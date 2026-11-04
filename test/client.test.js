import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, buildModels, estimateCost, projectSavings, fmtUSD, loadPrefs, savePrefs, DEFAULT_PREFS, PRICING_AS_OF } from '../public/models.js';
import { diffWords } from '../public/diff.js';
import { createRewriter } from '../public/rewrite.js';
import { createCounting } from '../public/counting.js';
import { analyze } from '../public/core.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

// ---------------------------------------------------------------- models and cost
test('model registry: current Claude IDs, no invented prices, every price is a sane number', () => {
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) assert.ok(MODELS.some((m) => m.id === id && m.count === 'anthropic'), id);
  assert.equal(MODELS.find((m) => m.id === 'generic').price, null);                      // unknown model: no made-up price
  assert.ok(MODELS.every((m) => m.price === null || (m.price.in >= 0 && m.price.out >= m.price.in * 0 && Number.isFinite(m.price.out))));
  assert.match(PRICING_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
});

test('buildModels: adds local tokenizers before "generic"; validated overrides apply, junk is ignored and flagged only when real', () => {
  const m = buildModels([{ id: 'openai-o200k', label: 'OpenAI o200k', note: 'n' }], { 'claude-sonnet-5-5': { in: 3, out: 15 }, 'claude-opus-5-5': { in: -1, out: 5 }, 'claude-haiku-5-5': { in: 'x', out: 1 }, generic: { in: 1, out: 2 }, 'claude-fable-5-1': { in: 10, out: 50 } });
  assert.deepEqual(m.slice(-2).map((x) => x.id), ['openai-o200k', 'generic']);
  assert.deepEqual(m.find((x) => x.id === 'openai-o200k').count, 'local');
  const get = (id) => m.find((x) => x.id === id);
  assert.deepEqual([get('claude-sonnet-5-5').price, get('claude-sonnet-5-5').edited], [{ in: 3, out: 15 }, true]);
  assert.deepEqual(get('claude-opus-5-5').price, { in: 4, out: 20 });                  // negative override rejected
  assert.deepEqual(get('claude-haiku-5-5').price, { in: 0.1, out: 0.5 });             // non-number rejected
  assert.deepEqual([get('generic').price, get('generic').edited], [{ in: 1, out: 2 }, true]);
  assert.equal(get('claude-fable-5-1').edited, false);                                // same as default: not "edited"
  assert.equal(buildModels([], null).length, MODELS.length);
});

test('cost maths: per-million pricing, optional output tokens, null without a price, savings count input only', () => {
  assert.deepEqual(estimateCost({ tokens: 1_000_000, price: { in: 2, out: 10 } }), { input: 2, output: 0, total: 2 });
  assert.deepEqual(estimateCost({ tokens: 500, outputTokens: 1000, price: { in: 2, out: 10 } }), { input: 0.001, output: 0.01, total: 0.011 });
  assert.equal(estimateCost({ tokens: 10, price: null }), null);
  assert.equal(estimateCost({ tokens: NaN, price: { in: 1, out: 1 } }), null);
  assert.equal(estimateCost({ tokens: -5, price: { in: 1, out: 1 } }), null);
  assert.equal(estimateCost({ tokens: 10, outputTokens: NaN, price: { in: 1, out: 1 } }).output, 0);
  const s = projectSavings({ before: 1200, after: 1000, calls: 10000, price: { in: 4, out: 20 } });
  assert.ok(Math.abs(s.perCall - 0.0008) < 1e-12 && Math.abs(s.per1k - 0.8) < 1e-9 && Math.abs(s.perMonth - 8) < 1e-9);
  assert.equal(projectSavings({ before: 100, after: 150, calls: 5, price: { in: 1, out: 1 } }).perCall, 0);   // a longer prompt never reports savings
  assert.equal(projectSavings({ before: 100, after: 50, calls: 5, price: null }), null);
  assert.equal(projectSavings({ before: 100, after: 50, calls: NaN, price: { in: 1, out: 1 } }).perMonth, 0);
});

test('fmtUSD: readable at every magnitude, never scientific notation or NaN', () => {
  assert.deepEqual([0, 0.00001, 0.0042, 0.05, 1.5, 1234.5678].map(fmtUSD), ['$0', '<$0.0001', '$0.0042', '$0.050', '$1.50', '$1234.57']);
  assert.deepEqual([null, undefined, NaN, Infinity].map(fmtUSD), ['–', '–', '–', '–']);
});

