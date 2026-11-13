// Builds three.js meshes and materials from blueprint parts.
// Mirrors Sources/TakeItApart/{SceneController,Mesh,Materials}.swift so objects look the same on Mac and web.
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const DEG = Math.PI / 180;

/** How finely curved shapes are drawn. Mirrors `Resolution` in SceneController.swift, which the triangle check uses. */
const RES = { radial: 96, lathe: 112, tube: 112, torusRing: 96, torusPipe: 32, sphereRings: 48, pipeSides: 24, pipeSteps: 10, repeatedFrom: 3, repeated: 64 };

function dim(d, i, fallback) {
  return i < d.length && d[i] > 0 ? d[i] : fallback;
}

function pairs(points) {
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]]);
  return out;
}

// SceneKit lathes start at +X and sweep toward +Z; three.js starts at +Z and sweeps toward +X.
function lathe(profile, startDeg = 0, sweepDeg = 360, segments = 72) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  if (pts.length < 2) return new THREE.SphereGeometry(0.1);
  const phiStart = (90 - (startDeg + sweepDeg)) * DEG;
  return new THREE.LatheGeometry(pts, segments, phiStart, sweepDeg * DEG);
}

function tube(outer, inner, height, seg = 72) {
  inner = Math.min(inner, outer * 0.995);
  const h = height / 2;
  const parts = [
    new THREE.CylinderGeometry(outer, outer, height, seg, 1, true),
    new THREE.CylinderGeometry(inner, inner, height, seg, 1, true),
    new THREE.RingGeometry(inner, outer, seg).rotateX(-Math.PI / 2).translate(0, h, 0),
    new THREE.RingGeometry(inner, outer, seg).rotateX(Math.PI / 2).translate(0, -h, 0),
  ];
  // Flip the inner wall so its normals face the hole.
  const idx = parts[1].index.array;
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  const n = parts[1].attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

function pipe(points, radius) {
  const v = [];
  for (let i = 0; i + 2 < points.length; i += 3) v.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  if (v.length < 2) return new THREE.SphereGeometry(radius);
  const curve = new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0.5);
  return new THREE.TubeGeometry(curve, Math.max(8, v.length * RES.pipeSteps), radius, RES.pipeSides, false);
}

function prism(points, thickness) {
  let outline = pairs(points);
  if (outline.length < 3) return new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  // Smooth across gentle bends so curved outlines read as smooth walls; real corners (over 35 degrees) stay crisp.
  return toCreasedNormals(g.translate(0, 0, -thickness / 2), 35 * DEG);
}

function grid(w, h, depth, cx, cy, bar) {
  cx = Math.max(1, Math.min(Math.round(cx), 40));
  cy = Math.max(1, Math.min(Math.round(cy), 40));
  const boxes = [];
  for (let i = 0; i <= cx; i++) {
    const t = bar * (i === 0 || i === cx ? 2 : 1);
    boxes.push(new THREE.BoxGeometry(t, h, depth).translate(-w / 2 + (w * i) / cx, 0, 0));
  }
  for (let j = 0; j <= cy; j++) {
    const t = bar * (j === 0 || j === cy ? 2 : 1);
    boxes.push(new THREE.BoxGeometry(w, t, depth).translate(0, -h / 2 + (h * j) / cy, 0));
  }
  return mergeGeometries(boxes);
}

/**
 * A curved panel with real thickness from a grid of points: rows of [x, y, z, ...], `columns` to a row.
 * Normals are smoothed across the face and split at the edges. Mirrors Mesh.patch on the Mac.
 */
