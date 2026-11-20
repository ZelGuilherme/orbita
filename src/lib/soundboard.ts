import { SOUND_IDS, type SoundId } from './config';
import { playbackContext, soundBus } from './playback';

/**
 * Soundboard: sons curtos gerados na hora pelo próprio Órbita (sem arquivos de áudio).
 * Ninguém transmite o som: quem aperta manda só o nome dele e cada um toca o seu,
 * então quem desligou "ouvir os sons dos outros" simplesmente não toca.
 */

export const SOUNDS: Record<SoundId, { label: string; emoji: string }> = {
  horn: { label: 'Buzina', emoji: '📯' },
  rimshot: { label: 'Ba-dum-tss', emoji: '🥁' },
  bell: { label: 'Sino', emoji: '🔔' },
  clap: { label: 'Palmas', emoji: '👏' },
  alarm: { label: 'Alarme', emoji: '🚨' },
  sad: { label: 'Trombone triste', emoji: '🎺' },
  boing: { label: 'Boing', emoji: '🤸' },
  tada: { label: 'Tcharam!', emoji: '🎉' },
};

export const SOUND_LIST = SOUND_IDS.map((id) => ({ id, ...SOUNDS[id] }));

export const validSound = (value: unknown): value is SoundId => typeof value === 'string' && (SOUND_IDS as readonly string[]).includes(value);

let noise: AudioBuffer | null = null;

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise = buffer;
  return buffer;
}

interface Kit {
  ctx: BaseAudioContext;
  out: AudioNode;
  t0: number;
}

/** Envelope: sobe rápido, segura e cai até sumir. */
function env(k: Kit, gain: GainNode, start: number, peak: number, hold: number, release: number) {
  const g = gain.gain;
  const t = k.t0 + start;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(peak, t + 0.01);
  g.setValueAtTime(peak, t + hold);
  g.exponentialRampToValueAtTime(0.0001, t + hold + release);
}

function tone(k: Kit, type: OscillatorType, freq: number, start: number, peak: number, hold: number, release: number, filter?: number) {
  const osc = k.ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = k.ctx.createGain();
  env(k, gain, start, peak, hold, release);
  let tail: AudioNode = osc;
  if (filter) {
    const lp = k.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filter;
    tail = osc.connect(lp);
  }
  tail.connect(gain).connect(k.out);
  osc.start(k.t0 + start);
  osc.stop(k.t0 + start + hold + release + 0.05);
  return osc;
}

function burst(k: Kit, start: number, peak: number, release: number, type: BiquadFilterType, freq: number, q = 1) {
  const src = k.ctx.createBufferSource();
  src.buffer = noiseBuffer(k.ctx);
  const filter = k.ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = k.ctx.createGain();
  env(k, gain, start, peak, 0.004, release);
  src.connect(filter).connect(gain).connect(k.out);
  src.start(k.t0 + start, Math.random());
  src.stop(k.t0 + start + release + 0.05);
}

/** Tambor: seno que cai de tom. */
function drum(k: Kit, start: number, from: number, to: number, peak: number) {
  const osc = tone(k, 'sine', from, start, peak, 0.01, 0.22);
  osc.frequency.setValueAtTime(from, k.t0 + start);
  osc.frequency.exponentialRampToValueAtTime(to, k.t0 + start + 0.15);
  burst(k, start, peak * 0.3, 0.05, 'bandpass', 2500, 0.8);
}

const RECIPES: Record<SoundId, (k: Kit) => void> = {
  horn: (k) => {
    for (const [start, hold] of [
      [0, 0.18],
      [0.3, 0.75],
    ]) {
      for (const f of [349.2, 440, 523.3]) {
        const osc = tone(k, 'sawtooth', f, start, 0.07, hold, 0.12, 2400);
        osc.frequency.setValueAtTime(f * 0.92, k.t0 + start);
        osc.frequency.exponentialRampToValueAtTime(f, k.t0 + start + 0.06);
      }
    }
  },
  rimshot: (k) => {
    drum(k, 0, 200, 110, 0.5);
    drum(k, 0.17, 150, 80, 0.55);
    burst(k, 0.42, 0.28, 1.1, 'highpass', 7000, 0.6);
    burst(k, 0.42, 0.12, 0.5, 'bandpass', 10000, 1.2);
  },
  bell: (k) => {
    const f = 660;
    const partials: Array<[number, number, number]> = [
      [1, 0.22, 2.6],
      [2.76, 0.1, 1.6],
      [5.4, 0.05, 0.9],
      [8.93, 0.03, 0.5],
    ];
    for (const [ratio, peak, release] of partials) tone(k, 'sine', f * ratio, 0, peak, 0.005, release);
  },
  clap: (k) => {
    let t = 0;
    for (let i = 0; i < 14; i++) {
      // várias pessoas batendo palma, fora de compasso
      t += 0.06 + Math.random() * 0.1;
      burst(k, t, 0.35 + Math.random() * 0.2, 0.09, 'bandpass', 1100 + Math.random() * 900, 1.4);
    }
  },
  alarm: (k) => {
    for (let i = 0; i < 8; i++) tone(k, 'square', i % 2 ? 660 : 880, i * 0.19, 0.06, 0.15, 0.03, 3000);
  },
  sad: (k) => {
    const notes: Array<[number, number, number]> = [
      [392, 0, 0.32],
      [370, 0.42, 0.32],
      [349.2, 0.84, 0.32],
      [329.6, 1.26, 1.1],
    ];
    for (const [f, start, hold] of notes) {
      const osc = tone(k, 'sawtooth', f, start, 0.09, hold, 0.15, 1400);
      if (hold > 0.5) {
        // o último "uóóóóm" treme
        const lfo = k.ctx.createOscillator();
        lfo.frequency.value = 6;
        const depth = k.ctx.createGain();
        depth.gain.value = 9;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(k.t0 + start);
        lfo.stop(k.t0 + start + hold + 0.2);
      }
    }
  },
  boing: (k) => {
    const osc = tone(k, 'sine', 140, 0, 0.35, 0.05, 0.75);
    osc.frequency.setValueAtTime(140, k.t0);
    osc.frequency.exponentialRampToValueAtTime(520, k.t0 + 0.12);
    const lfo = k.ctx.createOscillator();
    lfo.frequency.value = 14;
    const depth = k.ctx.createGain();
    depth.gain.setValueAtTime(120, k.t0);
    depth.gain.exponentialRampToValueAtTime(1, k.t0 + 0.8);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(k.t0);
    lfo.stop(k.t0 + 0.9);
  },
  tada: (k) => {
    for (const f of [523.3, 659.3, 784]) tone(k, 'sawtooth', f, 0, 0.05, 0.1, 0.08, 3200);
    for (const f of [523.3, 659.3, 784, 1046.5]) tone(k, 'sawtooth', f, 0.2, 0.05, 0.75, 0.5, 3200);
    burst(k, 0.2, 0.15, 1, 'highpass', 6000, 0.7);
  },
};

/** Toca um som do soundboard na saída de áudio escolhida (e na gravação, se houver). */
export function playSoundboard(id: SoundId) {
  try {
    const ctx = playbackContext();
    RECIPES[id]({ ctx, out: soundBus(), t0: ctx.currentTime + 0.02 });
  } catch (err) {
    console.warn('[soundboard]', err);
  }
}
