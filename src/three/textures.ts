import * as THREE from 'three';
import { photoMixOf, type PlanetStyle } from '../lib/planet';
import { generatePlanetTexture, generateSky, type TextureMaps, type TextureRequest } from '../lib/planetTextures';
import { partColors } from '../lib/texturePalette';

/** Texturas prontas de um planeta (já em forma de textura do three.js). */
export interface PlanetTextures {
  map: THREE.Texture;
  bumpMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
  clouds: THREE.Texture | null;
  dispose(): void;
}

// ───────────────────────── worker ─────────────────────────

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
type Reply = { maps?: TextureMaps; sky?: Uint8ClampedArray<ArrayBuffer> };
const pending = new Map<number, { resolve: (m: Reply) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./textures.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; maps?: TextureMaps; sky?: Uint8ClampedArray<ArrayBuffer>; error?: string }>) => {
        const job = pending.get(e.data.id);
        if (!job) return;
        pending.delete(e.data.id);
        if (e.data.maps || e.data.sky) job.resolve(e.data);
        else job.reject(new Error(e.data.error ?? 'textura'));
      };
      worker.onerror = () => {
        workerFailed = true;
        for (const job of pending.values()) job.reject(new Error('worker'));
        pending.clear();
        worker?.terminate();
        worker = null;
      };
    } catch {
      workerFailed = true;
      return null;
    }
  }
  return worker;
}

/** Mapas já gerados (a mesma aparência não é gerada duas vezes). */
const mapsCache = new Map<string, Promise<TextureMaps>>();

function requestMaps(req: TextureRequest): Promise<TextureMaps> {
  const key = JSON.stringify(req);
  let p = mapsCache.get(key);
  if (!p) {
    const w = getWorker();
    p = w
      ? new Promise<Reply>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          w.postMessage({ id, req });
        })
          .then((r) => r.maps!)
          .catch(() => generatePlanetTexture(req))
      : Promise.resolve().then(() => generatePlanetTexture(req));
    mapsCache.set(key, p);
    if (mapsCache.size > 48) mapsCache.delete(mapsCache.keys().next().value!);
  }
  return p;
}

// ───────────────────────── montagem ─────────────────────────

const images = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
    images.set(src, p);
    if (images.size > 64) images.delete(images.keys().next().value!);
  }
  return p;
}

function canvasFrom(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
}

function texture(source: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(source);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * Monta as texturas de um planeta. Com foto, ela é embrulhada no planeta (duas vezes na volta,
 * para o rosto aparecer de qualquer lado) e a textura escolhida fica por cima, semitransparente.
 */
export async function planetTextures(look: PlanetStyle, color: string, seed: number, photo: string | undefined, width = 768): Promise<PlanetTextures> {
  const maps = await requestMaps({ kind: look.texture, color, color2: look.color2, parts: partColors(look, color), seed, width });
  // cópias: os buffers do cache continuam inteiros para a próxima vez
  const surface = canvasFrom(new Uint8ClampedArray(maps.color), maps.width, maps.height);
  let mapCanvas = surface;
  const img = photo ? await loadImage(photo) : null;
  const mix = photoMixOf(look);
  if (img && mix > 0) {
    // a superfície embaixo e a foto por cima, tão visível quanto a pessoa escolheu
    mapCanvas = document.createElement('canvas');
    mapCanvas.width = maps.width;
    mapCanvas.height = maps.height;
    const g = mapCanvas.getContext('2d')!;
    g.drawImage(surface, 0, 0);
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    g.globalAlpha = mix;
    for (let k = 0; k < 2; k++) g.drawImage(img, sx, sy, side, side, k * maps.height, 0, maps.height, maps.height);
    g.globalAlpha = 1;
  }
  const map = texture(mapCanvas);
  const bumpMap = maps.bump ? texture(canvasFrom(new Uint8ClampedArray(maps.bump), maps.width, maps.height), false) : null;
  const emissiveMap = maps.emissive ? texture(canvasFrom(new Uint8ClampedArray(maps.emissive), maps.width, maps.height)) : null;
  const clouds = maps.clouds ? texture(canvasFrom(new Uint8ClampedArray(maps.clouds), maps.width, maps.height)) : null;
  return {
    map,
    bumpMap,
    emissiveMap,
    clouds,
    dispose() {
      map.dispose();
      bumpMap?.dispose();
      emissiveMap?.dispose();
      clouds?.dispose();
    },
  };
}

/** Textura de vídeo (câmera ligada) embrulhada no planeta. */
export function videoTexture(video: HTMLVideoElement, mirror: boolean): THREE.VideoTexture {
  const t = new THREE.VideoTexture(video);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  // duas voltas: o rosto aparece de qualquer lado
  t.repeat.set(mirror ? -2 : 2, 1);
  return t;
}

// ───────────────────────── céu ─────────────────────────

const skies = new Map<number, Promise<HTMLCanvasElement>>();

/** O céu com nebulosas de uma sala (cada sala tem o seu, sempre o mesmo). */
export function skyTexture(seed: number, width = 2048): Promise<THREE.Texture> {
  let p = skies.get(seed);
  if (!p) {
    const w = getWorker();
    const pixels: Promise<Uint8ClampedArray<ArrayBuffer>> = w
      ? new Promise<Reply>((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          w.postMessage({ id, sky: { seed, width } });
        })
          .then((r) => r.sky!)
          .catch(() => generateSky(seed, width))
      : Promise.resolve().then(() => generateSky(seed, width));
    p = pixels.then((data) => canvasFrom(data, width, width / 2));
    skies.set(seed, p);
    if (skies.size > 6) skies.delete(skies.keys().next().value!);
  }
  return p.then((canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  });
}
