import type { CSSProperties } from 'react';
import { initials, planetBackground } from '../lib/util';
import { useApp } from '../store';
import { cx } from './ui';

interface PlanetProps {
  name: string;
  color: string;
  size?: number;
  /** O host ganha um anel dourado (estilo Saturno). */
  host?: boolean;
  speaking?: boolean;
  live?: boolean;
  /** Texto no lugar da inicial. */
  text?: string;
  className?: string;
  /** Membro da sala: usa a foto de perfil dele, se tiver. */
  memberId?: string;
  /** Foto explícita (o próprio perfil, fora de uma sala). */
  avatar?: string;
}

/** Avatar em forma de planeta. */
export function Planet({ name, color, size = 40, host, speaking, live, text, className, memberId, avatar }: PlanetProps) {
  const stored = useApp((s) => (memberId ? s.avatars[memberId] : undefined));
  const photo = avatar ?? stored;
  return (
    <span
      className={cx('planet', host && 'planet--host', speaking && 'is-speaking', live && 'is-live', className)}
      style={{ '--size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {host && <span className="planet__ring planet__ring--back" />}
      <span className="planet__body" style={{ background: planetBackground(color) }}>
        {photo ? <img className="planet__photo" src={photo} alt="" draggable={false} /> : <span className="planet__initial">{text ?? initials(name)}</span>}
      </span>
      {host && <span className="planet__ring planet__ring--front" />}
    </span>
  );
}
