import { count, heal, necromancerSlot, stat, weaponMultiplier } from './shop.mjs';

const sizeMultiplier = {
  Normal: { medium: 2 },
  Piercing: { small: 2 },
  Magic: { large: 2 },
  Siege: { hero: 2 },
  Chaos: {},
};

const effectTint = {
  Normal: 0xf5c779, Piercing: 0x8bf091, Magic: 0xb390ff, Siege: 0xffb16e,
  Chaos: 0xe45a7c, Fire: 0xff7146, Frost: 0x8adfff, Poison: 0xa4ec4f, Spikes: 0xc8a28e,
};
const towerSpikes = Symbol('towerSpikes');
export const repairFraction = 0.2;
export const repairInterval = 45;
export const combatStep = 0.025;
export const flamecasterOffsets = [0, 180, 45, 225, 90, 270, 135, 315].map(degrees => degrees * Math.PI / 180);
export const teslaFlight = ({ from, to }) => Math.max(0.033, Math.hypot(to.x - from.x, to.y - from.y) / 1800);

export function orbitRate(state, attackSpeed) {
  if (state.item.slot === 17) return (1.25 + (attackSpeed - 1)) * Math.PI / (180 * 0.03);
  return state.spec.orbit * attackSpeed;
}

const specialWeapons = {
  17: { orbit: true, radius: 180 },
  44: { field: 3, pulse: 0.5, radius: 300, poisonCloud: true },
  104: { lock: 2, rocketRadius: 375 },
  125: { alternate: true },
  127: { alternate: true },
  [necromancerSlot]: { raisesOnKill: true },
  132: { phoenix: true },
  200: { summon: 5, pulse: 1, summonDamage: 2500, radius: 250 },
  204: { mine: 15, radius: 300 },
  207: { towerArea: true },
  211: { orbit: Math.PI / 36 / 0.03, radius: 150, glaive: true },
  212: { field: 15, pulse: 1.5, towerArea: true, radius: 600, roundCast: true },
  214: { parasite: true },
};

function numberFrom(text, pattern, fallback = 0) {
  return Number(pattern.exec(text)?.[1] ?? fallback);
}

