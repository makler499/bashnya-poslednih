import { Vector3 } from 'three';
import ViewerModule from 'mdx-m3-viewer/dist/cjs/viewer/viewer.js';
import BlpModule from 'mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler.js';
import DdsModule from 'mdx-m3-viewer/dist/cjs/viewer/handlers/dds/handler.js';
import TgaModule from 'mdx-m3-viewer/dist/cjs/viewer/handlers/tga/handler.js';
import MdxModule from 'mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler.js';
import { flamecasterOffsets, teslaFlight } from './combat.mjs';
import audioTracks from './warcraft-audio-tracks.json';

const unpack = module => module.default ?? module;
const normalized = path => path.replaceAll('\\', '/').toLowerCase().replace(/\.mdl$/, '.mdx');
const normalTint = [1, 1, 1, 1];
const frostTint = [0.52, 0.78, 1, 1];
const poisonTint = [0.72, 1, 0.58, 1];
const hitTint = [1, 0.74, 0.62, 1];
const rotation = degrees => {
  const angle = degrees * Math.PI / 360;
  return [0, 0, Math.sin(angle), Math.cos(angle)];
};

const spellModels = {
  19: 'absorbmanabirthmissile2.mdx',
  30: 'holyboltspecialart.mdx',
  40: 'firetrapupbirth.mdx',
  44: 'plaguecloudcastermoreclouds.mdx',
  43: 'icebeam.mdx',
  109: 'immolationpulse.mdx',
  114: 'crippletargetgreen.mdx',
  122: 'absorbmanabirthmissile2.mdx',
  134: 'endemicfieldarea.mdx',
  129: 'skeletalmagemissile.mdx',
  200: 'infernal_ts.mdx',
  201: 'impalemisstargetbigger.mdx',
  204: 'goblinlandmine.mdx',
  207: 'blizzardtargetperformance.mdx',
  211: 'glaivemissileupg3.mdx',
  212: 'monsoonrain.mdx',
};

function sequence(model, name) {
  const exact = model.sequences.findIndex(animation => animation.name.toLowerCase() === name);
  if (exact >= 0) return exact;
  const prefix = model.sequences.findIndex(animation => animation.name.toLowerCase().startsWith(name + ' '));
  return prefix >= 0 ? prefix : -1;
}

function sequenceSeconds(model, name) {
  const interval = model.sequences[sequence(model, name)]?.interval;
  return interval ? (interval[1] - interval[0]) / 1000 : 0;
}

export async function loadOriginalArt() {
  const base = new URL('./map-art/', document.baseURI);
  const response = await fetch(new URL('manifest.json', base));
  if (!response.ok) return null;
  const data = await response.json();
  const available = new Set(data.files);
  const pathsByName = new Map(data.files.map(path => [path.split('/').at(-1), path]));
  const pathFor = path => {
    const clean = normalized(path);
    if (available.has(clean)) return clean;
    return pathsByName.get(clean.split('/').at(-1));
  };
  const url = path => new URL(path.split('/').map(encodeURIComponent).join('/'), base).href;
  return { data, pathFor, url };
}

