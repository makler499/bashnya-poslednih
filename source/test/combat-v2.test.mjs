import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAttacks, combatStep, startRoundWeapons, tickEnemies, tickImpacts, tickWeapons } from '../combat.mjs';
import { createMatch } from '../match.mjs';
import { createSpawnPlanner } from '../enemy-spawn.mjs';
import { createTower, purchase, roundUpgrades, tickEconomy } from '../shop.mjs';

const map = JSON.parse(readFileSync(new URL('../map.json', import.meta.url), 'utf8'));
const attacks = buildAttacks(map.weapons);
const weapon = slot => ({ ...map.weapons.find(item => item.slot === slot), kind: 'weapon', id: map.weapons.find(item => item.slot === slot).abilityId });
const mob = (key, x, y = 0) => ({ key, x, y, hp: 100_000, maxHp: 100_000, armor: 'none', damageTaken: 1,
  cc: 1, speed: 0, stun: 0, frost: 0, fire: 0, bleed: 0, attackRange: 0, nextAttack: Infinity,
  poison: [], vulnerability: new Map() });
function arena(slots, enemies) {
  const state = { now: 0, tower: createTower(1_000_000), random: () => 0, enemies, events: [],
    hits: [], waves: [], enemyHits: [], fields: [], layout: { x: 0, y: 0 }, combatRules: map.combatRules };
  state.emit = event => state.events.push({ ...event, at: state.now });
  for (const slot of slots) assert.ok(purchase(state.tower, weapon(slot), 0));
  return state;
}
const shots = state => state.events.filter(event => event.kind === 'shot' || event.kind === 'beam');
const impactAt = (state, time) => { state.now = time; tickImpacts(state); };

test('each same-tick weapon independently chooses from its own in-range group', () => {
  const state = arena([0, 1, 2], [mob(1, 200), mob(2, 500), mob(3, 901)]);
  tickWeapons(state, attacks, combatStep);
  assert.deepEqual(shots(state).map(event => event.targetId), [1, 1, 1]);
  const spread = arena([0, 133], [mob(1, 200), mob(2, 500)]);
  spread.random = () => 0.99;
  tickWeapons(spread, attacks, combatStep);
  assert.deepEqual(shots(spread).map(event => event.targetId), [2, 1]);
});

test('drain retains a living target, then retargets after range exit and death', () => {
  const first = mob(1, 100), second = mob(2, 200), third = mob(3, 250);
  const state = arena([19], [first, second, third]);
  tickWeapons(state, attacks, combatStep);
  state.random = () => 0.99;
  state.now = 0.35;
  tickWeapons(state, attacks, combatStep);
  first.x = 601;
  state.now = 0.70;
  tickWeapons(state, attacks, combatStep);
  third.dead = true;
  state.now = 1.05;
  tickWeapons(state, attacks, combatStep);
  assert.deepEqual(shots(state).map(event => event.targetId), [1, 1, 3, 2]);
});

test('Tesla uses 1800 units/s and chains at impact within 600 units without revisiting', () => {
  const first = mob(1, 180), second = mob(2, 740), third = mob(3, 1341);
  const state = arena([133], [first, second, third]);
  tickWeapons(state, attacks, combatStep);
  assert.equal(shots(state)[0].duration, 0.1);
  impactAt(state, 0.075);
  assert.equal(first.hp, first.maxHp);
  impactAt(state, 0.1);
  assert.equal(first.hp, first.maxHp - 325);
  assert.equal(second.hp, second.maxHp);
  assert.equal(shots(state)[1].sourceId, 1);
  assert.equal(shots(state)[1].targetId, 2);
  assert.equal(shots(state)[1].duration, 0.325);
  impactAt(state, 0.425);
  assert.equal(second.hp, second.maxHp - 325);
  assert.equal(third.hp, third.maxHp);
  assert.equal(shots(state).length, 2);
});

