// Model registry, configurable pricing and cost maths. Pure functions: no DOM, no network.
// Prices are USD per million tokens and are DEFAULTS the person can edit (Models & cost view). They are estimates.

export const PRICING_AS_OF = '2026-10-29';
export const PRICING_NOTE = 'Defaults come from published Claude API rates as summarised in October 2026. Check them against your plan: rates and discounts (batch, caching, long-prompt tiers) change.';

/** count: how a measured count can be obtained for this model ('anthropic' needs the server key). Everything else is estimated. */
export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', vendor: 'Anthropic', count: 'anthropic', price: { in: 2, out: 10 } },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', vendor: 'Anthropic', count: 'anthropic', price: { in: 4, out: 20 } },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', vendor: 'Anthropic', count: 'anthropic', price: { in: 0.1, out: 0.5 }, note: 'Rate applies to prompts up to 100K tokens.' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', vendor: 'Anthropic', count: 'anthropic', price: { in: 10, out: 50 } },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', vendor: 'Google', count: 'none', price: { in: 0, out: 0 }, note: 'Free tier is $0 but rate-limited and prompts may be used by Google. Enter paid rates to model paid usage.' },
  { id: 'generic', label: 'Other model (estimate only)', vendor: 'Any', count: 'none', price: null, note: 'No price set. Enter one to see cost estimates.' },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000 ? v : null);

/** Registry + local tokenizers (when installed) + the person's price overrides. Overrides are validated, never trusted. */
export function buildModels(localTokenizers = [], overrides = {}) {
  const base = [...MODELS.slice(0, -1),
    ...localTokenizers.map((t) => ({ id: t.id, label: t.label, vendor: 'Local tokenizer', count: 'local', price: null, note: t.note })), MODELS[MODELS.length - 1]];
  return base.map((m) => {
    const o = overrides?.[m.id], i = num(o?.in), p = num(o?.out);
    const price = i !== null && p !== null ? { in: i, out: p } : m.price;
    return { ...m, price, edited: Boolean(price && (!m.price || price.in !== m.price.in || price.out !== m.price.out)) };
  });
}

/** Cost of a prompt, in USD. `tokens` is input tokens; outputTokens is optional expected output. null when no price is set. */
export function estimateCost({ tokens, outputTokens = 0, price }) {
  if (!price || !Number.isFinite(tokens) || tokens < 0) return null;
  const input = (tokens / 1e6) * price.in, output = ((Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0) / 1e6) * price.out;
  return { input, output, total: input + output };
}

/** Savings from sending fewer INPUT tokens. Output tokens are not affected by trimming the prompt. */
export function projectSavings({ before, after, calls, price }) {
  if (!price || !Number.isFinite(before) || !Number.isFinite(after)) return null;
  const perCall = (Math.max(0, before - after) / 1e6) * price.in;
  return { perCall, per1k: perCall * 1000, perMonth: perCall * (Number.isFinite(calls) ? Math.max(0, calls) : 0) };
}

export function fmtUSD(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  if (v === 0) return '$0';
  if (v < 0.0001) return '<$0.0001';
  return `$${v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4)}`;
}

export const DEFAULT_PREFS = { model: 'claude-sonnet-5-5', calls: 10000, out: 0, theme: 'auto', pricing: {} };

/** Preferences live in this browser only (localStorage). Everything is validated on load; failures fall back to defaults. */
export function loadPrefs(storage) {
  try {
    const raw = JSON.parse(storage.getItem('savetokens.v4') || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS };
    const pricing = {};
    for (const [id, p] of Object.entries(raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {})) {
      const i = num(p?.in), o = num(p?.out);
      if (/^[\w.:/-]{1,120}$/.test(id) && i !== null && o !== null) pricing[id] = { in: i, out: o };
    }
    return { model: typeof raw.model === 'string' ? raw.model.slice(0, 120) : DEFAULT_PREFS.model,
      calls: Number.isFinite(raw.calls) && raw.calls >= 0 && raw.calls <= 1e9 ? Math.round(raw.calls) : DEFAULT_PREFS.calls,
      out: Number.isFinite(raw.out) && raw.out >= 0 && raw.out <= 1e7 ? Math.round(raw.out) : DEFAULT_PREFS.out,
      theme: ['auto', 'light', 'dark'].includes(raw.theme) ? raw.theme : 'auto', pricing };
  } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(storage, prefs) { try { storage.setItem('savetokens.v4', JSON.stringify(prefs)); return true; } catch { return false; } }
