import gateWorkletUrl from './gate.worklet.js?url&no-inline';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import type { NoiseFilter, Settings } from './storage';

/**
 * Filtros do microfone, todos no navegador (Web Audio):
 *
 *   microfone → volume → corte de graves → supressão de ruído (IA) → compressor → portão → envio
 *
 * O portão também é o detector de voz: diz quando a pessoa está falando (o anel verde).
 * Eco e ganho automático continuam sendo os do navegador (são aplicados na captura).
 */

export interface VoiceOptions {
  noiseFilter: NoiseFilter;
  highpass: boolean;
  compressor: boolean;
  noiseGate: boolean;
  /** % (100 = sem alteração). */
  inputGain: number;
  /** 0..1 na escala do medidor (modo manual). */
  threshold: number;
  /** O limiar acompanha sozinho o ruído de fundo. */
  autoThreshold: boolean;
}

export const voiceOptions = (s: Settings): VoiceOptions => ({
  noiseFilter: s.noiseFilter,
  highpass: s.highpass,
  compressor: s.compressor,
  noiseGate: s.noiseGate,
  inputGain: s.inputGain,
  threshold: s.vadThreshold,
  autoThreshold: s.vadAuto,
});

/** Com supressão por IA, a do navegador fica desligada (as duas juntas deixam a voz robótica). */
export const browserNoiseSuppression = (filter: NoiseFilter) => filter === 'browser';

type Suppressor = AudioWorkletNode & { destroy?: () => void };
type AiFilter = 'rnnoise' | 'gtcrn';

const wasm: Partial<Record<AiFilter, Promise<ArrayBuffer>>> = {};
const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

function addModule(ctx: BaseAudioContext, url: string): Promise<void> {
  let loaded = modules.get(ctx);
  if (!loaded) modules.set(ctx, (loaded = new Map()));
  let promise = loaded.get(url);
  if (!promise) {
    promise = ctx.audioWorklet.addModule(url);
    loaded.set(url, promise);
    promise.catch(() => loaded?.delete(url));
  }
  return promise;
}

async function createSuppressor(ctx: AudioContext, kind: AiFilter): Promise<Suppressor> {
  const lib = await import('@sapphi-red/web-noise-suppressor');
  if (kind === 'rnnoise') {
    const binary = (wasm.rnnoise ??= lib.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdUrl }));
    binary.catch(() => delete wasm.rnnoise);
    const [wasmBinary] = await Promise.all([binary, addModule(ctx, rnnoiseWorkletUrl)]);
    return new lib.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
  }
  const binary = (wasm.gtcrn ??= lib.loadGtcrn({ url: gtcrnWasmUrl }));
  binary.catch(() => delete wasm.gtcrn);
  const [wasmBinary] = await Promise.all([binary, addModule(ctx, gtcrnWorkletUrl)]);
  return new lib.GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary });
}

export class VoiceProcessor {
  /** A faixa processada: é ela que vai para a chamada. */
  readonly track: MediaStreamTrack;
  speaking = false;
  level = 0;
  /** Limiar em uso agora (o automático muda com o ruído de fundo). */
  threshold = 0;
  /** O filtro de IA pedido não carregou (sem internet, navegador antigo…). */
  suppressorFailed = false;
  onSpeaking: (on: boolean) => void = () => {};
  onLevel: (level: number, threshold: number) => void = () => {};

