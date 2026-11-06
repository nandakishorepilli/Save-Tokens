// Regression tests for the "optimizer returns the original prompt unchanged" bug.
// Fixtures are repetitive, beginner-friendly machine-learning prompts: repeated instructions in different words,
// courtesy padding, emphasis frames, a thank-you closer, and constraints that MUST survive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, optimize, optimizePrompt, recommendedIds, estimateTokens, lostRequirements, requirementItems } from '../public/core.js';

const ML = `I want you to please explain machine learning to me. I am a complete beginner and I know nothing about it, so please explain it in a very simple way.

Please make sure to explain what machine learning is. Explain what machine learning is in simple words that a beginner can understand.

It is important to note that you must use simple language and avoid technical jargon. Please do not use technical jargon. Do not use jargon.

Keep the explanation short. Keep the explanation short, under 200 words.

Give me 3 examples. Give me exactly 3 examples of machine learning in everyday life. Make sure to include exactly 3 examples.

Please remember to explain it in order to help a beginner understand.   Thank you so much in advance for your help!
`;
const GOLDEN_ML = `I am a complete beginner and I know nothing about it, so explain it in a very simple way.

Explain what machine learning is in simple words that a beginner can understand.

You must use simple language and avoid technical jargon. Do not use technical jargon. Do not use jargon.

Keep the explanation short, under 200 words.

Give me exactly 3 examples of machine learning in everyday life.

Explain it to help a beginner understand.
`;
const VARIANT = `Hi! Could you please help me understand machine learning? I'm new to this and a total beginner.

Please explain machine learning in simple terms. Explain machine learning in simple terms so that I can follow it.

Basically, I would like you to avoid technical jargon and heavy math. Please avoid technical jargon and heavy math.

Make sure to give an example from everyday life. Provide one example from everyday life.

Be sure to keep your answer under 150 words. Keep your answer under 150 words.

Thanks so much!
`;
const GOLDEN_VARIANT = `Hi! Help me understand machine learning? I'm new to this and a total beginner.

Explain machine learning in simple terms so that I can follow it.

Avoid technical jargon and heavy math.

Provide one example from everyday life.

Keep your answer under 150 words.
`;
const FIXTURES = [['ML', ML, GOLDEN_ML], ['VARIANT', VARIANT, GOLDEN_VARIANT]];

const defaultOptimize = (t) => { const r = analyze(t); return optimize(t, r.findings, recommendedIds(r.findings)); }; // exactly what the Optimize button applies
const safeOnly = (t) => { const r = analyze(t); return optimize(t, r.findings, new Set(r.findings.filter((f) => f.safe && !f.advisory).map((f) => f.id))); }; // the OLD default
const sentences = (t) => (t.match(/[^.!?\n]+[.!?]*/g) || []).map((s) => s.toLowerCase().replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 15);
const count = (t, re) => (t.match(re) || []).length;

test('the bug: the old default left these prompts almost untouched; the default now removes the padding', () => {
  for (const [name, text] of FIXTURES) {
    const old = safeOnly(text), now = defaultOptimize(text);
    assert.ok(old.saved / old.before < 0.05, `${name}: the old default saved ${old.saved}/${old.before}`);   // documents the bug
    assert.notEqual(now.text, text, name);
    assert.ok(now.applied.length >= 6, `${name}: only ${now.applied.length} edits`);
    assert.equal(now.reason, 'optimized');
  }
});

test('the optimized prompt is genuinely shorter, in tokens and in characters', () => {
  for (const [name, text] of FIXTURES) {
    const o = defaultOptimize(text);
    assert.ok(o.saved / o.before >= 0.3, `${name}: only ${Math.round((o.saved / o.before) * 100)}% fewer tokens`);
    assert.ok(o.chars.saved / o.chars.before >= 0.25, `${name}: only ${Math.round((o.chars.saved / o.chars.before) * 100)}% fewer characters`);
    assert.ok(estimateTokens(o.text) < estimateTokens(text));
  }
});

