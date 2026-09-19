// Three.js scene: a stateless GPU particle field that orbits the hands, glowing hand skeletons,
// a wireframe "core" per hand that reacts to openness / roll / audio, ripples on notes and kicks,
// an optional camera backdrop, and bloom. Includes a one-way adaptive quality governor.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const COLORS = { lead: new THREE.Color(0x35e8ff), rhythm: new THREE.Color(0xff2fd6), beat: new THREE.Color(0xffc857) };

const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const QUALITY = [
  { name: 'high', particles: 60000, pixelRatio: 2, bloom: true },
  { name: 'medium', particles: 30000, pixelRatio: 1.5, bloom: true },
  { name: 'low', particles: 12000, pixelRatio: 1, bloom: false },
];

const PARTICLE_VERT = /* glsl */ `
  uniform float uTime, uBass, uMid, uHue, uPx;
  uniform vec4 uHand[2];      // xy = world position, z = strength 0..1, w = orbit radius
  uniform vec3 uTint[2];
  attribute vec4 aSeed;
  varying vec3 vColor;
  varying float vAlpha;

  vec3 hsv(float h, float s, float v) {
    vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), k, s);
  }

  void main() {
    vec3 p = position;
    float t = uTime * 0.18 + aSeed.w * 6.2831;
    p.x += sin(t + p.y * 0.55) * 0.7;
    p.y += cos(t * 1.3 + p.x * 0.45) * 0.7;
    p.z += sin(t * 0.7 + p.x * 0.3) * 0.9;
    p.xy *= 1.0 + uBass * 0.10 * (0.4 + aSeed.x);

    float glow = 0.0;
    vec3 tint = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      vec4 h = uHand[i];
      float r = length(h.xy - p.xy);
      float pull = h.z * exp(-r * r * 0.045);
      float dir = aSeed.z > 0.5 ? 1.0 : -1.0;
      float ang = uTime * (0.7 + aSeed.y * 1.8) * dir + aSeed.w * 6.2831;
      float rad = h.w * (0.55 + aSeed.x * 1.5) * (1.0 + uBass * 0.5);
      vec2 ring = h.xy + vec2(cos(ang), sin(ang)) * rad;
      float k = clamp(pull * 0.9, 0.0, 0.96);
      p.xy = mix(p.xy, ring, k);
      p.z = mix(p.z, sin(ang * 2.0 + aSeed.x * 6.0) * h.w * 0.45, clamp(pull * 0.7, 0.0, 1.0));
      glow += pull;
      tint += uTint[i] * pull;
    }

    float hue = fract(uHue + 0.55 + aSeed.x * 0.18 + p.x * 0.012);
    vec3 base = hsv(hue, 0.75, 0.9);
    float tw = clamp(length(tint), 0.0, 1.0);
    vColor = mix(base, normalize(tint + 1e-4), tw * 0.85) * (0.32 + glow * 0.35 + uMid * 0.35);
    vAlpha = clamp(0.30 + glow * 0.30 + uMid * 0.2, 0.0, 0.7);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uPx * (0.5 + aSeed.x * 1.0 + glow * 0.8 + uMid * 1.0) / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a * a * vAlpha);
  }
`;

