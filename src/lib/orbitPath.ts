/**
 * A órbita de cada pessoa em volta do host (em 3D): distância, inclinação, velocidade e sentido.
 * Quem arrasta o próprio planeta muda a sua; todo mundo vê igual porque a posição sai de um
 * relógio comum (Date.now()), não de quando cada um abriu a página.
 *
 * Unidades da cena: o host tem raio 1.
 */

export interface OrbitStyle {
  /** Distância do host. */
  radius: number;
  /** Inclinação do plano da órbita, em graus (-60 a 60). */
  incl: number;
  /** Direção da linha dos nós (onde a órbita cruza o "plano" do host), em graus. */
  node: number;
  /** Velocidade angular, em radianos por segundo. */
  speed: number;
  /** 1 = anti-horário visto de cima, -1 = horário. */
  dir: 1 | -1;
  /** Ângulo no instante zero do relógio comum. */
  phase: number;
}

export const ORBIT_LIMITS = { radiusMin: 2.2, radiusMax: 8, incl: 60, speedMin: 0.03, speedMax: 0.9 } as const;
const TAU = Math.PI * 2;

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Valida uma órbita vinda do armazenamento ou da rede. */
export function sanitizeOrbit(value: unknown): OrbitStyle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Partial<OrbitStyle>;
  if (o.radius === undefined) return undefined;
  return {
    radius: round(num(o.radius, ORBIT_LIMITS.radiusMin, ORBIT_LIMITS.radiusMax, 3.6)),
    incl: round(num(o.incl, -ORBIT_LIMITS.incl, ORBIT_LIMITS.incl, 0), 2),
    node: round(num(o.node, -360, 360, 0), 2),
    speed: round(num(o.speed, ORBIT_LIMITS.speedMin, ORBIT_LIMITS.speedMax, 0.14)),
    dir: o.dir === -1 ? -1 : 1,
    phase: round(wrap(num(o.phase, -1e6, 1e6, 0))),
  };
}

/** Órbita de quem nunca arrastou o planeta: anéis como antes, todos espalhados pela volta. */
export function defaultOrbit(index: number, count: number): OrbitStyle {
  const twoRings = count > 6;
  const inner = twoRings ? Math.ceil(count * 0.4) : count;
  const ring = index < inner ? 0 : 1;
  const k = ring === 0 ? index : index - inner;
  const n = Math.max(1, ring === 0 ? inner : count - inner);
  return {
    radius: ring === 0 ? (twoRings ? 3.2 : 3.8) : 5.4,
    incl: 0,
    node: 0,
    speed: ring === 0 ? 0.14 : 0.09,
    dir: ring === 0 ? 1 : -1,
    phase: (k / n) * TAU + (ring ? 0.4 : 0),
  };
}

/** Relógio comum, em segundos. */
export const orbitClock = () => Date.now() / 1000;

/** Posição [x, y, z] na órbita no instante t (segundos do relógio comum). */
export function orbitPosition(o: OrbitStyle, t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const theta = o.phase + o.dir * o.speed * t;
  const node = (o.node * Math.PI) / 180;
  const incl = (o.incl * Math.PI) / 180;
  const c = Math.cos(theta) * o.radius;
  const s = Math.sin(theta) * o.radius;
  // n = direção dos nós; h = perpendicular a ela no plano do host; a órbita sobe em h
  const nx = Math.cos(node);
  const nz = Math.sin(node);
  const hx = -nz;
  const hz = nx;
  out[0] = c * nx + s * Math.cos(incl) * hx;
  out[1] = s * Math.sin(incl);
  out[2] = c * nz + s * Math.cos(incl) * hz;
  return out;
}

/**
 * Órbita a partir de onde o planeta foi solto (P) e do "empurrão" (V, unidades por segundo):
 * a distância e a altura de P dão o raio e a inclinação; o empurrão ao longo da órbita dá a
 * velocidade e o sentido (sem empurrão, continuam os de antes).
 */
export function orbitFromDrop(p: [number, number, number], v: [number, number, number], prev: OrbitStyle, t: number): OrbitStyle {
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  const radius = Math.max(ORBIT_LIMITS.radiusMin, Math.min(ORBIT_LIMITS.radiusMax, len));
  const incl = Math.max(-ORBIT_LIMITS.incl, Math.min(ORBIT_LIMITS.incl, (Math.asin(Math.max(-1, Math.min(1, p[1] / len))) * 180) / Math.PI));
  const az = Math.atan2(p[2], p[0]);
  const nodeRad = az - Math.PI / 2;
  // P fica no ponto mais "alto" da órbita (theta = 90°); andar para theta maior = ir na direção -n
  const nx = Math.cos(nodeRad);
  const nz = Math.sin(nodeRad);
  const angular = -(v[0] * nx + v[2] * nz) / radius;
  let { speed, dir } = prev;
  if (Math.abs(angular) > 0.08) {
    dir = angular > 0 ? 1 : -1;
    speed = Math.max(ORBIT_LIMITS.speedMin, Math.min(ORBIT_LIMITS.speedMax, Math.abs(angular)));
  }
  // arredonda antes: a fase é calculada com a velocidade exata que vai pela rede
  speed = round(speed);
  const phase = wrap(Math.PI / 2 - dir * speed * t);
  return sanitizeOrbit({ radius, incl, node: (nodeRad * 180) / Math.PI, speed, dir, phase })!;
}
