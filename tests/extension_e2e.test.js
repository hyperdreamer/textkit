'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension');

function extensionId(extensionPath) {
  const digest = crypto.createHash('sha256').update(fs.realpathSync(extensionPath)).digest('hex').slice(0, 32);
  return [...digest].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail(message);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

test('unpacked MV3 extension loads in Chromium and survives a worker restart', { timeout: 30_000 }, async (t) => {
  const chromium = ['chromium', 'chromium-browser', 'google-chrome']
    .find((binary) => spawnSync('sh', ['-c', `command -v ${binary}`]).status === 0);
  if (!chromium) {
    t.skip('Chromium is not installed');
    return;
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'textkit-chromium-'));
  const browser = spawn(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browserLog = '';
  browser.stdout.on('data', (chunk) => { browserLog += chunk; });
  browser.stderr.on('data', (chunk) => { browserLog += chunk; });
  t.after(() => {
    browser.kill('SIGTERM');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  await waitFor(
    () => fs.existsSync(portFile)
      || browser.exitCode !== null
      || (browserLog.includes('crashpad') && browserLog.includes('Operation not permitted')),
    'Chromium did not expose a DevTools port'
  );
  if (!fs.existsSync(portFile)) {
    const logPath = path.join(os.tmpdir(), `textkit-chromium-${Date.now()}.log`);
    fs.writeFileSync(logPath, browserLog || '(Chromium produced no stdout/stderr output.)\n');
    t.diagnostic(`Chromium launch log preserved at ${logPath}`);
    t.skip(`Chromium could not start in this environment (exit ${browser.exitCode})`);
    return;
  }
  const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  const base = `http://127.0.0.1:${port}`;
  const id = extensionId(EXTENSION);
  const popupTarget = await fetch(`${base}/json/new?chrome-extension://${id}/popup.html`, { method: 'PUT' }).then((response) => response.json());
  const popup = new CdpClient(popupTarget.webSocketDebuggerUrl);
  const browserCdp = new CdpClient(`ws://127.0.0.1:${port}${browserPath}`);
  t.after(() => { popup.close(); browserCdp.close(); });

  await popup.send('Runtime.enable');
  await waitFor(async () => {
    const result = await popup.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    return result.result.value === 'complete';
  }, 'Popup did not finish loading');

  const snapshot = await popup.send('Runtime.evaluate', {
    expression: `(() => ({
      title: document.title,
      mainCount: document.querySelectorAll('main').length,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('aria-selected')),
      panels: document.querySelectorAll('[role="tabpanel"]').length,
      liveRegions: document.querySelectorAll('[aria-live="polite"]').length,
      manifest: chrome.runtime.getManifest()
    }))()`,
    returnByValue: true
  });
  const value = snapshot.result.value;
  assert.equal(value.title, 'TextKit');
  assert.equal(value.mainCount, 1);
  assert.deepEqual(value.tabs, ['true', 'false', 'false', 'false']);
  assert.equal(value.panels, 4);
  assert.ok(value.liveRegions >= 3);
  assert.equal(value.manifest.manifest_version, 3);
  assert.equal(value.manifest.minimum_chrome_version, '116');
  assert.equal(value.manifest.permissions.includes('tabs'), false);

  let targets = await fetch(`${base}/json/list`).then((response) => response.json());
  const worker = await waitFor(
    () => {
      const target = targets.find((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${id}/`));
      if (target) return target;
      return fetch(`${base}/json/list`).then((response) => response.json()).then((items) => {
        targets = items;
        return items.find((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${id}/`));
      });
    },
    'TextKit service worker did not start'
  );
  await browserCdp.send('Target.closeTarget', { targetId: worker.id });

  const wake = await popup.send('Runtime.evaluate', {
    expression: 'chrome.runtime.sendMessage({type:"popup:get-state"}).then((response) => Boolean(response?.ok))',
    awaitPromise: true,
    returnByValue: true
  });
  assert.equal(wake.result.value, true);
  await waitFor(async () => {
    const items = await fetch(`${base}/json/list`).then((response) => response.json());
    return items.some((item) => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${id}/`));
  }, 'TextKit service worker did not restart');
  } catch (error) {
    const logPath = path.join(os.tmpdir(), `textkit-chromium-${Date.now()}.log`);
    fs.writeFileSync(logPath, browserLog || '(Chromium produced no stdout/stderr output.)\n');
    t.diagnostic(`Chromium log preserved at ${logPath}`);
    throw error;
  }
});
