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

/** Savings between two texts, both counted with the SAME counter or estimator, so the figure is a real recount of
 *  the original and the optimized prompt, never a sum of per-edit guesses. A measured count is never subtracted
 *  from an estimate: if only one text can be measured, both fall back to the estimator. */
export function measureSavings(original, optimized, opts = {}) {
  original = String(original ?? ''); optimized = String(optimized ?? '');
  let b = countTokens(original, opts.counter), a = countTokens(optimized, opts.counter);
  if (b.kind !== a.kind) { b = estimateRange(original); a = estimateRange(optimized); }
  const saved = b.count - a.count;
  return { before: b.count, after: a.count, saved, percent: b.count ? Math.round((saved / b.count) * 1000) / 10 : 0, kind: b.kind, method: b.method,
    ...(b.kind === 'measured' && { provider: b.provider, model: b.model }),
    chars: { before: [...original].length, after: [...optimized].length, saved: [...original].length - [...optimized].length, kind: 'measured' } };
}

// ---------------------------------------------------------------- requirements (what must survive optimisation)
const REQ = [
  ['w', /\b(?:must not|must|never|always|only|do not|don't|dont|should not|shouldn't|cannot|can't|required|mandatory|exactly|at least|at most|no more than|no fewer than|no less than|fewer than|less than|more than|up to|maximum|minimum|limit|under|within|between|avoid|without|ensure|forbidden|prohibited|unless|except|not|no)\b/gi],
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
// [phrase, replacement, safe, kind, why, recommended].
//   safe        = meaning-preserving by construction.
//   recommended = removing it cannot lose a requirement (courtesy frames, emphasis); applied by default but not "safe".
// Degree words ("very", "really") and "simply"/"actually" can carry meaning, so the person decides those.
const SAME = 'Shorter with the same meaning', PRE = 'Preamble that adds no instruction', FRAME = 'Courtesy frame: the instruction stands on its own', EMPH = 'Emphasis frame: the instruction stands on its own';
const PHRASES = [
  ['in order to', 'to', true, 'wordiness', SAME], ['due to the fact that', 'because', true, 'wordiness', SAME], ['at this point in time', 'now', true, 'wordiness', SAME],
  ['at the present time', 'now', true, 'wordiness', SAME], ['in the event that', 'if', true, 'wordiness', SAME], ['for the purpose of', 'for', true, 'wordiness', SAME],
  ['for the reason that', 'because', true, 'wordiness', SAME], ['in spite of the fact that', 'although', true, 'wordiness', SAME], ['with regard to', 'about', true, 'wordiness', SAME],
  ['in regard to', 'about', true, 'wordiness', SAME], ['is able to', 'can', true, 'wordiness', SAME], ['are able to', 'can', true, 'wordiness', SAME], ['has the ability to', 'can', true, 'wordiness', SAME],
  ['on a daily basis', 'daily', true, 'wordiness', SAME], ['each and every', 'every', true, 'wordiness', SAME], ['first and foremost', 'first', true, 'wordiness', SAME],
  ['in the near future', 'soon', true, 'wordiness', SAME], ['prior to', 'before', true, 'wordiness', SAME], ['subsequent to', 'after', true, 'wordiness', SAME],
  ['in close proximity to', 'near', true, 'wordiness', SAME], ['a majority of', 'most', true, 'wordiness', SAME],
  ['it is important to note that', '', true, 'wordiness', PRE, true], ['it should be noted that', '', true, 'wordiness', PRE, true], ['please note that', '', true, 'wordiness', PRE, true],
  ['it goes without saying that', '', true, 'wordiness', PRE, true], ['needless to say', '', true, 'wordiness', PRE, true],
  ['please make sure that you', '', false, 'tone', FRAME, true], ['please make sure to', '', false, 'tone', FRAME, true], ['please remember to', '', false, 'tone', FRAME, true], ['please be sure to', '', false, 'tone', FRAME, true],
  ['make sure that you', '', false, 'tone', EMPH, true], ['make sure to', '', false, 'tone', EMPH, true], ['be sure to', '', false, 'tone', EMPH, true], ['remember to', '', false, 'tone', EMPH, true],
  ['i would like you to', '', false, 'tone', FRAME, true], ['i want you to', '', false, 'tone', FRAME, true], ['i need you to', '', false, 'tone', FRAME, true], ["i'd like you to", '', false, 'tone', FRAME, true],
  ['i was wondering if you could', '', false, 'tone', FRAME, true], ['it would be great if you could', '', false, 'tone', FRAME, true], ['it would be helpful if you could', '', false, 'tone', FRAME, true],
  ["i'd appreciate it if you could", '', false, 'tone', FRAME, true], ['can you please', '', false, 'tone', FRAME, true], ['could you please', '', false, 'tone', FRAME, true], ['would you please', '', false, 'tone', FRAME, true],
  ['feel free to', '', false, 'tone', FRAME, true], ['go ahead and', '', false, 'tone', FRAME, true], ["if you don't mind", '', false, 'tone', FRAME, true],
  ['please', '', false, 'tone', 'Courtesy word: removing it does not change what is asked', true], ['kindly', '', false, 'tone', 'Courtesy word: removing it does not change what is asked', true],
  ['basically', '', false, 'tone', 'Filler word', true],
  ['very', '', false, 'tone', 'Intensifier; check it is not carrying meaning'], ['really', '', false, 'tone', 'Intensifier; check it is not carrying meaning'],
  ['actually', '', false, 'tone', 'Filler word'], ['simply', '', false, 'tone', 'Filler word'],
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
const STOP = new Set('a an the and or but of to in on at for with by from as is are was were be been it this that these those you your i we our they their its if then than so do does did not no can could should would will shall may might have has had please kindly me my us what which how who sure make remember am about also any'.split(' '));
const GIVE = new Set(['provide', 'include', 'offer']);            // "give / provide / include / offer 3 examples" are the same instruction
const THANKS = /^thank(?:s| you)(?:\s+(?:so|very))?(?:\s+much)?(?:\s+a\s+lot)?(?:\s+in\s+advance)?(?:\s+for\s+(?:your|the)\s+(?:help|assistance|time|support|patience|attention|answers?|response|consideration))?[\s,]*(?:again)?[.!]*$/i;
const STRICT = /\b(?:not|no|never|none|nothing|nor|don't|dont|doesn't|won't|can't|cannot|shouldn't|avoid|without|except|unless|only|but|however|otherwise|instead|rather|if|when|whenever|while|before|after|until|exclude|excluding|ignore)\b/i; // negated or scoped: shorter is NOT automatically redundant
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

// ---- Overlapping "style talk": audience level, readability, length. A small hand-written OFFLINE lexicon.
// It only recognises words about HOW TO WRITE. Topics, examples, numbers, formats, negations and quotes are never in it,
// so a span that contains any of them is "not style-only" and is never suggested for removal.
const CONCEPT_WORDS = {
  beginner: 'beginner beginners novice novices newcomer newcomers newbie newbies layperson laypeople layman laymen non-technical nontechnical',
  simple: 'simple simply simpler easy easier easily straightforward plain accessible digestible jargon-free clear clearly',
  brief: 'short brief briefly concise succinct compact',
  detail: 'detailed thorough comprehensive in-depth',
};
const CONCEPT_OF = new Map();
for (const [id, ws] of Object.entries(CONCEPT_WORDS)) for (const w of ws.split(' ')) CONCEPT_OF.set(w, [id]);
for (const w of 'beginner-friendly beginner-level beginner-oriented newbie-friendly novice-friendly layman-friendly'.split(' ')) CONCEPT_OF.set(w, ['beginner', 'simple']);
const CONCEPT_PHRASES = [[/\bnew to (?:this|it|that|the (?:topic|subject|field)|ai|programming|coding)\b/g, ' beginner '], [/\bfrom scratch\b/g, ' beginner '],
  [/\b(?:plain|everyday) (?:english|language|words|terms)\b/g, ' simple '], [/\blayman'?s terms\b/g, ' simple '], [/\bto the point\b/g, ' concise '], [/\bin depth\b/g, ' thorough ']];
// words that may sit inside a style-only span without being content: generic nouns for the answer, light verbs, intensifiers
const STYLE_FILLER = new Set("explanation explanations answer answers response responses reply output content text wording way manner language terms words english it this that them make keep use write ensure be is are stay remain try aim speak understand understanding follow read grasp total complete absolute very really quite fairly extremely super i'm i've i'd i'll we're".split(' '));
const FIRST_PERSON = /\b(?:i|i'm|i've|i'd|i'll|my|me|we|we're|our)\b/i;
// trailing style clauses that can be cut off a topical sentence without touching its subject
const TAILS = [
  /,?\s+(?:in|using)\s+(?:a|an)\s+(?:way|manner|fashion)\s+(?:that|which)\b[^,.;:!?\n]*$/i,
  /,?\s+(?:so|such)\s+that\b[^,.;:!?\n]*$/i,
  /,?\s+in\s+(?:a\s+)?(?:very\s+|really\s+)?(?:simple|plain|easy|clear)\s+(?:terms|words|language|english|way|manner)$/i,
  /,?\s+for\s+(?:a\s+|an\s+)?(?:complete\s+|total\s+|absolute\s+)?(?:beginner|novice|newcomer|newbie|layperson)s?$/i,
  /,?\s+(?:that|which)\s+(?:is|are)\s+(?:easy|simple|clear|straightforward|beginner-friendly)\b[^,.;:!?\n]*$/i,
];
function tagWords(text) {
  let t = String(text ?? '').toLowerCase();
  for (const [re, tag] of CONCEPT_PHRASES) t = t.replace(re, tag);
  const words = [];
  for (const w of t.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || []) words.push(...(CONCEPT_OF.has(w) || !w.includes('-') ? [w] : w.split('-')));
  return words;
}
/** What a piece of text says about style. styleOnly = nothing but style wording: no topic, example, number, format, quote or negation. */
export function styleInfo(text) {
  const s = String(text ?? ''), concepts = new Set(), other = [];
  for (const w of tagWords(s)) {
    if (CONCEPT_OF.has(w)) { for (const c of CONCEPT_OF.get(w)) concepts.add(c); } else if (!STOP.has(w) && !STYLE_FILLER.has(w)) other.push(w);
  }
  const styleOnly = concepts.size > 0 && !other.length && !STRICT.test(s) && requirementItems(s).size === 0 && !/["“`<{]/.test(s);
  return { concepts, styleOnly, other, firstPerson: FIRST_PERSON.test(s) };
}
/** Every style concept the text expresses anywhere (used to prove a concept is never removed entirely). */
export const conceptsIn = (text) => new Set(tagWords(text).flatMap((w) => CONCEPT_OF.get(w) || []));

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
    if (masked.some(([a, b]) => start < b && end > a)) return false;
    const { recommended: wantRec = false, ...more } = extra;
    const original = text.slice(start, end);
    let advisory = replacement === null, protectedEdit = false, extraOut = more;
    if (!advisory && kind !== 'repetition') { // an edit may never drop a requirement
      const lost = missing(requirementItems(original), replacement);
      if (lost.length) { advisory = true; protectedEdit = true; message = `Protected: removing this would drop a requirement (${fmtItems(lost)})`; extraOut = { ...more, severity: 'info' }; }
    }
    const recommended = !advisory && (safe || wantRec);
    if (!advisory && safe && replacement === '' && kind === 'wordiness') { // emphasis in front of a requirement is not "safe" to drop, but it stays recommended
      const [a, b] = sentenceBounds(text, start);
      if (requirementItems(text.slice(a, b)).size) { safe = false; message += '. This sentence states a requirement: its wording is kept'; }
    }
    found.push({ start, end, kind, message, original, replacement: advisory ? '' : replacement, safe: advisory ? false : safe, recommended, advisory,
      protected: protectedEdit, severity: advisory ? 'warn' : 'fix', ...extraOut,
      saved: advisory ? 0 : Math.max(0, estimateTokens(original) - estimateTokens(replacement)) });
    return true;
  };

  for (const [p, r, safe, kind, why, rec] of PHRASES)
    for (const m of text.matchAll(new RegExp(`\\b${esc(p)}\\b`, 'gi'))) add(m.index, m.index + m[0].length, kind, why, r, safe, rec ? { recommended: true } : {});
  for (const m of text.matchAll(/\bthank you(?: so much)? in advance(?: for your (?:help|assistance|time))?[.!]?/gi))
    add(m.index, m.index + m[0].length, 'tone', 'Closing courtesy the model does not need', '', false, { recommended: true });

  // repetition: exact repeats, same sentence with a different number (conflict), and the same instruction in other words
  const FRAMES = new RegExp(`\\b(?:${PHRASES.filter((p) => p[1] === '' && (p[5] || p[2])).map((p) => esc(p[0])).join('|')})\\b`, 'gi');
  const contentWords = (s) => { const out = new Set(); for (let w of s.toLowerCase().replace(FRAMES, ' ').match(/[a-z0-9]+(?:'[a-z]+)?/g) || []) { if (STOP.has(w)) continue; w = stem(w); out.add(GIVE.has(w) ? 'give' : w); } return out; };
  const subset = (a, b) => [...a].every((w) => b.has(w)), same = (a, b) => a.size === b.size && subset(a, b);
  const headers = [...text.matchAll(/^(?:[ \t]{0,3}#{1,6}[ \t].*|[^\n]{1,80}:[ \t]*|[-=*_]{3,}[ \t]*)$/gm)].map((m) => m.index);
  const blockOf = (i) => { let n = 0; while (n < headers.length && headers[n] <= i) n++; return n; }; // sentences under different headings are never merged
  const covers = (small, big) => small.words.size >= 2 && small.items.size <= big.items.size && [...small.items].every((i) => big.items.has(i))
    && (small.strict || big.strict ? same(small.words, big.words) : small.words.size >= 3 && subset(small.words, big.words));
  const seen = new Map(), sigs = new Map(), recs = [];
  for (const m of text.matchAll(SENT_RE)) {
    const lead = m[0].match(/^\s*/)[0].length, body = m[0].slice(lead);
    const key = body.toLowerCase().replace(/\s+/g, ' ').trim();
    const start = m.index + lead, end = m.index + m[0].length;
    if (THANKS.test(body.trim())) { add(start, end, 'tone', 'Closing courtesy the model does not need', '', false, { recommended: true }); continue; } // only a sentence that is nothing but thanks
    if (key.length < 15) continue;
    const block = blockOf(start);
    if (seen.has(key)) {
      const isReq = requirementItems(key).size > 0;
      const sameSection = seen.get(key) === block; // under a different heading the repeat may be that section's only copy of the rule
      add(start, end, 'repetition', !sameSection ? 'Repeats a sentence from another section: it may be that section\'s own copy' : isReq ? 'Repeats an earlier requirement exactly. The first copy still applies' : 'Repeats an earlier sentence exactly', '', !isReq && sameSection, { recommended: sameSection });
      continue;
    }
    seen.set(key, block);
    const sig = key.replace(NUM_RE, '#');
    if (sig.includes('#') && sigs.has(sig)) { add(start, end, 'repetition', 'Same sentence with a different number: these requirements may conflict', null); continue; }
    sigs.set(sig, true);
    const rec = { start, end, words: contentWords(body), items: requirementItems(body), strict: STRICT.test(body), block, gone: false };
    let dropped = false, advised = false;
    for (const p of recs.slice(-300)) {
      if (p.gone || p.block !== rec.block) continue;
      if (covers(rec, p)) { dropped = add(rec.start, rec.end, 'repetition', 'Already said earlier in different words', '', false, { recommended: true }); if (dropped) { rec.gone = true; break; } }
      else if (covers(p, rec) && add(p.start, p.end, 'repetition', 'Covered by a later, more specific sentence', '', false, { recommended: true })) p.gone = true;
      else if (!advised && p.words.size >= 5 && rec.words.size >= 5) {
        const inter = [...rec.words].filter((w) => p.words.has(w)).length;
        if (inter / (rec.words.size + p.words.size - inter) >= 0.75) advised = add(start, end, 'repetition', 'Very similar to an earlier sentence: merge them if they say the same thing', null);
      } else if (!advised && (rec.strict || p.strict) && Math.min(rec.words.size, p.words.size) >= 3 && (subset(rec.words, p.words) || subset(p.words, rec.words)))
        advised = add(start, end, 'repetition', 'Overlaps an earlier instruction that is negated or limited: merge by hand if they mean the same', null);
    }
    if (!dropped) recs.push(rec);
  }
  // overlapping style wording: a style-only sentence or trailing clause that restates what another one already says
  {
    const goneRanges = found.filter((f) => f.kind === 'repetition' && !f.advisory && f.replacement === '').map((f) => [f.start, f.end]);
    const spans = [];
    for (const m of text.matchAll(SENT_RE)) {
      const lead = m[0].match(/^\s*/)[0].length, body = m[0].slice(lead), start = m.index + lead, end = m.index + m[0].length;
      if (!body.trim() || goneRanges.some(([a, b]) => start < b && end > a)) continue;
      const info = styleInfo(body);
      if (info.styleOnly) { spans.push({ kind: 'sentence', start, end, text: body.trim(), ...info, block: blockOf(start) }); continue; }
      const core = body.replace(/[.!?]+\s*$/, '');
      for (const re of TAILS) {
        const t = re.exec(core); if (!t) continue;
        const ti = styleInfo(t[0]);
        if (ti.styleOnly) { spans.push({ kind: 'tail', start: start + t.index, end: start + t.index + t[0].length, text: t[0].replace(/^[\s,]+/, ''), ...ti, block: blockOf(start) }); break; }
      }
    }
    const quote = (s) => `“${s.text.length > 60 ? `${s.text.slice(0, 57)}…` : s.text}”`, names = (s) => [...s.concepts].sort().join(', ');
    const kept = [];
    for (const x of spans) {
      for (const k of kept) {
        if (k.gone || k.block !== x.block) continue;
        if (subset(x.concepts, k.concepts)) {            // x says nothing that k does not already say
          const equal = same(x.concepts, k.concepts);
          x.gone = add(x.start, x.end, 'repetition', `${equal ? 'Same idea as' : 'Already covered by'} ${quote(k)} (${names(x)})${x.firstPerson ? '. It also says something about you, so tick it only if the other wording is enough' : ''}`, '', false,
            { recommended: equal && !x.firstPerson, semantic: true, concepts: [...x.concepts].sort() });
          if (x.gone) break;
        } else if (subset(k.concepts, x.concepts)) {     // k is only a part of what x says
          k.gone = add(k.start, k.end, 'repetition', `Already covered by ${quote(x)} (${names(k)}), which says more${k.firstPerson ? '. It also says something about you, so tick it only if the other wording is enough' : ''}`, '', false,
            { recommended: false, semantic: true, concepts: [...k.concepts].sort() });
        }
      }
      if (!x.gone) kept.push(x);
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
  if (text.length <= 8000 && findings.length <= 120) { // each edit's saving measured on the whole text, not on the span alone
    const whole = estimateTokens(text);
    for (const f of findings) if (!f.advisory) f.saved = Math.max(0, whole - estimateTokens(applyEdits(text, [f])));
  }

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
  const row = (id, label, raw, max, evidence, detail) => ({ id, label, penalty: Math.round(Math.min(max, raw)), max, evidence,
    detail: raw > max ? `${detail}. Capped at −${max}, so fixing only part of it may not change the score yet` : detail });
  // One source of truth: the score, the findings list and the suggestions all read the same repetition findings.
  const sumSaved = (list) => list.reduce((s, f) => s + f.saved, 0);
  const repAll = findings.filter((f) => f.kind === 'repetition'), repSem = repAll.filter((f) => f.semantic && !f.advisory), repExact = repAll.filter((f) => !f.semantic && !f.advisory);
  const repetition = { exact: { count: repExact.length, tokens: sumSaved(repExact) }, semantic: { count: repSem.length, tokens: sumSaved(repSem), recommended: repSem.filter((f) => f.recommended).length },
    advice: { count: advRep }, tokens: dupT };
  const criteria = [
    row('wording', 'Removable wording', 2.5 * pct(wordT), 60, count((f) => !f.advisory && (f.kind === 'wordiness' || f.kind === 'tone')), `${wordT} of ~${base} estimated tokens (${pct(wordT).toFixed(1)}%) are filler, courtesy or wordy phrasing; 2.5 points per 1%`),
    row('repetition', 'Repetition', 2.5 * pct(dupT) + 3 * advRep, 30, count((f) => f.kind === 'repetition' && f.severity !== 'info'), `${repetition.exact.count} repeated sentence(s) (${repetition.exact.tokens} tokens) + ${repetition.semantic.count} restated idea(s) (${repetition.semantic.tokens} tokens) = ${dupT} of ~${base} estimated tokens (${pct(dupT).toFixed(1)}%) at 2.5 points per 1%, plus ${advRep} near-duplicate or conflicting sentence(s) at 3 points each`),
    row('whitespace', 'Whitespace', 2.5 * pct(wsT), 10, count((f) => f.kind === 'whitespace'), `${wsT} estimated tokens in blank lines and spaces; 2.5 points per 1%`),
    row('clarity', 'Vague instructions', 4 * vagueN, 20, vagueN, `${vagueN} vague phrase(s) at 4 points each`),
    row('context', 'Missing context', ctxPenalty, 15, signals.filter((s) => s.penalty).length, `${signals.filter((s) => s.penalty).length} missing-context problem(s); 8 points for no task or missing pasted content, 5 for an unfilled placeholder`),
  ];
  criteria.find((c) => c.id === 'repetition').parts = repetition;
  const score = base < 8 ? null : Math.max(0, 100 - criteria.reduce((s, c) => s + c.penalty, 0));
  const label = score === null ? 'Too short to score' : score >= 90 ? 'Lean' : score >= 75 ? 'Fair' : score >= 50 ? 'Padded' : 'Heavily padded';

  const notes = [];
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length && letters.filter((c) => !LATIN.test(c)).length / letters.length > 0.3) notes.push('Rules are English-only: this prompt gets whitespace and exact-repeat checks, little else.');
  if (tokens.counterFailed) notes.push('The supplied token counter failed, so token numbers are estimates.');
  notes.push('Findings are offline rule-based checks. They do not judge answer quality.');
  const would = (ids) => { const o = optimize(text, findings, ids, { counter: opts.counter }); return { tokens: o.saved, percent: o.percent, kind: o.kind }; };
  const potential = { basis: 'potential', all: would(new Set(findings.filter((f) => !f.advisory).map((f) => f.id))), recommended: would(recommendedIds(findings)) };
  return { tokens, stats: measure(text), findings, signals, waste, ratio, byKind, criteria, repetition, potential, score, label, notes, engine: ENGINE };
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
  // Built left to right, so cleaning up the output already produced (trailing spaces, capitalisation) can never
  // invalidate the positions of edits that come later.
  let out = '', pos = 0, cap = false;
  const push = (s) => {
    if (!s) return;
    if (cap) { const m = s.match(/^([ \t]*)([a-z])/); if (m) s = m[1] + m[2].toUpperCase() + s.slice(m[0].length); if (/\S/.test(s)) cap = false; }
    out += s;
  };
  for (const f of [...edits].sort((a, b) => a.start - b.start)) {
    push(text.slice(pos, f.start));
    if (f.replacement !== '') { push(f.replacement); pos = f.end; continue; }
    let end = f.end;                                     // a deletion: tidy the seam on both sides
    while (text[end] === ' ') end++;
    if (!/\S/.test(text.slice(end))) {                   // nothing left after it: no dangling blank lines, keep the final newline
      return out.replace(/\s+$/, '') + (text.slice(end).match(/\r?\n$/) || [''])[0];
    }
    if (!/\S/.test(out)) while (/\s/.test(text[end])) end++; // nothing left before it: no leading blank lines
    const next = text[end];
    if (/[ \t]$/.test(out) && /[,.;:!?\r\n]/.test(next)) out = out.replace(/[ \t]+$/, '');
    if (/\n$/.test(out) && next === '\n') end++;         // do not leave a blank line behind
    if (/(^|[.!?][ \t]+|\n[ \t]*)$/.test(out)) {         // the next words now start a sentence
      const m = text.slice(end).match(/^[,;:]?[ \t]*([a-z])?/);
      end += m[0].length - (m[1] ? 1 : 0);
      cap = true;
    }
    pos = end;
  }
  push(text.slice(pos));
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
    else if (estimateTokens(f.replacement) > estimateTokens(f.original)) skipped.push({ id: f.id, reason: 'Would add tokens instead of removing them' });
    else if (f.semantic && !styleInfo(f.original).styleOnly) skipped.push({ id: f.id, reason: 'Not purely style wording, so it is not removed as a repeat' });
    else {
      const lost = f.kind === 'repetition' ? [] : missing(requirementItems(f.original), f.replacement);
      if (lost.length) skipped.push({ id: f.id, reason: `Would remove a requirement (${fmtItems(lost)})` });
      else chosen.push(f);
    }
  }
  let out = applyEdits(text, chosen);
  if (chosen.some((f) => f.semantic)) { // a style concept must still be stated somewhere afterwards: drop semantic edits whose concept would vanish
    const had = conceptsIn(text), kept = conceptsIn(out), gone = [...had].filter((x) => !kept.has(x));
    if (gone.length) {
      for (const f of chosen.filter((g) => g.semantic && (g.concepts || []).some((x) => gone.includes(x)))) skipped.push({ id: f.id, reason: `Would remove the only statement of: ${gone.join(', ')}` });
      chosen = chosen.filter((g) => !(g.semantic && (g.concepts || []).some((x) => gone.includes(x))));
      out = applyEdits(text, chosen);
    }
  }
  const need = requirementItems(text);
  if (missing(need, out).length) { // safety net: keep only edits that lose nothing, then re-check the combination
    const keep = [];
    for (const f of chosen) {
      const lost = missing(need, applyEdits(text, [f]));
      if (lost.length) skipped.push({ id: f.id, reason: `Would remove a requirement (${fmtItems(lost)})` }); else keep.push(f);
    }
    chosen = keep; out = applyEdits(text, chosen);
    if (missing(need, out).length) { for (const f of chosen) skipped.push({ id: f.id, reason: 'Together these edits would remove a requirement' }); chosen = []; out = text; }
  }
  const m = measureSavings(text, out, opts); // recounted from the original and the optimized text with the same counter
  const actionable = findings.filter((f) => !f.advisory), picked = actionable.filter((f) => ids.has(f.id));
  const reason = chosen.length ? 'optimized' : !actionable.length ? 'already_lean' : !picked.length ? (actionable.some((f) => f.recommended) ? 'nothing_selected' : 'review_only') : 'all_skipped';
  return { text: out, reason, ...m,
    applied: chosen.map((f) => ({ id: f.id, original: f.original, replacement: f.replacement })), skipped, warnings: skipped.map((s) => s.reason),
    verification: { requirements: need.size, preserved: missing(need, out).length === 0 } };
}

/** Ids of the edits applied by default: every edit that cannot lose a requirement (a superset of the "safe" ones). */
export const recommendedIds = (findings) => new Set(findings.filter((f) => f.recommended && !f.advisory).map((f) => f.id));

/** One call: analyze, apply every recommended edit, and repeat until nothing more can be removed (max 3 passes).
 *  The result is measured against the ORIGINAL text, so savings are the real end-to-end reduction.
 *  `outcome` says why the text is unchanged when it is: 'already_lean' (nothing to remove) or 'review_only' (only opt-in edits exist). */
export function optimizePrompt(input, opts = {}) {
  const original = String(input ?? '');
  let cur = original, passes = 0, applied = [], skipped = [], first = null;
  for (let i = 0; i < (opts.passes ?? 3); i++) {
    const r = analyze(cur, opts), o = optimize(cur, r.findings, recommendedIds(r.findings), opts);
    first ??= { reason: o.reason, findings: r.findings };
    skipped = skipped.concat(o.skipped);
    if (!o.applied.length || o.text === cur) break;
    applied = applied.concat(o.applied); cur = o.text; passes++;
  }
  const m = measureSavings(original, cur, opts);
  const outcome = cur !== original ? 'optimized' : first.reason === 'already_lean' ? 'already_lean' : first.findings.some((f) => !f.advisory && !f.recommended) ? 'review_only' : 'already_lean';
  return { text: cur, outcome, passes, applied, skipped, ...m,
    verification: { requirements: requirementItems(original).size, preserved: missing(requirementItems(original), cur).length === 0 } };
}
