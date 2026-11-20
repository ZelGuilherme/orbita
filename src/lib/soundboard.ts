import { SOUND_IDS, type SoundId } from './config';
import { playbackContext, soundBus } from './playback';

/**
 * Soundboard: sons curtos gerados na hora pelo próprio Órbita (sem arquivos de áudio).
 * Ninguém transmite o som: quem aperta manda só o nome dele e cada um toca o seu,
 * então quem desligou "ouvir os sons dos outros" simplesmente não toca.
 *
 * Cada som passa por um compressor (volume parelho) e uma reverberação curta (dá espaço);
 * os timbres usam camadas levemente desafinadas e filtros que abrem e fecham, para soarem
 * mais "de verdade" do que um tom puro.
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
  drumroll: { label: 'Rufar', emoji: '🪘' },
  laser: { label: 'Laser', emoji: '🔫' },
  coin: { label: 'Moeda', emoji: '🪙' },
  error: { label: 'Erro', emoji: '❌' },
  win: { label: 'Vitória', emoji: '🏆' },
  cricket: { label: 'Grilos', emoji: '🦗' },
  gong: { label: 'Gongo', emoji: '🔆' },
  boom: { label: 'Explosão', emoji: '💥' },
};

export const SOUND_LIST = SOUND_IDS.map((id) => ({ id, ...SOUNDS[id] }));

export const validSound = (value: unknown): value is SoundId => typeof value === 'string' && (SOUND_IDS as readonly string[]).includes(value);

// ───────────────────────── infraestrutura ─────────────────────────

let noise: AudioBuffer | null = null;
let chain: { ctx: BaseAudioContext; input: GainNode } | null = null;

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise = buffer;
  return buffer;
}

/** Sala pequena: ruído que decai rápido (dá corpo sem embolar). */
function roomImpulse(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 1.1);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
  }
  return buffer;
}

/** Entrada comum de todos os sons: compressor + reverberação, saindo no soundBus. */
function master(ctx: AudioContext): GainNode {
  if (chain?.ctx === ctx) return chain.input;
  const input = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.18;
  const verb = ctx.createConvolver();
  verb.buffer = roomImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  input.connect(comp);
  comp.connect(soundBus());
  comp.connect(verb).connect(wet).connect(soundBus());
  chain = { ctx, input };
  return input;
}

interface Kit {
  ctx: BaseAudioContext;
  out: AudioNode;
  t0: number;
}

/** Envelope: sobe rápido, segura e cai até sumir. */
function env(k: Kit, gain: GainNode, start: number, peak: number, hold: number, release: number, attack = 0.008) {
  const g = gain.gain;
  const t = k.t0 + start;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(peak, t + attack);
  g.setValueAtTime(peak, t + attack + hold);
  g.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
}

interface ToneOpts {
  type?: OscillatorType;
  peak?: number;
  hold?: number;
  release?: number;
  attack?: number;
  /** Filtro passa-baixa (Hz) e, opcional, para onde ele vai no fim (abre/fecha). */
  cutoff?: number;
  cutoffTo?: number;
  q?: number;
  /** Camadas desafinadas (cents) para o som ficar "largo". */
  detune?: number[];
  /** Vibrato: velocidade (Hz) e profundidade (cents). */
  vibrato?: [number, number];
  /** Frequência final (desliza). */
  to?: number;
  slide?: number;
}

/** Uma nota (com camadas, filtro, vibrato e deslize). Devolve os osciladores. */
function tone(k: Kit, freq: number, start: number, o: ToneOpts = {}): OscillatorNode[] {
  const { type = 'sine', peak = 0.2, hold = 0.05, release = 0.3, attack = 0.008, detune = [0] } = o;
  const gain = k.ctx.createGain();
  env(k, gain, start, peak / detune.length, hold, release, attack);
  let tail: AudioNode = gain;
  if (o.cutoff) {
    const lp = k.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = o.q ?? 0.8;
    lp.frequency.setValueAtTime(o.cutoff, k.t0 + start);
    if (o.cutoffTo) lp.frequency.exponentialRampToValueAtTime(o.cutoffTo, k.t0 + start + attack + hold + release);
    gain.connect(lp);
    tail = lp;
  }
  tail.connect(k.out);
  const end = k.t0 + start + attack + hold + release + 0.05;
  return detune.map((cents) => {
    const osc = k.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, k.t0 + start);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, k.t0 + start + (o.slide ?? attack + hold + release));
    osc.detune.value = cents;
    if (o.vibrato) {
      const lfo = k.ctx.createOscillator();
      lfo.frequency.value = o.vibrato[0];
      const depth = k.ctx.createGain();
      depth.gain.value = o.vibrato[1];
      lfo.connect(depth).connect(osc.detune);
      lfo.start(k.t0 + start);
      lfo.stop(end);
    }
    osc.connect(gain);
    osc.start(k.t0 + start);
    osc.stop(end);
    return osc;
  });
}

