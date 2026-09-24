/**
 * Small text helpers shared by the scorer and span selection. All offsets are
 * UTF-16 indexes into the original string, so a span can always be sliced back
 * out of the candidate text verbatim.
 */

export interface Span {
  start: number;
  end: number;
}

/**
 * Folds typographic quotes to ASCII without changing string length, so offsets
 * found in the folded text are valid in the original. Swift consumers apply
 * the same folding before matching (see LEXICON.md).
 */
export function foldForMatch(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

export interface Match extends Span {
  text: string;
}

/** Every non-empty match of a global regex. Never mutates the regex. */
export function findAll(re: RegExp, text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

export function hasMatch(re: RegExp, text: string): boolean {
  return text.search(re) !== -1;
}

export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

export const contains = (outer: Span, inner: Span): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m', 'prof', 'mt', 'ft',
]);

/**
 * Splits text into sentence spans. A sentence ends at a line break, or after
 * . ! ? … (plus any closing quotes/brackets and trailing emoji) followed by
 * whitespace. Spans exclude surrounding whitespace; empty sentences are dropped.
 */
export function segmentSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;

  const push = (end: number): void => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s]!)) s += 1;
    while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
    if (e > s) spans.push({ start: s, end: e });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      push(i);
      start = i + 1;
      i += 1;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      let j = i;
      while (j < text.length && /[.!?…]/.test(text[j]!)) j += 1;
      // Closing quotes/brackets and emoji that ride on the end of a sentence.
      while (j < text.length && /["')\]”’]/.test(text[j]!)) j += 1;
      let k = j;
      while (k < text.length && text[k] !== '\n' && /\s/.test(text[k]!)) k += 1;
      const atEnd = k >= text.length;
      const boundary = atEnd || k > j || text[k] === '\n';
      if (boundary && !(ch === '.' && j - i === 1 && isAbbreviation(text, i))) {
        push(j);
        start = j;
        i = j;
        continue;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  push(text.length);
  return spans;
}

function isAbbreviation(text: string, dotIndex: number): boolean {
  let s = dotIndex;
  while (s > 0 && /[a-z.]/i.test(text[s - 1]!)) s -= 1;
  const word = text.slice(s, dotIndex);
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  // A single capital letter ("J. Smith") is an initial, not a sentence end.
  return /^[A-Z]$/.test(word);
}

/** Index of the sentence containing `offset`, or the nearest one before it. */
export function sentenceIndexAt(sentences: readonly Span[], offset: number): number {
  let found = 0;
  for (let i = 0; i < sentences.length; i += 1) {
    if (sentences[i]!.start <= offset) found = i;
    else break;
  }
  return found;
}
