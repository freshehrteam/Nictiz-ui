/**
 * FLAT normalisation, scope filtering and the repeatable-seeding workaround.
 *
 * Each case here corresponds to a defect that produced either an HTTP 400 from
 * EHRbase or a silent data loss. They are regression guards, not coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  ROOT,
  splitAttribute,
  normalizeIndices,
  indicesOf,
  isInScope,
  filterToScope,
  diffFlat,
  summarizeDiff,
  normalizeExport,
  ensureRepeatableOccurrences,
} from '../../src/openehr/flat';

describe('key grammar', () => {
  it('splits a path from its attribute on the LAST pipe', () => {
    expect(splitAttribute(`${ROOT}/eps_allergies/substance|code`)).toEqual({
      path: `${ROOT}/eps_allergies/substance`,
      attribute: 'code',
    });
    expect(splitAttribute(`${ROOT}/category`)).toEqual({ path: `${ROOT}/category` });
  });

  it('normalises indices so keys can be compared structurally', () => {
    expect(normalizeIndices('a:0/b:12/c')).toBe('a:*/b:*/c');
  });

  it('reads indices outermost first', () => {
    expect(indicesOf('a:2/b:0/c:11')).toEqual([2, 0, 11]);
  });
});

describe('scope', () => {
  it('accepts all four clinical sections', () => {
    for (const section of [
      'eps_allergies',
      'eps_problems',
      'eps_medical_devices',
      'eps_history_of_procedures',
    ]) {
      expect(isInScope(`${ROOT}/${section}/anything`)).toBe(true);
    }
  });

  it('rejects narrative, workflow and guideline housekeeping', () => {
    expect(isInScope(`${ROOT}/eps_allergies/container/fhir_narrative/narrative`)).toBe(false);
    expect(isInScope(`${ROOT}/eps_problems/absence_of_information/_work_flow_id|id`)).toBe(false);
    expect(isInScope(`${ROOT}/eps_problems/absence_of_information/_guideline_id|id`)).toBe(false);
  });

  it('rejects keys outside the template root', () => {
    expect(isInScope('some_other_template/eps_allergies/x')).toBe(false);
  });

  it('filters a mixed payload down to in-scope keys only', () => {
    const filtered = filterToScope({
      [`${ROOT}/eps_allergies/adverse_reaction_risk:0/substance|code`]: 'A01AA',
      [`${ROOT}/eps_allergies/container/fhir_narrative/narrative`]: '<html/>',
      'unrelated/key': 'x',
    });
    expect(Object.keys(filtered)).toEqual([
      `${ROOT}/eps_allergies/adverse_reaction_risk:0/substance|code`,
    ]);
  });
});

describe('diffFlat', () => {
  it('sorts keys into lost, mangled, spurious and matched', () => {
    const diff = diffFlat({ a: '1', b: '2', c: '3' }, { a: '1', b: '99', d: '4' });
    expect(diff.matched).toEqual(['a']);
    expect(diff.mangled).toEqual([{ key: 'b', expected: '2', actual: '99' }]);
    expect(diff.lost).toEqual(['c']);
    expect(diff.spurious).toEqual(['d']);
  });

  it('compares as strings — FLAT is a string format and EHRbase requotes numbers', () => {
    expect(diffFlat({ a: 1 }, { a: '1' }).matched).toEqual(['a']);
  });

  it('summarises all four buckets', () => {
    expect(summarizeDiff(diffFlat({ a: '1' }, { a: '1' }))).toBe(
      'matched 1 · lost 0 · mangled 0 · spurious 0',
    );
  });
});

describe('normalizeExport (D-2, D-3)', () => {
  it('re-roots the unprefixed strays mb-context emits', () => {
    const out = normalizeExport({ 'category|code': '433' });
    expect(out[`${ROOT}/category|code`]).toBe('433');
    expect(out['category|code']).toBeUndefined();
  });

  it('prefers the rooted twin when Medblocks emits both', () => {
    const out = normalizeExport({
      'category|code': 'STRAY',
      [`${ROOT}/category|code`]: '433',
    });
    expect(out[`${ROOT}/category|code`]).toBe('433');
    expect(Object.keys(out)).toHaveLength(1);
  });

  it('expands language and territory into CODE_PHRASE pairs', () => {
    const out = normalizeExport({ [`${ROOT}/territory`]: 'NL', [`${ROOT}/language`]: 'en' });
    expect(out[`${ROOT}/territory|code`]).toBe('NL');
    expect(out[`${ROOT}/territory|terminology`]).toBe('ISO_3166-1');
    expect(out[`${ROOT}/language|code`]).toBe('en');
    expect(out[`${ROOT}/language|terminology`]).toBe('ISO_639-1');
    // The bare keys are exactly what EHRbase rejects with HTTP 400.
    expect(out[`${ROOT}/territory`]).toBeUndefined();
    expect(out[`${ROOT}/language`]).toBeUndefined();
  });

  it('expands composer as PARTY_PROXY |name, not a code phrase', () => {
    const out = normalizeExport({ [`${ROOT}/composer`]: 'Dr Jansen' });
    expect(out[`${ROOT}/composer|name`]).toBe('Dr Jansen');
    expect(out[`${ROOT}/composer`]).toBeUndefined();
  });

  it('never overwrites an explicit attribute that is already present', () => {
    const out = normalizeExport({
      [`${ROOT}/territory`]: 'NL',
      [`${ROOT}/territory|code`]: 'BE',
    });
    expect(out[`${ROOT}/territory|code`]).toBe('BE');
  });

  it('drops an empty ctx scalar rather than emitting a half-formed pair', () => {
    const out = normalizeExport({ [`${ROOT}/territory`]: '' });
    expect(out[`${ROOT}/territory|code`]).toBeUndefined();
    expect(out[`${ROOT}/territory|terminology`]).toBeUndefined();
  });

  it('honours a non-default root', () => {
    const out = normalizeExport({ 'category|code': '433' }, 'other_root');
    expect(out['other_root/category|code']).toBe('433');
  });
});

describe('ensureRepeatableOccurrences (D-8)', () => {
  it('seeds a :0 marker for a repeatable with no data', () => {
    const out = ensureRepeatableOccurrences({}, [`${ROOT}/eps_allergies/adverse_reaction_risk`]);
    expect(out[`${ROOT}/eps_allergies/adverse_reaction_risk:0`]).toBe('');
  });

  it('leaves a repeatable that already has data untouched', () => {
    const existing = {
      [`${ROOT}/eps_allergies/adverse_reaction_risk:0/substance|code`]: 'A01AA',
    };
    const out = ensureRepeatableOccurrences(existing, [
      `${ROOT}/eps_allergies/adverse_reaction_risk`,
    ]);
    expect(out[`${ROOT}/eps_allergies/adverse_reaction_risk:0`]).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(1);
  });

  it('seeds NESTED repeatables too — the trap inside the trap', () => {
    // The PoC's hand-written list covered only the two top-level repeatables and
    // still crashed. Nested paths must be seeded independently.
    const nested = `${ROOT}/eps_allergies/adverse_reaction_risk:0/adverse_reaction_event`;
    const out = ensureRepeatableOccurrences({}, [
      `${ROOT}/eps_allergies/adverse_reaction_risk`,
      nested,
    ]);
    expect(out[`${nested}:0`]).toBe('');
  });

  it('seeds an empty marker that serialize() will drop before it reaches the CDR', () => {
    const out = ensureRepeatableOccurrences({}, [`${ROOT}/eps_problems/problem_diagnosis`]);
    expect(out[`${ROOT}/eps_problems/problem_diagnosis:0`]).toBe('');
  });
});
