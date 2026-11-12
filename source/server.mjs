import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import { createMatch } from './match.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(root, 'dist');
const map = JSON.parse(await readFile(resolve(root, 'map.json'), 'utf8'));
const dataFile = process.env.DATA_FILE ?? resolve(root, 'data', 'survivors.sqlite');
if (dataFile !== ':memory:') await mkdir(dirname(dataFile), { recursive: true });
const database = new DatabaseSync(dataFile);
database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
database.exec(
  'CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);' +
  'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);' +
  'CREATE TABLE IF NOT EXISTS matches (match_id TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id), place INTEGER NOT NULL, wave INTEGER NOT NULL, kills INTEGER NOT NULL, duration INTEGER NOT NULL, won INTEGER NOT NULL, last_stand INTEGER NOT NULL, played INTEGER NOT NULL, PRIMARY KEY (match_id, account_id));'
);

const oneWeek = 7 * 24 * 60 * 60;
const scryptAsync = promisify(scrypt);
const authAttempts = new Map();
const sockets = new Set();
const rooms = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.wav', 'audio/wav'],
]);
const queries = {
  user: database.prepare('SELECT id, email, name, salt, password_hash FROM accounts WHERE email = ?'),
  create: database.prepare('INSERT INTO accounts (email, name, salt, password_hash) VALUES (?, ?, ?, ?)'),
  session: database.prepare('SELECT a.id, a.name FROM sessions s JOIN accounts a ON s.account_id = a.id WHERE s.id = ? AND s.expires > ?'),
  insertSession: database.prepare('INSERT INTO sessions (id, account_id, expires) VALUES (?, ?, ?)'),
  removeSession: database.prepare('DELETE FROM sessions WHERE id = ?'),
  purge: database.prepare('DELETE FROM sessions WHERE expires <= ?'),
  history: database.prepare('SELECT place, wave, kills, duration, won, last_stand, played FROM matches WHERE account_id = ? ORDER BY played DESC LIMIT 20'),
  record: database.prepare('INSERT OR IGNORE INTO matches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
};

function headers(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function origin(request) {
  return process.env.PUBLIC_ORIGIN || ((request.socket.encrypted ? 'https://' : 'http://') + request.headers.host);
}

function cookieHash(request) {
  const token = /(?:^|;\s*)ts_session=([0-9a-f]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
  return token ? hash(token) : null;
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function session(request) {
  const token = cookieHash(request);
  return token ? queries.session.get(token, Date.now()) : undefined;
}

function setSessionCookie(request, response, token, seconds) {
  const secure = origin(request).startsWith('https:') ? '; Secure' : '';
  response.setHeader('Set-Cookie', 'ts_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + seconds + secure);
}

async function payload(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('invalid payload');
  const bytes = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 4096) throw new Error('invalid payload');
    bytes.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(bytes).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid payload');
  return data;
}

function throttle(request) {
  const ip = request.socket.remoteAddress;
  const now = Date.now();
  let entry = authAttempts.get(ip);
  if (!entry || entry.expires < now) {
    entry = { expires: now + 60000, count: 0 };
    authAttempts.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > 10;
}

async function accountApi(request, response, path) {
  if (request.method === 'GET' && path === '/api/session') return reply(response, 200, { account: session(request) ?? null });
  if (request.method === 'GET' && path === '/api/profile') {
    const account = session(request);
    if (!account) return reply(response, 401, { error: 'Войдите в профиль.' });
    return reply(response, 200, { account, matches: queries.history.all(account.id) });
  }
  if (request.method !== 'POST' || request.headers.origin !== origin(request)) return reply(response, 403, { error: 'Запрос отклонён.' });
  if (path === '/api/logout') {
    const cookie = cookieHash(request);
    if (cookie) queries.removeSession.run(cookie);
    for (const socket of sockets) if (socket.sessionId === cookie) socket.close(1008, 'Signed out');
    setSessionCookie(request, response, '', 0);
    return reply(response, 200, {});
  }
  if (!['/api/register', '/api/login'].includes(path)) return reply(response, 404, { error: 'Не найдено.' });
  if (throttle(request)) return reply(response, 429, { error: 'Слишком много попыток. Повторите через минуту.' });
  let data;
  try { data = await payload(request); } catch { return reply(response, 400, { error: 'Проверьте данные формы.' }); }
  const email = typeof data.email === 'string' ? data.email.toLowerCase().trim() : '';
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, 24) : '';
  const password = typeof data.password === 'string' ? data.password : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length > 128 || !password) {
    return reply(response, 400, { error: 'Проверьте адрес почты и пароль.' });
  }
  let user = queries.user.get(email);
  if (path === '/api/register') {
    if (!name || password.length < 10) return reply(response, 400, { error: 'Нужны имя и пароль из десяти символов или больше.' });
    const salt = randomBytes(16).toString('hex');
    const digest = (await scryptAsync(password, salt, 64)).toString('hex');
    if (user) return reply(response, 409, { error: 'Не удалось зарегистрировать этот адрес.' });
    try { queries.create.run(email, name, salt, digest); }
    catch (error) {
      if (!queries.user.get(email)) throw error;
      return reply(response, 409, { error: 'Не удалось зарегистрировать этот адрес.' });
    }
    user = queries.user.get(email);
  } else {
    const attempted = await scryptAsync(password, user?.salt ?? 'tower-survivors-missing-account', 64);
    const expected = Buffer.from(user?.password_hash ?? '0'.repeat(128), 'hex');
    if (!timingSafeEqual(attempted, expected) || !user) return reply(response, 401, { error: 'Почта или пароль не подходят.' });
  }
  const previous = cookieHash(request);
  if (previous) queries.removeSession.run(previous);
  const token = randomBytes(32).toString('hex');
  queries.insertSession.run(hash(token), user.id, Date.now() + oneWeek * 1000);
  setSessionCookie(request, response, token, oneWeek);
  return reply(response, 200, { account: { id: user.id, name: user.name } });
}

const server = createServer(async (request, response) => {
  headers(response);
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) return await accountApi(request, response, path);
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405, { error: 'Метод недоступен.' });
    const decoded = decodeURIComponent(path === '/' ? '/index.html' : path);
    const file = resolve(staticRoot, '.' + decoded);
    if (!file.startsWith(staticRoot + sep)) return reply(response, 404, { error: 'Не найдено.' });
    const bytes = await readFile(file).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
      throw error;
    });
    if (!bytes) return reply(response, 404, { error: 'Не найдено.' });
    response.writeHead(200, {
      'Content-Type': mime.get(extname(file)) ?? 'application/octet-stream',
      'Cache-Control': decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) reply(response, 500, { error: 'Ошибка сервера игры.' });
  }
});

