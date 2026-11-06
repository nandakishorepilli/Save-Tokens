// Regression tests for semantic repetition: the same idea said in different words ("I am a beginner",
// "easy for beginners to understand", "beginner-friendly and easy to follow"). Everything runs offline.
// Policy under test: detect restated STYLE wording only; never touch topics, examples, numbers, formats or distinct instructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, optimize, optimizePrompt, recommendedIds, lostRequirements, requirementItems, estimateTokens, styleInfo, conceptsIn, KINDS } from '../public/core.js';

// The AI beginner prompt: the three phrasings from the bug report, plus real constraints that must survive.
const AI = `I am a beginner. I want to learn about artificial intelligence.

Please explain artificial intelligence to me in a way that is easy for beginners to understand. Make it beginner-friendly and easy to follow.

Explain what AI is and how it works. Use simple language and give me 3 real-world examples of AI in everyday life. Please avoid technical jargon.

Keep the answer under 250 words. Make sure the explanation is simple and clear for a total newcomer.
`;
const GOLDEN_DEFAULT = `I am a beginner. I want to learn about artificial intelligence.

Explain artificial intelligence to me in a way that is easy for beginners to understand.

Explain what AI is and how it works. Use simple language and give me 3 real-world examples of AI in everyday life. Avoid technical jargon.

Keep the answer under 250 words.
`;
const GOLDEN_ALL = `I want to learn about artificial intelligence.

Explain artificial intelligence to me in a way that is easy for beginners to understand.

Explain what AI is and how it works. Use simple language and give me 3 real-world examples of AI in everyday life. Avoid technical jargon.

Keep the answer under 250 words.
`;
const PRESERVE = [/artificial intelligence/i, /\bAI\b/, /how it works/i, /use simple language/i, /give me 3 real-world examples of AI in everyday life/i, /avoid technical jargon/i, /under 250 words/i, /easy for beginners to understand/i];

const sem = (t) => analyze(t).findings.filter((f) => f.semantic);
const def = (t) => { const r = analyze(t); return optimize(t, r.findings, recommendedIds(r.findings)); };
const withIds = (t, pick) => { const r = analyze(t); return optimize(t, r.findings, new Set(r.findings.filter(pick).map((f) => f.id))); };
const allEdits = (t) => withIds(t, (f) => !f.advisory);

test('the three phrasings are detected as repetition and offered as selectable suggestions', () => {
  const found = sem(AI), by = (s) => found.find((f) => f.original === s);
  assert.deepEqual(found.map((f) => f.original), ['I am a beginner.', 'Make it beginner-friendly and easy to follow.', 'Make sure the explanation is simple and clear for a total newcomer.']);
  for (const f of found) {                               // real, selectable edits in the existing suggestion list: no new UI kind
    assert.deepEqual([f.kind, f.advisory, f.replacement, f.protected, f.semantic], ['repetition', false, '', false, true]);
    assert.ok(Number.isInteger(f.id) && f.saved > 0 && f.concepts.length > 0 && f.message.length > 20);
    assert.match(f.message, /easy for beginners to understand/);               // says WHAT it repeats
  }
  assert.deepEqual(Object.keys(KINDS), ['wordiness', 'tone', 'repetition', 'whitespace', 'vague']);
  // paraphrases of the same idea are pre-selected; a sentence about the writer is offered but left to the person
  assert.deepEqual([by('Make it beginner-friendly and easy to follow.').recommended, by('Make sure the explanation is simple and clear for a total newcomer.').recommended], [true, true]);
  assert.equal(by('I am a beginner.').recommended, false);
  assert.match(by('I am a beginner.').message, /about you/);
});

test('by default only the pre-selected suggestions are applied; the opt-in one is applied when ticked', () => {
  const d = def(AI);
  assert.equal(d.text, GOLDEN_DEFAULT); assert.equal(d.reason, 'optimized');
  assert.ok(d.text.includes('I am a beginner.'));
  const a = allEdits(AI);
  assert.equal(a.text, GOLDEN_ALL); assert.ok(!a.text.includes('I am a beginner'));
  assert.ok(a.saved > d.saved && d.saved / d.before >= 0.2, `${d.saved}/${d.before}`);
  assert.deepEqual(a.skipped, []);
});

test('distinct instructions, topics, examples, numbers and output requirements all survive, even with everything ticked', () => {
  for (const out of [def(AI).text, allEdits(AI).text, optimizePrompt(AI).text]) {
    for (const re of PRESERVE) assert.match(out, re, String(re));
    assert.deepEqual(lostRequirements(AI, out), []);
  }
  // "Use simple language" overlaps the concept "simple" but is an instruction about vocabulary: never offered for removal
  assert.ok(analyze(AI).findings.every((f) => !/Use simple language/.test(f.original) && !/real-world examples/.test(f.original) && !/250/.test(f.original)));
});

