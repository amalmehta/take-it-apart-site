// Asks Claude to design a blueprint, straight from the browser with the visitor's own API key.
// The prompt, schema and settings come from data/claude-request.json, generated from the Mac app's
// ClaudeClient.swift by scripts/build-web-data.sh, so both apps ask Claude the same thing.

import Anthropic from 'anthropic-sdk';

let template;
async function requestTemplate() {
  template ??= await fetch('data/claude-request.json').then((r) => r.json());
  return template;
}

export class ClaudeError extends Error {}

export function buildBody(tpl, description, imageBase64) {
  const body = structuredClone(tpl);
  const content = [];
  if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } });
  content.push({ type: 'text', text: description ? `Take this apart: ${description}` : 'Identify the main object in this photo and take it apart.' });
  body.messages = [{ role: 'user', content }];
  return body;
}

export function decode(text, source) {
  let g;
  try { g = JSON.parse(text); } catch (e) { throw new ClaudeError(`Couldn't read the design Claude returned (${e.message}).`); }
  return sanitize({ id: crypto.randomUUID(), name: g.name, summary: g.summary, parts: g.parts ?? [], source: source || 'Photo', createdAt: new Date().toISOString() });
}

/** Same repairs as Blueprint.sanitized() in Swift, so a sloppy response never breaks rendering. */
export function sanitize(b) {
  const seen = new Set();
  const vec3 = (v) => [0, 1, 2].map((i) => (Array.isArray(v) && Number.isFinite(v[i]) ? v[i] : 0));
  const nums = (v) => (Array.isArray(v) ? v.map((x) => (Number.isFinite(x) ? x : 0)) : []);
  b.parts = (b.parts || []).map((p, i) => {
    let id = String(p.id || '').trim() || `part-${i}`;
    while (seen.has(id)) id += `-${i}`;
    seen.add(id);
    return {
      ...p, id,
      name: p.name || `Part ${i + 1}`, group: p.group || 'Parts', description: p.description || '',
      dims: nums(p.dims), points: nums(p.points),
      position: vec3(p.position), rotation: vec3(p.rotation), explode: vec3(p.explode),
      step: Math.max(0, Math.min(p.step | 0, 20)), radialCount: Math.max(1, Math.min(p.radialCount | 0 || 1, 36)),
    };
  });
  return b;
}

export async function generate({ apiKey, description, imageBase64, onParts, signal }) {
  if (!apiKey) throw new ClaudeError('Add your Anthropic API key in Settings first.');
  const body = buildBody(await requestTemplate(), description, imageBase64);
  delete body.stream;
  // The key never leaves this browser except to go straight to Anthropic.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let text = '';
  let lastCount = 0;
  let message;
  try {
    const stream = client.beta.messages.stream({ ...body, betas: ['server-side-fallback-2026-07-01'] }, { signal });
    stream.on('text', (delta) => {
      text += delta;
      const count = text.split('"radialCount"').length - 1;
      if (count !== lastCount) { lastCount = count; onParts?.(count); }
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new ClaudeError('That API key was rejected. Check it in Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new ClaudeError('Rate limited by the Claude API. Wait a minute and try again.');
    if (e instanceof Anthropic.APIError) throw new ClaudeError(`Claude API error ${e.status ?? ''}: ${e.message}`);
    throw new ClaudeError(`Couldn't reach the Claude API (${e.message}).`);
  }
  if (message.stop_reason === 'refusal') throw new ClaudeError(`Claude declined this request. ${message.stop_details?.explanation ?? ''}`);
  if (message.stop_reason === 'max_tokens') throw new ClaudeError('The design ran out of room before it finished. Try a simpler object.');
  const json = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return decode(json, description);
}

/** Downsizes a photo to at most 1568 px on the long edge and returns base64 JPEG. */
export async function photoToBase64(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}
