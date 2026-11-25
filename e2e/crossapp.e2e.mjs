// End-to-end check of guides that span web applications on different origins.
// Run after `npm run build`:  npm run test:e2e:crossapp   (screenshots land in e2e/screenshots/)
//
// Two small apps on different origins: an employee portal on http://localhost:8771 and an expenses
// app on http://127.0.0.1:8772. It checks that
//   A. a recording follows the author from the portal into the expenses app in a new tab,
//   B. playback follows the user the same way,
//   C. "Take me there" opens the other app when the user didn't click through,
//   D. the expenses app embedded in the portal through a cross-origin iframe (behind a same-origin
//      wrapper iframe) can be recorded and played with the spotlight in the right place.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'apps/extension/dist');
const shots = path.join(root, 'e2e/screenshots');
mkdirSync(shots, { recursive: true });
const API = 'http://localhost:4000';
const PORTAL = 'http://localhost:8771';
const EXPENSES = 'http://127.0.0.1:8772';
const procs = [];
const log = (...a) => console.log('•', ...a);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log('ok -', msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function api(method, url, body, token) {
  const r = await fetch(API + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
function serve(port, host) {
  const s = createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname) || 'portal.html';
    let body;
    try {
      body = readFileSync(path.join(root, 'e2e/crossapp', name));
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  s.listen(port, host);
  return s;
}

const extId = [...createHash('sha256').update(ext).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

let ctx;
const servers = [];
try {
  procs.push(spawn('npx', ['tsx', 'apps/api/src/server.ts'], { cwd: root, env: { ...process.env, DATABASE_URL: 'memory://', PORT: '4000' }, stdio: 'ignore', detached: true }));
  servers.push(serve(8771, 'localhost'), serve(8772, '127.0.0.1'));
  await waitHttp(`${API}/health`);
  await waitHttp(`${PORTAL}/portal.html`);
  await waitHttp(`${EXPENSES}/expenses.html`);
  const { token } = await api('POST', '/auth/signup', { workspaceName: 'Acme', email: 'xapp-owner@acme.test', password: 'password123' });

  ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const portal = await ctx.newPage();
  portal.on('pageerror', (e) => console.log('  page error:', e.message));
  await portal.goto(`${PORTAL}/portal.html`);

  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/popup.html`);
  const portalTab = await helper.evaluate(async () => {
    const me = await chrome.tabs.getCurrent();
    return (await chrome.tabs.query({})).find((t) => t.id !== me.id && t.url?.startsWith('http://localhost:8771'))?.id;
  });
  await helper.close();
  const popup = async (tab = portalTab) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 340, height: 480 });
    await p.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
    return p;
  };
  let pop = await popup();
  await pop.fill('#email', 'xapp-owner@acme.test');
  await pop.fill('#password', 'password123');
  await pop.click('#loginBtn');
  await pop.waitForSelector('#app:not([hidden])');
  await pop.close();
  check(true, 'signed in to the extension');

  const sh = (page, sel) => page.locator('#guidepost-root').locator(sel);
  const shadowText = (page, sel) => page.evaluate((s) => document.querySelector('#guidepost-root')?.shadowRoot.querySelector(s)?.textContent ?? null, sel);
  const hasBar = (page) => page.evaluate(() => !!document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.bar'));
  const record = async (page, name) => {
    const p = await popup();
    await p.fill('#name', name);
    await p.click('#record');
    await p.close().catch(() => {});
    await page.bringToFront();
    await sh(page, '.bar').waitFor();
  };
  const step = async (page, title, how) => {
    await sh(page, '.card.editor .t').fill(title);
    await sh(page, `[data-a="${how}"]`).click();
  };
  const finish = async (page, name) => {
    await sh(page, '[data-a="finish"]').click();
    await page.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.toast')?.textContent.includes('as a draft'));
    const flow = (await api('GET', '/flows', null, token)).find((f) => f.name === name);
    await api('PATCH', `/flows/${flow.id}`, { status: 'published' }, token);
    return flow;
  };
  const play = async (page, name) => {
    const p = await popup();
    await p.waitForSelector('.flow [data-a="play"]:not([disabled])');
    await p.locator('.flow', { hasText: name }).locator('[data-a="play"]').click();
    await p.close().catch(() => {});
    await page.bringToFront();
  };
  const expectStep = async (page, n, frame, selector, what) => {
    await page.waitForFunction((n) => {
      const r = document.querySelector('#guidepost-root')?.shadowRoot;
      return r?.querySelector('.spot') && r.querySelector('.card .count')?.textContent?.startsWith(`${n} of`);
    }, n, { timeout: 20_000 });
    await sleep(600); // the spotlight animates into place
    const box = await frame.locator(selector).first().boundingBox();
    const spot = await page.evaluate(() => {
      const r = document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.spot')?.getBoundingClientRect();
      return r && r.width ? { x: r.x + 4, y: r.y + 4, w: r.width - 8, h: r.height - 8 } : null;
    });
    const near = spot && box && Math.abs(spot.x - box.x) < 3 && Math.abs(spot.y - box.y) < 3 && Math.abs(spot.w - box.width) < 3;
    if (!near) console.log('  spot', spot, 'element', box);
    check(near, `step ${n}: spotlight is on ${what}`);
  };
  const finished = (page) =>
    page.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.toast')?.textContent.includes('You finished'));

  // ---------------------------------------------------------------
  // A. Record from the portal into the expenses app, which opens in a new tab
  // ---------------------------------------------------------------
  await record(portal, 'File an expense');
  await portal.click('#openExpenses');
  await sh(portal, '.card.editor').waitFor();
  const newTab = ctx.waitForEvent('page');
  await step(portal, 'Open Expenses', 'saveclick');
  let exp = await newTab;
  await exp.waitForLoadState();
  await sh(exp, '.bar').waitFor({ timeout: 10_000 });
  check(true, 'recording follows the author into the expenses app (other origin, new tab)');
  check((await shadowText(exp, '.bar .label')).includes('1 step'), 'the recorder bar in the new tab carries the steps recorded so far');
  await sleep(300);
  check(!(await hasBar(portal)), 'the portal tab stops showing the recorder');
  await exp.click('#new');
  await step(exp, 'Start a new claim', 'saveclick');
  await exp.waitForSelector('#form.open');
  await exp.click('#submit');
  await sh(exp, '.card.editor').waitFor();
  check((await shadowText(exp, '.bar .label')).includes('in 2 apps'), 'the recorder bar shows the guide spans 2 apps');
  await exp.screenshot({ path: `${shots}/crossapp-recording.png` });
  await step(exp, 'Submit it', 'save');
  check(await exp.evaluate(() => !window.__submitted), 'recording does not submit the claim');
  const flowA = await finish(exp, 'File an expense');
  check(flowA.host === 'localhost:8771', 'the guide starts on the portal');
  check(
    flowA.steps[0].url.startsWith(PORTAL) && flowA.steps[1].url.startsWith(EXPENSES) && flowA.steps[2].url.startsWith(EXPENSES),
    'steps are stored with the app they belong to (portal, then expenses)',
  );
  await exp.close();

  // ---------------------------------------------------------------
  // B. Play it: the guide follows the user into the new tab
  // ---------------------------------------------------------------
  await portal.goto(`${PORTAL}/portal.html`);
  await play(portal, 'File an expense');
  await expectStep(portal, 1, portal, '#openExpenses', 'the Open Expenses link in the portal');
  const newTab2 = ctx.waitForEvent('page');
  await portal.click('#openExpenses');
  exp = await newTab2;
  await exp.waitForLoadState();
  await expectStep(exp, 2, exp, '#new', 'New expense, in the expenses app in the new tab');
  await exp.screenshot({ path: `${shots}/crossapp-playback.png` });
  check(await portal.evaluate(() => !document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.spot')), 'the portal tab clears its spotlight once the guide moves on');
  await exp.click('#new');
  await expectStep(exp, 3, exp, '#submit', 'Submit claim');
  await exp.click('#submit');
  await finished(exp);
  check(await exp.evaluate(() => window.__submitted === 1), 'the user finishes the guide in the second app and the claim is submitted');
  await exp.close();

  // ---------------------------------------------------------------
  // C. "Take me there" when the user skips the link
  // ---------------------------------------------------------------
  await portal.bringToFront();
  await play(portal, 'File an expense');
  await expectStep(portal, 1, portal, '#openExpenses', 'step 1 again');
  await sh(portal, '[data-a="next"]').click();
  await portal.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.card .warn')?.textContent.includes('another app'), null, { timeout: 15_000 });
  check((await shadowText(portal, '.card .warn')).includes('127.0.0.1:8772'), 'a step in another app says which app it is in');
  await portal.screenshot({ path: `${shots}/crossapp-take-me-there.png` });
  const newTab3 = ctx.waitForEvent('page');
  await sh(portal, '[data-a="goto"]').click();
  exp = await newTab3;
  await exp.waitForLoadState();
  await expectStep(exp, 2, exp, '#new', 'New expense, after "Take me there" opened the app');
  await sh(exp, '[data-a="close"]').click();
  await exp.close();

  // ---------------------------------------------------------------
  // D. The expenses app inside the portal, through a cross-origin iframe
  // ---------------------------------------------------------------
  await portal.bringToFront();
  await portal.goto(`${PORTAL}/embed.html`);
  const inner = portal.frameLocator('#shell').frameLocator('#app');
  await inner.locator('#new').waitFor();
  await record(portal, 'Expense inside the portal');
  // Reload once: the recording lives in the extension, so it carries on. (This also works around
  // headless Chromium sometimes sending clicks meant for a nested cross-origin iframe to the
  // <iframe> element after the test switches tabs to the popup and back.)
  await portal.reload();
  await sh(portal, '.bar').waitFor();
  await inner.locator('#new').waitFor();
  check(true, 'recording carries on after a page reload');
  await inner.locator('#new').hover();
  await portal.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.hover')?.style.display === 'block');
  const hov = await portal.evaluate(() => document.querySelector('#guidepost-root').shadowRoot.querySelector('.hover').getBoundingClientRect().toJSON());
  const newBox = await inner.locator('#new').boundingBox();
  check(Math.abs(hov.x + 2 - newBox.x) < 3 && Math.abs(hov.y + 2 - newBox.y) < 3, 'hover outline lines up with an element two iframes down (same-origin, then cross-origin)');
  await inner.locator('#new').click();
  await sh(portal, '.card.editor').waitFor();
  check((await shadowText(portal, '.card.editor .target')).includes('in 127.0.0.1:8772'), 'step editor opens in the portal for a click inside the cross-origin iframe');
  await step(portal, 'Start a new claim', 'saveclick');
  await inner.locator('#form.open').waitFor();
  check(true, 'Save & click is performed inside the cross-origin iframe');
  await inner.locator('#submit').click();
  await sh(portal, '.card.editor').waitFor();
  await step(portal, 'Submit it', 'save');
  const appFrame = () => portal.frames().find((f) => f.url().startsWith(EXPENSES));
  check(await appFrame().evaluate(() => !window.__submitted), 'recording does not submit the claim inside the iframe');
  const flowD = await finish(portal, 'Expense inside the portal');
  check(flowD.steps.every((s) => s.frameOrigin === EXPENSES && s.url.startsWith(PORTAL)), 'steps keep the iframe origin and the portal page URL');

  await portal.reload();
  await inner.locator('#new').waitFor();
  await play(portal, 'Expense inside the portal');
  await expectStep(portal, 1, inner, '#new', 'New expense inside the cross-origin iframe');
  await portal.screenshot({ path: `${shots}/crossapp-iframe-playback.png` });
  await inner.locator('#new').click();
  await expectStep(portal, 2, inner, '#submit', 'Submit claim inside the cross-origin iframe');
  await inner.locator('#submit').click();
  await finished(portal);
  check(await appFrame().evaluate(() => window.__submitted === 1), 'guide finishes inside the cross-origin iframe');

  console.log('\nAll cross-application end-to-end checks passed.');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  for (const s of servers) s.close();
  for (const p of procs) try { process.kill(-p.pid); } catch {}
  process.exit();
}
