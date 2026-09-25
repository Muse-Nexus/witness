import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DELIVERY_LINK_TTL_MS, LASTING_LINK_TTL_MS, base64Encode, signDeliveryToken } from '../src/crypto.js';
import { runScheduled } from '../src/cron.js';
import { sendOne } from '../src/delivery.js';
import { config } from '../src/env.js';
import worker from '../src/index.js';
import { MailError, type Mailer, type OutgoingMail } from '../src/mail/index.js';
import { getRhythm as rhythmRow } from '../src/store/rhythm.js';
import { getUserById } from '../src/store/users.js';
import { PNG_1X1, addManual, asUser, call, createToken, keyring, outbox, signIn, testEnv, visibleText, type Session } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

interface Rhythm {
  enabled: boolean;
  nextAt: number | null;
  pausedUntil: number | null;
  skipNext: boolean;
  consentedAt: number | null;
  timezone: string;
  localTime: string;
  days: string[];
}

async function enableRhythm(session: Session, body: Record<string, unknown> = {}): Promise<Rhythm> {
  const res = await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, localTime: '08:30', timezone: 'Pacific/Honolulu', ...body } }));
  expect(res.status).toBe(200);
  return (await res.json()) as Rhythm;
}

async function getRhythm(session: Session): Promise<Rhythm> {
  return (await (await call('/api/v1/rhythm', asUser(session))).json()) as Rhythm;
}

async function deliveriesTo(email: string) {
  return (await outbox()).filter((m) => m.to === email && m.kind === 'delivery');
}

function actionLinks(text: string): Record<string, string> {
  const links: Record<string, string> = {};
  for (const [label, key] of [
    ['Skip the next one', 'skip'],
    ['Pause a week', 'pause'],
    ['Remove this from Witness', 'remove'],
    ['Never save from them', 'block'],
    ['Stop these emails', 'stop'],
  ] as const) {
    const m = new RegExp(`${label}: (\\S+)`).exec(text);
    if (m) links[key] = new URL(m[1]!).pathname + new URL(m[1]!).search;
  }
  return links;
}

/** The token a link carries, and a form post of it, as the confirm page sends it. */
const tokenOf = (link: string) => new URL(link, 'http://x').searchParams.get('t')!;
function post(link: string, extra: Record<string, string> = {}) {
  return call('/d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: tokenOf(link), ...extra }).toString(),
  });
}

