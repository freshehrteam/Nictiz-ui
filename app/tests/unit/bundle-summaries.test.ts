/**
 * The searchset→list-row reduction behind `GET /api/patients/:id/bundles`.
 *
 * The SUBSETTED case is the one doing real work: this HAPI is known to answer
 * `_elements` searches with `total` but no `entry` array at all, and the same
 * shape must reduce to an empty list rather than a crash — an unreachable
 * Bundles list must never take the compositions page down with it.
 */

import { describe, expect, it } from 'vitest';

import { COMPOSITION_LINK_SYSTEM } from '../../server/bundle-link';
import { bundleSummaries } from '../../server/bundle-summaries';

/** A stored Bundle the way HAPI hands it back inside a searchset entry. */
function storedBundle(
  id: string,
  overrides: Record<string, unknown> = {},
): { resource: Record<string, unknown> } {
  return {
    resource: {
      resourceType: 'Bundle',
      id,
      type: 'document',
      timestamp: '2026-01-01T10:00:00Z',
      meta: { lastUpdated: '2026-01-01T10:00:05.000+00:00' },
      entry: [
        {
          resource: {
            resourceType: 'Composition',
            title: 'Patient Summary',
            date: '2026-01-01T09:59:00Z',
          },
        },
        { resource: { resourceType: 'AllergyIntolerance' } },
      ],
      ...overrides,
    },
  };
}

describe('bundleSummaries', () => {
  it('answers [] for an empty searchset', () => {
    expect(bundleSummaries({ resourceType: 'Bundle', type: 'searchset', entry: [] })).toEqual([]);
  });

  it('answers [] for a SUBSETTED searchset with total but no entry', () => {
    // The documented `_elements` failure mode on this HAPI.
    expect(
      bundleSummaries({ resourceType: 'Bundle', type: 'searchset', total: 3 }),
    ).toEqual([]);
  });

  it('answers [] for non-searchset garbage', () => {
    expect(bundleSummaries(undefined)).toEqual([]);
    expect(bundleSummaries(null)).toEqual([]);
    expect(bundleSummaries('not a searchset')).toEqual([]);
    expect(bundleSummaries({ entry: 'not an array' })).toEqual([]);
  });

  it('extracts id, counts and the first Composition title/date', () => {
    const [summary] = bundleSummaries({ entry: [storedBundle('7')] });

    expect(summary).toEqual({
      id: '7',
      type: 'document',
      timestamp: '2026-01-01T10:00:00Z',
      lastUpdated: '2026-01-01T10:00:05.000+00:00',
      entryCount: 2,
      title: 'Patient Summary',
      date: '2026-01-01T09:59:00Z',
    });
  });

  it('sorts newest first by timestamp', () => {
    const result = bundleSummaries({
      entry: [
        storedBundle('older', { timestamp: '2026-01-01T10:00:00Z' }),
        storedBundle('newer', { timestamp: '2026-02-01T10:00:00Z' }),
      ],
    });

    expect(result.map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('falls back to meta.lastUpdated for sorting and puts undated Bundles last', () => {
    const result = bundleSummaries({
      entry: [
        storedBundle('undated', { timestamp: undefined, meta: {} }),
        storedBundle('by-meta', {
          timestamp: undefined,
          meta: { lastUpdated: '2026-03-01T10:00:00Z' },
        }),
        storedBundle('by-timestamp', { timestamp: '2026-01-01T10:00:00Z' }),
      ],
    });

    expect(result.map((s) => s.id)).toEqual(['by-meta', 'by-timestamp', 'undated']);
  });

  it('drops entries without a resource id and non-Bundle resources', () => {
    const result = bundleSummaries({
      entry: [
        storedBundle('kept'),
        storedBundle('', {}),
        { resource: { resourceType: 'Bundle', type: 'document' } },
        { resource: { resourceType: 'Patient', id: 'p-1' } },
        {},
      ],
    });

    expect(result.map((s) => s.id)).toEqual(['kept']);
  });

  it('summarises a Bundle with no Composition as untitled, not a crash', () => {
    const [summary] = bundleSummaries({
      entry: [
        storedBundle('9', {
          entry: [{ resource: { resourceType: 'AllergyIntolerance' } }],
        }),
      ],
    });

    expect(summary.title).toBeUndefined();
    expect(summary.date).toBeUndefined();
    expect(summary.entryCount).toBe(1);
  });

  it('counts zero entries for a Bundle whose entry array is missing', () => {
    const [summary] = bundleSummaries({ entry: [storedBundle('3', { entry: undefined })] });

    expect(summary.entryCount).toBe(0);
  });

  it('reads the source composition uid from the stamped meta.tag', () => {
    const uid = 'abc-123::local.ehrbase.org::1';
    const [summary] = bundleSummaries({
      entry: [
        storedBundle('7', {
          meta: {
            lastUpdated: '2026-01-01T10:00:05Z',
            tag: [
              { system: 'urn:other', code: 'noise' },
              { system: COMPOSITION_LINK_SYSTEM, code: uid },
            ],
          },
        }),
      ],
    });

    expect(summary.compositionUid).toBe(uid);
  });

  it('leaves compositionUid unset on a Bundle stored before the link existed', () => {
    const [summary] = bundleSummaries({ entry: [storedBundle('8')] });

    expect(summary.compositionUid).toBeUndefined();
  });
});
