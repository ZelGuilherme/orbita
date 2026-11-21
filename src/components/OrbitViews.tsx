import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, ChevronDown, Circle, Maximize, MicOff, Target, ZoomIn, ZoomOut } from 'lucide-react';
import { setOrbitHidden, setOrbitView } from '../controller';
import type { Member, RoomState } from '../lib/protocol';
import type { OrbitView } from '../lib/storage';
import { hashColor, roomInitials } from '../lib/util';
import { hasWebGL } from '../lib/webgl';
import { useApp } from '../store';
import { Planet } from './Planet';
import { cx } from './ui';

const MODES: Array<{ id: OrbitView; label: string; title: string; icon: typeof Box }> = [
  { id: '3d', label: '3D', title: 'Planetas em 3D (gira a câmera e arrasta o seu planeta)', icon: Box },
  { id: '2d', label: '2D', title: 'Órbita plana, mais leve', icon: Circle },
  { id: 'line', label: 'Anéis', title: 'Host no meio e todos parados em anéis em volta (o mais leve; roda do mouse dá zoom)', icon: Target },
];

/** Troca entre 3D, 2D e anéis (fica sempre no canto de cima da área dos planetas). */
export function OrbitModeSwitch({ compact = false }: { compact?: boolean }) {
  const mode = useApp((s) => s.orbitView);
  const can3d = hasWebGL();
  return (
    <>
      <div className="orbit-modes" role="radiogroup" aria-label="Como mostrar os planetas">
        {MODES.filter((m) => m.id !== '3d' || can3d).map((m) => {
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              className={cx('orbit3d__tool', mode === m.id && 'is-on')}
              title={m.title}
              onClick={() => setOrbitView(m.id)}
            >
              <Icon size={13} /> {m.label}
            </button>
          );
        })}
      </div>
      {/* na faixa embaixo da live: minimizar os planetas (a live ocupa tudo) */}
      {compact && (
        <button type="button" className="orbit-min" aria-label="Minimizar planetas" data-tip="Minimizar planetas" onClick={() => setOrbitHidden(true)}>
          <ChevronDown size={13} />
        </button>
      )}
    </>
  );
}

/** Um planeta parado num anel (centro do planeta, a partir do centro da área). */
interface Spot {
  x: number;
  y: number;
}

interface RingsLayout {
  size: number;
  hostSize: number;
  /** Largura máxima do nome de quem está nos anéis e do host. */
  label: number;
  hostLabel: number;
  /** Deslocamento vertical de tudo (o nome fica embaixo do planeta). */
  cy: number;
  rings: Array<{ rx: number; ry: number }>;
  /** Forma dos anéis: 2 é círculo/elipse; maior que 2 vai virando um retângulo de pontas redondas. */
  shape: number;
  spots: Spot[];
  /** Metade da largura e da altura ocupadas. */
  extentX: number;
  extentY: number;
}

const MAX_ZOOM = 8;
const SAMPLES = 720;

interface Size {
  w: number;
  h: number;
}

/** As caixas (planeta + nome) de dois planetas do mesmo tamanho se encostam? */
function touches(ax: number, ay: number, bx: number, by: number, box: Size) {
  return Math.abs(ax - bx) < box.w && Math.abs(ay - by) < box.h;
}

/** Ponto t (0 a 2π, começando à direita) de uma superelipse com expoente p. */
function ringPoint(rx: number, ry: number, t: number, p: number): [number, number] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  if (p === 2) return [rx * c, ry * s];
  return [rx * Math.sign(c) * Math.abs(c) ** (2 / p), ry * Math.sign(s) * Math.abs(s) ** (2 / p)];
}

