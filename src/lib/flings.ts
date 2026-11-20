/**
 * Reações que voam na órbita: um emoji estoura em volta do planeta de quem mandou ou voa do
 * planeta de quem mandou até o de outra pessoa. Aqui ficam o "barramento" (a rede avisa, a
 * órbita desenha) e o localizador de planetas (para soltar o emoji arrastado em cima de alguém).
 */

export interface Fling {
  from: string;
  emoji: string;
  to?: string;
}

/** Um emoji (com tons de pele, junções e bandeiras), sem letras nem texto. */
const EMOJI = /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣])+$/u;
export const validFlingEmoji = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 16 && EMOJI.test(value) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);

/** Uma reação por segundo por pessoa (o host confere com uma folga). */
export const FLING_COOLDOWN_MS = 1_000;

type Listener = (fling: Fling) => void;
const listeners = new Set<Listener>();

export function onFling(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitFling(fling: Fling) {
  for (const l of listeners) l(fling);
}

/** Quem está embaixo deste ponto da tela (a órbita registra; null = ninguém). */
type Picker = (clientX: number, clientY: number) => string | null;
const pickers = new Set<Picker>();

export function registerPlanetPicker(picker: Picker): () => void {
  pickers.add(picker);
  return () => pickers.delete(picker);
}

export function planetAt(clientX: number, clientY: number): string | null {
  for (const p of pickers) {
    const id = p(clientX, clientY);
    if (id) return id;
  }
  return null;
}