test('brigand launches on the object damage point and tower damage waits for its projectile', () => {
  const archetype = map.enemies.find(enemy => enemy.id === 'n001');
  const enemy = { ...mob(1, 225), ...archetype, nextAttack: 0, damage: 10, speed: 0, hp: 600, maxHp: 600 };
  const state = arena([], [enemy]);
  state.damagePerHit = 1.03;
  tickEnemies(state, combatStep);
  assert.equal(shots(state).length, 0);
  state.now = archetype.damagePoint;
  tickEnemies(state, combatStep);
  assert.equal(shots(state)[0].duration, 0.25);
  assert.equal(shots(state)[0].model, 'abilities/weapons/banditmissile/banditmissile.mdx');
  assert.equal(state.tower.health, 1500);
  state.now += 0.25;
  tickEnemies(state, combatStep);
  assert.equal(state.tower.health, 1490);
});

test('mortar impact uses flight timestamp and the object splash profile', () => {
  const first = mob(1, 600), near = mob(2, 680), far = mob(3, 901);
  const state = arena([11], [first, near, far]);
  tickWeapons(state, attacks, combatStep);
  assert.equal(shots(state)[0].duration, 0.5);
  assert.equal(shots(state)[0].targetId, null);
  impactAt(state, 0.475);
  assert.equal(first.hp, first.maxHp);
  impactAt(state, 0.5);
  assert.equal(first.hp, first.maxHp - 700);
  assert.equal(near.hp, near.maxHp - 175);
  assert.equal(far.hp, far.maxHp);
  assert.ok(state.events.some(event => event.kind === 'impact' && event.at === 0.5));
});

test('homing projectile advances at its configured speed and reports the actual impact point', () => {
  const enemy = mob(1, 600);
  const state = arena([0], [enemy]);
  tickWeapons(state, attacks, combatStep);
  impactAt(state, 0.25);
  assert.equal(state.hits[0].position.x, 300);
  enemy.x = 660;
  impactAt(state, 0.5);
  assert.equal(enemy.hp, enemy.maxHp);
  assert.equal(state.hits[0].position.x, 600);
  impactAt(state, 0.55);
  assert.ok(enemy.hp < enemy.maxHp);
  const end = state.events.find(event => event.kind === 'shotEnd');
  assert.equal(end.projectileId, shots(state)[0].projectileId);
  assert.equal(end.at, 0.55);
  assert.equal(end.x, 660);
});

test('barrage chooses distinct live targets within range', () => {
  const state = arena([21], [mob(1, 100), mob(2, 200), mob(3, 300), mob(4, 500), mob(5, 1201)]);
  tickWeapons(state, attacks, combatStep);
  assert.deepEqual(shots(state).map(event => event.targetId), [1, 2, 3, 4]);
});

test('Cluster Rockets retains an aim point for two seconds and damages only at impact', () => {
  const target = mob(1, 600), moved = mob(2, 700);
  const state = arena([104], [target, moved]);
  tickWeapons(state, attacks, combatStep);
  assert.equal(shots(state)[0].duration, 1);
  target.x = 1050;
  state.now = 0.35;
  tickWeapons(state, attacks, combatStep);
  assert.deepEqual(shots(state)[1].to, { x: 600, y: 0 });
  impactAt(state, 0.975);
  assert.equal(moved.hp, moved.maxHp);
  impactAt(state, 1);
  assert.equal(moved.maxHp - moved.hp, 325);
  assert.equal(target.hp, target.maxHp);
  state.now = 2;
  tickWeapons(state, attacks, combatStep);
  assert.deepEqual(shots(state).at(-1).to, { x: 700, y: 0 });
});

test('moving wave only hits targets reached by its front and only once', () => {
  const near = mob(1, 200), far = mob(2, 450), side = mob(3, 310, 150);
  const state = arena([24], [near, far, side]);
  tickWeapons(state, attacks, combatStep);
  impactAt(state, 0.175);
  assert.equal(near.hp, near.maxHp);
  impactAt(state, 0.2);
  assert.ok(near.hp < near.maxHp);
  const after = near.hp;
  impactAt(state, 0.45);
  impactAt(state, 0.6);
  assert.equal(near.hp, after);
  assert.ok(far.hp < far.maxHp);
  assert.equal(side.hp, side.maxHp);
});

