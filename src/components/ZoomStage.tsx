import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ZoomIn } from 'lucide-react';

const MAX_ZOOM = 5;

interface Zoom {
  s: number;
  x: number;
  y: number;
}

/** Espaço está apertado (com ferramenta ligada, Espaço + arrastar move a imagem). */
let spaceDown = false;
let spaceWatch = false;
function watchSpace() {
  if (spaceWatch) return;
  spaceWatch = true;
  const editable = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !editable(e.target)) spaceDown = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceDown = false;
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
  });
}

/**
 * Zoom na live, só para quem está olhando: roda do mouse (ou pinça) aproxima até 5x no ponto
 * do cursor; arrastar move. Com lápis/laser ligado, arrastar desenha e o movimento fica no botão
 * do meio do mouse ou com Espaço apertado. Dois cliques (com zoom) ou o botão voltam ao normal.
 * Os desenhos ficam dentro da área com zoom, então continuam no lugar certo da imagem.
 */
export function ZoomStage({ children, toolActive, onZoomChange }: { children: ReactNode; toolActive: boolean; onZoomChange?: (zoomed: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>({ s: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const toolRef = useRef(toolActive);
  toolRef.current = toolActive;
  const changeRef = useRef(onZoomChange);
  changeRef.current = onZoomChange;

  useEffect(() => {
    watchSpace();
    const el = box.current;
    if (!el) return;

    const clamp = (z: Zoom): Zoom => {
      const s = Math.max(1, Math.min(MAX_ZOOM, z.s));
      const mx = ((s - 1) * el.clientWidth) / 2;
      const my = ((s - 1) * el.clientHeight) / 2;
      return { s, x: Math.max(-mx, Math.min(mx, z.x)), y: Math.max(-my, Math.min(my, z.y)) };
    };
    const apply = (z: Zoom) => {
      const next = clamp(z);
      const was = zoomRef.current.s > 1.001;
      zoomRef.current = next;
      setZoom(next);
      if (was !== next.s > 1.001) changeRef.current?.(next.s > 1.001);
    };
    /** Aproxima mantendo parado o ponto (px, a partir do centro) que está embaixo do cursor. */
    const zoomAt = (factor: number, px: number, py: number) => {
      const z = zoomRef.current;
      const s = Math.max(1, Math.min(MAX_ZOOM, z.s * factor));
      const k = s / z.s;
      apply({ s, x: px - (px - z.x) * k, y: py - (py - z.y) * k });
    };
    const fromCenter = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      return [clientX - r.left - r.width / 2, clientY - r.top - r.height / 2] as const;
    };

    const onWheel = (e: WheelEvent) => {
      // a live ocupa a área inteira: a roda aqui é sempre zoom (não rola a página)
      e.preventDefault();
      const [px, py] = fromCenter(e.clientX, e.clientY);
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), px, py);
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let pan: { id: number; x: number; y: number; zx: number; zy: number } | null = null;
    let pinch: { dist: number; s: number } | null = null;

    const onDown = (e: PointerEvent) => {
      // botões (o "voltar" do zoom, as ferramentas) recebem o clique normalmente
      if ((e.target as Element | null)?.closest?.('button, input, a')) return;
      if (e.pointerType === 'touch') {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          // pinça: sempre é zoom (mesmo com ferramenta ligada)
          const [a, b] = [...pointers.values()];
          pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), s: zoomRef.current.s };
          pan = null;
          e.stopPropagation();
          return;
        }
      }
      const wantsPan = e.button === 1 || (e.button === 0 && (!toolRef.current || spaceDown));
      if (!wantsPan || (zoomRef.current.s <= 1.001 && e.button !== 1)) return;
      e.preventDefault();
      e.stopPropagation();
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, zx: zoomRef.current.x, zy: zoomRef.current.y };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-panning');
    };
    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const [px, py] = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoomAt((pinch.s * (dist / Math.max(1, pinch.dist))) / zoomRef.current.s, px, py);
        return;
      }
      if (!pan || e.pointerId !== pan.id) return;
      apply({ s: zoomRef.current.s, x: pan.zx + (e.clientX - pan.x), y: pan.zy + (e.clientY - pan.y) });
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pan && e.pointerId === pan.id) {
        pan = null;
        el.classList.remove('is-panning');
      }
    };
    const onDouble = (e: MouseEvent) => {
      // com zoom, dois cliques voltam ao normal (sem zoom, seguem para a tela cheia)
      if (zoomRef.current.s <= 1.001) return;
      e.stopPropagation();
      apply({ s: 1, x: 0, y: 0 });
    };
    // o botão do meio não abre a rolagem automática do navegador
    const onAux = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('dblclick', onDouble, true);
    el.addEventListener('mousedown', onAux);
    const ro = new ResizeObserver(() => apply(zoomRef.current));
    ro.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('dblclick', onDouble, true);
      el.removeEventListener('mousedown', onAux);
      ro.disconnect();
    };
  }, []);

  const zoomed = zoom.s > 1.001;
  return (
    <div ref={box} className={`zoom-box${zoomed ? ' is-zoomed' : ''}${toolActive ? ' has-tool' : ''}`}>
      <div className="zoom-stage" style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` } : undefined}>
        {children}
      </div>
      {zoomed && (
        <button
          type="button"
          className="zoom-pill"
          title="Voltar ao tamanho normal (ou dois cliques na imagem)"
          onClick={(e) => {
            e.stopPropagation();
            setZoom({ s: 1, x: 0, y: 0 });
            zoomRef.current = { s: 1, x: 0, y: 0 };
            onZoomChange?.(false);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ZoomIn size={13} /> {zoom.s.toFixed(1).replace('.', ',')}x · voltar
        </button>
      )}
    </div>
  );
}
