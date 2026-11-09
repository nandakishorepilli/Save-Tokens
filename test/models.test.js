// Model Intelligence upgrade: centralized registry, cascading provider -> model -> effort selection, honest token and price labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as M from '../public/models.js';
import { analyze, estimateTokens, countTokens } from '../public/core.js';
import { createCounting } from '../public/counting.js';

const { MODELS, PROVIDERS, buildModels, validateProfile, providersOf, modelsOf, namedOptions, resolveSelection, selectProvider, selectModel, selectEffort, effortOf, variantLabel,
  tokenBasis, pricingLine, modelIdLine, estimateCost, projectSavings, fmtUSD, loadPrefs, savePrefs, DEFAULT_PREFS, PRICING_STATUS, EFFORT_NOTE } = M;
const all = buildModels(), byId = (id, list = all) => list.find((m) => m.id === id);
const NAMED = ['Gemini Low', 'Gemini Medium', 'Gemini High', 'Terra Low', 'Terra Medium', 'Terra High', 'Luna'];
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ======================================================================= registry
test('every profile in the registry is structurally sound, and the registry is the single source of truth', () => {
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  for (const m of all) assert.deepEqual(validateProfile(m), [], m.id);
  for (const m of all) for (const k of ['provider', 'label', 'modelId', 'modelIdStatus', 'reasoning', 'tokenizer', 'pricing', 'price', 'confidence', 'capabilities']) assert.ok(k in m, `${m.id} lacks ${k}`);
  assert.ok(MODELS.every((m) => PROVIDERS.some((p) => p.id === m.provider)));
  assert.equal(MODELS.at(-1).id, 'generic');                                              // custom stays last, as before
});

test('validateProfile rejects the mistakes this registry exists to prevent', () => {
  const ok = structuredClone(byId('claude-sonnet-5-5'));
  assert.deepEqual(validateProfile(ok), []);
  const broken = (mut) => { const m = structuredClone(ok); mut(m); return validateProfile(m); };
  assert.ok(broken((m) => { m.modelIdStatus = 'unpinned'; }).length);                      // an id without verification
  assert.ok(broken((m) => { m.pricing.source = null; }).length);                           // verified price with no source
  assert.ok(broken((m) => { m.pricing.asOf = null; }).length);                             // ...or no date
  assert.ok(broken((m) => { m.tokenizer = { id: 'x', kind: 'heuristic', verified: false, exact: true }; }).length);   // an approximate tokenizer claiming exactness
  const terra = structuredClone(byId('codex-terra'));
  terra.reasoning.changesInputTokens = true; assert.ok(validateProfile(terra).length);     // effort must never change input tokens
  const t2 = structuredClone(byId('codex-terra')); t2.modelId = 'gpt-6.1-terra'; assert.ok(validateProfile(t2).length);   // inventing an identity
  const t3 = structuredClone(byId('codex-terra')); t3.pricing = { in: 1, out: 2, status: 'unavailable', reason: 'x' }; assert.ok(validateProfile(t3).length);   // numbers with "unavailable"
  const t4 = structuredClone(byId('codex-terra')); t4.modelIdCandidates = []; assert.ok(validateProfile(t4).length);
});

// ======================================================================= every new model profile
test('the requested options exist exactly as named: Gemini Low/Medium/High, Terra Low/Medium/High, Luna', () => {
  assert.deepEqual([...namedOptions(all, 'antigravity'), ...namedOptions(all, 'openai-codex')].map((o) => o.label), NAMED);
  for (const o of [...namedOptions(all, 'antigravity'), ...namedOptions(all, 'openai-codex')]) {
    const prefs = { model: o.profileId, ...(o.effort && { efforts: { [o.profileId]: o.effort } }) }, s = resolveSelection(all, prefs);
    assert.deepEqual([s.label, s.effort, s.profile.provider], [o.label, o.effort, o.provider]);
  }
});