function patch(points, columns, thickness) {
  const c = Math.max(2, columns | 0), r = Math.floor(points.length / 3 / c);
  if (r < 2) return new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const P = (i, j) => new THREE.Vector3().fromArray(points, (i * c + j) * 3);
  const normals = [];
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    const du = P(Math.min(r - 1, i + 1), j).sub(P(Math.max(0, i - 1), j)), dv = P(i, Math.min(c - 1, j + 1)).sub(P(i, Math.max(0, j - 1)));
    const n = new THREE.Vector3().crossVectors(du, dv);
    normals.push(n.lengthSq() > 1e-18 ? n.normalize() : new THREE.Vector3(0, 1, 0));
  }
  const pos = [], nrm = [], uv = [], idx = [];
  for (const back of [false, true]) for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) {
    const n = normals[i * c + j], p = P(i, j);
    if (back) p.addScaledVector(n, -thickness);
    pos.push(p.x, p.y, p.z);
    if (back) nrm.push(-n.x, -n.y, -n.z); else nrm.push(n.x, n.y, n.z);
    uv.push(i / (r - 1), j / (c - 1));
  }
  const b = r * c;
  for (let i = 0; i < r - 1; i++) for (let j = 0; j < c - 1; j++) {
    const a0 = i * c + j, a1 = a0 + c, a2 = a0 + 1, a3 = a1 + 1;
    idx.push(a0, a1, a3, a0, a3, a2, b + a0, b + a3, b + a1, b + a0, b + a2, b + a3);
  }
  const V = (k) => new THREE.Vector3().fromArray(pos, k * 3);
  const rim = (a, e) => {
    const oa = V(a), ob = V(e), ia = V(a + b), ib = V(e + b);
    const n = new THREE.Vector3().crossVectors(ob.clone().sub(oa), ia.clone().sub(oa));
    if (n.lengthSq() > 1e-18) n.normalize(); else n.set(0, 1, 0);
    const base = pos.length / 3;
    for (const v of [oa, ob, ia, ib]) { pos.push(v.x, v.y, v.z); nrm.push(n.x, n.y, n.z); }
    uv.push(0, 0, 1, 0, 0, 1, 1, 1);
    idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
  };
  for (let i = 0; i < r - 1; i++) { rim(i * c, (i + 1) * c); rim((i + 1) * c + c - 1, i * c + c - 1); }
  // A panel that closes on itself (first row meets last) has no edge along its seam.
  let closed = true;
  for (let j = 0; j < c; j++) if (P(0, j).distanceTo(P(r - 1, j)) > 1e-6) closed = false;
  if (!closed) for (let j = 0; j < c - 1; j++) { rim(j + 1, j); rim((r - 1) * c + j, (r - 1) * c + j + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** `featureSeg` is set for a feature's fewer sides; a part's own shape gets full resolution, or medium if it's repeated. */
export function geometryFor(part, featureSeg) {
  const d = part.dims;
  const repeated = featureSeg == null && (part.radialCount | 0) >= RES.repeatedFrom;
  const full = featureSeg == null && !repeated;
  const seg = featureSeg ?? (repeated ? RES.repeated : RES.radial);
  switch (part.shape) {
    case 'box': {
      const w = dim(d, 0, 1), h = dim(d, 1, 1), l = dim(d, 2, 1);
      const ch = d.length > 3 ? Math.min(Math.max(0, d[3]), Math.min(w, h, l) / 2) : 0;
      return ch > 0 ? new RoundedBoxGeometry(w, h, l, 3, ch) : new THREE.BoxGeometry(w, h, l);
    }
    case 'cylinder':
      return new THREE.CylinderGeometry(dim(d, 0, 0.5), dim(d, 0, 0.5), dim(d, 1, 1), seg);
    case 'tube': {
      const outer = dim(d, 0, 0.5);
      return tube(outer, dim(d, 1, outer * 0.9), dim(d, 2, 1), full ? RES.tube : seg);
    }
    case 'frustum':
      return new THREE.CylinderGeometry(d.length > 1 ? Math.max(0, d[1]) : 0.25, dim(d, 0, 0.5), dim(d, 2, 1), seg);
    case 'cone':
      return new THREE.ConeGeometry(dim(d, 0, 0.5), dim(d, 1, 1), seg);
    case 'sphere':
      return full ? new THREE.SphereGeometry(dim(d, 0, 0.5), RES.radial, RES.sphereRings) : new THREE.SphereGeometry(dim(d, 0, 0.5), seg, Math.ceil(seg / 2));
    case 'dome': {
      const r = dim(d, 0, 0.5), h = dim(d, 1, r);
      const prof = [];
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * (Math.PI / 2);
        prof.push([r * Math.cos(a), h * Math.sin(a)]);
      }
      return lathe(prof, 0, 360, full ? RES.lathe : seg);
    }
    case 'torus':
      // SceneKit tori lie flat in XZ; three.js tori stand in XY.
      return new THREE.TorusGeometry(dim(d, 0, 0.5), dim(d, 1, 0.05), full ? RES.torusPipe : 6, full ? RES.torusRing : seg).rotateX(Math.PI / 2);
    case 'capsule': {
      const r = dim(d, 0, 0.25);
      const total = Math.max(dim(d, 1, 1), 2 * r);
      return new THREE.CapsuleGeometry(r, total - 2 * r, full ? 12 : 4, full ? RES.radial : seg);
    }
    case 'lathe': {
      const start = d.length > 0 ? d[0] : 0;
      const sweep = d.length > 1 && d[1] > 0 ? Math.min(d[1], 360) : 360;
      return lathe(pairs(part.points), start, sweep, full ? RES.lathe : Math.max(4, Math.ceil((seg * sweep) / 360)));
    }
    case 'pipe':
      return pipe(part.points, dim(d, 0, 0.05));
    case 'prism':
      return prism(part.points, dim(d, 0, 0.1));
    case 'patch':
      return patch(part.points, dim(d, 0, 2), dim(d, 1, 0.002));
    case 'grid':
      return grid(dim(d, 0, 1), dim(d, 1, 1), dim(d, 2, 0.1), dim(d, 3, 4), dim(d, 4, 4), dim(d, 5, 0.03));
    default:
      return new THREE.BoxGeometry(0.2, 0.2, 0.2);
  }
}

/** Segments round a detail shape, by its size: a bolt doesn't need the resolution of a shell. */
function featureSegments(f) {
  if (f.segments) return f.segments;
  if (f.shape === 'lathe') return 48;
  const r = f.dims[0] ?? 0;
  return r < 0.006 ? 12 : r < 0.02 ? 20 : r < 0.05 ? 32 : 56;
}

/** A part's surface detail, batched by look so a dense part stays a handful of draw calls. Each batch is one geometry. */
export function featureBatches(part) {
  const groups = new Map();
  for (const f of part.features ?? []) {
    const g = geometryFor({ shape: f.shape, dims: f.dims, points: f.points ?? [] }, featureSegments(f));
    const scale = Array.isArray(f.scale) && f.scale.length === 3 ? f.scale.map((v) => Math.max(v, 0.001)) : [1, 1, 1];
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...(f.position ?? [0, 0, 0])), orientation(f.rotation ?? [0, 0, 0]), new THREE.Vector3(...scale)));
    const flat = g.index ? g.toNonIndexed() : g;
    const key = `${f.material}|${f.color}`;
    if (!groups.has(key)) groups.set(key, { material: f.material, color: f.color, list: [] });
    groups.get(key).list.push(flat);
  }
  return [...groups.values()].map(({ material, color, list }) => ({ material, color, geometry: mergeGeometries(list) ?? list[0] }));
}

