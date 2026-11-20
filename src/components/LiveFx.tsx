import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Crosshair, Eraser, Pencil, Trash2 } from 'lucide-react';
import { beginErase, beginStroke, clearDrawings, endErase, endStroke, extendErase, extendStroke, hideLaser, moveLaser, setFxBarHidden, setPen, setTool } from '../controller';
import { ERASER_SIZE, onDrawing, onFx, PEN_SIZE, strokesOf } from '../lib/fx';
import type { FxStroke, Member, PenStyle } from '../lib/protocol';
import { useApp, type FxTool } from '../store';
import { cx } from './ui';

/**
 * Laser, lápis e borracha por cima da live. A camada fica alinhada com a imagem do vídeo
 * (sem as faixas pretas), então um ponto em (0,5; 0,5) é o mesmo lugar na tela de todo mundo.
 * Os traços são desenhados em pixels da tela, com espessura proporcional à altura da imagem:
 * o desenho fica igual numa tela pequena ou em tela cheia.
 */

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Laser {
  el: HTMLDivElement;
  /** Rastro: os últimos pontos, que vão sumindo. */
  trail: SVGGElement;
  points: Array<{ x: number; y: number; t: number }>;
  color: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  at: number;
  own: boolean;
}

/** Retângulo da imagem dentro do elemento (object-fit: contain). */
function contentBox(video: HTMLVideoElement | null, width: number, height: number, aspect?: number): Box {
  let vw = video?.videoWidth ?? 0;
  let vh = video?.videoHeight ?? 0;
  // sem vídeo (prévia escondida): usa o formato da tela transmitida
  if ((!vw || !vh) && aspect) {
    vw = aspect;
    vh = 1;
  }
  if (!vw || !vh || !width || !height) return { left: 0, top: 0, width, height };
  const scale = Math.min(width / vw, height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

const TRAIL_MS = 420;

/** Desenha o rastro do laser: segmentos que afinam e somem com a idade. */
function drawTrail(l: Laser, now: number) {
  const pts = l.points;
  let html = '';
  for (let i = 1; i < pts.length; i++) {
    const life = 1 - (now - pts[i].t) / TRAIL_MS;
    if (life <= 0) continue;
    html += `<line x1="${pts[i - 1].x}" y1="${pts[i - 1].y}" x2="${pts[i].x}" y2="${pts[i].y}" stroke="${l.color}" stroke-opacity="${(life * 0.85).toFixed(2)}" stroke-width="${(1.5 + life * 5).toFixed(1)}" />`;
  }
  l.trail.innerHTML = html;
}

// ───────────────────────── traços ─────────────────────────

function pathOf(points: number[], w: number, h: number): string {
  let d = '';
  for (let i = 0; i < points.length; i += 2) d += `${i ? 'L' : 'M'}${(points[i] * w).toFixed(1)} ${(points[i + 1] * h).toFixed(1)}`;
  // um clique só vira um pontinho
  if (points.length === 2) d += `l0.01 0`;
  return d;
}

/** Números "aleatórios" que saem iguais em todas as telas (o spray fica igual para todo mundo). */
function seeded(a: number, b: number, k: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f) ^ Math.imul(k + 1, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const SPRAY_DOTS_PER_STATION = 4;
const SPRAY_MAX_DOTS = 4_000;

/** Spray: pontinhos espalhados ao longo do traço (na escala da imagem, iguais em qualquer tamanho). */
function sprayOf(points: number[], size: number, w: number, h: number): string {
  if (!w || !h) return '';
  const aspect = w / h;
  const radius = size / 1080 / 2;
  const step = Math.max(radius * 0.5, 0.002);
  let d = '';
  let dots = 0;
  let carry = 0;
  const station = (x: number, y: number) => {
    const ix = Math.round(x * 10_000);
    const iy = Math.round(y * 10_000);
    for (let k = 0; k < SPRAY_DOTS_PER_STATION && dots < SPRAY_MAX_DOTS; k++, dots++) {
      const angle = seeded(ix, iy, k * 2) * Math.PI * 2;
      const dist = Math.sqrt(seeded(ix, iy, k * 2 + 1)) * radius;
      const px = (x * aspect + Math.cos(angle) * dist) / aspect;
      const py = y + Math.sin(angle) * dist;
      d += `M${(px * w).toFixed(1)} ${(py * h).toFixed(1)}h0.01`;
    }
  };
  station(points[0], points[1]);
  for (let i = 2; i < points.length && dots < SPRAY_MAX_DOTS; i += 2) {
    const ax = points[i - 2] * aspect;
    const ay = points[i - 1];
    const bx = points[i] * aspect;
    const by = points[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    let t = step - carry;
    while (t <= len && dots < SPRAY_MAX_DOTS) {
      const f = t / len;
      station((ax + (bx - ax) * f) / aspect, ay + (by - ay) * f);
      t += step;
    }
    carry = len - (t - step);
  }
  return d;
}

function StrokeShape({ stroke, w, h }: { stroke: FxStroke; w: number; h: number }): ReactNode {
  const width = Math.max(1, (stroke.size * h) / 1080);
  const d = stroke.style === 'spray' ? sprayOf(stroke.points, stroke.size, w, h) : pathOf(stroke.points, w, h);
  const color = stroke.color;
  switch (stroke.style) {
    case 'marker':
      return <path className="fx-marker" d={d} stroke={color} strokeWidth={width} />;
    case 'neon':
      return (
        <g className="fx-neon" style={{ '--c': color } as CSSProperties}>
          <path d={d} stroke={color} strokeWidth={width} />
          <path d={d} stroke="#fff" strokeWidth={Math.max(1, width * 0.35)} strokeOpacity={0.9} />
        </g>
      );
    case 'dashed':
      return <path className="fx-pen" d={d} stroke={color} strokeWidth={width} strokeDasharray={`${(width * 1.8).toFixed(1)} ${(width * 1.6).toFixed(1)}`} strokeLinecap="butt" />;
    case 'spray':
      return <path className="fx-spray" d={d} stroke={color} strokeWidth={Math.max(1.2, width * 0.16)} />;
    default:
      return <path className="fx-pen" d={d} stroke={color} strokeWidth={width} />;
  }
}

export function FxLayer({
  streamerId,
  videoRef,
  members,
  tool,
  aspect,
}: {
  streamerId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  members: Member[];
  /** Ferramenta ativa nesta tela (null = só mostra). */
  tool: FxTool | null;
  /** Formato da imagem quando não há vídeo na tela (largura / altura). */
  aspect?: number;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const trails = useRef<SVGSVGElement>(null);
  const eraserRef = useRef<HTMLDivElement>(null);
  const lasers = useRef(new Map<string, Laser>());
  const raf = useRef(0);
  const pressing = useRef<FxTool | null>(null);
  const meId = useApp((s) => s.meId);
  const eraserSize = useApp((s) => s.pen.eraserSize);
  const [box, setBox] = useState<Box>({ left: 0, top: 0, width: 0, height: 0 });
  const [strokes, setStrokes] = useState(() => [...strokesOf(streamerId)]);
  const membersRef = useRef(members);
  membersRef.current = members;

  // acompanha o tamanho da imagem
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const update = () => {
      const next = contentBox(videoRef.current, el.clientWidth, el.clientHeight, aspect);
      setBox((prev) =>
        Math.abs(prev.left - next.left) < 0.5 &&
        Math.abs(prev.top - next.top) < 0.5 &&
        Math.abs(prev.width - next.width) < 0.5 &&
        Math.abs(prev.height - next.height) < 0.5
          ? prev
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    const video = videoRef.current;
    video?.addEventListener('loadedmetadata', update);
    video?.addEventListener('resize', update);
    const timer = window.setInterval(update, 1_000);
    return () => {
      observer.disconnect();
      video?.removeEventListener('loadedmetadata', update);
      video?.removeEventListener('resize', update);
      clearInterval(timer);
    };
  }, [videoRef, aspect]);

  // desenhos
  useEffect(() => {
    setStrokes([...strokesOf(streamerId)]);
    return onDrawing((id) => {
      if (id === streamerId) setStrokes([...strokesOf(streamerId)]);
    });
  }, [streamerId]);

  // lasers: posição nova a cada mensagem, desenhada quadro a quadro
  useEffect(() => {
    const current = lasers.current;
    const frame = () => {
      raf.current = 0;
      const now = performance.now();
      for (const [from, l] of current) {
        if (now - l.at > 2_500) {
          remove(from);
          continue;
        }
        // o próprio laser fica colado no cursor; o dos outros desliza um pouco entre mensagens
        l.x = l.own ? l.tx : l.x + (l.tx - l.x) * 0.6;
        l.y = l.own ? l.ty : l.y + (l.ty - l.y) * 0.6;
        l.el.style.transform = `translate(${(l.x * 100).toFixed(3)}cqw, ${(l.y * 100).toFixed(3)}cqh)`;
        const last = l.points[l.points.length - 1];
        if (!last || Math.abs(last.x - l.x) + Math.abs(last.y - l.y) > 0.0005) l.points.push({ x: l.x, y: l.y, t: now });
        while (l.points.length && now - l.points[0].t > TRAIL_MS) l.points.shift();
        drawTrail(l, now);
      }
      if (current.size) raf.current = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf.current) raf.current = requestAnimationFrame(frame);
    };
    const remove = (from: string) => {
      const l = current.get(from);
      if (!l) return;
      current.delete(from);
      l.el.remove();
      l.trail.remove();
    };
    const off = onFx((event) => {
      if (event.streamerId !== streamerId) return;
      if (event.fx.kind === 'laser-off') {
        remove(event.from);
        return;
      }
      if (event.fx.kind !== 'laser' || !stage.current || !trails.current) return;
      let l = current.get(event.from);
      if (!l) {
        const who = membersRef.current.find((m) => m.id === event.from);
        const el = document.createElement('div');
        el.className = 'fx-laser';
        el.style.setProperty('--c', who?.color ?? '#f43f5e');
        const dot = document.createElement('i');
        const label = document.createElement('span');
        label.textContent = who?.name ?? '';
        el.append(dot, label);
        stage.current.append(el);
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        trails.current.append(trail);
        const color = who?.color ?? '#f43f5e';
        l = { el, trail, points: [], color, x: event.fx.x, y: event.fx.y, tx: event.fx.x, ty: event.fx.y, at: 0, own: event.from === meId };
        current.set(event.from, l);
      }
      l.tx = event.fx.x;
      l.ty = event.fx.y;
      l.at = performance.now();
      kick();
    });
    return () => {
      off();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      for (const l of current.values()) {
        l.el.remove();
        l.trail.remove();
      }
      current.clear();
    };
  }, [streamerId, meId]);

  // largou a ferramenta no meio do gesto: termina o que estava fazendo
  useEffect(() => {
    return () => {
      if (pressing.current === 'pencil') endStroke();
      if (pressing.current === 'eraser') endErase();
      if (pressing.current === 'laser') hideLaser(streamerId);
      pressing.current = null;
    };
  }, [tool, streamerId]);

  const pointOf = (e: ReactPointerEvent<HTMLDivElement>): [number, number] | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  };

  const moveEraser = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = eraserRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // com zoom, a tela mostra a área maior: converte para o tamanho de dentro
    const k = e.currentTarget.offsetWidth / (rect.width || 1);
    el.style.transform = `translate(${(e.clientX - rect.left) * k}px, ${(e.clientY - rect.top) * k}px) translate(-50%, -50%)`;
    el.style.opacity = '1';
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool || e.button > 0) return;
    e.stopPropagation();
    const p = pointOf(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pressing.current = tool;
    if (tool === 'pencil') beginStroke(streamerId, p[0], p[1]);
    else if (tool === 'eraser') beginErase(streamerId, p[0], p[1], box.height ? box.width / box.height : 16 / 9);
    // o laser só aparece enquanto o botão está apertado
    else moveLaser(streamerId, p[0], p[1]);
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool) return;
    if (tool === 'eraser') moveEraser(e);
    if (!pressing.current) return;
    const p = pointOf(e);
    if (!p) return;
    if (pressing.current === 'laser') moveLaser(streamerId, p[0], p[1]);
    else if (pressing.current === 'pencil') extendStroke(p[0], p[1]);
    else extendErase(p[0], p[1]);
  };

  const onUp = () => {
    const was = pressing.current;
    pressing.current = null;
    if (was === 'pencil') endStroke();
    else if (was === 'eraser') endErase();
    else if (was === 'laser') hideLaser(streamerId);
  };

  const shapes = useMemo(() => strokes.map((s) => <StrokeShape key={`${s.from}:${s.id}`} stroke={s} w={box.width} h={box.height} />), [strokes, box.width, box.height]);
  const eraserPx = Math.max(6, (eraserSize * box.height) / 1080);

  return (
    <div ref={layer} className="fx-layer">
      <div
        ref={stage}
        className={cx('fx-stage', tool && `is-${tool}`)}
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => {
          if (eraserRef.current) eraserRef.current.style.opacity = '0';
        }}
        onClick={(e) => tool && e.stopPropagation()}
        onDoubleClick={(e) => tool && e.stopPropagation()}
      >
        <svg ref={trails} className="fx-draw fx-trails" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" />
        <svg className="fx-draw fx-strokes" width={box.width} height={box.height} aria-hidden="true">
          {shapes}
        </svg>
        {tool === 'eraser' && <div ref={eraserRef} className="fx-eraser" style={{ width: eraserPx, height: eraserPx }} />}
      </div>
    </div>
  );
}

