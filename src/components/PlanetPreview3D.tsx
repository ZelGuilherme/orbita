import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PlanetStyle } from '../lib/planet';
import { textureSeed } from '../lib/noise';
import { PlanetObject } from '../three/planetMesh';

/** Prévia do meu planeta em 3D no editor: gira sozinha e dá para virar com o mouse. */
export default function PlanetPreview3D({ color, look, photo, seedId, size = 190 }: { color: string; look: PlanetStyle; photo?: string; seedId: string; size?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const world = useRef<{ scene: THREE.Scene; planet: PlanetObject | null; dispose(): void } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.className = 'planet-preview3d__canvas';
    el.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight('#ffffff', 0.5));
    const key = new THREE.DirectionalLight('#fff4e0', 2.4);
    key.position.set(-3, 2.2, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#a5b4fc', 0.8);
    rim.position.set(4, -1, -3);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 1.6, 8.4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableDamping = true;
    controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotateSpeed = 1.2;
    let raf = 0;
    let last = performance.now();
    const state = {
      scene,
      planet: null as PlanetObject | null,
      dispose: () => {
        cancelAnimationFrame(raf);
        controls.dispose();
        state.planet?.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      },
    };
    world.current = state;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      controls.update();
      state.planet?.update(dt, now / 1000);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      state.dispose();
      world.current = null;
    };
  }, [size]);

  const key = JSON.stringify([color, look, photo?.length ?? 0, photo?.slice(-40), seedId]);
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    // troca o planeta só depois que o novo estiver pronto (sem piscar)
    const next = new PlanetObject({ color, look, seed: textureSeed(seedId), photo, radius: 1, detail: 512 });
    let cancelled = false;
    void next.ready.then(() => {
      if (cancelled || world.current !== w) {
        next.dispose();
        return;
      }
      if (w.planet) next.body.rotation.y = w.planet.body.rotation.y;
      w.planet?.dispose();
      w.planet = next;
      w.scene.add(next.group);
    });
    return () => {
      cancelled = true;
    };
  }, [key, size]);

  return <div className="planet-preview3d" ref={box} style={{ width: size, height: size }} title="Arraste para virar o planeta" />;
}
