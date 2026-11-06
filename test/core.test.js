import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, analyze, optimize } from '../public/core.js';

const ids = (r, safeOnly = false) => new Set(r.findings.filter((f) => !safeOnly || f.safe).map((f) => f.id));

test('estimator: empty is 0, longer text costs more', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world, again') > estimateTokens('hello world'));
});

test('flags wordy phrases and measures real savings', () => {
  const t = 'Please note that I want you to summarize this in order to save time.';
  const r = analyze(t);
  assert.ok(r.findings.some((f) => f.original.toLowerCase() === 'in order to'));
  const o = optimize(t, r.findings, ids(r));
  assert.ok(o.saved > 0 && o.after < o.before);
  assert.match(o.text, /^Summarize this to save time\.$/);
});

test('safe-only mode leaves tone words alone', () => {
  const t = 'Please summarize this report in order to save time for the team.';
  const r = analyze(t);
  const o = optimize(t, r.findings, ids(r, true));
  assert.ok(o.text.startsWith('Please summarize'));
  assert.ok(!o.text.includes('in order to'));
});

test('never edits fenced or inline code', () => {
  const t = 'Fix this:\n```\nplease really  basically\n\n\n\nx\n```\nand `very` carefully.';
  const r = analyze(t);
  assert.equal(r.findings.length, 0);
  assert.equal(optimize(t, r.findings, ids(r)).text, t);
});

test('detects exact duplicate sentences', () => {
  const t = 'Return valid JSON only. Use two-space indentation. Return valid JSON only.';
  const r = analyze(t);
  assert.equal(r.findings.filter((f) => f.kind === 'repetition').length, 1);
  assert.equal(optimize(t, r.findings, ids(r)).text, 'Return valid JSON only. Use two-space indentation.');
});

test('collapses whitespace waste', () => {
  const t = 'One.\n\n\n\nTwo  words.   \n';
  const r = analyze(t);
  assert.equal(optimize(t, r.findings, ids(r)).text, 'One.\n\nTwo words.\n');
});

test('score: short text unscored, clean text 100, padded text lower', () => {
  assert.equal(analyze('Hi').score, null);
  assert.equal(analyze('Summarize the attached report in five bullet points for executives.').score, 100);
  assert.ok(analyze('I would like you to please basically summarize this in order to save time. Thank you in advance.').score < 60);
});

test('removes a whole thank-you sentence, not a fragment', () => {
  const t = 'Summarize the report in five bullets.\n\nThank you in advance for your help.';
  const r = analyze(t);
  assert.equal(optimize(t, r.findings, ids(r)).text, 'Summarize the report in five bullets.'); // no dangling blank lines either
});

// ------------------------------------------------------------------ engine v2
import { estimateRange, measure, countTokens, requirementItems, ENGINE } from '../public/core.js';

const EXAMPLE = `I would like you to please summarize the attached customer feedback in order to help our team understand the main themes. It is important to note that the summary should be very concise.

Return the summary as five bullet points.   Group related comments together.


Please note that you should not invent quotes. Return the summary as five bullet points.

Thank you in advance for your help.`;
const SAMPLES = [EXAMPLE, 'Fix this:\n```\nx  =  1\n```', 'Return JSON only. Never include keys. Return JSON only.', 'Keep it under 50 words. Keep it under 80 words.',
  'Say "please" and "very" exactly. Please note that you must not use `etc.` anywhere.\r\n\r\n\r\n\r\nDone  here.  \r\n', '', '   \n\n  ', '日本語の文章を要約してください。', 'Do not share api_key or https://x.io/very/long. Never.'];

test('estimator v2: edge cases do not throw and scale sensibly', () => {
  for (const v of ['', null, undefined]) assert.equal(estimateTokens(v), 0);
  assert.ok(estimateTokens('   \n\n\n') <= 3); // whitespace is not free, but it is small
  assert.ok(estimateTokens('日本語の文章') >= 6);
  assert.ok(estimateTokens('🚀🚀') >= 4);
  assert.ok(estimateTokens('getUserAccountBalanceHistory') > estimateTokens('getuser'));
  assert.ok(estimateTokens('internationalization') > estimateTokens('cat'));
  assert.ok(estimateTokens('https://example.com/a/long/path?x=1') > 5);
  assert.ok(estimateTokens('don\'t') >= 2);
  assert.ok(estimateTokens('a\n\n\n\n\nb') > estimateTokens('a\nb'));
});

