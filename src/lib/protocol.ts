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

import type { OrbitStyle } from './orbitPath';
import type { PlanetStyle } from './planet';

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

/** Estilos do pincel. */
export type PenStyle = 'pen' | 'marker' | 'neon' | 'dashed' | 'spray';

/** Cor, tamanho e estilo de um traço. O tamanho é a espessura em pixels numa imagem de 1080 de altura. */
export interface PenLook {
  color: string;
  size: number;
  style: PenStyle;
}

/** Um traço do lápis: pontos [x, y, x, y, …] de 0 a 1 dentro da imagem da live. */
export interface FxStroke extends PenLook {
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
  | ({ kind: 'stroke'; id: string; points: number[] } & PenLook)
  /** Borracha: o caminho dela (mesma escala dos traços), o diâmetro e o formato da imagem (largura/altura). */
  | { kind: 'erase'; points: number[]; size: number; aspect: number }
  | { kind: 'clear' };

/** Estado que cada participante publica sobre si mesmo. */
export interface Presence {
  voiceChannelId: string | null;
  micOn: boolean;
  deafened: boolean;
  cameraOn: boolean;
  live: LiveInfo | null;
  /** Está gravando a chamada (todo mundo vê o aviso). */
  recording?: boolean;
}

export interface Member extends Presence {
  /** `${perfil}.${sessão}`: estável durante a sessão, mesmo se o host mudar. */
  id: string;
  /** ID do peer de mídia desta pessoa no servidor de sinalização. */
  peerId: string;
  name: string;
  color: string;
  /** Textura, anéis, luas e brilho do planeta. */
  planet?: PlanetStyle;
  /** A órbita em volta do host (ausente = automática). */
  orbit?: OrbitStyle;
  /** Versão do Órbita da pessoa (ausente = versão antiga, de antes do aviso). */
  build?: string;
  /** Chave pública de identidade (provada ao entrar; ausente = versão antiga, sem prova). */
  key?: string;
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
  /** Aparece na lista de órbitas abertas (o host pode esconder). Ausente = sim. */
  listed?: boolean;
  /** Órbita fixa: o mesmo link sempre; quem já entrou pode reabrir quando estiver vazia. */
  fixed?: boolean;
  /** Perfil de quem criou (numa órbita fixa, a coroa volta para ele quando chega). */
  ownerId?: string;
  /** Chave de quem criou: a coroa só volta para quem provar que tem esta chave. */
  ownerKey?: string;
  /** Chaves banidas (quem entrou com chave é banido pela chave, não pelo ID de perfil). */
  bannedKeys?: string[];
}

export interface ImageAttachment {
  kind: 'image';
  name: string;
  /** data:image/...;base64 — vazio quando o host já descartou a imagem do histórico. */
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Arquivo que fica no computador de quem mandou: quem baixa busca direto dele (P2P).
 * Só dá para baixar enquanto essa pessoa estiver na sala.
 */
export interface FileAttachment {
  kind: 'file';
  name: string;
  /** Bytes. */
  size: number;
  mime: string;
  fileId: string;
  /** ID de membro de quem tem o arquivo (o hub confere que é quem mandou). */
  ownerId: string;
}

export type Attachment = ImageAttachment | FileAttachment;

/** Trecho da mensagem respondida (cópia, para continuar aparecendo se a original sumir). */
export interface ReplyRef {
  id: string;
  authorName: string;
  text: string;
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
  /** Resposta a outra mensagem. */
  replyTo?: ReplyRef;
  /** Fixada pelo host (quando). */
  pinnedAt?: number;
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
  | { kind: 'listed'; listed: boolean }
  | { kind: 'fixed'; fixed: boolean }
  | { kind: 'rename'; name: string }
  | { kind: 'end' };

/** Participante -> host */
export type ClientMsg =
  | {
      t: 'hello';
      v: number;
      member: { id: string; peerId: string; name: string; color: string; avatar?: string; planet?: PlanetStyle; orbit?: OrbitStyle; build?: string };
      /** Prova de identidade: chave pública, assinatura e a hora assinada (ver identityKey.ts). */
      proof?: { key: string; sig: string; ts: number };
      presence: Presence;
      /** Reentrada depois de queda/migração: mantém o lugar na fila. */
      rejoinAt?: number;
    }
  | { t: 'pong' }
  | { t: 'bye' }
  | { t: 'chat'; channelId: string; text: string; attachment?: Attachment; replyTo?: string }
  | { t: 'chat:pin'; id: string; pinned: boolean }
  | { t: 'chat:edit'; id: string; text: string }
  | { t: 'chat:delete'; id: string }
  | { t: 'chat:react'; id: string; emoji: string }
  | { t: 'typing'; channelId: string }
  | { t: 'speaking'; on: boolean }
  /** Salvei um clipe: o host avisa no chat. */
  | { t: 'clip' }
  | { t: 'presence'; presence: Partial<Presence> }
  | { t: 'profile'; name: string; color: string; avatar?: string | null; planet?: PlanetStyle; orbit?: OrbitStyle | null }
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
  /** Fotos de perfil: todas ao entrar, depois uma por vez (fora do estado, que vai e volta toda hora). */
  | { t: 'avatars'; avatars: Record<string, string> }
  | { t: 'avatar'; memberId: string; avatar: string | null }
  | { t: 'ping' }
  | { t: 'kicked'; ban: boolean }
  | { t: 'ended' }
  | { t: 'handoff'; newHostId: string; /** o host antigo saiu (não vai reconectar) */ leaving?: boolean };
