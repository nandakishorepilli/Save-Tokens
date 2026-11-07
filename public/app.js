import { analyze, optimize, countTokens, estimateTokens, lostRequirements, recommendedIds, measureSavings, KINDS } from './core.js';
import { createCounting } from './counting.js';
import { createRewriter } from './rewrite.js';
import { diffWords } from './diff.js';
import { buildModels, estimateCost, projectSavings, fmtUSD, loadPrefs, savePrefs, DEFAULT_PREFS, PRICING_AS_OF, PRICING_NOTE } from './models.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const show = (s) => esc(s).replace(/ {2,}/g, (m) => '·'.repeat(m.length)).replace(/\n/g, '↵\n');
const nf = new Intl.NumberFormat();
const storage = (() => { try { const s = window.localStorage; s.getItem('x'); return s; } catch { return { getItem: () => null, setItem() { throw new Error('storage unavailable'); } }; } })();

const prefs = loadPrefs(storage);
const counting = createCounting(), rewriter = createRewriter();
let models = buildModels([], prefs.pricing);
const state = { text: '', aText: '', analyzed: false, result: null, chosen: new Set(), opt: null, baseline: null, view: 'workspace', cmpTab: 'local', ai: null, busy: { measure: false, ai: false }, marked: false };
const VIEWS = {
  workspace: ['Workspace', 'Write a prompt, find what it wastes, and trim it.'], compare: ['Compare', 'Original and optimized prompts, side by side.'],
  models: ['Models & cost', 'Configurable pricing and what your prompt costs.'], settings: ['Settings', 'Providers, privacy and appearance.'],
};
const EXAMPLE = `I would like you to please summarize the attached customer feedback in order to help our team understand the main themes. It is important to note that the summary should be very concise.

Return the summary as five bullet points.   Group related comments together.


Please note that you should not invent quotes. Return the summary as five bullet points.

Thank you in advance for your help.`;

const cur = () => models.find((m) => m.id === prefs.model) || models[0];
const save = () => savePrefs(storage, prefs);
const emptyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M5 12h10M5 17h6"/><circle cx="18" cy="17" r="3"/></svg>';

function toast(msg, kind = 'info') {
  const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg; $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4500);
}
function setStatus(id, msg, kind = '') { const el = $(id); el.textContent = msg; el.className = `status ${kind}`.trim(); }
function dynamic(root) { // CSP forbids inline style attributes, so sizes are applied through the DOM
  root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  requestAnimationFrame(() => root.querySelectorAll('[data-off]').forEach((el) => { el.style.strokeDashoffset = el.dataset.off; }));
}
function applyTheme() { const t = prefs.theme; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }

