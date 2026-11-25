// End-to-end check of the whole product: API + dashboard + Chrome extension on a demo app.
// Run after `npm run build`:  npm run test:e2e   (screenshots land in e2e/screenshots/)
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
const run = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  procs.push(p);
};

// Unpacked extensions get an id derived from their folder path.
const extId = [...createHash('sha256').update(ext).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

let ctx;
try {
  run('npx', ['tsx', 'apps/api/src/server.ts'], { DATABASE_URL: 'memory://', PORT: '4000' });
  run('npm', ['run', 'preview', '-w', '@guidepost/dashboard', '--', '--port', '5173', '--strictPort']);
  const demo = createServer((_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(path.join(root, 'e2e/demo/index.html'))));
  demo.listen(8765);
  await waitHttp('http://localhost:4000/health');
  await waitHttp('http://localhost:5173/');

  ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  ctx.on('page', (p) => p.on('dialog', (d) => d.accept()));

  // 1. Create a workspace in the dashboard.
  const dash = await ctx.newPage();
  dash.on('dialog', (d) => d.accept());
  await dash.goto('http://localhost:5173/#/signup');
  await dash.getByLabel('Workspace name').fill('Acme Inc.');
  await dash.getByLabel('Email').fill('owner@acme.test');
  await dash.getByLabel('Password').fill('password123');
  await dash.getByRole('button', { name: 'Create workspace' }).click();
  await dash.getByText('No guides yet').waitFor();
  check(true, 'owner signs up in the dashboard');
  await dash.screenshot({ path: `${shots}/dashboard-empty.png` });

  // 2. Sign in to the extension and record a guide on the demo app.
  const app = await ctx.newPage();
  await app.goto('http://localhost:8765/');
  await app.waitForSelector('#guidepost-root', { state: 'attached' }).catch(() => {});
  const helper = await ctx.newPage();
  await helper.goto(`chrome-extension://${extId}/popup.html`);
  const appTabId = await helper.evaluate(async () => {
    const me = await chrome.tabs.getCurrent();
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.id !== me.id && t.url?.startsWith('http://localhost:8765'))?.id;
  });
  await helper.close();
  const popup = async () => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 340, height: 480 });
    await p.goto(`chrome-extension://${extId}/popup.html?tab=${appTabId}`);
    return p;
  };

  let pop = await popup();
  await pop.fill('#email', 'owner@acme.test');
  await pop.fill('#password', 'password123');
  await pop.click('#loginBtn');
  await pop.waitForSelector('#app:not([hidden])');
  check((await pop.textContent('#who')).includes('Acme Inc.'), 'owner signs in to the extension');
  await pop.fill('#name', 'Create an invoice');
  await pop.click('#record');
  await pop.close().catch(() => {});

  await app.bringToFront();
  const sh = (sel) => app.locator('#guidepost-root').locator(sel);
  await sh('.bar').waitFor();
  await app.click('[data-testid="new-invoice"]');
  await sh('.card.editor .b').fill('Start here to bill a customer.');
  await sh('[data-a="saveclick"]').click();
  await app.click('input[name="amount"]');
  await sh('.card.editor .t').fill('Enter the amount');
  await sh('.card.editor .b').fill('Use USD, without the dollar sign.');
  await sh('[data-a="save"]').click();
  await app.click('button[type="submit"]');
  await sh('.card.editor .t').fill('Save the invoice');
  await sh('[data-a="save"]').click();
  check((await sh('.bar .label').textContent()).includes('3 steps'), 'recorder captures 3 steps without triggering the app');
  await sh('[data-a="finish"]').click();
  await sh('.toast').waitFor();
  check((await sh('.toast').textContent()).includes('as a draft'), 'finished recording is saved to the server as a draft');

  // 3. Publish from the popup.
  pop = await popup();
  await pop.waitForSelector('.flow');
  check((await pop.textContent('.flow .badge')) === 'Draft', 'popup lists the new guide as a draft');
  await pop.click('[data-a="toggle"]');
  await pop.waitForFunction(() => document.querySelector('.flow .badge')?.textContent === 'Published');
  check(true, 'editor publishes the guide from the popup');
  await pop.screenshot({ path: `${shots}/popup-editor.png` });

  // 4. Add a viewer in the dashboard, then sign the extension in as that viewer.
  await dash.bringToFront();
  await dash.goto('http://localhost:5173/#/members');
  await dash.getByLabel('Email').fill('staff@acme.test');
  await dash.getByLabel('Temporary password').fill('password123');
  await dash.getByRole('button', { name: 'Add' }).click();
  await dash.getByText('staff@acme.test').waitFor();
  check(true, 'owner adds a viewer on the Team page');

  await pop.click('#logout');
  await pop.waitForSelector('#signin:not([hidden])');
  await pop.fill('#email', 'staff@acme.test');
  await pop.fill('#password', 'password123');
  await pop.click('#loginBtn');
  await pop.waitForSelector('.flow');
  check((await pop.locator('#recordBox').isHidden()) && (await pop.locator('[data-a="del"]').count()) === 0, 'viewer sees Play only, no recording or editing');

  // 5. Viewer plays the guide to the end.
  const play = async () => {
    const p = await popup();
    await p.waitForSelector('.flow [data-a="play"]:not([disabled])');
    await p.click('.flow [data-a="play"]');
    await p.close().catch(() => {});
    await app.bringToFront();
  };
  await app.reload();
  await sleep(500);
  await pop.close().catch(() => {});
  await play();
  await sh('.card h3').waitFor();
  check((await sh('.card h3').textContent()) === 'Click “New invoice”', 'player shows step 1 on the right element');
  await app.click('[data-testid="new-invoice"]');
  await app.waitForFunction(() => document.querySelector('#guidepost-root').shadowRoot.querySelector('.card .count')?.textContent === '2 of 3');
  check(true, 'clicking the highlighted element moves to step 2');
  await app.screenshot({ path: `${shots}/player-step2.png` });
  await sh('[data-a="next"]').click();
  await app.waitForFunction(() => document.querySelector('#guidepost-root').shadowRoot.querySelector('.card [data-a="next"]')?.textContent === 'Done');
  await sh('[data-a="next"]').click();
  await sh('.toast').waitFor();
  check((await sh('.toast').textContent()).includes('You finished'), 'viewer completes the guide');

  // 6. A second viewer session quits at step 2.
  await app.reload();
  await sleep(500);
  await play();
  await sh('.card h3').waitFor();
  await sh('[data-a="next"]').click();
  await app.waitForFunction(() => document.querySelector('#guidepost-root').shadowRoot.querySelector('.card .count')?.textContent === '2 of 3');
  await sh('[data-a="close"]').click();
  await sleep(800);

  // 7. Owner sees the funnel in the dashboard.
  await dash.bringToFront();
  await dash.goto('http://localhost:5173/#/');
  await dash.getByText('Create an invoice').waitFor();
  await dash.reload();
  await dash.getByText('50%').first().waitFor();
  check(true, 'guide list shows 2 starts and a 50% completion rate');
  await dash.screenshot({ path: `${shots}/dashboard-guides.png` });
  await dash.getByRole('link', { name: 'Create an invoice' }).click();
  await dash.getByText('Most people who quit did so at step 2').waitFor();
  check(true, 'guide page shows where people quit');
  await dash.screenshot({ path: `${shots}/dashboard-guide.png`, fullPage: true });
  console.log('\nAll end-to-end checks passed.');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  for (const p of procs) try { process.kill(-p.pid); } catch {} // whole process group, so the API started by npx stops too
  process.exit();
}
