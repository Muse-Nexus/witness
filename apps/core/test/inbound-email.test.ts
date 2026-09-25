import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { UNKNOWN_SENDER_REJECT, envelopeAuthentication, handleInboundEmail, isAutoForward } from '../src/inbound-email.js';
import { asUser, call, signIn, testEnv, type Session } from './helpers.js';

interface FakeMessage extends ForwardableEmailMessage {
  rejected: string | null;
}

/** A synthetic inbound message as Email Routing would hand it to the Worker. */
function inbound(input: { from: string; to: string; raw: string }): FakeMessage {
  const bytes = new TextEncoder().encode(input.raw.replace(/\r?\n/g, '\r\n'));
  const headerBlock = input.raw.split(/\r?\n\r?\n/)[0] ?? '';
  const headers = new Headers();
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) headers.append(m[1]!, m[2]!);
  }
  const message = {
    from: input.from,
    to: input.to,
    headers,
    raw: new Response(bytes).body!,
    rawSize: bytes.length,
    rejected: null as string | null,
    setReject(reason: string) {
      message.rejected = reason;
    },
    forward: () => Promise.reject(new Error('not used')),
    reply: () => Promise.reject(new Error('not used')),
  };
  return message as unknown as FakeMessage;
}

function mail(lines: string[]): string {
  return lines.join('\n');
}

async function inboundAddress(session: Session): Promise<string> {
  const me = (await (await call('/api/v1/me', asUser(session))).json()) as { inboundAddress: string };
  return me.inboundAddress;
}

async function items(session: Session, status = 'saved') {
  return ((await (await call(`/api/v1/items?status=${status}`, asUser(session))).json()) as { items: Record<string, unknown>[] }).items;
}

