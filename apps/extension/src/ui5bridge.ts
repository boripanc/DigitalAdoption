// Runs in the page's own JavaScript world (manifest "world": "MAIN"), in every frame, so it can
// read SAPUI5 / OpenUI5 controls, which the isolated content script can't see. It answers two
// questions from the content script, over synchronous DOM events:
//   describe: "which UI5 control is this element, and what about it is stable?"
//   find:     "which control on this page best matches this description?"
// It never changes the app and does nothing on pages without UI5.
import type { Ui5Info } from '@guidepost/shared';
import { stableId } from './ui5id';

const REQ = 'guidepost:ui5-req';
const RES = 'guidepost:ui5-res';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Control = any;
const w = window as any;

function core() {
  const sap = w.sap;
  if (!sap?.ui?.require) return null;
  const Element = sap.ui.require('sap/ui/core/Element');
  const byId = (id: string): Control | undefined =>
    Element?.getElementById?.(id) ?? Element?.registry?.get?.(id) ?? sap.ui.getCore?.().byId?.(id);
  const all = (): Control[] => {
    if (Element?.registry?.all) return Object.values(Element.registry.all());
    const reg = sap.ui.require('sap/ui/core/ElementRegistry');
    if (reg?.all) return Object.values(reg.all());
    return Object.values(sap.ui.getCore?.().mElements ?? {});
  };
  return { byId, all };
}

/** The UI5 control that owns a DOM element (walks up to the nearest control root). */
function controlOf(el: Element | null, c: NonNullable<ReturnType<typeof core>>): Control | undefined {
  for (let cur = el; cur; cur = cur.parentElement) {
    const id = cur.getAttribute('data-sap-ui') || (cur.hasAttribute('data-sap-ui') ? cur.id : '');
    if (id) {
      const ctrl = c.byId(id);
      if (ctrl) return ctrl;
    }
  }
  return undefined;
}

