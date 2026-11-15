import type { CSSProperties } from 'react';
import { initials, planetBackground } from '../lib/util';
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
}

/** Avatar em forma de planeta. */
export function Planet({ name, color, size = 40, host, speaking, live, text, className }: PlanetProps) {
  return (
    <span
      className={cx('planet', host && 'planet--host', speaking && 'is-speaking', live && 'is-live', className)}
      style={{ '--size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {host && <span className="planet__ring planet__ring--back" />}
      <span className="planet__body" style={{ background: planetBackground(color) }}>
        <span className="planet__initial">{text ?? initials(name)}</span>
      </span>
      {host && <span className="planet__ring planet__ring--front" />}
    </span>
  );
}
