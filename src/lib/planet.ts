/**
 * Aparência do planeta (o avatar): cores, textura, anéis, luas, brilho e enfeites. Vai junto
 * com o perfil e aparece para todo mundo da sala.
 */

export type PlanetTexture = 'none' | 'stripes' | 'craters' | 'spots' | 'clouds' | 'ice' | 'lava' | 'gas' | 'continents';
export type Ornament = 'star' | 'comet' | 'satellite' | 'ship';
/** 1 = pequeno/fino/devagar, 2 = normal, 3 = grande/grosso/rápido. */
export type Level = 1 | 2 | 3;

/** As partes de cada textura que têm cor própria. */
export type TexPart = 'stripes' | 'bands' | 'zones' | 'storm' | 'ocean' | 'land' | 'clouds' | 'rock' | 'lava' | 'ice' | 'cracks' | 'maria' | 'soil' | 'patches' | 'caps';

/** Partes com cor de cada textura (na ordem do editor). */
export const TEXTURE_PARTS: Record<PlanetTexture, Array<{ id: TexPart; label: string }>> = {
  none: [],
  stripes: [{ id: 'stripes', label: 'Faixas' }],
  gas: [
    { id: 'bands', label: 'Faixas escuras' },
    { id: 'zones', label: 'Faixas claras' },
    { id: 'storm', label: 'Tempestade' },
  ],
  continents: [
    { id: 'ocean', label: 'Oceano' },
    { id: 'land', label: 'Terra' },
    { id: 'clouds', label: 'Nuvens' },
  ],
  lava: [
    { id: 'rock', label: 'Rocha' },
    { id: 'lava', label: 'Lava' },
  ],
  ice: [
    { id: 'ice', label: 'Gelo' },
    { id: 'cracks', label: 'Rachaduras' },
  ],
  craters: [
    { id: 'rock', label: 'Rocha' },
    { id: 'maria', label: 'Planícies escuras' },
  ],
  spots: [
    { id: 'soil', label: 'Solo' },
    { id: 'patches', label: 'Manchas' },
    { id: 'caps', label: 'Calotas polares' },
  ],
  clouds: [{ id: 'clouds', label: 'Nuvens' }],
};

const ALL_PARTS = new Set<TexPart>(Object.values(TEXTURE_PARTS).flatMap((list) => list.map((p) => p.id)));

export interface PlanetStyle {
  texture: PlanetTexture;
  /** Segunda cor, misturada em degradê (null = uma cor só). */
  color2: string | null;
  rings: 0 | 1 | 2;
  ringColor: string;
  /** Inclinação dos anéis, em graus (-40 a 40). */
  ringTilt: number;
  ringWidth: Level;
  /** Anéis com faixas (linha dupla). */
  ringBands: boolean;
  moons: 0 | 1 | 2 | 3;
  moonColor: string;
  moonSize: Level;
  moonSpeed: Level;
  glow: boolean;
  glowColor: string;
  /** Coisas em órbita além das luas. */
  ornaments: Ornament[];
  /** Cores escolhidas para partes da textura (as que faltam são automáticas). */
  texColors: Partial<Record<TexPart, string>>;
  /** Quanto a foto aparece no planeta, de 0 (só a textura) a 1 (só a foto). null = automático. */
  photoMix: number | null;
}

/** Visibilidade da foto em uso (automático: lisa = só a foto; com textura, um pouco de cada). */
export const photoMixOf = (look: Pick<PlanetStyle, 'photoMix' | 'texture'>) => look.photoMix ?? (look.texture === 'none' ? 1 : 0.55);

export const PLANET_TEXTURES: Array<{ id: PlanetTexture; label: string }> = [
  { id: 'none', label: 'Lisa' },
  { id: 'stripes', label: 'Listras' },
  { id: 'craters', label: 'Crateras' },
  { id: 'spots', label: 'Manchas' },
  { id: 'clouds', label: 'Nuvens' },
  { id: 'ice', label: 'Gelo' },
  { id: 'lava', label: 'Lava' },
  { id: 'gas', label: 'Gasoso' },
  { id: 'continents', label: 'Continentes' },
];

export const ORNAMENTS: Array<{ id: Ornament; label: string }> = [
  { id: 'star', label: 'Estrela' },
  { id: 'comet', label: 'Cometa' },
  { id: 'satellite', label: 'Satélite' },
  { id: 'ship', label: 'Nave' },
];

export const DEFAULT_PLANET: PlanetStyle = {
  texture: 'none',
  color2: null,
  rings: 0,
  ringColor: '#c4b5fd',
  ringTilt: -16,
  ringWidth: 2,
  ringBands: false,
  moons: 0,
  moonColor: '#e2e8f0',
  moonSize: 2,
  moonSpeed: 2,
  glow: false,
  glowColor: '#22d3ee',
  ornaments: [],
  texColors: {},
  photoMix: null,
};

const HEX = /^#[0-9a-f]{6}$/i;
const color = (value: unknown, fallback: string) => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback);
const level = (value: unknown): Level => (value === 1 || value === 3 ? value : 2);

/** Valida uma aparência vinda do armazenamento ou da rede. */
export function sanitizePlanet(value: unknown): PlanetStyle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Partial<PlanetStyle>;
  const tilt = Number(p.ringTilt);
  const ornaments = Array.isArray(p.ornaments) ? ORNAMENTS.map((o) => o.id).filter((id) => (p.ornaments as unknown[]).includes(id)) : [];
  const texColors: Partial<Record<TexPart, string>> = {};
  if (p.texColors && typeof p.texColors === 'object') {
    for (const [key, value] of Object.entries(p.texColors)) {
      if (ALL_PARTS.has(key as TexPart) && typeof value === 'string' && HEX.test(value)) texColors[key as TexPart] = value.toLowerCase();
    }
  }
  const mix = Number(p.photoMix);
  return {
    texture: PLANET_TEXTURES.some((t) => t.id === p.texture) ? (p.texture as PlanetTexture) : 'none',
    color2: typeof p.color2 === 'string' && HEX.test(p.color2) ? p.color2.toLowerCase() : null,
    rings: p.rings === 1 || p.rings === 2 ? p.rings : 0,
    ringColor: color(p.ringColor, DEFAULT_PLANET.ringColor),
    ringTilt: Number.isFinite(tilt) ? Math.max(-40, Math.min(40, Math.round(tilt))) : DEFAULT_PLANET.ringTilt,
    ringWidth: level(p.ringWidth),
    ringBands: !!p.ringBands,
    moons: p.moons === 1 || p.moons === 2 || p.moons === 3 ? p.moons : 0,
    moonColor: color(p.moonColor, DEFAULT_PLANET.moonColor),
    moonSize: level(p.moonSize),
    moonSpeed: level(p.moonSpeed),
    glow: !!p.glow,
    glowColor: color(p.glowColor, DEFAULT_PLANET.glowColor),
    ornaments,
    texColors,
    photoMix: Number.isFinite(mix) && p.photoMix !== null ? Math.max(0, Math.min(1, Math.round(mix * 100) / 100)) : null,
  };
}