test('preferences: round-trip, validation on load, and a broken or full storage never throws', () => {
  const s = store(); const prefs = { model: 'claude-opus-5-5', calls: 2500, out: 300, theme: 'dark', pricing: { 'claude-opus-5-5': { in: 3, out: 12 } } };
  assert.equal(savePrefs(s, prefs), true); assert.deepEqual(loadPrefs(s), prefs);
  assert.deepEqual(loadPrefs(store()), DEFAULT_PREFS);
  const evil = store({ 'savetokens.v4': JSON.stringify({ model: 5, calls: -4, theme: 'neon', pricing: { 'bad id!': { in: 1, out: 1 }, ok: { in: 1, out: 2 }, nan: { in: 'a', out: 1 }, big: { in: 1e9, out: 1 } } }) });
  const p = loadPrefs(evil);
  assert.deepEqual([p.model, p.calls, p.theme, Object.keys(p.pricing)], [DEFAULT_PREFS.model, DEFAULT_PREFS.calls, 'auto', ['ok']]);
  assert.deepEqual(loadPrefs(store({ 'savetokens.v4': '{nope' })), DEFAULT_PREFS);
  assert.deepEqual(loadPrefs({ getItem() { throw new Error('denied'); } }), DEFAULT_PREFS);
  assert.equal(savePrefs({ setItem() { throw new Error('quota'); } }, prefs), false);
});

// ---------------------------------------------------------------- diff
test('diff: rebuilds both sides exactly, marks only real changes, handles empty and identical input', () => {
  const cases = [['', ''], ['a b c', ''], ['', 'a b c'], ['same text', 'same text'], ['I would like you to summarize this in order to save time.', 'Summarize this to save time.'],
    ['a\n\nb  c', 'a b\nc'], ['x '.repeat(50), 'x '.repeat(40) + 'y '], ['日本語 の 文章', '日本語 文章 です']];
  for (const [a, b] of cases) {
    const d = diffWords(a, b);
    assert.equal(d.filter((p) => p.type !== 'add').map((p) => p.text).join(''), a);
    assert.equal(d.filter((p) => p.type !== 'del').map((p) => p.text).join(''), b);
    for (let i = 1; i < d.length; i++) assert.notEqual(d[i].type, d[i - 1].type);   // runs are merged
  }
  assert.deepEqual(diffWords('same', 'same'), [{ type: 'eq', text: 'same' }]);
  assert.deepEqual(diffWords('', ''), []);
  const d = diffWords('keep this please', 'keep this');
  assert.deepEqual(d.filter((p) => p.type === 'del').map((p) => p.text.trim()), ['please']);
  assert.equal(d.filter((p) => p.type === 'add').length, 0);
});

test('diff: very large edits fall back to a correct coarse diff instead of hanging', () => {
  const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join(' '), b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join(' ');
  const t0 = Date.now(), d = diffWords(a, b);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(d.filter((p) => p.type !== 'add').map((p) => p.text).join(''), a); assert.equal(d.filter((p) => p.type !== 'del').map((p) => p.text).join(''), b);
});

// ---------------------------------------------------------------- rewrite client
const PROV = { rewrite: [{ id: 'gemini', label: 'Google Gemini', configured: true, model: 'm', privacy: 'p', setup: 's' }, { id: 'ollama', label: 'Ollama', configured: false }, { bad: 1 }], rewriteMaxChars: 5000, tokenizers: [{ id: 'tok', label: 'Tok' }, null] };
const suggestion = (over = {}) => ({ kind: 'ai_suggestion', text: 'Short.', lost: [], provider: 'gemini', model: 'm', tokens: { before: 10, after: 2, saved: 8, kind: 'estimated' }, ...over });

test('rewrite client: unavailable without providers, never calls the network until rewrite() is invoked', async () => {
  let calls = 0;
  const off = createRewriter({ fetchImpl: async (u) => { calls++; return u === '/api/providers' ? reply(200, { rewrite: [{ id: 'g', label: 'G', configured: false }], tokenizers: [] }) : reply(500, {}); } });
  assert.equal(await off.init(), false);
  assert.equal((await off.rewrite('Please shorten this prompt.', 'g')).code, 'not_configured');
  assert.equal(calls, 1);                                                             // init only; the prompt was never sent
  for (const f of [async () => { throw new Error('x'); }, async () => reply(500, {}), async () => reply(200, undefined), async () => reply(200, { rewrite: 'no' })]) assert.equal(await createRewriter({ fetchImpl: f }).init(), false);
});