describe('rhythm settings', () => {
  it('enabling records consent and schedules the next local time', async () => {
    const session = await signIn();
    const before = Date.now();
    const rhythm = await enableRhythm(session, { days: ['mon', 'wed', 'fri'] });
    expect(rhythm).toMatchObject({ enabled: true, localTime: '08:30', timezone: 'Pacific/Honolulu', days: ['mon', 'wed', 'fri'] });
    expect(rhythm.consentedAt).toBeGreaterThanOrEqual(before);
    expect(rhythm.nextAt).toBeGreaterThan(before);
    // 08:30 HST is 18:30 UTC.
    expect(new Date(rhythm.nextAt!).getUTCHours()).toBe(18);
    expect(new Date(rhythm.nextAt!).getUTCMinutes()).toBe(30);

    const off = await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: false } }));
    expect(await off.json()).toMatchObject({ enabled: false, nextAt: null });
    const bad = await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, localTime: '8.30' } }));
    expect(bad.status).toBe(400);
  });

  it('a pause or turning the rhythm off and on never carries an old "Skip the next one" over', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for always showing up.' });
    await enableRhythm(session);
    await env.DB.prepare('UPDATE rhythms SET skip_next = 1 WHERE user_id = ?1').bind(session.userId).run();
    // The next delivery shown is the one that will really come, after the skipped one.
    const skipped = await getRhythm(session);
    const scheduled = await env.DB.prepare('SELECT next_run_at FROM rhythms WHERE user_id = ?1').bind(session.userId).first<{ next_run_at: number }>();
    expect(skipped.skipNext).toBe(true);
    expect(skipped.nextAt).toBeGreaterThan(scheduled!.next_run_at);

    const paused = (await (await call('/api/v1/rhythm/pause', asUser(session, { method: 'POST', body: { days: 2 } }))).json()) as Rhythm;
    expect(paused.skipNext).toBe(false);
    // Let the pause run out: the first slot after it delivers.
    const report = await runScheduled(testEnv, paused.nextAt! + 1000);
    expect(report.sent).toBeGreaterThanOrEqual(1);
    expect(await deliveriesTo(session.email)).toHaveLength(1);

    await env.DB.prepare('UPDATE rhythms SET skip_next = 1 WHERE user_id = ?1').bind(session.userId).run();
    await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: false } }));
    const back = await enableRhythm(session);
    expect(back.skipNext).toBe(false);
  });

  it('saving the rhythm between its time and the next cron tick keeps that delivery', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for always showing up.' });
    const rhythm = await enableRhythm(session, { localTime: '08:40' });
    const due = rhythm.nextAt!;
    // The cron has not run yet: it is 08:43 and the 08:40 delivery is still due.
    await env.DB.prepare('UPDATE rhythms SET next_run_at = ?2 WHERE user_id = ?1').bind(session.userId, due - DAY).run();
    const saved = await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, localTime: '08:40', timezone: 'Pacific/Honolulu' } }));
    expect(((await saved.json()) as Rhythm).nextAt).toBe(due - DAY);
    // Changing only the days keeps the due slot when the new days include it.
    const allDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const changed = await call('/api/v1/rhythm', asUser(session, { method: 'PUT', body: { enabled: true, days: allDays } }));
    expect(((await changed.json()) as Rhythm).nextAt).toBe(due - DAY);
  });

  it('pauses and resumes', async () => {
    const session = await signIn();
    const rhythm = await enableRhythm(session);
    const paused = (await (await call('/api/v1/rhythm/pause', asUser(session, { method: 'POST', body: { days: 7 } }))).json()) as Rhythm;
    expect(paused.pausedUntil).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(paused.nextAt).toBeGreaterThan(paused.pausedUntil!);
    const resumed = (await (await call('/api/v1/rhythm/resume', asUser(session, { method: 'POST' }))).json()) as Rhythm;
    expect(resumed.pausedUntil).toBeNull();
    expect(resumed.nextAt).toBe(rhythm.nextAt);
    expect((await call('/api/v1/rhythm/pause', asUser(session, { method: 'POST', body: { days: 91 } }))).status).toBe(400);
  });
});