test('Google Antigravity "Gemini": effort levels, quota-metered (no per-token price), unpinned model, fallback tokenizer', () => {
  const g = byId('antigravity-gemini');
  assert.deepEqual([g.provider, g.vendor, g.label, g.labelStatus], ['antigravity', 'Google Antigravity', 'Gemini', 'user-requested']);
  assert.deepEqual([g.modelId, g.modelIdStatus], [null, 'unpinned']);
  assert.deepEqual(g.modelIdCandidates.map((c) => c.apiId), ['gemini-4-argon']);          // a documented candidate, not promoted to a fact
  assert.match(g.modelIdCandidates[0].evidence, /candidate|depends on your plan/i);
  assert.deepEqual([g.reasoning.levels, g.reasoning.default, g.reasoning.changesInputTokens], [['low', 'medium', 'high'], 'medium', false]);
  assert.match(g.reasoning.source.url, /antigravity\.google/);
  assert.deepEqual([g.tokenizer.kind, g.tokenizer.verified, g.tokenizer.exact], ['heuristic', false, false]);
  assert.deepEqual([g.pricing.status, g.pricing.in, g.pricing.out, g.price], ['unavailable', null, null, null]);
  assert.match(g.pricing.reason, /quota/i); assert.match(g.pricing.reason, /not per token/i);
  assert.equal(g.confidence.level, 'unverified');
  assert.ok(g.capabilities.includes('reasoning-effort') && !g.capabilities.includes('cost-estimate') && !g.capabilities.some((c) => c.startsWith('count:')));
});

test('OpenAI Codex "Terra": user-requested label, effort levels, candidates with evidence, nothing invented', () => {
  const t = byId('codex-terra');
  assert.deepEqual([t.provider, t.label, t.labelStatus, t.modelId, t.modelIdStatus], ['openai-codex', 'Terra', 'user-requested', null, 'unpinned']);
  assert.ok(t.modelIdCandidates.length >= 2);
  for (const c of t.modelIdCandidates) assert.ok(c.name && c.evidence && /^https:\/\//.test(c.source.url));
  assert.ok(t.modelIdCandidates.every((c) => /unconfirmed|not confirmed|Not confirmed|third-party|third party/i.test(c.evidence)));
  assert.match(modelIdLine(t), /not pinned/i); assert.match(modelIdLine(t), /unconfirmed/);
  assert.deepEqual([t.reasoning.levels, t.reasoning.default, t.reasoning.changesInputTokens], [['low', 'medium', 'high'], 'medium', false]);
  assert.deepEqual([t.tokenizer.verified, t.tokenizer.exact, t.confidence.level, t.count], [false, false, 'unverified', 'none']);
  assert.deepEqual([t.pricing.status, t.price], ['unavailable', null]); assert.match(t.pricing.reason, /not pinned/i);
});

test('OpenAI Codex "Luna": user-requested label, no effort selector, unpinned, no price', () => {
  const l = byId('codex-luna');
  assert.deepEqual([l.provider, l.label, l.labelStatus, l.modelId, l.modelIdStatus, l.reasoning], ['openai-codex', 'Luna', 'user-requested', null, 'unpinned', null]);
  assert.equal(effortOf(l, { 'codex-luna': 'high' }), null); assert.equal(resolveSelection(all, { model: 'codex-luna' }).label, 'Luna');
  assert.deepEqual([l.pricing.status, l.price, l.tokenizer.verified, l.confidence.level], ['unavailable', null, false, 'unverified']);
  assert.ok(!l.capabilities.includes('reasoning-effort') && !l.capabilities.includes('cost-estimate'));
  assert.ok(l.modelIdCandidates.length >= 2 && l.modelIdCandidates.some((c) => c.apiId === null));    // an ID that was not found is not made up
});

test('no fabricated specifications: identities and prices exist only where a source backs them', () => {
  for (const m of all) {
    if (m.modelId !== null) assert.equal(m.modelIdStatus, 'verified', m.id);
    if (m.modelIdStatus === 'unpinned') assert.equal(m.modelId, null, m.id);
    for (const c of m.modelIdCandidates) if (c.apiId !== null) assert.notEqual(c.apiId, m.modelId, `${m.id}: a candidate was promoted to the model id`);   // a candidate id that was not found stays null
    if (m.price) assert.ok(['verified', 'reported'].includes(m.pricing.status) && m.pricing.source, `${m.id}: a default price without a source`);
  }
  for (const id of ['antigravity-gemini', 'codex-terra', 'codex-luna', 'generic']) assert.equal(byId(id).price, null, id);
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
    const p = byId(id).pricing; assert.deepEqual([p.status, /platform\.claude\.com/.test(p.source.url), p.asOf], ['verified', true, M.PRICING_AS_OF], id);
  }
  assert.equal(byId('gemini-3.5-flash-lite').pricing.status, 'reported');                    // never "verified" without checking Google's page
});

