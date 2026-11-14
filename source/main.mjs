import map from './map.json';
import { createMatch, speedOptions } from './match.mjs';
import { createArenaRenderer } from './renderer.mjs';
import { createOnlineClient } from './online.mjs';
import { loadOriginalArt } from './original-art.mjs';
import { combatStep, repairFraction, repairInterval } from './combat.mjs';
import { createBattleAudio } from './battle-audio.mjs';
import skillsRu from './ru-skills.json';
import { challengeScore, recordChallengeCompletions } from './challenges.mjs';

const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  'app', 'arena', 'announcer', 'clock', 'clock-label', 'wave', 'arena-eyebrow', 'arena-name', 'arena-detail', 'standings',
  'prep', 'prep-text', 'go', 'minimap', 'health-bar', 'health', 'shield-bar', 'shield', 'armor', 'regen', 'gold', 'income',
  'kills', 'shop', 'reroll', 'treasure', 'market', 'arsenal', 'clear', 'clears', 'pause', 'speed', 'lobby', 'resume',
  'tooltip', 'dialog', 'dialog-title', 'dialog-content', 'name', 'sound', 'weapon-damage', 'tower-damage', 'total-damage', 'repair',
  'arena-schedule', 'next-wave', 'next-skills', 'skills-progress', 'shop-hint',
  'sound-files',
].map(id => [id, byId(id)]));
ui.repair.title = 'Восстанавливает до ' + (repairFraction * 100) + '% здоровья. Перезарядка ' + repairInterval + ' с';
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const roundNumber = value => number.format(Math.max(0, value ?? 0));
const statNumber = value => number.format(value ?? 0);
const timerText = value => {
  const whole = Math.max(0, Math.floor(value));
  return String(Math.floor(whole / 60)).padStart(2, '0') + ':' + String(whole % 60).padStart(2, '0');
};
const glyphs = { Normal: '⚔', Piercing: '➶', Magic: '✦', Siege: '◉', Chaos: '✷' };
const rarityText = { common: 'Обычное', uncommon: 'Необычное', rare: 'Редкое', epic: 'Эпическое' };
const schoolText = { Normal: 'Обычный', Piercing: 'Колющий', Magic: 'Магический', Siege: 'Осадный', Chaos: 'Хаос', Poison: 'Яд', Frost: 'Обморожение', Fire: 'Огонь', Spikes: 'Шипы' };
const skillName = item => skillsRu[item.id]?.name ?? item.name;

function node(tag, classes, text) {
  const result = document.createElement(tag);
  if (classes) result.className = classes;
  if (text !== undefined) result.textContent = text;
  return result;
}

function readProfile() {
  try {
    return JSON.parse(localStorage.getItem('ts-web-profile')) ?? { name: 'Защитник', records: [], sound: true };
  } catch {
    return { name: 'Защитник', records: [], sound: true };
  }
}

const profile = readProfile();
profile.unlocks ??= [];
profile.challengeCounts ??= Object.fromEntries(profile.unlocks.filter(id => id !== 'A0JW').map(id => [id, 1]));
profile.skin ??= '';
const persist = () => localStorage.setItem('ts-web-profile', JSON.stringify(profile));
ui.name.value = profile.name;
const audio = createBattleAudio();
void audio.restore().then(renderSoundToggle);
const original = await loadOriginalArt().catch(() => null);
if (original?.data.consoleStone) {
  ui.app.classList.add('warcraft-art');
  ui.app.style.setProperty('--console-stone', 'url("' + original.url(original.data.consoleStone) + '")');
}
if (original?.data.healthFill) {
  ui.app.style.setProperty('--health-fill', 'url("' + original.url(original.data.healthFill) + '")');
}
const originalMinimap = original?.data.minimap ? new Image() : null;
if (originalMinimap) originalMinimap.src = original.url(original.data.minimap);
let graphics;
try {
  graphics = createArenaRenderer(ui.arena, map, original, byId('original-arena'), byId('combat-arena'), (cue, delay) => audio.play(cue, delay));
} catch (error) {
  const message = node('div', 'fatal');
  message.append(node('p', null, 'Не удалось запустить 3D. Проверьте, включено ли аппаратное ускорение WebGL в браузере.'));
  ui.app.append(message);
  throw error;
}

