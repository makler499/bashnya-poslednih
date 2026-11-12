import { count, heal, stat, weaponMultiplier } from './shop.mjs';

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
  44: { field: 1, pulse: 0.25, radius: 300 },
  104: { lock: 2 },
  125: { alternate: true },
  127: { alternate: true },
  129: { summon: 5, pulse: 1, cooldown: 10, summonDamage: 6000 },
  132: { phoenix: true },
  200: { summon: 5, pulse: 1, summonDamage: 2000, radius: 250 },
  204: { mine: 15, radius: 300 },
  207: { towerArea: true },
  211: { orbit: 2.6, radius: 150, cooldown: 0.3 },
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
      projectile: weapon.projectile ?? {},
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
      drain: description.includes('until it dies'),
      damageReduction: weapon.slot === 114 ? [0.25, 10] : weapon.slot === 201 ? [0.25, 1] : null,
      missChance: weapon.slot === 115 ? [0.25, 2] : null,
    };
    return [weapon.abilityId, spec];
  }));
}

const distance2 = (x, y, a) => (a.x - x) ** 2 + (a.y - y) ** 2;
const living = enemy => !enemy.dead;
const neighbors = (arena, x, y, range) =>
  arena.enemies.filter(enemy => living(enemy) && distance2(x, y, enemy) <= range * range);

