// The 3D view: builds a blueprint, moves parts apart, highlights the selection, frames the camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { featureBatches, geometryFor, materialFor, orientation } from './shapes.js';
import { stagesOf, stageProgress, explodeAfter, groupColor } from './teaching.js';

const UP = new THREE.Vector3(0, 1, 0);
const HIGHLIGHT = new THREE.Color(0.2, 0.8, 1);
const PULSE = new THREE.Color(0.35, 0.8, 1);
const PAPER = 0x060b12;
/** Towards each light, matching the Mac app's light angles. */
const KEY_DIRECTION = new THREE.Vector3(0.351, 0.783, 0.513);
const RIM_DIRECTION = new THREE.Vector3(0.285, -0.389, -0.876);

/**
 * The Mac app's daylight studio (Materials.studioEnvironment), drawn the same way: a bright paper room whose floor
 * bounces light back up, a slightly darker band at the horizon, three soft boxes, all softened so glossy paint
 * doesn't show hard edges.
 */
function studioEnvironment() {
  const w = 1024, h = 512;
  const sharp = document.createElement('canvas');
  sharp.width = w; sharp.height = h;
  const g = sharp.getContext('2d');
  // Canvas y runs downward, so the stops are the Mac's (measured up from the floor) turned over.
  const grad = g.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgb(204,199,189)');
  grad.addColorStop(0.42, 'rgb(168,166,158)');
  grad.addColorStop(0.56, 'rgb(204,201,194)');
  grad.addColorStop(1, 'rgb(250,247,242)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  for (const x of [120, 420, 760]) g.fillRect(x, h - 450, 120, 110);
  const soft = document.createElement('canvas');
  soft.width = w; soft.height = h;
  const sg = soft.getContext('2d');
  sg.filter = 'blur(14px)';
  sg.drawImage(sharp, 0, 0);
  const tex = new THREE.CanvasTexture(soft);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const SIGNAL = 0x45d9ff;

/** The HUD stage backdrop, matching the Mac app: a faint navy glow behind the object fading to near black. */
function stageBackdrop() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 240, 0, 256, 240, 380);
  grad.addColorStop(0, 'rgb(14,29,43)');
  grad.addColorStop(0.55, 'rgb(8,15,24)');
  grad.addColorStop(1, 'rgb(3,6,10)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const GHOST_OPACITY = 0.05;

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping; // keeps white shells white on the bright stage
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = stageBackdrop();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(studioEnvironment()).texture;
    this.scene.environmentIntensity = 1;

    // Same lights as the Mac app (SceneController): a key from above front-right and a dim fill from below behind.
    this.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.key.castShadow = true;
    // Finer shadows where there's power to spare; phones keep the lighter map.
    const size = matchMedia('(pointer: fine)').matches ? 4096 : 2048;
    this.key.shadow.mapSize.set(size, size);
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.key, this.key.target);
    // A cool blue rim from behind and a blue fill, so edges catch the HUD's light against the dark stage.
    const rim = new THREE.DirectionalLight(0x73c7ff, 1.15);
    rim.position.copy(RIM_DIRECTION).multiplyScalar(5);
    const fill = new THREE.DirectionalLight(0x5a9ef2, 0.5);
    fill.position.set(-0.8, 0.2, -0.5).multiplyScalar(5);
    this.scene.add(rim, fill);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.01, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    this.container3d = new THREE.Group();
    this.scene.add(this.container3d);
    this.stageGroup = new THREE.Group();
    this.scene.add(this.stageGroup);
    this.gridSpacing = 0.1;
    this.instances = [];
    this.explode = 0;
    this.showGuides = true;
    this.scale = 1;
    this.selectedId = null;
    this.isolatedGroup = null;
    this.spotlight = [];
    this.colorByGroup = false;
    this.movingStage = null;
    this.stages = [];
    this.onSelect = () => {};
    this.onHover = () => {};
    this.onAppearanceChange = () => {};
    this.onExplodeChange = () => {};

    this.#wirePointer();
    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ---------- Building ----------

  load(blueprint) {
    this.stop();
    this.#endScan();
    for (const inst of this.instances) {
      inst.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.container3d.clear();
    this.container3d.quaternion.identity();
    this.instances = [];
    this.selectedId = null;
    this.isolatedGroup = null;
    this.spotlight = [];
    this.movingStage = null;
    this.laidFlat = false;
    this.blueprint = blueprint;
    this.stages = stagesOf(blueprint);
    this.stageIndex = new Map(this.stages.map((st, i) => [st.step, i]));
    const groupNames = [...new Set(blueprint.parts.map((p) => p.group))];
    this.groupIndex = new Map(groupNames.map((g, i) => [g, i]));

    for (const part of blueprint.parts) {
      const count = Math.max(1, part.radialCount | 0);
      const geometry = geometryFor(part);
      geometry.computeBoundingBox();
      const batches = featureBatches(part);
      // The box also stands for the part's detail, so framing, sizes and guide lines see the whole part.
      for (const b of batches) {
        b.geometry.computeBoundingBox();
        geometry.boundingBox.union(b.geometry.boundingBox);
      }
      for (let k = 0; k < count; k++) {
        const spin = new THREE.Quaternion().setFromAxisAngle(UP, (k / count) * Math.PI * 2);
        const mesh = new THREE.Mesh(geometry, materialFor(part.material, part.color));
        if (Array.isArray(part.scale) && part.scale.length === 3) mesh.scale.set(...part.scale.map((v) => Math.max(v, 0.001)));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.partId = part.id;
        mesh.userData.group = part.group;
        for (const b of batches) {
          const detail = new THREE.Mesh(b.geometry, materialFor(b.material, b.color));
          detail.castShadow = detail.receiveShadow = true;
          detail.userData.partId = part.id;
          mesh.add(detail);
        }
        // radialOrigin (built-in examples): spin copies around their own centre and move them as one group.
        const pivot = Array.isArray(part.radialOrigin) ? new THREE.Vector3(...part.radialOrigin) : new THREE.Vector3();
        const base = new THREE.Vector3(...part.position).sub(pivot).applyQuaternion(spin).add(pivot);
        mesh.quaternion.copy(spin).multiply(orientation(part.rotation));
        mesh.position.copy(base);
        const offset = new THREE.Vector3(...part.explode);
        if (!part.radialOrigin) offset.applyQuaternion(spin);
        const localCenter = geometry.boundingBox.getCenter(new THREE.Vector3());
        this.container3d.add(mesh);
        this.instances.push({ id: part.id, mesh, base, offset, step: part.step | 0, localCenter, guide: !part.radialOrigin || k === 0 });
      }
    }

    this.guides = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.guides.raycast = () => {};
    this.container3d.add(this.guides);

    const size = this.#bounds(0).getSize(new THREE.Vector3());
    this.fixedRotation = Array.isArray(blueprint.displayRotation) && blueprint.displayRotation.length === 3 ? blueprint.displayRotation : null;
    this.isLong = !this.fixedRotation && size.y > 2.2 * Math.max(size.x, size.z);
    this.#applyOrientation();
    this.setExplode(0);
    this.#updateAppearance();
    this.fit();
    this.#placeShadowLight();
  }

  /** Long, thin objects (rockets, pens) lie across a wide screen but stand up on a tall one. */
  #applyOrientation() {
    if (this.fixedRotation) {
      if (this.laidFlat === 'fixed') return false;
      this.laidFlat = 'fixed';
      this.container3d.quaternion.copy(orientation(this.fixedRotation));
      this.container3d.updateMatrixWorld(true);
      return true;
    }
    const flat = this.isLong && this.camera.aspect >= 1;
    if (flat === this.laidFlat) return false;
    this.laidFlat = flat;
    if (flat) this.container3d.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
    else this.container3d.quaternion.identity();
    this.container3d.updateMatrixWorld(true);
    return true;
  }

  // ---------- Explode ----------

  #progress(step, t) {
    return stageProgress(this.stageIndex.get(step) ?? 0, this.stages.length, t);
  }

  /** How many stages have fully come off. */
  get stagesDone() {
    return this.stages.filter((_, i) => this.explode >= explodeAfter(i + 1, this.stages.length) - 0.001).length;
  }

  /** The stage to name under the slider: the one moving, or the last one that came off (null when assembled). */
  get currentStage() {
    if (this.explode <= 0.001 || !this.stages.length) return null;
    return Math.min(this.stages.length - 1, Math.ceil(this.explode * this.stages.length - 0.001) - 1);
  }

  /** Takes off (or puts back) exactly one stage, so you can study the object a layer at a time. */
  step(delta) {
    const n = this.stages.length, done = this.stagesDone;
    const atStop = Math.abs(this.explode - explodeAfter(done, n)) < 0.002;
    const target = Math.max(0, Math.min(n, delta < 0 && !atStop ? done : done + delta));
    if (this.zoomedToPart) { this.zoomedToPart = false; this.fit(true); }
    const to = explodeAfter(target, n);
    if (Math.abs(to - this.explode) <= 0.001) return;
    this.animateTo(to, Math.max(500, 1100 * Math.abs(to - this.explode) * n));
  }

  #positionAt(inst, t) {
    return inst.base.clone().addScaledVector(inst.offset, this.#progress(inst.step, t));
  }

  setExplode(t) {
    this.explode = t;
    for (const inst of this.instances) inst.mesh.position.copy(this.#positionAt(inst, t));
    this.#updateGuides();
    // While animating, light up the stage that's on the move.
    let moving = null;
    if (this.playing && this.stages.length) {
      const x = t * this.stages.length, i = Math.floor(x), frac = x - i;
      if (i < this.stages.length && frac > 0.02 && frac < 0.98) moving = i;
    }
    if (moving !== this.movingStage) { this.movingStage = moving; this.#updateAppearance(); }
    this.onExplodeChange(t);
  }

  setGuides(on) {
    this.showGuides = on;
    this.#updateGuides();
  }

  #updateGuides() {
    if (!this.guides) return;
    const verts = [];
    if (this.showGuides && this.explode > 0.01) {
      const emphasized = this.emphasized();
      for (const inst of this.instances) {
        if (!inst.guide || inst.offset.lengthSq() < 1e-6) continue;
        if (emphasized.size && !emphasized.has(inst.id)) continue;
        const moved = inst.mesh.position.clone().sub(inst.base);
        if (moved.length() < 0.05 * this.scale) continue;
        const now = inst.localCenter.clone().multiply(inst.mesh.scale).applyQuaternion(inst.mesh.quaternion).add(inst.mesh.position);
        const start = now.clone().sub(moved);
        verts.push(start.x, start.y, start.z, now.x, now.y, now.z);
      }
    }
    this.guides.geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.guides.geometry.computeBoundingSphere();
  }

  animateTo(target, duration) {
    this.stop();
    const from = this.explode;
    const t0 = performance.now();
    this.playing = { from, target, t0, duration: duration ?? 2800 * Math.abs(target - from) + 200 };
    this.onPlayChange?.(true);
  }

  /** The startup scan: a glowing plane with a bright rim sweeps up through the assembled object, then fades. */
  scan(duration = 1400, done = () => {}) {
    this.#endScan();
    const box = this.#bounds(this.explode);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const w = size.x * 1.25, d = size.z * 1.25;
    const group = new THREE.Group();
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: SIGNAL, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => new THREE.Vector3(x, 0, z));
    const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners),
      new THREE.LineBasicMaterial({ color: 0xbff3ff, transparent: true, opacity: 1, depthWrite: false }));
    group.add(sheet, rim);
    group.renderOrder = 10;
    for (const o of group.children) { o.raycast = () => {}; o.renderOrder = 10; }
    // Bounds are in the object's own frame, so the plane rides inside it (and turns with it on phones).
    this.container3d.add(group);
    this.scanning = { group, t0: performance.now(), duration, lo: box.min.y, height: size.y, center, done };
    this.onScan?.(0);
  }

  #endScan() {
    if (!this.scanning) return;
    const { group } = this.scanning;
    group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    group.removeFromParent();
    this.scanning = null;
  }

  togglePlay() {
    if (this.playing) { this.stop(); return; }
    if (this.zoomedToPart) { this.zoomedToPart = false; this.fit(true); }
    this.animateTo(this.explode > 0.5 ? 0 : 1);
  }

  stop() {
    this.playing = null;
    if (this.movingStage != null) { this.movingStage = null; this.#updateAppearance(); }
    this.onPlayChange?.(false);
  }

  // ---------- Selection ----------

  select(id) {
    this.selectedId = id;
    this.spotlight = [];
    this.#updateAppearance();
    this.onSelect(id);
  }

  /** Shows only this assembly (null for everything); the rest fades to a ghost so you see where it sits. */
  isolate(group) {
    this.isolatedGroup = group;
    this.spotlight = [];
    this.#updateAppearance();
  }

  /** Keeps several parts solid together (e.g. everything a hard problem lives in) while the rest ghosts. */
  setSpotlight(ids) {
    this.selectedId = null;
    this.isolatedGroup = null;
    this.spotlight = ids;
    this.#updateAppearance();
    this.onSelect(null);
  }

  /** Recolours every part by its assembly, so the object's subsystems show at a glance. */
  setColorByGroup(on) {
    this.colorByGroup = on;
    this.#updateAppearance();
  }

  /** The parts that stay solid while everything else ghosts; empty means every part is drawn normally. */
  emphasized() {
    const ids = new Set();
    if (this.isolatedGroup) for (const p of this.blueprint.parts) if (p.group === this.isolatedGroup) ids.add(p.id);
    if (this.selectedId) ids.add(this.selectedId);
    for (const id of this.spotlight) ids.add(id);
    return ids;
  }

  #updateAppearance() {
    const emphasized = this.emphasized();
    const moving = new Set(this.movingStage != null ? this.stages[this.movingStage].partIds : []);
    for (const inst of this.instances) {
      const on = inst.id === this.selectedId;
      const pulse = !on && moving.has(inst.id);
      const ghost = emphasized.size > 0 && !emphasized.has(inst.id);
      inst.mesh.traverse((o) => {
        const m = o.material, u = m.userData;
        u.baseColor ??= m.color.clone();
        u.base ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, side: m.side };
        const base = this.colorByGroup ? new THREE.Color(groupColor(this.groupIndex.get(inst.mesh.userData.group) ?? 0)) : u.baseColor;
        // Tint as well as glow when selected, so white and metallic parts visibly change too.
        m.color.copy(base);
        if (on) m.color.lerp(HIGHLIGHT, 0.3);
        m.emissive.copy(on ? HIGHLIGHT : pulse ? PULSE : u.baseEmissive);
        m.emissiveIntensity = on ? 0.35 : pulse ? 0.35 : 1;
        m.transparent = ghost || u.base.transparent;
        m.opacity = ghost ? GHOST_OPACITY : u.base.opacity;
        m.depthWrite = ghost ? false : u.base.depthWrite;
        m.side = ghost ? THREE.FrontSide : u.base.side; // one layer per surface, so ghosts stay faint
        o.castShadow = !ghost;
        m.needsUpdate = true;
      });
    }
    this.#updateGuides();
    this.onAppearanceChange();
  }

  /** The nearest solid part under a pointer event; ghosted parts are looked through. */
  #pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const emphasized = this.emphasized();
    const solid = this.instances.filter((i) => !emphasized.size || emphasized.has(i.id)).map((i) => i.mesh);
    return ray.intersectObjects(solid, true)[0]?.object.userData.partId ?? null;
  }

  #wirePointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
      down = null;
      this.select(this.#pick(e));
    });
    // Names the part under a mouse pointer, at most about 20 times a second (raycasts aren't free).
    let last = 0;
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || down) { this.onHover(null); return; }
      const now = performance.now();
      if (now - last < 50) return;
      last = now;
      const r = el.getBoundingClientRect();
      const id = this.#pick(e);
      this.onHover(id, e.clientX - r.left, e.clientY - r.top);
    });
    el.addEventListener('pointerleave', () => this.onHover(null));
  }

  // ---------- Camera ----------

  #bounds(t, subset = this.instances) {
    const box = new THREE.Box3();
    for (const inst of subset) {
      const bb = inst.mesh.geometry.boundingBox;
      const m = new THREE.Matrix4().compose(this.#positionAt(inst, t), inst.mesh.quaternion, inst.mesh.scale);
      box.union(bb.clone().applyMatrix4(m));
    }
    return box;
  }

  #corners(subset, t) {
    const pts = [];
    const world = this.container3d.matrixWorld;
    for (const inst of subset) {
      const bb = inst.mesh.geometry.boundingBox;
      const m = new THREE.Matrix4().compose(this.#positionAt(inst, t), inst.mesh.quaternion, inst.mesh.scale).premultiply(world);
      for (let i = 0; i < 8; i++) {
        pts.push(new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m));
      }
    }
    return pts;
  }

  /** Frames the fully taken-apart object from a three-quarter view. */
  /** `glide` moves the camera there smoothly instead of jumping (for Reset View). */
  fit(glide = false) {
    this.#frame3(this.instances, 1, null, 1.06, glide);
    this.userMoved = false;
    this.zoomedToPart = false;
  }

  /** Zooms to one part (all its copies) where it currently sits, keeping the viewing angle. */
  focus(id) {
    const ids = new Set(Array.isArray(id) ? id : [id]);
    const subset = this.instances.filter((i) => ids.has(i.id));
    if (!subset.length) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.#frame3(subset, this.explode, dir, 1.8, true);
    this.zoomedToPart = true;
  }

  #frame3(subset, t, dirIn, margin, animate = false) {
    this.container3d.updateMatrixWorld(true);
    const pts = this.#corners(subset, t);
    if (!pts.length) return;
    const yaw = 16 * (Math.PI / 180);
    const dir = dirIn ?? new THREE.Vector3(Math.sin(yaw), 0.34, Math.cos(yaw)).normalize();
    const right = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right);
    const tv = Math.tan((this.camera.fov * Math.PI) / 360);
    const th = tv * this.camera.aspect;
    const center = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    let dist = 1;
    for (let iter = 0; iter < 3; iter++) {
      let need = 0, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      for (const p of pts) {
        const q = p.clone().sub(center);
        const a = q.dot(dir), x = q.dot(right), y = q.dot(up);
        need = Math.max(need, a + Math.abs(x) / th, a + Math.abs(y) / tv);
        xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      }
      dist = need * margin;
      center.addScaledVector(right, (xmin + xmax) / 2).addScaledVector(up, (ymin + ymax) / 2);
    }
    const pos = center.clone().addScaledVector(dir, dist);
    this.scale = Math.max(1e-3, dist / 40);
    this.camera.near = Math.max(dist / 1000, 1e-4);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    if (animate) {
      this.flight = { fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(), pos, target: center, t0: performance.now() };
    } else {
      this.flight = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(center);
      this.controls.update();
    }
  }

  /** The longest side, in metres, of one copy of a part (blueprints are in real-world metres). */
  sizeOf(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return 0;
    const s = inst.mesh.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(inst.mesh.scale);
    return Math.max(s.x, s.y, s.z);
  }

  /** The longest side of the assembled object, in metres. */
  get objectSize() {
    const s = this.#bounds(0).getSize(new THREE.Vector3());
    return Math.max(s.x, s.y, s.z);
  }

  #placeShadowLight() {
    this.container3d.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromPoints(this.#corners(this.instances, 1));
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    this.key.position.copy(c).add(KEY_DIRECTION.clone().multiplyScalar(r * 2));
    this.key.target.position.copy(c);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -r * 1.5; cam.right = cam.top = r * 1.5;
    cam.near = r * 0.1; cam.far = r * 5;
    cam.updateProjectionMatrix();
    this.#buildStage(box);
  }

  /** The drafting table: a shadow catcher and a grid in real units, below the taken-apart object so nothing passes through. */
  #buildStage(box) {
    for (const o of [...this.stageGroup.children]) { o.geometry.dispose(); o.material.dispose(); }
    this.stageGroup.clear();
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.z, size.y * 0.6);
    const y = box.min.y - 0.02 * size.y;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.3 }));
    floor.position.set(center.x, y, center.z);
    floor.receiveShadow = true;
    const cell = this.gridSpacing = 10 ** Math.floor(Math.log10(span / 8));
    const half = Math.ceil((span * 0.9) / cell) * cell;
    const lines = (verts, opacity) => {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      this.stageGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: SIGNAL, transparent: true, opacity, depthWrite: false })));
    };
    // Only the coarse grid lines (every five cells), glowing under the object and fading out well before the edge.
    // Each line is cut into short pieces, sorted into bands by distance from the middle, each band a little fainter.
    const reach = half * 0.7, bands = 8, step = cell * 5, piece = Math.max(step, half / 24);
    const fade = (x, z) => { const d = Math.hypot(x - center.x, z - center.z) / reach; return d >= 1 ? 0 : (1 - d) ** 1.5; };
    const banded = Array.from({ length: bands }, () => []);
    for (let d = -half; d <= half + step / 2; d += step) {
      for (let t = -half; t < half - piece / 2; t += piece) {
        for (const [ax, az, bx, bz] of [[center.x + d, center.z + t, center.x + d, center.z + t + piece],
                                        [center.x + t, center.z + d, center.x + t + piece, center.z + d]]) {
          const f = fade((ax + bx) / 2, (az + bz) / 2);
          if (f > 0) banded[Math.min(bands - 1, Math.floor(f * bands))].push(ax, y, az, bx, y, bz);
        }
      }
    }
    banded.forEach((verts, k) => { if (verts.length) lines(verts, (0.34 * (k + 0.5)) / bands); });
    // One construction circle round the object's footprint.
    const r = half * 0.62, ring = [];
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2, b = ((i + 1) / 180) * Math.PI * 2;
      ring.push(center.x + r * Math.cos(a), y, center.z + r * Math.sin(a), center.x + r * Math.cos(b), y, center.z + r * Math.sin(b));
    }
    lines(ring, 0.22);
    this.stageGroup.add(floor);
    for (const o of this.stageGroup.children) o.raycast = () => {};
  }

  /** The object's width, height and depth in metres, assembled (t = 0) or fully apart (t = 1). */
  envelope(t) {
    return this.#bounds(t).getSize(new THREE.Vector3());
  }

  /** Where a part's centre appears on the canvas right now, in CSS pixels. */
  screenPoint(id) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) return null;
    const p = inst.localCenter.clone().applyMatrix4(inst.mesh.matrixWorld).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height };
  }

  /** The viewing angle in degrees: round the object, and above its floor. */
  get viewAngles() {
    const back = this.camera.position.clone().sub(this.controls.target).normalize();
    const az = (Math.atan2(back.x, back.z) * 180) / Math.PI;
    return { azimuth: (az + 360) % 360, elevation: (Math.asin(back.y) * 180) / Math.PI };
  }

  #resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.instances.length) return;
    const turned = this.#applyOrientation();
    if (turned) { this.#updateGuides(); this.#placeShadowLight(); }
    // Re-frame after a resize unless the user has moved the view.
    if (turned || (!this.userMoved && !this.zoomedToPart)) this.fit();
  }

  #frame() {
    const now = performance.now();
    if (this.playing) {
      const { from, target, t0, duration } = this.playing;
      const p = Math.min(1, (now - t0) / duration);
      // Eased, so the take-apart starts and settles gently.
      this.setExplode(from + (target - from) * (0.5 - 0.5 * Math.cos(p * Math.PI)));
      if (p >= 1) this.stop();
    }
    if (this.scanning) {
      const s = this.scanning;
      const p = Math.min(1, (now - s.t0) / s.duration);
      const eased = 0.5 - 0.5 * Math.cos(Math.min(1, p) * Math.PI);
      s.group.position.set(s.center.x, s.lo + s.height * eased, s.center.z);
      // Fade out over the last fifth.
      const fade = p > 0.8 ? 1 - (p - 0.8) / 0.2 : 1;
      s.group.children[0].material.opacity = 0.16 * fade;
      s.group.children[1].material.opacity = fade;
      this.onScan?.(p);
      if (p >= 1) { const done = s.done; this.#endScan(); done(); }
    }
    if (this.flight) {
      const f = this.flight;
      let p = Math.min(1, (now - f.t0) / 600);
      p = p * p * (3 - 2 * p);
      this.camera.position.lerpVectors(f.fromPos, f.pos, p);
      this.controls.target.lerpVectors(f.fromTarget, f.target, p);
      if (p >= 1) this.flight = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }
}
