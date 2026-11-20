import pitchWorkletUrl from './pitch.worklet.js?url&no-inline';

/**
 * Efeitos de voz: aplicados depois do portão (o detector de voz continua ouvindo a voz limpa),
 * só no que sai para a chamada. Tudo em Web Audio, sem bibliotecas.
 */

export type VoiceEffect = 'none' | 'robot' | 'deep' | 'high' | 'cave' | 'radio' | 'alien' | 'monster' | 'megaphone' | 'ghost' | 'choir' | 'stadium';

export const VOICE_EFFECTS: Array<{ id: VoiceEffect; label: string; emoji: string }> = [
  { id: 'none', label: 'Normal', emoji: '🙂' },
  { id: 'robot', label: 'Robô', emoji: '🤖' },
  { id: 'deep', label: 'Voz grossa', emoji: '🐻' },
  { id: 'high', label: 'Voz fina', emoji: '🐿️' },
  { id: 'cave', label: 'Caverna', emoji: '🕳️' },
  { id: 'radio', label: 'Rádio', emoji: '📻' },
  { id: 'alien', label: 'Alienígena', emoji: '👽' },
  { id: 'monster', label: 'Monstro', emoji: '👹' },
  { id: 'megaphone', label: 'Megafone', emoji: '📢' },
  { id: 'ghost', label: 'Fantasma', emoji: '👻' },
  { id: 'choir', label: 'Coral', emoji: '🎶' },
  { id: 'stadium', label: 'Estádio', emoji: '🏟️' },
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

/** Eco de sala enorme (estádio): cauda longa e espaçada. */
function hallImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 7654321;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = ((seed / 0x7fffffff) * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
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
    case 'alien':
    case 'monster': {
      // alienígena: mais agudo + modulação metálica; monstro: bem grave, rouco e encorpado
      await loadPitch(ctx);
      const alien = effect === 'alien';
      const input = track(ctx.createGain());
      const shifter = track(
        new AudioWorkletNode(ctx, 'orbita-pitch', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          outputChannelCount: [1],
          processorOptions: { ratio: alien ? 1.32 : 0.58 },
        }),
      );
      const output = track(ctx.createGain());
      output.gain.value = alien ? 1.3 : 0.4;
      input.connect(shifter);
      if (alien) {
        // anel suave: metade da voz modulada por um seno, a outra metade limpa
        const ring = track(ctx.createGain());
        ring.gain.value = 0;
        const osc = ctx.createOscillator();
        osc.frequency.value = 38;
        const depth = track(ctx.createGain());
        depth.gain.value = 1;
        osc.connect(depth).connect(ring.gain);
        osc.start();
        sources.push(osc);
        nodes.push(osc);
        const dry = track(ctx.createGain());
        dry.gain.value = 0.55;
        shifter.connect(ring).connect(output);
        shifter.connect(dry).connect(output);
      } else {
        const drive = track(ctx.createWaveShaper());
        drive.curve = softClip(3.5);
        drive.oversample = '2x';
        const body = track(ctx.createBiquadFilter());
        body.type = 'lowshelf';
        body.frequency.value = 220;
        body.gain.value = 7;
        const tame = track(ctx.createBiquadFilter());
        tame.type = 'lowpass';
        tame.frequency.value = 3200;
        shifter.connect(drive).connect(body).connect(tame).connect(output);
      }
      return { input, output, dispose };
    }
    case 'megaphone': {
      // megafone: faixa estreita, bem saturada e estourada
      const input = track(ctx.createBiquadFilter());
      input.type = 'highpass';
      input.frequency.value = 650;
      input.Q.value = 1.2;
      const low = track(ctx.createBiquadFilter());
      low.type = 'lowpass';
      low.frequency.value = 3800;
      low.Q.value = 1.4;
      const honk = track(ctx.createBiquadFilter());
      honk.type = 'peaking';
      honk.frequency.value = 2100;
      honk.Q.value = 1.5;
      honk.gain.value = 9;
      const pre = track(ctx.createGain());
      pre.gain.value = 3;
      const drive = track(ctx.createWaveShaper());
      drive.curve = softClip(14);
      drive.oversample = '4x';
      const output = track(ctx.createGain());
      output.gain.value = 0.55;
      input.connect(low).connect(honk).connect(pre).connect(drive).connect(output);
      return { input, output, dispose };
    }
    case 'ghost': {
      // fantasma: voz trêmula e oscilando de tom, afogada num eco longo e escuro
      await loadPitch(ctx);
      const input = track(ctx.createGain());
      const shifter = track(
        new AudioWorkletNode(ctx, 'orbita-pitch', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
          outputChannelCount: [1],
          processorOptions: { ratio: 1.08 },
        }),
      );
      const trem = track(ctx.createGain());
      trem.gain.value = 0.75;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      const lfoDepth = track(ctx.createGain());
      lfoDepth.gain.value = 0.25;
      lfo.connect(lfoDepth).connect(trem.gain);
      lfo.start();
      sources.push(lfo);
      nodes.push(lfo);
      const verb = track(ctx.createConvolver());
      verb.buffer = hallImpulse(ctx, 3.2, 2.2);
      const dark = track(ctx.createBiquadFilter());
      dark.type = 'lowpass';
      dark.frequency.value = 2600;
      const wet = track(ctx.createGain());
      wet.gain.value = 1.6;
      const dry = track(ctx.createGain());
      dry.gain.value = 0.9;
      const output = track(ctx.createGain());
      output.gain.value = 1.6;
      input.connect(shifter).connect(trem);
      trem.connect(dry).connect(output);
      trem.connect(verb).connect(dark).connect(wet).connect(output);
      return { input, output, dispose };
    }
    case 'choir': {
      // coral: três "vozes" levemente atrasadas e desafinadas (chorus), cada uma oscilando
      const input = track(ctx.createGain());
      const output = track(ctx.createGain());
      output.gain.value = 0.75;
      const dry = track(ctx.createGain());
      dry.gain.value = 0.7;
      input.connect(dry).connect(output);
      [
        [0.021, 0.33],
        [0.029, 0.52],
        [0.037, 0.71],
      ].forEach(([delay, rate], i) => {
        const d = track(ctx.createDelay(0.1));
        d.delayTime.value = delay;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const depth = track(ctx.createGain());
        depth.gain.value = 0.004 + i * 0.001;
        lfo.connect(depth).connect(d.delayTime);
        lfo.start();
        sources.push(lfo);
        nodes.push(lfo);
        const g = track(ctx.createGain());
        g.gain.value = 0.5;
        input.connect(d).connect(g).connect(output);
      });
      const verb = track(ctx.createConvolver());
      verb.buffer = hallImpulse(ctx, 1.8, 3);
      const wet = track(ctx.createGain());
      wet.gain.value = 0.3;
      input.connect(verb).connect(wet).connect(output);
      return { input, output, dispose };
    }
    case 'stadium': {
      // estádio: ecos espaçados que voltam do outro lado e uma cauda enorme
      const input = track(ctx.createGain());
      const output = track(ctx.createGain());
      const dry = track(ctx.createGain());
      dry.gain.value = 0.8;
      const echo = track(ctx.createDelay(1.5));
      echo.delayTime.value = 0.42;
      const back = track(ctx.createGain());
      back.gain.value = 0.38;
      const echoTone = track(ctx.createBiquadFilter());
      echoTone.type = 'bandpass';
      echoTone.frequency.value = 1300;
      echoTone.Q.value = 0.6;
      const echoOut = track(ctx.createGain());
      echoOut.gain.value = 0.55;
      const verb = track(ctx.createConvolver());
      verb.buffer = hallImpulse(ctx, 4, 1.6);
      const wet = track(ctx.createGain());
      wet.gain.value = 0.45;
      input.connect(dry).connect(output);
      input.connect(echo);
      echo.connect(echoTone).connect(back).connect(echo);
      echoTone.connect(echoOut).connect(output);
      input.connect(verb).connect(wet).connect(output);
      return { input, output, dispose };
    }
    default:
      return null;
  }
}
