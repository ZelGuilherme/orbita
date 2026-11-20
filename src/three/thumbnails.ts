import * as THREE from 'three';
import type { PlanetStyle } from '../lib/planet';
import { THUMB_FRAME } from '../lib/webgl';
import { PlanetObject } from './planetMesh';

/**
 * Imagens dos planetas 3D para os lugares pequenos (lista de pessoas, chat, cartões).
 * Um único desenhista fora da tela gera cada aparência uma vez; depois é só uma imagem.
 * A imagem tem o planeta no meio ocupando 1/FRAME da largura (anéis, luas e enfeites em volta).
 */

export const FRAME = THUMB_FRAME;

export interface ThumbSpec {
  color: string;
  look: PlanetStyle;
  seed: number;
  photo?: string;
  /** Lado da imagem em px. */
  px: number;
}

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
const cache = new Map<string, string>();
const jobs = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();

export const thumbKey = (s: ThumbSpec) => JSON.stringify([s.color, s.look, s.seed, s.photo?.length ?? 0, s.photo?.slice(-40) ?? '', s.px]);

export const cachedThumb = (s: ThumbSpec) => cache.get(thumbKey(s));

function setup() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight('#ffffff', 0.8));
  const key = new THREE.DirectionalLight('#fff4e0', 2.4);
  key.position.set(-3, 2.2, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight('#a5b4fc', 0.8);
  rim.position.set(4, -1, -3);
  scene.add(rim);
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  // o planeta (diâmetro 2) ocupa 1/FRAME da imagem: a câmera enxerga 2 × FRAME de altura
  const dist = FRAME / Math.tan(((30 / 2) * Math.PI) / 180);
  camera.position.set(0, dist * 0.2, dist);
  camera.lookAt(0, 0, 0);
}

async function render(spec: ThumbSpec): Promise<string> {
  setup();
  const planet = new PlanetObject({ color: spec.color, look: spec.look, seed: spec.seed, photo: spec.photo, radius: 1, detail: spec.px > 200 ? 512 : 256 });
  try {
    await planet.ready;
    planet.update(0, 0, true);
    scene!.add(planet.group);
    renderer!.setSize(spec.px, spec.px, false);
    renderer!.render(scene!, camera!);
    return renderer!.domElement.toDataURL('image/png');
  } finally {
    planet.dispose();
  }
}

/** Imagem do planeta (gerada uma vez por aparência; os pedidos entram numa fila). */
export function requestThumb(spec: ThumbSpec): Promise<string> {
  const key = thumbKey(spec);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let job = jobs.get(key);
  if (!job) {
    job = queue.then(() => render(spec)).then((url) => {
      cache.set(key, url);
      if (cache.size > 120) cache.delete(cache.keys().next().value!);
      jobs.delete(key);
      return url;
    });
    job.catch(() => jobs.delete(key));
    queue = job.catch(() => undefined);
    jobs.set(key, job);
  }
  return job;
}
