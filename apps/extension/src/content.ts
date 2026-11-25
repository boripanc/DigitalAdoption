// Content script: the recorder and the player, both running inside the target page.
import type { Flow, Step, TrackEvent } from '@guidepost/shared';
import { ask, type TabCommand, type TabHello } from './messages';
import { buildSelector, findElement, textOf } from './selector';
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

function showHover(r: DOMRect) {
  Object.assign(recUI!.hover.style, { display: 'block', top: `${r.top - 2}px`, left: `${r.left - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
}

function onHover(e: MouseEvent) {
  if (!recUI) return;
  if (!recording() || editing || isOurs(e)) {
    if (!editing) recUI.hover.style.display = 'none';
    return;
  }
  showHover((e.target as Element).getBoundingClientRect());
}

function swallow(e: Event) {
  if (!recording() || isOurs(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click' && !editing) openStepEditor(e.target as Element);
}

function openStepEditor(target: Element) {
  if (!rec) return;
  editing = true;
  const selector = buildSelector(target);
  const text = textOf(target);
  const rect = target.getBoundingClientRect();
  const n = rec.steps.length + 1;
  const card = h(`<div class="card editor">
    <button class="x" data-a="discard" title="Discard">×</button>
    <h3>Step ${n}</h3>
    <div class="target">${escapeHtml(selector)}</div>
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
      rec.steps.push({ selector, text, tag: target.tagName.toLowerCase(), url: location.href, title: title.value.trim() || `Step ${n}`, body: body.value.trim() });
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
        (target as HTMLElement).focus?.();
        (target as HTMLElement).click();
      } finally {
        bypass = false;
      }
    }
  });
}

for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'dblclick', 'submit']) window.addEventListener(t, swallow, true);
window.addEventListener('mousemove', onHover, true);

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
  if (!target) return showMissing(step);
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  p.spot = h('<div class="spot"></div>');
  p.card = buildCard(step);
  ui.append(p.spot, p.card);
  // Clicking the highlighted element itself also moves the tour on.
  const onTargetClick = () => setTimeout(() => play === p && next(), 150);
  target.addEventListener('click', onTargetClick, { once: true });
  p.cleanup = () => target.removeEventListener('click', onTargetClick);
  const follow = () => {
    if (play !== p || !p.spot || !p.card) return;
    const r = target.getBoundingClientRect();
    Object.assign(p.spot.style, { top: `${r.top - 4}px`, left: `${r.left - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    placeCard(p.card, r);
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
    otherPage = !!step.url && new URL(step.url).pathname !== location.pathname;
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
  play.cleanup?.();
  play.spot?.remove();
  play.card?.remove();
  play.spot = play.card = play.cleanup = undefined;
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
