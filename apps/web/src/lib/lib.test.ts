import { describe, expect, it } from 'vitest';
import type { Status } from '../api/types';
import { buildAgentConfigs } from './agentConfigs';
import { safeConfirmationUrl } from './confirmation';
import { formatDate, formatLocalTime, formatUpcoming, relativeAgo, statusSentence } from './format';
import { GMAIL_FILTER_SUFFIX, gmailFilterQuery, gmailFilterTerms, plainCues } from '@witness/detector/gmail';
import { applyThemeOverride } from './theme';

const TZ = 'UTC';
const NOW = Date.UTC(2026, 8, 24, 15, 0); // Thursday, September 24, 2026
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('format', () => {
  it('keeps unknown dates unknown', () => {
    expect(formatDate(null)).toBe('Date unknown');
    expect(formatDate(Date.UTC(2026, 2, 4, 12), TZ)).toBe('March 4, 2026');
  });

  it('describes how long ago, plainly', () => {
    expect(relativeAgo(NOW - 20_000, NOW, TZ)).toBe('just now');
    expect(relativeAgo(NOW - 5 * 60_000, NOW, TZ)).toBe('5 minutes ago');
    expect(relativeAgo(NOW - 3 * HOUR, NOW, TZ)).toBe('3 hours ago');
    expect(relativeAgo(NOW - DAY, NOW, TZ)).toBe('yesterday');
    expect(relativeAgo(NOW - 2 * DAY, NOW, TZ)).toBe('2 days ago');
    expect(relativeAgo(NOW - 21 * DAY, NOW, TZ)).toBe('3 weeks ago');
    expect(relativeAgo(Date.UTC(2026, 0, 2, 12), NOW, TZ)).toBe('on January 2, 2026');
  });

  it('describes the next delivery', () => {
    expect(formatUpcoming(Date.UTC(2026, 8, 24, 18, 30), NOW, TZ)).toBe('today at 6:30 PM');
    expect(formatUpcoming(Date.UTC(2026, 8, 25, 8, 30), NOW, TZ)).toBe('tomorrow at 8:30 AM');
    expect(formatUpcoming(Date.UTC(2026, 8, 29, 8, 30), NOW, TZ)).toBe('Tuesday at 8:30 AM');
    expect(formatUpcoming(Date.UTC(2026, 9, 14, 8, 30), NOW, TZ)).toBe('October 14 at 8:30 AM');
  });

  it('formats rhythm times', () => {
    expect(formatLocalTime('08:30')).toBe('8:30 AM');
    expect(formatLocalTime('00:05')).toBe('12:05 AM');
    expect(formatLocalTime('17:45')).toBe('5:45 PM');
  });
});

describe('statusSentence', () => {
  const base: Status = {
    saved: 12,
    maybe: 3,
    lastCapturedAt: NOW - 2 * DAY,
    sources: [],
    rhythm: { enabled: true, nextAt: Date.UTC(2026, 8, 29, 8, 30), pausedUntil: null },
  };

  it('reads like the spec example', () => {
    const s = statusSentence(base, NOW, TZ);
    expect([s.lead, ...s.rest].join(' ')).toBe(
      'Witness is on. Something new came in 2 days ago. Next email Tuesday at 8:30 AM.',
    );
  });

  it('is plain when nothing has come in yet and no schedule is set', () => {
    const s = statusSentence({ ...base, saved: 0, maybe: 0, lastCapturedAt: null, rhythm: { enabled: false, nextAt: null, pausedUntil: null } }, NOW, TZ);
    expect(s.rest).toEqual(['Nothing has come in yet.', 'Nothing is emailed until you choose when.']);
  });

  it('does not say nothing came in when a source heard something it did not keep', () => {
    // Home lists "Email · 5 minutes ago" beside this for a newsletter that was not kept.
    const heard = { ...base, saved: 0, maybe: 0, lastCapturedAt: null, sources: [{ type: 'email' as const, lastAt: NOW - 5 * 60_000, count7d: 1 }] };
    const s = statusSentence(heard, NOW, TZ);
    expect(s.rest).toEqual(['Nothing kept yet.', 'Your first email comes after Witness keeps something.']);
  });

  it('never promises an email while nothing is kept', () => {
    // Witness sends nothing while nothing is kept (SAFETY §5), so the next slot is not an email.
    const s = statusSentence({ ...base, saved: 0, maybe: 2 }, NOW, TZ);
    const text = [s.lead, ...s.rest].join(' ');
    expect(text).not.toMatch(/Next email/);
    expect(s.rest.at(-1)).toBe('Nothing kept yet, so your first email comes after Witness keeps something.');
  });

  it('never counts the days since anything was kept', () => {
    const s = statusSentence({ ...base, lastCapturedAt: NOW - 49 * DAY }, NOW, TZ);
    const text = [s.lead, ...s.rest].join(' ');
    expect(text).not.toMatch(/weeks? ago|last kept|came in/);
    expect(s.rest[0]).toBe('It keeps things as they arrive.');
  });

  it('says when deliveries are paused', () => {
    const s = statusSentence({ ...base, rhythm: { ...base.rhythm, pausedUntil: NOW + 3 * DAY } }, NOW, TZ);
    expect(s.lead).toBe('Witness is paused until Sunday, September 27.');
    expect(s.rest.at(-1)).toBe('It still keeps what arrives, and sends nothing until then.');
  });
});

