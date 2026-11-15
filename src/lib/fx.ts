import type { FxWink, LiveFx } from './protocol';

/**
 * Efeitos ao vivo (reações, "chamar atenção", animações e laser).
 *
 * Passam pelo hub como mensagens pequenas e cada pessoa desenha os efeitos por cima da live
 * na própria tela, sincronizados. Assim aparecem para todo mundo que assiste e para quem
 * transmite, sem recodificar o vídeo. O laser chega ~20 vezes por segundo.
 */

export const FX_REACTIONS = ['😂', '❤️', '🔥', '👏', '😮', '🎉', '💀', '🪐'];

export const FX_WINKS: Array<{ id: FxWink; label: string; icon: string }> = [
  { id: 'ufo', label: 'Disco voador', icon: '🛸' },
  { id: 'rocket', label: 'Foguete', icon: '🚀' },
  { id: 'meteor', label: 'Chuva de meteoros', icon: '☄️' },
  { id: 'confetti', label: 'Confete', icon: '🎊' },
  { id: 'hearts', label: 'Corações', icon: '💖' },
  { id: 'boom', label: 'Explosão', icon: '💥' },
  { id: 'kiss', label: 'Beijo', icon: '💋' },
  { id: 'snow', label: 'Neve', icon: '❄️' },
];

const WINK_IDS = new Set<string>(FX_WINKS.map((w) => w.id));

export interface FxEvent {
  streamerId: string;
  from: string;
  fx: LiveFx;
}

type Listener = (event: FxEvent) => void;
const listeners = new Set<Listener>();

export function onFx(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitFx(event: FxEvent) {
  for (const listener of listeners) listener(event);
}

const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n)));

/** Valida um efeito vindo da rede. */
export function validFx(value: unknown): LiveFx | null {
  if (!value || typeof value !== 'object') return null;
  const fx = value as Record<string, unknown>;
  switch (fx.kind) {
    case 'reaction':
      return typeof fx.emoji === 'string' && FX_REACTIONS.includes(fx.emoji) ? { kind: 'reaction', emoji: fx.emoji } : null;
    case 'nudge':
      return { kind: 'nudge' };
    case 'wink':
      return typeof fx.wink === 'string' && WINK_IDS.has(fx.wink) ? { kind: 'wink', wink: fx.wink as FxWink } : null;
    case 'laser': {
      const x = clamp01(fx.x);
      const y = clamp01(fx.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { kind: 'laser', x, y } : null;
    }
    case 'laser-off':
      return { kind: 'laser-off' };
    default:
      return null;
  }
}

export interface FxLimits {
  laser: number[];
  fx: number[];
  nudge: number;
}

/** Limite por pessoa, para ninguém transformar a live num caos. */
export const NUDGE_COOLDOWN_MS = 6_000;
const FX_WINDOW_MS = 3_000;
const FX_PER_WINDOW = 8;
const LASER_PER_SECOND = 30;

export function allowFx(limits: FxLimits, fx: LiveFx, now: number): boolean {
  if (fx.kind === 'laser-off') return true;
  if (fx.kind === 'laser') {
    limits.laser = limits.laser.filter((t) => now - t < 1_000);
    if (limits.laser.length >= LASER_PER_SECOND) return false;
    limits.laser.push(now);
    return true;
  }
  if (fx.kind === 'nudge') {
    if (now - limits.nudge < NUDGE_COOLDOWN_MS) return false;
    limits.nudge = now;
    return true;
  }
  limits.fx = limits.fx.filter((t) => now - t < FX_WINDOW_MS);
  if (limits.fx.length >= FX_PER_WINDOW) return false;
  limits.fx.push(now);
  return true;
}
