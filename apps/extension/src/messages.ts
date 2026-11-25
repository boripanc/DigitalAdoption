// Messages between the popup / content script and the background worker.
// Only the background worker talks to the API, so the API URL and token never touch the host page.
import type { AuthResponse, Flow, TrackEvent, User, Workspace } from '@guidepost/shared';

export interface Session {
  apiUrl: string;
  dashboardUrl: string;
  token?: string;
  user?: User;
  workspace?: Workspace;
}

export type Request =
  | { kind: 'session' }
  | { kind: 'login'; apiUrl: string; dashboardUrl: string; email: string; password: string }
  | { kind: 'logout' }
  | { kind: 'listFlows'; host: string }
  | { kind: 'getFlow'; id: string }
  | { kind: 'createFlow'; flow: Pick<Flow, 'name' | 'host' | 'steps'> }
  | { kind: 'updateFlow'; id: string; patch: Partial<Pick<Flow, 'name' | 'status' | 'steps'>> }
  | { kind: 'deleteFlow'; id: string }
  | { kind: 'track'; events: TrackEvent[] };

export type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string; status?: number };

export type ResponseFor<R extends Request> = R extends { kind: 'session' }
  ? Session
  : R extends { kind: 'login' }
    ? AuthResponse
    : R extends { kind: 'listFlows' }
      ? Flow[]
      : R extends { kind: 'getFlow' | 'createFlow' | 'updateFlow' }
        ? Flow
        : unknown;

/** Send a request to the background worker. Never throws; check `.ok`. */
export function ask<R extends Request>(req: R): Promise<Result<ResponseFor<R>>> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(req, (res: Result<ResponseFor<R>> | undefined) => {
        if (chrome.runtime.lastError || !res) resolve({ ok: false, error: chrome.runtime.lastError?.message ?? 'No response from extension' });
        else resolve(res);
      });
    } catch (e) {
      // Happens after the extension is reloaded while an old content script is still on the page.
      resolve({ ok: false, error: 'The extension was updated. Reload this page.' });
    }
  });
}

/** Messages the popup sends to the content script in the active tab. */
export type TabCommand =
  | { kind: 'hello' }
  | { kind: 'startRecording'; name: string }
  | { kind: 'play'; flowId: string };

export interface TabHello { host: string; recording: boolean; playing: boolean }
