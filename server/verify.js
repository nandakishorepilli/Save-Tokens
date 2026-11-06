// Live verification helper. Used by `npm run verify:live` and the opt-in live test.
// It reports only what the real API returned; it never prints the key.
import { createAnthropicCounter } from './anthropic.js';

const SHORT = 'Hello, Claude';
const LONG = `${SHORT}. `.repeat(40);

export async function verifyLive({ apiKey, models, baseUrl, fetchImpl, timeoutMs = 15000 }) {
  const count = createAnthropicCounter({ apiKey, baseUrl, fetchImpl, timeoutMs });
  const results = [];
  for (const model of models) {
    try {
      const a = await count(SHORT, model), b = await count(LONG, model);
      const sane = a.count > 0 && b.count > a.count; // a real tokenizer must count more tokens for 40x the text
      results.push({ model, ok: sane, short: a.count, long: b.count, requestId: b.requestId || a.requestId,
        ...(sane ? {} : { code: 'implausible', message: 'The API answered, but the counts do not scale with the text.' }) });
    } catch (e) {
      results.push({ model, ok: false, code: e.code || 'error', message: e.message, requestId: e.requestId });
    }
  }
  return results;
}

/** Live check of the optional AI-rewrite providers that are configured. Sends a tiny fixed prompt; reports what came back. */
import { createRewriter, providerList } from './rewrite.js';
export const REWRITE_PROBE = 'Please could you kindly summarize the following text in order to help me. It must be under 20 words.';
export async function verifyRewriteProviders({ config, fetchImpl }) {
  const rewrite = createRewriter({ config, fetchImpl });
  const results = [];
  for (const p of providerList(config).filter((x) => x.configured)) {
    try {
      const r = await rewrite(REWRITE_PROBE, p.id);
      results.push({ provider: p.id, model: p.model, ok: r.text.length > 0, chars: r.text.length, lost: r.lost });
    } catch (e) { results.push({ provider: p.id, model: p.model, ok: false, code: e.code || 'error', message: e.message }); }
  }
  return results;
}
