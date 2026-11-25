// Recording: catch the author's clicks (so the app doesn't act on them) and the element under the
// pointer, in a document and every same-origin iframe inside it, including iframes that appear later
// (a launchpad opens an app's iframe after you click its tile).
import { allFrames } from './frames';
import { isOurs } from './ui';

export interface CaptureHooks {
  /** Recording and not paused. */
  active(): boolean;
  /** The author is filling in a step, so clicks are swallowed but don't open another editor. */
  editing(): boolean;
  hover(el: Element | null): void;
  pick(el: Element): void;
}

let bypass = false;

/**
 * Clicks inside an iframe on another origin can also show up here as pointer events and a click on
 * the <iframe> element itself. The frame's own content script handles those (agent.ts), so leave them.
 */
const isFrameEl = (t: EventTarget | null) => /^(IFRAME|FRAME)$/.test((t as Element | null)?.tagName ?? ''); // not instanceof: other frames are other realms

export function startCapture(hooks: CaptureHooks) {
  const swallow = (e: Event) => {
    if (bypass || !hooks.active() || isOurs(e) || isFrameEl(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && !hooks.editing()) hooks.pick(e.target as Element);
  };
  const move = (e: MouseEvent) => !isFrameEl(e.target) && hooks.hover(bypass || !hooks.active() || isOurs(e) ? null : (e.target as Element));
  const hooked = new WeakSet<Window>();
  const hookFrames = () => {
    for (const { win } of allFrames()) {
      if (hooked.has(win)) continue;
      hooked.add(win);
      for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'submit']) win.addEventListener(t, swallow, true);
      win.addEventListener('mousemove', move, true);
    }
  };
  hookFrames();
  setInterval(hookFrames, 1000);
}

/** Perform a click the recorder held back ("Save & click"), without recording it again. */
export function clickThrough(el: Element) {
  bypass = true;
  try {
    realClick(el);
  } finally {
    bypass = false;
  }
}

/**
 * A full pointer + mouse + click sequence. Frameworks such as UI5 react to mousedown/mouseup
 * ("tap") rather than to click alone, so el.click() isn't enough there.
 */
function realClick(el: Element) {
  const win = (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, view: win, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new win.PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
  el.dispatchEvent(new win.MouseEvent('mousedown', { ...at, buttons: 1 }));
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new win.PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.MouseEvent('mouseup', at));
  el.dispatchEvent(new win.MouseEvent('click', at));
}
