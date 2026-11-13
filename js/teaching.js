// Teaching aids built from a blueprint's data: named disassembly stages, links from prose to parts,
// real-world sizes and a colour per assembly. Mirrors Sources/TakeItApart/Teaching.swift.

// ---------- Stages ----------

/** One stage per distinct `step`, in order, named after its (at most two) biggest assemblies. */
export function stagesOf(b) {
  const steps = [...new Set(b.parts.map((p) => p.step | 0))].sort((x, y) => x - y);
  return steps.map((step) => {
    const parts = b.parts.filter((p) => (p.step | 0) === step);
    const counts = new Map();
    for (const p of parts) counts.set(p.group, (counts.get(p.group) ?? 0) + Math.max(1, p.radialCount | 0));
    const order = [...counts.keys()];
    const groups = order.map((g, i) => [g, i]).sort((a, c) => counts.get(c[0]) - counts.get(a[0]) || a[1] - c[1]).slice(0, 2).map(([g]) => g);
    return { step, groups, name: groups.join(', '), partIds: parts.map((p) => p.id) };
  });
}

/** Stages come off one after another, each in its own equal slice of the explode amount, so stopping
 * between slices always shows clean layers. How far (0…1) stage `index` of `count` has moved at `t`. */
export function stageProgress(index, count, t) {
  if (!count) return 0;
  const p = Math.min(1, Math.max(0, t * count - index));
  return p * p * (3 - 2 * p);
}

/** The explode amount at which the first `done` stages have fully come off and the rest haven't moved. */
export function explodeAfter(done, count) { return count ? done / count : 0; }

// ---------- Links from prose to the model ----------

/** Part and assembly names worth linking, longest first so "rear wheel" wins over "wheel". */
export function linkTargets(b) {
  const out = [], seen = new Set();
  const add = (name, kind, value) => {
    const key = name.toLowerCase();
    if (key.length < 4 || seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, value });
  };
  for (const p of b.parts) add(p.group, 'group', p.group);
  for (const p of b.parts) add(p.name, 'part', p.id);
  return out.sort((a, c) => c.name.length - a.name.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A fragment with the first mention of each part or assembly name turned into a link button. */
export function linkify(text, targets, onLink, seen = null) {
  const taken = [];
  for (const t of targets) {
    if (seen?.has(t.name)) continue;
    const m = new RegExp(`\\b${escapeRe(t.name)}s?\\b`, 'i').exec(text);
    if (!m) continue;
    const a = m.index, z = a + m[0].length;
    if (taken.some((r) => a < r.z && z > r.a)) continue;
    taken.push({ a, z, t });
    seen?.add(t.name);
  }
  taken.sort((x, y) => x.a - y.a);
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const { a, z, t } of taken) {
    frag.append(text.slice(at, a));
    const link = document.createElement('button');
    link.className = 'inline-link';
    link.textContent = text.slice(a, z);
    link.title = t.kind === 'part' ? 'Show this part' : `Show only the ${t.value}`;
    link.onclick = () => onLink(t);
    frag.append(link);
    at = z;
  }
  frag.append(text.slice(at));
  return frag;
}

// ---------- Layered reading ----------
// Mirrors Teaching.layered in the Mac app: the opening sentence as the takeaway, the rest as short paragraphs of one
// or two sentences, and quantities with units in bold. Nothing is cut; only the layout changes.

const UNIT = '%|°C|°F|°|km/s|km/h|m/s|mph|kWh|Wh|MW|kW|GW|W|kV|V|mA|A|GHz|MHz|kHz|Hz|rpm|bar|atm|psi|tonnes?|kg|g|km|cm|mm|µm|nm|m|K|litres?|L|ml|times';
const QUANTITY = new RegExp(`(?<![\\w.])[−-]?[0-9][0-9,]*(?:\\.[0-9]+)?(?:\\s?(?:to|–|-)\\s?[0-9][0-9,]*(?:\\.[0-9]+)?)?\\s?(?:${UNIT})(?![A-Za-z0-9])`, 'g');

function sentences(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  }
  return text.match(/[^.!?]+(?:[.!?]+(?=\s+[A-Z]|\s*$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

/** { lead, rest } strings: the first sentence, then the others paired into short paragraphs. */
export function layered(text) {
  const s = sentences(text);
  const rest = [];
  for (let i = 1; i < s.length; ) {
    if (i + 1 < s.length && s[i].length + 1 + s[i + 1].length < 240) { rest.push(`${s[i]} ${s[i + 1]}`); i += 2; }
    else { rest.push(s[i]); i += 1; }
  }
  return { lead: s[0] ?? text, rest };
}

/** Linked text (as linkify) with quantities that carry the argument in bold. */
export function richText(text, targets, onLink, seen) {
  const frag = linkify(text, targets, onLink, seen);
  for (const node of [...frag.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const t = node.textContent;
    const out = document.createDocumentFragment();
    let at = 0;
    for (const m of t.matchAll(QUANTITY)) {
      out.append(t.slice(at, m.index));
      const b = document.createElement('strong');
      b.className = 'qty';
      b.textContent = m[0];
      out.append(b);
      at = m.index + m[0].length;
    }
    if (at === 0) continue;
    out.append(t.slice(at));
    node.replaceWith(out);
  }
  return frag;
}

// ---------- Key numbers ----------

/** A fragment with the first number or range in a key-number line (and its unit) in bold. */
export function emphasizeNumber(line) {
  const frag = document.createDocumentFragment();
  const m = /[0-9][0-9,.]*(\s?(to|–|-)\s?[0-9][0-9,.]*)?(\s?(%|°C|°|[A-Za-zµΩ/²³]+))?/.exec(line);
  if (!m) { frag.append(line); return frag; }
  const b = document.createElement('strong');
  b.textContent = m[0];
  frag.append(line.slice(0, m.index), b, line.slice(m.index + m[0].length));
  return frag;
}

// ---------- Real size ----------

/** "6 mm", "4.2 cm", "1.3 m", "120 m" from metres. */
export function lengthText(m) {
  const fmt = (v, unit) => `${v >= 10 ? Math.round(v) : (Math.round(v * 10) / 10).toString()} ${unit}`;
  if (m < 0.01) return fmt(m * 1000, 'mm');
  if (m < 1) return fmt(m * 100, 'cm');
  if (m < 1000) return fmt(m, 'm');
  return fmt(m / 1000, 'km');
}

const YARDSTICKS = [
  ['a grain of rice', 0.006], ['a fingernail', 0.012], ['a coin', 0.025], ['a matchbox', 0.05],
  ['a credit card', 0.085], ['a smartphone', 0.15], ['a school ruler', 0.3], ['a guitar', 1.0],
  ['a person', 1.75], ['a car', 4.5], ['a bus', 12], ['a tennis court', 24], ['a football pitch', 105],
];

/** "about the size of a credit card", when one is within a factor of about 1.6. */
export function comparison(m) {
  if (!(m > 0)) return null;
  let best = null;
  for (const y of YARDSTICKS) if (!best || Math.abs(Math.log(y[1] / m)) < Math.abs(Math.log(best[1] / m))) best = y;
  return Math.abs(Math.log(best[1] / m)) < Math.log(1.6) ? `about the size of ${best[0]}` : null;
}

// ---------- Assembly colours ----------

export const PALETTE = ['#4e9af1', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#edc948',
  '#76b7b2', '#ff9da7', '#9c755f', '#86bcb6', '#d37295', '#a0cbe8'];
export const groupColor = (i) => PALETTE[i % PALETTE.length];
