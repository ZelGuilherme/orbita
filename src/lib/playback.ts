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

/**
 * Tudo no Órbita toca 2x mais alto que o volume original do navegador (com o limitador segurando
 * os picos). Os controles guardam o valor de 0 a 300 (100 = som original) e mostram de 0 a 100.
 */
export const LOUDNESS = 2;

/** Ganho mais alto possível (controle no máximo, já com o 2x). */
const MAX_GAIN = (MAX_VOLUME / 100) * LOUDNESS;

/** O número que aparece no controle de volume (0 a 100). */
export const volumeLabel = (value: number) => Math.round((value / MAX_VOLUME) * 100);

/** Passo do controle: 1 no número mostrado. */
export const VOLUME_STEP = MAX_VOLUME / 100;

let ctx: AudioContext | null = null;
let sinkId = '';

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

  /** Ganho linear (1 = som original, 6 = máximo; 0 = mudo). */
  setVolume(volume: number) {
    if (this.stopped) return;
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(MAX_GAIN, volume)), this.gain.context.currentTime, 0.03);
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