test('every requirement, constraint and the intended meaning survive', () => {
  const need = {
    ML: [/must use simple language/i, /avoid technical jargon/i, /do not use/i, /exactly 3 examples/i, /under 200 words/i, /beginner/i, /machine learning/i, /simple (?:way|words)/i, /everyday life/i],
    VARIANT: [/avoid technical jargon and heavy math/i, /under 150 words/i, /one example from everyday life/i, /beginner/i, /machine learning/i, /simple terms/i],
  };
  for (const [name, text] of FIXTURES) {
    const o = defaultOptimize(text);
    assert.deepEqual(lostRequirements(text, o.text), [], name);
    assert.equal(o.verification.preserved, true);
    for (const re of need[name]) assert.match(o.text, re, `${name}: lost ${re}`);
  }
});

test('repeated instructions and courtesy padding are actually gone', () => {
  for (const [name, text] of FIXTURES) {
    const out = defaultOptimize(text).text, s = sentences(out);
    assert.equal(new Set(s).size, s.length, `${name}: a sentence is still repeated`);
    assert.doesNotMatch(out, /\bplease\b|thank|I want you to|I would like you to|make sure to|be sure to|remember to|it is important to note|\bbasically\b|in order to/i, name);
  }
  const ml = defaultOptimize(ML).text;
  assert.equal(count(ml, /keep the explanation short/gi), 1); assert.equal(count(ml, /under 200 words/gi), 1);
  assert.equal(count(ml, /\b3 examples/gi), 1); assert.equal(count(ml, /explain what machine learning is/gi), 1);
  const v = defaultOptimize(VARIANT).text;
  assert.equal(count(v, /under 150 words/gi), 1); assert.equal(count(v, /technical jargon/gi), 1); assert.equal(count(v, /simple terms/gi), 1);
});

test('exact expected output (golden): reads naturally, nothing stray left behind', () => {
  for (const [name, text, golden] of FIXTURES) {
    const out = defaultOptimize(text).text;
    assert.equal(out, golden, name);
    assert.ok(!/[ \t]\n|\n\n\n|^[ \t]|[ \t]{2,}/m.test(out), `${name}: stray whitespace`);
  }
});

test('token reduction is reported accurately and consistently', () => {
  for (const [name, text] of FIXTURES) {
    const r = analyze(text), ids = recommendedIds(r.findings), o = optimize(text, r.findings, ids);
    assert.equal(o.before, estimateTokens(text), name); assert.equal(o.after, estimateTokens(o.text), name);
    assert.equal(o.saved, o.before - o.after, name); assert.equal(o.kind, 'estimated');
    assert.equal(o.chars.saved, [...text].length - [...o.text].length);
    const sum = r.findings.filter((f) => ids.has(f.id)).reduce((s, f) => s + f.saved, 0);
    assert.ok(Math.abs(sum - o.saved) <= 2, `${name}: per-edit savings ${sum} vs reported ${o.saved}`);   // per-edit numbers add up to the total
  }
  const words = { name: 'word counter', count: (t) => (t.match(/\S+/g) || []).length };
  const m = optimizePrompt(ML, { counter: words });
  assert.deepEqual([m.kind, m.before, m.after], ['measured', (ML.match(/\S+/g) || []).length, (m.text.match(/\S+/g) || []).length]);
  assert.equal(m.saved, m.before - m.after);
});

test('the optimizer converges: a second run changes nothing and says the prompt is lean', () => {
  for (const [name, text] of FIXTURES) {
    const p = optimizePrompt(text);
    assert.equal(p.passes, 1, name); assert.equal(p.outcome, 'optimized');
    const again = optimizePrompt(p.text);
    // ML still contains "very", an opt-in intensifier, so it reports review_only; VARIANT has nothing left at all
    assert.deepEqual([again.text, again.passes, again.outcome, again.saved], [p.text, 0, name === 'ML' ? 'review_only' : 'already_lean', 0], name);
    assert.deepEqual([...recommendedIds(analyze(p.text).findings)], [], `${name}: recommended edits remain`);
  }
});

