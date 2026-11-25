// Same-origin iframes. Fiori launchpads (and many other enterprise shells) open the actual app in an
// iframe, so the recorder and player work in the top page plus every iframe they can reach.
// Cross-origin iframes can't be read by a top-level content script and are skipped.

export interface Frame {
  doc: Document;
  win: Window;
  /** The <iframe> element in the parent document, or null for the top page. */
  el: HTMLIFrameElement | null;
  parent: Frame | null;
}

function docOf(iframe: HTMLIFrameElement): Document | null {
  try {
    const d = iframe.contentDocument;
    return d && d.documentElement ? d : null;
  } catch {
    return null; // cross-origin
  }
}

/** The top page and every same-origin iframe inside it, recursively (top first). */
export function allFrames(): Frame[] {
  const out: Frame[] = [];
  const walk = (f: Frame, depth: number) => {
    out.push(f);
    if (depth > 5) return;
    for (const el of f.doc.querySelectorAll('iframe, frame')) {
      const doc = docOf(el as HTMLIFrameElement);
      if (doc?.defaultView) walk({ doc, win: doc.defaultView, el: el as HTMLIFrameElement, parent: f }, depth + 1);
    }
  };
  walk({ doc: document, win: window, el: null, parent: null }, 0);
  return out;
}

export const frameOf = (doc: Document) => allFrames().find((f) => f.doc === doc);

/** Offset of a document's viewport inside the top viewport. */
export function frameOffset(doc: Document) {
  let x = 0, y = 0;
  for (let f: Frame | null | undefined = frameOf(doc); f?.el; f = f.parent) {
    const r = f.el.getBoundingClientRect();
    x += r.left + f.el.clientLeft;
    y += r.top + f.el.clientTop;
  }
  return { x, y };
}

/** An element's box in top-page coordinates (what the overlay, which lives in the top page, needs). */
export function topRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  const o = frameOffset(el.ownerDocument);
  return new DOMRect(r.left + o.x, r.top + o.y, r.width, r.height);
}