/** Rajada de ruído filtrado (palmas, pratos, caixa, explosão). */
function burst(k: Kit, start: number, peak: number, release: number, type: BiquadFilterType, freq: number, q = 1, freqTo?: number) {
  const src = k.ctx.createBufferSource();
  src.buffer = noiseBuffer(k.ctx);
  const filter = k.ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, k.t0 + start);
  if (freqTo) filter.frequency.exponentialRampToValueAtTime(freqTo, k.t0 + start + release);
  filter.Q.value = q;
  const gain = k.ctx.createGain();
  env(k, gain, start, peak, 0.002, release, 0.002);
  src.connect(filter).connect(gain).connect(k.out);
  src.start(k.t0 + start, Math.random());
  src.stop(k.t0 + start + release + 0.05);
}

/** Tambor: seno que despenca de tom + "pele" de ruído. */
function drum(k: Kit, start: number, from: number, to: number, peak: number) {
  tone(k, from, start, { peak, hold: 0.005, release: 0.28, to, slide: 0.12 });
  burst(k, start, peak * 0.35, 0.06, 'bandpass', 1800, 0.9);
}

/** Caixa: corpo curto + esteira de ruído. */
function snare(k: Kit, start: number, peak: number) {
  tone(k, 220, start, { type: 'triangle', peak: peak * 0.6, hold: 0.004, release: 0.09, to: 160, slide: 0.08 });
  burst(k, start, peak, 0.16, 'highpass', 1800, 0.7);
}

/** Prato: vários quadrados agudos desafinados (metálico) + chiado. */
function cymbal(k: Kit, start: number, peak: number, release: number) {
  for (const f of [3150, 4210, 5320, 6870, 8340]) tone(k, f, start, { type: 'square', peak: peak * 0.05, hold: 0.002, release, cutoff: 12000 });
  burst(k, start, peak * 0.6, release, 'highpass', 6500, 0.6);
}

// ───────────────────────── os sons ─────────────────────────

