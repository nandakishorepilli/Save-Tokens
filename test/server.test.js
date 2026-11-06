import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadConfig, loadEnvFile } from '../server/config.js';
import { createAnthropicCounter, CountError } from '../server/anthropic.js';
import { createApp } from '../server/app.js';

const KEY = 'sk-ant-test-SECRET123';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (n) => json(200, { input_tokens: n });
const err = (status, message, headers) => json(status, { type: 'error', error: { type: 'x', message } }, headers);
const errT = (status, type, message = 'x', headers) => json(status, { type: 'error', error: { type, message } }, headers);
const upstream = (handler) => { const calls = []; const fn = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return handler(calls.length, init); }; fn.calls = calls; return fn; };

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text, json: j }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (port, payload, headers = {}) => call(port, { method: 'POST', path: '/api/count', headers: { 'content-type': 'application/json', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });

async function withApp(opts, fn) {
  const { env = { ANTHROPIC_API_KEY: KEY }, fetchImpl = upstream(() => ok(1)), now, over = {}, root } = opts;
  const config = { ...loadConfig(env), ...over };
  const srv = http.createServer(createApp({ config, fetchImpl, now, root }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(srv.address().port, fetchImpl, config); } finally { await new Promise((r) => srv.close(r)); }
}

// ---------------------------------------------------------------- config
test('parseEnv: comments, quotes, export, inline comments; real env wins over the file', () => {
  const e = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'  \nD=val # note\n\nbad line\nE=');
  assert.deepEqual(e, { A: '1', B: 'two words', C: 'x', D: 'val', E: '' });
  const dir = mkdtempSync(join(tmpdir(), 'st-')); writeFileSync(join(dir, '.env'), 'X=file\nY=file\n');
  const env = { X: 'real' };
  assert.equal(loadEnvFile(join(dir, '.env'), env), true);
  assert.deepEqual(env, { X: 'real', Y: 'file' });
  assert.equal(loadEnvFile(join(dir, 'missing'), {}), false);
});

test('loadConfig: safe defaults, no key means counting off, bad values are ignored with warnings', () => {
  const d = loadConfig({});
  assert.equal(d.apiKey, ''); assert.equal(d.host, '127.0.0.1'); assert.equal(d.defaultModel, d.models[0]);
  assert.ok(d.models.length >= 1 && d.baseUrl === 'https://api.anthropic.com' && d.warnings.length === 0);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: '  k  ' }).apiKey, 'k');
  const m = loadConfig({ ANTHROPIC_COUNT_MODELS: 'claude-a-1, bad model!, claude-a-1,claude-b-2' });
  assert.deepEqual(m.models, ['claude-a-1', 'claude-b-2']); assert.ok(m.warnings.length);
  assert.ok(loadConfig({ ANTHROPIC_COUNT_MODELS: '!!!' }).models.length >= 1);
  assert.equal(loadConfig({ ANTHROPIC_BASE_URL: 'http://evil.example.com' }).baseUrl, 'https://api.anthropic.com');
  assert.equal(loadConfig({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999/' }).baseUrl, 'http://127.0.0.1:9999');
  const n = loadConfig({ PORT: 'abc', COUNT_RATE_PER_MIN: '0', COUNT_MAX_CHARS: '5' });
  assert.deepEqual([n.port, n.ratePerMin, n.maxChars], [5173, 30, 100000]);
});

// ---------------------------------------------------------------- anthropic client
test('anthropic client: sends the documented request and returns input_tokens', async () => {
  const f = upstream(() => ok(14));
  const count = createAnthropicCounter({ apiKey: KEY, fetchImpl: f });
  const got = await count('Hello, world', 'claude-x-1');
  assert.equal(got.count, 14); assert.equal(got.requestId, undefined);
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['x-api-key'], KEY); assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(c.body, { model: 'claude-x-1', messages: [{ role: 'user', content: 'Hello, world' }] });
});

