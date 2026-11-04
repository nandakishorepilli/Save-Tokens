import { existsSync, readFileSync } from 'node:fs';

// Model IDs from Anthropic's token counting docs. Counts are per model: models from Opus 4.7 onward share a newer
// tokenizer that yields ~30% more tokens than earlier ones, so a count is never valid for another model.
export const DEFAULT_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
// IDs the docs say cannot be used for counting (or are retired): dropped with a warning instead of failing later.
export const UNSUPPORTED_MODELS = {
  'claude-sonnet-4-5': 'the token counting docs list it as not supported',
  'claude-sonnet-4-5-20250929': 'the token counting docs list it as not supported',
  'claude-mythos-preview': 'it is deprecated and past its documented end-of-life',
};
const DEFAULT_BASE = 'https://api.anthropic.com';

/** Minimal .env parser (no dependency). Supports KEY=value, quotes, comments and `export`. */
export function parseEnv(src) {
  const out = {};
  for (const line of String(src).split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Load a .env file into `env` without overriding variables that are already set. */
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return false;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) if (!(k in env)) env[k] = v;
  return true;
}

const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]{1,120}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

const int = (v, d, min, max) => { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n >= min && n <= max ? n : d; };

export function loadConfig(env = process.env) {
  const warnings = [];
  let apiKey = (env.ANTHROPIC_API_KEY || '').trim();
  if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) { // would make every request fail in a misleading way
    warnings.push('ANTHROPIC_API_KEY contains spaces or non-ASCII characters, so it was ignored. Check .env for stray quotes or line breaks.');
    apiKey = '';
  }

  let models = (env.ANTHROPIC_COUNT_MODELS ? env.ANTHROPIC_COUNT_MODELS.split(',') : DEFAULT_MODELS).map((s) => s.trim()).filter(Boolean);
  const valid = models.filter((m) => /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(m));
  if (valid.length !== models.length) warnings.push('Ignored invalid names in ANTHROPIC_COUNT_MODELS.');
  models = [...new Set(valid)].filter((m) => {
    if (!(m in UNSUPPORTED_MODELS)) return true;
    warnings.push(`Dropped ${m} from ANTHROPIC_COUNT_MODELS: ${UNSUPPORTED_MODELS[m]}.`); return false;
  });
  if (!models.length) { models = DEFAULT_MODELS; warnings.push('ANTHROPIC_COUNT_MODELS had no valid names; using the defaults.'); }

  let baseUrl = (env.ANTHROPIC_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const u = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new Error('insecure');
  } catch { warnings.push('ANTHROPIC_BASE_URL must be https (http only on localhost); using the default.'); baseUrl = DEFAULT_BASE; }

  const extra = (env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Optional AI-rewrite providers. Every one is off unless configured; none is needed for counting or analysis.
  const secret = (name) => {
    const t = (env[name] || '').trim();
    if (t && !PRINTABLE.test(t)) { warnings.push(`${name} contains spaces or non-ASCII characters, so it was ignored.`); return ''; }
    return t;
  };
  const model = (name, fallback = '') => {
    const m = (env[name] || '').trim();
    if (!m) return fallback;
    if (!MODEL_NAME.test(m)) { warnings.push(`${name} is not a valid model name, so it was ignored.`); return fallback; }
    return m;
  };
  const url = (name, fallback) => {
    const raw = (env[name] || fallback).replace(/\/+$/, '');
    try {
      const u = new URL(raw);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return raw;
    } catch { /* fall through */ }
    warnings.push(`${name} must be https (http only on localhost); using the default.`);
    return fallback;
  };
  return {
    apiKey, models, defaultModel: models[0], baseUrl, warnings,
    host: env.HOST || '127.0.0.1', port: int(env.PORT, 5173, 1, 65535),
    timeoutMs: int(env.COUNT_TIMEOUT_MS, 10000, 500, 60000), maxChars: int(env.COUNT_MAX_CHARS, 100000, 100, 1000000),
    ratePerMin: int(env.COUNT_RATE_PER_MIN, 30, 1, 600), allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...extra],
    rewrite: { maxChars: int(env.REWRITE_MAX_CHARS, 20000, 200, 200000), ratePerMin: int(env.REWRITE_RATE_PER_MIN, 10, 1, 120), timeoutMs: int(env.REWRITE_TIMEOUT_MS, 30000, 2000, 120000) },
    gemini: { apiKey: secret('GEMINI_API_KEY'), model: model('GEMINI_MODEL', 'gemini-3.5-flash-lite'), baseUrl: url('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com') },
    ollama: { model: model('OLLAMA_MODEL'), baseUrl: url('OLLAMA_BASE_URL', 'http://127.0.0.1:11434') },
    huggingface: { token: secret('HF_TOKEN'), model: model('HF_MODEL'), baseUrl: url('HF_BASE_URL', 'https://router.huggingface.co/v1') },
  };
}
