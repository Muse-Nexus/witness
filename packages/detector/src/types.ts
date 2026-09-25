/**
 * Public types for the Muse Nexus Witness detector (docs/dev/SPEC.md §6).
 * Everything here is plain data so the core Worker, the web app and tests can
 * share it without pulling in the scorer.
 */

/**
 * The most text Witness reads from one message (characters). Every path uses this one limit:
 * the capture API refuses longer text, email whose words run past it is excluded, and
 * nothing is ever cut to fit, so a verdict is never made on the start of a message alone.
 */
export const MAX_TEXT_CHARS = 20_000;

export const CATEGORIES = [
  'love',
  'care',
  'pride',
  'gratitude',
  'trust',
  'belonging',
  'accomplishment',
  'recovery',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export type Channel = 'email' | 'text' | 'ocr' | 'manual' | 'agent';

export interface Candidate {
  /** The message body (for email: already stripped of quoted replies and signatures). */
  text: string;
  subject?: string;
  channel: Channel;
  from?: { name?: string; handle?: string; isMe?: boolean };
  /** Lowercased header names (email). */
  headers?: Record<string, string>;
  threadKind?: 'direct' | 'group';
  occurredAt?: number;
}

export type Caveat =
  | 'possible_sarcasm'
  | 'negated'
  | 'boilerplate'
  | 'apology'
  | 'group_message'
  | 'not_directed'
  | 'transactional'
  | 'rejection'
  | 'coercion'
  /** A soft stage-1 rule (a support@ sender, an invoice subject) sits beside words aimed at the reader. */
  | 'business_signal'
  /** A person paying the reader for their work: evidence, kept for a look, never saved automatically. */
  | 'payment';

/** One scoring step. `rule` never contains message text, so it is safe to store. */
export interface Reason {
  rule: string;
  weight: number;
  start?: number;
  end?: number;
}

export interface Verdict {
  decision: 'save' | 'maybe' | 'exclude';
  /** 0..1 */
  score: number;
  category: Category;
  /** Verbatim substring of candidate.text: the best evidence span. Empty when excluded. */
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  reasons: Reason[];
  caveats: Caveat[];
  /** Rule id when decision === 'exclude'. */
  excludedBy?: string;
  engine: 'rules' | 'rules+model';
}

export interface JudgeInput {
  text: string;
  subject?: string;
  channel: Channel;
  fromName?: string;
}

export interface JudgeResult {
  isEvidence: boolean;
  directedAtRecipient: boolean;
  category: Category;
  /** Must be an exact substring of the judged text or it is ignored. */
  quote: string;
  /** 0..1 */
  confidence: number;
}

export interface ModelJudge {
  /** Resolve null (or throw) when no judgement is available; the rules verdict then stands. */
  judge(input: JudgeInput): Promise<JudgeResult | null>;
}

// ---------------------------------------------------------------------------
// lexicon.json (schema v1). See LEXICON.md for field-by-field documentation.
// ---------------------------------------------------------------------------

export interface LexiconPhrase {
  /** Literal phrase. Whole-word, case-insensitive; spaces match any whitespace; apostrophes optional. */
  p: string;
  /** Weight in (0, 1]. */
  w: number;
  /** True when the phrase is addressed to the reader even without "you" (e.g. "congrats"). */
  implicit?: boolean;
}

export interface LexiconPattern {
  id: string;
  /** Portable regex source (JS and ICU/NSRegularExpression). Matched case-insensitively. */
  re: string;
  w: number;
  implicit?: boolean;
}

export interface LexiconCategory {
  phrases: LexiconPhrase[];
  patterns: LexiconPattern[];
}

export interface LexiconRule {
  id: string;
  re: string;
}

export interface LexiconBooster extends LexiconRule {
  w: number;
}

export interface LexiconDampeners {
  /** Words or short phrases that negate a cue that follows them within `negationWindow` words. */
  negation: string[];
  negationWindow: number;
  /** Phrases that start with a negation word but do not negate (e.g. "can't believe"). */
  negationExceptions?: string[];
  boilerplate: LexiconRule[];
  rejection: LexiconRule[];
  apology: LexiconRule[];
  sarcasm: LexiconRule[];
  transactional: LexiconRule[];
  /** Phrasing that aims a cue at someone other than the recipient ("congrats to Priya"). */
  notDirected?: LexiconRule[];
  /**
   * Control, guilt, insults and conditional love next to kind words ("you're nothing
   * without me", "love you but you're a disappointment"). Raises the blocking
   * `coercion` caveat, so the message is never saved automatically, and the quote
   * keeps those words instead of trimming them away.
   */
  coercion?: LexiconRule[];
  /**
   * Violence, threats, self-harm and farewell warnings. A message with any of these
   * is never evidence, whatever kind words sit beside it: it is excluded.
   */
  harm?: LexiconRule[];
  /**
   * A person paying the reader ("sending the last $300 for the website", "paid invoice
   * #12"). Raises the blocking `payment` caveat: being paid for your work is evidence,
   * but it waits in maybe and is never saved automatically. Receipts, bills and a
   * payment processor's own mail are excluded before this (stage 1, `transactional`).
   */
  payment?: LexiconRule[];
}

/** "*": header present. string[]: value equals one of these. {not}: value is anything but these. */
export type LexiconHeaderRule = '*' | string[] | { not: string[] };

export interface LexiconExclusionRule extends LexiconRule {
  /**
   * A business-sounding signal that kind mail from a person can carry too (a support@
   * sender, an invoice subject, a corporate signature). A soft rule excludes a message
   * only when it holds no strong words aimed at the reader; otherwise the message is
   * held in maybe with the `business_signal` caveat, never saved. Collector prefilters
   * skip soft rules and leave the call to the server. Rules without it are hard: bulk
   * or automated mail (list headers, no-reply senders, codes) is always excluded.
   */
  soft?: boolean;
}

export interface LexiconExclusions {
  senderPatterns: LexiconExclusionRule[];
  subjectPatterns: LexiconExclusionRule[];
  bodyPatterns: LexiconExclusionRule[];
  headers: Record<string, LexiconHeaderRule>;
}

/** Scoring knobs that are not tied to a single phrase. All optional; defaults in lexicon.ts. */
export interface LexiconContext {
  /** Added once when threadKind is 'direct'. */
  directThread: number;
  /** Multiplies the final score for group threads. */
  groupThreadFactor: number;
  /** Multiplies cue weights when no surviving cue is aimed at the recipient. */
  undirectedFactor: number;
  /** How much supporting cues add on top of the strongest one (0 = strongest cue only). */
  supportFactor: number;
  /** Cap on the sum of booster weights. */
  maxBoost: number;
  /** Multiplies weights of cues found only in an email subject. */
  subjectFactor: number;
}

export interface LexiconData {
  version: 1;
  language: string;
  /** Regex source for a second-person reference ("you", "your", "u"...). Used for directedness. */
  secondPerson: string;
  categories: Partial<Record<Exclude<Category, 'other'>, LexiconCategory>>;
  boosters: LexiconBooster[];
  dampeners: LexiconDampeners;
  exclusions: LexiconExclusions;
  context?: Partial<LexiconContext>;
  gmailFilterTerms: string[];
}
