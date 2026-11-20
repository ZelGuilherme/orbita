/// <reference lib="webworker" />
import { generatePlanetTexture, generateSky, type TextureRequest } from '../lib/planetTextures';

/**
 * Gera as texturas fora da tela principal (cada uma leva dezenas a centenas de milissegundos) e
 * já devolve também em PNG, para guardar no navegador e não precisar gerar de novo.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

async function png(data: Uint8ClampedArray<ArrayBuffer> | null, width: number, height: number): Promise<Blob | null> {
  if (!data || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return null;
  }
}

scope.onmessage = async (e: MessageEvent<{ req?: TextureRequest; sky?: { seed: number; width: number } }>) => {
  const { req, sky } = e.data;
  try {
    if (sky) {
      const pixels = generateSky(sky.seed, sky.width);
      const skyPng = await png(pixels, sky.width, sky.width / 2);
      scope.postMessage({ sky: pixels, skyPng }, [pixels.buffer]);
      return;
    }
    const maps = generatePlanetTexture(req!);
    const [color, bump, emissive, clouds] = await Promise.all([
      png(maps.color, maps.width, maps.height),
      png(maps.bump, maps.width, maps.height),
      png(maps.emissive, maps.width, maps.height),
      png(maps.clouds, maps.width, maps.height),
    ]);
    const pngs = color ? { color, bump, emissive, clouds } : null;
    const buffers = [maps.color, maps.bump, maps.emissive, maps.clouds].flatMap((b) => (b ? [b.buffer] : []));
    scope.postMessage({ maps, pngs }, buffers);
  } catch (err) {
    scope.postMessage({ error: String(err) });
  }
};
