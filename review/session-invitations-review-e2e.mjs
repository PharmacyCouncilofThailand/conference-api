import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const BACKOFFICE_URL = process.env.BASE_URL_BACKOFFICE || 'http://backoffice-server:3001';
const PRIS_URL = process.env.BASE_URL_PRIS || 'http://pris-server:3004';
const API_URL = process.env.API_URL || 'http://api-server:3002';
const ADMIN_EMAIL = 'inv-review-20261001-admin@example.test';
const PASSWORD = 'InvitationReview!2026';
const EVENT_NAME = 'Session Invitation Review Event';
const UI_SESSION = 'Invitation UI Capacity';
const RESPONSE_SESSION = 'Invitation Response Review';
const CHROME = '/ms-playwright/chromium-1161/chrome-linux/chrome';

const tokens = {
  accept: process.env.INV_TOKEN_ACCEPT || '',
  decline: process.env.INV_TOKEN_DECLINE || '',
  uncertain: process.env.INV_TOKEN_UNCERTAIN || '',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws?.close(); }
}

async function waitForHttp(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function startBrowser() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222',
    `--unsafely-treat-insecure-origin-as-secure=${BACKOFFICE_URL},${PRIS_URL}`,
    `--user-data-dir=/tmp/session-invitations-review-${process.pid}`,
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForHttp('http://127.0.0.1:9222/json/version', 30000);
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const target = targets.find((entry) => entry.type === 'page');
  assert.ok(target?.webSocketDebuggerUrl);
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
  await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true }).catch(() => {});
  return { chrome, cdp };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result?.value;
}
async function waitFor(cdp, expression, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await evaluate(cdp, expression); if (last) return last; } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}
async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await waitFor(cdp, 'document.readyState === "complete"', `navigation ${url}`, 30000);
  await sleep(250);
}
async function clickText(cdp, text) {
  const ok = await evaluate(cdp, `(() => {
    const wanted=${JSON.stringify(text)};
    const el=[...document.querySelectorAll('button,a')].find(n=>(n.textContent||'').includes(wanted)&&!n.disabled&&n.offsetParent!==null);
    if(!el)return false; el.click(); return true;
  })()`);
  assert.equal(ok, true, `Expected clickable text: ${text}`);
}
async function focusText(cdp, text) {
  const ok = await evaluate(cdp, `(() => {
    const wanted=${JSON.stringify(text)};
    const el=[...document.querySelectorAll('button,a')].find(n=>(n.textContent||'').includes(wanted)&&!n.disabled&&n.offsetParent!==null);
    if(!el)return false; el.focus(); return document.activeElement===el;
  })()`);
  assert.equal(ok, true, `Expected focusable text: ${text}`);
}
async function pressKey(cdp, key, code=key, windowsVirtualKeyCode=0) {
  const down = {type:'rawKeyDown',key,code,windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode};
  if (key === 'Enter') Object.assign(down,{text:'\r',unmodifiedText:'\r'});
  await cdp.send('Input.dispatchKeyEvent',down);
  if (key === 'Enter') await cdp.send('Input.dispatchKeyEvent',{type:'char',key,code,text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode});
}
async function inputValue(cdp, selector, value) {
  const ok = await evaluate(cdp, `(() => {
    const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true;
  })()`);
  assert.equal(ok, true);
}
async function selectOptionText(cdp, text) {
  const ok = await evaluate(cdp, `(() => {
    const wanted=${JSON.stringify(text)};
    for(const select of document.querySelectorAll('select')){
      const option=[...select.options].find(o=>(o.textContent||'').trim()===wanted);
      if(!option)continue;
      const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      setter.call(select,option.value); select.dispatchEvent(new Event('change',{bubbles:true})); return true;
    }
    return false;
  })()`);
  assert.equal(ok, true, `Expected option: ${text}`);
}
async function setCheckbox(cdp, code, checked=true) {
  const ok = await evaluate(cdp, `(() => {
    const el=[...document.querySelectorAll('input[type="checkbox"]')].find(n=>(n.getAttribute('aria-label')||'').includes(${JSON.stringify(code)}));
    if(!el||el.disabled)return false; if(el.checked!==${checked})el.click(); return el.checked===${checked};
  })()`);
  assert.equal(ok, true, `Expected checkbox ${code}`);
}
async function bodyText(cdp) { return evaluate(cdp, 'document.body.innerText'); }

