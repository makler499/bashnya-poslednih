const damageSchools = ['Normal', 'Piercing', 'Magic', 'Siege', 'Chaos'];
const rollGroups = ['Income', 'Income', 'Utility', 'Damage'];
const blackMarket = { id: 'A0GR', name: 'Black Market', gold: 500, kind: 'upgrade', rarity: 'common' };
const tiers = ['common', 'uncommon', 'rare', 'epic'];

function rarityFor(gold) {
  if (gold >= 10000) return 'epic';
  if (gold >= 5000) return 'rare';
  if (gold >= 2000) return 'uncommon';
  return 'common';
}

export function createShop(map, random) {
  const pick = values => values[Math.floor(random() * values.length)];
  const weapons = map.weapons.map(weapon => ({ ...weapon, id: weapon.abilityId, kind: 'weapon' }));
  const byRarity = new Map(tiers.map(rarity => [rarity, weapons.filter(weapon => weapon.rarity === rarity)]));
  const upgradeById = new Map(Object.entries(map.shop.upgrades).map(([id, upgrade]) => [
    id, { ...upgrade, id, kind: 'upgrade', rarity: rarityFor(upgrade.gold) },
  ]));
  upgradeById.set(blackMarket.id, {
    ...blackMarket,
    effects: ['Открывает лавку с оружием и шипами необычной редкости на выбор.'],
  });
  const pools = Object.fromEntries(Object.entries(map.shop.pools).map(([key, pool]) => [
    key, Object.values(pool).map(id => upgradeById.get(id)),
  ]));

  function rollTier(wave, upgrade = false) {
    const growth = Math.min(20, Math.max(0, wave - 1));
    const epic = Math.max(0, Math.min(15, wave - 5)) * (upgrade ? 2 : 1);
    if (random() * 100 < epic) return 'epic';
    if (random() * 100 < 30 + growth) return 'rare';
    if (random() * 100 < 70 + growth) return 'uncommon';
    return 'common';
  }

  function rollUpgrade(commonOnly, wave) {
    if (random() < 1 / 6) {
      const tier = commonOnly ? 'common' : rollTier(wave, true);
      const spikes = pools.Spikes2.filter(entry => entry.rarity === tier);
      if (spikes.length) return pick(spikes);
    }
    const group = pick(rollGroups);
    if (!commonOnly && group === 'Damage' && rollTier(wave, true) === 'epic') return pick(pools.Damage2Epic);
    if (!commonOnly && group === 'Income' && wave < 6) return pick(pools.Income2.slice(0, 30));
    return pick(pools[group + (commonOnly ? '1' : '2')]);
  }

  return {
    offer(wave) {
      return [
        pick(byRarity.get('common')),
        ...Array.from({ length: 3 }, () => pick(byRarity.get(rollTier(wave)))),
        rollUpgrade(true, wave),
        ...Array.from({ length: 3 }, () => rollUpgrade(false, wave)),
      ];
    },
    market: [...byRarity.get('uncommon'), ...pools.Spikes2.filter(entry => entry.rarity === 'uncommon')],
  };
}

export function createTower(startingGold) {
  return {
    gold: startingGold,
    health: 1500,
    maxHealth: 1500,
    shield: 0,
    maxShield: 0,
    armor: 0,
    bonusArmor: 0,
    regen: 0,
    shieldRegen: 1,
    income: 0,
    incomeMultiplier: 1,
    bountyMultiplier: 1,
    flatReduction: 0,
    damageReduction: 0,
    shieldReduction: 0,
    attackSpeed: 1,
    healing: 1,
    critChance: 0,
    critPower: 1.5,
    dodge: 0,
    spikes: 0,
    reconstruction: 0,
    clears: 1,
    freeRerolls: 5,
    rollsPaid: 0,
    duplicated: 0,
    commonCopies: 0,
    marketOpen: false,
    treasure: null,
    effects: new Map(),
    stats: new Map(),
    weapons: new Map(),
    upgrades: new Map(),
    kills: 0,
    damage: 0,
    towerDamage: 0,
    healed: 0,
    repairAt: 0,
  };
}

export function stat(tower, name) {
  return tower.stats.get(name) ?? 0;
}

function addStat(tower, name, amount) {
  tower.stats.set(name, stat(tower, name) + amount);
}

export function heal(tower, amount, multiplier = tower.healing) {
  const before = Math.max(0, tower.health);
  tower.health = Math.min(tower.maxHealth, tower.health + amount * multiplier);
  const restored = Math.max(0, tower.health - before);
  tower.healed += restored;
  return restored;
}