const RECIPES: Record<SoundId, (k: Kit) => void> = {
  horn: (k) => {
    // buzina de estádio: acorde de dentes-de-serra largos, com "ataque" que sobe de tom
    for (const [start, hold] of [
      [0, 0.16],
      [0.26, 0.85],
    ]) {
      for (const f of [349.2, 440, 523.3]) {
        tone(k, f * 0.94, start, { type: 'sawtooth', peak: 0.16, hold, release: 0.12, attack: 0.02, to: f, slide: 0.06, cutoff: 1800, cutoffTo: 2600, q: 2, detune: [-9, 0, 9] });
      }
    }
  },
  rimshot: (k) => {
    drum(k, 0, 190, 105, 0.55);
    drum(k, 0.17, 150, 82, 0.6);
    snare(k, 0.17, 0.25);
    cymbal(k, 0.42, 0.55, 1.3);
  },
  bell: (k) => {
    // sino: parciais inarmônicas, as agudas somem antes
    const f = 659.3;
    const partials: Array<[number, number, number]> = [
      [0.5, 0.06, 3],
      [1, 0.2, 2.8],
      [1.19, 0.08, 2],
      [2.0, 0.07, 1.4],
      [2.76, 0.07, 1.1],
      [5.4, 0.04, 0.6],
      [8.93, 0.025, 0.35],
    ];
    for (const [ratio, peak, release] of partials) tone(k, f * ratio, 0, { peak, hold: 0.004, release, attack: 0.002, detune: [-2, 2] });
  },
  clap: (k) => {
    // várias pessoas batendo palma; cada palma são 3 estalinhos colados (como uma palma de verdade)
    let t = 0;
    for (let i = 0; i < 16; i++) {
      t += 0.05 + Math.random() * 0.09;
      const f = 1000 + Math.random() * 900;
      const p = 0.28 + Math.random() * 0.2;
      for (let s = 0; s < 3; s++) burst(k, t + s * 0.009, p * (s === 2 ? 1 : 0.6), s === 2 ? 0.12 : 0.012, 'bandpass', f, 1.6);
    }
  },
  alarm: (k) => {
    for (let i = 0; i < 8; i++) {
      tone(k, i % 2 ? 660 : 880, i * 0.19, { type: 'square', peak: 0.1, hold: 0.15, release: 0.03, attack: 0.004, cutoff: 3200, vibrato: [18, 25] });
    }
  },
  sad: (k) => {
    // "uóm uóm uóm uóóóóm": cada nota com o filtro abrindo e fechando (a surdina do trombone)
    const notes: Array<[number, number, number]> = [
      [392, 0, 0.3],
      [370, 0.42, 0.3],
      [349.2, 0.84, 0.3],
      [329.6, 1.26, 1.15],
    ];
    for (const [f, start, hold] of notes) {
      tone(k, f, start, { type: 'sawtooth', peak: 0.18, hold, release: 0.18, attack: 0.04, cutoff: 500, cutoffTo: 1500, q: 4, detune: [-6, 6], vibrato: hold > 0.5 ? [5.5, 35] : undefined });
    }
  },
  boing: (k) => {
    const [osc] = tone(k, 140, 0, { peak: 0.4, hold: 0.05, release: 0.8, to: 520, slide: 0.12 });
    const lfo = k.ctx.createOscillator();
    lfo.frequency.value = 14;
    const depth = k.ctx.createGain();
    depth.gain.setValueAtTime(120, k.t0);
    depth.gain.exponentialRampToValueAtTime(1, k.t0 + 0.85);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(k.t0);
    lfo.stop(k.t0 + 0.95);
  },
  tada: (k) => {
    // metais: curto e depois o acorde longo, com o filtro abrindo
    for (const f of [523.3, 659.3, 784]) tone(k, f, 0, { type: 'sawtooth', peak: 0.1, hold: 0.08, release: 0.06, cutoff: 1500, cutoffTo: 3500, detune: [-7, 7] });
    for (const f of [523.3, 659.3, 784, 1046.5]) tone(k, f, 0.2, { type: 'sawtooth', peak: 0.1, hold: 0.7, release: 0.5, attack: 0.03, cutoff: 1200, cutoffTo: 4200, detune: [-8, 0, 8], vibrato: [5, 12] });
    cymbal(k, 0.2, 0.4, 1.4);
  },
  drumroll: (k) => {
    // rufar crescendo que termina num prato
    const total = 1.6;
    for (let t = 0; t < total; t += 0.045) snare(k, t, 0.06 + (t / total) * 0.22);
    drum(k, total, 120, 70, 0.6);
    cymbal(k, total, 0.6, 1.6);
  },
  laser: (k) => {
    for (let i = 0; i < 3; i++) tone(k, 2400, i * 0.16, { type: 'square', peak: 0.2, hold: 0.02, release: 0.14, to: 300, slide: 0.15, cutoff: 5000, detune: [-12, 12] });
  },
  coin: (k) => {
    tone(k, 987.8, 0, { type: 'square', peak: 0.15, hold: 0.06, release: 0.02, attack: 0.002, cutoff: 6000 });
    tone(k, 1318.5, 0.08, { type: 'square', peak: 0.15, hold: 0.2, release: 0.35, attack: 0.002, cutoff: 6000 });
  },
  error: (k) => {
    tone(k, 220, 0, { type: 'sawtooth', peak: 0.12, hold: 0.18, release: 0.05, cutoff: 1200, detune: [-15, 15] });
    tone(k, 155.6, 0.26, { type: 'sawtooth', peak: 0.14, hold: 0.42, release: 0.12, cutoff: 1000, detune: [-15, 15] });
  },
  win: (k) => {
    // arpejo subindo e acorde final com brilho
    const notes = [523.3, 659.3, 784, 1046.5, 1318.5];
    notes.forEach((f, i) => tone(k, f, i * 0.09, { type: 'triangle', peak: 0.16, hold: 0.06, release: 0.25, detune: [-5, 5] }));
    for (const f of [523.3, 659.3, 784, 1046.5]) tone(k, f, 0.5, { type: 'sawtooth', peak: 0.07, hold: 0.6, release: 0.6, cutoff: 2500, detune: [-8, 8], vibrato: [6, 10] });
    cymbal(k, 0.5, 0.3, 1.2);
  },
  cricket: (k) => {
    // grilos no silêncio constrangedor: trinados agudos em grupos
    for (let g = 0; g < 4; g++) {
      for (let c = 0; c < 4; c++) tone(k, 4600 + (g % 2) * 300, g * 0.42 + c * 0.04, { peak: 0.13, hold: 0.012, release: 0.02, attack: 0.003 });
    }
  },
  gong: (k) => {
    // gongo: parciais graves que "florescem" devagar e vibram juntas
    const f = 98;
    for (const [ratio, peak] of [
      [1, 0.25],
      [1.48, 0.12],
      [2.03, 0.1],
      [2.74, 0.07],
      [3.6, 0.05],
      [4.9, 0.03],
    ] as Array<[number, number]>) {
      tone(k, f * ratio, 0, { peak, hold: 0.05, release: 3.2, attack: 0.06, detune: [-4, 4], vibrato: [3, 6] });
    }
    burst(k, 0, 0.2, 0.25, 'lowpass', 900, 0.7);
  },
  boom: (k) => {
    // explosão: estalo + ruído grave que se fecha devagar + sub
    burst(k, 0, 0.8, 0.08, 'highpass', 2000, 0.5);
    burst(k, 0, 0.9, 1.6, 'lowpass', 2200, 0.8, 120);
    tone(k, 70, 0, { peak: 0.6, hold: 0.05, release: 1, to: 32, slide: 0.9 });
  },
};

/** Desenha um som numa saída qualquer (os testes usam um contexto sem caixa de som). */
export function renderSound(ctx: BaseAudioContext, out: AudioNode, id: SoundId, t0 = 0.02) {
  RECIPES[id]({ ctx, out, t0 });
}

/** Toca um som do soundboard na saída de áudio escolhida (e na gravação, se houver). */
export function playSoundboard(id: SoundId) {
  try {
    const ctx = playbackContext();
    RECIPES[id]({ ctx, out: master(ctx), t0: ctx.currentTime + 0.02 });
  } catch (err) {
    console.warn('[soundboard]', err);
  }
}