let local = null;
let online = null;
let frame = createMatch(map, [{ seat: 1, name: 'Защитник' }], { seed: 192 }).snapshot(1);
let paused = false;
let lastTick = 0;
let carry = 0;
let nextUI = 0;
let shownShop = null;
let shownArsenal = null;
let shownSeats = '';
let viewSeat = 1;
let lastSequence = 0;
let savedResult = false;
const recordedChallenges = new Set();
let announcementTimeout;
let matchMode = 'solo';

const matchActive = () => local !== null || online?.playing;
const nameValue = () => ui.name.value.trim().slice(0, 24) || 'Защитник';
const minimap = ui.minimap.getContext('2d');
const fixedStep = combatStep;

function renderSoundToggle() {
  ui.sound.setAttribute('aria-pressed', String(profile.sound));
  ui.sound.textContent = profile.sound ? 'Звук вкл.' : 'Звук выкл.';
  ui.sound.title = 'Переключить звук';
}

async function enableAudio(confirm = false) {
  if (!profile.sound) return;
  await audio.enable();
  if (confirm) audio.play('click');
}

ui.sound.addEventListener('click', () => {
  profile.sound = !profile.sound;
  persist();
  renderSoundToggle();
  if (profile.sound) void enableAudio(true);
  else audio.mute();
});
byId('sound-import').addEventListener('click', () => ui['sound-files'].click());
ui['sound-files'].addEventListener('change', async () => {
  const files = [...ui['sound-files'].files];
  ui['sound-files'].value = '';
  if (!files.length) return;
  let imported = 0;
  try { imported = await audio.importFiles(files); } catch {}
  if (imported) {
    profile.sound = true;
    persist();
    audio.play('click');
    announce('Подключено звуков Warcraft III: ' + imported, 3, 'achievement');
  } else {
    if (!profile.sound) audio.mute();
    announce('Выберите оригинальные звуковые файлы Warcraft III', 3, 'achievement');
  }
  renderSoundToggle();
});
renderSoundToggle();

function announce(text, seconds = 2.4, variant = '') {
  clearTimeout(announcementTimeout);
  ui.announcer.dataset.variant = variant;
  ui.announcer.textContent = text;
  ui.announcer.hidden = false;
  announcementTimeout = setTimeout(() => { ui.announcer.hidden = true; }, seconds * 1000);
}

function saveResult() {
  if (savedResult || !local || (frame.player.alive && !frame.finished)) return;
  savedResult = true;
  profile.records.unshift({
    mode: matchMode, at: Date.now(), seconds: Math.floor(frame.elapsed), wave: frame.wave, kills: frame.player.kills,
    place: frame.player.place, won: frame.player.won, lastStand: frame.player.lastStand,
  });
  profile.records = profile.records.slice(0, 20);
  persist();
}

