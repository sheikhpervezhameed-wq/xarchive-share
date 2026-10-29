// X Archive phone app (0.9.5): turns a search into numbers with the same model the computer used, in a
// background thread so the page stays responsive. transformers.js comes from jsDelivr (the same version the
// extension bundles); the model comes from Hugging Face the first time (about 570 MB for bge-m3) and is then
// kept by Chrome on the phone, so later searches need no download and work offline.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
let ex = null, loaded = '';
const files = new Map();
self.onmessage = async (e) => {
  const { type, id, model, pooling, prefix, texts } = e.data || {};
  try {
    if (!ex || loaded !== model) {
      if (ex) { try { await ex.dispose(); } catch { /* ignore */ } }
      ex = await pipeline('feature-extraction', model, {
        device: 'wasm', dtype: 'q8',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            const [a, b] = [...files.values()].reduce((s, [x, y]) => [s[0] + x, s[1] + y], [0, 0]);
            self.postMessage({ type: 'progress', loaded: a, total: b });
          }
        },
      });
      loaded = model;
    }
    if (type === 'load') { self.postMessage({ type: 'ready', id }); return; }
    const out = await ex(texts.map((t) => (prefix || '') + t), { pooling: pooling || 'cls', normalize: true });
    const dims = out.dims[out.dims.length - 1];
    self.postMessage({ type: 'vec', id, dims, data: Float32Array.from(out.data) });
  } catch (err) {
    self.postMessage({ type: 'error', id, error: String((err && err.message) || err) });
  }
};