test('a restated style clause inside a topical sentence is cut off in either order, leaving the topic intact', () => {
  assert.equal(def('Make it beginner-friendly and easy to follow. Please explain artificial intelligence to me in a way that is easy for beginners to understand.').text,
    'Make it beginner-friendly and easy to follow. Explain artificial intelligence to me.');
  const f = sem('Give 3 examples for beginners. Make it beginner-friendly.');
  assert.deepEqual([f.length, f[0].original, f[0].recommended], [1, ' for beginners', false]);
  assert.equal(withIds('Give 3 examples for beginners. Make it beginner-friendly.', (x) => x.semantic).text, 'Give 3 examples. Make it beginner-friendly.');
});

test('equal ideas are merged by default, partial overlaps are opt-in, and only the overlapping sentence goes', () => {
  assert.equal(def('Keep it short. Keep it concise.').text, 'Keep it short.');
  const t = 'Make it beginner-friendly. Give 3 examples. Make it easy to follow.';
  assert.equal(def(t).text, t);                                              // subset only: offered, never pre-selected
  assert.deepEqual(sem(t).map((f) => [f.original, f.recommended]), [['Make it easy to follow.', false]]);
  assert.equal(withIds(t, (f) => f.semantic).text, 'Make it beginner-friendly. Give 3 examples.');
});

test('related-looking but distinct instructions are never merged or flagged', () => {
  const keep = [
    'Explain AI simply. Explain AI to beginners.',                                   // different instructions: no style-only sentence
    'I am a beginner. Write for advanced readers.',                                  // different audience
    'Keep it short. Keep it detailed.',                                              // opposite length ideas
    'Give 3 examples for beginners. Give 3 examples for experts.',                   // different audience, same count
    'Keep it simple. Write simply in 3 bullet points.',                              // number and output format
    'Keep it simple. Do not make it too simple.',                                    // negation
    'Make it easy to follow if the reader is a beginner. Make it beginner-friendly.',// condition
    'Make it beginner-friendly. For example, explain gradient descent with a hill analogy.', // an example
    'Use simple language such as cat and dog. Make it beginner-friendly and easy to follow.', // concrete words
    'Audience:\nMake it beginner-friendly.\n\nStyle:\nMake it beginner-friendly and easy to follow.\n', // different sections
    'I am a beginner.',                                                              // the only statement of the idea
    'Explain how neural networks learn in simple terms for a 5-year-old. Make it easy to follow.',    // a number
    'Make it beginner-friendly. Return the answer as JSON.', 'Make it beginner-friendly. Cover topics: backpropagation, gradients.',
  ];
  for (const t of keep) { assert.deepEqual(sem(t), [], JSON.stringify(t)); assert.equal(def(t).text, t, JSON.stringify(t)); }
});

test('what counts as style-only: nothing but style wording', () => {
  const yes = ['I am a beginner.', "I'm new to this.", 'Make it beginner-friendly and easy to follow.', 'Keep it short.', 'Make sure the explanation is simple and clear for a total newcomer.', 'Write in plain English.'];
  const no = ['Explain AI simply.', 'Keep it short, under 200 words.', 'Not too simple.', 'Use simple language such as "cat".', 'Make it simple if possible.', 'Give 3 beginner examples.', 'Write simply in bullet points.', 'Return JSON.', ''];
  for (const s of yes) assert.equal(styleInfo(s).styleOnly, true, s);
  for (const s of no) assert.equal(styleInfo(s).styleOnly, false, s);
  assert.deepEqual([...styleInfo('Make it beginner-friendly and easy to follow.').concepts].sort(), ['beginner', 'simple']);
  assert.deepEqual([...conceptsIn('Keep it short and make it easy for newcomers.')].sort(), ['beginner', 'brief', 'simple']);
  assert.equal(conceptsIn('Explain recursion.').size, 0);
});

test('every suggested span is verified style-only: it never contains a topic, number, example or format', () => {
  const prompts = [AI, 'Make it beginner-friendly. Give 3 examples. Make it easy to follow.', 'Give 3 examples for beginners. Make it beginner-friendly.', 'Keep it short. Keep it concise.'];
  for (const t of prompts) for (const f of sem(t)) {
    const s = styleInfo(f.original);
    assert.deepEqual([s.styleOnly, s.other], [true, []], f.original);
    assert.equal(requirementItems(f.original).size, 0, f.original);
    assert.ok(!/\d/.test(f.original));
  }
});

