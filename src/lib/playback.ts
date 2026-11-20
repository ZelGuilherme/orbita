/**
 * Volume acima de 100% (até 300%) para vozes e lives.
 *
 * O elemento <audio> só vai até 100%. Acima disso, o som passa pelo Web Audio:
 * fonte → ganho → limitador → saída escolhida. Até 100% o caminho continua sendo o <audio>
 * de sempre, porque é o som que o navegador consegue tirar por completo da captura da tela
 * inteira (restrictOwnAudio); o som do Web Audio sai só atenuado dessa captura.
 *
 * O Chrome só entrega o áudio de uma conexão WebRTC ao Web Audio se o stream também estiver
 * preso a um elemento de mídia, então o <audio> continua tocando (mudo).
 */

export const MAX_VOLUME = 300;

let ctx: AudioContext | null = null;
let sinkId = '';
let bus: GainNode | null = null;

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

function context(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    applySink();
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/** O contexto de áudio de reprodução (o mesmo da saída escolhida). */
export const playbackContext = () => context();

/** Saída dos sons do soundboard (a gravação também escuta daqui). */
export function soundBus(): GainNode {
  const c = context();
  if (!bus || bus.context !== c) {
    bus = c.createGain();
    bus.gain.value = 0.7;
    bus.connect(c.destination);
  }
  return bus;
}

function applySink() {
  const c = ctx as SinkContext | null;
  if (c?.setSinkId) void c.setSinkId(sinkId).catch(() => {});
}

/** A saída de áudio mudou nas configurações. */
export function setPlaybackSink(id: string) {
  if (id === sinkId) return;
  sinkId = id;
  applySink();
}

/** O navegador só libera áudio depois de um gesto: retoma no primeiro clique/tecla. */
export function resumePlayback() {
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
}

/** Um stream tocado com ganho acima de 100%. */
export class BoostedAudio {
  private source: MediaStreamAudioSourceNode;
  private gain: GainNode;
  private limiter: DynamicsCompressorNode;
  private stopped = false;

  constructor(stream: MediaStream, volume: number) {
    const c = context();
    this.source = c.createMediaStreamSource(stream);
    this.gain = c.createGain();
    this.gain.gain.value = volume;
    // limitador: segura os picos perto de 0 dB para o som alto não estourar
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.15;
    this.source.connect(this.gain).connect(this.limiter).connect(c.destination);
  }

  /** Ganho linear (1 = 100%, 3 = 300%; 0 = mudo). */
  setVolume(volume: number) {
    if (this.stopped) return;
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(MAX_VOLUME / 100, volume)), this.gain.context.currentTime, 0.03);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const node of [this.source, this.gain, this.limiter]) {
      try {
        node.disconnect();
      } catch {
        /* já desligado */
      }
    }
  }
}

/** Volume salvo (%) dentro do limite. */
export const clampVolume = (value: unknown, fallback = 100) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_VOLUME, Math.round(n))) : fallback;
};
