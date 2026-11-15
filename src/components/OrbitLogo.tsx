import { useId } from 'react';
import { useReducedMotion } from './ui';

/**
 * O logo: um planeta no centro com outros planetas orbitando.
 * As luas são desenhadas duas vezes (camada de trás e da frente, recortada) para
 * passarem por trás do planeta na metade de cima da órbita e na frente na de baixo.
 */

type Moon = { orbit: number; r: number; dur: number; begin: number; t: number; stops: [string, string, string] };
type Config = { planet: number; orbits: Array<{ rx: number; ry: number }>; moons: Moon[] };

const CYAN: [string, string, string] = ['#cffafe', '#22d3ee', '#0e5566'];
const PINK: [string, string, string] = ['#fce7f3', '#f472b6', '#7a1747'];
const GOLD: [string, string, string] = ['#fef3c7', '#fbbf24', '#7a4f06'];

const LARGE: Config = {
  planet: 78,
  orbits: [
    { rx: 148, ry: 48 },
    { rx: 184, ry: 62 },
  ],
  moons: [
    { orbit: 0, r: 17, dur: 11, begin: 0, t: 0.62, stops: CYAN },
    { orbit: 1, r: 12, dur: 17, begin: -6, t: 0.08, stops: PINK },
    { orbit: 1, r: 8.5, dur: 17, begin: -14.5, t: 0.9, stops: GOLD },
  ],
};

const SMALL: Config = {
  planet: 92,
  orbits: [{ rx: 170, ry: 58 }],
  moons: [
    { orbit: 0, r: 30, dur: 9, begin: 0, t: 0.64, stops: CYAN },
    { orbit: 0, r: 21, dur: 9, begin: -4.5, t: 0.1, stops: PINK },
  ],
};

const TILT = 'rotate(-18 200 200)';

const ellipsePath = (rx: number, ry: number) =>
  `M ${200 - rx} 200 a ${rx} ${ry} 0 1 1 ${2 * rx} 0 a ${rx} ${ry} 0 1 1 ${-2 * rx} 0`;

function pointAt(rx: number, ry: number, t: number) {
  const angle = Math.PI + 2 * Math.PI * t;
  return { x: 200 + rx * Math.cos(angle), y: 200 + ry * Math.sin(angle) };
}

interface OrbitLogoProps {
  size?: number;
  animated?: boolean;
  className?: string;
  title?: string;
}

export function OrbitLogo({ size = 48, animated = false, className, title = 'Órbita' }: OrbitLogoProps) {
  const id = `o${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const reduce = useReducedMotion();
  const animate = animated && !reduce;
  const small = size < 96;
  const cfg = small ? SMALL : LARGE;
  const stroke = small ? 10 : 3;

  const moon = (m: Moon, i: number, layer: string) => {
    const orbit = cfg.orbits[m.orbit];
    const fill = `url(#${id}m${i})`;
    if (animate) {
      return (
        <circle key={layer + i} r={m.r} fill={fill}>
          <animateMotion dur={`${m.dur}s`} begin={`${m.begin}s`} repeatCount="indefinite" path={ellipsePath(orbit.rx, orbit.ry)} />
        </circle>
      );
    }
    const p = pointAt(orbit.rx, orbit.ry, m.t);
    return <circle key={layer + i} cx={p.x} cy={p.y} r={m.r} fill={fill} />;
  };

  return (
    <svg className={className} width={size} height={size} viewBox="0 0 400 400" role="img" aria-label={title}>
      <defs>
        <radialGradient id={`${id}core`} cx="36%" cy="30%" r="80%">
          <stop offset="0" stopColor="#ede9fe" />
          <stop offset="0.28" stopColor="#a78bfa" />
          <stop offset="0.62" stopColor="#6d28d9" />
          <stop offset="1" stopColor="#1e0a4a" />
        </radialGradient>
        <radialGradient id={`${id}halo`}>
          <stop offset="0.5" stopColor="#8b5cf6" stopOpacity="0.45" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
        {cfg.moons.map((m, i) => (
          <radialGradient key={i} id={`${id}m${i}`} cx="35%" cy="30%" r="80%">
            <stop offset="0" stopColor={m.stops[0]} />
            <stop offset="0.5" stopColor={m.stops[1]} />
            <stop offset="1" stopColor={m.stops[2]} />
          </radialGradient>
        ))}
        <clipPath id={`${id}front`}>
          <rect x="-60" y="200" width="520" height="260" />
        </clipPath>
        <clipPath id={`${id}disc`}>
          <circle cx="200" cy="200" r={cfg.planet} />
        </clipPath>
      </defs>

      {!small && <circle cx="200" cy="200" r={cfg.planet * 1.65} fill={`url(#${id}halo)`} />}

      {/* metade de trás das órbitas */}
      <g transform={TILT}>
        {cfg.orbits.map((o, i) => (
          <ellipse key={i} cx="200" cy="200" rx={o.rx} ry={o.ry} fill="none" stroke="#a5b4fc" strokeOpacity="0.3" strokeWidth={stroke} />
        ))}
        {cfg.moons.map((m, i) => moon(m, i, 'b'))}
      </g>

      {/* o planeta central */}
      <circle cx="200" cy="200" r={cfg.planet} fill={`url(#${id}core)`} />
      <g clipPath={`url(#${id}disc)`} transform={TILT} opacity="0.32">
        <rect x="60" y={200 - cfg.planet * 0.44} width="280" height={cfg.planet * 0.14} fill="#ddd6fe" />
        <rect x="60" y={200 + cfg.planet * 0.06} width="280" height={cfg.planet * 0.11} fill="#2e1065" />
        <rect x="60" y={200 + cfg.planet * 0.42} width="280" height={cfg.planet * 0.07} fill="#ddd6fe" />
      </g>

      {/* metade da frente (passa por cima do planeta) */}
      <g transform={TILT} clipPath={`url(#${id}front)`}>
        {cfg.orbits.map((o, i) => (
          <ellipse key={i} cx="200" cy="200" rx={o.rx} ry={o.ry} fill="none" stroke="#c7d2fe" strokeOpacity="0.75" strokeWidth={stroke} />
        ))}
        {cfg.moons.map((m, i) => moon(m, i, 'f'))}
      </g>
    </svg>
  );
}
