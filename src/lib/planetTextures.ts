import { Noise3, rng } from './noise';
import type { PlanetTexture, TexPart } from './planet';
import { hexToRgb, mixRgb as mix, scaleRgb as scale, secondOf, type RGB } from './texturePalette';

/**
 * Texturas realistas dos planetas, geradas por código (sem imagens): faixas e tempestade de
 * gigante gasoso, oceano com continentes e nuvens, crateras com relevo, lava brilhando nas
 * rachaduras, gelo rachado… Cada parte tem a cor escolhida no editor (ou uma automática).
 *
 * A imagem é equirretangular (largura = 2 × altura, linha 0 = polo norte) e o ruído é amostrado
 * na esfera, então não há emenda. Roda num worker (three/textures.worker.ts). Aqui também sai o
 * céu do fundo (nebulosas).
 */

export interface TextureRequest {
  kind: PlanetTexture;
  color: string;
  color2: string | null;
  /** Cor de cada parte da textura, já resolvida (escolhida ou automática). */
  parts: Partial<Record<TexPart, string>>;
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

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const WHITE: RGB = [1, 1, 1];

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
  const base = hexToRgb(req.color);
  const second = secondOf(req.color, req.color2);
  const part = (id: TexPart, fallback: RGB): RGB => (req.parts[id] ? hexToRgb(req.parts[id]!) : fallback);
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

  // cores das partes (as automáticas são as mesmas que o editor mostra)
  const stripes = part('stripes', second);
  const bands = part('bands', scale(mix(base, second, 0.6), 0.7));
  const zones = part('zones', mix(base, [0.96, 0.9, 0.78], 0.55));
  const stormColor = part('storm', [0.75, 0.32, 0.22]);
  const ocean = part('ocean', [0.08, 0.3, 0.62]);
  const land = part('land', [0.24, 0.48, 0.18]);
  const cloudColor = part('clouds', WHITE);
  const rockColor = part('rock', kind === 'lava' ? mix([0.2, 0.16, 0.15], base, 0.45) : mix([0.6, 0.6, 0.62], base, 0.4));
  const lavaColor = part('lava', [1, 0.45, 0.08]);
  const iceColor = part('ice', mix(base, WHITE, 0.72));
  const cracksColor = part('cracks', scale(mix(base, second, 0.5), 0.6));
  const mariaColor = part('maria', scale(rockColor, 0.72));
  const soil = part('soil', base);
  const patchesColor = part('patches', scale(mix(base, second, 0.5), 0.55));
  const caps = part('caps', [0.95, 0.95, 0.97]);
  // o centro da rachadura de lava é mais claro (quase branco-amarelado)
  const lavaHot = mix(lavaColor, [1, 0.95, 0.7], 0.55);

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
      let glow: RGB | null = null;
      let cloud = 0;

