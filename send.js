// X Archive phone app: the shared part, used by the page and by the service worker (sw.js).
// Each share is kept on the phone (IndexedDB, "outbox") until GitHub has it, then marked sent. Sending puts
// one small file into inbox/ of your private bookmark-archive repository, with a key that you made for that
// repository only. Your computer collects the file with its next publish; nothing else reads it.
(function (root) {
  const DB = 'xa-phone', VER = 1;
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'k' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const req = (q) => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  async function store(name, mode = 'readonly') { const d = await open(); return d.transaction(name, mode).objectStore(name); }
  async function getSettings() {
    const all = await req((await store('settings')).getAll());
    const s = { owner: 'sheikhpervezhameed-wq', repo: 'bookmark-archive', token: '' };
    for (const x of all) s[x.k] = x.v;
    return s;
  }
  async function setSetting(k, v) { await req((await store('settings', 'readwrite')).put({ k, v })); }
  async function allShares() { return (await req((await store('outbox')).getAll())).sort((a, b) => (a.sharedAt < b.sharedAt ? 1 : -1)); }
  async function putShare(s) { await req((await store('outbox', 'readwrite')).put(s)); }
  async function dropOld() {          // keep the last 100 sent shares on the phone; unsent ones always stay
    const all = await allShares();
    const sent = all.filter((s) => s.state === 'sent');
    const st = await store('outbox', 'readwrite');
    for (const s of sent.slice(100)) st.delete(s.id);
  }
  function newShare({ url, title, text }) {
    const t = new Date();
    const id = `${t.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`;
    return { format: 'xarchive-share', id, sharedAt: t.toISOString(), url: String(url || '').trim(), title: String(title || '').trim().slice(0, 500), text: String(text || '').trim().slice(0, 4000), device: 'phone', state: 'waiting', tries: 0, note: '' };
  }
  const b64 = (s) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
  // One share to GitHub. Returns { ok, note, retry }.
  async function sendOne(share, cfg) {
    if (!cfg.token) return { ok: false, note: 'no key yet: open Settings and paste the key', retry: false };
    const body = { format: share.format, id: share.id, sharedAt: share.sharedAt, url: share.url, title: share.title, text: share.text, device: share.device };
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/inbox/${share.id}.json`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Phone share ${share.id}`, content: b64(JSON.stringify(body, null, 1) + '\n') }),
      });
    } catch { return { ok: false, note: 'no internet just now; it is sent by itself when the phone is back online', retry: true }; }
    if (r.status === 201 || r.status === 200) return { ok: true, note: 'sent' };
    if (r.status === 422) return { ok: true, note: 'sent (GitHub already had it)' };
    if (r.status === 401) return { ok: false, note: 'GitHub did not accept the key (wrong, or it has expired): make a new one and paste it in Settings', retry: false };
    if (r.status === 403 || r.status === 404) return { ok: false, note: 'the key cannot write to that repository: check the repository name, and that the key has "Contents: Read and write" for it', retry: false };
    return { ok: false, note: `GitHub answered ${r.status}; it is tried again later`, retry: true };
  }
  async function sendWaiting() {
    const cfg = await getSettings();
    const out = { sent: 0, failed: 0, retry: false };
    for (const s of await allShares()) {
      if (s.state === 'sent') continue;
      const r = await sendOne(s, cfg);
      s.tries = (s.tries || 0) + 1; s.note = r.note; s.state = r.ok ? 'sent' : 'waiting';
      if (r.ok) { s.sentAt = new Date().toISOString(); out.sent++; } else { out.failed++; if (r.retry) out.retry = true; }
      await putShare(s);
      if (!r.ok && !r.retry) break;        // a key problem: no point trying the others now
    }
    await dropOld();
    return out;
  }
  async function testKey(cfg) {
    if (!cfg.token) return 'Paste the key first.';
    try {
      const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
      if (r.status === 401) return 'GitHub did not accept the key (wrong, or expired).';
      if (r.status === 404) return 'The key cannot see that repository. Check the name, and that the key was made for it.';
      if (!r.ok) return `GitHub answered ${r.status}. Try again in a minute.`;
      const j = await r.json();
      if (j.permissions && j.permissions.push === false) return 'The key can read the repository but not write to it: give it "Contents: Read and write".';
      return 'OK: the key works.';
    } catch { return 'No internet just now. Try again when the phone is online.'; }
  }
  root.XA = { getSettings, setSetting, allShares, putShare, newShare, sendWaiting, testKey };
})(typeof self !== 'undefined' ? self : this);
