// X Archive phone app, Search (0.9.5). Searches the archive with the computer asleep: the computer publishes
// its meaning data files to the phone-data branch of your private bookmark-archive repository (the same key as
// sharing reads them), the phone keeps them, and searches them by meaning (with the same model as the computer,
// downloaded once) and by words. Gemini can answer from the best passages, with your own free key.
const MODELS = {
  'Xenova/bge-m3': { prefix: '', pooling: 'cls', mb: 570 },
  'Xenova/multilingual-e5-small': { prefix: 'query: ', pooling: 'mean', mb: 120 },
  'Xenova/multilingual-e5-large': { prefix: 'query: ', pooling: 'mean', mb: 560 },
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': { prefix: '', pooling: 'mean', mb: 120 },
};
const BRANCH = 'phone-data';
const STEP = 25;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nGB = (x) => Number(x || 0).toLocaleString('en-GB');

// ---------- Storage on the phone ----------
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('xa-phone-search', 1);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('parts')) d.createObjectStore('parts', { keyPath: 'name' }); if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const rq = (q) => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
async function st(name, mode = 'readonly') { return (await openDb()).transaction(name, mode).objectStore(name); }
async function kvGet(k, d = null) { const r = await rq((await st('kv')).get(k)); return r ? r.v : d; }
async function kvSet(k, v) { await rq((await st('kv', 'readwrite')).put({ k, v })); }
async function partsAll() { return rq((await st('parts')).getAll()); }
async function partPut(p) { await rq((await st('parts', 'readwrite')).put(p)); }
async function partDel(name) { await rq((await st('parts', 'readwrite')).delete(name)); }

