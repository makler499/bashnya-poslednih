import { Vector3 } from 'three';
import { teslaFlight } from './combat.mjs';

const colorHex = color => '#' + color.toString(16).padStart(6, '0');
const shotColor = event => event.slot === 133 ? '#fa535d'
  : event.slot === 100 ? '#b9d7ff' : event.slot === 43 ? '#93dcff' : event.type === 'Magic' ? '#73aaff' : colorHex(event.color ?? 0xf2b374);

export function createCombatArt(canvas) {
  const ctx = canvas.getContext('2d');
  const routes = [];
  const impacts = [];
  const point = new Vector3();
  let recovery = null;
  let width = 0;
  let height = 0;

  function add(event, native = false) {
    if (event.kind === 'shot' || event.kind === 'beam') {
      if (routes.length >= 96) routes.shift();
      routes.push({ event, native, color: shotColor(event), age: 0 });
      return;
    }
    if (event.kind === 'impact') {
      if (impacts.length >= 48) impacts.shift();
      impacts.push({ event, age: 0, color: colorHex(event.color ?? 0xf2b374) });
    } else if (event.kind === 'heal' && event.amount >= 1) {
      recovery = { event, age: 0 };
    }
  }

  function drawRoute(route, time, dt, attackPoint, project, projectileFlight) {
    const { event, color } = route;
    const tesla = route.native && event.kind === 'beam' && event.slot === 133;
    const isBeam = event.kind === 'beam' && !tesla;
    route.age += dt;
    const flight = projectileFlight(event);
    const estimatedProgress = (time - event.at) / (tesla ? teslaFlight(event) : event.duration);
    if (!flight && time - event.at > event.duration + 3) return false;
    const progress = flight?.progress ?? (event.projectileId == null ? estimatedProgress : Math.min(0.999, estimatedProgress));
    if (progress >= 1) return false;
    if (progress < 0) return true;
    const tip = isBeam ? 1 : Math.max(0.015, progress);
    const tail = isBeam ? 0 : Math.max(0, tip - 0.31);
    ctx.beginPath();
    let tipX = 0;
    let tipY = 0;
    for (let step = 0; step <= 7; step += 1) {
      project(attackPoint(event, tail + (tip - tail) * step / 7, point));
      const jagged = isBeam && step > 0 && step < 7 && event.slot !== 43;
      tipX = point.x;
      tipY = point.y + (jagged ? Math.sin(event.seq * 0.37 + step * 6.8 + route.age * 65) * 3.8 : 0);
      if (step) ctx.lineTo(tipX, tipY);
      else ctx.moveTo(tipX, tipY);
    }
    const alpha = isBeam ? 1 - progress : 0.82;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = isBeam ? 7 : 3.5;
    ctx.globalAlpha = alpha * 0.25;
    ctx.stroke();
    ctx.lineWidth = isBeam ? 3 : 1.45;
    ctx.globalAlpha = alpha * 0.77;
    ctx.stroke();
    ctx.strokeStyle = '#fff5dd';
    ctx.lineWidth = isBeam ? 1.25 : 0.6;
    ctx.globalAlpha = alpha * 0.72;
    ctx.stroke();
    if (!route.native) {
      ctx.beginPath();
      ctx.arc(tipX, tipY, isBeam ? 3.2 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff3d3';
      ctx.globalAlpha = alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return true;
  }

  function drawImpacts(dt, locate, project) {
    for (let index = impacts.length - 1; index >= 0; index -= 1) {
      const entry = impacts[index];
      entry.age += dt;
      const progress = entry.age / 0.2;
      if (progress >= 1) {
        impacts.splice(index, 1);
        continue;
      }
      const { event, color } = entry;
      project(locate(event.x, event.y, event.tower ? 1.45 : 0.68, point));
      const size = (event.tower ? 13 : 8) + progress * 4;
      const rise = (event.seq % 2 ? 1 : -1) * size * 0.56;
      ctx.beginPath();
      ctx.moveTo(point.x - size, point.y + rise);
      ctx.lineTo(point.x + size, point.y - rise);
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.lineWidth = 5;
      ctx.globalAlpha = (1 - progress) * 0.35;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1 - progress;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawRecovery(dt, locate, project) {
    if (!recovery) return;
    recovery.age += dt;
    const progress = recovery.age / 0.66;
    if (progress >= 1) {
      recovery = null;
      return;
    }
    project(locate(recovery.event.x, recovery.event.y, 3.2, point));
    const label = '+' + Math.round(recovery.event.amount);
    const y = point.y - 10 - progress * 22;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#11150e';
    ctx.fillStyle = '#a9f58a';
    ctx.globalAlpha = Math.min(1, (1 - progress) * 3.3);
    ctx.strokeText(label, point.x, y);
    ctx.fillText(label, point.x, y);
    ctx.globalAlpha = 1;
  }

  function drawHealth(health, length, thickness) {
    if (point.x < 0 || point.x > width || point.y < 0 || point.y > height) return;
    const x = Math.round(point.x - length / 2);
    const y = Math.round(point.y);
    ctx.fillStyle = '#080b07';
    ctx.fillRect(x, y, length, thickness);
    ctx.fillStyle = health > 0.5 ? '#55bd2d' : health > 0.25 ? '#e0b348' : '#e0684b';
    ctx.fillRect(x + 1, y + 1, Math.max(1, (length - 2) * Math.min(1, health)), thickness - 2);
  }

  return {
    add,
    reset() {
      routes.length = impacts.length = 0;
      recovery = null;
    },
    render(frame, time, dt, camera, size, locate, attackPoint, positionOf, projectileFlight) {
      if (canvas.width !== size.width || canvas.height !== size.height) {
        canvas.width = size.width;
        canvas.height = size.height;
      }
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (!width || !height) return;
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const project = world => {
        world.project(camera);
        world.set((world.x + 1) * width / 2, (1 - world.y) * height / 2, world.z);
      };
      const { arena } = frame;
      if (arena.alive && arena.health > 0) {
        project(locate(0, 0, 3.2, point));
        drawHealth(arena.health / arena.maxHealth, 55, 6);
      }
      let bars = 0;
      for (const enemy of arena.enemies) {
        if (enemy.hp >= enemy.maxHp || enemy.hp <= 0 || bars >= 90) continue;
        const location = positionOf(enemy);
        project(locate(location.x, location.y, enemy.family === 'Samwise' ? 2.1 : 1.14, point));
        drawHealth(enemy.hp / enemy.maxHp, enemy.family === 'Samwise' ? 32 : 19, 4);
        bars += 1;
      }
      for (let index = routes.length - 1; index >= 0; index -= 1) {
        if (!drawRoute(routes[index], time, dt, attackPoint, project, projectileFlight)) routes.splice(index, 1);
      }
      drawImpacts(dt, locate, project);
      drawRecovery(dt, locate, project);
    },
  };
}