// ───────────────────────── barra de ferramentas ─────────────────────────

const STYLE_OPTIONS: Array<{ id: PenStyle; label: string }> = [
  { id: 'pen', label: 'Normal' },
  { id: 'marker', label: 'Marca-texto' },
  { id: 'neon', label: 'Neon' },
  { id: 'dashed', label: 'Tracejado' },
  { id: 'spray', label: 'Spray' },
];

const SWATCHES = ['#f43f5e', '#f97316', '#facc15', '#22c55e', '#22d3ee', '#3b82f6', '#a855f7', '#ffffff', '#111827'];

/** Amostra do estilo (um traço curto desenhado com ele). */
function StylePreview({ style, color }: { style: PenStyle; color: string }) {
  const stroke: FxStroke = { id: 'x', from: 'x', points: [0.12, 0.65, 0.35, 0.3, 0.6, 0.62, 0.88, 0.3], color, size: style === 'marker' ? 260 : style === 'spray' ? 300 : 110, style };
  return (
    <svg className="fx-style__preview" width={40} height={22} aria-hidden="true">
      <StrokeShape stroke={stroke} w={40} h={22} />
    </svg>
  );
}

/** Ferramentas sobre a live: laser, lápis (cor, tamanho e estilo), borracha e apagar tudo. */
export function FxBar({ streamerId }: { streamerId: string }) {
  const tool = useApp((s) => s.tool);
  const pen = useApp((s) => s.pen);
  const planetColor = useApp((s) => s.profile.color);
  const color = pen.color ?? planetColor;
  const [hasDrawing, setHasDrawing] = useState(() => strokesOf(streamerId).length > 0);
  useEffect(() => {
    setHasDrawing(strokesOf(streamerId).length > 0);
    return onDrawing((id) => {
      if (id === streamerId) setHasDrawing(strokesOf(streamerId).length > 0);
    });
  }, [streamerId]);
  useEffect(() => {
    if (tool !== 'laser') return;
    return () => hideLaser(streamerId);
  }, [tool, streamerId]);
  const hidden = useApp((s) => s.fxBarHidden);

  // minimizada: só um botãozinho para trazer a barra de volta
  if (hidden) {
    return (
      <div className="fx-bar fx-bar--min" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" className="fx-bar__show" aria-label="Mostrar as ferramentas (laser, lápis…)" onClick={() => setFxBarHidden(false)}>
          <Pencil size={14} /> Ferramentas <ChevronUp size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="fx-bar" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {tool === 'pencil' && (
        <div className="fx-opts" role="group" aria-label="Pincel">
          <div className="fx-opts__row">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={cx('fx-swatch', color.toLowerCase() === c && 'is-on')}
                style={{ background: c }}
                aria-label={`Cor ${c}`}
                onClick={() => setPen({ color: c })}
              />
            ))}
            <label className="fx-swatch fx-swatch--custom" data-tip="Outra cor">
              <input type="color" value={color} aria-label="Escolher outra cor" onChange={(e) => setPen({ color: e.target.value })} />
            </label>
            <button
              type="button"
              className={cx('fx-swatch fx-swatch--planet', !pen.color && 'is-on')}
              style={{ background: planetColor }}
              aria-label="Cor do meu planeta"
              data-tip="Cor do meu planeta"
              onClick={() => setPen({ color: null })}
            />
          </div>
          <div className="fx-opts__row">
            {STYLE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={cx('fx-style', pen.style === o.id && 'is-on')}
                aria-label={o.label}
                aria-pressed={pen.style === o.id}
                data-tip={o.label}
                onClick={() => setPen({ style: o.id })}
              >
                <StylePreview style={o.id} color={color} />
              </button>
            ))}
          </div>
          <label className="fx-opts__size">
            <span>Tamanho</span>
            <input
              type="range"
              min={PEN_SIZE.min}
              max={PEN_SIZE.max}
              value={pen.size}
              aria-label="Tamanho do pincel"
              style={{ '--fill': `${((pen.size - PEN_SIZE.min) / (PEN_SIZE.max - PEN_SIZE.min)) * 100}%` } as CSSProperties}
              onChange={(e) => setPen({ size: Number(e.target.value) })}
            />
            <i className="fx-opts__dot" style={{ width: Math.max(3, pen.size / 2.2), height: Math.max(3, pen.size / 2.2), background: color }} />
          </label>
        </div>
      )}
      {tool === 'eraser' && (
        <div className="fx-opts" role="group" aria-label="Borracha">
          <label className="fx-opts__size">
            <span>Tamanho da borracha</span>
            <input
              type="range"
              min={ERASER_SIZE.min}
              max={ERASER_SIZE.max}
              value={pen.eraserSize}
              aria-label="Tamanho da borracha"
              style={{ '--fill': `${((pen.eraserSize - ERASER_SIZE.min) / (ERASER_SIZE.max - ERASER_SIZE.min)) * 100}%` } as CSSProperties}
              onChange={(e) => setPen({ eraserSize: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <button
        type="button"
        className={cx('fx-bar__btn', tool === 'laser' && 'is-on')}
        aria-label="Laser"
        aria-pressed={tool === 'laser'}
        data-tip={tool === 'laser' ? 'Desligar o laser' : 'Laser: segure o botão do mouse e aponte'}
        onClick={() => setTool('laser')}
      >
        <Crosshair size={17} />
      </button>
      <button
        type="button"
        className={cx('fx-bar__btn', tool === 'pencil' && 'is-on')}
        aria-label="Lápis"
        aria-pressed={tool === 'pencil'}
        data-tip={tool === 'pencil' ? 'Guardar o lápis' : 'Lápis: segure e arraste para desenhar'}
        onClick={() => setTool('pencil')}
      >
        <Pencil size={17} />
        <i className="fx-bar__color" style={{ background: color }} />
      </button>
      <button
        type="button"
        className={cx('fx-bar__btn', tool === 'eraser' && 'is-on')}
        aria-label="Borracha"
        aria-pressed={tool === 'eraser'}
        data-tip={tool === 'eraser' ? 'Guardar a borracha' : 'Borracha: apaga só por onde passar'}
        disabled={!hasDrawing && tool !== 'eraser'}
        onClick={() => setTool('eraser')}
      >
        <Eraser size={17} />
      </button>
      <button type="button" className="fx-bar__btn" aria-label="Apagar tudo" data-tip="Apagar todos os desenhos" disabled={!hasDrawing} onClick={() => clearDrawings(streamerId)}>
        <Trash2 size={17} />
      </button>
      <span className="fx-bar__sep" aria-hidden="true" />
      <button type="button" className="fx-bar__btn" aria-label="Minimizar as ferramentas" data-tip="Minimizar as ferramentas" onClick={() => setFxBarHidden(true)}>
        <ChevronDown size={17} />
      </button>
    </div>
  );
}
