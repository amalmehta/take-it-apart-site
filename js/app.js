// Page wiring: object library, parts inspector, dialogs.
import { Viewer } from './viewer.js';
import { MATERIAL_NAMES } from './shapes.js';
import { generate, photoToBase64, sanitize } from './claude.js';

const $ = (id) => document.getElementById(id);
const ISSUES_URL = 'https://github.com/amalmehta/take-it-apart-site/issues/new';
const STORE_OBJECTS = 'take-it-apart.objects';
const STORE_KEY = 'take-it-apart.api-key';

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
};

const viewer = new Viewer($('viewport'));
window.takeItApart = { viewer }; // handy from the console, and used to capture README screenshots
const isNarrow = () => matchMedia('(max-width: 820px)').matches;

// ---------- Library ----------

function pieceCount(b) { return b.parts.reduce((n, p) => n + Math.max(1, p.radialCount | 0), 0); }
function groups(b) {
  const map = new Map();
  for (const p of b.parts) { if (!map.has(p.group)) map.set(p.group, []); map.get(p.group).push(p); }
  return [...map];
}

function objectItem(b, removable) {
  const li = document.createElement('li');
  li.tabIndex = 0;
  li.className = state.current?.id === b.id ? 'selected' : '';
  li.innerHTML = `<span class="name"></span><span class="meta">${pieceCount(b)} pieces · ${groups(b).length} assemblies</span>`;
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

function open(b) {
  state.current = b;
  $('object-name').textContent = b.name;
  $('object-sub').textContent = `${pieceCount(b)} pieces`;
  document.title = `${b.name} — Take It Apart`;
  $('summary').textContent = b.summary;
  $('overview').hidden = !b.overview;
  $('overview-text').replaceChildren(...(b.overview || '').split(/\n\s*\n/).filter(Boolean).map((t) => {
    const para = document.createElement('p');
    para.textContent = t.trim();
    return para;
  }));
  $('part-search').value = '';
  viewer.load(b);
  renderLibrary();
  renderParts();
  renderCard(null);
  closeDrawers();
  setTimeout(() => { if (state.current === b && viewer.explode === 0) viewer.animateTo(1, 3200); }, 500);
}

// ---------- Parts inspector ----------

function renderParts() {
  const b = state.current;
  const q = $('part-search').value.trim().toLowerCase();
  const out = [];
  for (const [group, parts] of groups(b)) {
    const hits = q ? parts.filter((p) => p.name.toLowerCase().includes(q) || group.toLowerCase().includes(q)) : parts;
    if (!hits.length) continue;
    const h = document.createElement('h2');
    h.textContent = group;
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
  }
  $('parts').replaceChildren(...out);
}

function renderCard(id) {
  const card = $('part-card');
  const p = id && state.current.parts.find((x) => x.id === id);
  card.hidden = !p;
  $('about').hidden = !!p;
  if (!p) return;
  card.innerHTML = `
    <div class="head"><h3></h3><button class="link" id="card-close" aria-label="Close">✕</button></div>
    <p></p>
    <dl>
      <dt>Assembly</dt><dd class="g"></dd>
      ${p.details ? '' : `<dt>Material</dt><dd>${MATERIAL_NAMES[p.material] ?? p.material}</dd>`}
      ${p.radialCount > 1 ? `<dt>Count</dt><dd>${p.radialCount}</dd>` : ''}
      <dt>Comes off</dt><dd>Stage ${(p.step | 0) + 1}</dd>
    </dl>
    <button id="card-zoom">Zoom to Part</button>`;
  card.querySelector('h3').textContent = p.name;
  card.querySelector('p').textContent = p.description;
  card.querySelector('.g').textContent = p.group;
  $('card-close').onclick = () => viewer.select(null);
  $('card-zoom').onclick = () => { viewer.focus(p.id); if (isNarrow()) closeDrawers(); };
  const d = p.details;
  if (d) {
    const section = (title, body) => {
      if (!body || (Array.isArray(body) && !body.length)) return;
      const box = document.createElement('section');
      const h = document.createElement('h4');
      h.textContent = title;
      box.appendChild(h);
      if (Array.isArray(body)) {
        const ul = document.createElement('ul');
        for (const item of body) { const li = document.createElement('li'); li.textContent = item; ul.appendChild(li); }
        box.appendChild(ul);
      } else {
        const para = document.createElement('p');
        para.textContent = body;
        box.appendChild(para);
      }
      card.appendChild(box);
    };
    section('How it works', d.howItWorks);
    section('Made of', d.madeOf);
    section('Key numbers', d.keyNumbers);
    section('Did you know?', d.didYouKnow);
  }
}

viewer.onSelect = (id) => {
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
viewer.onExplodeChange = (t) => { $('explode').value = t; if (!viewer.playing) updatePlay(false); };
$('play').onclick = () => viewer.togglePlay();
$('explode').oninput = (e) => { viewer.stop(); viewer.setExplode(+e.target.value); };
$('guides').onchange = (e) => viewer.setGuides(e.target.checked);
$('reset-view').onclick = () => viewer.fit();
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest('input, textarea, dialog, button')) { e.preventDefault(); viewer.togglePlay(); }
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
$('toggle-sidebar').onclick = () => ($('sidebar').classList.contains('open') ? closeDrawers() : (closeDrawers(), openDrawer('sidebar')));
$('toggle-inspector').onclick = () => {
  if (isNarrow()) {
    $('inspector').classList.contains('open') ? closeDrawers() : (closeDrawers(), openDrawer('inspector'));
  } else {
    $('inspector').classList.toggle('hidden');
    syncInspectorToggle();
  }
};
const syncInspectorToggle = () =>
  $('toggle-inspector').classList.toggle('active', !isNarrow() && !$('inspector').classList.contains('hidden'));
syncInspectorToggle();
// Drawers only exist on narrow screens; drop them (and the scrim) when the layout widens.
matchMedia('(max-width: 820px)').addEventListener('change', (e) => {
  if (!e.matches) closeDrawers();
  syncInspectorToggle();
});

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
  state.examples = examples.map(sanitize);
  state.saved = state.saved.map(sanitize);
  updatePlay(false);
  open(state.examples[0]);
})();