// ------------------------------------------------------------------ navigation
function go(view) {
  if (!VIEWS[view]) view = 'workspace';
  state.view = view;
  for (const v of Object.keys(VIEWS)) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav-item').forEach((b) => (b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  $('view-title').textContent = VIEWS[view][0]; $('view-sub').textContent = VIEWS[view][1];
  try { history.replaceState(null, '', `#${view}`); } catch { /* ignore */ }
  renderAll(); window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ analysis (all local)
function runAnalysis() {
  const text = $('input').value;
  state.text = text; state.aText = text; state.analyzed = true;
  state.result = analyze(text, { counter: counting.counter });
  state.chosen = recommendedIds(state.result.findings);
  computeLocal(); renderAll();
}
function computeLocal() {
  state.opt = state.analyzed ? optimize(state.aText, state.result.findings, state.chosen, { counter: counting.counter }) : null;
}
function refreshCounts() {
  if (state.analyzed) { state.result.tokens = countTokens(state.aText, counting.counter); computeLocal(); }
  renderStats(); renderCompare(); renderModelsView(); updateButtons();
}

// ------------------------------------------------------------------ rendering
function renderMeta() {
  const t = $('input').value;
  $('meta').textContent = `${nf.format([...t].length)} characters · ${nf.format((t.match(/\S+/g) || []).length)} words`;
}

// Achieved savings exist only after a version was adopted ("Use as my prompt"). They are recounted from the ORIGINAL and the
// adopted text with the same counter, and shown only while the editor still holds exactly the adopted text.
function renderAchieved() {
  const el = $('st-achieved'), b = state.baseline;
  if (!b || b.adopted === b.original || $('input').value !== b.adopted) { el.hidden = true; return; }
  const m = measureSavings(b.original, b.adopted, { counter: counting.counter }), mark = m.kind === 'estimated' ? '~' : '';
  el.textContent = m.saved > 0 ? `Achieved: ${mark}${nf.format(m.saved)} fewer tokens (${nf.format(m.before)} → ${nf.format(m.after)}, ${m.kind}) vs your original`
    : m.saved === 0 ? `No change in tokens vs your original (${nf.format(m.before)}, ${m.kind})`
    : `Result: ${mark}${nf.format(-m.saved)} MORE tokens than your original (${nf.format(m.before)} → ${nf.format(m.after)}, ${m.kind})`;
  el.hidden = false;
}

function renderStats() {
  const set = (id, v) => { $(id).textContent = v; };
  const r = state.result, o = state.opt, m = cur();
  if (!state.analyzed || !r) {
    set('st-tokens', '–'); set('st-save', '–'); set('st-cost', '–'); set('st-month', '–');
    const b = $('st-badge'); b.className = 'badge'; b.textContent = 'No analysis yet'; b.title = ''; set('st-sub', '');
    set('st-save-sub', 'Press Analyze to find out'); set('st-cost-sub', "Estimated from the target model's price"); set('st-month-sub', `At ${nf.format(prefs.calls)} calls a month`);
    $('st-achieved').hidden = true;
    return;
  }
  const t = r.tokens, est = t.kind === 'estimated';
  set('st-tokens', (est && t.count ? '~' : '') + nf.format(t.count));
  const b = $('st-badge'); b.className = `badge ${est ? 'est' : 'ok'}`;
  b.textContent = est ? 'Estimated' : `Measured · ${t.provider === 'local' ? 'local tokenizer' : 'Anthropic'}`;
  b.title = t.caveat || (est ? 'Heuristic estimate, not a tokenizer. Use Count exactly where available.' : '');
  set('st-sub', !t.count ? '' : est ? `likely ${nf.format(t.low)}–${nf.format(t.high)}` : `${nf.format(r.stats.words)} words`);
  if (o) {
    set('st-save', `${o.saved > 0 ? (o.kind === 'estimated' ? '~' : '') : ''}${nf.format(Math.max(0, o.saved))} tokens`);
    const all = r.potential && r.potential.all.tokens > o.saved ? ` · all suggestions together: ~${nf.format(r.potential.all.tokens)}` : '';
    set('st-save-sub', `${o.before ? Math.max(0, Math.round((o.saved / o.before) * 100)) : 0}% of the prompt · ${o.kind} · if you apply the selected edits${all}`);
  }
  renderAchieved();
  const price = m.price, c = estimateCost({ tokens: t.count, outputTokens: prefs.out, price });
  set('st-cost', c ? fmtUSD(c.total * 1000) : '–');
  set('st-cost-sub', !price ? 'No price set: add one in Models & cost' : price.in === 0 && price.out === 0 ? 'Free tier ($0), rate-limited' : `${fmtUSD(price.in)}/M in${prefs.out ? ` + ${fmtUSD(price.out)}/M out` : ''} · ${est ? 'estimated' : 'measured'} tokens`);
  const s = o ? projectSavings({ before: o.before, after: o.after, calls: prefs.calls, price }) : null;
  set('st-month', s ? fmtUSD(s.perMonth) : '–'); set('st-month-sub', s ? `If applied · at ${nf.format(prefs.calls)} calls a month · input only` : 'Set a price to see this');
}

function renderScore() {
  const el = $('score-card'), r = state.result;
  if (!state.analyzed || !r) {
    el.innerHTML = `<div class="empty">${emptyIcon}<h2>No analysis yet</h2><p>Paste a prompt and press <b>Analyze</b>. You get an efficiency score, what each point cost you, and edits you can apply. All of it runs in your browser.</p></div>`;
    return;
  }
  const s = r.score, cls = s === null ? 'none' : s >= 90 ? 'lean' : s >= 75 ? 'fair' : s >= 50 ? 'padded' : 'heavy', C = 326.7;
  const rows = s === null ? '' : r.criteria.map((c) => `<li class="${!c.penalty ? 'lean' : c.penalty / c.max >= 0.8 ? 'heavy' : 'padded'}"><div class="crit-top"><span>${esc(c.label)}</span><b>${c.penalty ? '−' + c.penalty : '0'}</b></div><div class="bar"><i data-w="${c.max ? Math.round((c.penalty / c.max) * 100) : 0}"></i></div><small>${esc(c.detail)}</small></li>`).join('');
  el.innerHTML = `<div class="score-head">
    <svg class="ring ${cls}" viewBox="0 0 120 120" role="img" aria-label="Efficiency score ${s ?? 'not available'}"><circle class="trk" cx="60" cy="60" r="52"/><circle class="val" cx="60" cy="60" r="52" transform="rotate(-90 60 60)" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${s === null ? C : (C * (1 - s / 100)).toFixed(1)}"/><text x="60" y="71" text-anchor="middle">${s ?? '–'}</text></svg>
    <div><h2>Efficiency score</h2><p class="label ${cls}">${esc(r.label)}</p><p class="muted flush">Rule-based · offline · starts at 100</p></div></div>
    ${s === null ? '<p class="note">Add a little more text to get a score.</p>' : `<ul class="criteria">${rows}</ul>`}
    <p class="fine">${r.notes.map(esc).join(' ')} The score does not depend on which model or counter you choose.</p>`;
  dynamic(el);
}

const fixText = (f) => f.replacement === '' ? 'remove' : f.kind === 'whitespace' && !f.replacement.trim() ? (f.replacement.includes('\n') ? 'one blank line' : 'one space') : esc(f.replacement);

function renderSuggestions() {
  const el = $('sugg-card'), r = state.result;
  if (!state.analyzed || !r) { el.innerHTML = `<div class="empty">${emptyIcon}<h2>Suggestions appear here</h2><p>Edits that cannot lose a requirement are pre-selected. Anything that could change meaning or degree stays unchecked until you choose it.</p></div>`; return; }
  const edits = r.findings.filter((f) => !f.advisory), advice = r.findings.filter((f) => f.advisory);
  if (!edits.length && !advice.length && !r.signals.length) { el.innerHTML = '<div class="empty"><h2>Nothing to trim</h2><p>No wasted wording, repetition or vague phrasing found by the current checks.</p></div>'; return; }
  const row = (f) => `<li><label><input type="checkbox" data-id="${f.id}" ${state.chosen.has(f.id) ? 'checked' : ''} ${f.advisory ? 'disabled' : ''}>
    <span><span class="t">${show(f.original.trim() || f.original)}${f.advisory ? '' : ' → ' + fixText(f)}</span><span class="tag">${f.protected ? 'protected' : f.advisory ? 'advice' : f.safe ? 'safe' : f.recommended ? 'recommended' : 'review'}</span><span class="m">${esc(KINDS[f.kind])}: ${esc(f.message)}</span></span>
    <span class="s">${f.advisory ? '' : '−' + f.saved}</span></label></li>`;
  const sig = (s) => `<li><label><input type="checkbox" disabled><span><span class="t prose">Missing context</span><span class="tag">${s.severity === 'warn' ? 'advice' : 'note'}</span><span class="m">${esc(s.message)}</span></span><span class="s">${s.penalty ? '−' + s.penalty + ' pts' : ''}</span></label></li>`;
  const safe = edits.filter((f) => f.recommended), review = edits.filter((f) => !f.recommended);
  el.innerHTML = `<div class="sugg-head"><h2>Suggestions <span class="muted">(${edits.length + advice.length + r.signals.length})</span></h2><div class="head-actions"><button type="button" class="link" data-act="safe">Select recommended</button><button type="button" class="link" data-act="none">Clear</button></div></div>
    <ul class="list">
    ${safe.length ? `<p class="group">Recommended edits</p>${safe.map(row).join('')}` : ''}
    ${review.length ? `<p class="group">Review first</p>${review.map(row).join('')}` : ''}
    ${advice.length || r.signals.length ? `<p class="group">Advice (edit by hand)</p>${advice.map(row).join('')}${r.signals.map(sig).join('')}` : ''}</ul>`;
}

function renderMarked() {
  const box = $('marked'), r = state.result;
  $('legend').hidden = !state.marked || !state.analyzed;
  if (!state.marked) return;
  if (!state.analyzed || !r || state.aText !== $('input').value) { box.innerHTML = '<span class="muted">Press Analyze to mark up this prompt.</span>'; return; }
  let html = '', at = 0; const t = state.aText;
  for (const f of r.findings) { html += esc(t.slice(at, f.start)) + `<mark class="k-${f.kind}" title="${esc(f.message)}">${esc(t.slice(f.start, f.end))}</mark>`; at = f.end; }
  box.innerHTML = html + esc(t.slice(at)) || '<span class="muted">Nothing to mark up yet.</span>';
  $('legend').innerHTML = Object.entries(KINDS).map(([k, n]) => `<span><mark class="k-${k}">${esc(n)}</mark></span>`).join('');
}

const diffHtml = (parts, side) => parts.filter((p) => p.type === 'eq' || p.type === (side === 'orig' ? 'del' : 'add'))
  .map((p) => (p.type === 'eq' ? esc(p.text) : `<${p.type === 'del' ? 'del' : 'ins'}>${esc(p.text)}</${p.type === 'del' ? 'del' : 'ins'}>`)).join('');

const NO_CHANGE = {
  already_lean: 'No removable wording or repetition was found, so the prompt is already lean and is returned unchanged.',
  review_only: 'The only edits available change tone or degree (for example "very"), so none are applied unless you tick them.',
  nothing_selected: 'No edits are selected. Tick suggestions in the Workspace.',
  all_skipped: 'Every selected edit was refused to protect a requirement.',
};

function candidate() {
  if (state.cmpTab === 'ai') return state.ai ? { source: 'ai', orig: state.ai.forText, text: state.ai.text } : null;
  return state.opt ? { source: 'local', orig: state.aText, text: state.opt.text } : null;
}

function renderAiPanel() {
  const sel = $('ai-provider'), on = rewriter.providers.filter((p) => p.configured), keep = sel.value;
  sel.innerHTML = on.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.model ? ' · ' + esc(p.model) : ''}</option>`).join('');
  if (on.some((p) => p.id === keep)) sel.value = keep;
  const p = on.find((x) => x.id === sel.value) || on[0];
  $('ai-run').textContent = p ? (p.local ? 'Improve with AI (runs locally)' : `Improve with AI (sends prompt to ${p.label})`) : 'Improve with AI';
  $('ai-run').disabled = state.busy.ai; $('ai-run').classList.toggle('busy', state.busy.ai);
  const warn = p && p.id === 'ollama' && p.reachable === false ? ' Ollama is not responding right now, so this will probably fail.' : '';
  $('ai-disclosure').className = `callout ${p && !p.local ? 'warn' : ''}`;
  $('ai-disclosure').textContent = p ? `${p.privacy}${warn} Nothing is sent until you press the button. The result is a suggestion, not a measurement.` : '';
}

function renderCompare() {
  const ai = state.cmpTab === 'ai';
  $('cmp-local').setAttribute('aria-selected', String(!ai)); $('cmp-ai').setAttribute('aria-selected', String(ai));
  $('ai-panel').hidden = !(ai && rewriter.available);
  if (ai && rewriter.available) renderAiPanel();
  const c = candidate(), empty = $('cmp-empty');
  $('cmp-body').hidden = !c; empty.hidden = Boolean(c);
  $('cmp-chips').innerHTML = '';
  if (!c) {
    if (ai && !rewriter.available) {
      empty.innerHTML = `${emptyIcon}<h2>AI rewriting is optional and off</h2><p>Local optimization needs nothing. To add an AI rewrite, enable one provider on the server:</p><div class="opts">${rewriter.providers.map((p) => `<div><b>${esc(p.label)}</b>: ${esc(p.setup)}</div>`).join('') || '<div>Could not read provider status from the server.</div>'}</div>`;
    } else if (ai && state.busy.ai) {
      empty.innerHTML = '<h2>Asking the model…</h2><div class="skel l wide"></div><div class="skel l s"></div><div class="skel l"></div>';
    } else if (ai) {
      empty.innerHTML = `${emptyIcon}<h2>No AI rewrite yet</h2><p>Choose a provider above and press <b>Improve with AI</b>. The rewrite is checked for dropped requirements and compared with your original here.</p>`;
    } else {
      empty.innerHTML = `${emptyIcon}<h2>Nothing to compare yet</h2><p>Analyze a prompt in the Workspace, then press <b>Optimize</b> to see the original and the trimmed version side by side.</p><button type="button" class="btn primary" data-go="workspace">Go to Workspace</button>`;
    }
    return;
  }
  const ms = measureSavings(c.orig, c.text, { counter: counting.counter }); // both texts recounted with the same counter or estimator
  const before = ms.before, after = ms.after, kind = ms.kind, saved = ms.saved, m = cur();
  const sv = projectSavings({ before, after, calls: prefs.calls, price: m.price });
  const lost = lostRequirements(c.orig, c.text), parts = diffWords(c.orig, c.text);
  $('cmp-chips').innerHTML = [
    `<span class="chip ${saved > 0 ? 'good' : 'warn'}">${c.source === 'ai' ? 'AI rewrite' : 'Optimized version'}: ${nf.format(before)} → ${nf.format(after)} tokens (${saved > 0 ? '−' : saved < 0 ? '+' : ''}${nf.format(Math.abs(saved))}${before ? `, ${Math.abs(Math.round((saved / before) * 100))}%` : ''})</span>`,
    `<span class="badge ${kind === 'estimated' ? 'est' : 'ok'}">${kind === 'estimated' ? 'Estimated' : 'Measured'}</span>`,
    '<span class="badge">Not applied to your prompt yet</span>',
    c.source === 'ai' ? '<span class="badge ai">AI suggestion</span>' : '',
    sv && m.price && saved > 0 ? `<span class="chip">Would save ${fmtUSD(sv.per1k)} / 1,000 calls</span>` : '',
  ].join('');
  $('cmp-orig').innerHTML = diffHtml(parts, 'orig'); $('cmp-new').innerHTML = diffHtml(parts, 'new');
  $('cmp-orig-meta').textContent = `${nf.format([...c.orig].length)} characters`; $('cmp-new-meta').textContent = `${nf.format([...c.text].length)} characters`;
  $('cmp-new-title').textContent = c.source === 'ai' ? `AI rewrite${state.ai ? ' · ' + state.ai.model : ''}` : 'Optimized';
  const g = $('cmp-guard');
  if (c.source === 'ai') {
    g.className = `callout ${lost.length ? 'bad' : 'good'}`;
    g.textContent = lost.length ? `Check before using: this rewrite no longer contains ${lost.join(', ')}. These look like requirements in your original.` : 'Requirements check passed: every number, format, negation, limit and name from your original is still present. This check cannot see reworded requirements, so read the diff.';
  } else {
    const o = state.opt, skipped = o.skipped.length ? ` Not applied: ${o.skipped.map((s) => s.reason).join('; ')}.` : '';
    g.className = `callout ${o.verification.preserved && !lost.length ? 'good' : 'bad'}`;
    g.textContent = (o.applied.length ? `This version applies ${o.applied.length} edit${o.applied.length === 1 ? '' : 's'}. ` : `${NO_CHANGE[o.reason] || 'No edits were applied.'} `) + `Requirements check: all ${o.verification.requirements} constraint markers in your prompt are still present.${skipped}`;
  }
  $('cmp-use').textContent = lost.length ? 'Use anyway' : 'Use as my prompt'; $('cmp-use').className = `btn ${lost.length ? 'danger' : ''}`;
}

function countingCell(m) {
  const r = counting.routeFor(m.id);
  if (m.count === 'anthropic') return r ? '<span class="badge ok">Anthropic API · on request</span>' : '<span class="badge est">Needs a key on the server</span>';
  if (m.count === 'local') return '<span class="badge ok">Local tokenizer</span>';
  return '<span class="badge">Estimate only</span>';
}
function renderModelsView() {
  $('pricing-note').textContent = `${PRICING_NOTE} Defaults as of ${PRICING_AS_OF}. Edits are stored in this browser only.`;
  const cell = (m, k) => `<td><input type="number" min="0" step="any" data-model="${esc(m.id)}" data-k="${k}" aria-label="${esc(m.label)} ${k === 'in' ? 'input' : 'output'} price per million tokens" value="${m.price ? m.price[k] : ''}" placeholder="not set"></td>`;
  $('price-table').tBodies[0].innerHTML = models.map((m) => `<tr><td><b>${esc(m.label)}</b>${m.edited ? ' <span class="tag">edited</span>' : ''}<span class="mn">${esc(m.vendor)}${m.note ? ' · ' + esc(m.note) : ''}</span></td><td>${countingCell(m)}</td>${cell(m, 'in')}${cell(m, 'out')}</tr>`).join('');
  $('calls').value = prefs.calls; $('outtok').value = prefs.out;
  const body = $('scenario-table').tBodies[0];
  if (!state.analyzed || !state.opt) { body.innerHTML = '<tr><td colspan="4" class="muted">Analyze a prompt in the Workspace to see costs for every model.</td></tr>'; return; }
  const b = estimateTokens(state.aText), a = estimateTokens(state.opt.text);
  body.innerHTML = models.filter((m) => m.price).map((m) => {
    const c0 = estimateCost({ tokens: b, outputTokens: prefs.out, price: m.price }), c1 = estimateCost({ tokens: a, outputTokens: prefs.out, price: m.price }), s = projectSavings({ before: b, after: a, calls: prefs.calls, price: m.price });
    return `<tr><td><b>${esc(m.label)}</b></td><td class="num">${fmtUSD(c0.total)}</td><td class="num">${fmtUSD(c1.total)}</td><td class="num">${fmtUSD(s.perMonth)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">No model has a price set.</td></tr>';
}

function renderSettings() {
  const card = (title, state_, ok, html) => `<article class="card pcard"><h2>${esc(title)}<span class="badge ${ok ? 'ok' : ''}">${esc(state_)}</span></h2><p>${html}</p></article>`;
  const cards = [card('Offline engine', 'Always on', true, 'Analysis, scoring, local optimization, diffs and cost estimates run in your browser. No key and no network needed.')];
  cards.push(counting.available
    ? card('Exact counting · Anthropic', 'On', true, `Models: ${counting.models.map((m) => `<code>${esc(m)}</code>`).join(' ')}. Runs only when you press Count exactly; your prompt goes to Anthropic through this server.`)
    : card('Exact counting · Anthropic', 'Off', false, $('tpl-count-off').innerHTML));
  cards.push(counting.localModels.length
    ? card('Local tokenizers', `${counting.localModels.length} installed`, true, `${counting.localModels.map((t) => `<b>${esc(t.label)}</b>${t.note ? ': ' + esc(t.note) : ''}`).join('<br>')}`)
    : card('Local tokenizers', 'None', false, $('tpl-tok-off').innerHTML));
  for (const p of rewriter.providers)
    cards.push(card(`AI rewrite · ${p.label}`, p.configured ? 'On' : 'Off', p.configured, `${esc(p.privacy)} ${p.configured ? `Model: <code>${esc(p.model)}</code>.${p.id === 'ollama' && p.reachable === false ? ' <b>Not responding right now.</b>' : ''}` : esc(p.setup)}`));
  if (!rewriter.providers.length) cards.push(card('AI rewrite', 'Unavailable', false, 'Could not read provider status from the server. Local features still work.'));
  $('provider-cards').innerHTML = cards.join('');
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === prefs.theme)));
}

