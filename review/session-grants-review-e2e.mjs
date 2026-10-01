import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const XLSX = require('/workspace/conference-backoffice/node_modules/xlsx');

const BACKOFFICE_URL = process.env.BASE_URL_BACKOFFICE || 'http://backoffice-server:3001';
const API_URL = process.env.API_URL || 'http://api-server:3002';
const PREFIX = 'sg-review-20260930';
const PASSWORD = 'ReviewOnly!2026';
const ADMIN_EMAIL = `${PREFIX}-admin@example.test`;
const ORGANIZER_EMAIL = `${PREFIX}-organizer@example.test`;
const EVENT_A_NAME = 'Session Grant Review Event A';
const EVENT_B_NAME = 'Session Grant Review Event B';
const SESSION_A_NAME = 'Review Active Session 1';
const SESSION_B_NAME = 'Review Active Session 2';
const RETRY_BATCH_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_DIR = '/workspace/conference-api/docs/superpowers/verification/admin-session-grants/review-artifacts';
const CHROME = '/ms-playwright/chromium-1161/chrome-linux/chrome';

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result || {});
        return;
      }
      const handlers = this.listeners.get(message.method) || [];
      for (const handler of handlers) handler(message.params || {});
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function startBrowser() {
  const profileDir = `/tmp/session-grants-review-${process.pid}`;
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    `--unsafely-treat-insecure-origin-as-secure=${BACKOFFICE_URL}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (chunk) => { stderr += String(chunk); });
  try {
    await waitForHttp('http://127.0.0.1:9222/json/version', 30_000);
  } catch (error) {
    chrome.kill('SIGKILL');
    throw new Error(`Chromium did not start: ${stderr.slice(-2000)}\n${error}`);
  }
  const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const pageTarget = targets.find((target) => target.type === 'page');
  assert.ok(pageTarget?.webSocketDebuggerUrl, 'Chromium page target must expose CDP websocket');
  const browserCdp = new Cdp(version.webSocketDebuggerUrl);
  const pageCdp = new Cdp(pageTarget.webSocketDebuggerUrl);
  await Promise.all([browserCdp.connect(), pageCdp.connect()]);
  await Promise.all([
    pageCdp.send('Page.enable'),
    pageCdp.send('Runtime.enable'),
    pageCdp.send('Network.enable'),
  ]);
  return { chrome, browserCdp, pageCdp, profileDir };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, expression);
      if (lastValue) return lastValue;
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'document.readyState === "complete"', `navigation ${url}`, 30_000);
  await sleep(250);
}

async function clickText(cdp, text) {
  const clicked = await evaluate(cdp, `(() => {
    const text = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll('button,a')].find((node) =>
      (node.textContent || '').includes(text) && !node.disabled && node.offsetParent !== null
    );
    if (!el) return false;
    el.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Expected clickable text: ${text}`);
}

async function clickSelector(cdp, selector) {
  const clicked = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Expected clickable selector: ${selector}`);
}

async function inputValue(cdp, selector, value) {
  const ok = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(ok, true, `Expected input: ${selector}`);
}

async function selectOptionText(cdp, optionText) {
  const ok = await evaluate(cdp, `(() => {
    const wanted = ${JSON.stringify(optionText)};
    for (const select of document.querySelectorAll('select')) {
      const option = [...select.options].find((candidate) => (candidate.textContent || '').trim() === wanted);
      if (!option) continue;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  })()`);
  assert.equal(ok, true, `Expected select option: ${optionText}`);
}

async function setCheckboxByLabel(cdp, labelPart, checked = true) {
  const ok = await evaluate(cdp, `(() => {
    const part = ${JSON.stringify(labelPart)};
    const el = [...document.querySelectorAll('input[type="checkbox"]')].find((node) =>
      (node.getAttribute('aria-label') || '').includes(part)
    );
    if (!el || el.disabled) return false;
    if (el.checked !== ${checked}) el.click();
    return el.checked === ${checked};
  })()`);
  assert.equal(ok, true, `Expected checkbox containing label: ${labelPart}`);
}

async function bodyText(cdp) {
  return evaluate(cdp, 'document.body.innerText');
}

async function screenshot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), Buffer.from(result.data, 'base64'));
}

async function apiLogin(email) {
  const response = await fetch(`${API_URL}/backoffice/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await response.json();
  assert.equal(response.status, 200, `API login failed for ${email}: ${JSON.stringify(data)}`);
  assert.ok(data.token);
  return data;
}

async function api(token, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${API_URL}${pathname}`, { ...options, headers });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, data };
}

