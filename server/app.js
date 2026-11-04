import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CountError, createAnthropicCounter } from './anthropic.js';
import { RewriteError, createRewriter, providerList } from './rewrite.js';

const PUBLIC = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
export const SCOPE = 'The prompt is counted as a single user message. System prompts, tools and files are not included.';
export const CAVEAT = 'Anthropic describes this count as an estimate: it can differ slightly from billed usage and may include system-added tokens that are not billed. It is valid only for the model chosen.';

export function createApp({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), root = PUBLIC, tokenizers = [] }) {
  const available = Boolean(config.apiKey);
  const countUpstream = available ? createAnthropicCounter({ apiKey: config.apiKey, baseUrl: config.baseUrl, fetchImpl, timeoutMs: config.timeoutMs }) : null;
  const cache = new Map(); // sha256(model, text) -> count; process lifetime, never persisted
  const calls = [];        // timestamps of upstream calls, for the local rate limit
  const allowedHosts = new Set(config.allowedHosts);
  const rewriter = createRewriter({ config, fetchImpl });
  const rewriteCalls = [];
  const tokenizerById = new Map(tokenizers.map((t) => [t.id, t]));

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message, retryAfter, requestId) =>
    send(res, status, { error: { code, message, ...(retryAfter ? { retryAfter } : {}), ...(requestId ? { requestId } : {}) } }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) reject(new CountError('too_large', 'Prompt is too large to count.', 413)); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  /** Reads a JSON body. Sends the error response itself and returns { ok: false } when the request is unacceptable. */
  async function readPayload(req, res, limit) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { fail(res, 415, 'unsupported_media_type', 'Send application/json.'); return { ok: false }; }
    if (Number(req.headers['content-length']) > limit) { fail(res, 413, 'too_large', 'Prompt is too large.'); return { ok: false }; }
    try { return { ok: true, value: JSON.parse(await readBody(req, limit)) }; } catch (e) {
      if (e instanceof CountError) fail(res, e.status, e.code, e.message); else fail(res, 400, 'bad_json', 'Request body must be valid JSON.');
      return { ok: false };
    }
  }

  const probeOllama = async () => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 1000);
    try { return (await fetchImpl(`${config.ollama.baseUrl}/api/tags`, { signal: ctl.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
  };

  async function api(req, res, url) {
    let host = '';
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { /* rejected below */ }
    if (!allowedHosts.has(host)) return fail(res, 403, 'forbidden_host', 'This host name is not allowed.'); // blocks DNS rebinding
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return fail(res, 403, 'forbidden_origin', 'Cross-origin requests are not allowed.');

    if (url.pathname === '/api/providers') { // what is switched on; never any key or secret
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Use GET.');
      const rewrite = await Promise.all(providerList(config).map(async (p) => ({ ...p, reachable: p.id === 'ollama' && p.configured ? await probeOllama() : null })));
      return send(res, 200, { rewrite, rewriteMaxChars: config.rewrite.maxChars, tokenizers: tokenizers.map(({ id, label, note }) => ({ id, label, note })) });
    }

    if (url.pathname === '/api/rewrite') { // optional and user-triggered: the only route that can send a prompt to an AI model
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Use POST.');
      const on = providerList(config).filter((p) => p.configured);
      if (!on.length) return fail(res, 503, 'not_configured', 'AI rewriting is off: no provider is configured on the server.');
      const body = await readPayload(req, res, config.rewrite.maxChars * 4 + 1024);
      if (!body.ok) return;
      const { text, provider = on[0].id } = body.value ?? {};
      if (typeof text !== 'string' || typeof provider !== 'string') return fail(res, 400, 'bad_request', 'Expected {"text": string, "provider": string}.');
      if (!on.some((p) => p.id === provider)) return fail(res, 400, 'unsupported_provider', `Choose one of: ${on.map((p) => p.id).join(', ')}.`);
      if (!text.trim()) return fail(res, 400, 'empty_text', 'There is nothing to rewrite.');
      if ([...text].length > config.rewrite.maxChars) return fail(res, 413, 'too_large', `Prompts over ${config.rewrite.maxChars} characters are not rewritten.`);
      const t = now();
      while (rewriteCalls.length && t - rewriteCalls[0] >= 60000) rewriteCalls.shift();
      if (rewriteCalls.length >= config.rewrite.ratePerMin) return fail(res, 429, 'local_rate_limited', 'Too many rewrite requests. Wait a moment.', Math.max(1, Math.ceil((60000 - (t - rewriteCalls[0])) / 1000)));
      rewriteCalls.push(t);
      try { return send(res, 200, { ...(await rewriter(text, provider)), kind: 'ai_suggestion' }); } catch (e) {
        if (!(e instanceof RewriteError)) throw e;
        console.warn(`rewrite failed: ${provider} ${e.code}`); // never log prompt text or keys
        return fail(res, e.status, e.code, e.message, e.retryAfter);
      }
    }

    if (url.pathname === '/api/count-local') { // exact count from a locally installed tokenizer: no network, no key
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Use POST.');
      if (!tokenizers.length) return fail(res, 503, 'not_configured', 'No local tokenizer is installed.');
      const body = await readPayload(req, res, config.maxChars * 4 + 1024);
      if (!body.ok) return;
      const { text, model } = body.value ?? {};
      if (typeof text !== 'string' || typeof model !== 'string') return fail(res, 400, 'bad_request', 'Expected {"text": string, "model": string}.');
      const tok = tokenizerById.get(model);
      if (!tok) return fail(res, 400, 'unsupported_model', `Local counting is only offered for: ${[...tokenizerById.keys()].join(', ')}.`);
      if (!text.trim()) return fail(res, 400, 'empty_text', 'There is nothing to count.');
      if ([...text].length > config.maxChars) return fail(res, 413, 'too_large', `Prompts over ${config.maxChars} characters are not counted.`);
      let count;
      try { count = tok.count(text); } catch { return fail(res, 500, 'tokenizer_failed', 'The local tokenizer failed on this text.'); }
      if (!Number.isInteger(count) || count < 0) return fail(res, 500, 'tokenizer_failed', 'The local tokenizer returned an invalid count.');
      return send(res, 200, { kind: 'measured', provider: 'local', model, count, exact: true, cached: false, method: `Local tokenizer: ${tok.label}`, scope: 'Text only: no message or chat framing is included.', caveat: tok.note || '' });
    }

    if (url.pathname === '/api/config') {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Use GET.');
      return send(res, 200, { counting: available
        ? { available: true, provider: 'anthropic', models: config.models, defaultModel: config.defaultModel, maxChars: config.maxChars, scope: SCOPE, caveat: CAVEAT }
        : { available: false, reason: 'not_configured' } });
    }
    if (url.pathname !== '/api/count') return fail(res, 404, 'not_found', 'Unknown API route.');
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Use POST.');
    if (!available) return fail(res, 503, 'not_configured', 'Exact counting is off: no API key is configured on the server.');
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'unsupported_media_type', 'Send application/json.');
    const limit = config.maxChars * 4 + 1024;
    if (Number(req.headers['content-length']) > limit) return fail(res, 413, 'too_large', 'Prompt is too large to count.');

    let payload;
    try { payload = JSON.parse(await readBody(req, limit)); } catch (e) {
      if (e instanceof CountError) return fail(res, e.status, e.code, e.message);
      return fail(res, 400, 'bad_json', 'Request body must be valid JSON.');
    }
    const text = payload?.text, model = payload?.model ?? config.defaultModel;
    if (typeof text !== 'string' || typeof model !== 'string') return fail(res, 400, 'bad_request', 'Expected {"text": string, "model": string}.');
    if (!config.models.includes(model)) return fail(res, 400, 'unsupported_model', `Exact counting is only offered for: ${config.models.join(', ')}.`);
    if (!text.trim()) return fail(res, 400, 'empty_text', 'There is nothing to count.');
    if ([...text].length > config.maxChars) return fail(res, 413, 'too_large', `Prompts over ${config.maxChars} characters are not counted.`);

    const key = createHash('sha256').update(model).update('\0').update(text).digest('hex');
    const base = { kind: 'measured', provider: 'anthropic', model, method: 'Anthropic count_tokens API', scope: SCOPE, caveat: CAVEAT };
    if (cache.has(key)) { const c = cache.get(key); cache.delete(key); cache.set(key, c); return send(res, 200, { ...base, count: c, cached: true }); }

    const t = now();
    while (calls.length && t - calls[0] >= 60000) calls.shift();
    if (calls.length >= config.ratePerMin) return fail(res, 429, 'local_rate_limited', 'Too many count requests. Wait a moment.', Math.max(1, Math.ceil((60000 - (t - calls[0])) / 1000)));
    calls.push(t);
    try {
      const { count } = await countUpstream(text, model);
      cache.set(key, count);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return send(res, 200, { ...base, count, cached: false });
    } catch (e) {
      if (!(e instanceof CountError)) throw e;
      console.warn(`count failed: ${e.code}${e.requestId ? ` (request-id ${e.requestId})` : ''}`); // never log prompt text or keys
      return fail(res, e.status, e.code, e.message, e.retryAfter, e.requestId);
    }
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return void res.end(); }
    const path = normalize(decodeURIComponent(url.pathname));
    const file = join(root, path === sep || path === '/' ? 'index.html' : path);
    if (!file.startsWith(root + sep)) { res.writeHead(403, SECURITY); return void res.end('Forbidden'); }
    const body = await readFile(file); // read first so a failure can still send a 404
    res.writeHead(200, { 'Content-Type': `${TYPES[extname(file)] || 'application/octet-stream'}; charset=utf-8`, ...SECURITY });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) await api(req, res, url); else await serveStatic(req, res, url);
    } catch {
      if (!res.headersSent) { res.writeHead(404, SECURITY); res.end('Not found'); } else res.end();
    }
  };
}
