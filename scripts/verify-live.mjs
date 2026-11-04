// Usage: npm run verify:live [-- --model=claude-sonnet-5-5]   (Anthropic token counting)
//        npm run verify:live -- --rewrite                     (configured AI-rewrite providers: Gemini, Ollama, Hugging Face)
// Makes REAL calls to the Anthropic count_tokens endpoint using ANTHROPIC_API_KEY from the environment or .env.
// Counting is free but rate-limited. The key is never printed.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig, loadEnvFile } from '../server/config.js';
import { verifyLive, verifyRewriteProviders } from '../server/verify.js';

loadEnvFile(join(fileURLToPath(new URL('..', import.meta.url)), '.env'));
const config = loadConfig();
config.warnings.forEach((w) => console.warn(`warning: ${w}`));
if (process.argv.includes('--rewrite')) {
  const results = await verifyRewriteProviders({ config, fetchImpl: globalThis.fetch });
  if (!results.length) { console.log('No AI-rewrite provider is configured, so nothing was verified. This is NOT a pass.'); process.exit(2); }
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.provider.padEnd(12)} ${String(r.model).padEnd(34)} ${r.ok ? `returned ${r.chars} characters${r.lost.length ? ` (dropped: ${r.lost.join(', ')})` : ''}` : `${r.code}: ${r.message}`}`);
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok} of ${results.length} configured provider(s) returned a rewrite. Providers marked FAIL were not verified. Remote providers receive a short fixed test prompt.`);
  process.exit(ok === results.length ? 0 : 1);
}
if (!config.apiKey) {
  console.log('No usable ANTHROPIC_API_KEY is configured, so nothing was verified.');
  console.log('This is NOT a pass: live verification has not happened. Set the key in .env and rerun.');
  process.exit(2);
}
const only = process.argv.find((a) => a.startsWith('--model='))?.slice(8);
const models = only ? [only] : config.models;
console.log(`Calling ${config.baseUrl} for ${models.length} model(s)...`);
const results = await verifyLive({ apiKey: config.apiKey, models, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.model.padEnd(22)} ${r.ok ? `"Hello, Claude" = ${r.short} tokens; 40x text = ${r.long}` : `${r.code}: ${r.message}`}${r.requestId ? `  [request-id ${r.requestId}]` : ''}`);
const passed = results.filter((r) => r.ok).length;
const live = config.baseUrl === 'https://api.anthropic.com';
console.log(live
  ? `\nLive verification: ${passed} of ${results.length} model(s) returned plausible counts from api.anthropic.com.`
  : `\n${passed} of ${results.length} model(s) answered at ${config.baseUrl}. That is NOT api.anthropic.com, so this is NOT live verification of Anthropic.`);
process.exit(passed === results.length ? 0 : 1);