async function uiLogin(cdp, email) {
  const sameOrigin = await evaluate(cdp, `location.origin === ${JSON.stringify(BACKOFFICE_URL)}`);
  if (sameOrigin) await evaluate(cdp, 'localStorage.clear(); sessionStorage.clear(); true');
  await navigate(cdp, `${BACKOFFICE_URL}/login`);
  if (!sameOrigin) await evaluate(cdp, 'localStorage.clear(); sessionStorage.clear(); true');
  await waitFor(cdp, 'document.querySelector("#email") !== null', `login form ${email}`);
  await inputValue(cdp, '#email', email);
  await inputValue(cdp, '#password', PASSWORD);
  await clickText(cdp, 'Sign in');
  await waitFor(cdp, `localStorage.getItem('backoffice_token') || sessionStorage.getItem('backoffice_token')`, `UI login token ${email}`, 60_000);
  if (await evaluate(cdp, 'location.pathname === "/login"')) {
    await navigate(cdp, `${BACKOFFICE_URL}/`);
  }
}

async function findReviewContext(adminToken) {
  const eventsResult = await api(adminToken, '/api/backoffice/events?limit=100');
  assert.equal(eventsResult.response.status, 200);
  const events = eventsResult.data.events || [];
  const eventA = events.find((event) => event.eventName === EVENT_A_NAME);
  const eventB = events.find((event) => event.eventName === EVENT_B_NAME);
  assert.ok(eventA && eventB, 'Review events must exist');
  const sessionsResult = await api(adminToken, `/api/backoffice/events/${eventA.id}/sessions?forGrant=true`);
  assert.equal(sessionsResult.response.status, 200);
  const sessions = sessionsResult.data.sessions || [];
  const sessionA = sessions.find((session) => session.sessionName === SESSION_A_NAME);
  const sessionB = sessions.find((session) => session.sessionName === SESSION_B_NAME);
  assert.ok(sessionA && sessionB, 'Review active sessions must exist');
  const registrationsResult = await api(adminToken, `/api/backoffice/registrations?page=1&limit=200&eventId=${eventA.id}`);
  assert.equal(registrationsResult.response.status, 200);
  const registrations = registrationsResult.data.registrations || [];
  const byCode = new Map(registrations.map((registration) => [registration.regCode, registration]));
  const wrongEventResult = await api(adminToken, `/api/backoffice/registrations?page=1&limit=10&eventId=${eventB.id}&search=SGREV-WRONG-EVENT`);
  assert.equal(wrongEventResult.response.status, 200);
  const wrongEventRegistration = (wrongEventResult.data.registrations || []).find((registration) => registration.regCode === 'SGREV-WRONG-EVENT');
  assert.ok(wrongEventRegistration, 'Wrong-event review Registration must exist');
  return { eventA, eventB, sessionA, sessionB, registrations, byCode, wrongEventRegistration };
}

async function downloadWorkbook(browserCdp, cdp, buttonText, filenamePrefix) {
  for (const entry of fs.readdirSync(ARTIFACT_DIR)) {
    if (entry.startsWith(filenamePrefix) && entry.endsWith('.xlsx')) fs.rmSync(path.join(ARTIFACT_DIR, entry));
  }
  await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: ARTIFACT_DIR, eventsEnabled: true });
  await clickText(cdp, buttonText);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = fs.readdirSync(ARTIFACT_DIR).find((entry) => entry.startsWith(filenamePrefix) && entry.endsWith('.xlsx'));
    if (found && fs.statSync(path.join(ARTIFACT_DIR, found)).size > 0) return path.join(ARTIFACT_DIR, found);
    await sleep(200);
  }
  throw new Error(`Timed out waiting for workbook ${filenamePrefix}*.xlsx`);
}

