// Playback: find a step's element (waiting for it if needed), then keep reporting where it is and
// whether the user clicked it. Used by the top page for its own documents, and by agents in
// cross-origin iframes, which pass the rectangles up to the top page.
import type { Step } from '@guidepost/shared';
import { topRect } from './frames';
import { findElement } from './selector';

export interface FollowHooks {
  /** Called every animation frame once found: the element's box (null while it's gone, e.g. re-rendering). */
  rect(r: DOMRect | null): void;
  clicked(): void;
}

/** Returns a function that stops following. */
export function follow(step: Step, hooks: FollowHooks): () => void {
  let stopped = false;
  let target: Element | null = null;
  let doc: Document | null = null;
  let raf = 0, poll = 0, lost = 0, clicked = false;

  // Listen on the document rather than the element, because UI5 re-renders controls and replaces
  // their DOM nodes.
  const onClick = (e: Event) => {
    if (clicked || !target) return;
    try {
      if (!target.contains(e.target as Node)) return;
    } catch {
      return;
    }
    clicked = true;
    hooks.clicked();
  };
  const attach = (el: Element) => {
    target = el;
    if (el.ownerDocument !== doc) {
      doc?.removeEventListener('click', onClick, true);
      doc = el.ownerDocument;
      doc.addEventListener('click', onClick, true);
    }
  };
  const loop = () => {
    if (stopped || !target) return;
    if (!target.isConnected) {
      // Re-rendered or navigated away: look for it again, at most every few frames.
      if (lost++ % 10 === 0) {
        const again = findElement(step);
        if (again) attach(again);
      }
      hooks.rect(null);
    } else {
      lost = 0;
      hooks.rect(topRect(target));
    }
    raf = requestAnimationFrame(loop);
  };
  // Single-page apps (Fiori routes, launchpad iframes still loading) can show the element later
  // without a page load, so keep looking until stopped.
  const search = () => {
    if (stopped) return;
    const el = findElement(step);
    if (!el) {
      poll = window.setTimeout(search, 250);
      return;
    }
    attach(el);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    loop();
  };
  search();
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(poll);
    doc?.removeEventListener('click', onClick, true);
  };
}