export function orientation(rot) {
  // Degrees about X, then Y, then Z (matrix = Rz·Ry·Rx).
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'ZYX'));
}

// ---------- Materials ----------

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function canvasTexture(size, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}

const textures = {};
function crinkleNormal() {
  return (textures.crinkle ??= canvasTexture(256, (g, s) => {
    const rnd = seeded(7);
    g.fillStyle = 'rgb(128,128,255)';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      g.save();
      g.translate(rnd() * s, rnd() * s);
      g.rotate(rnd() * Math.PI);
      g.fillStyle = `rgba(${64 + rnd() * 128 | 0},${64 + rnd() * 128 | 0},230,0.55)`;
      g.beginPath();
      g.ellipse(0, 0, 2 + rnd() * 14, 1 + rnd() * 5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }, 4));
}
function brushedNormal() {
  return (textures.brushed ??= canvasTexture(256, (g, s) => {
    const rnd = seeded(3);
    for (let y = 0; y < s; y++) {
      g.fillStyle = `rgb(128,${107 + rnd() * 41 | 0},255)`;
      g.fillRect(0, y, s, 1);
    }
  }, 4));
}
function weave(color) {
  return canvasTexture(64, (g, s) => {
    const base = new THREE.Color(color);
    const half = s / 2;
    [[0, 0, 1.25, true], [half, 0, 0.8, false], [0, half, 0.8, false], [half, half, 1.25, true]].forEach(([x, y, k, vert]) => {
      const c = base.clone().multiplyScalar(k);
      g.fillStyle = `#${c.getHexString()}`;
      g.fillRect(x, y, half, half);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let i = 0; i < half; i += 4) vert ? g.fillRect(x + i, y, 0.6, half) : g.fillRect(x, y + i, half, 0.6);
    });
  }, 8);
}
function solarGrid(color) {
  return canvasTexture(512, (g, s) => {
    g.fillStyle = '#d9d9d9';
    g.fillRect(0, 0, s, s);
    const cells = 8, gap = 5, cw = s / cells;
    for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
      g.fillStyle = color;
      g.fillRect(i * cw + gap / 2, j * cw + gap / 2, cw - gap, cw - gap);
      g.fillStyle = 'rgba(190,190,190,0.6)';
      for (let k = 1; k < 4; k++) g.fillRect(i * cw + gap / 2, j * cw + gap / 2 + ((cw - gap) * k) / 4, cw - gap, 0.7);
    }
  });
}

