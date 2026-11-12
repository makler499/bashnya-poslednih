import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAttacks, combatStep, startRoundWeapons, tickEnemies, tickImpacts, tickWeapons } from '../combat.mjs';
import { createMatch } from '../match.mjs';
import { createSpawnPlanner } from '../enemy-spawn.mjs';
import { createTower, purchase, roundUpgrades } from '../shop.mjs';

const map = JSON.parse(readFileSync(new URL('../map.json', import.meta.url), 'utf8'));
const attacks = buildAttacks(map.weapons);
const weapon = slot => ({ ...map.weapons.find(item => item.slot === slot), kind: 'weapon', id: map.weapons.find(item => item.slot === slot).abilityId });
const mob = (key, x, y = 0) => ({ key, x, y, hp: 100_000, maxHp: 100_000, armor: 'none', damageTaken: 1,
  cc: 1, speed: 0, stun: 0, frost: 0, fire: 0, bleed: 0, attackRange: 0, nextAttack: Infinity,
  poison: [], vulnerability: new Map() });
function arena(slots, enemies) {
  const state = { now: 0, tower: createTower(1_000_000), random: () => 0, enemies, events: [],
    hits: [], waves: [], enemyHits: [], fields: [], corpses: [], layout: { x: 0, y: 0 }, combatRules: map.combatRules };
  state.emit = event => state.events.push({ ...event, at: state.now });
  for (const slot of slots) assert.ok(purchase(state.tower, weapon(slot), 0));
  return state;
}
const shots = state => state.events.filter(event => event.kind === 'shot' || event.kind === 'beam');
const impactAt = (state, time) => { state.now = time; tickImpacts(state); };

test('same-tick weapons reserve distinct in-range targets, then share if necessary', () => {
  const state = arena([0, 1, 2], [mob(1, 200), mob(2, 500), mob(3, 901)]);
  tickWeapons(state, attacks, combatStep);
  assert.deepEqual(shots(state).map(event => event.targetId), [1, 2, 1]);
  const spread = arena([0], [mob(1, 200), mob(2, 500)]);
  spread.random = () => 0.99;
  tickWeapons(spread, attacks, combatStep);
  assert.equal(shots(spread)[0].targetId, 2);
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
  const match = createMatch(map, [{ seat: 1 }], { seed: 36, preparation: 0 });
  assert.equal(match.snapshot(1).player.gold, 5000);
  for (let roll = 0; roll < 5; roll++) assert.ok(match.action(1, { type: 'reroll' }));
  assert.equal(match.snapshot(1).player.price, 250);
  assert.ok(match.action(1, { type: 'reroll' }));
  assert.equal(match.snapshot(1).player.price, 300);
  match.tick(30);
  assert.equal(match.snapshot(1).wave, 2);
  assert.equal(match.snapshot(1).player.income, 55);
  assert.equal(match.snapshot(1).player.waveBonusGold, 5);
  const tower = createTower(5000);
  assert.ok(purchase(tower, { ...map.shop.upgrades.A0DU, id: 'A0DU', kind: 'upgrade' }, 0));
  assert.equal(tower.spikes, 40);
  roundUpgrades(tower);
  assert.equal(tower.spikes, 46);
  assert.equal(createSpawnPlanner(map, () => 0)([{ arena: map.arenas[0], variant: 14 }])[0].unitId, 'h00G');
});

test('eight towers reproduce combat and event order under 1x, 1.5x and 2x timing', () => {
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
});
