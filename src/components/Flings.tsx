import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { SmilePlus } from 'lucide-react';
import { sendFling } from '../controller';
import { QUICK_EMOJIS } from '../lib/config';
import { onFling, planetAt, registerPlanetPicker, type Fling } from '../lib/flings';
import { useApp } from '../store';
import { cx, useNow } from './ui';

/** Centro de cada planeta na tela (px, relativo à área da órbita) e o tamanho dele. */
export interface PlanetCenter {
  x: number;
  y: number;
  size: number;
}

/**
 * Desenha as reações por cima da órbita. Segue os planetas quadro a quadro: o emoji chega
 * onde a pessoa está, mesmo com ela andando na órbita.
 */
export function FlingLayer({ locate }: { locate: (id: string) => PlanetCenter | null }) {
  const layer = useRef<HTMLDivElement>(null);
  const locateRef = useRef(locate);
  locateRef.current = locate;
  const centers = { current: { get: (id: string) => locateRef.current(id) ?? undefined } };

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const spawn = (emoji: string, size: number) => {
      const el = document.createElement('span');
      el.className = 'fling';
      el.textContent = emoji;
      el.style.fontSize = `${size}px`;
      layer.current?.append(el);
      return el;
    };
    const run = (duration: number, step: (t: number) => boolean | void, done?: () => void) => {
      const start = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        if (step(t) === false) return;
        if (t < 1) requestAnimationFrame(frame);
        else done?.();
      };
      requestAnimationFrame(frame);
    };

    /** Estouro: alguns emojis sobem em volta do planeta e somem. */
    const burst = (id: string, emoji: string, count = 6) => {
      for (let k = 0; k < count; k++) {
        const el = spawn(emoji, 22 + Math.random() * 12);
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        const dist = 50 + Math.random() * 60;
        const delay = k * 70;
        const spin = (Math.random() - 0.5) * 50;
        window.setTimeout(() => {
          run(
            reduce ? 900 : 1_400,
            (t) => {
              const c = centers.current.get(id);
              if (!c) {
                el.remove();
                return false;
              }
              const e = 1 - Math.pow(1 - t, 2);
              const r = reduce ? 0 : dist * e + c.size * 0.3;
              el.style.transform = `translate(${c.x + Math.cos(angle) * r}px, ${c.y + Math.sin(angle) * r}px) translate(-50%, -50%) scale(${0.6 + e * 0.8}) rotate(${spin * e}deg)`;
              el.style.opacity = String(t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
            },
            () => el.remove(),
          );
        }, delay);
      }
    };

    /** Voo: o emoji faz um arco do planeta de quem mandou até o de quem recebe e estoura lá. */
    const fly = (f: Fling & { to: string }) => {
      const el = spawn(f.emoji, 34);
      el.classList.add('fling--big');
      run(
        reduce ? 500 : 1_150,
        (t) => {
          const a = centers.current.get(f.from);
          const b = centers.current.get(f.to);
          if (!a || !b) {
            el.remove();
            return false;
          }
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const lift = Math.min(160, Math.hypot(b.x - a.x, b.y - a.y) * 0.45);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2 - lift;
          const x = (1 - e) * (1 - e) * a.x + 2 * (1 - e) * e * mx + e * e * b.x;
          const y = (1 - e) * (1 - e) * a.y + 2 * (1 - e) * e * my + e * e * b.y;
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${0.8 + Math.sin(Math.PI * e) * 0.7})`;
        },
        () => {
          el.remove();
          burst(f.to, f.emoji, 5);
        },
      );
    };

    return onFling((f) => {
      if (!centers.current.get(f.from)) return;
      if (f.to && centers.current.get(f.to)) fly(f as Fling & { to: string });
      else burst(f.from, f.emoji);
    });
    // o localizador muda a cada desenho; quem está na ponta é a ref
  }, []);

  return <div ref={layer} className="fling-layer" aria-hidden="true" />;
}

/**
 * Nos modos 2D e linha, os planetas são elementos da página (com data-planet-id): o centro de
 * cada um sai da posição na tela, e soltar um emoji arrastado em cima de um planeta funciona.
 */
export function useDomPlanets(box: RefObject<HTMLElement | null>) {
  const locate = useCallback(
    (id: string): PlanetCenter | null => {
      const root = box.current;
      const el = root?.querySelector<HTMLElement>(`[data-planet-id="${CSS.escape(id)}"] .planet`);
      if (!root || !el) return null;
      const r = el.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2, size: r.width };
    },
    [box],
  );
  useEffect(
    () =>
      registerPlanetPicker((clientX, clientY) => {
        const root = box.current;
        if (!root) return null;
        let best: string | null = null;
        let bestDist = Infinity;
        for (const el of root.querySelectorAll<HTMLElement>('[data-planet-id] .planet')) {
          const id = el.closest<HTMLElement>('[data-planet-id]')!.dataset.planetId!;
          const r = el.getBoundingClientRect();
          const d = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2));
          if (d < Math.max(30, r.width * 0.75) && d < bestDist) {
            best = id;
            bestDist = d;
          }
        }
        return best;
      }),
    [box],
  );
  return locate;
}

/** Botão de reações da barra da chamada: clique estoura em volta de você; arraste até alguém para mandar para essa pessoa. */
export function FlingButton() {
  const [open, setOpen] = useState(false);
  return (
    <div className="ctrl-wrap">
      <button type="button" className={cx('ctrl', open && 'is-on')} data-tip="Reações" aria-label="Reações" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SmilePlus />
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <FlingPanel />
        </>
      )}
    </div>
  );
}

function FlingPanel() {
  const cooldown = useApp((s) => s.flingCooldown);
  const now = useNow(200);
  const waiting = cooldown > now;
  const drag = useRef<{ emoji: string; x: number; y: number; ghost: HTMLElement | null } | null>(null);

  const onDown = (emoji: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { emoji, x: e.clientX, y: e.clientY, ghost: null };
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.ghost && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) {
      d.ghost = document.createElement('span');
      d.ghost.className = 'fling-ghost';
      d.ghost.textContent = d.emoji;
      document.body.append(d.ghost);
    }
    if (d.ghost) {
      d.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
      d.ghost.classList.toggle('is-target', !!planetAt(e.clientX, e.clientY));
    }
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    d.ghost?.remove();
    // arrastou até um planeta: vai para essa pessoa; senão (ou clique), estoura em volta de mim
    const to = d.ghost ? (planetAt(e.clientX, e.clientY) ?? undefined) : undefined;
    sendFling(d.emoji, to);
  };

  return (
    <div className="sound-panel fling-panel" role="dialog" aria-label="Reações">
      <h4>Reações</h4>
      <div className="fling-grid">
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="fling-pick"
            disabled={waiting}
            aria-label={`Reagir com ${emoji}`}
            onPointerDown={onDown(emoji)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => {
              drag.current?.ghost?.remove();
              drag.current = null;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                sendFling(emoji);
              }
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
      <p className="sound-panel__hint">
        {waiting ? 'Espere um instante…' : 'Clique: estoura em volta do seu planeta. Arraste até o planeta de alguém: voa até essa pessoa.'}
      </p>
    </div>
  );
}
