// A small headless-Chrome driver over the DevTools protocol, shared by screens.mjs,
// brand.mjs and the end-to-end test (scripts/e2e.mjs at the repository root).
// No dependencies: Node 22+ and Bun have WebSocket built in.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes('\n')) return text;
    }
    await sleep(100);
  }
  throw new Error(`Chrome did not start (no ${path}). Set CHROME to your Chrome binary.`);
}

export function connect(url) {
  const ws = new WebSocket(url);
  // Frames can arrive as binary; read them as text rather than as "[object Blob]".
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  // A reply or event that never comes fails the caller with a reason, never hangs it.
  const TIMEOUT_MS = 60_000;
  let closed = null;
  // One-shot event waiters (once), failed with the replies when the connection closes.
  const waiters = new Set();
  const closeAll = (reason) => {
    closed = closed ?? new Error(reason);
    for (const { fail } of pending.values()) fail(closed);
    pending.clear();
    for (const fail of waiters) fail(closed);
    waiters.clear();
  };
  ws.addEventListener('close', () => closeAll('the DevTools connection closed'));
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : decoder.decode(event.data));
    } catch {
      return; // not a whole DevTools message; nothing waits on it
    }
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    } else {
      for (const listener of listeners) listener(msg);
    }
  });
  const ready = new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(closed);
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`no reply to ${method} after ${TIMEOUT_MS / 1000} s`));
        }, TIMEOUT_MS);
        pending.set(id, {
          ok: (v) => (clearTimeout(timer), ok(v)),
          fail: (e) => (clearTimeout(timer), fail(e)),
        });
      });
    },
    once(method, sessionId, timeoutMs = TIMEOUT_MS) {
      if (closed) return Promise.reject(closed);
      return new Promise((ok, fail) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(listener);
          waiters.delete(stop);
        };
        const stop = (error) => (done(), fail(error));
        const timer = setTimeout(() => stop(new Error(`no ${method} after ${timeoutMs / 1000} s`)), timeoutMs);
        const listener = (msg) => {
          if (msg.method === method && msg.sessionId === sessionId) {
            done();
            ok(msg.params);
          }
        };
        listeners.add(listener);
        waiters.add(stop);
      });
    },
    /** Every event, for callers that keep their own logs (console, downloads). Returns an unsubscribe. */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => ws.close(),
  };
}

/**
 * Start headless Chrome with a fresh temporary profile and connect to it.
 * Returns the browser-level connection; `close()` kills Chrome and deletes the profile.
 */
export async function launchChrome(extraArgs = []) {
  const profile = mkdtempSync(join(tmpdir(), 'witness-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    ...extraArgs,
    'about:blank',
  ]);

  async function kill() {
    chrome.kill('SIGKILL');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }

  try {
    const [port, path] = (await waitForFile(join(profile, 'DevToolsActivePort'), 20_000)).trim().split('\n');
    const cdp = connect(`ws://127.0.0.1:${port}${path}`);
    await cdp.ready;
    return {
      cdp,
      profile,
      close: async () => {
        cdp.close();
        await kill();
      },
    };
  } catch (error) {
    await kill();
    throw error;
  }
}

/** Launch headless Chrome with one page. Returns `shoot()` and `close()`. */
export async function launch() {
  const browser = await launchChrome();
  const { cdp } = browser;
  const close = browser.close;

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);

    /**
     * Load `url` in an emulated viewport and write a PNG.
     * @param {{ url: string, file: string, width: number, height: number, scale?: number, mobile?: boolean,
     *           theme?: 'dark' | 'light', fullPage?: boolean, settleMs?: number, transparent?: boolean }} o
     */
    async function shoot(o) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: o.width, height: o.height, deviceScaleFactor: o.scale ?? 1, mobile: o.mobile ?? false },
        sessionId,
      );
      await cdp.send(
        'Emulation.setEmulatedMedia',
        {
          features: [
            { name: 'prefers-color-scheme', value: o.theme ?? 'dark' },
            // Capture the settled page, not an entrance animation.
            { name: 'prefers-reduced-motion', value: 'reduce' },
          ],
        },
        sessionId,
      );
      if (o.transparent) {
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
      }
      const loaded = cdp.once('Page.loadEventFired', sessionId);
      await cdp.send('Page.navigate', { url: o.url }, sessionId);
      await loaded;
      await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true }, sessionId);
      await sleep(o.settleMs ?? 1200);

      const params = { format: 'png' };
      if (o.fullPage) {
        const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: o.width, height: Math.ceil(metrics.cssContentSize.height), scale: 1 };
      }
      const { data } = await cdp.send('Page.captureScreenshot', params, sessionId);
      writeFileSync(o.file, Buffer.from(data, 'base64'));
    }

    return { shoot, close };
  } catch (error) {
    await close();
    throw error;
  }
}
