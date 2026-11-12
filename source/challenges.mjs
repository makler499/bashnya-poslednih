const groups = ['ABC', 'DEF', 'GHI', 'KLM', 'NOPQ', 'STW'];
const pirate = new Set(['Mortar Launcher', 'Bombs', 'Steam Cannon', 'Bouncy Cannonball', 'Overloaded Catapult']);
// The six weapon-purchase branches that increment the original glaive counter.
const glaives = new Set(['A00J', 'A0OD', 'A005', 'A0PF', 'A0LU', 'A0GE']);
const extraSpikeSources = new Set(['A0DU', 'A0QD', 'A0FO']);
export const survivorChallenge = 'A0DT';
const schools = ['Normal', 'Piercing', 'Magic', 'Siege', 'Chaos', 'Spikes', 'Poison', 'Frost', 'Fire'];
const attackTypes = ['Single Target', 'Splash', 'Wave', 'Area', 'Bounce'];

const effects = item => item.effects.join('\n');
const grantsBounty = item => /Kill Bounty|Bounty Gold/.test(effects(item));
const grantsIncome = item => /Gold per second|Gold Income/.test(effects(item));
const grantsGold = item => grantsBounty(item) || grantsIncome(item) || /\+\d+ Gold\b|gold contained|grants gold/i.test(effects(item));
const isSpikes = item => item.kind === 'upgrade' && (extraSpikeSources.has(item.id) || /^\+\d+ Spikes Damage/m.test(effects(item)));
const doesDamage = item => item.kind === 'weapon' || isSpikes(item);

function damageSchool(item, school) {
  if (item.kind === 'weapon') return item.damageTypes.includes(school);
  if (school === 'Spikes') return isSpikes(item);
  if (school === 'Fire') return item.name === 'Molten Spikes';
  if (school === 'Poison') return item.name === 'Poisonous Spikes';
  return false;
}

function matchesChallenge(challenge, arena) {
  const items = arena.purchaseLog.map(entry => entry.item);
  const damage = items.filter(doesDamage);
  const weapons = damage.filter(item => item.kind === 'weapon');
  const name = challenge.name;
  const restriction = challenge.restrictions;
  if (name === "Survivor's") return arena.lastStand && arena.bossDefeated;
  if (restriction === 'None') return true;
  if (name === 'Pirate Ship') return damage.every(item => item.kind === 'weapon' && pirate.has(item.name));
  if (name === 'No Income') return !items.some(item => grantsBounty(item) || grantsIncome(item));
  if (name === 'Only Income') return !items.some(grantsBounty);
  if (name === 'Only Bounty') return !items.some(grantsIncome);
  if (name === 'No Healing') return arena.tower.repairAt === 0 && !items.some(item => /Heal|HP Regen|Mana Shield/i.test(effects(item)));
  if (name === 'No Health') return !items.some(item => /Max HP/.test(effects(item)));
  if (name === 'Healing') return damage.length > 0 && damage.every(item => /heal|Max HP|HP Regen/i.test(effects(item)));
  if (name === 'Glaive') return damage.every(item => item.kind === 'weapon' && glaives.has(item.id));
  if (name === 'Alphabet') return damage.length > 0 && groups.some(group => damage.every(item => group.includes(item.name[0].toUpperCase())));
  if (name === 'Barebones') return !items.some(item => item.kind === 'upgrade');
  if (name === 'Magic Coins Only') return !items.some(item => item.kind === 'upgrade' && item.name !== 'Magic Coin' && grantsGold(item));
  if (name === 'Magic Treasure') {
    const treasures = arena.purchaseLog.filter(entry => entry.item.name === 'Magic Treasure');
    return treasures.length === 1 && treasures[0].wave === 1 && Boolean(arena.tower.treasure);
  }
  if (name === 'Mana Shield Unbroken') {
    return arena.purchaseLog.some(entry => entry.wave === 1 && /^\+\d+ Mana Shield$/m.test(effects(entry.item)))
      && !arena.tower.effects.has('shieldBroken') && arena.tower.shield > 0;
  }
  if (name === 'Income-Capped Damage') return !arena.exceededIncomeScore;
  if (name === 'Scaling') {
    return damage.length > 0
      && damage.every(item => /per enemy hit|Damage per .* (HP|Armor|Mana Shield|HP Regen)|when attacked/.test(effects(item)))
      && items.filter(item => !doesDamage(item)).every(item => /every (?:30 )?seconds?|sacrific|^-.*(?:Max HP|HP Regen)/m.test(effects(item)) || ['Black Market', 'Duplicator'].includes(item.name));
  }
  if (name === 'Single Weapon') return weapons.length === damage.length && arena.tower.weapons.size <= 1;
  if (name === 'One of Each') return weapons.length === damage.length && [...arena.tower.weapons.values()].every(weapon => weapon.copies <= 1);
  if (name === 'Stun') return damage.length > 0 && damage.every(item => item.kind === 'weapon' && /Stun \(/.test(effects(item)));
  const rarity = /^(Common|Uncommon|Rare)\b/.exec(name)?.[1]?.toLowerCase();
  if (rarity) return damage.every(item => item.kind === 'weapon' && item.rarity === rarity);
  const range = Number(/^(\d+) Range/.exec(name)?.[1]);
  if (range) return damage.length > 0 && damage.every(item => item.kind === 'weapon' && item.range === range && (range !== 900 || item.rarity !== 'common'));
  const attackType = attackTypes.find(type => name === type);
  if (attackType) return damage.length > 0 && damage.every(item => {
    if (item.kind !== 'weapon') return false;
    if (attackType === 'Bounce') return /Bounce|Barrage/.test(item.attackType);
    return item.attackType.includes(attackType) && (attackType !== 'Single Target' || item.rarity !== 'common');
  });
  const school = schools.find(type => name === type || name.startsWith(type + ','));
  return Boolean(school) && damage.length > 0 && damage.every(item => damageSchool(item, school));
}

export function rememberPurchase(arena, item, wave) {
  arena.purchaseLog.push({ item, wave });
  if (grantsIncome(item) || grantsBounty(item)) arena.spentIncome += item.gold;
  else if (doesDamage(item) || /Damage|Attack Speed/.test(effects(item))) arena.spentDamage += item.gold;
  if (arena.spentDamage > arena.spentIncome) arena.exceededIncomeScore = true;
}

export function checkChallenges(arena, challenges) {
  for (const challenge of challenges) {
    if (arena.challengeUnlocks.has(challenge.id)) continue;
    if (!matchesChallenge(challenge, arena)) continue;
    arena.challengeUnlocks.add(challenge.id);
    arena.emit({ kind: 'challenge', id: challenge.id, name: challenge.name, points: challenge.points ?? 0 });
  }
}

export function challengeScore(profile, catalog) {
  return catalog.reduce((total, challenge) => total + (profile.unlocks.includes(challenge.id) ? challenge.points ?? 0 : 0), 0);
}

export function recordChallengeCompletions(profile, recorded, ids, catalog) {
  let changed = false;
  const unlocked = [];
  for (const id of ids) {
    if (recorded.has(id)) continue;
    recorded.add(id);
    changed = true;
    profile.challengeCounts[id] = Math.min(999, (profile.challengeCounts[id] ?? 0) + 1);
    if (!profile.unlocks.includes(id)) {
      profile.unlocks.push(id);
      unlocked.push(id);
    }
  }
  if (changed && !profile.unlocks.includes('A0JW') && challengeScore(profile, catalog) >= 7500) {
    profile.unlocks.push('A0JW');
    unlocked.push('A0JW');
  }
  return { changed, unlocked };
}
