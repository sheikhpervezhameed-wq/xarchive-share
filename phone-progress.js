// X Archive phone app, Progress (0.9.7): what the computer's progress window shows, from status.json on the
// phone-status branch of bookmark-archive, which the computer replaces every 10 minutes while something runs
// (every hour otherwise). Read with the same key as sharing. Looked at again every minute while this tab is open.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nGB = (x) => Number(x || 0).toLocaleString('en-GB');
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const hrs = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 90 ? `about ${Math.max(1, m)} minutes` : `about ${Math.round(m / 60)} hours`; };
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function fetchStatus() {
  const cfg = await XA.getSettings();
  if (!cfg.token) throw new Error('no GitHub key yet: add it in Settings below (the same key as for sharing)');
  let r;
  try { r = await fetch(`https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/status.json?ref=phone-status`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' }); }
  catch { throw new Error('no internet just now'); }
  if (r.status === 404) throw new Error('no progress from the computer yet: paste the same key in the extension, Tools, Phone, "Progress on the phone"');
  if (r.status === 401) throw new Error('GitHub did not accept the key');
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const t = await r.text();
  let j = JSON.parse(t);
  if (j && typeof j.content === 'string' && j.encoding === 'base64') j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\s+/g, '')), (c) => c.charCodeAt(0))));
  return j;
}
function render(s) {
  const at = Date.parse(s.at);
  const old = Date.now() - at > 75 * 60e3;
  const run = s.run;
  let runHtml = '<div class="muted small">Nothing is running on X.</div>';
  if (run) {
    const now = Date.now();
    const state = run.paused ? `<b class="warn">Paused</b>${run.pausedWhy ? `: ${esc(run.pausedWhy)}` : ''}`
      : run.offlineSince ? '<b class="warn">Waiting for the internet</b>'
      : run.restUntil && run.restUntil > at ? `<b>Resting until ${hm(run.restUntil)}</b>${run.restWhy ? `: ${esc(run.restWhy)}` : ''}`
      : `Working on: ${esc(run.current || '')}`;
    runHtml = `<div class="big">${esc(run.name)}</div><div class="bar"><i style="width:${run.total ? Math.round(run.done / run.total * 100) : 0}%"></i></div>
      <div class="small">${nGB(run.done)} of ${nGB(run.total)} done${run.saved ? `, ${nGB(run.saved)} saved` : ''}${run.startedAt ? `, started ${hm(run.startedAt)}` : ''}.</div><div class="small">${state}</div>${run.next ? `<div class="small muted">Next: ${esc(run.next)}</div>` : ''}`;
  }
  const m = s.meaning || {};
  const mState = m.paused ? '<b class="warn">Paused by you</b>' : m.running ? `Reading now, ${m.gentle ? 'slowly' : 'at full speed'}${m.lastProgress ? ` (last progress ${ago(m.lastProgress)} when sent)` : ''}` : m.left ? 'Not reading at that moment' : 'All read';
  const short = (x) => String(x || '').split('/').pop();
  $('#prBox').innerHTML = `
    <div class="small ${old ? 'warn' : 'muted'}">As of ${new Date(at).toLocaleString()} (${ago(at)})${old ? ': the computer has not sent anything for over an hour (asleep, off, or Opera closed?)' : ''}. Version ${esc(s.version)}.</div>
    <div class="card"><div class="small muted">Items in the archive</div><div class="total">${nGB(s.items)}</div>${s.lastBackup ? `<div class="small muted">Last backup ${new Date(s.lastBackup.at).toLocaleString()}</div>` : ''}</div>
    <div class="card"><h2 style="margin-top:0">Run on X</h2>${runHtml}</div>
    <div class="card"><h2 style="margin-top:0">Meaning search ${m.next ? `<span class="small muted">(switching to ${esc(short(m.next))})</span>` : m.model ? `<span class="small muted">(${esc(short(m.model))})</span>` : ''}</h2>
      <div class="bar"><i style="width:${m.all ? Math.round(m.read / m.all * 100) : 0}%"></i></div>
      <div class="small">${nGB(m.read)} of ${nGB(m.all)} read, ${nGB(m.left)} left${m.left && m.rateMs ? `, ${hrs(m.rateMs * m.left)} at full speed` : ''}.</div><div class="small">${mState}</div></div>
    <div class="card"><h2 style="margin-top:0">Latest activity</h2>${(s.activity || []).slice().reverse().map((a) => `<div class="row small ${a.level === 'error' || a.level === 'warn' ? 'warn' : ''}">${a.at ? `<span class="muted">${hm(a.at)}</span> ` : ''}${esc(a.text)}</div>`).join('') || '<span class="muted small">Nothing yet.</span>'}</div>`;
}
let timer = null;
export async function refreshProgress() {
  $('#prNote').textContent = 'Looking…';
  try { const s = await fetchStatus(); render(s); $('#prNote').textContent = ''; try { localStorage.setItem('xaStatus', JSON.stringify(s)); } catch { /* ignore */ } }
  catch (e) {
    $('#prNote').textContent = e.message;
    try { const s = JSON.parse(localStorage.getItem('xaStatus') || 'null'); if (s) render(s); } catch { /* ignore */ }
  }
}
export function initProgress(isOpen) {
  $('#prRefresh').onclick = refreshProgress;
  clearInterval(timer);
  timer = setInterval(() => { if (isOpen() && document.visibilityState === 'visible') refreshProgress(); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (isOpen() && document.visibilityState === 'visible') refreshProgress(); });
}
