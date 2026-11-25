// Builds a selector that survives small page changes, and finds the element again later
// (falling back to "same tag with the same visible text" when the selector stops matching).
import type { Step } from '@guidepost/shared';

const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'placeholder', 'title'];

const esc = (s: string) => CSS.escape(s);
const isUnique = (sel: string) => {
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
};
/** Ids like "ember123", "react-select-4-input" or long hex strings change between page loads. */
export const looksGenerated = (v: string) => /\d{3,}|[a-f0-9]{8,}|^(ember|react|mui|radix|headlessui)[-_:]/i.test(v);

function own(el: Element): { sel: string; unique: boolean } {
  const tag = el.tagName.toLowerCase();
  if (el.id && !looksGenerated(el.id)) {
    const s = `#${esc(el.id)}`;
    if (isUnique(s)) return { sel: s, unique: true };
  }
  for (const a of STABLE_ATTRS) {
    const v = el.getAttribute(a);
    if (v && v.length < 80 && !looksGenerated(v)) {
      const s = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
      if (isUnique(s)) return { sel: s, unique: true };
    }
  }
  const classes = [...el.classList].filter((c) => !looksGenerated(c) && c.length < 30).slice(0, 2);
  if (classes.length) {
    const s = tag + classes.map((c) => '.' + esc(c)).join('');
    if (isUnique(s)) return { sel: s, unique: true };
  }
  return { sel: tag, unique: false };
}

function nth(el: Element, sel: string) {
  const parent = el.parentElement;
  if (!parent) return sel;
  const same = [...parent.children].filter((c) => c.tagName === el.tagName);
  return same.length > 1 ? `${sel}:nth-of-type(${same.indexOf(el) + 1})` : sel;
}

export function buildSelector(el: Element): string {
  const first = own(el);
  if (first.unique) return first.sel;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const o = own(cur);
    if (o.unique) {
      parts.unshift(o.sel);
      break;
    }
    parts.unshift(nth(cur, o.sel));
    const candidate = parts.join(' > ');
    if (isUnique(candidate)) return candidate;
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
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
}

export function findElement(step: Pick<Step, 'selector' | 'text' | 'tag'>): Element | null {
  let el: Element | null = null;
  try {
    el = document.querySelector(step.selector);
  } catch {
    /* invalid selector */
  }
  if (el && isVisible(el)) return el;
  if (step.text) {
    for (const c of document.getElementsByTagName(step.tag || '*')) if (textOf(c) === step.text && isVisible(c)) return c;
  }
  return null;
}
