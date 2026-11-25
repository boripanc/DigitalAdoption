// Content script: the recorder and the player.
//
// It runs in every frame. The top page draws all the UI and drives the guide; it reaches
// same-origin iframes directly. An iframe on another origin can't be reached that way, so the
// script in it runs as an agent (agent.ts) that works on its own part of the page and reports up.
// The guide's progress lives in the background worker, so it carries on across page loads,
// other web apps and domains, and other tabs.
import type { Flow, Step, TrackEvent } from '@guidepost/shared';
import { runAgent } from './agent';
import { startCapture, clickThrough } from './capture';
import { onFromFrames, toRect, type Box, type UpMsg } from './chain';
import { topRect } from './frames';
import { follow } from './follow';
import { ask, type FrameCommand, type GuideState, type PlayingState, type RecordingState, type TabCommand, type TabHello } from './messages';
import { describeTarget } from './selector';
import { actionOf, escapeHtml, h, mount, placeCard, shadow, toast, ui } from './ui';

/** True when every frame between this one and the top page is same-origin, so the top page handles it. */
function reachableFromTop() {
  try {
    for (let w: Window = window; w !== w.top; w = w.parent) void w.parent.document.documentElement;
    return true;
  } catch {
    return false;
  }
}

if (window === window.top) runTop();
else if (!reachableFromTop()) runAgent();
// else: a same-origin iframe. The top page records and finds elements in it directly; the script
// here only passes messages from deeper cross-origin iframes up (chain.ts).

