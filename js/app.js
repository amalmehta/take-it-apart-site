// Page wiring: object library, parts inspector, dialogs.
import { Viewer } from './viewer.js';
import { Instruments } from './instruments.js';
import { MATERIAL_NAMES } from './shapes.js';
import { generate, photoToBase64, sanitize } from './claude.js';
import { linkTargets, linkify, layered, richText, emphasizeNumber, lengthText, comparison, groupColor } from './teaching.js';

const $ = (id) => document.getElementById(id);
const ISSUES_URL = 'https://github.com/amalmehta/take-it-apart-site/issues/new';
const STORE_OBJECTS = 'take-it-apart.objects';
const STORE_KEY = 'take-it-apart.api-key';
const STORE_PRINCIPLES = 'take-it-apart.show-principles';

// Browser storage can be missing (private windows, blocked site data); the page works without it.
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  examples: [],
  saved: store.get(STORE_OBJECTS, []),
  current: null,
  generation: null,
  scanned: new Set(), // objects already scanned on this page, so reopening one skips the scan
};

const viewer = new Viewer($('viewport'));
window.takeItApart = { viewer }; // handy from the console, and used to capture README screenshots
const isNarrow = () => matchMedia('(max-width: 820px)').matches;
const instruments = new Instruments($('instruments'), viewer);
viewer.onFrame = () => {
  instruments.updateCallout($('callout-svg'), $('callout'), state.current?.parts.find((p) => p.id === viewer.selectedId));
};

// The startup scan's readout: progress and a count of what it has found while the scan plane sweeps.
viewer.onScan = (p) => {
  const box = $('scan'), b = state.current;
  if (!b) return;
  clearTimeout(box.hideTimer);
  box.hidden = false;
  box.classList.remove('gone');
  $('scan-state').textContent = p < 1 ? 'SCANNING' : 'SCAN COMPLETE';
  $('scan-pct').textContent = `${Math.floor(p * 100)}%`;
  $('scan-bar').style.width = `${p * 100}%`;
  $('scan-found').textContent = `${Math.floor(pieceCount(b) * p)} PIECES · ${Math.floor(groups(b).length * p)} ASSEMBLIES`;
  if (p >= 1) box.hideTimer = setTimeout(() => { box.classList.add('gone'); box.hideTimer = setTimeout(() => { box.hidden = true; }, 300); }, 700);
};

// ---------- Library ----------

function pieceCount(b) { return b.pieces ?? b.parts.reduce((n, p) => n + Math.max(1, p.radialCount | 0), 0); }
function groups(b) {
  const map = new Map();
  for (const p of b.parts) { if (!map.has(p.group)) map.set(p.group, []); map.get(p.group).push(p); }
  return [...map];
}

function objectItem(b, removable) {
  const li = document.createElement('li');
  li.tabIndex = 0;
  li.className = state.current?.id === b.id ? 'selected' : '';
  li.innerHTML = `<span class="name"></span><span class="meta">${pieceCount(b)} pieces · ${b.assemblies ?? groups(b).length} assemblies</span>`;
  li.querySelector('.name').textContent = b.name;
  li.onclick = () => open(b);
  li.onkeydown = (e) => { if (e.key === 'Enter') open(b); };
  if (removable) {
    const x = document.createElement('button');
    x.className = 'remove'; x.textContent = '×'; x.title = 'Remove from this browser'; x.setAttribute('aria-label', `Remove ${b.name}`);
    x.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Remove “${b.name}” from this browser? This can't be undone.`)) return;
      state.saved = state.saved.filter((s) => s.id !== b.id);
      store.set(STORE_OBJECTS, state.saved);
      if (state.current?.id === b.id) open(state.examples[0]); else renderLibrary();
    };
    li.appendChild(x);
  }
  return li;
}

