// Central model registry, configurable pricing, provider/model/effort selection and cost maths.
// Pure functions: no DOM, no network. Everything here is data plus logic that tests can exercise directly.
//
// Honesty rules encoded in the data model:
//  * A model identifier is "verified" only if an official source was checked; otherwise it is "unpinned" and the
//    candidates found are listed with their evidence, never promoted to a fact.
//  * Pricing has a status: verified (checked against the provider's own page, with source and date), reported
//    (third-party summaries, unchecked), user (entered by the person) or unavailable (nothing is shown, no guess).
//  * Reasoning effort changes OUTPUT/reasoning tokens and quota use, never the input tokens of your prompt.
//  * Token counts are estimates unless a real counter measured them; unverified tokenizers are labelled as fallbacks.

export const PRICING_AS_OF = '2026-11-08';
export const PRICING_NOTE = 'Prices marked Verified were checked against the provider\'s own pricing page on the date shown. Reported prices come from third-party summaries and must be confirmed. Your price is what you entered. Where no price is published, none is shown. Discounts, caching, batch mode and long-prompt tiers are not modelled.';
export const EFFORT_NOTE = 'Reasoning effort changes output (reasoning) tokens and quota use, not the input tokens of your prompt, so your prompt\'s token count is the same at every level.';

export const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'google', label: 'Google (Gemini API)' },
  { id: 'antigravity', label: 'Google Antigravity' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
  { id: 'local', label: 'Local tokenizers' },
  { id: 'custom', label: 'Other / custom' },
];
export const PRICING_STATUS = { verified: 'Verified', reported: 'Reported', user: 'Your price', unavailable: 'Unavailable' };
export const CONFIDENCE = {
  measurable: { label: 'Exact count on request', hint: 'A real counter can measure this model on request. Until then the number shown is an estimate.' },
  approximate: { label: 'Approximate (offline heuristic)', hint: 'The model is known, but no model-specific tokenizer is available here, so counts are heuristic estimates.' },
  unverified: { label: 'Fallback estimate (tokenizer not verified)', hint: 'The model identity or tokenizer is not verified, so the offline heuristic is a fallback.' },
};