      switch (kind) {
        case 'none': {
          const v = n.fbm(x * 1.6, y * 1.6, z * 1.6, 4);
          c = mix(scale(base, 0.9 + v * 0.2), second, req.color2 ? smooth(-0.6, 0.6, y + v * 0.3) * 0.85 : 0.08);
          break;
        }
        case 'stripes': {
          const warp = n.fbm(x * 2.5, y * 2.5, z * 2.5, 4) * 0.35;
          const band = Math.sin((y + warp * 0.25) * 22) * 0.5 + 0.5;
          const fine = Math.sin((y + warp * 0.1) * 70) * 0.5 + 0.5;
          c = mix(mix(base, stripes, band), mix(base, WHITE, 0.4), fine * 0.18);
          c = scale(c, 0.92 + n2.fbm(x * 8, y * 30, z * 8, 3) * 0.12);
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
          c = mix(mix(bands, zones, band), base, zone * 0.3);
          c = scale(c, 0.94 + turb * 0.18);
          c = mix(c, stormColor, smooth(0.955, 0.99, dS + turb * 0.01) * 0.9);
          break;
        }
        case 'craters': {
          const maria = smooth(0.05, 0.35, n.fbm(x * 1.8, y * 1.8, z * 1.8, 5));
          const ch = craterHeight(craters, x, y, z);
          const fine = n2.fbm(x * 18, y * 18, z * 18, 3);
          h = clamp01(0.55 + ch * 0.5 + fine * 0.08 - maria * 0.08);
          c = scale(mix(rockColor, mariaColor, maria * 0.85), 0.82 + h * 0.36 + fine * 0.06);
          if (ch < -0.2) c = scale(c, 0.85);
          break;
        }
        case 'spots': {
          // estilo Marte: poeira, manchas escuras e calotas polares
          const dust = n.fbm(x * 2.2, y * 2.2, z * 2.2, 6);
          const patches = smooth(0.08, 0.3, n2.fbm(x * 1.4 + 3, y * 1.4, z * 1.4, 5));
          const ch = craterHeight(craters, x, y, z);
          h = clamp01(0.5 + dust * 0.4 + ch * 0.25);
          c = mix(scale(soil, 0.95 + dust * 0.25), patchesColor, patches * 0.8);
          c = mix(c, caps, smooth(0.82, 0.9, absLat + dust * 0.05));
          break;
        }
        case 'clouds': {
          // superfície encoberta (tipo Vênus) com nuvens que andam por cima
          const surf = n.fbm(x * 2, y * 2, z * 2, 5);
          c = mix(scale(base, 0.85 + surf * 0.2), second, smooth(-0.3, 0.5, surf) * 0.3);
          const w = n2.fbm(x * 1.5, y * 3, z * 1.5, 3) * 0.6;
          const k = n.fbm(x * 2.4 + w, y * 5 + w, z * 2.4 - w, 6);
          cloud = smooth(-0.05, 0.4, k);
          break;
        }
        case 'ice': {
          const cracks = n.ridged(x * 3, y * 3, z * 3, 4);
          const big = n2.fbm(x * 1.5, y * 1.5, z * 1.5, 4);
          const line = smooth(0.72, 0.92, cracks);
          h = clamp01(0.6 + big * 0.2 - line * 0.4);
          c = mix(scale(iceColor, 0.94 + big * 0.12), cracksColor, line * 0.8);
          c = mix(c, mix(iceColor, WHITE, 0.6), smooth(0.75, 0.92, absLat) * 0.6);
          break;
        }
        case 'lava': {
          const rock = n.fbm(x * 3, y * 3, z * 3, 5);
          const cracks = n.ridged(x * 2.6 + 7, y * 2.6, z * 2.6, 5);
          const lakes = smooth(0.32, 0.45, n2.fbm(x * 1.3, y * 1.3, z * 1.3, 4));
          const hot = Math.max(smooth(0.78, 0.95, cracks), lakes);
          const stone = scale(rockColor, 0.85 + rock * 0.4);
          const molten = mix(lavaColor, lavaHot, smooth(0.9, 1, cracks) * 0.7 + lakes * 0.3);
          c = mix(stone, molten, hot);
          glow = scale(molten, hot);
          h = clamp01(0.55 + rock * 0.3 - hot * 0.35);
          break;
        }
        case 'continents': {
          const elev = n.fbm(x * 1.7, y * 1.7, z * 1.7, 7) + n2.fbm(x * 5, y * 5, z * 5, 3) * 0.15;
          const sea = 0.04;
          if (elev < sea) {
            const depth = smooth(-0.45, sea, elev);
            c = mix(scale(ocean, 0.6), mix(ocean, [0.3, 0.75, 0.85], 0.35), depth * depth);
            h = 0.45;
          } else {
            const t = smooth(sea, 0.5, elev);
            const high = mix(land, [0.55, 0.45, 0.32], 0.55);
            c = mix(land, high, t);
            c = mix(c, [0.86, 0.78, 0.6], smooth(0.0, 0.25, n2.fbm(x * 3 + 5, y * 3, z * 3, 3)) * (1 - absLat) * 0.3);
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
        const e = glow ?? [0, 0, 0];
        emissive[i] = clamp01(e[0]) * 255;
        emissive[i + 1] = clamp01(e[1]) * 255;
        emissive[i + 2] = clamp01(e[2]) * 255;
        emissive[i + 3] = 255;
      }
      if (clouds) {
        clouds[i] = cloudColor[0] * 255;
        clouds[i + 1] = cloudColor[1] * 255;
        clouds[i + 2] = cloudColor[2] * 255;
        clouds[i + 3] = cloud * 235;
      }
    }
  }
  return { width, height, color, bump, emissive, clouds };
}