function renderLibrary() {
  $('examples').replaceChildren(...state.examples.map((b) => objectItem(b, false)));
  $('saved').replaceChildren(...state.saved.map((b) => objectItem(b, true)));
  $('saved-empty').hidden = state.saved.length > 0 || !!state.generation;
  const g = state.generation, box = $('generation');
  box.hidden = !g;
  if (g) {
    box.innerHTML = '';
    const name = document.createElement('div');
    name.textContent = g.label;
    box.appendChild(name);
    const row = document.createElement('div');
    if (g.error) {
      row.className = 'error';
      row.textContent = g.error;
      const dismiss = document.createElement('button');
      dismiss.textContent = 'Dismiss'; dismiss.style.marginTop = '6px';
      dismiss.onclick = () => { state.generation = null; renderLibrary(); };
      box.append(row, dismiss);
    } else {
      row.className = 'row';
      row.innerHTML = `<span class="spinner"></span><span>${g.parts ? `Designed ${g.parts} parts…` : 'Studying the object…'}</span>`;
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel'; cancel.style.marginLeft = 'auto';
      cancel.onclick = () => { g.abort.abort(); state.generation = null; renderLibrary(); };
      row.appendChild(cancel);
      box.appendChild(row);
    }
  }
  $('new-object').disabled = !!(g && !g.error);
}

