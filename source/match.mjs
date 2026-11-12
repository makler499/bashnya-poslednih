import { createSpawnPlanner } from './enemy-spawn.mjs';
import { createShop, createTower, purchase, roundUpgrades, tickEconomy } from './shop.mjs';
import { buildAttacks, clearArena, combatStep, orbitRate, repairTower, startRoundWeapons, tickEnemies, tickImpacts, tickWeapons } from './combat.mjs';
import { checkChallenges, rememberPurchase, survivorChallenge } from './challenges.mjs';

const playerColors = [0xb84836, 0x426bc4, 0x4a9c82, 0x8764ab, 0xcbaf55, 0xd78138, 0x68a149, 0xb96a90];
const speedOptions = new Set([1, 1.5, 2]);
const defaultEnemyHealth = { Bandit: 300, Brigand: 600, BanditRider: 600, Catapult: 600 };
const defaultEnemyArmor = { Bandit: 'medium', Brigand: 'small', BanditRider: 'large', Catapult: 'hero' };

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), 1 | state);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), 61 | bits);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  };
}

function terrainWalkability(map) {
  if (!map.pathing) return null;
  const { width, height, runs } = map.pathing;
  const [west, south] = map.terrain.origin;
  const cells = new Uint8Array(width * height);
  let offset = 0;
  for (const [count, flag] of runs) {
    cells.fill(flag, offset, offset + count);
    offset += count;
  }
  return (x, y) => {
    const column = Math.floor((x - west) / 32);
    const row = Math.floor((y - south) / 32);
    return column >= 0 && row >= 0 && column < width && row < height && !(cells[row * width + column] & 2);
  };
}

function makeArena(map, player, offers, random, walkable) {
  const arena = {
    seat: player.seat,
    name: player.name,
    bot: Boolean(player.bot),
    color: playerColors[player.seat - 1],
    skin: player.skin ?? '',
    layout: map.arenas[player.seat - 1],
    tower: createTower(map.initialRules.startingGold),
    walkable,
    combatRules: map.combatRules,
    shop: offers,
    shopVersion: 1,
    enemies: [],
    hits: [],
    enemyHits: [],
    waves: [],
    fields: [],
    corpses: [],
    events: [],
    purchaseLog: [],
    challengeUnlocks: new Set(),
    spentDamage: 0,
    spentIncome: 0,
    waveBonusGold: 0,
    multipliers: { health: 1, damage: 1, speed: 1 },
    healthGrowth: 0.05,
    healthGrowthStep: 0.05,
    damageGrowth: 0.05,
    damageGrowthStep: 0,
    extremeGrowth: 1,
    damageTaken: 1,
    damagePerHit: 1.03,
    damagePerSecond: 1.01,
    cc: 1,
    now: 0,
    invulnerableUntil: 0,
    nextBot: 0,
    place: null,
    won: false,
    lastStand: false,
    alive: true,
    random,
  };
  let eventNumber = 0;
  let impactWindow = -Infinity;
  let impactCount = 0;
  arena.emit = event => {
    if (event.kind === 'impact') {
      if (arena.now >= impactWindow + 0.1) {
        impactWindow = arena.now;
        impactCount = 0;
      }
      if (impactCount >= 36) return;
      impactCount += 1;
    }
    arena.events.push({ ...event, at: arena.now, seq: ++eventNumber });
    if (arena.events.length > 400) arena.events.splice(0, 100);
  };
  return arena;
}

