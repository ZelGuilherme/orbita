import { create } from 'zustand';
import type { Channel, ChannelType, ChatMessage, LiveInfo, RoomState } from './lib/protocol';
import type { EndReason } from './lib/session';
import { loadProfile, loadSettings, loadVolumes, type Profile, type Settings } from './lib/storage';

export type View = { kind: 'text' | 'voice'; channelId: string };
export type SettingsTab = 'perfil' | 'audio' | 'live' | 'rede' | 'sobre';

export type Modal =
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'invite' }
  | { kind: 'golive' }
  | { kind: 'leave' }
  | { kind: 'room' }
  | { kind: 'channel'; type: ChannelType; channel?: Channel }
  | { kind: 'image'; src: string; name: string }
  | { kind: 'confirm'; title: string; body: string; confirm: string; danger?: boolean; action: () => void };

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

export type Phase = 'landing' | 'connecting' | 'room' | 'ended';

export interface AppState {
  profile: Profile;
  settings: Settings;
  phase: Phase;
  connectingText: string;
  landingError: string | null;
  inviteCode: string | null;
  ended: { reason: EndReason; roomName: string; code: string } | null;
  toasts: Toast[];
  modal: Modal | null;
  volumes: Record<string, number>;

  // sala
  code: string | null;
  room: RoomState | null;
  meId: string | null;
  isHost: boolean;
  net: 'connected' | 'reconnecting';
  netDetail: string;
  messages: Record<string, ChatMessage[]>;
  typing: Record<string, Record<string, number>>;
  speaking: Record<string, boolean>;

  // mídia local
  voiceChannelId: string | null;
  joiningVoice: boolean;
  micOn: boolean;
  deafened: boolean;
  cameraOn: boolean;
  live: LiveInfo | null;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  voiceStreams: Record<string, MediaStream>;
  liveStreams: Record<string, MediaStream>;
  watching: Record<string, true>;

  // interface
  view: View | null;
  unread: Record<string, number>;
  mentions: Record<string, number>;
  showMembers: boolean;
  navOpen: boolean;
  focus: string | null;
  callLayout: 'auto' | 'grid' | 'orbit';
  localMutes: Record<string, boolean>;
  audioBlocked: boolean;
  memberCard: { memberId: string; x: number; y: number } | null;
}

const roomDefaults = () => ({
  code: null,
  room: null,
  meId: null,
  isHost: false,
  net: 'connected' as const,
  netDetail: '',
  messages: {},
  typing: {},
  speaking: {},
  voiceChannelId: null,
  joiningVoice: false,
  micOn: true,
  deafened: false,
  cameraOn: false,
  live: null,
  localCamera: null,
  localScreen: null,
  voiceStreams: {},
  liveStreams: {},
  watching: {},
  view: null,
  unread: {},
  mentions: {},
  navOpen: false,
  focus: null,
  callLayout: 'auto' as const,
  localMutes: {},
  audioBlocked: false,
  memberCard: null,
  modal: null,
});

export const useApp = create<AppState>()(() => ({
  profile: loadProfile(),
  settings: loadSettings(),
  phase: 'landing',
  connectingText: '',
  landingError: null,
  inviteCode: null,
  ended: null,
  toasts: [],
  volumes: loadVolumes(),
  showMembers: typeof window === 'undefined' || window.innerWidth > 1100,
  ...roomDefaults(),
}));

export const getApp = useApp.getState;
export const setApp = useApp.setState;
export const resetRoomState = () => setApp(roomDefaults());

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', ms = 3_800) {
  const id = ++toastId;
  setApp((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-4) }));
  window.setTimeout(() => setApp((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