function addHealth(tower, amount) {
  const maximum = Math.max(1, tower.maxHealth + amount);
  tower.health = Math.max(1, Math.min(maximum, tower.health + maximum - tower.maxHealth));
  tower.maxHealth = maximum;
}

const statByText = new Map([
  ['Damage', 'all'], ['Damage to Stunned enemies', 'stunned'], ['Damage to Poisoned enemies', 'poisoned'],
  ['Damage to enemies who are or have been Frozen', 'frozen'],
  ['Damage for 900 and 1200 Attack Range Weapons', 'long'],
  ['Damage for 300 and 600 Attack Range Weapons', 'short'],
  ['Damage for Single Target Weapons', 'Single Target'], ['Damage for Splash Weapons', 'Splash'],
  ['Damage for Wave Weapons', 'Wave'], ['Damage for 500 Gold (Common) Weapons', 'common'],
  ['Enemies hit by Bounce and Barrage', 'multifire'], ['Area of Effect for Area Weapons', 'area'],
  ['Stun Duration', 'stunDuration'], ['Poison damage', 'Poison'], ['Fire damage', 'Fire'],
  ['Frost damage & effect strength', 'Frost'],
]);

function applyEffect(tower, line, copies) {
  const parsed = /^([+-]\d+(?:\.\d+)?)(%)?\s+(.+)$/.exec(line.trim());
  if (!parsed) return;
  const [, number, percent, description] = parsed;
  const text = description.replace(', but cannot reduce an attack below 25% of its damage', '');
  const flat = Number(number) * copies;
  const ratio = flat / 100;
  if (text === 'Max HP') return addHealth(tower, percent ? tower.maxHealth * ratio : flat);
  if (text === 'Mana Shield' && !percent) {
    tower.maxShield += flat;
    tower.shield += flat;
    return;
  }
  const fields = {
    'Armor': ['armor', flat], 'HP Regen': ['regen', flat], 'Gold': ['gold', flat],
    'Gold per second': percent ? ['incomeMultiplier', ratio] : ['income', flat],
    'Kill Bounty': ['bountyMultiplier', ratio], 'Attack Speed': ['attackSpeed', ratio],
    'Damage Reduction': percent ? ['damageReduction', ratio] : ['flatReduction', flat],
    'Damage Reduction while Mana Shield is active': ['shieldReduction', ratio],
    'Dodge': ['dodge', ratio], 'Healing': ['healing', ratio], 'Mana Regeneration': ['shieldRegen', ratio],
    'Critical Strike Chance': ['critChance', ratio], 'Critical Strike Power': ['critPower', ratio],
    'charge of Reconstruction': ['reconstruction', flat],
  };
  if (text === 'HP Regen' && percent) return addStat(tower, 'regenMultiplier', ratio);
  if (text === 'Spikes Damage' && !percent) {
    tower.spikes += flat;
    return;
  }
  if (fields[text]) {
    const [key, amount] = fields[text];
    tower[key] += amount;
    return;
  }
  if (percent && statByText.has(text)) return addStat(tower, statByText.get(text), ratio);
  const schoolMatch = percent && /^((?:Normal|Piercing|Magic|Siege|Chaos|Spikes)(?:\/\w+)*) Damage$/.exec(text);
  if (schoolMatch) {
    for (const school of schoolMatch[1].split('/')) addStat(tower, school, ratio);
  }
}

const scrollSchools = {
  'Normal Scroll': 'Normal', 'Scroll of Piercing': 'Piercing', 'Scroll of Magic': 'Magic',
  'Scroll of Siege': 'Siege', 'Scroll of Chaos': 'Chaos',
};

