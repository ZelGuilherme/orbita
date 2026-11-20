/**
 * Ruído 3D (Perlin "melhorado") com semente, para gerar as texturas dos planetas.
 * Amostrado na superfície da esfera (x, y, z), não tem emenda nem polo esticado.
 */

const GRAD: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1],
];

/** Gerador pseudoaleatório pequeno (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semente a partir de um texto (o ID da pessoa: o mesmo planeta para todo mundo). */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Noise3 {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const r = rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private grad(hash: number, x: number, y: number, z: number) {
    const g = GRAD[hash & 15];
    return g[0] * x + g[1] * y + g[2] * z;
  }

  /** Aproximadamente de -1 a 1. */
  noise(x: number, y: number, z: number): number {
    const P = this.perm;
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = P[X] + Y;
    const AA = P[A] + Z;
    const AB = P[A + 1] + Z;
    const B = P[X + 1] + Y;
    const BA = P[B] + Z;
    const BB = P[B + 1] + Z;
    return lerp(
      lerp(lerp(this.grad(P[AA], x, y, z), this.grad(P[BA], x - 1, y, z), u), lerp(this.grad(P[AB], x, y - 1, z), this.grad(P[BB], x - 1, y - 1, z), u), v),
      lerp(
        lerp(this.grad(P[AA + 1], x, y, z - 1), this.grad(P[BA + 1], x - 1, y, z - 1), u),
        lerp(this.grad(P[AB + 1], x, y - 1, z - 1), this.grad(P[BB + 1], x - 1, y - 1, z - 1), u),
        v,
      ),
      w,
    );
  }

  /** Várias camadas de detalhe (fbm), de -1 a 1 aproximadamente. */
  fbm(x: number, y: number, z: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x, y, z) * amp;
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    }
    return sum / norm;
  }

  /** Cristas finas (rachaduras, cordilheiras): 0 a 1, 1 na crista. */
  ridged(x: number, y: number, z: number, octaves = 4): number {
    let sum = 0;
    let amp = 0.6;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x, y, z));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      x *= 2.1;
      y *= 2.1;
      z *= 2.1;
    }
    return sum / norm;
  }
}

/** Semente da textura de uma pessoa: o perfil, sem a sessão (o mesmo planeta em todo lugar). */
export const textureSeed = (id: string) => hashSeed(id.split('.')[0] || id);
