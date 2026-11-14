import * as THREE from 'three';
import { seededRandom } from './match.mjs';
import { createOriginalLayer } from './original-art.mjs';
import { createCombatArt } from './combat-art.mjs';

const tile = 128;
const maxEnemies = 1600;
const terrainPalette = [0x766044, 0x8f764e, 0x6b6942, 0x827359, 0x7d7668, 0x515b34, 0x667147, 0x9b9275];
const pose = new THREE.Object3D();
const hue = new THREE.Color();

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...options });
}

function mesh(geometry, finish, x, y, z, scaleX = 1, scaleY = 1, scaleZ = 1) {
  const object = new THREE.Mesh(geometry, finish);
  object.position.set(x, y, z);
  object.scale.set(scaleX, scaleY, scaleZ);
  return object;
}

function canvasTexture(size, painter) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  painter(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function groundTexture() {
  const random = seededRandom(192);
  const texture = canvasTexture(128, (ctx, size) => {
    ctx.fillStyle = '#acacac';
    ctx.fillRect(0, 0, size, size);
    for (let index = 0; index < 5700; index += 1) {
      const gray = Math.floor(80 + random() * 155);
      const x = random() * size;
      const y = random() * size;
      ctx.fillStyle = 'rgba(' + gray + ',' + gray + ',' + gray + ',.43)';
      ctx.fillRect(x, y, 1 + random() * 4, 1 + random() * 2);
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function glowTexture() {
  return canvasTexture(64, (ctx, size) => {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.25, 'rgba(255,255,255,.7)');
    gradient.addColorStop(0.62, 'rgba(255,255,255,.19)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  });
}

function groundHeight(corner) {
  const raw = corner[0] & 0x3fff;
  const level = corner[5] & 0xf;
  return (raw - 0x2000 + (level - 2) * 0x200) / (4 * tile);
}

export function terrainElevation(terrain, x, y) {
  const [west, south] = terrain.origin;
  const column = THREE.MathUtils.clamp((x - west) / terrain.tileSize, 0, terrain.width - 1);
  const row = THREE.MathUtils.clamp((y - south) / terrain.tileSize, 0, terrain.height - 1);
  const left = Math.min(terrain.width - 2, Math.floor(column));
  const bottom = Math.min(terrain.height - 2, Math.floor(row));
  const index = bottom * terrain.width + left;
  const across = column - left;
  const up = row - bottom;
  const southeast = groundHeight(terrain.corners[index + 1]);
  const northwest = groundHeight(terrain.corners[index + terrain.width]);
  if (across + up <= 1) {
    const southwest = groundHeight(terrain.corners[index]);
    return southwest + across * (southeast - southwest) + up * (northwest - southwest);
  }
  const northeast = groundHeight(terrain.corners[index + terrain.width + 1]);
  return northeast + (1 - up) * (southeast - northeast) + (1 - across) * (northwest - northeast);
}

function terrainGeometry(terrain) {
  const { width, height, origin, corners } = terrain;
  const coords = new Float32Array(corners.length * 3);
  const colors = new Float32Array(coords.length);
  const uv = new Float32Array(corners.length * 2);
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  const random = seededRandom(433);
  let point = 0;
  let cursor = 0;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1, point += 1) {
      const corner = corners[point];
      const x = origin[0] / tile + col;
      const z = -origin[1] / tile - row;
      coords.set([x, groundHeight(corner), z], point * 3);
      const groundType = corner[2] & 0xf;
      hue.setHex(terrainPalette[groundType] ?? 0x596344).multiplyScalar(0.83 + random() * 0.31);
      colors.set([hue.r, hue.g, hue.b], point * 3);
      uv.set([col * 0.69, row * 0.69], point * 2);
      if (row === height - 1 || col === width - 1) continue;
      indices.set([point, point + 1, point + width, point + 1, point + width + 1, point + width], cursor);
      cursor += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(coords, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

async function originalTerrainMaterial(original, terrain) {
  if (!original?.data.terrain.some(Boolean)) return null;
  const images = await Promise.all(original.data.terrain.map(async path => {
    if (!path) return null;
    const image = new Image();
    image.src = original.url(path);
    try { await image.decode(); return image; } catch { return null; }
  }));
  const columns = terrain.width - 1;
  const rows = terrain.height - 1;
  const pixels = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = pixels;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tileLayers = new Map();
  const layersByTile = new Uint8Array(columns * rows * 4);
  const layersPixels = [];
  function layerIndex(type, cell) {
    const key = type * 32 + cell;
    if (tileLayers.has(key)) return tileLayers.get(key);
    ctx.clearRect(0, 0, pixels, pixels);
    const image = images[type];
    if (image) {
      const dimension = Math.min(image.width, image.height) / 4;
      const column = cell % 4 + (cell >= 16 ? 4 : 0);
      const row = Math.floor((cell % 16) / 4);
      ctx.drawImage(image, column * dimension, row * dimension, dimension, dimension, 0, 0, pixels, pixels);
    } else {
      ctx.fillStyle = '#' + (terrainPalette[type] ?? 0x596344).toString(16);
      ctx.fillRect(0, 0, pixels, pixels);
    }
    const index = layersPixels.push(ctx.getImageData(0, 0, pixels, pixels).data);
    tileLayers.set(key, index);
    return index;
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const bottomLeft = row * terrain.width + col;
      const corners = [bottomLeft, bottomLeft + 1, bottomLeft + terrain.width, bottomLeft + terrain.width + 1]
        .map(index => terrain.corners[index]);
      const types = corners.map(corner => corner[2] & 0xf);
      const layers = [...new Set(types)].sort((a, b) => a - b);
      for (let layer = 0; layer < layers.length; layer += 1) {
        const type = layers[layer];
        const image = images[type];
        const extended = image && image.width > image.height;
        const variation = corners[0][4] & 0x1f;
        const baseCell = extended && variation < 16 ? 16 + variation
          : extended ? (variation === 16 ? 15 : 0) : (variation ? 15 : 0);
        const mask = (types[1] === type ? 1 : 0) | (types[0] === type ? 2 : 0)
          | (types[3] === type ? 4 : 0) | (types[2] === type ? 8 : 0);
        layersByTile[(row * columns + col) * 4 + layer] = layerIndex(type, layer === 0 ? baseCell : mask);
      }
    }
  }
  const stride = pixels * pixels * 4;
  const data = new Uint8Array(stride * layersPixels.length);
  layersPixels.forEach((layer, index) => data.set(layer, index * stride));
  const tiles = new THREE.DataArrayTexture(data, pixels, pixels, layersPixels.length);
  tiles.colorSpace = THREE.SRGBColorSpace;
  tiles.magFilter = THREE.LinearFilter;
  tiles.minFilter = THREE.LinearMipmapLinearFilter;
  tiles.generateMipmaps = true;
  tiles.anisotropy = 8;
  tiles.needsUpdate = true;
  const indices = new THREE.DataTexture(layersByTile, columns, rows, THREE.RGBAFormat);
  indices.needsUpdate = true;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tiles: { value: tiles }, indices: { value: indices }, size: { value: new THREE.Vector2(columns, rows) } },
    vertexShader: `
      varying vec2 groundUV;
      void main() {
        groundUV = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform highp sampler2DArray tiles;
      uniform sampler2D indices;
      uniform vec2 size;
      varying vec2 groundUV;
      out vec4 outColor;
      #define gl_FragColor outColor
      void main() {
        vec2 grid = min(groundUV * size, size - 0.0001);
        vec4 layers = texelFetch(indices, ivec2(floor(grid)), 0) * 255.0;
        vec2 texel = vec2(grid.x, -grid.y);
        vec2 localUV = vec2(fract(grid.x), 1.0 - fract(grid.y));
        vec2 dx = dFdx(texel);
        vec2 dy = dFdy(texel);
        vec3 color = textureGrad(tiles, vec3(localUV, round(layers.x) - 1.0), dx, dy).rgb;
        for (int index = 1; index < 4; index++) {
          if (layers[index] < 0.5) break;
          vec4 layer = textureGrad(tiles, vec3(localUV, round(layers[index]) - 1.0), dx, dy);
          color = mix(color, layer.rgb, layer.a);
        }
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
    toneMapped: false,
  });
}

function makeOriginalWater(original, terrain) {
  const atlas = original?.data.water;
  if (!atlas?.count) return null;
  const texture = new THREE.TextureLoader().load(original.url(atlas.file));
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  const worldWidth = terrain.width - 1;
  const worldHeight = terrain.height - 1;
  const margin = 112;
  const [west, south] = terrain.origin;
  const rawLevel = terrain.corners[Math.floor(terrain.corners.length / 2)][1] & 0x3fff;
  const level = (rawLevel - 0x2000) / (4 * tile) + (terrain.waterOffset ?? -0.7);
  const depths = new Uint8Array(terrain.corners.length * 2);
  terrain.corners.forEach((corner, index) => {
    depths[index * 2] = Math.round(255 * THREE.MathUtils.clamp(level - groundHeight(corner), 0, 1));
    depths[index * 2 + 1] = corner[3] & 1 ? 255 : 0;
  });
  const shore = new THREE.DataTexture(depths, terrain.width, terrain.height, THREE.RGFormat);
  shore.magFilter = shore.minFilter = THREE.LinearFilter;
  shore.needsUpdate = true;
  const sheet = new THREE.ShaderMaterial({
    uniforms: {
      sheet: { value: texture },
      shore: { value: shore },
      frame: { value: 0 },
      frameCount: { value: atlas.count },
      grid: { value: new THREE.Vector2(atlas.columns, atlas.rows) },
      terrainSize: { value: new THREE.Vector2(terrain.width, terrain.height) },
      margin: { value: margin },
    },
    vertexShader: [
      'varying vec2 waterUV;',
      'void main() {',
      'waterUV = uv;',
      'gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D sheet;',
      'uniform sampler2D shore;',
      'uniform float frame;',
      'uniform float frameCount;',
      'uniform vec2 grid;',
      'uniform vec2 terrainSize;',
      'uniform float margin;',
      'varying vec2 waterUV;',
      'vec4 surface(float index, vec2 ripple, vec2 dx, vec2 dy) {',
      'vec2 cell = vec2(mod(index, grid.x), grid.y - 1.0 - floor(index / grid.x));',
      'return textureGrad(sheet, (cell + ripple * 0.992 + 0.004) / grid, dx, dy);',
      '}',
      'void main() {',
      'vec2 tiles = waterUV * (terrainSize - 1.0 + 2.0 * margin) - margin;',
      'vec2 scaled = tiles / 2.0;',
      'vec2 ripple = fract(scaled);',
      'vec2 dx = dFdx(scaled / grid);',
      'vec2 dy = dFdy(scaled / grid);',
      'float index = floor(frame);',
      'vec4 waves = mix(surface(index, ripple, dx, dy), surface(mod(index + 1.0, frameCount), ripple, dx, dy), fract(frame));',
      'vec2 coastData = texture2D(shore, (tiles + 0.5) / terrainSize).rg;',
      'if (coastData.g < 0.01) discard;',
      'float depth = coastData.r;',
      'vec4 coast = vec4(255.0, 255.0, 255.0, 10.0);',
      'vec4 shallow = vec4(117.0, 117.0, 200.0, 219.0);',
      'vec4 deep = vec4(96.0, 96.0, 192.0, 250.0);',
      'vec4 tint = depth <= 0.5 ? mix(coast, shallow, clamp((depth - 0.078125) / 0.421875, 0.0, 1.0))',
      '  : mix(shallow, deep, clamp((depth - 0.5) / 0.0625, 0.0, 1.0));',
      'gl_FragColor = waves * (tint / 255.0);',
      '}',
    ].join('\n'),
    transparent: true,
    depthWrite: false,
  });
  const water = mesh(new THREE.PlaneGeometry(worldWidth + margin * 2, worldHeight + margin * 2), sheet,
    west / tile + worldWidth / 2, level, -south / tile - worldHeight / 2);
  water.rotation.x = -Math.PI / 2;
  return { water, step(time) {
    sheet.uniforms.frame.value = (time * 15) % atlas.count;
  } };
}

function makeTower(color) {
  const tower = new THREE.Group();
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const octagon = new THREE.CylinderGeometry(1, 1, 1, 8);
  const stone = material(0xa9a18e);
  const agedStone = material(0x827966);
  const dark = material(0x48443a);
  const wood = material(0x473024);
  const band = material(0xc19856, { metalness: 0.48, roughness: 0.62 });
  const flag = material(color, { side: THREE.DoubleSide });
  const lamp = material(0xffd58d, { emissive: 0xff9d3e, emissiveIntensity: 2.1 });
  const block = (x, y, z, sx, sy, sz, finish) => mesh(cube, finish, x, y, z, sx, sy, sz);
  const layer = (y, radius, height, finish) => mesh(octagon, finish, 0, y, 0, radius, height, radius);
  tower.add(layer(0.045, 1.5, 0.09, dark), layer(0.15, 1.27, 0.2, agedStone), layer(0.3, 1.13, 0.18, stone));
  tower.add(block(0, 1.08, 0, 1.56, 1.52, 1.5, stone));
  tower.add(block(0, 1.78, 0, 1.72, 0.14, 1.67, agedStone));
  tower.add(block(0, 1.98, 0, 1.38, 0.34, 1.32, wood));
  tower.add(block(0, 2.17, 0, 1.94, 0.2, 1.87, dark));
  tower.add(block(0, 2.3, 0, 1.94, 0.14, 1.87, stone));
  const random = seededRandom(1292);
  for (let row = 0; row < 6; row += 1) {
    const y = 0.4 + row * 0.22;
    for (let index = 0; index < 5; index += 1) {
      const x = (index - 2) * 0.29 + (row % 2 ? 0.05 : -0.03);
      const finish = random() < 0.31 ? agedStone : stone;
      tower.add(block(x, y, 0.77, 0.28, 0.203, 0.05, finish));
      tower.add(block(x, y, -0.77, 0.28, 0.203, 0.05, finish));
      tower.add(block(0.8, y, x, 0.05, 0.203, 0.28, finish));
      tower.add(block(-0.8, y, x, 0.05, 0.203, 0.28, finish));
    }
  }
  for (const side of [-1, 1]) {
    for (const value of [-0.79, 0, 0.79]) {
      tower.add(block(value, 2.49, side * 0.82, 0.29, 0.27, 0.26, stone));
      if (value === 0) tower.add(block(side * 0.83, 2.49, value, 0.26, 0.27, 0.3, stone));
    }
    tower.add(block(side * 0.28, 1.32, 0.811, 0.12, 0.36, 0.035, dark));
    tower.add(block(side * 0.28, 1.35, 0.838, 0.04, 0.23, 0.02, lamp));
    tower.add(block(side * 0.82, 1.91, 0.64, 0.13, 0.31, 0.18, wood));
    tower.add(block(side * 0.82, 1.91, -0.64, 0.13, 0.31, 0.18, wood));
  }
  tower.add(block(0, 0.63, 0.82, 0.34, 0.48, 0.075, wood));
  tower.add(block(0, 2.18, 0.97, 0.54, 0.05, 0.06, band));
  tower.add(block(0, 1.81, 0.98, 0.4, 0.72, 0.032, flag));
  tower.add(block(0, 1.81, 1.005, 0.07, 0.27, 0.012, band));
  tower.add(block(0, 1.81, 1.006, 0.19, 0.05, 0.012, band));
  const mount = mesh(new THREE.CylinderGeometry(0.36, 0.49, 0.42, 8), dark, 0, 2.55, 0);
  tower.add(mount);
  const crystal = mesh(new THREE.OctahedronGeometry(0.3), lamp, 0, 2.95, 0, 0.82, 1.35, 0.82);
  tower.add(crystal);
  tower.traverse(part => {
    if (!part.isMesh) return;
    part.castShadow = true;
    part.receiveShadow = true;
  });
  return { tower, crystal, flag };
}

function makeActors(scene, shadowMap) {
  const body = new THREE.CylinderGeometry(0.19, 0.15, 0.4, 6);
  const head = new THREE.IcosahedronGeometry(0.125, 0);
  const limb = new THREE.BoxGeometry(0.095, 0.28, 0.105);
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.075, 10);
  const sword = new THREE.BoxGeometry(0.055, 0.37, 0.025);
  const shadow = new THREE.PlaneGeometry(2, 2);
  const rough = material(0xffffff, { flatShading: true });
  const shade = new THREE.MeshBasicMaterial({ map: shadowMap, color: 0x11160e, opacity: 0.65, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  const batch = (geometry, finish = rough, factor = 1) => {
    const object = new THREE.InstancedMesh(geometry, finish, maxEnemies * factor);
    object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    object.frustumCulled = false;
    object.count = 0;
    scene.add(object);
    return object;
  };
  return {
    torso: batch(body), skull: batch(head), legs: batch(limb, rough, 2), arms: batch(limb, rough, 2),
    weapons: batch(sword), cart: batch(cube, rough, 2), wheels: batch(wheel, rough, 2), shadow: batch(shadow, shade),
  };
}

function put(batch, x, y, z, heading, tilt, sx, sy, sz, color) {
  if (batch.count >= batch.instanceMatrix.count) return;
  pose.position.set(x, y, z);
  pose.rotation.set(tilt, heading, 0, 'YXZ');
  pose.scale.set(sx, sy, sz);
  pose.updateMatrix();
  batch.setMatrixAt(batch.count, pose.matrix);
  if (color !== undefined) batch.setColorAt(batch.count, hue.setHex(color));
  batch.count += 1;
}

function actorColor(actor) {
  if (actor.frost || actor.stun > 0) return 0x87c3d4;
  if (actor.fire > 0) return 0xc66b3e;
  if (actor.poison) return 0x839340;
  const base = { n: 0x785844, h: 0x9b4c43, u: 0x665082, o: 0x648048, e: 0x59786b }[actor.id[0]];
  return base ?? 0xb1584e;
}

function drawActors(actors, terrain, view, clock, deaths, represented, positionOf) {
  for (const batch of Object.values(actors)) batch.count = 0;
  const { layout } = view;
  const all = view.enemies.concat(deaths);
  for (const enemy of all.slice(0, maxEnemies)) {
    const location = enemy.falling ? enemy : positionOf(enemy);
    const x = (layout.x + location.x) / tile;
    const z = -(layout.y + location.y) / tile;
    const ground = terrainElevation(terrain, x * tile, -z * tile);
    const angle = Math.atan2(-location.x, location.y);
    const swinging = Math.max(0, 1 - (clock - enemy.attackAt) * 2.8);
    const gait = enemy.walking && enemy.stun <= 0 ? Math.sin(clock * 10 + enemy.key * 1.3) : 0;
    const lean = enemy.falling ? -1.46 * enemy.falling : swinging * 0.19;
    const height = 1 - (enemy.falling ?? 0) * 0.8;
    const boss = enemy.family === 'Samwise';
    const big = boss ? 1.9 : enemy.family === 'BanditRider' ? 1.13 : 1;
    const color = actorColor(enemy);
    const dx = Math.cos(angle);
    const dz = -Math.sin(angle);
    if (!enemy.falling) put(actors.shadow, x, ground + 0.025, z, angle, -Math.PI / 2, big * 0.4, big * 0.59, 1);
    if (represented?.has(enemy.key)) continue;
    if (enemy.family === 'Catapult') {
      put(actors.cart, x, ground + 0.25 * height, z, angle, lean, 0.53, 0.15, 0.8, 0x644c38);
      put(actors.cart, x, ground + 0.45 * height, z, angle, -0.4 + swinging * 1.12, 0.082, 0.09, 0.76, 0x936d46);
      for (const side of [-1, 1]) {
        put(actors.wheels, x + dx * 0.31 * side, ground + 0.2 * height, z + dz * 0.31 * side, angle + Math.PI / 2, Math.PI / 2, 1, 1, 1, 0x3c3128);
      }
      continue;
    }
    if (enemy.family === 'BanditRider') {
      put(actors.cart, x, ground + 0.29 * height, z, angle, lean, 0.41, 0.32, 0.66, 0x5a4438);
    }
    const bob = Math.abs(gait) * 0.055;
    const riding = enemy.family === 'BanditRider' ? 0.19 : 0;
    put(actors.torso, x, ground + (0.47 + bob + riding) * height * big, z, angle, lean, big, big, big, color);
    put(actors.skull, x, ground + (0.755 + bob + riding) * height * big, z, angle, lean, big, big, big, boss ? 0xa57187 : 0xb8a082);
    for (const side of [-1, 1]) {
      const a = side * 0.091 * big;
      put(actors.legs, x + dx * a, ground + 0.16 * height * big, z + dz * a,
        angle, lean + gait * side * 0.7, big, big, big, 0x3c3d33);
      const b = side * 0.2 * big;
      put(actors.arms, x + dx * b, ground + (0.48 + riding) * height * big, z + dz * b,
        angle, lean + (side > 0 ? -swinging * 1.35 : gait * 0.45), big, big, big, color);
      if (side > 0) put(actors.weapons, x + dx * b, ground + (0.45 + riding + swinging * 0.26) * height * big,
        z + dz * b, angle, -0.75 + swinging * 2.2 + lean, big, big, big, 0xc4c5ad);
    }
  }
  for (const batch of Object.values(actors)) {
    if (!batch.count) continue;
    updateInstances(batch.instanceMatrix, batch.count);
    if (batch.instanceColor) updateInstances(batch.instanceColor, batch.count);
  }
}

function updateInstances(attribute, count) {
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

function effectMaterial(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
}

export function createArenaRenderer(canvas, map, original, originalCanvas, combatCanvas, playModelSound) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.29;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x171d19);
  if (!original) scene.fog = new THREE.FogExp2(0x252c21, 0.012);
  scene.add(new THREE.HemisphereLight(0xf4e2b5, 0x4b544a, 2.1));
  const sun = new THREE.DirectionalLight(0xffd6a3, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 65 });
  sun.shadow.normalBias = 0.025;
  sun.shadow.bias = -0.0002;
  scene.add(sun, sun.target);

  const terrain = mesh(terrainGeometry(map.terrain), material(0xffffff, { vertexColors: true, map: groundTexture() }), 0, 0, 0);
  terrain.receiveShadow = true;
  scene.add(terrain);
  const water = makeOriginalWater(original, map.terrain);
  if (water) scene.add(water.water);
  const fort = makeTower(0xb84836);
  scene.add(fort.tower);
  const towerLight = new THREE.PointLight(0xffa048, 7, 5, 1.8);
  scene.add(towerLight);
  const spriteMap = glowTexture();
  const actors = makeActors(scene, spriteMap);
  const towerShade = mesh(new THREE.PlaneGeometry(4.5, 3.8), new THREE.MeshBasicMaterial({
    map: spriteMap, color: 0x0f150d, transparent: true, opacity: 0.58, depthWrite: false,
  }), 0, 0, 0);
  towerShade.rotation.x = -Math.PI / 2;
  scene.add(towerShade);
  // Stock game camera positions in Warcraft III UI/MiscData.txt.
  const cameraSteps = [[56, 1650], [49, 1600], [42, 1500], [35, 1400], [28, 1275], [21, 1100]];
  const cameraRules = map.camera ?? { fov: 70, pitch: 56, rotation: 90, distance: 1650, near: 100, far: 5000 };
  const camera = new THREE.PerspectiveCamera(cameraRules.fov, 1, cameraRules.near / tile, cameraRules.far / tile);
  const cameraTarget = new THREE.Vector3();
  const combatArt = createCombatArt(combatCanvas);
  let originalLayer;
  try {
    if (original) originalLayer = createOriginalLayer(originalCanvas, original, playModelSound);
  } catch (error) {
    console.warn('Original model layer unavailable', error);
  }
  const ground = (x, y) => terrainElevation(map.terrain, x, y) * tile;
  const targets = new Map();
  const projectiles = new Map();
  const projectileEnds = new Map();
  const projectileFlight = event => projectiles.get(event.projectileId) ?? projectileEnds.get(event.projectileId);
  const sampledPositions = [];
  const positionOf = enemy => targets.get(enemy.key) ?? enemy;
  const defeated = new Map();
  const attackStart = new THREE.Vector3();
  const attackEnd = new THREE.Vector3();
  const sphere = new THREE.IcosahedronGeometry(0.12, 1);
  const torus = new THREE.TorusGeometry(1, 0.035, 5, 48);
  const spark = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const effects = [];
  const deaths = [];
  let layout = map.arenas[0];
  let activeSkin;
  let cameraStep = 0;
  let cameraPitch = cameraRules.pitch;
  let cameraDistance = cameraRules.distance;
  let cameraWidth = 0;
  let cameraHeight = 0;
  let cameraPixelRatio = 1;
  let lastFrame = 0;
  let afterMatch = 0;

  if (original) {
    void originalTerrainMaterial(original, map.terrain).then(surface => {
      if (!surface) return;
      const uv = terrain.geometry.getAttribute('uv');
      for (let index = 0; index < uv.count; index += 1) {
        uv.setXY(index, (index % map.terrain.width) / (map.terrain.width - 1),
          Math.floor(index / map.terrain.width) / (map.terrain.height - 1));
      }
      uv.needsUpdate = true;
      terrain.material.map.dispose();
      terrain.material.dispose();
      terrain.material = surface;
    }).catch(error => console.warn('Original terrain unavailable', error));
  }

  function setLayout(next, color) {
    layout = next;
    const height = terrainElevation(map.terrain, layout.x, layout.y);
    const x = layout.x / tile;
    const z = -layout.y / tile;
    fort.tower.position.set(x, height, z);
    towerShade.position.set(x + 0.28, height + 0.035, z + 0.28);
    fort.flag.color.setHex(color);
    towerLight.position.set(x, height + 2.8, z);
    sun.position.set(x - 9, height + 17, z - 5);
    sun.target.position.set(x, height, z);
    originalLayer?.reset();
    combatArt.reset();
    targets.clear();
    projectiles.clear();
    projectileEnds.clear();
    defeated.clear();
    afterMatch = 0;
    for (const fx of effects.splice(0)) release(fx);
    deaths.length = 0;
    updateCamera(true);
  }

  function updateCamera(force = false) {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const pixelRatio = Math.min(Math.max(window.devicePixelRatio, 1.25), 2, Math.max(1, Math.sqrt(2_500_000 / (width * height))));
    if (width !== cameraWidth || height !== cameraHeight || pixelRatio !== cameraPixelRatio) {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      cameraWidth = width;
      cameraHeight = height;
      cameraPixelRatio = pixelRatio;
    } else if (!force) {
      return;
    }
    const aspect = width / height;
    const pitch = THREE.MathUtils.degToRad(cameraPitch);
    const azimuth = THREE.MathUtils.degToRad(cameraRules.rotation);
    const distance = (cameraDistance / tile) * Math.max(1, 0.92 / aspect);
    camera.aspect = aspect;
    const { x, y, z } = fort.tower.position;
    cameraTarget.set(x, y, z);
    camera.position.set(x - Math.cos(azimuth) * Math.cos(pitch) * distance,
      y + Math.sin(pitch) * distance, z + Math.sin(azimuth) * Math.cos(pitch) * distance);
    camera.lookAt(cameraTarget);
    camera.updateProjectionMatrix();
  }

  function position(x, y, height = 0, out = new THREE.Vector3()) {
    const absoluteX = layout.x + x;
    const absoluteY = layout.y + y;
    return out.set(absoluteX / tile, terrainElevation(map.terrain, absoluteX, absoluteY) + height, -absoluteY / tile);
  }

  function attackPoint(event, progress, out) {
    const source = event.kind === 'shot' ? event.from : targets.get(event.sourceId) ?? defeated.get(event.sourceId) ?? event.from;
    const flight = projectileFlight(event);
    const target = flight ?? targets.get(event.targetId) ?? defeated.get(event.targetId) ?? event.to;
    const profile = id => original?.data.actors?.[id === 'samwise' ? 'n00C' : id];
    const sourceProfile = profile(event.sourceUnitId);
    const targetProfile = profile(event.targetTower ? original?.data.towerUnits?.[activeSkin] ?? 'H00C' : event.targetUnitId ?? target.unitId);
    const heading = Math.atan2(event.to.y - source.y, event.to.x - source.x);
    const [side, forward, height] = event.launch ?? [0, 0, event.launchHeight ?? (source.x || source.y ? 86 : 145)];
    const scale = sourceProfile?.scale ?? 1;
    position(source.x + (Math.cos(heading) * forward - Math.sin(heading) * side) * scale,
      source.y + (Math.sin(heading) * forward + Math.cos(heading) * side) * scale,
      ((sourceProfile?.height ?? 0) + height * scale) / tile, attackStart);
    position(target.x, target.y, ((targetProfile?.height ?? 0) + (targetProfile?.projectile.impactHeight ?? 75) * (targetProfile?.scale ?? 1)) / tile, attackEnd);
    const span = flight ? Math.min(1, progress / Math.max(1e-9, flight.progress)) : progress;
    const point = out.lerpVectors(attackStart, attackEnd, span);
    if (event.kind === 'shot') {
      const arc = event.arc == null ? (event.type === 'Siege' ? 1.55 : event.type === 'Piercing' ? 0.2 : 0.51)
        : event.arc * Math.hypot(event.to.x - source.x, event.to.y - source.y) / tile;
      point.y += 4 * progress * (1 - progress) * arc;
    }
    return point;
  }

  function addVisual(event) {
    if (event.kind === 'shotEnd' || event.kind === 'shotCancel') {
      projectileEnds.set(event.projectileId, { ...event, progress: 1, cancelled: event.kind === 'shotCancel' });
      return;
    }
    if (event.kind === 'impact' || event.kind === 'heal' || event.kind === 'shot' || event.kind === 'beam') {
      const native = (event.kind === 'shot' || (event.kind === 'beam' && (event.slot === 100 || event.slot === 133)))
        && originalLayer?.event(event, layout, ground);
      combatArt.add(event, native);
      return;
    }
    if (event.kind === 'death') defeated.set(event.enemyId, event);
    if (originalLayer?.event(event, layout, ground)) return;
    if (event.kind === 'death') {
      deaths.push({
        key: event.enemyId, id: event.unitId, x: event.x, y: event.y, walking: false,
        attackAt: -10, falling: 0.01, at: event.at,
      });
      return;
    }
    if (effects.length > 550) release(effects.shift());
    const color = event.color ?? 0xf2b374;
    const root = new THREE.Group();
    const finish = effectMaterial(color, 0.95);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteMap, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    const fx = { root, finish, halo, event, age: 0, duration: event.duration ?? 0.58 };
    if (['burst', 'wave', 'clear', 'field', 'summon', 'mine', 'enemyAttack'].includes(event.kind)) {
      root.position.copy(position(event.x ?? 0, event.y ?? 0, 0.11));
      if (event.kind === 'enemyAttack') {
        fx.duration = 0.15;
        halo.scale.setScalar(0.33);
        halo.position.y = 0.55;
        root.add(halo);
      } else {
        fx.ring = mesh(torus, finish, 0, 0.04, 0);
        fx.ring.rotation.x = -Math.PI / 2;
        fx.radius = Math.max(0.15, (event.radius ?? 70) / tile);
        fx.ring.scale.setScalar(0.1);
        root.add(fx.ring, halo);
        if (['mine', 'summon'].includes(event.kind)) root.add(mesh(sphere, finish, 0, 0.25, 0, 1, 2.5, 1));
        if (event.kind === 'clear') fx.duration = 1.0;
        if (event.kind === 'burst' && event.slot === 30) fx.duration = 2.8;
        if (event.kind === 'burst' && event.slot === 40) fx.duration = 0.4;
        if (event.kind === 'wave') {
          fx.from = root.position.clone();
          fx.to = position((event.dx ?? 0) * event.radius, (event.dy ?? 0) * event.radius, 0.19);
          fx.radius = (event.width ?? 125) / tile;
        }
        if (event.kind === 'burst' || event.kind === 'clear') {
          const random = seededRandom(event.seq);
          fx.sparks = Array.from({ length: event.kind === 'clear' ? 20 : 6 }, () => {
            const object = mesh(spark, finish, 0, 0, 0);
            root.add(object);
            return { object, angle: random() * 6.28, rise: 0.35 + random() };
          });
        }
      }
    } else {
      finish.dispose();
      halo.material.dispose();
      return;
    }
    effects.push(fx);
    scene.add(root);
  }

  function release(fx) {
    scene.remove(fx.root);
    fx.finish.dispose();
    fx.halo.material.dispose();
  }

  function updateEffects(dt, time) {
    for (let index = effects.length - 1; index >= 0; index -= 1) {
      const fx = effects[index];
      fx.age = fx.event.kind === 'wave' ? Math.max(0, time - fx.event.at) : fx.age + dt;
      const t = fx.age / fx.duration;
      if (t >= 1) {
        release(fx);
        effects.splice(index, 1);
        continue;
      }
      if (fx.from) fx.root.position.lerpVectors(fx.from, fx.to, t);
      const steady = ['field', 'summon', 'mine'].includes(fx.event.kind);
      fx.finish.opacity = steady ? 0.31 + 0.13 * Math.sin(time * 8) : (1 - t) * 0.95;
      fx.halo.material.opacity = steady ? 0.44 : (1 - t) * 0.78;
      if (fx.ring) {
        const scale = fx.radius * (steady ? 0.9 + 0.1 * Math.sin(time * 6) : 0.16 + t * 0.84);
        fx.ring.scale.setScalar(scale);
        fx.halo.scale.setScalar(Math.max(0.45, scale * 1.8));
      }
      if (fx.sparks) {
        for (const { object, angle, rise } of fx.sparks) {
          object.position.set(Math.cos(angle) * t * fx.radius, Math.sin(t * Math.PI) * rise, Math.sin(angle) * t * fx.radius);
          object.rotation.set(t * 7, angle, t * 5);
          object.scale.setScalar(1 - t * 0.8);
        }
      }
    }
  }

  setLayout(map.arenas[0], 0xb84836);
  return {
    event: addVisual,
    reset: setLayout,
    zoom(direction) {
      cameraStep = THREE.MathUtils.clamp(cameraStep + direction, 0, cameraSteps.length - 1);
    },
    render(frame, stamp, paused = false, interpolation = 0, movementAlpha = 1) {
      if (frame.arena.layout.seat !== layout.seat) setLayout(frame.arena.layout, frame.arena.color);
      const wallStep = lastFrame ? Math.min((stamp - lastFrame) / 1000, 0.08) : 0;
      const dt = paused ? 0 : wallStep;
      lastFrame = stamp;
      const [pitch, distance] = cameraSteps[cameraStep];
      const zooming = cameraPitch !== pitch || cameraDistance !== distance;
      if (zooming) {
        cameraPitch += THREE.MathUtils.clamp(pitch - cameraPitch, -20 * wallStep, 20 * wallStep);
        cameraDistance += THREE.MathUtils.clamp(distance - cameraDistance, -1200 * wallStep, 1200 * wallStep);
      }
      updateCamera(zooming);
      for (let index = deaths.length - 1; index >= 0; index -= 1) {
        deaths[index].falling += dt * 1.95;
        if (deaths[index].falling >= 1) deaths.splice(index, 1);
      }
      afterMatch = frame.finished ? Math.min(1.25, afterMatch + dt) : 0;
      const gameTime = frame.time + interpolation + afterMatch;
      activeSkin = frame.arena.skin;
      targets.clear();
      projectiles.clear();
      for (const shot of frame.arena.projectiles ?? []) {
        projectiles.set(shot.id, {
          x: THREE.MathUtils.lerp(shot.previousX, shot.x, movementAlpha),
          y: THREE.MathUtils.lerp(shot.previousY, shot.y, movementAlpha),
          progress: THREE.MathUtils.lerp(shot.previousProgress, shot.progress, movementAlpha),
        });
      }
      for (const [id, shot] of projectileEnds) if (gameTime > shot.at + 1.5) projectileEnds.delete(id);
      for (const [index, enemy] of frame.arena.enemies.entries()) {
        const point = sampledPositions[index] ??= {};
        point.x = THREE.MathUtils.lerp(enemy.previousX ?? enemy.x, enemy.x, movementAlpha);
        point.y = THREE.MathUtils.lerp(enemy.previousY ?? enemy.y, enemy.y, movementAlpha);
        point.family = enemy.family;
        point.unitId = enemy.id;
        targets.set(enemy.key, point);
      }
      water?.step(gameTime);
      const artState = originalLayer?.sync(frame, ground, positionOf, interpolation);
      fort.tower.visible = !artState?.tower;
      fort.crystal.rotation.y = gameTime * 1.3;
      fort.crystal.position.y = 2.95 + Math.sin(gameTime * 2.6) * 0.07;
      towerLight.intensity = frame.arena.alive ? 6 + Math.sin(gameTime * 8) * 1.4 : 0;
      drawActors(actors, map.terrain, frame.arena, gameTime, deaths, artState?.represented, positionOf);
      updateEffects(dt, gameTime);
      for (const [key, event] of defeated) if (gameTime > event.at + 1.2) defeated.delete(key);
      renderer.render(scene, camera);
      originalLayer?.render(camera, cameraTarget, canvas.width, canvas.height, dt, gameTime, attackPoint, frame.speed, projectileFlight);
      combatArt.render(frame, gameTime, dt, camera, canvas, position, attackPoint, positionOf, projectileFlight);
    },
  };
}
