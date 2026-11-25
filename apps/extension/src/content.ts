// Content script: the recorder and the player, both running inside the target page.
import type { Flow, Step, TrackEvent } from '@guidepost/shared';
import { ask, type TabCommand, type TabHello } from './messages';
import { allFrames, topRect } from './frames';
import { describeTarget, findElement } from './selector';
import { actionOf, escapeHtml, h, isOurs, mount, placeCard, shadow, toast, ui } from './ui';

const host = location.host || 'local-file';
const uid = () => crypto.randomUUID();

interface RecordingState { name: string; host: string; steps: Step[]; paused: boolean }
interface PlayingState { flowId: string; index: number; sessionId: string; host: string }

const store = {
  get: async <T>(key: string) => (await chrome.storage.local.get(key))[key] as T | undefined,
  set: (key: string, value: unknown) => chrome.storage.local.set({ [key]: value }),
};

function track(flowId: string, sessionId: string, type: TrackEvent['type'], stepIndex?: number) {
  void ask({ kind: 'track', events: [{ flowId, sessionId, type, stepIndex }] });
}

// =====================================================================
// RECORDER
// =====================================================================
let rec: RecordingState | null = null;
let recUI: { bar: HTMLElement; hover: HTMLElement } | null = null;
let editing = false;
let bypass = false;
let saving = false;

const saveRec = () => store.set('recording', rec);

function startRecording(name: string) {
  rec = { name: name || 'Untitled flow', host, steps: [], paused: false };
  void saveRec();
  showRecorder();
}

function showRecorder() {
  mount();
  stopPlayer(false);
  recUI?.bar.remove();
  recUI?.hover.remove();
  const hover = h('<div class="hover"></div>');
  const bar = h(`<div class="bar"><span class="dot"></span><span class="label"></span>
    <button data-a="pause"></button><button class="primary" data-a="finish">Finish</button><button data-a="cancel">Cancel</button></div>`);
  ui.append(hover, bar);
  recUI = { bar, hover };
  bar.addEventListener('click', (e) => {
    const a = actionOf(e);
    if (!rec) return;
    if (a === 'pause') {
      rec.paused = !rec.paused;
      void saveRec();
      renderBar();
    }
    if (a === 'finish') void finishRecording();
    if (a === 'cancel') void cancelRecording();
  });
  renderBar();
}

function renderBar() {
  if (!recUI || !rec) return;
  const { bar, hover } = recUI;
  bar.querySelector('.dot')!.classList.toggle('paused', rec.paused);
  const n = rec.steps.length;
  bar.querySelector('.label')!.textContent = `${rec.paused ? 'Paused' : 'Recording'} "${rec.name}" · ${n} step${n === 1 ? '' : 's'}`;
  bar.querySelector('[data-a="pause"]')!.textContent = rec.paused ? 'Resume' : 'Pause';
  if (rec.paused) hover.style.display = 'none';
}

function teardownRecorder() {
  recUI?.bar.remove();
  recUI?.hover.remove();
  shadow.querySelectorAll('.card.editor').forEach((c) => c.remove());
  recUI = null;
  rec = null;
  editing = false;
}

async function finishRecording() {
  if (!rec || saving) return;
  if (!rec.steps.length) return toast('Add at least one step first.');
  saving = true;
  const finish = recUI?.bar.querySelector<HTMLButtonElement>('[data-a="finish"]');
  if (finish) { finish.disabled = true; finish.textContent = 'Saving…'; }
  const r = await ask({ kind: 'createFlow', flow: { name: rec.name, host: rec.host, steps: rec.steps } });
  saving = false;
  if (!r.ok) {
    if (finish) { finish.disabled = false; finish.textContent = 'Finish'; }
    // Keep the recording so nothing is lost; the author can sign in again and press Finish.
    return toast(`Couldn't save the flow: ${r.error}`, { error: true, ms: 6000 });
  }
  await store.set('recording', null);
  const n = rec.steps.length;
  teardownRecorder();
  toast(`Saved "${r.data.name}" with ${n} step${n === 1 ? '' : 's'} as a draft. Publish it from the Guidepost menu or the dashboard.`, { ms: 5000 });
}

async function cancelRecording() {
  await store.set('recording', null);
  teardownRecorder();
  toast('Recording discarded.');
}

const recording = () => !!(rec && recUI && !rec.paused && !bypass);

/** Where the overlay should draw for a hovered element: the UI5 control's root on Fiori apps. */
let hoverCache: { el: Element; root: Element } | null = null;
function hoverRoot(el: Element) {
  if (hoverCache?.el !== el) hoverCache = { el, root: describeTarget(el).el };
  return hoverCache.root;
}

