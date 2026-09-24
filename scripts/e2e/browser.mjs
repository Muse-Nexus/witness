// A page driver for the end-to-end test: real headless Chrome over the DevTools
// protocol (apps/web/scripts/chrome.mjs), real mouse clicks and typing, and a log
// of every console error, uncaught exception, failed request and CSP violation.
import { writeFileSync } from 'node:fs';
import { launchChrome, sleep } from '../../apps/web/scripts/chrome.mjs';

// Runs in the page: find an element by role-ish kind and visible name.
const FIND = `
  const norm = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width > 0 || r.height > 0 || e.type === 'checkbox' || e.type === 'file'); };
  const byLabel = (text) => {
    for (const label of document.querySelectorAll('label')) {
      if (norm(label.textContent) === text || norm(label.textContent).startsWith(text)) {
        const target = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input, textarea, select');
        if (target) return target;
      }
    }
    return [...document.querySelectorAll('input, textarea, select')].find((e) => e.getAttribute('aria-label') === text) ?? null;
  };
  const byName = (selector, text) => {
    const all = [...document.querySelectorAll(selector)].filter(visible);
    return all.find((e) => e.getAttribute('aria-label') === text || norm(e.textContent) === text)
      ?? all.find((e) => norm(e.textContent).startsWith(text)) ?? null;
  };
  const CLICKABLE = 'button, a, [role=button], [role=menuitem], [role=tab], summary';
`;

export const TIME_ZONE = 'Pacific/Honolulu';

