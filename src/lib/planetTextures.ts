import { Noise3, rng } from './noise';
import type { PlanetTexture } from './planet';

/**
 * Texturas realistas dos planetas, geradas por código (sem imagens): faixas e tempestade de
 * gigante gasoso, oceano com continentes e nuvens, crateras com relevo, lava brilhando nas
 * rachaduras, gelo rachado… As cores vêm das cores escolhidas no editor.
 *
 * A imagem é equirretangular (largura = 2 × altura, linha 0 = polo norte) e o ruído é amostrado
 * na esfera, então não há emenda. Roda num worker (planetTextures.worker.ts).
 */

export interface TextureRequest {
  kind: PlanetTexture;
  color: string;
  color2: string | null;
  seed: number;
  width: number;
}

export interface TextureMaps {
  width: number;
  height: number;
  /** RGBA da superfície. */
  color: Uint8ClampedArray<ArrayBuffer>;
  /** Relevo (cinza em RGBA), quando há. */
  bump: Uint8ClampedArray<ArrayBuffer> | null;
  /** O que brilha sozinho (lava), quando há. */
  emissive: Uint8ClampedArray<ArrayBuffer> | null;
  /** Camada de nuvens (RGBA com transparência), quando há. */
  clouds: Uint8ClampedArray<ArrayBuffer> | null;
}

type RGB = [number, number, number];