async function login(cdp, token, user) {
  await navigate(cdp, `${BACKOFFICE_URL}/login`);
  const authExpression = `(() => {
    const token = ${JSON.stringify(token)};
    const user = ${JSON.stringify(user)};
    localStorage.setItem('backoffice_token', token);
    localStorage.setItem('backoffice_user', JSON.stringify(user));
    return true;
  })()`;
  await evaluate(cdp, authExpression);
  await navigate(cdp, `${BACKOFFICE_URL}/registrations`);
  await waitFor(cdp, `location.pathname.includes('/registrations')`, 'authenticated registrations route');
}

async function apiLogin() {
  const response = await fetch(`${API_URL}/backoffice/login`, {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({email:ADMIN_EMAIL,password:PASSWORD}),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  return { token: body.token, user: body.user };
}
async function api(token, path, options={}) {
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  if (options.body) headers.set('content-type','application/json');
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}
const gates = [];
async function gate(id, fn) {
  try { await fn(); gates.push({id,status:'PASS'}); process.stdout.write(`${id} PASS\n`); }
  catch (error) {
    gates.push({id,status:'FAIL',error:error instanceof Error?error.message:String(error)});
    process.stderr.write(`${id} FAIL: ${error instanceof Error?error.stack:error}\n`);
    throw error;
  }
}

const { chrome, cdp } = await startBrowser();
try {
  await waitForHttp(`${API_URL}/health`);
  await waitForHttp(`${BACKOFFICE_URL}/login`);
  await waitForHttp(`${PRIS_URL}/th/sessions/confirm`);
  const adminAuth = await apiLogin();
  const adminToken = adminAuth.token;

  await gate('BOUI-01-05', async () => {
    await login(cdp, adminToken, adminAuth.user);
    await navigate(cdp, `${BACKOFFICE_URL}/registrations`);
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(EVENT_NAME)})`, 'event');
    await selectOptionText(cdp, EVENT_NAME);
    await focusText(cdp, 'เพิ่มสิทธิ์ Session');
    await pressKey(cdp, 'Enter', 'Enter', 13);
    await waitFor(cdp, '!!document.querySelector("dialog[open]")', 'dialog opened by keyboard');
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(UI_SESSION)})`, 'grant session options');
    assert.equal(await evaluate(cdp, 'document.querySelector("dialog[open]").contains(document.activeElement)'), true);
    await pressKey(cdp, 'Escape', 'Escape', 27);
    await waitFor(cdp, '!document.querySelector("dialog[open]")', 'dialog closed by Escape');
    await waitFor(cdp, `(document.activeElement?.textContent||'').includes('เพิ่มสิทธิ์ Session')`, 'dialog return focus');
    await pressKey(cdp, 'Enter', 'Enter', 13);
    await waitFor(cdp, '!!document.querySelector("dialog[open]")', 'dialog reopened by keyboard');
    await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(UI_SESSION)})`, 'grant session options after reopen');
    await clickText(cdp, UI_SESSION);
    await waitFor(cdp, `document.body.innerText.includes('เพิ่มสิทธิ์: ${UI_SESSION}')`, 'session selected');
    await waitFor(cdp, `[...document.querySelectorAll('input[type="checkbox"]')].some(el=>(el.getAttribute('aria-label')||'').includes('INV-CAND-1'))`, 'rows');
    await setCheckbox(cdp, 'INV-CAND-1', true);
    await clickText(cdp, 'Next');
    await waitFor(cdp, `[...document.querySelectorAll('button')].some(n=>(n.textContent||'').includes('Prev')&&!n.disabled&&n.offsetParent!==null)`, 'next registration page');
    await clickText(cdp, 'Prev');
    await waitFor(cdp, `document.body.innerText.includes('INV-CAND-1')`, 'previous registration page');
    assert.match(await bodyText(cdp), /เลือกแล้ว 1 \/ 500 Registration/);
    await setCheckbox(cdp, 'INV-CAND-1', false);
  });

  await gate('BOUI-06', async () => {
    await setCheckbox(cdp, 'INV-CAND-1', true);
    await setCheckbox(cdp, 'INV-CAND-2', true);
    await evaluate(cdp, 'window.confirm=()=>true; true');
    await clickText(cdp, 'ยืนยัน 2 คน');
    await waitFor(cdp, `document.body.innerText.includes('ที่นั่งไม่พอ') || document.body.innerText.includes('SESSION_CAPACITY_EXCEEDED')`, 'capacity error');
    assert.match(await bodyText(cdp), /เลือกแล้ว 2 \/ 500 Registration/);
  });

  await gate('BOUI-08-12', async () => {
    await setCheckbox(cdp, 'INV-CAND-1', false);
    await waitFor(cdp, `document.body.innerText.includes('เลือกแล้ว 1 / 500 Registration')`, 'single selection after capacity error');
    await waitFor(cdp, `[...document.querySelectorAll('button')].some(n=>(n.textContent||'').trim()==='ยืนยัน 1 คน'&&!n.disabled&&n.offsetParent!==null)`, 'fresh single-item operation');
    await clickText(cdp, 'ยืนยัน 1 คน');
    await waitFor(cdp, `new URL(location.href).searchParams.has('grantBatchId')`, 'dynamic batch id');
    await waitFor(cdp, `document.body.innerText.includes('ผลการเพิ่มสิทธิ์ Session')`, 'batch');
    const text = await bodyText(cdp);
    assert.match(text, /สร้างคำเชิญแล้ว/);
    assert.match(text, /รอตอบรับ/);
    assert.match(text, /ATTEMPTS/i);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert.equal(await evaluate(cdp,'document.documentElement.scrollWidth <= window.innerWidth + 2'),true);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  });

  await gate('PRIS-01-03-06-07-14', async () => {
    assert.ok(tokens.accept);
    const url = `${PRIS_URL}/th/sessions/confirm?token=${tokens.accept}`;
    await navigate(cdp, url);
    await waitFor(cdp, `document.body.innerText.includes('ตอบรับคำเชิญเข้าร่วม Session')`, 'pris pending');
    let text = await bodyText(cdp);
    assert.match(text, /Invitation Response Review/);
    assert.match(text, /เวลาไทย \(Asia\/Bangkok\)/);
    assert.match(text, /ยืนยันเข้าร่วม/);
    await cdp.send('Page.reload',{ignoreCache:true});
    await waitFor(cdp, `location.pathname.includes('/th/sessions/confirm') && location.search.includes('token=')`, 'reload retained');
    await waitFor(cdp, `[...document.querySelectorAll('button,a')].some(n=>(n.textContent||'').includes('EN')&&!n.disabled&&n.offsetParent!==null)`, 'locale switch after reload');
    await clickText(cdp, 'EN');
    await waitFor(cdp, `location.pathname.includes('/en/sessions/confirm') && location.search.includes('token=')`, 'locale retained');
    assert.equal(await evaluate(cdp,`JSON.stringify({...localStorage,...sessionStorage}).includes(${JSON.stringify(tokens.accept)})`),false);
    const headers = await fetch(`${PRIS_URL}/th/sessions/confirm?token=${tokens.accept}`);
    assert.match(headers.headers.get('cache-control') || '', /no-store/);
    assert.equal(headers.headers.get('referrer-policy'),'no-referrer');
  });

  await gate('PRIS-04', async () => {
    await navigate(cdp, `${PRIS_URL}/th/sessions/confirm?token=${tokens.accept}`);
    await waitFor(cdp, `document.body.innerText.includes('ยืนยันเข้าร่วม')`, 'accept');
    await focusText(cdp, 'ยืนยันเข้าร่วม');
    await pressKey(cdp, 'Enter', 'Enter', 13);
    await waitFor(cdp, `document.body.innerText.includes('คุณยืนยันเข้าร่วมแล้ว')`, 'accepted');
  });

  await gate('PRIS-05', async () => {
    await navigate(cdp, `${PRIS_URL}/th/sessions/confirm?token=${tokens.decline}`);
    await waitFor(cdp, `document.body.innerText.includes('ปฏิเสธการเข้าร่วม')`, 'decline');
    await clickText(cdp, 'ปฏิเสธการเข้าร่วม');
    await waitFor(cdp, `document.body.innerText.includes('คุณปฏิเสธคำเชิญแล้ว')`, 'declined');
    assert.match(await bodyText(cdp), /คำตอบที่ส่งแล้วเปลี่ยนไม่ได้/);
  });

  await gate('PRIS-08-12-13', async () => {
    await navigate(cdp, `${PRIS_URL}/th/sessions/confirm`);
    await waitFor(cdp, `document.body.innerText.includes('ลิงก์คำเชิญไม่ถูกต้อง')`, 'invalid token');
    assert.doesNotMatch(await bodyText(cdp), /inv-review-20261001-/);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await navigate(cdp, `${PRIS_URL}/th/sessions/confirm?token=${tokens.uncertain}`);
    await waitFor(cdp, `document.body.innerText.includes('ยืนยันเข้าร่วม')`, 'mobile actions');
    assert.equal(await evaluate(cdp,'document.documentElement.scrollWidth <= window.innerWidth + 2'),true);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  });

  process.stdout.write(JSON.stringify({ok:true,gates})+'\n');
} finally {
  cdp.close();
  chrome.kill('SIGKILL');
}
