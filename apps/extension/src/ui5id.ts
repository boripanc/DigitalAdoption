// Shared by the content script and the in-page UI5 bridge.

/**
 * The part of a UI5 id that doesn't change between loads, or undefined if it's all generated.
 * "application-PO-manage-component---list--save" -> "list--save" (component prefix varies by launchpad)
 * "__xmlview3--save" -> "save";  "__button12" and list-item clones like "__item0-...-2" -> undefined.
 */
export function stableId(id: string): string | undefined {
  let tail: string;
  const comp = id.lastIndexOf('---');
  if (comp >= 0) {
    if (id.startsWith('__') && !/^__(component|xmlview|jsview|view|htmlview|jsonview)\d+$/.test(id.slice(0, id.indexOf('-')))) return undefined;
    tail = id.slice(comp + 3);
  } else if (id.includes('--')) {
    const head = id.slice(0, id.indexOf('--'));
    if (head.startsWith('__') && !/^__(xmlview|jsview|view|htmlview|jsonview)\d+$/.test(head)) return undefined;
    tail = id.slice(id.indexOf('--') + 2);
  } else {
    tail = id;
  }
  if (!tail || tail.split('--').some((s) => s.startsWith('__')) || /^__/.test(tail)) return undefined;
  return tail;
}
