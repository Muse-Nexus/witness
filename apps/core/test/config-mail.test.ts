import { describe, expect, it } from 'vitest';
import { ConfigError, config, inboundAddressFor, inboundSlugOf, parseMailbox, type AppEnv } from '../src/env.js';
import { MailError } from '../src/mail/index.js';
import { RESEND_TIMEOUT_MS, resendMailer } from '../src/mail/resend.js';
import { DELIVERY_CLAIM_MS } from '../src/store/rhythm.js';
import { CRISIS_LINE } from '../src/templates/brand.js';
import { renderDeliveryEmail, renderMagicLinkEmail } from '../src/templates/email.js';
import { testEnv, visibleText } from './helpers.js';

function envWith(vars: Partial<AppEnv>): AppEnv {
  return { ...testEnv, ...vars };
}

describe('config', () => {
  it('parses vars with safe defaults', () => {
    const cfg = config(envWith({ SIGNUPS: 'invite', ALLOWED_EMAILS: ' A@example.com, b@example.com ,', APP_URL: 'https://witness.example.com' }));
    expect(cfg.signups).toBe('invite');
    expect([...cfg.allowedEmails]).toEqual(['a@example.com', 'b@example.com']);
    expect(cfg.secureCookies).toBe(true);
    expect(cfg.devOutbox).toBe(false);
    expect(cfg.mailFrom).toEqual({ name: 'Witness', email: 'witness@example.com' });
  });

  it('keeps the model judge off without a key', () => {
    expect(config(envWith({ WITNESS_JUDGE: 'anthropic', ANTHROPIC_API_KEY: '' })).judge).toBe('none');
    expect(config(envWith({ WITNESS_JUDGE: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real' })).judge).toBe('anthropic');
  });

  it('rejects unknown values instead of guessing', () => {
    expect(() => config(envWith({ MAILER: 'carrier-pigeon' }))).toThrow(ConfigError);
    expect(() => config(envWith({ APP_URL: 'not a url' }))).toThrow(ConfigError);
    expect(() => parseMailbox('nobody')).toThrow(ConfigError);
    expect(parseMailbox('witness@example.com')).toEqual({ name: '', email: 'witness@example.com' });
  });
});

describe('inbound address style', () => {
  it('defaults to plus addresses on one mailbox', () => {
    const cfg = config(envWith({ INBOUND_ADDRESS_STYLE: '', INBOUND_PLUS_USER: '' }));
    expect(cfg.inboundAddressStyle).toBe('plus');
    expect(cfg.inboundPlusUser).toBe('witness');
    expect(inboundAddressFor(cfg, 'k3v9q2m7xa')).toBe('witness+k3v9q2m7xa@in.example.com');
  });

  it('shows local addresses when configured, and a custom plus mailbox', () => {
    expect(inboundAddressFor(config(envWith({ INBOUND_ADDRESS_STYLE: 'local' })), 'k3v9q2m7xa')).toBe('k3v9q2m7xa@in.example.com');
    expect(inboundAddressFor(config(envWith({ INBOUND_PLUS_USER: 'Kept' })), 'k3v9q2m7xa')).toBe('kept+k3v9q2m7xa@in.example.com');
  });

  it('accepts both forms whatever the style, and nothing else', () => {
    for (const style of ['plus', 'local']) {
      const cfg = config(envWith({ INBOUND_ADDRESS_STYLE: style }));
      expect(inboundSlugOf(cfg, 'witness+k3v9q2m7xa@in.example.com')).toBe('k3v9q2m7xa');
      expect(inboundSlugOf(cfg, 'Witness+K3V9Q2M7XA@IN.example.com')).toBe('k3v9q2m7xa');
      expect(inboundSlugOf(cfg, 'witness+k3v9q2m7xa+gmail@in.example.com')).toBe('k3v9q2m7xa');
      expect(inboundSlugOf(cfg, 'k3v9q2m7xa@in.example.com')).toBe('k3v9q2m7xa');
      expect(inboundSlugOf(cfg, 'k3v9q2m7xa+tag@in.example.com')).toBe('k3v9q2m7xa');
      expect(inboundSlugOf(cfg, 'someone+k3v9q2m7xa@in.example.com')).toBeNull();
      expect(inboundSlugOf(cfg, 'witness@in.example.com')).toBeNull();
      expect(inboundSlugOf(cfg, 'witness+short@in.example.com')).toBeNull();
      expect(inboundSlugOf(cfg, 'witness+k3v9q2m7xa@example.org')).toBeNull();
    }
  });

  it('rejects an unknown style or an unusable mailbox name', () => {
    expect(() => config(envWith({ INBOUND_ADDRESS_STYLE: 'wildcard' }))).toThrow(ConfigError);
    expect(() => config(envWith({ INBOUND_PLUS_USER: 'wit+ness' }))).toThrow(ConfigError);
    expect(() => config(envWith({ INBOUND_PLUS_USER: 'wit ness' }))).toThrow(ConfigError);
  });
});

describe('Resend mailer', () => {
  it('posts the message and keeps only the status on failure', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = resendMailer('re_test_not_real', { name: 'Witness', email: 'witness@example.com' }, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ id: 'msg_123' });
    });
    expect(await ok.send({ kind: 'delivery', to: 'jordan@example.com', subject: 'Something you kept, for Tuesday', html: '<p>x</p>', text: 'x' })).toEqual({ id: 'msg_123' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ from: 'Witness <witness@example.com>', to: ['jordan@example.com'] });

    const failing = resendMailer('re_test_not_real', { name: '', email: 'witness@example.com' }, async () => new Response('{"message":"echo of the request"}', { status: 422 }));
    await expect(failing.send({ kind: 'delivery', to: 'jordan@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow('resend failed: HTTP 422');
  });

  it('gives up on a send that hangs, well inside the delivery claim', async () => {
    expect(RESEND_TIMEOUT_MS).toBeLessThanOrEqual(DELIVERY_CLAIM_MS / 4);
    let signal: AbortSignal | undefined;
    const hanging = resendMailer(
      're_test_not_real',
      { name: '', email: 'witness@example.com' },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(signal!.reason));
        }),
      20,
    );
    await expect(hanging.send({ kind: 'delivery', to: 'jordan@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow(
      new MailError('resend failed: timeout'),
    );
    expect(signal?.aborted).toBe(true);
  });
});

describe('email templates', () => {
  /** Markup removed without adding spaces, for sentences that carry links. */
  const tagsOff = (html: string) => html.replace(/<[^>]+>/g, '');
  const links = {
    skip: 'https://w.example/d?t=s',
    pause: 'https://w.example/d?t=p',
    remove: 'https://w.example/d?t=r',
    stop: 'https://w.example/d?t=x',
    block: null,
    open: 'https://w.example/app',
    settings: 'https://w.example/app/settings',
  };

  it('escape evidence and keep it out of the subject and preheader', () => {
    const email = renderDeliveryEmail({
      weekday: 'Tuesday',
      quote: 'You <b>matter</b> & you "know" it',
      attribution: '— Sam · March 3, 2026 · Text message',
      imageUrl: null,
      links,
      chosenOn: 'September 1, 2026',
    });
    expect(email.subject).toBe('Something you kept, for Tuesday');
    expect(email.html).toContain('You &lt;b&gt;matter&lt;/b&gt; &amp; you &quot;know&quot; it');
    expect(email.html).not.toContain('<b>matter</b>');
    const preheader = /<div style="display:none[^>]*>([^<]*)/.exec(email.html)?.[1] ?? '';
    expect(preheader).not.toContain('matter');
    expect(preheader).toContain('From the schedule you set in Witness.');
    expect(email.text).toContain('You chose this schedule on September 1, 2026. Change it any time: https://w.example/app/settings');
    expect(email.text).toContain('Stop these emails: https://w.example/d?t=x');
    expect(tagsOff(email.html)).toContain('You chose this schedule on September 1, 2026. Change it any time, or stop these emails.');
  });

  it('name each link for what it does, and have no link that only seems to be needed', () => {
    const email = renderDeliveryEmail({ weekday: 'Tuesday', quote: 'Thank you.', attribution: '— Someone · Date unknown · Email', imageUrl: null, links, chosenOn: null });
    const visible = visibleText(email.html);
    for (const [label, href] of [
      ['Skip the next one', links.skip],
      ['Pause a week', links.pause],
      ['Remove this from Witness', links.remove],
      ['Open Witness', links.open],
    ] as const) {
      expect(email.text).toContain(`${label}: ${href}`);
      expect(email.html).toContain(`href="${href}"`);
      expect(visible).toContain(label);
    }
    // A one-off says so, with the same two ways out.
    expect(tagsOff(email.html)).toContain('You asked Witness to send this one. Change your schedule any time, or stop these emails.');
    expect(email.text).toContain('You asked Witness to send this one. Change your schedule any time: https://w.example/app/settings');
    for (const old of ['Keep them coming', 'Not today', 'Remove this one', 'rhythm']) {
      expect(email.text).not.toContain(old);
      expect(visible).not.toContain(old);
    }
  });

  it('open the plain-text part with neutral lines, so a text preview never shows the quote', () => {
    const quote = 'I love you, and I am so glad you are my sister. Synthetic example.';
    const email = renderDeliveryEmail({ weekday: 'Tuesday', quote, attribution: '— Dana · March 3, 2026 · Text', imageUrl: null, links, chosenOn: 'September 1, 2026' });
    // Inbox lists and lock screens collapse whitespace, so blank lines alone would not hold the quote back.
    const preview = email.text.replace(/\s+/g, ' ').slice(0, 400);
    for (const word of ['love', 'sister', 'glad', 'Dana']) expect(preview).not.toContain(word);
    expect(email.text).toContain(`“${quote}”`);
    // What comes before the quote is only the wordmark, the schedule line and the crisis line; the rest looks blank.
    const before = email.text.slice(0, email.text.indexOf('“'));
    expect(before.replace(/[\u034F\u200C]/g, '').replace(/\s+/g, ' ').trim()).toBe(
      'MUSE NEXUS Witness. From the schedule you set in Witness. If you are in crisis, call or text 988 (US) or visit findahelpline.com.',
    );
  });

  it('open a one-off the person asked for with what happened, not a schedule there may not be', () => {
    const email = renderDeliveryEmail({ weekday: 'Tuesday', quote: 'Thank you.', attribution: '— Someone · Date unknown · Email', imageUrl: null, links, chosenOn: null });
    const preheader = /<div style="display:none[^>]*>([^<]*)/.exec(email.html)?.[1] ?? '';
    expect(preheader).toContain('You asked Witness to send this one.');
    const before = email.text.slice(0, email.text.indexOf('“'));
    expect(before.replace(/[\u034F\u200C]/g, '').replace(/\s+/g, ' ').trim()).toBe(
      'MUSE NEXUS Witness. You asked Witness to send this one. If you are in crisis, call or text 988 (US) or visit findahelpline.com.',
    );
    expect(email.text).not.toContain('From the schedule');
    expect(email.html).not.toContain('From the schedule');
  });

  it('give an image-only delivery a way to see it in Witness, and offer blocking only for a known sender', () => {
    const image = renderDeliveryEmail({ weekday: 'Tuesday', quote: '', attribution: '— Someone · Date unknown · Photo', imageUrl: 'https://w.example/i.png', links, chosenOn: null });
    expect(image.text).toContain('See it in Witness: https://w.example/app');
    expect(visibleText(image.html)).toContain('See it in Witness');
    expect(image.text).not.toContain('Never save from them');
    const known = renderDeliveryEmail({ weekday: 'Tuesday', quote: 'Thank you.', attribution: '— Dana · Date unknown · Email', imageUrl: null, links: { ...links, block: 'https://w.example/d?t=b' }, chosenOn: null });
    expect(known.text).toContain('Never save from them: https://w.example/d?t=b');
  });

  it('load nothing from elsewhere (no web fonts or pixels that report an open)', () => {
    const delivery = renderDeliveryEmail({ weekday: 'Tuesday', quote: 'Thank you.', attribution: '— Someone · Date unknown · Email', imageUrl: null, links, chosenOn: null });
    const signIn = renderMagicLinkEmail({ link: 'https://w.example/auth/callback?token=wit_link_x', minutes: 15 });
    for (const email of [delivery, signIn]) {
      expect(email.html).not.toContain('fonts.googleapis.com');
      expect(email.html).not.toMatch(/<link\b/i);
    }
  });

  it('use calm words: no exclamation marks, always the crisis line', () => {
    const delivery = renderDeliveryEmail({ weekday: 'Tuesday', quote: 'Thank you.', attribution: '— Someone · Date unknown · Email', imageUrl: null, links, chosenOn: null });
    const signIn = renderMagicLinkEmail({ link: 'https://w.example/auth/callback?token=wit_link_x', minutes: 15 });
    for (const email of [delivery, signIn]) {
      expect(visibleText(email.html)).not.toContain('!');
      expect(email.text).not.toContain('!');
      expect(email.text).toContain(CRISIS_LINE);
      expect(email.html).toContain('Muse Nexus');
      // The same words in HTML, where "call" and "text" open the phone's dialer and messages.
      const footer = /<p[^>]*>(If you are in crisis,[\s\S]*?)<\/p>/.exec(email.html)?.[1] ?? '';
      expect(tagsOff(footer)).toBe(CRISIS_LINE);
      expect(footer).toMatch(/<a href="tel:988"[^>]*>call<\/a>/);
      expect(footer).toMatch(/<a href="sms:988"[^>]*>text<\/a>/);
      expect(footer).toMatch(/<a href="https:\/\/findahelpline\.com"[^>]*>findahelpline\.com<\/a>/);
    }
  });

  it('say how long a sign-in link works, and that it works once', () => {
    const email = renderMagicLinkEmail({ link: 'https://w.example/auth/callback?token=wit_link_x', minutes: 15 });
    expect(email.subject).toBe('Your sign-in link for Witness');
    expect(email.text).toContain('It works once, for the next 15 minutes.');
    expect(visibleText(email.html)).toContain('It works once, for the next 15 minutes.');
  });
});

describe('log mailer outside local development', () => {
  it('never prints a sign-in link or keeps mail unless it is local', async () => {
    const { logMailer, readOutbox } = await import('../src/mail/log.js');
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const before = readOutbox().length;
      await logMailer(false).send({ kind: 'magic_link', to: 'jordan@example.com', subject: 's', html: 'h', text: 't', devLink: 'https://w.example/auth/callback?token=wit_link_x' });
      expect(readOutbox().length).toBe(before);
      expect(lines.join('\n')).not.toContain('wit_link_');
      await logMailer(true).send({ kind: 'magic_link', to: 'jordan@example.com', subject: 's', html: 'h', text: 't', devLink: 'http://localhost:8787/auth/callback?token=wit_link_y' });
      expect(lines.join('\n')).toContain('wit_link_y');
    } finally {
      console.log = original;
    }
  });

  it('refuses a public host with local-only settings', async () => {
    const { assertServesHost } = await import('../src/env.js');
    const local = config(envWith({ APP_URL: 'http://localhost:8787', MAILER: 'log' }));
    expect(() => assertServesHost(local, new URL('http://localhost:8787/x'))).not.toThrow();
    expect(() => assertServesHost(local, new URL('https://w.workers.dev/x'))).toThrow(ConfigError);
    const logOnPublic = config(envWith({ APP_URL: 'https://witness.example.com', MAILER: 'log' }));
    expect(() => assertServesHost(logOnPublic, new URL('https://witness.example.com/x'))).toThrow(/MAILER=log/);
    const ready = config(envWith({ APP_URL: 'https://witness.example.com', MAILER: 'resend' }));
    expect(() => assertServesHost(ready, new URL('https://witness.example.com/x'))).not.toThrow();
  });
});

describe('parseMailbox on hostile or quoted input', () => {
  it('parses a quoted display name', () => {
    expect(parseMailbox('"Muse Nexus Witness" <hello@witness.example.com>')).toEqual({
      name: 'Muse Nexus Witness',
      email: 'hello@witness.example.com',
    });
  });

  it('stays fast on a long hostile value', () => {
    const start = performance.now();
    expect(() => parseMailbox('<!@'.repeat(100_000) + ' '.repeat(100_000))).toThrow(ConfigError);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
