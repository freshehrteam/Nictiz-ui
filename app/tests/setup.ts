/**
 * Headless test setup.
 *
 * FINDING (criterion C9 — dependency health), recorded rather than hidden:
 *
 * Importing `medblocks-ui` in a headless DOM throws before any Medblocks code
 * runs. The throw comes from @shoelace-style/shoelace@2.0.0-beta.71, which runs
 * a `FormData` *polyfill probe* at module scope:
 *
 *     document.body.append(form); ... form.remove();
 *
 * happy-dom's `append` + `ChildNodeUtility.remove` disagree about parentage, so
 * `removeChild` throws `NotFoundError` and the whole module graph fails to load.
 *
 * Two things this tells us:
 *   1. The polyfill exists for a browser feature (the `formdata` event) that has
 *      been baseline-supported since 2021 — it is dead weight from a 2022 beta.
 *   2. Medblocks cannot be unit-tested headlessly without patching a
 *      transitive dependency's module-scope side effect.
 *
 * The shim below makes `body.append` + `remove` consistent so the probe can run
 * to completion. It changes no Medblocks behaviour and is confined to tests;
 * real browsers (and the Playwright e2e) never take this path.
 */

// `document.body` is an HTMLBodyElement whose `append` comes from further up
// the prototype chain than HTMLElement, so patch at the Element level and walk
// the chain to catch whichever prototype actually owns the method.
function patchAppend(proto: any): void {
  if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'append')) return;
  const original = proto.append;
  proto.append = function patchedAppend(this: Node, ...nodes: unknown[]) {
    for (const node of nodes) {
      if (node && typeof node === 'object' && 'nodeType' in (node as Node)) {
        this.appendChild(node as Node);
      } else {
        original.call(this, node);
      }
    }
  };
}

for (const proto of [
  (globalThis as any).Element?.prototype,
  (globalThis as any).HTMLElement?.prototype,
  (globalThis as any).DocumentFragment?.prototype,
  (globalThis as any).Document?.prototype,
]) {
  patchAppend(proto);
}

// Walk up from document.body in case the owning prototype is none of the above.
for (let p = Object.getPrototypeOf(document.body); p; p = Object.getPrototypeOf(p)) {
  patchAppend(p);
}

/**
 * The actual throw site is `form.remove()` (happy-dom's ChildNodeUtility),
 * which raises NotFoundError when it disagrees about parentage. Make `remove`
 * tolerant: a node that is already detached should be a no-op, which is what
 * the DOM spec says and what every browser does.
 */
function patchRemove(proto: any): void {
  if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'remove')) return;
  const original = proto.remove;
  proto.remove = function patchedRemove(this: Node) {
    try {
      original.call(this);
    } catch {
      // Already detached (or parentage confusion) — spec behaviour is no-op.
    }
  };
}

for (const proto of [
  (globalThis as any).Element?.prototype,
  (globalThis as any).HTMLElement?.prototype,
  (globalThis as any).CharacterData?.prototype,
]) {
  patchRemove(proto);
}

for (let p = Object.getPrototypeOf(document.createElement('form')); p; p = Object.getPrototypeOf(p)) {
  patchRemove(p);
}