function processFrame(next, reset = false) {
  const changedArena = next.arena.layout.seat !== frame.arena.layout.seat;
  frame = next;
  if (changedArena || reset) {
    graphics.reset(frame.arena.layout, frame.arena.color, frame.arena.skin);
    lastSequence = frame.arena.events.at(-1)?.seq ?? 0;
  }
  for (const event of frame.arena.events) {
    if (event.seq <= lastSequence) continue;
    lastSequence = event.seq;
    graphics.event(event);
    audio.event(event, frame.selected === frame.seat);
    if (event.kind === 'round') {
      const bonus = event.incomeBonus && frame.player?.alive ? ' · +' + roundNumber(event.incomeBonus) + ' золота/с' : '';
      announce('Волна ' + event.wave + bonus, 2.2, 'wave');
    }
    if (event.kind === 'defeat' && frame.selected === frame.seat) announce('БАШНЯ ПАЛА', 4);
    if (event.kind === 'victory' && frame.selected === frame.seat) announce('ПОБЕДА');
    if (event.kind === 'lastStand' && frame.selected === frame.seat) announce('ПОСЛЕДНИЙ ЗАЩИТНИК');
    if (event.kind === 'boss') announce('СЭМУАЙЗ НА ПОЛЕ', 3);
  }
  if (local) {
    const result = recordChallengeCompletions(profile, recordedChallenges, frame.player.challenges, map.challenges);
    if (result.changed) {
      persist();
      const challenge = map.challenges.find(entry => entry.id === result.unlocked[0]);
      if (challenge) {
        const others = result.unlocked.length > 1 ? ' · ещё ' + (result.unlocked.length - 1) : '';
        announce('Достижение открыто · ' + challenge.name + others, 4, 'achievement');
      }
    }
  }
  saveResult();
}

function resetMatchUI(mode) {
  paused = false;
  matchMode = mode;
  viewSeat = frame.seat ?? 1;
  savedResult = false;
  carry = 0;
  shownShop = null;
  shownArsenal = null;
  shownSeats = '';
  clearTimeout(announcementTimeout);
  ui.announcer.hidden = true;
  ui.tooltip.hidden = true;
  ui.lobby.hidden = true;
  ui.resume.hidden = false;
  renderUI();
}

function startLocal(mode) {
  online?.disconnect();
  online = null;
  profile.name = nameValue();
  persist();
  void enableAudio();
  const players = [{ seat: 1, name: profile.name, skin: profile.skin }];
  const bots = ['Лесной дозор', 'Сумеречный страж', 'Каменный клинок', 'Северный гарнизон', 'Огненный бастион', 'Тихий рубеж', 'Серебряная башня'];
  if (mode === 'bots') bots.forEach((name, index) => players.push({ seat: index + 2, name, bot: true }));
  recordedChallenges.clear();
  local = createMatch(map, players);
  processFrame(local.snapshot(1), true);
  resetMatchUI(mode);
}

function localAction(action) {
  if (!ui.lobby.hidden || !matchActive() || frame.finished) return;
  if (online?.playing) {
    online.action(action);
    return;
  }
  const accepted = local.action(1, action);
  if (accepted && ['buy', 'market', 'treasure'].includes(action.type)) audio.play('click');
  if (accepted && action.type === 'reroll') audio.play('click');
  processFrame(local.snapshot(1, viewSeat, lastSequence));
  renderUI();
}

function switchArena(seat) {
  if (!matchActive() || viewSeat === seat) return;
  viewSeat = seat;
  if (online?.playing) online.view(seat);
  else processFrame(local.snapshot(1, seat), true);
  renderUI();
}

function showLobby(show) {
  ui.lobby.hidden = !show;
  ui.resume.hidden = !matchActive();
  if (show) ui.tooltip.hidden = true;
}

function showTooltip(button, item) {
  const translation = skillsRu[item.id];
  ui.tooltip.className = 'tooltip ' + item.rarity;
  ui.tooltip.replaceChildren(node('strong', null, skillName(item)));
  ui.tooltip.append(node('p', null, rarityText[item.rarity] + ' · ' + roundNumber(item.gold) + ' золота'));
  if (item.kind === 'weapon') {
    const schools = item.damageTypes.map(school => schoolText[school] ?? school).join(' / ');
    ui.tooltip.append(node('p', null, schools + ' · ' + (translation?.attack ?? item.attackType)));
    const stats = ['Урон ' + statNumber(item.baseDamage), 'Дальность ' + statNumber(item.range)];
    if (item.cooldownSeconds) stats.push('Перезарядка ' + statNumber(item.cooldownSeconds) + ' с');
    ui.tooltip.append(node('p', null, stats.join(' · ')));
  }
  for (const text of translation?.effects ?? item.effects) if (text.trim()) ui.tooltip.append(node('p', null, text));
  ui.tooltip.hidden = false;
  const box = button.getBoundingClientRect();
  const tip = ui.tooltip.getBoundingClientRect();
  ui.tooltip.style.left = Math.max(9, Math.min(box.left, window.innerWidth - tip.width - 9)) + 'px';
  ui.tooltip.style.top = Math.max(9, box.top - tip.height - 8) + 'px';
}