describe('cron delivery', () => {
  it('sends one email per due rhythm, picked by the rules, with no evidence in the subject', async () => {
    const session = await signIn();
    const rhythm = await enableRhythm(session);
    const runAt = rhythm.nextAt! + 60_000;

    // "On this day" (same month and day, an earlier year, in Honolulu) beats an older, never-sent item.
    const anniversaryDay = new Date(runAt - 10 * 60 * 60 * 1000); // Honolulu is UTC-10
    const anniversary = Date.UTC(anniversaryDay.getUTCFullYear() - 2, anniversaryDay.getUTCMonth(), anniversaryDay.getUTCDate(), 22);
    await addManual(session, { quote: 'Thank you for teaching me to swim at Waimea.', fromName: 'Uncle Kai' });
    await addManual(session, { quote: 'You stayed with me the whole night at the hospital. I will never forget it.', fromName: 'Mei', occurredAt: anniversary });

    const report = await runScheduled(testEnv, runAt);
    expect(report.sent).toBeGreaterThanOrEqual(1);
    const [email] = await deliveriesTo(session.email);
    expect(email).toBeTruthy();
    expect(email!.subject).toMatch(/^Something you kept, for (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/);
    expect(email!.subject).not.toContain('hospital');
    expect(email!.text).toContain('“You stayed with me the whole night at the hospital. I will never forget it.”');
    expect(email!.text).toContain('— Mei · ');
    expect(email!.text).toContain('If you are in crisis, call or text 988 (US) or visit findahelpline.com.');
    expect(email!.text).toMatch(/You chose this schedule on [A-Z][a-z]+ \d{1,2}, \d{4}\./);
    expect(email!.html).toContain('Georgia');
    expect(email!.html).toContain('role="presentation"');
    expect(visibleText(email!.html)).not.toContain('!');
    expect(email!.headers).toMatchObject({ 'X-Witness-Mail': 'delivery' });

    // Rescheduled for the next day, and the same run does not send twice.
    const after = await getRhythm(session);
    expect(after.nextAt).toBeGreaterThan(runAt);
    await runScheduled(testEnv, runAt);
    expect(await deliveriesTo(session.email)).toHaveLength(1);

    // Next day: the never-sent one.
    await runScheduled(testEnv, after.nextAt! + 1000);
    const second = (await deliveriesTo(session.email))[0]!;
    expect(second.text).toContain('Waimea');
  });

  it('sends nothing when nothing qualifies, and never says so', async () => {
    const session = await signIn();
    const rhythm = await enableRhythm(session);
    const report = await runScheduled(testEnv, rhythm.nextAt! + 1000);
    expect(report.nothing).toBeGreaterThanOrEqual(1);
    expect(await deliveriesTo(session.email)).toHaveLength(0);
    // Still rescheduled.
    expect((await getRhythm(session)).nextAt).toBeGreaterThan(rhythm.nextAt!);

    // One item, delivered once: within 30 days it does not come back.
    await addManual(session, { quote: 'You make every team better.' });
    const next = (await getRhythm(session)).nextAt!;
    await runScheduled(testEnv, next + 1000);
    expect(await deliveriesTo(session.email)).toHaveLength(1);
    const later = (await getRhythm(session)).nextAt!;
    await runScheduled(testEnv, later + 1000);
    expect(await deliveriesTo(session.email)).toHaveLength(1);
  });

  it('skips the next run when asked, then carries on', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for always showing up.' });
    const rhythm = await enableRhythm(session);
    await env.DB.prepare('UPDATE rhythms SET skip_next = 1 WHERE user_id = ?1').bind(session.userId).run();
    const report = await runScheduled(testEnv, rhythm.nextAt! + 1000);
    expect(report.skipped).toBeGreaterThanOrEqual(1);
    expect(await deliveriesTo(session.email)).toHaveLength(0);
    const after = await getRhythm(session);
    expect(after.skipNext).toBe(false);
    await runScheduled(testEnv, after.nextAt! + 1000);
    expect(await deliveriesTo(session.email)).toHaveLength(1);
  });

  it('does not deliver while paused', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for always showing up.' });
    const rhythm = await enableRhythm(session);
    await env.DB.prepare('UPDATE rhythms SET paused_until = ?2 WHERE user_id = ?1').bind(session.userId, rhythm.nextAt! + 3 * DAY).run();
    const report = await runScheduled(testEnv, rhythm.nextAt! + 1000);
    expect(report.paused).toBeGreaterThanOrEqual(1);
    expect(await deliveriesTo(session.email)).toHaveLength(0);
    expect((await getRhythm(session)).nextAt).toBeGreaterThan(rhythm.nextAt! + 3 * DAY);
  });

  it('includes a signed image link for image items', async () => {
    const session = await signIn();
    await addManual(session, { image: { base64: base64Encode(PNG_1X1), mediaType: 'image/png' } });
    const rhythm = await enableRhythm(session);
    await runScheduled(testEnv, rhythm.nextAt! + 1000);
    const [email] = await deliveriesTo(session.email);
    const imageUrl = /Image: (\S+)/.exec(email!.text)?.[1];
    expect(imageUrl).toMatch(/\/api\/v1\/items\/[0-9a-f-]+\/media\?sig=\d+\.[A-Za-z0-9_-]+$/);
    const url = new URL(imageUrl!);
    const res = await call(url.pathname + url.search); // no cookie: the signature is the permission
    expect(res.status).toBe(200);
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_1X1);
  });

  it('runs from the Worker scheduled() handler', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'You were the calm in that storm, thank you.' });
    const rhythm = await enableRhythm(session);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: rhythm.nextAt! + 1000, cron: '*/15 * * * *' }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(await deliveriesTo(session.email)).toHaveLength(1);
  });
});

