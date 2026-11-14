import { createSpawnPlanner } from './enemy-spawn.mjs';
import { addWeaponCopies, count, createShop, createTower, goldPerSecond, necromancerSlot, purchase, roundUpgrades, stat, tickEconomy } from './shop.mjs';
import { buildAttacks, cancelProjectiles, clearArena, combatStep, orbitRate, repairTower, startRoundWeapons, tickEnemies, tickImpacts, tickWeapons } from './combat.mjs';
import { checkChallenges, rememberPurchase, survivorChallenge } from './challenges.mjs';

const playerColors = [0xb84836, 0x426bc4, 0x4a9c82, 0x8764ab, 0xcbaf55, 0xd78138, 0x68a149, 0xb96a90];
const boardColors = ['#ff0303', '#0042ff', '#1be7ba', '#550081', '#fefc00', '#fe890d', '#21bf00', '#e45caf'];
const damageSchools = ['Normal', 'Piercing', 'Magic', 'Siege', 'Chaos', 'Spikes'];
export const speedOptions = [1, 1.5, 2, 3];
const defaultEnemyHealth = { Bandit: 300, Brigand: 600, BanditRider: 600, Catapult: 600 };
const defaultEnemyArmor = { Bandit: 'medium', Brigand: 'small', BanditRider: 'large', Catapult: 'hero' };
const hasDirectDefense = tower => tower.spikes > 0 || [...tower.weapons.values()].some(({ item }) => item.slot !== necromancerSlot);

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
    tower: createTower(map.initialRules.startingGold, map.initialRules),
    walkable,
    combatRules: map.combatRules,
    shop: offers,
    shopVersion: 1,
    shopHistory: { Income: 0, Utility: 0, Damage: 0 },
    enemies: [],
    hits: [],
    enemyHits: [],
    waves: [],
    fields: [],
    events: [],
    playerEvents: [],
    purchaseLog: [],
    challengeUnlocks: new Set(),
    spentDamage: 0,
    spentIncome: 0,
    spentBounty: 0,
    score: player.score ?? 0,
    departed: false,
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
    if (['round', 'boss', 'defeat', 'victory', 'lastStand'].includes(event.kind)) {
      arena.playerEvents.push(arena.events.at(-1));
      if (arena.playerEvents.length > 12) arena.playerEvents.shift();
    }
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
  const transmute = count(arena.tower, 'Transmute');
  const multiplier = transmute && arena.random() < 0.10 ? 1 + transmute : 1;
  const scaledBounty = Math.floor(waveBounty * arena.tower.bountyMultiplier);
  return {
    key, id: spawn.unitId, family: archetype.family,
    x: spawn.x - arena.layout.x, y: spawn.y - arena.layout.y,
    maxHp, hp: maxHp, speed: spawn.speed ?? 50, bounty: scaledBounty * multiplier,
    bonusBounty: (scaledBounty - waveBounty + 1) * multiplier - 1,
    armor: archetype.armorType ?? defaultEnemyArmor[archetype.family], armorValue: archetype.armorValue ?? 0,
    healthRegen: (archetype.healthRegen ?? 0) * (arena.multipliers.health > 1 ? 1 + arena.multipliers.health : 1),
    damageBase: spawn.damageBase ?? 9,
    damage: Math.max(0, (spawn.damageBase ?? 9) + 1),
    attackRange: archetype.attackRange ?? 128, attackCooldown: spawn.attackCooldown ?? 1,
    damagePoint: archetype.damagePoint, backswing: archetype.backswing,
    projectile: archetype.projectile,
    damageTaken: arena.damageTaken, collision: archetype.collision ?? 1,
    lifetime: spawn.lifetime, expires: arena.now + (spawn.lifetime ?? 0),
    facing: spawn.facing === undefined ? Math.atan2(arena.layout.y - spawn.y, arena.layout.x - spawn.x) : spawn.facing * Math.PI / 180,
    walking: true, nextAttack: 0, attackAt: -10, attackEnd: -10, hitAt: -10, cc: arena.cc,
    stun: 0, frost: 0, frostTime: 0, fire: 0, bleed: 0, spikesVulnerability: 0,
    poison: [], vulnerability: new Map(), dead: false,
  };
}

