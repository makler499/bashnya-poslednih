import tracks from './warcraft-audio-tracks.json';

const filenames = new Map(Object.entries({
  mouseclick1: 'click',
  goodjob: 'reward',
  questcompleted: 'victory',
  questfailed: 'defeat',
  farseermissile: 'tesla',
  lightningbolt: 'chain',
  fireballmissiledeath: 'pillar',
  breathoffire1: 'firebreather',
  monsoonlightninghit: 'storm',
}));
const directSounds = ['warning', 'questlog', 'questnew', 'credits', 'darkvictory', 'doom',
  'heroicvictory', 'tragicconfrontation', 'undeaddissipate2', 'kelthuzadwhat1', 'humancalltoarmswhat1'];
for (const name of [...Object.values(tracks).flat(), ...directSounds]) {
  if (!filenames.has(name)) filenames.set(name, name);
}
const maxSampleBytes = 16 * 1024 * 1024;
const maxArchiveBytes = 96 * 1024 * 1024;

function soundKey(filename) {
  const match = /([^/\\]+)\.(wav|flac|ogg|mp3)$/i.exec(filename);
  return match && filenames.get(match[1].toLowerCase());
}

function audioHeader(data) {
  const bytes = new Uint8Array(data, 0, Math.min(data.byteLength, 12));
  const magic = String.fromCharCode(...bytes);
  return /^(fLaC|OggS|ID3|RIFF....WAVE)/s.test(magic) || (bytes[0] === 255 && (bytes[1] & 224) === 224);
}
const effects = {
  tesla: { gain: 0.38, voices: 5 },
  chain: { gain: 0.27, voices: 2 },
  pillar: { gain: 0.31, voices: 3 },
  firebreather: { gain: 0.34, voices: 3 },
  storm: { gain: 0.29, voices: 2 },
};

const builtInCues = {
  click: [0.07, 720, 460, 0.12],
  questnew: [0.24, 390, 650, 0.25],
  reward: [0.26, 490, 820, 0.24],
  shot: [0.13, 190, 70, 0.35],
  impact: [0.11, 105, 45, 0.42],
  beam: [0.18, 280, 100, 0.36],
  wave: [0.25, 140, 52, 0.55],
  burst: [0.23, 110, 36, 0.62],
  doom: [0.55, 135, 62, 0.38],
  victory: [0.46, 390, 780, 0.25],
  defeat: [0.49, 280, 100, 0.27],
};
const equivalentCue = {
  tesla: 'beam', chain: 'beam', pillar: 'burst', storm: 'burst', firebreather: 'wave',
  '#SHSL': 'shot', '#SHSI': 'burst', '#AOHW': 'beam', '#MTRL': 'shot', '#MTRI': 'burst',
};

