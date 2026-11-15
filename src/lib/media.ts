import type Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';
import type { LiveQuality, Member, RoomState } from './protocol';
import type { Settings } from './storage';

/**
 * Toda a mídia vai direto de pessoa para pessoa (o host não retransmite nada):
 * - Voz/câmera: malha completa entre quem está no mesmo canal de voz. Cada par tem
 *   UMA chamada com uma faixa de áudio e uma de vídeo; ligar/desligar câmera ou trocar
 *   o microfone usa replaceTrack(), sem renegociar.
 * - Lives: quem transmite liga para cada espectador que clicou em "Assistir".
 */

export const LIVE_PRESETS: Record<
  LiveQuality,
  { label: string; hint: string; width: number; height: number; fps: number; bitrate: number }
> = {
  '480p': { label: '480p', hint: 'Economiza internet', width: 854, height: 480, fps: 30, bitrate: 1_000_000 },
  '720p': { label: '720p', hint: 'Equilibrado (recomendado)', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '1080p': { label: '1080p', hint: 'Mais nitidez', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { label: '1080p 60fps', hint: 'Jogos fluidos, pede upload alto', width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
};

const CAMERA = {
  sd: { width: 640, height: 360, fps: 24, bitrate: 500_000 },
  hd: { width: 1280, height: 720, fps: 30, bitrate: 1_200_000 },
};

/** Chamadas recebidas ganham alguns segundos antes de serem descartadas (o estado pode estar atrasado). */
const INCOMING_GRACE_MS = 6_000;

export interface MediaEvents {
  streams(voice: Record<string, MediaStream>, live: Record<string, MediaStream>): void;
  localSpeaking(on: boolean): void;
  liveViewers(count: number): void;
  liveEnded(): void;
  liveDropped(streamerId: string): void;
  cameraEnded(): void;
  micLost(): void;
}

/** Nível 0..1 (escala em dB) de um trecho de áudio. */
export function levelFromBuffer(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  const rms = Math.sqrt(sum / buffer.length);
  const db = 20 * Math.log10(rms + 1e-8);
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

function safeClose(call: MediaConnection) {
  try {
    call.close();
  } catch {
    /* já fechada */
  }
}

async function tuneSender(
  sender: RTCRtpSender,
  maxBitrate: number,
  maxFramerate?: number,
  degradation?: 'maintain-framerate' | 'maintain-resolution',
) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxBitrate = maxBitrate;
    if (maxFramerate) params.encodings[0].maxFramerate = maxFramerate;
    if (degradation) (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = degradation;
    await sender.setParameters(params);
  } catch {
    /* nem todo navegador aceita todos os parâmetros */
  }
}

interface VoiceLink {
  memberId: string;
  peerId: string;
  call: MediaConnection;
  stream: MediaStream | null;
  initiator: boolean;
  since: number;
}

export class MediaEngine {
  camStream: MediaStream | null = null;
  screenStream: MediaStream | null = null;
  readonly watching = new Set<string>();

  private peer: Peer | null = null;
  private meId = '';
  private state: RoomState | null = null;
  private myVoice: string | null = null;
  private ctx: AudioContext | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private silentTrack: MediaStreamTrack | null = null;
  private blankTrack: MediaStreamTrack | null = null;
  private sendStream: MediaStream | null = null;
  private micEnabled = false;
  private vad: { stop(): void } | null = null;
  private voice = new Map<string, VoiceLink>();
  private retryTimers = new Map<string, number>();
  private retryCount = new Map<string, number>();
  private liveOut = new Map<string, MediaConnection>();
  private liveIn = new Map<string, MediaConnection>();
  private liveStreams = new Map<string, MediaStream>();
  private liveQuality: LiveQuality = '720p';
  private liveMotion = true;
  private destroyed = false;

  constructor(
    private ev: MediaEvents,
    private settings: () => Settings,
  ) {}

  attach(peer: Peer, meId: string) {
    this.peer = peer;
    this.meId = meId;
    peer.on('call', (call) => this.onCall(call));
  }

  update(state: RoomState) {
    this.state = state;
    for (const id of [...this.watching]) {
      if (!state.members.find((m) => m.id === id)?.live) this.dropLive(id);
    }
    for (const id of [...this.liveOut.keys()]) {
      if (!state.members.some((m) => m.id === id)) this.closeLiveOut(id);
    }
    this.reconcile();
  }

  // ───────────────────────── voz ─────────────────────────

  /** Entra num canal de voz. Devolve false se o microfone não estiver disponível (entra só ouvindo). */
  async joinVoice(channelId: string, micOn: boolean): Promise<boolean> {
    this.context();
    let micAvailable = true;
    if (!this.micTrack) {
      try {
        this.micTrack = await this.acquireMic();
      } catch (err) {
        console.warn('[mídia] microfone indisponível', err);
        micAvailable = false;
      }
    }
    if (this.destroyed) {
      this.micTrack?.stop();
      this.micTrack = null;
      return false;
    }
    this.sendStream = new MediaStream([this.micTrack ?? this.silent(), this.camStream?.getVideoTracks()[0] ?? this.blank()]);
    this.myVoice = channelId;
    this.setMicEnabled(micOn && micAvailable);
    this.startVad();
    this.reconcile();
    return micAvailable;
  }

  leaveVoice() {
    this.myVoice = null;
    for (const link of [...this.voice.values()]) this.dropVoice(link, false);
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    this.retryCount.clear();
    this.stopLive();
    this.stopCamera();
    this.vad?.stop();
    this.vad = null;
    this.micTrack?.stop();
    this.micTrack = null;
    this.sendStream = null;
    this.emitStreams();
  }

  setMicEnabled(on: boolean) {
    this.micEnabled = on;
    if (this.micTrack) this.micTrack.enabled = on;
  }

  async setCamera(on: boolean): Promise<MediaStream | null> {
    if (on && !this.camStream) {
      const settings = this.settings();
      const q = CAMERA[settings.cameraQuality];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: settings.videoInputId ? { ideal: settings.videoInputId } : undefined,
          width: { ideal: q.width },
          height: { ideal: q.height },
          frameRate: { ideal: q.fps },
        },
        audio: false,
      });
      if (this.destroyed || !this.myVoice) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'motion';
      track.onended = () => {
        if (this.camStream !== stream) return;
        this.camStream = null;
        this.applyTracks();
        this.ev.cameraEnded();
      };
      this.camStream = stream;
      this.applyTracks();
    } else if (!on) {
      this.stopCamera();
    }
    return this.camStream;
  }

  async refreshMic() {
    if (!this.myVoice) return;
    let track: MediaStreamTrack;
    try {
      track = await this.acquireMic();
    } catch {
      return;
    }
    if (!this.myVoice || this.destroyed) {
      track.stop();
      return;
    }
    const old = this.micTrack;
    this.micTrack = track;
    track.enabled = this.micEnabled;
    this.applyTracks();
    old?.stop();
    this.startVad();
  }

  async refreshCamera(): Promise<MediaStream | null> {
    if (!this.camStream) return null;
    this.stopCamera();
    return this.setCamera(true);
  }

  private stopCamera() {
    if (!this.camStream) return;
    this.camStream.getTracks().forEach((t) => t.stop());
    this.camStream = null;
    this.applyTracks();
  }

  /** Mantém o stream de envio e todas as chamadas com as faixas atuais. */
  private applyTracks() {
    if (this.sendStream) {
      const audio = this.micTrack ?? this.silent();
      const video = this.camStream?.getVideoTracks()[0] ?? this.blank();
      for (const track of this.sendStream.getTracks()) {
        if (track !== audio && track !== video) this.sendStream.removeTrack(track);
      }
      if (!this.sendStream.getTracks().includes(audio)) this.sendStream.addTrack(audio);
      if (!this.sendStream.getTracks().includes(video)) this.sendStream.addTrack(video);
    }
    for (const link of this.voice.values()) this.syncSenders(link);
  }

  private syncSenders(link: VoiceLink) {
    const pc = link.call.peerConnection;
    if (!pc || pc.signalingState === 'closed') return;
    const audio = this.micTrack ?? this.silent();
    const video = this.camStream?.getVideoTracks()[0] ?? this.blank();
    const camera = CAMERA[this.settings().cameraQuality];
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track?.kind;
      const sender = transceiver.sender;
      if (kind === 'audio' && sender.track !== audio) void sender.replaceTrack(audio).catch(() => {});
      if (kind === 'video') {
        if (sender.track !== video) void sender.replaceTrack(video).catch(() => {});
        void tuneSender(sender, this.camStream ? camera.bitrate : 100_000);
      }
    }
  }

  private reconcile() {
    const state = this.state;
    const peer = this.peer;
    if (!state || !peer || this.destroyed) return;
    const desired = new Map<string, Member>();
    if (this.myVoice && this.sendStream) {
      for (const m of state.members) {
        if (m.id !== this.meId && m.voiceChannelId === this.myVoice && m.peerId) desired.set(m.peerId, m);
      }
    }
    const now = Date.now();
    for (const link of [...this.voice.values()]) {
      if (desired.has(link.peerId)) continue;
      const stillHere = state.members.some((m) => m.peerId === link.peerId);
      if (stillHere && this.myVoice && !link.initiator && now - link.since < INCOMING_GRACE_MS) continue;
      this.dropVoice(link, false);
    }
    for (const [peerId, member] of desired) {
      if (this.voice.has(peerId) || this.retryTimers.has(peerId)) continue;
      // regra fixa para não ligarem os dois ao mesmo tempo: quem tem o ID "maior" liga
      if (peer.id > peerId) this.callVoice(member);
    }
  }

  private callVoice(member: Member) {
    const peer = this.peer;
    const stream = this.sendStream;
    if (!peer || !stream) return;
    const call = peer.call(member.peerId, stream, { metadata: { kind: 'voice' } }) as MediaConnection | undefined;
    if (!call) {
      this.scheduleRetry(member.peerId);
      return;
    }
    this.setupVoice(call, member, true);
  }

  private onCall(call: MediaConnection) {
    const caller = this.state?.members.find((m) => m.peerId === call.peer);
    const kind = (call.metadata as { kind?: string } | undefined)?.kind;
    if (!caller || this.destroyed) {
      safeClose(call);
      return;
    }
    if (kind === 'live') {
      if (this.watching.has(caller.id)) this.acceptLive(caller.id, call);
      else safeClose(call);
      return;
    }
    if (kind === 'voice' && this.myVoice && this.sendStream) {
      const old = this.voice.get(call.peer);
      if (old) {
        this.voice.delete(call.peer);
        safeClose(old.call);
      }
      // responder na hora: o PeerJS descarta candidatos ICE que chegam antes do answer()
      call.answer(this.sendStream);
      this.setupVoice(call, caller, false);
      window.setTimeout(() => this.reconcile(), INCOMING_GRACE_MS + 200);
      return;
    }
    safeClose(call);
  }

  private setupVoice(call: MediaConnection, member: Member, initiator: boolean) {
    const link: VoiceLink = { memberId: member.id, peerId: member.peerId, call, stream: null, initiator, since: Date.now() };
    this.voice.set(member.peerId, link);
    call.on('stream', (stream) => {
      if (this.voice.get(link.peerId) !== link) return;
      link.stream = stream;
      this.retryCount.delete(link.peerId);
      this.emitStreams();
    });
    call.on('close', () => this.dropVoice(link, true));
    call.on('error', (err) => console.warn('[voz]', member.name, err.type));
    const pc = call.peerConnection;
    pc?.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.syncSenders(link);
      else if (pc.connectionState === 'failed') this.dropVoice(link, true);
    });
    window.setTimeout(() => {
      if (this.voice.get(link.peerId) === link && !link.stream) this.dropVoice(link, true);
    }, 20_000);
  }

  private dropVoice(link: VoiceLink, retry: boolean) {
    if (this.voice.get(link.peerId) !== link) return;
    this.voice.delete(link.peerId);
    safeClose(link.call);
    this.emitStreams();
    if (retry && link.initiator && this.myVoice) this.scheduleRetry(link.peerId);
  }

  private scheduleRetry(peerId: string) {
    if (this.retryTimers.has(peerId) || this.destroyed) return;
    const attempt = (this.retryCount.get(peerId) ?? 0) + 1;
    this.retryCount.set(peerId, attempt);
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4));
    this.retryTimers.set(
      peerId,
      window.setTimeout(() => {
        this.retryTimers.delete(peerId);
        this.reconcile();
      }, delay),
    );
  }

  // ───────────────────────── lives ─────────────────────────

  async startLive(quality: LiveQuality, audio: boolean, motion: boolean): Promise<MediaStream> {
    const preset = LIVE_PRESETS[quality];
    const options = {
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps },
      },
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: audio ? 'include' : 'exclude',
    } as DisplayMediaStreamOptions;
    const stream = await navigator.mediaDevices.getDisplayMedia(options);
    if (this.destroyed || !this.myVoice) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Você saiu da chamada.');
    }
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.contentHint = motion ? 'motion' : 'detail';
      video.onended = () => {
        if (this.screenStream !== stream) return;
        this.stopLive();
        this.ev.liveEnded();
      };
    }
    this.stopLive();
    this.screenStream = stream;
    this.liveQuality = quality;
    this.liveMotion = motion;
    return stream;
  }

  stopLive() {
    for (const id of [...this.liveOut.keys()]) this.closeLiveOut(id, false);
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.ev.liveViewers(0);
    }
  }

  /** Alguém clicou em "Assistir" (ou parou): o host repassou o pedido. */
  onLiveViewer(viewerId: string, viewerPeerId: string, on: boolean) {
    if (!on) {
      this.closeLiveOut(viewerId);
      return;
    }
    const peer = this.peer;
    const stream = this.screenStream;
    if (!peer || !stream) return;
    const viewer = this.state?.members.find((m) => m.id === viewerId && m.peerId === viewerPeerId);
    if (!viewer) return;
    const call = peer.call(viewerPeerId, stream, { metadata: { kind: 'live' } }) as MediaConnection | undefined;
    if (!call) return;
    const old = this.liveOut.get(viewerId);
    this.liveOut.set(viewerId, call);
    if (old) safeClose(old);
    const pc = call.peerConnection;
    pc?.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') this.tuneLive(pc);
      else if (pc.connectionState === 'failed') this.closeLiveOut(viewerId);
    });
    call.on('close', () => {
      if (this.liveOut.get(viewerId) !== call) return;
      this.liveOut.delete(viewerId);
      this.ev.liveViewers(this.liveOut.size);
    });
    this.ev.liveViewers(this.liveOut.size);
  }

  private closeLiveOut(viewerId: string, notify = true) {
    const call = this.liveOut.get(viewerId);
    if (!call) return;
    this.liveOut.delete(viewerId);
    safeClose(call);
    if (notify) this.ev.liveViewers(this.liveOut.size);
  }

  private tuneLive(pc: RTCPeerConnection) {
    const preset = LIVE_PRESETS[this.liveQuality];
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') {
        void tuneSender(sender, preset.bitrate, preset.fps, this.liveMotion ? 'maintain-framerate' : 'maintain-resolution');
      } else if (sender.track?.kind === 'audio') {
        void tuneSender(sender, 128_000);
      }
    }
  }

  watch(streamerId: string) {
    this.watching.add(streamerId);
  }

  hasLiveStream(streamerId: string) {
    return this.liveStreams.has(streamerId);
  }

  private acceptLive(streamerId: string, call: MediaConnection) {
    const old = this.liveIn.get(streamerId);
    this.liveIn.set(streamerId, call);
    if (old) safeClose(old);
    call.answer(); // só recebe
    call.on('stream', (stream) => {
      if (this.liveIn.get(streamerId) !== call) return;
      this.liveStreams.set(streamerId, stream);
      this.emitStreams();
    });
    call.on('close', () => {
      if (this.liveIn.get(streamerId) !== call) return;
      this.liveIn.delete(streamerId);
      this.liveStreams.delete(streamerId);
      this.emitStreams();
      if (this.watching.has(streamerId)) this.ev.liveDropped(streamerId);
    });
  }

  dropLive(streamerId: string) {
    this.watching.delete(streamerId);
    const call = this.liveIn.get(streamerId);
    this.liveIn.delete(streamerId);
    const had = this.liveStreams.delete(streamerId);
    if (call) safeClose(call);
    if (had || call) this.emitStreams();
  }

  // ───────────────────────── infraestrutura ─────────────────────────

  private emitStreams() {
    const voice: Record<string, MediaStream> = {};
    for (const link of this.voice.values()) if (link.stream) voice[link.memberId] = link.stream;
    this.ev.streams(voice, Object.fromEntries(this.liveStreams));
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private async acquireMic(): Promise<MediaStreamTrack> {
    const s = this.settings();
    const base: MediaTrackConstraints = {
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      channelCount: 1,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: s.audioInputId ? { ...base, deviceId: { exact: s.audioInputId } } : base,
      });
    } catch (err) {
      if (!s.audioInputId) throw err;
      stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }
    const track = stream.getAudioTracks()[0];
    track.onended = () => {
      if (this.micTrack === track) this.ev.micLost();
    };
    return track;
  }

  /** Faixa de áudio muda, para quem entra sem microfone. */
  private silent(): MediaStreamTrack {
    if (!this.silentTrack || this.silentTrack.readyState === 'ended') {
      this.silentTrack = this.context().createMediaStreamDestination().stream.getAudioTracks()[0];
    }
    return this.silentTrack;
  }

  /** Faixa de vídeo preta: reserva o espaço do vídeo na chamada para ligar a câmera depois. */
  private blank(): MediaStreamTrack {
    if (!this.blankTrack || this.blankTrack.readyState === 'ended') {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const g = canvas.getContext('2d');
      if (g) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      const track = canvas.captureStream(1).getVideoTracks()[0];
      track.enabled = false;
      this.blankTrack = track;
    }
    return this.blankTrack;
  }

  private startVad() {
    this.vad?.stop();
    this.vad = null;
    const track = this.micTrack;
    if (!track) return;
    const ctx = this.context();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let speaking = false;
    let lastLoud = 0;
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      const level = levelFromBuffer(buffer);
      const now = performance.now();
      if (this.micEnabled && level > this.settings().vadThreshold) lastLoud = now;
      const next = this.micEnabled && now - lastLoud < 350;
      if (next !== speaking) {
        speaking = next;
        this.ev.localSpeaking(next);
      }
    }, 60);
    this.vad = {
      stop: () => {
        clearInterval(timer);
        source.disconnect();
        if (speaking) this.ev.localSpeaking(false);
      },
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.leaveVoice();
    for (const id of [...this.liveIn.keys()]) this.dropLive(id);
    this.watching.clear();
    this.destroyed = true;
    this.silentTrack?.stop();
    this.blankTrack?.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.peer = null;
    this.state = null;
  }
}
