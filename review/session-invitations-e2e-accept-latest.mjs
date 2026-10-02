import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || '/ms-playwright/chromium-1161/chrome-linux/chrome';
const PRIS_URL = process.env.BASE_URL_PRIS || 'http://pris-server:3004';
const API_URL = process.env.API_URL || 'http://api-server:3002';
const MAIL_URL = 'http://fake-mail:8025';
const RECIPIENT = 'inv-review-20261001-cand-2@example.test';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-e2e-'));
  const child = spawn(CHROME, [
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
    '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',
    `--user-data-dir=${profile}`,'about:blank',
  ], { stdio: ['ignore','ignore','ignore'] });
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch('http://127.0.0.1:9222/json/version');
      if (response.ok) return { child, profile };
    } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('Chromium CDP did not start');
}

class CDP {
  constructor(ws) { this.ws = ws; this.next = 1; this.pending = new Map(); ws.onmessage = (event) => { const m=JSON.parse(event.data); if (!m.id) return; const p=this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }; }
  send(method, params={}) { const id=this.next++; return new Promise((resolve,reject)=>{ this.pending.set(id,{resolve,reject}); this.ws.send(JSON.stringify({id,method,params})); }); }
  close() { this.ws.close(); }
}

async function connect() {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((target) => target.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ ws.onopen=resolve; ws.onerror=reject; });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return cdp;
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  return result.result.value;
}

async function waitFor(cdp, expression, label, timeout=20000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) {
    try { if (await evaluate(cdp, expression)) return; } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickText(cdp, text) {
  const ok = await evaluate(cdp, `(() => { const n=[...document.querySelectorAll('button,a')].find(n=>(n.textContent||'').includes(${JSON.stringify(text)})&&!n.disabled&&n.offsetParent!==null); if(!n)return false;n.click();return true; })()`);
  assert.equal(ok,true,`Missing clickable text: ${text}`);
}

const mail = await (await fetch(`${MAIL_URL}/messages`)).json();
const message = [...(mail.messages || [])].reverse().find((entry) => entry.recipient === RECIPIENT);
assert.ok(message, 'Synthetic invitation email not captured');
assert.match(message.subject, /^คำเชิญเข้าร่วมเซสชัน .+ ในงาน /);
assert.doesNotMatch(message.subject, /payment|receipt|ชำระเงิน|ใบเสร็จ/i);
const href = message.html.match(/href="([^"]*\/sessions\/confirm\?token=[a-f0-9]{64})"/i)?.[1];
assert.ok(href, 'Invitation response URL missing from synthetic mail');
const mailed = new URL(href);
assert.equal(mailed.origin, 'http://localhost:3004');
assert.equal(mailed.pathname, '/th/sessions/confirm');
const token = mailed.searchParams.get('token');
assert.match(token || '', /^[a-f0-9]{64}$/);

const chrome = await launchChrome();
const cdp = await connect();
try {
  const browserUrl = new URL(mailed.pathname + mailed.search, PRIS_URL).toString();
  await cdp.send('Page.navigate',{url:browserUrl});
  await waitFor(cdp, `document.body.innerText.includes('ยืนยันเข้าร่วม')`, 'PRIS invitation response');
  await clickText(cdp, 'ยืนยันเข้าร่วม');
  await waitFor(cdp, `document.body.innerText.includes('คุณยืนยันเข้าร่วมแล้ว')`, 'accepted terminal state');

  const api = await fetch(`${API_URL}/api/session-invitations/current`, { headers:{ authorization:`Bearer ${token}` } });
  assert.equal(api.status,200);
  const body = await api.json();
  assert.equal(body.status,'accepted');
  process.stdout.write(JSON.stringify({ok:true,mailCaptured:true,prisAccepted:true,apiStatus:body.status})+'\n');
} finally {
  cdp.close();
  chrome.child.kill('SIGKILL');
  fs.rmSync(chrome.profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