function offerButton(item, slot, onBuy) {
  const button = node('button', 'offer ' + (item?.rarity ?? 'empty'));
  button.type = 'button';
  if (!item) {
    button.disabled = true;
    button.append(node('span', 'offer-glyph', '·'), node('span', 'offer-copy', 'Пусто'));
    return button;
  }
  const glyph = item.kind === 'weapon' ? glyphs[item.damageTypes[0]] : item.name === 'Black Market' ? '◈' : '✥';
  const text = node('span', 'offer-copy');
  const name = skillName(item);
  text.append(node('b', null, name), node('span', null, '◈ ' + roundNumber(item.gold)));
  const picture = node('span', 'offer-glyph');
  const artPath = original?.data.icons[item.id];
  if (artPath) {
    const image = node('img', 'offer-icon');
    image.alt = '';
    image.src = original.url(artPath);
    picture.append(image);
  } else picture.textContent = glyph;
  button.append(picture, text);
  if (slot !== null) button.append(node('span', 'offer-key', String(slot + 1)));
  button.setAttribute('aria-label', name + ', ' + roundNumber(item.gold) + ' золота');
  button.addEventListener('mouseenter', () => showTooltip(button, item));
  button.addEventListener('focus', () => showTooltip(button, item));
  button.addEventListener('mouseleave', () => { ui.tooltip.hidden = true; });
  button.addEventListener('blur', () => { ui.tooltip.hidden = true; });
  button.addEventListener('click', () => {
    ui.tooltip.hidden = true;
    onBuy();
  });
  return button;
}

function paintMinimap() {
  const size = ui.minimap.width;
  minimap.fillStyle = '#373b27';
  minimap.fillRect(0, 0, size, size);
  if (originalMinimap?.complete && originalMinimap.naturalWidth) minimap.drawImage(originalMinimap, 0, 0, size, size);
  minimap.strokeStyle = '#6f6945';
  minimap.lineWidth = 2;
  minimap.strokeRect(9, 9, size - 18, size - 18);
  for (const arena of map.arenas) {
    const x = size / 2 + arena.x / 116;
    const y = size / 2 - arena.y / 116;
    const seat = frame.seats.find(p => p.seat === arena.seat);
    minimap.strokeStyle = '#7d7958';
    minimap.beginPath();
    minimap.arc(x, y, 13, 0, Math.PI * 2);
    minimap.stroke();
    if (!seat) continue;
    minimap.fillStyle = seat.alive ? '#' + seat.color.toString(16).padStart(6, '0') : '#59584c';
    minimap.fillRect(x - 4, y - 4, 8, 8);
    if (seat.seat === frame.selected) {
      minimap.strokeStyle = '#ffe0a3';
      minimap.strokeRect(x - 6, y - 6, 12, 12);
    }
  }
  const arena = frame.arena.layout;
  minimap.fillStyle = '#eac376';
  for (const enemy of frame.arena.enemies) {
    const x = size / 2 + (arena.x + enemy.x) / 116;
    const y = size / 2 - (arena.y + enemy.y) / 116;
    minimap.fillRect(x, y, 1, 1);
  }
}

function fillBar(bar, display, amount, maximum) {
  const percent = maximum > 0 ? Math.min(100, Math.max(0, amount / maximum * 100)) : 0;
  bar.firstElementChild.style.width = percent + '%';
  display.textContent = roundNumber(amount) + ' / ' + roundNumber(maximum);
}

