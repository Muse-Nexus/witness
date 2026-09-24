/**
 * The rules detector: stage 1 hard exclusions, stage 2 lexicon scoring with
 * caveats, and selection of the verbatim evidence span (SPEC §6).
 *
 * Deterministic and synchronous. Precision over recall: anything uncertain
 * goes to "maybe", which nobody has to look at.
 */
import { defaultLexicon, type CompiledRule, type Lexicon } from './lexicon.js';
import {
  contains,
  findAll,
  foldForMatch,
  hasMatch,
  overlaps,
  segmentSentences,
  sentenceIndexAt,
  type Span,
} from './text.js';
import type { Candidate, Category, Caveat, Reason, Verdict } from './types.js';

export const SAVE_THRESHOLD = 0.75;
export const MAYBE_THRESHOLD = 0.35;
/** Below this, a caveated verdict is too thin to be worth a look. */
export const CAVEAT_MAYBE_FLOOR = 0.25;

/** Caveats that keep a verdict out of auto-save no matter the score. */
export const BLOCKING_CAVEATS: ReadonlySet<Caveat> = new Set<Caveat>([
  'possible_sarcasm',
  'negated',
  'apology',
  'rejection',
  'transactional',
  'not_directed',
  'coercion',
]);

/** A negated cue lighter than this ("no thanks") is not worth a caveat. */
const NEGATION_CAVEAT_MIN = 0.3;
const MAX_QUOTE_SENTENCES = 3;
const MAX_QUOTE_LENGTH = 600;

// ---------------------------------------------------------------------------
// Stage 1: hard exclusions
// ---------------------------------------------------------------------------

/**
 * Returns the id of the first hard exclusion that applies, or null. Manual
 * adds are never excluded: the person chose them.
 */
export function exclusionFor(c: Candidate, lexicon: Lexicon = defaultLexicon()): string | null {
  if (c.channel === 'manual') return null;
  if (c.from?.isMe) return 'from_me';

  const handle = (c.from?.handle ?? '').trim();
  if (handle) {
    if (/^urn:biz:/i.test(handle)) return 'business_chat';
    const digits = handle.replace(/[\s().+-]/g, '');
    if (/^\d+$/.test(digits) && digits.length <= 6) return 'short_code';
    // SMS sender IDs like "BANKCO" are always businesses; people have numbers or emails.
    if (c.channel === 'text' && !handle.includes('@') && /[a-z]/i.test(handle)) return 'alphanumeric_sender';
  }

  const headers = lowerKeys(c.headers);
  for (const [name, rule] of lexicon.headerRules) {
    const raw = headers[name];
    if (raw === undefined) continue;
    const value = raw.trim().toLowerCase();
    if (rule === '*') return `header:${name}`;
    if (Array.isArray(rule)) {
      if (rule.some((v) => v.toLowerCase() === value)) return `header:${name}`;
    } else if (!rule.not.some((v) => v.toLowerCase() === value)) {
      return `header:${name}`;
    }
  }

  const sender = foldForMatch(`${c.from?.name ?? ''} ${handle}`.trim());
  if (sender) {
    const hit = firstHit(lexicon.senderPatterns, sender);
    if (hit) return `sender:${hit}`;
  }
  if (c.subject) {
    const hit = firstHit(lexicon.subjectPatterns, foldForMatch(c.subject));
    if (hit) return `subject:${hit}`;
  }
  const hit = firstHit(lexicon.bodyPatterns, foldForMatch(c.text ?? ''));
  if (hit) return `body:${hit}`;
  return null;
}

