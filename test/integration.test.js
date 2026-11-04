// Client module <-> real HTTP server <-> mocked Anthropic. This is the contract the "Count exactly" button relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createCounting } from '../public/counting.js';
import { analyze, optimize } from '../public/core.js';

const KEY = 'sk-ant-integration-SECRET9';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function boot(upstream, env = { ANTHROPIC_API_KEY: KEY }) {
  const srv = http.createServer(createApp({ config: loadConfig(env), fetchImpl: upstream }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const client = createCounting({ fetchImpl: (u, i) => fetch(origin + u, i) });
  return { client, origin, close: () => new Promise((r) => srv.close(r)) };
}

test('Count exactly, end to end: only a real upstream answer becomes a measured count', async () => {
  const seen = [];
  const { client, close } = await boot(async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return json(200, { input_tokens: seen.length * 100 + 7 }, { 'request-id': 'req_it_0001' }); });
  try {
    assert.equal(await client.init(), true);
    const text = 'Please summarize this report in order to save time.';
    assert.equal(analyze(text, { counter: client.counter }).tokens.kind, 'estimated');   // before any API answer
    const r = analyze(text, { counter: client.counter });
    const trimmed = optimize(text, r.findings, new Set(r.findings.map((f) => f.id))).text;
    const [a, b] = await Promise.all([client.measure(text), client.measure(trimmed)]);
    assert.deepEqual([a.ok, b.ok], [true, true]);
    assert.equal(seen.length, 2);
    for (const s of seen) {                                                              // what Anthropic actually received
      assert.equal(s.url, 'https://api.anthropic.com/v1/messages/count_tokens');
      assert.equal(s.init.headers['x-api-key'], KEY); assert.equal(s.init.headers['anthropic-version'], '2023-06-01');
      assert.deepEqual(Object.keys(s.body).sort(), ['messages', 'model']); assert.equal(s.body.messages[0].role, 'user');
    }
    assert.deepEqual(seen.map((s) => s.body.messages[0].content).sort(), [text, trimmed].sort());
    const m = analyze(text, { counter: client.counter }).tokens;
    assert.deepEqual([m.kind, m.provider, m.exact], ['measured', 'anthropic', false]);
    assert.ok([107, 207].includes(m.count));                                             // exactly what the API returned
    assert.equal(optimize(text, r.findings, new Set(r.findings.map((f) => f.id)), { counter: client.counter }).kind, 'measured');
  } finally { await close(); }
});

test('Count exactly, failures: the UI gets a clear error and stays on estimates', async () => {
  const script = [json(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }), json(429, { error: { message: 's' } }, { 'retry-after': '9' }), json(200, { oops: true }), json(200, { input_tokens: 12 })];
  let n = 0;
  const { client, close } = await boot(async () => script[n++]);
  try {
    await client.init();
    const t = 'Summarize the attached report in five bullet points.';
    const codes = [];
    for (let i = 0; i < 3; i++) { const r = await client.measure(t); codes.push([r.ok, r.code, r.retryAfter]); assert.equal(client.counter.count(t), null); assert.ok(!JSON.stringify(r).includes(KEY)); }
    assert.deepEqual(codes, [[false, 'auth', undefined], [false, 'rate_limited', 9], [false, 'bad_response', undefined]]);
    assert.equal(analyze(t, { counter: client.counter }).tokens.kind, 'estimated');
    assert.equal((await client.measure(t)).count, 12);
    assert.equal(analyze(t, { counter: client.counter }).tokens.kind, 'measured');
  } finally { await close(); }
});

test('with no key the client stays offline and never calls the API', async () => {
  let calls = 0;
  const { client, close } = await boot(async () => { calls++; return json(200, { input_tokens: 1 }); }, {});
  try {
    assert.equal(await client.init(), false);
    assert.equal((await client.measure('hello there')).code, 'not_configured');
    assert.equal(analyze('Please summarize this.', { counter: client.counter }).tokens.kind, 'estimated');
    assert.equal(calls, 0);
  } finally { await close(); }
});

test('model switching: a count for one model is never shown for another', async () => {
  const { client, close } = await boot(async (u, init) => json(200, { input_tokens: JSON.parse(init.body).model.length }));
  try {
    await client.init();
    const [m1, m2] = client.models, text = 'Summarize this report in five bullet points.';
    client.setModel(m1); await client.measure(text);
    assert.equal(client.counter.count(text), m1.length);
    client.setModel(m2); assert.equal(client.counter.count(text), null);
    client.setModel(m1); assert.equal(client.counter.count(text), m1.length);
  } finally { await close(); }
});