const SRC = {
  claudePricing: { label: 'Anthropic pricing page', url: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  antigravityModels: { label: 'Antigravity docs: Choose a model', url: 'https://antigravity.google/docs/models/' },
  geminiArgon: { label: 'Gemini API docs: What\'s new in Gemini 4 Argon', url: 'https://ai.google.dev/gemini-api/docs/latest-model' },
  openaiGpt6: { label: 'OpenAI docs: Using GPT-6', url: 'https://developers.openai.com/api/docs/guides/latest-model' },
  awsBedrock: { label: 'AWS blog: GPT-5.6 Sol, Terra and Luna on Bedrock (third party)', url: 'https://aws.amazon.com/blogs/machine-learning/get-started-with-openai-gpt-5-6-sol-terra-and-luna-on-amazon-bedrock/' },
  openclaw: { label: 'OpenClaw docs: OpenAI models (third party)', url: 'https://docs.openclaw.ai/providers/openai/models' },
};
const verified = (inn, out, note) => ({ in: inn, out, status: 'verified', source: SRC.claudePricing, asOf: PRICING_AS_OF, ...(note && { note }) });
const unavailable = (reason, source = null) => ({ in: null, out: null, status: 'unavailable', reason, source, asOf: null });
const HEURISTIC = (note) => ({ id: 'heuristic-v2', kind: 'heuristic', verified: false, exact: false, note });
const CLAUDE_TOKENIZER = { id: 'anthropic-count-tokens', kind: 'provider-api', verified: true, exact: false,
  note: 'Counted by Anthropic\'s token-counting endpoint for the exact model ID, on request. Anthropic calls the result an estimate. Claude 4.7 and later use a newer tokenizer (about 30% more tokens than earlier models), so a count never transfers between models.' };

// ---------------------------------------------------------------- the registry
const RAW = [
  { id: 'claude-sonnet-5-5', provider: 'anthropic', vendor: 'Anthropic', label: 'Claude Sonnet 5.5', labelStatus: 'official', modelId: 'claude-sonnet-5-5', modelIdStatus: 'verified',
    reasoning: null, tokenizer: CLAUDE_TOKENIZER, count: 'anthropic', pricing: verified(2, 10) },
  { id: 'claude-opus-5-5', provider: 'anthropic', vendor: 'Anthropic', label: 'Claude Opus 5.5', labelStatus: 'official', modelId: 'claude-opus-5-5', modelIdStatus: 'verified',
    reasoning: null, tokenizer: CLAUDE_TOKENIZER, count: 'anthropic', pricing: verified(4, 20) },
  { id: 'claude-haiku-5-5', provider: 'anthropic', vendor: 'Anthropic', label: 'Claude Haiku 5.5', labelStatus: 'official', modelId: 'claude-haiku-5-5', modelIdStatus: 'verified',
    reasoning: null, tokenizer: CLAUDE_TOKENIZER, count: 'anthropic', pricing: verified(0.1, 0.5, 'Rate applies to prompts up to 100K tokens; longer prompts cost more ($0.50 in / $2.50 out) and are not modelled.'), note: 'Rate applies to prompts up to 100K tokens.' },
  { id: 'claude-fable-5-1', provider: 'anthropic', vendor: 'Anthropic', label: 'Claude Fable 5.1', labelStatus: 'official', modelId: 'claude-fable-5-1', modelIdStatus: 'verified',
    reasoning: null, tokenizer: CLAUDE_TOKENIZER, count: 'anthropic', pricing: verified(10, 50) },
  { id: 'gemini-3.5-flash-lite', provider: 'google', vendor: 'Google', label: 'Gemini 3.5 Flash-Lite', labelStatus: 'official', modelId: 'gemini-3.5-flash-lite', modelIdStatus: 'verified',
    reasoning: null, tokenizer: HEURISTIC('No Gemini tokenizer is available offline here; counts are heuristic estimates.'), count: 'none',
    pricing: { in: 0, out: 0, status: 'reported', source: { label: 'Third-party summaries of the free tier (not checked against Google\'s pricing page)', url: null }, asOf: null },
    note: 'Free tier is $0 but rate-limited and prompts may be used by Google. Enter paid rates to model paid usage.' },
  // User-requested label. Antigravity offers Gemini models at selectable thinking levels; which Gemini model you get depends on your plan.
  { id: 'antigravity-gemini', provider: 'antigravity', vendor: 'Google Antigravity', label: 'Gemini', labelStatus: 'user-requested', modelId: null, modelIdStatus: 'unpinned',
    modelIdCandidates: [{ name: 'Gemini 4 Argon', apiId: 'gemini-4-argon', evidence: 'Listed with low / medium / high thinking levels in Google\'s Gemini API docs. Which Gemini models Antigravity offers depends on your plan, so this is a candidate, not a confirmed match.', source: SRC.geminiArgon }],
    reasoning: { param: 'thinking level', levels: ['low', 'medium', 'high'], default: 'medium', defaultBasis: 'The Gemini API docs name medium as the default thinking level.', changesInputTokens: false, source: SRC.antigravityModels },
    tokenizer: HEURISTIC('No tokenizer is verified for the Gemini model Antigravity uses, so the offline estimate is a fallback.'), count: 'none',
    pricing: unavailable('Antigravity usage is metered as plan quota (weekly and five-hour limits), not per token, so there is no per-token price. Enter your own rates to model a cost.', SRC.antigravityModels),
    note: 'Quota-metered product: dollar figures appear only if you enter a rate yourself.' },
  // User-requested label. "Terra" is a named OpenAI tier that exists in more than one generation, so the exact model is not pinned.
  { id: 'codex-terra', provider: 'openai-codex', vendor: 'OpenAI Codex', label: 'Terra', labelStatus: 'user-requested', modelId: null, modelIdStatus: 'unpinned',
    modelIdCandidates: [
      { name: 'GPT-6.1 Terra', apiId: 'gpt-6.1-terra', evidence: 'The name and its reasoning efforts appear in OpenAI\'s "Using GPT-6" guide. The API ID is from third-party coverage and is unconfirmed.', source: SRC.openaiGpt6 },
      { name: 'GPT-5.6 Terra', apiId: 'gpt-5.6-terra', evidence: 'Listed as a Codex / Bedrock model ID in third-party documentation. Not confirmed against OpenAI\'s own model page.', source: SRC.awsBedrock }],
    reasoning: { param: 'reasoning effort', levels: ['low', 'medium', 'high'], default: 'medium', defaultBasis: 'OpenAI\'s GPT-6 guide lists medium as the default for GPT-6.1 Terra; other generations were not checked.', changesInputTokens: false, source: SRC.openaiGpt6 },
    tokenizer: HEURISTIC('The tokenizer of the model behind "Terra" is not verified, so the offline estimate is a fallback and is never labelled exact.'), count: 'none',
    pricing: unavailable('The Terra generation (GPT-5.6 or GPT-6.1) is not pinned, so no price is shown. Enter your own rates for a cost model.'),
    note: 'Efforts above high (xhigh, max) exist for this tier but are not offered here.' },
  // User-requested label. Same ambiguity as Terra. No effort levels were requested for Luna.
  { id: 'codex-luna', provider: 'openai-codex', vendor: 'OpenAI Codex', label: 'Luna', labelStatus: 'user-requested', modelId: null, modelIdStatus: 'unpinned',
    modelIdCandidates: [
      { name: 'GPT-6 Luna', apiId: null, evidence: 'The name appears in OpenAI\'s "Using GPT-6" guide. No API ID was confirmed in the sources reviewed.', source: SRC.openaiGpt6 },
      { name: 'GPT-5.6 Luna', apiId: 'gpt-5.6-luna', evidence: 'Listed as a Codex model ID in third-party documentation. Not confirmed against OpenAI\'s own model page.', source: SRC.openclaw }],
    reasoning: null,
    tokenizer: HEURISTIC('The tokenizer of the model behind "Luna" is not verified, so the offline estimate is a fallback and is never labelled exact.'), count: 'none',
    pricing: unavailable('The Luna generation (GPT-5.6 or GPT-6) is not pinned, so no price is shown. Enter your own rates for a cost model.'),
    note: 'OpenAI documents reasoning effort for Luna, but none was requested for this profile, so no effort selector is offered.' },
  { id: 'generic', provider: 'custom', vendor: 'Any', label: 'Other model (estimate only)', labelStatus: 'custom', modelId: null, modelIdStatus: 'none',
    reasoning: null, tokenizer: HEURISTIC('Any model: only the offline heuristic is available.'), count: 'none', pricing: unavailable('No price is set. Enter your own rates for a cost model.'),
    note: 'No price set. Enter one to see cost estimates.' },
];

const capabilitiesOf = (m, price) => ['analyze', 'optimize', ...(price ? ['cost-estimate'] : []),
  ...(m.count === 'anthropic' ? ['count:provider-api'] : []), ...(m.count === 'local' ? ['count:local-tokenizer'] : []), ...(m.reasoning ? ['reasoning-effort'] : [])];
const confidenceOf = (m) => (m.count === 'anthropic' || m.count === 'local' ? { level: 'measurable', reason: CONFIDENCE.measurable.hint }
  : m.modelIdStatus === 'verified' ? { level: 'approximate', reason: CONFIDENCE.approximate.hint } : { level: 'unverified', reason: CONFIDENCE.unverified.hint });
const priceOf = (pricing) => (pricing.in !== null && pricing.out !== null ? { in: pricing.in, out: pricing.out } : null);
function finish(p) {
  const price = priceOf(p.pricing);
  return { note: '', modelIdCandidates: [], ...p, price, confidence: confidenceOf(p), capabilities: capabilitiesOf(p, price) };
}

/** Every profile, finished: derived `price` (old shape {in,out} or null), `confidence`, and `capabilities` (what THIS APP can do for it). */
export const MODELS = RAW.map(finish);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000 ? v : null);

