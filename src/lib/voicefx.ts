import pitchWorkletUrl from './pitch.worklet.js?url&no-inline';

/**
 * Efeitos de voz: aplicados depois do portão (o detector de voz continua ouvindo a voz limpa),
 * só no que sai para a chamada. Tudo em Web Audio, sem bibliotecas.
 */

export type VoiceEffect = 'none' | 'robot' | 'deep' | 'high' | 'cave' | 'radio';

export const VOICE_EFFECTS: Array<{ id: VoiceEffect; label: string; emoji: string }> = [
  { id: 'none', label: 'Normal', emoji: '🙂' },
  { id: 'robot', label: 'Robô', emoji: '🤖' },
  { id: 'deep', label: 'Voz grossa', emoji: '🐻' },
  { id: 'high', label: 'Voz fina', emoji: '🐿️' },
  { id: 'cave', label: 'Caverna', emoji: '🕳️' },
  { id: 'radio', label: 'Rádio', emoji: '📻' },
];

export const validEffect = (value: unknown): VoiceEffect => (VOICE_EFFECTS.some((e) => e.id === value) ? (value as VoiceEffect) : 'none');

export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
}

const pitchLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function loadPitch(ctx: BaseAudioContext): Promise<void> {
  let p = pitchLoaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(pitchWorkletUrl);
    pitchLoaded.set(ctx, p);
    p.catch(() => pitchLoaded.delete(ctx));
  }
  return p;
}

/** Eco de caverna: ruído que decai, como uma sala grande. */
function caveImpulse(ctx: BaseAudioContext): AudioBuffer {
  const seconds = 2.2;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff) * 2 - 1;
    data[i] = noise * Math.pow(1 - i / length, 2.6);
  }
  return buffer;
}

function softClip(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
  }
  return curve;
}

/** Monta a cadeia do efeito (null = voz normal). */
export async function createEffect(ctx: AudioContext, effect: VoiceEffect): Promise<EffectChain | null> {
  const nodes: AudioNode[] = [];
  const sources: Array<OscillatorNode | ConstantSourceNode> = [];
  const track = <T extends AudioNode>(node: T) => {
    nodes.push(node);
    return node;
  };
  const dispose = () => {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* já parado */
      }
    }
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* já desligado */
      }
    }
  };

  switch (effect) {
    case 'robot': {
      // pente metálico curto + modulação em anel (a voz "de lata")
      const input = track(ctx.createGain());
      const comb = track(ctx.createDelay(0.05));
      comb.delayTime.value = 0.009;
      const feedback = track(ctx.createGain());
      feedback.gain.value = 0.55;
      const ring = track(ctx.createGain());
      ring.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 50;
      const depth = track(ctx.createGain());
      depth.gain.value = 0.9;
      osc.connect(depth).connect(ring.gain);
      osc.start();
      sources.push(osc);
      nodes.push(osc);
      const output = track(ctx.createGain());
      output.gain.value = 1.1;
      input.connect(comb);
      comb.connect(feedback).connect(comb);
      input.connect(ring);
      comb.connect(ring);
      ring.connect(output);
      return { input, output, dispose };
    }
    case 'deep':
    case 'high': {
      await loadPitch(ctx);
      const input = track(ctx.createGain());
      const shifter = track(
        new AudioWorkletNode(ctx, 'orbita-pitch', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          outputChannelCount: [1],
          processorOptions: { ratio: effect === 'deep' ? 0.72 : 1.45 },
        }),
      );
      const tone = track(ctx.createBiquadFilter());
      // voz grossa ganha corpo nos graves; a fina perde um pouco de chiado
      tone.type = effect === 'deep' ? 'lowshelf' : 'highshelf';
      tone.frequency.value = effect === 'deep' ? 250 : 6000;
      tone.gain.value = effect === 'deep' ? 4 : -4;
      // a mistura das duas leituras perde um pouco de volume: compensa
      const makeup = track(ctx.createGain());
      makeup.gain.value = 1.3;
      input.connect(shifter).connect(tone).connect(makeup);
      return { input, output: makeup, dispose };
    }
    case 'cave': {
      const input = track(ctx.createGain());
      const output = track(ctx.createGain());
      const dry = track(ctx.createGain());
      dry.gain.value = 0.85;
      const reverb = track(ctx.createConvolver());
      reverb.buffer = caveImpulse(ctx);
      const wet = track(ctx.createGain());
      wet.gain.value = 0.55;
      const echo = track(ctx.createDelay(1));
      echo.delayTime.value = 0.3;
      const echoBack = track(ctx.createGain());
      echoBack.gain.value = 0.35;
      const echoOut = track(ctx.createGain());
      echoOut.gain.value = 0.4;
      input.connect(dry).connect(output);
      input.connect(reverb).connect(wet).connect(output);
      input.connect(echo);
      echo.connect(echoBack).connect(echo);
      echo.connect(echoOut).connect(output);
      return { input, output, dispose };
    }
    case 'radio': {
      const input = track(ctx.createBiquadFilter());
      input.type = 'highpass';
      input.frequency.value = 450;
      input.Q.value = 0.9;
      const low = track(ctx.createBiquadFilter());
      low.type = 'lowpass';
      low.frequency.value = 3000;
      low.Q.value = 0.9;
      const mid = track(ctx.createBiquadFilter());
      mid.type = 'peaking';
      mid.frequency.value = 1600;
      mid.gain.value = 7;
      const drive = track(ctx.createWaveShaper());
      drive.curve = softClip(6);
      drive.oversample = '2x';
      const output = track(ctx.createGain());
      output.gain.value = 0.8;
      input.connect(low).connect(mid).connect(drive).connect(output);
      return { input, output, dispose };
    }
    default:
      return null;
  }
}
