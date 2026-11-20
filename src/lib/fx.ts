import type { FxStroke, LiveFx, PenLook, PenStyle } from './protocol';

/**
 * Laser, lápis e borracha por cima da live.
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

export const PEN_STYLES: PenStyle[] = ['pen', 'marker', 'neon', 'dashed', 'spray'];
/** Espessura do pincel e diâmetro da borracha: pixels numa imagem de 1080 de altura. */
export const PEN_SIZE = { min: 2, max: 60, default: 6 };
export const ERASER_SIZE = { min: 10, max: 160, default: 48 };
const COLOR = /^#[0-9a-f]{6}$/i;

const total = (strokes: FxStroke[]) => strokes.reduce((sum, s) => sum + s.points.length, 0);

/** Acrescenta pontos a um traço (ou começa um novo). Devolve false se passou dos limites. */
export function addToStrokes(strokes: FxStroke[], from: string, id: string, points: number[], look: PenLook): boolean {
  let stroke = strokes.find((s) => s.from === from && s.id === id);
  if (!stroke) {
    if (strokes.length >= MAX_STROKES) return false;
    stroke = { id, from, points: [], color: look.color, size: look.size, style: look.style };
    strokes.push(stroke);
  }
  if (stroke.points.length + points.length > MAX_STROKE_VALUES) return false;
  if (total(strokes) + points.length > MAX_TOTAL_VALUES) return false;
  stroke.points.push(...points);
  return true;
}

/** Id determinístico para um pedaço que sobrou de um traço cortado pela borracha. */
function pieceId(from: string, id: string, start: number): string {
  let h = 2166136261;
  const text = `${from}:${id}:${start}`;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ('p' + (h >>> 0).toString(36) + start.toString(36)).slice(0, 16).padEnd(6, '0');
}

/**
 * Borracha: apaga só o pedaço dos traços por onde ela passou (o traço pode virar dois).
 * Determinística: todo mundo (e o hub) aplica a mesma conta e chega no mesmo desenho.
 * Distâncias na escala da altura da imagem (x é corrigido pelo formato da imagem).
 */
export function eraseStrokes(strokes: FxStroke[], path: number[], size: number, aspect: number): boolean {
  if (!strokes.length || path.length < 2) return false;
  const radius = size / 1080 / 2;
  // amostras do caminho da borracha, sem buracos maiores que meio raio
  const samples: number[] = [];
  for (let i = 0; i < path.length; i += 2) {
    const x = path[i] * aspect;
    const y = path[i + 1];
    if (i >= 2) {
      const px = path[i - 2] * aspect;
      const py = path[i - 1];
      const steps = Math.min(200, Math.floor(Math.hypot(x - px, y - py) / (radius / 2)));
      for (let k = 1; k <= steps; k++) samples.push(px + ((x - px) * k) / (steps + 1), py + ((y - py) * k) / (steps + 1));
    }
    samples.push(x, y);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < samples.length; i += 2) {
    minX = Math.min(minX, samples[i]);
    maxX = Math.max(maxX, samples[i]);
    minY = Math.min(minY, samples[i + 1]);
    maxY = Math.max(maxY, samples[i + 1]);
  }

  let changed = false;
  const next: FxStroke[] = [];
  for (const stroke of strokes) {
    const reach = radius + stroke.size / 1080 / 2;
    const pts = stroke.points;
    const n = pts.length / 2;
    // fora do alcance da borracha: fica como está
    let sMinX = Infinity;
    let sMinY = Infinity;
    let sMaxX = -Infinity;
    let sMaxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] * aspect;
      sMinX = Math.min(sMinX, x);
      sMaxX = Math.max(sMaxX, x);
      sMinY = Math.min(sMinY, pts[i + 1]);
      sMaxY = Math.max(sMaxY, pts[i + 1]);
    }
    if (sMinX - reach > maxX || sMaxX + reach < minX || sMinY - reach > maxY || sMaxY + reach < minY) {
      next.push(stroke);
      continue;
    }
    const hit = (ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      for (let k = 0; k < samples.length; k += 2) {
        const sx = samples[k];
        const sy = samples[k + 1];
        const t = len2 ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / len2)) : 0;
        if (Math.hypot(ax + t * dx - sx, ay + t * dy - sy) < reach) return true;
      }
      return false;
    };
    if (n === 1) {
      if (hit(pts[0] * aspect, pts[1], pts[0] * aspect, pts[1])) changed = true;
      else next.push(stroke);
      continue;
    }
    // segmentos apagados; os que sobram em sequência viram pedaços
    const pieces: Array<[number, number]> = [];
    let runStart = -1;
    for (let i = 0; i < n - 1; i++) {
      const erased = hit(pts[i * 2] * aspect, pts[i * 2 + 1], pts[i * 2 + 2] * aspect, pts[i * 2 + 3]);
      if (!erased && runStart < 0) runStart = i;
      if (erased && runStart >= 0) {
        pieces.push([runStart, i]);
        runStart = -1;
      }
    }
    if (runStart >= 0) pieces.push([runStart, n - 1]);
    if (pieces.length === 1 && pieces[0][0] === 0 && pieces[0][1] === n - 1) {
      next.push(stroke);
      continue;
    }
    changed = true;
    pieces.forEach(([a, b], index) => {
      // o último pedaço mantém o id: se a pessoa ainda está desenhando, o traço continua nele
      const id = index === pieces.length - 1 ? stroke.id : pieceId(stroke.from, stroke.id, a);
      next.push({ ...stroke, id, points: pts.slice(a * 2, b * 2 + 2) });
    });
  }
  if (!changed) return false;
  strokes.length = 0;
  strokes.push(...next.slice(0, MAX_STROKES));
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

