/**
 * Reading an IPS document Bundle.
 *
 * The reference resolver is what these mostly guard. An IPS Bundle addresses
 * its own entries by `urn:uuid:` fullUrl, but `Reference.reference` is equally
 * allowed to be a relative `Type/id` — and resolving only one of the two fails
 * SILENTLY, rendering a section as empty rather than as broken. That failure
 * mode is why it is tested against both forms and against a dangling reference.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import type { FhirBundle } from '../../src/fhir/bundle';
import {
  codeText,
  dayOf,
  deviceLabel,
  findComposition,
  indexBundle,
  orDash,
  resolveReference,
} from '../../src/fhir/ips';

const REAL_BUNDLE: FhirBundle = JSON.parse(
  readFileSync('../fixtures/eps.example.bundle.json', 'utf8'),
);

describe('indexBundle / resolveReference', () => {
  it('resolves a urn:uuid reference, the form an IPS document actually uses', () => {
    const index = indexBundle(REAL_BUNDLE);
    const allergy = REAL_BUNDLE.entry!.find(
      (e) => e.resource?.resourceType === 'AllergyIntolerance',
    )!;

    expect(resolveReference(index, { reference: allergy.fullUrl })).toBe(allergy.resource);
  });

  it('resolves a relative Type/id reference', () => {
    const index = indexBundle({
      resourceType: 'Bundle',
      entry: [{ resource: { resourceType: 'Condition', id: 'c1' } }],
    });

    expect(resolveReference(index, { reference: 'Condition/c1' })?.id).toBe('c1');
  });

  it('resolves both forms from the same Bundle', () => {
    // Neither index may shadow the other: a Bundle can mix the two.
    const index = indexBundle({
      resourceType: 'Bundle',
      entry: [
        { fullUrl: 'urn:uuid:aaa', resource: { resourceType: 'Condition', id: 'c1' } },
        { fullUrl: 'urn:uuid:bbb', resource: { resourceType: 'Procedure', id: 'p1' } },
      ],
    });

    expect(resolveReference(index, { reference: 'urn:uuid:aaa' })?.resourceType).toBe('Condition');
    expect(resolveReference(index, { reference: 'Procedure/p1' })?.resourceType).toBe('Procedure');
  });

  it('returns undefined for a dangling reference rather than throwing', () => {
    const index = indexBundle(REAL_BUNDLE);

    expect(resolveReference(index, { reference: 'urn:uuid:not-here' })).toBeUndefined();
    expect(resolveReference(index, { display: 'Penicillin' })).toBeUndefined();
    expect(resolveReference(index, undefined)).toBeUndefined();
  });

  it('survives an empty Bundle', () => {
    const index = indexBundle(undefined);
    expect(index.byFullUrl.size).toBe(0);
    expect(resolveReference(index, { reference: 'urn:uuid:x' })).toBeUndefined();
  });
});

describe('findComposition', () => {
  it('finds the Composition in a real Bundle', () => {
    expect(findComposition(REAL_BUNDLE)?.resourceType).toBe('Composition');
  });

  it('returns undefined when there is none', () => {
    expect(
      findComposition({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient' } }] }),
    ).toBeUndefined();
  });
});

describe('codeText', () => {
  it('prefers text, then display, then the bare code', () => {
    expect(codeText({ text: 'Peanut', coding: [{ display: 'Other' }] })).toBe('Peanut');
    expect(codeText({ coding: [{ display: 'Peanut', code: 'X' }] })).toBe('Peanut');
    expect(codeText({ coding: [{ code: 'X' }] })).toBe('X');
    expect(codeText(undefined)).toBe('');
  });
});

describe('deviceLabel', () => {
  it('falls through name, then type, then model — past empty strings', () => {
    expect(deviceLabel({ resourceType: 'Device', deviceName: [{ name: 'Hip' }] })).toBe('Hip');
    expect(deviceLabel({ resourceType: 'Device', type: { text: 'Implant' } })).toBe('Implant');
    expect(deviceLabel({ resourceType: 'Device', modelNumber: 'M-1' })).toBe('M-1');
    expect(deviceLabel(undefined)).toBe('');
  });
});

describe('dayOf / orDash', () => {
  it('trims a datetime to its day', () => {
    expect(dayOf('2022-02-03T04:05:06+00:00')).toBe('2022-02-03');
    expect(dayOf(undefined)).toBe('');
  });

  it('renders an empty cell as a dash', () => {
    expect(orDash('')).toBe('—');
    expect(orDash('   ')).toBe('—');
    expect(orDash(undefined)).toBe('—');
    expect(orDash('Peanut')).toBe('Peanut');
  });
});
