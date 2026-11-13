// The instrument card: the object's name and the teardown gauge. Everything shown is counted or measured from the blueprint itself, never invented.
import { MATERIAL_NAMES } from './shapes.js';

const pieces = (parts) => parts.reduce((n, p) => n + Math.max(1, p.radialCount | 0), 0);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** "1.73 m" or "412 mm": metres for big objects, millimetres for small ones. */
function length(m) {
  return m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 1000)} mm`;
}

function panel(title) {
  const p = el('section', 'ins-panel');
  p.append(el('h3', '', title));
  return p;
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up from zero shortly after the panel appears. */
function countUp(target, delay = 0, suffix = '') {
  const span = el('span', '', reduceMotion() ? `${target}${suffix}` : `0${suffix}`);
  if (!reduceMotion()) {
    const t0 = performance.now() + delay;
    const tick = (now) => {
      const p = Math.max(0, Math.min(1, (now - t0) / 900));
      span.textContent = `${Math.round(target * (1 - (1 - p) ** 3))}${suffix}`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  return span;
}

/** Sets a style once the element is on screen, so its CSS transition plays from the starting value. */
function grow(elem, prop, value, delay) {
  elem.style.transitionDelay = `${delay}ms`;
  requestAnimationFrame(() => requestAnimationFrame(() => { elem.style[prop] = value; }));
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** The teardown gauge as an arc-reactor style dial: a glowing ring that fills, a notch per stage, a bezel of ticks. */
function dial(stageCount) {
  const s = svg('svg', { viewBox: '0 0 128 128', class: 'ins-dial', 'aria-hidden': 'true' });
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    s.append(svg('line', { x1: 64, y1: 3, x2: 64, y2: major ? 9 : 6, class: major ? 'tick major' : 'tick', transform: `rotate(${i * 6} 64 64)` }));
  }
  const r = 48.5, c = 2 * Math.PI * r;
  s.append(svg('circle', { cx: 64, cy: 64, r, class: 'track' }));
  const arc = svg('circle', { cx: 64, cy: 64, r, class: 'arc', 'stroke-dasharray': `0 ${c}`, transform: 'rotate(-90 64 64)' });
  s.append(arc);
  const n = Math.max(1, stageCount);
  for (let i = 0; i < n; i++) s.append(svg('line', { x1: 64, y1: 11, x2: 64, y2: 20, class: 'notch', transform: `rotate(${(360 * i) / n} 64 64)` }));
  s.append(svg('circle', { cx: 64, cy: 64, r: 40, class: 'inner' }));
  return { svg: s, set: (t) => arc.setAttribute('stroke-dasharray', `${Math.max(0.01, t) * c} ${c}`) };
}

export class Instruments {
  constructor(container, viewer) {
    this.container = container;
    this.viewer = viewer;
  }

  render(b) {
    const v = this.viewer;
    const box = el('div', 'ins-sheet');
    const groups = [...new Set(b.parts.map((p) => p.group))].map((g) => ({ name: g, pieces: pieces(b.parts.filter((p) => p.group === g)) }));

    const title = el('section', 'ins-title');
    const tag = el('div', 'ins-tag');
    tag.append(el('i', 'ins-led'), el('span', '', b.isBuiltIn ? 'EXAMPLE' : 'YOUR OBJECT'));
    const stats = el('p');
    stats.append(countUp(pieces(b.parts), 200), ` PCS · ${groups.length} ASM · ${v.stages.length} STG`);
    title.append(tag, el('h2', '', b.name), stats);

    const teardown = panel('Teardown');
    const gauge = el('div', 'ins-gauge');
    this.dial = dial(v.stages.length);
    const readout = el('div', 'ins-readout');
    const big = el('div', 'ins-big');
    this.percent = el('strong');
    big.append(this.percent, el('small', '', '%'));
    this.stage = el('span', 'ins-stage');
    readout.append(big, this.stage);
    gauge.append(this.dial.svg, readout);
    const chart = el('div', 'ins-chart');
    const counts = v.stages.map((st) => pieces(b.parts.filter((p) => st.partIds.includes(p.id))));
    const top = Math.max(1, ...counts);
    this.bars = counts.map((c, i) => {
      const bar = el('i');
      grow(bar, 'height', `${4 + (22 * c) / top}px`, 300 + 60 * i);
      bar.title = `Stage ${i + 1}: ${c} pieces`;
      chart.append(bar);
      return bar;
    });
    teardown.append(gauge, el('p', 'ins-note', 'Pieces off in each stage'), chart);

    box.append(title, teardown);
    this.container.replaceChildren(box);
    this.update();
  }

  update() {
    const v = this.viewer;
    if (!this.percent) return;
    this.percent.textContent = Math.round(v.explode * 100);
    this.dial.set(v.explode);
    const i = v.currentStage;
    this.stage.textContent = i == null ? 'ASSEMBLED' : `STAGE ${i + 1}/${v.stages.length}`;
    const done = v.stagesDone;
    this.bars.forEach((bar, k) => bar.classList.toggle('on', k < done || k === i));
  }

  /** A targeting reticle on the selected part, with an elbowed leader line to a readout of its name, size, material, assembly and count. */
  updateCallout(svgEl, label, part) {
    const p = part && this.viewer.screenPoint(part.id);
    const show = !!p;
    svgEl.style.display = show ? '' : 'none';
    label.hidden = !show;
    if (!show) { this.calloutId = null; return; }
    if (this.calloutId !== part.id) {
      this.calloutId = part.id;
      const row = (k, v) => { const r = el('div', 'co-row'); r.append(el('span', '', k), el('b', '', v)); return r; };
      label.replaceChildren(el('strong', '', part.name), el('hr'),
        row('SIZE', length(this.viewer.sizeOf(part.id))),
        row('MATL', MATERIAL_NAMES[part.material] ?? part.material),
        row('ASM', part.group),
        ...(part.radialCount > 1 ? [row('QTY', `×${part.radialCount}`)] : []));
    }
    const box = label.parentElement.getBoundingClientRect();
    const w = 220, h = label.offsetHeight || 96;
    const toLeft = p.x > box.width * 0.62;
    const x = Math.min(Math.max(p.x + (toLeft ? -170 : 170), w / 2 + 8), box.width - w / 2 - 8);
    const y = Math.min(Math.max(p.y - 80, h / 2 + 8), box.height - h / 2 - 90);
    label.style.left = `${x - w / 2}px`;
    label.style.top = `${y - h / 2}px`;
    const ex = x + (toLeft ? w / 2 : -w / 2), ey = y - h / 2 + 14;
    const bx = ex + (toLeft ? 34 : -34);
    svgEl.querySelector('#callout-line').setAttribute('points', `${p.x},${p.y} ${bx},${ey} ${ex},${ey}`);
    svgEl.querySelector('#callout-elbow').setAttribute('transform', `translate(${bx} ${ey})`);
    for (const id of ['callout-dot', 'callout-ring']) svgEl.querySelector(`#${id}`).setAttribute('transform', `translate(${p.x} ${p.y})`);
  }
}
