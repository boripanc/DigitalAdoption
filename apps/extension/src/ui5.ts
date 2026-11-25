// Content-script side of the UI5 bridge (see ui5bridge.ts, which runs in the page's own world).
import type { Ui5Info } from '@guidepost/shared';

const REQ = 'guidepost:ui5-req';
const RES = 'guidepost:ui5-res';

/** True when the document renders UI5 controls (SAP Fiori, SAPUI5, OpenUI5). Cheap; no bridge call. */
export const isUi5 = (doc: Document) => !!doc.querySelector('[data-sap-ui]');

/** Event dispatch is synchronous, so the bridge's answer arrives before dispatchEvent returns. */
function send<T>(doc: Document, req: object): T | null {
  let out: T | null = null;
  const on = (e: Event) => {
    try {
      out = JSON.parse((e as CustomEvent<string>).detail) as T;
    } catch { /* ignore */ }
  };
  doc.addEventListener(RES, on);
  try {
    doc.dispatchEvent(new CustomEvent(REQ, { detail: JSON.stringify(req) }));
  } finally {
    doc.removeEventListener(RES, on);
  }
  return out;
}

/** Describe the UI5 control under an element. Returns the control's root element too. */
export function describeUi5(el: Element): { info: Ui5Info; root: Element } | null {
  const doc = el.ownerDocument;
  if (!isUi5(doc)) return null;
  const probe = Math.random().toString(36).slice(2);
  el.setAttribute('data-guidepost-probe', probe);
  let res: (Ui5Info & { domId: string }) | null;
  try {
    res = send(doc, { op: 'describe', el: probe });
  } finally {
    el.removeAttribute('data-guidepost-probe');
  }
  if (!res) return null;
  const { domId, ...info } = res;
  return { info, root: doc.getElementById(domId) ?? el };
}

/** Find the control that best matches a recorded description, in one document. */
export function findUi5(doc: Document, info: Ui5Info): Element | null {
  if (!isUi5(doc)) return null;
  const id = send<string>(doc, { op: 'find', q: info });
  return id ? doc.getElementById(id) : null;
}