function runTop() {
  const host = location.host || 'local-file';
  const uid = () => crypto.randomUUID();
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  };
  const saveGuide = (state: GuideState | null, start = false) => ask({ kind: 'guideSet', state, start });
  const toFrames = (msg: FrameCommand, frameId?: number) => void ask({ kind: 'toFrames', msg, frameId });

  function track(flowId: string, sessionId: string, type: TrackEvent['type'], stepIndex?: number) {
    void ask({ kind: 'track', events: [{ flowId, sessionId, type, stepIndex }] });
  }

  // =====================================================================
  // RECORDER
  // =====================================================================
  let rec: RecordingState | null = null;
  let recUI: { bar: HTMLElement; hover: HTMLElement } | null = null;
  let editing = false;
  let saving = false;

  const saveRec = (start = false) => (rec ? saveGuide({ recording: rec }, start) : undefined);

  function startRecording(name: string) {
    rec = { name: name || 'Untitled flow', host, steps: [], paused: false };
    void saveRec(true);
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
    const apps = new Set(rec.steps.map((s) => hostOf(s.url)).filter(Boolean)).size;
    bar.querySelector('.label')!.textContent =
      `${rec.paused ? 'Paused' : 'Recording'} "${rec.name}" · ${n} step${n === 1 ? '' : 's'}${apps > 1 ? ` in ${apps} apps` : ''}`;
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
    await saveGuide(null);
    const n = rec.steps.length;
    teardownRecorder();
    toast(`Saved "${r.data.name}" with ${n} step${n === 1 ? '' : 's'} as a draft. Publish it from the Guidepost menu or the dashboard.`, { ms: 5000 });
  }

  async function cancelRecording() {
    await saveGuide(null);
    teardownRecorder();
    toast('Recording discarded.');
  }

  const recording = () => !!(rec && recUI && !rec.paused);

  /** Where the overlay should draw for a hovered element: the UI5 control's root on Fiori apps. */
  let hoverCache: { el: Element; root: Element } | null = null;
  function hoverRoot(el: Element) {
    if (hoverCache?.el !== el) hoverCache = { el, root: describeTarget(el).el };
    return hoverCache.root;
  }

  function showHover(r: DOMRect | null) {
    if (!recUI) return;
    if (!r) {
      recUI.hover.style.display = 'none';
      return;
    }
    Object.assign(recUI.hover.style, { display: 'block', top: `${r.top - 2}px`, left: `${r.left - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
  }

  startCapture({
    active: recording,
    editing: () => editing,
    hover: (el) => {
      if (!editing) showHover(el ? topRect(hoverRoot(el)) : null);
    },
    pick: (clicked) => {
      const { el, ...where } = describeTarget(clicked);
      openStepEditor(where, topRect(el), {
        perform: () => clickThrough(clicked),
        label: where.frames ? ' · in frame' : '',
      });
    },
  });

  /**
   * The step card. `where` is what gets stored; `perform` does the author's click once the step
   * is saved ("Save & click"); otherwise `done` runs when the card goes away.
   */
  function openStepEditor(
    where: Omit<Step, 'url' | 'title' | 'body'>,
    rect: DOMRect,
    opts: { perform: () => void; label: string; done?: () => void },
  ) {
    if (!rec) return opts.done?.();
    editing = true;
    const { selector, text } = where;
    const n = rec.steps.length + 1;
    const label = where.ui5
      ? `${where.ui5.type}${where.ui5.id ? ` #${where.ui5.id}` : ''}${where.ui5.text ? ` “${where.ui5.text}”` : ''}`
      : selector;
    const card = h(`<div class="card editor">
      <button class="x" data-a="discard" title="Discard">×</button>
      <h3>Step ${n}</h3>
      <div class="target" title="${escapeHtml(selector)}">${escapeHtml(label)}${escapeHtml(opts.label)}</div>
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
      if (!a) return;
      card.remove();
      editing = false;
      showHover(null);
      if (!rec) return opts.done?.();
      if (a !== 'discard') {
        rec.steps.push({ ...where, url: location.href, title: title.value.trim() || `Step ${n}`, body: body.value.trim() });
        // Saved before the click, so the step is kept when the click leaves the page or opens a tab.
        await saveRec();
      }
      renderBar();
      if (a === 'saveclick') opts.perform();
      else opts.done?.();
    });
  }

  // =====================================================================
  // PLAYER
  // =====================================================================
  interface Play {
    flow: Flow;
    index: number;
    sessionId: string;
    /** Identifies the step being shown, so late messages about an earlier step are ignored. */
    token?: string;
    spot?: HTMLElement;
    card?: HTMLElement;
    /** Whether the card is the "can't find it" one. */
    missing?: boolean;
    /** Called with the element's position (from this page or from an iframe on another origin). */
    onRect?: (r: DOMRect | null) => void;
    onClick?: () => void;
    timer?: number;
    cleanup?: () => void;
  }
  let play: Play | null = null;
  let starting: string | null = null;

  async function startFlow(flowId: string, resume?: PlayingState) {
    const key = `${flowId}:${resume?.index ?? 'new'}`;
    if (starting === key) return;
    starting = key;
    const r = await ask({ kind: 'getFlow', id: flowId });
    if (starting !== key) return;
    starting = null;
    if (!r.ok) {
      await saveGuide(null);
      return toast(`Couldn't load the guide: ${r.error}`, { error: true });
    }
    if (rec) teardownRecorder();
    stopPlayer(false);
    mount();
    play = { flow: r.data, index: Math.min(resume?.index ?? 0, r.data.steps.length - 1), sessionId: resume?.sessionId ?? uid() };
    if (!resume) track(flowId, play.sessionId, 'start');
    void showStep(!resume);
  }

  async function showStep(start = false) {
    const p = play;
    if (!p) return;
    const step = p.flow.steps[p.index];
    clearStepUI();
    const token = uid();
    p.token = token;
    // Saved first, so the guide continues at this step when a click opens another page, app or tab.
    const saved = await saveGuide({ playing: { flowId: p.flow.id, index: p.index, sessionId: p.sessionId, stepUrl: step.url } }, start);
    if (!saved.ok && !start) return; // the guide moved on to another tab
    if (play !== p || p.token !== token) return;
    track(p.flow.id, p.sessionId, 'step_view', p.index);

    p.onRect = (r) => {
      if (play !== p || p.token !== token) return;
      if (r && (!p.spot || p.missing)) {
        clearCard(p);
        p.spot = h('<div class="spot"></div>');
        p.card = buildCard(step);
        ui.append(p.spot, p.card);
      }
      if (!p.spot || !p.card) return;
      if (!r) {
        p.spot.style.display = 'none';
        return;
      }
      p.spot.style.display = '';
      Object.assign(p.spot.style, { top: `${r.top - 4}px`, left: `${r.left - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      placeCard(p.card, r);
    };
    // Clicking the highlighted element itself also moves the guide on.
    p.onClick = () => play === p && p.token === token && next();

    if (step.frameOrigin) {
      // The element is in an iframe on another origin: its agent looks for it and reports back.
      toFrames({ kind: 'seek', token, step });
      p.cleanup = () => toFrames({ kind: 'unseek' });
    } else {
      p.cleanup = follow(step, { rect: (r) => p.onRect?.(r), clicked: () => p.onClick?.() });
    }
    // Not found after a while: explain, and keep looking (the element can still turn up).
    p.timer = window.setTimeout(() => {
      if (play === p && p.token === token && !p.spot) showMissing(p, step);
    }, 6000);
  }

  function clearCard(p: Play) {
    p.spot?.remove();
    p.card?.remove();
    p.spot = p.card = undefined;
    p.missing = false;
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
      if (a === 'goto') goTo(step.url);
    });
    return card;
  }

  /** Go to the page of a step: in this tab for this app, else in a tab for the other app. */
  function goTo(url: string) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.origin === location.origin) location.href = url;
    else void ask({ kind: 'guideGoto', url });
  }

  function showMissing(p: Play, step: Step) {
    let where: 'here' | 'page' | 'app' = 'here';
    try {
      // Hash routes count as pages too (Fiori: #PurchaseOrder-manage&/orders/1).
      const u = new URL(step.url);
      if (u.origin !== location.origin) where = 'app';
      else if (u.pathname !== location.pathname || u.hash !== location.hash) where = 'page';
    } catch { /* bad url */ }
    const extra =
      where === 'app'
        ? `<p class="warn">This step is in another app (${escapeHtml(hostOf(step.url))}).</p><div class="row" style="margin-bottom:10px"><button data-a="goto">Take me there</button></div>`
        : where === 'page'
          ? '<p class="warn">This step is on another page.</p><div class="row" style="margin-bottom:10px"><button data-a="goto">Take me there</button></div>'
          : "<p class=\"warn\">I couldn't find this element on the page. The page may have changed since the guide was recorded.</p>";
    clearCard(p);
    p.card = buildCard(step, extra);
    p.missing = true;
    ui.appendChild(p.card);
    placeCard(p.card, null);
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
    clearTimeout(play.timer);
    play.cleanup?.();
    clearCard(play);
    play.cleanup = play.timer = play.onRect = play.onClick = play.token = undefined;
  }

  function stopPlayer(clearStored: boolean) {
    clearStepUI();
    play = null;
    starting = null;
    if (clearStored) void saveGuide(null);
  }

  // =====================================================================
  // Messages from cross-origin iframes (see agent.ts and chain.ts)
  // =====================================================================
  const rectOf = (b: Box | null) => (b ? toRect(b) : null);
  onFromFrames((m: UpMsg) => {
    switch (m.type) {
      case 'hover':
        if (recording() && !editing) showHover(rectOf(m.rect));
        break;
      case 'pick': {
        const drop = () => toFrames({ kind: 'drop', pickId: m.pickId }, m.frameId);
        if (!recording() || editing || typeof m.pickId !== 'string' || typeof m.where?.selector !== 'string') return drop();
        let origin = '';
        try {
          origin = new URL(m.origin).origin;
        } catch {
          return drop();
        }
        const { selector, text, tag, frames, ui5 } = m.where;
        openStepEditor({ selector, text, tag, frames, ui5, frameOrigin: origin }, toRect(m.rect), {
          perform: () => toFrames({ kind: 'click', pickId: m.pickId }, m.frameId),
          label: ` · in ${new URL(origin).host}`,
          done: drop,
        });
        break;
      }
      case 'target':
        if (play?.token === m.token) play.onRect?.(rectOf(m.rect));
        break;
      case 'targetClick':
        if (play?.token === m.token) play.onClick?.();
        break;
      case 'ready': {
        // An iframe on another origin (re)loaded: if the current step lives in one, ask again.
        const step = play?.token && play.flow.steps[play.index];
        if (step && step.frameOrigin) toFrames({ kind: 'seek', token: play!.token!, step });
        break;
      }
    }
  });

  // =====================================================================
  // Wiring: commands from the popup, and the guide state from the background
  // =====================================================================
  /** Take on the guide state the background has for this tab (on load, or when the guide moves here). */
  function adopt(state: GuideState | null) {
    if (!state) {
      if (rec) teardownRecorder();
      if (play || starting) stopPlayer(false);
      return;
    }
    if (state.recording) {
      rec = state.recording;
      if (recUI) renderBar();
      else showRecorder();
      return;
    }
    const s = state.playing;
    if (play && play.flow.id === s.flowId && play.index === s.index) return;
    void startFlow(s.flowId, s);
  }

  chrome.runtime.onMessage.addListener((msg: TabCommand | FrameCommand, _sender, reply) => {
    if (msg.kind === 'hello') reply({ host, recording: !!rec, playing: !!play } satisfies TabHello);
    if (msg.kind === 'startRecording') {
      startRecording(msg.name);
      reply({ ok: true });
    }
    if (msg.kind === 'play') {
      void startFlow(msg.flowId);
      reply({ ok: true });
    }
    if (msg.kind === 'guide' && !msg.echo) adopt(msg.state);
  });

  void (async () => {
    const r = await ask({ kind: 'guideGet' });
    if (r.ok) adopt(r.data.state);
  })();
}
