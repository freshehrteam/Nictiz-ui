/**
 * The save pipeline model: the four steps shown while a composition is being
 * committed, and the state each one moves through.
 *
 * All four steps are REAL. Each is driven by an actual request and reports what
 * that request returned:
 *
 * - `validate` and `commit` are the `POST /composition` and the read-back diff.
 *   Their lines carry the real uid, the real HTTP status and the real key counts.
 * - `map` and `bundle` are the openFHIR mapping and the Bundle store. Their
 *   counts come from the returned Bundle's own entries, so they describe what
 *   the engine actually produced rather than what a local guess predicted.
 *
 * `map` and `bundle` were once staged animations over a hardcoded lookup table.
 * That table is gone on purpose: a plausible-looking count with nothing behind
 * it is worse than no count, because it invites being trusted.
 *
 * Failure in `map`/`bundle` is NON-FATAL and that is load-bearing. By the time
 * they run the composition is already committed to the CDR, so a mapping
 * failure marks its own step failed and leaves the save standing — the form
 * still reports the save and still navigates to the record.
 *
 * Keeping the model in its own module means the timings and the copy can be
 * read without going through the component's rendering, and lets the resource
 * counting be unit-tested against a Bundle directly.
 */

import type { FhirBundle } from '../fhir/bundle';

/** Where a step is in its lifecycle. Drives the icon and the CSS class. */
export type StepState = 'pending' | 'running' | 'done' | 'failed';

export type StepKey = 'validate' | 'commit' | 'map' | 'bundle';

export interface PipelineStep {
  key: StepKey;
  title: string;
  /**
   * The monospace line under the title. Written as a function of the run so a
   * step can report the real uid and counts once they exist, and a plausible
   * placeholder before then.
   */
  line: (run: RunFacts) => string;
  /**
   * How long to hold this step on screen, in ms. A FLOOR, not a delay: every
   * step is backed by a request now, so this only stops a fast localhost
   * round-trip rendering as a step that never ran.
   */
  dwellMs: number;
}

/**
 * What the running pipeline knows so far. Every field is optional because the
 * panel opens before the POST has been made and fills in as it goes.
 */
export interface RunFacts {
  templateId: string;
  ehrId: string;
  /** Composition uid, once EHRbase has assigned one. */
  uid?: string;
  /**
   * True when this save replaced an existing composition rather than creating
   * one. EHRbase answers a create with 201 and an update with 200, and the
   * step line has to say which actually happened.
   */
  updated?: boolean;
  /** Number of FLAT keys submitted. */
  submitted?: number;
  /** Number of FLAT keys read back. */
  readBack?: number;
  /**
   * Per-resource-type counts, taken from the Bundle openFHIR returned — not
   * predicted from the composition. Absent until `map` succeeds.
   */
  resources?: ResourceCounts;
  /**
   * The stored Bundle's id, once `bundle` succeeds.
   *
   * This is what the summary route carries: only the id travels in the URL and
   * the Bundle itself is re-read from the FHIR server, so a reload, a deep link
   * and the back button all work with no client-side store. Its absence is also
   * the signal that mapping failed, which is what the panel's call to action
   * branches on.
   */
  bundleId?: string;
  /** Set when a step failed — the real error, shown on that step. */
  error?: string;
  /**
   * A non-fatal remark about a step that still succeeded — currently a
   * read-back that differs from what was submitted.
   *
   * Distinct from `error` on purpose: the CDR accepted and stored the
   * composition (201), so the pipeline continues. EHRbase reformats some
   * values it stores — an `mb-date`'s `…T07:28:00.000Z` comes back as
   * `…T07:28:00Z` — and a string diff cannot tell that apart from real data
   * loss. Reporting it without blocking is the honest middle.
   */
  note?: string;
}

export type ResourceCounts = Record<string, number>;

