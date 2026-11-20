/// <reference lib="webworker" />
import { generatePlanetTexture, type TextureRequest } from '../lib/planetTextures';

/** Gera as texturas fora da tela principal (cada uma leva dezenas de milissegundos). */
self.onmessage = (e: MessageEvent<{ id: number; req: TextureRequest }>) => {
  const { id, req } = e.data;
  try {
    const maps = generatePlanetTexture(req);
    const buffers = [maps.color, maps.bump, maps.emissive, maps.clouds].flatMap((b) => (b ? [b.buffer] : []));
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, maps }, buffers);
  } catch (err) {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: String(err) });
  }
};
