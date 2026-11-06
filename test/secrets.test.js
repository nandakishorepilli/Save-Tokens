// Spawns the real server process and proves the API key never reaches logs or anything the browser can fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const KEY = 'sk-ant-spawn-TOPSECRET42';
const root = fileURLToPath(new URL('..', import.meta.url));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (port, path, opts = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
  r.on('error', reject); r.end(opts.body);
});

test('static client files contain no key material and never reference the key header', () => {
  for (const f of readdirSync(join(root, 'public'))) {
    const src = readFileSync(join(root, 'public', f), 'utf8');
    assert.ok(!/sk-ant-/i.test(src), `${f} contains a key-like string`);
    assert.ok(!/x-api-key/i.test(src), `${f} refers to the key header`);
    if (f.endsWith('.js')) assert.ok(!/ANTHROPIC_API_KEY|GEMINI_API_KEY|HF_TOKEN|x-goog-api-key|authorization/i.test(src), `${f} refers to a key variable or auth header`);
    assert.ok(!/AIza[\w-]{10,}|hf_[A-Za-z0-9]{10,}/.test(src), `${f} contains a key-like string`);
  }
});

test('server process: key is absent from stdout, stderr and every response, even when upstream echoes it', async (t) => {
  let n = 0;
  const stub = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      n++; res.writeHead(n === 1 ? 401 : 200, { 'content-type': 'application/json', 'request-id': 'req_spawn_001' });
      res.end(JSON.stringify(n === 1 ? { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } } : { input_tokens: 9 }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => stub.once('listening', r));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.address().port}` } });
  let out = ''; child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  t.after(() => { child.kill(); stub.close(); });
  for (let i = 0; i < 50 && !/Exact counting/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /Exact counting: on/);

  const body = JSON.stringify({ text: 'a prompt that must not leak anywhere' });
  const h = { 'content-type': 'application/json' };
  const responses = [
    await get(port, '/api/count', { method: 'POST', headers: h, body }),                         // upstream 401 echoing the key
    await get(port, '/api/count', { method: 'POST', headers: h, body: JSON.stringify({ text: 'second, successful prompt' }) }),
    await get(port, '/api/config'), await get(port, '/'), await get(port, '/app.js'), await get(port, '/counting.js'), await get(port, '/core.js'), await get(port, '/.env'),
  ];
  assert.deepEqual(responses.slice(0, 2).map((r) => r.status), [502, 200]);
  for (const r of responses) assert.ok(!r.text.includes(KEY) && !r.text.includes('TOPSECRET'));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!out.includes(KEY) && !out.includes('TOPSECRET'), 'key leaked into server output');
  assert.ok(!out.includes('must not leak'), 'prompt text leaked into server output');
  assert.match(out, /count failed: auth \(request-id req_spawn_001\)/);
});

test('server process: an invalid key is reported without printing it, and counting stays off', async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), ANTHROPIC_API_KEY: 'sk-ant bad TOPSECRET43' } });
  let out = ''; child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  t.after(() => child.kill());
  for (let i = 0; i < 50 && !/Exact counting/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /Exact counting: off/); assert.match(out, /ANTHROPIC_API_KEY contains spaces/); assert.ok(!out.includes('TOPSECRET'));
  assert.deepEqual(JSON.parse((await get(port, '/api/config')).text), { counting: { available: false, reason: 'not_configured' } });
});

test('server process: Gemini and Hugging Face keys never reach logs or responses, even when the provider echoes them', async (t) => {
  const GK = 'AIza-spawn-GEMINI-TOPSECRET7';
  const stub = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: `API key not valid ${GK}` } })); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => stub.once('listening', r));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), GEMINI_API_KEY: GK, GEMINI_BASE_URL: `http://127.0.0.1:${stub.address().port}` } });
  let out = ''; child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  t.after(() => { child.kill(); stub.close(); });
  for (let i = 0; i < 50 && !/AI rewriting/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /gemini on/);
  const h = { 'content-type': 'application/json' };
  const rs = [await get(port, '/api/rewrite', { method: 'POST', headers: h, body: JSON.stringify({ text: 'PRIVATE prompt that must stay private' }) }), await get(port, '/api/providers'), await get(port, '/api/config'), await get(port, '/'), await get(port, '/app.js')];
  assert.equal(rs[0].status, 502);
  for (const r of rs) assert.ok(!r.text.includes(GK) && !r.text.includes('TOPSECRET'));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!out.includes('TOPSECRET') && !out.includes('PRIVATE prompt'), 'secret or prompt leaked into server output');
  assert.match(out, /rewrite failed: gemini auth/);
});
