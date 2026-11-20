import * as THREE from 'three';
import type { Ornament, PlanetStyle } from '../lib/planet';
import { planetTextures, videoTexture, type PlanetTextures } from './textures';

/**
 * Um planeta em 3D: superfície com textura (e foto embrulhada), nuvens, atmosfera (brilho),
 * anéis com faixas, luas, enfeites (estrela, cometa, satélite, nave), o halo de quem fala ou
 * está ao vivo e a coroa do host.
 */

export interface PlanetSpec {
  color: string;
  look: PlanetStyle;
  seed: number;
  photo?: string;
  /** Raio na cena. */
  radius: number;
  host?: boolean;
  /** Resolução da textura (largura). */
  detail?: number;
}

const MOON_SCALE = { 1: 0.7, 2: 1, 3: 1.45 } as const;
const MOON_SPEED = { 1: 0.45, 2: 0.8, 3: 1.6 } as const;
const RING_WIDTH = { 1: 0.16, 2: 0.3, 3: 0.48 } as const;

/** Texturas pequenas desenhadas em canvas (halo, coroa, estrela). */
const spriteCache = new Map<string, THREE.Texture>();
function spriteTexture(kind: 'halo' | 'crown' | 'star' | 'flame'): THREE.Texture {
  const hit = spriteCache.get(kind);
  if (hit) return hit;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  const c = size / 2;
  if (kind === 'halo') {
    const grad = g.createRadialGradient(c, c, c * 0.62, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.18, 'rgba(255,255,255,1)');
    grad.addColorStop(0.32, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  } else if (kind === 'crown') {
    g.fillStyle = '#fbbf24';
    g.strokeStyle = '#92400e';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(14, 46);
    g.lineTo(38, 70);
    g.lineTo(64, 24);
    g.lineTo(90, 70);
    g.lineTo(114, 46);
    g.lineTo(102, 108);
    g.lineTo(26, 108);
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = '#fde68a';
    for (const [x, y] of [[14, 46], [64, 24], [114, 46]]) {
      g.beginPath();
      g.arc(x, y, 8, 0, Math.PI * 2);
      g.fill();
    }
  } else if (kind === 'star') {
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,240,1)');
    grad.addColorStop(0.15, 'rgba(253,230,138,0.9)');
    grad.addColorStop(0.4, 'rgba(251,191,36,0.25)');
    grad.addColorStop(1, 'rgba(251,191,36,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.strokeStyle = 'rgba(255,250,220,0.85)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(c, 6);
    g.lineTo(c, size - 6);
    g.moveTo(6, c);
    g.lineTo(size - 6, c);
    g.stroke();
  } else {
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,240,200,1)');
    grad.addColorStop(0.3, 'rgba(251,146,60,0.8)');
    grad.addColorStop(1, 'rgba(244,63,94,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  spriteCache.set(kind, t);
  return t;
}

/** Atmosfera: borda que brilha (fresnel), somada à cena. */
function atmosphereMaterial(color: string, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { glowColor: { value: new THREE.Color(color) }, strength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 glowColor;
      uniform float strength;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float rim = 1.0 - abs(dot(vNormal, vView));
        float a = pow(rim, 2.6) * strength;
        gl_FragColor = vec4(glowColor * a, a);
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/** Anel com faixas: o desenho sai da distância ao centro (não precisa de textura). */
function ringMaterial(color: string, bands: boolean, inner: number, outer: number, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ringColor: { value: new THREE.Color(color) },
      inner: { value: inner },
      outer: { value: outer },
      bands: { value: bands ? 1 : 0 },
      seed: { value: (seed % 1000) / 1000 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 ringColor;
      uniform float inner;
      uniform float outer;
      uniform float bands;
      uniform float seed;
      varying vec3 vPos;
      float hash(float x) { return fract(sin(x * 127.1 + seed * 311.7) * 43758.5453); }
      void main() {
        float r = (length(vPos.xy) - inner) / (outer - inner);
        if (r < 0.0 || r > 1.0) discard;
        float edge = smoothstep(0.0, 0.08, r) * smoothstep(1.0, 0.86, r);
        // anéis finos de densidade aleatória (como poeira e gelo)
        float ringlet = 0.55 + 0.45 * hash(floor(r * 46.0));
        float density = edge * mix(0.75, ringlet, 0.6);
        if (bands > 0.5) {
          // faixas largas com divisões escuras (como Saturno)
          float gaps = smoothstep(0.035, 0.0, abs(r - 0.4)) + smoothstep(0.02, 0.0, abs(r - 0.72));
          float zone = mix(0.55, 1.0, step(0.5, fract(r * 3.0 + 0.2)));
          density *= zone * (1.0 - 0.9 * gaps);
        }
        vec3 col = ringColor * (0.8 + 0.3 * hash(floor(r * 13.0)));
        gl_FragColor = vec4(col, density * 0.62);
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
}

function ornamentObject(kind: Ornament, r: number): THREE.Object3D {
  switch (kind) {
    case 'star': {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture('star'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.scale.setScalar(r * 0.9);
      return s;
    }
    case 'comet': {
      const group = new THREE.Group();
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(r * 0.12, 1), new THREE.MeshStandardMaterial({ color: '#e0f2fe', emissive: '#7dd3fc', emissiveIntensity: 0.6, roughness: 0.8 }));
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.1, r * 1.1, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      // a cauda fica para trás do movimento (a órbita gira no sentido -z local)
      tail.rotation.x = -Math.PI / 2;
      tail.position.z = r * 0.55;
      group.add(head, tail);
      return group;
    }
    case 'satellite': {
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(r * 0.14, r * 0.14, r * 0.22), new THREE.MeshStandardMaterial({ color: '#e5e7eb', metalness: 0.6, roughness: 0.35 }));
      const panelMat = new THREE.MeshStandardMaterial({ color: '#2563eb', emissive: '#1e3a8a', emissiveIntensity: 0.3, metalness: 0.3, roughness: 0.4 });
      for (const side of [-1, 1]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(r * 0.3, r * 0.01, r * 0.14), panelMat);
        panel.position.x = side * r * 0.23;
        group.add(panel);
      }
      group.add(body);
      return group;
    }
    case 'ship': {
      const group = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.ConeGeometry(r * 0.08, r * 0.32, 12), new THREE.MeshStandardMaterial({ color: '#f1f5f9', metalness: 0.4, roughness: 0.4 }));
      hull.rotation.x = -Math.PI / 2;
      const finMat = new THREE.MeshStandardMaterial({ color: '#f43f5e', roughness: 0.5 });
      for (const side of [-1, 1]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(r * 0.1, r * 0.01, r * 0.08), finMat);
        fin.position.set(side * r * 0.07, 0, r * 0.1);
        group.add(fin);
      }
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture('flame'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      flame.scale.setScalar(r * 0.22);
      flame.position.z = r * 0.2;
      group.add(hull, flame);
      return group;
    }
  }
}

interface Orbiter {
  pivot: THREE.Object3D;
  speed: number;
}

export class PlanetObject {
  readonly group = new THREE.Group();
  /** A esfera da superfície (é nela que o mouse "acerta"). */
  readonly body: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  /** Esfera invisível um pouco maior: planetas pequenos ficam fáceis de pegar. */
  readonly hitArea: THREE.Mesh;
  private clouds: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null = null;
  private orbiters: Orbiter[] = [];
  private halo: THREE.Sprite;
  private crown: THREE.Sprite | null = null;
  private textures: PlanetTextures | null = null;
  private video: THREE.VideoTexture | null = null;
  private disposed = false;
  private haloState: 'none' | 'speaking' | 'live' = 'none';
  readonly ready: Promise<void>;

  constructor(readonly spec: PlanetSpec) {
    const r = spec.radius;
    const look = spec.look;
    this.body = new THREE.Mesh(
      new THREE.SphereGeometry(r, 64, 48),
      new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.92, metalness: 0 }),
    );
    this.group.add(this.body);
    this.hitArea = new THREE.Mesh(new THREE.SphereGeometry(r * 1.5, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    this.group.add(this.hitArea);

    if (look.glow || look.texture === 'continents' || look.texture === 'clouds') {
      const atmo = new THREE.Mesh(new THREE.SphereGeometry(r * (look.glow ? 1.22 : 1.08), 48, 32), atmosphereMaterial(look.glow ? look.glowColor : '#9fd3ff', look.glow ? 1.6 : 0.7));
      this.group.add(atmo);
    }

    // anéis: o de dentro e, com dois, um mais largo por fora
    if (look.rings > 0) {
      const ringGroup = new THREE.Group();
      ringGroup.rotation.set(-Math.PI / 2 + 0.16, 0, (look.ringTilt * Math.PI) / 180);
      const width = RING_WIDTH[look.ringWidth] * r;
      const specs: Array<[number, number]> = [[r * 1.3, r * 1.3 + width]];
      if (look.rings > 1) specs.push([r * 1.38 + width, r * 1.38 + width * 1.75]);
      specs.forEach(([inner, outer], k) => {
        const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 128, 1), ringMaterial(look.ringColor, look.ringBands, inner, outer, spec.seed + k * 17));
        ring.renderOrder = 2;
        ringGroup.add(ring);
      });
      this.group.add(ringGroup);
    }

    // luas: cada uma numa órbita inclinada diferente
    for (let i = 0; i < look.moons; i++) {
      const pivot = new THREE.Object3D();
      pivot.rotation.set(0.25 * (i - 1), (i * Math.PI * 2) / 3, 0.18 * i);
      const moonR = r * (0.16 - i * 0.03) * MOON_SCALE[look.moonSize];
      const moon = new THREE.Mesh(new THREE.SphereGeometry(moonR, 24, 16), new THREE.MeshStandardMaterial({ color: look.moonColor, roughness: 1 }));
      moon.position.x = r * (1.75 + i * 0.42);
      pivot.add(moon);
      this.group.add(pivot);
      this.orbiters.push({ pivot, speed: MOON_SPEED[look.moonSpeed] * (i % 2 ? -1 : 1) * (1 - i * 0.18) });
    }

    // enfeites, cada um no seu caminho
    look.ornaments.forEach((kind, i) => {
      const pivot = new THREE.Object3D();
      pivot.rotation.set(0.5 - i * 0.35, i * 1.7, -0.3 + i * 0.25);
      const obj = ornamentObject(kind, r);
      obj.position.x = r * (2.1 + i * 0.28);
      pivot.add(obj);
      this.group.add(pivot);
      this.orbiters.push({ pivot, speed: 0.55 - i * 0.1 });
    });

    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture('halo'), color: '#34d399', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo.scale.setScalar(r * 3);
    this.halo.visible = false;
    this.group.add(this.halo);

    if (spec.host) {
      this.crown = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTexture('crown'), transparent: true, depthWrite: false }));
      this.crown.scale.setScalar(r * 0.75);
      this.crown.position.y = r * 1.45;
      this.group.add(this.crown);
    }

    this.ready = this.loadTextures();
  }

  private async loadTextures() {
    const spec = this.spec;
    let tex: PlanetTextures;
    try {
      tex = await planetTextures(spec.look, spec.color, spec.seed, spec.photo, spec.detail);
    } catch (err) {
      console.warn('[3d] textura', err);
      return;
    }
    if (this.disposed) {
      tex.dispose();
      return;
    }
    this.textures = tex;
    const m = this.body.material;
    m.color.set('#ffffff');
    if (!this.video) m.map = tex.map;
    m.bumpMap = tex.bumpMap;
    m.bumpScale = 2.2;
    if (tex.emissiveMap) {
      m.emissiveMap = tex.emissiveMap;
      m.emissive.set('#ffffff');
      m.emissiveIntensity = 1.4;
    } else if (spec.host) {
      // o host é o "sol": brilha um pouco sozinho
      m.emissiveMap = tex.map;
      m.emissive.set('#ffffff');
      m.emissiveIntensity = 0.35;
    }
    m.needsUpdate = true;
    if (tex.clouds) {
      this.clouds = new THREE.Mesh(
        new THREE.SphereGeometry(spec.radius * 1.015, 64, 48),
        new THREE.MeshStandardMaterial({ map: tex.clouds, transparent: true, depthWrite: false, roughness: 1 }),
      );
      this.group.add(this.clouds);
    }
  }

  /** Câmera ligada: o vídeo vira a superfície (sem textura por cima, para não cobrir o rosto). */
  setVideo(video: HTMLVideoElement | null, mirror = false) {
    const m = this.body.material;
    if (!video) {
      if (!this.video) return;
      this.video.dispose();
      this.video = null;
      m.map = this.textures?.map ?? null;
      if (!this.textures) m.color.set(this.spec.color);
      if (this.clouds) this.clouds.visible = true;
      m.needsUpdate = true;
      return;
    }
    if (this.video?.image === video) return;
    this.video?.dispose();
    this.video = videoTexture(video, mirror);
    m.map = this.video;
    m.color.set('#ffffff');
    if (this.clouds) this.clouds.visible = false;
    m.needsUpdate = true;
  }

  setHalo(state: 'none' | 'speaking' | 'live') {
    if (state === this.haloState) return;
    this.haloState = state;
    this.halo.visible = state !== 'none';
    this.halo.material.color.set(state === 'live' ? '#f43f5e' : '#34d399');
  }

  /** Avança as animações (giro, nuvens, luas, enfeites e o pulso do halo). */
  update(dt: number, t: number, still = false) {
    if (!still) {
      this.body.rotation.y += dt * 0.12;
      if (this.clouds) this.clouds.rotation.y += dt * 0.16;
      for (const o of this.orbiters) o.pivot.rotation.y += dt * o.speed;
    }
    if (this.halo.visible) {
      const pulse = this.haloState === 'speaking' ? 1 + Math.sin(t * 9) * 0.05 : 1 + Math.sin(t * 3) * 0.04;
      this.halo.scale.setScalar(this.spec.radius * 3 * pulse);
    }
  }

  dispose() {
    this.disposed = true;
    this.textures?.dispose();
    this.video?.dispose();
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.group.removeFromParent();
  }
}
