/**
 * @witness/detector: "is this evidence?" for Muse Nexus Witness (SPEC §6).
 */
import type { Category } from './types.js';

export type {
  Candidate,
  Category,
  Caveat,
  Channel,
  JudgeInput,
  JudgeResult,
  LexiconBooster,
  LexiconCategory,
  LexiconContext,
  LexiconData,
  LexiconDampeners,
  LexiconExclusions,
  LexiconHeaderRule,
  LexiconPattern,
  LexiconPhrase,
  LexiconRule,
  ModelJudge,
  Reason,
  Verdict,
} from './types.js';
export { CATEGORIES, MAX_TEXT_CHARS } from './types.js';

export {
  BLOCKING_CAVEATS,
  CAVEAT_MAYBE_FLOOR,
  MAYBE_THRESHOLD,
  SAVE_THRESHOLD,
  combineWeights,
  decide,
  detect,
  exclusionFor,
} from './rules.js';
export {
  DEFAULT_MODEL,
  JUDGE_OUTPUT_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
  MAX_JUDGE_TEXT,
  MODEL_MIN_CONFIDENCE,
  anthropicJudge,
  detectWithModel,
  isBorderline,
  parseJudgeResult,
  renderJudgeInput,
} from './model.js';
export type { AnthropicJudgeOptions } from './model.js';
export { decodeEntities, extractEmailEvidence, htmlToText, MAX_HTML_CHARS, offsetMinutesOf, parseAddress, parseMailDate } from './email.js';
export type { EmailEvidence, RawEmail } from './email.js';
export { GMAIL_FILTER_SUFFIX, cueTerms, gmailFilterQuery, gmailFilterTerms, plainCues, prefilter } from './filters.js';
export type { GmailTermSource } from './filters.js';
export type { PrefilterResult } from './filters.js';
export { dedupeKey, normalizeForDedupe } from './normalize.js';
export {
  DEFAULT_CONTEXT,
  DEFAULT_LEXICON_DATA,
  LexiconError,
  defaultLexicon,
  loadLexicon,
  phraseSource,
  portabilityProblem,
  validateLexicon,
} from './lexicon.js';
export type { Lexicon } from './lexicon.js';

export const CATEGORY_LABELS: Record<Category, string> = {
  love: 'Love',
  care: 'Care',
  pride: 'Pride',
  gratitude: 'Gratitude',
  trust: 'Trusted',
  belonging: 'Belonging',
  accomplishment: 'Accomplishment',
  recovery: 'Recovery',
  other: 'Other',
};
