// Shadow-DOM root for everything Guidepost draws on a host page, so the app's CSS can't break ours.
export const rootHost = document.createElement('div');
rootHost.id = 'guidepost-root';
rootHost.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
export const shadow = rootHost.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .hover { position: fixed; pointer-events: none; border: 2px dashed #e8590c; background: rgba(232,89,12,.08); border-radius: 4px; display: none; }
  .bar { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; align-items: center;
         background: #1f2937; color: #fff; padding: 8px 10px 8px 14px; border-radius: 999px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.25); white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; animation: pulse 1.2s infinite; }
  .dot.paused { background: #9ca3af; animation: none; }
  @keyframes pulse { 50% { opacity: .35; } }
  button { font: inherit; font-size: 13px; border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer; background: #374151; color: #fff; }
  button.primary { background: #e8590c; color: #fff; }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: .6; cursor: default; }
  .card { position: fixed; width: 320px; max-width: calc(100vw - 16px); background: #fff; color: #111827; border-radius: 12px; padding: 16px; box-shadow: 0 12px 32px rgba(0,0,0,.28); font-size: 14px; line-height: 1.45; }
  .card h3 { margin: 0 24px 6px 0; font-size: 15px; font-weight: 650; }
  .card p { margin: 0 0 12px; color: #374151; white-space: pre-wrap; }
  .card .row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
  .card .row .count { margin-right: auto; color: #6b7280; font-size: 12px; }
  .card .row button:not(.primary) { background: #f3f4f6; color: #111827; }
  .card .x { position: absolute; top: 8px; right: 10px; background: none; color: #9ca3af; padding: 2px 6px; font-size: 18px; }
  .card label { display: block; font-size: 12px; color: #6b7280; margin: 8px 0 4px; }
  .card input, .card textarea { width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 9px; font-size: 14px; color: #111827; background: #fff; }
  .card textarea { min-height: 64px; resize: vertical; }
  .card .target { font-size: 12px; color: #6b7280; background: #f9fafb; border-radius: 6px; padding: 4px 8px; word-break: break-all; }
  .card .warn { color: #b45309; }
  .spot { position: fixed; pointer-events: none; border-radius: 6px; box-shadow: 0 0 0 9999px rgba(15,23,42,.55); outline: 2px solid #e8590c; outline-offset: 2px; transition: all .2s ease; }
  .toast { position: fixed; bottom: 24px; right: 24px; max-width: 360px; background: #1f2937; color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 13px; }
  .toast.error { background: #b91c1c; }
</style>`;
export const ui = document.createElement('div');
shadow.appendChild(ui);

export const mount = () => {
  if (!rootHost.isConnected) document.documentElement.appendChild(rootHost);
};
export const isOurs = (e: Event) => e.composedPath().includes(rootHost);

export function h<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function toast(msg: string, opts: { ms?: number; error?: boolean } = {}) {
  mount();
  const t = h(`<div class="toast${opts.error ? ' error' : ''}">${escapeHtml(msg)}</div>`);
  ui.appendChild(t);
  setTimeout(() => t.remove(), opts.ms ?? 3000);
}

/** Place a card next to a rect: below if there's room, else above, else centred on screen. */
export function placeCard(card: HTMLElement, rect: DOMRect | null) {
  const w = card.offsetWidth, ht = card.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 12;
  let y: number, x: number;
  if (!rect) {
    y = (vh - ht) / 2;
    x = (vw - w) / 2;
  } else {
    if (rect.bottom + gap + ht < vh) y = rect.bottom + gap;
    else if (rect.top - gap - ht > 0) y = rect.top - gap - ht;
    else y = Math.max(8, Math.min(vh - ht - 8, rect.top));
    x = Math.max(8, Math.min(vw - w - 8, rect.left + rect.width / 2 - w / 2));
  }
  card.style.top = `${y}px`;
  card.style.left = `${x}px`;
}

/** Read the data-a attribute of the button that was clicked inside a card. */
export const actionOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