function renderUI() {
  const player = frame.player;
  if (!player) return;
  const prep = frame.preparation > 0;
  const finished = frame.finished;
  ui['clock-label'].textContent = finished ? 'МАТЧ ЗАВЕРШЁН' : prep ? 'ПОДГОТОВКА' : 'ВРЕМЯ МАТЧА';
  ui.clock.textContent = timerText(prep ? Math.ceil(frame.preparation) : frame.elapsed);
  ui.wave.textContent = String(frame.wave).padStart(2, '0');
  ui.prep.hidden = !prep || !matchActive();
  ui.go.hidden = frame.seat !== 1;
  ui['prep-text'].textContent = 'До первой волны · ' + Math.ceil(frame.preparation) + ' с';
  ui['arena-eyebrow'].textContent = 'АРЕНА ' + String(frame.selected).padStart(2, '0');
  const selected = frame.seats.find(seat => seat.seat === frame.selected);
  ui['arena-name'].textContent = frame.selected === frame.seat ? 'Башня выжившего' : (selected?.name ?? 'Башня соперника');
  ui['arena-detail'].textContent = finished ? (player.won ? 'Победа' : 'Башня пала')
    : 'На поле ' + frame.arena.enemies.length + ' · сила врагов ×' + frame.arena.enemyScale.health.toFixed(2);
  ui['arena-schedule'].hidden = !matchActive();
  const schedule = frame.schedule;
  if (schedule) {
    const suffix = paused ? ' · пауза' : '';
    ui['next-wave'].textContent = 'Волна ' + schedule.wave + ' через ' + timerText(Math.ceil(schedule.waveIn)) + suffix;
  } else {
    ui['next-wave'].textContent = 'Волны завершены';
  }
  const shopClosed = !schedule || !player.alive || (schedule.shopCloses && frame.wave >= 31);
  ui['next-skills'].textContent = shopClosed ? 'Лавка закрыта'
    : schedule.shopCloses ? 'До закрытия лавки' : 'Новый набор навыков';
  ui['skills-progress'].hidden = shopClosed;
  ui['skills-progress'].value = shopClosed ? 0 : schedule.skillsProgress;
  fillBar(ui['health-bar'], ui.health, player.health, player.maxHealth);
  fillBar(ui['shield-bar'], ui.shield, player.shield, player.maxShield);
  ui.armor.textContent = '♜ ' + statNumber(player.armor);
  ui.regen.textContent = '✚ ' + statNumber(player.regen) + '/с';
  ui['weapon-damage'].textContent = roundNumber(player.weaponDamage);
  ui['tower-damage'].textContent = roundNumber(player.towerDamage);
  ui['total-damage'].textContent = roundNumber(player.damage);
  const repairSeconds = Math.ceil(player.repairCooldown ?? 0);
  ui.repair.textContent = repairSeconds > 0 ? 'Ремонт · ' + repairSeconds + ' с' : 'Ремонт';
  ui.repair.disabled = prep || finished || !player.alive || player.health >= player.maxHealth || repairSeconds > 0;
  ui.gold.textContent = roundNumber(player.gold);
  ui.income.textContent = '+' + roundNumber(player.income) + '/с';
  ui.kills.textContent = roundNumber(player.kills) + ' убито';
  ui.clears.textContent = player.clears;
  ui.clear.disabled = prep || !player.clears || !player.alive;
  ui.pause.disabled = finished || Boolean(online?.playing);
  ui.pause.textContent = paused ? '▶ Продолжить' : 'Ⅱ Пауза';
  ui.speed.textContent = '×' + frame.speed;
  ui.speed.disabled = finished || frame.seat !== 1;
  ui.resume.textContent = finished ? 'К итогам матча' : 'Вернуться в бой';
  ui.treasure.hidden = player.treasure === null;
  ui.treasure.textContent = '◇ Казна ' + roundNumber(player.treasure);
  ui.market.hidden = !player.market;
  ui.reroll.textContent = player.price === 0 ? '⟳ Бесплатно · ' + player.freeRerolls
    : player.price == null ? '⟳ Обновления исчерпаны' : '⟳ ' + roundNumber(player.price) + ' · осталось ' + player.roundRerolls;
  ui.reroll.disabled = player.price == null || player.gold < player.price || !player.alive;
  ui['shop-hint'].textContent = player.alive && player.directDefense === false
    ? (player.weapons.some(weapon => weapon.charges !== undefined) ? 'Тому нужно первое убийство' : 'Купите оружие или шипы')
    : '1–8 · покупка';

  const offerKey = player.version + ':' + player.shop.map(item => item?.id ?? '').join(':');
  if (shownShop !== offerKey) {
    shownShop = offerKey;
    ui.shop.replaceChildren(...player.shop.map((item, slot) => offerButton(item, slot, () => {
      localAction({ type: 'buy', slot, version: frame.player.version });
    })));
  }
  [...ui.shop.children].forEach((button, index) => {
    const item = player.shop[index];
    button.disabled = !item || !player.alive || player.gold < item.gold;
  });
  const arsenalKey = player.weapons.map(weapon => weapon.id + ':' + weapon.copies).join('|') + ':' + player.duplicate;
  if (shownArsenal !== arsenalKey) {
    shownArsenal = arsenalKey;
    if (player.weapons.length) {
      ui.arsenal.replaceChildren(...player.weapons.map(weapon => {
        const entry = node('button', 'arsenal-item ' + weapon.rarity);
        const name = skillName(weapon);
        entry.append(node('span', null, name + ' ×' + weapon.copies), node('b', 'arsenal-damage'));
        entry.title = player.duplicate && weapon.rarity === 'rare' ? 'Использовать дубликатор' : name;
        entry.disabled = !player.duplicate || weapon.rarity !== 'rare';
        entry.addEventListener('click', () => localAction({ type: 'duplicate', id: weapon.id }));
        return entry;
      }));
    } else {
      ui.arsenal.replaceChildren(node('p', null, 'Купите оружие, чтобы начать оборону.'));
    }
  }
  for (const [index, label] of [...ui.arsenal.querySelectorAll('.arsenal-damage')].entries()) {
    const weapon = player.weapons[index];
    const text = roundNumber(weapon.damage) + ' ур.';
    if (label.textContent !== text) label.textContent = text;
  }
  const seatKey = frame.seats.map(seat => [seat.seat, seat.name, seat.alive, seat.place, Math.ceil(seat.health / seat.maxHealth * 20)].join('/')).join('|') + ':' + frame.selected;
  if (shownSeats !== seatKey) {
    shownSeats = seatKey;
    ui.standings.replaceChildren(...frame.seats.map(seat => {
      const entry = node('button', 'seat');
      entry.style.setProperty('--seat', '#' + seat.color.toString(16).padStart(6, '0'));
      entry.setAttribute('aria-pressed', String(frame.selected === seat.seat));
      entry.setAttribute('aria-label', 'Смотреть арену ' + seat.seat + ' · ' + seat.name);
      const bar = node('i');
      bar.style.width = Math.max(0, seat.health / seat.maxHealth * 100) + '%';
      entry.append(node('em'), node('span', null, seat.name), node('b', null, seat.place ? '#' + seat.place : ''), bar);
      entry.addEventListener('click', () => switchArena(seat.seat));
      return entry;
    }));
  }
  paintMinimap();
}

