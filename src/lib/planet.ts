/**
 * Aparência do planeta (o avatar): textura, anéis, luas e brilho. Vai junto com o perfil
 * e aparece para todo mundo da sala.
 */

export type PlanetTexture = 'none' | 'stripes' | 'craters' | 'spots' | 'clouds';

export interface PlanetStyle {
  texture: PlanetTexture;
  rings: 0 | 1 | 2;
  ringColor: string;
  /** Inclinação dos anéis, em graus (-40 a 40). */
  ringTilt: number;
  moons: 0 | 1 | 2 | 3;
  moonColor: string;
  glow: boolean;
  glowColor: string;
}

export const PLANET_TEXTURES: Array<{ id: PlanetTexture; label: string }> = [
  { id: 'none', label: 'Lisa' },
  { id: 'stripes', label: 'Listras' },
  { id: 'craters', label: 'Crateras' },
  { id: 'spots', label: 'Manchas' },
  { id: 'clouds', label: 'Nuvens' },
];

export const DEFAULT_PLANET: PlanetStyle = {
  texture: 'none',
  rings: 0,
  ringColor: '#c4b5fd',
  ringTilt: -16,
  moons: 0,
  moonColor: '#e2e8f0',
  glow: false,
  glowColor: '#22d3ee',
};

const HEX = /^#[0-9a-f]{6}$/i;
const color = (value: unknown, fallback: string) => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback);

/** Valida uma aparência vinda do armazenamento ou da rede. */
export function sanitizePlanet(value: unknown): PlanetStyle | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Partial<PlanetStyle>;
  const tilt = Number(p.ringTilt);
  return {
    texture: PLANET_TEXTURES.some((t) => t.id === p.texture) ? (p.texture as PlanetTexture) : 'none',
    rings: p.rings === 1 || p.rings === 2 ? p.rings : 0,
    ringColor: color(p.ringColor, DEFAULT_PLANET.ringColor),
    ringTilt: Number.isFinite(tilt) ? Math.max(-40, Math.min(40, Math.round(tilt))) : DEFAULT_PLANET.ringTilt,
    moons: p.moons === 1 || p.moons === 2 || p.moons === 3 ? p.moons : 0,
    moonColor: color(p.moonColor, DEFAULT_PLANET.moonColor),
    glow: !!p.glow,
    glowColor: color(p.glowColor, DEFAULT_PLANET.glowColor),
  };
}
