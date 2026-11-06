import test from 'node:test';
import assert from 'node:assert/strict';
import { createCounting } from '../public/counting.js';
import { analyze, optimize, countTokens, estimateTokens } from '../public/core.js';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });
const CFG = { counting: { available: true, provider: 'anthropic', models: ['m-one', 'm-two'], defaultModel: 'm-two', scope: 'Counted as a single user message.', caveat: 'Anthropic calls this an estimate.' } };
const measured = (model, count) => ({ kind: 'measured', provider: 'anthropic', model, count, cached: false });

function fake(routes) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const r = routes[url]; return typeof r === 'function' ? r(init, calls.length) : r; };
  f.calls = calls; return f;
}
async function ready(count = (init) => reply(200, measured(JSON.parse(init.body).model, 25))) {
  const f = fake({ '/api/config': reply(200, CFG), '/api/count': count });
  const c = createCounting({ fetchImpl: f });
  assert.equal(await c.init(), true);
  return { c, f };
}

test('init: stays offline when there is no server, no key, or a malformed config', async () => {
  for (const f of [async () => { throw new Error('no server'); }, fake({ '/api/config': reply(200, { counting: { available: false } }) }),
    fake({ '/api/config': reply(500, {}) }), fake({ '/api/config': reply(200, { counting: { available: true, models: [] } }) }),
    fake({ '/api/config': reply(200, undefined) }), fake({ '/api/config': reply(200, {}) })]) {
    const c = createCounting({ fetchImpl: f });
    assert.equal(await c.init(), false); assert.equal(c.available, false); assert.equal(c.counter.count('hello there'), null);
    const m = await c.measure('hello there'); assert.equal(m.ok, false); assert.equal(m.code, 'not_configured');
  }
});

test('init: uses the server default model; only allow-listed models can be selected', async () => {
  const { c } = await ready();
  assert.deepEqual([c.model, c.models], ['m-two', ['m-one', 'm-two']]);
  assert.equal(c.setModel('gpt-4o'), false); assert.equal(c.model, 'm-two');
  assert.equal(c.setModel('m-one'), true); assert.equal(c.model, 'm-one');
});

test('measure: sends only text and model, and the counter then answers for exactly that text and model', async () => {
  const { c, f } = await ready();
  assert.equal(c.counter.count('Hello there'), null); // nothing measured yet: no guess
  const r = await c.measure('Hello there');
  assert.deepEqual([r.ok, r.count, r.model], [true, 25, 'm-two']);
  const sent = f.calls.find((x) => x.url === '/api/count');
  assert.deepEqual(JSON.parse(sent.init.body), { text: 'Hello there', model: 'm-two' });
  assert.deepEqual(Object.keys(sent.init.headers), ['content-type']);
  assert.equal(c.counter.count('Hello there'), 25);
  assert.equal(c.counter.count('Hello there!'), null);  // edited text: stale measurement is never shown
  c.setModel('m-one'); assert.equal(c.counter.count('Hello there'), null); // other model: different tokenizer
  c.setModel('m-two'); assert.equal(c.counter.count('Hello there'), 25);
  await c.measure('Hello there');
  assert.equal(f.calls.filter((x) => x.url === '/api/count').length, 1); // second call came from the cache
});

test('measure: errors are surfaced with the server message; nothing is cached on failure', async () => {
  const cases = [
    [() => { throw new Error('refused'); }, 'network'], [() => reply(503, { error: { code: 'not_configured', message: 'Exact counting is off.' } }), 'not_configured'],
    [() => reply(429, { error: { code: 'rate_limited', message: 'Rate limit reached.', retryAfter: 7 } }), 'rate_limited'],
    [() => reply(502, undefined), 'error'], [() => reply(200, undefined), 'bad_response'],
    [() => reply(200, { ...measured('m-two', 5), kind: 'estimated' }), 'bad_response'], [() => reply(200, measured('m-one', 5)), 'bad_response'],
    [() => reply(200, { ...measured('m-two', 5), provider: 'openai' }), 'bad_response'], [() => reply(200, measured('m-two', -1)), 'bad_response'],
    [() => reply(200, measured('m-two', 2.5)), 'bad_response'], [() => reply(200, measured('m-two', '5')), 'bad_response'],
  ];
  for (const [route, code] of cases) {
    const { c } = await ready(route);
    const r = await c.measure('some prompt text');
    assert.equal(r.ok, false, code); assert.equal(r.code, code); assert.ok(r.message.length > 10);
    assert.equal(c.counter.count('some prompt text'), null);
  }
  const { c } = await ready(() => reply(429, { error: { code: 'rate_limited', message: 'm', retryAfter: 7 } }));
  assert.equal((await c.measure('some prompt text')).retryAfter, 7);
});