function updateButtons() {
  const has = $('input').value.trim().length > 0, route = counting.route;
  $('analyze').disabled = !has; $('optimize').disabled = !has;
  const mb = $('measure'); mb.disabled = state.busy.measure || !route || !has; mb.classList.toggle('busy', state.busy.measure);
  mb.title = route ? `Sends this prompt to ${route === 'local' ? 'the local tokenizer on this machine' : 'Anthropic, through your local server,'} to count tokens` : 'No exact counter for this model: estimates are shown instead.';
  const m = cur(), r = counting.routeFor(m.id);
  $('model-hint').textContent = r === 'local' ? 'Exact counting: local tokenizer' : r ? 'Exact counting available on request' : m.count === 'anthropic' ? 'Estimates only: exact counting needs a key on the server' : 'Estimates only for this model';
}

function renderAll() { renderMeta(); renderStats(); renderScore(); renderSuggestions(); renderMarked(); renderCompare(); renderModelsView(); renderSettings(); updateButtons(); }

// ------------------------------------------------------------------ actions
async function measure() {
  if (state.busy.measure) return;
  const text = $('input').value; if (!text.trim()) return;
  if (!state.analyzed || state.aText !== text) runAnalysis();
  const texts = [state.aText]; if (state.opt && state.opt.text.trim() && state.opt.text !== state.aText) texts.push(state.opt.text);
  state.busy.measure = true; updateButtons(); setStatus('measure-status', `Counting for ${cur().label}…`);
  let results;
  try { results = await Promise.all(texts.map((t) => counting.measure(t))); } catch { results = [{ ok: false, message: 'Unexpected error while counting.' }]; }
  state.busy.measure = false;
  if ($('input').value !== text) { updateButtons(); return setStatus('measure-status', 'The prompt changed while counting. Count again.', 'error'); }
  const bad = results.find((r) => !r.ok);
  if (bad) { setStatus('measure-status', `${bad.message}${bad.requestId ? ` (request ${bad.requestId})` : ''}${bad.retryAfter ? ` Retry in ${bad.retryAfter}s.` : ''} Showing estimates where there is no measurement.`, 'error'); toast(bad.message, 'error'); }
  else setStatus('measure-status', `Measured for ${cur().label}.`, 'good');
  refreshCounts();
}

