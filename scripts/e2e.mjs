#!/usr/bin/env bun
// End-to-end proof: the real web app, served by the real core Worker (wrangler dev,
// local D1 and R2), driven in headless Chrome, with synthetic mail posted to the
// Worker's email handler, the real MCP SDK client, and the real witness-mac CLI.
//
//   bun run e2e                 from the repository root
//
// Needs Chrome (set CHROME if it is not in /Applications) and a free port 8787. On
// macOS it also builds and runs apps/mac (skip with WITNESS_E2E_SKIP_MAC=1).
// Screenshots go to /tmp/witness-e2e (WITNESS_E2E_SHOTS to change). Nothing here
// touches real mail, Messages, Keychain items or settings: every input is
// synthetic, the Mac CLI runs with WITNESS_TOKEN and WITNESS_SUPPORT_DIR, and the
// Worker's local state lives in a temporary folder that is removed afterwards
// (WITNESS_E2E_KEEP=1 keeps it for debugging).
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { TIME_ZONE, openBrowser } from './e2e/browser.mjs';
import { ACCOUNT, KIND, NOT_EVIDENCE, chatRows, forwardedKindEmail, gmailConfirmation, gradientPng, newsletter } from './e2e/fixtures.mjs';
import { EXTRACTED_TEXT, KEY_VARIABLE, NOTICES, SHORTCUTS, describeRequest, imageShortcut, textShortcut } from './shortcuts/workflow.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORE = join(ROOT, 'apps/core');
const MAC = join(ROOT, 'apps/mac');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const PORT = 8787;
const ORIGIN = `http://localhost:${PORT}`;
const SHOTS = process.env.WITNESS_E2E_SHOTS ?? '/tmp/witness-e2e';
const KEEP = process.env.WITNESS_E2E_KEEP === '1';
const RUN_MAC = process.platform === 'darwin' && process.env.WITNESS_E2E_SKIP_MAC !== '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const steps = [];

function log(message) {
  console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function step(name, fn) {
  const t = Date.now();
  log(`▍ ${name}`);
  await fn();
  steps.push({ name, ms: Date.now() - t });
  log(`  ok (${Date.now() - t} ms)`);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/**
 * `run` without blocking the event loop: the DevTools socket keeps being read while a long
 * command (a Swift build) runs. A blocked loop left Chrome's messages unread for minutes, and a
 * dropped reply then hung the whole run until CI cancelled it.
 */
function runAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0 && !options.allowFailure) reject(new Error(`${cmd} ${args.join(' ')} failed (${status}):\n${stdout}\n${stderr}`));
      else resolve({ status, stdout, stderr });
    });
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'witness-e2e-'));
const persist = join(work, 'state');
const downloads = join(work, 'downloads');
mkdirSync(downloads, { recursive: true });
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const devVars = join(CORE, '.dev.vars');
// A developer's own .dev.vars (it can hold real keys) is kept outside the repository while
// the run uses its own, so a crash can never leave a copy where `git add` would find it.
const devVarsBackup = join(work, 'dev.vars.backup');
let movedDevVars = false;
let wroteDevVars = false;
const hadWranglerDir = existsSync(join(CORE, '.wrangler'));
let wrangler = null;
let browser = null;

