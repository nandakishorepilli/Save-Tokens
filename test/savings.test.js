// Regression tests for two issues:
//  1. semantic repetition must flow consistently into the score, the findings and the optimization suggestions;
//  2. potential (estimated, before) savings must never be shown as achieved (recounted, after) savings.
// Fixture: a repetitive Python beginner prompt with restated "beginner / easy to follow" wording, real topics,
// a number, an output requirement and constraints that must survive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { analyze, optimize, optimizePrompt, recommendedIds, measureSavings, estimateTokens, lostRequirements } from '../public/core.js';

const PY = `I am a beginner. I want to learn Python programming.

Please explain Python to me in a way that is easy for beginners to understand. Make it beginner-friendly and easy to follow.

Explain what variables, loops and functions are. Use simple language and give me 3 short code examples, each as a Python code block with a comment on every line. Please avoid technical jargon.

Give me 3 short code examples. Keep the answer under 300 words. Make sure the explanation is simple and clear for a total newcomer.

Thank you so much in advance for your help!
`;
const GOLDEN_DEFAULT = `I am a beginner. I want to learn Python programming.

Explain Python to me in a way that is easy for beginners to understand.

Explain what variables, loops and functions are. Use simple language and give me 3 short code examples, each as a Python code block with a comment on every line. Avoid technical jargon.

Keep the answer under 300 words.
`;
const GOLDEN_ALL = GOLDEN_DEFAULT.replace('I am a beginner. ', '');
const PRESERVE = [/Python programming/, /Explain Python to me/, /variables, loops and functions/, /Use simple language/, /3 short code examples, each as a Python code block with a comment on every line/, /Avoid technical jargon/, /under 300 words/, /easy for beginners to understand/];
const AI = `I am a beginner. I want to learn about artificial intelligence.\n\nPlease explain artificial intelligence to me in a way that is easy for beginners to understand. Make it beginner-friendly and easy to follow.\n\nExplain what AI is and how it works. Use simple language and give me 3 real-world examples of AI in everyday life. Please avoid technical jargon.\n\nKeep the answer under 250 words. Make sure the explanation is simple and clear for a total newcomer.\n`;

const LEAN = 'Explain Python variables to a beginner. Make it beginner-friendly and easy to follow. Show 3 short code examples with a comment on every line. Keep the answer under 300 words.';
const RESTATED = `${LEAN} Make sure the explanation is simple and clear for a total newcomer.`;
const RESTATED2 = `${RESTATED} Keep it simple and easy for a novice to follow.`;

const defaultRun = (t, opts) => { const r = analyze(t, opts); return optimize(t, r.findings, recommendedIds(r.findings), opts); };
const allIds = (r) => new Set(r.findings.filter((f) => !f.advisory).map((f) => f.id));
const crit = (r, id) => r.criteria.find((c) => c.id === id);

// ======================================================================= 1. scoring consistency
test('the repetition criterion is built from the very findings the list shows, semantic ones included', () => {
  const r = analyze(PY), rep = r.findings.filter((f) => f.kind === 'repetition' && !f.advisory), sem = rep.filter((f) => f.semantic);
  assert.deepEqual(sem.map((f) => f.original), ['I am a beginner.', 'Make it beginner-friendly and easy to follow.', 'Make sure the explanation is simple and clear for a total newcomer.']);
  const sum = (l) => l.reduce((s, f) => s + f.saved, 0), c = crit(r, 'repetition');
  assert.deepEqual(c.parts, { exact: { count: rep.length - sem.length, tokens: sum(rep) - sum(sem) }, semantic: { count: 3, tokens: sum(sem), recommended: 2 }, advice: { count: 0 }, tokens: sum(rep) });
  assert.deepEqual(r.repetition, c.parts);                                           // one object, exposed both ways
  assert.equal(r.byKind.repetition, c.parts.tokens);                                 // same total the per-kind table reports
  assert.equal(c.evidence, rep.length);                                              // evidence = number of repetition rows in the list
  const pct = (c.parts.tokens / estimateTokens(PY)) * 100;
  assert.equal(c.penalty, Math.min(c.max, Math.round(2.5 * pct)));
  assert.match(c.detail, /1 repeated sentence\(s\) \(\d+ tokens\) \+ 3 restated idea\(s\) \(\d+ tokens\)/);   // no longer called "exact repeats"
  assert.match(c.detail, /Capped at −30/);                                           // says so when the cap hides the effect
  assert.equal(100 - r.criteria.reduce((s, x) => s + x.penalty, 0), r.score);
});