async function improveWithAi() {
  if (state.busy.ai) return;
  const text = $('input').value;
  if (!text.trim()) return toast('Type or paste a prompt first.');
  const provider = $('ai-provider').value;
  state.busy.ai = true; setStatus('ai-status', ''); renderCompare();
  let r; try { r = await rewriter.rewrite(text, provider); } catch { r = { ok: false, message: 'Unexpected error while rewriting.' }; }
  state.busy.ai = false;
  if (!r.ok) { setStatus('ai-status', `${r.message}${r.retryAfter ? ` Retry in ${r.retryAfter}s.` : ''}`, 'error'); toast(r.message, 'error'); }
  else if ($('input').value !== text) setStatus('ai-status', 'The prompt changed while the model was working, so the rewrite was discarded.', 'error');
  else { state.ai = { ...r, forText: text }; setStatus('ai-status', `Rewrite ready from ${r.provider}. Review the diff and the requirements check before using it.`, 'good'); }
  renderCompare();
}

// ------------------------------------------------------------------ events
let timer;
$('input').addEventListener('input', () => {
  state.text = $('input').value; renderMeta(); updateButtons();
  if (state.ai && state.ai.forText !== state.text) state.ai = null;
  clearTimeout(timer);
  timer = setTimeout(() => { if (state.analyzed) runAnalysis(); }, 160);
});
$('input').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('analyze').click(); } });
$('analyze').onclick = () => { if ($('input').value.trim()) { runAnalysis(); setStatus('measure-status', ''); } };
$('optimize').onclick = () => {
  if (!$('input').value.trim()) return;
  if (!state.analyzed || state.aText !== $('input').value) runAnalysis();
  state.cmpTab = 'local'; go('compare');
  const n = state.opt ? state.opt.applied.length : 0;
  toast(n ? `Optimized version ready: ${n} edit${n === 1 ? '' : 's'}, ${state.opt.kind === 'estimated' ? 'about ' : ''}${state.opt.saved > 0 ? state.opt.saved : 0} fewer tokens if you use it. Your prompt is unchanged until you press Use as my prompt.` : (NO_CHANGE[state.opt?.reason] || 'No edits were applied.'), n ? 'good' : 'info');
};
$('measure').onclick = measure;
$('example').onclick = () => { $('input').value = EXAMPLE; state.ai = null; state.baseline = null; runAnalysis(); state.marked = false; $('tab-edit').click(); };
$('clear').onclick = () => { $('input').value = ''; Object.assign(state, { text: '', aText: '', analyzed: false, result: null, opt: null, ai: null, baseline: null, chosen: new Set() }); setStatus('measure-status', ''); renderAll(); $('input').focus(); };
$('tab-edit').onclick = () => { state.marked = false; $('input').hidden = false; $('marked').hidden = true; $('tab-edit').setAttribute('aria-selected', 'true'); $('tab-marked').setAttribute('aria-selected', 'false'); renderMarked(); };
$('tab-marked').onclick = () => { if ($('input').value.trim() && (!state.analyzed || state.aText !== $('input').value)) runAnalysis(); state.marked = true; $('input').hidden = true; $('marked').hidden = false; $('tab-edit').setAttribute('aria-selected', 'false'); $('tab-marked').setAttribute('aria-selected', 'true'); renderMarked(); };

