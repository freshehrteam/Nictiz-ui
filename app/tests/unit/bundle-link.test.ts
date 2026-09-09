/**
 * The patient link stamped onto a stored Bundle.
 *
 * Small surface, but one assertion here is doing real work: that `entry` comes
 * out referentially IDENTICAL. The openFHIR interceptor in this stack decides
 * what to do with a POSTed Bundle by sniffing its Composition entry, and a
 * Bundle it claims is committed to EHRbase as a duplicate composition instead
 * of being stored. Reference equality is the strongest available proof that
 * this function cannot have disturbed what the interceptor looks at.
 */

import { describe, expect, it } from 'vitest';

import {
  COMPOSITION_LINK_SYSTEM,
  PATIENT_LINK_SYSTEM,
  identifyBundleWithPatient,
  linkBundleToComposition,
} from '../../server/bundle-link';

/** A Bundle shaped like the ones openFHIR actually returns. */
function bundle() {
  return {
    resourceType: 'Bundle',
    type: 'document',
    meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'] },
    identifier: { system: 'urn:oid:2.16.840.1.113883.3.72', value: 'a-document-uuid' },
    entry: [{ resource: { resourceType: 'Composition', id: 'c1' } }],
  };
}

describe('identifyBundleWithPatient', () => {
  it('sets the identifier to the patient link', () => {
    const result = identifyBundleWithPatient(bundle(), '42');

    expect(result.identifier).toEqual({ system: PATIENT_LINK_SYSTEM, value: '42' });
  });

  it('leaves entry referentially unchanged', () => {
    const input = bundle();
    const result = identifyBundleWithPatient(input, '42');

    // Not toEqual — the interceptor safety argument rests on identity.
    expect(result.entry).toBe(input.entry);
  });

  it('does not mutate the bundle it was given', () => {
    const input = bundle();
    identifyBundleWithPatient(input, '42');

    expect(input.identifier.value).toBe('a-document-uuid');
  });

  it('is idempotent on re-application', () => {
    const once = identifyBundleWithPatient(bundle(), '42');
    const twice = identifyBundleWithPatient(once, '42');

    expect(twice).toEqual(once);
  });

  it('preserves meta.profile — the Bundle stays IPS-tagged', () => {
    const result = identifyBundleWithPatient(bundle(), '42');

    expect(result.meta.profile).toEqual([
      'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips',
    ]);
  });

  it('overwrites openFHIR’s document identifier — the accepted tradeoff', () => {
    const result = identifyBundleWithPatient(bundle(), '42');

    expect(result.identifier.system).not.toBe('urn:oid:2.16.840.1.113883.3.72');
  });

  /**
   * The no-op cases matter because the BFF only calls this when `?patientId=`
   * is present. If an empty id still stamped an identifier, every Bundle stored
   * without one would claim to belong to a patient called "".
   */
  it('returns the bundle untouched when there is no patient id', () => {
    const input = bundle();

    expect(identifyBundleWithPatient(input, '')).toBe(input);
  });

  it('tolerates a null bundle', () => {
    expect(identifyBundleWithPatient(null, '42')).toBeNull();
  });
});

describe('linkBundleToComposition', () => {
  const UID = 'abc-123::local.ehrbase.org::1';

  it('adds a meta.tag naming the source composition', () => {
    const result = linkBundleToComposition(bundle(), UID);

    expect(result.meta.tag).toContainEqual({ system: COMPOSITION_LINK_SYSTEM, code: UID });
  });

  it('leaves entry referentially unchanged — same interceptor argument', () => {
    const input = bundle();
    const result = linkBundleToComposition(input, UID);

    expect(result.entry).toBe(input.entry);
  });

  it('preserves meta.profile and unrelated tags', () => {
    const input = bundle();
    (input.meta as any).tag = [{ system: 'urn:other', code: 'keep-me' }];

    const result = linkBundleToComposition(input, UID);

    expect(result.meta.profile).toEqual([
      'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips',
    ]);
    expect(result.meta.tag).toContainEqual({ system: 'urn:other', code: 'keep-me' });
  });

  it('replaces an earlier composition link instead of accumulating', () => {
    const once = linkBundleToComposition(bundle(), 'abc-123::local.ehrbase.org::1');
    const twice = linkBundleToComposition(once, 'abc-123::local.ehrbase.org::2');

    const links = twice.meta.tag.filter((t: any) => t.system === COMPOSITION_LINK_SYSTEM);
    expect(links).toEqual([{ system: COMPOSITION_LINK_SYSTEM, code: 'abc-123::local.ehrbase.org::2' }]);
  });

  it('composes with the patient link — both survive', () => {
    const result = linkBundleToComposition(identifyBundleWithPatient(bundle(), '42'), UID);

    expect(result.identifier).toEqual({ system: PATIENT_LINK_SYSTEM, value: '42' });
    expect(result.meta.tag).toContainEqual({ system: COMPOSITION_LINK_SYSTEM, code: UID });
  });

  it('does not mutate the bundle it was given', () => {
    const input = bundle();
    linkBundleToComposition(input, UID);

    expect((input.meta as any).tag).toBeUndefined();
  });

  it('returns the bundle untouched when there is no uid', () => {
    const input = bundle();

    expect(linkBundleToComposition(input, '')).toBe(input);
  });

  it('tolerates a null bundle', () => {
    expect(linkBundleToComposition(null, UID)).toBeNull();
  });
});
