// Save Tokens core (engine v2): framework-free, offline, deterministic. Runs in the browser and in Node.
// Nothing here calls an API. Numbers are labelled as "measured" (exact facts about the text, or a counter
// you plug in) or "estimated" (heuristic). Findings are rule-based; they say nothing about answer quality.

export const ENGINE = { version: '2.0.0', offline: true, language: 'en' };
export const ESTIMATOR = { name: 'heuristic-v2', exact: false };

// ---------------------------------------------------------------- tokens
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_ONE = new RegExp(`^[${CJK}]$`, 'u');
const LATIN = /^\p{Script=Latin}/u;
const TOKEN_RE = new RegExp(
  `https?:\\/\\/\\S+|[${CJK}]|\\p{Extended_Pictographic}|(?:(?![${CJK}])[\\p{L}\\p{M}])+(?:['’]\\p{L}+)?|\\p{N}+|(?:[ \\t]*\\r?\\n)+|[ \\t]{2,}|[^\\s\\p{L}\\p{N}]+`, 'gu');

function wordCost(t) {
  const [base, suffix] = t.split(/['’]/);
  if (!LATIN.test(base)) return Math.ceil(t.length / 2.5);
  return base.split(/(?<=[a-z])(?=[A-Z])/).reduce((s, p) => s + (p.length <= 6 ? 1 : 1 + Math.ceil((p.length - 6) / 3.5)), 0) + (suffix ? 1 : 0);
}

/** Heuristic estimate (number). Rules approximate common BPE behaviour; it is NOT benchmarked against a real tokenizer. */
export function estimateTokens(text) {
  let n = 0;
  for (const [t] of String(text ?? '').matchAll(TOKEN_RE)) {
    if (/^https?:/.test(t)) n += Math.ceil(t.length / 3.2);
    else if (/^\p{Extended_Pictographic}$/u.test(t)) n += 2;
    else if (CJK_ONE.test(t)) n += 1;
    else if (/^\p{L}/u.test(t)) n += wordCost(t);
    else if (/^\p{N}/u.test(t)) n += Math.ceil(t.length / 3);
    else if (t.includes('\n')) n += Math.ceil((t.match(/\n/g) || []).length / 2);
    else if (/^[ \t]+$/.test(t)) n += 1;
    else n += Math.ceil(t.length / 2);
  }
  return n;
}

function marginFor(text) {
  const letters = text.match(/\p{L}/gu) || [];
  const nonLatin = letters.filter((c) => !LATIN.test(c)).length;
  const symbolShare = (text.match(/[^\s\p{L}]/gu) || []).length / Math.max(1, text.length);
  if (letters.length && nonLatin / letters.length > 0.2) return [0.7, 1.5]; // other scripts: least reliable
  if (symbolShare > 0.35) return [0.75, 1.4];                                // code / data heavy
  return [0.85, 1.2];
}

/** Estimated count with an assumed (not validated) margin. kind says what the number is. */
export function estimateRange(text) {
  text = String(text ?? '');
  const n = estimateTokens(text), [lo, hi] = marginFor(text);
  return { count: n, estimate: n, low: Math.round(n * lo), high: Math.round(n * hi), kind: 'estimated', method: ESTIMATOR.name, exact: false };
}

/** Exact facts about the text itself. These are measured, not estimated. */
export function measure(text) {
  text = String(text ?? '');
  return { chars: [...text].length, bytes: new TextEncoder().encode(text).length, words: (text.match(/\S+/g) || []).length,
    lines: text ? text.split(/\r?\n/).length : 0, kind: 'measured' };
}

/** Token count. With `counter` ({name, count(text)}) the result is MEASURED when count() returns an integer; it returns
 *  null/undefined when it has no measurement for this text (the result is then an ESTIMATE, not an error). A throw or
 *  an invalid value is a failure (ESTIMATE, flagged). Optional counter.provider/model/caveat are passed through. */
export function countTokens(text, counter) {
  text = String(text ?? '');
  if (counter && typeof counter.count === 'function') {
    let c;
    try { c = counter.count(text); } catch { return { ...estimateRange(text), counterFailed: true }; }
    if (c === null || c === undefined) return estimateRange(text);
    if (Number.isInteger(c) && c >= 0)
      return { count: c, estimate: c, low: c, high: c, kind: 'measured', method: counter.name || 'custom counter', exact: counter.exact !== false,
        ...(counter.provider && { provider: counter.provider }), ...(counter.model && { model: counter.model }), ...(counter.caveat && { caveat: counter.caveat }) };
    return { ...estimateRange(text), counterFailed: true };
  }
  return estimateRange(text);
}

// ---------------------------------------------------------------- requirements (what must survive optimisation)
const REQ = [
  ['w', /\b(?:must not|must|never|always|only|do not|don't|dont|should not|shouldn't|cannot|can't|required|mandatory|exactly|at least|at most|no more than|no fewer than|no less than|maximum|minimum|limit|avoid|without|ensure|forbidden|prohibited|unless|except|not|no)\b/gi],
  ['n', /\d+(?:[.,]\d+)*%?/g],
  ['nw', /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/gi],
  ['f', /\b(?:json|xml|yaml|csv|markdown|html|sql|table|bullet points?|bullets?)\b/gi],
  ['q', /["“][^"”\n]{1,200}["”]/g],
  ['u', /https?:\/\/\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b/g],
  ['i', /\b[A-Za-z]+(?:[_.][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z]\w*\b/g],
];
/** Items that carry a requirement or constraint: negations, limits, numbers, formats, quoted text, names. */
export function requirementItems(text) {
  const out = new Set();
  for (const [tag, re] of REQ) for (const m of String(text ?? '').matchAll(re)) out.add(`${tag}:${m[0].toLowerCase().replace(/\s+/g, ' ')}`);
  return out;
}
/** Requirement markers present in `original` but missing from `candidate` (empty array = nothing lost). */
export function lostRequirements(original, candidate) {
  const have = requirementItems(String(candidate ?? ''));
  return [...requirementItems(original)].filter((i) => !have.has(i)).map((i) => i.slice(i.indexOf(':') + 1));
}
const fmtItems = (items) => items.map((i) => i.slice(i.indexOf(':') + 1)).join(', ');
const missing = (need, text) => { const have = requirementItems(text); return [...need].filter((i) => !have.has(i)); };

// ---------------------------------------------------------------- rules
// [phrase, replacement, safe, kind, why]. "safe" = meaning-preserving swap; others need a human look.
const PHRASES = [
  ['in order to', 'to', true, 'wordiness', 'Shorter with the same meaning'],
  ['due to the fact that', 'because', true, 'wordiness', 'Shorter with the same meaning'],
  ['at this point in time', 'now', true, 'wordiness', 'Shorter with the same meaning'],
  ['in the event that', 'if', true, 'wordiness', 'Shorter with the same meaning'],
  ['for the purpose of', 'for', true, 'wordiness', 'Shorter with the same meaning'],
  ['it is important to note that', '', true, 'wordiness', 'Preamble that adds no instruction'],
  ['it should be noted that', '', true, 'wordiness', 'Preamble that adds no instruction'],
  ['please note that', '', true, 'wordiness', 'Preamble that adds no instruction'],
  ['i would like you to', '', false, 'tone', 'Models follow direct instructions just as well'],
  ['i want you to', '', false, 'tone', 'Models follow direct instructions just as well'],
  ['i need you to', '', false, 'tone', 'Models follow direct instructions just as well'],
  ['can you please', '', false, 'tone', 'Direct instruction is shorter'],
  ['could you please', '', false, 'tone', 'Direct instruction is shorter'],
  ['would you please', '', false, 'tone', 'Direct instruction is shorter'],
  ['please', '', false, 'tone', 'Courtesy word; removing it may change tone'],
  ['kindly', '', false, 'tone', 'Courtesy word; removing it may change tone'],
  ['very', '', false, 'tone', 'Intensifier; check it is not carrying meaning'],
  ['really', '', false, 'tone', 'Intensifier; check it is not carrying meaning'],
  ['basically', '', false, 'tone', 'Filler word'],
  ['actually', '', false, 'tone', 'Filler word'],
  ['simply', '', false, 'tone', 'Filler word'],
];
const VAGUE = [
  [/\bmake (?:it|this|that|them) (?:better|good|nicer|great|cooler|more professional)\b/gi, 'Say what "better" means: the criteria or the specific change'],
  [/\b(?:(?:improve|enhance|polish|clean up) (?:it|this|that|them)\b(?!\s*:)|(?:improve|enhance|polish|clean up|fix) (?:everything|things)\b)/gi, 'Name what to change and how success is judged'],
  [/\b(?:etc\.?|and so on|and stuff|and things like that|or something|or whatever|somehow)(?!\w)/gi, 'Open-ended: name the items, or say "only these"'],
  [/\b(?:a few|several|a couple of|a bunch of|some|many)\s+(?:more\s+)?(?:examples?|items?|ideas?|options?|points?|suggestions?|bullets?|sentences?|paragraphs?)\b/gi, 'Give an exact number'],
  [/\b(?:as appropriate|appropriately|properly|as needed|good enough|high[- ]quality|the best (?:way|possible))\b/gi, 'Define what counts as appropriate or good here'],
];
const LENGTH_WORDS = /\b(?:concise|brief(?:ly)?|short|detailed|thorough|comprehensive|long)\b/gi;
const LENGTH_LIMIT = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred)\s+(?:words?|sentences?|bullets?|bullet points?|paragraphs?|lines?|items?|characters?|steps?|examples?)\b|\b(?:under|within|max(?:imum)?|at most|up to|no more than)\s+\d+/i;
const TASK = /\b(?:summari[sz]e|write|explain|list|translate|classify|extract|generate|create|draft|review|analy[sz]e|compare|rewrite|fix|convert|describe|answer|identify|find|suggest|give|provide|return|calculate|tell|show|make|build|design|plan|outline|edit|proofread|critique|evaluate|rank|sort|categori[sz]e|brainstorm|decide|recommend|reply|respond|output|produce|implement|refactor|debug|document|simplify|expand|shorten|paraphrase|solve|check|detect|determine|rate|score|label|tag|select|choose|pick|improve|optimi[sz]e|help|act|pretend|imagine)\b/i;
const QUESTION = /(?:^|[.!?]\s+)(?:what|why|how|who|when|where|which|is|are|can|could|do|does|did|should|would|will)\b/im;
const PLACEHOLDER = /\[(?:insert|your|enter|add|paste|todo|tbd|name|text)[^\]\n]*\]|\{\{[^}\n]+\}\}|<(?:insert|your)[^>\n]*>|\bTODO\b|\bTBD\b|\blorem ipsum\b/i;
const FORMAT = /\b(?:json|xml|yaml|csv|markdown|html|table|bullets?|bullet points?|list|paragraphs?|sentences?|words|steps|format|numbered|headings?|code block|one line|single line|essay|email|summary|outline)\b/i;
const STOP = new Set('a an the and or but of to in on at for with by from as is are was were be been it this that these those you your i we our they their its if then than so do does did not no can could should would will shall may might have has had'.split(' '));

export const KINDS = { wordiness: 'Wordiness', tone: 'Politeness & filler', repetition: 'Repetition', whitespace: 'Whitespace', vague: 'Vague instruction' };

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SENT_RE = /[^.!?\n]+[.!?]*/g;
const NUM_RE = /\d+(?:[.,]\d+)*/g;
const sentenceBounds = (t, i) => { let a = i, b = i; while (a > 0 && !'.!?\n'.includes(t[a - 1])) a--; while (b < t.length && !'.!?\n'.includes(t[b])) b++; return [a, Math.min(b + 1, t.length)]; };

/** Ranges the analyzer must never edit: code, quoted text, URLs, template variables, XML-style tags. */
function protectedRanges(text) {
  const out = [];
  const res = [/```[\s\S]*?(?:```|$)/g, /`[^`\n]+`/g, /["“][^"”\n]{1,200}["”]/g, /https?:\/\/\S+/g, /\{\{[^}\n]*\}\}|\{[A-Za-z_]\w*\}/g, /<\/?[A-Za-z][^<>\n]*>/g];
  for (const re of res) for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// ---------------------------------------------------------------- analysis
export function analyze(input, opts = {}) {
  const text = String(input ?? '');
  const masked = protectedRanges(text);
  const found = [];
  const add = (start, end, kind, message, replacement, safe, extra = {}) => {
    if (masked.some(([a, b]) => start < b && end > a)) return;
    const original = text.slice(start, end);
    let advisory = replacement === null, protectedEdit = false;
    if (!advisory && kind !== 'repetition') { // an edit may never drop a requirement
      const lost = missing(requirementItems(original), replacement);
      if (lost.length) { advisory = true; protectedEdit = true; message = `Protected: removing this would drop a requirement (${fmtItems(lost)})`; extra = { ...extra, severity: 'info' }; }
    }
    if (!advisory && safe && replacement === '' && kind === 'wordiness') { // emphasis in front of a requirement is not free to drop
      const [a, b] = sentenceBounds(text, start);
      if (requirementItems(text.slice(a, b)).size) { safe = false; message += '. This sentence states a requirement: confirm the emphasis is not needed'; }
    }
    found.push({ start, end, kind, message, original, replacement: advisory ? '' : replacement, safe: advisory ? false : safe, advisory,
      protected: protectedEdit, severity: advisory ? 'warn' : 'fix', ...extra,
      saved: advisory ? 0 : Math.max(0, estimateTokens(original) - estimateTokens(replacement)) });
  };

  for (const [p, r, safe, kind, why] of PHRASES)
    for (const m of text.matchAll(new RegExp(`\\b${esc(p)}\\b`, 'gi'))) add(m.index, m.index + m[0].length, kind, why, r, safe);
  for (const m of text.matchAll(/\bthank you(?: so much)? in advance(?: for your (?:help|assistance|time))?[.!]?/gi))
    add(m.index, m.index + m[0].length, 'tone', 'Closing courtesy the model does not need', '', false);

  // repetition: exact (removable), same-sentence-different-number (conflict), near-duplicate (advice)
  const seen = new Set(), sigs = new Map(), prior = [];
  for (const m of text.matchAll(SENT_RE)) {
    const lead = m[0].match(/^\s*/)[0].length;
    const key = m[0].slice(lead).toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.length < 15) continue;
    const start = m.index + lead, end = m.index + m[0].length;
    if (seen.has(key)) {
      const isReq = requirementItems(key).size > 0;
      add(start, end, 'repetition', isReq ? 'Repeats an earlier requirement exactly. Safe to drop if the earlier one still applies here' : 'Repeats an earlier sentence exactly', '', !isReq);
      continue;
    }
    seen.add(key);
    const sig = key.replace(NUM_RE, '#');
    if (sig.includes('#') && sigs.has(sig)) add(start, end, 'repetition', 'Same sentence with a different number: these requirements may conflict', null);
    else {
      sigs.set(sig, true);
      const words = new Set((key.match(/[a-z0-9]+(?:'[a-z]+)?/g) || []).filter((w) => !STOP.has(w)));
      if (words.size >= 5) for (const p of prior.slice(-300)) {
        if (p.words.size < 5) continue;
        const inter = [...words].filter((w) => p.words.has(w)).length;
        if (inter / (words.size + p.words.size - inter) >= 0.75) { add(start, end, 'repetition', 'Very similar to an earlier sentence: merge them if they say the same thing', null); break; }
      }
      prior.push({ words });
    }
  }
  const wordList = [...text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
  if (wordList.length < 5000) {
    const grams = new Map();
    for (let i = 0; i + 6 <= wordList.length; i++) {
      const k = wordList.slice(i, i + 6).map((w) => w[0].toLowerCase()).join(' ');
      (grams.get(k) || grams.set(k, []).get(k)).push(i);
    }
    for (const [k, at] of grams) if (at.length >= 3)
      for (const i of at.slice(1)) add(wordList[i].index, wordList[i + 5].index + wordList[i + 5][0].length, 'repetition',
        `Phrase "${k}" appears ${at.length} times: say it once`, null, false, { severity: 'info' });
  }

  for (const [re, why] of VAGUE) for (const m of text.matchAll(re)) add(m.index, m.index + m[0].length, 'vague', why, null);
  if (!LENGTH_LIMIT.test(text))
    for (const m of text.matchAll(LENGTH_WORDS)) add(m.index, m.index + m[0].length, 'vague', 'Add a measurable limit, such as "under 100 words"', null);

  for (const m of text.matchAll(/[ \t]+$/gm)) add(m.index, m.index + m[0].length, 'whitespace', 'Trailing spaces', '', true);
  for (const m of text.matchAll(/(?:\r?\n){3,}/g)) add(m.index, m.index + m[0].length, 'whitespace', 'Extra blank lines', m[0].includes('\r') ? '\r\n\r\n' : '\n\n', true);
  for (const m of text.matchAll(/(?<=\S)[ \t]{2,}(?=\S)/g)) add(m.index, m.index + m[0].length, 'whitespace', 'Repeated spaces', ' ', true);

  // Non-overlapping, sorted. Edits win over advice when they collide.
  const taken = [];
  const take = (list) => { list.sort((a, b) => a.start - b.start || b.end - a.end); for (const f of list) if (!taken.some((t) => f.start < t.end && f.end > t.start)) taken.push(f); };
  take(found.filter((f) => !f.advisory)); take(found.filter((f) => f.advisory));
  const findings = taken.sort((a, b) => a.start - b.start);
  findings.forEach((f, i) => (f.id = i));

  const signals = contextSignals(text);
  const tokens = countTokens(text, opts.counter);
  const base = estimateTokens(text); // the score always uses one estimator for numerator and denominator
  const sum = (pred) => findings.filter(pred).reduce((s, f) => s + f.saved, 0);
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + f.saved;
  const waste = sum(() => true), ratio = base ? waste / base : 0;
  const pct = (n) => (base ? (n / base) * 100 : 0);
  const count = (pred) => findings.filter(pred).length;
  const wordT = sum((f) => f.kind === 'wordiness' || f.kind === 'tone'), dupT = sum((f) => f.kind === 'repetition'), wsT = sum((f) => f.kind === 'whitespace');
  const advRep = count((f) => f.kind === 'repetition' && f.advisory && f.severity === 'warn');
  const vagueN = count((f) => f.kind === 'vague'), ctxPenalty = signals.reduce((s, x) => s + x.penalty, 0);
  const row = (id, label, raw, max, evidence, detail) => ({ id, label, penalty: Math.round(Math.min(max, raw)), max, evidence, detail });
  const criteria = [
    row('wording', 'Removable wording', 2.5 * pct(wordT), 60, count((f) => !f.advisory && (f.kind === 'wordiness' || f.kind === 'tone')), `${wordT} of ~${base} estimated tokens (${pct(wordT).toFixed(1)}%) are filler, courtesy or wordy phrasing; 2.5 points per 1%`),
    row('repetition', 'Repetition', 2.5 * pct(dupT) + 3 * advRep, 30, count((f) => f.kind === 'repetition' && f.severity !== 'info'), `${dupT} estimated tokens in exact repeats (2.5 points per 1%) plus ${advRep} near-duplicate or conflicting sentence(s) at 3 points each`),
    row('whitespace', 'Whitespace', 2.5 * pct(wsT), 10, count((f) => f.kind === 'whitespace'), `${wsT} estimated tokens in blank lines and spaces; 2.5 points per 1%`),
    row('clarity', 'Vague instructions', 4 * vagueN, 20, vagueN, `${vagueN} vague phrase(s) at 4 points each`),
    row('context', 'Missing context', ctxPenalty, 15, signals.filter((s) => s.penalty).length, `${signals.filter((s) => s.penalty).length} missing-context problem(s); 8 points for no task or missing pasted content, 5 for an unfilled placeholder`),
  ];
  const score = base < 8 ? null : Math.max(0, 100 - criteria.reduce((s, c) => s + c.penalty, 0));
  const label = score === null ? 'Too short to score' : score >= 90 ? 'Lean' : score >= 75 ? 'Fair' : score >= 50 ? 'Padded' : 'Heavily padded';

  const notes = [];
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length && letters.filter((c) => !LATIN.test(c)).length / letters.length > 0.3) notes.push('Rules are English-only: this prompt gets whitespace and exact-repeat checks, little else.');
  if (tokens.counterFailed) notes.push('The supplied token counter failed, so token numbers are estimates.');
  notes.push('Findings are offline rule-based checks. They do not judge answer quality.');
  return { tokens, stats: measure(text), findings, signals, waste, ratio, byKind, criteria, score, label, notes, engine: ENGINE };
}

function contextSignals(text) {
  const out = [], push = (id, severity, message, penalty = 0) => out.push({ id, kind: 'context', severity, message, penalty });
  const long = estimateTokens(text) >= 8;
  if (long && !TASK.test(text) && !/\?/.test(text) && !QUESTION.test(text)) push('no-task', 'warn', 'No clear task found: say what the model should do, starting with a verb', 8);
  if (/:\s*$/.test(text)) push('missing-content', 'warn', 'The prompt ends with a colon, so the content it introduces seems to be missing', 8);
  if (PLACEHOLDER.test(text)) push('placeholder', 'warn', 'Contains an unfilled placeholder (ignore this if the prompt is a template)', 5);
  if (/\b(?:attached|attachment|enclosed|uploaded|the (?:above|below) (?:text|document|file|code|data|email))\b/i.test(text))
    push('external-ref', 'info', 'Refers to content that is not in the prompt text. Fine if you attach it; otherwise paste it in');
  if (long && TASK.test(text) && !FORMAT.test(text) && !LENGTH_LIMIT.test(text)) push('no-format', 'info', 'No output format or length is stated, so the model will choose one');
  return out;
}

// ---------------------------------------------------------------- optimisation
function applyEdits(text, edits) {
  let out = text;
  for (const f of [...edits].sort((a, b) => b.start - a.start)) {
    let end = f.end;
    if (f.replacement === '') while (out[end] === ' ') end++;
    let before = out.slice(0, f.start), rest = out.slice(end);
    if (f.replacement === '') {
      if (/[ \t]$/.test(before) && /^[,.;:!?]/.test(rest)) before = before.replace(/[ \t]+$/, '');
      if (/[ \t]$/.test(before) && (rest === '' || rest[0] === '\n' || rest[0] === '\r')) before = before.replace(/[ \t]+$/, '');
      if (/\n$/.test(before) && rest[0] === '\n') rest = rest.slice(1);
      if (/(^|[.!?][ \t]+|\n[ \t]*)$/.test(before)) rest = rest.replace(/^[,;:]?[ \t]*([a-z])?/, (m, c) => (c ? c.toUpperCase() : ''));
    }
    out = before + f.replacement + rest;
  }
  return out;
}

/** Apply the findings whose ids are in `ids`. Advice is never applied. Any edit that would lose a requirement is
 *  skipped and reported in `skipped`; nothing is dropped silently. before/after are measured only if a counter is given. */
export function optimize(text, findings, ids, opts = {}) {
  text = String(text ?? '');
  const skipped = [];
  let chosen = [];
  for (const f of findings) {
    if (!ids.has(f.id)) continue;
    if (f.advisory) skipped.push({ id: f.id, reason: f.protected ? f.message : 'Advice only: change this one by hand' });
    else if (text.slice(f.start, f.end) !== f.original) skipped.push({ id: f.id, reason: 'The prompt changed since analysis: analyze again' });
    else {
      const lost = f.kind === 'repetition' ? [] : missing(requirementItems(f.original), f.replacement);
      if (lost.length) skipped.push({ id: f.id, reason: `Would remove a requirement (${fmtItems(lost)})` });
      else chosen.push(f);
    }
  }
  const need = requirementItems(text);
  let out = applyEdits(text, chosen);
  if (missing(need, out).length) { // safety net: keep only edits that lose nothing, then re-check the combination
    const keep = [];
    for (const f of chosen) {
      const lost = missing(need, applyEdits(text, [f]));
      if (lost.length) skipped.push({ id: f.id, reason: `Would remove a requirement (${fmtItems(lost)})` }); else keep.push(f);
    }
    chosen = keep; out = applyEdits(text, chosen);
    if (missing(need, out).length) { for (const f of chosen) skipped.push({ id: f.id, reason: 'Together these edits would remove a requirement' }); chosen = []; out = text; }
  }
  // before and after must be the same kind: never subtract a measured count from an estimate
  let b = countTokens(text, opts.counter), a = countTokens(out, opts.counter);
  if (b.kind !== a.kind) { b = estimateRange(text); a = estimateRange(out); }
  return { text: out, before: b.count, after: a.count, saved: b.count - a.count, kind: b.kind,
    method: b.method, ...(b.kind === 'measured' && { provider: b.provider, model: b.model }), chars: { before: [...text].length, after: [...out].length, saved: [...text].length - [...out].length, kind: 'measured' },
    applied: chosen.map((f) => ({ id: f.id, original: f.original, replacement: f.replacement })), skipped, warnings: skipped.map((s) => s.reason),
    verification: { requirements: need.size, preserved: missing(need, out).length === 0 } };
}