function sampleDamage(tower) {
  for (const weapon of tower.weapons.values()) {
    if (!weapon.damage) continue;
    weapon.copySeconds = (weapon.copySeconds ?? 0) + weapon.copies;
    weapon.dps = Math.trunc(weapon.damage / weapon.copySeconds);
  }
  if (tower.spikes > 0) {
    tower.spikeSeconds = (tower.spikeSeconds ?? 0) + 1;
    tower.spikeDps = Math.trunc(tower.towerDamage / tower.spikeSeconds);
  }
}

function weaponStats({ item, copies, damage = 0, dps = 0, charges }) {
  return { id: item.id, name: item.name, rarity: item.rarity, school: item.damageTypes[0], copies, damage, dps, charges };
}

function describeTower(arena) {
  const { tower } = arena;
  return {
    incomeMultiplier: Math.round(100 * (tower.incomeMultiplier - 1)),
    incomeBonus: tower.income * tower.incomeMultiplier,
    bountyMultiplier: Math.round(100 * (tower.bountyMultiplier - 1)),
    transmute: 100 * count(tower, 'Transmute'),
    incomeEarned: tower.incomeEarned,
    bountyEarned: tower.bountyEarned,
    schools: Object.fromEntries(damageSchools.map(school => [school, Math.round(100 * stat(tower, school))])),
    spikePower: tower.spikes,
    spikeDps: tower.spikeDps ?? 0,
    weapons: [...tower.weapons.values()].map(weaponStats),
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
  const glaiveId = map.weapons.find(weapon => weapon.slot === 211)?.abilityId;
  const planSpawns = createSpawnPlanner(map, random);
  const statsByEnemy = new Map(map.enemies.map(enemy => [enemy.id, enemy]));
  const { initialRules: rules } = map;
  const timedChallenges = map.challenges.filter(challenge => challenge.seconds !== null && challenge.id !== survivorChallenge)
    .sort((a, b) => a.seconds - b.seconds);
  const bossChallenge = map.challenges.filter(challenge => challenge.id === survivorChallenge);
  let nextChallenge = 0;
  const walkable = terrainWalkability(map);
  const arenas = [...players].sort((a, b) => a.seat - b.seat)
    .map(player => makeArena(map, player, shop.offer(1), seededRandom(seed + player.seat), walkable));
  let nextEnemyId = 0;
  let spawnInterval = rules.initialSpawnIntervalSeconds;
  let nextSpawn = Infinity;
  let nextRound = Infinity;
  let nextIncome = Infinity;
  let variant = 0;
  let finished = false;
  let bossPhase = false;
  let time = 0;
  let nextDescription = 5;
  let incomeTicks = 0;
  const preparationDuration = options.preparation ?? rules.preparationSeconds ?? 30;
  let battleAt = preparationDuration;
  let pendingTime = 0;
  let baseIncome = rules.baseIncomePerTick;
  let wave = 1;
  let speed = speedOptions.includes(options.speed) ? options.speed : 1;

  const arenaFor = seat => arenas.find(arena => arena.seat === seat);
  const aliveArenas = () => arenas.filter(arena => arena.alive);
  const roundDeadline = () => Number.isFinite(nextRound) ? nextRound : battleAt + rules.roundSeconds;
  const shopDuration = arena => arena?.shopDuration ?? preparationDuration + rules.roundSeconds;

  function newOffer(arena, paid = false) {
    arena.shop = shop.offer(wave, wave > 1 ? arena.shopHistory : undefined, paid);
    arena.shopVersion += 1;
  }

  function refreshDescriptions() {
    if (time + 1e-9 < nextDescription) return;
    nextDescription += 5;
    for (const arena of aliveArenas()) arena.description = describeTower(arena);
  }

  function rerollPrice(tower) {
    if (wave === 1) return tower.freeRerolls > 0 ? 0 : null;
    if (!tower.roundRerolls) return null;
    return rules.basePaidRerollGold + tower.rollsPaid * rules.paidRerollGoldStep + Math.max(0, wave - 20) * 100;
  }

  function action(seat, input) {
    const arena = arenaFor(seat);
    if (!arena?.alive || finished) return false;
    const tower = arena.tower;
    if (arenas.length > 1 && wave >= 31 && ['buy', 'reroll', 'market', 'duplicate'].includes(input.type)) return false;
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
        const price = rerollPrice(tower);
        if (price === null || tower.gold < price) return false;
        tower.gold -= price;
        if (wave === 1) tower.freeRerolls -= 1;
        else {
          tower.roundRerolls -= 1;
          tower.rollsPaid += 1;
        }
        newOffer(arena, price > 0);
        arena.shopDuration = Math.max(0, roundDeadline() - time);
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
        addWeaponCopies(tower, target, tower.duplicated);
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
        if (seat !== 1 || !speedOptions.includes(input.value)) return false;
        speed = input.value;
        return true;
      default:
        return false;
    }
  }

  function leave(seat) {
    const arena = arenaFor(seat);
    if (arena) arena.departed = true;
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
    const wantDamage = !hasDirectDefense(tower) || tower.weapons.size < 2 || arena.enemies.length > 15;
    const slots = arena.shop.map((item, index) => ({ item, index }))
      .filter(({ item }) => item && item.gold <= tower.gold && item.name !== 'Black Market'
        && (item.slot !== necromancerSlot || hasDirectDefense(tower)));
    slots.sort((a, b) => botScore(b.item, tower, wantDamage) - botScore(a.item, tower, wantDamage));
    const choice = slots[0];
    if (choice && botScore(choice.item, tower, wantDamage) >= 0) {
      action(arena.seat, { type: 'buy', slot: choice.index, version: arena.shopVersion });
    } else if (rerollPrice(tower) === 0 || (tower.roundRerolls && tower.gold >= 3000 && arena.random() < 0.35)) {
      action(arena.seat, { type: 'reroll' });
    }
  }

  function beginRound() {
    wave += 1;
    variant = Math.floor(random() * 8);
    if (wave === 13 || wave === 25) variant = 14;
    const capped = spawnInterval < 0.48 - 1e-9;
    if (!capped) spawnInterval -= 0.08;
    nextSpawn = time + spawnInterval;
    const incomeBonus = rules.baseIncomePerRound ?? 0;
    baseIncome += incomeBonus;
    const active = aliveArenas();
    const shopRefresh = arenas.length === 1 || wave < 31;
    for (const arena of active) {
      growEnemies(arena, wave, arenas.length === 1);
      if (capped) arena.damagePerSecond = wave > 30 && arenas.length > 1 ? 1.05 : 1.03;
      roundUpgrades(arena.tower);
      startRoundWeapons(arena, attacks);
      if (shopRefresh) {
        arena.tower.roundRerolls = 1 + Math.min(5, Math.floor(incomeTicks / 150));
        newOffer(arena);
        arena.shopDuration = rules.roundSeconds;
      } else if (wave === 31) {
        arena.shop = arena.shop.map(() => null);
        arena.shopVersion += 1;
        arena.tower.roundRerolls = 0;
        arena.tower.marketOpen = false;
      }
      arena.emit({ kind: 'round', wave, incomeBonus, shopRefresh });
    }
    if (arenas.length > 1 && wave >= 31 && active.length === 1) startBoss(active[0]);
  }

  function startBoss(arena) {
    bossPhase = true;
    nextSpawn = Infinity;
    nextRound = Infinity;
    arena.enemies.length = 0;
    cancelProjectiles(arena);
    const archetype = { family: 'Samwise', armorType: 'divine', attackRange: 128, bounty: 0, ...map.bossProfile };
    const angle = random() * 2 * Math.PI;
    const spawn = { unitId: 'samwise', x: arena.layout.x + 1200 * Math.cos(angle), y: arena.layout.y + 1200 * Math.sin(angle),
      health: 20_000_000, speed: 200, damageBase: 24_999, attackCooldown: 0.5 };
    const enemy = createEnemy(arena, spawn, archetype, ++nextEnemyId);
    enemy.cc = 0.01;
    arena.enemies.push(enemy);
    arena.emit({ kind: 'boss' });
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
      arena.emit({ kind: 'defeat', place: left, postVictory: arena.lastStand });
      left -= 1;
    }
    if (arenas.length > 1 && left <= Math.floor(arenas.length / 2)) {
      for (const arena of aliveArenas()) {
        if (arena.won) continue;
        arena.won = true;
        arena.emit({ kind: 'victory' });
      }
    }
    if (arenas.length > 1 && left === 1) {
      const [last] = aliveArenas();
      if (!last.lastStand) {
        last.lastStand = true;
        last.emit({ kind: 'lastStand' });
      }
    }
    const winner = bossPhase ? aliveArenas().find(arena => arena.bossDefeated) : null;
    if (winner) {
      winner.place = 1;
      winner.finishedAt = time;
      winner.emit({ kind: 'victory', bossDefeated: true });
    }
    finished = left === 0 || Boolean(winner);
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
    if (time + 1e-9 < battleAt) {
      refreshDescriptions();
      return;
    }
    if (nextSpawn === Infinity && !bossPhase) {
      nextSpawn = battleAt + spawnInterval;
      nextRound = battleAt + rules.roundSeconds;
      nextIncome = battleAt + rules.baseIncomeIntervalSeconds;
      for (const arena of arenas) arena.emit({ kind: 'round', wave });
    }
    const paysIncome = time >= nextIncome - 1e-9;
    if (paysIncome) incomeTicks += 1;
    if (time >= nextRound - 1e-9) {
      nextRound += rules.roundSeconds;
      beginRound();
    }
    if (time >= nextSpawn - 1e-9) {
      nextSpawn += spawnInterval;
      spawnWave();
    }
    if (paysIncome) {
      nextIncome += rules.baseIncomeIntervalSeconds;
      for (const arena of aliveArenas()) {
        sampleDamage(arena.tower);
        tickEconomy(arena.tower, baseIncome);
        arena.waveBonusGold += baseIncome - rules.baseIncomePerTick;
        for (const enemy of arena.enemies) {
          if (enemy.dead || Math.hypot(enemy.x, enemy.y) > 1200 + 1e-6) continue;
          enemy.damageBase = Math.trunc(enemy.damageBase * arena.damagePerSecond);
          enemy.damage = Math.max(0, enemy.damageBase + 1);
        }
      }
    }
    for (const arena of aliveArenas()) {
      tickWeapons(arena, attacks, dt);
      tickImpacts(arena);
      for (const enemy of arena.enemies) {
        enemy.previousX = enemy.x;
        enemy.previousY = enemy.y;
      }
      tickEnemies(arena, dt);
      arena.enemies = arena.enemies.filter(enemy => !enemy.dead);
    }
    checkEliminations();
    awardChallenges();
    refreshDescriptions();
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
    const glaive = selected.alive && observed.weapons.get(glaiveId);
    const preparation = Math.max(0, battleAt - time);
    const roundAt = roundDeadline();
    const incomeDetails = arena && (arena.description ?? describeTower(arena));
    return {
      time, elapsed: Math.max(0, time - battleAt), preparation,
      wave, speed, finished, bossPhase, seat: arena?.seat, selected: selected.seat,
      playerEvents: arena?.playerEvents ?? [],
      schedule: finished || bossPhase ? null : {
        wave: preparation > 0 ? 1 : wave + 1,
        waveIn: preparation > 0 ? preparation : Math.max(0, roundAt - time),
        shopLife: Math.max(0, Math.min(1, (roundAt - time) / (shopDuration(arena) || 1))),
        shopCloses: arenas.length > 1 && wave >= 30,
      },
      player: tower ? {
        gold: tower.gold, income: goldPerSecond(tower, baseIncome),
        health: tower.health, maxHealth: tower.maxHealth, shield: tower.shield, maxShield: tower.maxShield,
        armor: tower.armor + tower.bonusArmor, regen: tower.regen, kills: tower.kills, damage: tower.damage,
        towerDamage: tower.towerDamage, weaponDamage: tower.weaponDamage, otherDamage: tower.otherDamage,
        directDefense: hasDirectDefense(tower), healed: tower.healed, repairCooldown: Math.max(0, tower.repairAt - time),
        waveBonusGold: arena.waveBonusGold,
        weapons: [...tower.weapons.values()].map(weaponStats),
        upgrades: [...tower.upgrades.entries()],
        clears: tower.clears, price: rerollPrice(tower), freeRerolls: wave === 1 ? tower.freeRerolls : 0, roundRerolls: tower.roundRerolls,
        treasure: tower.treasure ? Math.floor(tower.treasure.value) : null,
        shop: arena.shop, version: arena.shopVersion, market: tower.marketOpen ? shop.market : null,
        duplicate: tower.duplicated, place: arena.place, won: arena.won, lastStand: arena.lastStand, alive: arena.alive, skin: arena.skin,
        challenges: [...arena.challengeUnlocks],
      } : null,
      seats: arenas.map(a => ({
        seat: a.seat, name: a.name, color: a.color, alive: a.alive, won: a.won, place: a.place,
        health: a.tower.health, maxHealth: a.tower.maxHealth, kills: a.tower.kills, bot: a.bot,
        boardColor: a.alive ? boardColors[a.seat - 1] : '#4f5055',
        clear: a.departed ? null : a.alive && a.tower.clears > 0,
        damageInvestment: Math.trunc(a.spentDamage / 500),
        incomeInvestment: Math.trunc((a.spentIncome + a.spentBounty) / 500),
        score: a.score,
      })),
      incomeDetails: arena ? {
        incomeMultiplier: incomeDetails.incomeMultiplier,
        incomeBonus: incomeDetails.incomeBonus, bountyMultiplier: incomeDetails.bountyMultiplier, transmute: incomeDetails.transmute,
        incomeEarned: incomeDetails.incomeEarned, bountyEarned: incomeDetails.bountyEarned,
        gold: tower.gold, currentIncome: goldPerSecond(tower, baseIncome), baseIncome,
        incomeSpent: arena.spentIncome, bountySpent: arena.spentBounty, rerolls: 1 + Math.min(5, Math.floor(incomeTicks / 150)),
      } : null,
      observedStats: {
        ...(selected.description ?? describeTower(selected)),
        name: selected.name, damage: observed.damage, weaponDamage: observed.weaponDamage, towerDamage: observed.towerDamage,
        otherDamage: observed.otherDamage, kills: observed.kills, healed: observed.healed,
      },
      arena: {
        color: selected.color, skin: selected.skin, layout: selected.layout, health: observed.health, maxHealth: observed.maxHealth,
        shield: observed.shield, maxShield: observed.maxShield, alive: selected.alive,
        enemyScale: selected.multipliers,
        enemies: selected.enemies.map(enemy => ({
          key: enemy.key, id: enemy.id, family: enemy.family, x: enemy.x, y: enemy.y,
          previousX: enemy.previousX, previousY: enemy.previousY,
          hp: enemy.hp, maxHp: enemy.maxHp, walking: enemy.walking, facing: enemy.facing, speed: enemy.movementRate,
          attackAt: enemy.attackAt, attackEnd: enemy.attackEnd, attackRelease: enemy.attackRelease, hitAt: enemy.hitAt,
          frost: enemy.frost, stun: enemy.stun, fire: enemy.fire, poison: Boolean(enemy.poison.length),
        })),
        effects: selected.fields.map(field => ({ x: field.x, y: field.y, mine: field.mine, summon: field.summon, slot: field.state.item.slot })),
        projectiles: selected.hits.map(hit => ({ id: hit.id, ...hit.position })),
        glaive: glaive?.spec ? { copies: glaive.copies, phase: glaive.phase, rate: orbitRate(glaive, observed.attackSpeed) } : null,
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