/** Built-in objects start as index entries; the model itself is fetched the first time it's opened. */
let openRequest = 0;
async function open(entry) {
  const request = ++openRequest;
  let b = entry;
  if (!b.parts) {
    try {
      const res = await fetch(`data/${b.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      b = sanitize(await res.json());
    } catch (err) {
      console.error(err);
      if (request === openRequest) { $('object-name').textContent = entry.name; $('object-sub').textContent = "Couldn't load this object. Check your connection and try again."; }
      return;
    }
    state.examples[state.examples.indexOf(entry)] = b;
  }
  if (request === openRequest) show(b);
}

function show(b) {
  state.current = b;
  $('object-name').textContent = b.name;
  $('object-sub').textContent = `${pieceCount(b)} pieces`;
  document.title = `${b.name} — Take It Apart`;
  $('summary').textContent = b.summary;
  $('part-search').value = '';
  viewer.load(b);
  instruments.render(b);
  const targets = linkTargets(b);
  $('overview').hidden = !b.overview;
  $('overview-text').replaceChildren(...(b.overview || '').split(/\n\s*\n/).filter(Boolean).map((t) => {
    const para = document.createElement('p');
    para.append(linkify(t.trim(), targets, followLink));
    return para;
  }));
  $('assemblies').replaceChildren(...groups(b).map(([group, parts], i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'assembly';
    btn.title = `Show only the ${group}`;
    btn.innerHTML = '<span class="swatch"></span><span class="aname"></span><span class="count"></span>';
    btn.querySelector('.swatch').style.background = groupColor(i);
    btn.querySelector('.aname').textContent = group;
    btn.querySelector('.count').textContent = `${parts.reduce((n, p) => n + Math.max(1, p.radialCount | 0), 0)} pieces`;
    btn.onclick = () => showGroup(group);
    li.append(btn);
    return li;
  }));
  $('ticks').replaceChildren(...viewer.stages.length > 1 ? [...Array(viewer.stages.length + 1)].map((_, k) => {
    const t = document.createElement('span');
    t.style.left = `calc(var(--knob) / 2 + (100% - var(--knob)) * ${k / viewer.stages.length})`;
    return t;
  }) : []);
  updateIsolation();
  renderPrinciples();
  renderLibrary();
  renderParts();
  renderCard(null);
  closeDrawers();
  // Scan it, then take it apart. The scan runs only the first time an object opens on this page; after that it comes straight apart.
  setTimeout(() => {
    if (state.current !== b || viewer.explode !== 0 || new URLSearchParams(location.search).has('explode')) return;
    const takeApart = () => { if (state.current === b && viewer.explode === 0) viewer.animateTo(1, 3200); };
    if (state.scanned.has(b.id)) takeApart(); else { state.scanned.add(b.id); viewer.scan(1400, takeApart); }
  }, 300);
}

// ---------- Parts inspector ----------

function renderParts() {
  const b = state.current;
  const q = $('part-search').value.trim().toLowerCase();
  const out = [];
  // Matches names, assemblies, and what the card says, so "bearing" finds every part that uses one.
  const matches = (p, group) => [p.name, group, p.description, p.details?.howItWorks, p.details?.madeOf]
    .some((t) => t && t.toLowerCase().includes(q));
  groups(b).forEach(([group, parts], gi) => {
    const hits = q ? parts.filter((p) => matches(p, group)) : parts;
    if (!hits.length) return;
    const h = document.createElement('h2');
    const head = document.createElement('button');
    const isolated = viewer.isolatedGroup === group;
    head.className = 'group-head' + (isolated ? ' active' : '');
    head.title = isolated ? 'Show the whole object again' : `Show only the ${group}`;
    head.innerHTML = `${viewer.colorByGroup ? '<span class="swatch"></span>' : ''}<span class="gname"></span><span class="eye">${isolated ? '◉' : '○'}</span>`;
    head.querySelector('.gname').textContent = group;
    if (viewer.colorByGroup) head.querySelector('.swatch').style.background = groupColor(gi);
    head.onclick = () => toggleIsolation(group);
    h.append(head);
    out.push(h);
    for (const p of hits) {
      const row = document.createElement('div');
      row.className = 'part-row' + (viewer.selectedId === p.id ? ' selected' : '');
      row.dataset.id = p.id;
      row.tabIndex = 0;
      row.innerHTML = `<span class="dot"></span><span class="pname"></span>${p.radialCount > 1 ? `<span class="count">×${p.radialCount}</span>` : ''}`;
      row.querySelector('.dot').style.background = p.color;
      row.querySelector('.pname').textContent = p.name;
      row.onclick = () => viewer.select(p.id);
      row.ondblclick = () => { viewer.select(p.id); viewer.focus(p.id); };
      row.onkeydown = (e) => { if (e.key === 'Enter') viewer.select(p.id); };
      out.push(row);
    }
  });
  $('parts').replaceChildren(...out);
}

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };

function renderCard(id) {
  const card = $('part-card');
  const b = state.current;
  const p = id && b.parts.find((x) => x.id === id);
  card.hidden = !p;
  $('about').hidden = !!p;
  if (!p) return;
  const stages = viewer.stages;
  const si = Math.max(0, stages.findIndex((st) => st.step === (p.step | 0)));
  const order = groups(b).flatMap(([, parts]) => parts);
  const index = order.findIndex((x) => x.id === p.id);
  const together = b.parts.filter((x) => x.id !== p.id && (x.step | 0) === (p.step | 0) && x.group === p.group);
  const hard = (b.firstPrinciples?.hardParts ?? []).map((h, i) => [h, i]).filter(([h]) => h.partIDs.includes(p.id));
  card.innerHTML = `
    <div class="crumbs"><button class="link" id="crumb-object" title="Back to the overview"></button><span>›</span><button class="link" id="crumb-group"></button><button class="link close" id="card-close" aria-label="Close">✕</button></div>
    <h3></h3>
    <p class="desc"></p>
    <dl>
      <dt>Material</dt><dd><span class="swatch"></span> ${MATERIAL_NAMES[p.material] ?? p.material}</dd>
      ${p.radialCount > 1 ? `<dt>Copies</dt><dd>${p.radialCount} identical pieces, all highlighted</dd>` : ''}
      <dt>Comes off</dt><dd>${stages.length > 1 ? `Stage ${si + 1} of ${stages.length}${si === 0 ? ', first' : si === stages.length - 1 ? ', last' : ''}` : 'With everything else'}</dd>
    </dl>
    <div class="size"></div>
    <div class="card-actions"><button id="card-zoom">Zoom to Part</button><span></span><button id="card-prev" title="Previous part (↑)" aria-label="Previous part">↑</button><button id="card-next" title="Next part (↓)" aria-label="Next part">↓</button></div>`;
  card.querySelector('h3').textContent = p.name;
  card.querySelector('.desc').textContent = p.description;
  card.querySelector('.swatch').style.background = p.color;
  $('crumb-object').textContent = b.name;
  $('crumb-object').onclick = () => viewer.select(null);
  $('crumb-group').textContent = p.group;
  $('crumb-group').title = `Show only the ${p.group}`;
  $('crumb-group').onclick = () => toggleIsolation(p.group);
  $('card-close').onclick = () => viewer.select(null);
  $('card-zoom').onclick = () => { viewer.focus(p.id); if (isNarrow()) closeDrawers(); };
  $('card-prev').onclick = () => viewer.select(order[(index - 1 + order.length) % order.length].id);
  $('card-next').onclick = () => viewer.select(order[(index + 1) % order.length].id);

  // The part's real size, in words and as a bar against the whole object.
  const size = viewer.sizeOf(p.id), whole = viewer.objectSize;
  if (size > 0 && whole > 0) {
    const ratio = Math.min(1, size / whole);
    const box = card.querySelector('.size');
    const cmp = comparison(size);
    box.append(el('div', `About ${lengthText(size)} at its longest${cmp ? `, ${cmp}` : ''}`));
    const bar = el('div', '', 'bar'); const fill = el('div', '', 'fill');
    fill.style.width = `max(3px, ${ratio * 100}%)`;
    bar.append(fill);
    box.append(bar, el('div', `${ratio < 0.01 ? 'Under 1' : Math.round(ratio * 100)}% of the whole ${b.name.toLowerCase()} (${lengthText(whole)})`, 'quiet'));
  }

  const section = (title, ...children) => { const box = el('section'); box.append(el('h4', title), ...children); card.appendChild(box); return box; };
  if (hard.length) {
    section('Why it matters', ...hard.map(([h, i]) => {
      const link = el('button', `⚠ ${h.title}`, 'link why');
      link.title = 'One of the hardest problems in this object; read about it in First principles';
      link.onclick = () => { setTab(true); const h = document.getElementById(`hard-${i}`); h?.open?.(); h?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
      return link;
    }));
  }
  const d = p.details;
  if (d) {
    if (d.howItWorks) section('How it works', el('p', d.howItWorks));
    if (d.madeOf) section('Made of', el('p', d.madeOf));
    if (d.keyNumbers?.length) {
      const ul = el('ul');
      for (const n of d.keyNumbers) { const li = el('li'); li.append(emphasizeNumber(n)); ul.append(li); }
      section('Key numbers', ul);
    }
    if (d.didYouKnow) { const c = el('div', '', 'callout'); c.append(el('h4', 'Did you know?'), el('p', d.didYouKnow)); card.append(c); }
  }
  if (together.length) {
    const chips = el('div', '', 'chips');
    for (const x of together.slice(0, 8)) {
      const chip = el('button', x.name, 'part-link');
      chip.onclick = () => viewer.select(x.id);
      chips.append(chip);
    }
    section('Comes off with', chips);
  }
}

// ---------- Isolating an assembly and following links ----------

function updateIsolation() {
  instruments.update();
  const names = viewer.spotlight.map((id) => state.current.parts.find((p) => p.id === id)?.name).filter(Boolean);
  const label = viewer.isolatedGroup ?? (names.length ? names.join(', ') : null);
  $('isolation').hidden = !label;
  if (label) $('isolation-name').textContent = label;
}
function toggleIsolation(group) {
  viewer.isolate(group && viewer.isolatedGroup !== group ? group : null);
  updateIsolation();
  renderParts();
}
$('isolation-clear').onclick = () => toggleIsolation(null);

/** Shows one assembly on its own and frames it. */
function showGroup(group) {
  viewer.select(null);
  viewer.isolate(group);
  viewer.focus(state.current.parts.filter((p) => p.group === group).map((p) => p.id));
  updateIsolation();
  renderParts();
  if (isNarrow()) closeDrawers();
}
/** Selects one part (or frames several) where it sits now. */
function showParts(ids) {
  viewer.isolate(null);
  if (ids.length === 1) viewer.select(ids[0]); else viewer.setSpotlight(ids);
  updateIsolation();
  viewer.focus(ids);
  renderParts();
  if (isNarrow()) closeDrawers();
}
function followLink(t) { if (t.kind === 'part') showParts([t.value]); else showGroup(t.value); }

// ---------- First principles ----------

// Remembered across objects (and visits) so you can browse the explainers one after another.
let showsPrinciples = store.get(STORE_PRINCIPLES, false) === true;

function setTab(principles) {
  showsPrinciples = principles;
  store.set(STORE_PRINCIPLES, principles);
  renderPrinciples();
}
$('tab-parts').onclick = () => setTab(false);
$('tab-principles').onclick = () => setTab(true);

const SECTIONS = [['fp-problem', 'Problem'], ['fp-principles', 'Principles'], ['fp-buildup', 'Build-up'],
  ['fp-hard', 'Hard parts'], ['fp-xfactor', 'X factor'], ['fp-questions', 'Questions']];

function renderPrinciples() {
  const fp = state.current?.firstPrinciples;
  const on = !!fp && showsPrinciples;
  $('tabs').hidden = !fp;
  $('tab-parts').setAttribute('aria-selected', String(!on));
  $('tab-principles').setAttribute('aria-selected', String(on));
  $('inspector').classList.toggle('principles-mode', on);
  $('principles').hidden = !on;
  if (!on) return;
  const parts = state.current.parts;
  const targets = linkTargets(state.current);
  // Part and assembly names in the text are links into the 3D view.
  const text = (tag, t, cls) => { const e = el(tag, '', cls); e.append(linkify(t, targets, followLink)); return e; };
  const section = (id, title, ...children) => { const s = el('section'); s.id = id; s.append(el('h3', title), ...children); return s; };
  // Explainer text in layers: the takeaway sentence first (bold when more follows), then short paragraphs.
  const layers = (t) => {
    const { lead, rest } = layered(t);
    const seen = new Set();
    const para = (s, cls) => { const p = el('p', '', cls); p.append(richText(s, targets, followLink, seen)); return p; };
    return { lead: para(lead, rest.length ? 'lead' : ''), rest: rest.map((r) => para(r, 'more')) };
  };
  const layeredBlock = (t, cls = 'layers') => { const d = el('div', '', cls); const { lead, rest } = layers(t); d.append(lead, ...rest); return d; };
  const callout = (title, t) => { const d = el('div', '', 'callout'); d.append(el('h4', title), layeredBlock(t)); return d; };
  // A card shows its title and takeaway; the rest of the explanation opens on a click.
  const card = (n, title, t) => {
    const d = el('div', '', 'card');
    const h = el('h4', title);
    h.prepend(el('span', String(n), 'num'));
    const { lead, rest } = layers(t);
    lead.classList.remove('lead');
    d.append(h, lead);
    if (rest.length) {
      const more = el('div', '', 'layers');
      more.hidden = true;
      more.append(...rest);
      const toggle = el('button', 'Read more ▾', 'link read-more');
      toggle.onclick = () => { more.hidden = !more.hidden; toggle.textContent = more.hidden ? 'Read more ▾' : 'Less ▴'; };
      d.open = () => { more.hidden = false; toggle.textContent = 'Less ▴'; };
      d.append(more, toggle);
    }
    return d;
  };
  // A map of the page, so you can see its shape and jump around.
  const jump = el('nav', '', 'jump');
  for (const [id, title] of SECTIONS) {
    const b = el('button', title);
    b.onclick = () => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    jump.append(b);
  }
  const principles = fp.principles.map((p, i) => card(i + 1, p.title, p.explanation));
  const steps = el('ol', '', 'timeline');
  for (const step of fp.buildUp) { const li = el('li'); li.append(layeredBlock(step)); steps.append(li); }
  const hard = fp.hardParts.map((h, i) => {
    const d = card(i + 1, h.title, h.why);
    d.id = `hard-${i}`;
    const chips = el('div', '', 'chips');
    const linked = h.partIDs.map((id) => parts.find((x) => x.id === id)).filter(Boolean);
    for (const p of linked) {
      const link = el('button', `◎ ${p.name}`, 'part-link');
      link.title = 'Show this part';
      link.onclick = () => showParts([p.id]);
      chips.append(link);
    }
    // Hard problems usually live between parts, so frame them all at once too.
    if (linked.length > 1) {
      const all = el('button', '▣ All together', 'part-link');
      all.title = 'Frame all of these parts at once';
      all.onclick = () => showParts(linked.map((p) => p.id));
      chips.append(all);
    }
    if (chips.children.length) d.append(chips);
    return d;
  });
  // Questions: answer in your head, reveal, then mark yourself.
  const marks = new Map();
  const tally = el('span', '', 'tally');
  const updateTally = () => { tally.textContent = marks.size ? `${[...marks.values()].filter(Boolean).length} of ${marks.size} right` : ''; };
  const questions = fp.questions.map((q, i) => {
    const d = el('details', '', 'card');
    const summary = el('summary', q.question);
    const mark = el('span', '', 'mark');
    summary.append(mark);
    const prompt = el('p', 'Think it through, then click to reveal', 'prompt');
    const check = el('div', '', 'self-check');
    check.append(el('span', 'Did you get it?'));
    for (const [label, got] of [['Yes', true], ['Not quite', false]]) {
      const b = el('button', label);
      b.onclick = () => {
        marks.set(i, got);
        mark.textContent = got ? '✓' : '↺';
        mark.className = `mark ${got ? 'yes' : 'no'}`;
        for (const x of check.querySelectorAll('button')) x.classList.toggle('chosen', x === b);
        updateTally();
      };
      check.append(b);
    }
    d.append(summary, prompt, text('p', q.answer, 'answer'), check);
    return d;
  });
  const revealAll = el('button', 'Show all answers', 'link');
  revealAll.onclick = () => {
    const open = revealAll.textContent.startsWith('Show');
    for (const q of questions) q.open = open;
    revealAll.textContent = open ? 'Hide answers' : 'Show all answers';
  };
  const qHead = el('div', '', 'q-head');
  qHead.append(el('h3', 'Test your intuition'), tally, revealAll);
  const qSection = el('section');
  qSection.id = 'fp-questions';
  qSection.append(qHead, el('p', 'Answer each one in your head before you reveal it; committing to a guess is what makes it stick.', 'quiet small'), ...questions);
  const x = callout('The x factor', fp.xFactor);
  x.id = 'fp-xfactor';
  $('principles').replaceChildren(
    jump,
    section('fp-problem', 'The problem', layeredBlock(fp.problem), callout('The core idea', fp.coreIdea)),
    section('fp-principles', 'The principles underneath', ...principles),
    section('fp-buildup', "Why it's built this way", steps),
    section('fp-hard', 'The hardest parts', ...hard),
    x,
    qSection,
  );
  $('principles').scrollTop = 0;
}

viewer.onSelect = (id) => {
  updateIsolation();
  renderCard(id);
  for (const row of document.querySelectorAll('.part-row')) row.classList.toggle('selected', row.dataset.id === id);
  if (id) {
    document.querySelector(`.part-row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (isNarrow()) openDrawer('inspector');
  }
};
$('part-search').oninput = renderParts;

// ---------- Controls ----------

const PLAY_ICONS = {
  apart: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 8 3 3M3 3v4M3 3h4M12 12l5 5M17 17v-4M17 17h-4M12 8l5-5M17 3h-4M17 3v4M8 12l-5 5M3 17h4M3 17v-4"/></svg>',
  together: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3l5 5M8 8H4M8 8V4M17 17l-5-5M12 12h4M12 12v4M17 3l-5 5M12 8h4M12 8V4M3 17l5-5M8 12H4M8 12v4"/></svg>',
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4v12M13 4v12"/></svg>',
};
function updatePlay(playing = !!viewer.playing) {
  const b = $('play');
  const kind = playing ? 'pause' : viewer.explode > 0.5 ? 'together' : 'apart';
  b.innerHTML = PLAY_ICONS[kind];
  const label = { pause: 'Pause', together: 'Put it back together', apart: 'Take it apart' }[kind];
  b.setAttribute('aria-label', label); b.title = `${label} (Space)`;
}
viewer.onPlayChange = updatePlay;
function updateStage() {
  const n = viewer.stages.length, i = viewer.currentStage;
  $('stage-label').textContent = i == null ? (n > 1 ? `Assembled · ${n} layers to take off` : 'Assembled') : `Stage ${i + 1} of ${n} · ${viewer.stages[i].name}`;
  $('stage-prev').disabled = viewer.explode < 0.001;
  $('stage-next').disabled = viewer.explode > 0.999;
}
viewer.onExplodeChange = (t) => { $('explode').value = t; updateStage(); instruments.update(); if (!viewer.playing) updatePlay(false); };
$('stage-prev').onclick = () => viewer.step(-1);
$('stage-next').onclick = () => viewer.step(1);
$('color-groups').onchange = (e) => { viewer.setColorByGroup(e.target.checked); renderParts(); };

// The name of the part under the pointer, so you can find out what things are without clicking each one.
viewer.onHover = (id, x, y) => {
  const label = $('hover-label');
  const p = id && state.current?.parts.find((q) => q.id === id);
  label.hidden = !p;
  if (!p) return;
  label.textContent = p.name;
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
};
$('play').onclick = () => viewer.togglePlay();
$('explode').oninput = (e) => { viewer.stop(); viewer.setExplode(+e.target.value); };
$('guides').onchange = (e) => viewer.setGuides(e.target.checked);
$('reset-view').onclick = () => viewer.fit(true);
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input:not([type=range]):not([type=checkbox]), textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' && !e.target.closest('button, input')) { e.preventDefault(); viewer.togglePlay(); }
  // ← → take it apart a layer at a time; ↑ ↓ step through the parts list.
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); viewer.step(e.key === 'ArrowLeft' ? -1 : 1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const order = groups(state.current).flatMap(([, parts]) => parts);
    if (!order.length) return;
    e.preventDefault();
    const i = order.findIndex((p) => p.id === viewer.selectedId);
    const next = i < 0 ? (e.key === 'ArrowDown' ? 0 : order.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length;
    viewer.select(order[next].id);
  }
});

