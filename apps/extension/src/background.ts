import type { AuthResponse } from '@guidepost/shared';
import type { Request, Result, Session } from './messages';

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

async function handle(req: Request): Promise<Result> {
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
      await chrome.storage.local.remove(['recording', 'playing']);
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

chrome.runtime.onMessage.addListener((req: Request, _sender, reply) => {
  handle(req).then(reply, (e) => reply({ ok: false, error: String(e) }));
  return true; // keep the channel open for the async reply
});