test('safety net: a stale or forged suggestion on non-style text is refused', () => {
  const t = 'Explain gradient descent with 3 examples. Make it beginner-friendly.';
  const forged = [{ id: 0, start: 0, end: 40, original: t.slice(0, 40), replacement: '', safe: false, recommended: true, advisory: false, kind: 'repetition', semantic: true, concepts: ['simple'] }];
  const o = optimize(t, forged, new Set([0]));
  assert.deepEqual([o.text, o.applied.length], [t, 0]); assert.match(o.skipped[0].reason, /Not purely style/);
});

test('safety net: the last statement of an idea can never be removed, even if every suggestion is ticked', () => {
  // two suggestions that each rely on the other: applying both would erase "beginner" and "simple" completely
  const t = 'Make it beginner-friendly. Give 3 examples. Make it easy for beginners.';
  const mk = (id, original) => ({ id, start: t.indexOf(original), end: t.indexOf(original) + original.length, original, replacement: '', safe: false, recommended: true, advisory: false, kind: 'repetition', semantic: true, concepts: ['beginner', 'simple'] });
  const o = optimize(t, [mk(0, 'Make it beginner-friendly.'), mk(1, 'Make it easy for beginners.')], new Set([0, 1]));
  assert.ok(/beginner/i.test(o.text) && /3 examples/.test(o.text), o.text);
  assert.equal(o.applied.length, 0); assert.ok(o.skipped.every((s) => /only statement of/.test(s.reason)) && o.skipped.length === 2);
  assert.deepEqual(lostRequirements(t, o.text), []);
});

test('reported savings are accurate, results are stable, and nothing is lost on repeat runs', () => {
  const r = analyze(AI), ids = recommendedIds(r.findings), o = optimize(AI, r.findings, ids);
  assert.deepEqual([o.before, o.after, o.saved, o.kind], [estimateTokens(AI), estimateTokens(o.text), estimateTokens(AI) - estimateTokens(o.text), 'estimated']);
  const sum = r.findings.filter((f) => ids.has(f.id)).reduce((s, f) => s + f.saved, 0);
  assert.ok(Math.abs(sum - o.saved) <= 2, `${sum} vs ${o.saved}`);
  const p = optimizePrompt(AI), again = optimizePrompt(p.text);
  assert.deepEqual([p.text, p.passes, again.text, again.passes, again.saved], [GOLDEN_DEFAULT, 1, GOLDEN_DEFAULT, 0, 0]);
  const words = { name: 'words', count: (t) => (t.match(/\S+/g) || []).length }, m = optimizePrompt(AI, { counter: words });
  assert.deepEqual([m.kind, m.before - m.after], ['measured', m.saved]);
  assert.ok(analyze(AI).score < analyze(GOLDEN_DEFAULT).score);                // the repetition shows up in the score, and fixing it raises it
});

test('the earlier machine-learning fixtures are unaffected (no new false positives)', () => {
  const ml = 'I am a complete beginner and I know nothing about it, so please explain it in a very simple way.\n\nExplain what machine learning is in simple words that a beginner can understand.\n';
  assert.deepEqual(sem(ml), []);
  assert.deepEqual(sem('Hi! Could you please help me understand machine learning? I\'m new to this and a total beginner.\n\nExplain machine learning in simple terms so that I can follow it.'), []);
});

test('properties: suggestions are sorted, never overlap, and applying all of them keeps every requirement and style idea', () => {
  const prompts = [AI, 'Keep it short. Keep it concise. Keep it brief.', 'Make it beginner-friendly. Give 3 examples. Make it easy to follow. Make it simple for newcomers.',
    'Please explain X in simple terms. Make it easy to understand for beginners. Return JSON.', 'Be concise. Be succinct. Write 3 bullet points.', 'I am a novice. I am a beginner. Make it simple.'];
  for (const t of prompts) {
    const r = analyze(t);
    r.findings.forEach((f, i) => { assert.equal(f.id, i); if (i) assert.ok(r.findings[i - 1].end <= f.start); });
    const o = allEdits(t);
    assert.deepEqual(lostRequirements(t, o.text), [], JSON.stringify(t));
    for (const c of conceptsIn(t)) assert.ok(conceptsIn(o.text).has(c), `${c} vanished from ${JSON.stringify(t)}`);
    assert.ok(o.after <= o.before);
    assert.equal(optimizePrompt(o.text).text, optimizePrompt(optimizePrompt(o.text).text).text);
  }
});
