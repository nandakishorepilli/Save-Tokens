# QA report: Model Intelligence upgrade

Date: 2026-11-08 · Scope: model registry, cascading selector, estimate and price labelling · Result: **no open defects in the shipped behaviour**; limitations listed at the end.

## 1. Architecture inspection (before any change)
All model knowledge funnelled through one file into one consumer, which made a central registry a contained change.

| File | Role | Changed? |
|---|---|---|
| `public/models.js` | model list, prices, cost maths, preferences | **Yes**: now the central registry, selection logic, pricing status, validation |
| `public/app.js` | selector, stat cards, Models & cost view | **Yes**: cascading selector, honest estimate/price labels, no-price rows |
| `public/index.html`, `public/styles.css` | selector markup, table columns, layout | **Yes** (additive) |
| `test/models.test.js` | new coverage | **New** |
| `README.md`, `docs/MODELS.md`, this report | documentation | **Yes / new** |
| `public/core.js` (offline estimator, analysis, optimizer) | token estimation | No |
| `public/counting.js`, `public/rewrite.js`, `public/diff.js` | exact counting, AI rewrite, diff | No |
| `server/*` (Anthropic counting, Gemini / Ollama / Hugging Face rewrite) | integrations | No |

## 2. What was verified, and what was not
| Claim | Evidence | Status |
|---|---|---|
| Claude IDs and prices ($2/$10, $4/$20, $0.10/$0.50, $10/$50 per M tokens) | Anthropic's pricing page, fetched 2026-11-08 | **Verified** (source URL and date stored in the profile) |
| Claude 4.7+ tokenizer yields ~30% more tokens | same page | Verified, documented in the tokenizer note |
| Antigravity offers Low / Medium / High thinking levels | Antigravity docs, *Choose a model* | Verified |
| Antigravity has no per-token price (plan quota) | Antigravity docs meters + plan coverage | Treated as unavailable; none shown |
| "Terra" and "Luna" are named OpenAI tiers | OpenAI's GPT-6 guide; AWS and OpenClaw docs | Names verified |
| Which generation, API id, tokenizer, price for Terra / Luna | GPT-5.6 and GPT-6.x both exist; labels do not say which | **Not verified → unpinned, fallback estimate, no price** |
| `gemini-3.5-flash-lite` free tier $0 | third-party summaries | **Reported**, never "verified" |

## 3. Requirement → test traceability (`test/models.test.js`, 22 tests)
| Requirement | Tests |
|---|---|
| Centralized registry with all required fields | registry soundness; `validateProfile` rejections (id without verification, source-less verified price, exact heuristic, effort changing input, invented identity, numbers with "unavailable") |
| Every new model profile | named options (Gemini Low/Medium/High, Terra Low/Medium/High, Luna); one test each for Antigravity Gemini, Terra, Luna; "no fabricated specifications" |
| Existing models retained | ids, routes, vendors, prices of all six earlier profiles |
| Provider / model selection | provider list and order, local tokenizers only when installed, first-model default, keep-current-model, invalid ignored |
| Reasoning effort | defaults, selection, per-model memory, invalid ignored, save/restore, invalid saved efforts dropped |
| Model switching | nine-step switching sequence with consistency and non-mutation (frozen input) |
| Token estimation fallback | fallback / approximate / exact-on-request / measured labels; never "exact" for approximations; counters with no measurement stay estimates; counting routes match the registry |
| Effort never changes input tokens | analysis and input cost identical at every level of every effort-capable model |
| Missing pricing | no cost or savings figures; "Pricing unavailable: <reason>" |
| User pricing | independent per model, labelled "Your price", invalid ignored, published price keeps its Verified status, reset restores unavailable |
| Backward compatibility | old saved preferences, unknown saved model, all earlier exports, ordering, `DEFAULT_PREFS` unchanged |
| UI and docs contract | labelled selects, effort hidden until supported, responsive CSS, no hard-coded model ids in the UI, honest wording, docs exist |

## 4. Results
**Automated:** 162 tests, **161 passed, 0 failed, 1 skipped** (the opt-in live-API test, which did not run). All 140 earlier tests pass unchanged.

**Browser QA** (headless Chromium against the real server; every row passed):

| Scenario | Observed |
|---|---|
| Default | Anthropic / Claude Sonnet 5.5, effort selector hidden, "Estimate · exact counting is not set up", price "verified 2026-11-08" |
| Google Antigravity | one model "Gemini", effort Low / Medium (default) / High, badge **Estimated · fallback**, cost card "–" with the reason, monthly savings "–" |
| Effort Low / Medium / High | prompt tokens ~37 and cost "–" **identical at all three levels** |
| Persistence | reload restores provider, model and effort |
| OpenAI Codex | Terra (effort High) → Luna (selector hidden) → back to Terra: High remembered |
| Models & cost | 9 rows; Terra shows "user-requested label", "Model ID not pinned" with unconfirmed candidates, status *Unavailable*; Claude shows *Verified* with a source link (`rel="noopener noreferrer"`); scenario table lists every model, unpriced ones as "Pricing unavailable" |
| Price lifecycle | enter Terra $1.50 / $6 → *Your price*, cost card $0.055 per 1,000 calls, monthly savings shown; Luna still *Unavailable*; reset → unavailable again |
| Backward compatibility | saved `{model:'generic', …}` loads as Other / custom with its price; unknown saved model falls back to Claude Sonnet 5.5 |
| Network | no counting or rewrite API call during any selection change |
| Console | no errors or warnings |
| Responsive | desktop 1280, tablet 820, mobile 390: no horizontal overflow on Workspace, Compare, Models & cost or Settings; selectors in one row (desktop, tablet) and stacked (mobile) |

## 5. Defects found during QA
- *UX:* the header line for unavailable pricing repeated the whole reason (about 170 characters), which crowded small screens. Fixed: the header says "Pricing unavailable" and the full reason stays in the tooltip and the cost card.
- Three test mistakes (a null candidate id compared with a null model id, a wording regex, a docs check written before the docs) and one QA-script mistake (analysis state lost on reload) were corrected. **No product defect** was found in the registry, selection, estimation or pricing logic.

## 6. Limitations and residual risk
- **Terra and Luna stay unpinned.** Until you say which generation you mean (GPT-5.6 or GPT-6.x), their model ids, tokenizers and prices are unknown, so counts are fallback estimates and no cost is shown unless you enter your own rates.
- **Antigravity's Gemini model is not pinned** and its usage is quota-metered; dollar figures appear only from rates you enter.
- No tokenizer is verified for Gemini, Terra, Luna or custom models; their counts are heuristic estimates and are never labelled exact or measured.
- Gemini's free-tier price is *Reported*, not verified. Haiku's long-prompt tier, batch, caching and discounts are not modelled.
- Facts here are date-stamped (2026-11-08) and can go stale; `docs/MODELS.md` says how to update the registry.
- Live calls to Anthropic, Gemini, OpenAI, Hugging Face and Ollama were not exercised in this environment (unchanged from earlier releases; use `npm run verify:live`).
- Effort does not alter the output-token estimate: cost uses the expected output tokens you enter, because no per-effort multiplier is documented and none is invented.
- Cosmetic, pre-existing: a one-token saving reads "~1 tokens".

## 7. Re-running this QA
`npm test` for the automated suite. For the browser pass, start `npm start` and walk the scenarios in section 4; the selector screenshots are in `docs/screenshots/`.
