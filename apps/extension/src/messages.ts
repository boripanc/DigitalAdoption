// Messages between the popup / content script and the background worker.
// Only the background worker talks to the API, so the API URL and token never touch the host page.
import type { AuthResponse, Flow, Step, TrackEvent, User, Workspace } from '@guidepost/shared';

export interface Session {
  apiUrl: string;
  dashboardUrl: string;
  token?: string;
  user?: User;
  workspace?: Workspace;
}

// ---------------------------------------------------------------------
// Guide state. The background worker owns it, so a recording or a guide being played survives
// page loads, moves between web apps and domains, and moves to another tab.
// ---------------------------------------------------------------------
export interface RecordingState { name: string; host: string; steps: Step[]; paused: boolean }
export interface PlayingState {
  flowId: string;
  index: number;
  sessionId: string;
  /** Page URL of the current step, so the background knows which app the guide is heading to. */
  stepUrl?: string;
}
/** Exactly one of the two is set. */
export type GuideState = { recording: RecordingState; playing?: undefined } | { playing: PlayingState; recording?: undefined };

/** Sent by the background (or the popup) to every frame of a tab. */
export type FrameCommand =
  /** The guide state for this tab. echo: the top frame of this tab made the change itself. */
  | { kind: 'guide'; state: GuideState | null; echo?: boolean }
  /** Playback: look for this step's element in your part of the page (cross-origin iframes). */
  | { kind: 'seek'; token: string; step: Step }
  | { kind: 'unseek' }
  /** Recording: perform (or forget) the click the author made on element `pickId`. */
  | { kind: 'click'; pickId: string }
  | { kind: 'drop'; pickId: string };

export type Request =
  | { kind: 'guideGet' }
  /** start: this tab takes the guide over from whichever tab had it. */
  | { kind: 'guideSet'; state: GuideState | null; start?: boolean }
  | { kind: 'guideStatus' }
  | { kind: 'guideHere'; tabId: number }
  | { kind: 'guideStop' }
  | { kind: 'guideGoto'; url: string }
  /** Forward a command to the frames of the sender's tab (one frame, or all of them). */
  | { kind: 'toFrames'; msg: FrameCommand; frameId?: number }
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

export interface GuideGet { state: GuideState | null; frameId: number }
export interface GuideStatus { state: GuideState | null; tabId?: number }

export type ResponseFor<R extends Request> = R extends { kind: 'guideGet' }
  ? GuideGet
  : R extends { kind: 'guideStatus' }
    ? GuideStatus
    : R extends { kind: 'session' }
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
