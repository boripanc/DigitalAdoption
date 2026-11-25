// End-to-end check of the extension on a SAP Fiori-style app (OpenUI5, hash routing, launchpad iframe).
// Run after `npm run build`:  npm run test:e2e:fiori   (screenshots land in e2e/screenshots/)
//
// The app in e2e/fiori is served by UI5 Tooling, which fetches OpenUI5 from npm. Playback happens
// on a reload with ?shift=N, which changes every generated UI5 id and the component id prefix, the
// way ids change between real Fiori sessions or between standalone and launchpad starts.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'apps/extension/dist');
const shots = path.join(root, 'e2e/screenshots');
mkdirSync(shots, { recursive: true });
const API = 'http://localhost:4000';
const UI5 = 'http://localhost:8766';
const procs = [];
const log = (...a) => console.log('•', ...a);
function check(cond, msg) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log('ok -', msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, tries = 300) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}
const run = (cmd, args, opts = {}) => {
  const p = spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, stdio: 'ignore', detached: true });
  procs.push(p);
};
async function api(method, url, body, token) {
  const r = await fetch(API + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const extId = [...createHash('sha256').update(ext).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

let ctx;
try {
  run('npx', ['tsx', 'apps/api/src/server.ts'], { env: { DATABASE_URL: 'memory://', PORT: '4000' } });
  run('npx', ['ui5', 'serve', '--port', '8766'], { cwd: path.join(root, 'e2e/fiori') });
  await waitHttp(`${API}/health`);
  await waitHttp(`${UI5}/index.html`);
  const { token } = await api('POST', '/auth/signup', { workspaceName: 'Acme', email: 'fiori-owner@acme.test', password: 'password123' });
  check(!!token, 'workspace created');

  ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  const app = await ctx.newPage();
  app.on('pageerror', (e) => console.log('  page error:', e.message));
  await app.goto(`${UI5}/index.html`);
  await app.waitForSelector('.sapMListTblRow', { timeout: 120_000 });

  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/popup.html`);
  const appTabId = await helper.evaluate(async () => {
    const me = await chrome.tabs.getCurrent();
    return (await chrome.tabs.query({})).find((t) => t.id !== me.id && t.url?.startsWith('http://localhost:8766'))?.id;
  });
  await helper.close();
  const popup = async () => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 340, height: 480 });
    await p.goto(`chrome-extension://${extId}/popup.html?tab=${appTabId}`);
    return p;
  };
  let pop = await popup();
  await pop.fill('#email', 'fiori-owner@acme.test');
  await pop.fill('#password', 'password123');
  await pop.click('#loginBtn');
  await pop.waitForSelector('#app:not([hidden])');
  await pop.close();

  const sh = (sel) => app.locator('#guidepost-root').locator(sel);
  const shadowText = (sel) => app.evaluate((s) => document.querySelector('#guidepost-root')?.shadowRoot.querySelector(s)?.textContent ?? null, sel);
  const record = async (name) => {
    const p = await popup();
    await p.fill('#name', name);
    await p.click('#record');
    await p.close().catch(() => {});
    await app.bringToFront();
    await sh('.bar').waitFor();
  };
  const step = async (title, how) => {
    await sh('.card.editor .t').fill(title);
    await sh(`[data-a="${how}"]`).click();
  };
  const finish = async (name) => {
    await sh('[data-a="finish"]').click();
    await app.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.toast')?.textContent.includes('as a draft'));
    await sleep(300);
    const flows = await api('GET', '/flows?host=localhost:8766', null, token);
    const flow = flows.find((f) => f.name === name);
    await api('PATCH', `/flows/${flow.id}`, { status: 'published' }, token);
    return flow;
  };
  const play = async (name) => {
    const p = await popup();
    await p.waitForSelector('.flow [data-a="play"]:not([disabled])');
    await p.locator('.flow', { hasText: name }).locator('[data-a="play"]').click();
    await p.close().catch(() => {});
    await app.bringToFront();
  };
  /** Wait for step N, then check the spotlight sits on the element the test expects. */
  const expectStep = async (n, frame, selector, what) => {
    await app.waitForFunction((n) => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.card .count')?.textContent?.startsWith(`${n} of`), n, { timeout: 30_000 });
    await sleep(600); // spotlight animates into place
    const el = frame.locator(selector).first();
    const box = await el.boundingBox();
    const spot = await app.evaluate(() => {
      const r = document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.spot')?.getBoundingClientRect();
      return r && r.width ? { x: r.x + 4, y: r.y + 4, w: r.width - 8, h: r.height - 8 } : null;
    });
    const near = spot && box && Math.abs(spot.x - box.x) < 3 && Math.abs(spot.y - box.y) < 3 && Math.abs(spot.w - box.width) < 3;
    if (!near) console.log('  spot', spot, 'element', box);
    check(near, `step ${n}: spotlight is on ${what}`);
  };

  // ---------------------------------------------------------------
  // A. Standalone Fiori app, hash routing (#/orders/PO-1002)
  // ---------------------------------------------------------------
  await record('Approve an order');
  await app.click('.sapMListTblRow:has-text("PO-1002")');
  const target1 = await shadowText('.card.editor .target');
  check(target1.startsWith('sap.m.ColumnListItem'), `recorder resolves a click on row text to the UI5 row control (${target1})`);
  await step('Open the order', 'saveclick');
  await app.waitForURL(/#\/orders\/PO-1002/);
  check(true, 'Save & click triggers UI5 navigation (hash route changes)');
  await app.waitForSelector('input[id$="--note-inner"]');
  await app.click('input[id$="--note-inner"]');
  check((await shadowText('.card.editor .target')).includes('sap.m.Input #detail--note'), 'recorder keeps the stable part of the UI5 id (detail--note)');
  await step('Add a note', 'saveclick');
  await app.click('button:has-text("Approve")');
  check((await shadowText('.card.editor .target')).startsWith('sap.m.Button'), 'recorder resolves the inner <bdi> of a button to sap.m.Button');
  await sleep(600); // let UI5's page transition finish
  await app.screenshot({ path: `${shots}/fiori-recording.png` });
  await step('Approve it', 'save');
  check(await app.evaluate(() => !window.__approved), 'recording does not trigger the app (no approval happened)');
  const flowA = await finish('Approve an order');
  check(flowA.steps[0].ui5?.type === 'sap.m.ColumnListItem' && flowA.steps[1].ui5?.id === 'detail--note' && flowA.steps[2].ui5?.text === 'Approve', 'UI5 control info is stored on the server with each step');

  // Play on a fresh load where every generated id is different.
  await app.goto(`${UI5}/index.html?shift=3`);
  await app.waitForSelector('.sapMListTblRow');
  const ids = await app.evaluate(() => document.querySelector('.sapMListTblRow').id);
  check(ids.includes('po3---'), `generated ids changed on reload (${ids})`);
  await play('Approve an order');
  await expectStep(1, app, '.sapMListTblRow:has-text("PO-1002")', 'the PO-1002 row');
  await app.click('.sapMListTblRow:has-text("PO-1002")');
  await expectStep(2, app, '[id$="--note"].sapMInput', 'the note input after the route change');
  await app.screenshot({ path: `${shots}/fiori-playback.png` });
  await app.click('input[id$="--note-inner"]');
  await expectStep(3, app, '.sapMBtn:has-text("Approve")', 'the Approve button, whose id is generated');
  await app.click('.sapMBtn:has-text("Approve")');
  await app.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.toast')?.textContent.includes('You finished'));
  check(await app.evaluate(() => window.__approved === 1), 'clicking the highlighted UI5 button still runs the app and finishes the guide');

  // ---------------------------------------------------------------
  // B. Launchpad that opens the app in an iframe
  // ---------------------------------------------------------------
  await app.goto(`${UI5}/launchpad.html#Shell-home`);
  await record('Approve from the launchpad');
  await app.click('.tile');
  await step('Open the app tile', 'saveclick');
  const appFrame = app.frameLocator('#application-PurchaseOrder-manage');
  await appFrame.locator('.sapMListTblRow').first().waitFor({ timeout: 60_000 });
  await appFrame.locator('.sapMListTblRow:has-text("PO-1003")').click();
  check((await shadowText('.card.editor .target')).includes('in frame'), 'recorder captures clicks inside the launchpad iframe');
  await step('Open the order', 'saveclick');
  await appFrame.locator('button:has-text("Approve")').click();
  await step('Approve it', 'save');
  const flowB = await finish('Approve from the launchpad');
  check(JSON.stringify(flowB.steps[1].frames) === JSON.stringify(['#application-PurchaseOrder-manage']), 'iframe path is stored with the step');

  await app.goto(`${UI5}/launchpad.html?shift=5#Shell-home`);
  await sleep(500);
  await play('Approve from the launchpad');
  await expectStep(1, app, '.tile', 'the launchpad tile');
  await app.click('.tile');
  // Playwright reports bounding boxes of iframe elements in top-page coordinates, like the spotlight.
  const frame = app.frameLocator('#application-PurchaseOrder-manage');
  await expectStep(2, frame, '.sapMListTblRow:has-text("PO-1003")', 'the PO-1003 row inside the iframe, once the app has loaded');
  await frame.locator('.sapMListTblRow:has-text("PO-1003")').click();
  await expectStep(3, frame, '.sapMBtn:has-text("Approve")', 'the Approve button inside the iframe');
  await app.screenshot({ path: `${shots}/fiori-launchpad-playback.png` });
  await frame.locator('.sapMBtn:has-text("Approve")').click();
  await app.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.toast')?.textContent.includes('You finished'));
  check(true, 'guide finishes across the launchpad page and the app iframe');

  // ---------------------------------------------------------------
  // C. Launchpad on one origin, app iframe on another (localhost vs 127.0.0.1)
  // ---------------------------------------------------------------
  const XO = 'http://127.0.0.1:8766';
  await app.goto(`${UI5}/launchpad.html?appOrigin=${encodeURIComponent(XO)}#Shell-home`);
  await record('Approve from another domain');
  await app.click('.tile');
  await step('Open the app tile', 'saveclick');
  const xFrame = app.frameLocator('#application-PurchaseOrder-manage');
  await xFrame.locator('.sapMListTblRow').first().waitFor({ timeout: 60_000 });
  await xFrame.locator('.sapMListTblRow:has-text("PO-1001")').click();
  const xLabel = await app.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.card.editor .target')?.textContent, null, { timeout: 10_000 }).then((h) => h.jsonValue());
  check(xLabel.startsWith('sap.m.ColumnListItem') && xLabel.includes('in 127.0.0.1:8766'), `recorder captures UI5 clicks inside a cross-origin app iframe (${xLabel})`);
  await step('Open the order', 'saveclick');
  await xFrame.locator('button:has-text("Approve")').waitFor();
  check(true, 'Save & click performs the click inside the cross-origin iframe');
  await xFrame.locator('button:has-text("Approve")').click();
  await sh('.card.editor').waitFor();
  await step('Approve it', 'save');
  const flowC = await finish('Approve from another domain');
  check(flowC.steps[1].frameOrigin === XO && flowC.steps[2].frameOrigin === XO && !flowC.steps[0].frameOrigin, 'steps in the cross-origin iframe are stored with its origin');

  await app.goto(`${UI5}/launchpad.html?shift=7&appOrigin=${encodeURIComponent(XO)}#Shell-home`);
  await sleep(500);
  await play('Approve from another domain');
  await expectStep(1, app, '.tile', 'the launchpad tile');
  await app.click('.tile');
  const xf = app.frameLocator('#application-PurchaseOrder-manage');
  await expectStep(2, xf, '.sapMListTblRow:has-text("PO-1001")', 'the PO-1001 row inside the cross-origin iframe');
  await app.screenshot({ path: `${shots}/fiori-cross-origin-playback.png` });
  await xf.locator('.sapMListTblRow:has-text("PO-1001")').click();
  await expectStep(3, xf, '.sapMBtn:has-text("Approve")', 'the Approve button inside the cross-origin iframe');
  await xf.locator('.sapMBtn:has-text("Approve")').click();
  await app.waitForFunction(() => document.querySelector('#guidepost-root')?.shadowRoot.querySelector('.toast')?.textContent.includes('You finished'));
  const approvedX = await app.frames().find((f) => f.url().startsWith(XO))?.evaluate(() => window.__approved);
  check(approvedX === 1, 'guide finishes in a launchpad whose app iframe is on another domain');
  console.log('\nAll Fiori end-to-end checks passed.');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  for (const p of procs) try { process.kill(-p.pid); } catch {} // whole process group (npx starts children)
  process.exit();
}