export function buildAttacks(weapons) {
  return new Map(weapons.map(weapon => {
    const description = weapon.effects.join('\n');
    const primary = weapon.damageTypes[0];
    const types = weapon.attackType;
    const spec = {
      ...specialWeapons[weapon.slot],
      primary,
      color: effectTint[weapon.damageTypes[1]] ?? effectTint[primary],
      splash: numberFrom(types, /Splash \((\d+)/),
      area: numberFrom(types, /Area \((\d+)/),
      hits: numberFrom(types, /(?:Bounce|Barrage) \((\d+)/, 1),
      bounce: types.includes('Bounce'),
      wave: types.includes('Wave'),
      waveExtra: numberFrom(types, /\(\+(\d+)/),
      projectile: weapon.slot === 104 ? { ...weapon.projectile, weaponType: 'missile', speed: 600 } : weapon.projectile ?? {},
      waveProfile: weapon.waveProfile,
      radialArea: types.includes('Enemies In Range'),
      poisonDamage: numberFrom(description, /Poison \((?:[\d.]+% attack speed reduction & )?(\d+) damage/),
      poisonSlow: numberFrom(description, /Poison \((\d+)% attack speed reduction/) / 100,
      frost: numberFrom(description, /Frost \((\d+) stacks/),
      fire: numberFrom(description, /Fire \((\d+)% of damage\)/) / 100,
      stun: numberFrom(description, /Stun \(([\d.]+) seconds?/),
      healPerHit: numberFrom(description, /Heal (\d+) health per enemy hit/),
      healPerSecond: numberFrom(description, /Heal (\d+) health per second/),
      shieldPerHit: numberFrom(description, /grant \+(\d+) Mana Shield per enemy hit/),
      healthPerHit: numberFrom(description, /grant \+(\d+) Max HP per enemy hit/),
      regenPerHit: numberFrom(description, /grant \+([\d.]+) HP Regen per enemy hit/),
      restoreMana: numberFrom(description, /Restores (\d+) mana per second/),
      knockback: numberFrom(description, /Knockback \((\d+)/),
      vulnerability: /increase (\w+) damage taken by (\d+)% for (\d+) seconds?/.exec(description),
      drain: [19, 43, 122].includes(weapon.slot),
      damageReduction: weapon.slot === 114 ? [0.25, 10] : weapon.slot === 201 ? [0.25, 1] : null,
      missChance: weapon.slot === 115 ? [0.25, 2] : null,
    };
    return [weapon.abilityId, spec];
  }));
}

const distance2 = (x, y, a) => (a.x - x) ** 2 + (a.y - y) ** 2;
const living = enemy => !enemy.dead;
const inRange = (enemy, x, y, range) => living(enemy) && distance2(x, y, enemy) <= range ** 2 + 1e-6;
const neighbors = (arena, x, y, range) => arena.enemies.filter(enemy => inRange(enemy, x, y, range));

function pickTarget(arena, candidates) {
  return candidates.length ? candidates[Math.floor(arena.random() * candidates.length)] : null;
}

function timeOnStep(seconds) {
  return seconds > 0 ? Math.max(1, Math.ceil((seconds - 1e-9) / combatStep)) * combatStep : 0;
}

function armorFactor(armor, coefficient = 0.05) {
  return armor >= 0 ? 1 / (1 + coefficient * armor) : 2 - (1 - coefficient) ** -armor;
}

function nearest(enemies, x, y) {
  let target = null;
  let best = Infinity;
  for (const enemy of enemies) {
    const distance = distance2(x, y, enemy);
    if (distance >= best) continue;
    best = distance;
    target = enemy;
  }
  return target;
}

function applyFrost(enemy, stacks, strength) {
  enemy.frostTime = 5;
  enemy.frost = Math.min(50, enemy.frost + stacks);
  if (enemy.frost < 50 || enemy.frozen) return;
  enemy.frozen = true;
  enemy.stun = Math.max(enemy.stun, 3 * enemy.cc * strength);
}

function raiseSkeletalMage(arena, enemy) {
  const tower = arena.tower;
  const state = tower.necromancy;
  if (!state || state.charges < 10) return;
  const radius = state.item.range * (1 + stat(tower, 'area'));
  if (distance2(0, 0, enemy) > radius ** 2) return;
  state.charges -= 10;
  const { x, y } = enemy;
  const crit = tower.critChance > 0 && arena.random() < tower.critChance ? 1 + tower.critPower : 1;
  const facing = (enemy.facing ?? Math.atan2(-y, -x)) + Math.PI;
  arena.fields.push({ state, x, y, radius, mage: true, crit, next: arena.now, until: arena.now + 5 });
  arena.emit({ kind: 'summon', x, y, facing, unitId: 'u005', color: effectTint.Chaos, duration: 5, slot: state.item.slot });
}

function grantKill(arena, enemy, bounty, source) {
  if (enemy.dead) return;
  enemy.dead = true;
  if (enemy.id === 'samwise') arena.bossDefeated = true;
  const tower = arena.tower;
  if (bounty) {
    tower.kills += 1;
    tower.gold += enemy.bounty;
    tower.bountyEarned += enemy.bonusBounty ?? 0;
    heal(tower, 15 * count(tower, 'Mask of Death'));
    tower.shield = Math.min(tower.maxShield, tower.shield + 15 * count(tower, 'Maw of Death'));
    if (source) raiseSkeletalMage(arena, enemy);
    const medallions = count(tower, 'Golden Medallion');
    if (medallions) {
      tower.medallionKills = (tower.medallionKills ?? 0) + 1;
      if (tower.medallionKills >= Math.max(1, Math.floor(500 / medallions))) {
        tower.bountyMultiplier += 0.5;
        tower.medallionKills = 0;
      }
    }
  }
  const ignite = count(tower, 'Ignite');
  if (bounty && ignite && enemy.fireSources) {
    const target = pickTarget(arena, neighbors(arena, enemy.x, enemy.y, 600));
    if (target) {
      for (const [origin, amount] of enemy.fireSources) {
        if (origin !== 'ignite') addFire(arena, target, amount * 0.25 * ignite, 'ignite');
      }
    }
  }
  arena.emit({ kind: 'death', x: enemy.x, y: enemy.y, facing: enemy.facing, unitId: enemy.id, enemyId: enemy.key, bounty: bounty ? enemy.bounty : 0 });
}

function addFire(arena, enemy, amount, source) {
  if (enemy.dead || amount <= 0) return;
  enemy.fireSources ??= new Map();
  enemy.fireSources.set(source, (enemy.fireSources.get(source) ?? 0) + amount);
  if (!(enemy.fireUntil > arena.now)) {
    enemy.fireUntil = arena.now + 600;
    enemy.nextFire = (Math.floor((arena.now + 1e-9) * 2) + 1) / 2;
  }
  enemy.fire = 1;
}

function creditDamage(tower, source, amount) {
  if (source === towerSpikes) tower.towerDamage += amount;
  else if (source?.item) {
    tower.weaponDamage += amount;
    source.damage = (source.damage ?? 0) + amount;
  } else tower.otherDamage += amount;
}

function wound(arena, enemy, amount, school, source, useArmor = true) {
  if (enemy.dead || amount <= 0) return 0;
  const attackType = school === 'Piercing' ? 'Pierce' : school;
  const typeFactor = arena.combatRules?.damageMatrix?.[attackType]?.[enemy.armor] ?? sizeMultiplier[school]?.[enemy.armor] ?? 1;
  const armor = useArmor ? typeFactor * armorFactor(enemy.armorValue ?? 0, arena.combatRules?.armorFactor) : 1;
  const vulnerable = enemy.vulnerability.get(school);
  const damage = amount * armor * (vulnerable ? 1 + vulnerable.amount : 1) * (arena.damageTaken ?? enemy.damageTaken);
  const dealt = Math.min(enemy.hp, damage);
  enemy.hp -= dealt;
  arena.tower.damage += dealt;
  if (school === 'Fire' && source instanceof Map) {
    const fireMultiplier = 1 + stat(arena.tower, 'Fire');
    for (const [origin, portion] of source) creditDamage(arena.tower, origin, dealt * portion * fireMultiplier / amount);
  } else creditDamage(arena.tower, source, dealt);
  if (dealt > 0 && (useArmor || arena.now >= (enemy.nextPeriodicImpact ?? 0))) {
    enemy.hitAt = arena.now;
    arena.emit({ kind: 'impact', x: enemy.x, y: enemy.y, enemyId: enemy.key, unitId: enemy.id, color: effectTint[school] });
    if (!useArmor) enemy.nextPeriodicImpact = arena.now + 0.24;
  }
  if (enemy.hp <= 0) grantKill(arena, enemy, true, source);
  return damage;
}

function critical(tower, random) {
  const guaranteed = Math.max(0, tower.critChance - 1);
  return random() < tower.critChance ? 1 + tower.critPower + guaranteed : 1;
}

function strike(arena, state, enemy, portion = 1, damageOverride, critOverride, applyStun = true) {
  if (!enemy || enemy.dead) return;
  const tower = arena.tower;
  const { item, spec } = state;
  const crit = critOverride ?? critical(tower, arena.random);
  let damage = (damageOverride ?? item.baseDamage) * weaponMultiplier(tower, item, enemy) * portion * crit;
  const frostStrength = 1 + stat(tower, 'Frost');
  if (spec.frost) damage *= frostStrength;
  if (spec.primary === 'Chaos' && enemy.armor !== 'divine') damage *= 0.5 + 1.5 * arena.random();
  if (item.slot === 113) damage *= 1 + tower.maxHealth / 50000;
  if (item.slot === 117) damage *= 1 + tower.maxShield / 100000;
  if (item.slot === 119) damage *= 1 + 0.1 * (state.copies - 1);
  if (item.slot === 130) damage *= 1 + (tower.armor + tower.bonusArmor) * 0.01;
  if (item.slot === 134) damage *= 1 + tower.regen / 2000;
  if ([104, 207].includes(item.slot)) damage *= 1 + 1.25 * stat(tower, 'area');
  const dealt = wound(arena, enemy, damage, spec.primary, state);
  if (spec.stun && applyStun) enemy.stun = Math.max(enemy.stun, spec.stun * (1 + stat(tower, 'stunDuration')) * enemy.cc);
  if (spec.frost) applyFrost(enemy, spec.frost, frostStrength);
  if (spec.poisonDamage && !enemy.dead) {
    enemy.poison.push({ left: 2, amount: spec.poisonDamage * (1 + stat(tower, 'Poison')) * portion * crit / 2, source: state });
    if (spec.poisonSlow) enemy.attackSlow = { amount: spec.poisonSlow, expires: arena.now + 2 };
  }
  if (spec.fire) addFire(arena, enemy, dealt * spec.fire, state);
  if (spec.damageReduction) enemy.weaken = { amount: spec.damageReduction[0], expires: arena.now + spec.damageReduction[1] };
  if (spec.missChance) enemy.miss = { amount: spec.missChance[0], expires: arena.now + spec.missChance[1] };
  if (spec.vulnerability) {
    const [, school, pct, duration] = spec.vulnerability;
    enemy.vulnerability.set(school, { amount: Number(pct) / 100, expires: arena.now + Number(duration) });
  }
  if (spec.knockback && !enemy.dead) enemy.knockback = { remaining: spec.knockback * enemy.cc, next: arena.now + 0.03 };
  heal(tower, (spec.healPerHit + spec.healPerSecond * (item.cooldownSeconds ?? 0)) * crit);
  tower.shield = Math.min(tower.maxShield, tower.shield + (spec.shieldPerHit + spec.restoreMana * (item.cooldownSeconds ?? 0)) * crit);
  tower.regen += spec.regenPerHit * crit * (spec.poisonCloud ? portion * tower.attackSpeed : 1);
  tower.maxHealth += spec.healthPerHit * crit;
  tower.health += spec.healthPerHit * crit;
}

function sendHit(arena, state, from, target, { chain, crit, radius = state.spec.splash } = {}) {
  const spec = state.spec;
  const length = Math.hypot(target.x - from.x, target.y - from.y);
  const projectile = spec.projectile;
  const instantaneous = projectile.weaponType === 'instant' || [100, 205].includes(state.item.slot);
  const flight = instantaneous ? 0 : Math.max(combatStep, timeOnStep(length / (projectile.speed || 1200)));
  const follows = !radius || Boolean(projectile.homing);
  const packet = {
    target, state, radius,
    x: target.x, y: target.y, follows, chain, crit,
  };
  if (flight) {
    packet.id = nextProjectileId(arena);
    packet.position = { x: from.x, y: from.y, previousX: from.x, previousY: from.y, progress: 0, previousProgress: 0 };
    packet.speed = projectile.speed || 1200;
    packet.travelled = 0;
    packet.updated = arena.now;
  }
  arena.emit({
    kind: instantaneous ? 'beam' : 'shot', color: spec.color, from, to: { x: target.x, y: target.y },
    sourceId: from.key, targetId: follows ? target.key : null, duration: instantaneous ? 0.2 : flight,
    type: spec.primary, slot: state.item.slot, splash: radius, arc: projectile.arc,
    launchHeight: projectile.launchHeight ?? projectile.launch?.[2],
    launch: from.key ? undefined : projectile.launch, sourceUnitId: state.item.slot === necromancerSlot ? 'u005' : undefined,
    targetUnitId: target.id,
    projectileId: packet.id,
  });
  if (flight) arena.hits.push(packet);
  else resolveHit(arena, packet);
}

function nextProjectileId(arena) {
  arena.projectileSerial = (arena.projectileSerial ?? 0) + 1;
  return arena.projectileSerial;
}

function resolveHit(arena, { state, target, radius, x, y, follows, chain, crit }) {
  if (follows) ({ x, y } = target);
  if (radius) {
    const profile = state.spec.projectile;
    for (const enemy of neighbors(arena, x, y, radius)) {
      const distance = Math.hypot(enemy.x - x, enemy.y - y);
      const portion = profile.splashFull == null || distance <= profile.splashFull ? 1
        : distance <= profile.splashMedium ? (profile.mediumFactor ?? 0.5) : (profile.smallFactor ?? 0.25);
      if (portion > 0) strike(arena, state, enemy, portion, undefined, crit);
    }
    arena.emit({ kind: 'burst', color: state.spec.color, x, y, radius, slot: state.item.slot });
  } else {
    strike(arena, state, target, 1, undefined, crit);
  }
  if (chain && chain.remaining > 1) {
    const next = nearest(neighbors(arena, x, y, state.spec.projectile.bounceRange ?? 600)
      .filter(enemy => !chain.visited.has(enemy)), x, y);
    if (next) {
      chain.visited.add(next);
      chain.remaining -= 1;
      sendHit(arena, state, { x, y, key: target.key }, next, { chain });
    }
  }
}

function pulse(arena, state, x, y, radius, damageOverride) {
  for (const enemy of neighbors(arena, x, y, radius)) strike(arena, state, enemy, 1, damageOverride);
  arena.emit({ kind: 'burst', color: state.spec.color, x, y, radius, slot: state.item.slot });
}

function wave(arena, state, target) {
  const { spec, item } = state;
  const angle = spec.alternate
    ? state.phase++ % 2 * Math.PI + Math.atan2(target.y, target.x)
    : Math.atan2(target.y, target.x);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const profile = spec.waveProfile;
  const length = profile?.distance ?? item.range + spec.waveExtra;
  const width = profile?.width ?? 125;
  const duration = timeOnStep(length / (profile?.speed ?? 1200));
  const impaler = item.slot === 201;
  const damage = impaler && arena.tower.critChance > 0 ? 4500 : undefined;
  const crit = impaler ? (damage !== undefined && arena.random() < arena.tower.critChance ? 1 + arena.tower.critPower : 1) : undefined;
  arena.emit({ kind: 'wave', color: spec.color, x: 0, y: 0, dx, dy, radius: length, width, duration, slot: item.slot });
  arena.waves.push({ state, dx, dy, length, width, finalWidth: profile?.finalWidth ?? width,
    start: arena.now, duration, previous: 0, damage, crit, seen: new Set() });
}

function attack(arena, state, spec, target) {
  const item = state.item;
  const tower = arena.tower;
  const radius = spec.radius ?? spec.area ?? 0;
  if (spec.orbit) {
    const distance = spec.radial ? 300 + 900 * (0.5 - Math.cos(state.phase / 2) / 2) : item.range;
    let angle = state.phase;
    if (item.slot === 17) {
      const stream = (state.flameStream ?? 0) % Math.min(state.copies, flamecasterOffsets.length);
      angle += flamecasterOffsets[stream];
      state.flameStream = stream + 1;
    }
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    pulse(arena, state, x, y, spec.radius);
    return;
  }
  if (spec.mine) {
    const angle = arena.random() * Math.PI * 2;
    const distance = 300 + arena.random() * 300;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    arena.fields.push({ state, x, y, radius, mine: true, until: arena.now + spec.mine });
    arena.emit({ kind: 'mine', x, y, duration: spec.mine, color: spec.color, slot: item.slot });
    return;
  }
  if (spec.parasite) {
    target.parasites ??= new Map();
    const stack = target.parasites.get(state);
    if (stack) stack.count += 1;
    else target.parasites.set(state, { count: 1, next: arena.now + 1 });
    arena.emit({ kind: 'beam', from: { x: 0, y: 0 }, to: { x: target.x, y: target.y }, targetId: target.key,
      duration: 0.2, slot: item.slot, type: spec.primary, color: spec.color, targetUnitId: target.id });
    arena.emit({ kind: 'parasite', x: target.x, y: target.y, targetId: target.key, unitId: target.id, duration: 60 });
    return;
  }
  if (spec.rocketRadius) {
    if (!(state.lockUntil > arena.now)) {
      state.lockUntil = arena.now + spec.lock;
      state.lockPoint = { x: target.x, y: target.y };
      state.rocketCrit = critical(tower, arena.random);
    }
    sendHit(arena, state, { x: 0, y: 0 }, state.lockPoint,
      { crit: state.rocketCrit, radius: spec.rocketRadius * (1 + stat(tower, 'area')) });
    return;
  }
  if (spec.field || spec.summon) {
    const center = spec.towerArea ? { x: 0, y: 0 } : target;
    const duration = spec.poisonCloud ? spec.field * tower.attackSpeed : spec.summon;
    const area = radius * (1 + stat(tower, 'area'));
    arena.fields.push({
      state, x: center.x, y: center.y, radius: area, summon: Boolean(spec.summon),
      interval: spec.pulse, next: arena.now + spec.pulse, until: arena.now + duration,
      summonImpact: spec.summon ? arena.now + 1.1 : undefined,
    });
    arena.emit({ kind: spec.summon ? 'summon' : 'field', x: center.x, y: center.y,
      unitId: spec.summon ? 'n004' : undefined, color: spec.color, radius: area, duration, slot: item.slot });
    return;
  }
  if (spec.wave) return wave(arena, state, target);
  if (spec.radialArea || spec.towerArea) {
    let range = item.range * (1 + (spec.towerArea ? 0.5 * (state.copies - 1) : 0));
    range *= 1 + stat(tower, 'area');
    pulse(arena, state, 0, 0, range);
    if (item.slot === 109 && arena.random() < 0.2) pulse(arena, state, 0, 0, 2 * range);
    return;
  }
  if (spec.area) {
    const areaRadius = spec.area * (1 + stat(tower, 'area'));
    pulse(arena, state, target.x, target.y, areaRadius);
    return;
  }
  const hits = Math.max(1, Math.round(spec.hits * (1 + stat(tower, 'multifire'))));
  const origin = { x: 0, y: 0 };
  if (spec.bounce) {
    sendHit(arena, state, origin, target, { chain: { visited: new Set([target]), remaining: hits } });
  } else {
    const candidates = neighbors(arena, 0, 0, item.range).filter(enemy => enemy !== target);
    sendHit(arena, state, origin, target);
    for (let index = 1; index < hits && candidates.length; index += 1) {
      const enemy = pickTarget(arena, candidates.filter(living));
      if (!enemy) break;
      candidates.splice(candidates.indexOf(enemy), 1);
      sendHit(arena, state, origin, enemy);
    }
  }
}

export function tickWeapons(arena, attacks, dt) {
  for (const state of arena.tower.weapons.values()) {
    const { item, copies } = state;
    const spec = state.spec ??= attacks.get(item.id);
    const speed = arena.tower.attackSpeed;
    if (spec.orbit) state.phase += dt * orbitRate(state, speed);
    if (spec.glaive) {
      for (let index = 0; index < Math.min(copies, 8); index += 1) {
        const angle = state.phase - index * Math.PI / 4;
        const x = Math.cos(angle) * item.range;
        const y = Math.sin(angle) * item.range;
        for (const enemy of neighbors(arena, x, y, spec.radius)) {
          if (enemy.glaiveUntil > arena.now) continue;
          enemy.glaiveUntil = arena.now + 0.15;
          strike(arena, state, enemy, 1 + 0.125 * Math.max(0, copies - 8));
        }
      }
      continue;
    }
    if (spec.roundCast || spec.raisesOnKill || state.next > arena.now + 1e-9 || state.eggUntil > arena.now) continue;
    const autonomous = spec.orbit || spec.mine;
    const valid = state.target && inRange(state.target, 0, 0, item.range);
    const lockedArea = spec.lock && state.lockPoint && state.lockUntil > arena.now;
    const target = autonomous ? null : lockedArea ? state.lockPoint : valid && spec.drain ? state.target
      : pickTarget(arena, neighbors(arena, 0, 0, item.range));
    state.target = target;
    if (!target && !autonomous) continue;
    state.lockUntil ??= -1;
    attack(arena, state, spec, target);
    const seconds = spec.cooldown ?? item.cooldownSeconds;
    const rate = speed * (item.slot === 207 ? 1 : copies);
    const scheduled = arena.now - state.next <= combatStep + 1e-9 ? state.next : arena.now;
    state.next = scheduled + Math.max(0.045, seconds / rate);
  }
}

export function startRoundWeapons(arena, attacks) {
  for (const state of arena.tower.weapons.values()) {
    const spec = state.spec ??= attacks.get(state.item.id);
    if (!spec.roundCast) continue;
    const duration = spec.field * arena.tower.attackSpeed;
    const radius = spec.radius * (1 + stat(arena.tower, 'area'));
    arena.fields.push({ state, x: 0, y: 0, radius, interval: spec.pulse,
      next: arena.now + spec.pulse, until: arena.now + duration, damage: state.item.baseDamage * state.copies });
    arena.emit({ kind: 'field', x: 0, y: 0, radius, duration, slot: state.item.slot, color: spec.color });
  }
}

function tickWaves(arena) {
  arena.waves = arena.waves.filter(wave => {
    const progress = Math.min(1, (arena.now - wave.start) / wave.duration);
    const front = wave.length * progress;
    for (const enemy of arena.enemies) {
      if (enemy.dead || wave.seen.has(enemy)) continue;
      const alreadyMoving = wave.start < arena.now;
      const previousX = alreadyMoving ? (enemy.previousX ?? enemy.x) : enemy.x;
      const previousY = alreadyMoving ? (enemy.previousY ?? enemy.y) : enemy.y;
      const before = previousX * wave.dx + previousY * wave.dy - wave.previous;
      const after = enemy.x * wave.dx + enemy.y * wave.dy - front;
      if (before * after > 0) continue;
      const fraction = before === after ? 1 : before / (before - after);
      const crossingX = previousX + (enemy.x - previousX) * fraction;
      const crossingY = previousY + (enemy.y - previousY) * fraction;
      const crossingFront = wave.previous + (front - wave.previous) * fraction;
      const width = wave.width + (wave.finalWidth - wave.width) * crossingFront / wave.length;
      if (Math.abs(crossingX * wave.dy - crossingY * wave.dx) > width) continue;
      wave.seen.add(enemy);
      strike(arena, wave.state, enemy, 1, wave.damage, wave.crit);
    }
    wave.previous = front;
    return progress < 1 - 1e-9;
  });
}

export function tickImpacts(arena) {
  const due = [];
  arena.hits = arena.hits.filter(hit => {
    const { position, target } = hit;
    const x = hit.follows ? target.x : hit.x;
    const y = hit.follows ? target.y : hit.y;
    const dx = x - position.x;
    const dy = y - position.y;
    const remaining = Math.hypot(dx, dy);
    const step = Math.min(remaining, (arena.now - hit.updated) * hit.speed);
    hit.updated = arena.now;
    if (remaining <= step + 1e-7) {
      due.push({ hit, x, y });
      return false;
    }
    position.previousX = position.x;
    position.previousY = position.y;
    position.previousProgress = position.progress;
    position.x += dx * step / remaining;
    position.y += dy * step / remaining;
    hit.travelled += step;
    position.progress = hit.travelled / (hit.travelled + remaining - step);
    return true;
  });
  for (const { hit, x, y } of due) {
    arena.emit({ kind: 'shotEnd', projectileId: hit.id, x, y });
    resolveHit(arena, hit);
  }
  tickWaves(arena);
  const activeFields = arena.fields;
  arena.fields = [];
  arena.fields.push(...activeFields.filter(field => {
    const { x, y, state, radius } = field;
    if (field.until < arena.now - 1e-9) return false;
    if (field.mine) {
      if (!neighbors(arena, x, y, 105).length) return true;
      pulse(arena, state, x, y, radius);
      return false;
    }
    if (field.summonImpact !== undefined && field.summonImpact <= arena.now + 1e-9) {
      pulse(arena, state, x, y, radius);
      field.summonImpact = undefined;
    }
    if (field.next > arena.now + 1e-9) return true;
    if (field.mage) {
      const target = field.target && inRange(field.target, x, y, radius) ? field.target : nearest(neighbors(arena, x, y, radius), x, y);
      if (!target) return true;
      field.target = target;
      sendHit(arena, state, { x, y }, target, { crit: field.crit });
      field.next = arena.now + timeOnStep(1.5 / arena.tower.attackSpeed);
    } else {
      const portion = state.spec.poisonCloud ? 0.5 : 1;
      const pulseRadius = field.summon ? radius * 1.2 : radius;
      for (const enemy of neighbors(arena, x, y, pulseRadius)) {
        strike(arena, state, enemy, portion, field.summon ? state.spec.summonDamage : field.damage, undefined, !field.summon);
      }
      arena.emit({ kind: 'burst', color: state.spec.color, x, y, radius, slot: state.item.slot });
      field.next += field.interval;
    }
    return true;
  }));
}

export function repairTower(arena) {
  const { tower, now } = arena;
  if (tower.repairAt > now || tower.health <= 0 || tower.health >= tower.maxHealth) return false;
  const restored = heal(tower, tower.maxHealth * repairFraction, 1);
  tower.repairAt = now + repairInterval;
  arena.emit({ kind: 'heal', x: 0, y: 0, amount: restored });
  return true;
}

export function clearArena(arena, manual) {
  const tower = arena.tower;
  if (manual && !tower.clears) return false;
  if (manual) tower.clears -= 1;
  for (const enemy of arena.enemies) {
    if (manual && !enemy.dead) {
      arena.tower.damage += enemy.hp;
      creditDamage(tower, 'clear', enemy.hp);
      enemy.hp = 0;
    }
    grantKill(arena, enemy, manual, manual ? 'clear' : undefined);
  }
  arena.enemies.length = 0;
  cancelProjectiles(arena);
  arena.waves.length = 0;
  if (manual) {
    heal(tower, tower.maxHealth - tower.health, 1);
    tower.shield = tower.maxShield;
    arena.invulnerableUntil = arena.now + 1;
  }
  arena.emit({ kind: 'clear', x: 0, y: 0, radius: 1250, color: 0xffdd95 });
  return true;
}

export function cancelProjectiles(arena) {
  for (const { id } of arena.hits) arena.emit({ kind: 'shotCancel', projectileId: id });
  for (const { projectileId } of arena.enemyHits) {
    if (projectileId != null) arena.emit({ kind: 'shotCancel', projectileId });
  }
  arena.hits.length = 0;
  arena.enemyHits.length = 0;
}

function damageTower(arena, enemy) {
  const { tower, random, now } = arena;
  if (arena.invulnerableUntil > now || random() < Math.min(tower.dodge, 0.95) || random() < (enemy.miss?.amount ?? 0)) return;
  const rawDamage = enemy.damage * (1 - (enemy.weaken?.amount ?? 0));
  const armor = tower.armor + tower.bonusArmor + (tower.effects.get('reactiveArmor') ?? 0);
  const afterArmor = rawDamage * armorFactor(armor, arena.combatRules?.armorFactor);
  const spikeMultiplier = 1 + stat(tower, 'Spikes') + (tower.effects.get('spikyArmor') ?? 0);
  if (tower.spikes > 0) {
    let spikes = (tower.spikes + rawDamage * 0.3 * count(tower, 'Crypt Carapace')) * spikeMultiplier;
    spikes *= 1 + enemy.spikesVulnerability;
    spikes *= 1 + ((enemy.maxHp - enemy.hp) / enemy.maxHp) * 0.5 * count(tower, 'Gnashing Teeth');
    wound(arena, enemy, spikes, 'Spikes', towerSpikes, false);
  }
  const extraReduction = Math.max(0, armor) * 2 * (1 - 0.5 ** count(tower, 'Unbreakable Armor'));
  const shieldReduction = tower.shield > 0 ? tower.shieldReduction : 0;
  let amount = Math.max(afterArmor * 0.25, afterArmor - tower.flatReduction * spikeMultiplier - extraReduction);
  amount *= Math.max(0, 1 - tower.damageReduction) * Math.max(0, 1 - shieldReduction);
  if (enemy.id === 'samwise') {
    enemy.damageBase = Math.trunc(enemy.damageBase * 1.1 + 1);
    enemy.damage = enemy.damageBase + 1;
    enemy.attackCooldown *= 0.98;
  } else if (enemy.id !== 'h00G' && enemy.hitTower) {
    enemy.damageBase = Math.trunc(enemy.damageBase * arena.damagePerHit);
    enemy.damage = Math.max(0, enemy.damageBase + 1);
  }
  enemy.hitTower = true;
  const absorbed = Math.min(tower.shield, amount);
  tower.shield -= absorbed;
  if (absorbed && tower.shield === 0) tower.effects.set('shieldBroken', true);
  if (absorbed && tower.shield === 0 && count(tower, 'Energy Pulse')) {
    for (const mob of arena.enemies) mob.stun = Math.max(mob.stun, mob.cc * count(tower, 'Energy Pulse'));
  }
  tower.health -= amount - absorbed;
  if (amount > 0) arena.emit({ kind: 'impact', x: 0, y: 0, tower: true, color: amount > absorbed ? 0xff6559 : 0x7eceff });
  tower.bonusArmor = Math.max(0, tower.bonusArmor - 1);
  heal(tower, (count(tower, 'Dreadlord Fang') * 4 + count(tower, 'Hungering Maw') * 12) * spikeMultiplier);
  tower.regen += count(tower, "Nature's Fang") * 0.04;
  tower.maxHealth += count(tower, 'Spiked Masonry');
  tower.health += count(tower, 'Spiked Masonry');
  if (count(tower, 'Frost Armor') && amount > absorbed) applyFrost(enemy, count(tower, 'Frost Armor') * 5, 1 + stat(tower, 'Frost'));
  enemy.spikesVulnerability += 0.05 * count(tower, 'Puncturing Spikes');
  enemy.bleed += (enemy.bleed ? 10 : 20) * count(tower, 'Bloody Spikes');
  if (count(tower, 'Molten Spikes') && random() < 0.2) addFire(arena, enemy, 200 * count(tower, 'Molten Spikes') * spikeMultiplier, towerSpikes);
  if (count(tower, 'Poisonous Spikes')) enemy.poison.push({ left: 2, amount: 200 * count(tower, 'Poisonous Spikes'), source: towerSpikes });
  if (count(tower, 'Poison Armor') && amount > absorbed) enemy.poisonArmorUntil = now + 3;
  if (count(tower, 'Reactive Armor')) tower.effects.set('reactiveArmor', (tower.effects.get('reactiveArmor') ?? 0) + 0.1 * count(tower, 'Reactive Armor'));
  if (count(tower, 'Spiky Armor')) tower.effects.set('spikyArmor', (tower.effects.get('spikyArmor') ?? 0) + 0.01 * count(tower, 'Spiky Armor'));
  if (count(tower, 'Living Wood') && tower.health > 0 && tower.health < tower.maxHealth * 0.35 && amount > absorbed) {
    tower.effects.set('livingWoodUntil', now + 10);
  }
  if (tower.health <= 0 && tower.reconstruction > 0) {
    tower.reconstruction -= 1;
    heal(tower, tower.maxHealth - tower.health, 1);
    arena.emit({ kind: 'burst', color: 0xffe0a0, x: 0, y: 0, radius: 300 });
  }
  if (tower.health <= 0) {
    const phoenix = [...tower.weapons.values()].find(({ item, eggUntil }) => item.slot === 132 && !(eggUntil > now));
    if (phoenix?.spec) {
      for (const target of neighbors(arena, 0, 0, phoenix.item.range)) {
        strike(arena, phoenix, target, 1, 3000);
        heal(tower, 100);
      }
      phoenix.eggUntil = now + 30 / tower.attackSpeed;
    }
  }
}

export function tickEnemies(arena, dt) {
  const tower = arena.tower;
  resolveEnemyHits(arena);
  if (tower.health <= 0) return;
  let poisonArmorRegen = 0;
  for (const enemy of arena.enemies) {
    if (enemy.dead) continue;
    if (enemy.lifetime && arena.now >= enemy.expires) {
      grantKill(arena, enemy, false);
      continue;
    }
    if (enemy.healthRegen) enemy.hp = Math.min(enemy.maxHp, enemy.hp + enemy.healthRegen * dt);
    for (const [type, effect] of enemy.vulnerability) if (effect.expires <= arena.now) enemy.vulnerability.delete(type);
    for (const key of ['attackSlow', 'weaken', 'miss']) if (enemy[key]?.expires <= arena.now) enemy[key] = null;
    for (const poison of enemy.poison) {
      poison.next ??= arena.now + 0.5;
      if (arena.now + 1e-9 < poison.next) continue;
      wound(arena, enemy, poison.amount * Math.min(0.5, poison.left), 'Poison', poison.source, false);
      poison.left -= 0.5;
      poison.next += 0.5;
    }
    enemy.poison = enemy.poison.filter(poison => poison.left > 0);
    for (const [state, stack] of enemy.parasites ?? []) {
      if (enemy.dead || arena.now + 1e-9 < stack.next) continue;
      wound(arena, enemy, state.item.baseDamage * stack.count * weaponMultiplier(tower, state.item, enemy), 'Chaos', state, false);
      heal(tower, 50 * stack.count);
      stack.next += 1;
    }
    if (enemy.poisonArmorUntil > arena.now) poisonArmorRegen += 3 * count(tower, 'Poison Armor') * (1 + stat(tower, 'Poison'));
    if (enemy.fireUntil <= arena.now) enemy.fire = 0;
    if (enemy.fire && Math.hypot(enemy.x, enemy.y) <= 1200 && arena.now + 1e-9 >= enemy.nextFire) {
      const stack = [...enemy.fireSources.values()].reduce((sum, amount) => sum + amount, 0);
      wound(arena, enemy, stack * (1 + stat(tower, 'Fire')), 'Fire', enemy.fireSources, false);
      enemy.nextFire = (Math.floor((arena.now + 1e-9) * 2) + 1) / 2;
    }
    if (enemy.bleed && arena.now + 1e-9 >= (enemy.nextBleed ?? 0)) {
      wound(arena, enemy, enemy.bleed, 'Spikes', towerSpikes, false);
      enemy.nextBleed = arena.now + 0.5;
    }
    if (enemy.dead) continue;
    enemy.frostTime -= dt;
    if (enemy.frostTime <= 0) enemy.frost = 0;
    enemy.stun -= dt;
    if (enemy.knockback) {
      const push = enemy.knockback;
      if (arena.now + 1e-9 >= push.next) {
        const distance = Math.hypot(enemy.x, enemy.y) || 1;
        const step = 25;
        const x = enemy.x + enemy.x / distance * step;
        const y = enemy.y + enemy.y / distance * step;
        if (!arena.walkable || arena.walkable(arena.layout.x + x, arena.layout.y + y)) {
          enemy.x = x;
          enemy.y = y;
          push.remaining -= step;
          push.next += 0.03;
        } else push.remaining = 0;
        if (push.remaining <= 0) {
          enemy.knockback = null;
          enemy.pathing = true;
        }
      }
      enemy.attackEnd = arena.now;
      enemy.attackInterrupted = true;
      enemy.walking = false;
      continue;
    }
    if (enemy.stun > 0) {
      enemy.attackEnd = arena.now;
      enemy.attackInterrupted = true;
      enemy.walking = false;
      continue;
    }
    const distance = Math.hypot(enemy.x, enemy.y);
    const reach = enemy.attackRange;
    const frostSlow = Math.min(0.99, enemy.frost / 100 * enemy.cc * (1 + stat(tower, 'Frost')));
    if (distance > reach) {
      const step = Math.min(distance - reach, Math.min(enemy.speed, arena.combatRules?.maxUnitSpeed ?? 522) * dt * (1 - frostSlow));
      const x = enemy.x - step * enemy.x / distance;
      const y = enemy.y - step * enemy.y / distance;
      const previousX = enemy.x;
      const previousY = enemy.y;
      enemy.walking = moveEnemy(arena, enemy, x, y);
      if (enemy.walking) {
        enemy.facing = Math.atan2(enemy.y - previousY, enemy.x - previousX);
        enemy.movementRate = Math.hypot(enemy.x - previousX, enemy.y - previousY) / dt;
      }
      continue;
    }
    enemy.walking = false;
    if (enemy.nextAttack > arena.now) continue;
    const rate = Math.max(0.2, 1 - frostSlow - (enemy.attackSlow?.amount ?? 0));
    const damagePoint = (enemy.damagePoint ?? 0.3) / rate;
    enemy.nextAttack = arena.now + enemy.attackCooldown / rate;
    enemy.attackAt = arena.now;
    enemy.attackRelease = arena.now + timeOnStep(damagePoint);
    enemy.attackEnd = Math.max(arena.now + combatStep, enemy.attackRelease + (enemy.backswing ?? 0.15) / rate);
    enemy.attackInterrupted = false;
    enemy.facing = Math.atan2(-enemy.y, -enemy.x);
    arena.emit({ kind: 'enemyAttack', x: enemy.x, y: enemy.y, family: enemy.family, enemyId: enemy.key });
    const release = { enemy, at: enemy.attackRelease, attackAt: enemy.attackAt };
    if (damagePoint > 0) arena.enemyHits.push(release);
    else if (tower.health > 0) resolveEnemyHit(arena, release);
  }
  const livingWood = (tower.effects.get('livingWoodUntil') ?? 0) > arena.now ? 150 * count(tower, 'Living Wood') : 0;
  const regen = tower.regen * (1 + stat(tower, 'regenMultiplier')) + poisonArmorRegen + livingWood;
  heal(tower, regen * dt, 1);
}

const missileAttacks = new Set(['missile', 'msplash', 'artillery', 'aline', 'mbounce']);

function resolveEnemyHits(arena) {
  const due = arena.enemyHits.filter(hit => hit.at <= arena.now + 1e-9);
  arena.enemyHits = arena.enemyHits.filter(hit => hit.at > arena.now + 1e-9);
  for (const hit of due) {
    resolveEnemyHit(arena, hit);
    if (arena.tower.health <= 0) break;
  }
}

function resolveEnemyHit(arena, { enemy, attackAt, projectileId }) {
  if (projectileId != null) {
    arena.emit({ kind: 'shotEnd', projectileId, x: 0, y: 0 });
    return damageTower(arena, enemy);
  }
  if (enemy.attackAt !== attackAt || enemy.attackInterrupted) return;
  if (enemy.dead || enemy.stun > 0 || enemy.knockback) return;
  const distance = Math.hypot(enemy.x, enemy.y);
  if (distance > enemy.attackRange + 1) return;
  const projectile = enemy.projectile;
  const flight = projectile?.speed > 0 && missileAttacks.has(projectile.weaponType)
    ? timeOnStep(distance / projectile.speed) : 0;
  if (flight) {
    const projectileId = nextProjectileId(arena);
    arena.emit({ kind: 'shot', from: { x: enemy.x, y: enemy.y }, to: { x: 0, y: 0 }, duration: flight,
      targetTower: true, sourceId: enemy.key, sourceUnitId: enemy.id, launch: projectile.launch,
      arc: projectile.arc, model: projectile.model, color: 0xff6559, projectileId });
    arena.enemyHits.push({ enemy, at: arena.now + flight, projectileId });
  } else {
    damageTower(arena, enemy);
  }
}

function moveEnemy(arena, enemy, x, y) {
  if (enemy.pathing) {
    const walkable = (x, y) => {
      if (arena.walkable && !arena.walkable(arena.layout.x + x, arena.layout.y + y)) return false;
      return !arena.enemies.some(other => {
        if (other === enemy || other.dead || !other.pathing) return false;
        const collision = (other.collision + enemy.collision) ** 2;
        const gap = distance2(x, y, other);
        return gap < collision && gap < distance2(enemy.x, enemy.y, other);
      });
    };
    if (!walkable(x, y)) {
      if (x !== enemy.x && walkable(x, enemy.y)) y = enemy.y;
      else if (y !== enemy.y && walkable(enemy.x, y)) x = enemy.x;
      else return false;
    }
  }
  enemy.x = x;
  enemy.y = y;
  return true;
}