$('sugg-card').addEventListener('change', (e) => {
  const id = Number(e.target.dataset.id); if (!Number.isInteger(id)) return;
  e.target.checked ? state.chosen.add(id) : state.chosen.delete(id);
  computeLocal(); renderStats(); renderCompare(); renderModelsView();
});
$('sugg-card').addEventListener('click', (e) => {
  const act = e.target.dataset?.act; if (!act || !state.result) return;
  state.chosen = act === 'safe' ? recommendedIds(state.result.findings) : new Set();
  computeLocal(); renderStats(); renderSuggestions(); renderCompare(); renderModelsView();
});
document.addEventListener('click', (e) => { const g = e.target.closest?.('[data-go]'); if (g) go(g.dataset.go); });
document.querySelectorAll('.nav-item').forEach((b) => { b.onclick = () => go(b.dataset.view); });
window.addEventListener('hashchange', () => go(location.hash.slice(1)));

$('cmp-local').onclick = () => { state.cmpTab = 'local'; renderCompare(); };
$('cmp-ai').onclick = () => { state.cmpTab = 'ai'; renderCompare(); };
$('ai-run').onclick = improveWithAi;
$('ai-provider').onchange = renderAiPanel;
$('cmp-copy').onclick = async () => { const c = candidate(); if (!c) return; try { await navigator.clipboard.writeText(c.text); toast('Copied to the clipboard.', 'good'); } catch { toast('Copy failed. Select the text and copy it manually.', 'error'); } };
$('cmp-use').onclick = () => {
  const c = candidate(); if (!c) return;
  const prev = state.baseline, original = prev && prev.adopted === c.orig ? prev.original : c.orig; // keep measuring against the very first prompt while you keep optimizing
  $('input').value = c.text; state.ai = null; state.baseline = { original, adopted: c.text };
  runAnalysis(); go('workspace');
  const m = measureSavings(original, c.text, { counter: counting.counter });
  toast(`Prompt replaced. Recounted against your original: ${nf.format(m.before)} → ${nf.format(m.after)} tokens (${m.saved > 0 ? '−' : m.saved < 0 ? '+' : ''}${nf.format(Math.abs(m.saved))}, ${m.kind}).`, m.saved >= 0 ? 'good' : 'info');
};