test('wave checks sideways position at the point where a moving enemy crosses its front', () => {
  const aim = mob(1, 200), crossing = mob(2, 200), entersLate = mob(3, 200, 200);
  const state = arena([24], [aim, crossing, entersLate]);
  tickWeapons(state, attacks, combatStep);
  impactAt(state, 0.175);
  Object.assign(crossing, { previousX: 200, previousY: 0, x: 175, y: 160 });
  Object.assign(entersLate, { previousX: 180, previousY: 200, x: 180, y: 100 });
  impactAt(state, 0.2);
  assert.ok(crossing.hp < crossing.maxHp);
  assert.equal(entersLate.hp, entersLate.maxHp);
});

test('Impaler uses the object damage without crit and shares one script crit roll across the wave', () => {
  for (const [chance, roll, expected] of [[0, 0, 7500], [0.5, 0.99, 4500], [0.5, 0, 11250]]) {
    const first = mob(1, 150), second = mob(2, 270);
    const state = arena([201], [first, second]);
    state.tower.critChance = chance;
    let calls = 0;
    state.random = () => [0, roll][calls++];
    tickWeapons(state, attacks, combatStep);
    impactAt(state, 0.1);
    assert.equal(first.maxHp - first.hp, expected);
    assert.equal(second.maxHp - second.hp, expected);
    assert.equal(calls, chance > 0 ? 2 : 1);
  }
});

test('normal damage uses the archive armor matrix and DefenseArmor coefficient', () => {
  const enemy = { ...mob(1, 120), armor: 'medium', armorValue: 20 };
  const state = arena([0], [enemy]);
  tickWeapons(state, attacks, combatStep);
  impactAt(state, 0.1);
  assert.equal(enemy.maxHp - enemy.hp, 100);
});

test('wind spear moves a target in 25-unit steps and stops at blocked terrain', () => {
  const enemy = mob(1, 120);
  const state = arena([206], [enemy]);
  state.walkable = x => x <= 145;
  tickWeapons(state, attacks, combatStep);
  impactAt(state, 0.1);
  assert.equal(enemy.x, 120);
  state.now = 0.15;
  tickEnemies(state, combatStep);
  assert.equal(enemy.x, 145);
  state.now = 0.175;
  tickEnemies(state, combatStep);
  assert.equal(enemy.x, 145);
  assert.equal(enemy.knockback, null);
});

test('Parasite stacks without instant damage, then deals damage and heals', () => {
  const enemy = mob(1, 200);
  const state = arena([214, 214], [enemy]);
  state.tower.health = 1000;
  tickWeapons(state, attacks, combatStep);
  state.now = 0.5;
  tickWeapons(state, attacks, combatStep);
  assert.equal(enemy.hp, enemy.maxHp);
  state.now = 1;
  tickEnemies(state, combatStep);
  assert.equal(enemy.maxHp - enemy.hp, 2400);
  assert.equal(state.tower.health, 1100);
});

test('Necromancer starts charged, raises a mage at a qualifying kill and credits its projectile', () => {
  const victim = { ...mob(1, 300), hp: 40 }, next = mob(2, 500);
  const state = arena([129, 0], [victim, next]);
  const tome = state.tower.necromancy;
  assert.equal(tome.charges, 10);
  tickWeapons(state, attacks, combatStep);
  assert.equal(state.fields.length, 0);
  impactAt(state, 0.25);
  assert.equal(tome.charges, 0);
  assert.ok(victim.dead);
  assert.equal(state.fields[0].until, 5.25);
  assert.equal(state.fields[0].radius, 600);
  assert.deepEqual(shots(state).at(-1).from, { x: 300, y: 0 });
  assert.equal(tome.damage, undefined);
  impactAt(state, 0.45);
  assert.equal(tome.damage, undefined);
  impactAt(state, 0.475);
  assert.equal(tome.damage, 3000);
  assert.equal(state.tower.weaponDamage, 3040);
  for (let time = 0; time < 10; time++) tickEconomy(state.tower, 0);
  assert.equal(tome.charges, 10);
});

test('fire continues to tick at full stack strength and credits the weapon', () => {
  const enemy = mob(1, 240);
  const state = arena([26], [enemy]);
  tickWeapons(state, attacks, combatStep);
  impactAt(state, 0.2);
  const direct = state.tower.weaponDamage;
  assert.ok(direct > 0);
  state.now = 0.475;
  tickEnemies(state, combatStep);
  assert.equal(state.tower.damage, direct);
  for (const time of [0.5, 1, 1.5]) {
    state.now = time;
    tickEnemies(state, combatStep);
  }
  assert.ok(Math.abs(state.tower.damage - direct * 1.15) < 1e-6);
  assert.equal(state.tower.damage, state.tower.weaponDamage);
  assert.equal(state.tower.towerDamage, 0);
});