test('rewrite client: parses providers, validates the response shape, and surfaces errors with retry hints', async () => {
  const sent = [];
  const mk = (resp) => createRewriter({ fetchImpl: async (u, i) => { if (u === '/api/providers') return reply(200, PROV); sent.push(JSON.parse(i.body)); return typeof resp === 'function' ? resp() : resp; } });
  const r = mk(reply(200, suggestion()));
  assert.equal(await r.init(), true);
  assert.deepEqual([r.providers.map((p) => p.id), r.maxChars, r.tokenizers.map((t) => t.id)], [['gemini', 'ollama'], 5000, ['tok']]);
  const ok = await r.rewrite('A long prompt to shorten.', 'gemini');
  assert.deepEqual([ok.ok, ok.text, ok.lost, ok.provider], [true, 'Short.', [], 'gemini']);
  assert.deepEqual(sent[0], { text: 'A long prompt to shorten.', provider: 'gemini' });   // only the text and provider id; no keys exist client-side
  assert.equal((await r.rewrite('  ', 'gemini')).code, 'empty_text');
  const bad = [suggestion({ kind: 'measured' }), suggestion({ text: '  ' }), suggestion({ lost: 'none' }), { text: 'x' }];
  for (const b of bad) { const x = await (async () => { const rr = mk(reply(200, b)); await rr.init(); return rr.rewrite('A long prompt.', 'gemini'); })(); assert.deepEqual([x.ok, x.code], [false, 'bad_response']); }
  const e = mk(reply(429, { error: { code: 'quota', message: 'The free-tier quota or rate limit is reached.', retryAfter: 9 } })); await e.init();
  assert.deepEqual(await e.rewrite('A long prompt.', 'gemini'), { ok: false, code: 'quota', message: 'The free-tier quota or rate limit is reached.', retryAfter: 9 });
  const n = createRewriter({ fetchImpl: async (u) => { if (u === '/api/providers') return reply(200, PROV); throw new Error('refused'); } }); await n.init();
  assert.equal((await n.rewrite('A long prompt.', 'gemini')).code, 'network');
});

// ---------------------------------------------------------------- counting: local tokenizers
test('counting: a local tokenizer is a second exact route, labelled as local and exact, without touching Anthropic', async () => {
  const calls = [];
  const f = async (u, i) => {
    calls.push(u);
    if (u === '/api/config') return reply(200, { counting: { available: true, provider: 'anthropic', models: ['m-one'], defaultModel: 'm-one', scope: 'Single user message.', caveat: 'An estimate.' } });
    if (u === '/api/count-local') { const b = JSON.parse(i.body); return reply(200, { kind: 'measured', provider: 'local', model: b.model, count: 7, exact: true, cached: false }); }
    return reply(404, {});
  };
  const c = createCounting({ fetchImpl: f }); await c.init();
  c.setLocalTokenizers([{ id: 'tok-a', label: 'Tok A', note: 'Own encoding.' }, { nope: 1 }, null]);
  assert.deepEqual([c.routeFor('m-one'), c.routeFor('tok-a'), c.routeFor('gpt-4o'), c.localModels.length], ['anthropic', 'local', null, 1]);
  assert.equal(c.setModel('gpt-4o'), false); assert.equal(c.setModel('tok-a'), true); assert.equal(c.route, 'local');
  const text = 'Summarize the report in five bullet points.';
  assert.equal(analyze(text, { counter: c.counter }).tokens.kind, 'estimated');
  assert.equal((await c.measure(text)).count, 7);
  assert.deepEqual(calls.filter((u) => u.startsWith('/api/count')), ['/api/count-local']);
  const t = analyze(text, { counter: c.counter }).tokens;
  assert.deepEqual([t.kind, t.provider, t.exact, t.model, t.method], ['measured', 'local', true, 'tok-a', 'Local tokenizer, Tok A']);
  assert.match(t.caveat, /Own encoding/);
  c.setModel('m-one'); assert.equal(analyze(text, { counter: c.counter }).tokens.kind, 'estimated');   // other model: other tokenizer
  assert.equal(c.counter.provider, 'anthropic'); assert.equal(c.counter.exact, false);
});

test('counting: clearing the model (a model with no exact route) forces estimates and blocks measuring', async () => {
  const c = createCounting({ fetchImpl: async (u) => (u === '/api/config' ? reply(200, { counting: { available: true, models: ['m'], defaultModel: 'm' } }) : reply(200, { kind: 'measured', provider: 'anthropic', model: 'm', count: 3 })) });
  await c.init(); await c.measure('hello there friend');
  assert.equal(c.counter.count('hello there friend'), 3);
  assert.equal(c.setModel(null), true);
  assert.equal(c.counter.count('hello there friend'), null); assert.equal(c.route, null);
  assert.equal((await c.measure('hello there friend')).code, 'not_configured');
  assert.equal(analyze('Summarize this report in five bullets.', { counter: c.counter }).tokens.kind, 'estimated');
  c.setModel('m'); assert.equal(c.counter.count('hello there friend'), 3);
});

test('counting: a local response claiming the wrong provider or model is discarded', async () => {
  for (const bad of [{ provider: 'anthropic' }, { model: 'other' }, { kind: 'estimated' }, { count: 1.5 }]) {
    const f = async (u, i) => (u === '/api/config' ? reply(200, { counting: { available: false } }) : reply(200, { kind: 'measured', provider: 'local', model: JSON.parse(i.body).model, count: 4, ...bad }));
    const c = createCounting({ fetchImpl: f }); await c.init(); c.setLocalTokenizers([{ id: 'tok-a', label: 'T' }]); c.setModel('tok-a');
    const r = await c.measure('hello there'); assert.deepEqual([r.ok, r.code], [false, 'bad_response']); assert.equal(c.counter.count('hello there'), null);
  }
});
