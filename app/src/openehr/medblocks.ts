/**
 * Every Medblocks defect workaround, in one place.
 *
 * The PoC scattered these across its shell. Concentrating them here does two
 * things the plan asks for: it makes the ongoing cost of the library visible in
 * a single file, and it stops any of them being dropped by accident — each one
 * failed silently when it was missing, and nine of the ten defects behind them
 * produce no error at all.
 *
 * Full detail: the Medblocks UI evaluation's TRACK-B-GAPS-AND-WORKAROUNDS.md
 * (separate, private evaluation repository).
 */

import { normalizeExport, ensureRepeatableOccurrences, ROOT } from './flat';
import { FORM_CTX } from '../forms/context';
import { ensureDeviceStatus } from '../forms/devices';
import { nowLocalIso } from '../auth/session';

/**
 * `mb-form` is untyped (it is a Lit 1 JS component with no .d.ts), so this
 * interface records what we actually rely on. It is documentation as much as
 * typing: every member below is a load-bearing part of one workaround.
 */
export interface MbForm extends HTMLElement {
  /** Registry of every mb-* element by path — the only reliable repeatable list. */
  mbElements?: Record<string, unknown>;
  /** Registry of repeatable containers by path, INCLUDING nested ones. */
  repeatables?: Record<string, unknown>;
  /**
   * Live map of path -> that element's `.data`, built from the same registry as
   * `mbElements`. Reading it is how the form asks "does this branch hold
   * anything?" before unmounting it.
   *
   * `.data`, not `.value`: `mb-search` keeps its coded value on `.data` while
   * `.value` stays empty, so a filled search would read as untouched.
   */
  readonly data?: Record<string, unknown>;
  /** Keys that matched no element. `serialize()` merges these back — see D-1. */
  deferredData?: Record<string, unknown>;
  /** When true (the default), `serialize()` re-emits deferredData. */
  serializeDeferredData?: boolean;
  import(data: Record<string, unknown>): void;
  export(includeDeferred?: boolean): Record<string, unknown>;
  serialize(elements?: Record<string, unknown>): Record<string, unknown>;
}

/** How long the form needs to settle after `import()` before values can be read. */
const IMPORT_SETTLE_MS = 400;

/**
 * Pushes a `handleSearch` implementation onto every search element under `root`.
 *
 * DEFECT D-10. `mb-form` propagates `handleSearch` only through a
 * `watch('handleSearch')` reaction, which fires once, when the property is
 * first set. `handleChildConnect` assigns `mbForm` and `variant` to
 * late-connecting children but NOT `handleSearch` — so every element that
 * registers afterwards ends up with `handleSearch === undefined`. That is all
 * of them, plus every copy a repeatable creates when the user clicks "add".
 *
 * Without this, ALL terminology search is dead. The symptom actively misleads:
 * typing shows "An unexpected error occurred" in the dropdown, which reads as a
 * terminology-server outage rather than an unwired callback.
 *
 * Must be called from `updated()` on every render AND from an `mb-connect`
 * listener. `updated()` alone is not enough: `mb-repeatable-simple.handleAdd()`
 * only does `this.count++`, which re-renders inside the Lit 1 tree and writes
 * to no property of the host, so Lit 3 never schedules an update and
 * `updated()` never runs for a newly added occurrence. Worse, the copy is
 * built with `unsafeHTML(slotNode.outerHTML)` — cloned from serialized markup,
 * so JS properties like `handleSearch` cannot survive. Every mb-* element does
 * emit a bubbling, composed `mb-connect` on connect, and that is the only
 * signal a repeatable copy gives us.
 */
export function ensureSearchHandlers(
  root: ParentNode,
  handleSearch: (options: unknown) => Promise<unknown[]>,
): void {
  for (const el of root.querySelectorAll('mb-search, mb-search-multiple')) {
    const search = el as unknown as { handleSearch?: unknown };
    if (typeof search.handleSearch !== 'function') search.handleSearch = handleSearch;
  }
}

export interface ImportReport {
  /** Keys handed to the form. */
  read: number;
  /** Keys that actually BOUND to a field — the only honest number (D-1). */
  bound: number;
  /** Keys that matched nothing and passed through untouched. */
  deferred: number;
}

/**
 * Imports a FLAT composition into a form and reports what actually bound.
 *
 * Wraps two defects:
 *
 * D-8 — a repeatable whose path is absent from the imported data makes
 * `getCount()` return 0, and `mb-repeatable-simple.render()` then evaluates
 * `[...Array(this.count - 1)]` — `Array(-1)` — which throws
 * `RangeError: Invalid array length`. EVERY repeatable on the page dies, so a
 * composition that simply has no allergies breaks the whole form. Seeding an
 * empty `:0` marker keeps the count at 1; `serialize()`'s own `hasValue()`
 * filter drops the empty value, so nothing extra reaches the CDR.
 *
 * The repeatable list comes from `form.repeatables` — the form's own registry —
 * and not from a hand-maintained one. This template declares five, three of
 * them nested; the PoC's hand-written list of the two top-level ones still
 * crashed.
 *
 * D-1 — `import()` diverts unmatched keys to `deferredData`, and `serialize()`
 * merges them straight back into the export. An import whose keys ALL mismatch
 * therefore produces a perfect import→export diff while populating zero fields.
 * Toggling `serializeDeferredData` off is what makes `bound` mean what it says.
 */
