/**
 * Loads, validates and compiles lexicon.json.
 *
 * lexicon.json is shared with the Swift Mac helper, so every regex must behave
 * the same in JavaScript (no `u` flag) and ICU / NSRegularExpression. The
 * validator rejects constructs that are missing from one engine or that mean
 * different things in each (see LEXICON.md, "Portable regex").
 */
import lexiconJson from '../lexicon.json' with { type: 'json' };
import { CATEGORIES } from './types.js';
import type {
  Category,
  LexiconContext,
  LexiconData,
  LexiconHeaderRule,
  LexiconRule,
} from './types.js';

export interface CompiledCue {
  /** Stable id, e.g. "pride/phrase:so_proud_of_you" or "pride/proud_of_you_strong" (pattern). */
  ruleId: string;
  category: Exclude<Category, 'other'>;
  weight: number;
  implicit: boolean;
  kind: 'phrase' | 'pattern';
  re: RegExp;
}

export interface CompiledRule {
  id: string;
  re: RegExp;
}

export interface CompiledBooster extends CompiledRule {
  weight: number;
}

export interface Lexicon {
  readonly data: LexiconData;
  readonly cues: readonly CompiledCue[];
  readonly boosters: readonly CompiledBooster[];
  readonly secondPerson: RegExp;
  readonly negation: RegExp;
  readonly negationExceptions: RegExp | null;
  readonly negationWindow: number;
  readonly boilerplate: readonly CompiledRule[];
  readonly rejection: readonly CompiledRule[];
  readonly apology: readonly CompiledRule[];
  readonly sarcasm: readonly CompiledRule[];
  readonly transactional: readonly CompiledRule[];
  readonly notDirected: readonly CompiledRule[];
  readonly coercion: readonly CompiledRule[];
  readonly harm: readonly CompiledRule[];
  readonly senderPatterns: readonly CompiledRule[];
  readonly subjectPatterns: readonly CompiledRule[];
  readonly bodyPatterns: readonly CompiledRule[];
  readonly headerRules: ReadonlyArray<readonly [string, LexiconHeaderRule]>;
  readonly context: LexiconContext;
}

export const DEFAULT_CONTEXT: LexiconContext = {
  directThread: 0.05,
  groupThreadFactor: 0.8,
  undirectedFactor: 0.6,
  supportFactor: 0.6,
  maxBoost: 0.2,
  subjectFactor: 0.5,
};