// ---------- GitHub: the phone-data branch ----------
async function gh(path, accept = 'application/vnd.github+json') {
  const cfg = await XA.getSettings();
  if (!cfg.token) throw new Error('no GitHub key yet: open Settings below and paste it (the same key as for sharing)');
  let r;
  try { r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/${path}`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' }); }
  catch { throw new Error('no internet just now; the data already on the phone still works'); }
  if (r.status === 404) throw new Error('no search data on GitHub yet: the computer publishes it after its first complete reading (PublishToGitHub.bat)');
  if (r.status === 401) throw new Error('GitHub did not accept the key (wrong, or expired)');
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r;
}
// A file's bytes from GitHub: raw when GitHub sends it raw, otherwise from the JSON copy (base64).
async function blobBytes(sha) {
  const r = await gh(`git/blobs/${sha}`, 'application/vnd.github.raw+json');
  if (/json/i.test(r.headers.get('Content-Type') || '')) {
    const j = await r.json();
    if (j && typeof j.content === 'string') { const bin = atob(j.content.replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
    return new TextEncoder().encode(JSON.stringify(j));
  }
  return new Uint8Array(await r.arrayBuffer());
}
// Downloads only the files that changed since last time. Returns a line saying what happened.
async function update(force = false) {
  const tree = await (await gh(`git/trees/${BRANCH}`)).json();
  const files = (tree.tree || []).filter((x) => x.type === 'blob');
  const man = files.find((x) => x.path === 'meaning.json');
  if (!man) throw new Error('the search data on GitHub is incomplete (no meaning.json)');
  const manifest = JSON.parse(new TextDecoder().decode(await blobBytes(man.sha)));
  const have = new Map((await partsAll()).map((p) => [p.name, p]));
  const want = manifest.parts.map((p) => ({ ...p, sha: (files.find((f) => f.path === p.name) || {}).sha })).filter((p) => p.sha);
  const todo = want.filter((p) => force || !have.has(p.name) || have.get(p.name).sha !== p.sha);
  const mb = todo.reduce((a, p) => a + (p.bytes || 0), 0) / 1048576;
  let n = 0;
  for (const p of todo) {
    status(`Downloading the search data: ${++n} of ${todo.length} (${mb.toFixed(1)} MB in all)…`);
    const bytes = await blobBytes(p.sha);
    await partPut({ name: p.name, sha: p.sha, bytes, items: p.items });
  }
  for (const name of have.keys()) if (!want.some((p) => p.name === name)) await partDel(name);
  await kvSet('manifest', manifest);
  await kvSet('checkedAt', new Date().toISOString());
  return todo.length ? `Updated: ${todo.length} file${todo.length === 1 ? '' : 's'} (${mb.toFixed(1)} MB).` : 'Already up to date.';
}

// ---------- Reading the files ----------
const MAGIC = 'XAMD1\n';
async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
const D = { items: [], byId: new Map(), parts: [], dims: 0, model: '', rows: 0, made: '', hay: new Map(), df: new Map() };
async function loadData() {
  const parts = await partsAll();
  D.items = []; D.byId = new Map(); D.parts = []; D.rows = 0; D.hay = new Map(); D.df = new Map();
  for (const p of parts.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const raw = await gunzip(p.bytes);
    if (new TextDecoder().decode(raw.subarray(0, 6)) !== MAGIC) continue;
    const n = new DataView(raw.buffer, raw.byteOffset).getUint32(6, true);
    const header = JSON.parse(new TextDecoder().decode(raw.subarray(10, 10 + n)));
    const vec = new Int8Array(raw.buffer.slice(raw.byteOffset + 10 + n, raw.byteOffset + raw.length));
    D.dims = header.dims; D.model = header.model;
    const part = { vec, scales: [], rowItem: [], rowChunk: [] };
    for (const it of header.items) {
      it.part = D.parts.length; it.row0 = part.scales.length;
      it.chunks.forEach((c, i) => { part.scales.push(it.scales[i]); part.rowItem.push(it); part.rowChunk.push(i); });
      D.items.push(it); D.byId.set(it.id, it);
    }
    part.scales = Float32Array.from(part.scales);
    D.parts.push(part); D.rows += part.scales.length;
  }
  const man = await kvGet('manifest');
  D.made = man ? man.made : '';
  return D.items.length;
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
function hayOf(it) { if (!D.hay.has(it.id)) D.hay.set(it.id, norm([it.title, it.who, ...it.chunks.map((c) => c.text)].join('\n'))); return D.hay.get(it.id); }

// ---------- The model, in its own thread ----------
let worker = null, wid = 0;
const waits = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('phone-embed.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'progress') { $('#modelNote').textContent = `Downloading the meaning model: ${Math.round(m.loaded / 1048576)} of ${Math.round(m.total / 1048576)} MB (once only; keep the app open)`; return; }
    const w = waits.get(m.id);
    if (!w) return;
    waits.delete(m.id);
    if (m.type === 'error') w.rej(new Error(m.error)); else w.res(m);
  };
  return worker;
}
function call(msg) { const id = ++wid; return new Promise((res, rej) => { waits.set(id, { res, rej }); getWorker().postMessage({ ...msg, id }); }); }
async function embedQuery(q) {
  const m = MODELS[D.model] || MODELS['Xenova/bge-m3'];
  const r = await call({ type: 'embed', model: D.model, prefix: m.prefix, pooling: m.pooling, texts: [q] });
  return r.data;
}

// ---------- Searching ----------
const STOP = new Set('a an and are as at be but by for from has have he her his i in into is it its me my no not of on or our she so that the their them they this to was we were what when where which who why will with you your about after before more most some than then there these those also only very just like give show find any all one two idea ideas thing things something anything stuff kind sort type really tell please need want looking look list example examples post posts tweet tweets article articles latest recent news'.split(' '));
function termsOf(q) {
  const words = [...new Set((norm(q).match(/[\p{L}\p{N}]+/gu) || []).filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)))];
  const N = D.items.length || 1;
  const df = (t) => { if (!D.df.has(t)) { let n = 0; for (const it of D.items) if (hayOf(it).includes(t)) n++; D.df.set(t, n); } return D.df.get(t); };
  return words.map((t) => ({ t, w: Math.log(1 + N / (1 + df(t))), rare: df(t) / N < 0.02 }));
}
const S = { q: '', results: [], shown: STEP, gem: null };
async function search(q) {
  S.q = q; S.shown = STEP; S.gem = null; renderGem();
  const kind = $('#pKind').value;
  let qv = null;
  if (await kvGet('modelOn', false)) {
    try { status('Searching…'); qv = await embedQuery(q); } catch (e) { status(`Meaning search is not available just now (${e.message}); searching by words.`); }
  }
  const T = termsOf(q);
  const wsum = T.reduce((a, x) => a + x.w, 0) || 1;
  const best = new Map();
  if (qv) {
    const d = D.dims;
    for (const part of D.parts) {
      const v = part.vec, n = part.scales.length;
      for (let r = 0; r < n; r++) {
        let s = 0;
        const off = r * d;
        for (let i = 0; i < d; i++) s += qv[i] * v[off + i];
        s *= part.scales[r];
        const it = part.rowItem[r];
        const b = best.get(it.id);
        if (!b || s > b.s) best.set(it.id, { s, c: part.rowChunk[r] });
      }
    }
  }
  const sorted = [...best.values()].map((b) => b.s).sort((a, b) => b - a);
  const spread = sorted.length > 20 ? sorted[0] - sorted[Math.min(sorted.length - 1, 200)] : 0.1;
  const lexW = Math.max(0.03, spread * 0.8);
  const base = sorted.length ? sorted[Math.floor(sorted.length * 0.25)] : 0.5;
  const recent = /\b(latest|recent|recently|today|this week|this month|new|newest|now)\b/i.test(q);
  const now = Date.now();
  const out = [];
  for (const it of D.items) {
    if (kind !== 'all' && it.kind !== kind) continue;
    const b = best.get(it.id);
    const hay = hayOf(it);
    let got = 0, rare = false;
    for (const x of T) if (hay.includes(x.t)) { got += x.w; if (x.rare) rare = true; }
    const lex = T.length ? got / wsum : 0;
    if (!b && (!T.length || lex < (qv ? 0.99 : 0.5))) continue;
    let score = (b ? b.s : base) + lex * lexW * (rare ? 1.5 : 1);
    const t = Date.parse(it.date || it.saved || '') || 0;
    if (recent && t) score += 0.04 * Math.exp(-(now - t) / (30 * 864e5));
    let c = b ? b.c : 0;
    if (!b && T.length) { c = Math.max(0, it.chunks.findIndex((x) => T.some((y) => norm(x.text).includes(y.t)))); }
    out.push({ it, score, meaning: b ? b.s : null, c });
  }
  out.sort((a, b) => b.score - a.score);
  S.results = out;
  status(`${nGB(out.length)} found${qv ? '' : ' by words (turn on meaning search in Settings for searches by meaning)'}.`);
  render();
}
function render() {
  const words = termsOf(S.q).map((x) => x.t);
  const mark = (t) => { let h = esc(t); for (const w of words.filter((x) => x.length > 2).sort((a, b) => b.length - a.length)) h = h.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>'); return h; };
  const list = S.results.slice(0, S.shown);
  $('#pResults').innerHTML = list.map(({ it, meaning, c }) => {
    const ch = it.chunks[c] || it.chunks[0] || { text: '' };
    return `<div class="res" data-id="${esc(it.id)}"><div class="rmeta"><b class="rid">${esc(it.id)}</b> ${esc(it.who)}${it.date ? ` · ${esc(it.date)}` : ''}${meaning !== null ? ` · match ${meaning.toFixed(2)}` : ''}</div>
      ${it.title ? `<div><b>${esc(it.title)}</b></div>` : ''}<div class="rtext">${ch.src === 'notes' ? '<i>Your note:</i> ' : ch.src === 'translation' ? '<i>Translation:</i> ' : ''}${mark(ch.text)}</div>
      <div><a href="${esc(it.url)}" target="_blank" rel="noopener">${it.kind === 'article' ? 'Open article' : 'Open on X'} ↗</a></div></div>`;
  }).join('') + (S.results.length > S.shown ? `<button class="ghost" id="pMore">Show ${STEP} more</button>` : '');
  const m = $('#pMore');
  if (m) m.onclick = () => { S.shown += STEP; render(); };
}

// ---------- Gemini ----------
const API = 'https://generativelanguage.googleapis.com/v1beta';
const SYSTEM = (today) => `You answer questions about the user's private research archive of saved X (Twitter) posts and web articles. The user is a novelist researching material for fiction.
Use only the passages given. Each passage starts with its item ID in square brackets, like [XA-0412] or [WA-0031].
Cite every point with the ID or IDs it rests on, in square brackets, for example [XA-0412] or [XA-0412, WA-0031]. Never invent an ID.
Some passages contain leftover website text (menus, subscription or paywall notices, cookie notices, comment prompts, "published automatically"): ignore that text.
If the passages do not answer the question, say so plainly, then say briefly what they do contain.
Answer in English, even where passages are in Hindi, Urdu or other languages; you may quote a short original phrase with its meaning.
Lead with the answer, then the supporting points. Prefer the newest items when the question asks for the latest. Keep it under about 300 words unless asked for more; this is read on a phone.
Today is ${today}.`;
function pickModel(names) {
  const ver = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const odd = /image|tts|audio|live|embedding|thinking|vision|robotics|computer|native|aqa|learnlm|gemma/i;
  const flash = names.filter((n) => /gemini-[\d.]+-flash/.test(n) && !odd.test(n));
  const by = (l) => l.sort((a, b) => ver(b) - ver(a) || a.length - b.length)[0] || '';
  return by(flash.filter((n) => !/lite|preview|exp/i.test(n))) || by(flash.filter((n) => !/lite/i.test(n))) || by(flash) || '';
}
async function gemProblem(r) {
  let j = null; try { j = await r.json(); } catch { /* ignore */ }
  const msg = (j && j.error && j.error.message) || '', det = JSON.stringify((j && j.error && j.error.details) || []);
  if (r.status === 429) return /PerDay|per day|daily/i.test(det + msg) ? 'Gemini\'s free allowance for today is used up (it resets at midnight Pacific time, about 12:30 or 1:30 pm in India).' : 'Gemini\'s free limit per minute was reached; try again in a minute.';
  if (r.status === 400 && /api key/i.test(msg)) return 'Google did not accept the Gemini key; check it in Settings.';
  if (r.status === 404) return 'That Gemini model is no longer offered; press Save and test in Settings to choose the current one.';
  if (r.status >= 500) return 'Gemini is busy just now; try again in a minute.';
  return `Gemini answered ${r.status}${msg ? `: ${msg}` : ''}.`;
}
function gemPassages(n, withNotes) {
  const L = []; let chars = 0;
  for (const [i, x] of S.results.slice(0, n).entries()) {
    const it = x.it;
    let first = it.chunks[x.c] || it.chunks[0] || { text: '', src: 'text' };
    if (first.src === 'notes' && !withNotes) first = it.chunks.find((c) => c.src !== 'notes') || { text: it.title || '', src: 'text' };
    const parts = [first.src === 'notes' ? `(The user's own note) ${first.text}` : first.text];
    for (const c of it.chunks) {
      if (parts.some((p) => p.includes(c.text))) continue;
      if (c.src === 'notes') { if (withNotes) parts.push(`(The user's own note) ${c.text}`); }
      else if (c.src === 'translation') parts.push(`(Translation) ${c.text}`);
      else if (i < 30 && parts.length < 3) parts.push(c.text);
    }
    const line = `[${it.id}] ${it.who || (it.kind === 'article' ? 'web page' : 'post')}${it.title ? `, "${it.title.slice(0, 140)}"` : ''}${it.date ? `, ${it.date}` : ''}: ${parts.filter(Boolean).join(' … ').slice(0, i < 30 ? 2400 : 900)}`;
    if (chars + line.length > 140000) break;
    L.push(line); chars += line.length;
  }
  return { text: L.join('\n\n'), count: L.length };
}
async function gemAsk(follow = '') {
  const key = await kvGet('geminiKey', ''), model = await kvGet('geminiModel', '');
  if (!key || !model) { $('#gemNote').textContent = 'No Gemini key yet: add it in Settings below.'; return; }
  if (!S.results.length) { $('#gemNote').textContent = 'Search first.'; return; }
  const withNotes = $('#pNotes').checked;
  const first = !S.gem;
  const pp = gemPassages(first ? 150 : 60, withNotes);
  const opening = `Question: ${S.q}\n\nPassages from the archive (${pp.count}, best match first):\n\n${pp.text}`;
  const contents = [{ role: 'user', text: opening }, ...(first ? [] : [...S.gem.turns, { role: 'user', text: follow }])];
  $('#gemNote').textContent = `Asking ${model}…`;
  $('#gemAsk').disabled = true;
  try {
    let r;
    try { r = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM(new Date().toISOString().slice(0, 10)) }] }, contents: contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] })), generationConfig: { temperature: 0.3, maxOutputTokens: 4096 } }) }); }
    catch { throw new Error('Gemini could not be reached (no internet just now?).'); }
    if (!r.ok) throw new Error(await gemProblem(r));
    const j = await r.json();
    const cand = (j.candidates || [])[0];
    const text = cand && cand.content ? (cand.content.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('') : '';
    if (!text) throw new Error(`Gemini gave no answer (${(cand && cand.finishReason) || 'blocked'}).`);
    if (first) S.gem = { turns: [{ role: 'model', text }] }; else S.gem.turns.push({ role: 'user', text: follow }, { role: 'model', text });
    $('#gemNote').textContent = `${model}, ${pp.count} passages${withNotes ? ', with your notes' : ''}.`;
    renderGem();
  } catch (e) { $('#gemNote').textContent = e.message; }
  finally { $('#gemAsk').disabled = false; }
}
function renderGem() {
  const box = $('#gemChat');
  if (!S.gem) { box.hidden = true; $('#gemFollowBox').hidden = true; return; }
  box.hidden = false; $('#gemFollowBox').hidden = false;
  box.innerHTML = S.gem.turns.map((t) => `<div class="turn ${t.role}">${t.role === 'user' ? '<b>You:</b> ' : ''}${esc(t.text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\b(XA|WA)-\d+\b/gi, (m) => `<a data-goto="${m.toUpperCase()}">${m.toUpperCase()}</a>`)}</div>`).join('');
}

