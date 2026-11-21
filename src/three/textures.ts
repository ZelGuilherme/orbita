import * as THREE from 'three';
import { cacheGet, cacheSet } from '../lib/idbCache';
import { photoMixOf, type PlanetStyle } from '../lib/planet';
import { generatePlanetTexture, generateSky, type TextureMaps, type TextureRequest } from '../lib/planetTextures';
import { partColors } from '../lib/texturePalette';

/**
 * Texturas dos planetas e do céu.
 *
 * - Geradas fora da tela principal por até duas tarefas (workers) em paralelo, numa fila com
 *   prioridade: primeiro os planetas da órbita, depois as imagens pequenas e por último o céu.
 * - Guardadas no navegador (IndexedDB, como PNG): ao recarregar ou voltar para a sala, os
 *   planetas aparecem na hora, sem gerar de novo.
 */

/** Texturas prontas de um planeta (já em forma de textura do three.js). */
export interface PlanetTextures {
  map: THREE.Texture;
  bumpMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
  clouds: THREE.Texture | null;
  dispose(): void;
}

/** Prioridade na fila: 0 = planeta na órbita, 1 = imagem pequena, 2 = céu. */
export type Priority = 0 | 1 | 2;

/** Os mapas de uma textura, já como imagens (canvas). */
interface MapCanvases {
  width: number;
  height: number;
  color: HTMLCanvasElement;
  bump: HTMLCanvasElement | null;
  emissive: HTMLCanvasElement | null;
  clouds: HTMLCanvasElement | null;
}

type Pngs = { color: Blob; bump: Blob | null; emissive: Blob | null; clouds: Blob | null };
type Reply = { maps?: TextureMaps; pngs?: Pngs | null; sky?: Uint8ClampedArray<ArrayBuffer>; skyPng?: Blob | null };

// ───────────────────────── fila de trabalho (workers) ─────────────────────────

interface Job {
  priority: Priority;
  seq: number;
  msg: Record<string, unknown>;
  resolve: (r: Reply) => void;
  reject: (e: Error) => void;
}

const queue: Job[] = [];
const idle: Worker[] = [];
const running = new Map<Worker, Job>();
let pool: Worker[] | null = null;
let poolFailed = false;
let seq = 0;

function startPool(): boolean {
  if (poolFailed) return false;
  if (pool) return true;
  const size = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
  try {
    pool = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./textures.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<Reply & { error?: string }>) => {
        const job = running.get(w);
        running.delete(w);
        idle.push(w);
        if (job) {
          if (e.data.error) job.reject(new Error(e.data.error));
          else job.resolve(e.data);
        }
        pump();
      };
      w.onerror = () => {
        poolFailed = true;
        for (const job of [...running.values(), ...queue.splice(0)]) job.reject(new Error('worker'));
        running.clear();
        for (const x of pool ?? []) x.terminate();
        pool = null;
        idle.length = 0;
      };
      idle.push(w);
      return w;
    });
    return true;
  } catch {
    poolFailed = true;
    return false;
  }
}

function pump() {
  while (idle.length && queue.length) {
    const w = idle.pop()!;
    const job = queue.shift()!;
    running.set(w, job);
    w.postMessage(job.msg);
  }
}

function schedule(msg: Record<string, unknown>, priority: Priority): Promise<Reply> {
  if (!startPool()) return Promise.reject(new Error('sem worker'));
  return new Promise((resolve, reject) => {
    queue.push({ priority, seq: seq++, msg, resolve, reject });
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    pump();
  });
}

// ───────────────────────── mapas (com cache) ─────────────────────────

function canvasFrom(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
}

async function canvasFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function fromMaps(maps: TextureMaps): MapCanvases {
  return {
    width: maps.width,
    height: maps.height,
    color: canvasFrom(maps.color, maps.width, maps.height),
    bump: maps.bump ? canvasFrom(maps.bump, maps.width, maps.height) : null,
    emissive: maps.emissive ? canvasFrom(maps.emissive, maps.width, maps.height) : null,
    clouds: maps.clouds ? canvasFrom(maps.clouds, maps.width, maps.height) : null,
  };
}

async function fromPngs(p: Pngs & { width: number; height: number }): Promise<MapCanvases> {
  const [color, bump, emissive, clouds] = await Promise.all([p.color, p.bump, p.emissive, p.clouds].map((b) => (b ? canvasFromBlob(b) : Promise.resolve(null))));
  return { width: p.width, height: p.height, color: color!, bump, emissive, clouds };
}

/** Mapas já prontos nesta aba (a mesma aparência não é montada duas vezes). */
const mapsCache = new Map<string, Promise<MapCanvases>>();