test('frost caps at 50 stacks and freezes the same enemy only once', () => {
  const enemy = { ...mob(1, 200), cc: 0.5 };
  const state = arena([43], [enemy]);
  state.tower.stats.set('Frost', 0.5);
  for (let attack = 0; attack < 9; attack++) {
    state.now = attack * 0.35;
    tickWeapons(state, attacks, combatStep);
  }
  assert.equal(enemy.frost, 50);
  assert.equal(enemy.stun, 2.25);
  enemy.stun = 0;
  state.now += 0.35;
  tickWeapons(state, attacks, combatStep);
  assert.equal(enemy.stun, 0);
});

test('Storm Generator activates at the round boundary and pulses after 1.5 seconds', () => {
  const enemy = mob(1, 500);
  const state = arena([212, 212], [enemy]);
  tickWeapons(state, attacks, combatStep);
  assert.equal(state.fields.length, 0);
  startRoundWeapons(state, attacks);
  assert.equal(state.fields[0].until, 15);
  impactAt(state, 1.475);
  assert.equal(enemy.hp, enemy.maxHp);
  impactAt(state, 1.5);
  assert.equal(enemy.maxHp - enemy.hp, 18_000);
});

test('v2 catalog, round income, rerolls, growing spikes and special wagon variant', () => {
  assert.equal(map.title, 'Tower Survivors v2.0');
  assert.equal(map.weapons.length, 90);
  assert.equal(map.challenges.length, 50);
  const economyMap = { ...map, weapons: map.weapons.map(weapon => weapon.slot <= 4
    ? { ...weapon, baseDamage: 100000, cooldownSeconds: 0.1 } : weapon) };
  const match = createMatch(economyMap, [{ seat: 1 }], { seed: 36, preparation: 0 });
  assert.equal(match.snapshot(1).player.gold, 5000);
  for (let roll = 0; roll < 6; roll++) assert.ok(match.action(1, { type: 'reroll' }));
  assert.equal(match.snapshot(1).player.price, null);
  assert.equal(match.action(1, { type: 'reroll' }), false);
  assert.ok(match.action(1, { type: 'buy', slot: 0, version: match.snapshot(1).player.version }));
  match.tick(30);
  assert.equal(match.snapshot(1).wave, 2);
  assert.equal(match.snapshot(1).player.income, 55);
  assert.equal(match.snapshot(1).player.waveBonusGold, 5);
  assert.equal(match.snapshot(1).player.price, 250);
  assert.ok(match.action(1, { type: 'reroll' }));
  assert.equal(match.snapshot(1).player.price, null);
  match.tick(30);
  assert.equal(match.snapshot(1).player.price, 300);
  const tower = createTower(5000);
  assert.ok(purchase(tower, { ...map.shop.upgrades.A0DU, id: 'A0DU', kind: 'upgrade' }, 0));
  assert.equal(tower.spikes, 40);
  roundUpgrades(tower);
  assert.equal(tower.spikes, 46);
  assert.equal(createSpawnPlanner(map, () => 0)([{ arena: map.arenas[0], variant: 14 }])[0].unitId, 'h00G');
});

test('multiboard uses slot order and investments while viewed weapons and local income stay distinct', () => {
  const players = [{ seat: 2, name: 'Синий', score: 100 }, { seat: 1, name: 'Красный', score: 50 }];
  const match = createMatch(map, players, { seed: 36 });
  assert.equal(match.snapshot(1).schedule.shopLife, 1);
  match.tick(5);
  assert.ok(match.snapshot(1).schedule.shopLife < 1);
  assert.ok(match.action(1, { type: 'reroll' }));
  assert.equal(match.snapshot(1).schedule.shopLife, 1);
  const { version } = match.snapshot(2).player;
  assert.ok(match.action(2, { type: 'buy', slot: 0, version }));
  match.tick(5);
  const observed = match.snapshot(1, 2);
  assert.deepEqual(observed.seats.map(seat => [seat.seat, seat.boardColor, seat.damageInvestment, seat.score]), [
    [1, '#ff0303', 0, 50], [2, '#0042ff', 1, 100],
  ]);
  assert.equal(observed.incomeDetails.gold, 5000);
  assert.equal(observed.observedStats.name, 'Синий');
  assert.equal(observed.observedStats.weapons[0].copies, 1);
  match.tick(50);
  const renewed = match.snapshot(1, 2);
  assert.equal(renewed.wave, 2);
  assert.equal(renewed.schedule.shopLife, 1);
  assert.ok(renewed.arena.events.some(event => event.kind === 'round' && event.shopRefresh));
});