/** Registry + local tokenizers (when installed) + the person's price overrides. Overrides are validated, never trusted. */
export function buildModels(localTokenizers = [], overrides = {}) {
  const local = localTokenizers.map((t) => finish({ id: t.id, provider: 'local', vendor: 'Local tokenizer', label: t.label, labelStatus: 'tokenizer', modelId: null, modelIdStatus: 'none', reasoning: null,
    tokenizer: { id: t.id, kind: 'local-package', verified: true, exact: true, note: t.note || '' }, count: 'local',
    pricing: unavailable('A tokenizer is not a priced model. Enter a rate if you want a cost model.'), note: t.note }));
  const base = [...MODELS.slice(0, -1), ...local, MODELS[MODELS.length - 1]];
  return base.map((m) => {
    const o = overrides?.[m.id], i = num(o?.in), p = num(o?.out);
    const own = i !== null && p !== null ? { in: i, out: p } : null;
    const same = own && m.price && own.in === m.price.in && own.out === m.price.out;      // an override equal to the default keeps the default's status
    const pricing = own && !same ? { in: own.in, out: own.out, status: 'user', source: null, asOf: null } : m.pricing;
    const price = priceOf(pricing);
    return { ...m, pricing, price, capabilities: capabilitiesOf(m, price), edited: Boolean(price && (!m.price || price.in !== m.price.in || price.out !== m.price.out)) };
  });
}