test('measure: empty text is never sent', async () => {
  const { c, f } = await ready();
  for (const t of ['', '  \n ']) assert.equal((await c.measure(t)).code, 'empty_text');
  assert.equal(f.calls.filter((x) => x.url === '/api/count').length, 0);
});

// ---------------------------------------------------------------- core integration
test('core: a counter that returns null is an estimate, not a failure; a throw is flagged', () => {
  const t = 'Summarize the attached report in five bullet points.';
  for (const v of [null, undefined]) { const r = countTokens(t, { name: 'x', count: () => v }); assert.equal(r.kind, 'estimated'); assert.equal(r.counterFailed, undefined); }
  assert.equal(analyze(t, { counter: { name: 'x', count: () => null } }).notes.some((n) => /failed/.test(n)), false);
  assert.equal(countTokens(t, { name: 'x', count: () => { throw new Error('x'); } }).counterFailed, true);
  const m = countTokens(t, { name: 'N', provider: 'p', model: 'm', caveat: 'c', count: () => 9 });
  assert.deepEqual([m.kind, m.count, m.provider, m.model, m.caveat, m.method], ['measured', 9, 'p', 'm', 'c', 'N']);
});

test('core + browser module: estimated until measured, measured only for the exact text and model', async () => {
  const { c } = await ready();
  const t = 'Please summarize this report in order to save time for the team.';
  const before = analyze(t, { counter: c.counter });
  assert.deepEqual([before.tokens.kind, before.tokens.count], ['estimated', estimateTokens(t)]);
  await c.measure(t);
  const after = analyze(t, { counter: c.counter });
  assert.deepEqual([after.tokens.kind, after.tokens.count, after.tokens.provider, after.tokens.model], ['measured', 25, 'anthropic', 'm-two']);
  assert.match(after.tokens.method, /count_tokens, m-two/); assert.match(after.tokens.caveat, /single user message/);
  assert.equal(after.score, before.score);                        // the score never depends on the counter
  assert.equal(after.findings.length, before.findings.length);
  assert.equal(analyze(t + ' ', { counter: c.counter }).tokens.kind, 'estimated');
  c.setModel('m-one'); assert.equal(analyze(t, { counter: c.counter }).tokens.kind, 'estimated');
});

test('optimize: before/after are the same kind; a measured number is never subtracted from an estimate', async () => {
  const { c } = await ready((init) => { const { text, model } = JSON.parse(init.body); return reply(200, measured(model, text.length)); });
  const t = 'Please note that I want you to summarize this in order to save time.';
  const r = analyze(t, { counter: c.counter });
  const ids = new Set(r.findings.map((f) => f.id));
  const out = optimize(t, r.findings, ids).text;
  await c.measure(t);                                            // only the original is measured
  const mixed = optimize(t, r.findings, ids, { counter: c.counter });
  assert.equal(mixed.kind, 'estimated');
  assert.deepEqual([mixed.before, mixed.after], [estimateTokens(t), estimateTokens(out)]);
  await c.measure(out);                                          // now both are
  const both = optimize(t, r.findings, ids, { counter: c.counter });
  assert.deepEqual([both.kind, both.before, both.after, both.saved, both.model], ['measured', t.length, out.length, t.length - out.length, 'm-two']);
  const none = optimize(t, r.findings, new Set(), { counter: c.counter });   // unchanged text stays measured
  assert.deepEqual([none.kind, none.saved], ['measured', 0]);
});

test('without any server the analysis is fully offline and labelled as estimated', async () => {
  const c = createCounting({ fetchImpl: async () => { throw new Error('offline'); } });
  await c.init();
  const t = 'Please summarize this report in order to save time.';
  const r = analyze(t, { counter: c.counter });
  assert.equal(r.tokens.kind, 'estimated'); assert.equal(r.tokens.exact, false); assert.ok(r.findings.length > 0);
  assert.equal(optimize(t, r.findings, new Set(r.findings.map((f) => f.id)), { counter: c.counter }).kind, 'estimated');
});

test('provider counts are measured but not "exact": the caveat and the provider label come from the server', async () => {
  const { c } = await ready();
  await c.measure('Hello there');
  const t = countTokens('Hello there', c.counter);
  assert.deepEqual([t.kind, t.exact, t.provider], ['measured', false, 'anthropic']);
  assert.match(t.caveat, /single user message/); assert.match(t.caveat, /Anthropic calls this an estimate/);
  assert.equal(countTokens('x y z', { name: 'mock', count: () => 3 }).exact, true); // custom counters keep the old default
});

test('measure: the server request id is passed through so failures can be reported', async () => {
  const { c } = await ready(() => reply(502, { error: { code: 'permission', message: 'This key may not count for this model.', requestId: 'req_abc123' } }));
  const r = await c.measure('some prompt text');
  assert.deepEqual([r.ok, r.code, r.requestId], [false, 'permission', 'req_abc123']);
});