export function materialFor(kind, hex) {
  const color = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex || '') ? (hex.startsWith('#') ? hex : '#' + hex) : '#cccccc';
  const m = new THREE.MeshPhysicalMaterial({ color, side: THREE.DoubleSide });
  const set = (metal, rough) => { m.metalness = metal; m.roughness = rough; };
  switch (kind) {
    // A clear lacquer over the paint, as on the Mac.
    case 'paintedMetal': set(0.15, 0.42); m.clearcoat = 0.8; m.clearcoatRoughness = 0.12; break;
    // Brushed metal stretches its highlights along the grain.
    case 'brushedAluminum': set(1, 0.34); m.normalMap = brushedNormal(); m.normalScale.set(0.35, 0.35); m.anisotropy = 0.5; break;
    case 'steel': set(0.95, 0.3); break;
    case 'titanium': set(0.9, 0.45); break;
    case 'copper': set(1, 0.28); break;
    case 'gold': set(1, 0.18); break;
    case 'goldFoil': set(1, 0.38); m.normalMap = crinkleNormal(); m.normalScale.set(0.9, 0.9); break;
    case 'carbonFiber': set(0.25, 0.32); m.map = weave(color); m.color.set('#ffffff'); break;
    case 'rubber': set(0, 0.9); break;
    case 'glass': set(0.1, 0.05); m.transparent = true; m.opacity = 0.2; m.depthWrite = false; break;
    case 'plastic': set(0, 0.5); break;
    case 'ceramic': set(0, 0.85); break;
    case 'solarCell': set(0.6, 0.22); m.map = solarGrid(color); m.color.set('#ffffff'); break;
    case 'fabric': set(0, 1); break;
    case 'emissive': set(0, 0.5); m.emissive.set(color); break;
    case 'castMetal': set(0.55, 0.6); break;
    default: set(0.2, 0.5);
  }
  if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
  m.userData.baseEmissive = m.emissive.clone();
  return m;
}

export const MATERIAL_NAMES = {
  paintedMetal: 'Painted metal', brushedAluminum: 'Brushed aluminium', steel: 'Steel', titanium: 'Titanium',
  copper: 'Copper', gold: 'Gold', goldFoil: 'Gold foil (MLI)', carbonFiber: 'Carbon fibre', rubber: 'Rubber',
  glass: 'Glass', plastic: 'Plastic', ceramic: 'Ceramic', solarCell: 'Solar cells', fabric: 'Fabric', emissive: 'Light / glow', castMetal: 'Cast metal',
};
