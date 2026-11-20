import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ORBIT_LIMITS, orbitClock, orbitFromDrop, orbitPosition, type OrbitStyle } from '../lib/orbitPath';
import type { PlanetStyle } from '../lib/planet';
import { PlanetObject } from './planetMesh';

/**
 * A órbita da chamada em 3D: o host no centro (é dele que vem a luz), cada pessoa na sua
 * órbita. A câmera é de cada um (arrastar o fundo gira, a roda aproxima, dois cliques voltam).
 * Arrastar o PRÓPRIO planeta e soltar muda a sua órbita: onde soltou = distância e inclinação,
 * o empurrão = velocidade e sentido.
 */

export interface SceneMember {
  id: string;
  name: string;
  color: string;
  look: PlanetStyle;
  seed: number;
  photo?: string;
  /** null = o centro (host ou a sala). */
  orbit: OrbitStyle | null;
  host: boolean;
  me: boolean;
  speaking: boolean;
  live: boolean;
  video: MediaStream | null;
  mirror: boolean;
  /** Pode ser clicado (a sala vazia no centro não). */
  pickable: boolean;
}

export interface LabelPos {
  id: string;
  x: number;
  y: number;
  /** Atrás do centro (fica mais apagado). */
  behind: boolean;
  /** Tamanho do planeta na tela, em px. */
  size: number;
}

export interface SceneOptions {
  compact: boolean;
  /** Sem animação nem mouse: desenha só quando pedirem (modo imagem). */
  still: boolean;
  /** "Reduzir movimento": tudo parado, mas dá para girar a câmera e arrastar. */
  frozen: boolean;
  onPick(id: string): void;
  onOrbit(orbit: OrbitStyle): void;
  onLabels(labels: LabelPos[]): void;
}

interface Entry {
  member: SceneMember;
  lookKey: string;
  planet: PlanetObject;
  line: THREE.LineLoop | null;
  orbitKey: string;
  videoEl: HTMLVideoElement | null;
  /** Posição forçada (enquanto a pessoa arrasta). */
  drag: THREE.Vector3 | null;
}

const HOST_R = 1;
const SAT_R = 0.42;
const FOV = 38;
const ELEVATION = { main: 26, compact: 13 };
const CAMERA_KEY = 'orbita.camera.v1';

interface SavedCamera {
  azimuth: number;
  polar: number;
  zoom: number;
}

function loadCamera(variant: string): SavedCamera | null {
  try {
    const all = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? '{}') as Record<string, SavedCamera>;
    const c = all[variant];
    if (c && [c.azimuth, c.polar, c.zoom].every((v) => Number.isFinite(v))) return c;
  } catch {
    /* sem armazenamento */
  }
  return null;
}

function saveCamera(variant: string, value: SavedCamera | null) {
  try {
    const all = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? '{}') as Record<string, SavedCamera>;
    if (value) all[variant] = value;
    else delete all[variant];
    localStorage.setItem(CAMERA_KEY, JSON.stringify(all));
  } catch {
    /* sem armazenamento */
  }
}

const lookKeyOf = (m: SceneMember) => JSON.stringify([m.color, m.look, m.seed, m.photo?.length ?? 0, m.photo?.slice(-48) ?? '', m.host, m.orbit === null]);