test('the original is returned only when there is nothing meaningful to remove, and the reason is given', () => {
  const lean = 'Explain how a neural network learns, in three short paragraphs for a beginner.';
  const a = defaultOptimize(lean), p = optimizePrompt(lean);
  assert.deepEqual([a.text, a.applied.length, a.reason, a.saved], [lean, 0, 'already_lean', 0]);
  assert.deepEqual([p.text, p.outcome], [lean, 'already_lean']);
  const veryOnly = 'Explain machine learning in a very simple way for a beginner.';     // only an opt-in intensifier
  const b = defaultOptimize(veryOnly);
  assert.deepEqual([b.text, b.reason], [veryOnly, 'review_only']); assert.equal(optimizePrompt(veryOnly).outcome, 'review_only');
  const rv = analyze(veryOnly), all = optimize(veryOnly, rv.findings, new Set(rv.findings.map((f) => f.id)));
  assert.equal(all.text, 'Explain machine learning in a simple way for a beginner.');      // the person can still opt in
  const r = analyze(ML), none = optimize(ML, r.findings, new Set());
  assert.deepEqual([none.text, none.reason], [ML, 'nothing_selected']);
  const crafted = [{ id: 0, start: 0, end: 5, original: 'Never', replacement: '', safe: true, recommended: true, advisory: false, kind: 'tone' }];
  assert.equal(optimize('Never share keys. Always use JSON.', crafted, new Set([0])).reason, 'all_skipped');
  assert.equal(optimize('Explain it.', [{ id: 0, start: 0, end: 7, original: 'Explain', replacement: 'Explain in great detail', safe: false, advisory: false, kind: 'tone' }], new Set([0])).applied.length, 0); // never adds tokens
});

test('no over-merging: negated, limited, conflicting and differently-scoped sentences are kept', () => {
  const keep = [
    'Avoid jargon in titles. Avoid jargon.', 'Use 3 examples. Use 5 examples.', 'Explain recursion to a beginner. Explain recursion to an expert.',
    'Do not include examples. Include examples of recursion.', 'Keep it short. Keep it short only in titles.', 'Never share keys with anyone. Share keys only with admins.',
    'Thanks, now summarize the article in plain English.', 'Thanks to the new data, keep 3 bullets.', 'Thank you for the report; summarize it in 5 bullets.',
    'Rules for A:\n- Keep the answer short and clear.\n\nRules for B:\n- Keep the answer short and clear.\n',
  ];
  for (const t of keep) assert.equal(defaultOptimize(t).text, t, JSON.stringify(t));
  const cross = analyze(keep[keep.length - 1]).findings.find((f) => f.kind === 'repetition');
  assert.ok(cross && !cross.recommended && !cross.safe && /another section/.test(cross.message));   // offered, never pre-selected
});

test('merges what is genuinely redundant, in either order', () => {
  const cases = [
    ['Write 3 bullet points. Write 3 bullet points about cats.', 'Write 3 bullet points about cats.'],
    ['Explain how recursion works. Explain how recursion works to a beginner using a simple example.', 'Explain how recursion works to a beginner using a simple example.'],
    ['Return JSON only. Use two-space indentation. Return JSON only.', 'Return JSON only. Use two-space indentation.'],
    ['Describe how a decision tree works for a beginner. Describe how a decision tree works for a beginner, with one example.', 'Describe how a decision tree works for a beginner, with one example.'],
  ];
  for (const [from, to] of cases) assert.equal(optimizePrompt(from).text, to, from);
  assert.equal(optimizePrompt('Please explain recursion. Explain recursion.').text, 'Explain recursion.');   // needs a second pass: padding first, then the repeat
  const tiny = 'Explain recursion. Explain recursion to a beginner using a simple example.';          // under three content words: too little evidence, never auto-merged
  assert.equal(optimizePrompt(tiny).text, tiny);
});