describe('inbound email', () => {
  it('keeps nothing from mail longer than Witness reads, rather than reading only the start', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const filler = Array.from({ length: 450 }, () => 'We walked along the beach and talked about the week ahead.');
    const message = inbound({
      from: session.email,
      to,
      raw: mail([
        'From: Grace Okafor <grace.okafor@example.com>',
        `To: ${session.email}`,
        'Subject: thank you',
        'Date: Sun, 14 Sep 2026 20:11:05 -0400',
        'Message-ID: <long-1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        "I'm so proud of you. Seriously. You showed up every single day for this.",
        '',
        ...filler,
        '',
        'If you leave, you will regret it.',
      ]),
    });
    const result = await handleInboundEmail(message, testEnv);
    expect(message.rejected).toBeNull();
    expect(result).toEqual({ outcome: 'captured', result: { status: 'excluded', reason: 'too_long' } });
    expect(await items(session)).toEqual([]);
    expect(await items(session, 'maybe')).toEqual([]);
  });

  it('saves evidence auto-forwarded from an allowed sender, with the original sender and date', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const message = inbound({
      from: session.email, // Gmail auto-forward: envelope sender is the person's own address
      to,
      raw: mail([
        'From: Grace Okafor <grace.okafor@example.com>',
        `To: ${session.email}`,
        'Subject: thank you',
        'Date: Sun, 14 Sep 2026 20:11:05 -0400',
        'Message-ID: <thanks-1@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hi Jordan,',
        '',
        'I wanted to write and say thank you properly. When I was falling apart in March you checked on me every single day. I don\'t think I would have made it through that month without you.',
        '',
        'With love,',
        'Grace',
      ]),
    });
    const result = await handleInboundEmail(message, testEnv);
    expect(message.rejected).toBeNull();
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'saved', category: 'gratitude' } });

    const [item] = await items(session);
    expect(item).toMatchObject({ fromName: 'Grace Okafor', sourceType: 'email', sourceLabel: 'Email', occurredAt: Date.UTC(2026, 8, 15, 0, 11, 5) });
    expect(String(item!.quote)).toContain('without you');
    expect(String(item!.quote)).not.toContain('With love');

    // The same message again is a duplicate (original Message-ID).
    const again = await handleInboundEmail(
      inbound({ from: session.email, to, raw: mail(['From: Grace Okafor <grace.okafor@example.com>', 'Subject: thank you', 'Message-ID: <thanks-1@example.com>', '', 'Thank you, truly, for everything you did for me.']) }),
      testEnv,
    );
    expect(again).toMatchObject({ outcome: 'captured', result: { status: 'duplicate' } });
  });

  it('keeps the original sender of a manual forward', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const result = await handleInboundEmail(
      inbound({
        from: session.email, // the person pressed Forward and sent it here themself
        to,
        raw: mail([
          `From: Jordan Lee <${session.email}>`,
          'Subject: Fwd: Your reference',
          'Message-ID: <fwd-1@example.com>',
          '',
          'saving this one',
          '',
          '---------- Forwarded message ---------',
          'From: Owen Hart <owen.hart@example.org>',
          'Date: Mon, 7 Sep 2026 at 09:15',
          'Subject: Your reference',
          `To: Jordan Lee <${session.email}>`,
          '',
          'Hi Priya, I just got off the phone with the hiring manager. I recommended you without hesitation, because you are the most reliable person I have ever worked with. Thank you for trusting me with this.',
        ]),
      }),
      testEnv,
    );
    expect(result.outcome).toBe('captured');
    const all = [...(await items(session)), ...(await items(session, 'maybe'))];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ fromName: 'Owen Hart', canBlockSender: true });
    expect(String(all[0]!.quote)).not.toContain('saving this one');
  });

  /** A Gmail "Forward" the person pressed and sent to their Witness address themself. */
  const manualForward = (owner: string, from: string, body: string[], id = crypto.randomUUID()) =>
    mail([
      `From: Jordan Lee <${owner}>`,
      'Subject: Fwd: today',
      `Message-ID: <${id}@example.com>`,
      '',
      '---------- Forwarded message ---------',
      `From: ${from}`,
      'Date: Tue, Sep 22, 2026 at 5:40 PM',
      'Subject: today',
      `To: Jordan Lee <${owner}>`,
      '',
      ...body,
    ]);

  it('keeps kind words the person forwards themself, credited to who wrote them, even with no stock phrase', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const calm = 'You were the calmest person in the room today. The whole team noticed, and so did I.';
    const result = await handleInboundEmail(
      inbound({ from: session.email, to, raw: manualForward(session.email, 'Rosa Delgado <rosa.delgado@example.com>', [calm]) }),
      testEnv,
    );
    expect(result).toMatchObject({ outcome: 'captured', result: { status: expect.stringMatching(/^(saved|maybe)$/) } });
    const all = [...(await items(session)), ...(await items(session, 'maybe'))];
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ fromName: 'Rosa Delgado', sourceType: 'email', canBlockSender: true });
    expect(String(all[0]!.quote)).toContain('calmest person in the room');

    // Words with no cue at all: a forward the person chose is kept whole in maybe, still credited.
    const plain = 'I keep thinking about the way you walked me through the numbers on Friday. The week felt lighter after that.';
    const chosen = await handleInboundEmail(
      inbound({ from: session.email, to, raw: manualForward(session.email, 'Owen Hart <owen.hart@example.org>', [plain]) }),
      testEnv,
    );
    expect(chosen).toMatchObject({ outcome: 'captured', result: { status: 'maybe', quote: plain } });
    const [kept] = (await items(session, 'maybe')).filter((i) => i.quote === plain);
    expect(kept).toMatchObject({ fromName: 'Owen Hart', canBlockSender: true });
  });

  it('does not keep the same words when a filter forwards them automatically (nothing chose them)', async () => {
    const session = await signIn();
    const plain = 'I keep thinking about the way you walked me through the numbers on Friday. The week felt lighter after that.';
    const result = await handleInboundEmail(
      inbound({
        from: session.email.replace('@', '+caf_=witness@'), // Gmail filter auto-forward
        to: await inboundAddress(session),
        raw: mail([
          'From: Owen Hart <owen.hart@example.org>',
          `X-Forwarded-To: ${session.email}`,
          'Subject: Friday',
          `Message-ID: <${crypto.randomUUID()}@example.org>`,
          '',
          plain,
        ]),
      }),
      testEnv,
    );
    expect(result).toEqual({ outcome: 'captured', result: { status: 'excluded', reason: 'no_cue' } });
    expect(await items(session)).toHaveLength(0);
    expect(await items(session, 'maybe')).toHaveLength(0);
  });

  it("does not keep a note the person writes themself just because they sent it: those are their words, not someone else's", async () => {
    const session = await signIn();
    const note = 'Coach Ruiz stopped me after practice to say the team plays calmer when I am on the bench.';
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: mail([`From: Jordan Lee <${session.email}>`, 'Subject: note to self', `Message-ID: <${crypto.randomUUID()}@example.com>`, '', note]),
      }),
      testEnv,
    );
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'excluded' } });
    expect(await items(session, 'maybe')).toHaveLength(0);
  });

  it('does not keep a forward whose words are all ">" quotes just because it was forwarded: they may be quoted history', async () => {
    const session = await signIn();
    const plain = 'I keep thinking about the way you walked me through the numbers on Friday. The week felt lighter after that.';
    const result = await handleInboundEmail(
      inbound({ from: session.email, to: await inboundAddress(session), raw: manualForward(session.email, 'Owen Hart <owen.hart@example.org>', [`> ${plain}`]) }),
      testEnv,
    );
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'excluded' } });
    expect(await items(session, 'maybe')).toHaveLength(0);
  });

  it('never keeps a threat the person forwards, whatever kind words sit beside it', async () => {
    const session = await signIn();
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: manualForward(session.email, 'Cal Vance <cal.vance@example.net>', ['I love you and I miss you. Answer me or I\'m coming over tonight.']),
      }),
      testEnv,
    );
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'excluded', reason: expect.stringMatching(/^harm:/) } });
    expect(await items(session)).toHaveLength(0);
    expect(await items(session, 'maybe')).toHaveLength(0);
  });

  it('never keeps the person\'s own words quoted inside a reply they forward', async () => {
    const session = await signIn();
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: manualForward(session.email, 'Rosa Vega <rosa.vega@example.org>', [
          'Got them, thanks.',
          '',
          `On Mon, Sep 21, 2026 at 8:00 PM Jordan Lee <${session.email}> wrote:`,
          '> Rosa, I am so proud of you. These drawings are the best work you have done.',
        ]),
      }),
      testEnv,
    );
    expect(result.outcome).toBe('captured');
    const all = [...(await items(session)), ...(await items(session, 'maybe'))];
    expect(await items(session)).toHaveLength(0);
    for (const item of all) {
      expect(item).toMatchObject({ fromName: 'Rosa Vega' });
      expect(String(item.quote)).not.toMatch(/proud|best work/);
    }
  });

  it('rejects mail from an unknown sender', async () => {
    const session = await signIn();
    const message = inbound({
      from: 'stranger@example.net',
      to: await inboundAddress(session),
      raw: mail(['From: Stranger <stranger@example.net>', 'Subject: hello', '', 'I am so proud of you.']),
    });
    const result = await handleInboundEmail(message, testEnv);
    expect(message.rejected).toBe(UNKNOWN_SENDER_REJECT);
    expect(result).toEqual({ outcome: 'rejected', reason: 'unknown_sender' });
    const event = await env.DB.prepare('SELECT outcome, reason FROM inbound_events WHERE user_id = ?1').bind(session.userId).first();
    expect(event).toEqual({ outcome: 'rejected', reason: 'unknown_sender' });
  });

  it('shows a plus address and accepts mail at both address styles', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    expect(to).toMatch(/^witness\+[a-z0-9]{10}@in\.example\.com$/);
    const slug = /^witness\+([a-z0-9]{10})@/.exec(to)![1]!;
    const kinds = [
      [to, 'You showed up for me every single day this month. Thank you so much, truly.'],
      [`${slug}@in.example.com`, 'I am so proud of you for finishing the course. You worked so hard for it.'],
    ] as const;
    for (const [address, words] of kinds) {
      const message = inbound({
        from: session.email,
        to: address,
        raw: mail(['From: Lea Park <lea.park@example.com>', `To: ${session.email}`, 'Subject: hi', `Message-ID: <${crypto.randomUUID()}@example.com>`, '', words]),
      });
      const result = await handleInboundEmail(message, testEnv);
      expect(message.rejected).toBeNull();
      // Accepted and scored (the address is what this test is about, not the verdict).
      expect(result).toMatchObject({ outcome: 'captured', result: { status: expect.stringMatching(/^(saved|maybe)$/) } });
    }
    const kept = [...(await items(session)), ...(await items(session, 'maybe'))].map((i) => i.quote);
    // One kept per address, each a verbatim span of what was sent.
    expect(kept).toHaveLength(2);
    for (const [, words] of kinds) expect(kept.some((q) => typeof q === 'string' && words.includes(q))).toBe(true);
  });

  it('rejects mail to an address that does not exist', async () => {
    for (const to of ['zzzzzzzzzz@in.example.com', 'witness+zzzzzzzzzz@in.example.com', 'witness@in.example.com']) {
      const message = inbound({ from: 'someone@example.com', to, raw: mail(['Subject: hi', '', 'hello']) });
      await handleInboundEmail(message, testEnv);
      expect(message.rejected).toBe('Unknown recipient');
    }
  });

  it('captures a Gmail forwarding confirmation for the web app, with a safe link only', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const message = inbound({
      from: 'forwarding-noreply@google.com',
      to,
      raw: mail([
        'From: Gmail Team <forwarding-noreply@google.com>',
        `Subject: (#482913577) Gmail Forwarding Confirmation - Receive Mail from ${session.email}`,
        '',
        `${session.email} has requested to automatically forward mail to your email address ${to}.`,
        'Confirmation code: 482913577',
        '',
        'To allow this, please click the link below to confirm the request:',
        '',
        'https://mail-settings.google.com/mail/vf-%5BANGjdJ_synthetic_example%5D-QmFzZTY0',
        '',
        'If you click the link and it appears to be broken, please copy and paste it into a new browser window.',
      ]),
    });
    const result = await handleInboundEmail(message, testEnv);
    expect(result).toEqual({ outcome: 'confirmation', provider: 'gmail' });
    expect(message.rejected).toBeNull();

    const res = await call('/api/v1/inbound/confirmations', asUser(session));
    expect(await res.json()).toEqual({
      provider: 'gmail',
      url: 'https://mail-settings.google.com/mail/vf-%5BANGjdJ_synthetic_example%5D-QmFzZTY0',
      code: '482913577',
      receivedAt: expect.any(Number),
    });
    const row = await env.DB.prepare('SELECT url_ct, code_ct FROM pending_confirmations WHERE user_id = ?1').bind(session.userId).first<{ url_ct: string; code_ct: string }>();
    expect(row?.url_ct).toMatch(/^v1\./);
    expect(row?.code_ct).not.toContain('482913577');
  });

  it('never keeps a confirmation link that points somewhere else', async () => {
    const session = await signIn();
    await handleInboundEmail(
      inbound({
        from: 'forwarding-noreply@google.com',
        to: await inboundAddress(session),
        raw: mail([
          'From: Gmail Team <forwarding-noreply@google.com>',
          'Subject: Gmail Forwarding Confirmation',
          '',
          'Confirmation code: 123456',
          'https://evil.example/mail/vf-steal',
          'https://mail.google.com/mail/u/0/#settings',
        ]),
      }),
      testEnv,
    );
    const confirmation = (await (await call('/api/v1/inbound/confirmations', asUser(session))).json()) as { url?: string; code?: string };
    expect(confirmation.url).toBeUndefined();
    expect(confirmation.code).toBe('123456');
  });

  it('answers null when no confirmation has arrived', async () => {
    const session = await signIn();
    expect(await (await call('/api/v1/inbound/confirmations', asUser(session))).json()).toBeNull();
  });

  it('excludes newsletters that a filter forwards', async () => {
    const session = await signIn();
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: mail([
          'From: The Weekly Digest <news@digest.example.com>',
          'Subject: Thank you for being a subscriber',
          'List-Unsubscribe: <https://digest.example.com/unsubscribe>',
          'List-Id: weekly.digest.example.com',
          'Message-ID: <news-1@digest.example.com>',
          '',
          'Thank you so much for being part of our community. We are so grateful for readers like you.',
        ]),
      }),
      testEnv,
    );
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'excluded' } });
    expect(await items(session)).toHaveLength(0);
    expect(await items(session, 'maybe')).toHaveLength(0);
  });

  it('ignores Witness deliveries that a filter loops back in', async () => {
    const session = await signIn();
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: mail(['From: Witness <witness@example.com>', 'X-Witness-Mail: delivery', 'Subject: Your witness for Tuesday', '', '“I am so proud of you.”']),
      }),
      testEnv,
    );
    expect(result).toEqual({ outcome: 'ignored', reason: 'witness_mail' });
  });

  it('keeps a photo the person emails in themself in maybe (the header From is not proof of who sent it)', async () => {
    const session = await signIn();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: mail([
          `From: Jordan Lee <${session.email}>`,
          'Subject: this one',
          'Message-ID: <photo-1@example.com>',
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="b1"',
          '',
          '--b1',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'from the recital',
          '--b1',
          'Content-Type: image/png; name="recital.png"',
          'Content-Disposition: attachment; filename="recital.png"',
          'Content-Transfer-Encoding: base64',
          '',
          png,
          '--b1--',
        ]),
      }),
      testEnv,
    );
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'maybe' } });
    expect(await items(session)).toHaveLength(0);
    const [item] = await items(session, 'maybe');
    expect(item).toMatchObject({ kind: 'image', hasMedia: true, mediaType: 'image/png', sourceLabel: 'Email', quote: null });
  });

  it('runs through the Worker email() handler', async () => {
    const session = await signIn();
    const message = inbound({ from: 'stranger@example.net', to: await inboundAddress(session), raw: mail(['Subject: hi', '', 'hello']) });
    const ctx = createExecutionContext();
    await worker.email(message, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(message.rejected).toBe(UNKNOWN_SENDER_REJECT);
  });

  it('never trusts an auto-forwarded message that claims to be from the owner (a spoofed From)', async () => {
    const session = await signIn();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const message = inbound({
      from: session.email.replace('@', '+caf_=witness@'), // Gmail filter auto-forward
      to: await inboundAddress(session),
      raw: mail([
        `From: Jordan Lee <${session.email}>`,
        `X-Forwarded-To: ${session.email}`,
        'Subject: so proud of you',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'I am so proud of you.',
        '--b1',
        'Content-Type: image/png; name="x.png"',
        'Content-Disposition: attachment; filename="x.png"',
        'Content-Transfer-Encoding: base64',
        '',
        png,
        '--b1--',
      ]),
    });
    const result = await handleInboundEmail(message, testEnv);
    expect(result).toEqual({ outcome: 'captured', result: { status: 'excluded', reason: 'from_owner_unverified' } });
    expect(await items(session)).toHaveLength(0);
    expect(await items(session, 'maybe')).toHaveLength(0);
  });

  it('never credits a "Forwarded message" block inside someone else\'s auto-forwarded mail to the person it names', async () => {
    const session = await signIn();
    const result = await handleInboundEmail(
      inbound({
        from: session.email.replace('@', '+caf_=witness@'),
        to: await inboundAddress(session),
        raw: mail([
          'From: Sam Stranger <sam@elsewhere.example>',
          `X-Forwarded-To: ${session.email}`,
          'Subject: a note',
          'Date: Mon, 21 Sep 2026 10:00:00 -0700',
          '',
          'I am so proud of you for everything you did for the team this year.',
          '',
          '---------- Forwarded message ---------',
          'From: Mom <mom@example.com>',
          'Date: Dec 25, 2025',
          '',
          'I am so proud of you. You are the best thing that ever happened to me.',
        ]),
      }),
      testEnv,
    );
    // Credited to who actually sent it, and held for a look rather than saved outright.
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'maybe' } });
    expect(await items(session)).toHaveLength(0);
    const [item] = await items(session, 'maybe');
    expect(item).toMatchObject({ fromName: 'Sam Stranger', occurredAt: Date.UTC(2026, 8, 21, 17, 0, 0), canBlockSender: true });
    expect(String(item!.quote)).not.toContain('best thing');

    // "Never save from this sender" now stops the real sender, not the person they named.
    const blocked = await call(`/api/v1/items/${String(item!.id)}/block-sender`, asUser(session, { method: 'POST', body: {} }));
    expect(blocked.status).toBe(200);
    const again = await handleInboundEmail(
      inbound({
        from: session.email.replace('@', '+caf_=witness@'),
        to: await inboundAddress(session),
        raw: mail(['From: Sam Stranger <sam@elsewhere.example>', 'Subject: again', '', 'I am so proud of you, truly, you mean the world to me.']),
      }),
      testEnv,
    );
    expect(again).toMatchObject({ outcome: 'captured', result: { status: 'blocked' } });
  });

  it('reads a forwarded Gmail date that has no zone in the forwarder\'s zone', async () => {
    const session = await signIn();
    await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: mail([
          `From: Jordan Lee <${session.email}>`,
          'Subject: Fwd: thank you',
          'Date: Wed, 16 Sep 2026 06:10:00 -1000',
          '',
          '---------- Forwarded message ---------',
          'From: Lea Park <lea.park@example.com>',
          'Date: Wed, Sep 16, 2026 at 1:30 AM',
          'Subject: thank you',
          '',
          'Thank you so much for sitting with me at the hospital all night. I could not have done it without you.',
        ]),
      }),
      testEnv,
    );
    const [item] = [...(await items(session)), ...(await items(session, 'maybe'))];
    // 1:30 AM in the forwarder's zone (-10:00), not 1:30 AM UTC (the evening before, there).
    expect(item).toMatchObject({ fromName: 'Lea Park', occurredAt: Date.UTC(2026, 8, 16, 11, 30, 0) });
  });

  it('holds mail for review when Cloudflare\'s own result does not tie it to the envelope sender', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const words = 'I am so proud of you. You mean the world to me, and I could not have done this year without you.';
    const spoofed = await handleInboundEmail(
      inbound({
        from: session.email,
        to,
        raw: mail([
          'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=attacker.example header.s=s1; spf=softfail smtp.mailfrom=' + session.email + '; dmarc=pass header.from=attacker.example',
          'From: Lea Park <lea@attacker.example>',
          'Subject: hi',
          `Message-ID: <${crypto.randomUUID()}@example.com>`,
          '',
          words,
        ]),
      }),
      testEnv,
    );
    expect(spoofed).toMatchObject({ outcome: 'captured', result: { status: 'maybe' } });

    const genuine = await handleInboundEmail(
      inbound({
        from: session.email,
        to,
        raw: mail([
          'ARC-Authentication-Results: i=2; mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1; spf=pass smtp.mailfrom=' + session.email,
          'ARC-Authentication-Results: i=1; mx.google.com; arc=none',
          'From: Lea Park <lea.park@example.com>',
          'Subject: hi',
          `Message-ID: <${crypto.randomUUID()}@example.com>`,
          '',
          words.replace('this year', 'this spring'),
        ]),
      }),
      testEnv,
    );
    expect(genuine).toMatchObject({ outcome: 'captured', result: { status: 'saved' } });
  });

  it('keeps only a code, never a link, from Outlook- or iCloud-looking mail anyone can send', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const planted = await handleInboundEmail(
      inbound({
        from: 'stranger@outlook.com',
        to,
        raw: mail([
          'From: Stranger <stranger@outlook.com>',
          'Subject: Confirm forwarding',
          '',
          'Your code is 55512345.',
          'https://login.live.com/oauth20_authorize.srf?client_id=synthetic&scope=Mail.Read',
          'https://forms.office.com/r/synthetic',
        ]),
      }),
      testEnv,
    );
    expect(planted).toEqual({ outcome: 'confirmation', provider: 'outlook' });
    const outlook = (await (await call('/api/v1/inbound/confirmations?provider=outlook', asUser(session))).json()) as { url?: string; code?: string };
    expect(outlook.url).toBeUndefined();
    expect(outlook.code).toBe('55512345');
    // It never shows up in place of Gmail's.
    expect(await (await call('/api/v1/inbound/confirmations?provider=gmail', asUser(session))).json()).toBeNull();
  });

  it('only takes a Gmail confirmation from Gmail\'s own From address', async () => {
    const session = await signIn();
    const message = inbound({
      from: 'forwarding-noreply@google.com',
      to: await inboundAddress(session),
      raw: mail([
        'From: Gmail Team <someone@attacker.example>',
        'Subject: Gmail Forwarding Confirmation',
        '',
        'Confirmation code: 123456',
        'https://mail-settings.google.com/mail/vf-synthetic',
      ]),
    });
    expect(await handleInboundEmail(message, testEnv)).toEqual({ outcome: 'rejected', reason: 'unknown_sender' });
    expect(await (await call('/api/v1/inbound/confirmations', asUser(session))).json()).toBeNull();
  });

  it('stops showing a confirmation after a day', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    await handleInboundEmail(
      inbound({
        from: 'forwarding-noreply@google.com',
        to,
        raw: mail(['From: Gmail Team <forwarding-noreply@google.com>', 'Subject: Gmail Forwarding Confirmation', '', 'Confirmation code: 123456', 'https://mail-settings.google.com/mail/vf-old']),
      }),
      testEnv,
      dayAgo,
    );
    expect(await (await call('/api/v1/inbound/confirmations', asUser(session))).json()).toBeNull();
  });
});

