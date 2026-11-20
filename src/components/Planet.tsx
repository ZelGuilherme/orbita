import type { CSSProperties, ReactNode } from 'react';
import type { Ornament, PlanetStyle } from '../lib/planet';
import { initials, planetBackground } from '../lib/util';
import { useApp } from '../store';
import { cx, VideoEl } from './ui';

interface PlanetProps {
  name: string;
  color: string;
  size?: number;
  /** O host ganha uma coroa dourada. */
  host?: boolean;
  speaking?: boolean;
  live?: boolean;
  /** Texto no lugar da inicial. */
  text?: string;
  className?: string;
  /** Membro da sala: usa a foto e a aparência do planeta dele. */
  memberId?: string;
  /** Foto explícita (o próprio perfil, fora de uma sala). */
  avatar?: string;
  /** Aparência explícita (o próprio perfil, fora de uma sala). */
  planet?: PlanetStyle;
  /** Câmera ligada: aparece dentro do planeta. */
  video?: MediaStream | null;
  /** Espelhar a câmera (a própria). */
  mirror?: boolean;
}

const MOON_SCALE = { 1: 0.7, 2: 1, 3: 1.45 } as const;
const MOON_SPEED = { 1: 1.8, 2: 1, 3: 0.5 } as const;
const RING_WIDTH = { 1: 0.03, 2: 0.055, 3: 0.09 } as const;

/** Enfeites em órbita: desenhos pequenos em SVG. */
const ORNAMENT_SHAPES: Record<Ornament, ReactNode> = {
  star: <path d="M12 1l2.6 8.4L23 12l-8.4 2.6L12 23l-2.6-8.4L1 12l8.4-2.6z" fill="#fde68a" stroke="#f59e0b" strokeWidth="1" />,
  comet: (
    <>
      <path d="M2 22L15 9l2 2L4 23z" fill="url(#orn-tail)" opacity="0.85" />
      <circle cx="17.5" cy="6.5" r="5" fill="#e0f2fe" stroke="#7dd3fc" strokeWidth="1.2" />
      <defs>
        <linearGradient id="orn-tail" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0" />
          <stop offset="1" stopColor="#7dd3fc" />
        </linearGradient>
      </defs>
    </>
  ),
  satellite: (
    <>
      <rect x="1" y="9" width="7" height="6" rx="1" fill="#60a5fa" stroke="#1e3a8a" strokeWidth="1" />
      <rect x="16" y="9" width="7" height="6" rx="1" fill="#60a5fa" stroke="#1e3a8a" strokeWidth="1" />
      <rect x="9" y="7" width="6" height="10" rx="1.5" fill="#e5e7eb" stroke="#475569" strokeWidth="1" />
      <path d="M12 7V3m-2 0h4" stroke="#e5e7eb" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  ship: (
    <>
      <path d="M12 1c3.5 3 5 7 5 11l-2 5H9l-2-5c0-4 1.5-8 5-11z" fill="#f1f5f9" stroke="#475569" strokeWidth="1" />
      <circle cx="12" cy="9" r="2.2" fill="#38bdf8" stroke="#0c4a6e" strokeWidth="0.8" />
      <path d="M7 12l-3 5 4-1zM17 12l3 5-4-1z" fill="#f43f5e" />
      <path d="M10 18l2 5 2-5z" fill="#fb923c" />
    </>
  ),
};

/** Avatar em forma de planeta: cores, textura, anéis, luas, brilho, enfeites e (se houver) foto ou câmera. */
export function Planet({ name, color, size = 40, host, speaking, live, text, className, memberId, avatar, planet, video, mirror }: PlanetProps) {
  const storedPhoto = useApp((s) => (memberId ? s.avatars[memberId] : undefined));
  const storedPlanet = useApp((s) => (memberId ? s.room?.members.find((m) => m.id === memberId)?.planet : undefined));
  const photo = avatar ?? storedPhoto;
  const look = planet ?? storedPlanet;
  const rings = look?.rings ?? 0;
  const hasVideo = !!video && video.getVideoTracks().length > 0;
  const style = {
    '--size': `${size}px`,
    '--ring': look?.ringColor,
    '--tilt': `${look?.ringTilt ?? -16}deg`,
    '--ring-w': RING_WIDTH[look?.ringWidth ?? 2],
    '--moon': look?.moonColor,
    '--moon-scale': MOON_SCALE[look?.moonSize ?? 2],
    '--moon-speed': MOON_SPEED[look?.moonSpeed ?? 2],
    '--glow': look?.glowColor,
  } as CSSProperties;
  const ringClass = cx('planet__ring', look?.ringBands && 'is-banded');
  return (
    <span
      className={cx('planet', host && 'planet--host', speaking && 'is-speaking', live && 'is-live', look?.glow && 'has-glow', hasVideo && 'has-video', className)}
      style={style}
      aria-hidden="true"
    >
      {rings > 0 && <span className={cx(ringClass, 'planet__ring--back')} />}
      {rings > 1 && <span className={cx(ringClass, 'planet__ring--outer planet__ring--back')} />}
      <span className="planet__body" style={{ background: planetBackground(color, look?.color2) }}>
        {hasVideo ? (
          <VideoEl stream={video} mirror={mirror} />
        ) : (
          <>
            {photo ? <img className="planet__photo" src={photo} alt="" draggable={false} /> : <span className="planet__initial">{text ?? initials(name)}</span>}
            {/* a textura fica por cima da foto, e gira devagar */}
            {look && look.texture !== 'none' && (
              <span className={cx('planet__texture', photo && 'is-over-photo')}>
                <span className={`planet__tex tex-${look.texture}`} />
              </span>
            )}
          </>
        )}
      </span>
      {rings > 0 && <span className={cx(ringClass, 'planet__ring--front')} />}
      {rings > 1 && <span className={cx(ringClass, 'planet__ring--outer planet__ring--front')} />}
      {Array.from({ length: look?.moons ?? 0 }, (_, i) => (
        <span key={i} className={`planet__orbit planet__orbit--${i + 1}`}>
          <span className="planet__moon" />
        </span>
      ))}
      {look?.ornaments.map((o) => (
        <span key={o} className={`planet__orbit planet__orn orn-${o}`}>
          <svg viewBox="0 0 24 24" className="planet__orn-shape">
            {ORNAMENT_SHAPES[o]}
          </svg>
        </span>
      ))}
      {host && (
        <svg className="planet__crown" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 8l4.5 4L12 4l4.5 8L21 8l-2 11H5z" />
        </svg>
      )}
    </span>
  );
}
