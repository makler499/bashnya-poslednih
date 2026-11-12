const packSizes = [2, 2, 3, 4];
const speedByTimerScale = new Map([[1, 1], [0.66, 1.5], [0.5, 2], [0.33, 3]]);

const firstRoundMultipliers = Object.freeze({ health: 1, damage: 1, speed: 1 });

// One timer event chooses the same angle, family and pack size for every seat.
export function createSpawnPlanner(map, random = Math.random) {
  const archetypes = new Map(map.enemies.map(enemy => [`${enemy.family}:${enemy.variant}`, enemy]));
  const spawnRadius = map.initialRules.spawnRadius;

  return function planSpawns(seats, timerScale = 1) {
    const movementScale = speedByTimerScale.get(timerScale);
    if (!movementScale) throw new RangeError(`Unknown timer scale ${timerScale}`);
    const angle = random() * 2 * Math.PI;
    const roll = Math.floor(random() * 25);
    const family = roll < 10 ? 'Bandit' : roll < 15 ? 'Brigand' : roll < 20 ? 'BanditRider' : 'Catapult';
    const count = packSizes[Math.floor(random() * 15)] ?? 1;
    const offsetX = Math.cos(angle) * spawnRadius;
    const offsetY = Math.sin(angle) * spawnRadius;

    return seats.map(({ arena, variant = 0, multipliers = firstRoundMultipliers }) => {
      const enemy = archetypes.get(`${family}:${variant}`);
      if (!enemy) throw new RangeError(`Unknown ${family} variant ${variant}`);
      const finalForm = enemy.id === 'h00G';
      const scaleStats = multipliers.health > 1;
      return {
        seat: arena.seat,
        unitId: enemy.id,
        count: finalForm ? 1 : count,
        x: arena.x + offsetX,
        y: arena.y + offsetY,
        facing: (angle * 180 / Math.PI + 180) % 360,
        health: scaleStats && enemy.maxHealth != null
          ? Math.trunc(enemy.maxHealth * multipliers.health + 1) : enemy.maxHealth,
        speed: enemy.movementSpeed == null ? null : enemy.movementSpeed * multipliers.speed * movementScale,
        damageBase: scaleStats && !finalForm && enemy.damageBase != null
          ? Math.trunc(enemy.damageBase * multipliers.damage + 1) : enemy.damageBase,
        attackCooldown: enemy.attackCooldown == null ? null : enemy.attackCooldown * timerScale,
        lifetime: finalForm ? 18 * timerScale : null,
      };
    });
  };
}
