/**
 * The pure halves of adopting the interceptor-provisioned EHR.
 *
 * Two behaviours here guard against regressions that only show up against the
 * real stack: the malformed identifier system the deployed interceptor JAR
 * emits (`http://https://…`) must keep matching, and the EHR_STATUS PUT body
 * must carry NO uid — the version travels in If-Match, and a body uid naming
 * the previous version is a seam for the CDR to reject.
 */

import { describe, expect, it } from 'vitest';

import { adoptedEhrStatus, interceptorEhrId } from '../../server/ehr-link';

/** A Patient shaped like HAPI returns it after the interceptor ran. */
function patientWith(...identifiers: Array<Record<string, unknown>>) {
  return { resourceType: 'Patient', id: '7', identifier: identifiers };
}

describe('interceptorEhrId', () => {
  it('finds the ehr-id among other identifiers', () => {
    const patient = patientWith(
      { system: 'http://fhir.nl/fhir/NamingSystem/bsn', value: '999900128' },
      { system: 'http://openehr.org/NamingSystem/ehr-id', value: 'abc-123' },
    );
    expect(interceptorEhrId(patient)).toBe('abc-123');
  });

  it('matches the malformed system the deployed interceptor JAR emits', () => {
    const patient = patientWith({
      system: 'http://https://openehr.org/NamingSystem/ehr-id',
      value: 'abc-123',
    });
    expect(interceptorEhrId(patient)).toBe('abc-123');
  });

  it('returns null when no ehr-id identifier is present', () => {
    expect(interceptorEhrId(patientWith({ system: 'http://fhir.nl/fhir/NamingSystem/bsn', value: 'x' }))).toBeNull();
  });

  it('returns null for a patient without identifiers, or no patient at all', () => {
    expect(interceptorEhrId({ resourceType: 'Patient', id: '7' })).toBeNull();
    expect(interceptorEhrId(null)).toBeNull();
    expect(interceptorEhrId(undefined)).toBeNull();
  });

  it('ignores an ehr-id identifier with an empty value', () => {
    expect(interceptorEhrId(patientWith({ system: 'http://openehr.org/NamingSystem/ehr-id', value: '' }))).toBeNull();
  });
});

/** An EHR_STATUS shaped like EHRbase serves it for an interceptor-created EHR. */
function bareStatus() {
  return {
    _type: 'EHR_STATUS',
    archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1',
    name: { _type: 'DV_TEXT', value: 'EHR Status' },
    uid: { _type: 'OBJECT_VERSION_ID', value: 'abc-123::local.ehrbase.org::1' },
    subject: { _type: 'PARTY_SELF' },
    is_queryable: true,
    is_modifiable: true,
  };
}

const SUBJECT = {
  _type: 'PARTY_SELF',
  external_ref: {
    _type: 'PARTY_REF',
    namespace: 'fhir',
    type: 'PERSON',
    id: { _type: 'GENERIC_ID', value: '7', scheme: 'FHIR' },
  },
};

describe('adoptedEhrStatus', () => {
  it('replaces the subject and surfaces the version uid for If-Match', () => {
    const adopted = adoptedEhrStatus(bareStatus(), SUBJECT);
    expect(adopted?.versionUid).toBe('abc-123::local.ehrbase.org::1');
    expect(adopted?.body.subject).toEqual(SUBJECT);
  });

  it('strips the uid from the PUT body', () => {
    const adopted = adoptedEhrStatus(bareStatus(), SUBJECT);
    expect(adopted?.body).not.toHaveProperty('uid');
  });

  it('preserves everything else the interceptor created', () => {
    const adopted = adoptedEhrStatus(bareStatus(), SUBJECT);
    expect(adopted?.body).toMatchObject({
      _type: 'EHR_STATUS',
      archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1',
      name: { _type: 'DV_TEXT', value: 'EHR Status' },
      is_queryable: true,
      is_modifiable: true,
    });
  });

  it('refuses a status without a uid rather than guessing a version', () => {
    const { uid: _uid, ...withoutUid } = bareStatus();
    expect(adoptedEhrStatus(withoutUid, SUBJECT)).toBeNull();
    expect(adoptedEhrStatus(null, SUBJECT)).toBeNull();
  });
});
