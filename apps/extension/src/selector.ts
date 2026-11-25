// Builds a selector that survives small page changes, and finds the element again later.
// On UI5 apps (SAP Fiori) the control description comes first, because UI5 generates ids such as
// "__button12" that change between loads; elsewhere it's the CSS selector, then "same tag with the
// same visible text". Works inside same-origin iframes too.
import type { Step } from '@guidepost/shared';
import { allFrames, type Frame } from './frames';
import { describeUi5, findUi5 } from './ui5';
import { stableId } from './ui5id';

const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'placeholder', 'title'];

const esc = (s: string) => CSS.escape(s);
const isUnique = (doc: Document, sel: string) => {
  try {
    return doc.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
};
/** Ids like "ember123", "react-select-4-input", "__button12" or long hex strings change between page loads. */
export const looksGenerated = (v: string) => /\d{3,}|[a-f0-9]{8,}|^__|^(ember|react|mui|radix|headlessui)[-_:]/i.test(v);

function idSelector(el: Element): string | null {
  const id = el.id;
  if (!id) return null;
  // UI5 ids: "<component>---<view>--<control>". The prefix depends on how the app was launched,
  // so match on the stable end of the id instead.
  if (id.includes('--')) {
    const tail = stableId(id);
    if (!tail) return null;
    return tail === id ? `#${esc(id)}` : `[id$="${id.includes('---') ? '---' : '--'}${tail.replace(/"/g, '\\"')}"]`;
  }
  return looksGenerated(id) ? null : `#${esc(id)}`;
}

function own(el: Element): { sel: string; unique: boolean } {
  const doc = el.ownerDocument;
  const tag = el.tagName.toLowerCase();
  const byId = idSelector(el);
  if (byId && isUnique(doc, byId)) return { sel: byId, unique: true };
  for (const a of STABLE_ATTRS) {
    const v = el.getAttribute(a);
    if (v && v.length < 80 && !looksGenerated(v)) {
      const s = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
      if (isUnique(doc, s)) return { sel: s, unique: true };
    }
  }
  const classes = [...el.classList].filter((c) => !looksGenerated(c) && c.length < 30).slice(0, 2);
  if (classes.length) {
    const s = tag + classes.map((c) => '.' + esc(c)).join('');
    if (isUnique(doc, s)) return { sel: s, unique: true };
  }
  return { sel: tag, unique: false };
}

function nth(el: Element, sel: string) {
  const parent = el.parentElement;
  if (!parent) return sel;
  const same = [...parent.children].filter((c) => c.tagName === el.tagName);
  return same.length > 1 ? `${sel}:nth-of-type(${same.indexOf(el) + 1})` : sel;
}

/** CSS selector for an element, relative to its own document. */
export function buildSelector(el: Element): string {
  const first = own(el);
  if (first.unique) return first.sel;
  const doc = el.ownerDocument;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    const o = own(cur);
    if (o.unique) {
      parts.unshift(o.sel);
      break;
    }
    parts.unshift(nth(cur, o.sel));
    const candidate = parts.join(' > ');
    if (isUnique(doc, candidate)) return candidate;
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

export const textOf = (el: Element) =>
  ((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60);

function isVisible(el: Element) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  const st = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
}

/** Selectors of the iframes between the top page and this frame, outermost first. */
function chainOf(f: Frame | undefined): string[] {
  const out: string[] = [];
  for (let cur: Frame | null | undefined = f; cur?.el; cur = cur.parent) out.unshift(buildSelector(cur.el));
  return out;
}

export type Target = Pick<Step, 'selector' | 'text' | 'tag' | 'frames' | 'ui5'> & { el: Element };

/**
 * What the recorder stores for a clicked element. On UI5 apps the clicked node is swapped for the
 * control's root (a click on a button's inner <span> means the button).
 */
export function describeTarget(clicked: Element): Target {
  const ui5 = describeUi5(clicked);
  const el = ui5?.root ?? clicked;
  const frame = allFrames().find((f) => f.doc === el.ownerDocument);
  const t: Target = { el, selector: buildSelector(el), text: ui5?.info.text ?? textOf(el), tag: el.tagName.toLowerCase() };
  const frames = chainOf(frame);
  if (frames.length) t.frames = frames;
  if (ui5) t.ui5 = ui5.info;
  return t;
}

/** Documents to search for a step: the recorded iframe first, then every other reachable one. */
function candidateDocs(step: Pick<Step, 'frames'>): Document[] {
  const frames = allFrames();
  const docs = frames.map((f) => f.doc);
  if (!step.frames?.length) return docs;
  let cur: Document | null = document;
  for (const sel of step.frames) {
    const ifr: HTMLIFrameElement | null = cur ? (cur.querySelector(sel) as HTMLIFrameElement | null) : null;
    cur = frames.find((f) => f.el === ifr)?.doc ?? null;
  }
  // Launchpads sometimes re-create the app iframe with a different id, so fall back to all frames,
  // innermost first, since that's where the apps are.
  const rest = docs.filter((d) => d !== cur).reverse();
  return cur ? [cur, ...rest] : rest;
}

function findIn(doc: Document, step: Pick<Step, 'selector' | 'text' | 'tag' | 'ui5'>): Element | null {
  if (step.ui5) {
    const el = findUi5(doc, step.ui5);
    if (el && isVisible(el)) return el;
  }
  let el: Element | null = null;
  try {
    el = doc.querySelector(step.selector);
  } catch {
    /* invalid selector */
  }
  // On UI5 a structural selector (no stable id in it) can land on a different control after
  // re-rendering, so only trust it there when the text agrees too.
  const trusted = !step.ui5 || /^(#|\[id\$=)/.test(step.selector) || (!!step.text && textOf(el ?? doc.body) === step.text);
  if (el && isVisible(el) && trusted) return el;
  if (step.text) {
    for (const c of doc.getElementsByTagName(step.tag || '*')) if (textOf(c) === step.text && isVisible(c)) return c;
  }
  return null;
}

export function findElement(step: Pick<Step, 'selector' | 'text' | 'tag' | 'frames' | 'ui5'>): Element | null {
  for (const doc of candidateDocs(step)) {
    const el = findIn(doc, step);
    if (el) return el;
  }
  return null;
}