test('anthropic client: maps every failure to a typed error and never leaks the key', async () => {
  const run = (resp) => createAnthropicCounter({ apiKey: KEY, fetchImpl: async () => resp })('hi', 'm').then(() => null, (e) => e);
  const cases = [
    [err(401, 'bad'), 'auth', 502], [err(403, 'nope'), 'permission', 502], [err(404, 'x'), 'model_unavailable', 502],
    [errT(400, 'authentication_error'), 'auth', 502], [errT(400, 'permission_error'), 'permission', 502], [err(413, 'big'), 'too_large', 413], [err(408, 'x'), 'upstream_unavailable', 502], [err(418, 'teapot'), 'rejected', 502],
    [err(429, 'slow', { 'retry-after': '7' }), 'rate_limited', 429], [err(500, 'x'), 'upstream_unavailable', 502], [err(529, 'x'), 'upstream_unavailable', 502],
    [err(400, `invalid key ${KEY}`), 'rejected', 502], [new Response('<html>', { status: 200 }), 'bad_response', 502],
    [json(200, {}), 'bad_response', 502], [json(200, { input_tokens: 1.5 }), 'bad_response', 502], [json(200, { input_tokens: -1 }), 'bad_response', 502],
  ];
  for (const [resp, code, status] of cases) {
    const e = await run(resp);
    assert.ok(e instanceof CountError, code); assert.equal(e.code, code); assert.equal(e.status, status);
    assert.ok(!e.message.includes(KEY), `${code} leaked the key`);
  }
  assert.equal((await run(err(429, 's', { 'retry-after': '7' }))).retryAfter, 7);
  assert.equal((await run(err(429, 's'))).retryAfter, 30);
  assert.equal((await run(err(429, 's', { 'retry-after': '99999' }))).retryAfter, 600);
  const net = await createAnthropicCounter({ apiKey: KEY, fetchImpl: async () => { throw new Error(`boom ${KEY}`); } })('hi', 'm').catch((e) => e);
  assert.deepEqual([net.code, net.status], ['network', 502]); assert.ok(!net.message.includes(KEY));
});

test('anthropic client: times out instead of hanging', async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const e = await createAnthropicCounter({ apiKey: KEY, fetchImpl: hang, timeoutMs: 30 })('hi', 'm').catch((x) => x);
  assert.deepEqual([e.code, e.status], ['timeout', 504]);
});

// ---------------------------------------------------------------- HTTP API
test('no API key: offline mode is reported honestly and upstream is never called', async () => {
  await withApp({ env: {} }, async (port, f) => {
    const c = await call(port, { path: '/api/config' });
    assert.deepEqual(c.json, { counting: { available: false, reason: 'not_configured' } });
    const r = await post(port, { text: 'hello there friend' });
    assert.equal(r.status, 503); assert.equal(r.json.error.code, 'not_configured');
    assert.equal(f.calls.length, 0);
    assert.equal((await call(port, { path: '/' })).status, 200); // the app itself still serves
  });
});

test('with a key: config lists models without exposing the key; count returns a labelled measurement', async () => {
  await withApp({ fetchImpl: upstream(() => ok(42)) }, async (port, f, cfg) => {
    const c = await call(port, { path: '/api/config' });
    assert.equal(c.json.counting.available, true); assert.deepEqual(c.json.counting.models, cfg.models);
    assert.ok(!c.text.includes(KEY) && !c.text.includes('SECRET'));
    const r = await post(port, { text: 'Summarize this report.', model: cfg.models[1] });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.kind, r.json.provider, r.json.model, r.json.count, r.json.cached], ['measured', 'anthropic', cfg.models[1], 42, false]);
    assert.match(r.json.scope, /single user message/);
    assert.ok(!r.text.includes(KEY));
    assert.equal(f.calls[0].body.model, cfg.models[1]);
    assert.equal((await post(port, { text: 'No model given.' })).json.model, cfg.defaultModel);
  });
});

test('identical requests are served from cache; a different model is a different measurement', async () => {
  await withApp({ fetchImpl: upstream((n) => ok(10 * n)) }, async (port, f, cfg) => {
    const a = await post(port, { text: 'same text here', model: cfg.models[0] });
    const b = await post(port, { text: 'same text here', model: cfg.models[0] });
    assert.deepEqual([a.json.count, a.json.cached, b.json.count, b.json.cached], [10, false, 10, true]);
    const c = await post(port, { text: 'same text here', model: cfg.models[1] });
    assert.deepEqual([c.json.count, c.json.cached], [20, false]); assert.equal(f.calls.length, 2);
  });
});