test('opening purchase reaches a real enemy and records weapon damage before a tower hit', () => {
  const tested = new Set();
  for (let seed = 0; tested.size < 5 && seed < 60; seed++) {
    const match = createMatch(map, [{ seat: 1 }], { seed });
    const starting = match.snapshot(1);
    const item = starting.player.shop[0];
    if (tested.has(item.slot)) continue;
    tested.add(item.slot);
    assert.equal(starting.preparation, 30);
    assert.equal(starting.player.health, 1500);
    assert.equal(starting.player.gold, 5000);
    assert.equal(starting.player.directDefense, false);
    assert.ok(match.action(1, { type: 'buy', slot: 0, version: starting.player.version }));
    assert.equal(match.snapshot(1).player.gold, 4500);
    match.tick(31.975);
    assert.equal(match.snapshot(1).arena.enemies.length, 0);
    match.tick(0.025);
    assert.ok(match.snapshot(1).arena.enemies.length > 0);
    match.tick(7);
    const { player } = match.snapshot(1);
    assert.equal(player.health, 1500);
    assert.ok(player.weaponDamage > 0, item.name);
    assert.equal(player.towerDamage, 0);
    assert.equal(player.damage, player.weaponDamage);
    assert.equal(player.weaponDamage, player.weapons[0].damage);
  }
  assert.equal(tested.size, 5);
});

test('the last surviving tower faces the boss at wave 31 and finishes in first place', () => {
  const finaleMap = { ...map, weapons: map.weapons.map(weapon => weapon.slot <= 4
    ? { ...weapon, baseDamage: 100_000_000, cooldownSeconds: 0.1 } : weapon) };
  const match = createMatch(finaleMap, [{ seat: 1 }, { seat: 2 }], { seed: 0, preparation: 0 });
  assert.ok(match.action(1, { type: 'buy', slot: 0, version: 1 }));
  match.leave(2);
  assert.equal(match.snapshot(1).player.lastStand, true);
  match.tick(899.975);
  assert.equal(match.snapshot(1).bossPhase, false);
  match.tick(0.025);
  const finale = match.snapshot(1);
  assert.equal(finale.bossPhase, true);
  assert.equal(finale.wave, 31);
  assert.deepEqual(finale.arena.enemies.map(enemy => enemy.id), ['samwise']);
  assert.equal(finale.player.shop.every(item => item === null), true);
  match.tick(3);
  assert.equal(match.snapshot(1).finished, true);
  assert.equal(match.snapshot(1).player.place, 1);
});

test('eight towers reproduce combat and event order under all four speeds', () => {
  const players = Array.from({ length: 8 }, (_, index) => ({ seat: index + 1, name: `Башня ${index + 1}`, bot: index > 0 }));
  function simulate(speed) {
    const match = createMatch(map, players, { seed: 235, preparation: 0, speed });
    const { shop, version } = match.snapshot(1).player;
    assert.ok(shop[0].kind === 'weapon');
    assert.ok(match.action(1, { type: 'buy', slot: 0, version }));
    assert.equal(match.action(2, { type: 'speed', value: 2 }), false);
    for (let index = 0; index < Math.round(60 / (0.1 * speed)); index++) match.tick(0.1 * speed);
    const frame = match.snapshot(1);
    assert.equal(frame.seats.length, 8);
    assert.equal(frame.wave, 3);
    const { speed: displayedSpeed, ...deterministic } = frame;
    return deterministic;
  }
  const expected = simulate(1);
  assert.deepEqual(simulate(1.5), expected);
  assert.deepEqual(simulate(2), expected);
  assert.deepEqual(simulate(3), expected);
});