server.on('upgrade', (request, connection, head) => {
  const account = session(request);
  if (request.url !== '/socket' || request.headers.origin !== origin(request) || !account || sockets.size >= 512) {
    connection.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    connection.destroy();
    return;
  }
  wss.handleUpgrade(request, connection, head, socket => {
    socket.account = account;
    socket.sessionId = cookieHash(request);
    wss.emit('connection', socket);
  });
});

function send(socket, data) {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 1024 * 1024) socket.send(JSON.stringify(data));
}

function roomState(room) {
  for (const player of room.players.values()) {
    send(player.socket, {
      type: 'room', code: room.code, host: player.id === room.host,
      players: [...room.players.values()].map(({ name, seat }) => ({ name, seat })),
    });
  }
}

function detach(socket, explicit) {
  const room = socket.room;
  if (!room) return;
  const player = room.players.get(socket.account.id);
  socket.room = null;
  if (!player || player.socket !== socket) return;
  player.socket = null;
  room.updated = Date.now();
  if (room.match && explicit) room.match.leave(player.seat);
  if (!room.match && explicit) room.players.delete(player.id);
  if (!room.match && !room.players.get(room.host)?.socket) {
    room.host = [...room.players.values()].find(entry => entry.socket)?.id ?? room.host;
  }
  if (room.players.size === 0) rooms.delete(room.code);
  else if (!room.match) roomState(room);
}

function attach(socket, room) {
  let member = room.players.get(socket.account.id);
  if (member?.socket && member.socket !== socket) {
    member.socket.room = null;
    member.socket.close(1008, 'Other connection');
  }
  if (socket.room !== room) detach(socket, true);
  if (!member) {
    const occupied = new Set([...room.players.values()].map(player => player.seat));
    const seat = [1, 2, 3, 4, 5, 6, 7, 8].find(candidate => !occupied.has(candidate));
    member = { ...socket.account, seat, view: seat, since: 0, recorded: false };
    room.players.set(member.id, member);
  }
  member.socket = socket;
  member.since = 0;
  socket.room = room;
  room.updated = Date.now();
  if (!room.match) roomState(room);
}