function dialog(title) {
  ui['dialog-title'].textContent = title;
  ui['dialog-content'].replaceChildren();
  if (!ui.dialog.open) ui.dialog.showModal();
  return ui['dialog-content'];
}

function statCard(label, value) {
  const card = node('div', 'dialog-stat');
  card.append(node('strong', null, value), node('small', null, label));
  return card;
}

function showStats() {
  const content = dialog('Статистика матча');
  const player = frame.player;
  const grid = node('div', 'dialog-grid');
  grid.append(statCard('Волна', String(frame.wave)), statCard('Время', timerText(frame.elapsed)),
    statCard('Убийства', roundNumber(player.kills)), statCard('Весь урон', roundNumber(player.damage)),
    statCard('Урон оружия', roundNumber(player.weaponDamage)), statCard('Урон шипов', roundNumber(player.towerDamage)),
    statCard('Восстановлено здоровья', roundNumber(player.healed)),
    statCard('Дополнительный доход за волны', roundNumber(player.waveBonusGold) + ' золота'));
  content.append(grid);
  if (player.otherDamage > 0) grid.append(statCard('Очистка и прочий урон', roundNumber(player.otherDamage)));
  for (const weapon of [...player.weapons].sort((a, b) => b.damage - a.damage)) {
    content.append(node('p', 'dialog-copy', skillName(weapon) + ' ×' + weapon.copies + ' · ' + roundNumber(weapon.damage) + ' урона'));
  }
}