export class LexiconError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid lexicon:\n- ${problems.join('\n- ')}`);
    this.name = 'LexiconError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Portable regex check
// ---------------------------------------------------------------------------

const isHighSurrogate = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= '\uD800' && ch <= '\uDBFF';

/**
 * Returns a human-readable reason when `source` is not portable between JS
 * (flags "gi", no "u") and ICU, or could backtrack badly, or null when it is fine.
 */
export function portabilityProblem(source: string): string | null {
  if (source.length === 0) return 'empty pattern';
  let i = 0;
  let inClass = false;
  // Whether the atom just before the current position can take a quantifier,
  // whether that atom was an astral (surrogate pair) character, and whether
  // it was a group.
  let canQuantify = false;
  let prevAstral = false;
  let prevGroup = false;

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) return 'trailing backslash';
      if (next === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
          return '\\u must be followed by exactly 4 hex digits (\\u{...} is not portable)';
        }
        i += 6;
      } else if (next === 'x') {
        if (!/^[0-9a-fA-F]{2}$/.test(source.slice(i + 2, i + 4))) {
          return '\\x must be followed by exactly 2 hex digits';
        }
        i += 4;
      } else if (/[1-9]/.test(next)) {
        if (inClass) return 'backreference inside a character class';
        i += 2;
      } else if (/[dDsSwWntrfv]/.test(next)) {
        i += 2;
      } else if (next === 'b' || next === 'B') {
        if (inClass) return '\\b inside a character class means different things in JS and ICU';
        i += 2;
      } else if (/[a-zA-Z0-9]/.test(next)) {
        return `escape \\${next} is not portable`;
      } else {
        i += 2; // escaped punctuation is a literal in both engines
      }
      canQuantify = !inClass;
      prevAstral = false;
      prevGroup = false;
      continue;
    }

    if (inClass) {
      if (ch === '[') return 'unescaped [ inside a character class (ICU reads it as a nested set)';
      if (ch === '&' && source[i + 1] === '&') return '&& inside a character class is ICU-only';
      if (ch === '-' && source[i + 1] === '-') return '-- inside a character class is ICU-only';
      if (isHighSurrogate(ch)) {
        return 'emoji or other astral characters inside [...] break in JS without the u flag; use (a|b) instead';
      }
      if (ch === ']') {
        inClass = false;
        canQuantify = true;
        prevAstral = false;
        prevGroup = false;
      }
      i += 1;
      continue;
    }

    switch (ch) {
      case '[': {
        const rest = source.slice(i + 1);
        if (rest.startsWith(']') || rest.startsWith('^]')) return 'empty character class';
        inClass = true;
        i += rest.startsWith('^') ? 2 : 1;
        continue;
      }
      case '(': {
        if (source[i + 1] === '?') {
          const kind = source[i + 2];
          if (kind === ':' || kind === '=' || kind === '!') {
            i += 3;
            canQuantify = false;
            continue;
          }
          if (kind === '<') {
            const after = source[i + 3];
            return after === '=' || after === '!'
              ? 'lookbehind is not portable'
              : 'named groups are not portable';
          }
          return `(?${kind ?? ''} group syntax is not portable (inline flags, atomic groups, named groups)`;
        }
        i += 1;
        canQuantify = false;
        continue;
      }
      case ')':
        i += 1;
        canQuantify = true;
        prevAstral = false;
        prevGroup = true;
        continue;
      case '|':
        i += 1;
        canQuantify = false;
        continue;
      case '}':
        return 'unescaped } outside a {n,m} quantifier';
      case '*':
      case '+':
      case '?':
      case '{': {
        let length = 1;
        if (ch === '{') {
          const interval = /^\{\d+(,\d*)?\}/.exec(source.slice(i));
          if (!interval) return 'unescaped { that is not a {n,m} quantifier';
          length = interval[0].length;
        }
        if (!canQuantify) return `quantifier ${ch} has nothing to repeat`;
        if (prevAstral) return 'quantifier after an emoji applies to half a character in JS; wrap it in (?:...)';
        const openEnded = ch === '*' || ch === '+' || /^\{\d+,\}/.test(source.slice(i));
        if (prevGroup && openEnded) {
          // "(so |really )*" rescans the whole chain from every start position.
          return 'unbounded repetition of a group can backtrack badly on long messages; use {0,4}';
        }
        i += length;
        if (source[i] === '+') return 'possessive quantifiers are not portable';
        if (source[i] === '?') i += 1; // lazy
        canQuantify = false;
        prevGroup = false;
        continue;
      }
      default:
        break;
    }

    prevGroup = false;
    if (isHighSurrogate(ch)) {
      i += 2;
      prevAstral = true;
    } else {
      i += 1;
      prevAstral = false;
    }
    canQuantify = true;
  }

  if (inClass) return 'unterminated character class';

  let compiled: RegExp;
  try {
    compiled = new RegExp(source, 'i');
  } catch (error) {
    return `does not compile in JS: ${(error as Error).message}`;
  }
  if (compiled.test('')) return 'matches the empty string';
  return null;
}

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\\/]/g;

/**
 * Turns a literal phrase into a portable regex source: whole words at the
 * edges, any whitespace for a space, optional apostrophes, and "-" matching a
 * hyphen, a space or nothing ("well-deserved" = "well deserved").
 */
export function phraseSource(phrase: string): string {
  const normalized = foldPhrase(phrase);
  let body = '';
  for (const ch of normalized) {
    if (ch === ' ') body += '\\s+';
    else if (ch === "'") body += "'?";
    else if (ch === '-') body += '[\\s\\-]?';
    else body += ch.replace(REGEX_SPECIALS, (m) => `\\${m}`);
  }
  const first = normalized[0] ?? '';
  const last = normalized[normalized.length - 1] ?? '';
  const edge = /[a-z0-9_]/i;
  return `${edge.test(first) ? '\\b' : ''}${body}${edge.test(last) ? '\\b' : ''}`;
}

function foldPhrase(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
}

export function slugify(phrase: string): string {
  const slug = foldPhrase(phrase)
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_');
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === '_') start++;
  while (end > start && slug[end - 1] === '_') end--;
  return end > start ? slug.slice(start, end) : 'phrase';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DAMPENER_LISTS = ['boilerplate', 'rejection', 'apology', 'sarcasm', 'transactional'] as const;
const OPTIONAL_DAMPENER_LISTS = ['notDirected', 'coercion', 'harm'] as const;
const EXCLUSION_LISTS = ['senderPatterns', 'subjectPatterns', 'bodyPatterns'] as const;
const CONTEXT_KEYS: readonly (keyof LexiconContext)[] = [
  'directThread',
  'groupThreadFactor',
  'undirectedFactor',
  'supportFactor',
  'maxBoost',
  'subjectFactor',
];
const ID = /^[a-z0-9_]+$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isWeight = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;

/** Returns every problem found; an empty list means the lexicon is valid. */
export function validateLexicon(data: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(data)) return ['lexicon must be a JSON object'];

  if (data.version !== 1) problems.push('version must be 1');
  if (typeof data.language !== 'string' || data.language.length === 0) {
    problems.push('language must be a non-empty string');
  }
  checkRegex('secondPerson', data.secondPerson, problems);

  const categories = data.categories;
  if (!isObject(categories)) {
    problems.push('categories must be an object');
  } else {
    for (const [name, value] of Object.entries(categories)) {
      if (!(CATEGORIES as readonly string[]).includes(name) || name === 'other') {
        problems.push(`categories.${name}: unknown category`);
        continue;
      }
      if (!isObject(value) || !Array.isArray(value.phrases) || !Array.isArray(value.patterns)) {
        problems.push(`categories.${name}: needs "phrases" and "patterns" arrays`);
        continue;
      }
      const seenPhrases = new Set<string>();
      value.phrases.forEach((entry: unknown, index: number) => {
        const where = `categories.${name}.phrases[${index}]`;
        if (!isObject(entry) || typeof entry.p !== 'string' || foldPhrase(entry.p).length === 0) {
          problems.push(`${where}: "p" must be a non-empty string`);
          return;
        }
        if (!isWeight(entry.w)) problems.push(`${where} "${entry.p}": "w" must be in (0, 1]`);
        if (entry.implicit !== undefined && typeof entry.implicit !== 'boolean') {
          problems.push(`${where}: "implicit" must be a boolean`);
        }
        const id = slugify(entry.p);
        if (seenPhrases.has(id)) problems.push(`${where} "${entry.p}": duplicate phrase in ${name}`);
        seenPhrases.add(id);
      });
      const seen = new Set<string>();
      value.patterns.forEach((entry: unknown, index: number) => {
        const where = `categories.${name}.patterns[${index}]`;
        if (!isObject(entry) || typeof entry.id !== 'string' || !ID.test(entry.id)) {
          problems.push(`${where}: "id" must match ${ID}`);
          return;
        }
        if (!isWeight(entry.w)) problems.push(`${where} ${entry.id}: "w" must be in (0, 1]`);
        if (entry.implicit !== undefined && typeof entry.implicit !== 'boolean') {
          problems.push(`${where}: "implicit" must be a boolean`);
        }
        if (seen.has(entry.id)) problems.push(`${where}: duplicate id ${entry.id} in ${name}`);
        seen.add(entry.id);
        checkRegex(`${where} ${entry.id}`, entry.re, problems);
      });
    }
  }

  if (!Array.isArray(data.boosters)) {
    problems.push('boosters must be an array');
  } else {
    checkRuleList('boosters', data.boosters, problems, true);
  }

  const dampeners = data.dampeners;
  if (!isObject(dampeners)) {
    problems.push('dampeners must be an object');
  } else {
    if (!isStringList(dampeners.negation) || dampeners.negation.length === 0) {
      problems.push('dampeners.negation must be a non-empty list of strings');
    }
    if (
      typeof dampeners.negationWindow !== 'number' ||
      !Number.isInteger(dampeners.negationWindow) ||
      dampeners.negationWindow < 1 ||
      dampeners.negationWindow > 8
    ) {
      problems.push('dampeners.negationWindow must be an integer from 1 to 8');
    }
    if (dampeners.negationExceptions !== undefined && !isStringList(dampeners.negationExceptions)) {
      problems.push('dampeners.negationExceptions must be a list of strings');
    }
    for (const list of DAMPENER_LISTS) {
      if (!Array.isArray(dampeners[list])) problems.push(`dampeners.${list} must be an array`);
      else checkRuleList(`dampeners.${list}`, dampeners[list] as unknown[], problems, false);
    }
    for (const list of OPTIONAL_DAMPENER_LISTS) {
      if (dampeners[list] === undefined) continue;
      if (!Array.isArray(dampeners[list])) problems.push(`dampeners.${list} must be an array`);
      else checkRuleList(`dampeners.${list}`, dampeners[list] as unknown[], problems, false);
    }
  }

  const exclusions = data.exclusions;
  if (!isObject(exclusions)) {
    problems.push('exclusions must be an object');
  } else {
    for (const list of EXCLUSION_LISTS) {
      if (!Array.isArray(exclusions[list])) problems.push(`exclusions.${list} must be an array`);
      else checkRuleList(`exclusions.${list}`, exclusions[list] as unknown[], problems, false);
    }
    if (!isObject(exclusions.headers)) {
      problems.push('exclusions.headers must be an object');
    } else {
      for (const [name, rule] of Object.entries(exclusions.headers)) {
        if (name !== name.toLowerCase()) problems.push(`exclusions.headers.${name}: header names must be lowercase`);
        const valid =
          rule === '*' ||
          isStringList(rule) ||
          (isObject(rule) && isStringList(rule.not) && Object.keys(rule).length === 1);
        if (!valid) problems.push(`exclusions.headers.${name}: must be "*", a list of values, or {"not": [...]}`);
      }
    }
  }

  if (data.context !== undefined) {
    if (!isObject(data.context)) {
      problems.push('context must be an object');
    } else {
      for (const [key, value] of Object.entries(data.context)) {
        if (!(CONTEXT_KEYS as readonly string[]).includes(key)) problems.push(`context.${key}: unknown key`);
        else if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
          problems.push(`context.${key}: must be a number from 0 to 1`);
        }
      }
    }
  }

  if (!isStringList(data.gmailFilterTerms) || data.gmailFilterTerms.length === 0) {
    problems.push('gmailFilterTerms must be a non-empty list of strings');
  }

  return problems;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0);
}

function checkRegex(where: string, source: unknown, problems: string[]): void {
  if (typeof source !== 'string') {
    problems.push(`${where}: "re" must be a string`);
    return;
  }
  const problem = portabilityProblem(source);
  if (problem) problems.push(`${where}: ${problem} (${source})`);
}

function checkRuleList(where: string, list: unknown[], problems: string[], weighted: boolean): void {
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isObject(entry) || typeof entry.id !== 'string' || !ID.test(entry.id)) {
      problems.push(`${at}: "id" must match ${ID}`);
      return;
    }
    if (seen.has(entry.id)) problems.push(`${at}: duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (weighted && !isWeight(entry.w)) problems.push(`${at} ${entry.id}: "w" must be in (0, 1]`);
    checkRegex(`${at} ${entry.id}`, entry.re, problems);
  });
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const compileRule = (rule: LexiconRule): CompiledRule => ({ id: rule.id, re: new RegExp(rule.re, 'gi') });