test('estimates are labelled as estimates; margins widen for other scripts', () => {
  const e = estimateRange('Summarize the attached report in five bullet points for executives.');
  assert.equal(e.kind, 'estimated'); assert.equal(e.exact, false); assert.equal(e.method, 'heuristic-v2');
  assert.ok(e.low <= e.estimate && e.estimate <= e.high);
  const j = estimateRange('日本語の文章を要約してください日本語の文章を要約してください');
  assert.ok(j.high / j.estimate > e.high / e.estimate);
});

test('measure(): exact facts about the text, counted in code points and bytes', () => {
  const m = measure('héllo 🚀\r\nline two');
  assert.equal(m.kind, 'measured'); assert.equal(m.lines, 2); assert.equal(m.words, 4);
  assert.equal(m.chars, [...'héllo 🚀\r\nline two'].length);
  assert.ok(m.bytes > m.chars);
  assert.deepEqual(measure(''), { chars: 0, bytes: 0, words: 0, lines: 0, kind: 'measured' });
});

test('countTokens: only a real counter makes a count "measured"; failures fall back to estimated', () => {
  assert.equal(countTokens('hello there').kind, 'estimated');
  const ok = countTokens('hello there', { name: 'mock', count: () => 7 });
  assert.deepEqual([ok.kind, ok.count, ok.exact, ok.method, ok.low, ok.high], ['measured', 7, true, 'mock', 7, 7]);
  for (const bad of [() => { throw new Error('x'); }, () => -1, () => 1.5, () => 'a']) {
    const r = countTokens('hello there', { name: 'bad', count: bad });
    assert.equal(r.kind, 'estimated'); assert.equal(r.counterFailed, true);
  }
});

test('analyze/optimize carry the counter label through; per-finding savings stay estimates', () => {
  const counter = { name: 'mock', count: (t) => t.length };
  const t = 'Please note that I want you to summarize this in order to save time.';
  const r = analyze(t, { counter });
  assert.equal(r.tokens.kind, 'measured'); assert.equal(r.tokens.count, t.length);
  const o = optimize(t, r.findings, new Set(r.findings.map((f) => f.id)), { counter });
  assert.equal(o.kind, 'measured'); assert.equal(o.before - o.after, o.saved); assert.equal(o.after, o.text.length);
  assert.equal(optimize(t, r.findings, new Set()).kind, 'estimated');
  assert.equal(o.chars.kind, 'measured'); assert.equal(o.chars.saved, t.length - o.text.length);
});

test('score is explainable: criteria penalties add up exactly to 100 - score', () => {
  for (const t of SAMPLES) {
    const r = analyze(t);
    if (r.score === null) { assert.equal(r.label, 'Too short to score'); continue; }
    assert.equal(100 - r.criteria.reduce((s, c) => s + c.penalty, 0), r.score);
    for (const c of r.criteria) { assert.ok(c.penalty >= 0 && c.penalty <= c.max); assert.ok(c.detail.length > 10); }
    assert.deepEqual(r.criteria.map((c) => c.id), ['wording', 'repetition', 'whitespace', 'clarity', 'context']);
  }
  assert.equal(analyze('Summarize the attached report in five bullet points for executives.').criteria.every((c) => c.penalty === 0), true);
  assert.ok(analyze(EXAMPLE).criteria.find((c) => c.id === 'wording').penalty <= 60);
});

test('vague instructions are advice only: flagged, free of token claims, never applied', () => {
  const t = 'Make it better and give me a few examples, tags, etc. Keep the answer short.';
  const r = analyze(t);
  const v = r.findings.filter((f) => f.kind === 'vague');
  assert.ok(v.length >= 3 && v.every((f) => f.advisory && f.saved === 0 && !f.safe));
  assert.ok(analyze(t).criteria.find((c) => c.id === 'clarity').penalty > 0);
  const o = optimize(t, r.findings, new Set(v.map((f) => f.id)));
  assert.equal(o.text, t); assert.equal(o.skipped.length, v.length);
  assert.equal(analyze('Write a summary. Keep it short, under 50 words.').findings.filter((f) => f.kind === 'vague').length, 0);
  assert.equal(analyze('Summarize this in 3 sentences, keep it brief.').findings.filter((f) => f.kind === 'vague').length, 0);
  assert.equal(analyze('Fix this:\nfoo()').findings.filter((f) => f.kind === 'vague').length, 0);
});

