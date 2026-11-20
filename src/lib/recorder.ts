import { playbackContext } from './playback';

/**
 * Gravação da chamada e clipes do último minuto, tudo no navegador de quem grava.
 *
 * O Mixer junta o som de todo mundo (vozes que chegam, a minha voz já com filtros, o som da
 * live em destaque) e, se houver live, desenha a imagem dela num canvas. O
 * relógio do desenho roda num worker: com a aba em segundo plano, os timers da página ficam
 * lentos, os do worker não.
 */

const W = 1280;
const H = 720;
const FPS = 24;

const TICKER = `let t = 0; onmessage = (e) => { clearInterval(t); if (e.data > 0) t = setInterval(() => postMessage(0), e.data); };`;

export class Mixer {
  readonly audio: MediaStreamTrack;
  private ctx = playbackContext();
  private dest: MediaStreamAudioDestinationNode;
  private keepAlive: ConstantSourceNode;
  private inputs = new Map<string, MediaStreamAudioSourceNode>();
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private video: HTMLVideoElement = document.createElement('video');
  private videoTrackOut: MediaStreamTrack | null = null;
  private ticker: Worker | null = null;
  private tickerUrl = '';
  private label = '';
  private disposed = false;

  constructor() {
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.keepAlive = this.ctx.createConstantSource();
    this.keepAlive.offset.value = 0;
    this.keepAlive.connect(this.dest);
    this.keepAlive.start();
    this.audio = this.dest.stream.getAudioTracks()[0];
    this.video.muted = true;
    this.video.playsInline = true;
  }

  /** Mantém ligadas exatamente estas faixas de áudio. */
  setAudio(tracks: MediaStreamTrack[]) {
    if (this.disposed) return;
    const want = new Map(tracks.filter((t) => t.readyState === 'live').map((t) => [t.id, t]));
    for (const [id, node] of this.inputs) {
      if (want.has(id)) continue;
      node.disconnect();
      this.inputs.delete(id);
    }
    for (const [id, track] of want) {
      if (this.inputs.has(id)) continue;
      try {
        const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
        node.connect(this.dest);
        this.inputs.set(id, node);
      } catch (err) {
        console.warn('[gravação] faixa ignorada', err);
      }
    }
  }

  /** A imagem da live em destaque (null = sem live agora). */
  setVideo(stream: MediaStream | null, label: string) {
    this.label = label;
    if (this.video.srcObject === stream) return;
    this.video.srcObject = stream;
    if (stream) void this.video.play().catch(() => {});
  }

  /** Faixa de vídeo do canvas (criada na primeira vez). */
  videoTrack(): MediaStreamTrack {
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
      this.g = this.canvas.getContext('2d');
      this.videoTrackOut = this.canvas.captureStream(FPS).getVideoTracks()[0];
      this.tickerUrl = URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' }));
      this.ticker = new Worker(this.tickerUrl);
      this.ticker.onmessage = () => this.draw();
      this.ticker.postMessage(Math.round(1000 / FPS));
      this.draw();
    }
    return this.videoTrackOut!;
  }

  private draw() {
    const g = this.g;
    if (!g || this.disposed) return;
    g.fillStyle = '#05060f';
    g.fillRect(0, 0, W, H);
    const v = this.video;
    if (v.srcObject && v.readyState >= 2 && v.videoWidth) {
      const scale = Math.min(W / v.videoWidth, H / v.videoHeight);
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      g.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      g.fillStyle = '#7d83b0';
      g.font = '600 34px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(this.label || 'Sem live no momento', W / 2, H / 2);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ticker?.terminate();
    if (this.tickerUrl) URL.revokeObjectURL(this.tickerUrl);
    this.videoTrackOut?.stop();
    this.video.srcObject = null;
    for (const node of this.inputs.values()) node.disconnect();
    this.inputs.clear();
    this.keepAlive.stop();
    this.keepAlive.disconnect();
    this.audio.stop();
  }
}

