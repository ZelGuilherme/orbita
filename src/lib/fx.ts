import type { FxStroke, LiveFx } from './protocol';

/**
 * Laser e lápis por cima da live.
 *
 * Passam pelo hub como mensagens pequenas e cada pessoa desenha por cima da imagem na
 * própria tela, sincronizados: aparecem para todo mundo que assiste e para quem transmite.
 * Coordenadas de 0 a 1 dentro da imagem. Os desenhos ficam até alguém apagar; o hub guarda
 * uma cópia para quem começar a assistir depois.
 */

// ───────────────────────── laser (eventos) ─────────────────────────

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

// ───────────────────────── desenhos ─────────────────────────

/** Limites por live, para ninguém travar a sala desenhando sem parar. */
export const MAX_STROKES = 400;
const MAX_STROKE_VALUES = 8_000;
const MAX_TOTAL_VALUES = 80_000;
const MAX_VALUES_PER_MESSAGE = 240;

const total = (strokes: FxStroke[]) => strokes.reduce((sum, s) => sum + s.points.length, 0);

/** Acrescenta pontos a um traço (ou começa um novo). Devolve false se passou dos limites. */
export function addToStrokes(strokes: FxStroke[], from: string, id: string, points: number[]): boolean {
  let stroke = strokes.find((s) => s.from === from && s.id === id);
  if (!stroke) {
    if (strokes.length >= MAX_STROKES) return false;
    stroke = { id, from, points: [] };
    strokes.push(stroke);
  }
  if (stroke.points.length + points.length > MAX_STROKE_VALUES) return false;
  if (total(strokes) + points.length > MAX_TOTAL_VALUES) return false;
  stroke.points.push(...points);
  return true;
}

const drawings = new Map<string, FxStroke[]>();
const drawListeners = new Set<(streamerId: string) => void>();
const notify = (streamerId: string) => drawListeners.forEach((fn) => fn(streamerId));

export function onDrawing(listener: (streamerId: string) => void): () => void {
  drawListeners.add(listener);
  return () => drawListeners.delete(listener);
}

export const strokesOf = (streamerId: string): FxStroke[] => drawings.get(streamerId) ?? [];

export function drawStroke(streamerId: string, from: string, id: string, points: number[]) {
  let list = drawings.get(streamerId);
  if (!list) drawings.set(streamerId, (list = []));
  if (addToStrokes(list, from, id, points)) notify(streamerId);
}

export function setDrawing(streamerId: string, strokes: FxStroke[]) {
  drawings.set(
    streamerId,
    strokes.map((s) => ({ ...s, points: [...s.points] })),
  );
  notify(streamerId);
}

export function clearDrawing(streamerId: string) {
  if (!drawings.get(streamerId)?.length) return;
  drawings.set(streamerId, []);
  notify(streamerId);
}

export function dropDrawing(streamerId: string) {
  if (drawings.delete(streamerId)) notify(streamerId);
}

// ───────────────────────── validação e limites ─────────────────────────

const STROKE_ID = /^[a-z0-9]{4,16}$/;
const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n)));
const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Valida um efeito vindo da rede. */
export function validFx(value: unknown): LiveFx | null {
  if (!value || typeof value !== 'object') return null;
  const fx = value as Record<string, unknown>;
  switch (fx.kind) {
    case 'laser': {
      const x = clamp01(fx.x);
      const y = clamp01(fx.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { kind: 'laser', x, y } : null;
    }
    case 'laser-off':
      return { kind: 'laser-off' };
    case 'stroke': {
      if (typeof fx.id !== 'string' || !STROKE_ID.test(fx.id) || !Array.isArray(fx.points)) return null;
      if (fx.points.length < 2 || fx.points.length % 2 || fx.points.length > MAX_VALUES_PER_MESSAGE) return null;
      const points = fx.points.map((n) => round(clamp01(n)));
      return points.every(Number.isFinite) ? { kind: 'stroke', id: fx.id, points } : null;
    }
    case 'clear':
      return { kind: 'clear' };
    default:
      return null;
  }
}

/** Valida a lista de traços que o hub manda para quem começou a assistir. */
export function validStrokes(value: unknown): FxStroke[] {
  if (!Array.isArray(value)) return [];
  const out: FxStroke[] = [];
  for (const item of value.slice(0, MAX_STROKES)) {
    const s = item as Partial<FxStroke>;
    if (typeof s?.id !== 'string' || typeof s.from !== 'string' || !Array.isArray(s.points) || s.points.length % 2) continue;
    out.push({ id: s.id, from: s.from, points: s.points.slice(0, MAX_STROKE_VALUES).map((n) => round(clamp01(n))) });
  }
  return out;
}

export interface FxLimits {
  laser: number[];
  stroke: number[];
  clear: number;
}

export const newFxLimits = (): FxLimits => ({ laser: [], stroke: [], clear: 0 });

const LASER_PER_SECOND = 75;
const STROKES_PER_SECOND = 60;
const CLEAR_COOLDOWN_MS = 500;

export function allowFx(limits: FxLimits, fx: LiveFx, now: number): boolean {
  if (fx.kind === 'laser-off') return true;
  if (fx.kind === 'clear') {
    if (now - limits.clear < CLEAR_COOLDOWN_MS) return false;
    limits.clear = now;
    return true;
  }
  const list = fx.kind === 'laser' ? limits.laser : limits.stroke;
  const max = fx.kind === 'laser' ? LASER_PER_SECOND : STROKES_PER_SECOND;
  while (list.length && now - list[0] >= 1_000) list.shift();
  if (list.length >= max) return false;
  list.push(now);
  return true;
}