function alternation(terms: readonly string[]): RegExp {
  // Longest first so "no longer" wins over "no".
  const sources = [...terms].sort((a, b) => b.length - a.length).map(phraseSource);
  return new RegExp(sources.join('|'), 'gi');
}

/** Validates and compiles lexicon data. Throws LexiconError listing every problem. */
export function loadLexicon(data: unknown): Lexicon {
  const problems = validateLexicon(data);
  if (problems.length > 0) throw new LexiconError(problems);
  const lexicon = data as LexiconData;

  const cues: CompiledCue[] = [];
  for (const category of CATEGORIES) {
    if (category === 'other') continue;
    const entry = lexicon.categories[category];
    if (!entry) continue;
    for (const phrase of entry.phrases) {
      cues.push({
        ruleId: `${category}/phrase:${slugify(phrase.p)}`,
        category,
        weight: phrase.w,
        implicit: phrase.implicit === true,
        kind: 'phrase',
        re: new RegExp(phraseSource(phrase.p), 'gi'),
      });
    }
    for (const pattern of entry.patterns) {
      cues.push({
        ruleId: `${category}/${pattern.id}`,
        category,
        weight: pattern.w,
        implicit: pattern.implicit === true,
        kind: 'pattern',
        re: new RegExp(pattern.re, 'gi'),
      });
    }
  }

  const d = lexicon.dampeners;
  return {
    data: lexicon,
    cues,
    boosters: lexicon.boosters.map((b) => ({ ...compileRule(b), weight: b.w })),
    secondPerson: new RegExp(lexicon.secondPerson, 'gi'),
    negation: alternation(d.negation),
    negationExceptions:
      d.negationExceptions && d.negationExceptions.length > 0
        ? new RegExp(`^(?:${[...d.negationExceptions].sort((a, b) => b.length - a.length).map(phraseSource).join('|')})`, 'i')
        : null,
    negationWindow: d.negationWindow,
    boilerplate: d.boilerplate.map(compileRule),
    rejection: d.rejection.map(compileRule),
    apology: d.apology.map(compileRule),
    sarcasm: d.sarcasm.map(compileRule),
    transactional: d.transactional.map(compileRule),
    notDirected: (d.notDirected ?? []).map(compileRule),
    coercion: (d.coercion ?? []).map(compileRule),
    harm: (d.harm ?? []).map(compileRule),
    senderPatterns: lexicon.exclusions.senderPatterns.map(compileRule),
    subjectPatterns: lexicon.exclusions.subjectPatterns.map(compileRule),
    bodyPatterns: lexicon.exclusions.bodyPatterns.map(compileRule),
    headerRules: Object.entries(lexicon.exclusions.headers),
    context: { ...DEFAULT_CONTEXT, ...lexicon.context },
  };
}

let cachedDefault: Lexicon | null = null;

/** The bundled lexicon.json, validated and compiled once. */
export function defaultLexicon(): Lexicon {
  cachedDefault ??= loadLexicon(lexiconJson);
  return cachedDefault;
}

/** The raw bundled lexicon.json data (for tooling that needs the JSON itself). */
export const DEFAULT_LEXICON_DATA: unknown = lexiconJson;