function hex(value: string): RGB {
  const n = parseInt(value.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const WHITE: RGB = [1, 1, 1];
const BLACK: RGB = [0, 0, 0];

/** Gira o matiz (para derivar uma segunda cor quando a pessoa só escolheu uma). */
function hueShift([r, g, b]: RGB, degrees: number): RGB {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [
    0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.33 * s, 0.114 - 0.114 * c - 0.497 * s,
    0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s,
    0.299 - 0.3 * c + 1.25 * s, 0.587 - 0.588 * c - 1.05 * s, 0.114 + 0.886 * c - 0.203 * s,
  ];
  return [clamp01(m[0] * r + m[1] * g + m[2] * b), clamp01(m[3] * r + m[4] * g + m[5] * b), clamp01(m[6] * r + m[7] * g + m[8] * b)];
}

interface Crater {
  x: number;
  y: number;
  z: number;
  /** Cosseno do raio angular. */
  cos: number;
  r: number;
  depth: number;
}

function makeCraters(seed: number, count: number): Crater[] {
  const r = rng(seed ^ 0x5bd1e995);
  const out: Crater[] = [];
  for (let i = 0; i < count; i++) {
    const u = r() * 2 - 1;
    const t = r() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    // muitas pequenas, poucas grandes
    const radius = 0.03 + Math.pow(r(), 3) * 0.22;
    out.push({ x: s * Math.cos(t), y: u, z: s * Math.sin(t), cos: Math.cos(radius * 1.35), r: radius, depth: 0.5 + r() * 0.5 });
  }
  return out;
}

/** Altura das crateras num ponto: bacia funda com borda alta. */
function craterHeight(craters: Crater[], x: number, y: number, z: number): number {
  let h = 0;
  for (const c of craters) {
    const d = c.x * x + c.y * y + c.z * z;
    if (d < c.cos) continue;
    const dist = Math.acos(Math.min(1, d)) / c.r;
    if (dist < 1) h -= (1 - dist * dist) * c.depth * 0.9;
    else if (dist < 1.35) h += Math.sin(((dist - 1) / 0.35) * Math.PI) * 0.35 * c.depth;
  }
  return h;
}

export function generatePlanetTexture(req: TextureRequest): TextureMaps {
  const width = Math.max(32, Math.round(req.width / 2) * 2);
  const height = width / 2;
  const n = new Noise3(req.seed);
  const n2 = new Noise3(req.seed ^ 0x9e3779b9);
  const base = hex(req.color);
  const second = req.color2 ? hex(req.color2) : hueShift(base, 38);
  const color = new Uint8ClampedArray(width * height * 4);
  const kind = req.kind;
  const wantsBump = kind === 'craters' || kind === 'ice' || kind === 'continents' || kind === 'spots' || kind === 'lava';
  const bump = wantsBump ? new Uint8ClampedArray(width * height * 4) : null;
  const emissive = kind === 'lava' ? new Uint8ClampedArray(width * height * 4) : null;
  const clouds = kind === 'clouds' || kind === 'continents' ? new Uint8ClampedArray(width * height * 4) : null;
  const craters = kind === 'craters' ? makeCraters(req.seed, 90) : kind === 'spots' ? makeCraters(req.seed, 18) : [];
  const r = rng(req.seed);
  // tempestade do gigante gasoso: latitude e longitude sorteadas pela semente
  const stormLat = (-0.25 - r() * 0.2) * Math.PI * 0.5;
  const stormLon = r() * Math.PI * 2;
  const storm = { x: Math.cos(stormLat) * Math.cos(stormLon), y: Math.sin(stormLat), z: Math.cos(stormLat) * Math.sin(stormLon) };

  for (let row = 0; row < height; row++) {
    const lat = (0.5 - (row + 0.5) / height) * Math.PI;
    const cl = Math.cos(lat);
    const y = Math.sin(lat);
    const absLat = Math.abs(lat) / (Math.PI / 2);
    for (let col = 0; col < width; col++) {
      const lon = ((col + 0.5) / width) * Math.PI * 2;
      const x = cl * Math.cos(lon);
      const z = cl * Math.sin(lon);
      const i = (row * width + col) * 4;
      let c: RGB = base;
      let h = 0.5;
      let glow = 0;
      let cloud = 0;

      switch (kind) {
        case 'none': {
          const v = n.fbm(x * 1.6, y * 1.6, z * 1.6, 4);
          c = mix(scale(base, 0.86 + v * 0.22), second, req.color2 ? smooth(-0.6, 0.6, y + v * 0.3) * 0.85 : 0.08);
          break;
        }
        case 'stripes': {
          const warp = n.fbm(x * 2.5, y * 2.5, z * 2.5, 4) * 0.35;
          const band = Math.sin((y + warp * 0.25) * 22) * 0.5 + 0.5;
          const fine = Math.sin((y + warp * 0.1) * 70) * 0.5 + 0.5;
          c = mix(mix(base, second, band), scale(mix(base, WHITE, 0.4), 1), fine * 0.18);
          c = scale(c, 0.9 + n2.fbm(x * 8, y * 30, z * 8, 3) * 0.12);
          break;
        }
        case 'gas': {
          // faixas com turbulência e a grande tempestade oval
          const dS = storm.x * x + storm.y * y + storm.z * z;
          const near = smooth(0.92, 0.995, dS);
          const swirl = near * 2.4;
          const wx = x * Math.cos(swirl) - z * Math.sin(swirl);
          const wz = x * Math.sin(swirl) + z * Math.cos(swirl);
          const turb = n.fbm(wx * 3, y * 9, wz * 3, 6);
          const lat2 = y + turb * 0.09;
          const band = Math.sin(lat2 * 17 + n2.fbm(x, y * 2, z, 2) * 2) * 0.5 + 0.5;
          const zone = Math.sin(lat2 * 6.3) * 0.5 + 0.5;
          const cream = mix(base, [0.96, 0.9, 0.78], 0.55);
          const dark = scale(mix(base, second, 0.6), 0.62);
          c = mix(mix(dark, cream, band), mix(base, second, 0.35), zone * 0.35);
          c = scale(c, 0.92 + turb * 0.18);
          const stormColor = mix(second, [0.75, 0.32, 0.22], req.color2 ? 0.25 : 0.7);
          c = mix(c, stormColor, smooth(0.955, 0.99, dS + turb * 0.01) * 0.9);
          break;
        }
        case 'craters': {
          const grey = mix([0.55, 0.55, 0.56], base, 0.35);
          const maria = smooth(0.05, 0.35, n.fbm(x * 1.8, y * 1.8, z * 1.8, 5));
          const ch = craterHeight(craters, x, y, z);
          const fine = n2.fbm(x * 18, y * 18, z * 18, 3);
          h = clamp01(0.55 + ch * 0.5 + fine * 0.08 - maria * 0.08);
          c = scale(mix(grey, mix(grey, second, 0.25), maria * 0.7), 0.78 + h * 0.4 + fine * 0.06);
          if (ch < -0.2) c = mix(c, scale(c, 0.7), 0.4);
          break;
        }
        case 'spots': {
          // estilo Marte: poeira, manchas escuras e calotas polares
          const dust = n.fbm(x * 2.2, y * 2.2, z * 2.2, 6);
          const patches = smooth(0.08, 0.3, n2.fbm(x * 1.4 + 3, y * 1.4, z * 1.4, 5));
          const ch = craterHeight(craters, x, y, z);
          h = clamp01(0.5 + dust * 0.4 + ch * 0.25);
          c = mix(scale(base, 0.95 + dust * 0.25), scale(mix(base, second, 0.5), 0.5), patches * 0.75);
          const cap = smooth(0.82, 0.9, absLat + dust * 0.05);
          c = mix(c, [0.95, 0.95, 0.97], cap);
          break;
        }
        case 'clouds': {
          // superfície encoberta (tipo Vênus) com nuvens que andam por cima
          const surf = n.fbm(x * 2, y * 2, z * 2, 5);
          c = mix(scale(base, 0.8 + surf * 0.2), second, smooth(-0.3, 0.5, surf) * 0.35);
          const w = n2.fbm(x * 1.5, y * 3, z * 1.5, 3) * 0.6;
          const k = n.fbm(x * 2.4 + w, y * 5 + w, z * 2.4 - w, 6);
          cloud = smooth(-0.05, 0.4, k);
          break;
        }
        case 'ice': {
          const cracks = n.ridged(x * 3, y * 3, z * 3, 4);
          const big = n2.fbm(x * 1.5, y * 1.5, z * 1.5, 4);
          const ice = mix(mix(base, WHITE, 0.72), [0.8, 0.9, 1], 0.3);
          const line = smooth(0.72, 0.92, cracks);
          h = clamp01(0.6 + big * 0.2 - line * 0.4);
          c = mix(scale(ice, 0.92 + big * 0.12), scale(mix(base, second, 0.5), 0.55), line * 0.75);
          c = mix(c, WHITE, smooth(0.75, 0.92, absLat) * 0.6);
          break;
        }
        case 'lava': {
          const rock = n.fbm(x * 3, y * 3, z * 3, 5);
          const cracks = n.ridged(x * 2.6 + 7, y * 2.6, z * 2.6, 5);
          const lakes = smooth(0.32, 0.45, n2.fbm(x * 1.3, y * 1.3, z * 1.3, 4));
          const hot = Math.max(smooth(0.78, 0.95, cracks), lakes);
          const stone = scale(mix([0.12, 0.09, 0.08], base, 0.25), 0.8 + rock * 0.4);
          const molten = mix([1, 0.35, 0.05], [1, 0.85, 0.3], smooth(0.9, 1, cracks) * 0.7 + lakes * 0.3);
          const tinted = req.color2 ? mix(molten, second, 0.35) : molten;
          c = mix(stone, tinted, hot);
          glow = hot;
          h = clamp01(0.55 + rock * 0.3 - hot * 0.35);
          break;
        }
        case 'continents': {
          const elev = n.fbm(x * 1.7, y * 1.7, z * 1.7, 7) + n2.fbm(x * 5, y * 5, z * 5, 3) * 0.15;
          const sea = 0.04;
          const ocean = req.color2 ? second : mix([0.06, 0.24, 0.55], base, 0.2);
          if (elev < sea) {
            const depth = smooth(-0.45, sea, elev);
            c = mix(scale(ocean, 0.55), mix(ocean, [0.3, 0.75, 0.85], 0.35), depth * depth);
            h = 0.45;
          } else {
            const t = smooth(sea, 0.5, elev);
            const low = mix([0.2, 0.42, 0.16], base, 0.45);
            const high = mix([0.5, 0.4, 0.28], base, 0.25);
            c = mix(low, high, t);
            c = mix(c, [0.86, 0.78, 0.6], smooth(0.0, 0.25, n2.fbm(x * 3 + 5, y * 3, z * 3, 3)) * (1 - absLat) * 0.35);
            c = mix(c, WHITE, smooth(0.38, 0.5, elev) * 0.8);
            h = 0.5 + t * 0.5;
          }
          c = mix(c, [0.94, 0.96, 1], smooth(0.8, 0.88, absLat + n.fbm(x * 4, y * 4, z * 4, 3) * 0.06));
          const k = n2.fbm(x * 2.5 + 11, y * 4.5, z * 2.5, 6);
          cloud = smooth(0.08, 0.42, k) * 0.9;
          break;
        }
      }

      color[i] = clamp01(c[0]) * 255;
      color[i + 1] = clamp01(c[1]) * 255;
      color[i + 2] = clamp01(c[2]) * 255;
      color[i + 3] = 255;
      if (bump) {
        const v = clamp01(h) * 255;
        bump[i] = v;
        bump[i + 1] = v;
        bump[i + 2] = v;
        bump[i + 3] = 255;
      }
      if (emissive) {
        const e = mix(BLACK, [1, 0.45, 0.1], glow);
        emissive[i] = e[0] * 255;
        emissive[i + 1] = e[1] * 255;
        emissive[i + 2] = e[2] * 255;
        emissive[i + 3] = 255;
      }
      if (clouds) {
        clouds[i] = 255;
        clouds[i + 1] = 255;
        clouds[i + 2] = 255;
        clouds[i + 3] = cloud * 235;
      }
    }
  }
  return { width, height, color, bump, emissive, clouds };
}
