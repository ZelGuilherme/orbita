import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Crosshair, Eraser, Pencil } from 'lucide-react';
import { beginStroke, clearDrawings, endStroke, extendStroke, hideLaser, moveLaser, setTool } from '../controller';
import { onDrawing, onFx, strokesOf } from '../lib/fx';
import type { Member } from '../lib/protocol';
import { useApp } from '../store';
import { cx } from './ui';

/**
 * Laser e lápis por cima da live. A camada fica alinhada com a imagem do vídeo (sem as
 * faixas pretas), então um ponto em (0,5; 0,5) é o mesmo lugar na tela de todo mundo.
 */

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Laser {
  el: HTMLDivElement;
  x: number;
  y: number;
  tx: number;
  ty: number;
  at: number;
  own: boolean;
}

/** Retângulo da imagem dentro do elemento (object-fit: contain). */
function contentBox(video: HTMLVideoElement | null, width: number, height: number): Box {
  const vw = video?.videoWidth ?? 0;
  const vh = video?.videoHeight ?? 0;
  if (!vw || !vh || !width || !height) return { left: 0, top: 0, width, height };
  const scale = Math.min(width / vw, height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

function pathOf(points: number[]): string {
  let d = '';
  for (let i = 0; i < points.length; i += 2) d += `${i ? 'L' : 'M'}${points[i]} ${points[i + 1]}`;
  // um clique só vira um pontinho
  if (points.length === 2) d += `L${points[0] + 0.0001} ${points[1]}`;
  return d;
}

export function FxLayer({
  streamerId,
  videoRef,
  members,
  tool,
}: {
  streamerId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  members: Member[];
  /** Ferramenta ativa nesta tela (null = só mostra). */
  tool: 'laser' | 'pencil' | null;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const lasers = useRef(new Map<string, Laser>());
  const raf = useRef(0);
  const drawing = useRef(false);
  const meId = useApp((s) => s.meId);
  const [box, setBox] = useState<Box>({ left: 0, top: 0, width: 0, height: 0 });
  const [strokes, setStrokes] = useState(() => [...strokesOf(streamerId)]);
  const membersRef = useRef(members);
  membersRef.current = members;

  // acompanha o tamanho da imagem
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const update = () => {
      const next = contentBox(videoRef.current, el.clientWidth, el.clientHeight);
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
  }, [videoRef]);

  // desenhos do lápis
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
    };
    const off = onFx((event) => {
      if (event.streamerId !== streamerId) return;
      if (event.fx.kind === 'laser-off') {
        remove(event.from);
        return;
      }
      if (event.fx.kind !== 'laser' || !stage.current) return;
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
        l = { el, x: event.fx.x, y: event.fx.y, tx: event.fx.x, ty: event.fx.y, at: 0, own: event.from === meId };
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
      for (const l of current.values()) l.el.remove();
      current.clear();
    };
  }, [streamerId, meId]);

  const pointOf = (e: ReactPointerEvent<HTMLDivElement>): [number, number] | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool) return;
    e.stopPropagation();
    const p = pointOf(e);
    if (!p) return;
    if (tool === 'pencil') {
      e.currentTarget.setPointerCapture(e.pointerId);
      drawing.current = true;
      beginStroke(streamerId, p[0], p[1]);
    } else {
      moveLaser(streamerId, p[0], p[1]);
    }
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool) return;
    const p = pointOf(e);
    if (!p) return;
    if (tool === 'laser') moveLaser(streamerId, p[0], p[1]);
    else if (drawing.current) extendStroke(p[0], p[1]);
  };

  const onUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    endStroke();
  };

  const colorOf = (id: string) => members.find((m) => m.id === id)?.color ?? '#f43f5e';

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
          if (tool === 'laser') hideLaser(streamerId);
        }}
        onClick={(e) => tool && e.stopPropagation()}
        onDoubleClick={(e) => tool && e.stopPropagation()}
      >
        <svg className="fx-draw" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {strokes.map((s) => (
            <path key={`${s.from}:${s.id}`} d={pathOf(s.points)} stroke={colorOf(s.from)} />
          ))}
        </svg>
      </div>
    </div>
  );
}

/** Ferramentas sobre a live: laser, lápis e apagar tudo. */
export function FxBar({ streamerId }: { streamerId: string }) {
  const tool = useApp((s) => s.tool);
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
  return (
    <div className="fx-bar" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={cx('fx-bar__btn', tool === 'laser' && 'is-on')}
        aria-label="Laser"
        aria-pressed={tool === 'laser'}
        data-tip={tool === 'laser' ? 'Desligar o laser' : 'Laser: aponte na tela'}
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
      </button>
      <button type="button" className="fx-bar__btn" aria-label="Apagar tudo" data-tip="Apagar todos os desenhos" disabled={!hasDrawing} onClick={() => clearDrawings(streamerId)}>
        <Eraser size={17} />
      </button>
    </div>
  );
}