test('missing context: no task, dangling colon, placeholders; attachments and format are info only', () => {
  const ids_ = (t) => analyze(t).signals.map((s) => s.id);
  assert.ok(ids_('The quarterly numbers for the northern region were quite unremarkable overall').includes('no-task'));
  assert.ok(!ids_('What is the capital of the largest country in South America today').includes('no-task'));
  assert.ok(ids_('Translate the following paragraph into French:').includes('missing-content'));
  assert.ok(ids_('Write an email to [insert name] about the delay in shipping.').includes('placeholder'));
  const a = analyze('Summarize the attached report in five bullet points for executives.');
  assert.deepEqual(a.signals.map((s) => [s.id, s.penalty]), [['external-ref', 0]]);
  const n = analyze('Describe the main causes of the French revolution for a general reader.');
  assert.deepEqual(n.signals.map((s) => s.id), ['no-format']); assert.equal(n.score, 100);
  const bad = analyze('Translate the following paragraph into French:');
  assert.ok(bad.criteria.find((c) => c.id === 'context').penalty >= 8 && bad.score < 100);
});

test('repetition: conflicts and genuinely different overlaps stay advice; a sentence repeated with only filler words differs is now removed', () => {
  const c = analyze('Keep it under 50 words. Keep it under 80 words.');
  assert.ok(c.findings.some((f) => f.advisory && /conflict/.test(f.message)));
  // same sentence, only a stop word differs: a repeat, so it is a recommended edit (the first copy stays)
  const t = 'Summarize the customer feedback into themes for the product team. Summarize the customer feedback into the themes for product team.';
  const n = analyze(t);
  const rep = n.findings.filter((f) => f.kind === 'repetition' && !f.advisory);
  assert.equal(rep.length, 1); assert.ok(rep[0].recommended && !rep[0].safe);
  assert.equal(optimize(t, n.findings, new Set([rep[0].id])).text, 'Summarize the customer feedback into themes for the product team.');
  // similar wording but a different object ("product" vs "support"): never merged automatically
  const d = analyze('Summarize customer feedback into themes for the product team weekly. Summarize customer feedback into themes for the support team weekly.');
  assert.ok(d.findings.some((f) => f.advisory && /similar/.test(f.message)));
  assert.equal(d.findings.filter((f) => !f.advisory && f.kind === 'repetition').length, 0);
  const p = analyze('Check the output format of each answer. Then check the output format of each report. Also check the output format of each summary.');
  assert.ok(p.findings.some((f) => f.advisory && /appears 3 times/.test(f.message) && f.severity === 'info'));
  for (const r of [c, d, p]) assert.equal(optimize('x', r.findings, new Set(r.findings.map((f) => f.id))).applied.length, 0);
});

test('requirements are protected: edits in constraint sentences are never marked safe', () => {
  const r = analyze('It is important to note that you must never share the API keys.');
  const f = r.findings.find((x) => /important to note/i.test(x.original));
  assert.equal(f.safe, false); assert.match(f.message, /requirement/);
  const d = analyze('Never reveal the password. Never reveal the password.').findings.find((x) => x.kind === 'repetition');
  assert.equal(d.safe, false);
  assert.equal(analyze('Write a short poem about autumn leaves. Write a short poem about autumn leaves.').findings.find((x) => x.kind === 'repetition').safe, true);
});

test('quoted text, URLs, template variables and tags are never edited', () => {
  const t = 'Say "please" and "very really" exactly. Visit https://x.io/simply/please now. Use {{user_name}} and <please> as given.';
  const r = analyze(t);
  assert.deepEqual(r.findings.filter((f) => !f.advisory), []);
  assert.equal(optimize(t, r.findings, new Set(r.findings.map((f) => f.id))).text, t);
});

