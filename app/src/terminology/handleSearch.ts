/**
 * DIY terminology provider (plan Step 4 / criterion C6).
 *
 * Medblocks ships no terminology integration at all — `mb-search` takes a
 * `handleSearch` property and nothing else. Everything below is the cost of
 * that gap, and the effort is the C6 measurement.
 *
 * The seam is deliberately narrow (`TerminologyProvider`) so a Snowstorm or
 * Ontoserver client can replace the local lookup without touching form code.
 */

import type { SearchOptions, SearchResult } from './types';
import { SNOMED_MANIFESTATIONS, SNOMED_FINDINGS, SNOMED_BODY_SITES, ATC_SUBSTANCES } from './seed';

export interface TerminologyProvider {
  search(options: SearchOptions): Promise<SearchResult[]>;
}

export { TERMINOLOGY_SNOMED, TERMINOLOGY_ATC } from './seed';

/**
 * Local, in-memory provider seeded from the golden fixture's actual values so
 * the PoC can demonstrate a complete round-trip with the stack down.
 */
export class LocalTerminologyProvider implements TerminologyProvider {
  private readonly sets: Record<string, SearchResult[]> = {
    'snomed:manifestation': SNOMED_MANIFESTATIONS,
    'snomed:finding': SNOMED_FINDINGS,
    'snomed:body-site': SNOMED_BODY_SITES,
    'atc:substance': ATC_SUBSTANCES,
  };

  async search({ searchString, constraints, maxHits = 20 }: SearchOptions): Promise<SearchResult[]> {
    const pool = this.poolFor(constraints);
    const q = (searchString ?? '').trim().toLowerCase();
    if (!q) return pool.slice(0, maxHits);

    // Rank exact code matches first, then prefix, then substring — cheap but
    // enough to make the UX honest when judging C6.
    const scored = pool
      .map((item) => {
        const value = (item.value ?? '').toLowerCase();
        const code = (item.code ?? '').toLowerCase();
        let score = -1;
        if (code === q) score = 0;
        else if (value.startsWith(q)) score = 1;
        else if (value.includes(q)) score = 2;
        else if (code.startsWith(q)) score = 3;
        return { item, score };
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score);

    return scored.slice(0, maxHits).map((s) => s.item);
  }

  private poolFor(constraints?: string[]): SearchResult[] {
    if (!constraints?.length) return Object.values(this.sets).flat();
    return constraints.flatMap((c) => this.sets[c] ?? []);
  }
}

/** Debounce that preserves the promise contract `mb-search` expects. */
export function debounceSearch(
  fn: (o: SearchOptions) => Promise<SearchResult[]>,
  ms = 250,
): (o: SearchOptions) => Promise<SearchResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: ((v: SearchResult[]) => void)[] = [];

  return (options: SearchOptions) =>
    new Promise<SearchResult[]>((resolve) => {
      pending.push(resolve);
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const waiters = pending;
        pending = [];
        const results = await fn(options);
        waiters.forEach((w) => w(results));
      }, ms);
    });
}

const provider: TerminologyProvider = new LocalTerminologyProvider();

/**
 * The value handed to `mb-form.handleSearch` / `mb-search.handleSearch`.
 * Signature is dictated by Medblocks: (SearchOptions) => Promise<SearchResult[]>.
 */
export const handleSearch = debounceSearch((options) => provider.search(options), 250);
