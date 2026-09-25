import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL,
  JUDGE_OUTPUT_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
  MAX_JUDGE_TEXT,
  anthropicJudge,
  detectWithModel,
  isBorderline,
  parseJudgeResult,
  renderJudgeInput,
} from '../src/model.js';
import { detect } from '../src/rules.js';
import type { Candidate, JudgeInput, JudgeResult, ModelJudge } from '../src/types.js';

/** Scores just under 0.5 in the rules stage: borderline, no caveats. */
const BORDERLINE: Candidate = {
  text: 'Thank you for volunteering every Friday. The kids light up when you walk in.',
  channel: 'agent',
};

function fakeJudge(result: JudgeResult | null | Error): ModelJudge & { calls: JudgeInput[] } {
  const calls: JudgeInput[] = [];
  return {
    calls,
    async judge(input) {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const accept = (overrides: Partial<JudgeResult> = {}): JudgeResult => ({
  isEvidence: true,
  directedAtRecipient: true,
  category: 'gratitude',
  quote: 'The kids light up when you walk in.',
  confidence: 0.92,
  ...overrides,
});

describe('detectWithModel', () => {
  it('starts from a borderline rules verdict', () => {
    const rules = detect(BORDERLINE);
    expect(rules.decision).toBe('maybe');
    expect(isBorderline(rules)).toBe(true);
  });

  it('promotes to save when the judge is confident and quotes an exact substring', async () => {
    const judge = fakeJudge(accept());
    const verdict = await detectWithModel(BORDERLINE, judge);
    expect(verdict.decision).toBe('save');
    expect(verdict.engine).toBe('rules+model');
    expect(verdict.quote).toBe('The kids light up when you walk in.');
    expect(BORDERLINE.text.slice(verdict.quoteStart, verdict.quoteEnd)).toBe(verdict.quote);
    expect(verdict.reasons.at(-1)).toEqual({ rule: 'model:accepted', weight: 0.92 });
    expect(judge.calls).toEqual([{ text: BORDERLINE.text, channel: 'agent' }]);
  });

  it('keeps the rules verdict when the quote is not verbatim', async () => {
    const verdict = await detectWithModel(BORDERLINE, fakeJudge(accept({ quote: 'The kids light up whenever you walk in.' })));
    expect(verdict.decision).toBe('maybe');
    expect(verdict.quote).toBe(detect(BORDERLINE).quote);
    expect(verdict.reasons.at(-1)?.rule).toBe('model:declined');
  });

  it.each<[string, Partial<JudgeResult>]>([
    ['low confidence', { confidence: 0.79 }],
    // 0.8 let warm stock pleasantries through (the 2026-09-25 evaluation, SPEC §6).
    ['below 0.9', { confidence: 0.89 }],
    ['not evidence', { isEvidence: false }],
    ['not aimed at the recipient', { directedAtRecipient: false }],
    ['empty quote', { quote: '   ' }],
  ])('does not promote on %s', async (_name, overrides) => {
    const verdict = await detectWithModel(BORDERLINE, fakeJudge(accept(overrides)));
    expect(verdict.decision).toBe('maybe');
    expect(verdict.engine).toBe('rules+model');
  });

  it('never demotes: a confident "not evidence" leaves maybe as maybe', async () => {
    const verdict = await detectWithModel(BORDERLINE, fakeJudge(accept({ isEvidence: false, confidence: 0.99 })));
    expect(verdict.decision).toBe('maybe');
  });

  it('falls back to the rules verdict on errors, null and malformed output', async () => {
    const rules = detect(BORDERLINE);
    expect(await detectWithModel(BORDERLINE, fakeJudge(new Error('network')))).toEqual(rules);
    expect(await detectWithModel(BORDERLINE, fakeJudge(null))).toEqual(rules);
    expect(await detectWithModel(BORDERLINE, fakeJudge({ ...accept(), category: 'joy' } as unknown as JudgeResult))).toEqual(rules);
  });

  it('keeps the rules category when the judge says "other"', async () => {
    const verdict = await detectWithModel(BORDERLINE, fakeJudge(accept({ category: 'other' })));
    expect(verdict.category).toBe(detect(BORDERLINE).category);
  });

  it('does not call the judge for clear saves, exclusions, or without a judge', async () => {
    const judge = fakeJudge(accept());
    await detectWithModel({ text: "I'm so proud of you.", channel: 'text', threadKind: 'direct' }, judge);
    await detectWithModel({ text: 'see you at 7', channel: 'text' }, judge);
    const excluded = await detectWithModel({ text: 'Thank you so much, you are amazing', channel: 'text', from: { isMe: true } }, judge);
    expect(judge.calls).toHaveLength(0);
    expect(excluded.decision).toBe('exclude');
    expect(await detectWithModel(BORDERLINE, null)).toEqual(detect(BORDERLINE));
  });

  it('does not let the judge overrule policy caveats like apology or sarcasm', async () => {
    const judge = fakeJudge(accept({ quote: 'You matter to me.' }));
    const apology: Candidate = { text: "I'm sorry I hurt you. I care about you.", channel: 'text' };
    const verdict = await detectWithModel(apology, judge);
    expect(verdict.decision).toBe('maybe');
    expect(judge.calls).toHaveLength(0);
  });

  it('never asks the judge about text longer than it would be shown', async () => {
    // The judge sees at most MAX_JUDGE_TEXT characters. A verdict on the first part of a
    // longer message could save words whose ending it never read, so the rules verdict stands.
    const long: Candidate = { ...BORDERLINE, text: `${BORDERLINE.text} ${'We talked about the bus schedule and the weather. '.repeat(130)}` };
    expect(long.text.length).toBeGreaterThan(MAX_JUDGE_TEXT);
    const rules = detect(long);
    expect(isBorderline(rules)).toBe(true);
    const judge = fakeJudge(accept());
    expect(await detectWithModel(long, judge)).toEqual(rules);
    expect(judge.calls).toHaveLength(0);
  });

  it('passes subject and sender name, never the handle', async () => {
    const judge = fakeJudge(null);
    await detectWithModel({ ...BORDERLINE, channel: 'email', subject: 'fridays', from: { name: 'Rafa', handle: 'rafa@example.com' } }, judge);
    expect(judge.calls[0]).toEqual({ text: BORDERLINE.text, channel: 'email', subject: 'fridays', fromName: 'Rafa' });
  });
});

describe('parseJudgeResult', () => {
  it('validates shape and clamps confidence', () => {
    expect(parseJudgeResult({ ...accept(), confidence: 1.4 })?.confidence).toBe(1);
    expect(parseJudgeResult({ ...accept(), confidence: Number.NaN })).toBeNull();
    expect(parseJudgeResult({ ...accept(), isEvidence: 'yes' })).toBeNull();
    expect(parseJudgeResult('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// anthropicJudge, against a fake fetch (no network)
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function fakeFetch(respond: (captured: Captured) => Response): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    requests.push(captured);
    return respond(captured);
  });
  return { fetch: impl as unknown as typeof fetch, requests };
}

const message = (text: string, stop_reason = 'end_turn'): Response =>
  new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_MODEL,
      content: [{ type: 'text', text }],
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const INPUT: JudgeInput = { text: BORDERLINE.text, channel: 'agent', fromName: 'Rafa' };

describe('anthropicJudge', () => {
  it('sends a small structured-output request to Haiku 4.5 and parses the answer', async () => {
    const { fetch, requests } = fakeFetch(() => message(JSON.stringify(accept())));
    const judge = anthropicJudge({ apiKey: 'sk-ant-test', baseURL: 'https://api.test', fetch, maxRetries: 0 });
    expect(await judge.judge(INPUT)).toEqual(accept());

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe('https://api.test/v1/messages');
    expect(request!.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(request!.body.model).toBe('claude-haiku-4-5');
    expect(request!.body.max_tokens).toBe(400);
    expect(request!.body.thinking).toBeUndefined();
    expect(request!.body.system).toEqual([{ type: 'text', text: JUDGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(request!.body.output_config).toEqual({ format: { type: 'json_schema', schema: JUDGE_OUTPUT_SCHEMA } });
    expect(request!.body.messages).toEqual([{ role: 'user', content: renderJudgeInput(INPUT) }]);
  });

  it('honors a configured model', async () => {
    const { fetch, requests } = fakeFetch(() => message(JSON.stringify(accept())));
    await anthropicJudge({ apiKey: 'k', baseURL: 'https://api.test', model: 'claude-sonnet-5', fetch }).judge(INPUT);
    expect(requests[0]!.body.model).toBe('claude-sonnet-5');
  });

  it.each<[string, () => Response]>([
    ['a refusal', () => message('', 'refusal')],
    ['truncated output', () => message('{"isEvidence": tr', 'max_tokens')],
    ['malformed JSON', () => message('not json')],
    ['a schema mismatch', () => message(JSON.stringify({ isEvidence: true }))],
    ['an API error', () => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' } }), { status: 500 })],
  ])('returns null on %s', async (_name, respond) => {
    const { fetch } = fakeFetch(respond);
    const judge = anthropicJudge({ apiKey: 'k', baseURL: 'https://api.test', fetch, maxRetries: 0 });
    expect(await judge.judge(INPUT)).toBeNull();
  });

  it('works end to end through detectWithModel', async () => {
    const { fetch } = fakeFetch(() => message(JSON.stringify(accept())));
    const judge = anthropicJudge({ apiKey: 'k', baseURL: 'https://api.test', fetch, maxRetries: 0 });
    expect((await detectWithModel(BORDERLINE, judge)).decision).toBe('save');
  });

  it('keeps untrusted text inside the message tags and bounds its length', () => {
    const rendered = renderJudgeInput({ text: 'x'.repeat(10_000), channel: 'text', subject: 'hi' });
    expect(rendered.startsWith('Channel: text\nSubject: hi\n<message>\n')).toBe(true);
    expect(rendered.endsWith('\n</message>')).toBe(true);
    expect(rendered.length).toBeLessThan(6100);
  });
});

describe('coercion is policy, not reading comprehension', () => {
  it('never sends a coercive message to the model judge', async () => {
    const { detect } = await import('../src/rules.js');
    const { isBorderline: borderline } = await import('../src/model.js');
    const v = detect({ text: "I love you, you're nothing without me.", channel: 'email', from: { handle: 'rowan@example.com' } });
    expect(v.caveats).toContain('coercion');
    expect(borderline(v)).toBe(false);
  });
});
