// Browser side of optional AI rewriting. Nothing is sent until rewrite() is called by a click.
// A rewrite is a SUGGESTION: it is never labelled measured, and the server reports any requirement it dropped.
export function createRewriter({ fetchImpl = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let providers = [], tokenizers = [], maxChars = 20000;
  const ok = (v) => v && typeof v.id === 'string' && typeof v.label === 'string';
  return {
    get providers() { return providers; },
    get available() { return providers.some((p) => p.configured); },
    get maxChars() { return maxChars; },
    get tokenizers() { return tokenizers; },
    async init() {
      try {
        const res = await fetchImpl(`${base}/api/providers`);
        const d = await res.json();
        if (res.ok && Array.isArray(d?.rewrite)) {
          providers = d.rewrite.filter(ok); tokenizers = (Array.isArray(d.tokenizers) ? d.tokenizers : []).filter(ok);
          if (Number.isInteger(d.rewriteMaxChars)) maxChars = d.rewriteMaxChars;
        }
      } catch { /* no server: AI rewriting simply stays unavailable */ }
      return this.available;
    },
    async rewrite(text, provider) {
      if (!this.available) return { ok: false, code: 'not_configured', message: 'AI rewriting is off. No provider is configured on the server.' };
      if (!String(text).trim()) return { ok: false, code: 'empty_text', message: 'There is nothing to rewrite.' };
      let res, data = null;
      try { res = await fetchImpl(`${base}/api/rewrite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, provider }) }); }
      catch { return { ok: false, code: 'network', message: 'Could not reach the local server. Is it running?' }; }
      try { data = await res.json(); } catch { /* keep null */ }
      if (!res.ok) return { ok: false, code: data?.error?.code || 'error', message: data?.error?.message || `Request failed (${res.status}).`, retryAfter: data?.error?.retryAfter };
      if (data?.kind !== 'ai_suggestion' || typeof data.text !== 'string' || !data.text.trim() || !Array.isArray(data.lost))
        return { ok: false, code: 'bad_response', message: 'The server returned an unexpected response, so the rewrite was discarded.' };
      return { ok: true, text: data.text, lost: data.lost.map(String), provider: String(data.provider), model: String(data.model), tokens: data.tokens };
    },
  };
}