test('request validation: bad input is rejected before any upstream call', async () => {
  await withApp({ over: { maxChars: 100 } }, async (port, f) => {
    const j = { 'content-type': 'application/json' };
    const check = async (resp, status, code) => { assert.equal(resp.status, status, code); assert.equal(resp.json.error.code, code); };
    await check(await post(port, '{not json'), 400, 'bad_json');
    await check(await call(port, { method: 'POST', path: '/api/count', headers: { 'content-type': 'text/plain' }, body: '{"text":"x"}' }), 415, 'unsupported_media_type');
    await check(await post(port, {}), 400, 'bad_request');
    await check(await post(port, { text: 5 }), 400, 'bad_request');
    await check(await post(port, { text: 'hello there', model: 7 }), 400, 'bad_request');
    await check(await post(port, { text: 'hello there', model: 'gpt-4o' }), 400, 'unsupported_model');
    await check(await post(port, { text: 'hello there', model: 'claude-sonnet-5-5; drop' }), 400, 'unsupported_model');
    await check(await post(port, { text: '   \n ' }), 400, 'empty_text');
    await check(await post(port, { text: 'x'.repeat(101) }), 413, 'too_large');
    await check(await post(port, `{"text":"${'x'.repeat(3000)}"}`), 413, 'too_large'); // over the byte limit (maxChars*4+1024)
    await check(await call(port, { path: '/api/count' }), 405, 'method_not_allowed');
    await check(await call(port, { method: 'POST', path: '/api/config' }), 405, 'method_not_allowed');
    await check(await call(port, { path: '/api/nope' }), 404, 'not_found');
    assert.equal(f.calls.length, 0);
  });
});

test('browser-abuse protection: foreign Host (DNS rebinding) and foreign Origin are refused', async () => {
  await withApp({}, async (port, f) => {
    assert.equal((await post(port, { text: 'hello there' }, { host: 'evil.example.com' })).json.error.code, 'forbidden_host');
    assert.equal((await call(port, { path: '/api/config', headers: { host: 'evil.example.com' } })).status, 403);
    assert.equal((await post(port, { text: 'hello there' }, { origin: 'http://evil.example.com' })).json.error.code, 'forbidden_origin');
    assert.equal(f.calls.length, 0);
    assert.equal((await post(port, { text: 'hello there' }, { origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await post(port, { text: 'hello again' }, { host: `localhost:${port}` })).status, 200);
    assert.equal((await post(port, { text: 'third try', }, { host: 'app.local' })).status, 403);
  });
  await withApp({ env: { ANTHROPIC_API_KEY: KEY, ALLOWED_HOSTS: 'app.local' } }, async (port) => {
    assert.equal((await post(port, { text: 'allowed by config' }, { host: 'app.local' })).status, 200);
  });
});

test('upstream failures reach the client as clear, typed errors; failures are not cached or logged with content', async () => {
  const logs = []; const warn = console.warn; console.warn = (...a) => logs.push(a.join(' '));
  try {
    const script = [err(401, 'x'), err(429, 's', { 'retry-after': '7' }), err(404, 'x'), err(500, 'x'), err(400, `bad ${KEY}`), new Response('oops', { status: 200 }), ok(5)];
    await withApp({ fetchImpl: upstream((n) => script[n - 1]) }, async (port) => {
      const t = 'PRIVATE prompt text for counting';
      const codes = [];
      for (let i = 0; i < 6; i++) { const r = await post(port, { text: t }); codes.push([r.status, r.json.error.code]); assert.ok(!r.text.includes(KEY)); assert.ok(r.json.error.message.length > 10); }
      assert.deepEqual(codes, [[502, 'auth'], [429, 'rate_limited'], [502, 'model_unavailable'], [502, 'upstream_unavailable'], [502, 'rejected'], [502, 'bad_response']]);
      const ok7 = await post(port, { text: t });
      assert.deepEqual([ok7.status, ok7.json.count, ok7.json.cached], [200, 5, false]); // errors were not cached
    });
    await withApp({ fetchImpl: async () => { throw new Error('down'); } }, async (port) => assert.equal((await post(port, { text: 'hello there' })).json.error.code, 'network'));
    await withApp({ fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('a')))), over: { timeoutMs: 30 } },
      async (port) => { const r = await post(port, { text: 'hello there' }); assert.deepEqual([r.status, r.json.error.code], [504, 'timeout']); });
    await withApp({ fetchImpl: upstream(() => err(429, 's', { 'retry-after': '7' })) }, async (port) => {
      const r = await post(port, { text: 'hello there' });
      assert.deepEqual([r.headers['retry-after'], r.json.error.retryAfter], ['7', 7]);
    });
  } finally { console.warn = warn; }
  assert.ok(logs.length >= 5);
  assert.ok(logs.every((l) => !l.includes(KEY) && !l.includes('PRIVATE')), 'logs must not contain prompts or keys');
});