export class OrbitScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400);
  private controls: OrbitControls;
  private fill: THREE.DirectionalLight;
  private entries = new Map<string, Entry>();
  private raf = 0;
  private last = performance.now();
  private frozenAt = orbitClock();
  private width = 1;
  private height = 1;
  private fitDistance = 12;
  private zoom = 1;
  private variant: 'main' | 'compact';
  private resetAnim: { from: THREE.Spherical; to: THREE.Spherical; start: number } | null = null;
  private press: { id: string | null; x: number; y: number; moved: boolean } | null = null;
  private dragging: { id: string; prev: OrbitStyle; samples: Array<{ p: THREE.Vector3; t: number }> } | null = null;
  private preview: THREE.LineLoop;
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private tmp: [number, number, number] = [0, 0, 0];

  constructor(
    private container: HTMLElement,
    private opts: SceneOptions,
  ) {
    this.variant = opts.compact ? 'compact' : 'main';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: opts.still });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'orbit3d__canvas';
    container.append(this.canvas);

    this.scene.add(new THREE.AmbientLight('#ffffff', 0.32));
    const sun = new THREE.PointLight('#fff4e0', 3.2, 0, 0);
    this.scene.add(sun);
    this.fill = new THREE.DirectionalLight('#c7d2fe', 0.55);
    this.scene.add(this.fill);
    this.scene.add(this.starfield());

    this.preview = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#a78bfa', transparent: true, opacity: 0.9 }));
    this.preview.visible = false;
    this.scene.add(this.preview);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = !opts.still;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.8;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI - 0.12;
    this.controls.enabled = !opts.still;
    this.controls.addEventListener('end', () => this.rememberCamera());
    this.controls.addEventListener('change', () => {
      if (opts.still) this.render();
    });

    const saved = loadCamera(this.variant);
    const elevation = (ELEVATION[this.variant] * Math.PI) / 180;
    const spherical = new THREE.Spherical(1, saved?.polar ?? Math.PI / 2 - elevation, saved?.azimuth ?? 0);
    this.zoom = saved?.zoom ?? 1;
    this.camera.position.setFromSpherical(spherical);

    if (!opts.still) {
      this.canvas.addEventListener('pointerdown', this.onDown, true);
      this.canvas.addEventListener('pointermove', this.onMove);
      this.canvas.addEventListener('pointerup', this.onUp);
      this.canvas.addEventListener('pointercancel', this.onUp);
      this.canvas.addEventListener('dblclick', this.onDouble);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    if (!opts.still) this.raf = requestAnimationFrame(this.frame);
  }

  // ───────────────────────── pessoas ─────────────────────────

  setMembers(list: SceneMember[]) {
    const seen = new Set<string>();
    for (const m of list) {
      seen.add(m.id);
      const key = lookKeyOf(m);
      let entry = this.entries.get(m.id);
      if (entry && entry.lookKey !== key) {
        this.removeEntry(entry);
        entry = undefined;
      }
      if (!entry) {
        const planet = new PlanetObject({ color: m.color, look: m.look, seed: m.seed, photo: m.photo, radius: m.orbit ? SAT_R : HOST_R, host: m.host, detail: m.orbit ? 512 : 768 });
        planet.body.userData.memberId = m.id;
        planet.hitArea.userData.memberId = m.id;
        this.scene.add(planet.group);
        entry = { member: m, lookKey: key, planet, line: null, orbitKey: '', videoEl: null, drag: null };
        this.entries.set(m.id, entry);
        if (this.opts.still) void planet.ready.then(() => this.render());
      }
      entry.member = m;
      entry.planet.setHalo(m.live ? 'live' : m.speaking ? 'speaking' : 'none');
      this.syncVideo(entry);
      this.syncLine(entry);
    }
    for (const entry of [...this.entries.values()]) if (!seen.has(entry.member.id)) this.removeEntry(entry);
    this.fit();
    if (this.opts.still) this.render();
  }

  /** Espera as texturas e desenha uma vez (modo imagem). */
  async renderWhenReady(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.planet.ready));
    // a câmera de vídeo precisa de um quadro
    await new Promise((r) => setTimeout(r, 60));
    if (!this.disposed) this.render();
  }

  /** Imagem PNG do que está desenhado agora. */
  snapshot(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  /** Onde está o centro de um planeta na tela (px, relativo à cena). */
  screenPosition(id: string): { x: number; y: number } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const v = entry.planet.group.position.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** Volta a câmera para o ângulo padrão. */
  resetCamera() {
    const from = new THREE.Spherical().setFromVector3(this.camera.position);
    const elevation = (ELEVATION[this.variant] * Math.PI) / 180;
    const to = new THREE.Spherical(this.fitDistance, Math.PI / 2 - elevation, 0);
    this.zoom = 1;
    saveCamera(this.variant, null);
    if (this.opts.still) {
      this.camera.position.setFromSpherical(to);
      this.camera.lookAt(0, 0, 0);
      this.render();
    } else {
      this.resetAnim = { from, to, start: performance.now() };
    }
  }

  private removeEntry(entry: Entry) {
    entry.planet.dispose();
    if (entry.line) {
      entry.line.geometry.dispose();
      (entry.line.material as THREE.Material).dispose();
      entry.line.removeFromParent();
    }
    if (entry.videoEl) entry.videoEl.srcObject = null;
    this.entries.delete(entry.member.id);
  }

  private syncVideo(entry: Entry) {
    const stream = entry.member.video;
    if (!stream || !stream.getVideoTracks().length) {
      if (entry.videoEl) {
        entry.videoEl.srcObject = null;
        entry.videoEl = null;
        entry.planet.setVideo(null);
      }
      return;
    }
    if (entry.videoEl?.srcObject === stream) return;
    const video = entry.videoEl ?? document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => {});
    entry.videoEl = video;
    entry.planet.setVideo(video, entry.member.mirror);
  }

  private orbitPoints(orbit: OrbitStyle): Float32Array {
    const n = 160;
    const pts = new Float32Array(n * 3);
    const o = { ...orbit, speed: 1, dir: 1 as const, phase: 0 };
    for (let i = 0; i < n; i++) {
      orbitPosition(o, (i / n) * Math.PI * 2, this.tmp);
      pts.set(this.tmp, i * 3);
    }
    return pts;
  }

  private syncLine(entry: Entry) {
    const orbit = entry.member.orbit;
    const key = orbit ? JSON.stringify([orbit.radius, orbit.incl, orbit.node]) + entry.member.me : '';
    if (key === entry.orbitKey) return;
    entry.orbitKey = key;
    if (entry.line) {
      entry.line.geometry.dispose();
      (entry.line.material as THREE.Material).dispose();
      entry.line.removeFromParent();
      entry.line = null;
    }
    if (!orbit) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.orbitPoints(orbit), 3));
    const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: entry.member.me ? '#c4b5fd' : '#94a0ff', transparent: true, opacity: entry.member.me ? 0.4 : 0.16, depthWrite: false }));
    this.scene.add(line);
    entry.line = line;
  }

  private starfield(): THREE.Points {
    const n = 700;
    const pts = new Float32Array(n * 3);
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < n; i++) {
      const u = rand() * 2 - 1;
      const t = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = 80 + rand() * 40;
      pts.set([s * Math.cos(t) * r, u * r, s * Math.sin(t) * r], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: '#c7d2fe', size: 0.35, transparent: true, opacity: 0.55, depthWrite: false }));
  }

  // ───────────────────────── câmera ─────────────────────────

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fit();
    if (this.opts.still) this.render();
  }

  /** Distância da câmera para caber todo mundo (a "zoom" do usuário multiplica). */
  private fit() {
    let maxR = 2.6;
    for (const e of this.entries.values()) if (e.member.orbit) maxR = Math.max(maxR, e.member.orbit.radius);
    const bound = maxR + SAT_R * 2.2;
    const vHalf = ((FOV / 2) * Math.PI) / 180;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const elevation = (ELEVATION[this.variant] * Math.PI) / 180;
    const vertical = bound * Math.sin(elevation) + HOST_R * 1.9;
    const dist = Math.max(vertical / Math.tan(vHalf), bound / Math.tan(hHalf), HOST_R * 4);
    this.fitDistance = dist;
    this.controls.minDistance = dist * 0.3;
    this.controls.maxDistance = dist * 3;
    const s = new THREE.Spherical().setFromVector3(this.camera.position);
    s.radius = dist * this.zoom;
    this.camera.position.setFromSpherical(s);
    this.camera.lookAt(0, 0, 0);
  }

  private rememberCamera() {
    const s = new THREE.Spherical().setFromVector3(this.camera.position);
    this.zoom = s.radius / this.fitDistance;
    saveCamera(this.variant, { azimuth: s.theta, polar: s.phi, zoom: this.zoom });
  }

  // ───────────────────────── mouse ─────────────────────────

  private pointer(e: PointerEvent | MouseEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private pick(e: PointerEvent | MouseEvent): Entry | null {
    this.raycaster.setFromCamera(this.pointer(e), this.camera);
    const targets: THREE.Object3D[] = [];
    for (const entry of this.entries.values()) if (entry.member.pickable) targets.push(entry.planet.body, entry.planet.hitArea);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    const id = hit?.object.userData.memberId as string | undefined;
    return id ? (this.entries.get(id) ?? null) : null;
  }

  /** Onde o mouse está num plano de frente para a câmera, passando pelo centro. */
  private planePoint(e: PointerEvent): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.pointer(e), this.camera);
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane(normal, 0);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const entry = this.pick(e);
    this.press = { id: entry?.member.id ?? null, x: e.clientX, y: e.clientY, moved: false };
    if (entry?.member.me && entry.member.orbit) {
      // segurou o próprio planeta: a câmera fica parada enquanto arrasta
      this.controls.enabled = false;
      this.dragging = { id: entry.member.id, prev: entry.member.orbit, samples: [] };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    }
  };

  private onMove = (e: PointerEvent) => {
    const press = this.press;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) press.moved = true;
    const drag = this.dragging;
    if (drag) {
      const p = this.planePoint(e);
      const entry = this.entries.get(drag.id);
      if (!p || !entry) return;
      const len = p.length();
      if (len > ORBIT_LIMITS.radiusMax) p.multiplyScalar(ORBIT_LIMITS.radiusMax / len);
      if (len < ORBIT_LIMITS.radiusMin) p.multiplyScalar(ORBIT_LIMITS.radiusMin / Math.max(len, 0.001));
      entry.drag = p;
      const now = performance.now();
      drag.samples.push({ p: p.clone(), t: now });
      while (drag.samples.length > 2 && now - drag.samples[0].t > 120) drag.samples.shift();
      const shape = orbitFromDrop([p.x, p.y, p.z], [0, 0, 0], drag.prev, orbitClock());
      this.preview.geometry.setAttribute('position', new THREE.BufferAttribute(this.orbitPoints(shape), 3));
      this.preview.visible = true;
      return;
    }
    if (!press) {
      const hover = this.pick(e);
      this.canvas.style.cursor = hover ? (hover.member.me && hover.member.orbit ? 'grab' : 'pointer') : '';
    }
  };

  private onUp = (e: PointerEvent) => {
    const press = this.press;
    const drag = this.dragging;
    this.press = null;
    this.dragging = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = '';
    this.preview.visible = false;
    if (drag) {
      const entry = this.entries.get(drag.id);
      if (entry?.drag && press?.moved) {
        const s = drag.samples;
        const first = s[0];
        const last = s[s.length - 1];
        const dt = last && first ? (last.t - first.t) / 1000 : 0;
        // parou antes de soltar (sem empurrão): sem mudar velocidade e sentido
        const still = !last || performance.now() - last.t > 90;
        const v: [number, number, number] =
          dt > 0.01 && !still ? [(last.p.x - first.p.x) / dt, (last.p.y - first.p.y) / dt, (last.p.z - first.p.z) / dt] : [0, 0, 0];
        const orbit = orbitFromDrop([entry.drag.x, entry.drag.y, entry.drag.z], v, drag.prev, orbitClock());
        entry.member = { ...entry.member, orbit };
        this.syncLine(entry);
        this.opts.onOrbit(orbit);
      }
      if (entry) entry.drag = null;
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* já solto */
      }
    }
    if (press && !press.moved && press.id && e.type === 'pointerup') this.opts.onPick(press.id);
  };

  private onDouble = (e: MouseEvent) => {
    if (this.pick(e)) return;
    this.resetCamera();
  };

  // ───────────────────────── desenho ─────────────────────────

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.resetAnim) {
      const k = Math.min(1, (now - this.resetAnim.start) / 450);
      const e = 1 - Math.pow(1 - k, 3);
      const { from, to } = this.resetAnim;
      let dTheta = to.theta - from.theta;
      dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
      const s = new THREE.Spherical(from.radius + (to.radius - from.radius) * e, from.phi + (to.phi - from.phi) * e, from.theta + dTheta * e);
      this.camera.position.setFromSpherical(s);
      this.camera.lookAt(0, 0, 0);
      if (k >= 1) this.resetAnim = null;
    } else {
      this.controls.update();
    }
    this.render(dt);
  };

  private render(dt = 0) {
    if (this.disposed) return;
    const t = this.opts.still || this.opts.frozen ? this.frozenAt : orbitClock();
    const seconds = performance.now() / 1000;
    for (const entry of this.entries.values()) {
      const g = entry.planet.group;
      if (entry.drag) g.position.copy(entry.drag);
      else if (entry.member.orbit) {
        orbitPosition(entry.member.orbit, t, this.tmp);
        g.position.set(this.tmp[0], this.tmp[1], this.tmp[2]);
      } else g.position.set(0, 0, 0);
      entry.planet.update(dt, seconds, this.opts.still || this.opts.frozen);
    }
    this.fill.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.emitLabels();
  }

  private emitLabels() {
    const labels: LabelPos[] = [];
    const v = new THREE.Vector3();
    const camDist = this.camera.position.length();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const pxPerUnit = (dist: number) => this.height / (2 * Math.tan(((FOV / 2) * Math.PI) / 180) * dist);
    for (const entry of this.entries.values()) {
      const r = entry.planet.spec.radius;
      const pos = entry.planet.group.position;
      const dist = pos.distanceTo(this.camera.position);
      v.copy(pos).addScaledVector(up, -r * 1.12).project(this.camera);
      labels.push({
        id: entry.member.id,
        x: ((v.x + 1) / 2) * this.width,
        y: ((1 - v.y) / 2) * this.height,
        behind: entry.member.orbit ? dist > camDist + 0.3 : false,
        size: 2 * r * pxPerUnit(dist),
      });
    }
    this.opts.onLabels(labels);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.onDown, true);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('dblclick', this.onDouble);
    for (const entry of [...this.entries.values()]) this.removeEntry(entry);
    this.preview.geometry.dispose();
    this.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = (m as { material?: THREE.Material }).material;
      mat?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
