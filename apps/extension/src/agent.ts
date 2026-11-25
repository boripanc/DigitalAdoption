// Runs in an iframe that the top page can't reach because it's on another origin (for example a
// Fiori app served from a different domain than the launchpad, or another web app embedded in a
// portal). It records and finds elements in its own document and in same-origin iframes inside it,
// and reports to the top page, which draws all the UI (see chain.ts for how positions get there).
import type { Step } from '@guidepost/shared';
import { clickThrough, startCapture } from './capture';
import { sendUp, toBox } from './chain';
import { topRect } from './frames';
import { follow } from './follow';
import { ask, type FrameCommand, type GuideState } from './messages';
import { describeTarget } from './selector';

export function runAgent() {
  let state: GuideState | null = null;
  let frameId = -1;
  const picks = new Map<string, Element>();
  let seek: { token: string; stop: () => void } | null = null;

  // Recording -----------------------------------------------------------
  let lastHover: Element | null = null;
  startCapture({
    active: () => !!state?.recording && !state.recording.paused && frameId >= 0,
    editing: () => false, // the top page ignores picks while the author is filling in a step
    hover(el) {
      if (!el && !lastHover) return;
      lastHover = el;
      sendUp({ type: 'hover', rect: el ? toBox(topRect(describeTarget(el).el)) : null });
    },
    pick(clicked) {
      const { el, ...where } = describeTarget(clicked);
      const pickId = crypto.randomUUID();
      picks.set(pickId, clicked);
      sendUp({ type: 'pick', pickId, frameId, origin: location.origin, where, rect: toBox(topRect(el)) });
    },
  });

  // Playback ------------------------------------------------------------
  function stopSeek() {
    seek?.stop();
    seek = null;
  }
  function startSeek(token: string, step: Step) {
    if (seek?.token === token) return;
    stopSeek();
    // Only the iframe the step was recorded in looks for it, so text-based matching can't land on
    // a look-alike element in some other app on the page.
    if (step.frameOrigin !== location.origin) return;
    seek = {
      token,
      stop: follow(step, {
        rect: (r) => sendUp({ type: 'target', token, rect: r ? toBox(r) : null }),
        clicked: () => sendUp({ type: 'targetClick', token }),
      }),
    };
  }

  chrome.runtime.onMessage.addListener((msg: FrameCommand) => {
    if (msg.kind === 'guide') {
      state = msg.state;
      if (!state?.playing) stopSeek();
      if (!state?.recording) picks.clear();
    }
    if (msg.kind === 'seek') startSeek(msg.token, msg.step);
    if (msg.kind === 'unseek') stopSeek();
    if (msg.kind === 'click' || msg.kind === 'drop') {
      const el = picks.get(msg.pickId);
      picks.delete(msg.pickId);
      if (el?.isConnected && msg.kind === 'click') clickThrough(el);
    }
    // No reply: the top page answers the popup's questions.
  });

  void (async () => {
    const r = await ask({ kind: 'guideGet' });
    if (!r.ok) return;
    frameId = r.data.frameId;
    state = r.data.state;
    // Tell the top page this frame (re)loaded, so a guide waiting for an element in here asks again.
    sendUp({ type: 'ready' });
  })();
}