test('optimize refuses edits that would lose a requirement, and says so', () => {
  const t = 'Never share secrets. Always answer in JSON.';
  const crafted = [{ id: 0, start: 0, end: 5, original: 'Never', replacement: '', safe: true, advisory: false, kind: 'tone' }];
  const o = optimize(t, crafted, new Set([0]));
  assert.equal(o.text, t); assert.equal(o.applied.length, 0);
  assert.match(o.skipped[0].reason, /never/i); assert.equal(o.verification.preserved, true);
  // a "repetition" edit that is not really a duplicate is caught by the whole-text check
  const lie = [{ id: 0, start: 21, end: t.length, original: t.slice(21), replacement: '', safe: true, advisory: false, kind: 'repetition' }];
  const o2 = optimize(t, lie, new Set([0]));
  assert.equal(o2.text, t); assert.match(o2.skipped[0].reason, /json|always/i);
  // a genuine duplicate is fine because the first copy remains
  const d = 'Always answer in JSON. Always answer in JSON.';
  const r = analyze(d);
  assert.equal(optimize(d, r.findings, new Set(r.findings.map((f) => f.id))).text, 'Always answer in JSON.');
});

test('optimize ignores unknown ids, advice ids and stale findings', () => {
  const t = 'Please summarize this in order to save time.';
  const r = analyze(t);
  assert.equal(optimize(t, r.findings, new Set([99, -1])).text, t);
  const stale = optimize('Totally different prompt text here, in order to test.', r.findings, new Set(r.findings.map((f) => f.id)));
  assert.ok(stale.skipped.some((s) => /changed/.test(s.reason)));
  assert.equal(stale.text.includes('in order to'), true);
});

test('invariants on varied inputs: no crash, sorted non-overlapping spans, requirements survive, idempotent', () => {
  for (const t of SAMPLES) {
    const r = analyze(t);
    for (let i = 0; i < r.findings.length; i++) {
      const f = r.findings[i];
      assert.equal(f.id, i); assert.equal(t.slice(f.start, f.end), f.original);
      if (i) assert.ok(r.findings[i - 1].end <= f.start);
      if (f.advisory) assert.deepEqual([f.saved, f.safe, f.replacement], [0, false, '']);
    }
    for (const sel of [new Set(r.findings.map((f) => f.id)), new Set(r.findings.filter((f) => f.safe).map((f) => f.id))]) {
      const o = optimize(t, r.findings, sel);
      const have = requirementItems(o.text);
      for (const item of requirementItems(t)) assert.ok(have.has(item), `lost ${item} in ${JSON.stringify(t)}`);
      assert.ok(o.after <= o.before); assert.equal(o.verification.preserved, true);
    }
    const once = optimize(t, r.findings, new Set(r.findings.filter((f) => f.safe).map((f) => f.id))).text;
    assert.equal(analyze(once).findings.filter((f) => f.safe).length, 0, `not idempotent: ${JSON.stringify(t)}`);
  }
});

test('analysis is deterministic, does not mutate its input, and handles odd input', () => {
  assert.deepEqual(analyze(EXAMPLE), analyze(EXAMPLE));
  for (const v of ['', '   ', null, undefined, 42]) assert.equal(analyze(v).score, null);
  for (const v of ['', null, undefined]) assert.deepEqual(analyze(v).findings, []);
  assert.equal(optimize('   ', analyze('   ').findings, new Set([0])).text, '');
  assert.equal(analyze('x'.repeat(50000)).findings.length, 0);
  assert.equal(analyze('Return JSON.\n```\nunterminated please really').findings.length, 0);
  assert.equal(ENGINE.offline, true);
});

test('CRLF text keeps its line endings when whitespace is cleaned', () => {
  const t = 'One.\r\n\r\n\r\n\r\nTwo  words.   \r\nThree.';
  const r = analyze(t);
  assert.equal(optimize(t, r.findings, new Set(r.findings.map((f) => f.id))).text, 'One.\r\n\r\nTwo words.\r\nThree.');
});

test('non-English prompts get an honest limitation note instead of false confidence', () => {
  const r = analyze('日本語の文章を要約してください。日本語の文章を要約してください。');
  assert.ok(r.notes.some((n) => /English-only/.test(n)));
  assert.ok(!analyze('Summarize this report in five bullet points.').notes.some((n) => /English-only/.test(n)));
});
