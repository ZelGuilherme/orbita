import { create } from 'zustand';
import type { LiveSurface } from './lib/media';
import type { ChatMessage, LiveInfo, RoomState } from './lib/protocol';
import type { EndReason } from './lib/session';
import { loadLiveVolumes, loadProfile, loadSettings, loadUiPrefs, loadVolumes, type Profile, type Settings } from './lib/storage';

export type SettingsTab = 'perfil' | 'voz' | 'filtros' | 'live' | 'atalhos' | 'rede' | 'sobre';

export type Modal =
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'invite' }
  | { kind: 'live' }
  | { kind: 'leave' }
  | { kind: 'room' }
  | { kind: 'image'; src: string; name: string }
  | { kind: 'confirm'; title: string; body: string; confirm: string; danger?: boolean; action: () => void };

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

/** handoff: a aba entregou o convite para o app instalado. */
export type Phase = 'landing' | 'connecting' | 'room' | 'ended' | 'handoff';

export interface AppState {
  profile: Profile;
  settings: Settings;
  phase: Phase;
  connectingText: string;
  landingError: string | null;
  inviteCode: string | null;
  handoff: { code: string; status: 'opening' | 'opened' | 'failed' } | null;
  ended: { reason: EndReason; roomName: string; code: string } | null;
  toasts: Toast[];
  modal: Modal | null;
  /** Volume da voz de cada pessoa (por perfil). */
  volumes: Record<string, number>;
  /** Volume da live de cada pessoa (por perfil), separado da voz. */
  liveVolumes: Record<string, number>;

  // sala
  code: string | null;
  room: RoomState | null;
  meId: string | null;
  isHost: boolean;
  net: 'connected' | 'reconnecting';
  netDetail: string;
  /** Mensagens do chat da sala. */
  messages: ChatMessage[];
  /** Quem está digitando: id → até quando. */
  typing: Record<string, number>;
  speaking: Record<string, boolean>;
  /** Fotos de perfil de quem está na sala. */
  avatars: Record<string, string>;

  // mídia local
  inCall: boolean;
  joiningVoice: boolean;
  micOn: boolean;
  deafened: boolean;
  /** Pressionar para falar: a tecla está pressionada. */
  pttDown: boolean;
  cameraOn: boolean;
  live: LiveInfo | null;
  liveSurface: LiveSurface | null;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  voiceStreams: Record<string, MediaStream>;
  liveStreams: Record<string, MediaStream>;
  watching: Record<string, true>;
  /** Lives silenciadas só para mim (sem mexer no volume salvo). */
  liveMutes: Record<string, boolean>;

  // interface
  chatOpen: boolean;
  peopleOpen: boolean;
  unread: number;
  mentions: number;
  focus: string | null;
  callLayout: 'auto' | 'grid' | 'orbit';
  localMutes: Record<string, boolean>;
  audioBlocked: boolean;
  memberCard: { memberId: string; x: number; y: number } | null;
  /** Ferramenta sobre a live: laser aponta, lápis desenha. */
  tool: 'laser' | 'pencil' | null;
  /** Largura do chat em px (null = padrão). */
  chatWidth: number | null;
  /** Saiu uma versão nova do Órbita. */
  updateReady: boolean;
  /** Já fechei a dica da janela flutuante nesta live. */
  floatTipClosed: boolean;
  /** Janela flutuante (sempre por cima) com a prévia da live e os efeitos. */
  floating: boolean;
}

const roomDefaults = () => ({
  code: null,
  room: null,
  meId: null,
  isHost: false,
  net: 'connected' as const,
  netDetail: '',
  messages: [],
  typing: {},
  speaking: {},
  avatars: {},
  inCall: false,
  joiningVoice: false,
  micOn: true,
  deafened: false,
  pttDown: false,
  cameraOn: false,
  live: null,
  liveSurface: null,
  localCamera: null,
  localScreen: null,
  voiceStreams: {},
  liveStreams: {},
  watching: {},
  liveMutes: {},
  peopleOpen: false,
  unread: 0,
  mentions: 0,
  focus: null,
  callLayout: 'auto' as const,
  localMutes: {},
  audioBlocked: false,
  memberCard: null,
  tool: null,
  floatTipClosed: false,
  floating: false,
  modal: null,
});

export const useApp = create<AppState>()(() => ({
  profile: loadProfile(),
  settings: loadSettings(),
  phase: 'landing',
  connectingText: '',
  landingError: null,
  inviteCode: null,
  handoff: null,
  ended: null,
  toasts: [],
  volumes: loadVolumes(),
  liveVolumes: loadLiveVolumes(),
  chatOpen: loadUiPrefs().chatOpen,
  chatWidth: loadUiPrefs().chatWidth,
  updateReady: false,
  ...roomDefaults(),
}));

export const getApp = useApp.getState;
export const setApp = useApp.setState;
export const resetRoomState = () => setApp(roomDefaults());

/** O chat de texto e a chamada da sala (cada sala tem um de cada). */
export const textChannelOf = (room: RoomState | null) => room?.channels.find((c) => c.type === 'text') ?? null;
export const voiceChannelOf = (room: RoomState | null) => room?.channels.find((c) => c.type === 'voice') ?? null;

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 3_800) {
  const id = ++toastId;
  setApp((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-4) }));
  window.setTimeout(() => setApp((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
