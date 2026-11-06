// Browser side of exact counting. Prompt text leaves the browser ONLY when measure() is called
// (the "Count exactly" button), and only to this app's own server, which holds the API key.
// A measured count is cached under (model, exact text): edit the text or change the model and the
// lookup misses, so a stale measurement can never be shown for different text.

export function createCounting({ fetchImpl = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let cfg = { available: false }, model = null, local = [];
  const cache = new Map();
  const key = (m, t) => `${m}\0${t}`;
  const route = (m) => (cfg.available && cfg.models.includes(m) ? 'anthropic' : local.some((t) => t.id === m) ? 'local' : null);
  const localInfo = (m) => local.find((t) => t.id === m);

  return {
    get available() { return cfg.available; },
    get models() { return cfg.models || []; },
    get model() { return model; },
    get scope() { return cfg.scope || ''; },
    get localModels() { return local; },
    /** 'anthropic', 'local' or null: how a measured count can be obtained for the current model. */
    get route() { return model ? route(model) : null; },
    routeFor: route,
    setLocalTokenizers(list) { local = (Array.isArray(list) ? list : []).filter((t) => t && typeof t.id === 'string'); },
    /** null clears the selection (a model with no measured route): every count is then an estimate. */
    setModel(m) { if (m === null || route(m)) { model = m; return true; } return false; },
    clear() { cache.clear(); },

    /** Sync counter for core.js: an integer when this exact text was measured for this model, else null (-> estimate). */
    counter: {
      get provider() { return model && route(model) === 'local' ? 'local' : 'anthropic'; },
      get name() { return route(model) === 'local' ? `Local tokenizer, ${localInfo(model).label}` : `Anthropic count_tokens, ${model}`; },
      get model() { return model; },
      get exact() { return route(model) === 'local'; }, // Anthropic itself calls its count an estimate; a local tokenizer counts its own encoding exactly
      get caveat() { return route(model) === 'local' ? `Text only. ${localInfo(model).note || ''}`.trim() : [cfg.scope, cfg.caveat].filter(Boolean).join(' '); },
      count(text) { const v = model && cache.get(key(model, text)); return Number.isInteger(v) ? v : null; },
    },

    async init() {
      try {
        const res = await fetchImpl(`${base}/api/config`);
        const c = (await res.json())?.counting;
        if (res.ok && c?.available === true && Array.isArray(c.models) && c.models.length) {
          cfg = c; model = c.models.includes(c.defaultModel) ? c.defaultModel : c.models[0];
        }
      } catch { /* no server or no config: stay offline */ }
      return cfg.available;
    },

    async measure(text) {
      const m = model, r = m ? route(m) : null;
      if (!r) return { ok: false, code: 'not_configured', message: cfg.available || local.length ? 'No exact counter is available for this model.' : 'Exact counting is off: no API key is configured on the server.' };
      if (!String(text).trim()) return { ok: false, code: 'empty_text', message: 'There is nothing to count.' };
      const k = key(m, text);
      if (cache.has(k)) return { ok: true, count: cache.get(k), model: m, cached: true };
      let res, data = null;
      try {
        res = await fetchImpl(`${base}${r === 'local' ? '/api/count-local' : '/api/count'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, model: m }) });
      } catch { return { ok: false, code: 'network', message: 'Could not reach the local server. Is it running?' }; }
      try { data = await res.json(); } catch { /* keep null */ }
      if (!res.ok) return { ok: false, code: data?.error?.code || 'error', message: data?.error?.message || `Request failed (${res.status}).`, retryAfter: data?.error?.retryAfter, requestId: data?.error?.requestId };
      const provider = r === 'local' ? 'local' : 'anthropic';
      if (data?.kind !== 'measured' || data.provider !== provider || data.model !== m || !Number.isInteger(data.count) || data.count < 0)
        return { ok: false, code: 'bad_response', message: 'The server returned an unexpected response, so the count was discarded.' };
      cache.set(k, data.count);
      if (cache.size > 50) cache.delete(cache.keys().next().value);
      return { ok: true, count: data.count, model: m, cached: Boolean(data.cached) };
    },
  };
}