test('every semantic finding is a selectable suggestion, counted in the score whether or not it is pre-selected', () => {
  const r = analyze(PY), sem = r.findings.filter((f) => f.semantic), rec = recommendedIds(r.findings);
  assert.ok(sem.every((f) => !f.advisory && Number.isInteger(f.id) && f.replacement === '' && f.saved > 0));
  assert.deepEqual(sem.map((f) => rec.has(f.id)), [false, true, true]);              // "I am a beginner." is opt-in...
  assert.equal(crit(r, 'repetition').parts.semantic.tokens, sem.reduce((s, f) => s + f.saved, 0));   // ...and still counted
  assert.equal(crit(r, 'repetition').parts.semantic.recommended, 2);
  assert.ok(sem.every((f) => r.findings[f.id] === f));
});

test('adding a restated idea lowers the score, and removing it brings the score back', () => {
  const lean = analyze(LEAN), one = analyze(RESTATED), two = analyze(RESTATED2);
  assert.deepEqual([lean.findings.filter((f) => f.semantic).length, one.findings.filter((f) => f.semantic).length], [0, 1]);
  assert.equal(crit(lean, 'repetition').penalty, 0);
  assert.ok(crit(one, 'repetition').penalty > 0 && one.score < lean.score, `${one.score} vs ${lean.score}`);
  assert.ok(two.score <= one.score);
  const fixed = defaultRun(RESTATED);
  assert.equal(fixed.text, LEAN);
  assert.deepEqual([analyze(fixed.text).score, crit(analyze(fixed.text), 'repetition').penalty], [lean.score, 0]);
});

test('applying every repetition finding clears the repetition penalty and the detector finds nothing more', () => {
  const r = analyze(PY), ids = new Set(r.findings.filter((f) => f.kind === 'repetition' && !f.advisory).map((f) => f.id));
  const o = optimize(PY, r.findings, ids), after = analyze(o.text);
  assert.equal(crit(after, 'repetition').penalty, 0); assert.equal(after.findings.filter((f) => f.kind === 'repetition').length, 0);
  assert.ok(after.score > r.score);
  assert.deepEqual(lostRequirements(PY, o.text), []);
});

test('the score never gets worse after optimizing, whichever suggestions are applied', () => {
  for (const t of [PY, AI, RESTATED2, LEAN, 'Keep it short. Keep it concise. Keep it brief. Write 3 bullet points.']) {
    const r = analyze(t);
    for (const ids of [recommendedIds(r.findings), allIds(r)]) {
      const o = optimize(t, r.findings, ids);
      assert.ok(analyze(o.text).score >= r.score, `${JSON.stringify(t.slice(0, 40))}: ${r.score} -> ${analyze(o.text).score}`);
    }
  }
});

// ======================================================================= 2. savings: potential vs achieved
test('measureSavings recounts both texts with the same counter and never mixes measured with estimated', () => {
  const m = measureSavings(PY, GOLDEN_DEFAULT);
  assert.deepEqual([m.before, m.after, m.saved, m.kind, m.method], [estimateTokens(PY), estimateTokens(GOLDEN_DEFAULT), estimateTokens(PY) - estimateTokens(GOLDEN_DEFAULT), 'estimated', 'heuristic-v2']);
  assert.equal(m.percent, Math.round((m.saved / m.before) * 1000) / 10);
  assert.deepEqual(m.chars, { before: [...PY].length, after: [...GOLDEN_DEFAULT].length, saved: [...PY].length - [...GOLDEN_DEFAULT].length, kind: 'measured' });
  const words = { name: 'words', count: (t) => (t.match(/\S+/g) || []).length };
  const w = measureSavings(PY, GOLDEN_DEFAULT, { counter: words });
  assert.deepEqual([w.kind, w.before, w.after], ['measured', (PY.match(/\S+/g) || []).length, (GOLDEN_DEFAULT.match(/\S+/g) || []).length]);
  const onlyOriginal = { name: 'cache', count: (t) => (t === PY ? 999 : null) };      // the optimized text was never counted by the real tokenizer
  const mixed = measureSavings(PY, GOLDEN_DEFAULT, { counter: onlyOriginal });
  assert.deepEqual([mixed.kind, mixed.before, mixed.after], ['estimated', estimateTokens(PY), estimateTokens(GOLDEN_DEFAULT)]);   // 999 is NOT subtracted from an estimate
  assert.deepEqual([measureSavings('', '').saved, measureSavings('', '').percent, measureSavings(null, undefined).before], [0, 0, 0]);
  assert.equal(measureSavings('a b c d e f', 'a b c d e f g h').saved < 0, true);        // a longer result is reported as negative, never hidden
});

