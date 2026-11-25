import type { AuthResponse } from '@guidepost/shared';
import type { FrameCommand, GuideState, Request, Result, Session } from './messages';

const DEFAULTS: Session = { apiUrl: 'http://localhost:4000', dashboardUrl: 'http://localhost:5173' };

async function getSession(): Promise<Session> {
  const { session } = await chrome.storage.local.get('session');
  return { ...DEFAULTS, ...(session as Session | undefined) };
}
const saveSession = (session: Session) => chrome.storage.local.set({ session });

async function api<T>(method: string, path: string, body?: unknown, s?: Session): Promise<Result<T>> {
  const session = s ?? (await getSession());
  try {
    const res = await fetch(session.apiUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (res.status === 401 && session.token) {
      // Token expired or the account was removed: sign out locally.
      await saveSession({ apiUrl: session.apiUrl, dashboardUrl: session.dashboardUrl });
    }
    if (!res.ok) return { ok: false, status: res.status, error: (data as { error?: string })?.error ?? `Request failed (${res.status})` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: `Can't reach the Guidepost server at ${session.apiUrl}` };
  }
}

// =====================================================================
// Guide state: one recording or one guide being played at a time, owned by one tab.
// Kept in session storage so it survives the service worker going to sleep, page loads and moves
// between web apps. The owning tab changes when the guide continues in another tab.
// =====================================================================
type Stored = GuideState & { tabId?: number };

async function getGuide(): Promise<Stored | null> {
  return ((await chrome.storage.session.get('guide')).guide as Stored | undefined) ?? null;
}
const saveGuide = (g: Stored | null) => chrome.storage.session.set({ guide: g });
const strip = (g: Stored): GuideState => (g.recording ? { recording: g.recording } : { playing: g.playing! });

function toTab(tabId: number, msg: FrameCommand, frameId?: number) {
  chrome.tabs.sendMessage(tabId, msg, frameId === undefined ? {} : { frameId }).catch(() => {
    /* no content script there (yet): it asks for the state when it loads */
  });
}

const originOf = (url?: string) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/** Hand the guide to another tab. The old tab takes its UI down; the new one picks the guide up. */
async function moveTo(g: Stored, tabId: number) {
  if (g.tabId === tabId) return;
  if (g.tabId !== undefined) toTab(g.tabId, { kind: 'guide', state: null });
  const moved = { ...g, tabId };
  await saveGuide(moved);
  toTab(tabId, { kind: 'guide', state: strip(moved) });
}

/**
 * Whether the guide should follow the user into this tab. A recording follows tabs opened from the
 * recording tab while recording. A guide being played follows a tab that is on the app of the
 * current step, when that tab was opened from the guide's tab while playing, or the guide's tab is
 * on another app.
 * Either one is picked up by any tab once its own tab was closed.
 */
async function maybeAdopt(tab: chrome.tabs.Tab): Promise<Stored | null> {
  const g = await getGuide();
  if (!g || tab.id === undefined || g.tabId === tab.id) return g;
  const fromGuideTab = (await getSpawned()).includes(tab.id);
  let adopt = false;
  if (g.tabId === undefined) adopt = true;
  else if (g.recording) adopt = fromGuideTab;
  else if (g.playing?.stepUrl) {
    const want = originOf(g.playing.stepUrl);
    if (want && originOf(tab.pendingUrl || tab.url) === want) {
      const owner = await chrome.tabs.get(g.tabId).catch(() => null);
      adopt = fromGuideTab || originOf(owner?.url) !== want;
    }
  }
  if (!adopt) return g;
  await moveTo(g, tab.id);
  return { ...g, tabId: tab.id };
}

// Tabs opened from the guide's tab while the guide runs (a link with target=_blank, window.open).
// Only these pull the guide along; older tabs opened from the same page don't.
async function getSpawned(): Promise<number[]> {
  return ((await chrome.storage.session.get('spawned')).spawned as number[] | undefined) ?? [];
}
chrome.tabs.onCreated.addListener(async (tab) => {
  const g = await getGuide();
  if (g?.tabId === undefined || tab.id === undefined || tab.openerTabId !== g.tabId) return;
  await chrome.storage.session.set({ spawned: [...(await getSpawned()).slice(-19), tab.id] });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(maybeAdopt, () => {});
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const g = await getGuide();
  if (g?.tabId === tabId) await saveGuide({ ...g, tabId: undefined });
});

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<Result> {
  const tab = sender.tab;
  switch (req.kind) {
    case 'guideGet': {
      let g = await getGuide();
      if (tab?.active && g && g.tabId !== tab.id) g = await maybeAdopt(tab);
      return { ok: true, data: { state: g && tab && g.tabId === tab.id ? strip(g) : null, frameId: sender.frameId ?? 0 } };
    }
    case 'guideSet': {
      if (tab?.id === undefined || sender.frameId !== 0) return { ok: false, error: 'Only a page can change the guide' };
      const g = await getGuide();
      const mine = g?.tabId === tab.id;
      if (!req.state) {
        if (mine || g?.tabId === undefined) await saveGuide(null);
        toTab(tab.id, { kind: 'guide', state: null, echo: true });
        return { ok: true, data: null };
      }
      // A tab that lost the guide to another tab can't take it back by accident.
      if (g && !mine && !req.start) return { ok: false, error: 'The guide continued in another tab' };
      if (g?.tabId !== undefined && !mine) toTab(g.tabId, { kind: 'guide', state: null });
      if (!mine) await chrome.storage.session.set({ spawned: [] });
      await saveGuide({ ...req.state, tabId: tab.id });
      toTab(tab.id, { kind: 'guide', state: req.state, echo: true });
      return { ok: true, data: null };
    }
    case 'guideStatus': {
      const g = await getGuide();
      return { ok: true, data: { state: g ? strip(g) : null, tabId: g?.tabId } };
    }
    case 'guideHere': {
      const g = await getGuide();
      if (g) await moveTo(g, req.tabId);
      return { ok: true, data: null };
    }
    case 'guideStop': {
      const g = await getGuide();
      if (g?.tabId !== undefined) toTab(g.tabId, { kind: 'guide', state: null });
      await saveGuide(null);
      return { ok: true, data: null };
    }
    case 'guideGoto': {
      // "Take me there" for a step on another app: switch to a tab that already has that app open,
      // else open it next to the current tab. The guide moves along.
      const want = originOf(req.url);
      if (!want || !/^https?:/.test(want) || tab?.id === undefined) return { ok: false, error: 'Bad URL' };
      const g = await getGuide();
      if (originOf(tab.url) === want) {
        await chrome.tabs.update(tab.id, { url: req.url });
        return { ok: true, data: null };
      }
      const open = (await chrome.tabs.query({ windowId: tab.windowId })).find((t) => t.id !== tab.id && originOf(t.url) === want);
      const target = open
        ? await chrome.tabs.update(open.id!, { active: true })
        : await chrome.tabs.create({ url: req.url, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId });
      if (g && target?.id !== undefined) await moveTo(g, target.id);
      return { ok: true, data: null };
    }
    case 'toFrames':
      if (tab?.id === undefined) return { ok: false, error: 'No tab' };
      toTab(tab.id, req.msg, req.frameId);
      return { ok: true, data: null };
  }
  switch (req.kind) {
    case 'session': {
      const s = await getSession();
      // Hand out who is signed in, never the token itself.
      return { ok: true, data: { apiUrl: s.apiUrl, dashboardUrl: s.dashboardUrl, user: s.user, workspace: s.workspace } };
    }
    case 'login': {
      const base: Session = { apiUrl: req.apiUrl, dashboardUrl: req.dashboardUrl };
      const r = await api<AuthResponse>('POST', '/auth/login', { email: req.email, password: req.password }, base);
      if (r.ok) await saveSession({ ...base, token: r.data.token, user: r.data.user, workspace: r.data.workspace });
      else await saveSession(base);
      return r.ok ? { ok: true, data: { user: r.data.user, workspace: r.data.workspace } } : r;
    }
    case 'logout': {
      const s = await getSession();
      await saveSession({ apiUrl: s.apiUrl, dashboardUrl: s.dashboardUrl });
      const g = await getGuide();
      if (g?.tabId !== undefined) toTab(g.tabId, { kind: 'guide', state: null });
      await saveGuide(null);
      return { ok: true, data: null };
    }
    case 'listFlows':
      return api('GET', `/flows?host=${encodeURIComponent(req.host)}`);
    case 'getFlow':
      return api('GET', `/flows/${encodeURIComponent(req.id)}`);
    case 'createFlow':
      return api('POST', '/flows', { ...req.flow, status: 'draft' });
    case 'updateFlow':
      return api('PATCH', `/flows/${encodeURIComponent(req.id)}`, req.patch);
    case 'deleteFlow':
      return api('DELETE', `/flows/${encodeURIComponent(req.id)}`);
    case 'track':
      return api('POST', '/events', { events: req.events });
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, reply) => {
  handle(req, sender).then(reply, (e) => reply({ ok: false, error: String(e) }));
  return true; // keep the channel open for the async reply
});