function showProfile() {
  const content = dialog('Профиль · ' + profile.name);
  const grid = node('div', 'dialog-grid');
  const record = profile.records.reduce((best, game) => Math.max(best, game.wave), 0);
  grid.append(statCard('Лучшая волна', record || '—'), statCard('Локальные матчи', profile.records.length),
    statCard('Достижения', profile.unlocks.length), statCard('Очки испытаний', challengeScore(profile, map.challenges)));
  content.append(grid);
  if (profile.records.length === 0) content.append(node('p', 'dialog-copy', 'Завершённые матчи появятся здесь.'));
  for (const game of profile.records) {
    const text = new Date(game.at).toLocaleDateString('ru-RU') + ' · ' + (game.mode === 'bots' ? 'Восемь башен' : 'Одиночная оборона')
      + ' · волна ' + game.wave + ' · ' + timerText(game.seconds) + (game.lastStand ? ' · последний защитник' : '');
    content.append(node('p', 'dialog-copy', text));
  }
}

function showChallenges() {
  const content = dialog('Достижения и облики');
  const points = challengeScore(profile, map.challenges);
  content.append(node('p', 'dialog-copy', 'Открыто ' + profile.unlocks.length + ' из ' + map.challenges.length + ' · ' + roundNumber(points) + ' очков'));
  const defaults = node('button', 'small-button', profile.skin ? 'Вернуть исходный облик' : 'Выбран исходный облик');
  defaults.disabled = !profile.skin;
  defaults.addEventListener('click', () => {
    profile.skin = '';
    persist();
    showChallenges();
  });
  content.append(defaults);
  const list = node('div', 'challenge-list');
  for (const challenge of map.challenges) {
    const unlocked = profile.unlocks.includes(challenge.id);
    const card = node('article', 'challenge');
    const header = node('header');
    header.append(node('strong', null, challenge.name));
    if (unlocked) {
      const select = node('button', 'small-button', profile.skin === challenge.id ? 'Выбран' : 'Выбрать');
      select.disabled = profile.skin === challenge.id;
      select.addEventListener('click', () => {
        profile.skin = challenge.id;
        persist();
        showChallenges();
      });
      header.append(select);
    } else header.append(node('small', null, challenge.points ? '+' + challenge.points : '◇'));
    card.append(header, node('p', 'dialog-copy', challenge.goal));
    if (challenge.restrictions !== 'None') card.append(node('p', 'dialog-copy', challenge.restrictions));
    if (unlocked && profile.challengeCounts[challenge.id]) {
      card.append(node('p', 'dialog-copy', 'Пройдено: ' + profile.challengeCounts[challenge.id]));
    }
    list.append(card);
  }
  content.append(list);
}

function openMarket() {
  if (!frame.player.market) return;
  const content = dialog('Чёрный рынок');
  const grid = node('div', 'market-grid');
  for (const item of frame.player.market) {
    const button = offerButton(item, null, () => {
      localAction({ type: 'market', id: item.id });
      ui.dialog.close();
    });
    button.disabled = frame.player.gold < item.gold;
    grid.append(button);
  }
  content.append(grid);
}

function togglePause() {
  if (!local || frame.finished || online?.playing) return;
  paused = !paused;
  renderUI();
}