// ---------- Drawers (narrow screens) and the parts toggle ----------

function openDrawer(which) {
  $(which).classList.add('open');
  $('scrim').hidden = false;
}
function closeDrawers() {
  $('sidebar').classList.remove('open');
  $('inspector').classList.remove('open');
  $('scrim').hidden = true;
}
$('scrim').onclick = closeDrawers;
// The examples list starts closed so the object has the window; this button opens it (a drawer on narrow screens).
$('toggle-sidebar').onclick = () => {
  if (isNarrow()) {
    $('sidebar').classList.contains('open') ? closeDrawers() : (closeDrawers(), openDrawer('sidebar'));
  } else {
    $('sidebar').classList.toggle('hidden');
    $('toggle-sidebar').classList.toggle('active', !$('sidebar').classList.contains('hidden'));
  }
};
$('toggle-inspector').onclick = () => {
  if (isNarrow()) {
    $('inspector').classList.contains('open') ? closeDrawers() : (closeDrawers(), openDrawer('inspector'));
  } else {
    $('inspector').classList.toggle('hidden');
    $('toggle-inspector').classList.toggle('active', !$('inspector').classList.contains('hidden'));
  }
};
$('toggle-inspector').classList.toggle('active', !isNarrow());

// ---------- New object ----------

let photoFile = null;
const apiKey = () => store.get(STORE_KEY, '');

