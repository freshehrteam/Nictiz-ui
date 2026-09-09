/**
 * What a stored Bundle looks like in a list.
 *
 * Its own module for the same reason `bundle-link.ts` is: `index.ts` calls
 * `app.listen()` at import time, so anything that needs to be unit-tested
 * cannot live there. This is pure — no fetch, no config, no server state.
 *
 * The input is the searchset HAPI answers for `GET Bundle?identifier=…` — a
 * Bundle of Bundles. Each hit is a full stored document (tens of kilobytes;
 * `_elements=id` is broken on this server, see `searchBundlesFor`), and this
 * module is the part that reduces each one to the handful of fields a list row
 * shows.
 */

import { COMPOSITION_LINK_SYSTEM } from './bundle-link';

export interface BundleSummary {
  id: string;
  /** `bundle.type` — 'document' for everything openFHIR emits today. */
  type?: string;
  /** `bundle.timestamp` — when the document says it was composed. */
  timestamp?: string;
  /** `bundle.meta.lastUpdated` — when the server last touched it. */
  lastUpdated?: string;
  entryCount: number;
  /** The first Composition entry's title — the human name of the document. */
  title?: string;
  /** The first Composition entry's date. */
  date?: string;
  /**
   * The versioned openEHR composition uid this Bundle was mapped from, read
   * from the `meta.tag` stamped at store time. Absent on Bundles stored before
   * the link existed — those can only be listed, not attributed.
   */
  compositionUid?: string;
}

/**
 * Reduces a HAPI searchset of stored Bundles to list-row summaries.
 *
 * Newest first, by `timestamp ?? meta.lastUpdated`; a Bundle with neither
 * sorts last rather than being dropped — an undatable document is still a
 * document. Entries that are not Bundles or carry no id are skipped: without
 * an id there is nothing to navigate to.
 *
 * Tolerates the SUBSETTED failure mode this HAPI is known for — a searchset
 * carrying `total` but NO `entry` array at all — by answering `[]` rather
 * than crashing. Same defence as `bundleIdsFor` in the BFF.
 */
export function bundleSummaries(searchset: unknown): BundleSummary[] {
  const entries = Array.isArray((searchset as any)?.entry) ? (searchset as any).entry : [];

  const summaries: BundleSummary[] = [];
  for (const entry of entries) {
    const bundle = entry?.resource;
    if (bundle?.resourceType !== 'Bundle') continue;
    if (typeof bundle.id !== 'string' || bundle.id.length === 0) continue;

    const inner = Array.isArray(bundle.entry) ? bundle.entry : [];
    const composition = inner
      .map((e: any) => e?.resource)
      .find((r: any) => r?.resourceType === 'Composition');

    const compositionTag = (Array.isArray(bundle.meta?.tag) ? bundle.meta.tag : []).find(
      (tag: any) => tag?.system === COMPOSITION_LINK_SYSTEM,
    );

    summaries.push({
      id: bundle.id,
      type: asString(bundle.type),
      timestamp: asString(bundle.timestamp),
      lastUpdated: asString(bundle.meta?.lastUpdated),
      entryCount: inner.length,
      title: asString(composition?.title),
      date: asString(composition?.date),
      compositionUid: asString(compositionTag?.code),
    });
  }

  return summaries.sort((a, b) => {
    const whenA = a.timestamp ?? a.lastUpdated;
    const whenB = b.timestamp ?? b.lastUpdated;
    if (whenA && whenB) return whenB.localeCompare(whenA);
    if (whenA) return -1;
    if (whenB) return 1;
    return 0;
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