export class Page {
  constructor(cdp, sessionId, { shotsDir }) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.shotsDir = shotsDir;
    this.shotCount = 0;
    /** Everything that went wrong in the page, in order. */
    this.problems = [];
    this.checked = 0;
    /** Network failures that are expected at that moment (e.g. 401 before sign-in). */
    this.allowedFailures = [];
    this.requests = new Map();
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async init() {
    this.cdp.on((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      const p = msg.params;
      switch (msg.method) {
        case 'Runtime.consoleAPICalled':
          if (p.type === 'error' || p.type === 'assert') {
            this.problems.push({ kind: 'console', text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
          }
          break;
        case 'Runtime.exceptionThrown':
          this.problems.push({ kind: 'exception', text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text });
          break;
        case 'Log.entryAdded':
          if (p.entry.level === 'error' && p.entry.source !== 'network') {
            this.problems.push({ kind: `log:${p.entry.source}`, text: `${p.entry.text} ${p.entry.url ?? ''}`.trim() });
          }
          break;
        case 'Network.requestWillBeSent':
          this.requests.set(p.requestId, { url: p.request.url, method: p.request.method });
          break;
        case 'Network.responseReceived': {
          const { status, url } = p.response;
          if (status >= 400) this.networkFailure(`${this.requests.get(p.requestId)?.method ?? 'GET'} ${url} ${status}`);
          break;
        }
        case 'Network.loadingFailed':
          if (!p.canceled) this.networkFailure(`${this.requests.get(p.requestId)?.method ?? 'GET'} ${this.requests.get(p.requestId)?.url ?? '?'} ${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ''}`);
          break;
      }
    });
    await Promise.all([this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'), this.send('Network.enable'), this.send('DOM.enable')]);
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    // A person in Hawaiʻi, whatever zone this machine (or a UTC CI runner) is in.
    await this.send('Emulation.setTimezoneOverride', { timezoneId: TIME_ZONE });
    // CSP violations as console errors, so they land in `problems` with what was blocked.
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `document.addEventListener('securitypolicyviolation', (e) => console.error('[csp] ' + e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + ' on ' + location.pathname));`,
    });
  }

  networkFailure(text) {
    if (this.allowedFailures.some((pattern) => pattern.test(text))) return;
    this.problems.push({ kind: 'network', text });
  }

  /** Throws if anything went wrong since the last check. */
  assertClean(where) {
    const fresh = this.problems.slice(this.checked);
    this.checked = this.problems.length;
    if (fresh.length) throw new Error(`${where}: the page reported problems:\n  ${fresh.map((p) => `${p.kind}: ${p.text}`).join('\n  ')}`);
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`page eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }

  async goto(url) {
    const loaded = this.cdp.once('Page.loadEventFired', this.sessionId);
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /** Polls a page expression until it is truthy; returns its value. */
  async waitFor(expression, { timeout = 10_000, what = expression } = {}) {
    const until = Date.now() + timeout;
    let last;
    while (Date.now() < until) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch {
        // navigating: the context is gone for a moment
      }
      await sleep(150);
    }
    throw new Error(`timed out after ${timeout} ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
  }

  path() {
    return this.eval('location.pathname + location.search');
  }

  text() {
    return this.eval('document.body.innerText');
  }

  waitForText(text, options = {}) {
    return this.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, { what: JSON.stringify(text), ...options });
  }

  waitForPath(path, options = {}) {
    return this.waitFor(`location.pathname === ${JSON.stringify(path)}`, { what: `path ${path}`, ...options });
  }

  /** Clicks the visible button/link/menu item with this name, with a real mouse press. */
  async click(name, { selector = null, timeout = 10_000 } = {}) {
    const find = selector ? `byName(${JSON.stringify(selector)}, ${JSON.stringify(name)})` : `byName(CLICKABLE, ${JSON.stringify(name)})`;
    const point = await this.waitFor(
      `(() => { ${FIND} const el = ${find}; if (!el || el.disabled) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      { timeout, what: `clickable "${name}"` },
    );
    await this.mouseClick(point);
  }

  async mouseClick({ x, y }) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /** Types into the field with this label, replacing what is there, as keyboard input. */
  async type(label, text) {
    await this.waitFor(
      `(() => { ${FIND} const el = byLabel(${JSON.stringify(label)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); el.select?.(); return document.activeElement === el; })()`,
      { what: `field "${label}"` },
    );
    await this.send('Input.insertText', { text });
  }

  /** Sets a value the way a native picker does (time inputs), firing input and change. */
  async setValue(label, value) {
    await this.waitFor(
      `(() => { ${FIND} const el = byLabel(${JSON.stringify(label)}); if (!el) return false;
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === ${JSON.stringify(value)}; })()`,
      { what: `value of "${label}"` },
    );
  }

  /** Ticks or unticks the checkbox with this label (or aria-label). */
  async check(label, checked = true) {
    await this.waitFor(
      `(() => { ${FIND} let el = byLabel(${JSON.stringify(label)});
        if (!el) el = [...document.querySelectorAll('label')].find((l) => norm(l.textContent).includes(${JSON.stringify(label)}))?.querySelector('input[type=checkbox]') ?? null;
        if (!el) return false; if (el.checked !== ${checked}) el.click(); return el.checked === ${checked}; })()`,
      { what: `checkbox "${label}"` },
    );
  }

  async setFile(selector, path) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no ${selector}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files: [path] });
  }

  async shot(name) {
    this.shotCount += 1;
    const file = `${this.shotsDir}/${String(this.shotCount).padStart(2, '0')}-${name}.png`;
    await this.eval('document.fonts.ready.then(() => true)');
    await sleep(250);
    const metrics = await this.send('Page.getLayoutMetrics');
    const height = Math.min(Math.ceil(metrics.cssContentSize.height), 6000);
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: Math.max(height, 900), scale: 1 },
    });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}

/** Launches Chrome with a fresh profile and one page. Downloads go to `downloadDir`. */
export async function openBrowser({ downloadDir, shotsDir }) {
  const browser = await launchChrome(['--window-size=1280,900', '--disable-background-networking', '--disable-component-update']);
  const { cdp } = browser;
  const downloads = new Map();
  cdp.on((msg) => {
    if (msg.method === 'Browser.downloadWillBegin') downloads.set(msg.params.guid, { name: msg.params.suggestedFilename, state: 'started' });
    if (msg.method === 'Browser.downloadProgress' && downloads.has(msg.params.guid)) downloads.get(msg.params.guid).state = msg.params.state;
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadDir, eventsEnabled: true });
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId, { shotsDir });
  await page.init();

  async function waitForDownload(timeout = 15_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      for (const [guid, d] of downloads) if (d.state === 'completed') return { guid, name: d.name, path: `${downloadDir}/${guid}` };
      await sleep(100);
    }
    throw new Error('no download completed');
  }

  async function cookie(name) {
    const { cookies } = await cdp.send('Storage.getCookies');
    return cookies.find((c) => c.name === name) ?? null;
  }

  return { page, cdp, waitForDownload, cookie, close: browser.close };
}
