/**
 * Atualização automática: o build publica um version.json; o app consulta de tempos em
 * tempos (sem cache) e, se mudou, avisa. Fora de uma sala recarrega sozinho; dentro, mostra
 * um aviso para não derrubar a chamada.
 */

declare const __APP_BUILD__: string;

const CHECK_MS = 5 * 60_000;

export function watchForUpdates(onNewVersion: () => void) {
  if (!import.meta.env.PROD) return;
  let found = false;
  let last = 0;
  const check = async () => {
    if (found || Date.now() - last < 30_000) return;
    last = Date.now();
    try {
      const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { build } = (await res.json()) as { build?: string };
      if (build && build !== __APP_BUILD__) {
        found = true;
        onNewVersion();
      }
    } catch {
      /* sem internet agora: tenta depois */
    }
  };
  window.setInterval(() => void check(), CHECK_MS);
  window.addEventListener('focus', () => void check());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.setTimeout(() => void check(), 20_000);
}
