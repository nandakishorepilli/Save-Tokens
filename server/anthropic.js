// Anthropic token counting: POST {baseUrl}/v1/messages/count_tokens  ->  { input_tokens }
// Docs: https://platform.claude.com/docs/en/build-with-claude/token-counting
// The API key is only ever used here, on the server, and is redacted from every error message.

export class CountError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.code = code; this.status = status;
    if (extra.retryAfter) this.retryAfter = extra.retryAfter;
    if (extra.requestId) this.requestId = extra.requestId;
  }
}

const KEY_OK = /^[\x21-\x7e]+$/; // visible ASCII only: anything else cannot be sent in an HTTP header
const REQUEST_ID = /^[\w-]{4,100}$/;

export function createAnthropicCounter({ apiKey, baseUrl = 'https://api.anthropic.com', fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  const redact = (s) => String(s).split(apiKey).join('[redacted]').slice(0, 200);
  return async function count(text, model) {
    if (!KEY_OK.test(apiKey || '')) throw new CountError('bad_key', 'The API key on the server contains spaces or invalid characters. Check ANTHROPIC_API_KEY in .env.', 500);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
          signal: ctl.signal,
        });
      } catch {
        throw ctl.signal.aborted ? new CountError('timeout', 'Anthropic did not answer in time. Try again.', 504) : new CountError('network', 'Could not reach the Anthropic API. Check the connection.', 502);
      }
      let body = null;
      try { body = await res.json(); } catch { /* handled below */ }
      const rid = res.headers?.get?.('request-id') || body?.request_id;
      const requestId = typeof rid === 'string' && REQUEST_ID.test(rid) ? rid : undefined;
      const fail = (code, message, status = 502, extra = {}) => new CountError(code, message, status, { requestId, ...extra });

      if (res.ok) {
        const n = body?.input_tokens;
        if (!Number.isInteger(n) || n < 0) throw fail('bad_response', 'Anthropic returned a response without a token count.');
        return { count: n, requestId };
      }
      const type = body?.error?.type, detail = body?.error?.message ? redact(body.error.message) : '';
      // Anthropic errors are JSON: {"type":"error","error":{"type":...}}. A 4xx without that envelope came from a
      // proxy, firewall or wrong base URL, so do not blame the key or the model for it.
      const envelope = body?.type === 'error' || typeof body?.error?.type === 'string';
      if (!envelope && [400, 401, 403, 404, 407, 451].includes(res.status))
        throw fail('blocked', `The response (HTTP ${res.status}) did not come from the Anthropic API. A proxy or firewall may be blocking the request, or ANTHROPIC_BASE_URL is wrong.`);
      if (res.status === 401 || type === 'authentication_error') throw fail('auth', 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY on the server.');
      if (res.status === 403 || type === 'permission_error') throw fail('permission', `This API key is not allowed to count tokens for "${model}" (or in this workspace).`);
      if (res.status === 404) throw fail('model_unavailable', `Anthropic does not know the model "${model}" for this key.`);
      if (res.status === 413) throw fail('too_large', 'Anthropic says the request is too large to count.', 413);
      if (res.status === 429) {
        const ra = Number.parseInt(res.headers?.get?.('retry-after'), 10);
        throw fail('rate_limited', 'Anthropic rate limit reached. Wait a moment and try again.', 429, { retryAfter: Number.isInteger(ra) && ra > 0 ? Math.min(ra, 600) : 30 });
      }
      if (res.status === 408 || res.status >= 500) throw fail('upstream_unavailable', 'The Anthropic API is unavailable right now. Try again shortly.');
      throw fail('rejected', `Anthropic rejected the request${detail ? `: ${detail}` : ` (HTTP ${res.status}).`}`);
    } finally { clearTimeout(timer); }
  };
}