test('seams: edits never corrupt neighbouring text, capitalisation and line endings are right', () => {
  const cases = [
    ['Summarize this.   Thank you so much in advance!\n', 'Summarize this.\n'],              // used to lose the newline and keep a space (index shift)
    ['Thank you!\n\nExplain recursion simply.\n', 'Explain recursion simply.\n'],
    ['Explain recursion simply.\r\n\r\nThanks so much!\r\n', 'Explain recursion simply.\r\n'],
    ['Please make sure to explain recursion.', 'Explain recursion.'],
    ['I am new, so please explain recursion.', 'I am new, so explain recursion.'],
    ['Be concise. Please note that you must cite sources.', 'Be concise. You must cite sources.'],
    ['Explain it.\n\n\n\nGive an example.', 'Explain it.\n\nGive an example.'],
  ];
  for (const [from, to] of cases) assert.equal(optimizePrompt(from).text, to, JSON.stringify(from));
});

test('thank-you handling only removes a sentence that is nothing but thanks', () => {
  for (const s of ['Thanks!', 'Thank you.', 'Thank you so much in advance!', 'Thanks a lot for your help.', 'Thank you very much for your time.'])
    assert.equal(optimizePrompt(`Explain overfitting simply for a beginner. ${s}`).text, 'Explain overfitting simply for a beginner.', s);
  for (const s of ['Thanks, now explain it.', 'Thank you; keep it under 50 words.', 'Thanks to this, list 3 steps.'])
    assert.ok(optimizePrompt(s).text.length >= s.length - 1 || /50|3 steps|explain/i.test(optimizePrompt(s).text), s);
});

test('code, quoted text and templates are never touched, even when they repeat', () => {
  const t = 'Explain this code.\n```\nplease  really\n\n\n\nKeep it short. Keep it short.\n```\nSay "Please keep it short." and "Please keep it short." exactly.\nUse {{topic}} and <please> as given. Please keep it under 50 words. Please keep it under 50 words.';
  const o = optimizePrompt(t);
  assert.ok(o.text.includes('```\nplease  really\n\n\n\nKeep it short. Keep it short.\n```'));
  assert.ok(o.text.includes('"Please keep it short." and "Please keep it short."') && o.text.includes('{{topic}}') && o.text.includes('<please>'));
  assert.equal(count(o.text, /under 50 words/g), 1);
  assert.deepEqual(lostRequirements(t, o.text), []);
});

test('properties over varied prompts: never longer, requirements kept, idempotent, even if everything is selected', () => {
  const prompts = [ML, VARIANT, '', '   \n', 'Hi', 'Fix this:\n```\nx  =  1\n```', 'Return JSON only.\r\n\r\n\r\nReturn JSON only.\r\n',
    'Please please please explain it. Please explain it. Explain it.', 'Keep it under 50 words. Keep it under 80 words.', '日本語の文章を要約してください。日本語の文章を要約してください。',
    'Summarize the attached report in five bullet points for executives.', 'Do not share api_key or https://x.io/very/long. Never.'];
  for (const t of prompts) {
    const r = analyze(t), picks = [recommendedIds(r.findings), new Set(r.findings.map((f) => f.id))];
    for (const ids of picks) {
      const o = optimize(t, r.findings, ids);
      assert.ok(o.after <= o.before && o.chars.after <= o.chars.before, JSON.stringify(t));
      assert.deepEqual(lostRequirements(t, o.text), [], JSON.stringify(t));
      assert.equal(o.verification.preserved, true);
    }
    const p = optimizePrompt(t);
    assert.equal(optimizePrompt(p.text).text, p.text, `not idempotent: ${JSON.stringify(t)}`);
    for (const item of requirementItems(t)) assert.ok(requirementItems(p.text).has(item), `${item} lost in ${JSON.stringify(t)}`);
  }
});
