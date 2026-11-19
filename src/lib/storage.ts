import { COSMIC_NAMES, PLANET_COLORS } from './config';
import { DEFAULT_KEYBINDS, sanitizeKeybinds, type Keybinds } from './keybinds';
import type { LiveQuality } from './protocol';
import { randomId } from './util';

export interface Profile {
  id: string;
  name: string;
  color: string;
  /** Foto (data URL webp/jpeg, 160x160). */
  avatar?: string;
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

/**
 * Supressão de ruído do microfone:
 * - browser: a do próprio navegador (leve, padrão);
 * - rnnoise: rede neural RNNoise (corta teclado, ventilador e barulho de rua);
 * - gtcrn: rede neural GTCRN (mais forte, usa um pouco mais de processador).
 */
export type NoiseFilter = 'off' | 'browser' | 'rnnoise' | 'gtcrn';
/** vad: transmite quando detecta voz; ptt: só enquanto a tecla está pressionada. */
export type VoiceMode = 'vad' | 'ptt';

export interface Settings {
  audioInputId: string;
  audioOutputId: string;
  videoInputId: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseFilter: NoiseFilter;
  /** Corta graves (ronco, vento, batidas na mesa). */
  highpass: boolean;
  /** Deixa o volume da voz mais uniforme. */
  compressor: boolean;
  /** Fecha o microfone abaixo da sensibilidade (não transmite barulho entre as falas). */
  noiseGate: boolean;
  /** Volume do microfone em % (100 = sem alteração). */
  inputGain: number;
  /** 0..1 — nível a partir do qual você "está falando". */
  vadThreshold: number;
  voiceMode: VoiceMode;
  /** Entrar na chamada com o microfone desligado. */
  joinMuted: boolean;
  cameraQuality: 'sd' | 'hd';
  liveQuality: LiveQuality;
  liveAudio: boolean;
  liveMotion: boolean;
  /** Aceitar laser e lápis dos espectadores nas minhas lives. */
  liveEffects: boolean;
  /** Codec de vídeo da live (auto = VP8). */
  liveCodec: 'auto' | 'VP9' | 'H264' | 'AV1';
  sounds: boolean;
  network: NetworkSettings;
  keybinds: Keybinds;
  /** Versão das configurações salvas (para migrar padrões antigos). */
  version: number;
}

/** Preferências da interface (só deste navegador). */
export interface UiPrefs {
  chatOpen: boolean;
  chatWidth: number | null;
}

const PROFILE_KEY = 'orbita.profile.v1';
const SETTINGS_KEY = 'orbita.settings.v1';
const VOLUMES_KEY = 'orbita.volumes.v1';
const LIVE_VOLUMES_KEY = 'orbita.liveVolumes.v1';
const UI_KEY = 'orbita.ui.v1';

/** Chaves que, mudando em outra aba ou no app instalado, valem também para esta janela. */
export const SYNCED_KEYS = { profile: PROFILE_KEY, settings: SETTINGS_KEY } as const;

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
  autoGainControl: true,
  noiseFilter: 'rnnoise',
  highpass: false,
  compressor: false,
  noiseGate: false,
  inputGain: 100,
  vadThreshold: 0.32,
  voiceMode: 'vad',
  joinMuted: true,
  cameraQuality: 'sd',
  liveQuality: '720p',
  liveAudio: true,
  liveMotion: true,
  liveEffects: true,
  liveCodec: 'auto',
  sounds: true,
  network: DEFAULT_NETWORK,
  keybinds: DEFAULT_KEYBINDS,
  version: 2,
};

const NOISE_FILTERS: NoiseFilter[] = ['off', 'browser', 'rnnoise', 'gtcrn'];

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

/** Foto de perfil aceitável: imagem pequena em data URL. */
export function validAvatar(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80_000 && /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(value);
}

export function loadProfile(): Profile {
  const saved = read<Profile>(PROFILE_KEY);
  const validId = typeof saved?.id === 'string' && /^[a-z0-9]{8,32}$/.test(saved.id);
  const validName = typeof saved?.name === 'string' && !!saved.name.trim();
  const validColor = typeof saved?.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color);
  const profile: Profile = {
    id: validId ? (saved!.id as string) : randomId(16),
    name: validName ? (saved!.name as string) : `${pick(COSMIC_NAMES)} ${Math.floor(Math.random() * 900 + 100)}`,
    color: validColor ? (saved!.color as string) : pick(PLANET_COLORS),
  };
  if (validAvatar(saved?.avatar)) profile.avatar = saved!.avatar as string;
  // só grava quando precisou inventar algo (gravar à toa avisaria as outras janelas)
  if (!validId || !validName || !validColor) write(PROFILE_KEY, profile);
  return profile;
}

export const saveProfile = (profile: Profile) => write(PROFILE_KEY, profile);

export function loadSettings(): Settings {
  const saved = (read<Settings>(SETTINGS_KEY) ?? {}) as Partial<Settings> & { noiseSuppression?: boolean };
  // versões antigas guardavam só "supressão de ruído: sim/não"
  let noiseFilter: NoiseFilter = NOISE_FILTERS.includes(saved.noiseFilter as NoiseFilter)
    ? (saved.noiseFilter as NoiseFilter)
    : saved.noiseSuppression === false
      ? 'off'
      : 'rnnoise';
  // versão 2: a supressão por IA virou o padrão (quem estava no padrão antigo, do navegador, muda junto)
  if ((saved.version ?? 1) < 2 && noiseFilter === 'browser') noiseFilter = 'rnnoise';
  const settings: Settings & { noiseSuppression?: boolean } = {
    ...DEFAULT_SETTINGS,
    ...saved,
    noiseFilter,
    voiceMode: saved.voiceMode === 'ptt' ? 'ptt' : 'vad',
    inputGain: clampNumber(saved.inputGain, 0, 200, 100),
    vadThreshold: clampNumber(saved.vadThreshold, 0.05, 0.9, DEFAULT_SETTINGS.vadThreshold),
    network: { ...DEFAULT_NETWORK, ...(saved.network ?? {}) },
    keybinds: sanitizeKeybinds(saved.keybinds),
    version: DEFAULT_SETTINGS.version,
  };
  delete settings.noiseSuppression;
  return settings;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export const saveSettings = (settings: Settings) => write(SETTINGS_KEY, settings);

export function loadVolumes(): Record<string, number> {
  const saved = read<Record<string, number>>(VOLUMES_KEY);
  return saved && typeof saved === 'object' ? (saved as Record<string, number>) : {};
}

export const saveVolumes = (volumes: Record<string, number>) => write(VOLUMES_KEY, volumes);

/** Volume (%) das lives de cada pessoa, separado do volume da voz dela. */
export function loadLiveVolumes(): Record<string, number> {
  const saved = read<Record<string, number>>(LIVE_VOLUMES_KEY);
  return saved && typeof saved === 'object' ? (saved as Record<string, number>) : {};
}

export const saveLiveVolumes = (volumes: Record<string, number>) => write(LIVE_VOLUMES_KEY, volumes);

export function loadUiPrefs(): UiPrefs {
  const saved = read<UiPrefs>(UI_KEY);
  // no celular o chat cobre a chamada: começa fechado
  const wide = typeof window === 'undefined' || window.innerWidth > 760;
  const width = Number(saved?.chatWidth);
  return { chatOpen: saved ? saved.chatOpen !== false : wide, chatWidth: Number.isFinite(width) && width >= 240 ? width : null };
}

export const saveUiPrefs = (prefs: UiPrefs) => write(UI_KEY, prefs);
