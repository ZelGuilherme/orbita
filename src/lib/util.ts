import { PLANET_COLORS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './config';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomFrom(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const randomId = (length = 12) => randomFrom(ID_ALPHABET, length);
export const roomCode = () => randomFrom(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);

/** Aceita um código puro, um link de convite (…#/sala/codigo) ou web+orbita://sala/codigo. */
export function parseRoomCode(input: string): string | null {
  const value = input.trim();
  const fromLink = value.match(/sala\/([a-z0-9]{4,16})/i);
  if (fromLink) return fromLink[1].toLowerCase();
  if (/^[a-z0-9]{4,16}$/i.test(value)) return value.toLowerCase();
  return null;
}

export function inviteFromHash(): string | null {
  const match = location.hash.match(/^#\/sala\/([a-z0-9]{4,16})/i);
  return match ? match[1].toLowerCase() : null;
}

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}#/sala/${code}`;
}

export function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function sanitizeName(value: unknown): string {
  return clampText(value, 64).replace(/\s+/g, ' ').trim().slice(0, 32) || 'Astronauta';
}

export function sanitizeColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : PLANET_COLORS[0];
}

export function sanitizeRoomName(value: unknown): string {
  return clampText(value, 80).replace(/\s+/g, ' ').trim().slice(0, 40) || 'Minha órbita';
}

export function initials(name: string, max = 1): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words
    .slice(0, max)
    .map((word) => [...word][0])
    .join('')
    .toUpperCase();
}

/** Iniciais da sala ignorando palavrinhas: "Órbita de Ana" → "ÓA". */
export function roomInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => [...w].length > 2);
  const list = meaningful.length ? meaningful : words;
  if (list.length <= 1) return initials(list.join(' ') || '?', 1);
  return initials(`${list[0]} ${list[list.length - 1]}`, 2);
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Hoje';
  if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clareia (amount > 0) ou escurece (amount < 0) uma cor #rrggbb. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  const mix = (c: number) => Math.round((target - c) * p + c);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Fundo de "planeta": esfera iluminada de cima-esquerda. */
export function planetBackground(color: string, color2?: string | null): string {
  if (!color2) return `radial-gradient(circle at 32% 26%, ${shade(color, 0.6)} 0%, ${color} 42%, ${shade(color, -0.55)} 100%)`;
  // duas cores: degradê diagonal, com o mesmo brilho no canto de cima
  return `radial-gradient(circle at 32% 26%, ${shade(color, 0.6)}cc 0%, transparent 38%), linear-gradient(150deg, ${color} 18%, ${color2} 78%, ${shade(color2, -0.5)} 100%)`;
}

export function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PLANET_COLORS[h % PLANET_COLORS.length];
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permissão negada pelo navegador';
    if (err.name === 'NotFoundError') return 'nenhum dispositivo encontrado';
    if (err.name === 'NotReadableError') return 'o dispositivo está em uso por outro programa';
    if (err.name === 'OverconstrainedError') return 'o dispositivo escolhido não está disponível';
  }
  return err instanceof Error ? err.message : String(err);
}
