import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig, loadEnvFile } from './server/config.js';
import { createApp } from './server/app.js';
import { providerList } from './server/rewrite.js';
import { loadLocalTokenizers } from './server/tokenizers.js';

loadEnvFile(join(fileURLToPath(new URL('.', import.meta.url)), '.env'));
const config = loadConfig();
for (const w of config.warnings) console.warn(`warning: ${w}`);

const tokenizers = await loadLocalTokenizers();
createServer(createApp({ config, tokenizers })).listen(config.port, config.host, () => {
  console.log(`Save Tokens running at http://${config.host === '127.0.0.1' ? 'localhost' : config.host}:${config.port}`);
  console.log(config.apiKey
    ? `Exact counting: on (Anthropic count_tokens; models: ${config.models.join(', ')})`
    : 'Exact counting: off (no ANTHROPIC_API_KEY). Offline analysis with heuristic estimates still works.');
  console.log(`Local tokenizers: ${tokenizers.length ? tokenizers.map((t) => t.id).join(', ') : 'none installed (counts fall back to estimates)'}`);
  console.log(`AI rewriting (optional, only when you click): ${providerList(config).map((p) => `${p.id} ${p.configured ? 'on' : 'off'}`).join(', ')}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && config.apiKey)
    console.warn(`warning: HOST=${config.host} exposes this server, and your API quota, to the network. Keep it on 127.0.0.1 unless you know why.`);
});
