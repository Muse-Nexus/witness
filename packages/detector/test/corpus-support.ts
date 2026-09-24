/**
 * Loading and scoring of the labeled corpus (corpus/*.jsonl). Pure functions so
 * the gate test and ad-hoc tuning scripts share one definition of the metrics.
 */
import { extractEmailEvidence } from '../src/email.js';
import { CATEGORIES } from '../src/types.js';
import type { Candidate, Category, Channel, Verdict } from '../src/types.js';

export type Decision = Verdict['decision'];

export interface CorpusExample {
  id: string;
  file: string;
  text: string;
  /** Email only: an HTML body, used when `text` is empty. */
  html?: string;
  subject?: string;
  channel: Channel;
  from?: { name?: string; handle?: string; isMe?: boolean };
  headers?: Record<string, string>;
  threadKind?: 'direct' | 'group';
  expect: Decision;
  category?: Category;
  /** A negative written to trip the detector; it must never be saved. */
  hard?: boolean;
  note?: string;
}

const CHANNELS: readonly Channel[] = ['email', 'text', 'ocr', 'manual', 'agent'];
const DECISIONS: readonly Decision[] = ['save', 'maybe', 'exclude'];

export function parseCorpus(raw: string, file: string): CorpusExample[] {
  return raw
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, index }) => {
      const where = `${file}:${index + 1}`;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`${where}: invalid JSON (${(error as Error).message})`);
      }
      if (typeof value.id !== 'string') throw new Error(`${where}: missing id`);
      if (typeof value.text !== 'string') throw new Error(`${where}: missing text`);
      if (!CHANNELS.includes(value.channel as Channel)) throw new Error(`${where}: bad channel`);
      if (!DECISIONS.includes(value.expect as Decision)) throw new Error(`${where}: bad expect`);
      if (value.category !== undefined && !(CATEGORIES as readonly string[]).includes(value.category as string)) {
        throw new Error(`${where}: bad category`);
      }
      if (value.hard === true && value.expect === 'save') throw new Error(`${where}: a hard negative cannot expect save`);
      return { ...(value as unknown as CorpusExample), file };
    });
}

/** Builds the detector input the way the core would: emails go through extraction first. */
export function toCandidate(example: CorpusExample): Candidate {
  if (example.channel !== 'email') {
    return {
      text: example.text,
      channel: example.channel,
      ...(example.subject ? { subject: example.subject } : {}),
      ...(example.from ? { from: example.from } : {}),
      ...(example.headers ? { headers: example.headers } : {}),
      ...(example.threadKind ? { threadKind: example.threadKind } : {}),
    };
  }
  const evidence = extractEmailEvidence({
    text: example.text,
    ...(example.html ? { html: example.html } : {}),
    ...(example.subject ? { subject: example.subject } : {}),
    ...(example.from ? { from: { name: example.from.name, address: example.from.handle } } : {}),
    headers: example.headers ?? {},
  });
  return {
    text: evidence.text,
    channel: 'email',
    ...(evidence.subject ? { subject: evidence.subject } : {}),
    from: { ...evidence.from, ...(example.from?.isMe ? { isMe: true } : {}) },
    headers: evidence.headers,
    ...(example.threadKind ? { threadKind: example.threadKind } : {}),
    ...(evidence.occurredAt !== undefined ? { occurredAt: evidence.occurredAt } : {}),
  };
}

export interface Row {
  example: CorpusExample;
  candidate: Candidate;
  verdict: Verdict;
}

export interface Metrics {
  total: number;
  confusion: Record<Decision, Record<Decision, number>>;
  saves: number;
  correctSaves: number;
  /** Share of save decisions whose label is save. 1 when nothing was saved. */
  savePrecision: number;
  positives: number;
  /** Share of save-labeled examples decided save or maybe. */
  positiveRecall: number;
  /** Share of save-labeled examples decided save. */
  autoSaveRate: number;
  hardNegatives: number;
  hardNegativeSaves: string[];
  falseSaves: string[];
  missedPositives: string[];
  categoryAgreement: number;
}

export function evaluate(examples: readonly CorpusExample[], run: (c: Candidate) => Verdict): { rows: Row[]; metrics: Metrics } {
  const rows = examples.map((example) => {
    const candidate = toCandidate(example);
    return { example, candidate, verdict: run(candidate) };
  });

  const confusion = Object.fromEntries(
    DECISIONS.map((expected) => [expected, Object.fromEntries(DECISIONS.map((d) => [d, 0]))]),
  ) as Record<Decision, Record<Decision, number>>;
  for (const { example, verdict } of rows) confusion[example.expect][verdict.decision] += 1;

  const saved = rows.filter((r) => r.verdict.decision === 'save');
  const correctSaves = saved.filter((r) => r.example.expect === 'save').length;
  const positives = rows.filter((r) => r.example.expect === 'save');
  const found = positives.filter((r) => r.verdict.decision !== 'exclude');
  const hard = rows.filter((r) => r.example.hard);
  const labeled = positives.filter((r) => r.example.category && r.verdict.decision !== 'exclude');

  return {
    rows,
    metrics: {
      total: rows.length,
      confusion,
      saves: saved.length,
      correctSaves,
      savePrecision: saved.length === 0 ? 1 : correctSaves / saved.length,
      positives: positives.length,
      positiveRecall: positives.length === 0 ? 1 : found.length / positives.length,
      autoSaveRate: positives.length === 0 ? 1 : positives.filter((r) => r.verdict.decision === 'save').length / positives.length,
      hardNegatives: hard.length,
      hardNegativeSaves: hard.filter((r) => r.verdict.decision === 'save').map((r) => r.example.id),
      falseSaves: saved.filter((r) => r.example.expect !== 'save').map((r) => r.example.id),
      missedPositives: positives.filter((r) => r.verdict.decision === 'exclude').map((r) => r.example.id),
      categoryAgreement:
        labeled.length === 0 ? 1 : labeled.filter((r) => r.verdict.category === r.example.category).length / labeled.length,
    },
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function formatSummary(name: string, m: Metrics): string {
  const pad = (s: string | number, width: number): string => String(s).padStart(width);
  const lines = [
    `${name}: ${m.total} examples, ${m.positives} positive, ${m.hardNegatives} hard negatives`,
    `  save precision ${pct(m.savePrecision)} (${m.correctSaves}/${m.saves})` +
      ` | positive recall (save+maybe) ${pct(m.positiveRecall)} | auto-saved ${pct(m.autoSaveRate)}` +
      ` | category agreement ${pct(m.categoryAgreement)}`,
    `  expected \\ decided     save   maybe exclude`,
    ...DECISIONS.map(
      (e) => `  ${e.padEnd(20)}${pad(m.confusion[e].save, 6)}${pad(m.confusion[e].maybe, 8)}${pad(m.confusion[e].exclude, 8)}`,
    ),
  ];
  if (m.falseSaves.length > 0) lines.push(`  false saves: ${m.falseSaves.join(', ')}`);
  if (m.hardNegativeSaves.length > 0) lines.push(`  HARD NEGATIVE SAVES: ${m.hardNegativeSaves.join(', ')}`);
  if (m.missedPositives.length > 0) lines.push(`  missed positives: ${m.missedPositives.join(', ')}`);
  return lines.join('\n');
}
