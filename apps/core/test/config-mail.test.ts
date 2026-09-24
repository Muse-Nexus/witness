import { describe, expect, it } from 'vitest';
import { ConfigError, config, inboundAddressFor, inboundSlugOf, parseMailbox, type AppEnv } from '../src/env.js';
import { resendMailer } from '../src/mail/resend.js';
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
    expect(await ok.send({ kind: 'delivery', to: 'jordan@example.com', subject: 'Your witness for Tuesday', html: '<p>x</p>', text: 'x' })).toEqual({ id: 'msg_123' });
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ from: 'Witness <witness@example.com>', to: ['jordan@example.com'] });

    const failing = resendMailer('re_test_not_real', { name: '', email: 'witness@example.com' }, async () => new Response('{"message":"echo of the request"}', { status: 422 }));
    await expect(failing.send({ kind: 'delivery', to: 'jordan@example.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow('resend failed: HTTP 422');
  });
});

describe('email templates', () => {
  const links = {
    keep: 'https://w.example/d?t=k',
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
    expect(email.subject).toBe('Your witness for Tuesday');
    expect(email.html).toContain('You &lt;b&gt;matter&lt;/b&gt; &amp; you &quot;know&quot; it');
    expect(email.html).not.toContain('<b>matter</b>');
    const preheader = /<div style="display:none[^>]*>([^<]*)/.exec(email.html)?.[1] ?? '';
    expect(preheader).not.toContain('matter');
    expect(email.text).toContain('You chose this rhythm on September 1, 2026. Change it any time:');
    expect(email.text).toContain('Stop these emails: https://w.example/d?t=x');
  });

  it('open the plain-text part with neutral lines, so a text preview never shows the quote', () => {
    const quote = 'I love you, and I am so glad you are my sister. Synthetic example.';
    const email = renderDeliveryEmail({ weekday: 'Tuesday', quote, attribution: '— Dana · March 3, 2026 · Text', imageUrl: null, links, chosenOn: null });
    const preview = email.text.replace(/\s+/g, ' ').slice(0, 220);
    for (const word of ['love', 'sister', 'glad', 'Dana']) expect(preview).not.toContain(word);
    expect(email.text).toContain(`“${quote}”`);
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
      expect(email.text).toContain('988');
      expect(email.html).toContain('findahelpline.com');
      expect(email.html).toContain('Muse Nexus');
    }
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
