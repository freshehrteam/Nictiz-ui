/**
 * Reading an IPS document Bundle: reference resolution and the small text
 * helpers every view of one needs.
 *
 * This used to also hold the per-type COLUMN SETS the summary rendered as
 * tables. Those are gone: they showed 4–6 chosen fields per resource and
 * dropped the rest, and `fhir/eps-view` now projects every datapoint instead.
 * What remains is what that projection is built out of.
 *
 * Kept out of the component so it can be unit-tested against a real Bundle
 * without a DOM. Everything here is a pure function of the Bundle.
 */

import type {
  BundleEntry,
  CodeableConcept,
  FhirBundle,
  FhirResource,
  Reference,
} from './bundle';

/**
 * Looks up entries by every name a reference might use.
 *
 * TWO indexes are needed, and the reason is specific rather than defensive. An
 * IPS document Bundle addresses its own entries by `fullUrl`, which openFHIR
 * writes as `urn:uuid:…`; but `Reference.reference` is allowed to be a
 * relative `Type/id` instead, and a Bundle assembled by other software
 * routinely is. Indexing only one of the two silently loses every reference
 * written in the other form — silently, because a missing target renders as
 * "not recorded" rather than as an error.
 */
export interface ResourceIndex {
  /** `urn:uuid:…` or absolute-URL keys, from each entry's `fullUrl`. */
  byFullUrl: Map<string, FhirResource>;
  /** `Type/id` keys, from each resource's own `resourceType` and `id`. */
  byTypeId: Map<string, FhirResource>;
}

export function indexBundle(bundle: FhirBundle | undefined): ResourceIndex {
  const byFullUrl = new Map<string, FhirResource>();
  const byTypeId = new Map<string, FhirResource>();

  for (const entry of bundle?.entry ?? []) {
    const resource = entry?.resource;
    if (!resource) continue;

    if (entry.fullUrl) byFullUrl.set(entry.fullUrl, resource);
    if (resource.id) byTypeId.set(`${resource.resourceType}/${resource.id}`, resource);
  }

  return { byFullUrl, byTypeId };
}

/**
 * Resolves one reference against the Bundle, or `undefined` if it points
 * outside it.
 *
 * A dangling reference is NOT an error worth throwing over: an IPS Bundle may
 * legitimately reference a resource held elsewhere, and `Reference.display`
 * exists precisely so a reader can still say what was meant. The caller falls
 * back to that rather than rendering a dead link.
 */
export function resolveReference(
  index: ResourceIndex,
  reference: Reference | undefined,
): FhirResource | undefined {
  const target = reference?.reference;
  if (!target) return undefined;

  return index.byFullUrl.get(target) ?? index.byTypeId.get(target);
}

/** The first Composition in the Bundle — the document's spine. */
export function findComposition(bundle: FhirBundle | undefined): FhirResource | undefined {
  return bundle?.entry?.find((e: BundleEntry) => e?.resource?.resourceType === 'Composition')
    ?.resource;
}

/**
 * The best human-readable text for a coded value.
 *
 * `text` first, then the first coding's `display`, then the bare code. The
 * order matters: `text` is what the source system chose to call it, and a code
 * with no display is still more informative than an empty cell.
 */
export function codeText(concept: CodeableConcept | undefined): string {
  if (!concept) return '';
  if (concept.text) return concept.text;

  const coding = concept.coding?.[0];
  return coding?.display ?? coding?.code ?? '';
}

/** A date trimmed to its day. IPS tables are clinical, not to-the-second. */
export function dayOf(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

/** `—` for anything empty, so a table cell never renders as blank. */
export function orDash(value: string | undefined): string {
  return value && value.trim() ? value : '—';
}

/** A device's name, falling back through the fields that carry one. */
export function deviceLabel(device: FhirResource | undefined): string {
  if (!device) return '';

  // `||` rather than `??` throughout: `codeText` returns '' for a missing
  // concept, not undefined, so `??` would stop at the first empty string and
  // never reach the later fallbacks.
  const named = (device.deviceName as { name?: string }[])?.find((n) => n.name)?.name;
  return (
    named ||
    codeText(device.type as CodeableConcept) ||
    (device.modelNumber as string) ||
    ''
  );
}