describe('authentication and auto-forward signals', () => {
  it('reads only Cloudflare\'s own result, aligned with the envelope domain', () => {
    const h = (value: string, key = 'arc-authentication-results') => ({ key, value });
    expect(envelopeAuthentication([], 'lee@example.com')).toBe('unknown');
    expect(envelopeAuthentication([h('i=1; mx.google.com; arc=none')], 'lee@example.com')).toBe('unknown');
    expect(envelopeAuthentication([h('i=1; mx.cloudflare.net; spf=pass smtp.mailfrom=lee@example.com')], 'lee@example.com')).toBe('pass');
    expect(envelopeAuthentication([h('mx.cloudflare.net; dkim=pass header.d=example.com', 'authentication-results')], 'lee+caf_=x@mail.example.com')).toBe('pass');
    expect(envelopeAuthentication([h('i=1; mx.cloudflare.net; dkim=pass header.d=attacker.example; spf=softfail smtp.mailfrom=lee@example.com')], 'lee@example.com')).toBe('fail');
    // The topmost Cloudflare result wins over one that came inside the message.
    expect(
      envelopeAuthentication(
        [h('i=2; mx.cloudflare.net; spf=fail smtp.mailfrom=lee@example.com'), h('i=1; mx.cloudflare.net; spf=pass smtp.mailfrom=lee@example.com')],
        'lee@example.com',
      ),
    ).toBe('fail');
  });

  it('recognises Gmail auto-forwards', () => {
    expect(isAutoForward('lee+caf_=witness=in.example.com@gmail.com', {})).toBe(true);
    expect(isAutoForward('lee@gmail.com', { 'x-forwarded-to': 'lee@gmail.com' })).toBe(true);
    expect(isAutoForward('lee@gmail.com', {})).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Whose words (SAFETY §1): synthetic raw mail, one per way a client quotes the owner
// ---------------------------------------------------------------------------

/** The owner's own words, quoted back in each reply below. Misread, they would be saved. */
const OWNER_WORDS = 'Ana, I am so proud of you. You deserve every bit of this.';

function reply(owner: string, headerLines: string[], body: { text?: string[]; html?: string }): string {
  const content = body.html !== undefined
    ? ['Content-Type: text/html; charset=utf-8', '', body.html]
    : ['Content-Type: text/plain; charset=utf-8', '', ...body.text!];
  return mail([
    'From: Ana Duarte <ana.duarte@example.com>',
    `To: Sam Rivera <${owner}>`,
    'Date: Mon, 1 Sep 2026 10:30:00 -0500',
    'MIME-Version: 1.0',
    ...headerLines,
    ...content,
  ]);
}

const QUOTING_CLIENTS: Record<string, (owner: string) => string> = {
  'Spanish Gmail': (owner) =>
    reply(owner, ['Subject: Re: felicidades', 'Message-ID: <es-gmail@example.com>'], {
      text: ['Gracias, de verdad.', '', `El lun, 1 sept 2026 a las 9:00, Sam Rivera (<${owner}>) escribió:`, '', OWNER_WORDS],
    }),
  'French Gmail': (owner) =>
    reply(owner, ['Subject: Re: bravo', 'Message-ID: <fr-gmail@example.com>'], {
      text: ['Merci, vraiment.', '', `Le lun. 1 sept. 2026 à 09:00, Sam Rivera <${owner}> a écrit :`, '', OWNER_WORDS],
    }),
  'German Gmail': (owner) =>
    reply(owner, ['Subject: Re: Gratulation', 'Message-ID: <de-gmail@example.com>'], {
      text: ['Danke dir.', '', `Am Mo., 1. Sept. 2026 um 09:00 Uhr schrieb Sam Rivera <${owner}>:`, '', OWNER_WORDS],
    }),
  'Portuguese Gmail': (owner) =>
    reply(owner, ['Subject: Re: parabens', 'Message-ID: <pt-gmail@example.com>'], {
      text: ['Obrigada, de verdade.', '', `Em seg., 1 de set. de 2026 às 09:00, Sam Rivera <${owner}> escreveu:`, '', OWNER_WORDS],
    }),
  'Spanish Outlook': (owner) =>
    reply(owner, ['Subject: RE: felicidades', 'Message-ID: <es-outlook@example.com>'], {
      text: [
        'Gracias, de verdad.',
        '',
        '________________________________',
        `De: Sam Rivera <${owner}>`,
        'Enviado: lunes, 1 de septiembre de 2026 9:00',
        'Para: Ana Duarte <ana.duarte@example.com>',
        'Asunto: felicidades',
        '',
        OWNER_WORDS,
      ],
    }),
  'German Outlook': (owner) =>
    reply(owner, ['Subject: AW: Gratulation', 'Message-ID: <de-outlook@example.com>'], {
      text: ['Danke dir.', '', `Von: Sam Rivera <${owner}>`, 'Gesendet: Montag, 1. September 2026 09:00', 'An: Ana Duarte <ana.duarte@example.com>', 'Betreff: Gratulation', '', OWNER_WORDS],
    }),
  'French Outlook': (owner) =>
    reply(owner, ['Subject: RE: bravo', 'Message-ID: <fr-outlook@example.com>'], {
      text: ['Merci, vraiment.', '', `De : Sam Rivera <${owner}>`, 'Envoyé : lundi 1 septembre 2026 09:00', 'À : Ana Duarte <ana.duarte@example.com>', 'Objet : bravo', '', OWNER_WORDS],
    }),
  'Gmail, HTML only': (owner) =>
    reply(owner, ['Subject: Re: felicidades', 'Message-ID: <html-gmail@example.com>'], {
      html:
        '<div dir="ltr">Gracias, de verdad.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">' +
        `El lun, 1 sept 2026 a las 9:00, Sam Rivera (&lt;<a href="mailto:${owner}">${owner}</a>&gt;) escribió:<br></div>` +
        `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">${OWNER_WORDS}</div></blockquote></div>`,
    }),
  'Apple Mail, HTML only': (owner) =>
    reply(owner, ['Subject: Re: felicidades', 'Message-ID: <html-apple@example.com>'], {
      html: `<div>Gracias, de verdad.</div><div><br><blockquote type="cite"><div>On Sep 1, 2026, at 9:00 AM, Sam Rivera &lt;${owner}&gt; wrote:</div><div>${OWNER_WORDS}</div></blockquote></div>`,
    }),
};

async function everyQuote(session: Session): Promise<string[]> {
  return [...(await items(session)), ...(await items(session, 'maybe'))].map((i) => String(i.quote ?? ''));
}

describe('whose words: the owner\'s own words are never credited to someone else', () => {
  it.each(Object.keys(QUOTING_CLIENTS))('%s: a reply quoting the owner keeps nothing of the owner\'s words', async (client) => {
    const session = await signIn();
    const result = await handleInboundEmail(
      // The person's mail provider forwards what arrives (the envelope sender is theirs).
      inbound({ from: session.email, to: await inboundAddress(session), raw: QUOTING_CLIENTS[client]!(session.email) }),
      testEnv,
    );
    expect(result.outcome).toBe('captured');
    // The replier's own words are only thanks, so nothing is kept at all.
    expect(result).toMatchObject({ result: { status: 'excluded' } });
    for (const quote of await everyQuote(session)) expect(quote).not.toContain('proud of you');
  });

  it('regression: across every client, no kept quote ever holds the owner\'s quoted text', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    for (const build of Object.values(QUOTING_CLIENTS)) {
      await handleInboundEmail(inbound({ from: session.email, to, raw: build(session.email) }), testEnv);
    }
    // The same replies with kind new words of their own: those are kept, the owner's never.
    for (const [client, build] of Object.entries(QUOTING_CLIENTS)) {
      const raw = build(session.email)
        .replace(/Gracias, de verdad\.|Merci, vraiment\.|Danke dir\.|Obrigada, de verdade\./, `Thank you so much for being there for me this year, ${client}. I could not have done it without you.`)
        .replace(/Message-ID: <([^>]+)>/, 'Message-ID: <kind-$1>');
      await handleInboundEmail(inbound({ from: session.email, to, raw }), testEnv);
    }
    const quotes = await everyQuote(session);
    expect(quotes.length).toBe(Object.keys(QUOTING_CLIENTS).length);
    for (const quote of quotes) {
      expect(quote).toContain('could not have done it without you');
      expect(quote).not.toContain('proud of you');
      expect(quote).not.toContain('deserve every bit');
    }
  });

  it('recovers kind words from a thread the owner forwarded, credited to their author and dated by the thread', async () => {
    const session = await signIn();
    const result = await handleInboundEmail(
      inbound({
        from: session.email,
        to: await inboundAddress(session),
        raw: mail([
          `From: Sam Rivera <${session.email}>`,
          'Subject: Fwd: Re: final files',
          'Date: Tue, 22 Sep 2026 09:00:00 -0700',
          'Message-ID: <thread-1@example.com>',
          '',
          'look what she said!!',
          '',
          '---------- Forwarded message ---------',
          'From: Rosa Vega <rosa@vegaarch.example.com>',
          'Date: Mon, Sep 8, 2026 at 6:12 PM',
          'Subject: Re: final files',
          `To: Sam Rivera <${session.email}>`,
          '',
          'Got them, thanks.',
          '',
          `On Sun, Sep 7, 2026 at 8:00 PM Sam Rivera <${session.email}> wrote:`,
          '> Here are the final files. Thank you so much, you were a joy to work with and I am so proud of this.',
          '>',
          '> On Fri, Sep 5, 2026 at 9:00 AM Rosa Vega <rosa@vegaarch.example.com> wrote:',
          '>> Sam, these drawings are stunning. You are by far the most thoughtful designer we have ever worked with.',
        ]),
      }),
      testEnv,
    );
    // Picked out of the thread, so it waits in maybe for a look.
    expect(result).toMatchObject({ outcome: 'captured', result: { status: 'maybe' } });
    expect(await items(session)).toHaveLength(0);
    const [item] = await items(session, 'maybe');
    expect(item).toMatchObject({ fromName: 'Rosa Vega', canBlockSender: true, occurredAt: Date.UTC(2026, 8, 5, 16, 0, 0) });
    expect(String(item!.quote)).toContain('most thoughtful designer');
    expect(String(item!.quote)).not.toContain('joy to work with');
  });

  it('leaves the date unknown for mail the owner writes, and for a forwarded message with no date', async () => {
    const session = await signIn();
    const to = await inboundAddress(session);
    await handleInboundEmail(
      inbound({
        from: session.email,
        to,
        raw: mail([`From: Sam Rivera <${session.email}>`, 'Subject: from Grandma', 'Date: Tue, 22 Sep 2026 09:00:00 -0700', '', 'I am so proud of you and I love you more than words can say.']),
      }),
      testEnv,
    );
    await handleInboundEmail(
      inbound({
        from: session.email,
        to,
        raw: mail([
          `From: Sam Rivera <${session.email}>`,
          'Subject: Fwd: thank you',
          'Date: Tue, 22 Sep 2026 09:00:00 -0700',
          '',
          '---------- Forwarded message ---------',
          'From: Lea Park <lea.park@example.com>',
          'Subject: thank you',
          '',
          'Thank you so much for sitting with me at the hospital all night. I could not have done it without you.',
        ]),
      }),
      testEnv,
    );
    const kept = [...(await items(session)), ...(await items(session, 'maybe'))];
    expect(kept).toHaveLength(2);
    for (const item of kept) expect(item.occurredAt).toBeNull();
    expect(kept.map((i) => i.fromName).sort()).toEqual(['Lea Park', null].sort());
  });
});
