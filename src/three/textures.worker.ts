/// <reference lib="webworker" />
import { generatePlanetTexture, generateSky, type TextureRequest } from '../lib/planetTextures';

/** Gera as texturas fora da tela principal (cada uma leva dezenas de milissegundos). */
self.onmessage = (e: MessageEvent<{ id: number; req?: TextureRequest; sky?: { seed: number; width: number } }>) => {
  const { id, req, sky } = e.data;
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  try {
    if (sky) {
      const pixels = generateSky(sky.seed, sky.width);
      scope.postMessage({ id, sky: pixels }, [pixels.buffer]);
      return;
    }
    const maps = generatePlanetTexture(req!);
    const buffers = [maps.color, maps.bump, maps.emissive, maps.clouds].flatMap((b) => (b ? [b.buffer] : []));
    scope.postMessage({ id, maps }, buffers);
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
