import catalog from './warcraft-audio-tracks.json';

const { tracks, named, samples, missiles } = catalog;
const soundKey = path => path.replaceAll('\\', '/').toLowerCase().replace(/\.(wav|flac|ogg|mp3)$/, '');
const missileKey = path => path.replaceAll('\\', '/').toLowerCase().replace(/\.md[xl]$/, '');
const missing = new Set(Object.values(tracks).flatMap(track => track.paths).map(soundKey).filter(key => !samples[key]));
const missingByName = new Map();
for (const key of missing) {
  const name = key.split('/').at(-1);
  missingByName.set(name, missingByName.has(name) ? null : key);
}
const importKey = path => /\.(wav|flac|ogg|mp3)$/i.test(path)
  ? (missing.has(soundKey(path)) ? soundKey(path) : missingByName.get(soundKey(path).split('/').at(-1)))
  : undefined;
const maxSampleBytes = 16 * 1024 * 1024;
const maxArchiveBytes = 96 * 1024 * 1024;
const effectModels = {
  'beam:100': ['war3mapimported/boltimpact', 'stand'],
  'wave:125': ['war3mapimported/breathoffiremissile', 'birth'],
  'burst:40': ['war3mapimported/firetrapupbirth', 'birth'],
  'burst:212': ['war3mapimported/monsoonbolttarget', 'stand'],
};

function audioHeader(data) {
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 12));
  const magic = String.fromCharCode(...bytes);
  return /^(fLaC|OggS|ID3|RIFF....WAVE)/s.test(magic) || (bytes[0] === 255 && (bytes[1] & 224) === 224);
}