function growEnemies(arena, wave, solo) {
  const { multipliers } = arena;
  multipliers.speed += 0.1;
  arena.healthGrowth += arena.healthGrowthStep;
  multipliers.health += arena.healthGrowth;
  arena.healthGrowthStep += 0.01;
  arena.damageGrowth += arena.damageGrowthStep;
  multipliers.damage += arena.damageGrowth;
  arena.damageGrowthStep += 0.02;
  arena.damagePerHit += 0.02;
  arena.cc = Math.max(0.02, arena.cc - 0.02);
  if (wave > 10) arena.damageGrowthStep += 0.01;
  if (wave > 20) {
    multipliers.speed += 0.05;
    arena.healthGrowth += arena.extremeGrowth;
    arena.extremeGrowth *= 1.5;
    arena.damageGrowth += arena.damageGrowthStep;
    arena.damageGrowthStep += 0.25 + (1 - arena.damageTaken) * 3;
    if (arena.cc > 0.05) arena.cc = Math.max(0.05, arena.cc - 0.02);
    if (arena.damageTaken > 0.05) arena.damageTaken *= 0.9;
  }
  if (wave > 30) {
    arena.healthGrowth += arena.extremeGrowth;
    arena.extremeGrowth *= solo ? 1.13 : 2.5;
    arena.damageGrowth += arena.damageGrowthStep;
    arena.damageGrowthStep += (solo ? 15 : 30) + (1 - arena.damageTaken) * (solo ? 7.5 : 15);
    arena.damagePerHit += solo ? 0.05 : 0.1;
    arena.cc = Math.max(0.02, arena.cc - (solo ? 0.02 : 0.04));
  }
}

function createEnemy(arena, spawn, archetype, key) {
  const maxHp = spawn.health ?? defaultEnemyHealth[archetype.family] ?? 900;
  const finalForm = spawn.unitId === 'h00G';
  const waveBounty = archetype.bounty ?? (finalForm ? 100 : archetype.family === 'Bandit' ? 10 : 20);
  const bounty = Math.floor(waveBounty * arena.tower.bountyMultiplier);
  return {
    key, id: spawn.unitId, family: archetype.family,
    x: spawn.x - arena.layout.x, y: spawn.y - arena.layout.y,
    maxHp, hp: maxHp, speed: spawn.speed ?? 50, bounty,
    armor: archetype.armorType ?? defaultEnemyArmor[archetype.family], armorValue: archetype.armorValue ?? 0,
    healthRegen: (archetype.healthRegen ?? 0) * (arena.multipliers.health > 1 ? 1 + arena.multipliers.health : 1),
    damageBase: spawn.damageBase ?? 9,
    damage: Math.max(0, (spawn.damageBase ?? 9) + 1),
    attackRange: archetype.attackRange ?? 128, attackCooldown: spawn.attackCooldown ?? 1,
    damagePoint: archetype.damagePoint, projectileSpeed: archetype.projectileSpeed,
    damageTaken: arena.damageTaken, damageScale: 1,
    lifetime: spawn.lifetime, expires: arena.now + (spawn.lifetime ?? 0),
    walking: true, nextAttack: 0, attackAt: -10, cc: arena.cc,
    stun: 0, frost: 0, frostTime: 0, fire: 0, bleed: 0, spikesVulnerability: 0,
    poison: [], vulnerability: new Map(), dead: false,
  };
}