function firstHit(rules: readonly CompiledRule[], text: string): string | null {
  for (const rule of rules) if (hasMatch(rule.re, text)) return rule.id;
  return null;
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = String(v);
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2: cues
// ---------------------------------------------------------------------------

type Source = 'text' | 'subject';

interface Cue extends Span {
  ruleId: string;
  category: Exclude<Category, 'other'>;
  weight: number;
  implicit: boolean;
  source: Source;
  status: 'live' | 'negated' | 'neutralized';
  /** Dampener rule that neutralized the cue, e.g. "boilerplate:thanks_in_advance". */
  neutralizedBy?: string;
  /** Offset of the negation word, when negated. */
  negationAt?: number;
  directed: boolean;
}

interface Dampening {
  kind: 'boilerplate' | 'transactional' | 'third_party' | 'sarcasm' | 'apology' | 'rejection' | 'coercion';
  id: string;
  source: Source;
  span: Span;
}

interface Analysis {
  cues: Cue[];
  dampenings: Dampening[];
  sentences: Span[];
}

function findCues(folded: string, source: Source, lexicon: Lexicon): Cue[] {
  const found: Cue[] = [];
  for (const cue of lexicon.cues) {
    for (const m of findAll(cue.re, folded)) {
      found.push({
        ruleId: cue.ruleId,
        category: cue.category,
        weight: cue.weight,
        implicit: cue.implicit,
        source,
        start: m.start,
        end: m.end,
        status: 'live',
        directed: false,
      });
    }
  }
  // Longest match wins: a cue inside a longer cue is part of it. "thank you"
  // inside "can't thank you enough" must not be scored (or negation-checked)
  // alone, and "love you all" is weaker than the "love you" inside it.
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || b.weight - a.weight || a.start - b.start);
  const kept: Cue[] = [];
  for (const cue of found) {
    if (!kept.some((k) => contains(k, cue))) kept.push(cue);
  }
  return kept.sort((a, b) => a.start - b.start || b.weight - a.weight);
}

function findDampenings(folded: string, source: Source, lexicon: Lexicon): Dampening[] {
  const lists: [Dampening['kind'], readonly CompiledRule[]][] = [
    ['transactional', lexicon.transactional],
    ['boilerplate', lexicon.boilerplate],
    ['third_party', lexicon.notDirected],
    ['sarcasm', lexicon.sarcasm],
    ['apology', lexicon.apology],
    ['rejection', lexicon.rejection],
    ['coercion', lexicon.coercion],
  ];
  const out: Dampening[] = [];
  for (const [kind, rules] of lists) {
    for (const rule of rules) {
      for (const m of findAll(rule.re, folded)) out.push({ kind, id: rule.id, source, span: m });
    }
  }
  return out;
}

/**
 * Dampeners that cancel a cue they overlap ("thanks" inside "thanks in
 * advance", "thanks for nothing", "congrats to Priya"). Sarcasm, apology and
 * rejection elsewhere in the message only add a caveat.
 */
const NEUTRALIZING: ReadonlySet<Dampening['kind']> = new Set(['transactional', 'boilerplate', 'third_party', 'sarcasm']);

/** In a pasted or screenshotted chat, "You: ..." and "Me: ..." lines are the owner's own words. */
const OWNER_LINE = /(^|\n)[ \t]*(you|me)[ \t]*:[^\n]*/gi;

/** Characters and words that end the reach of a negation ("not much, but thank you"). */
const CLAUSE_BREAK = /[,;:()–—]|\s-\s|\b(?:but|though|although|however|except)\b/gi;

/**
 * How far back from a cue a negation is looked for. The window is a few words,
 * so a bounded look-back keeps a very long sentence linear, not quadratic.
 */
const NEGATION_LOOKBACK_CHARS = 240;

function negationOffset(folded: string, cue: Cue, sentence: Span, lexicon: Lexicon): number | null {
  const scopeStart = Math.max(Math.min(sentence.start, cue.start), cue.start - NEGATION_LOOKBACK_CHARS);
  let from = scopeStart;
  for (const m of findAll(CLAUSE_BREAK, folded.slice(scopeStart, cue.start))) from = scopeStart + m.end;

  // Walk back over at most `negationWindow` words.
  const words = findAll(/\S+/g, folded.slice(from, cue.start));
  if (words.length === 0) return null;
  const windowStart = from + words[Math.max(0, words.length - lexicon.negationWindow)]!.start;

  for (const m of findAll(lexicon.negation, folded.slice(windowStart, cue.start))) {
    const at = windowStart + m.start;
    if (lexicon.negationExceptions && lexicon.negationExceptions.test(folded.slice(at))) continue;
    return at;
  }
  return null;
}

