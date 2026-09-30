// The 3D view: builds a blueprint, moves parts apart, highlights the selection, frames the camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { geometryFor, materialFor, orientation } from './shapes.js';

const UP = new THREE.Vector3(0, 1, 0);
const HIGHLIGHT = new THREE.Color(1, 0.55, 0.15);

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x16171b);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;

    this.key = new THREE.DirectionalLight(0xffffff, 1.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xbfd9ff, 0.6);
    rim.position.set(-3, 2, -4);
    this.scene.add(rim);

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.01, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    this.container3d = new THREE.Group();
    this.scene.add(this.container3d);
    this.instances = [];
    this.explode = 0;
    this.showGuides = true;
    this.scale = 1;
    this.selectedId = null;
    this.onSelect = () => {};
    this.onExplodeChange = () => {};

    this.#wirePointer();
    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ---------- Building ----------

  load(blueprint) {
    this.stop();
    for (const inst of this.instances) {
      inst.mesh.geometry.dispose();
      inst.mesh.material.dispose();
    }
    this.container3d.clear();
    this.container3d.quaternion.identity();
    this.instances = [];
    this.selectedId = null;
    this.maxStep = 0;
    this.laidFlat = false;

    for (const part of blueprint.parts) {
      const count = Math.max(1, part.radialCount | 0);
      const geometry = geometryFor(part);
      geometry.computeBoundingBox();
      for (let k = 0; k < count; k++) {
        const spin = new THREE.Quaternion().setFromAxisAngle(UP, (k / count) * Math.PI * 2);
        const mesh = new THREE.Mesh(geometry, materialFor(part.material, part.color));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.partId = part.id;
        const base = new THREE.Vector3(...part.position).applyQuaternion(spin);
        mesh.quaternion.copy(spin).multiply(orientation(part.rotation));
        mesh.position.copy(base);
        const offset = new THREE.Vector3(...part.explode).applyQuaternion(spin);
        const localCenter = geometry.boundingBox.getCenter(new THREE.Vector3());
        this.container3d.add(mesh);
        this.instances.push({ id: part.id, mesh, base, offset, step: part.step | 0, localCenter });
      }
      this.maxStep = Math.max(this.maxStep, part.step | 0);
    }

    this.guides = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffb866, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    this.guides.raycast = () => {};
    this.container3d.add(this.guides);

    const size = this.#bounds(0).getSize(new THREE.Vector3());
    this.isLong = size.y > 2.2 * Math.max(size.x, size.z);
    this.#applyOrientation();
    this.setExplode(0);
    this.fit();
    this.#placeShadowLight();
  }

  /** Long, thin objects (rockets, pens) lie across a wide screen but stand up on a tall one. */
  #applyOrientation() {
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
    const s = this.maxStep > 0 ? step / this.maxStep : 0;
    const start = s * 0.55;
    const p = Math.min(1, Math.max(0, (t - start) / 0.45));
    return p * p * (3 - 2 * p);
  }

  #positionAt(inst, t) {
    return inst.base.clone().addScaledVector(inst.offset, this.#progress(inst.step, t));
  }

  setExplode(t) {
    this.explode = t;
    for (const inst of this.instances) inst.mesh.position.copy(this.#positionAt(inst, t));
    this.#updateGuides();
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
      for (const inst of this.instances) {
        if (inst.offset.lengthSq() < 1e-6) continue;
        const moved = inst.mesh.position.clone().sub(inst.base);
        if (moved.length() < 0.05 * this.scale) continue;
        const now = inst.localCenter.clone().applyQuaternion(inst.mesh.quaternion).add(inst.mesh.position);
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

  togglePlay() {
    if (this.playing) { this.stop(); return; }
    if (this.zoomedToPart) { this.zoomedToPart = false; this.fit(); }
    this.animateTo(this.explode > 0.5 ? 0 : 1);
  }

  stop() { this.playing = null; this.onPlayChange?.(false); }

  // ---------- Selection ----------

  select(id) {
    this.selectedId = id;
    for (const inst of this.instances) {
      const m = inst.mesh.material;
      m.userData.baseColor ??= m.color.clone();
      if (inst.id === id) {
        // Tint as well as glow, so white and metallic parts visibly change too.
        m.color.copy(m.userData.baseColor).lerp(HIGHLIGHT, 0.6);
        m.emissive.copy(HIGHLIGHT);
        m.emissiveIntensity = 0.3;
      } else {
        m.color.copy(m.userData.baseColor);
        m.emissive.copy(m.userData.baseEmissive);
        m.emissiveIntensity = 1;
      }
    }
    this.onSelect(id);
  }

  #wirePointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.instances.map((i) => i.mesh), false)[0];
      this.select(hit ? hit.object.userData.partId : null);
    });
  }

  // ---------- Camera ----------

  #bounds(t, subset = this.instances) {
    const box = new THREE.Box3();
    for (const inst of subset) {
      const bb = inst.mesh.geometry.boundingBox;
      const m = new THREE.Matrix4().compose(this.#positionAt(inst, t), inst.mesh.quaternion, new THREE.Vector3(1, 1, 1));
      box.union(bb.clone().applyMatrix4(m));
    }
    return box;
  }

  #corners(subset, t) {
    const pts = [];
    const world = this.container3d.matrixWorld;
    for (const inst of subset) {
      const bb = inst.mesh.geometry.boundingBox;
      const m = new THREE.Matrix4().compose(this.#positionAt(inst, t), inst.mesh.quaternion, new THREE.Vector3(1, 1, 1)).premultiply(world);
      for (let i = 0; i < 8; i++) {
        pts.push(new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m));
      }
    }
    return pts;
  }

  /** Frames the fully taken-apart object from a three-quarter view. */
  fit() {
    this.#frame3(this.instances, 1, null, 1.06);
    this.userMoved = false;
    this.zoomedToPart = false;
  }

  /** Zooms to one part (all its copies) where it currently sits, keeping the viewing angle. */
  focus(id) {
    const subset = this.instances.filter((i) => i.id === id);
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

  #placeShadowLight() {
    this.container3d.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromPoints(this.#corners(this.instances, 1));
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    this.key.position.copy(c).add(new THREE.Vector3(0.6, 1.2, 0.8).normalize().multiplyScalar(r * 2));
    this.key.target.position.copy(c);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -r; cam.right = cam.top = r;
    cam.near = r * 0.1; cam.far = r * 4;
    cam.updateProjectionMatrix();
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
      this.setExplode(from + (target - from) * p);
      if (p >= 1) this.stop();
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
  }
}