export async function importComposition(
  form: MbForm,
  flat: Record<string, unknown>,
): Promise<ImportReport> {
  form.import(ensureRepeatableOccurrences(flat, Object.keys(form.repeatables ?? {})));

  // Medblocks binds asynchronously across several Lit 1 update cycles; reading
  // before it settles under-reports what bound.
  await new Promise((r) => setTimeout(r, IMPORT_SETTLE_MS));

  const previous = form.serializeDeferredData;
  form.serializeDeferredData = false;
  const bound = form.serialize(form.mbElements) ?? {};
  form.serializeDeferredData = previous;

  return {
    read: Object.keys(flat).length,
    bound: Object.keys(bound).length,
    deferred: Object.keys(form.deferredData ?? {}).length,
  };
}

/**
 * Exports a form as FLAT the CDR will accept.
 *
 * Always goes through `normalizeExport()`, which fixes:
 *
 * D-2 — `mb-context` emits its keys BOTH unprefixed (`category|code`) and
 * rooted (`eps_patient_summary/category|code`). EHRbase rejects the strays with
 * `HTTP 400 Could not consume Parts […]`.
 *
 * D-3 — `ctx` scalars leak as bare keys. `language`/`territory` are CODE_PHRASE
 * and need `|code` + `|terminology`; `composer` is PARTY_PROXY and needs
 * `|name`. Medblocks serialises the ctx object verbatim, so the CDR rejects it.
 *
 * `export(false)` excludes deferred data: passthrough keys are not the form's
 * to submit, and including them re-posts whatever the last import happened to
 * carry.
 *
 * Finally `ensureDeviceStatus()` stamps the fixed `status` = Current onto every
 * occupied device entry — the form renders no control for it (see
 * `forms/devices`), yet the CDR demands it 1..1 per entry.
 */
export function exportComposition(form: MbForm, root: string = ROOT): Record<string, unknown> {
  return ensureDeviceStatus(
    ensureMandatoryContext(normalizeExport(form.export(false) ?? {}, root), root),
  );
}

/**
 * Stamps the COMPOSITION attributes EHRbase requires but Medblocks may not emit.
 *
 * `composer` is the one that bites. It is mandatory at the composition root, and
 * although `mb-form.ctx` carries it and the bound `mb-input` visibly shows it,
 * neither reaches `export()` until a user physically edits that field:
 * Medblocks serialises only elements whose value has been *set*, and a default
 * bound via `.value` is not one. Saving an untouched form therefore fails with
 *
 *   HTTP 400 Composition missing mandatory attribute: composer
 *
 * — which is a confusing thing to be told about a field that is plainly filled
 * in on screen. Verified against the live CDR.
 *
 * `language` and `territory` come from `ctx` and are usually present, but they
 * are equally mandatory and equally cheap to guarantee. Existing values always
 * win: this fills gaps, it never overrides what the user actually entered.
 */
function ensureMandatoryContext(
  flat: Record<string, unknown>,
  root: string,
): Record<string, unknown> {
  const out = { ...flat };

  const hasValue = (key: string) => out[key] != null && out[key] !== '';

  if (!hasValue(`${root}/composer|name`)) out[`${root}/composer|name`] = FORM_CTX.composer;

  if (!hasValue(`${root}/language|code`)) {
    out[`${root}/language|code`] = FORM_CTX.language;
    out[`${root}/language|terminology`] ??= 'ISO_639-1';
  }

  if (!hasValue(`${root}/territory|code`)) {
    out[`${root}/territory|code`] = FORM_CTX.territory;
    out[`${root}/territory|terminology`] ??= 'ISO_3166-1';
  }

  // `context/start_time` is mandatory too, and unlike the above there is no
  // sensible constant for it — "now" is the only honest default.
  if (!hasValue(`${root}/context/start_time`)) {
    out[`${root}/context/start_time`] = nowLocalIso();
  }

  return out;
}

/**
 * Reads back what is currently BOUND to fields, ignoring passthrough.
 *
 * Used by the regression guard that D-1 exists to defeat: an import can only be
 * called successful if fields hold values, never because import→export matched.
 */
export function boundValues(form: MbForm): Record<string, unknown> {
  const previous = form.serializeDeferredData;
  form.serializeDeferredData = false;
  const bound = form.serialize(form.mbElements) ?? {};
  form.serializeDeferredData = previous;
  return bound;
}