function storedSounds(mode, files) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tower-survivors-warcraft-audio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('audio');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('audio', mode);
      const store = transaction.objectStore('audio');
      const operation = files ? store.put(files, 'sounds-v2') : store.get('sounds-v2');
      transaction.oncomplete = () => { db.close(); resolve(operation.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

export function createBattleAudio() {
  const base = new URL('map-art/', document.baseURI);
  const buffers = new Map();
  const activeSources = new Set();
  const voices = new Map();
  const flights = new Map();
  const enemyFlights = [];
  let originals = {};
  let context;
  let output;
  let mix;
  let restoration;
  let enabled = false;
  let preloaded = false;

  async function enable() {
    enabled = true;
    try {
      if (!context) {
        context = new AudioContext();
        output = context.createGain();
        mix = context.createDynamicsCompressor();
        mix.threshold.value = -12;
        mix.ratio.value = 4;
        mix.attack.value = 0.004;
        mix.release.value = 0.13;
        mix.connect(output).connect(context.destination);
      }
      output.gain.value = 0.85;
      if (context.state !== 'running') await context.resume();
      if (!preloaded) {
        preloaded = true;
        for (const name of ['mouseclick1', 'questnew', 'goodjob']) void load(soundKey(named[name].path));
      }
    } catch {
      // The next click can retry browser audio activation.
    }
  }

  function restore() {
    restoration ??= storedSounds('readonly').then(files => { originals = files ?? {}; }).catch(() => {});
    return restoration;
  }

  async function importFiles(files) {
    await restore();
    const imported = new Set();
    function add(filename, data) {
      const key = importKey(filename);
      if (!key || data.byteLength > maxSampleBytes || !audioHeader(data)) return;
      originals[key] = data;
      buffers.delete(key);
      imported.add(key);
    }
    for (const file of files) {
      try {
        if (/\.zip$/i.test(file.name) && file.size <= maxArchiveBytes) {
          const { unzipSync } = await import('three/addons/libs/fflate.module.js');
          let size = 0;
          const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
            filter: entry => {
              if (!importKey(entry.name) || entry.originalSize > maxSampleBytes) return false;
              size += entry.originalSize;
              return size <= maxArchiveBytes;
            },
          });
          for (const [name, data] of Object.entries(entries)) {
            add(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          }
        } else if (importKey(file.name) && file.size <= maxSampleBytes) {
          add(file.name, await file.arrayBuffer());
        }
      } catch {}
    }
    if (imported.size) {
      try { await storedSounds('readwrite', originals); } catch {}
    }
    return imported.size;
  }

  function mute() {
    enabled = false;
    if (output) output.gain.value = 0;
    for (const source of activeSources) source.stop();
  }

  function load(key) {
    if (!buffers.has(key)) {
      const asset = samples[key];
      const bytes = asset ? fetch(new URL(asset.file, base)).then(response => {
        if (!response.ok) throw new Error('Audio ' + response.status);
        return response.arrayBuffer();
      }) : Promise.resolve(originals[key]?.slice(0));
      buffers.set(key, bytes.then(data => data && context.decodeAudioData(data)).catch(() => {
        buffers.delete(key);
        return null;
      }));
    }
    return buffers.get(key);
  }

  async function play(name, delay = 0) {
    if (!enabled || context?.state !== 'running') return;
    const modelSound = name.startsWith('#');
    const cue = modelSound ? tracks[name.slice(1).trim().toUpperCase()] : named[name];
    if (!cue) return;
    const choices = (modelSound ? cue.paths : [cue.path]).map(soundKey).filter(key => samples[key] || originals[key]);
    if (!choices.length) return;
    const key = choices[Math.floor(Math.random() * choices.length)];
    const scheduled = context.currentTime + delay;
    const buffer = await load(key);
    if (!buffer || !enabled || context.state !== 'running') return;
    const count = voices.get(name) ?? 0;
    if (modelSound && (count >= 5 || activeSources.size >= 32)) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = (cue.pitch ?? 1) + (Math.random() * 2 - 1) * (cue.variance ?? 0);
    gain.gain.value = (cue.gain ?? 1) * (modelSound ? 0.65 : 0.9) / Math.sqrt(1 + count);
    source.connect(gain).connect(mix);
    activeSources.add(source);
    voices.set(name, count + 1);
    source.onended = () => {
      activeSources.delete(source);
      voices.set(name, voices.get(name) - 1);
      source.disconnect();
      gain.disconnect();
    };
    source.start(Math.max(scheduled, context.currentTime));
  }

  function cues(list) {
    for (const [code, milliseconds] of list ?? []) void play('#' + code, milliseconds / 1000);
  }

  function reset() {
    flights.clear();
    enemyFlights.length = 0;
  }

  function advance(time) {
    for (let index = enemyFlights.length - 1; index >= 0; index--) {
      if (enemyFlights[index].at > time) continue;
      cues(enemyFlights[index].impact);
      enemyFlights.splice(index, 1);
    }
  }

  function event(effect, ownArena, model, skin) {
    const effectModel = effectModels[effect.kind + ':' + effect.slot];
    if (effectModel) {
      const [path, phase] = effectModel;
      cues(missiles[path]?.[phase]);
      return;
    }
    switch (effect.kind) {
      case 'beam':
        if (effect.slot === 133 && model) {
          const missile = missiles[missileKey(model)];
          cues(missile?.birth);
          if (missile?.death) enemyFlights.push({ at: effect.at + effect.duration, impact: missile.death });
        }
        break;
      case 'shot': {
        const missile = model && missiles[missileKey(model)];
        if (!missile) break;
        cues(missile.birth);
        if (!missile.death) break;
        if (effect.projectileId != null) flights.set(effect.projectileId, missile.death);
        else enemyFlights.push({ at: effect.at + effect.duration, impact: missile.death });
        break;
      }
      case 'shotEnd':
        cues(flights.get(effect.projectileId));
        flights.delete(effect.projectileId);
        break;
      case 'round':
        if (ownArena && effect.shopRefresh) void play('goodjob');
        else if (ownArena && effect.wave === 1) void play('questnew');
        break;
      case 'boss':
        if (ownArena) void play('doom');
        break;
      case 'defeat':
        if (skin === 'H020') void play('undeaddissipate2');
        if (ownArena) {
          if (effect.postVictory) void play('questfailed');
          else {
            void play('tragicconfrontation');
            void play('questlog');
          }
        }
        break;
      case 'victory':
        if (ownArena) {
          void play('questcompleted');
          void play(skin === 'H020' ? 'darkvictory' : 'heroicvictory');
        }
        break;
    }
  }

  return { enable, mute, play, event, reset, advance, importFiles, restore };
}