function requestMaps(req: TextureRequest, priority: Priority): Promise<MapCanvases> {
  const key = JSON.stringify(req);
  let p = mapsCache.get(key);
  if (!p) {
    p = (async () => {
      // 1) guardado no navegador de outra vez?
      const saved = await cacheGet<Pngs & { width: number; height: number }>('maps', key);
      if (saved?.color) {
        try {
          return await fromPngs(saved);
        } catch {
          /* imagem estragada: gera de novo */
        }
      }
      // 2) gera (num worker; sem worker, aqui mesmo)
      let reply: Reply;
      try {
        reply = await schedule({ req }, priority);
      } catch {
        reply = { maps: generatePlanetTexture(req), pngs: null };
      }
      const maps = reply.maps!;
      if (reply.pngs) void cacheSet('maps', key, { ...reply.pngs, width: maps.width, height: maps.height });
      return fromMaps(maps);
    })();
    mapsCache.set(key, p);
    p.catch(() => mapsCache.delete(key));
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

function texture(source: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(source);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * Desenha a foto no mapa do planeta (W = 2H: a volta inteira na largura), do jeito escolhido:
 *  - uma só: um adesivo redondo de bordas suaves na frente; o resto é a textura;
 *  - esticada: uma cópia ocupando a volta inteira;
 *  - espelhada: frente normal e verso espelhado (as emendas somem);
 *  - repetida: N ladrilhos na volta (e linhas suficientes para ficarem quase quadrados).
 */
function drawPhoto(g: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number, look: PlanetStyle) {
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const put = (x: number, y: number, dw: number, dh: number, flip = false) => {
    if (!flip) {
      g.drawImage(img, sx, sy, side, side, x, y, dw, dh);
      return;
    }
    g.save();
    g.translate(x + dw, y);
    g.scale(-1, 1);
    g.drawImage(img, sx, sy, side, side, 0, 0, dw, dh);
    g.restore();
  };
  switch (look.photoFit) {
    case 'single': {
      // adesivo: a foto num círculo com a borda esfumada, centrado na frente do planeta
      const size = Math.round(h * 0.62);
      const sticker = document.createElement('canvas');
      sticker.width = sticker.height = size;
      const s = sticker.getContext('2d')!;
      s.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      const mask = s.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size / 2);
      mask.addColorStop(0, 'rgba(0,0,0,1)');
      mask.addColorStop(1, 'rgba(0,0,0,0)');
      s.globalCompositeOperation = 'destination-in';
      s.fillStyle = mask;
      s.fillRect(0, 0, size, size);
      g.drawImage(sticker, w * 0.25 - size / 2, (h - size) / 2);
      return;
    }
    case 'stretch':
      put(0, 0, w, h);
      return;
    case 'mirror':
      put(0, 0, w / 2, h);
      put(w / 2, 0, w / 2, h, true);
      return;
    default: {
      const n = Math.max(2, Math.min(10, Math.round(look.photoRepeat || 2)));
      const tileW = w / n;
      const rows = Math.max(1, Math.round(h / tileW));
      const tileH = h / rows;
      for (let r = 0; r < rows; r++) for (let c = 0; c < n; c++) put(c * tileW, r * tileH, tileW, tileH);
    }
  }
}

/**
 * Monta as texturas de um planeta. Com foto, ela vai por cima da superfície (do jeito
 * escolhido), tão visível quanto a pessoa escolheu.
 */
export async function planetTextures(look: PlanetStyle, color: string, seed: number, photo: string | undefined, width = 768, priority: Priority = 0): Promise<PlanetTextures> {
  const maps = await requestMaps({ kind: look.texture, color, color2: look.color2, parts: partColors(look, color), seed, width }, priority);
  let mapCanvas = maps.color;
  const img = photo ? await loadImage(photo) : null;
  const mix = photoMixOf(look);
  if (img && mix > 0) {
    // a superfície embaixo e a foto por cima (canvas novo: o mapa guardado continua limpo)
    mapCanvas = document.createElement('canvas');
    mapCanvas.width = maps.width;
    mapCanvas.height = maps.height;
    const g = mapCanvas.getContext('2d')!;
    g.drawImage(maps.color, 0, 0);
    g.globalAlpha = mix;
    drawPhoto(g, img, maps.width, maps.height, look);
    g.globalAlpha = 1;
  }
  const map = texture(mapCanvas);
  const bumpMap = maps.bump ? texture(maps.bump, false) : null;
  const emissiveMap = maps.emissive ? texture(maps.emissive) : null;
  const clouds = maps.clouds ? texture(maps.clouds) : null;
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

const skies = new Map<string, Promise<HTMLCanvasElement>>();

/** O céu com nebulosas de uma sala (cada sala tem o seu, sempre o mesmo). Vem por último na fila. */
export function skyTexture(seed: number, width = 1024): Promise<THREE.Texture> {
  const key = `sky:${seed}:${width}`;
  let p = skies.get(key);
  if (!p) {
    p = (async () => {
      const saved = await cacheGet<Blob>('maps', key);
      if (saved) {
        try {
          return await canvasFromBlob(saved);
        } catch {
          /* gera de novo */
        }
      }
      let reply: Reply;
      try {
        reply = await schedule({ sky: { seed, width } }, 2);
      } catch {
        reply = { sky: generateSky(seed, width), skyPng: null };
      }
      if (reply.skyPng) void cacheSet('maps', key, reply.skyPng);
      return canvasFrom(reply.sky!, width, width / 2);
    })();
    skies.set(key, p);
    p.catch(() => skies.delete(key));
    if (skies.size > 6) skies.delete(skies.keys().next().value!);
  }
  return p.then((canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  });
}