// ───────────────────────── céu (nebulosas) ─────────────────────────

/** Combinações de cores das nebulosas (cada sala sorteia uma pela semente). */
const SKY_PALETTES: Array<[RGB, RGB, RGB]> = [
  [[0.45, 0.2, 0.75], [0.1, 0.55, 0.75], [0.85, 0.3, 0.55]],
  [[0.2, 0.3, 0.85], [0.6, 0.2, 0.7], [0.15, 0.7, 0.65]],
  [[0.75, 0.3, 0.25], [0.45, 0.2, 0.7], [0.95, 0.6, 0.3]],
  [[0.15, 0.55, 0.5], [0.3, 0.25, 0.8], [0.85, 0.4, 0.75]],
];

/**
 * Céu do fundo: escuro, com nebulosas coloridas suaves, faixas de poeira e um mar de estrelas
 * bem pequenas. Equirretangular, amostrado na esfera (sem emenda).
 */
export function generateSky(seed: number, width: number): Uint8ClampedArray<ArrayBuffer> {
  const height = width / 2;
  const n = new Noise3(seed);
  const n2 = new Noise3(seed ^ 0x51ed270b);
  const r = rng(seed ^ 0x2545f491);
  const [c1, c2, c3] = SKY_PALETTES[seed % SKY_PALETTES.length];
  const out = new Uint8ClampedArray(width * height * 4);
  // um "plano da galáxia" inclinado, onde a nebulosa se concentra
  const gx = r() - 0.5;
  const gy = 1;
  const gz = r() - 0.5;
  const gl = Math.hypot(gx, gy, gz);
  for (let row = 0; row < height; row++) {
    const lat = (0.5 - (row + 0.5) / height) * Math.PI;
    const cl = Math.cos(lat);
    const y = Math.sin(lat);
    for (let col = 0; col < width; col++) {
      const lon = ((col + 0.5) / width) * Math.PI * 2;
      const x = cl * Math.cos(lon);
      const z = cl * Math.sin(lon);
      const band = 1 - Math.abs((x * gx + y * gy + z * gz) / gl);
      const warp = n2.fbm(x * 1.5, y * 1.5, z * 1.5, 3) * 0.8;
      const cloud = n.fbm(x * 2.2 + warp, y * 2.2 - warp, z * 2.2, 6);
      const detail = n2.fbm(x * 6, y * 6, z * 6, 4);
      const density = smooth(-0.05, 0.6, cloud + band * 0.35 - 0.2) * (0.65 + 0.35 * detail);
      const dust = smooth(0.55, 0.85, n.ridged(x * 3 + 4, y * 3, z * 3, 4)) * band * 0.7;
      const hue = smooth(-0.4, 0.5, n2.fbm(x * 1.1 + 9, y * 1.1, z * 1.1, 3));
      let c = mix(mix(c1, c2, hue), c3, smooth(0.35, 0.75, detail) * 0.6);
      // núcleos mais claros onde a nuvem é mais densa
      const core = smooth(0.5, 0.95, density) * 0.16;
      c = mix(scale(c, density * 0.62 * (1 - dust)), [1, 0.92, 0.95], core * (1 - dust));
      // fundo quase preto com um toque azulado (as estrelas são desenhadas à parte, nítidas)
      const px: RGB = [0.012 + c[0], 0.014 + c[1], 0.035 + c[2]];
      const i = (row * width + col) * 4;
      out[i] = clamp01(px[0]) * 255;
      out[i + 1] = clamp01(px[1]) * 255;
      out[i + 2] = clamp01(px[2]) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}