export function createMatch(map, players, options = {}) {
  if (players.length < 1 || players.length > 8 || new Set(players.map(p => p.seat)).size !== players.length) {
    throw new RangeError('Match needs 1–8 distinct seats');
  }
  if (players.some(p => !Number.isInteger(p.seat) || p.seat < 1 || p.seat > 8)) throw new RangeError('Invalid seat');
  const seed = options.seed ?? Math.floor(Math.random() * 4294967296);
  const random = seededRandom(seed);
  const shop = createShop(map, random);
  const attacks = buildAttacks(map.weapons);
  const flamecasterId = map.weapons.find(weapon => weapon.slot === 17)?.abilityId;
  const planSpawns = createSpawnPlanner(map, random);
  const statsByEnemy = new Map(map.enemies.map(enemy => [enemy.id, enemy]));
  const { initialRules: rules } = map;
  const timedChallenges = map.challenges.filter(challenge => challenge.seconds !== null && challenge.id !== survivorChallenge)
    .sort((a, b) => a.seconds - b.seconds);
  const bossChallenge = map.challenges.filter(challenge => challenge.id === survivorChallenge);
  let nextChallenge = 0;
  const walkable = terrainWalkability(map);
  const arenas = players.map(player => makeArena(map, player, shop.offer(1), seededRandom(seed + player.seat), walkable));
  let nextEnemyId = 0;
  let spawnInterval = rules.initialSpawnIntervalSeconds;
  let nextSpawn = Infinity;
  let nextRound = Infinity;
  let nextIncome = Infinity;
  let variant = 0;
  let finished = false;
  let lastStandSpawned = false;
  let bossPhase = false;
  let time = 0;
  let battleAt = options.preparation ?? rules.preparationSeconds ?? 30;
  let pendingTime = 0;
  let baseIncome = rules.baseIncomePerTick;
  let wave = 1;
  let speed = speedOptions.has(options.speed) ? options.speed : 1;

  const arenaFor = seat => arenas.find(arena => arena.seat === seat);
  const aliveArenas = () => arenas.filter(arena => arena.alive);

  function newOffer(arena) {
    arena.shop = shop.offer(wave);
    arena.shopVersion += 1;
  }

  function paidPrice(tower) {
    return tower.freeRerolls > 0 ? 0 : rules.basePaidRerollGold + tower.rollsPaid * rules.paidRerollGoldStep + Math.max(0, wave - 20) * 100;
  }

  function action(seat, input) {
    const arena = arenaFor(seat);
    if (!arena?.alive || finished) return false;
    const tower = arena.tower;
    if (bossPhase && ['buy', 'reroll', 'market', 'duplicate'].includes(input.type)) return false;
    switch (input.type) {
      case 'buy': {
        if (input.version !== arena.shopVersion || !Number.isInteger(input.slot)) return false;
        const item = arena.shop[input.slot];
        if (!purchase(tower, item, time)) return false;
        rememberPurchase(arena, item, wave);
        arena.shop[input.slot] = null;
        arena.shopVersion += 1;
        return true;
      }
      case 'reroll': {
        const price = paidPrice(tower);
        if (tower.gold < price) return false;
        tower.gold -= price;
        if (tower.freeRerolls) tower.freeRerolls -= 1;
        else tower.rollsPaid += 1;
        newOffer(arena);
        return true;
      }
      case 'market': {
        if (!tower.marketOpen) return false;
        const item = shop.market.find(offer => offer.id === input.id);
        if (!item || !purchase(tower, item, time)) return false;
        rememberPurchase(arena, item, wave);
        tower.marketOpen = false;
        return true;
      }
      case 'treasure': {
        if (!tower.treasure) return false;
        tower.gold += Math.floor(tower.treasure.value);
        tower.treasure = null;
        return true;
      }
      case 'duplicate': {
        const target = tower.weapons.get(input.id);
        if (!tower.duplicated || target?.item.rarity !== 'rare') return false;
        target.copies += tower.duplicated;
        tower.duplicated = 0;
        return true;
      }
      case 'clear':
        return time >= battleAt && clearArena(arena, true);
      case 'repair':
        return time >= battleAt && repairTower(arena);
      case 'go':
        if (seat !== 1 || time >= battleAt) return false;
        battleAt = time;
        return true;
      case 'speed':
        if (seat !== 1 || !speedOptions.has(input.value)) return false;
        speed = input.value;
        return true;
      default:
        return false;
    }
  }

  function leave(seat) {
    const arena = arenaFor(seat);
    if (arena?.alive && !finished) {
      arena.tower.health = 0;
      checkEliminations();
    }
  }

  function actBot(arena) {
    if (arena.now < arena.nextBot) return;
    const tower = arena.tower;
    arena.nextBot = time + 1.5 + arena.random() * 2.5;
    if (time >= battleAt && tower.health <= tower.maxHealth * 0.75) repairTower(arena);
    if (tower.health < tower.maxHealth * 0.21 && tower.clears > 0 && time > battleAt) {
      action(arena.seat, { type: 'clear' });
      return;
    }
    const wantDamage = tower.weapons.size < 2 || arena.enemies.length > 15;
    const slots = arena.shop.map((item, index) => ({ item, index }))
      .filter(({ item }) => item && item.gold <= tower.gold && item.name !== 'Black Market');
    slots.sort((a, b) => botScore(b.item, tower, wantDamage) - botScore(a.item, tower, wantDamage));
    const choice = slots[0];
    if (choice && botScore(choice.item, tower, wantDamage) >= 0) {
      action(arena.seat, { type: 'buy', slot: choice.index, version: arena.shopVersion });
    } else if (tower.freeRerolls || (tower.gold >= 3000 && arena.random() < 0.35)) {
      action(arena.seat, { type: 'reroll' });
    }
  }

  function beginRound() {
    wave += 1;
    variant = wave === 13 || wave === 25 ? 14 : Math.floor(random() * 8);
    const capped = spawnInterval < 0.48 - 1e-9;
    if (!capped) spawnInterval -= 0.08;
    nextSpawn = time + spawnInterval;
    const incomeBonus = rules.baseIncomePerRound ?? 0;
    baseIncome += incomeBonus;
    for (const arena of aliveArenas()) {
      growEnemies(arena, wave, arenas.length === 1);
      if (capped) arena.damagePerSecond = wave > 30 && arenas.length > 1 ? 1.05 : 1.03;
      roundUpgrades(arena.tower);
      startRoundWeapons(arena, attacks);
      newOffer(arena);
      arena.emit({ kind: 'round', wave, incomeBonus });
    }
  }

  function spawnWave() {
    const active = aliveArenas();
    const spawns = planSpawns(active.map(arena => ({ arena: arena.layout, variant, multipliers: arena.multipliers })));
    for (let index = 0; index < spawns.length; index += 1) {
      const spawn = spawns[index];
      const arena = active[index];
      const archetype = statsByEnemy.get(spawn.unitId);
      for (let count = 0; count < spawn.count; count += 1) {
        const enemy = createEnemy(arena, spawn, archetype, ++nextEnemyId);
        arena.enemies.push(enemy);
      }
    }
  }

  function checkEliminations() {
    let left = aliveArenas().length;
    for (const arena of arenas) {
      if (!arena.alive || arena.tower.health > 0) continue;
      clearArena(arena, false);
      arena.alive = false;
      arena.place = left;
      arena.finishedAt = time;
      arena.tower.health = 0;
      arena.hits = [];
      arena.fields = [];
      arena.emit({ kind: 'defeat', place: left });
      left -= 1;
    }
    if (arenas.length > 1 && left <= Math.floor(arenas.length / 2)) {
      for (const arena of arenas) {
        if (!arena.alive || arena.won) continue;
        arena.won = true;
        arena.emit({ kind: 'victory', bossDefeated: arena.bossDefeated });
      }
    }
    if (arenas.length > 1 && left === 1) {
      const [last] = aliveArenas();
      if (!last.lastStand) {
        last.lastStand = true;
        last.emit({ kind: 'lastStand' });
      }
      if (wave >= 31 && !lastStandSpawned) {
        lastStandSpawned = true;
        bossPhase = true;
        nextSpawn = Infinity;
        nextRound = Infinity;
        last.shop = last.shop.map(() => null);
        last.shopVersion += 1;
        for (const enemy of last.enemies) enemy.dead = true;
        const archetype = { family: 'Samwise', armorType: 'divine', attackRange: 128, bounty: 0, damagePoint: 0 };
        const angle = random() * 2 * Math.PI;
        const spawn = { unitId: 'samwise', x: last.layout.x + 1200 * Math.cos(angle), y: last.layout.y + 1200 * Math.sin(angle),
          health: 20_000_000, speed: 200, damageBase: 24_999, attackCooldown: 0.5 };
        const enemy = createEnemy(last, spawn, archetype, ++nextEnemyId);
        enemy.cc = 0.01;
        last.enemies.push(enemy);
        last.emit({ kind: 'boss' });
      }
    }
    finished = left === 0 || (bossPhase && aliveArenas().some(arena => arena.bossDefeated));
  }

  function awardChallenges() {
    const elapsed = time - battleAt;
    const first = nextChallenge;
    while (nextChallenge < timedChallenges.length && timedChallenges[nextChallenge].seconds <= elapsed + 1e-9) nextChallenge += 1;
    if (nextChallenge > first) {
      const due = timedChallenges.slice(first, nextChallenge);
      for (const arena of arenas) if (arena.alive && !arena.bot) checkChallenges(arena, due);
    }
    for (const arena of arenas) {
      if (arena.alive && !arena.bot && arena.bossDefeated && elapsed + 1e-9 >= (bossChallenge[0]?.seconds ?? Infinity)) {
        checkChallenges(arena, bossChallenge);
      }
    }
  }

  function step(dt) {
    if (finished) return;
    time += dt;
    for (const arena of arenas) {
      arena.now = time;
      if (arena.bot && arena.alive) actBot(arena);
    }
    if (time < battleAt) return;
    if (nextSpawn === Infinity && !bossPhase) {
      nextSpawn = battleAt + spawnInterval;
      nextRound = battleAt + rules.roundSeconds;
      nextIncome = battleAt + rules.baseIncomeIntervalSeconds;
      for (const arena of arenas) arena.emit({ kind: 'round', wave });
    }
    if (time >= nextRound - 1e-9) {
      nextRound += rules.roundSeconds;
      beginRound();
    }
    if (time >= nextSpawn - 1e-9) {
      nextSpawn += spawnInterval;
      spawnWave();
    }
    if (time >= nextIncome - 1e-9) {
      nextIncome += rules.baseIncomeIntervalSeconds;
      for (const arena of aliveArenas()) {
        tickEconomy(arena.tower, baseIncome);
        arena.waveBonusGold += baseIncome - rules.baseIncomePerTick;
        for (const enemy of arena.enemies) {
          if (enemy.dead || enemy.id === 'samwise') continue;
          enemy.damageBase = Math.trunc(enemy.damageBase * arena.damagePerSecond);
          enemy.damage = Math.max(0, enemy.damageBase + 1);
        }
      }
    }
    for (const arena of aliveArenas()) {
      for (const enemy of arena.enemies) {
        enemy.previousX = enemy.x;
        enemy.previousY = enemy.y;
      }
      tickWeapons(arena, attacks, dt);
      tickImpacts(arena);
      tickEnemies(arena, dt);
      arena.enemies = arena.enemies.filter(enemy => !enemy.dead);
    }
    checkEliminations();
    awardChallenges();
  }

  function tick(dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    pendingTime += dt;
    while (!finished && pendingTime + 1e-9 >= combatStep) {
      pendingTime -= combatStep;
      step(combatStep);
    }
  }

  function snapshot(seat, viewed = seat, since = 0) {
    const arena = arenaFor(seat);
    const tower = arena?.tower;
    const selected = arenaFor(viewed) ?? arena ?? arenas[0];
    const observed = selected.tower;
    const flamecaster = selected.alive && observed.weapons.get(flamecasterId);
    const preparation = Math.max(0, battleAt - time);
    const roundAt = Number.isFinite(nextRound) ? nextRound : battleAt + rules.roundSeconds;
    return {
      time, elapsed: Math.max(0, time - battleAt), preparation,
      wave, speed, finished, bossPhase, seat: arena?.seat, selected: selected.seat,
      schedule: finished || bossPhase ? null : {
        wave: preparation > 0 ? 1 : wave + 1,
        waveIn: preparation > 0 ? preparation : Math.max(0, roundAt - time),
        skillsWave: wave + 1,
        skillsIn: Math.max(0, roundAt - time),
      },
      player: tower ? {
        gold: tower.gold, income: baseIncome + tower.income * tower.incomeMultiplier,
        health: tower.health, maxHealth: tower.maxHealth, shield: tower.shield, maxShield: tower.maxShield,
        armor: tower.armor + tower.bonusArmor, regen: tower.regen, kills: tower.kills, damage: tower.damage,
        towerDamage: tower.towerDamage, healed: tower.healed, repairCooldown: Math.max(0, tower.repairAt - time),
        waveBonusGold: arena.waveBonusGold,
        weapons: [...tower.weapons.values()].map(({ item, copies, damage }) => ({ id: item.id, name: item.name, rarity: item.rarity, school: item.damageTypes[0], copies, damage: damage ?? 0 })),
        upgrades: [...tower.upgrades.entries()],
        clears: tower.clears, price: paidPrice(tower), freeRerolls: tower.freeRerolls,
        treasure: tower.treasure ? Math.floor(tower.treasure.value) : null,
        shop: arena.shop, version: arena.shopVersion, market: tower.marketOpen ? shop.market : null,
        duplicate: tower.duplicated, place: arena.place, won: arena.won, lastStand: arena.lastStand, alive: arena.alive,
        challenges: [...arena.challengeUnlocks],
      } : null,
      seats: arenas.map(a => ({
        seat: a.seat, name: a.name, color: a.color, alive: a.alive, won: a.won, place: a.place,
        health: a.tower.health, maxHealth: a.tower.maxHealth, kills: a.tower.kills, bot: a.bot,
      })),
      arena: {
        color: selected.color, skin: selected.skin, layout: selected.layout, health: observed.health, maxHealth: observed.maxHealth,
        shield: observed.shield, maxShield: observed.maxShield, alive: selected.alive,
        enemyScale: selected.multipliers,
        enemies: selected.enemies.map(enemy => ({
          key: enemy.key, id: enemy.id, family: enemy.family, x: enemy.x, y: enemy.y,
          previousX: enemy.previousX, previousY: enemy.previousY,
          hp: enemy.hp, maxHp: enemy.maxHp, walking: enemy.walking, attackAt: enemy.attackAt,
          frost: enemy.frost, stun: enemy.stun, fire: enemy.fire, poison: Boolean(enemy.poison.length),
        })),
        effects: selected.fields.map(field => ({ x: field.x, y: field.y, mine: field.mine, summon: field.summon, slot: field.state.item.slot })),
        projectiles: selected.hits.map(hit => ({ id: hit.id, ...hit.position })),
        flamecaster: flamecaster?.spec ? {
          phase: flamecaster.phase, rate: orbitRate(flamecaster, observed.attackSpeed), copies: flamecaster.copies,
        } : null,
        events: selected.events.filter(event => event.seq > since),
      },
    };
  }

  return { tick, action, leave, snapshot, get speed() { return speed; }, get finished() { return finished; } };
}

function botScore(item, tower, wantDamage) {
  if (item.kind === 'weapon') return (wantDamage ? 8 : 3) + item.gold / 2000;
  if (item.name === 'Philosopher\'s Stone' && tower.maxHealth < 1800) return -1;
  if (item.name === 'Cursed Treasure' && tower.regen < 80) return -1;
  if (item.name === 'Urn of Avarice') return 15;
  if (item.name === 'Repair Crew' && tower.regen < 50) return 9;
  if (item.name === 'Mana Shield' && tower.shield < 1000) return 8;
  if (item.name.includes('Gold Mine') || item.name === 'Magic Coin') return wantDamage ? 2 : 9;
  return 1;
}