function pickMime(video: boolean): string {
  const options = video
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return options.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

export const canRecord = () => typeof MediaRecorder !== 'undefined';

export const extensionOf = (mime: string) => (mime.includes('mp4') ? 'mp4' : 'webm');

/** Gravação da chamada: vai direto para um arquivo no disco (se o navegador deixar) ou fica na memória até parar. */
export class CallRecording {
  readonly mime: string;
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private writing: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    stream: MediaStream,
    video: boolean,
    private sink: FileSystemWritableFileStream | null,
  ) {
    this.mime = pickMime(video);
    this.rec = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 128_000 });
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (this.sink && !this.failed) {
        const sink = this.sink;
        this.writing = this.writing.then(() => sink.write(e.data)).catch((err) => {
          // o disco recusou (cheio, arquivo apagado…): o resto fica na memória
          console.warn('[gravação] falha ao gravar no arquivo', err);
          this.failed = true;
        });
      } else {
        this.chunks.push(e.data);
      }
    };
    this.rec.start(1_000);
  }

  /** Para e devolve o arquivo (null quando já foi gravado direto no disco). */
  stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const finish = async () => {
        await this.writing;
        if (this.sink && !this.failed) {
          try {
            await this.sink.close();
            resolve(null);
            return;
          } catch {
            /* cai para a memória */
          }
        }
        resolve(new Blob(this.chunks, { type: this.mime || 'video/webm' }));
      };
      if (this.rec.state === 'inactive') void finish();
      else {
        this.rec.onstop = () => void finish();
        this.rec.stop();
      }
    });
  }
}

interface Slot {
  rec: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  mime: string;
}

/** Quanto vive cada gravador do clipe e de quanto em quanto tempo nasce um novo. */
const CLIP_LIFE_MS = 95_000;
const CLIP_STAGGER_MS = 30_000;

/**
 * Clipes: um arquivo WebM só começa no início da gravação, então não dá para "cortar" o
 * último minuto de uma gravação contínua. Em vez disso, a cada 30 s nasce um gravador novo e
 * os com mais de 95 s são descartados. Na hora do clipe, o mais antigo (60 a 95 s) vira o arquivo.
 */
export class ClipBuffer {
  private slots: Slot[] = [];
  private timer = 0;
  private stopped = false;

  constructor(private makeStream: () => { stream: MediaStream; video: boolean }) {
    this.spawn();
    this.timer = window.setInterval(() => this.rotate(), CLIP_STAGGER_MS);
  }

  private spawn() {
    if (this.stopped) return;
    const { stream, video } = this.makeStream();
    const mime = pickMime(video);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 });
    } catch (err) {
      console.warn('[clipe] não consegui gravar', err);
      return;
    }
    const slot: Slot = { rec, chunks: [], startedAt: Date.now(), mime };
    rec.ondataavailable = (e) => {
      if (e.data.size) slot.chunks.push(e.data);
    };
    rec.start(1_000);
    this.slots.push(slot);
  }

  private rotate() {
    this.spawn();
    const now = Date.now();
    for (const slot of [...this.slots]) if (now - slot.startedAt > CLIP_LIFE_MS) this.drop(slot);
  }

  private drop(slot: Slot) {
    this.slots = this.slots.filter((s) => s !== slot);
    slot.rec.ondataavailable = null;
    if (slot.rec.state !== 'inactive') slot.rec.stop();
    slot.chunks = [];
  }

  /** Salva o trecho mais longo disponível (até ~1 min e meio). */
  clip(): Promise<{ blob: Blob; seconds: number; mime: string } | null> {
    const slot = this.slots[0];
    if (!slot) return Promise.resolve(null);
    this.slots = this.slots.slice(1);
    if (!this.slots.length) this.spawn();
    const seconds = Math.round((Date.now() - slot.startedAt) / 1000);
    return new Promise((resolve) => {
      slot.rec.onstop = () => resolve({ blob: new Blob(slot.chunks, { type: slot.mime || 'video/webm' }), seconds, mime: slot.mime });
      if (slot.rec.state === 'inactive') slot.rec.onstop(new Event('stop'));
      else slot.rec.stop();
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const slot of [...this.slots]) this.drop(slot);
  }
}