// ======================================================================= existing models are retained
test('all earlier models are retained with identical ids, routes and prices', () => {
  const OLD = { 'claude-sonnet-5-5': [2, 10, 'anthropic', 'Anthropic'], 'claude-opus-5-5': [4, 20, 'anthropic', 'Anthropic'], 'claude-haiku-5-5': [0.1, 0.5, 'anthropic', 'Anthropic'],
    'claude-fable-5-1': [10, 50, 'anthropic', 'Anthropic'], 'gemini-3.5-flash-lite': [0, 0, 'none', 'Google'], generic: [null, null, 'none', 'Any'] };
  for (const [id, [i, o, count, vendor]] of Object.entries(OLD)) {
    const m = byId(id);
    assert.deepEqual([m.count, m.vendor, m.price], [count, vendor, i === null ? null : { in: i, out: o }], id);
  }
  assert.equal(byId('generic').label, 'Other model (estimate only)');
  assert.deepEqual(all.map((m) => m.id).slice(0, 4), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
});

// ======================================================================= provider / model selection
test('provider selection lists only providers that have models, in a fixed order, and local tokenizers appear only when installed', () => {
  assert.deepEqual(providersOf(all).map((p) => p.id), ['anthropic', 'google', 'antigravity', 'openai-codex', 'custom']);
  assert.deepEqual(providersOf(all).map((p) => p.count), [4, 1, 1, 2, 1]);
  const withLocal = buildModels([{ id: 'openai-o200k', label: 'OpenAI o200k', note: 'n' }]);
  assert.deepEqual(providersOf(withLocal).map((p) => p.id), ['anthropic', 'google', 'antigravity', 'openai-codex', 'local', 'custom']);
  assert.deepEqual(modelsOf(withLocal, 'local').map((m) => [m.id, m.count, m.tokenizer.kind, m.tokenizer.exact, m.confidence.level]), [['openai-o200k', 'local', 'local-package', true, 'measurable']]);
  assert.deepEqual(modelsOf(all, 'openai-codex').map((m) => m.id), ['codex-terra', 'codex-luna']);
  assert.deepEqual(modelsOf(all, 'nope'), []);
});

test('choosing a provider selects its first model; choosing the current provider keeps the current model', () => {
  const start = { ...DEFAULT_PREFS };
  assert.equal(selectProvider(all, start, 'antigravity').model, 'antigravity-gemini');
  assert.equal(selectProvider(all, start, 'openai-codex').model, 'codex-terra');
  assert.equal(selectProvider(all, start, 'google').model, 'gemini-3.5-flash-lite');
  assert.equal(selectProvider(all, start, 'custom').model, 'generic');
  assert.equal(selectProvider(all, { ...start, model: 'claude-opus-5-5' }, 'anthropic').model, 'claude-opus-5-5');
  assert.equal(selectProvider(all, start, 'no-such-provider').model, start.model);
  assert.equal(selectModel(all, start, 'codex-luna').model, 'codex-luna');
  assert.equal(selectModel(all, start, 'gpt-nonsense').model, start.model);                // an unknown model is ignored, not stored
  assert.equal(resolveSelection(all, selectModel(all, start, 'codex-luna')).provider.id, 'openai-codex');
});

// ======================================================================= reasoning effort
test('reasoning effort: defaults, selection, per-model memory, and invalid values are ignored', () => {
  let p = selectModel(all, DEFAULT_PREFS, 'codex-terra');
  assert.deepEqual([resolveSelection(all, p).effort, resolveSelection(all, p).label], ['medium', 'Terra Medium']);
  p = selectEffort(all, p, 'high');
  assert.deepEqual([resolveSelection(all, p).effort, resolveSelection(all, p).label, p.efforts], ['high', 'Terra High', { 'codex-terra': 'high' }]);
  assert.deepEqual(selectEffort(all, p, 'extreme'), p);                                    // not a level of this model
  p = selectModel(all, p, 'antigravity-gemini');
  assert.equal(resolveSelection(all, p).effort, 'medium');                                 // each model has its own default
  p = selectEffort(all, p, 'low'); assert.equal(resolveSelection(all, p).label, 'Gemini Low');
  p = selectModel(all, p, 'codex-terra'); assert.equal(resolveSelection(all, p).label, 'Terra High');   // remembered per model
  p = selectModel(all, p, 'claude-sonnet-5-5');
  assert.deepEqual([resolveSelection(all, p).effort, selectEffort(all, p, 'high').efforts], [null, p.efforts]);   // no effort on a model without levels
  assert.deepEqual([effortOf(byId('codex-terra'), undefined), effortOf(byId('codex-terra'), { 'codex-terra': 'bogus' }), variantLabel(byId('codex-luna'), null)], ['medium', 'medium', 'Luna']);
});

test('effort is saved and restored, and invalid saved efforts are dropped when loading', () => {
  const s = store(), prefs = { ...DEFAULT_PREFS, model: 'codex-terra', efforts: { 'codex-terra': 'high', 'antigravity-gemini': 'low' } };
  assert.equal(savePrefs(s, prefs), true); assert.deepEqual(loadPrefs(s), prefs);
  const evil = store({ 'savetokens.v4': JSON.stringify({ efforts: { 'codex-terra': 'max', 'codex-luna': 'high', 'claude-sonnet-5-5': 'low', 'nope': 'low', 'antigravity-gemini': 'high' } }) });
  assert.deepEqual(loadPrefs(evil).efforts, { 'antigravity-gemini': 'high' });
  assert.equal('efforts' in loadPrefs(store({ 'savetokens.v4': JSON.stringify({ model: 'generic' }) })), false);   // older preferences load unchanged
});

// ======================================================================= model switching
test('switching across providers always yields a consistent selection, and never mutates the input preferences', () => {
  const frozen = Object.freeze({ ...DEFAULT_PREFS, efforts: Object.freeze({}) });
  const steps = [['provider', 'openai-codex', 'Terra Medium'], ['effort', 'high', 'Terra High'], ['model', 'codex-luna', 'Luna'], ['provider', 'antigravity', 'Gemini Medium'], ['effort', 'low', 'Gemini Low'],
    ['provider', 'anthropic', 'Claude Sonnet 5.5'], ['model', 'claude-haiku-5-5', 'Claude Haiku 5.5'], ['provider', 'custom', 'Other model (estimate only)'], ['provider', 'openai-codex', 'Terra High']];
  let p = frozen;
  for (const [kind, v, label] of steps) {
    const next = kind === 'provider' ? selectProvider(all, p, v) : kind === 'model' ? selectModel(all, p, v) : selectEffort(all, p, v);
    assert.notEqual(next, p); assert.deepEqual(p.efforts, p === frozen ? {} : p.efforts);
    p = next; const s = resolveSelection(all, p);
    assert.equal(s.label, label, `${kind} ${v}`); assert.ok(modelsOf(all, s.profile.provider).includes(s.profile));
  }
  assert.deepEqual(frozen, { ...DEFAULT_PREFS, efforts: {} });
  assert.equal(p.calls, DEFAULT_PREFS.calls); assert.deepEqual(p.pricing, {});             // selecting never touches prices or scenario settings
});

test('counting stays wired to the registry: only models with a real counter get a measured route', async () => {
  const c = createCounting({ fetchImpl: async () => reply(200, { counting: { available: true, models: ['claude-sonnet-5-5', 'claude-opus-5-5'], defaultModel: 'claude-sonnet-5-5', scope: 's', caveat: 'c' } }) });
  await c.init(); c.setLocalTokenizers([{ id: 'openai-o200k', label: 'OpenAI o200k' }]);
  const routes = Object.fromEntries(buildModels([{ id: 'openai-o200k', label: 'x', note: '' }]).map((m) => [m.id, c.routeFor(m.id)]));
  assert.deepEqual(routes, { 'claude-sonnet-5-5': 'anthropic', 'claude-opus-5-5': 'anthropic', 'claude-haiku-5-5': null, 'claude-fable-5-1': null, 'gemini-3.5-flash-lite': null,
    'antigravity-gemini': null, 'codex-terra': null, 'codex-luna': null, 'openai-o200k': 'local', generic: null });
  assert.equal(c.setModel('codex-terra'), false);                                          // a model with no counter cannot be "measured"
  assert.equal(c.setModel(null), true);
});

// ======================================================================= token estimation and fallback labelling
test('fallback estimates are labelled as fallbacks and never as exact', () => {
  const prompt = 'Explain Python variables to a beginner in three short paragraphs with two code examples.';
  const t = analyze(prompt).tokens;
  assert.deepEqual([t.kind, t.exact, t.method], ['estimated', false, 'heuristic-v2']);     // the offline estimator is unchanged
  for (const id of ['antigravity-gemini', 'codex-terra', 'codex-luna', 'generic']) {
    const b = tokenBasis(byId(id), 'estimated', null);
    assert.equal(b.level, 'fallback', id); assert.match(b.label, /Fallback estimate/); assert.doesNotMatch(b.label, /exact/i);
    assert.match(b.detail, /(not|no tokenizer is) verified|Any model/i, id);
  }
  assert.equal(tokenBasis(byId('gemini-3.5-flash-lite'), 'estimated', null).level, 'approximate');
  assert.match(tokenBasis(byId('claude-sonnet-5-5'), 'estimated', 'anthropic').label, /exact count available on request/);
  assert.match(tokenBasis(byId('claude-sonnet-5-5'), 'estimated', null).label, /not set up/);
  assert.equal(tokenBasis(byId('claude-sonnet-5-5'), 'measured', 'anthropic').level, 'measured');
  assert.equal(tokenBasis(buildModels([{ id: 'openai-o200k', label: 'x', note: '' }]).find((m) => m.id === 'openai-o200k'), 'estimated', 'local').level, 'exact-available');
  const none = { name: 'x', count: () => null };                                           // a counter with no measurement for this text never produces a "measured" label
  assert.deepEqual([countTokens(prompt, none).kind, countTokens(prompt, none).exact], ['estimated', false]);
});

test('reasoning effort never changes input tokens or the cost of the input', () => {
  const prompt = 'Explain Python variables to a beginner in three short paragraphs with two code examples.';
  const base = analyze(prompt).tokens.count, price = { in: 1, out: 4 };
  assert.equal(base, estimateTokens(prompt));
  for (const o of namedOptions(all, 'openai-codex').concat(namedOptions(all, 'antigravity'))) {
    const p = o.effort ? selectEffort(all, selectModel(all, DEFAULT_PREFS, o.profileId), o.effort) : selectModel(all, DEFAULT_PREFS, o.profileId);
    assert.equal(analyze(prompt).tokens.count, base, o.label);                              // the estimate does not look at the selection at all
    assert.deepEqual([p.calls, p.out, p.pricing], [DEFAULT_PREFS.calls, DEFAULT_PREFS.out, DEFAULT_PREFS.pricing], o.label);
    assert.deepEqual(estimateCost({ tokens: base, outputTokens: 500, price }), { input: (base / 1e6) * 1, output: (500 / 1e6) * 4, total: (base / 1e6) * 1 + (500 / 1e6) * 4 }, o.label);
  }
  for (const m of all.filter((x) => x.reasoning)) { assert.equal(m.reasoning.changesInputTokens, false); }
  assert.match(EFFORT_NOTE, /not the input tokens/);
});

// ======================================================================= pricing: missing, user-entered, verified
test('missing pricing is shown as unavailable and produces no cost or savings figures', () => {
  for (const id of ['antigravity-gemini', 'codex-terra', 'codex-luna', 'generic']) {
    const m = byId(id);
    assert.equal(estimateCost({ tokens: 1000, outputTokens: 500, price: m.price }), null, id);
    assert.equal(projectSavings({ before: 1000, after: 500, calls: 10000, price: m.price }), null, id);
    assert.match(pricingLine(m), /^Pricing unavailable: /, id);
  }
  assert.match(pricingLine(byId('antigravity-gemini')), /quota/); assert.match(pricingLine(byId('codex-terra')), /not pinned/);
  assert.equal(fmtUSD(null), '–'); assert.equal(fmtUSD(NaN), '–');
  assert.match(pricingLine(byId('claude-opus-5-5')), /\$4\.00\/M in · \$20\.00\/M out · verified 2026-11-08/);
  assert.match(pricingLine(byId('gemini-3.5-flash-lite')), /Free tier \(\$0\), rate-limited · reported, not verified/);
});

test('your own price is independent per model, labelled as yours, and unlocks cost estimates only for that model', () => {
  const m = buildModels([], { 'codex-terra': { in: 1.5, out: 6 }, 'antigravity-gemini': { in: -1, out: 3 }, 'claude-sonnet-5-5': { in: 2, out: 10 }, 'codex-luna': { in: 'x', out: 1 } });
  const t = byId('codex-terra', m);
  assert.deepEqual([t.pricing.status, t.price, t.edited, t.pricing.source], ['user', { in: 1.5, out: 6 }, true, null]);
  assert.ok(t.capabilities.includes('cost-estimate'));
  assert.match(pricingLine(t), /1\.50\/M in · \$6\.00\/M out · your price/);
  assert.equal(estimateCost({ tokens: 2_000_000, price: t.price }).total, 3);
  for (const id of ['antigravity-gemini', 'codex-luna']) { assert.equal(byId(id, m).price, null, id); assert.equal(byId(id, m).pricing.status, 'unavailable', id); }   // invalid entries are ignored
  assert.deepEqual([byId('claude-sonnet-5-5', m).pricing.status, byId('claude-sonnet-5-5', m).edited], ['verified', false]);   // entering the published price does not downgrade it
  assert.equal(byId('codex-terra', buildModels([], {})).price, null);                      // clearing the override restores "unavailable"
  assert.equal(byId('codex-luna', m).price, null);                                         // other models are unaffected
});

// ======================================================================= backward compatibility
test('older saved preferences and the older API keep working', () => {
  const s = store({ 'savetokens.v4': JSON.stringify({ model: 'generic', calls: 5, out: 3, theme: 'dark', pricing: { generic: { in: 1, out: 2 } } }) });
  const prefs = loadPrefs(s), m = buildModels([], prefs.pricing), sel = resolveSelection(m, prefs);
  assert.deepEqual([sel.profile.id, sel.provider.id, sel.effort, sel.profile.price, sel.profile.pricing.status], ['generic', 'custom', null, { in: 1, out: 2 }, 'user']);
  assert.equal(resolveSelection(all, { model: 'gpt-removed-model' }).profile.id, DEFAULT_PREFS.model);   // an unknown saved model falls back safely
  assert.equal(resolveSelection(all, {}).profile.id, DEFAULT_PREFS.model);
  for (const name of ['MODELS', 'buildModels', 'estimateCost', 'projectSavings', 'fmtUSD', 'loadPrefs', 'savePrefs', 'DEFAULT_PREFS', 'PRICING_AS_OF', 'PRICING_NOTE']) assert.ok(name in M, name);
  assert.deepEqual(buildModels([{ id: 'openai-o200k', label: 'L', note: 'n' }]).slice(-2).map((x) => x.id), ['openai-o200k', 'generic']);
  assert.equal(buildModels([], null).length, MODELS.length);
  assert.deepEqual(DEFAULT_PREFS, { model: 'claude-sonnet-5-5', calls: 10000, out: 0, theme: 'auto', pricing: {} });
});

// ======================================================================= UI and documentation contract
const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const app = readFileSync(join(dir, 'app.js'), 'utf8'), html = readFileSync(join(dir, 'index.html'), 'utf8'), css = readFileSync(join(dir, 'styles.css'), 'utf8');

test('UI: a labelled provider -> model -> effort cascade, effort hidden until supported, responsive, registry-driven', () => {
  for (const id of ['target-provider', 'target-model', 'target-effort']) { assert.match(html, new RegExp(`<select id="${id}"`)); assert.match(html, new RegExp(`for="${id}"`)); }
  assert.match(html, /id="effort-pick" hidden/); assert.ok(html.indexOf('target-provider') < html.indexOf('id="target-model"') && html.indexOf('id="target-model"') < html.indexOf('target-effort'));
  for (const s of [/selectProvider\(models, prefs/, /selectModel\(models, prefs/, /selectEffort\(models, prefs/, /\$\('effort-pick'\)\.hidden = !r/, /providersOf\(models\)/, /modelsOf\(models/, /resolveSelection\(models, prefs\)/]) assert.match(app, s, String(s));
  assert.doesNotMatch(app, /codex-terra|codex-luna|antigravity-gemini|gemini-3\.5/);        // no model ids hard-coded in the UI: the registry is the only source
  assert.doesNotMatch(app, /fillModelSelect/);
  assert.match(css, /\.cascade/); assert.match(css, /max-width:700px\)\{\.top \.cascade/);
  assert.ok(!/\sstyle\s*=/.test(html + app));
});

test('UI: estimates, prices and identities are described honestly, including when no price exists', () => {
  for (const s of [/tokenBasis\(m, t\.kind, counting\.route\)/, /Estimated · fallback/, /pricingLine\(m\)/, /No price, so no dollar savings are shown/, /modelIdLine\(m\)/, /PRICING_STATUS\[/, /user-requested label/, /EFFORT_NOTE/, /changes output tokens, not your prompt's input/]) assert.match(app, s, String(s));
  assert.match(html, /Pricing status/);
  assert.match(app, /if \(!m\.price\) return `<tr>/);                                       // models without a price get an explanatory row, not invented numbers
});

test('documentation exists and states what is and is not verified', () => {
  const root = join(dir, '..'), md = join(root, 'docs', 'MODELS.md'), qa = join(root, 'docs', 'QA-REPORT-model-intelligence.md');
  assert.ok(existsSync(md) && existsSync(qa));
  const doc = readFileSync(md, 'utf8');
  for (const s of [/Terra/, /Luna/, /unpinned/i, /not verified/i, /quota/i, /verified/i, /input tokens/i, /Pricing status/i]) assert.match(doc, s, String(s));
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /docs\/MODELS\.md/);
});