function showHover(r: DOMRect) {
  Object.assign(recUI!.hover.style, { display: 'block', top: `${r.top - 2}px`, left: `${r.left - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
}

function onHover(e: MouseEvent) {
  if (!recUI) return;
  if (!recording() || editing || isOurs(e)) {
    if (!editing) recUI.hover.style.display = 'none';
    return;
  }
  showHover(topRect(hoverRoot(e.target as Element)));
}

function swallow(e: Event) {
  if (!recording() || isOurs(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click' && !editing) openStepEditor(e.target as Element);
}

function openStepEditor(clicked: Element) {
  if (!rec) return;
  editing = true;
  const { el: target, ...where } = describeTarget(clicked);
  const { selector, text } = where;
  const rect = topRect(target);
  const n = rec.steps.length + 1;
  const label = where.ui5
    ? `${where.ui5.type}${where.ui5.id ? ` #${where.ui5.id}` : ''}${where.ui5.text ? ` “${where.ui5.text}”` : ''}`
    : selector;
  const card = h(`<div class="card editor">
    <button class="x" data-a="discard" title="Discard">×</button>
    <h3>Step ${n}</h3>
    <div class="target" title="${escapeHtml(selector)}">${escapeHtml(label)}${where.frames ? ' · in frame' : ''}</div>
    <label>Title</label><input class="t" value="${escapeHtml(text ? `Click “${text.slice(0, 40)}”` : 'Click here')}">
    <label>Explanation</label><textarea class="b" placeholder="What should the user do here, and why?"></textarea>
    <div class="row" style="margin-top:12px">
      <button data-a="discard">Discard</button>
      <button data-a="save" title="Save the step and stay on this page">Save</button>
      <button class="primary" data-a="saveclick" title="Save the step, then perform the click so you can continue">Save & click</button>
    </div></div>`);
  ui.appendChild(card);
  placeCard(card, rect);
  showHover(rect);
  const title = card.querySelector<HTMLInputElement>('.t')!;
  const body = card.querySelector<HTMLTextAreaElement>('.b')!;
  title.select();
  // Keep the host app's keyboard shortcuts from firing while the author types.
  card.addEventListener('keydown', (e) => e.stopPropagation(), true);
  card.addEventListener('click', async (e) => {
    const a = actionOf(e);
    if (!a || !rec) return;
    if (a !== 'discard') {
      rec.steps.push({ ...where, url: location.href, title: title.value.trim() || `Step ${n}`, body: body.value.trim() });
      await saveRec();
    }
    card.remove();
    editing = false;
    recUI!.hover.style.display = 'none';
    renderBar();
    if (a === 'saveclick') {
      // click() dispatches synchronously, so the bypass covers exactly this one click.
      bypass = true;
      try {
        realClick(clicked);
      } finally {
        bypass = false;
      }
    }
  });
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

// Listen in the top page and in every same-origin iframe, including ones that appear later
// (a launchpad opens an app's iframe after you click its tile).
const hooked = new WeakSet<Window>();
function hookFrames() {
  for (const { win } of allFrames()) {
    if (hooked.has(win)) continue;
    hooked.add(win);
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'submit']) win.addEventListener(t, swallow, true);
    win.addEventListener('mousemove', onHover, true);
  }
}
hookFrames();
setInterval(hookFrames, 1000);

// =====================================================================
// PLAYER
// =====================================================================
interface Play {
  flow: Flow;
  index: number;
  sessionId: string;
  spot?: HTMLElement;
  card?: HTMLElement;
  raf?: number;
  /** Polling for a step's element that hasn't appeared yet. */
  timer?: number;
  cleanup?: () => void;
}
let play: Play | null = null;

async function startFlow(flowId: string, resume?: PlayingState) {
  const r = await ask({ kind: 'getFlow', id: flowId });
  if (!r.ok) {
    await store.set('playing', null);
    return toast(`Couldn't load the guide: ${r.error}`, { error: true });
  }
  if (rec) teardownRecorder();
  stopPlayer(false);
  mount();
  play = { flow: r.data, index: resume?.index ?? 0, sessionId: resume?.sessionId ?? uid() };
  if (!resume) track(flowId, play.sessionId, 'start');
  void showStep();
}

async function showStep() {
  const p = play;
  if (!p) return;
  const step = p.flow.steps[p.index];
  await store.set('playing', { flowId: p.flow.id, index: p.index, sessionId: p.sessionId, host } satisfies PlayingState);
  clearStepUI();
  const target = await waitFor(step, 6000);
  if (play !== p || p.flow.steps[p.index] !== step) return; // the user moved on meanwhile
  track(p.flow.id, p.sessionId, 'step_view', p.index);
  if (!target) {
    showMissing(step);
    // Single-page apps (Fiori routes, launchpad iframes still loading) can show the element later
    // without a page load, so keep looking while the "can't find it" card is up.
    p.timer = window.setInterval(() => {
      if (play !== p || p.flow.steps[p.index] !== step) return;
      const el = findElement(step);
      if (el) {
        clearStepUI();
        highlight(p, step, el);
      }
    }, 700);
    return;
  }
  highlight(p, step, target);
}

function highlight(p: Play, step: Step, first: Element) {
  let target = first;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  p.spot = h('<div class="spot"></div>');
  p.card = buildCard(step);
  ui.append(p.spot, p.card);
  // Clicking the highlighted element itself also moves the tour on. Listen on the document rather
  // than the element, because UI5 re-renders controls and replaces their DOM nodes.
  let clicked = false;
  const onClick = (e: Event) => {
    if (clicked || !(e.target instanceof (target.ownerDocument.defaultView ?? window).Node) || !target.contains(e.target as Node)) return;
    clicked = true;
    setTimeout(() => play === p && next(), 150);
  };
  let doc = target.ownerDocument;
  doc.addEventListener('click', onClick, true);
  p.cleanup = () => doc.removeEventListener('click', onClick, true);
  let lost = 0;
  const follow = () => {
    if (play !== p || !p.spot || !p.card) return;
    if (!target.isConnected) {
      // Re-rendered or navigated away: look for it again, at most every few frames.
      if (lost++ % 10 === 0) {
        const again = findElement(step);
        if (again) {
          target = again;
          if (again.ownerDocument !== doc) {
            p.cleanup?.();
            doc = again.ownerDocument;
            doc.addEventListener('click', onClick, true);
            p.cleanup = () => doc.removeEventListener('click', onClick, true);
          }
        }
      }
      p.spot.style.display = 'none';
    } else {
      lost = 0;
      p.spot.style.display = '';
      const r = topRect(target);
      Object.assign(p.spot.style, { top: `${r.top - 4}px`, left: `${r.left - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      placeCard(p.card, r);
    }
    p.raf = requestAnimationFrame(follow);
  };
  follow();
}

function buildCard(step: Step, extra = '') {
  const p = play!;
  const i = p.index, n = p.flow.steps.length, last = i === n - 1;
  const card = h(`<div class="card">
    <button class="x" data-a="close" title="Close">×</button>
    <h3>${escapeHtml(step.title)}</h3>
    ${step.body ? `<p>${escapeHtml(step.body)}</p>` : ''}${extra}
    <div class="row"><span class="count">${i + 1} of ${n}</span>
      ${i > 0 ? '<button data-a="back">Back</button>' : ''}
      <button class="primary" data-a="next">${last ? 'Done' : 'Next'}</button>
    </div></div>`);
  card.addEventListener('click', (e) => {
    const a = actionOf(e);
    if (a === 'next') next();
    if (a === 'back') back();
    if (a === 'close') {
      track(p.flow.id, p.sessionId, 'exit', p.index);
      stopPlayer(true);
    }
    if (a === 'goto') location.href = step.url;
  });
  return card;
}

function showMissing(step: Step) {
  let otherPage = false;
  try {
    // Hash routes count as pages too (Fiori: #PurchaseOrder-manage&/orders/1).
    const u = new URL(step.url);
    otherPage = !!step.url && (u.pathname !== location.pathname || u.hash !== location.hash);
  } catch { /* bad url */ }
  const extra = otherPage
    ? '<p class="warn">This step is on another page.</p><div class="row" style="margin-bottom:10px"><button data-a="goto">Take me there</button></div>'
    : "<p class=\"warn\">I couldn't find this element on the page. The page may have changed since the guide was recorded.</p>";
  play!.card = buildCard(step, extra);
  ui.appendChild(play!.card);
  placeCard(play!.card, null);
}

function waitFor(step: Step, timeout: number) {
  return new Promise<Element | null>((resolve) => {
    const t0 = Date.now();
    (function poll() {
      const found = findElement(step);
      if (found || Date.now() - t0 > timeout) return resolve(found);
      setTimeout(poll, 250);
    })();
  });
}

function next() {
  if (!play) return;
  if (play.index >= play.flow.steps.length - 1) {
    const { flow, sessionId } = play;
    track(flow.id, sessionId, 'complete');
    stopPlayer(true);
    toast(`You finished "${flow.name}".`);
    return;
  }
  play.index++;
  void showStep();
}

function back() {
  if (play && play.index > 0) {
    play.index--;
    void showStep();
  }
}

function clearStepUI() {
  if (!play) return;
  if (play.raf) cancelAnimationFrame(play.raf);
  if (play.timer) clearInterval(play.timer);
  play.cleanup?.();
  play.spot?.remove();
  play.card?.remove();
  play.spot = play.card = play.cleanup = play.raf = play.timer = undefined;
}

function stopPlayer(clearStored: boolean) {
  clearStepUI();
  play = null;
  if (clearStored) void store.set('playing', null);
}

// =====================================================================
// Wiring: commands from the popup + resume after page navigation
// =====================================================================
chrome.runtime.onMessage.addListener((msg: TabCommand, _sender, reply) => {
  if (msg.kind === 'hello') reply({ host, recording: !!rec, playing: !!play } satisfies TabHello);
  if (msg.kind === 'startRecording') {
    startRecording(msg.name);
    reply({ ok: true });
  }
  if (msg.kind === 'play') {
    void startFlow(msg.flowId);
    reply({ ok: true });
  }
});

(async () => {
  const r = await store.get<RecordingState>('recording');
  const p = await store.get<PlayingState>('playing');
  if (r && r.host === host) {
    rec = r;
    showRecorder();
  } else if (p && p.host === host) {
    void startFlow(p.flowId, p);
  }
})();