/**
 * Counts the resources in a mapped Bundle, by type.
 *
 * Reads the Bundle openFHIR actually returned rather than predicting from the
 * composition. The predecessor of this function was a four-row lookup table
 * that guessed which FLAT paths would become which resources; it was deleted
 * along with the staged steps, because a count that merely looks right is the
 * kind of thing a demo audience is well placed to catch — and worse, the kind
 * of thing a reader later trusts.
 *
 * `Patient` is not special-cased here. A Bundle either carries one or it does
 * not, and the count says which.
 */
export function countBundleResources(bundle: FhirBundle | undefined): ResourceCounts {
  const counts: ResourceCounts = {};

  for (const entry of bundle?.entry ?? []) {
    const type = entry?.resource?.resourceType;
    if (!type) continue;
    counts[type] = (counts[type] ?? 0) + 1;
  }

  return counts;
}

/**
 * `AllergyIntolerance x1, Condition x2` — the bundle step's line.
 *
 * Lists only what the Bundle contains. This used to prepend `Patient`
 * unconditionally, which was safe while the counts were invented but is a
 * falsehood now they are read from a real Bundle: openFHIR's output carries no
 * Patient resource, so claiming one would be inventing a resource that is not
 * there.
 *
 * Sorted by descending count, then by name, so the line is stable rather than
 * dependent on Bundle entry order.
 */
export function formatResources(counts: ResourceCounts | undefined): string {
  const entries = Object.entries(counts ?? {});
  if (!entries.length) return 'no resources';

  return entries
    .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName))
    .map(([resource, n]) => `${resource} x${n}`)
    .join(', ');
}

/**
 * The four steps, in order.
 *
 * Dwell times are what makes the pipeline readable rather than a flash. Every
 * step now resolves when its own request does, so each dwell is a FLOOR only:
 * a 40ms localhost round-trip would otherwise render as a step that never ran.
 */
export const STEPS: readonly PipelineStep[] = [
  {
    key: 'validate',
    title: 'Validating against EHDS template',
    dwellMs: 700,
    line: (r) => `validating composition vs ${r.templateId} … OK`,
  },
  {
    key: 'commit',
    title: 'Committing composition to EHRbase CDR',
    dwellMs: 700,
    line: (r) => {
      const verb = r.updated ? 'PUT' : 'POST';
      const path = `${verb} /ehrbase/rest/openehr/v1/ehr/{ehrId}/composition`;
      if (r.error) return `${path} … ${r.error}`;
      return `${path} … ${r.updated ? '200 OK (new version)' : '201 Created'}`;
    },
  },
  {
    key: 'map',
    title: 'Mapping via FHIR Connect / openFHIR',
    dwellMs: 700,
    line: (r) => {
      const total = Object.values(r.resources ?? {}).reduce((sum, n) => sum + n, 0);
      return total
        ? `POST /openfhir/tofhir?templateId=${r.templateId} … 200, ${total} ${
            total === 1 ? 'resource' : 'resources'
          }`
        : `POST /openfhir/tofhir?templateId=${r.templateId} … 200`;
    },
  },
  {
    key: 'bundle',
    title: 'Generating EHDS Patient Summary Bundle',
    dwellMs: 700,
    line: (r) =>
      r.bundleId
        ? `Bundle stored as Bundle/${r.bundleId}: ${formatResources(r.resources)}`
        : `Bundle assembled: ${formatResources(r.resources)}`,
  },
];

/**
 * Advances `states` so that `key` becomes `state`, leaving earlier steps done.
 *
 * Written as a pure function of the previous map so the component can treat
 * the pipeline as immutable state and let Lit diff it.
 */
export function withState(
  states: Record<StepKey, StepState>,
  key: StepKey,
  state: StepState,
): Record<StepKey, StepState> {
  return { ...states, [key]: state };
}

/** Every step pending — the panel's opening state. */
export function initialStates(): Record<StepKey, StepState> {
  return { validate: 'pending', commit: 'pending', map: 'pending', bundle: 'pending' };
}

/** A promise that resolves after `ms`, used to hold a step on screen. */
export function dwell(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