async function teardown() {
  if (browser) await browser.close().catch(() => {});
  if (wrangler && wrangler.exitCode === null) {
    try {
      process.kill(-wrangler.pid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 30 && wrangler.exitCode === null; i += 1) await sleep(100);
    try {
      process.kill(-wrangler.pid, 'SIGKILL');
    } catch {}
  }
  // Only undo what this run did: never delete a .dev.vars it did not write.
  if (wroteDevVars) rmSync(devVars, { force: true });
  if (movedDevVars && existsSync(devVarsBackup)) {
    copyFileSync(devVarsBackup, devVars);
    rmSync(devVarsBackup, { force: true });
  }
  // The Worker's local D1/R2 lived in `persist`; wrangler also leaves a bundle folder.
  if (!hadWranglerDir) rmSync(join(CORE, '.wrangler'), { recursive: true, force: true });
  if (KEEP) log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

// SIGHUP: the terminal was closed. Teardown still restores the developer's .dev.vars.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void teardown().finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------
// Talking to the Worker from here
// ---------------------------------------------------------------------------

let session = null;

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (session) headers.Cookie = `wit_session=${session}`;
  if (method !== 'GET') Object.assign(headers, { 'X-Witness-CSRF': '1', Origin: ORIGIN });
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function outbox() {
  const res = await fetch(`${ORIGIN}/api/v1/dev/outbox`);
  assert(res.ok, 'dev outbox is available (MAILER=log on localhost)');
  return (await res.json()).messages;
}

async function waitForMail(predicate, what, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = (await outbox()).filter(predicate);
    if (found.length) return found;
    await sleep(200);
  }
  throw new Error(`no mail: ${what}`);
}

/** Posts a raw message to the Worker's email() handler, as Email Routing would. */
async function deliverEmail({ from, to, raw }) {
  const url = `${ORIGIN}/cdn-cgi/handler/email?${new URLSearchParams({ from, to })}`;
  const res = await fetch(url, { method: 'POST', body: raw });
  return { status: res.status, text: await res.text() };
}

function d1(sql) {
  const out = run(WRANGLER, ['d1', 'execute', 'DB', '--local', '--persist-to', persist, '--json', '--command', sql], { cwd: CORE });
  const parsed = JSON.parse(out.stdout.slice(out.stdout.indexOf('[')));
  return parsed[0].results;
}

function r2Exists(key) {
  const file = join(work, `r2-${Date.now()}`);
  const out = run(WRANGLER, ['r2', 'object', 'get', `witness-media/${key}`, '--local', '--persist-to', persist, '--file', file], { cwd: CORE, allowFailure: true });
  const exists = out.status === 0 && existsSync(file) && statSync(file).size > 0;
  rmSync(file, { force: true });
  return exists;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const quotes = [KIND.maya.words, KIND.jordan.words, KIND.manual.words, KIND.text.words];
let failure = null;

try {
  await step('preflight: port, Chrome, build the web app', async () => {
    assert(!(await portInUse(PORT)), `port ${PORT} is free (stop any running wrangler dev first)`);
    assert(existsSync(WRANGLER), 'wrangler is installed (bun install)');
    run('bun', ['run', '--filter', '@witness/web', 'build'], { cwd: ROOT });
    const assets = join(ROOT, 'apps/web/dist/assets');
    const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
    const bundle = js.map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
    const kb = Math.round(Buffer.byteLength(bundle) / 1024);
    log(`  web bundle ${kb} kB in ${js.length} file(s)`);
    assert(kb < 400, 'web bundle stays under 400 kB');
    // (The privacy page names Anthropic in prose; the SDK would bring its API host and headers.)
    assert(!/api\.anthropic\.com|anthropic-version|@anthropic-ai/.test(bundle), 'the web bundle carries no model SDK');
    assert(bundle.includes('proud of you') && bundle.includes('-from:me'), 'the web bundle has the Gmail filter terms from lexicon.json');
  });

  await step('start the Worker: local D1 migrations, wrangler dev --test-scheduled', async () => {
    if (existsSync(devVars)) {
      copyFileSync(devVars, devVarsBackup);
      movedDevVars = true;
      rmSync(devVars);
      log(`  your apps/core/.dev.vars is set aside at ${devVarsBackup} and put back afterwards`);
    }
    wroteDevVars = true;
    writeFileSync(
      devVars,
      [
        '# Written by scripts/e2e.mjs for one run and deleted afterwards.',
        'MAILER=log',
        `APP_URL=${ORIGIN}`,
        'SIGNUPS=open',
        `WITNESS_MASTER_KEY=${randomBytes(32).toString('base64')}`,
        '',
      ].join('\n'),
    );
    run(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], { cwd: CORE, env: { ...process.env, CI: '1' } });
    const logFile = join(work, 'wrangler.log');
    const out = [];
    wrangler = spawn(WRANGLER, ['dev', '--local', '--port', String(PORT), '--test-scheduled', '--persist-to', persist, '--show-interactive-dev-session=false'], {
      cwd: CORE,
      detached: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    wrangler.stdout.on('data', (d) => out.push(String(d)));
    wrangler.stderr.on('data', (d) => out.push(String(d)));
    wrangler.on('exit', () => writeFileSync(logFile, out.join('')));
    const until = Date.now() + 60_000;
    for (;;) {
      if (wrangler.exitCode !== null) throw new Error(`wrangler dev exited:\n${out.join('')}`);
      try {
        const res = await fetch(`${ORIGIN}/api/v1/me`);
        if (res.status === 401) break;
      } catch {}
      if (Date.now() > until) throw new Error(`wrangler dev did not start:\n${out.join('')}`);
      await sleep(250);
    }
    browser = await openBrowser({ downloadDir: downloads, shotsDir: SHOTS });
  });

  const { page } = browser;
  // Signed out, the app asks who you are and gets a 401; that is not a failure.
  page.allowedFailures = [/GET http:\/\/localhost:8787\/api\/v1\/me 401/];

  await step('a. landing page: brand, crisis line, no console errors or CSP violations', async () => {
    await page.goto(`${ORIGIN}/`);
    await page.waitForText('988');
    const text = await page.eval('document.body.textContent');
    assert(/muse nexus/i.test(text) && text.includes('Witness'), 'wordmark: Muse Nexus Witness');
    assert(text.includes('A witness to your life.'), 'tagline');
    assert(/call or text\s*988/.test(text) && text.includes('findahelpline.com'), 'crisis line in the footer');
    const fonts = await page.eval(`getComputedStyle(document.querySelector('h1') ?? document.body).fontFamily`);
    assert(/Fraunces/.test(fonts), `display type is Fraunces (${fonts})`);
    await page.shot('landing');
    page.assertClean('landing');
  });

  await step('b. sign in with a link from the dev outbox, land on /app/setup', async () => {
    await page.goto(`${ORIGIN}/signin`);
    await page.type('Email', ACCOUNT);
    await page.click('', { selector: 'form button[type=submit]' });
    await page.waitForText('Check your email');
    const [mail] = await waitForMail((m) => m.kind === 'magic_link' && m.to === ACCOUNT, 'sign-in link');
    const link = mail.devLink ?? /https?:\/\/\S+\/auth\/callback\?token=\S+/.exec(mail.text)?.[0];
    assert(link?.startsWith(`${ORIGIN}/auth/callback?token=wit_link_`), 'the sign-in link points at this Witness');
    await page.goto(link);
    await page.waitForPath('/app/setup', { timeout: 15_000 });
    session = (await browser.cookie('wit_session'))?.value;
    assert(session?.startsWith('wit_sess_'), 'session cookie set');
    page.allowedFailures = [];
    const me = await api('GET', '/api/v1/me');
    assert(me.status === 200 && me.body.email === ACCOUNT, 'signed in as alex');
    page.assertClean('sign-in');
  });

  let inbound;
  await step('c. email step shows the address; a Gmail confirmation appears as a Confirm button', async () => {
    const me = await api('GET', '/api/v1/me');
    inbound = me.body.inboundAddress;
    assert(/^witness\+[a-z0-9]{10}@in\.example\.com$/.test(inbound), `plus-style inbound address (${inbound})`);
    await page.waitForText(inbound);
    await page.shot('setup-email');
    const res = await deliverEmail({ from: 'forwarding-noreply@google.com', to: inbound, raw: gmailConfirmation(inbound) });
    assert(res.status === 200, `confirmation accepted by email() (${res.status} ${res.text})`);
    const href = await page.waitFor(
      `[...document.querySelectorAll('a')].find((a) => a.textContent.includes('Confirm it'))?.href ?? null`,
      { timeout: 12_000, what: 'the Confirm it button (polled every 5 s)' },
    );
    assert(href.startsWith('https://mail-settings.google.com/mail/vf-'), `Confirm links to Google only (${href})`);
    await page.waitForText('104729338');
    await page.shot('setup-email-confirmation');
    page.assertClean('email step');
  });

  await step('d. forwarded kind emails are saved verbatim; a newsletter is not', async () => {
    for (const friend of [KIND.maya, KIND.jordan]) {
      const res = await deliverEmail({ from: ACCOUNT, to: inbound, raw: forwardedKindEmail(inbound, friend) });
      assert(res.status === 200, `forward accepted (${res.status} ${res.text})`);
    }
    const bulk = await deliverEmail({ from: ACCOUNT, to: inbound, raw: newsletter(inbound) });
    assert(bulk.status === 200, 'newsletter accepted by the handler (and then excluded)');
    const stranger = await deliverEmail({ from: 'stranger@example.net', to: inbound, raw: forwardedKindEmail(inbound, KIND.maya) });
    assert(stranger.status !== 200 && /can't send to your Witness/.test(stranger.text), 'mail from an unknown envelope sender is rejected, with where to add it');

    await page.goto(`${ORIGIN}/app`);
    for (const friend of [KIND.maya, KIND.jordan]) await page.waitForText(friend.words);
    const text = await page.text();
    assert(text.includes(`— ${KIND.maya.name}`) && text.includes(`— ${KIND.jordan.name}`), 'cards say who sent them');
    assert(!text.includes('valued subscriber'), 'the newsletter is not in the gallery');
    const saved = (await api('GET', '/api/v1/items?status=saved')).body.items;
    const maybe = (await api('GET', '/api/v1/items?status=maybe')).body.items;
    assert(saved.length === 2, `two saved items (${saved.length})`);
    for (const friend of [KIND.maya, KIND.jordan]) {
      const item = saved.find((i) => i.fromName === friend.name);
      assert(item?.quote === friend.words, `exact quote from ${friend.name}`);
      assert(item.sourceType === 'email' && item.canBlockSender === true, 'an email item with a known sender');
    }
    assert(![...saved, ...maybe].some((i) => i.quote?.includes('subscriber')), 'nothing kept from the newsletter');
    const events = d1(`SELECT outcome, reason FROM inbound_events WHERE source_type = 'email' ORDER BY received_at`);
    assert(events.some((e) => e.outcome === 'excluded' && /header|bulk|list/.test(e.reason ?? '')), `newsletter excluded by a header rule (${JSON.stringify(events)})`);
    await page.shot('gallery-emails');
    page.assertClean('gallery');
  });

  let userId;
  await step('e. rhythm: consent, save, send one now; a delivery link confirms on GET and acts on POST', async () => {
    await page.goto(`${ORIGIN}/app/setup?step=rhythm`);
    await page.setValue('Time', '07:45');
    await page.check('Saturday', false);
    await page.check('Sunday', false);
    await page.check("I'm choosing this now, so Witness can email me on these days.");
    await page.click('Turn on emails');
    await page.waitForText('Saved. Witness will email you at 7:45 AM on weekdays.');
    const rhythm = (await api('GET', '/api/v1/rhythm')).body;
    assert(rhythm.enabled && rhythm.localTime === '07:45' && rhythm.days.join() === 'mon,tue,wed,thu,fri', `rhythm saved (${JSON.stringify(rhythm)})`);
    assert(rhythm.consentedAt > 0 && rhythm.nextAt > Date.now(), 'consent recorded and a next run scheduled');
    assert(rhythm.timezone === TIME_ZONE, `the rhythm is in the browser's zone, not UTC (${rhythm.timezone})`);
    assert((await api('GET', '/api/v1/me')).body.timezone === TIME_ZONE, 'and so is the account');
    await page.shot('setup-rhythm');

    await page.click('Send one now to see it');
    await page.waitForText('One is on its way');
    const [delivery] = await waitForMail((m) => m.kind === 'delivery' && m.to === ACCOUNT, 'the send-now delivery');
    const quote = quotes.find((q) => delivery.text.includes(q));
    assert(quote, 'the delivery carries one exact quote');
    for (const q of quotes) assert(!delivery.subject.includes(q.slice(0, 12)), 'no evidence in the subject');
    assert(!/Maya|Jordan|Chen|Ellis/.test(delivery.subject), `no names in the subject (${delivery.subject})`);
    assert(/^Something you kept, for \w+day$/.test(delivery.subject), `calm subject (${delivery.subject})`);
    assert(delivery.text.includes('988') && delivery.text.includes('findahelpline.com'), 'crisis line in the delivery');
    assert(delivery.html.includes('988') && !delivery.text.includes('!'), 'crisis line in HTML; no exclamation marks');
    assert(delivery.text.includes('You asked Witness to send this one.'), 'send-now says the person asked');

    // The signed token rides in the query string (request logs redact it), never the path.
    const pauseLink = /Pause a week: (http:\/\/localhost:8787\/d\?t=[A-Za-z0-9_-]+\.pause\.[0-9]+\.[A-Za-z0-9_-]+)/.exec(delivery.text)?.[1];
    assert(pauseLink, 'a signed pause link');
    assert(/Stop these emails: http:\/\/localhost:8787\/d\?t=/.test(delivery.text), 'a one-step stop link');
    assert(/^<http:\/\/localhost:8787\/d\?t=.+\.stop\./.test(delivery.headers?.['List-Unsubscribe'] ?? ''), 'List-Unsubscribe points at the stop link');
    await page.goto(pauseLink);
    await page.waitForText('Pause for a week?');
    assert((await api('GET', '/api/v1/rhythm')).body.pausedUntil === null, 'opening the link (GET) changes nothing');
    await page.shot('delivery-link-confirm');
    await page.click('Pause for a week');
    await page.waitForText('Paused until');
    const paused = (await api('GET', '/api/v1/rhythm')).body;
    assert(paused.pausedUntil > Date.now() + 6 * 86_400_000, 'the POST paused the rhythm for a week');
    await page.shot('delivery-link-done');
    page.assertClean('delivery links');

    await page.goto(`${ORIGIN}/app/settings`);
    await page.click('Resume now');
    await page.waitForText('Resumed.');
    assert((await api('GET', '/api/v1/rhythm')).body.pausedUntil === null, 'resumed from Settings');
    userId = d1(`SELECT id FROM users WHERE email = '${ACCOUNT}'`)[0].id;
    page.assertClean('settings resume');
  });

  let imageItemId;
  await step('f. add a photo by hand; the scheduled run delivers exactly once', async () => {
    const png = join(work, 'photo.png');
    writeFileSync(png, gradientPng());
    await page.goto(`${ORIGIN}/app`);
    await page.type('What they said, in their exact words', KIND.manual.words);
    await page.type('Who said it', KIND.manual.name);
    await page.setFile('input[type=file]', png);
    await page.click('Keep it');
    await page.waitForText('Kept.');
    await page.waitForText(KIND.manual.words);
    const loaded = await page.waitFor(
      `[...document.querySelectorAll('img')].some((img) => img.src.includes('/api/v1/items/') && img.complete && img.naturalWidth === 320)`,
      { what: 'the kept photo to load from core' },
    );
    assert(loaded, 'photo shown');
    const manual = (await api('GET', '/api/v1/items?status=saved')).body.items.find((i) => i.quote === KIND.manual.words);
    assert(manual?.kind === 'mixed' && manual.mediaType === 'image/png' && manual.canBlockSender === false, 'a hand-added photo item');
    imageItemId = manual.id;
    assert(r2Exists(`u/${userId}/${imageItemId}`), 'the photo is in R2');
    await page.shot('gallery-with-photo');
    page.assertClean('add something');

    const before = (await outbox()).filter((m) => m.kind === 'delivery').length;
    d1(`UPDATE rhythms SET next_run_at = ${Date.now() - 60_000} WHERE user_id = '${userId}'`);
    const tick = await fetch(`${ORIGIN}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/15 * * * *')}`);
    assert(tick.ok, 'scheduled handler ran');
    let deliveries = [];
    for (let i = 0; i < 50; i += 1) {
      deliveries = (await outbox()).filter((m) => m.kind === 'delivery');
      if (deliveries.length > before) break;
      await sleep(200);
    }
    assert(deliveries.length === before + 1, `the cron sent one delivery (${deliveries.length - before})`);
    const cronMail = deliveries[0]; // the outbox is newest first
    assert(quotes.some((q) => cronMail.text.includes(q)), 'the scheduled delivery carries an exact quote');
    assert(cronMail.text.includes('You chose this schedule on'), 'a scheduled email names the day it was chosen');
    const next = d1(`SELECT next_run_at FROM rhythms WHERE user_id = '${userId}'`)[0].next_run_at;
    assert(next > Date.now(), 'next run moved into the future');

    const again = await fetch(`${ORIGIN}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('*/15 * * * *')}`);
    assert(again.ok, 'scheduled handler ran again');
    await sleep(2500);
    const after = (await outbox()).filter((m) => m.kind === 'delivery').length;
    assert(after === before + 1, `no duplicate delivery (${after - before})`);
    const rows = d1(`SELECT channel, status FROM deliveries WHERE user_id = '${userId}'`);
    assert(rows.length === 2 && rows.every((r) => r.status === 'sent'), `two sent deliveries recorded (${JSON.stringify(rows)})`);
  });

  await step('g. assistant key from the UI; MCP over Streamable HTTP with the official SDK', async () => {
    await page.goto(`${ORIGIN}/app/setup?step=assistant`);
    await page.click('Create an assistant key');
    const token = await page.waitFor(`(/wit_agent_[A-Za-z0-9_-]{43}/.exec(document.body.innerText) ?? [null])[0]`, { what: 'the assistant key' });
    const configText = await page.text();
    assert(configText.includes(`claude mcp add --transport http witness ${ORIGIN}/mcp --header "Authorization: Bearer ${token}"`), 'Claude Code config from core');
    await page.click('Codex', { selector: '[role=tab]' });
    await page.waitForText('[mcp_servers.witness]');
    await page.shot('setup-assistant');
    page.assertClean('assistant step');

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'witness-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      assert(client.getServerVersion()?.name === 'muse-nexus-witness', 'server name');
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Search hands over evidence without the offer-and-yes step, so it is off unless ticked.
      assert(names.join() === 'witness_add,witness_offer,witness_pause,witness_reveal,witness_status', `five tools, no search by default (${names})`);
      const offerTool = tools.find((t) => t.name === 'witness_offer');
      assert(offerTool.description.includes('Never offer to someone in acute crisis'), 'offer says crisis first');

      const noContent = (result, where) => {
        const json = JSON.stringify(result);
        for (const q of quotes) assert(!json.includes(q.slice(0, 20)), `${where} carries no evidence`);
        for (const n of [KIND.maya.name, KIND.jordan.name, KIND.manual.name]) assert(!json.includes(n), `${where} carries no names`);
      };
      const status = await client.callTool({ name: 'witness_status', arguments: {} });
      assert(!status.isError && status.structuredContent.saved === 3, `status counts (${JSON.stringify(status.structuredContent)})`);
      noContent(status, 'witness_status');

      const offer = await client.callTool({ name: 'witness_offer', arguments: {} });
      assert(!offer.isError && offer.structuredContent.available === true && offer.structuredContent.offerId, `an offer (${JSON.stringify(offer.structuredContent)})`);
      noContent(offer, 'witness_offer');

      const reveal = await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.structuredContent.offerId, userSaidYes: true } });
      assert(!reveal.isError, `reveal works after a yes (${JSON.stringify(reveal.content)})`);
      assert(quotes.includes(reveal.structuredContent.quote), `reveal returns an exact quote (${reveal.structuredContent.quote})`);
      assert(reveal.structuredContent.attribution.startsWith('— '), 'with a ready attribution line');

      let second;
      try {
        second = await client.callTool({ name: 'witness_reveal', arguments: { offerId: offer.structuredContent.offerId, userSaidYes: true } });
      } catch (error) {
        second = { isError: true, thrown: String(error) };
      }
      assert(second.isError === true, 'a second reveal of the same offer fails');
      assert(!JSON.stringify(second).includes(reveal.structuredContent.quote), 'and shows nothing');
    } finally {
      await client.close();
    }
  });

  await step(RUN_MAC ? 'h. Mac key from the UI; the real witness-mac CLI sends only the kind text' : 'h. (skipped: the Mac CLI step needs macOS)', async () => {
    if (!RUN_MAC) return;
    await page.goto(`${ORIGIN}/app/setup?step=texts`);
    await page.click('Create a Mac key');
    const token = await page.waitFor(`(/wit_dev_[A-Za-z0-9_-]{43}/.exec(document.body.innerText) ?? [null])[0]`, { what: 'the device key' });
    await page.shot('setup-texts');
    page.assertClean('texts step');

    await runAsync('swift', ['build', '--package-path', MAC], { cwd: ROOT });
    const binary = join(MAC, '.build/debug/witness-mac');
    const home = join(work, 'home');
    const support = join(work, 'mac-support');
    mkdirSync(home, { recursive: true });
    const db = join(work, 'chat.db');
    const rowsFile = join(work, 'chat-rows.json');
    writeFileSync(rowsFile, JSON.stringify(chatRows()));
    await runAsync('swift', [join(ROOT, 'scripts/e2e/make-chat-db.swift'), db, rowsFile], { cwd: ROOT });

    // WITNESS_TOKEN and WITNESS_SUPPORT_DIR keep the real Keychain and settings out of it.
    const env = { ...process.env, HOME: home, WITNESS_TOKEN: token, WITNESS_SUPPORT_DIR: support, WITNESS_LEXICON: join(ROOT, 'packages/detector/lexicon.json'), NO_COLOR: '1' };
    const login = await runAsync(binary, ['login', '--url', ORIGIN, '--token', token], { env });
    assert(login.stdout.includes(`Signed in to ${ORIGIN}`), `login (${login.stdout})`);
    const config = JSON.parse(readFileSync(join(support, 'config.json'), 'utf8'));
    assert(config.apiUrl.startsWith(ORIGIN), 'server saved in the isolated support folder');
    const status = await runAsync(binary, ['status', '--db', db], { env });
    assert(status.stdout.includes('from WITNESS_TOKEN') && /cues and \d+ exclusions compile/.test(status.stdout), `status (${status.stdout})`);
    const scan = await runAsync(binary, ['scan', '--once', '--db', db], { env });
    log(`  witness-mac: ${scan.stdout.trim()}`);
    // 4 rows: the tapback and my own message are skipped, the code is excluded, the kind one is sent.
    assert(/scanned 4\b/.test(scan.stdout) && /skipped 2\b/.test(scan.stdout) && /excluded 1\b/.test(scan.stdout) && /sent 1\b/.test(scan.stdout), `one message sent, the rest kept on the Mac (${scan.stdout})`);
    for (const words of Object.values(NOT_EVIDENCE)) assert(!scan.stdout.includes(words.slice(0, 15)) && !scan.stderr.includes(words.slice(0, 15)), 'the CLI never prints message text');

    await page.goto(`${ORIGIN}/app`);
    await page.waitForText(KIND.text.words);
    // (The status line keeps "7:45 AM" together with a no-break space.)
    await page.waitFor(`/Next email [^.]*7:45\\sAM/.test(document.body.innerText)`, { what: 'the next email at 7:45 AM local time in the status line' });
    const text = (await api('GET', '/api/v1/items?status=saved')).body.items.find((i) => i.quote === KIND.text.words);
    assert(text?.sourceType === 'text' && text.canBlockSender === true, 'the text is saved with a blockable sender');
    const maybe = (await api('GET', '/api/v1/items?status=maybe')).body.items;
    assert(!maybe.some((i) => Object.values(NOT_EVIDENCE).some((w) => i.quote?.includes(w.slice(0, 15)))), 'no tapback, own message or code anywhere');
    const events = d1(`SELECT outcome FROM inbound_events WHERE user_id = '${userId}' AND source_type = 'text'`);
    assert(events.length === 1 && events[0].outcome === 'saved', `exactly one text reached the server (${JSON.stringify(events)})`);
    const again = await runAsync(binary, ['scan', '--once', '--db', db], { env });
    assert(/sent 0\b/.test(again.stdout), 'a second scan sends nothing new');
    await page.shot('gallery-with-text');
    page.assertClean('gallery with text');
  });

  await step('i. iPhone shortcuts download as signed files; the request each one makes is kept as sent', async () => {
    for (const { name, file } of SHORTCUTS) {
      const res = await fetch(`${ORIGIN}/shortcuts/${file}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert(res.status === 200, `${file} is served (${res.status})`);
      assert(res.headers.get('content-type') === 'application/octet-stream', `${file} is a file to save (${res.headers.get('content-type')})`);
      const disposition = res.headers.get('content-disposition');
      assert(disposition === `attachment; filename="${name}.shortcut"`, `${file} saves as "${name}.shortcut" (${disposition})`);
      assert(bytes.subarray(0, 4).toString('latin1') === 'AEA1', `${file} is signed`);
      assert(bytes.equals(readFileSync(join(ROOT, 'apps/web/public/shortcuts', file))), `${file} is served byte for byte`);
    }

    // A device key as Setup makes one, then exactly what each shortcut sends, built for this Worker.
    const created = await api('POST', '/api/v1/tokens', { label: 'iPhone', kind: 'device', scopes: ['capture'] });
    assert(created.status === 201 && /^wit_dev_/.test(created.body.token), 'a capture-only device key');
    const send = async (request) => {
      assert(request.method === 'POST' && request.bodyType === 'JSON', 'the shortcut POSTs JSON');
      const res = await fetch(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(request.body) });
      return { status: res.status, body: await res.json() };
    };

    const shared = await send(describeRequest(textShortcut({ appUrl: ORIGIN }), { [KEY_VARIABLE]: created.body.token, ExtensionInput: KIND.shared.words }));
    assert(shared.status === 201 && ['saved', 'maybe'].includes(shared.body.status), `the shared text is kept (${JSON.stringify(shared)})`);
    const kept = [...(await api('GET', '/api/v1/items?status=saved')).body.items, ...(await api('GET', '/api/v1/items?status=maybe')).body.items];
    const text = kept.find((i) => i.quote === KIND.shared.words);
    assert(text?.status === shared.body.status && text.sourceType === 'text' && text.sourceLabel === 'iPhone', 'kept verbatim, labeled iPhone');

    const noKey = await send(describeRequest(textShortcut({ appUrl: ORIGIN }), { [KEY_VARIABLE]: '', ExtensionInput: KIND.shared.words }));
    assert(noKey.status === 401 && noKey.body.status === undefined, 'without a key nothing is kept, and the shortcut says it did not arrive');

    const png = gradientPng(240, 160);
    // The phone read no words in this one (Extract Text from Image gives nothing).
    const image = await send(describeRequest(imageShortcut({ appUrl: ORIGIN }), { [KEY_VARIABLE]: created.body.token, 'Base64 Encoded': png.toString('base64'), [EXTRACTED_TEXT]: '' }));
    assert(image.status === 201 && image.body.status === 'maybe', `a shared screenshot without text waits in Maybe (${JSON.stringify(image)})`);
    const shot = (await api('GET', '/api/v1/items?status=maybe')).body.items.find((i) => i.sourceType === 'screenshot' && i.sourceLabel === 'iPhone');
    assert(shot?.mediaType === 'image/png', `the screenshot is kept as a PNG, whatever the shortcut labeled it (${shot?.mediaType})`);
    const media = await fetch(`${ORIGIN}/api/v1/items/${shot.id}/media`, { headers: { Cookie: `wit_session=${session}` } });
    assert(Buffer.from(await media.arrayBuffer()).equals(png), 'the original bytes, not converted or resized');

    // A screenshot of a kind message: the words the phone read in it are quoted, labeled as read
    // from the image, and wait in Maybe (the phone cannot say whose bubble they were in).
    const read = "9:41\nMaya\niMessage\nI just want you to know I'm so proud of you. You've come so far this year.\nDelivered";
    const words = await send(describeRequest(imageShortcut({ appUrl: ORIGIN }), { [KEY_VARIABLE]: created.body.token, 'Base64 Encoded': gradientPng(240, 161).toString('base64'), [EXTRACTED_TEXT]: read }));
    assert(words.status === 201 && words.body.status === 'maybe' && read.includes(words.body.quote), `a screenshot of kind words is quoted and kept for review (${JSON.stringify(words)})`);
    const quoted = (await api('GET', '/api/v1/items?status=maybe')).body.items.find((i) => i.sourceType === 'screenshot' && i.quote);
    assert(quoted?.kind === 'mixed' && quoted.sourceLabel === 'iPhone · Text read from the image', `kept with its image, marked as read from it (${quoted?.kind}, ${quoted?.sourceLabel})`);

    // A screenshot whose words match a harm rule (a crisis-line banner here) reaches Witness and
    // is not kept. The phone's notice says just that, never that it did not arrive.
    const banner = '9:41\n988 Suicide & Crisis Lifeline\nCall or text 988\nThinking of you today.';
    const left = await send(describeRequest(imageShortcut({ appUrl: ORIGIN }), { [KEY_VARIABLE]: created.body.token, 'Base64 Encoded': gradientPng(240, 162).toString('base64'), [EXTRACTED_TEXT]: banner }));
    assert(left.status === 200 && left.body.status === 'excluded', `a screenshot whose words match a harm rule is not kept (${JSON.stringify(left)})`);
    assert(NOTICES.failed.startsWith('Witness did not keep this.') && !/did not reach/.test(NOTICES.failed), `the phone says it was not kept, not that it failed (${NOTICES.failed})`);
  });

  await step('j. export everything, then delete everything (D1 rows and R2 objects)', async () => {
    await page.goto(`${ORIGIN}/app/settings`);
    await page.waitForText('Download everything');
    await page.shot('settings');
    await page.click('Download everything');
    const file = await browser.waitForDownload();
    const archive = JSON.parse(readFileSync(file.path, 'utf8'));
    assert(archive.format === 'muse-nexus-witness-export' && archive.account.email === ACCOUNT, 'an export for alex');
    const exported = archive.items.map((i) => i.quote);
    for (const q of RUN_MAC ? quotes : quotes.slice(0, 3)) assert(exported.includes(q), `export has "${q.slice(0, 30)}…"`);
    const photo = archive.items.find((i) => i.id === imageItemId);
    assert(photo?.media?.type === 'image/png' && Buffer.from(photo.media.base64, 'base64').subarray(1, 4).toString() === 'PNG', 'export includes the photo');
    page.assertClean('export');

    await page.type('Type delete everything to confirm', 'delete everything');
    await page.click('Delete everything');
    await page.waitForText('Everything is deleted.');
    await page.shot('deleted');
    const tables = ['items', 'blocked_senders', 'rhythms', 'deliveries', 'offers', 'inbound_events', 'pending_confirmations', 'tokens', 'sessions', 'user_addresses'];
    for (const table of tables) {
      const n = d1(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = '${userId}'`)[0].n;
      assert(n === 0, `${table} has no rows for the user (${n})`);
    }
    assert(d1(`SELECT COUNT(*) AS n FROM users WHERE id = '${userId}'`)[0].n === 0, 'the user row is gone');
    assert(d1(`SELECT COUNT(*) AS n FROM magic_links WHERE email = '${ACCOUNT}'`)[0].n === 0, 'sign-in links are gone');
    assert(!r2Exists(`u/${userId}/${imageItemId}`), 'the photo is gone from R2');
    assert((await api('GET', '/api/v1/me')).status === 401, 'the old session no longer works');
    page.assertClean('delete');
  });

  assert(browser.page.problems.length === 0, 'no console errors, exceptions, failed requests or CSP violations in the whole run');
} catch (error) {
  failure = error;
  try {
    if (browser) {
      const file = await browser.page.shot('failure');
      log(`screenshot of the failure: ${file}`);
      log(`page: ${await browser.page.path()}`);
    }
  } catch {}
} finally {
  await teardown();
}

if (failure) {
  console.error(`\n✗ e2e failed: ${failure.stack ?? failure}`);
  process.exit(1);
}
console.log(`\n✓ e2e passed: ${steps.length} steps in ${((Date.now() - started) / 1000).toFixed(1)} s. Screenshots in ${SHOTS}`);
for (const s of steps) console.log(`  ${String(s.ms).padStart(6)} ms  ${s.name}`);
process.exit(0);