test('local rate limit protects the quota: upstream calls are capped, cache hits are free, the window slides', async () => {
  let t = 1_000_000; const now = () => t;
  await withApp({ now, over: { ratePerMin: 2 }, fetchImpl: upstream(() => ok(3)) }, async (port, f) => {
    assert.equal((await post(port, { text: 'first prompt' })).status, 200);
    assert.equal((await post(port, { text: 'second prompt' })).status, 200);
    const limited = await post(port, { text: 'third prompt' });
    assert.deepEqual([limited.status, limited.json.error.code], [429, 'local_rate_limited']);
    assert.ok(limited.json.error.retryAfter >= 1 && limited.headers['retry-after']);
    assert.equal((await post(port, { text: 'first prompt' })).json.cached, true);
    assert.equal(f.calls.length, 2);
    t += 60_000;
    assert.equal((await post(port, { text: 'third prompt' })).status, 200);
  });
});

test('static serving: hardened headers, and secrets outside public/ are unreachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'st-')); mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<h1>ok</h1>'); writeFileSync(join(dir, 'public', 'a.js'), 'export {}'); writeFileSync(join(dir, '.env'), `ANTHROPIC_API_KEY=${KEY}`);
  await withApp({ root: join(dir, 'public') }, async (port) => {
    const home = await call(port, { path: '/' });
    assert.equal(home.status, 200); assert.match(home.headers['content-security-policy'], /default-src 'self'/); assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.equal((await call(port, { path: '/a.js' })).headers['content-type'], 'text/javascript; charset=utf-8');
    for (const p of ['/.env', '/../.env', '/%2e%2e/.env', '/..%2f.env', '/nope.js', '/%E0%A4%A']) {
      const r = await call(port, { path: p });
      assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`); assert.ok(!r.text.includes(KEY));
    }
    assert.equal((await call(port, { method: 'POST', path: '/' })).status, 405);
  });
});

// ---------------------------------------------------------------- Phase 3 audit fixes
import { DEFAULT_MODELS, UNSUPPORTED_MODELS } from '../server/config.js';
import { verifyLive } from '../server/verify.js';

test('anthropic client: a malformed key is reported as a key problem, not a network problem, and nothing is sent', async () => {
  for (const bad of ['sk-ant fake', 'sk-ant-é', '', undefined]) {
    const f = upstream(() => ok(1));
    const e = await createAnthropicCounter({ apiKey: bad, fetchImpl: f })('hello', 'm').catch((x) => x);
    assert.equal(e.code, 'bad_key'); assert.equal(f.calls.length, 0);
  }
});

test('anthropic client: request-id is captured from the header or body, and unsafe values are dropped', async () => {
  const run = (resp) => createAnthropicCounter({ apiKey: KEY, fetchImpl: async () => resp })('hi', 'm').then((r) => r, (e) => e);
  assert.equal((await run(json(200, { input_tokens: 3 }, { 'request-id': 'req_011CSHoEeqs5C35K2UUqR7Fy' }))).requestId, 'req_011CSHoEeqs5C35K2UUqR7Fy');
  assert.equal((await run(err(500, 'x', { 'request-id': 'req_abc123' }))).requestId, 'req_abc123');
  assert.equal((await run(json(429, { error: { message: 'x' }, request_id: 'req_body_1' }))).requestId, 'req_body_1');
  assert.equal((await run(err(500, 'x', { 'request-id': 'bad id with spaces <script>' }))).requestId, undefined);
});

test('config: model list follows the current docs; unsupported or retired IDs are dropped with a warning', () => {
  assert.ok(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'].every((m) => DEFAULT_MODELS.includes(m)));
  assert.equal(DEFAULT_MODELS.some((m) => m in UNSUPPORTED_MODELS), false);
  const c = loadConfig({ ANTHROPIC_COUNT_MODELS: 'claude-sonnet-4-5,claude-mythos-preview,claude-opus-4-8' });
  assert.deepEqual(c.models, ['claude-opus-4-8']); assert.equal(c.warnings.length, 2);
  assert.ok(c.warnings.every((w) => /Dropped/.test(w)));
  const all = loadConfig({ ANTHROPIC_COUNT_MODELS: 'claude-sonnet-4-5' });
  assert.deepEqual(all.models, DEFAULT_MODELS); // never ends up with an empty list
});

test('config: a key with spaces or non-ASCII is ignored with a warning that does not contain the key', () => {
  for (const bad of ['sk-ant bad key', 'sk-ant-é']) {
    const c = loadConfig({ ANTHROPIC_API_KEY: bad });
    assert.equal(c.apiKey, ''); assert.equal(c.warnings.length, 1); assert.ok(!c.warnings[0].includes(bad));
  }
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-api03-abc_DEF-123' }).apiKey, 'sk-ant-api03-abc_DEF-123');
});

test('API: responses carry the estimate caveat; errors carry the request id; logs carry the id but no secrets', async () => {
  const logs = []; const warn = console.warn; console.warn = (...a) => logs.push(a.join(' '));
  try {
    await withApp({ fetchImpl: upstream((n) => (n === 1 ? ok(8) : err(403, `no access ${KEY}`, { 'request-id': 'req_abc123' }))) }, async (port) => {
      const cfg = await call(port, { path: '/api/config' });
      assert.match(cfg.json.counting.caveat, /estimate/); assert.match(cfg.json.counting.scope, /single user message/);
      const good = await post(port, { text: 'first prompt text' });
      assert.match(good.json.caveat, /estimate/); assert.equal(good.json.kind, 'measured');
      const bad = await post(port, { text: 'second prompt text' });
      assert.deepEqual([bad.status, bad.json.error.code, bad.json.error.requestId], [502, 'permission', 'req_abc123']);
      assert.ok(!bad.text.includes(KEY));
    });
  } finally { console.warn = warn; }
  assert.ok(logs.some((l) => l.includes('req_abc123') && l.includes('permission')));
  assert.ok(logs.every((l) => !l.includes(KEY) && !l.includes('prompt text')));
});

test('verifyLive: reports per-model results from what the API returned, flags implausible counts, never throws', async () => {
  const f = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.model === 'm-denied') return err(403, 'x', { 'request-id': 'req_denied1' });
    if (b.model === 'm-flat') return ok(5); // same count for any text: not a real tokenizer
    return ok(Math.ceil(b.messages[0].content.length / 4));
  };
  const r = await verifyLive({ apiKey: KEY, models: ['m-good', 'm-denied', 'm-flat'], fetchImpl: f });
  assert.deepEqual(r.map((x) => [x.model, x.ok]), [['m-good', true], ['m-denied', false], ['m-flat', false]]);
  assert.ok(r[0].long > r[0].short && r[0].short > 0);
  assert.deepEqual([r[1].code, r[1].requestId], ['permission', 'req_denied1']);
  assert.equal(r[2].code, 'implausible');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('anthropic client: a 4xx that is not an Anthropic error (proxy, firewall, wrong URL) is "blocked", never blamed on the key or model', async () => {
  const run = (resp) => createAnthropicCounter({ apiKey: KEY, fetchImpl: async () => resp })('hi', 'm').catch((e) => e);
  for (const status of [400, 401, 403, 404, 407, 451]) {
    const e = await run(new Response('<html>Access denied</html>', { status, headers: { 'content-type': 'text/html' } }));
    assert.equal(e.code, 'blocked', String(status)); assert.match(e.message, /proxy or firewall/); assert.ok(!e.message.includes(KEY));
  }
  assert.equal((await run(new Response('', { status: 403 }))).code, 'blocked');
  assert.equal((await run(json(403, { error: { type: 'permission_error', message: 'x' } }))).code, 'permission'); // a real Anthropic 403 is still a permission error
  assert.equal((await run(new Response('<html>', { status: 502 }))).code, 'upstream_unavailable');                   // 5xx stays "try again"
});