function makeCue(context, name) {
  const [duration, high, low, texture] = builtInCues[name];
  const length = Math.round(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  let phase = 0;
  for (let index = 0; index < length; index++) {
    const progress = index / length;
    phase += 2 * Math.PI * (high + (low - high) * progress) / context.sampleRate;
    const envelope = Math.min(1, index / 80) * (1 - progress) ** 3;
    samples[index] = 0.46 * envelope * (Math.sin(phase) * (1 - texture) + (Math.random() * 2 - 1) * texture);
  }
  return buffer;
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
      const operation = files ? store.put(files, 'sounds') : store.get('sounds');
      transaction.oncomplete = () => { db.close(); resolve(operation.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

export function createBattleAudio() {
  const buffers = new Map();
  const fallbackBuffers = new Map();
  const activeSources = new Set();
  const activeVoices = new Map();
  let originals = {};
  const lastPlayed = new Map();
  let context;
  let output;
  let mix;
  let restoration;
  let enabled = false;

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
        mix.connect(output);
        output.connect(context.destination);
      }
      output.gain.value = 0.85;
      await context.resume();
      await restore();
    } catch {
      // A browser can reject audio activation while its tab is in the background.
    }
  }

  function restore() {
    restoration ??= storedSounds('readonly').then(files => { originals = files ?? {}; }).catch(() => {});
    return restoration;
  }

  async function importFiles(files) {
    await enable();
    const imported = new Set();
    function add(filename, data) {
      const name = soundKey(filename);
      if (!name || data.byteLength > maxSampleBytes || !audioHeader(data)) return;
      originals[name] = data;
      buffers.delete(name);
      imported.add(name);
    }
    for (const file of files) {
      try {
        if (/\.zip$/i.test(file.name) && file.size <= maxArchiveBytes) {
          const { unzipSync } = await import('three/addons/libs/fflate.module.js');
          let size = 0;
          const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
            filter: entry => {
              if (!soundKey(entry.name) || entry.originalSize > maxSampleBytes) return false;
              size += entry.originalSize;
              return size <= maxArchiveBytes;
            },
          });
          for (const [name, data] of Object.entries(entries)) {
            add(name, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          }
        } else if (soundKey(file.name) && file.size <= maxSampleBytes) {
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

  async function play(name, delay = 0, modelSound = false) {
    if (!enabled || context?.state !== 'running') return;
    if (name.startsWith('#')) {
      const variants = (tracks[name.slice(1)] ?? []).map(file => filenames.get(file)).filter(file => originals[file]);
      if (variants.length) {
        void play(variants[Math.floor(Math.random() * variants.length)], delay, true);
        return;
      }
    }
    const data = originals[name];
    const cue = equivalentCue[name] ?? name;
    const scheduled = context.currentTime + delay;
    let buffer;
    if (data) {
      if (!buffers.has(name)) buffers.set(name, context.decodeAudioData(data.slice(0)).catch(() => null));
      buffer = await buffers.get(name);
    }
    if (!buffer && builtInCues[cue]) {
      name = cue;
      if (!fallbackBuffers.has(cue)) fallbackBuffers.set(cue, makeCue(context, cue));
      buffer = fallbackBuffers.get(cue);
    }
    if (!buffer || !enabled || context.state !== 'running') return;
    const start = Math.max(scheduled, context.currentTime);
    const effect = effects[name] ?? (modelSound ? { gain: 0.23, voices: 3 } : null);
    const voices = activeVoices.get(name) ?? 0;
    if (voices >= (effect?.voices ?? 1) || start < (lastPlayed.get(name) ?? -1) + 0.065) return;
    if (effect && activeSources.size >= 18) return;
    lastPlayed.set(name, start);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = effect ? effect.gain / Math.sqrt(1 + 0.6 * voices) : 0.85;
    source.connect(gain).connect(mix);
    activeSources.add(source);
    activeVoices.set(name, voices + 1);
    source.onended = () => {
      activeSources.delete(source);
      activeVoices.set(name, activeVoices.get(name) - 1);
      source.disconnect();
      gain.disconnect();
    };
    source.start(start);
  }

  function event(effect, ownArena) {
    if (ownArena && !Object.keys(originals).length && ['shot', 'beam', 'wave', 'burst', 'impact'].includes(effect.kind)) {
      play(effect.kind, 0, true);
      return;
    }
    switch (effect.kind) {
      case 'round': if (ownArena) play(effect.incomeBonus ? 'reward' : 'questnew'); break;
      case 'shot': if (effect.slot === 38) play('#SHSL'); break;
      case 'beam':
        if (effect.slot === 100 && effect.sourceId == null) play('chain', 0.033);
        if (effect.slot === 205) play('#AOHW');
        break;
      case 'wave': if (effect.slot === 125) play('firebreather', 0.033); break;
      case 'burst':
        if (effect.slot === 38) play('#SHSI');
        if (effect.slot === 40) play('pillar', 0.033);
        if (effect.slot === 104) {
          play('#MTRL');
          play('#MTRI', 0.2);
        }
        if (effect.slot === 212) play('storm');
        break;
      case 'boss': play('doom'); break;
      case 'defeat':
        play('tragicconfrontation');
        if (ownArena) play('defeat');
        play('questlog');
        break;
      case 'victory':
        if (ownArena) {
          play('victory');
          play(effect.bossDefeated ? 'darkvictory' : 'heroicvictory');
        }
        break;
    }
  }

  return { enable, mute, play, event, importFiles, restore, get hasFiles() { return Object.keys(originals).length > 0; } };
}