describe('gmail filter (from @witness/detector, lexicon.json)', () => {
  it('ORs the cues and leaves out bulk mail', () => {
    const q = gmailFilterQuery(['"thank you"', 'congrats']);
    expect(q).toBe(`("thank you" OR congrats) ${GMAIL_FILTER_SUFFIX}`);
    expect(GMAIL_FILTER_SUFFIX).toContain('-category:promotions');
    expect(GMAIL_FILTER_SUFFIX).toContain('-unsubscribe');
  });

  it('uses the shared lexicon terms by default', () => {
    expect(gmailFilterTerms.length).toBeGreaterThan(10);
    for (const term of gmailFilterTerms) expect(gmailFilterQuery()).toContain(term);
  });

  it('offers plain phrases for other mail apps', () => {
    expect(plainCues(['"thank you"', 'congrats', '"proud of you"'])).toEqual(['thank you', 'proud of you']);
  });
});

describe('assistant configs', () => {
  const configs = buildAgentConfigs('https://witness.example.com/', 'wit_agent_TEST');

  it('builds every paste-ready format from one URL and token', () => {
    expect(configs.claudeCode).toBe(
      'claude mcp add --transport http witness https://witness.example.com/mcp --header "Authorization: Bearer wit_agent_TEST"',
    );
    expect(configs.codex).toContain('[mcp_servers.witness]');
    expect(configs.codex).toContain('url = "https://witness.example.com/mcp"');
    expect(JSON.parse(configs.json)).toEqual({
      mcpServers: {
        witness: { type: 'http', url: 'https://witness.example.com/mcp', headers: { Authorization: 'Bearer wit_agent_TEST' } },
      },
    });
    expect(configs.curl).toContain('https://witness.example.com/api/v1/status');
  });
});

describe('theme override', () => {
  it('pins light or dark from ?theme= and ignores anything else', () => {
    const root = document.createElement('html');
    expect(applyThemeOverride('?theme=light', root)).toBe('light');
    expect(root.dataset.theme).toBe('light');
    expect(applyThemeOverride('?theme=sepia', root)).toBeNull();
    expect(root.dataset.theme).toBe('light');
  });
});

describe('confirmation links', () => {
  it('only links to Gmail forwarding-confirmation pages, over https', () => {
    expect(safeConfirmationUrl('https://mail-settings.google.com/mail/vf-abc')).toBe('https://mail-settings.google.com/mail/vf-abc');
    expect(safeConfirmationUrl('https://isolated.mail.google.com/mail/vf-abc')).toBe('https://isolated.mail.google.com/mail/vf-abc');
    // Pages anyone can write, or consent screens, on big providers' hosts are never linked.
    for (const planted of [
      'https://account.live.com/confirm',
      'https://login.live.com/oauth20_authorize.srf?client_id=x&scope=Mail.Read',
      'https://forms.office.com/r/abc',
      'https://www.icloud.com/notes/abc',
      'https://docs.google.com/mail/vf-abc',
      'https://mail.google.com/mail/u/0/#settings',
      'https://mail-settings.google.com:8443/mail/vf-abc',
      'https://user@mail-settings.google.com/mail/vf-abc',
    ]) {
      expect(safeConfirmationUrl(planted), planted).toBeNull();
    }
    expect(safeConfirmationUrl('http://mail.google.com/x')).toBeNull();
    expect(safeConfirmationUrl('https://google.com.evil.example/x')).toBeNull();
    expect(safeConfirmationUrl('javascript:alert(1)')).toBeNull();
    expect(safeConfirmationUrl(null)).toBeNull();
  });
});