function workbookRows(file) {
  const workbook = XLSX.readFile(file);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

const gates = [];
async function gate(id, fn) {
  try {
    await fn();
    gates.push({ id, status: 'PASS' });
    process.stdout.write(`${id} PASS\n`);
  } catch (error) {
    gates.push({ id, status: 'FAIL', error: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`${id} FAIL: ${error instanceof Error ? error.stack : error}\n`);
    throw error;
  }
}

const { chrome, browserCdp, pageCdp } = await startBrowser();
const grantRequests = [];
pageCdp.on('Network.requestWillBeSent', ({ request }) => {
  if (request?.method === 'POST' && request.url.includes('/api/backoffice/session-grants')) {
    grantRequests.push({ url: request.url, headers: request.headers || {} });
  }
});
try {
  await waitForHttp(`${API_URL}/health`, 60_000);
  await waitForHttp(`${BACKOFFICE_URL}/login`, 60_000);

  const admin = await apiLogin(ADMIN_EMAIL);
  const organizer = await apiLogin(ORGANIZER_EMAIL);
  const context = await findReviewContext(admin.token);

  await gate('UI-01', async () => {
    await uiLogin(pageCdp, ORGANIZER_EMAIL);
    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations`);
    await waitFor(pageCdp, `document.body.innerText.includes(${JSON.stringify(EVENT_A_NAME)})`, 'organizer registration page');
    await selectOptionText(pageCdp, EVENT_A_NAME);
    await sleep(500);
    const hasGrantAction = await evaluate(pageCdp, `[...document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('เพิ่มสิทธิ์ Session'))`);
    assert.equal(hasGrantAction, false, 'non-admin must not see grant action');
    const direct = await api(organizer.token, '/api/backoffice/session-grants/status');
    assert.equal(direct.response.status, 403, 'non-admin direct session-grant API must be forbidden');
  });

  await uiLogin(pageCdp, ADMIN_EMAIL);
  await navigate(pageCdp, `${BACKOFFICE_URL}/registrations`);
  await waitFor(pageCdp, `document.body.innerText.includes(${JSON.stringify(EVENT_A_NAME)})`, 'admin event options');
  await selectOptionText(pageCdp, EVENT_A_NAME);
  await waitFor(pageCdp, `[...document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('เพิ่มสิทธิ์ Session'))`, 'grant action');

  await gate('UI-02', async () => {
    await clickText(pageCdp, 'เพิ่มสิทธิ์ Session');
    await waitFor(pageCdp, 'document.querySelector("dialog[open]") !== null', 'session dialog');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_A_NAME)})`, 'session dialog options');
    const dialogText = await evaluate(pageCdp, 'document.querySelector("dialog[open]").innerText');
    assert.match(dialogText, /Review Active Session 1/);
    assert.match(dialogText, /Review Inactive Session/);
    assert.match(dialogText, /Session ไม่เปิดใช้งาน/);
    assert.match(dialogText, /Review Ended Session/);
    assert.match(dialogText, /Session สิ้นสุดแล้ว/);
    await clickText(pageCdp, SESSION_A_NAME);
    await waitFor(pageCdp, `document.body.innerText.includes('เพิ่มสิทธิ์: ${SESSION_A_NAME}')`, 'selected session summary');
  });

  await gate('UI-03', async () => {
    await waitFor(pageCdp, `[...document.querySelectorAll('input[type="checkbox"]')].some((el) => (el.getAttribute('aria-label') || '').includes('SGREV-001'))`, 'grant eligibility rows');
    await setCheckboxByLabel(pageCdp, 'SGREV-001', true);
    await clickText(pageCdp, 'Next');
    await waitFor(pageCdp, `document.body.innerText.includes('SGREV-011')`, 'page 2 registrations');
    await setCheckboxByLabel(pageCdp, 'SGREV-011', true);
    await clickText(pageCdp, 'Prev');
    await waitFor(pageCdp, `[...document.querySelectorAll('input[type="checkbox"]')].some((el) => (el.getAttribute('aria-label') || '').includes('SGREV-001'))`, 'page 1 registration checkbox');
    const checked = await evaluate(pageCdp, `[...document.querySelectorAll('input[type="checkbox"]')].find((el) => (el.getAttribute('aria-label') || '').includes('SGREV-001'))?.checked === true`);
    assert.equal(checked, true);
    const summary = await bodyText(pageCdp);
    assert.match(summary, /เลือกแล้ว 2 \/ 500 Registration/);
  });

  await gate('UI-04', async () => {
    await inputValue(pageCdp, 'input[placeholder="Search by name, email, or code..."]', 'SGREV-011');
    await waitFor(pageCdp, `document.body.innerText.includes('SGREV-011')`, 'filtered registration');
    const summary = await bodyText(pageCdp);
    assert.match(summary, /เลือกแล้ว 2 \/ 500 Registration/);
    assert.match(summary, /SGREV-001/);
    assert.match(summary, /SGREV-011/);
    await inputValue(pageCdp, 'input[placeholder="Search by name, email, or code..."]', '');
    await sleep(500);
  });

  await gate('UI-05', async () => {
    await clickSelector(pageCdp, 'input[aria-label="เลือก Registration ที่มีสิทธิ์ทั้งหมดในหน้าปัจจุบัน"]');
    const text = await bodyText(pageCdp);
    const match = text.match(/เลือกแล้ว (\d+) \/ 500 Registration/);
    assert.ok(match);
    assert.equal(Number(match[1]), 9, 'select-all must add only eligible current-page rows while preserving off-page selection');
    assert.ok(Number(match[1]) < context.registrations.length, 'select-all must not select the full dataset');
  });

  await gate('UI-06', async () => {
    await evaluate(pageCdp, 'window.__reviewConfirm = false; window.confirm = () => window.__reviewConfirm; true');
    await clickText(pageCdp, `Session: ${SESSION_A_NAME}`);
    await waitFor(pageCdp, 'document.querySelector("dialog[open]") !== null', 'session change dialog');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_B_NAME)})`, 'session B option after dialog reopen');
    await clickText(pageCdp, SESSION_B_NAME);
    await sleep(300);
    assert.match(await bodyText(pageCdp), new RegExp(`เพิ่มสิทธิ์: ${SESSION_A_NAME}`));
    assert.match(await bodyText(pageCdp), /เลือกแล้ว 9 \/ 500 Registration/);
    await evaluate(pageCdp, 'window.__reviewConfirm = true; true');
    await clickText(pageCdp, `Session: ${SESSION_A_NAME}`);
    await waitFor(pageCdp, 'document.querySelector("dialog[open]") !== null', 'session change dialog accepted');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_B_NAME)})`, 'session B option after accepted reopen');
    await clickText(pageCdp, SESSION_B_NAME);
    await waitFor(pageCdp, `document.body.innerText.includes('เพิ่มสิทธิ์: ${SESSION_B_NAME}')`, 'session B selected');
    assert.match(await bodyText(pageCdp), /เลือกแล้ว 0 \/ 500 Registration/);
    await clickText(pageCdp, `Session: ${SESSION_B_NAME}`);
    await waitFor(pageCdp, 'document.querySelector("dialog[open]") !== null', 'switch back dialog');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_A_NAME)})`, 'session A option after switch-back reopen');
    await clickText(pageCdp, SESSION_A_NAME);
    await waitFor(pageCdp, `document.body.innerText.includes('เพิ่มสิทธิ์: ${SESSION_A_NAME}')`, 'session A restored');
  });

  await gate('UI-07', async () => {
    await waitFor(pageCdp, `[...document.querySelectorAll('input[type="checkbox"]')].some((el) => (el.getAttribute('aria-label') || '').includes('SGREV-002'))`, 'session A rows after switch-back');
    await setCheckboxByLabel(pageCdp, 'SGREV-002', true);
    const text = await bodyText(pageCdp);
    assert.match(text, /ผู้มีสิทธิ์ปัจจุบัน\s+\d+/);
    assert.match(text, /เลือกเพิ่ม\s+1/);
    assert.match(text, /หลังยืนยันโดยประมาณ\s+\d+/);
    assert.match(text, /ตรวจอีกครั้งตอนยืนยัน/);
    await setCheckboxByLabel(pageCdp, 'SGREV-002', false);
  });

  await gate('UI-08', async () => {
    const states = await evaluate(pageCdp, `(() => {
      const get = (code) => [...document.querySelectorAll('input[type="checkbox"]')].find((el) => (el.getAttribute('aria-label') || '').includes(code));
      const owned = get('SGREV-003');
      const cancelled = get('SGREV-004');
      return {
        ownedDisabled: !!owned?.disabled,
        ownedReason: owned?.getAttribute('title') || '',
        cancelledDisabled: !!cancelled?.disabled,
        cancelledReason: cancelled?.getAttribute('title') || '',
      };
    })()`);
    assert.equal(states.ownedDisabled, true);
    assert.match(states.ownedReason, /ALREADY_REGISTERED|มีสิทธิ์/);
    assert.equal(states.cancelledDisabled, true);
    assert.match(states.cancelledReason, /REGISTRATION_NOT_CONFIRMED|ยืนยัน/);
    const wrongResult = await api(admin.token, '/api/backoffice/session-grants', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ sessionId: context.sessionA.id, registrationIds: [context.wrongEventRegistration.id] }),
    });
    assert.equal(wrongResult.response.status, 201);
    assert.equal(wrongResult.data.skippedCount, 1);
    assert.equal(wrongResult.data.results[0].reasonCode, 'EVENT_MISMATCH');
  });

  await gate('UI-09', async () => {
    assert.equal(await evaluate(pageCdp, 'isSecureContext && typeof crypto.randomUUID === "function"'), true, 'review browser must provide secure-context crypto.randomUUID like production');
    await setCheckboxByLabel(pageCdp, 'SGREV-005', true);
    const doubleClickStart = grantRequests.length;
    await evaluate(pageCdp, `(() => {
      window.__reviewOriginalFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/session-grants') && String(init.method || 'GET').toUpperCase() === 'POST') {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        return window.__reviewOriginalFetch(input, init);
      };
      return true;
    })()`);
    const submitText = await evaluate(pageCdp, `[...document.querySelectorAll('button')].find((el) => (el.textContent || '').includes('ยืนยัน 1 คน'))?.textContent || ''`);
    assert.ok(submitText);
    await clickText(pageCdp, 'ยืนยัน 1 คน');
    await waitFor(pageCdp, `[...document.querySelectorAll('button')].some((node) => (node.textContent || '').includes('กำลังดำเนินการ') && node.disabled)`, 'disabled pending grant action');
    const secondClick = await evaluate(pageCdp, `(() => {
      const el = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').includes('กำลังดำเนินการ'));
      if (!el) return 'missing';
      const disabled = el.disabled;
      el.click();
      return disabled ? 'disabled' : 'enabled';
    })()`);
    assert.equal(secondClick, 'disabled');
    await waitFor(pageCdp, `document.body.innerText.includes('ผลการเพิ่มสิทธิ์ Session')`, 'double-click grant result');
    assert.equal(grantRequests.slice(doubleClickStart).length, 1, 'double click must produce one grant request');

    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations`);
    await waitFor(pageCdp, `document.body.innerText.includes(${JSON.stringify(EVENT_A_NAME)})`, 'event options before timeout retry scenario');
    await selectOptionText(pageCdp, EVENT_A_NAME);
    await waitFor(pageCdp, `[...document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('เพิ่มสิทธิ์ Session'))`, 'grant action before timeout retry scenario');
    await clickText(pageCdp, 'เพิ่มสิทธิ์ Session');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_A_NAME)})`, 'session A option before timeout retry scenario');
    await clickText(pageCdp, SESSION_A_NAME);
    await waitFor(pageCdp, `[...document.querySelectorAll('input[type="checkbox"]')].some((el) => (el.getAttribute('aria-label') || '').includes('SGREV-006'))`, 'registration rows before timeout retry scenario');
    await setCheckboxByLabel(pageCdp, 'SGREV-006', true);
    const retryNetworkStart = grantRequests.length;
    await evaluate(pageCdp, `(() => {
      window.__reviewOriginalFetch = window.fetch.bind(window);
      window.__reviewFailGrantOnce = true;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/session-grants') && String(init.method || 'GET').toUpperCase() === 'POST') {
          const headers = new Headers(init.headers || {});
          if (window.__reviewFailGrantOnce) {
            window.__reviewFailGrantOnce = false;
            sessionStorage.setItem('__reviewFirstGrantKey', headers.get('Idempotency-Key') || '');
            throw new TypeError('review synthetic timeout');
          }
        }
        return window.__reviewOriginalFetch(input, init);
      };
      return true;
    })()`);
    await clickText(pageCdp, 'ยืนยัน 1 คน');
    await waitFor(pageCdp, `[...document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('ลองคำขอเดิมอีกครั้ง'))`, 'retry same operation button');
    await clickText(pageCdp, 'ลองคำขอเดิมอีกครั้ง');
    await waitFor(pageCdp, `document.body.innerText.includes('ผลการเพิ่มสิทธิ์ Session')`, 'retry grant result');
    const firstKey = await evaluate(pageCdp, `sessionStorage.getItem('__reviewFirstGrantKey') || ''`);
    const retryRequests = grantRequests.slice(retryNetworkStart);
    assert.equal(retryRequests.length, 1, 'synthetic timeout must not reach the network; retry must send exactly one request');
    const retryHeaders = retryRequests[0].headers || {};
    const retryKeyEntry = Object.entries(retryHeaders).find(([name]) => name.toLowerCase() === 'idempotency-key');
    const retryKey = retryKeyEntry?.[1];
    assert.ok(firstKey);
    assert.ok(retryKey);
    assert.equal(firstKey, retryKey, 'retry after timeout must reuse the same idempotency key');
    await evaluate(pageCdp, `sessionStorage.removeItem('__reviewFirstGrantKey'); true`);
  });

  await gate('UI-10', async () => {
    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations`);
    await waitFor(pageCdp, `document.body.innerText.includes(${JSON.stringify(EVENT_A_NAME)})`, 'event options before partial-success scenario');
    await selectOptionText(pageCdp, EVENT_A_NAME);
    await waitFor(pageCdp, `[...document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('เพิ่มสิทธิ์ Session'))`, 'grant action before partial-success scenario');
    await clickText(pageCdp, 'เพิ่มสิทธิ์ Session');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_A_NAME)})`, 'session A option before partial-success scenario');
    await clickText(pageCdp, SESSION_A_NAME);
    await waitFor(pageCdp, `[...document.querySelectorAll('input[type="checkbox"]')].some((el) => (el.getAttribute('aria-label') || '').includes('SGREV-007'))`, 'registration rows before partial-success scenario');
    await setCheckboxByLabel(pageCdp, 'SGREV-007', true);
    await setCheckboxByLabel(pageCdp, 'SGREV-008', true);
    const stale = context.byCode.get('SGREV-007');
    const preGrant = await api(admin.token, '/api/backoffice/session-grants', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ sessionId: context.sessionA.id, registrationIds: [stale.id] }),
    });
    assert.equal(preGrant.response.status, 201);
    await clickText(pageCdp, 'ยืนยัน 2 คน');
    await waitFor(pageCdp, `document.body.innerText.includes('เพิ่มสำเร็จ 1 · ข้าม 1 · เลือกทั้งหมด 2')`, 'partial success summary');
    const text = await bodyText(pageCdp);
    assert.match(text, /ALREADY_REGISTERED/);
  });

  let largeBatch;
  await gate('UI-11', async () => {
    const ids = context.registrations
      .filter((registration) => /^SGREV-\d{3}$/.test(registration.regCode))
      .sort((a, b) => a.regCode.localeCompare(b.regCode))
      .slice(0, 101)
      .map((registration) => registration.id);
    const result = await api(admin.token, '/api/backoffice/session-grants', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ sessionId: context.sessionB.id, registrationIds: ids }),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.data.requestedCount, 101);
    largeBatch = result.data;
    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations?grantBatchId=${largeBatch.batchId}`);
    await waitFor(pageCdp, `document.body.innerText.includes('เลือกทั้งหมด 101')`, 'large batch results');
    const globalPending = await evaluate(pageCdp, `(() => {
      const texts = [...document.querySelectorAll('div')]
        .map((el) => (el.textContent || '').trim())
        .filter((text) => text.startsWith('รอส่ง'))
        .sort((a, b) => a.length - b.length);
      const text = texts[0] || '';
      const value = Number(text.slice('รอส่ง'.length).trim());
      return Number.isFinite(value) ? value : -1;
    })()`);
    const visiblePending = await evaluate(pageCdp, `[...document.querySelectorAll('tbody tr')].filter((row) => row.innerText.includes('pending')).length`);
    assert.ok(globalPending > visiblePending, `global pending ${globalPending} must include off-page item beyond visible pending ${visiblePending}`);
    assert.equal(await evaluate(pageCdp, `document.querySelectorAll('tbody > tr').length`), 100, 'results page is capped at 100 rows while global counts cover 101 requested');
  });

  await gate('UI-12', async () => {
    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations?grantBatchId=${RETRY_BATCH_ID}`);
    await waitFor(pageCdp, `document.body.innerText.includes('failed') && document.body.innerText.includes('unknown')`, 'failed/unknown batch');
    await setCheckboxByLabel(pageCdp, 'SGREV-103', true);
    await setCheckboxByLabel(pageCdp, 'SGREV-104', true);
    await evaluate(pageCdp, 'window.confirm = () => true; true');
    await clickText(pageCdp, 'ส่งซ้ำ (2)');
    await waitFor(pageCdp, `document.body.innerText.includes('รอส่ง 2')`, 'retry queued');
    const text = await bodyText(pageCdp);
    assert.doesNotMatch(text, /เลือกเฉพาะรายการ failed\/unknown/);
  });

  await gate('UI-13', async () => {
    await pageCdp.send('Page.reload', { ignoreCache: true });
    await waitFor(pageCdp, `document.body.innerText.includes('ผลการเพิ่มสิทธิ์ Session')`, 'batch reload');
    const reg105 = context.byCode.get('SGREV-105');
    assert.ok(reg105);
    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations/${reg105.id}`);
    await waitFor(pageCdp, `document.body.innerText.includes('SGREV-105')`, 'registration detail');
    await clickText(pageCdp, 'เพิ่มสิทธิ์ Session');
    await waitFor(pageCdp, 'document.querySelector("dialog[open]") !== null', 'detail add session dialog');
    await waitFor(pageCdp, `document.querySelector("dialog[open]")?.innerText.includes(${JSON.stringify(SESSION_A_NAME)})`, 'detail session A option');
    await clickText(pageCdp, SESSION_A_NAME);
    await waitFor(pageCdp, `document.body.innerText.includes('Admin-added Sessions')`, 'detail grant refresh');
    const storage = await evaluate(pageCdp, `JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })`);
    assert.ok(!storage.includes('SGREV-105'));
    assert.ok(!storage.includes(`${PREFIX}-105@example.test`));
  });

  await gate('UI-14', async () => {
    await pageCdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor(pageCdp, `[...document.querySelectorAll('button')].some((el) => (el.textContent || '').includes('เพิ่มสิทธิ์ Session') && !el.disabled && el.offsetParent !== null)`, 'visible detail grant action ready after mobile reflow');
    await evaluate(pageCdp, `(() => {
      window.__reviewUi14Events = [];
      window.__reviewUi14Record = (entry) => {
        const dialog = document.querySelector('dialog');
        window.__reviewUi14Events.push({
          ...entry,
          open: !!dialog?.open,
          activeTag: document.activeElement?.tagName || '',
          inside: !!dialog && dialog.contains(document.activeElement),
        });
      };
      document.addEventListener('cancel', (event) => window.__reviewUi14Record({ type: 'cancel', defaultPrevented: event.defaultPrevented }), true);
      document.addEventListener('close', () => window.__reviewUi14Record({ type: 'close' }), true);
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.target instanceof HTMLDialogElement) {
            window.__reviewUi14Record({ type: 'open-attribute' });
          }
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
      return true;
    })()`);
    await waitFor(pageCdp, `(() => {
      const el = [...document.querySelectorAll('button,a')].find((node) =>
        (node.textContent || '').includes('เพิ่มสิทธิ์ Session') && !node.disabled && node.offsetParent !== null
      );
      if (!el) return false;
      el.click();
      return true;
    })()`, 'click visible detail grant action after mobile reflow');
    await waitFor(pageCdp, `(() => {
      const dialog = document.querySelector('dialog[open]');
      return !!dialog && dialog.contains(document.activeElement);
    })()`, 'mobile dialog focused');
    await evaluate(pageCdp, `(() => {
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
          window.__reviewUi14Record({ type: 'keydown-tab', defaultPrevented: event.defaultPrevented, shiftKey: event.shiftKey });
        }
      }, false);
      return true;
    })()`);
    const focusStates = [];
    for (let index = 0; index < 8; index += 1) {
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await pageCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      focusStates.push(await evaluate(pageCdp, `(() => {
        const dialog = document.querySelector('dialog[open]');
        return {
          open: !!dialog,
          inside: !!dialog && dialog.contains(document.activeElement),
          activeTag: document.activeElement?.tagName || '',
          activeText: (document.activeElement?.textContent || '').trim().slice(0, 80),
        };
      })()`));
    }
    const dialogEvents = await evaluate(pageCdp, `window.__reviewUi14Events || []`);
    process.stdout.write(`UI-14 FOCUS ${JSON.stringify(focusStates)}\n`);
    process.stdout.write(`UI-14 EVENTS ${JSON.stringify(dialogEvents)}\n`);
    assert.equal(focusStates.every((state) => state.open && state.inside), true, 'focus must remain trapped in modal dialog');
    await clickSelector(pageCdp, 'dialog[open] button[aria-label="ปิด"]');
    await waitFor(pageCdp, 'document.querySelector("dialog[open]") === null', 'dialog close');
    assert.equal(await evaluate(pageCdp, `(document.activeElement?.textContent || '').includes('เพิ่มสิทธิ์ Session')`), true, 'focus must return to grant action');
    await pageCdp.send('Emulation.clearDeviceMetricsOverride');
    await screenshot(pageCdp, 'ui-14-mobile-detail.png');
  });

  let reportCheckin;
  await gate('REPORT-01', async () => {
    const reg103 = context.byCode.get('SGREV-103');
    assert.ok(reg103);
    const checkin = await api(admin.token, '/api/backoffice/checkins', {
      method: 'POST',
      body: JSON.stringify({ regCode: 'SGREV-103', sessionId: context.sessionB.id }),
    });
    assert.equal(checkin.response.status, 200, JSON.stringify(checkin.data));
    const detail = await api(admin.token, `/api/backoffice/registrations/${reg103.id}`);
    assert.equal(detail.response.status, 200);
    const entitlement = detail.data.registration.sessions.find((session) => session.sessionId === context.sessionB.id && session.source === 'admin_grant');
    assert.ok(entitlement);
    assert.equal(entitlement.ticketTypeId, null);
    const list = await api(admin.token, `/api/backoffice/checkins?page=1&limit=100&eventId=${context.eventA.id}&sessionId=${context.sessionB.id}&search=SGREV-103`);
    assert.equal(list.response.status, 200);
    assert.equal(list.data.checkins.length, 1);
    reportCheckin = list.data.checkins[0];
    assert.equal(reportCheckin.id, entitlement.id, 'attendee/check-in API must identify the same entitlement row');
    assert.equal(reportCheckin.source, 'admin_grant');
    await navigate(pageCdp, `${BACKOFFICE_URL}/checkins`);
    await waitFor(pageCdp, `document.body.innerText.includes(${JSON.stringify(EVENT_A_NAME)})`, 'checkins event options');
    await selectOptionText(pageCdp, EVENT_A_NAME);
    await waitFor(pageCdp, `document.body.innerText.includes('SGREV-103')`, 'admin-grant attendee visible in check-in UI');
    const occurrences = await evaluate(pageCdp, `[...document.querySelectorAll('tbody tr')].filter((row) => row.innerText.includes('SGREV-103')).length`);
    assert.equal(occurrences, 1);
    await screenshot(pageCdp, 'report-01-checkin-ui.png');
  });

  await gate('REPORT-02', async () => {
    const workbook = await downloadWorkbook(browserCdp, pageCdp, 'Export Excel', 'checkins_');
    const rows = workbookRows(workbook);
    const row = rows.find((candidate) => candidate['Reg Code'] === 'SGREV-103');
    assert.ok(row, 'check-in workbook must contain admin-granted attendee');
    assert.equal(row['Ticket'], '', 'null ticket entitlement must remain present with blank ticket cell');
    assert.equal(row['Source'], 'Admin Grant');
    assert.ok(String(row['Entitlement Added At']).length > 0);
    assert.equal(reportCheckin.ticketName, null);
    assert.equal(reportCheckin.source, 'admin_grant');
    assert.ok(reportCheckin.addedAt);
  });

  await gate('REPORT-03', async () => {
    await navigate(pageCdp, `${BACKOFFICE_URL}/registrations`);
    await waitFor(pageCdp, `document.body.innerText.includes(${JSON.stringify(EVENT_A_NAME)})`, 'registration export event options');
    await selectOptionText(pageCdp, EVENT_A_NAME);
    await waitFor(pageCdp, `document.body.innerText.includes('SGREV-001')`, 'registration export rows');
    const workbook = await downloadWorkbook(browserCdp, pageCdp, 'Export Excel', 'registrations_');
    const rows = workbookRows(workbook);
    const codes = rows.map((row) => row['Reg Code']);
    assert.equal(new Set(codes).size, codes.length, 'registration export must remain one row per Registration');
    assert.equal(codes.filter((code) => code === 'SGREV-103').length, 1);
    const reportsSource = fs.readFileSync('/workspace/conference-backoffice/src/app/reports/page.tsx', 'utf8');
    assert.match(reportsSource, /\/\/ Mock data/);
    await navigate(pageCdp, `${BACKOFFICE_URL}/reports`);
    await waitFor(pageCdp, `document.body.innerText.includes('Reports')`, 'reports mock page');
    assert.equal((await bodyText(pageCdp)).includes('Session Grant Review Event A'), false, 'mock reports page must not be treated as evidence for synthetic session-grant event reporting');
  });

  await screenshot(pageCdp, 'review-final-page.png');
  process.stdout.write(`${JSON.stringify({ ok: true, gates, artifacts: fs.readdirSync(ARTIFACT_DIR).sort() })}\n`);
} finally {
  pageCdp.close();
  browserCdp.close();
  chrome.kill('SIGTERM');
  await sleep(250);
  if (!chrome.killed) chrome.kill('SIGKILL');
}