// ---------------------------------------------------------------- cascading selection: provider -> model -> reasoning effort
export const providersOf = (models) => PROVIDERS.filter((p) => models.some((m) => m.provider === p.id)).map((p) => ({ ...p, count: models.filter((m) => m.provider === p.id).length }));
export const modelsOf = (models, providerId) => models.filter((m) => m.provider === providerId);
export const variantLabel = (profile, effort) => (effort ? `${profile.label} ${effort[0].toUpperCase()}${effort.slice(1)}` : profile.label);
/** The effort in force for a profile: the person's choice if valid, else the profile's default, else null when it has no effort levels. */
export const effortOf = (profile, efforts) => {
  if (!profile?.reasoning) return null;
  const e = efforts?.[profile.id];
  return profile.reasoning.levels.includes(e) ? e : profile.reasoning.default;
};
/** Resolve preferences to a profile. An unknown or missing model falls back to the default, so old saved preferences keep working. */
export function resolveSelection(models, prefs = {}) {
  const profile = models.find((m) => m.id === prefs.model) || models.find((m) => m.id === DEFAULT_PREFS.model) || models[0];
  const effort = effortOf(profile, prefs.efforts);
  return { profile, provider: PROVIDERS.find((p) => p.id === profile.provider), effort, label: variantLabel(profile, effort) };
}
// These return NEW preference objects and never mutate their input.
export function selectProvider(models, prefs, providerId) {
  const cur = resolveSelection(models, prefs).profile;
  if (cur.provider === providerId) return { ...prefs };
  const first = modelsOf(models, providerId)[0];
  return first ? { ...prefs, model: first.id } : { ...prefs };
}
export const selectModel = (models, prefs, modelId) => (models.some((m) => m.id === modelId) ? { ...prefs, model: modelId } : { ...prefs });
export function selectEffort(models, prefs, level) {
  const { profile } = resolveSelection(models, prefs);
  return profile.reasoning?.levels.includes(level) ? { ...prefs, efforts: { ...prefs.efforts, [profile.id]: level } } : { ...prefs };
}
/** The options exactly as named by the people who use them: "Gemini Low", "Terra High", "Luna"... */
export function namedOptions(models, providerId) {
  return modelsOf(models, providerId).flatMap((m) => (m.reasoning ? m.reasoning.levels.map((e) => ({ profileId: m.id, provider: m.provider, effort: e, label: variantLabel(m, e) })) : [{ profileId: m.id, provider: m.provider, effort: null, label: m.label }]));
}

// ---------------------------------------------------------------- honest descriptions used by the UI
/** How to describe a token count for this profile. `kind` is 'estimated' or 'measured'; `route` is the counting route available now ('anthropic' | 'local' | null). */
export function tokenBasis(profile, kind = 'estimated', route = null) {
  if (kind === 'measured') return { level: 'measured', label: 'Measured', detail: 'Counted by a real counter for this exact text and model.' };
  if (profile.count === 'anthropic' || profile.count === 'local')
    return { level: 'exact-available', label: route ? 'Estimate · exact count available on request' : 'Estimate · exact counting is not set up',
      detail: route ? 'Press Count exactly to measure this model.' : 'Exact counting needs a key on the server (Claude) or an installed tokenizer package.' };
  if (profile.confidence.level === 'unverified') return { level: 'fallback', label: 'Fallback estimate · no verified tokenizer for this model', detail: profile.tokenizer.note };
  return { level: 'approximate', label: 'Estimate · offline heuristic, not this model\'s tokenizer', detail: profile.tokenizer.note };
}
/** One line about price, always saying where it comes from or why there is none. */
export function pricingLine(profile) {
  const p = profile.pricing, price = profile.price;
  if (!price) return `Pricing unavailable: ${p.reason || 'no price is set'}`;
  const rates = price.in === 0 && price.out === 0 ? 'Free tier ($0), rate-limited' : `${fmtUSD(price.in)}/M in · ${fmtUSD(price.out)}/M out`;
  return p.status === 'verified' ? `${rates} · verified ${p.asOf}` : p.status === 'user' ? `${rates} · your price` : `${rates} · reported, not verified`;
}
export const modelIdLine = (profile) => (profile.modelIdStatus === 'verified' ? `Model ID: ${profile.modelId}`
  : profile.modelIdStatus === 'unpinned' ? `Model ID not pinned. Candidates: ${profile.modelIdCandidates.map((c) => `${c.name}${c.apiId ? ` (${c.apiId}, unconfirmed)` : ''}`).join('; ')}`
  : 'Model ID: not applicable');