describe('send one now', () => {
  it('sends when something qualifies and answers sent:false otherwise', async () => {
    const session = await signIn();
    const nothing = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await nothing.json()).toEqual({ sent: false, reason: 'nothing_qualifies' });
    expect(await deliveriesTo(session.email)).toHaveLength(0);

    await addManual(session, { quote: 'Thank you for the soup when I was sick.' });
    const sent = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await sent.json()).toEqual({ sent: true });
    const [email] = await deliveriesTo(session.email);
    expect(email!.text).toContain('You asked Witness to send this one.');

    // Pressed again a minute later: something is kept, it was just sent. Never "nothing yet".
    const again = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await again.json()).toEqual({ sent: false, reason: 'all_recent' });
  });

  it('never picks an image-only HEIC photo for email, which most mail clients cannot show', async () => {
    const session = await signIn();
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1heic')]);
    await addManual(session, { image: { base64: base64Encode(heic), mediaType: 'image/heic' } });
    const res = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await res.json()).toEqual({ sent: false, reason: 'all_recent' });
    expect(await deliveriesTo(session.email)).toHaveLength(0);
  });

  it('sends the words of a HEIC item with a link to the photo in Witness, never the HEIC itself', async () => {
    const session = await signIn();
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1heic')]);
    const id = await addManual(session, { quote: 'Thank you for the day at the lake.', image: { base64: base64Encode(heic), mediaType: 'image/heic' } });
    // Kept exactly as it came: the stored image is the HEIC file, byte for byte.
    const media = await call(`/api/v1/items/${id}/media`, asUser(session));
    expect(media.headers.get('Content-Type')).toBe('image/heic');
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(heic);

    const res = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await res.json()).toEqual({ sent: true });
    const [email] = await deliveriesTo(session.email);
    expect(email!.text).toContain('“Thank you for the day at the lake.”');
    // Most mail apps cannot draw HEIC: no broken image, a quiet link instead.
    expect(email!.html).not.toContain('<img');
    expect(email!.html).not.toContain('/media?sig=');
    expect(email!.text).not.toContain('Image: ');
    expect(visibleText(email!.html)).toContain('See the photo in Witness');
    expect(email!.text).toMatch(/See the photo in Witness: http:\/\/localhost:8787\/app\b/);
  });
});

