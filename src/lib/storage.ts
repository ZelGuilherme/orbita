import { COSMIC_NAMES, PLANET_COLORS } from './config';
import type { LiveQuality } from './protocol';
import { randomId } from './util';

export interface Profile {
  id: string;
  name: string;
  color: string;
}

export interface NetworkSettings {
  /** Vazio = servidor público do PeerJS (0.peerjs.com). */
  host: string;
  port: number;
  path: string;
  secure: boolean;
  key: string;
  /** JSON com uma lista de RTCIceServer. Vazio = STUN/TURN padrão do PeerJS. */
  iceServersJson: string;
}

export interface Settings {
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** 0..1 — nível a partir do qual você "está falando". */
  vadThreshold: number;
  cameraQuality: 'sd' | 'hd';
  liveQuality: LiveQuality;
  liveAudio: boolean;
  liveMotion: boolean;
  sounds: boolean;
  network: NetworkSettings;
}

const PROFILE_KEY = 'orbita.profile.v1';
const SETTINGS_KEY = 'orbita.settings.v1';
const VOLUMES_KEY = 'orbita.volumes.v1';

export const DEFAULT_NETWORK: NetworkSettings = {
  host: '',
  port: 443,
  path: '/',
  secure: true,
  key: 'peerjs',
  iceServersJson: '',
};

export const DEFAULT_SETTINGS: Settings = {
  audioInputId: '',
  audioOutputId: '',
  videoInputId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  vadThreshold: 0.32,
  cameraQuality: 'sd',
  liveQuality: '720p',
  liveAudio: true,
  liveMotion: true,
  sounds: true,
  network: DEFAULT_NETWORK,
};

function read<T>(key: string): Partial<T> | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível (aba anônima, bloqueado etc.) */
  }
}

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

export function loadProfile(): Profile {
  const saved = read<Profile>(PROFILE_KEY);
  const profile: Profile = {
    id: typeof saved?.id === 'string' && /^[a-z0-9]{8,32}$/.test(saved.id) ? saved.id : randomId(16),
    name:
      typeof saved?.name === 'string' && saved.name.trim()
        ? saved.name
        : `${pick(COSMIC_NAMES)} ${Math.floor(Math.random() * 900 + 100)}`,
    color: typeof saved?.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : pick(PLANET_COLORS),
  };
  write(PROFILE_KEY, profile);
  return profile;
}

export const saveProfile = (profile: Profile) => write(PROFILE_KEY, profile);

export function loadSettings(): Settings {
  const saved = read<Settings>(SETTINGS_KEY) ?? {};
  return { ...DEFAULT_SETTINGS, ...saved, network: { ...DEFAULT_NETWORK, ...(saved.network ?? {}) } };
}

export const saveSettings = (settings: Settings) => write(SETTINGS_KEY, settings);

export function loadVolumes(): Record<string, number> {
  const saved = read<Record<string, number>>(VOLUMES_KEY);
  return saved && typeof saved === 'object' ? (saved as Record<string, number>) : {};
}

export const saveVolumes = (volumes: Record<string, number>) => write(VOLUMES_KEY, volumes);
