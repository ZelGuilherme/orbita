import { TEXTURE_PARTS, type PlanetStyle, type PlanetTexture, type TexPart } from './planet';

/**
 * Cores das partes das texturas (oceano, lava, nuvens…). Sem escolha da pessoa, cada parte
 * tem uma cor automática que combina com a cor do planeta (e com a segunda cor, se houver).
 */

export type RGB = [number, number, number];

export function hexToRgb(value: string): RGB {
  const n = parseInt(value.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const h = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scaleRgb = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

/** Gira o matiz (para derivar uma segunda cor quando a pessoa só escolheu uma). */
export function hueShift([r, g, b]: RGB, degrees: number): RGB {
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

/** A segunda cor em uso (a escolhida ou uma derivada da principal). */
export const secondOf = (base: string, color2: string | null): RGB => (color2 ? hexToRgb(color2) : hueShift(hexToRgb(base), 38));

/** Cores automáticas de cada parte. */
export function autoPartColors(kind: PlanetTexture, base: string, color2: string | null): Partial<Record<TexPart, string>> {
  const b = hexToRgb(base);
  const s = secondOf(base, color2);
  const out: Partial<Record<TexPart, RGB>> = {};
  switch (kind) {
    case 'stripes':
      out.stripes = s;
      break;
    case 'gas':
      out.bands = scaleRgb(mixRgb(b, s, 0.6), 0.7);
      out.zones = mixRgb(b, [0.96, 0.9, 0.78], 0.55);
      out.storm = mixRgb(s, [0.75, 0.32, 0.22], color2 ? 0.25 : 0.7);
      break;
    case 'continents':
      out.ocean = color2 ? s : mixRgb([0.08, 0.3, 0.62], b, 0.2);
      out.land = mixRgb([0.24, 0.48, 0.18], b, 0.45);
      out.clouds = [1, 1, 1];
      break;
    case 'lava':
      out.rock = mixRgb([0.2, 0.16, 0.15], b, 0.45);
      out.lava = color2 ? mixRgb([1, 0.45, 0.08], s, 0.35) : [1, 0.45, 0.08];
      break;
    case 'ice':
      out.ice = mixRgb(mixRgb(b, [1, 1, 1], 0.72), [0.8, 0.9, 1], 0.3);
      out.cracks = scaleRgb(mixRgb(b, s, 0.5), 0.6);
      break;
    case 'craters':
      out.rock = mixRgb([0.6, 0.6, 0.62], b, 0.4);
      out.maria = scaleRgb(mixRgb(mixRgb([0.6, 0.6, 0.62], b, 0.4), s, 0.25), 0.72);
      break;
    case 'spots':
      out.soil = b;
      out.patches = scaleRgb(mixRgb(b, s, 0.5), 0.55);
      out.caps = [0.95, 0.95, 0.97];
      break;
    case 'clouds':
      out.clouds = [1, 1, 1];
      break;
    default:
      break;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, rgbToHex(v as RGB)]));
}

/** Cores de todas as partes da textura do planeta (as escolhidas valem mais que as automáticas). */
export function partColors(look: Pick<PlanetStyle, 'texture' | 'color2' | 'texColors'>, base: string): Partial<Record<TexPart, string>> {
  const auto = autoPartColors(look.texture, base, look.color2);
  const out: Partial<Record<TexPart, string>> = {};
  for (const { id } of TEXTURE_PARTS[look.texture]) out[id] = look.texColors[id] ?? auto[id];
  return out;
}