describe('one delivery at a time', () => {
  /** A mailer that holds each send until it is let go, so two senders can overlap. */
  function heldMailer() {
    const sent: OutgoingMail[] = [];
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    let reached!: () => void;
    const sending = new Promise<void>((resolve) => (reached = resolve));
    const mailer: Mailer = {
      async send(mail) {
        reached();
        await gate;
        sent.push(mail);
        return {};
      },
    };
    return { mailer, sent, sending, letGo };
  }

  it('send-now and the rhythm never send at once for the same person', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for driving me to every appointment.' });
    await addManual(session, { quote: 'You are the reason the garden came back.' });
    const user = (await getUserById(env.DB, session.userId))!;
    const rhythm = await rhythmRow(env.DB, session.userId, 'UTC', Date.now());
    const deps = { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now() };

    const held = heldMailer();
    const first = sendOne({ ...deps, mailer: held.mailer }, user, rhythm, 'send-now');
    await held.sending;
    // While the first is still with the mail provider, a second sender for the same person
    // (the cron, or another "Send one now") steps back instead of picking the same item.
    const other = heldMailer();
    other.letGo();
    expect(await sendOne({ ...deps, mailer: other.mailer }, user, rhythm, 'rhythm')).toEqual({ sent: false, reason: 'in_progress' });
    expect(other.sent).toHaveLength(0);
    held.letGo();
    expect(await first).toMatchObject({ sent: true });
    expect(held.sent).toHaveLength(1);

    // Once it is done, the next one may go, and it is not the same item.
    const next = heldMailer();
    next.letGo();
    expect(await sendOne({ ...deps, mailer: next.mailer }, user, rhythm, 'send-now')).toMatchObject({ sent: true });
    expect(next.sent[0]!.text).not.toBe(held.sent[0]!.text);
  });

  it('a send that outlasts its claim never lets another sender send the same item', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for driving me to every appointment.' });
    await addManual(session, { quote: 'You are the reason the garden came back.' });
    const user = (await getUserById(env.DB, session.userId))!;
    const rhythm = await rhythmRow(env.DB, session.userId, 'UTC', Date.now());
    const deps = { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now() };

    const slow = heldMailer();
    const first = sendOne({ ...deps, mailer: slow.mailer }, user, rhythm, 'rhythm');
    await slow.sending;
    // The mail provider takes longer than the claim lasts: the claim runs out while the
    // first email is still on its way, and "Send one now" gets through.
    await env.DB.prepare('UPDATE rhythms SET delivery_claim_until = ?2 WHERE user_id = ?1').bind(session.userId, Date.now() - 1).run();
    const second = heldMailer();
    second.letGo();
    expect(await sendOne({ ...deps, mailer: second.mailer }, user, rhythm, 'send-now')).toMatchObject({ sent: true });
    slow.letGo();
    expect(await first).toMatchObject({ sent: true });
    expect(second.sent[0]!.text).not.toBe(slow.sent[0]!.text);
    const counts = await env.DB.prepare('SELECT delivered_count AS n FROM items WHERE user_id = ?1').bind(session.userId).all<{ n: number }>();
    expect(counts.results.map((r) => r.n)).toEqual([1, 1]);
  });

  it('undoes the delivered mark when the mail provider fails, so the item can come next time', async () => {
    const session = await signIn();
    const itemId = await addManual(session, { quote: 'Thank you for the soup when I was sick.' });
    const user = (await getUserById(env.DB, session.userId))!;
    const rhythm = await rhythmRow(env.DB, session.userId, 'UTC', Date.now());
    const deps = { env: testEnv, cfg: config(testEnv), keyring: keyring(), now: Date.now() };
    const failing: Mailer = {
      async send() {
        throw new MailError('resend failed: HTTP 503');
      },
    };
    expect(await sendOne({ ...deps, mailer: failing }, user, rhythm, 'send-now')).toEqual({ sent: false, reason: 'send_failed' });
    const item = () => env.DB.prepare('SELECT last_delivered_at, delivered_count FROM items WHERE id = ?1').bind(itemId).first();
    expect(await item()).toEqual({ last_delivered_at: null, delivered_count: 0 });
    const statuses = await env.DB.prepare('SELECT status FROM deliveries WHERE user_id = ?1').bind(session.userId).all();
    expect(statuses.results).toEqual([{ status: 'failed' }]);

    const ok = heldMailer();
    ok.letGo();
    expect(await sendOne({ ...deps, mailer: ok.mailer }, user, rhythm, 'send-now')).toMatchObject({ sent: true, itemId });
    expect(await item()).toEqual({ last_delivered_at: deps.now, delivered_count: 1 });
  });

  it('answers in_progress over HTTP while a send is under way, and a stale claim does not block', async () => {
    const session = await signIn();
    await addManual(session, { quote: 'Thank you for the soup when I was sick.' });
    await call('/api/v1/rhythm', asUser(session, { method: 'GET' }));
    const now = Date.now();
    await env.DB.prepare('UPDATE rhythms SET delivery_claim = ?2, delivery_claim_until = ?3 WHERE user_id = ?1').bind(session.userId, 'other-sender', now + 60_000).run();
    const busy = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await busy.json()).toEqual({ sent: false, reason: 'in_progress' });
    expect(await deliveriesTo(session.email)).toHaveLength(0);

    // A sender that died mid-way leaves a claim that runs out by itself.
    await env.DB.prepare('UPDATE rhythms SET delivery_claim_until = ?2 WHERE user_id = ?1').bind(session.userId, now - 1).run();
    const sent = await call('/api/v1/rhythm/send-now', asUser(session, { method: 'POST' }));
    expect(await sent.json()).toEqual({ sent: true });
    expect(await deliveriesTo(session.email)).toHaveLength(1);
    const claim = await env.DB.prepare('SELECT delivery_claim, delivery_claim_until FROM rhythms WHERE user_id = ?1').bind(session.userId).first();
    expect(claim).toEqual({ delivery_claim: null, delivery_claim_until: null });
  });
});