$('target-model').onchange = () => { prefs.model = $('target-model').value; save(); syncCounting(); refreshCounts(); renderAll(); };
$('price-table').tBodies[0].addEventListener('change', (e) => {
  const id = e.target.dataset.model; if (!id) return;
  const row = e.target.closest('tr'), i = parseFloat(row.querySelector('[data-k=in]').value), o = parseFloat(row.querySelector('[data-k=out]').value);
  if (Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 && i <= 100000 && o <= 100000) { prefs.pricing[id] = { in: i, out: o }; save(); models = buildModels(rewriter.tokenizers, prefs.pricing); $('price-status').textContent = 'Saved in this browser.'; renderAll(); }
  else $('price-status').textContent = 'Enter both prices as numbers from 0 to 100000.';
});
$('price-reset').onclick = () => { prefs.pricing = {}; save(); models = buildModels(rewriter.tokenizers, {}); $('price-status').textContent = 'Defaults restored.'; renderAll(); };
const numPref = (id, key) => { $(id).onchange = () => { const v = Math.round(Number($(id).value)); if (Number.isFinite(v) && v >= 0) { prefs[key] = v; save(); } renderAll(); }; };
numPref('calls', 'calls'); numPref('outtok', 'out');
document.querySelectorAll('[data-theme-choice]').forEach((b) => { b.onclick = () => { prefs.theme = b.dataset.themeChoice; save(); applyTheme(); renderSettings(); }; });

function syncCounting() { const id = cur().id; counting.setModel(counting.routeFor(id) ? id : null); }
function fillModelSelect() {
  const groups = {}; for (const m of models) (groups[m.vendor] ||= []).push(m);
  $('target-model').innerHTML = Object.entries(groups).map(([v, ms]) => `<optgroup label="${esc(v)}">${ms.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</optgroup>`).join('');
  $('target-model').value = cur().id;
}

// ------------------------------------------------------------------ boot
applyTheme(); fillModelSelect(); go(VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : 'workspace');
(async () => {
  await Promise.all([counting.init(), rewriter.init()]);
  counting.setLocalTokenizers(rewriter.tokenizers);
  models = buildModels(rewriter.tokenizers, prefs.pricing);
  if (!models.some((m) => m.id === prefs.model)) prefs.model = DEFAULT_PREFS.model;
  fillModelSelect(); syncCounting(); renderAll();
})();