function pickTarget(arena, candidates, assigned) {
  const free = candidates.filter(enemy => !assigned.has(enemy));
  const pool = free.length ? free : candidates;
  return pool.length ? pool[Math.floor(arena.random() * pool.length)] : null;
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

function applyFrost(enemy, stacks) {
  enemy.frostTime = 5;
  enemy.frost = Math.min(50, enemy.frost + stacks);
  if (enemy.frost < 50) return;
  enemy.frost = 0;
  enemy.frozen = true;
  enemy.stun = Math.max(enemy.stun, 3 * enemy.cc);
}

function grantKill(arena, enemy, bounty, source) {
  if (enemy.dead) return;
  enemy.dead = true;
  if (enemy.id === 'samwise') arena.bossDefeated = true;
  arena.corpses.push({ x: enemy.x, y: enemy.y, expires: arena.now + 10 });
  const tower = arena.tower;
  if (bounty) {
    tower.kills += 1;
    tower.gold += enemy.bounty;
    heal(tower, 15 * count(tower, 'Mask of Death'));
    tower.shield = Math.min(tower.maxShield, tower.shield + 15 * count(tower, 'Maw of Death'));
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
  if (ignite && enemy.fire > 0 && source !== 'ignite') {
    const target = nearest(neighbors(arena, enemy.x, enemy.y, 600), enemy.x, enemy.y);
    if (target) target.fire += enemy.fire * 0.25 * ignite;
  }
  arena.emit({ kind: 'death', x: enemy.x, y: enemy.y, unitId: enemy.id, enemyId: enemy.key, bounty: bounty ? enemy.bounty : 0 });
}

function wound(arena, enemy, amount, school, source, useArmor = true) {
  if (enemy.dead || amount <= 0) return 0;
  const typeFactor = arena.combatRules?.damageMatrix?.[school]?.[enemy.armor] ?? sizeMultiplier[school]?.[enemy.armor] ?? 1;
  const armor = useArmor ? typeFactor * armorFactor(enemy.armorValue ?? 0, arena.combatRules?.armorFactor) : 1;
  const vulnerable = enemy.vulnerability.get(school);
  const damage = amount * armor * (vulnerable ? 1 + vulnerable.amount : 1) * enemy.damageTaken;
  const dealt = Math.min(enemy.hp, damage);
  enemy.hp -= damage;
  arena.tower.damage += dealt;
  if (source === towerSpikes) arena.tower.towerDamage += dealt;
  else if (source?.item) source.damage = (source.damage ?? 0) + dealt;
  if (dealt > 0 && (useArmor || arena.now >= (enemy.nextPeriodicImpact ?? 0))) {
    arena.emit({ kind: 'impact', x: enemy.x, y: enemy.y, color: effectTint[school] });
    if (!useArmor) enemy.nextPeriodicImpact = arena.now + 0.24;
  }
  if (enemy.hp <= 0) grantKill(arena, enemy, true, source);
  return damage;
}

function critical(tower, random) {
  const guaranteed = Math.max(0, tower.critChance - 1);
  return random() < tower.critChance ? 1 + tower.critPower + guaranteed : 1;
}

function strike(arena, state, enemy, portion = 1, damageOverride, critOverride) {
  if (!enemy || enemy.dead) return;
  const tower = arena.tower;
  const { item, spec } = state;
  const crit = critOverride ?? critical(tower, arena.random);
  let damage = (damageOverride ?? item.baseDamage) * weaponMultiplier(tower, item, enemy) * portion * crit;
  if (spec.primary === 'Chaos' && enemy.armor !== 'divine') damage *= 0.5 + 1.5 * arena.random();
  if (item.slot === 113) damage *= 1 + tower.maxHealth / 50000;
  if (item.slot === 117) damage *= 1 + tower.maxShield / 100000;
  if (item.slot === 119) damage *= 1 + 0.1 * (state.copies - 1);
  if (item.slot === 130) damage *= 1 + (tower.armor + tower.bonusArmor) * 0.01;
  if (item.slot === 134) damage *= 1 + tower.regen / 2000;
  if ([104, 207].includes(item.slot)) damage *= 1 + 1.25 * stat(tower, 'area');
  const dealt = wound(arena, enemy, damage, spec.primary, state);
  if (spec.stun) enemy.stun = Math.max(enemy.stun, spec.stun * (1 + stat(tower, 'stunDuration')) * enemy.cc);
  if (spec.frost) applyFrost(enemy, spec.frost * (1 + stat(tower, 'Frost')));
  if (spec.poisonDamage && !enemy.dead) {
    enemy.poison.push({ left: 2, amount: spec.poisonDamage * (1 + stat(tower, 'Poison')) * portion * crit / 2, source: state });
    if (spec.poisonSlow) enemy.attackSlow = { amount: spec.poisonSlow, expires: arena.now + 2 };
  }
  if (spec.fire) enemy.fire += dealt * spec.fire * (1 + stat(tower, 'Fire'));
  if (spec.damageReduction) enemy.weaken = { amount: spec.damageReduction[0], expires: arena.now + spec.damageReduction[1] };
  if (spec.missChance) enemy.miss = { amount: spec.missChance[0], expires: arena.now + spec.missChance[1] };
  if (spec.vulnerability) {
    const [, school, pct, duration] = spec.vulnerability;
    enemy.vulnerability.set(school, { amount: Number(pct) / 100, expires: arena.now + Number(duration) });
  }
  if (spec.knockback && !enemy.dead) enemy.knockback = { remaining: spec.knockback * enemy.cc, next: arena.now + 0.03 };
  heal(tower, (spec.healPerHit + spec.healPerSecond * (item.cooldownSeconds ?? 0)) * crit);
  tower.shield = Math.min(tower.maxShield, tower.shield + (spec.shieldPerHit + spec.restoreMana * (item.cooldownSeconds ?? 0)) * crit);
  tower.regen += spec.regenPerHit * crit;
  tower.maxHealth += spec.healthPerHit * crit;
  tower.health += spec.healthPerHit * crit;
}

function sendHit(arena, state, from, target, chain) {
  const spec = state.spec;
  const length = Math.hypot(target.x - from.x, target.y - from.y);
  const projectile = spec.projectile;
  const instantaneous = projectile.weaponType === 'instant' || [100, 205].includes(state.item.slot);
  const flight = instantaneous ? 0 : Math.max(combatStep, timeOnStep(length / (projectile.speed || 1200)));
  const follows = !spec.splash || Boolean(projectile.homing);
  const packet = {
    target, state, radius: spec.splash,
    x: target.x, y: target.y, follows, chain,
  };
  if (flight) {
    arena.projectileSerial = (arena.projectileSerial ?? 0) + 1;
    packet.id = arena.projectileSerial;
    packet.position = { x: from.x, y: from.y, previousX: from.x, previousY: from.y, progress: 0, previousProgress: 0 };
    packet.speed = projectile.speed || 1200;
    packet.travelled = 0;
    packet.updated = arena.now;
  }
  arena.emit({
    kind: instantaneous ? 'beam' : 'shot', color: spec.color, from, to: { x: target.x, y: target.y },
    sourceId: from.key, targetId: follows ? target.key : null, duration: instantaneous ? 0.2 : flight,
    type: spec.primary, slot: state.item.slot, splash: spec.splash, arc: projectile.arc,
    launchHeight: projectile.launchHeight,
    projectileId: packet.id,
  });
  if (flight) arena.hits.push(packet);
  else resolveHit(arena, packet);
}

function resolveHit(arena, { state, target, radius, x, y, follows, chain }) {
  if (follows) ({ x, y } = target);
  if (radius) {
    const profile = state.spec.projectile;
    for (const enemy of neighbors(arena, x, y, radius)) {
      const distance = Math.hypot(enemy.x - x, enemy.y - y);
      const portion = profile.splashFull == null || distance <= profile.splashFull ? 1
        : distance <= profile.splashMedium ? (profile.mediumFactor ?? 0.5) : (profile.smallFactor ?? 0.25);
      if (portion > 0) strike(arena, state, enemy, portion);
    }
    arena.emit({ kind: 'burst', color: state.spec.color, x, y, radius, slot: state.item.slot });
  } else {
    strike(arena, state, target);
  }
  if (chain && chain.remaining > 1) {
    const next = nearest(neighbors(arena, x, y, state.spec.projectile.bounceRange ?? 600)
      .filter(enemy => !chain.visited.has(enemy)), x, y);
    if (next) {
      chain.visited.add(next);
      chain.remaining -= 1;
      sendHit(arena, state, { x, y, key: target.key }, next, chain);
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

function attack(arena, state, spec, target, assigned) {
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
      duration: 0.2, slot: item.slot, type: spec.primary, color: spec.color });
    return;
  }
  if (item.slot === 129) {
    const index = arena.corpses.findIndex(corpse => Math.hypot(corpse.x, corpse.y) <= item.range);
    if (index === -1) return;
    const [corpse] = arena.corpses.splice(index, 1);
    arena.fields.push({ state, x: corpse.x, y: corpse.y, radius: 300, summon: true, next: arena.now, until: arena.now + spec.summon, interval: spec.pulse / tower.attackSpeed });
    arena.emit({ kind: 'summon', x: corpse.x, y: corpse.y, color: spec.color, duration: spec.summon, slot: item.slot });
    return;
  }
  if (spec.field || spec.summon) {
    const center = spec.towerArea ? { x: 0, y: 0 } : target;
    const duration = spec.field ? spec.field * (item.slot === 212 ? tower.attackSpeed : 1) : spec.summon;
    if (spec.summon) pulse(arena, state, center.x, center.y, radius);
    arena.fields.push({
      state, x: center.x, y: center.y, radius, summon: Boolean(spec.summon),
      interval: spec.pulse, next: arena.now + (spec.summon ? spec.pulse : 0), until: arena.now + duration,
    });
    arena.emit({ kind: spec.summon ? 'summon' : 'field', x: center.x, y: center.y, color: spec.color, radius, duration, slot: item.slot });
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
    if (spec.lock && state.lockUntil < arena.now) {
      state.lockUntil = arena.now + spec.lock;
      state.lockPoint = { x: target.x, y: target.y };
    }
    const center = state.lockPoint ?? target;
    pulse(arena, state, center.x, center.y, areaRadius);
    return;
  }
  const hits = Math.max(1, Math.round(spec.hits * (1 + stat(tower, 'multifire'))));
  const origin = { x: 0, y: 0 };
  if (spec.bounce) {
    sendHit(arena, state, origin, target, { visited: new Set([target]), remaining: hits });
  } else {
    const candidates = neighbors(arena, 0, 0, item.range).filter(enemy => enemy !== target);
    sendHit(arena, state, origin, target);
    for (let index = 1; index < hits && candidates.length; index += 1) {
      const enemy = pickTarget(arena, candidates.filter(living), assigned);
      if (!enemy) break;
      candidates.splice(candidates.indexOf(enemy), 1);
      assigned.add(enemy);
      sendHit(arena, state, origin, enemy);
    }
  }
}

export function tickWeapons(arena, attacks, dt) {
  const assigned = new Set();
  for (const state of arena.tower.weapons.values()) {
    const { item, copies } = state;
    state.spec ??= attacks.get(item.id);
    const { spec } = state;
    const speed = arena.tower.attackSpeed;
    if (spec.orbit) state.phase += dt * orbitRate(state, speed);
    if (spec.roundCast || state.next > arena.now + 1e-9 || state.eggUntil > arena.now) continue;
    const autonomous = spec.orbit || spec.mine || item.slot === 129;
    const valid = state.target && !state.target.dead && distance2(0, 0, state.target) <= item.range ** 2;
    const lockedArea = spec.lock && state.lockPoint && state.lockUntil > arena.now;
    const target = autonomous ? null : lockedArea ? state.lockPoint : valid && spec.drain ? state.target
      : pickTarget(arena, neighbors(arena, 0, 0, item.range), assigned);
    state.target = target;
    if (!target && !autonomous) continue;
    if (target && !lockedArea && !spec.towerArea && !spec.radialArea) assigned.add(target);
    state.lockUntil ??= -1;
    attack(arena, state, spec, target, assigned);
    const seconds = spec.cooldown ?? item.cooldownSeconds;
    const rate = speed * (item.slot === 207 ? 1 : copies);
    state.next = arena.now + timeOnStep(Math.max(0.045, seconds / rate));
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
  arena.fields = arena.fields.filter(field => {
    const { x, y, state, radius } = field;
    if (field.until < arena.now - 1e-9) return false;
    if (field.mine) {
      if (!neighbors(arena, x, y, 105).length) return true;
      pulse(arena, state, x, y, radius);
      return false;
    }
    if (field.next > arena.now + 1e-9) return true;
    if (field.summon && state.item.slot === 129) {
      const target = nearest(neighbors(arena, x, y, 500), x, y);
      if (target) {
        strike(arena, state, target, 1, state.spec.summonDamage);
        arena.emit({
          kind: 'beam', color: state.spec.color, from: { x, y }, to: { x: target.x, y: target.y },
          type: state.spec.primary, slot: state.item.slot, targetId: target.key, duration: 0.22,
        });
      }
    } else {
      const portion = state.item.slot === 44 ? 0.25 : 1;
      for (const enemy of neighbors(arena, x, y, radius)) strike(arena, state, enemy, portion,
        field.damage ?? (field.summon ? state.spec.summonDamage : undefined));
      arena.emit({ kind: 'burst', color: state.spec.color, x, y, radius, slot: state.item.slot });
    }
    field.next += field.interval;
    return true;
  });
  arena.corpses = arena.corpses.filter(corpse => corpse.expires > arena.now);
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
  for (const enemy of arena.enemies) grantKill(arena, enemy, manual);
  arena.enemies.length = 0;
  arena.hits.length = 0;
  arena.waves.length = 0;
  arena.enemyHits.length = 0;
  if (manual) {
    heal(tower, tower.maxHealth - tower.health, 1);
    tower.shield = tower.maxShield;
    arena.invulnerableUntil = arena.now + 1;
  }
  arena.emit({ kind: 'clear', x: 0, y: 0, radius: 1250, color: 0xffdd95 });
  return true;
}

function damageTower(arena, enemy) {
  const { tower, random, now } = arena;
  if (arena.invulnerableUntil > now || random() < Math.min(tower.dodge, 0.95) || random() < (enemy.miss?.amount ?? 0)) return;
  const rawDamage = enemy.damage * enemy.damageScale * (1 - (enemy.weaken?.amount ?? 0));
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
  enemy.damageScale *= arena.damagePerHit;
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
  if (count(tower, 'Frost Armor') && amount > absorbed) applyFrost(enemy, count(tower, 'Frost Armor') * 5);
  enemy.spikesVulnerability += 0.05 * count(tower, 'Puncturing Spikes');
  enemy.bleed += (enemy.bleed ? 10 : 20) * count(tower, 'Bloody Spikes');
  if (count(tower, 'Molten Spikes') && random() < 0.2) enemy.fire += 200 * count(tower, 'Molten Spikes');
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
  const due = arena.enemyHits.filter(hit => hit.at <= arena.now + 1e-9);
  arena.enemyHits = arena.enemyHits.filter(hit => hit.at > arena.now + 1e-9);
  for (const hit of due) {
    if (hit.launched || (!hit.enemy.dead && hit.enemy.stun <= 0 && !hit.enemy.knockback)) {
      if (hit.flight) {
        arena.emit({ kind: 'shot', from: { x: hit.enemy.x, y: hit.enemy.y }, to: { x: 0, y: 0 },
          duration: hit.flight, targetTower: true, arc: hit.enemy.family === 'Catapult' ? 0.35 : 0, color: 0xff6559 });
        arena.enemyHits.push({ enemy: hit.enemy, at: arena.now + hit.flight, launched: true });
      } else if (hit.launched || Math.hypot(hit.enemy.x, hit.enemy.y) <= hit.enemy.attackRange + 1) {
        damageTower(arena, hit.enemy);
      }
    }
    if (tower.health <= 0) return;
  }
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
    if (enemy.fire > 0 || enemy.bleed) {
      enemy.nextPeriodic ??= arena.now + 0.5;
      if (arena.now + 1e-9 >= enemy.nextPeriodic) {
        if (enemy.fire > 0) {
          const decay = Math.min(enemy.fire, Math.max(1, enemy.fire * 0.075));
          wound(arena, enemy, decay, 'Fire', null, false);
          enemy.fire -= decay;
        }
        if (enemy.bleed) wound(arena, enemy, enemy.bleed, 'Spikes', towerSpikes, false);
        enemy.nextPeriodic += 0.5;
      }
    }
    if (enemy.dead) continue;
    enemy.frostTime -= dt;
    if (enemy.frostTime <= 0) enemy.frost = 0;
    enemy.stun -= dt;
    if (enemy.knockback) {
      const push = enemy.knockback;
      if (arena.now + 1e-9 >= push.next) {
        const distance = Math.hypot(enemy.x, enemy.y) || 1;
        const step = Math.min(25, push.remaining);
        const x = enemy.x + enemy.x / distance * step;
        const y = enemy.y + enemy.y / distance * step;
        if (!arena.walkable || arena.walkable(arena.layout.x + x, arena.layout.y + y)) {
          enemy.x = x;
          enemy.y = y;
          push.remaining -= step;
          push.next += 0.03;
        } else push.remaining = 0;
        if (push.remaining <= 0) enemy.knockback = null;
      }
      enemy.walking = false;
      continue;
    }
    if (enemy.stun > 0) { enemy.walking = false; continue; }
    const distance = Math.hypot(enemy.x, enemy.y);
    const reach = enemy.attackRange;
    if (distance > reach) {
      const step = Math.min(distance - reach, Math.min(enemy.speed, arena.combatRules?.maxUnitSpeed ?? 522) * dt * (1 - enemy.frost / 100));
      enemy.x -= step * enemy.x / distance;
      enemy.y -= step * enemy.y / distance;
      enemy.walking = true;
      continue;
    }
    enemy.walking = false;
    if (enemy.nextAttack > arena.now) continue;
    enemy.nextAttack = arena.now + enemy.attackCooldown / Math.max(0.2, 1 - enemy.frost / 100 - (enemy.attackSlow?.amount ?? 0));
    enemy.attackAt = arena.now;
    arena.emit({ kind: 'enemyAttack', x: enemy.x, y: enemy.y, family: enemy.family, enemyId: enemy.key });
    arena.enemyHits.push({ enemy, at: arena.now + timeOnStep(enemy.damagePoint ?? 0.3),
      flight: enemy.projectileSpeed ? timeOnStep(distance / enemy.projectileSpeed) : 0 });
  }
  const livingWood = (tower.effects.get('livingWoodUntil') ?? 0) > arena.now ? 150 * count(tower, 'Living Wood') : 0;
  const regen = tower.regen * (1 + stat(tower, 'regenMultiplier')) + poisonArmorRegen + livingWood;
  heal(tower, regen * dt, 1);
}