export class Visuals {
  constructor(container) {
    this.container = container;
    this.clock = 0;
    this.hue = 0;
    this.bloomBoost = 1;
    this.qualityIndex = 0;
    this.locked = false; // user pinned the quality → no auto downgrade
    this._slow = 0;
    this._frames = 0;

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' }));
    renderer.setClearColor(0x04050a, 1);
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.z = 10;
    this.H = 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.W = this.H;

    this._buildBackdrop();
    this._buildParticles();
    this.hands = { lead: this._buildHand(COLORS.lead), rhythm: this._buildHand(COLORS.rhythm) };
    this._buildRipples();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.25);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.applyQuality(0);
  }

  // ───────────────────────────── construction ─────────────────────────────
  _buildBackdrop() {
    this.backdropMat = new THREE.MeshBasicMaterial({ color: 0x9aa4c0, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backdropMat);
    this.backdrop.position.z = -8;
    this.backdrop.visible = false;
    this.backdrop.renderOrder = -1;
    this.scene.add(this.backdrop);
  }

  setBackdrop(video, on) {
    if (on && video && !this.videoTex) {
      this.videoTex = new THREE.VideoTexture(video);
      this.videoTex.colorSpace = THREE.SRGBColorSpace;
    }
    this.backdropMat.map = this.videoTex ?? null;
    this.backdropMat.needsUpdate = true;
    this.backdrop.visible = !!(on && this.videoTex);
    this.videoAspect = video && video.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9;
    this._fitBackdrop();
  }

  _fitBackdrop() {
    // "contain" fit at z=-8 (same mapping main.js uses for landmarks), mirrored like a selfie view
    const dist = this.camera.position.z - this.backdrop.position.z;
    const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const w = h * this.camera.aspect;
    const va = this.videoAspect || 16 / 9;
    const [cw, ch] = va > this.camera.aspect ? [w, w / va] : [h * va, h];
    this.backdrop.scale.set(-cw, ch, 1);
  }

  _buildParticles() {
    const MAX = QUALITY[0].particles;
    const pos = new Float32Array(MAX * 3);
    const seed = new Float32Array(MAX * 4);
    for (let i = 0; i < MAX; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 22;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 13;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 9;
      for (let k = 0; k < 4; k++) seed[i * 4 + k] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.uniforms = {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uHue: { value: 0 },
      uPx: { value: 400 },
      uHand: { value: [new THREE.Vector4(0, 0, 0, 1.5), new THREE.Vector4(0, 0, 0, 1.5)] },
      uTint: { value: [COLORS.lead.clone(), COLORS.rhythm.clone()] },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(g, m);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  _buildHand(color) {
    const group = new THREE.Group();
    group.visible = false;

    const linePos = new Float32Array(HAND_EDGES.length * 2 * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(1.8), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    lines.frustumCulled = false;

    const ptPos = new Float32Array(21 * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ color, size: 0.13, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.frustumCulled = false;

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const inner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.45, 0),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    core.add(inner);

    const pinchRing = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.05, 8, 40),
      new THREE.MeshBasicMaterial({ color: COLORS.beat, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );

    group.add(lines, pts, core, pinchRing);
    this.scene.add(group);
    return { group, lines, linePos, pts, ptPos, core, inner, pinchRing, color, energy: 0, world: new THREE.Vector3(), radius: 1.2 };
  }

  _buildRipples() {
    this.ripples = [];
    const geo = new THREE.RingGeometry(0.92, 1, 64);
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false;
      this.scene.add(m);
      this.ripples.push({ mesh: m, age: 1, life: 1, size: 1, active: false });
    }
  }

  // ───────────────────────────── public API ─────────────────────────────
  toWorld(x, y) {
    return [(x - 0.5) * this.W, (0.5 - y) * this.H];
  }

  ripple(x, y, color, size = 3, life = 1.1) {
    const r = this.ripples.find((q) => !q.active) ?? this.ripples[0];
    const [wx, wy] = this.toWorld(x, y);
    r.mesh.position.set(wx, wy, 0.2);
    r.mesh.material.color.copy(color);
    r.age = 0;
    r.life = life;
    r.size = size;
    r.active = true;
    r.mesh.visible = true;
  }

  rippleAt(role, size, life) {
    const h = this.hands[role];
    if (!h.group.visible) return;
    const x = h.world.x / this.W + 0.5;
    const y = 0.5 - h.world.y / this.H;
    this.ripple(x, y, role === 'beat' ? COLORS.beat : h.color, size, life);
  }

  beatPulse(strength = 1) {
    this.pulse = Math.max(this.pulse ?? 0, strength);
  }

  setHue(v) {
    this.hue = v;
  }

  setBloomBoost(v) {
    this.bloomBoost = v;
  }

  setBloomEnabled(on) {
    this.bloomEnabled = on;
  }

  /**
   * @param frame {dt, hands:{lead?:{lm, f}, rhythm?:{lm, f}}, weights:{lead,rhythm}, audio:{bass,mid,high,level}}
   *   lm are display-space landmarks (x already mirrored)
   */
  update(dt, frame) {
    this.clock += dt;
    this._adapt(dt);
    const { audio } = frame;
    this.pulse = (this.pulse ?? 0) * Math.exp(-dt * 7);

    const U = this.uniforms;
    U.uTime.value = this.clock;
    U.uBass.value = Math.min(1, audio.bass * 1.6 + this.pulse * 0.6);
    U.uMid.value = audio.mid;
    U.uHue.value = this.hue;

    ['lead', 'rhythm'].forEach((role, i) => {
      const h = this.hands[role];
      const src = frame.hands[role];
      const w = frame.weights[role];
      h.group.visible = w > 0.02 && !!src;
      const hv = U.uHand.value[i];
      if (src) {
        this._writeHand(h, src, dt);
        hv.set(h.world.x, h.world.y, w, h.radius);
      } else {
        hv.z = 0;
      }
      h.energy *= Math.exp(-dt * 5);
      h.group.traverse((o) => {
        if (o.material) o.material.opacity = (o.material.userData.base ??= o.material.opacity) * Math.min(1, w * 1.5);
      });
    });

    for (const r of this.ripples) {
      if (!r.active) continue;
      r.age += dt / r.life;
      if (r.age >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - r.age, 3);
      r.mesh.scale.setScalar(0.3 + e * r.size);
      r.mesh.material.opacity = (1 - r.age) * 0.7;
    }

    if (this.backdrop.visible && this.videoTex) this.videoTex.needsUpdate = true;

    const q = QUALITY[this.qualityIndex];
    this.bloom.enabled = q.bloom && this.bloomEnabled !== false;
    this.bloom.strength = (0.5 + audio.bass * 0.5 + this.pulse * 0.35) * this.bloomBoost;
    this.composer.render();
  }

  _writeHand(h, { lm, f }, dt) {
    const W = this.W;
    const H = this.H;
    for (let i = 0; i < 21; i++) {
      const x = (lm[i].x - 0.5) * W;
      const y = (0.5 - lm[i].y) * H;
      const z = -lm[i].z * W * 0.9;
      h.ptPos[i * 3] = x;
      h.ptPos[i * 3 + 1] = y;
      h.ptPos[i * 3 + 2] = z;
    }
    HAND_EDGES.forEach(([a, b], e) => {
      for (let k = 0; k < 3; k++) {
        h.linePos[e * 6 + k] = h.ptPos[a * 3 + k];
        h.linePos[e * 6 + 3 + k] = h.ptPos[b * 3 + k];
      }
    });
    h.lines.geometry.attributes.position.needsUpdate = true;
    h.pts.geometry.attributes.position.needsUpdate = true;

    const [px, py] = this.toWorld(f.x, f.y);
    h.world.set(px, py, 0);
    const handSizeWorld = f.size * this.H; // wrist→knuckle in world units
    h.radius = 0.5 + handSizeWorld * 0.9 + f.open * 0.5;
    const s = (0.55 + f.open * 0.45) * handSizeWorld * (1 + h.energy * 0.4);
    h.core.position.set(px, py, 0);
    h.core.scale.setScalar(Math.max(0.25, s));
    h.core.rotation.z = -f.roll * Math.PI * 0.5;
    h.core.rotation.x += dt * (0.6 + h.energy * 4);
    h.core.rotation.y += dt * (0.9 + h.energy * 3);
    h.inner.scale.setScalar(1 + h.energy * 0.8);

    // pinch ring sits between thumb tip and index tip and closes as you pinch
    const t = lm[4];
    const i8 = lm[8];
    h.pinchRing.position.set(((t.x + i8.x) / 2 - 0.5) * W, (0.5 - (t.y + i8.y) / 2) * H, 0.1);
    h.pinchRing.scale.setScalar(0.08 + (1 - f.pinch) * 0.32 + h.energy * 0.2);
    h.pinchRing.visible = f.pinch > 0.05 || h.energy > 0.05;
  }

  /** Flash a hand's core (note on for lead, kick for rhythm). */
  hit(role, amount = 1) {
    this.hands[role].energy = Math.min(1.5, this.hands[role].energy + amount);
  }

  // ───────────────────────────── size / quality ─────────────────────────────
  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.W = this.H * this.camera.aspect;
    this._applySize(w, h);
    this._fitBackdrop();
  }

  _applySize(w = this.container.clientWidth, h = this.container.clientHeight) {
    const pr = Math.min(window.devicePixelRatio || 1, QUALITY[this.qualityIndex].pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.uniforms.uPx.value = h * pr * 0.028; // px per world-unit-at-distance-1; a size-1 particle ≈ 2.8% of screen height / 10
  }

  applyQuality(i, lock = false) {
    this.qualityIndex = Math.max(0, Math.min(QUALITY.length - 1, i));
    if (lock) this.locked = true;
    this.particles.geometry.setDrawRange(0, QUALITY[this.qualityIndex].particles);
    this._applySize();
    this.onQuality?.(QUALITY[this.qualityIndex].name);
  }

  /** One-way governor: sustained slow frames → next quality tier. */
  _adapt(dt) {
    this._frames++;
    if (this.locked || this._frames < 30) return; // ignore warm-up (shader compile, etc.)
    this._slow = dt > 1 / 24 ? this._slow + 1 : Math.max(0, this._slow - 2);
    if (this._slow > 40 && this.qualityIndex < QUALITY.length - 1) {
      this._slow = 0;
      this.applyQuality(this.qualityIndex + 1);
    }
  }

  get qualityName() {
    return QUALITY[this.qualityIndex].name;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { COLORS, QUALITY };
