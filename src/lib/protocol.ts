/**
 * Protocolo entre os participantes e o host.
 *
 * Topologia: o host roda um "hub" (um peer com ID previsível = prefixo + código da sala).
 * Todo mundo abre uma conexão de dados com o hub, que é a autoridade da sala: guarda a
 * lista de membros, o histórico do chat e repassa mensagens. Áudio, vídeo e lives
 * NÃO passam pelo hub: vão direto de pessoa para pessoa (malha WebRTC).
 *
 * Cada sala tem exatamente um chat de texto e uma chamada de voz (os dois "canais" fixos).
 */

export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
}

export type LiveQuality = '480p' | '720p' | '1080p' | '1080p60';

export interface LiveInfo {
  startedAt: number;
  quality: LiveQuality;
  audio: boolean;
  viewers: number;
  /** Quem transmite aceita laser e lápis dos espectadores. */
  effects: boolean;
}

/** Um traço do lápis: pontos [x, y, x, y, …] de 0 a 1 dentro da imagem da live. */
export interface FxStroke {
  id: string;
  from: string;
  points: number[];
}

/**
 * Laser e lápis por cima da live: aparecem para todo mundo que assiste e para quem
 * transmite. Um traço chega em pedaços enquanto a pessoa desenha (mesmo id).
 */
export type LiveFx =
  | { kind: 'laser'; x: number; y: number }
  | { kind: 'laser-off' }
  | { kind: 'stroke'; id: string; points: number[] }
  | { kind: 'clear' };

/** Estado que cada participante publica sobre si mesmo. */
export interface Presence {
  voiceChannelId: string | null;
  micOn: boolean;
  deafened: boolean;
  cameraOn: boolean;
  live: LiveInfo | null;
}

export interface Member extends Presence {
  /** `${perfil}.${sessão}`: estável durante a sessão, mesmo se o host mudar. */
  id: string;
  /** ID do peer de mídia desta pessoa no servidor de sinalização. */
  peerId: string;
  name: string;
  color: string;
  /** Ordem de chegada: define quem herda o host se ele cair. */
  joinedAt: number;
  /** Microfone bloqueado pelo host. */
  serverMuted: boolean;
  /** A conexão com o hub caiu; a pessoa tem alguns segundos para voltar. */
  reconnecting: boolean;
}

export interface RoomState {
  code: string;
  name: string;
  hostId: string;
  createdAt: number;
  locked: boolean;
  /** Aumenta a cada troca de host. */
  epoch: number;
  channels: Channel[];
  members: Member[];
  /** IDs de perfil banidos. */
  banned: string[];
}

export interface Attachment {
  kind: 'image';
  name: string;
  /** data:image/...;base64 — vazio quando o host já descartou a imagem do histórico. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  /** Vazio para mensagens do sistema. */
  authorId: string;
  authorName: string;
  authorColor: string;
  text: string;
  ts: number;
  editedAt?: number;
  attachment?: Attachment;
  /** emoji -> IDs de quem reagiu */
  reactions?: Record<string, string[]>;
  system?: boolean;
}

export type RejectReason = 'locked' | 'banned' | 'full' | 'version' | 'invalid';

export type AdminAction =
  | { kind: 'kick'; memberId: string; ban: boolean }
  | { kind: 'mute'; memberId: string; muted: boolean }
  | { kind: 'transfer'; memberId: string; /** o host atual está saindo da sala */ leave?: boolean }
  | { kind: 'lock'; locked: boolean }
  | { kind: 'rename'; name: string }
  | { kind: 'end' };

/** Participante -> host */
export type ClientMsg =
  | {
      t: 'hello';
      v: number;
      member: { id: string; peerId: string; name: string; color: string };
      presence: Presence;
      /** Reentrada depois de queda/migração: mantém o lugar na fila. */
      rejoinAt?: number;
    }
  | { t: 'pong' }
  | { t: 'bye' }
  | { t: 'chat'; channelId: string; text: string; attachment?: Attachment }
  | { t: 'chat:edit'; id: string; text: string }
  | { t: 'chat:delete'; id: string }
  | { t: 'chat:react'; id: string; emoji: string }
  | { t: 'typing'; channelId: string }
  | { t: 'speaking'; on: boolean }
  | { t: 'presence'; presence: Partial<Presence> }
  | { t: 'profile'; name: string; color: string }
  | { t: 'live:watch'; streamerId: string; on: boolean }
  | { t: 'fx'; streamerId: string; fx: LiveFx }
  | { t: 'admin'; action: AdminAction };

/** Host -> participante */
export type HubMsg =
  | { t: 'welcome'; you: string; state: RoomState; messages: ChatMessage[] }
  | { t: 'reject'; reason: RejectReason }
  | { t: 'state'; state: RoomState }
  | { t: 'chat'; message: ChatMessage }
  | { t: 'chat:update'; message: ChatMessage }
  | { t: 'chat:delete'; id: string; channelId: string }
  | { t: 'typing'; memberId: string; channelId: string }
  | { t: 'speaking'; memberId: string; on: boolean }
  | { t: 'live:viewer'; viewerId: string; viewerPeerId: string; on: boolean }
  | { t: 'fx'; from: string; streamerId: string; fx: LiveFx }
  | { t: 'fx:sync'; streamerId: string; strokes: FxStroke[] }
  | { t: 'ping' }
  | { t: 'kicked'; ban: boolean }
  | { t: 'ended' }
  | { t: 'handoff'; newHostId: string; /** o host antigo saiu (não vai reconectar) */ leaving?: boolean };
