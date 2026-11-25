import { canEdit, type Flow } from '@guidepost/shared';
import { ask, type Session, type TabCommand, type TabHello } from './messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let tabId: number | undefined;
let host = '';
let session: Session;
let tabReady = false;

/** The popup is normally opened from a toolbar click; tests open it as a page and pass ?tab=<id>. */
async function findTab() {
  const forced = new URLSearchParams(location.search).get('tab');
  if (forced) return chrome.tabs.get(Number(forced));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendTab<T>(msg: TabCommand): Promise<T | null> {
  return new Promise((resolve) => {
    if (tabId === undefined) return resolve(null);
    chrome.tabs.sendMessage(tabId, msg, (res: T) => resolve(chrome.runtime.lastError ? null : res));
  });
}

function showMsg(id: string, text: string) {
  $(id).textContent = text;
  $(id).hidden = false;
}

async function renderFlows() {
  const box = $('flows');
  if (!host) {
    box.innerHTML = '<div class="muted">Open the web app you want to guide.</div>';
    return;
  }
  const r = await ask({ kind: 'listFlows', host });
  if (!r.ok) {
    if (r.status === 401) return init();
    box.innerHTML = '';
    return showMsg('msg', r.error);
  }
  const editor = canEdit(session.user!.role);
  if (!r.data.length) {
    box.innerHTML = `<div class="muted">${editor ? 'No guides yet. Name one above, press Record, then click through the app.' : 'No guides for this site yet.'}</div>`;
    return;
  }
  box.innerHTML = r.data
    .map((f: Flow) => `<div class="flow" data-id="${esc(f.id)}" data-status="${f.status}">
      <div class="top"><span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
        <button class="small primary" data-a="play" ${tabReady ? '' : 'disabled'}>Play</button>
        ${editor ? '<button class="small" data-a="del">Delete</button>' : ''}</div>
      <div class="meta">${editor ? `<span class="badge ${f.status}">${f.status === 'published' ? 'Published' : 'Draft'}</span>` : ''}
        <span>${f.steps.length} steps</span>
        ${editor ? `<button class="link" data-a="toggle">${f.status === 'published' ? 'Unpublish' : 'Publish'}</button>` : ''}</div></div>`)
    .join('');
}

$('flows').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
  const card = (e.target as HTMLElement).closest<HTMLElement>('.flow');
  if (!btn || !card) return;
  const id = card.dataset.id!;
  const a = btn.dataset.a;
  if (a === 'play') {
    await sendTab({ kind: 'play', flowId: id });
    window.close();
    return;
  }
  (btn as HTMLButtonElement).disabled = true;
  const r =
    a === 'toggle'
      ? await ask({ kind: 'updateFlow', id, patch: { status: card.dataset.status === 'published' ? 'draft' : 'published' } })
      : a === 'del' && confirm('Delete this guide? Its analytics are deleted too.')
        ? await ask({ kind: 'deleteFlow', id })
        : { ok: true as const, data: null };
  if (!r.ok) showMsg('msg', r.error);
  void renderFlows();
});

$('record').addEventListener('click', async () => {
  const res = await sendTab({ kind: 'startRecording', name: $<HTMLInputElement>('name').value.trim() || 'Untitled guide' });
  if (!res) return showMsg('msg', 'Reload this page once, then try again.');
  window.close();
});
$('name').addEventListener('keydown', (e) => e.key === 'Enter' && $('record').click());

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $<HTMLButtonElement>('loginBtn').disabled = true;
  $('loginMsg').hidden = true;
  const r = await ask({
    kind: 'login',
    email: $<HTMLInputElement>('email').value,
    password: $<HTMLInputElement>('password').value,
    apiUrl: $<HTMLInputElement>('apiUrl').value.trim(),
    dashboardUrl: $<HTMLInputElement>('dashboardUrl').value.trim(),
  });
  $<HTMLButtonElement>('loginBtn').disabled = false;
  if (!r.ok) return showMsg('loginMsg', r.error);
  void init();
});

$('logout').addEventListener('click', async () => {
  await ask({ kind: 'logout' });
  void init();
});
// A recording or guide that's running in another tab (or whose tab was closed) can continue here,
// for example when the next step is in an app the user opened themselves.
async function renderElsewhere() {
  const r = await ask({ kind: 'guideStatus' });
  const st = r.ok ? r.data : null;
  const show = !!st?.state && st.tabId !== tabId;
  $('elsewhere').hidden = !show;
  if (!show || !st?.state) return;
  const where = st.tabId === undefined ? 'its tab was closed' : 'in another tab';
  $('elsewhereText').textContent = st.state.recording
    ? `Recording "${st.state.recording.name}" (${st.state.recording.steps.length} steps), ${where}.`
    : `A guide is playing, ${where}.`;
  $<HTMLButtonElement>('here').disabled = !tabReady;
}
$('here').addEventListener('click', async () => {
  if (tabId === undefined) return;
  await ask({ kind: 'guideHere', tabId });
  window.close();
});
$('stopGuide').addEventListener('click', async () => {
  await ask({ kind: 'guideStop' });
  void renderElsewhere();
});

$('dashboard').addEventListener('click', () => chrome.tabs.create({ url: session.dashboardUrl }));
$('createWs').addEventListener('click', () => chrome.tabs.create({ url: `${$<HTMLInputElement>('dashboardUrl').value.replace(/\/$/, '')}/#/signup` }));

async function init() {
  const s = await ask({ kind: 'session' });
  if (!s.ok) return;
  session = s.data;
  const signedIn = !!session.user;
  $('signin').hidden = signedIn;
  $('app').hidden = !signedIn;
  if (!signedIn) {
    $<HTMLInputElement>('apiUrl').value = session.apiUrl;
    $<HTMLInputElement>('dashboardUrl').value = session.dashboardUrl;
    return;
  }
  $('who').textContent = `${session.user!.email} · ${session.workspace?.name ?? ''}`;
  $('recordBox').hidden = !canEdit(session.user!.role);
  $<HTMLButtonElement>('record').disabled = !tabReady;
  if (!tabReady && host) showMsg('msg', 'Reload this page once so Guidepost can run on it.');
  await Promise.all([renderFlows(), renderElsewhere()]);
}

(async () => {
  const tab = await findTab();
  tabId = tab?.id;
  const hello = await sendTab<TabHello>({ kind: 'hello' });
  tabReady = !!hello;
  try {
    host = hello?.host ?? (tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url).host : '');
  } catch {
    host = '';
  }
  $('host').textContent = host;
  await init();
})();
