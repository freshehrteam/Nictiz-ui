/**
 * Layout rules for the occurrences `mb-repeatable-simple` renders into its own
 * shadow root.
 *
 * WHY THIS FILE EXISTS (library defect D-11)
 *
 * `mb-repeatable-simple` renders occurrence 0 through a `<slot>` — so it stays
 * in the host's light DOM — but every occurrence after it through
 * `unsafeHTML(slotNode.outerHTML)` INSIDE its shadow root:
 *
 *     <slot @slotchange=${this.reloadSlot}></slot>
 *     ${[...Array(this.count - 1)].map((_, i) =>
 *        html`${unsafeHTML(this.replacePath(this.slotNode?.outerHTML, i + 1))}`)}
 *
 * Every rule in `styles/views.css` is scoped `eps-composition-form <descendant>`,
 * and descendant selectors do not cross a shadow boundary. So occurrence 0 is
 * styled and occurrences 1+ get browser defaults. Measured in Chrome:
 *
 *     .field-grid display   grid -> block        (controls stop flowing in columns)
 *     grid-template-columns 4 cols -> none
 *     fieldset padding      14px -> 10.5px       (UA default)
 *     fieldset border       1px  -> 2px groove   (UA default)
 *     mb-input display      block -> inline      (no spacing, fields run together)
 *
 * The rules below are the same declarations as the `eps-composition-form ...`
 * block in `views.css`, minus the host prefix, so they still match once adopted
 * into a shadow root. They are deliberately a copy rather than a shared import:
 * `views.css` is a plain stylesheet served by Vite, and the only way to reuse it
 * here would be to fetch and re-parse it at runtime.
 *
 * KEEP IN SYNC with the "Medblocks controls inside our cards" and
 * "compact field layout" blocks of `styles/views.css`.
 *
 * Custom properties (`--eps-*`) are NOT redefined here on purpose: custom
 * properties inherit THROUGH a shadow boundary, so the values set on `:root`
 * reach these rules unchanged. Only selector matching is blocked.
 */

/** The declarations, ancestor-free so they match inside a shadow root. */
const REPEATABLE_CSS = `
  .field-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px 14px;
    align-items: start;
  }

  .field-wide {
    grid-column: 1 / -1;
  }

  .field-grid > mb-input,
  .field-grid > mb-date,
  .field-grid > mb-search,
  .field-grid > mb-select,
  .field-grid > mb-text-select,
  .field-grid > mb-buttons,
  .field-grid > mb-quantity,
  .field-grid > mb-repeatable-simple,
  .field-wide > :last-child {
    margin-bottom: 0;
  }

  fieldset.entry,
  fieldset.nested {
    margin: 0 0 14px;
    padding: 12px 14px;
    border: 1px solid var(--eps-border);
    border-radius: var(--eps-radius-sm);
    background: var(--eps-surface);
  }

  fieldset.nested {
    background: var(--eps-bg);
    margin-top: 12px;
  }

  fieldset legend {
    padding: 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--eps-teal-700);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  mb-input,
  mb-date,
  mb-search,
  mb-select,
  mb-text-select,
  mb-buttons,
  mb-quantity {
    display: block;
    margin-bottom: 8px;
  }

  mb-repeatable-simple {
    display: block;
    margin-bottom: 8px;
  }
`;

/**
 * One shared stylesheet for every repeatable on the page.
 *
 * `CSSStyleSheet` objects are designed to be adopted by many roots at once, so
 * constructing this once and sharing it costs one parse rather than one per
 * repeatable — and there are five per Allergies entry alone.
 *
 * Built lazily because `new CSSStyleSheet()` is not available in every headless
 * DOM the unit tests run under; `applyRepeatableStyles` degrades to a no-op
 * there rather than throwing.
 */
let sheet: CSSStyleSheet | undefined;
let sheetUnavailable = false;

function getSheet(): CSSStyleSheet | undefined {
  if (sheet || sheetUnavailable) return sheet;
  try {
    const s = new CSSStyleSheet();
    s.replaceSync(REPEATABLE_CSS);
    sheet = s;
  } catch {
    // Constructable stylesheets unsupported (happy-dom, older Safari). The
    // fallback below handles it; real browsers never take this path.
    sheetUnavailable = true;
  }
  return sheet;
}

/** Marks a root we have already styled, so repeat calls are cheap. */
const styled = new WeakSet<ShadowRoot>();

/**
 * Adopts the occurrence styles into one repeatable's shadow root.
 *
 * Safe to call repeatedly — the second call for a given root is a WeakSet hit.
 */
export function applyRepeatableStyles(root: ShadowRoot): void {
  if (styled.has(root)) return;

  const s = getSheet();
  if (s) {
    // Append rather than replace: mb-repeatable-simple renders its own
    // `<link rel="stylesheet">` for the `css` property, and Shoelace puts the
    // add/delete button styles here too.
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, s];
  } else {
    // No constructable stylesheets — inject a <style> element instead.
    const el = document.createElement('style');
    el.textContent = REPEATABLE_CSS;
    root.appendChild(el);
  }

  styled.add(root);
}

/**
 * Styles every repeatable currently inside `host`.
 *
 * Called on each render of the form, like `ensureSearchHandlers`: repeatables
 * appear when a section switches to its entries branch, not only at first paint.
 */
export function ensureRepeatableStyles(host: ParentNode): void {
  for (const el of host.querySelectorAll('mb-repeatable-simple')) {
    const root = el.shadowRoot;
    if (root) applyRepeatableStyles(root);
  }
}
