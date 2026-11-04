// OPT-IN live test against the REAL Anthropic API. Skipped unless explicitly enabled:
//   SAVE_TOKENS_LIVE_TEST=1 ANTHROPIC_API_KEY=... npm test        (or put the key in .env)
//   optional: SAVE_TOKENS_LIVE_MODEL=claude-sonnet-5-5
// It never prints the key. A skipped test is NOT a pass: it means live verification did not happen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig, loadEnvFile } from '../server/config.js';
import { verifyLive } from '../server/verify.js';

const enabled = process.env.SAVE_TOKENS_LIVE_TEST === '1';
if (enabled) loadEnvFile(join(fileURLToPath(new URL('..', import.meta.url)), '.env'));
const config = loadConfig();

test('LIVE: real Anthropic count_tokens returns plausible counts', { skip: !enabled ? 'set SAVE_TOKENS_LIVE_TEST=1 to run (makes real API calls)' : !config.apiKey ? 'no usable ANTHROPIC_API_KEY configured' : config.baseUrl !== 'https://api.anthropic.com' ? 'ANTHROPIC_BASE_URL is not api.anthropic.com, so this would not be a live test' : false }, async () => {
  const models = process.env.SAVE_TOKENS_LIVE_MODEL ? [process.env.SAVE_TOKENS_LIVE_MODEL] : [config.defaultModel];
  const results = await verifyLive({ apiKey: config.apiKey, models, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
  for (const r of results) assert.ok(r.ok, `${r.model}: ${r.code} ${r.message}${r.requestId ? ` [request-id ${r.requestId}]` : ''}`);
});