/** Structural check used by the tests (and handy when adding a profile): returns a list of problems, empty when the profile is sound. */
export function validateProfile(m) {
  const bad = [], need = (ok, msg) => { if (!ok) bad.push(msg); };
  need(typeof m.id === 'string' && /^[\w.:-]+$/.test(m.id), 'id'); need(PROVIDERS.some((p) => p.id === m.provider), 'provider');
  need(typeof m.label === 'string' && m.label, 'label'); need(['official', 'user-requested', 'custom', 'tokenizer'].includes(m.labelStatus), 'labelStatus');
  need(m.modelId === null || typeof m.modelId === 'string', 'modelId'); need(['verified', 'unpinned', 'none'].includes(m.modelIdStatus), 'modelIdStatus');
  need((m.modelIdStatus === 'verified') === (typeof m.modelId === 'string'), 'a verified status needs an id, and an id needs a verified status (no invented identities)');
  if (m.modelIdStatus === 'unpinned') need(m.modelIdCandidates.length > 0 && m.modelIdCandidates.every((c) => c.name && c.evidence && c.source?.url), 'unpinned candidates need name, evidence and source');
  if (m.reasoning) { const r = m.reasoning; need(Array.isArray(r.levels) && r.levels.length > 0 && r.levels.includes(r.default), 'reasoning levels/default'); need(r.changesInputTokens === false, 'effort must not change input tokens'); need(r.defaultBasis && r.source?.url, 'reasoning basis/source'); }
  need(m.tokenizer && m.tokenizer.id && ['heuristic', 'provider-api', 'local-package'].includes(m.tokenizer.kind) && typeof m.tokenizer.verified === 'boolean' && typeof m.tokenizer.exact === 'boolean', 'tokenizer');
  if (m.tokenizer?.kind === 'heuristic') need(m.tokenizer.verified === false && m.tokenizer.exact === false, 'a heuristic is never verified or exact');
  const p = m.pricing; need(p && ['verified', 'reported', 'user', 'unavailable'].includes(p.status), 'pricing status');
  if (p?.status === 'verified') need(p.in !== null && p.out !== null && p.source?.url && /^\d{4}-\d{2}-\d{2}$/.test(p.asOf), 'verified pricing needs numbers, a source URL and a date');
  if (p?.status === 'reported') need(p.in !== null && p.out !== null && p.source?.label, 'reported pricing needs numbers and a source');
  if (p?.status === 'unavailable') need(p.in === null && p.out === null && p.reason, 'unavailable pricing has no numbers and says why');
  need(m.price === null || (m.price.in === p.in && m.price.out === p.out), 'price matches pricing');
  need(['measurable', 'approximate', 'unverified'].includes(m.confidence?.level) && m.confidence.reason, 'confidence');
  need(Array.isArray(m.capabilities) && m.capabilities.includes('analyze') && m.capabilities.includes('optimize'), 'capabilities');
  need((m.capabilities.includes('cost-estimate')) === (m.price !== null), 'cost-estimate capability follows price');
  return bad;
}

// ---------------------------------------------------------------- cost maths (unchanged)
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

/** Preferences live in this browser only (localStorage). Everything is validated on load; failures fall back to defaults.
 *  `efforts` (the chosen reasoning effort per profile) appears only when the person has chosen one, so older saved preferences load unchanged. */
export function loadPrefs(storage) {
  try {
    const raw = JSON.parse(storage.getItem('savetokens.v4') || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS };
    const pricing = {};
    for (const [id, p] of Object.entries(raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : {})) {
      const i = num(p?.in), o = num(p?.out);
      if (/^[\w.:/-]{1,120}$/.test(id) && i !== null && o !== null) pricing[id] = { in: i, out: o };
    }
    const efforts = {};
    for (const [id, level] of Object.entries(raw.efforts && typeof raw.efforts === 'object' ? raw.efforts : {})) {
      if (MODELS.find((m) => m.id === id)?.reasoning?.levels.includes(level)) efforts[id] = level;
    }
    return { model: typeof raw.model === 'string' ? raw.model.slice(0, 120) : DEFAULT_PREFS.model,
      calls: Number.isFinite(raw.calls) && raw.calls >= 0 && raw.calls <= 1e9 ? Math.round(raw.calls) : DEFAULT_PREFS.calls,
      out: Number.isFinite(raw.out) && raw.out >= 0 && raw.out <= 1e7 ? Math.round(raw.out) : DEFAULT_PREFS.out,
      theme: ['auto', 'light', 'dark'].includes(raw.theme) ? raw.theme : 'auto', pricing, ...(Object.keys(efforts).length && { efforts }) };
  } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(storage, prefs) { try { storage.setItem('savetokens.v4', JSON.stringify(prefs)); return true; } catch { return false; } }
