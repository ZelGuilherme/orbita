import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { BellRing, Crosshair, Sparkles } from 'lucide-react';
import { hideLaser, moveLaser, sendFx, toggleLaser } from '../controller';
import { FX_REACTIONS, FX_WINKS, onFx, type FxEvent } from '../lib/fx';
import type { FxWink, Member } from '../lib/protocol';
import { useApp } from '../store';
import { cx } from './ui';

/**
 * Camada de efeitos por cima da live: reações, animações ("winks"), "chamar atenção" e lasers.
 * Fica alinhada com a imagem do vídeo (sem as faixas pretas), então um laser em (0,5; 0,5)
 * aponta para o mesmo lugar na tela de todo mundo.
 */

interface Burst {
  id: number;
  kind: 'reaction' | 'wink' | 'credit';
  from: string;
  emoji?: string;
  wink?: FxWink;
  text?: string;
  x: number;
  until: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const WINK_MS: Record<FxWink, number> = {
  ufo: 3_400,
  rocket: 2_600,
  meteor: 3_000,
  confetti: 3_400,
  hearts: 3_000,
  boom: 1_800,
  kiss: 2_400,
  snow: 4_600,
};

let burstId = 0;

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

/** Pseudoaleatório estável por índice, para as partículas não pularem a cada render. */
const rand = (seed: number, i: number) => {
  const x = Math.sin(seed * 9301 + i * 49297) * 233280;
  return x - Math.floor(x);
};

export function FxLayer({
  streamerId,
  videoRef,
  members,
  interactive,
}: {
  streamerId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  members: Member[];
  /** Laser ligado: o mouse em cima da imagem aponta. */
  interactive: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const lasers = useRef(new Map<string, { el: HTMLDivElement; at: number }>());
  const [box, setBox] = useState<Box>({ left: 0, top: 0, width: 0, height: 0 });
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [shaking, setShaking] = useState(0);
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

  // recebe os efeitos desta live
  useEffect(() => {
    const nameOf = (id: string) => membersRef.current.find((m) => m.id === id);
    const placeLaser = (event: FxEvent, x: number, y: number) => {
      const host = stage.current;
      if (!host) return;
      let entry = lasers.current.get(event.from);
      if (!entry) {
        const who = nameOf(event.from);
        const el = document.createElement('div');
        el.className = 'fx-laser';
        el.style.setProperty('--c', who?.color ?? '#f43f5e');
        const dot = document.createElement('i');
        const label = document.createElement('span');
        label.textContent = who?.name ?? '';
        el.append(dot, label);
        host.append(el);
        entry = { el, at: 0 };
        lasers.current.set(event.from, entry);
      }
      entry.at = performance.now();
      entry.el.style.left = `${(x * 100).toFixed(2)}%`;
      entry.el.style.top = `${(y * 100).toFixed(2)}%`;
      entry.el.classList.add('is-on');
    };
    const removeLaser = (from: string) => {
      const entry = lasers.current.get(from);
      if (!entry) return;
      lasers.current.delete(from);
      entry.el.classList.remove('is-on');
      window.setTimeout(() => entry.el.remove(), 250);
    };
    const add = (burst: Omit<Burst, 'id'>) => setBursts((list) => [...list.filter((b) => b.until > Date.now()), { ...burst, id: ++burstId }].slice(-40));

    const off = onFx((event) => {
      if (event.streamerId !== streamerId) return;
      const { fx } = event;
      const who = nameOf(event.from)?.name ?? 'Alguém';
      if (fx.kind === 'laser') placeLaser(event, fx.x, fx.y);
      else if (fx.kind === 'laser-off') removeLaser(event.from);
      else if (fx.kind === 'reaction') add({ kind: 'reaction', from: who, emoji: fx.emoji, x: 8 + Math.random() * 84, until: Date.now() + 2_800 });
      else if (fx.kind === 'wink') {
        const icon = FX_WINKS.find((w) => w.id === fx.wink)?.icon ?? '✨';
        add({ kind: 'wink', from: who, wink: fx.wink, x: 15 + Math.random() * 70, until: Date.now() + WINK_MS[fx.wink] });
        add({ kind: 'credit', from: who, text: `${icon} ${who}`, x: 0, until: Date.now() + 2_600 });
      } else if (fx.kind === 'nudge') {
        setShaking(Date.now());
        add({ kind: 'credit', from: who, text: `📳 ${who} chamou atenção!`, x: 0, until: Date.now() + 2_600 });
      }
    });
    // lasers parados somem sozinhos (a pessoa pode ter fechado a aba)
    const sweep = window.setInterval(() => {
      const now = performance.now();
      for (const [from, entry] of lasers.current) if (now - entry.at > 2_500) removeLaser(from);
      setBursts((list) => (list.some((b) => b.until <= Date.now()) ? list.filter((b) => b.until > Date.now()) : list));
    }, 500);
    const current = lasers.current;
    return () => {
      off();
      clearInterval(sweep);
      for (const entry of current.values()) entry.el.remove();
      current.clear();
    };
  }, [streamerId]);

  useEffect(() => {
    if (!shaking) return;
    const timer = window.setTimeout(() => setShaking(0), 650);
    return () => clearTimeout(timer);
  }, [shaking]);

  const pointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    moveLaser(streamerId, x, y);
  };

  return (
    <div ref={layer} className={cx('fx-layer', shaking > 0 && 'is-shaking')} aria-hidden={!interactive}>
      <div
        ref={stage}
        className={cx('fx-stage', interactive && 'is-laser')}
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        onPointerMove={pointer}
        onPointerDown={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          pointer(e);
        }}
        onPointerLeave={() => interactive && hideLaser(streamerId)}
        onClick={(e) => interactive && e.stopPropagation()}
        onDoubleClick={(e) => interactive && e.stopPropagation()}
      >
        {bursts
          .filter((b) => b.kind !== 'credit')
          .map((b) => (
            <BurstView key={b.id} burst={b} />
          ))}
        <div className="fx-credits">
          {bursts
            .filter((b) => b.kind === 'credit')
            .slice(-3)
            .map((b) => (
              <div key={b.id} className="fx-credit">
                {b.text}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function BurstView({ burst }: { burst: Burst }) {
  if (burst.kind === 'reaction') {
    return (
      <span className="fx-reaction" style={{ left: `${burst.x}%`, '--sway': `${(burst.id % 2 ? 1 : -1) * (10 + (burst.id % 5) * 4)}px` } as CSSProperties}>
        {burst.emoji}
        <small>{burst.from}</small>
      </span>
    );
  }
  return <Wink wink={burst.wink ?? 'confetti'} seed={burst.id} x={burst.x} />;
}

function Wink({ wink, seed, x }: { wink: FxWink; seed: number; x: number }) {
  switch (wink) {
    case 'ufo':
      return (
        <div className="fx-ufo" style={{ top: `${18 + rand(seed, 1) * 30}%` }}>
          <span className="fx-ufo__ship">🛸</span>
          <span className="fx-ufo__beam" />
        </div>
      );
    case 'rocket':
      return (
        <div className="fx-rocket" style={{ left: `${x}%` }}>
          <span>🚀</span>
          <i />
        </div>
      );
    case 'meteor':
      return (
        <>
          {Array.from({ length: 7 }, (_, i) => (
            <span
              key={i}
              className="fx-meteor"
              style={{ left: `${10 + rand(seed, i) * 90}%`, top: `${-10 + rand(seed, i + 9) * 40}%`, animationDelay: `${i * 0.28}s` }}
            >
              ☄️
            </span>
          ))}
        </>
      );
    case 'confetti':
      return (
        <>
          {Array.from({ length: 46 }, (_, i) => (
            <i
              key={i}
              className="fx-confetti"
              style={
                {
                  left: `${rand(seed, i) * 100}%`,
                  background: ['#8b5cf6', '#22d3ee', '#f472b6', '#facc15', '#34d399', '#fb923c'][i % 6],
                  animationDelay: `${rand(seed, i + 50) * 0.7}s`,
                  animationDuration: `${2 + rand(seed, i + 99) * 1.2}s`,
                  '--spin': `${360 + rand(seed, i + 7) * 720}deg`,
                  '--drift': `${(rand(seed, i + 3) - 0.5) * 120}px`,
                } as CSSProperties
              }
            />
          ))}
        </>
      );
    case 'hearts':
      return (
        <>
          {Array.from({ length: 16 }, (_, i) => (
            <span
              key={i}
              className="fx-heart"
              style={
                {
                  left: `${x - 12 + rand(seed, i) * 24}%`,
                  animationDelay: `${rand(seed, i + 20) * 0.9}s`,
                  fontSize: `${22 + rand(seed, i + 40) * 26}px`,
                  '--drift': `${(rand(seed, i + 60) - 0.5) * 220}px`,
                } as CSSProperties
              }
            >
              {['💖', '💜', '💙', '❤️'][i % 4]}
            </span>
          ))}
        </>
      );
    case 'boom':
      return (
        <div className="fx-boom" style={{ left: `${x}%`, top: `${30 + rand(seed, 2) * 40}%` }}>
          <i className="fx-boom__ring" />
          <span className="fx-boom__icon">💥</span>
          <b className="fx-boom__text">BOOM!</b>
        </div>
      );
    case 'kiss':
      return (
        <div className="fx-kiss" style={{ left: `${x}%`, top: `${25 + rand(seed, 4) * 50}%` }}>
          💋
        </div>
      );
    case 'snow':
      return (
        <>
          {Array.from({ length: 34 }, (_, i) => (
            <span
              key={i}
              className="fx-snow"
              style={
                {
                  left: `${rand(seed, i) * 100}%`,
                  animationDelay: `${rand(seed, i + 30) * 1.6}s`,
                  animationDuration: `${2.6 + rand(seed, i + 70) * 1.8}s`,
                  fontSize: `${12 + rand(seed, i + 11) * 16}px`,
                  '--drift': `${(rand(seed, i + 5) - 0.5) * 80}px`,
                } as CSSProperties
              }
            >
              ❄
            </span>
          ))}
        </>
      );
    default:
      return null;
  }
}

/** Barra de efeitos de quem assiste (e o laser, que quem transmite também pode usar). */
export function FxBar({ streamerId, own }: { streamerId: string; own?: boolean }) {
  const laser = useApp((s) => s.laser);
  const [winks, setWinks] = useState(false);
  useEffect(() => {
    if (!laser) return;
    return () => hideLaser(streamerId);
  }, [laser, streamerId]);
  return (
    <div className="fx-bar" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {!own && (
        <>
          {FX_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" className="fx-bar__emoji" aria-label={`Reagir com ${emoji}`} onClick={() => sendFx(streamerId, { kind: 'reaction', emoji })}>
              {emoji}
            </button>
          ))}
          <span className="fx-bar__sep" />
          <button type="button" className="fx-bar__btn" aria-label="Chamar atenção" data-tip="Chamar atenção" onClick={() => sendFx(streamerId, { kind: 'nudge' })}>
            <BellRing size={17} />
          </button>
          <span className="fx-bar__menu">
            <button
              type="button"
              className={cx('fx-bar__btn', winks && 'is-on')}
              aria-label="Efeitos na tela"
              aria-expanded={winks}
              data-tip={winks ? undefined : 'Efeitos na tela'}
              onClick={() => setWinks(!winks)}
            >
              <Sparkles size={17} />
            </button>
            {winks && (
              <span className="fx-winks" role="menu">
                {FX_WINKS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      sendFx(streamerId, { kind: 'wink', wink: w.id });
                      setWinks(false);
                    }}
                  >
                    <span>{w.icon}</span>
                    {w.label}
                  </button>
                ))}
              </span>
            )}
          </span>
        </>
      )}
      <button
        type="button"
        className={cx('fx-bar__btn', laser && 'is-laser')}
        aria-label="Laser"
        data-tip={laser ? 'Desligar laser' : 'Laser: aponte na tela'}
        aria-pressed={laser}
        onClick={toggleLaser}
      >
        <Crosshair size={17} />
      </button>
    </div>
  );
}