function roomCode() {
  let code;
  do code = randomBytes(3).toString('hex').toUpperCase();
  while (rooms.has(code));
  return code;
}

wss.on('connection', socket => {
  sockets.add(socket);
  socket.rate = { timestamp: Date.now(), messages: 0 };
  socket.alive = true;
  socket.on('pong', () => { socket.alive = true; });
  socket.on('error', () => socket.terminate());
  socket.on('close', () => {
    detach(socket, false);
    sockets.delete(socket);
  });
  socket.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (typeof data !== 'object' || data === null) return;
    const now = Date.now();
    if (now - socket.rate.timestamp > 1000) socket.rate = { timestamp: now, messages: 0 };
    if (++socket.rate.messages > 20) return;
    const fail = error => send(socket, { type: 'error', error });
    const room = socket.room;
    const member = room?.players.get(socket.account.id);
    if (data.type === 'create') {
      if (rooms.size >= 80) return fail('Все комнаты заняты. Повторите позже.');
      const code = roomCode();
      const newRoom = { code, id: randomBytes(16).toString('hex'), host: socket.account.id, players: new Map(), updated: now };
      rooms.set(code, newRoom);
      attach(socket, newRoom);
    } else if (data.type === 'join') {
      const target = rooms.get(typeof data.code === 'string' ? data.code.toUpperCase() : '');
      if (!target) return fail('Комната с этим кодом не найдена.');
      if (target.match && !target.players.has(socket.account.id)) return fail('Матч уже начался.');
      if (target.players.size === 8 && !target.players.has(socket.account.id)) return fail('В комнате восемь игроков.');
      attach(socket, target);
    } else if (data.type === 'leave') {
      detach(socket, true);
    } else if (data.type === 'start') {
      if (!room || room.host !== socket.account.id || room.match) return;
      const connected = [...room.players.values()].filter(player => player.socket);
      if (connected.length < 2) return fail('Нужно минимум два игрока.');
      connected.sort((a, b) => Number(b.id === room.host) - Number(a.id === room.host));
      connected.forEach((player, index) => Object.assign(player, { seat: index + 1, view: index + 1, since: 0 }));
      room.players = new Map(connected.map(player => [player.id, player]));
      room.match = createMatch(map, connected);
      room.carry = 0;
    } else if (data.type === 'action' && room?.match && member && data.input && typeof data.input === 'object') {
      room.match.action(member.seat, data.input);
    } else if (data.type === 'view' && room?.match && member) {
      if (![...room.players.values()].some(player => player.seat === data.seat)) return;
      member.view = data.seat;
      member.since = 0;
    }
  });
});

const step = 0.025;
let lastTick = performance.now();
let lastBroadcast = lastTick;
setInterval(() => {
  const now = performance.now();
  const delta = Math.min((now - lastTick) / 1000, 0.18);
  const broadcast = now - lastBroadcast >= 90;
  lastTick = now;
  if (broadcast) lastBroadcast = now;
  for (const room of rooms.values()) {
    if (!room.match) continue;
    room.carry += delta * room.match.speed;
    while (room.carry >= step) {
      room.match.tick(step);
      room.carry -= step;
    }
    if (!broadcast) continue;
    for (const player of room.players.values()) {
      if (!player.socket && player.recorded) continue;
      const frame = room.match.snapshot(player.seat, player.view, player.since);
      if (player.socket) {
        const last = frame.arena.events.at(-1);
        if (last) player.since = last.seq;
        send(player.socket, { type: 'frame', frame });
      }
      if (!player.recorded && (!frame.player.alive || frame.finished)) {
        queries.record.run(room.id, player.id, frame.player.place, frame.wave, frame.player.kills,
          Math.floor(frame.elapsed), Number(frame.player.won), Number(frame.player.lastStand), Date.now());
        player.recorded = true;
      }
    }
  }
}, 25).unref();

setInterval(() => {
  const now = Date.now();
  queries.purge.run(now);
  for (const [ip, entry] of authAttempts) if (entry.expires < now) authAttempts.delete(ip);
  for (const [code, room] of rooms) {
    if (![...room.players.values()].some(player => player.socket) && now - room.updated > 10 * 60 * 1000) rooms.delete(code);
  }
  for (const socket of sockets) {
    if (!socket.alive || !queries.session.get(socket.sessionId, now)) socket.terminate();
    else {
      socket.alive = false;
      socket.ping();
    }
  }
}, 30000).unref();

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);
server.listen(port, host, () => console.log('Tower Survivors listening on ' + host + ':' + port));