function refreshNewForm() {
  const hasKey = !!apiKey();
  $('need-key').hidden = hasKey;
  $('new-go').disabled = !hasKey || (!$('new-text').value.trim() && !photoFile);
}
function setPhoto(file) {
  photoFile = file && file.type.startsWith('image/') ? file : null;
  const img = $('drop-preview');
  img.hidden = !photoFile;
  $('drop-label').hidden = !!photoFile;
  if (photoFile) img.src = URL.createObjectURL(photoFile);
  refreshNewForm();
}
$('new-object').onclick = () => { refreshNewForm(); $('new-dialog').showModal(); $('new-text').focus(); };
$('new-text').oninput = refreshNewForm;
$('new-photo').onchange = (e) => setPhoto(e.target.files[0]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); setPhoto(e.dataTransfer.files[0]); };
$('new-cancel').onclick = () => $('new-dialog').close();
$('new-settings').onclick = () => openSettings();
$('new-form').onsubmit = async (e) => {
  e.preventDefault();
  const description = $('new-text').value.trim();
  const file = photoFile;
  $('new-dialog').close();
  $('new-text').value = '';
  setPhoto(null);
  const g = { label: description || 'Object from photo', parts: 0, abort: new AbortController() };
  state.generation = g;
  renderLibrary();
  try {
    const imageBase64 = file ? await photoToBase64(file) : null;
    const b = await generate({
      apiKey: apiKey(), description, imageBase64, signal: g.abort.signal,
      onParts: (n) => { g.parts = n; if (state.generation === g) renderLibrary(); },
    });
    if (state.generation !== g) return;
    state.saved.unshift(b);
    if (!store.set(STORE_OBJECTS, state.saved)) console.warn('Could not save to browser storage; the object will be lost on reload.');
    state.generation = null;
    open(b);
  } catch (err) {
    if (g.abort.signal.aborted || state.generation !== g) return;
    g.error = err.message;
    renderLibrary();
  }
};