/** O contorno de um anel em SVG. */
function ringPath(rx: number, ry: number, p: number, cy: number) {
  const steps = 96;
  let d = '';
  for (let i = 0; i < steps; i++) {
    const [x, y] = ringPoint(rx, ry, (i / steps) * Math.PI * 2, p);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${(y + cy).toFixed(1)}`;
  }
  return d + 'Z';
}

/**
 * Lugares num anel, andando pelo contorno a partir da direita: um ponto vira lugar se a
 * caixa (planeta + nome) dele não encosta no host, no anel de dentro nem nos lugares já escolhidos
 * neste anel. Sai um encaixe justo, intercalado com o anel de dentro.
 */
function ringSlots(rx: number, ry: number, p: number, box: Size, host: Size, inner: Array<[number, number]>) {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < SAMPLES; i++) {
    const [x, y] = ringPoint(rx, ry, (i / SAMPLES) * Math.PI * 2, p);
    if (Math.abs(x) < (host.w + box.w) / 2 && Math.abs(y) < (host.h + box.h) / 2) continue;
    if (inner.some(([px, py]) => touches(x, y, px, py, box))) continue;
    if (out.some(([px, py]) => touches(x, y, px, py, box))) continue;
    out.push([x, y]);
  }
  return out;
}

/** n planetas à mesma distância num círculo, se nenhum encostar no host, no anel de dentro ou no vizinho. */
function evenly(r: number, n: number, box: Size, host: Size, inner: Array<[number, number]>): Array<[number, number]> | null {
  for (const offset of [0, 0.5, 0.25, 0.75]) {
    const pts = Array.from({ length: n }, (_, i): [number, number] => ringPoint(r, r, ((i + offset) / n) * Math.PI * 2, 2));
    const ok = pts.every(
      ([x, y], i) =>
        (Math.abs(x) >= (host.w + box.w) / 2 || Math.abs(y) >= (host.h + box.h) / 2) &&
        !inner.some(([px, py]) => touches(x, y, px, py, box)) &&
        !pts.some(([px, py], j) => j > i && touches(x, y, px, py, box)),
    );
    if (ok) return pts;
  }
  return null;
}

/**
 * Monta os anéis para um tamanho de planeta: o anel de dentro enche e o resto vai para fora.
 * Para no meio (null) se passar do limite.
 */
function ringsFor(n: number, size: number, aspect: number, compact: boolean, limitX = Infinity, limitY = Infinity): RingsLayout | null {
  // na faixa compacta o nome fica por cima da parte de baixo do planeta
  const labelH = compact ? 9 : 25;
  const hostSize = Math.round(size * (compact ? 1.3 : 1.4));
  const label = compact ? Math.max(40, Math.min(96, Math.round(size * 1.6))) : Math.max(64, Math.min(120, Math.round(size * 1.4) + 12));
  const hostLabel = Math.max(hostSize + 20, compact ? 96 : 120);
  const box = { w: Math.max(size, label) + 6, h: size + labelH + 6 };
  // a coroa passa um pouco por cima do planeta do host
  const host = { w: hostLabel + 6, h: Math.round(hostSize * 1.25) + labelH + 6 };
  const cy = -labelH / 2;
  // anéis redondos; na faixa compacta, achatados em duas fileiras retas (o host fica no meio)
  const shape = compact ? 6 : 2;
  // o primeiro anel dá a volta inteira no host (com o nome dele)
  const ry1 = compact ? box.h / 2 + 1 : Math.max(host.h + box.h, host.w + box.w) / 2;
  const gapY = compact ? box.h : 0.9 * Math.max(box.w, box.h);

  /** Enche anéis a partir de rx1 (até maxRings); null se não couber. */
  const fill = (rx1: number, gapX: number, maxRings: number): RingsLayout | null => {
    const rings: RingsLayout['rings'] = [];
    const spots: Spot[] = [];
    let extentX = host.w / 2;
    let extentY = host.h / 2;
    let inner: Array<[number, number]> = [];
    let left = n;
    for (let k = 0; left > 0 && k < maxRings; k++) {
      const ry = ry1 + k * gapY;
      const rx = rx1 + k * gapX;
      if (rx + box.w / 2 > limitX || ry + box.h / 2 > limitY) return null;
      const slots = ringSlots(rx, ry, shape, box, host, inner);
      if (!slots.length) continue;
      const count = Math.min(left, slots.length);
      // no círculo, tenta todos à mesma distância; senão (ou se encostar), o encaixe justo
      const pick =
        (shape === 2 && evenly(rx, count, box, host, inner)) ||
        (count === slots.length ? slots : Array.from({ length: count }, (_, i) => slots[Math.floor((i * slots.length) / count)]));
      for (const [x, y] of pick) spots.push({ x, y: y + cy });
      rings.push({ rx, ry });
      extentX = Math.max(extentX, rx + box.w / 2);
      extentY = Math.max(extentY, ry + box.h / 2);
      inner = pick;
      left -= count;
    }
    if (left > 0 || extentX > limitX || extentY > limitY) return null;
    return { size, hostSize, label, hostLabel, cy, rings, shape, spots, extentX, extentY };
  };

  if (!compact || n === 0) return fill(ry1, gapY, 60);
  if (!Number.isFinite(limitX)) return fill(ry1 * aspect, Math.max(box.w, gapY * aspect), 60);
  // faixa compacta: o anel mais estreito (com 1, 2 ou 3 anéis) em que todos cabem, até a borda
  const gapX = box.w * 1.05;
  for (let count = 1; count <= 3; count++) {
    if (ry1 + (count - 1) * gapY + box.h / 2 > limitY) break;
    let lo = Math.max(ry1 * 2, (host.w + box.w) / 2);
    let hi = limitX - box.w / 2 - (count - 1) * gapX;
    if (hi < lo) break;
    let best = fill(hi, gapX, count);
    if (!best) continue;
    // busca binária pela largura menor (cabe mais gente quanto mais largo)
    for (let i = 0; i < 7 && hi - lo > box.w / 4; i++) {
      const mid = (lo + hi) / 2;
      const l = fill(mid, gapX, count);
      if (l) {
        best = l;
        hi = mid;
      } else lo = mid;
    }
    return best;
  }
  return null;
}

/** O maior tamanho de planeta em que todos cabem na área; se nem o menor cabe, encolhe tudo. */
function ringsLayout(n: number, w: number, h: number, compact: boolean): RingsLayout & { scale: number } {
  // na faixa de baixo (larga e baixa) os anéis viram elipses, para usar a largura
  const aspect = compact && h > 0 ? Math.max(1, Math.min(10, w / h)) : 1;
  const min = compact ? 14 : 22;
  const max = Math.max(min, Math.round(compact ? Math.min(56, h * 0.5) : 72));
  for (let size = max; size >= min; size -= 2) {
    const l = ringsFor(n, size, aspect, compact, w / 2, h / 2);
    if (l) return { ...l, scale: 1 };
  }
  const l = ringsFor(n, min, aspect, compact)!;
  return { ...l, scale: w > 0 && h > 0 ? Math.min(1, w / 2 / l.extentX, h / 2 / l.extentY) : 1 };
}

/**
 * Modo anéis: o host no meio e os outros parados em anéis em volta (quantos anéis forem
 * precisos). Todos cabem na área; roda do mouse ou pinça aproxima, arrastar move e dois cliques
 * no fundo voltam. Nada se mexe (nem a textura e as luas dos planetas): é o modo mais leve.
 * Clicar num planeta faz o mesmo que na órbita (live, câmera ou cartão).
 */
export function OrbitRings({
  members,
  room,
  onPick,
  compact = false,
}: {
  members: Member[];
  room: RoomState;
  onPick: (member: Member, anchor: Element) => void;
  compact?: boolean;
}) {
  const speaking = useApp((s) => s.speaking);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [zoomed, setZoomed] = useState(false);
  const zoom = useRef({ s: 1, x: 0, y: 0 });
  const base = useRef(1);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const host = members.find((m) => m.id === room.hostId) ?? null;
  const others = members.filter((m) => m !== host);
  const pad = compact ? { top: 34, side: 10, bottom: 4 } : { top: 46, side: 16, bottom: 12 };
  const w = Math.max(0, area.w - pad.side * 2);
  const h = Math.max(0, area.h - pad.top - pad.bottom);
  const layout = useMemo(() => ringsLayout(others.length, w, h, compact), [others.length, w, h, compact]);
  base.current = layout.scale;

  /** Aplica o zoom direto no estilo (sem renderizar os planetas de novo a cada passo da roda). */
  const apply = useCallback((z: { s: number; x: number; y: number }) => {
    const el = stage.current;
    if (!el) return;
    const s = Math.max(1, Math.min(MAX_ZOOM, z.s));
    const mx = ((s - 1) * el.clientWidth) / 2;
    const my = ((s - 1) * el.clientHeight) / 2;
    const next = { s, x: Math.max(-mx, Math.min(mx, z.x)), y: Math.max(-my, Math.min(my, z.y)) };
    zoom.current = next;
    el.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.s * base.current})`;
    setZoomed(next.s > 1.001);
  }, []);

  /** Aproxima mantendo parado o ponto (a partir do centro da área) que está embaixo do cursor. */
  const zoomAt = useCallback(
    (factor: number, px = 0, py = 0) => {
      const z = zoom.current;
      const s = Math.max(1, Math.min(MAX_ZOOM, z.s * factor));
      const k = s / z.s;
      apply({ s, x: px - (px - z.x) * k, y: py - (py - z.y) * k });
    },
    [apply],
  );

  // a área ou os anéis mudaram de tamanho: refaz o zoom (e o limite de quanto dá para mover)
  const ready = w > 0 && h > 0;
  useLayoutEffect(() => apply(zoom.current), [apply, ready, w, h, layout.scale]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    /** Posição na tela a partir do centro da área (sem o zoom). */
    const fromCenter = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      return [clientX - r.left - pad.side - w / 2, clientY - r.top - pad.top - h / 2] as const;
    };
    const onTools = (t: EventTarget | null) => !!(t as Element | null)?.closest?.('.orbit3d__tools');

    const onWheel = (e: WheelEvent) => {
      if (onTools(e.target)) return;
      e.preventDefault();
      const [px, py] = fromCenter(e.clientX, e.clientY);
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), px, py);
    };

    // arrastar move (com zoom); dois dedos aproximam; um arrasto não vira clique no planeta
    const pts = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; zx: number; zy: number } | null = null;
    let panning = false;
    let pinch = 0;
    let swallow = false;
    const onDown = (e: PointerEvent) => {
      if ((e.button !== 0 && e.button !== 1) || onTools(e.target)) return;
      swallow = false;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) {
        start = { x: e.clientX, y: e.clientY, zx: zoom.current.x, zy: zoom.current.y };
        panning = false;
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        start = null;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) {
          const [px, py] = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
          zoomAt(d / pinch, px, py);
        }
        pinch = d;
        swallow = true;
        return;
      }
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!panning && Math.hypot(dx, dy) > 5 && zoom.current.s > 1.001) {
        panning = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-panning');
      }
      if (panning) apply({ s: zoom.current.s, x: start.zx + dx, y: start.zy + dy });
    };
    const onUp = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (panning) swallow = true;
      panning = false;
      start = null;
      if (pts.size < 2) pinch = 0;
      el.classList.remove('is-panning');
    };
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    };
    const onDbl = (e: MouseEvent) => {
      if ((e.target as Element).closest('[data-planet-id], .orbit3d__tools')) return;
      apply({ s: 1, x: 0, y: 0 });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('click', onClick, true);
    el.addEventListener('dblclick', onDbl);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('dblclick', onDbl);
    };
  }, [apply, zoomAt, w, h, pad.side, pad.top]);

  const { size, hostSize, cy } = layout;
  const item = (m: Member, isHost: boolean, spot: Spot | null) => {
    const muted = m.serverMuted || !m.micOn || m.deafened;
    const s = isHost ? hostSize : size;
    const x = spot ? spot.x : 0;
    const y = spot ? spot.y : cy;
    return (
      <button
        key={m.id}
        type="button"
        data-planet-id={m.id}
        className={cx('orbit-rings__item', isHost && 'is-host', m.reconnecting && 'is-away')}
        style={{ left: w / 2 + x, top: h / 2 + y - s / 2 }}
        aria-label={m.live ? `${m.name}: assistir live` : m.cameraOn ? `${m.name}: ver câmera` : m.name}
        onClick={(e) => onPick(m, e.currentTarget)}
      >
        <Planet memberId={m.id} name={m.name} color={m.color} size={s} host={isHost} speaking={!!speaking[m.id]} live={!!m.live} />
        <span className="orbit3d__name" style={{ maxWidth: spot ? layout.label : layout.hostLabel }} title={m.name}>
          {m.live && <span className="live-dot" />}
          {m.name}
          {muted && <MicOff size={12} />}
        </span>
      </button>
    );
  };

  return (
    <div className={cx('orbit-rings', compact && 'orbit-rings--compact')} ref={box}>
      {ready && (
        <div className="orbit-rings__stage" ref={stage} style={{ left: pad.side, top: pad.top, width: w, height: h }}>
          <svg className="orbit-rings__lines" width={w} height={h} viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`} aria-hidden="true">
            {layout.rings.map((r, i) =>
              layout.shape === 2 ? <ellipse key={i} cx={0} cy={cy} rx={r.rx} ry={r.ry} /> : <path key={i} d={ringPath(r.rx, r.ry, layout.shape, cy)} />,
            )}
          </svg>
          {host ? (
            item(host, true, null)
          ) : (
            <div className="orbit-rings__item is-host is-room" style={{ left: w / 2, top: h / 2 + cy - hostSize / 2 }}>
              <Planet name={room.name} color={hashColor(room.code)} size={hostSize} text={roomInitials(room.name)} />
              <span className="orbit3d__name" style={{ maxWidth: layout.hostLabel }}>
                {room.name}
              </span>
            </div>
          )}
          {others.map((m, i) => item(m, false, layout.spots[i] ?? null))}
        </div>
      )}
      <div className="orbit3d__tools">
        <OrbitModeSwitch compact={compact} />
        <div className="orbit-modes" role="group" aria-label="Zoom">
          <button type="button" className="orbit3d__tool" title="Afastar" aria-label="Afastar" disabled={!zoomed} onClick={() => zoomAt(1 / 1.4)}>
            <ZoomOut size={13} />
          </button>
          <button type="button" className="orbit3d__tool" title="Aproximar (ou use a roda do mouse)" aria-label="Aproximar" onClick={() => zoomAt(1.4)}>
            <ZoomIn size={13} />
          </button>
          {zoomed && (
            <button
              type="button"
              className="orbit3d__tool"
              title="Mostrar todos (ou dois cliques no fundo)"
              aria-label="Mostrar todos"
              onClick={() => apply({ s: 1, x: 0, y: 0 })}
            >
              <Maximize size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