const call = (ctrl: Control, fn: string) => {
  try {
    const v = typeof ctrl[fn] === 'function' ? ctrl[fn]() : undefined;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
};

function viewOf(ctrl: Control): Control | undefined {
  for (let p = ctrl; p; p = p.getParent?.()) if (p.isA?.('sap.ui.core.mvc.View')) return p;
  return undefined;
}

function labelOf(ctrl: Control, c: NonNullable<ReturnType<typeof core>>): string | undefined {
  const id = ctrl.getId();
  // <Label labelFor="x"> or aria-labelledby associations.
  const refs: string[] = [...(ctrl.getAriaLabelledBy?.() ?? [])];
  for (const lbl of document.querySelectorAll('label[for], [data-sap-ui].sapMLabel')) {
    const l = c.byId(lbl.id);
    if (l?.getLabelFor?.() === id) refs.unshift(lbl.id);
  }
  for (const r of refs) {
    const t = call(c.byId(r) ?? {}, 'getText') ?? document.getElementById(r)?.textContent?.trim();
    if (t) return t.slice(0, 120);
  }
  return undefined;
}

function bindingsOf(ctrl: Control) {
  const out: Record<string, string> = {};
  for (const prop of ['text', 'title', 'value', 'selectedKey', 'number', 'icon', 'src', 'tooltip']) {
    try {
      const p = ctrl.getBindingPath?.(prop);
      if (p) out[prop] = String(p);
    } catch { /* not bindable */ }
  }
  return Object.keys(out).length ? out : undefined;
}

const INTERACTIVE = 'a,button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"]';

/**
 * A click on plain text inside a list or table row (a Text, an ObjectIdentifier...) means the row:
 * that's what reacts, and it's a better thing to highlight.
 */
function promote(ctrl: Control): Control {
  const dom: HTMLElement | null = ctrl.getDomRef?.();
  if (dom?.matches(INTERACTIVE)) return ctrl;
  let p = ctrl.getParent?.();
  for (let i = 0; p && i < 4; i++, p = p.getParent?.()) if (p.isA?.('sap.m.ListItemBase')) return p;
  return ctrl;
}

/** Visible text of a control, without UI5's screen-reader-only helper texts. */
const domText = (ctrl: Control) => {
  const dom = ctrl.getDomRef?.() as HTMLElement | null;
  if (!dom) return undefined;
  const parts: string[] = [];
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.sapUiInvisibleText, .sapUiPseudoInvisibleText, [aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue?.trim()) parts.push(n.nodeValue.trim());
  const t = parts.join(' ').replace(/\s+/g, ' ');
  return t ? t.slice(0, 120) : undefined;
};

function describe(el: Element, raw = false): Ui5Info & { domId: string } | null {
  const c = core();
  if (!c) return null;
  let ctrl = controlOf(el, c);
  if (!ctrl) return null;
  if (!raw) ctrl = promote(ctrl);
  const view = viewOf(ctrl);
  const info: Ui5Info & { domId: string } = {
    domId: ctrl.getDomRef?.()?.id ?? ctrl.getId(),
    type: ctrl.getMetadata().getName(),
    id: stableId(ctrl.getId()),
    view: view?.getViewName?.(),
    text: call(ctrl, 'getText') ?? call(ctrl, 'getTitle') ?? call(ctrl, 'getHeaderText') ?? call(ctrl, 'getPlaceholder') ??
      (ctrl.isA?.('sap.m.ListItemBase') ? domText(ctrl) : undefined),
    icon: call(ctrl, 'getIcon') ?? call(ctrl, 'getSrc'),
    tooltip: call(ctrl, 'getTooltip_AsString'),
    label: labelOf(ctrl, c),
    bindings: bindingsOf(ctrl),
    context: ctrl.getBindingContext?.()?.getPath?.() || undefined,
  };
  for (const k of Object.keys(info) as (keyof typeof info)[]) if (info[k] === undefined) delete info[k];
  return info;
}

function visible(ctrl: Control) {
  const d: HTMLElement | null = ctrl.getDomRef?.();
  if (!d || !d.isConnected) return null;
  const r = d.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? d : null;
}

/** Score every visible control of the recorded type and return the best one's DOM id. */
function find(q: Ui5Info): string | null {
  const c = core();
  if (!c) return null;
  let best: { id: string; score: number } | null = null;
  for (const ctrl of c.all()) {
    if (ctrl.getMetadata?.().getName() !== q.type) continue;
    const dom = visible(ctrl);
    if (!dom) continue;
    const d = describe(dom, true);
    if (!d) continue;
    let score = 0;
    if (q.id) score += d.id === q.id ? 10 : -4;
    if (q.view && d.view === q.view) score += 2;
    if (q.text) score += d.text === q.text ? 5 : -2;
    if (q.icon) score += d.icon === q.icon ? 3 : -1;
    if (q.tooltip) score += d.tooltip === q.tooltip ? 2 : 0;
    if (q.label) score += d.label === q.label ? 4 : -1;
    if (q.context && d.context === q.context) score += 3;
    for (const [k, v] of Object.entries(q.bindings ?? {})) score += d.bindings?.[k] === v ? 2 : 0;
    if (!best || score > best.score) best = { id: dom.id, score };
  }
  // Below 4 means nothing meaningful matched beyond the control type.
  return best && best.score >= 4 ? best.id : null;
}

if (!w.__guidepostUi5Bridge) {
  w.__guidepostUi5Bridge = true;
  document.addEventListener(REQ, (e) => {
    let res: unknown = null;
    try {
      const req = JSON.parse((e as CustomEvent<string>).detail) as { op: 'describe'; el: string } | { op: 'find'; q: Ui5Info } | { op: 'ping' };
      if (req.op === 'ping') res = !!core();
      if (req.op === 'describe') {
        // The content script marks the element with a one-off attribute, since elements can't cross worlds.
        const el = document.querySelector(`[data-guidepost-probe="${CSS.escape(req.el)}"]`);
        res = el ? describe(el) : null;
      }
      if (req.op === 'find') res = find(req.q);
    } catch {
      res = null;
    }
    document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(res) }));
  });
}