// ---------- The page ----------
function status(t) { $('#pStatus').textContent = t; }
async function dataLine() {
  const man = await kvGet('manifest'), at = await kvGet('checkedAt', '');
  $('#dataNote').textContent = D.items.length ? `On this phone: ${nGB(D.items.length)} items, made on the computer ${String(D.made || '').slice(0, 16).replace('T', ' ')}${man ? ` with ${String(man.model).split('/').pop()}` : ''}; last checked ${at ? at.slice(0, 16).replace('T', ' ') : 'never'}.` : 'No search data on this phone yet: press Update.';
  const on = await kvGet('modelOn', false);
  const m = MODELS[D.model] || MODELS['Xenova/bge-m3'];
  $('#modelNote').textContent = on ? `Meaning search is on (${String(D.model || 'Xenova/bge-m3').split('/').pop()}, kept on this phone).` : `Meaning search is off: searches use words only. Turning it on downloads the model once (about ${m.mb} MB): use Wi-Fi.`;
  $('#modelOn').textContent = on ? 'Turn meaning search off' : 'Turn on meaning search (download)';
  const g = await kvGet('geminiKey', '');
  $('#gKeyNote').textContent = g ? `Gemini key kept on this phone; answers use ${await kvGet('geminiModel', '(not chosen)')}.` : 'No Gemini key yet.';
}
async function doUpdate(force = false) {
  try { status(await update(force)); } catch (e) { status(e.message); }
  await loadData().catch((e) => status(`The search data could not be read: ${e.message}`));
  dataLine();
}
export async function initSearch() {
  try { navigator.storage && navigator.storage.persist && await navigator.storage.persist(); } catch { /* ignore */ }
  await loadData().catch(() => {});
  dataLine();
  // Look for new data once every 6 hours when the app opens (only changed files are downloaded).
  const at = await kvGet('checkedAt', '');
  if (!at || Date.now() - Date.parse(at) > 6 * 3600e3) doUpdate();
  $('#pGo').onclick = () => { const q = $('#pQ').value.trim(); if (q) search(q); };
  $('#pQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#pGo').click(); } });
  $('#pUpdate').onclick = () => doUpdate();
  $('#gemAsk').onclick = () => { S.gem = null; gemAsk(); };
  $('#gemSend').onclick = () => { const t = $('#gemFollow').value.trim(); if (t && S.gem) { $('#gemFollow').value = ''; gemAsk(t); } };
  $('#gemChat').addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (!a) return; const el = document.querySelector(`.res[data-id="${a.dataset.goto}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); else { const it = D.byId.get(a.dataset.goto); if (it) window.open(it.url, '_blank'); } });
  $('#modelOn').onclick = async () => {
    if (await kvGet('modelOn', false)) { await kvSet('modelOn', false); dataLine(); return; }
    if (!D.model) { $('#modelNote').textContent = 'Update the search data first.'; return; }
    $('#modelOn').disabled = true;
    try { await call({ type: 'load', model: D.model }); await kvSet('modelOn', true); }
    catch (e) { $('#modelNote').textContent = `The model could not be loaded: ${e.message}`; }
    $('#modelOn').disabled = false;
    dataLine();
  };
  $('#gKeySave').onclick = async () => {
    const v = $('#gKey').value.trim();
    const key = v && !/^•+/.test(v) ? v : await kvGet('geminiKey', '');
    if (!key) { $('#gKeyNote').textContent = 'Paste the key first.'; return; }
    $('#gKeyNote').textContent = 'Testing…';
    try {
      const r = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
      if (!r.ok) throw new Error(await gemProblem(r));
      const names = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
      const model = pickModel(names);
      if (!model) throw new Error('the key works, but no Gemini Flash model is offered to it');
      await kvSet('geminiKey', key); await kvSet('geminiModel', model);
      $('#gKey').value = '••••••••';
    } catch (e) { $('#gKeyNote').textContent = `Not working: ${e.message}`; return; }
    dataLine();
  };
  if (await kvGet('geminiKey', '')) $('#gKey').value = '••••••••';
}