describe('delivery links /d?t=', () => {
  async function deliveredSession() {
    const session = await signIn();
    const itemId = await addManual(session, { quote: 'Thank you for believing in me before I did.' });
    const rhythm = await enableRhythm(session);
    await runScheduled(testEnv, rhythm.nextAt! + 1000);
    const [email] = await deliveriesTo(session.email);
    return { session, itemId, links: actionLinks(email!.text) };
  }

  it('GET shows a confirm page and changes nothing; POST acts', async () => {
    const { session, links } = await deliveredSession();
    // A hand-added item has no known sender, so there is no "Never save from them". There is
    // no "keep" link either: it changed nothing.
    expect(Object.keys(links).sort()).toEqual(['pause', 'remove', 'skip', 'stop']);
    const [email] = await deliveriesTo(session.email);
    expect(email!.text).not.toMatch(/\.keep\./);
    expect(email!.html).not.toMatch(/\.keep\./);
    // The token is in the query string (logs redact it), never the path.
    for (const link of Object.values(links)) expect(link).toMatch(/^\/d\?t=/);

    const page = await call(links.skip!);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Skip the next one?');
    expect(html).toContain('action="/d"');
    expect(html).toContain(`name="t" value="${tokenOf(links.skip!)}"`);
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const words = visibleText(html);
    expect(words).toContain('988');
    expect(words).toContain('Your Witness emails');
    expect(words).toContain('Witness will skip your next email, then carry on as usual.');
    expect(words).toContain('Change your schedule');
    expect(words.toLowerCase()).not.toContain('rhythm');
    expect((await getRhythm(session)).skipNext).toBe(false);

    const done = await post(links.skip!);
    expect(done.status).toBe(200);
    const doneWords = visibleText(await done.text());
    expect(doneWords).toContain('The next one is skipped. After that, your emails continue as planned.');
    expect(doneWords.toLowerCase()).not.toContain('rhythm');
    expect((await getRhythm(session)).skipNext).toBe(true);
  });

  it('pause and remove act only on POST, and remove deletes the item and its image', async () => {
    const { session, itemId, links } = await deliveredSession();
    // A pause holds emails and assistants, and says that saving goes on.
    const pausePage = visibleText(await (await call(links.pause!)).text());
    expect(pausePage).toContain(
      'Witness will not email you for a week, and AI assistants will not ask to show you anything. It still keeps what arrives. After the week, Witness goes back to your schedule.',
    );
    expect((await getRhythm(session)).pausedUntil).toBeNull();
    const paused = visibleText(await (await post(links.pause!)).text());
    expect(paused).toMatch(/Paused until [A-Z][a-z]+ \d{1,2}, \d{4}\. Witness still keeps what arrives\./);
    expect((await getRhythm(session)).pausedUntil).toBeGreaterThan(Date.now() + 6 * DAY);

    expect(visibleText(await (await call(links.remove!)).text())).toContain('Remove this from Witness?');
    const stillThere = await env.DB.prepare('SELECT status FROM items WHERE id = ?1').bind(itemId).first<{ status: string }>();
    expect(stillThere?.status).toBe('saved');
    const removedPage = await post(links.remove!);
    expect(await removedPage.text()).toContain('It is deleted from Witness');
    const removed = await env.DB.prepare('SELECT id FROM items WHERE id = ?1').bind(itemId).first();
    expect(removed).toBeNull();

    // Changed their mind: adding the same words by hand works (nothing hidden says "already here").
    const readd = await call('/api/v1/items', asUser(session, { method: 'POST', body: { quote: 'Thank you for believing in me before I did.' } }));
    expect(readd.status).toBe(201);
  });

  it('keeps an older email\'s "Keep them coming" link working: it says there is nothing to change', async () => {
    const { session, links } = await deliveredSession();
    const deliveryId = tokenOf(links.skip!).split('.')[0]!;
    // New emails have no keep link, so sign one the way older emails did.
    const keep = `/d?t=${encodeURIComponent(await signDeliveryToken(keyring(), deliveryId, 'keep', Date.now()))}`;
    const before = await getRhythm(session);

    const page = await call(keep);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(visibleText(html)).toContain('Nothing to change. Your Witness emails continue as planned.');
    // Nothing to confirm, so no button that looks like it is needed.
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');

    // A post from a confirm page opened before this change still answers, and changes nothing.
    const done = await post(keep);
    expect(done.status).toBe(200);
    expect(visibleText(await done.text())).toContain('Nothing to change. Your Witness emails continue as planned.');
    expect(await getRhythm(session)).toEqual(before);
  });

  it('stops the rhythm in one step, from the link or the mail client\'s own Unsubscribe', async () => {
    const { session, links } = await deliveredSession();
    const [email] = await deliveriesTo(session.email);
    expect(email!.headers).toMatchObject({ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    const unsubscribe = /^<(.+)>$/.exec(email!.headers!['List-Unsubscribe']!)![1]!;
    expect(new URL(unsubscribe).searchParams.get('t')).toBe(tokenOf(links.stop!));

    // RFC 8058: the provider POSTs "List-Unsubscribe=One-Click" to that URL.
    const url = new URL(unsubscribe);
    const oneClick = await call(url.pathname + url.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    expect(await getRhythm(session)).toMatchObject({ enabled: false, nextAt: null });
    expect(visibleText(await (await call(links.stop!)).text())).toContain(
      'Witness will not email you again until you turn emails back on in Settings. Everything you kept stays.',
    );

    // A one-click post to any other link does nothing.
    const other = await call(`/d?t=${encodeURIComponent(tokenOf(links.remove!))}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(other.status).toBe(400);
  });

  it('keeps stop and pause links working long after the others expire', async () => {
    const { session, links } = await deliveredSession();
    const deliveryId = tokenOf(links.skip!).split('.')[0]!;
    const old = Date.now() - 60 * DAY;
    const oldStop = await signDeliveryToken(keyring(), deliveryId, 'stop', old);
    const oldRemove = await signDeliveryToken(keyring(), deliveryId, 'remove', old);
    expect((await post(`/d?t=${encodeURIComponent(oldRemove)}`)).status).toBe(410);
    const stopped = await post(`/d?t=${encodeURIComponent(oldStop)}`);
    expect(stopped.status).toBe(200);
    expect(visibleText(await stopped.text())).toContain('Stopped. No more Witness emails will come. You can turn them back on in Settings any time.');
    expect((await getRhythm(session)).enabled).toBe(false);
  });

  /** A text from a known sender, delivered; returns the email's links. */
  async function deliveredFromSender(session: Session, device: string, fromName?: string) {
    const captured = await call('/api/v1/capture', {
      method: 'POST',
      headers: { Authorization: `Bearer ${device}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'text', text: 'I am so proud of you, you mean the world to me.', ...(fromName ? { fromName } : {}), fromHandle: '+15555550199', threadKind: 'direct' }),
    });
    expect(((await captured.json()) as { status: string }).status).toBe('saved');
    const rhythm = await enableRhythm(session);
    await runScheduled(testEnv, rhythm.nextAt! + 1000);
    const [email] = await deliveriesTo(session.email);
    return actionLinks(email!.text);
  }
  const heading = (html: string) => /<h1>([^<]*)<\/h1>/.exec(html)?.[1];
  const eyebrow = (html: string) => /<span class="cursor" aria-hidden="true">&#9613;<\/span>([^<]*)<\/p>/.exec(html)?.[1];

  it('offers "Never save from them" for a known sender, and it blocks them', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    const links = await deliveredFromSender(session, device, 'Ex');
    expect(links.block).toBeTruthy();
    // It says who it is about, with a way out that changes nothing. The page title, which
    // tabs and browser history keep, does not carry the name.
    const confirm = await (await call(links.block!)).text();
    expect(heading(confirm)).toBe('Never save from Ex?');
    expect(eyebrow(confirm)).toBe('Never save from');
    expect(confirm).toContain('<a href="/app">Keep saving from them</a>');
    expect(confirm).toContain('<title>Never save from this sender? · Muse Nexus Witness</title>');
    expect(visibleText(confirm)).not.toContain('Change your schedule');
    expect(visibleText(confirm)).toContain('Witness will not keep anything new from them, and this one is deleted. Nothing else is kept from them.');
    const done = await (await post(links.block!)).text();
    expect(eyebrow(done)).toBe('Never save from');
    expect(visibleText(done)).toContain('Witness will not save anything new from them.');
    const again = await call('/api/v1/capture', {
      method: 'POST',
      headers: { Authorization: `Bearer ${device}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceType: 'text', text: 'Thank you so much, I love you so much.', fromHandle: '+1 (555) 555-0199', threadKind: 'direct' }),
    });
    expect(((await again.json()) as { status: string }).status).toBe('blocked');
  });

  it('says how many other things are kept from them, and keeps those (SAFETY §6)', async () => {
    const session = await signIn();
    const device = await createToken(session, 'device');
    for (const text of ['Thank you so much, I love you so much.', 'You are the kindest friend, thank you for everything.']) {
      const res = await call('/api/v1/capture', {
        method: 'POST',
        headers: { Authorization: `Bearer ${device}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'text', text, fromName: 'Ex', fromHandle: '+15555550199', threadKind: 'direct' }),
      });
      expect(['saved', 'maybe']).toContain(((await res.json()) as { status: string }).status);
    }
    const links = await deliveredFromSender(session, device, 'Ex');
    const confirm = visibleText(await (await call(links.block!)).text());
    expect(confirm).toContain('and this one is deleted. The 2 other things kept from them stay until you remove them in Witness.');
    await post(links.block!);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE user_id = ?1').bind(session.userId).first<{ n: number }>();
    expect(left?.n).toBe(2);
  });

  it('names nobody on "Never save from" when Witness has no name, and escapes a name it has', async () => {
    const nameless = await signIn();
    const links = await deliveredFromSender(nameless, await createToken(nameless, 'device'));
    expect(heading(await (await call(links.block!)).text())).toBe('Never save from this sender?');

    const marked = await signIn();
    const markedLinks = await deliveredFromSender(marked, await createToken(marked, 'device'), 'Sam <b>&</b> "Co"');
    expect(heading(await (await call(markedLinks.block!)).text())).toBe('Never save from Sam &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;?');
  });

  it('rejects a bad signature, an expired link and the old path form', async () => {
    const { session, links } = await deliveredSession();
    const tampered = links.skip!.replace(/\.skip\./, '.remove.');
    expect((await call(tampered)).status).toBe(400);
    expect((await post(tampered)).status).toBe(400);
    expect((await call('/d?t=not-a-token')).status).toBe(400);
    // /d/<token> put the token in the path, where logs keep it: nothing acts on it.
    const oldForm = await call(`/d/${tokenOf(links.remove!)}`, { method: 'POST' });
    expect(oldForm.status).toBe(400);

    const deliveryId = tokenOf(links.skip!).split('.')[0]!;
    const expired = await signDeliveryToken(keyring(), deliveryId, 'remove', Date.now() - 15 * DAY);
    const res = await post(`/d?t=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(410);
    const words = visibleText(await res.text());
    expect(words).toContain('This link has expired');
    expect(words).toContain(
      'Links in Witness emails work for two weeks. Stop and pause links work for a year. Try the links in your newest Witness email, or sign in to change or stop your emails.',
    );
    // The page names these durations in words: change them together.
    expect(DELIVERY_LINK_TTL_MS).toBe(14 * DAY);
    expect(LASTING_LINK_TTL_MS).toBe(365 * DAY);
    const items = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?1 AND status = 'saved'").bind(session.userId).first<{ n: number }>();
    expect(items?.n).toBe(1);
  });
});
