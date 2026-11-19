import type { CSSProperties } from 'react';
import type { PlanetStyle } from '../lib/planet';
import { initials, planetBackground } from '../lib/util';
import { useApp } from '../store';
import { cx } from './ui';

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
}

/** Avatar em forma de planeta: cor, textura, anéis, luas, brilho e (se houver) foto. */
export function Planet({ name, color, size = 40, host, speaking, live, text, className, memberId, avatar, planet }: PlanetProps) {
  const storedPhoto = useApp((s) => (memberId ? s.avatars[memberId] : undefined));
  const storedPlanet = useApp((s) => (memberId ? s.room?.members.find((m) => m.id === memberId)?.planet : undefined));
  const photo = avatar ?? storedPhoto;
  const look = planet ?? storedPlanet;
  const rings = look?.rings ?? 0;
  const style = {
    '--size': `${size}px`,
    '--ring': look?.ringColor,
    '--tilt': `${look?.ringTilt ?? -16}deg`,
    '--moon': look?.moonColor,
    '--glow': look?.glowColor,
  } as CSSProperties;
  return (
    <span
      className={cx('planet', host && 'planet--host', speaking && 'is-speaking', live && 'is-live', look?.glow && 'has-glow', className)}
      style={style}
      aria-hidden="true"
    >
      {rings > 0 && <span className="planet__ring planet__ring--back" />}
      {rings > 1 && <span className="planet__ring planet__ring--outer planet__ring--back" />}
      <span className="planet__body" style={{ background: planetBackground(color) }}>
        {!photo && look && look.texture !== 'none' && <span className={`planet__texture tex-${look.texture}`} />}
        {photo ? <img className="planet__photo" src={photo} alt="" draggable={false} /> : <span className="planet__initial">{text ?? initials(name)}</span>}
      </span>
      {rings > 0 && <span className="planet__ring planet__ring--front" />}
      {rings > 1 && <span className="planet__ring planet__ring--outer planet__ring--front" />}
      {Array.from({ length: look?.moons ?? 0 }, (_, i) => (
        <span key={i} className={`planet__orbit planet__orbit--${i + 1}`}>
          <span className="planet__moon" />
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