test('potential savings are labelled as potential and equal a recount of the would-be text, not a sum of guesses', () => {
  const r = analyze(PY), allText = optimize(PY, r.findings, allIds(r)).text, recText = optimize(PY, r.findings, recommendedIds(r.findings)).text;
  assert.equal(r.potential.basis, 'potential');
  assert.deepEqual([r.potential.all.kind, r.potential.recommended.kind], ['estimated', 'estimated']);
  assert.equal(r.potential.all.tokens, estimateTokens(PY) - estimateTokens(allText));
  assert.equal(r.potential.recommended.tokens, estimateTokens(PY) - estimateTokens(recText));
  assert.ok(r.potential.all.tokens > r.potential.recommended.tokens && r.potential.recommended.tokens > 0);
  assert.ok(r.potential.all.percent > r.potential.recommended.percent);
  const sum = r.findings.filter((f) => recommendedIds(r.findings).has(f.id)).reduce((s, f) => s + f.saved, 0);
  assert.ok(Math.abs(sum - r.potential.recommended.tokens) <= 2, `${sum} vs ${r.potential.recommended.tokens}`);
});

test('achieved savings come from recounting the original and the optimized prompt, and match a fresh analysis of the result', () => {
  const o = defaultRun(PY);
  assert.equal(o.text, GOLDEN_DEFAULT);
  assert.deepEqual([o.before, o.after, o.saved], [estimateTokens(PY), estimateTokens(GOLDEN_DEFAULT), estimateTokens(PY) - estimateTokens(GOLDEN_DEFAULT)]);
  assert.equal(analyze(o.text).tokens.count, o.after);                                // analysing the adopted prompt counts exactly what was reported
  assert.deepEqual(measureSavings(PY, o.text), { ...measureSavings(PY, o.text), before: o.before, after: o.after, saved: o.saved, percent: o.percent });
  assert.equal(o.saved, analyze(PY).potential.recommended.tokens);                    // the estimate made before optimizing equals the recount after it
  assert.ok(o.saved / o.before >= 0.3 && o.chars.saved > 0);
  for (const re of PRESERVE) assert.match(o.text, re, String(re));
  assert.deepEqual(lostRequirements(PY, o.text), []);
});

test('optimize, optimizePrompt and measureSavings always agree', () => {
  for (const t of [PY, AI, RESTATED2, LEAN]) {
    const o = defaultRun(t), p = optimizePrompt(t), m = measureSavings(t, p.text);
    assert.equal(p.text, o.text, t.slice(0, 30));
    assert.deepEqual([p.before, p.after, p.saved, p.percent, p.kind], [o.before, o.after, o.saved, o.percent, o.kind]);
    assert.deepEqual([m.before, m.after, m.saved, m.percent], [p.before, p.after, p.saved, p.percent]);
  }
  const lean = defaultRun(LEAN);
  assert.deepEqual([lean.saved, lean.percent, lean.reason], [0, 0, 'already_lean']);     // nothing to save: reported as zero, never invented
});

