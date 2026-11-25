import type { AuthResponse, Flow, FlowStats, User, Workspace } from '@guidepost/shared';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'guidepost.token';
export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
};
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Can't reach the Guidepost server at ${API_URL}`);
  }
  if (res.status === 401 && token) {
    setToken(null);
    window.dispatchEvent(new Event('guidepost:signedout'));
  }
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  signup: (b: { email: string; password: string; workspaceName: string }) => request<AuthResponse>('POST', '/auth/signup', b),
  login: (b: { email: string; password: string }) => request<AuthResponse>('POST', '/auth/login', b),
  me: () => request<{ user: User; workspace: Workspace }>('GET', '/me'),
  flows: () => request<Flow[]>('GET', '/flows'),
  flow: (id: string) => request<Flow>('GET', `/flows/${id}`),
  updateFlow: (id: string, patch: Partial<Pick<Flow, 'name' | 'status' | 'steps'>>) => request<Flow>('PATCH', `/flows/${id}`, patch),
  deleteFlow: (id: string) => request<void>('DELETE', `/flows/${id}`),
  analytics: () => request<FlowStats[]>('GET', '/analytics'),
  members: () => request<User[]>('GET', '/members'),
  addMember: (b: { email: string; password: string; role: User['role'] }) => request<User>('POST', '/members', b),
  setRole: (id: string, role: User['role']) => request<User>('PATCH', `/members/${id}`, { role }),
  removeMember: (id: string) => request<void>('DELETE', `/members/${id}`),
};