export function createOriginalLayer(canvas, original, playSound = () => {}) {
  const ModelViewer = unpack(ViewerModule);
  const viewer = new ModelViewer(canvas, { alpha: true, antialias: true, premultipliedAlpha: true });
  const pathSolver = path => {
    if (typeof path !== 'string') return path;
    const file = original.pathFor(path);
    if (file) return original.url(file);
    return null;
  };
  viewer.on('error', () => {});
  viewer.addHandler(unpack(BlpModule));
  viewer.addHandler(unpack(DdsModule));
  viewer.addHandler(unpack(TgaModule));
  viewer.addHandler(unpack(MdxModule), pathSolver);
  const scene = viewer.addScene();
  scene.alpha = true;
  const { gl } = viewer;
  const blend = gl.blendFunc.bind(gl);
  // This canvas sits above the terrain. Additive effects must add light without
  // making the dark, rectangular borders of their textures opaque.
  gl.blendFunc = (source, destination) => {
    if (source === gl.SRC_ALPHA && destination === gl.ONE) {
      gl.blendFuncSeparate(source, destination, gl.ZERO, gl.ONE);
    } else if (source === gl.SRC_ALPHA && destination === gl.ONE_MINUS_SRC_ALPHA) {
      gl.blendFuncSeparate(source, destination, gl.ONE, destination);
    } else {
      blend(source, destination);
    }
  };
  const modelCache = new Map();
  const enemies = new Map();
  const dying = [];
  const effects = [];
  const parasites = new Map();
  const soundingActors = new Set();
  const missilePoint = new Vector3();
  let tower;
  let towerPath;
  const flames = [];
  const glaives = [];
  const flamePath = original.pathFor('war3mapimported/flamethrower_ts.mdx');

  function extendTeamTextures(textures, folder, replaceableId) {
    const Texture = textures[0]?.constructor;
    if (!Texture) return;
    for (let color = textures.length; color < 20; color += 1) {
      const file = original.pathFor(`replaceabletextures/${folder}/${folder}${color}.blp`);
      if (!file) {
        textures[color] = textures[color - 4];
        continue;
      }
      const entry = new Texture(replaceableId, 3);
      textures[color] = entry;
      void viewer.load(file, pathSolver).then(texture => { entry.texture = texture; }).catch(() => {});
    }
  }

  function getModel(path, color) {
    if (!path) return undefined;
    let entry = modelCache.get(path);
    if (!entry) {
      entry = {};
      modelCache.set(path, entry);
      void viewer.load(path, pathSolver).then(model => {
        if (!model?.addInstance) return;
        const parts = new Set([model]);
        for (const part of parts) {
          for (const attachment of part.attachments) {
            if (attachment.internalModel) parts.add(attachment.internalModel);
          }
        }
        const components = [...parts];
        if (!components.some(part => part.batches.length || part.particleEmitters.length
          || part.particleEmitters2.length || part.ribbonEmitters.length)) return;
        const textures = components.flatMap(part => part.textures);
        entry.textures = textures.filter(texture => texture.replaceableId !== 1 && texture.replaceableId !== 2);
        entry.needsTeamColor = textures.some(texture => texture.replaceableId === 1)
          || components.some(part => part.particleEmitters2.some(emitter => emitter.teamColored && emitter.replaceableId === 1));
        entry.needsTeamGlow = textures.some(texture => texture.replaceableId === 2)
          || components.some(part => part.particleEmitters2.some(emitter => emitter.teamColored && emitter.replaceableId === 2));
        entry.model = model;
      }).catch(() => {});
    }
    if (!entry.model || entry.textures.some(texture => !texture.texture?.webglResource)) return undefined;
    const { teamColors, teamGlows } = viewer.sharedCache.get('mdx');
    if (color >= 16) {
      extendTeamTextures(teamColors, 'teamcolor', 1);
      extendTeamTextures(teamGlows, 'teamglow', 2);
    }
    if (entry.needsTeamColor && !teamColors[color]?.texture?.webglResource) return undefined;
    if (entry.needsTeamGlow && !teamGlows[color]?.texture?.webglResource) return undefined;
    return entry.model;
  }

  function create(model, animation, color, scale = 1) {
    const instance = model.addInstance();
    instance.setTeamColor(color);
    instance.setUniformScale(scale);
    const selected = sequence(model, animation);
    instance.setSequence(selected >= 0 ? selected : 0);
    instance.setScene(scene);
    const actor = { model, instance, animation };
    actor.attachment = model.attachments.findIndex(attachment => /^chest(?:\s|$)/i.test(attachment.name));
    const tracks = model.eventObjects.filter(event => event.type === 'SND' && audioTracks.tracks[event.id.trim().toUpperCase()]);
    if (tracks.length) {
      actor.soundTracks = tracks;
      soundingActors.add(actor);
    }
    return actor;
  }

  function destroy(actor) {
    soundingActors.delete(actor);
    scene.removeInstance(actor.instance);
  }

  function animation(actor, name) {
    if (actor.animation === name) return;
    const selected = sequence(actor.model, name);
    if (selected < 0) return;
    actor.instance.setSequence(selected);
    actor.animation = name;
    actor.lastSoundFrame = undefined;
  }

  function syncActorAnimation(actor, name, rate, gameTime, attackAt) {
    const attacking = name === 'attack';
    if (attacking && actor.attackAt !== attackAt) {
      actor.animation = '';
      actor.attackAt = attackAt;
    }
    const changed = actor.animation !== name;
    animation(actor, name);
    actor.instance.setSequenceLoopMode(name === 'stand' || name === 'walk' ? 2 : 0);
    actor.instance.timeScale = rate;
    if (changed && attacking) {
      actor.instance.frame += Math.min(sequenceSeconds(actor.model, name), Math.max(0, gameTime - attackAt) * rate) * 1000;
    }
  }

  function playAnimationSounds() {
    for (const actor of soundingActors) {
      if (actor.shot || actor.audioByEvent) continue;
      const { instance, model, lastSoundFrame } = actor;
      const sequence = model.sequences[instance.sequence];
      if (!sequence) continue;
      const [start, end] = sequence.interval;
      const frame = instance.frame;
      const previous = lastSoundFrame ?? start - 1;
      actor.lastSoundFrame = frame;
      const previousCounter = actor.lastSoundCounter ?? -1;
      actor.lastSoundCounter = instance.counter;
      for (const track of actor.soundTracks) {
        const id = track.id.trim().toUpperCase();
        const period = track.globalSequence;
        const crossed = period > 0
          ? track.tracks.some(at => Math.floor((instance.counter - at) / period) > Math.floor((previousCounter - at) / period))
          : track.tracks.some(at => at >= start && at <= end
            && (frame >= previous ? previous < at && at <= frame : previous < at || at <= frame));
        if (crossed) playSound('#' + id);
      }
    }
  }

  function reset() {
    for (const actor of enemies.values()) destroy(actor);
    enemies.clear();
    for (const actor of dying.splice(0)) destroy(actor);
    for (const actor of effects.splice(0)) destroy(actor);
    for (const actor of flames.splice(0)) destroy(actor);
    for (const actor of glaives.splice(0)) destroy(actor);
    parasites.clear();
  }

  function syncFlame(arena, ground, interpolation) {
    const { flamecaster, layout } = arena;
    const count = flamecaster && arena.alive ? Math.min(flamecaster.copies ?? 1, flamecasterOffsets.length) : 0;
    while (flames.length > count) destroy(flames.pop());
    if (!count) return;
    if (flames.length < count) {
      const model = getModel(flamePath, layout.seat - 1);
      if (!model) return;
      const location = [layout.x, layout.y, ground(layout.x, layout.y) + 75];
      while (flames.length < count) {
        const actor = create(model, 'stand', layout.seat - 1);
        actor.instance.setSequenceLoopMode(2);
        actor.instance.setLocation(location);
        flames.push(actor);
      }
    }
    const angle = flamecaster.phase + flamecaster.rate * interpolation;
    for (const [index, actor] of flames.entries()) {
      actor.instance.setRotation(rotation((angle + flamecasterOffsets[index]) * 180 / Math.PI));
    }
  }

  function syncGlaives(arena, ground, interpolation) {
    const { glaive, layout } = arena;
    const count = Math.min(8, glaive?.copies ?? 0);
    while (glaives.length > count) destroy(glaives.pop());
    if (!count) return;
    if (glaives.length < count) {
      const model = getModel(original.pathFor(spellModels[211]), layout.seat - 1);
      if (!model) return;
      while (glaives.length < count) {
        const actor = create(model, 'stand', layout.seat - 1);
        actor.instance.timeScale = 1.5;
        actor.instance.setSequenceLoopMode(2);
        glaives.push(actor);
      }
    }
    for (const [index, actor] of glaives.entries()) {
      const angle = glaive.phase + glaive.rate * interpolation - index * Math.PI / 4;
      const x = layout.x + Math.cos(angle) * 300;
      const y = layout.y + Math.sin(angle) * 300;
      actor.instance.setLocation([x, y, ground(x, y) + 80]);
      actor.instance.setRotation(rotation((angle + Math.PI / 2) * 180 / Math.PI));
    }
  }

  function sync(frame, ground, positionOf = enemy => enemy, interpolation = 0) {
    const { arena } = frame;
    const { layout } = arena;
    const towerColor = layout.seat - 1;
    const enemyColor = 12 + towerColor;
    const requestedTower = arena.skin && original.data.towers[arena.skin] ? original.data.towers[arena.skin] : original.data.towers.standard;
    const towerUnit = original.data.towerUnits?.[arena.skin] ?? 'H00C';
    const towerProfile = original.data.actors?.[towerUnit];
    const towerModel = getModel(requestedTower, towerColor);
    if (towerPath !== requestedTower || Boolean(towerModel) !== Boolean(tower)) {
      if (tower) destroy(tower);
      tower = towerModel ? create(towerModel, 'stand', towerColor, towerProfile?.scale) : null;
      towerPath = requestedTower;
    }
    if (tower) {
      if (tower.seat !== layout.seat) {
        tower.instance.setTeamColor(towerColor);
        tower.instance.setLocation([layout.x, layout.y, ground(layout.x, layout.y) + (towerProfile?.height ?? 0)]);
        tower.instance.setRotation(rotation(layout.heading));
        tower.seat = layout.seat;
      }
      animation(tower, arena.alive ? 'stand' : 'death');
      tower.instance.setSequenceLoopMode(arena.alive ? 2 : 0);
    }
    syncFlame(arena, ground, interpolation);
    syncGlaives(arena, ground, interpolation);
    const visible = new Set();
    const represented = new Set();
    for (const enemy of arena.enemies) {
      visible.add(enemy.key);
      const profile = original.data.actors?.[enemy.id === 'samwise' ? 'n00C' : enemy.id];
      const model = getModel(original.data.models[enemy.id], enemyColor);
      if (!model) continue;
      represented.add(enemy.key);
      let actor = enemies.get(enemy.key);
      const time = frame.time + interpolation;
      const attacking = time < (enemy.attackEnd ?? enemy.attackAt + 0.42) && enemy.stun <= 0;
      const hitSequence = model.sequences.find(entry => /^(hit|stand hit|hurt)(?:\s|$)/i.test(entry.name));
      const hit = hitSequence && time - (enemy.hitAt ?? -10) < (hitSequence.interval[1] - hitSequence.interval[0]) / 1000;
      const state = attacking && sequence(model, 'attack') >= 0 ? 'attack'
        : hit ? hitSequence.name.toLowerCase() : enemy.walking && enemy.stun <= 0 ? 'walk' : 'stand';
      if (!actor) {
        actor = create(model, state, enemyColor, profile?.scale);
        enemies.set(enemy.key, actor);
      }
      const duration = sequenceSeconds(model, state);
      const rate = state === 'attack' ? duration / Math.max(0.025, (enemy.attackEnd ?? time + 0.42) - enemy.attackAt)
        : state === 'walk' ? Math.max(0.05, (enemy.speed ?? profile?.walkSpeed ?? 180) / (profile?.walkSpeed || 180)) : 1;
      syncActorAnimation(actor, state, rate, time, enemy.attackAt);
      const location = positionOf(enemy);
      const x = layout.x + location.x;
      const y = layout.y + location.y;
      if (actor.x !== x || actor.y !== y) {
        actor.instance.setLocation([x, y, ground(x, y) + (profile?.height ?? 0)]);
        actor.x = x;
        actor.y = y;
      }
      const heading = (enemy.facing ?? Math.atan2(-location.y, -location.x)) * 180 / Math.PI;
      if (actor.heading !== heading) {
        actor.instance.setRotation(rotation(heading));
        actor.heading = heading;
      }
      const flash = !hitSequence && time - (enemy.hitAt ?? -10) < 0.12;
      const tint = flash ? hitTint : enemy.frost ? frostTint : enemy.poison ? poisonTint : normalTint;
      if (actor.tint !== tint) {
        actor.instance.setVertexColor(tint);
        actor.tint = tint;
      }
    }
    for (const [key, actor] of enemies) {
      if (visible.has(key)) continue;
      destroy(actor);
      enemies.delete(key);
    }
    return { tower: Boolean(tower), represented };
  }

  function event(event, layout, ground) {
    if (event.kind === 'burst' && event.slot === 17) return flames.length > 0;
    if (event.kind === 'death') {
      const color = 11 + layout.seat;
      const model = getModel(original.data.models[event.unitId], color);
      if (!model || sequence(model, 'death') < 0) return false;
      const x = layout.x + event.x;
      const y = layout.y + event.y;
      const profile = original.data.actors?.[event.unitId === 'samwise' ? 'n00C' : event.unitId];
      const actor = create(model, 'death', color, profile?.scale);
      actor.instance.setSequenceLoopMode(0);
      actor.instance.setLocation([x, y, ground(x, y) + (profile?.height ?? 0)]);
      actor.instance.setRotation(rotation((event.facing ?? Math.atan2(-event.y, -event.x)) * 180 / Math.PI));
      actor.age = 0;
      actor.duration = sequenceSeconds(model, 'death') || 0.1;
      dying.push(actor);
      return true;
    }
    const missiles = original.data.missiles;
    const tesla = (event.kind === 'shot' || event.kind === 'beam') && event.slot === 133;
    const chain = event.kind === 'beam' && event.slot === 100;
    const stormStrike = event.kind === 'burst' && event.slot === 212;
    const infernal = event.kind === 'summon' && event.slot === 200;
    if (event.kind === 'parasite' && parasites.has(event.targetId)) {
      parasites.get(event.targetId).age = 0;
      return true;
    }
    if (event.kind === 'burst' && event.slot === 200) return effects.some(actor => actor.infernal);
    const modelPath = event.model ?? (event.kind === 'clear' ? original.data.clear
      : event.kind === 'parasite' ? 'war3mapimported/parasitetarget.mdx'
      : event.kind === 'summon' && event.unitId ? original.data.models[event.unitId]
      : chain ? 'war3mapimported/boltimpact.mdx'
      : stormStrike ? 'war3mapimported/monsoonbolttarget.mdx'
      : tesla || event.kind === 'shot' || event.kind === 'wave' ? missiles[event.slot] ?? spellModels[event.slot]
      : ['beam', 'field', 'burst', 'summon', 'mine'].includes(event.kind) ? spellModels[event.slot] : null);
    const model = getModel(modelPath && original.pathFor(modelPath), layout.seat - 1);
    if (!model) return false;
    const traveling = event.kind === 'shot' || tesla;
    const moving = traveling || event.kind === 'wave';
    const firebreath = event.kind === 'wave' && event.slot === 125;
    const monsoon = event.kind === 'field' && event.slot === 212;
    const pillar = event.kind === 'burst' && event.slot === 40;
    const loop = moving && !tesla && !firebreath;
    const profile = event.kind === 'summon' ? original.data.actors?.[event.unitId] : undefined;
    const animationName = loop || chain || stormStrike || event.kind === 'parasite' || sequence(model, 'birth') < 0 ? 'stand' : 'birth';
    const actor = create(model, animationName, layout.seat - 1, profile?.scale);
    if (event.kind === 'parasite') {
      actor.attachedTo = event.targetId;
      parasites.set(event.targetId, actor);
    }
    actor.audioByEvent = chain || pillar || firebreath || stormStrike;
    if (infernal) actor.infernal = true;
    actor.instance.setSequenceLoopMode(loop ? 2 : 1);
    actor.age = 0;
    actor.duration = tesla && event.kind === 'beam' ? teslaFlight(event)
      : chain || stormStrike || pillar ? sequenceSeconds(model, actor.animation)
      : event.duration ?? 0.55;
    if (event.kind === 'wave') actor.waveAt = event.at;
    const from = traveling ? event.from : chain ? event.to : event;
    const x = layout.x + (from.x ?? 0);
    const y = layout.y + (from.y ?? 0);
    actor.origin = [x, y, ground(x, y) + (moving ? 130 : chain ? 75 : profile?.height ?? 0)];
    actor.instance.setLocation(actor.origin);
    if (event.facing !== undefined) actor.instance.setRotation(rotation(event.facing * 180 / Math.PI));
    if (moving) {
      const tx = layout.x + (event.to?.x ?? event.x + event.dx * event.radius);
      const ty = layout.y + (event.to?.y ?? event.y + event.dy * event.radius);
      actor.destination = [tx, ty, ground(tx, ty) + 35];
      actor.arc = event.kind === 'wave' ? 0 : event.type === 'Siege' ? 180 : 30;
      actor.instance.setRotation(rotation(Math.atan2(ty - y, tx - x) * 180 / Math.PI));
    }
    if (traveling) actor.shot = event;
    if (chain) actor.chain = event;
    if (tesla || firebreath || monsoon || profile) actor.deathDuration = sequenceSeconds(model, 'death');
    if (tesla || monsoon || profile) actor.birthDuration = sequenceSeconds(model, 'birth');
    if (effects.length >= 180) {
      const oldest = effects.shift();
      if (oldest.attachedTo !== undefined) parasites.delete(oldest.attachedTo);
      destroy(oldest);
    }
    effects.push(actor);
    return true;
  }

  function advance(items, dt, time, attackPoint, projectileFlight) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const actor = items[index];
      if (actor.attachedTo !== undefined) {
        const parent = enemies.get(actor.attachedTo);
        if (!parent && actor.age > 0.2) actor.age = actor.duration;
        if (parent) {
          const anchor = parent.instance.getAttachment(parent.attachment);
          actor.instance.setLocation(anchor?.worldLocation ?? parent.instance.worldLocation);
        }
      }
      const start = actor.shot?.at ?? actor.waveAt;
      actor.age = start === undefined ? actor.age + dt : Math.max(0, time - start);
      const flight = actor.shot && projectileFlight(actor.shot);
      if (flight) actor.age = flight.progress * actor.duration + (flight.at === undefined ? 0 : Math.max(0, time - flight.at));
      if (actor.age >= actor.duration + (actor.deathDuration ?? 0)) {
        if (actor.attachedTo !== undefined) parasites.delete(actor.attachedTo);
        destroy(actor);
        items.splice(index, 1);
        continue;
      }
      const ratio = Math.min(1, actor.age / actor.duration);
      if ((actor.shot && actor.animation !== 'death') || actor.chain) {
        const point = attackPoint(actor.shot ?? actor.chain, actor.chain ? 1 : ratio, missilePoint);
        actor.instance.setLocation([point.x * 128, -point.z * 128, point.y * 128]);
      } else if (actor.destination && actor.animation !== 'death') {
        const point = actor.origin.map((value, coordinate) => value + ratio * (actor.destination[coordinate] - value));
        point[2] += Math.sin(ratio * Math.PI) * actor.arc;
        actor.instance.setLocation(point);
      }
      if (actor.deathDuration && ratio === 1 && actor.animation !== 'death') {
        animation(actor, 'death');
        actor.instance.setSequenceLoopMode(1);
      } else if (actor.birthDuration && actor.age >= actor.birthDuration && actor.animation === 'birth') {
        animation(actor, 'stand');
        actor.instance.setSequenceLoopMode(2);
      }
    }
  }

  for (const path of [flamePath, original.data.missiles[133] && original.pathFor(original.data.missiles[133]),
    original.pathFor('war3mapimported/boltimpact.mdx'), original.pathFor(spellModels[40]),
    original.pathFor('war3mapimported/parasitetarget.mdx'), original.data.models.u005, original.data.models.n004]) getModel(path, 0);

  return {
    reset, sync, event,
    render(camera, target, canvasWidth, canvasHeight, dt, time, attackPoint, speed = 1, projectileFlight = () => null) {
      if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
      }
      scene.viewport[2] = canvas.width;
      scene.viewport[3] = canvas.height;
      const convert = point => [point.x * 128, -point.z * 128, point.y * 128];
      if (camera.isPerspectiveCamera) {
        scene.camera.perspective(camera.fov * Math.PI / 180, camera.aspect, camera.near * 128, camera.far * 128);
      } else {
        scene.camera.ortho(camera.left * 128, camera.right * 128, camera.bottom * 128, camera.top * 128, camera.near * 128, camera.far * 128);
      }
      scene.camera.moveToAndFace(convert(camera.position), convert(target), [0, 0, 1]);
      const animationStep = Math.min(0.12, dt * speed);
      advance(effects, animationStep, time, attackPoint, projectileFlight);
      advance(dying, animationStep);
      viewer.update(animationStep * 1000);
      if (animationStep > 0) playAnimationSounds();
      gl.scissor(0, 0, canvas.width, canvas.height);
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      viewer.render();
    },
  };
}