// ---------- Settings & feedback ----------

function openSettings() {
  $('api-key').value = '';
  $('api-key').placeholder = apiKey() ? 'Saved in this browser' : 'sk-ant-…';
  $('key-remove').hidden = !apiKey();
  $('settings-dialog').showModal();
}
$('open-settings').onclick = openSettings;
$('key-save').onclick = (e) => {
  const v = $('api-key').value.trim();
  if (v) store.set(STORE_KEY, v); else e.preventDefault();
  refreshNewForm();
  if (v) $('settings-dialog').close();
};
$('key-remove').onclick = () => { store.remove(STORE_KEY); $('settings-dialog').close(); refreshNewForm(); };

$('open-feedback').onclick = () => { $('feedback-text').value = ''; $('feedback-dialog').showModal(); };
$('feedback-cancel').onclick = () => $('feedback-dialog').close();
$('feedback-send').onclick = (e) => {
  const text = $('feedback-text').value.trim();
  if (!text) { e.preventDefault(); return; }
  const url = new URL(ISSUES_URL);
  url.searchParams.set('title', `Feedback: ${text.slice(0, 60)}`);
  url.searchParams.set('body', `${text}\n\n— Take It Apart (web), ${navigator.userAgent}`);
  window.open(url, '_blank', 'noopener');
};

// ---------- Start ----------

(async () => {
  const examples = await fetch('data/examples.json').then((r) => r.json());
  state.examples = examples;
  state.saved = state.saved.map(sanitize);
  updatePlay(false);
  $('color-groups').checked = false;
  // For screenshots and links: ?example=rocket&select=s1-lox-tank&explode=1 opens an object in a given state.
  const params = new URLSearchParams(location.search);
  const wanted = params.get('example');
  await open(state.examples.find((e) => e.id === wanted || e.id === `builtin-${wanted}`) ?? state.examples[0]);
  if (params.has('explode')) { viewer.stop(); viewer.setExplode(Math.min(1, Math.max(0, +params.get('explode') || 0))); }
  if (params.has('select')) viewer.select(params.get('select'));
})();