function analyze(text: string, subject: string | undefined, lexicon: Lexicon): Analysis {
  const folded = foldForMatch(text);
  const sentences = segmentSentences(text);
  const cues = findCues(folded, 'text', lexicon);
  const dampenings = findDampenings(folded, 'text', lexicon);

  const foldedSubject = subject ? foldForMatch(subject) : '';
  const subjectCues = foldedSubject ? findCues(foldedSubject, 'subject', lexicon) : [];
  const subjectDampenings = foldedSubject ? findDampenings(foldedSubject, 'subject', lexicon) : [];

  const secondPersonIn = (s: string): boolean => hasMatch(lexicon.secondPerson, s);

  // A cue that itself says "you" ("proud of the person you're becoming") is
  // aimed at the reader even when a third-party pattern overlaps it.
  const cancels = (d: Dampening, cue: Cue, haystack: string): boolean =>
    NEUTRALIZING.has(d.kind) &&
    overlaps(d.span, cue) &&
    !(d.kind === 'third_party' && secondPersonIn(haystack.slice(cue.start, cue.end)));

  const ownerLines = findAll(OWNER_LINE, folded);
  // Whether a sentence says "you" is the same for every cue in it; work it out once.
  const sentenceSaysYou = new Map<number, boolean>();

  for (const cue of cues) {
    if (ownerLines.some((line) => overlaps(line, cue))) {
      cue.status = 'neutralized';
      cue.neutralizedBy = 'owner_line';
      continue;
    }
    const neutralizer = dampenings.find((d) => cancels(d, cue, folded));
    if (neutralizer) {
      cue.status = 'neutralized';
      cue.neutralizedBy = `${neutralizer.kind}:${neutralizer.id}`;
      continue;
    }
    const sentenceIndex = sentenceIndexAt(sentences, cue.start);
    const sentence = sentences[sentenceIndex] ?? { start: 0, end: text.length };
    const negatedAt = negationOffset(folded, cue, sentence, lexicon);
    if (negatedAt !== null) {
      cue.status = 'negated';
      cue.negationAt = negatedAt;
      continue;
    }
    const inSentence = (): boolean => {
      // A cue that runs past its sentence is checked on its own span below.
      if (cue.start < sentence.start || cue.end > sentence.end) {
        return secondPersonIn(folded.slice(Math.min(sentence.start, cue.start), Math.max(sentence.end, cue.end)));
      }
      let known = sentenceSaysYou.get(sentenceIndex);
      if (known === undefined) {
        known = secondPersonIn(folded.slice(sentence.start, sentence.end));
        sentenceSaysYou.set(sentenceIndex, known);
      }
      return known;
    };
    cue.directed = cue.implicit || secondPersonIn(folded.slice(cue.start, cue.end)) || inSentence();
  }

  for (const cue of subjectCues) {
    const neutralizer = subjectDampenings.find((d) => cancels(d, cue, foldedSubject));
    if (neutralizer) {
      cue.status = 'neutralized';
      cue.neutralizedBy = `${neutralizer.kind}:${neutralizer.id}`;
      continue;
    }
    const negatedAt = negationOffset(foldedSubject, cue, { start: 0, end: foldedSubject.length }, lexicon);
    if (negatedAt !== null) {
      cue.status = 'negated';
      continue;
    }
    cue.directed = cue.implicit || secondPersonIn(foldedSubject);
  }

  return { cues: [...cues, ...subjectCues], dampenings: [...dampenings, ...subjectDampenings], sentences };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The strongest cue sets the level; the others add a share of the remaining
 * headroom (noisy-OR), so many weak cues never outrank one strong, specific one.
 */
export function combineWeights(weights: readonly number[], supportFactor: number): number {
  if (weights.length === 0) return 0;
  const [top, ...rest] = [...weights].sort((a, b) => b - a) as [number, ...number[]];
  const support = 1 - rest.reduce((product, w) => product * (1 - w), 1);
  return top + (1 - top) * supportFactor * support;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

function effectiveWeight(cue: Cue, lexicon: Lexicon, undirected: boolean): number {
  let w = cue.weight;
  if (cue.source === 'subject') w *= lexicon.context.subjectFactor;
  if (undirected) w *= lexicon.context.undirectedFactor;
  return w;
}

/** One entry per rule id (the heaviest occurrence), so repeating a phrase does not stack. */
function distinctByRule(cues: readonly Cue[]): Cue[] {
  const best = new Map<string, Cue>();
  for (const cue of cues) {
    const key = `${cue.source}:${cue.ruleId}`;
    const prev = best.get(key);
    if (!prev || cue.weight > prev.weight) best.set(key, cue);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Span selection
// ---------------------------------------------------------------------------

function selectQuote(text: string, analysis: Analysis, live: readonly Cue[], weightOf: (c: Cue) => number): Span {
  const { sentences } = analysis;
  if (sentences.length === 0) return { start: 0, end: 0 };

  const textCues = live.filter((c) => c.source === 'text');
  if (textCues.length === 0) {
    // Evidence only in the subject: show the opening of the message.
    const last = Math.min(sentences.length, MAX_QUOTE_SENTENCES) - 1;
    const span = { start: sentences[0]!.start, end: sentences[last]!.end };
    return span.end - span.start > MAX_QUOTE_LENGTH ? sentences[0]! : span;
  }

  const anchor = [...textCues].sort((a, b) => weightOf(b) - weightOf(a) || a.start - b.start)[0]!;
  let lo = sentenceIndexAt(sentences, anchor.start);
  let hi = Math.max(lo, sentenceIndexAt(sentences, anchor.end - 1));
  const anchorLo = lo;
  const anchorHi = hi;

  const strengthOf = (index: number): number => {
    const s = sentences[index];
    if (!s) return 0;
    return Math.max(0, ...textCues.filter((c) => c.start >= s.start && c.start < s.end).map(weightOf));
  };
  while (hi - lo + 1 < MAX_QUOTE_SENTENCES) {
    const left = strengthOf(lo - 1);
    const right = strengthOf(hi + 1);
    if (left === 0 && right === 0) break;
    if (right >= left) hi += 1;
    else lo -= 1;
  }

  // Control, guilt or an insult anywhere in the message always comes along: a
  // quote must never turn "I love you. You owe me." into a clean "I love you."
  const coercive = analysis.dampenings.filter((d) => d.source === 'text' && d.kind === 'coercion').map((d) => d.span);
  for (const q of coercive) {
    lo = Math.min(lo, sentenceIndexAt(sentences, q.start));
    hi = Math.max(hi, sentenceIndexAt(sentences, Math.max(q.start, q.end - 1)));
  }

  // Never cut away the words that qualify the evidence: a negation, sarcasm,
  // an apology or a rejection in the quote or right next to it comes along.
  const qualifiers: Span[] = [
    ...analysis.dampenings
      .filter((d) => d.source === 'text' && (d.kind === 'sarcasm' || d.kind === 'apology' || d.kind === 'rejection'))
      .map((d) => d.span),
    ...analysis.cues
      .filter((c) => c.source === 'text' && c.status === 'negated')
      .map((c) => ({ start: c.negationAt ?? c.start, end: c.end })),
  ];
  for (const q of qualifiers) {
    const first = sentenceIndexAt(sentences, q.start);
    const last = sentenceIndexAt(sentences, Math.max(q.start, q.end - 1));
    // Touching or inside the quote: take every sentence the qualifier spans.
    if (last >= lo - 1 && first <= hi + 1) {
      lo = Math.min(lo, first);
      hi = Math.max(hi, last);
    }
  }

  let span: Span = { start: sentences[lo]!.start, end: sentences[hi]!.end };
  // A coercive message is never saved automatically; its quote stays whole so the
  // person sees everything that was said, however long.
  if (coercive.length > 0) return span;
  if (span.end - span.start > MAX_QUOTE_LENGTH) {
    span = { start: sentences[anchorLo]!.start, end: sentences[anchorHi]!.end };
  }
  if (span.end - span.start > MAX_QUOTE_LENGTH) span = windowAround(text, span, anchor);
  return tidyQuote(text, span, anchor);
}

const SPEAKER_LABEL = /^[^\s:"'][^:\n"]{0,30}:\s+/;

/** "Mom texted:", "My manager's note:" and the like: narration, not the other person's words. */
const NARRATOR_PREFIX =
  /\b(wrote|said|says|texted|writes|messaged|emailed|told me|sent me|replied|note|card|letter|message|text|email|dm|comment|review|caption)\s*:\s*/gi;

/**
 * Keeps the quote to the other person's words: when the evidence sits inside
 * quotation marks or after a narrator prefix ("My sister texted: ..."), the
 * narration is dropped. A stray unmatched quote mark at either end goes too.
 */
function tidyQuote(text: string, span: Span, anchor: Span): Span {
  const folded = foldForMatch(text);
  let { start, end } = span;
  for (const region of findAll(/"[^"\n]{2,}"/g, folded)) {
    if (region.start <= anchor.start && anchor.end <= region.end) {
      start = Math.max(start, region.start + 1);
      end = Math.min(end, region.end - 1);
      break;
    }
  }
  const prefixes = findAll(NARRATOR_PREFIX, folded.slice(start, anchor.start));
  if (prefixes.length > 0) start += prefixes[prefixes.length - 1]!.end;
  const trim = (): void => {
    while (start < end && /\s/.test(text[start]!)) start += 1;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  };
  trim();
  // A chat speaker label ("Nadia: happy birthday") is not part of what they said.
  const label = SPEAKER_LABEL.exec(folded.slice(start, anchor.start));
  if (label) start += label[0].length;
  const first = folded[start];
  const last = folded[end - 1];
  if ((first === '"' || first === "'") && last === first && end - start > 2) {
    start += 1;
    end -= 1;
  } else if ((folded.slice(start, end).match(/"/g) ?? []).length % 2 === 1) {
    if (last === '"') end -= 1;
    else if (first === '"') start += 1;
  }
  trim();
  // Tidying must never lose the evidence itself.
  return start <= anchor.start && anchor.end <= end ? { start, end } : span;
}

/** A word-aligned window inside one very long sentence that keeps the words just before the cue. */
function windowAround(text: string, sentence: Span, anchor: Span): Span {
  let start = Math.max(sentence.start, anchor.start - 200);
  let end = Math.min(sentence.end, anchor.end + 300);
  while (start > sentence.start && /\S/.test(text[start - 1]!)) start -= 1;
  while (end < sentence.end && /\S/.test(text[end]!)) end += 1;
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return { start, end };
}

// ---------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------

/**
 * SPEC thresholds. Blocking caveats keep a verdict out of save and hold it in
 * maybe even below the maybe threshold, as long as there is more than a bare
 * "thanks" behind it (CAVEAT_MAYBE_FLOOR). `boilerplate` and `group_message`
 * are informational only; otherwise every "thanks" in a group chat, or every
 * "thanks a lot 🙄", would pile up in maybe.
 */
export function decide(score: number, caveats: readonly Caveat[]): Verdict['decision'] {
  const blocked = caveats.some((cv) => BLOCKING_CAVEATS.has(cv));
  if (score >= SAVE_THRESHOLD && !blocked) return 'save';
  if (score >= MAYBE_THRESHOLD || (blocked && score >= CAVEAT_MAYBE_FLOOR)) return 'maybe';
  return 'exclude';
}

function excludedVerdict(rule: string, reasons: Reason[] = []): Verdict {
  return {
    decision: 'exclude',
    score: 0,
    category: 'other',
    quote: '',
    quoteStart: 0,
    quoteEnd: 0,
    reasons: [...reasons, { rule: `exclude:${rule}`, weight: 0 }],
    caveats: [],
    excludedBy: rule,
    engine: 'rules',
  };
}

/** Rules-only verdict for one candidate. Deterministic and synchronous. */
export function detect(c: Candidate, lexicon: Lexicon = defaultLexicon()): Verdict {
  const text = c.text ?? '';
  const excluded = exclusionFor(c, lexicon);
  if (excluded) return excludedVerdict(excluded);
  // Violence, threats, self-harm and farewells are never evidence, whatever else is said.
  if (c.channel !== 'manual') {
    const harm = firstHit(lexicon.harm, foldForMatch(text));
    if (harm) return excludedVerdict(`harm:${harm}`);
  }

  const analysis = analyze(text, c.subject, lexicon);
  const reasons: Reason[] = [];
  const offsets = (cue: Cue): Partial<Reason> => (cue.source === 'text' ? { start: cue.start, end: cue.end } : {});
  const label = (cue: Cue): string => (cue.source === 'subject' ? `subject:${cue.ruleId}` : cue.ruleId);

  for (const cue of analysis.cues) {
    if (cue.status === 'neutralized') {
      reasons.push({ rule: `${cue.neutralizedBy}>${label(cue)}`, weight: round(-cue.weight), ...offsets(cue) });
    } else if (cue.status === 'negated') {
      reasons.push({ rule: `negated>${label(cue)}`, weight: 0, ...offsets(cue) });
    }
  }

  const live = analysis.cues.filter((cue) => cue.status === 'live');
  if (live.length === 0) {
    const why = analysis.cues.length === 0 ? 'no_cue' : 'no_live_cue';
    return excludedVerdict(why, reasons);
  }

  const ctx = lexicon.context;
  const undirected = !live.some((cue) => cue.directed);
  const weightOf = (cue: Cue): number => effectiveWeight(cue, lexicon, undirected);
  const scored = distinctByRule(live);

  for (const cue of scored) reasons.push({ rule: label(cue), weight: round(weightOf(cue)), ...offsets(cue) });

  const base = combineWeights(scored.map(weightOf), ctx.supportFactor);

  // Category: the one whose own cues add up highest.
  let category: Category = 'other';
  let best = -1;
  for (const cue of scored) {
    const own = combineWeights(scored.filter((c2) => c2.category === cue.category).map(weightOf), ctx.supportFactor);
    if (own > best + 1e-9) {
      best = own;
      category = cue.category;
    }
  }

  const folded = foldForMatch(text);
  const foldedSubject = c.subject ? foldForMatch(c.subject) : '';
  let boost = 0;
  for (const booster of lexicon.boosters) {
    if (hasMatch(booster.re, folded) || (foldedSubject && hasMatch(booster.re, foldedSubject))) {
      boost += booster.weight;
      reasons.push({ rule: `boost:${booster.id}`, weight: booster.weight });
    }
  }
  boost = Math.min(boost, ctx.maxBoost);
  if (c.threadKind === 'direct' && ctx.directThread > 0) {
    boost += ctx.directThread;
    reasons.push({ rule: 'context:direct_thread', weight: ctx.directThread });
  }

  let score = base + boost;
  if (c.threadKind === 'group') {
    score *= ctx.groupThreadFactor;
    reasons.push({ rule: 'context:group_thread', weight: ctx.groupThreadFactor });
  }
  if (undirected) reasons.push({ rule: 'context:not_directed', weight: ctx.undirectedFactor });
  score = round(Math.min(1, Math.max(0, score)));

  // Caveats qualify surviving evidence; they are only raised when some exists.
  const caveats = new Set<Caveat>();
  const kinds = new Set(analysis.dampenings.map((d) => d.kind));
  if (kinds.has('sarcasm')) caveats.add('possible_sarcasm');
  if (kinds.has('apology')) caveats.add('apology');
  if (kinds.has('rejection')) caveats.add('rejection');
  if (kinds.has('transactional')) caveats.add('transactional');
  if (kinds.has('boilerplate')) caveats.add('boilerplate');
  if (kinds.has('coercion')) caveats.add('coercion');
  if (analysis.cues.some((cue) => cue.status === 'negated' && cue.weight >= NEGATION_CAVEAT_MIN)) caveats.add('negated');
  if (undirected) caveats.add('not_directed');
  if (c.threadKind === 'group') caveats.add('group_message');
  for (const d of analysis.dampenings) {
    if (d.kind === 'sarcasm' || d.kind === 'apology' || d.kind === 'rejection' || d.kind === 'coercion') {
      reasons.push({
        rule: `caveat:${d.kind}:${d.id}`,
        weight: 0,
        ...(d.source === 'text' ? { start: d.span.start, end: d.span.end } : {}),
      });
    }
  }

  const caveatList = [...caveats];
  const decision = decide(score, caveatList);

  if (decision === 'exclude') {
    return { ...excludedVerdict('low_score', reasons), score, category };
  }

  const span = selectQuote(text, analysis, live, weightOf);
  // Evidence has to be shown in the sender's own words; with no body to quote
  // (a warm subject line over an empty message) there is nothing to keep.
  if (span.end <= span.start) return { ...excludedVerdict('no_quote', reasons), score, category };
  return {
    decision,
    score,
    category,
    quote: text.slice(span.start, span.end),
    quoteStart: span.start,
    quoteEnd: span.end,
    reasons,
    caveats: caveatList,
    engine: 'rules',
  };
}