export function drawStroke(streamerId: string, from: string, id: string, points: number[], look: PenLook) {
  let list = drawings.get(streamerId);
  if (!list) drawings.set(streamerId, (list = []));
  if (addToStrokes(list, from, id, points, look)) notify(streamerId);
}

export function eraseDrawing(streamerId: string, path: number[], size: number, aspect: number) {
  const list = drawings.get(streamerId);
  if (list && eraseStrokes(list, path, size, aspect)) notify(streamerId);
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

/** Tamanho dentro da faixa (pincel ou borracha). */
export function clampSize(n: unknown, range: { min: number; max: number; default: number }): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(range.min, Math.min(range.max, Math.round(v))) : range.default;
}

/** Cor, tamanho e estilo vindos da rede (com valores seguros). */
export function validLook(value: Record<string, unknown>): PenLook {
  return {
    color: typeof value.color === 'string' && COLOR.test(value.color) ? value.color.toLowerCase() : '#f43f5e',
    size: clampSize(value.size, PEN_SIZE),
    style: PEN_STYLES.includes(value.style as PenStyle) ? (value.style as PenStyle) : 'pen',
  };
}

function validPoints(value: unknown, max: number): number[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length % 2 || value.length > max) return null;
  const points = value.map((n) => round(clamp01(n)));
  return points.every(Number.isFinite) ? points : null;
}

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
      if (typeof fx.id !== 'string' || !STROKE_ID.test(fx.id)) return null;
      const points = validPoints(fx.points, MAX_VALUES_PER_MESSAGE);
      return points ? { kind: 'stroke', id: fx.id, points, ...validLook(fx) } : null;
    }
    case 'erase': {
      const points = validPoints(fx.points, MAX_VALUES_PER_MESSAGE);
      const aspect = Number(fx.aspect);
      if (!points || !Number.isFinite(aspect) || aspect < 0.2 || aspect > 5) return null;
      return { kind: 'erase', points, size: clampSize(fx.size, ERASER_SIZE), aspect: Math.round(aspect * 1000) / 1000 };
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
    out.push({
      id: s.id,
      from: s.from,
      points: s.points.slice(0, MAX_STROKE_VALUES).map((n) => round(clamp01(n))),
      ...validLook(s as Record<string, unknown>),
    });
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
  // traço e borracha dividem o mesmo limite
  const list = fx.kind === 'laser' ? limits.laser : limits.stroke;
  const max = fx.kind === 'laser' ? LASER_PER_SECOND : STROKES_PER_SECOND;
  while (list.length && now - list[0] >= 1_000) list.shift();
  if (list.length >= max) return false;
  list.push(now);
  return true;
}
