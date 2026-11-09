# Models, tokenizers and pricing

Save Tokens keeps every model in one registry, `public/models.js`. The UI, the cost maths and the tests all read it; nothing else hard-codes a model.
This page says what each profile is, and, just as important, **what has and has not been verified**.

## How selection works
Three cascading selectors in the top bar:
1. **Provider**: Anthropic (Claude), Google (Gemini API), Google Antigravity, OpenAI Codex, Other / custom, and *Local tokenizers* (only when a tokenizer package is installed).
2. **Model**: the models of that provider.
3. **Reasoning effort**: shown only when the model has effort levels.

Choosing a provider picks its first model; choosing the provider you are already on keeps your model. Effort is remembered per model. Preferences are stored in your browser only, and older saved preferences (just a model id) keep working: an unknown saved model falls back to the default.

## Profile fields
| Field | Meaning |
|---|---|
| `provider`, `vendor`, `label` | where it sits in the selector, and its display name |
| `labelStatus` | `official`, `user-requested` (a label you asked for), `custom` or `tokenizer` |
| `modelId`, `modelIdStatus` | the API identifier, set **only** when `verified`. Otherwise `unpinned` with `modelIdCandidates` (name, API id if found, evidence, source) |
| `reasoning` | `null`, or `{ levels, default, changesInputTokens: false, source }` |
| `tokenizer` | `{ id, kind: heuristic / provider-api / local-package, verified, exact }` |
| `count` | the way a *measured* count can be obtained: `anthropic`, `local` or `none` |
| `pricing` | `{ in, out, status, source, asOf, reason }` per million tokens (see below) |
| `confidence` | `measurable`, `approximate` or `unverified`, with the reason |
| `capabilities` | what **this app** can do for the profile (`analyze`, `optimize`, `cost-estimate`, `count:provider-api`, `count:local-tokenizer`, `reasoning-effort`). These are app features, not claims about the model's own abilities |

`validateProfile()` enforces the rules below, and the tests run it on every profile.

## Honesty rules
- **Identities.** A model id exists only where an official source was checked. Anything else is `unpinned`; candidates are listed with their evidence and are never promoted to a fact.
- **Token counts.** The offline estimator (`heuristic-v2`) is unchanged and is always an estimate. A count is **Measured** only when a real counter answered for that exact text and model. When no verified tokenizer exists the UI says *Fallback estimate*, and a heuristic is never marked verified or exact.
- **Reasoning effort** changes output (reasoning) tokens and quota use. It never changes the input tokens of your prompt, so the prompt's token count is identical at every level. Cost uses the *expected output tokens* you enter, not a guess per effort.
- **Pricing status.** `Verified` (checked against the provider's own page, with source and date), `Reported` (third-party summaries, unchecked), `Your price` (entered by you) or `Unavailable` (nothing is shown, and no savings figure is produced).

## The profiles
| Provider | Model | Model id | Efforts | Pricing | Token counting |
|---|---|---|---|---|---|
| Anthropic | Claude Sonnet 5.5 / Opus 5.5 / Haiku 5.5 / Fable 5.1 | verified (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`) | none | **Verified** 2026-11-08: $2/$10, $4/$20, $0.10/$0.50, $10/$50 per M tokens | estimate; exact via Anthropic's counting endpoint on request (needs a key) |
| Google (Gemini API) | Gemini 3.5 Flash-Lite | verified (`gemini-3.5-flash-lite`) | none | **Reported** free tier ($0, rate-limited); not checked against Google's page | heuristic estimate |
| Google Antigravity | Gemini | **unpinned** | Low / Medium / High | **Unavailable** | fallback estimate |
| OpenAI Codex | Terra | **unpinned** | Low / Medium / High | **Unavailable** | fallback estimate |
| OpenAI Codex | Luna | **unpinned** | none | **Unavailable** | fallback estimate |
| Other / custom | Other model | n/a | none | enter your own | heuristic estimate |
| Local tokenizers | e.g. OpenAI o200k (if installed) | n/a | none | enter your own | exact for that encoding, text only |

### Google Antigravity: "Gemini Low / Medium / High"
- **Verified** (Antigravity's docs, *Choose a model*): you can switch models and choose a thinking level of Low, Medium or High. So Low/Medium/High are three levels of one Gemini model, shown as the effort selector. The three names "Gemini Low / Medium / High" are therefore *Gemini* at each level.
- **Not pinned:** which Gemini model Antigravity serves depends on your plan. The registry lists `gemini-4-argon` (documented in Google's Gemini API docs with low/medium/high thinking levels) as a *candidate*, not a confirmed match.
- **No per-token price.** Antigravity usage is metered as plan quota (weekly and five-hour limits), not per token, so none is shown. If you want a cost model, enter your own rates and they will be labelled *Your price*. (The Gemini **API** has its own published per-token prices; those are not Antigravity prices and are not applied.)

### OpenAI Codex: "Terra" and "Luna"
- **What was found:** Terra and Luna are named OpenAI tiers. OpenAI's own GPT-6 guide lists *GPT-6.1 Terra* (with low / medium / high reasoning effort among others) and *GPT-6 Luna*; third-party documentation (AWS Bedrock, OpenClaw) lists `gpt-5.6-terra` and `gpt-5.6-luna` as Codex model ids.
- **Why they stay unpinned:** each name exists in more than one generation (GPT-5.6 and GPT-6.x), and your label does not say which. The generation decides the model id, the tokenizer and the price, so none is chosen for you. The candidates and their evidence are shown in *Models & cost*. API ids found only in third-party sources are marked unconfirmed, and one candidate (GPT-6 Luna) has no id at all because none was found.
- **Tokenizer:** not verified for either, so counts are *fallback estimates* and are never labelled exact. (If the model uses the o200k encoding, installing the optional `gpt-tokenizer` package gives you an exact count for *that encoding* under the *Local tokenizers* provider, but that is not claimed to be Terra's or Luna's tokenizer.)
- **Pricing:** unavailable until the generation is pinned. Enter your own rates for a cost model.
- **Effort levels:** Terra offers Low / Medium / High as requested (OpenAI documents higher efforts as well, not offered here). Luna has no selector because none was requested for it; OpenAI documents effort for Luna, so it is a one-line change in the registry if you want it.

## Adding or changing a model
Add one object to `RAW` in `public/models.js`. Run `npm test`: `validateProfile` fails loudly if you set a model id without verification, mark a heuristic tokenizer exact or verified, give a verified price without a source URL and date, or let effort change input tokens. To pin Terra or Luna once you know the generation, set `modelId` and `modelIdStatus: 'verified'` and, if the pricing page confirms it, add a `verified` price with its source.

## What would change the "unverified" labels
- A confirmed generation for Terra / Luna, and OpenAI's tokenizer documentation for it.
- A Gemini token-counting integration (Gemini has its own counting endpoint; it is not wired in).
- Google or OpenAI per-token pricing for the pinned models.