  private source: MediaStreamAudioSourceNode;
  private gain: GainNode;
  private highpass: BiquadFilterNode;
  private compressor: DynamicsCompressorNode;
  private gate: AudioWorkletNode;
  private dest: MediaStreamAudioDestinationNode;
  private suppressor: Suppressor | null = null;
  private suppressorKind: AiFilter | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  private constructor(
    private ctx: AudioContext,
    readonly input: MediaStreamTrack,
    private opts: VoiceOptions,
  ) {
    this.source = ctx.createMediaStreamSource(new MediaStream([input]));
    this.gain = ctx.createGain();
    this.gain.gain.value = opts.inputGain / 100;
    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 100;
    this.highpass.Q.value = 0.7;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -28;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.22;
    this.gate = new AudioWorkletNode(ctx, 'orbita-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    this.threshold = opts.threshold;
    this.gate.port.postMessage({ threshold: opts.threshold, gate: opts.noiseGate, auto: opts.autoThreshold });
    this.gate.port.onmessage = (e: MessageEvent<{ speaking?: boolean; level?: number; threshold?: number }>) => {
      if (typeof e.data.speaking === 'boolean' && e.data.speaking !== this.speaking) {
        this.speaking = e.data.speaking;
        this.onSpeaking(this.speaking);
      }
      if (typeof e.data.level === 'number') {
        this.level = e.data.level;
        if (typeof e.data.threshold === 'number') this.threshold = e.data.threshold;
        this.onLevel(this.level, this.threshold);
      }
    };
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.gate.connect(this.dest);
    this.track = this.dest.stream.getAudioTracks()[0];
  }

  static async create(input: MediaStreamTrack, opts: VoiceOptions): Promise<VoiceProcessor> {
    const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    try {
      await addModule(ctx, gateWorkletUrl);
      const processor = new VoiceProcessor(ctx, input, opts);
      await processor.applySuppressor();
      processor.wire();
      processor.resume();
      return processor;
    } catch (err) {
      void ctx.close().catch(() => {});
      throw err;
    }
  }

  /** Troca os filtros sem reabrir o microfone. */
  update(opts: VoiceOptions): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      this.opts = opts;
      this.gain.gain.setTargetAtTime(opts.inputGain / 100, this.ctx.currentTime, 0.03);
      this.gate.port.postMessage({ threshold: opts.threshold, gate: opts.noiseGate, auto: opts.autoThreshold });
      await this.applySuppressor();
      this.wire();
    });
    return this.queue;
  }

  /** O navegador só deixa o áudio rodar depois de um clique ou tecla na página. */
  resume() {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  get running() {
    return this.ctx.state === 'running';
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.gate.port.onmessage = null;
    this.suppressor?.destroy?.();
    this.track.stop();
    void this.ctx.close().catch(() => {});
    if (this.speaking) this.onSpeaking(false);
  }

  private async applySuppressor() {
    const want: AiFilter | null = this.opts.noiseFilter === 'rnnoise' || this.opts.noiseFilter === 'gtcrn' ? this.opts.noiseFilter : null;
    if (want === this.suppressorKind && (want === null || this.suppressor)) return;
    const old = this.suppressor;
    let next: Suppressor | null = null;
    this.suppressorFailed = false;
    if (want) {
      try {
        next = await createSuppressor(this.ctx, want);
      } catch (err) {
        console.warn('[voz] supressão de ruído indisponível', err);
        this.suppressorFailed = true;
      }
    }
    if (this.stopped) {
      next?.destroy?.();
      return;
    }
    this.suppressor = next;
    this.suppressorKind = next ? want : null;
    if (old) {
      try {
        old.disconnect();
      } catch {
        /* já desligado */
      }
      old.destroy?.();
    }
  }

  /** (Re)liga os nós na ordem certa, pulando os filtros desligados. */
  private wire() {
    for (const node of [this.source, this.gain, this.highpass, this.suppressor, this.compressor]) {
      try {
        node?.disconnect();
      } catch {
        /* não estava ligado */
      }
    }
    const chain: AudioNode[] = [this.gain];
    if (this.opts.highpass) chain.push(this.highpass);
    if (this.suppressor) chain.push(this.suppressor);
    if (this.opts.compressor) chain.push(this.compressor);
    chain.push(this.gate);
    let tail: AudioNode = this.source;
    for (const node of chain) {
      tail.connect(node);
      tail = node;
    }
  }
}
