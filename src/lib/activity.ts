/**
 * A pessoa está olhando para o Órbita?
 *  - 'active': aba visível e com foco;
 *  - 'blurred': visível, mas sem foco (o Órbita num outro monitor enquanto a pessoa joga);
 *  - 'hidden': outra aba, janela minimizada ou coberta.
 *
 * As animações (planetas, estrelas, CSS) usam isso para pesar menos. Voz, live, gravação,
 * clipes, arquivos e chat não mudam em nada.
 */
export type Activity = 'active' | 'blurred' | 'hidden';

function compute(): Activity {
  if (typeof document === 'undefined') return 'active';
  if (document.visibilityState === 'hidden') return 'hidden';
  return document.hasFocus() ? 'active' : 'blurred';
}

let current: Activity = compute();
const listeners = new Set<(activity: Activity) => void>();

function update() {
  const next = compute();
  if (next === current) return;
  current = next;
  document.documentElement.dataset.activity = next;
  listeners.forEach((fn) => fn(next));
}

if (typeof window !== 'undefined') {
  document.documentElement.dataset.activity = current;
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
}

export const activity = () => current;

export function onActivity(fn: (activity: Activity) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Intervalo mínimo entre quadros de uma animação: ~60 por segundo com a aba em uso, ~20 sem
 * foco. Escondida, o próprio navegador já para de desenhar.
 */
export const minFrameMs = (activeMs: number) => (current === 'active' ? activeMs : 50);
