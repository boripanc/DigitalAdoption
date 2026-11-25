// Messages from iframes up to the top page, for iframes on another origin (see agent.ts).
//
// The overlay (spotlight, cards, recorder bar) is drawn in the top page, so whatever happens in an
// iframe has to reach it with a position the top page can use. Each frame posts to its parent
// window; the parent's content script finds the <iframe> the message came from, shifts the
// rectangle by that iframe's position and passes it on to its own parent. This works through any
// mix of same-origin and cross-origin frames, because each hop only measures its own <iframe>.
//
// Page scripts can post messages too, so nothing here is trusted beyond its shape: the worst a page
// can do is move the spotlight or offer the author a step to save.
import type { Step } from '@guidepost/shared';

export interface Box { x: number; y: number; w: number; h: number }

export type UpMsg =
  /** Recording: the element under the pointer (null: none). */
  | { type: 'hover'; rect: Box | null }
  /** Recording: the author clicked an element. frameId routes "perform the click" back to it. */
  | { type: 'pick'; pickId: string; frameId: number; origin: string; where: Omit<Step, 'url' | 'title' | 'body'>; rect: Box }
  /** Playback: where the current step's element is (null: not on screen right now). */
  | { type: 'target'; token: string; rect: Box | null }
  | { type: 'targetClick'; token: string }
  /** A cross-origin frame (re)loaded and is ready for commands. */
  | { type: 'ready' };

const TAG = '__guidepost';
const TYPES = new Set(['hover', 'pick', 'target', 'targetClick', 'ready']);

export const toBox = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
export const toRect = (b: Box) => new DOMRect(b.x, b.y, b.w, b.h);

let deliver: (m: UpMsg) => void = () => {};
/** Top page only: handle messages that arrive from iframes. */
export function onFromFrames(fn: (m: UpMsg) => void) {
  deliver = fn;
}

export function sendUp(msg: UpMsg) {
  if (window === window.top) deliver(msg);
  else window.parent.postMessage({ [TAG]: msg }, '*');
}

const isBox = (b: unknown): b is Box =>
  !!b && typeof b === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((b as Record<string, unknown>)[k]));

window.addEventListener('message', (e) => {
  const m = (e.data as Record<string, unknown> | null)?.[TAG] as UpMsg | undefined;
  if (!m || typeof m !== 'object' || !TYPES.has(m.type) || !e.source) return;
  const iframe = [...document.querySelectorAll<HTMLIFrameElement>('iframe, frame')].find((f) => f.contentWindow === e.source);
  if (!iframe) return; // not from one of our child frames
  if ('rect' in m && m.rect !== null) {
    if (!isBox(m.rect)) return;
    const r = iframe.getBoundingClientRect();
    m.rect = { ...m.rect, x: m.rect.x + r.left + iframe.clientLeft, y: m.rect.y + r.top + iframe.clientTop };
  }
  sendUp(m);
});