function cycleSpeed() {
  localAction({ type: 'speed', value: speedOptions[(speedOptions.indexOf(frame.speed) + 1) % speedOptions.length] });
}

function showOnline() {
  if (!online) online = createOnlineClient({
    dialog, node, nameValue,
    start(next) {
      local = null;
      processFrame(next, true);
      resetMatchUI('online');
      ui.dialog.close();
      void enableAudio();
    },
    update(next) { processFrame(next); },
    failure(message) { announce(message, 4); },
  });
  online.show();
}

byId('start-solo').addEventListener('click', () => startLocal('solo'));
byId('start-bots').addEventListener('click', () => startLocal('bots'));
byId('start-online').addEventListener('click', showOnline);
byId('dialog-close').addEventListener('click', () => ui.dialog.close());
byId('menu').addEventListener('click', () => showLobby(true));
ui.resume.addEventListener('click', () => showLobby(false));
byId('profile').addEventListener('click', showProfile);
byId('challenges').addEventListener('click', showChallenges);
byId('stats').addEventListener('click', showStats);
byId('zoom-out').addEventListener('click', () => graphics.zoom(-0.1));
byId('zoom-in').addEventListener('click', () => graphics.zoom(0.1));
ui.arena.addEventListener('wheel', event => {
  event.preventDefault();
  graphics.zoom(Math.sign(-event.deltaY) * 0.07);
}, { passive: false });
ui.go.addEventListener('click', () => localAction({ type: 'go' }));
ui.pause.addEventListener('click', togglePause);
ui.speed.addEventListener('click', cycleSpeed);
ui.clear.addEventListener('click', () => localAction({ type: 'clear' }));
ui.repair.addEventListener('click', () => localAction({ type: 'repair' }));
ui.reroll.addEventListener('click', () => localAction({ type: 'reroll' }));
ui.treasure.addEventListener('click', () => localAction({ type: 'treasure' }));
ui.market.addEventListener('click', openMarket);

document.addEventListener('keydown', event => {
  if (ui.dialog.open || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  if (event.code === 'Escape') {
    if (ui.lobby.hidden && viewSeat !== frame.seat) switchArena(frame.seat);
    else showLobby(ui.lobby.hidden);
    return;
  }
  if (!ui.lobby.hidden || !matchActive() || event.repeat) return;
  if (/^F[1-8]$/.test(event.code)) {
    event.preventDefault();
    const seat = Number(event.code.slice(1));
    if (frame.seats.some(player => player.seat === seat)) switchArena(seat);
  } else if (/^(Digit|Numpad)[1-8]$/.test(event.code)) {
    const slot = Number(event.code.at(-1)) - 1;
    localAction({ type: 'buy', slot, version: frame.player.version });
  } else if (event.code === 'KeyR') localAction({ type: 'reroll' });
  else if (event.code === 'KeyC') localAction({ type: 'clear' });
  else if (event.code === 'KeyF') cycleSpeed();
  else if (event.code === 'Space') {
    event.preventDefault();
    togglePause();
  }
});

function animate(stamp) {
  const dt = lastTick ? Math.min((stamp - lastTick) / 1000, 0.12) : 0;
  lastTick = stamp;
  const blocked = paused || !ui.lobby.hidden;
  if (local && !blocked && !local.finished) {
    carry += dt * local.speed;
    if (carry >= fixedStep) {
      while (carry >= fixedStep) {
        local.tick(fixedStep);
        carry -= fixedStep;
      }
      processFrame(local.snapshot(1, viewSeat, lastSequence));
    }
  }
  if (stamp >= nextUI) {
    renderUI();
    nextUI = stamp + 100;
  }
  const activeLocal = local && !local.finished;
  graphics.render(frame, stamp, blocked && !online?.playing, activeLocal ? carry : 0, activeLocal ? carry / fixedStep : 1);
  requestAnimationFrame(animate);
}

renderUI();
requestAnimationFrame(animate);