export function purchase(tower, item, time) {
  if (!item || tower.gold < item.gold) return false;
  tower.gold -= item.gold;
  if (item.kind === 'weapon') {
    const existing = tower.weapons.get(item.id);
    const extra = item.rarity === 'rare' ? tower.duplicated : 0;
    if (extra) tower.duplicated = 0;
    if (existing) existing.copies += 1 + extra;
    else tower.weapons.set(item.id, { item, copies: 1 + extra, next: time, phase: 0, target: null });
    return true;
  }

  const name = item.name;
  const existing = tower.upgrades.get(name) ?? 0;
  let copies = 1;
  if (item.gold === 500 && tower.commonCopies && !['Magic Coin', 'Magic Treasure', 'Black Market'].includes(name)) {
    copies += tower.commonCopies;
    tower.commonCopies = 0;
  }
  if (item.gold === 5000 && item.effects.some(line => /^\+\d+ Spikes Damage/.test(line))) {
    copies += tower.duplicated;
    tower.duplicated = 0;
  }
  tower.upgrades.set(name, existing + copies);
  for (const line of item.effects) applyEffect(tower, line, copies);
  if (name === 'Black Market') tower.marketOpen = true;
  if (name === 'Multiplication Gems') tower.commonCopies += 3;
  if (name === 'Duplicator') tower.duplicated += 1;
  if (name === 'Magic Treasure') {
    if (tower.treasure) tower.gold += Math.floor(tower.treasure.value);
    tower.treasure = { value: 0, rate: 5 };
  }
  if (name === 'Urn of Avarice') tower.effects.set('urn', (tower.effects.get('urn') ?? 0) + 20);
  return true;
}

export function count(tower, name) {
  return tower.upgrades.get(name) ?? 0;
}

export function roundUpgrades(tower) {
  tower.income += count(tower, 'Entangled Gold Mine');
  tower.gold += count(tower, 'Gold Delivery') * 1000 * tower.incomeMultiplier;
  tower.armor += count(tower, 'Blessed Armor') * 1.5;
  tower.spikes += count(tower, 'Growing Spikes') * 6;
  addStat(tower, 'all', count(tower, 'Power Generator') * 0.01);
  for (const [name, school] of Object.entries(scrollSchools)) addStat(tower, school, count(tower, name) * 0.03);
  tower.effects.delete('reactiveArmor');
  tower.effects.delete('spikyArmor');
}

export function tickEconomy(tower, baseIncome) {
  tower.gold += baseIncome + Math.trunc(tower.income * tower.incomeMultiplier + 0.05);
  tower.regen += count(tower, 'Wisp') * 0.2;
  addHealth(tower, count(tower, 'Magic Seeds') * 5);
  tower.maxShield += count(tower, 'Moonwell') * 10;
  tower.shield = Math.min(tower.maxShield, tower.shield + tower.maxShield * 0.05 * tower.shieldRegen);
  if (tower.treasure) {
    tower.treasure.value += tower.treasure.rate;
    tower.treasure.rate *= 1.01;
  }
  const urn = tower.effects.get('urn') ?? 0;
  if (urn) {
    tower.gold += 500;
    tower.effects.set('urn', urn - 1);
  }
  tower.bonusArmor = Math.min(10, tower.bonusArmor + count(tower, 'Armor-Plated Spikes'));
}

export function weaponMultiplier(tower, weapon, enemy) {
  const groups = ['all', weapon.damageTypes[0], weapon.range >= 900 ? 'long' : 'short'];
  if (weapon.rarity === 'common') groups.push('common');
  for (const type of ['Single Target', 'Splash', 'Wave']) if (weapon.attackType.includes(type)) groups.push(type);
  if (enemy.stun > 0) groups.push('stunned');
  if (enemy.poison.length) groups.push('poisoned');
  if (enemy.frozen) groups.push('frozen');
  let multiplier = groups.reduce((result, key) => result * (1 + stat(tower, key)), 1);
  const stone = count(tower, 'Mastercrafted Masonry');
  if (stone) multiplier *= 1 + tower.maxHealth / 100000 * 2 * (1 - 0.5 ** stone);
  const ring = count(tower, 'Golden Ring');
  if (ring) multiplier *= 1 + (tower.bountyMultiplier - 1) * 0.02 * 2 * (1 - 0.5 ** ring);
  const mark = count(tower, 'Arcane Mark');
  if (mark && tower.shield > 0) multiplier *= 1 + tower.maxShield / 200000 * 2 * (1 - 0.5 ** mark);
  const epicAttacks = ['Blessed Steel', 'Enchanted Moon Arrow', 'Magic Gemstone', 'Refined Explosives', 'Chaos Legion'];
  const epicIndex = damageSchools.indexOf(weapon.damageTypes[0]);
  if (epicIndex !== -1) {
    const epicCount = count(tower, epicAttacks[epicIndex]);
    const starterCount = [...tower.weapons.values()].find(({ item }) => item.slot === epicIndex)?.copies ?? 0;
    multiplier *= 1 + 0.05 * epicCount * starterCount;
  }
  return multiplier;
}