test('with a counter, savings are measured only when BOTH texts are; otherwise both fall back to the estimator', () => {
  const words = { name: 'words', count: (t) => (t.match(/\S+/g) || []).length };
  const r = analyze(PY, { counter: words }), o = optimize(PY, r.findings, recommendedIds(r.findings), { counter: words });
  assert.deepEqual([o.kind, o.before, o.after, o.saved], ['measured', words.count(PY), words.count(o.text), words.count(PY) - words.count(o.text)]);
  // a counter that can count any text recounts the would-be text too; it is still labelled as potential, never as achieved
  assert.deepEqual([r.potential.basis, r.potential.recommended.kind, r.potential.recommended.tokens], ['potential', 'measured', o.saved]);
  const cache = new Map([[PY, 123]]);                                                // only the original has a real count
  const half = { name: 'cache', count: (t) => cache.get(t) ?? null };
  const h = defaultRun(PY, { counter: half });
  assert.deepEqual([h.kind, h.before, h.after], ['estimated', estimateTokens(PY), estimateTokens(h.text)]);
  const hp = analyze(PY, { counter: half }).potential;                                // the would-be text was never counted by the real counter
  assert.deepEqual([hp.basis, hp.recommended.kind, hp.all.kind], ['potential', 'estimated', 'estimated']);
});

test('semantic suggestions still preserve every distinct instruction, topic, number and output requirement', () => {
  const r = analyze(PY);
  for (const out of [optimize(PY, r.findings, recommendedIds(r.findings)).text, optimize(PY, r.findings, allIds(r)).text, optimizePrompt(PY).text]) {
    for (const re of PRESERVE) assert.match(out, re, String(re));
    assert.deepEqual(lostRequirements(PY, out), []);
  }
  assert.equal(optimize(PY, r.findings, allIds(r)).text, GOLDEN_ALL);
});

// ======================================================================= 3. UI never presents potential as achieved
const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const app = readFileSync(join(dir, 'app.js'), 'utf8'), html = readFileSync(join(dir, 'index.html'), 'utf8');

test('UI wording: previews say "if applied / not applied yet"; "Achieved" appears only for an adopted version', () => {
  for (const bad of [/Applied \$\{n\}/, /edits? applied\./, /saved \$\{state/, /Saves \$\{fmtUSD/, /'Applied/]) assert.doesNotMatch(app, bad, String(bad));
  assert.doesNotMatch(html, /Saved \/ month/);
  for (const good of [/if you apply the selected edits/, /Not applied to your prompt yet/, /Would save/, /This version applies/, /Optimized version ready/, /Your prompt is unchanged until you press Use as my prompt/, /Est\. saving \/ month \(if applied\)/])
    assert.match(app + html, good, String(good));
  assert.match(html, /id="st-achieved" hidden/);
  assert.equal((app.match(/Achieved:/g) || []).length, 1);                           // one place only...
  const fn = app.slice(app.indexOf('function renderAchieved()'), app.indexOf('function renderStats()'));
  assert.match(fn, /!b \|\| b\.adopted === b\.original \|\| \$\('input'\)\.value !== b\.adopted/);   // ...guarded: needs an adopted baseline and an unedited prompt
  assert.match(fn, /measureSavings\(b\.original, b\.adopted/);                       // and it is a recount of original vs adopted
});

test('UI state: the baseline is set only when a version is adopted, chains to the first original, and resets on Clear and Load example', () => {
  const use = app.slice(app.indexOf("$('cmp-use').onclick"), app.indexOf("$('target-model').onchange"));
  assert.match(use, /state\.baseline = \{ original, adopted: c\.text \}/);
  assert.match(use, /prev && prev\.adopted === c\.orig \? prev\.original : c\.orig/);
  assert.match(use, /measureSavings\(original, c\.text/);
  assert.match(app, /\$\('example'\)\.onclick = \(\) => \{[^}]*state\.baseline = null/);
  assert.match(app, /\$\('clear'\)\.onclick = \(\) => \{[^}]*baseline: null/);
  assert.ok(!/state\.baseline = \{/.test(app.replace(use, '')), 'the baseline is assigned somewhere other than adoption');
  assert.match(app, /const ms = measureSavings\(c\.orig, c\.text/);                  // the Compare chips use the same recount for local and AI versions
});
