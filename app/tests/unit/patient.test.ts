/**
 * FHIR Patient → view model.
 *
 * The cases below are the ones that produce a wrong answer rather than an
 * error: a partial birth date, a missing name, a patient whose `official` name
 * is not the first in the list.
 */

import { describe, it, expect } from 'vitest';
import {
  ageFrom,
  formatName,
  initialsOf,
  toPatientView,
  patientsFromBundle,
  validateDraft,
  draftToFhirPatient,
  BSN_SYSTEM,
  type FhirPatient,
  type PatientDraft,
} from '../../src/fhir/patient';

const ANNA: FhirPatient = {
  resourceType: 'Patient',
  id: '1',
  identifier: [{ system: 'http://fhir.nl/fhir/NamingSystem/bsn', value: '999900123' }],
  name: [{ use: 'official', family: 'de Vries', given: ['Anna'] }],
  gender: 'female',
  birthDate: '1974-03-12',
};

/** Fixed so the age assertions cannot drift with the wall clock. */
const AS_OF = new Date('2026-08-13T00:00:00Z');

describe('ageFrom', () => {
  it('computes whole years', () => {
    expect(ageFrom('1974-03-12', AS_OF)).toBe(52);
  });

  it('does not count a birthday that has not happened yet this year', () => {
    expect(ageFrom('1974-12-31', AS_OF)).toBe(51);
  });

  it('counts a birthday that falls exactly today', () => {
    expect(ageFrom('1974-08-13', AS_OF)).toBe(52);
  });

  it('pads a year-only FHIR date to 1 January', () => {
    expect(ageFrom('1974', AS_OF)).toBe(52);
  });

  it('pads a year-month FHIR date to the first of the month', () => {
    expect(ageFrom('1974-08', AS_OF)).toBe(52);
  });

  it('returns undefined rather than a number it cannot justify', () => {
    expect(ageFrom(undefined, AS_OF)).toBeUndefined();
    expect(ageFrom('', AS_OF)).toBeUndefined();
    expect(ageFrom('not-a-date', AS_OF)).toBeUndefined();
  });

  it('returns undefined for a future birth date instead of a negative age', () => {
    expect(ageFrom('2030-01-01', AS_OF)).toBeUndefined();
  });
});

describe('formatName', () => {
  it('joins given and family names', () => {
    expect(formatName(ANNA)).toBe('Anna de Vries');
  });

  it('joins multiple given names', () => {
    expect(formatName({ name: [{ family: 'Bakker', given: ['Sofie', 'Marie'] }] })).toBe(
      'Sofie Marie Bakker',
    );
  });

  it('prefers the name marked official over the first in the list', () => {
    const patient: FhirPatient = {
      name: [
        { use: 'nickname', family: 'Vries', given: ['Ans'] },
        { use: 'official', family: 'de Vries', given: ['Anna'] },
      ],
    };
    expect(formatName(patient)).toBe('Anna de Vries');
  });

  it('degrades to an identifiable fallback rather than an empty string', () => {
    expect(formatName({ id: '7' })).toBe('(unnamed patient 7)');
    expect(formatName({ id: '7', name: [{}] })).toBe('(unnamed patient 7)');
  });

  it('copes with a family name but no given name', () => {
    expect(formatName({ name: [{ family: 'Visser' }] })).toBe('Visser');
  });
});

describe('initialsOf', () => {
  it('takes the first letter of the given and family names', () => {
    expect(initialsOf(ANNA)).toBe('AD');
  });

  it('falls back to a placeholder when there is no name at all', () => {
    expect(initialsOf({})).toBe('?');
  });
});

describe('toPatientView', () => {
  it('maps every displayed field', () => {
    expect(toPatientView(ANNA, AS_OF)).toEqual({
      id: '1',
      name: 'Anna de Vries',
      initials: 'AD',
      age: 52,
      sex: 'female',
      birthDate: '1974-03-12',
      identifier: '999900123',
    });
  });

  it('leaves optional fields undefined rather than inventing them', () => {
    const view = toPatientView({ id: '2' }, AS_OF);
    expect(view.age).toBeUndefined();
    expect(view.sex).toBeUndefined();
    expect(view.identifier).toBeUndefined();
  });

  it('takes the BSN by naming system, not merely the first identifier', () => {
    const view = toPatientView(
      {
        id: '3',
        identifier: [
          // HAPI assigns this to a patient created without an identifier.
          { system: 'urn:ietf:rfc:3986', value: 'ca1d2dec-a989-40e0-8de5-f3f393ffaeb9' },
          { system: BSN_SYSTEM, value: '999900123' },
        ],
      },
      AS_OF,
    );
    expect(view.identifier).toBe('999900123');
  });

  it('shows no BSN rather than a HAPI-assigned UUID when there is none', () => {
    const view = toPatientView(
      { id: '4', identifier: [{ system: 'urn:ietf:rfc:3986', value: 'ca1d2dec-a989' }] },
      AS_OF,
    );
    expect(view.identifier).toBeUndefined();
  });
});

describe('validateDraft', () => {
  const valid: PatientDraft = {
    firstName: 'Anna',
    lastName: 'de Vries',
    birthDate: '1974-03-12',
    gender: 'female',
    bsn: '999900123',
  };

  it('accepts a complete draft', () => {
    expect(validateDraft(valid)).toEqual({});
  });

  it('requires a first and last name', () => {
    const errors = validateDraft({ ...valid, firstName: '  ', lastName: '' });
    expect(errors.firstName).toBeTruthy();
    expect(errors.lastName).toBeTruthy();
  });

  it('requires a date of birth', () => {
    expect(validateDraft({ ...valid, birthDate: '' }).birthDate).toBeTruthy();
  });

  it('rejects a partial date — the form asks for a full one', () => {
    expect(validateDraft({ ...valid, birthDate: '1974-03' }).birthDate).toBeTruthy();
  });

  it('rejects a date that does not exist', () => {
    expect(validateDraft({ ...valid, birthDate: '1974-02-31' }).birthDate).toBeTruthy();
  });

  it('rejects a future date of birth', () => {
    const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;
    expect(validateDraft({ ...valid, birthDate: nextYear }).birthDate).toBeTruthy();
  });

  it('treats BSN as optional — unidentified and foreign patients have none', () => {
    expect(validateDraft({ ...valid, bsn: '' })).toEqual({});
    expect(validateDraft({ ...valid, bsn: undefined })).toEqual({});
  });

  it('requires exactly 9 digits when a BSN IS given', () => {
    expect(validateDraft({ ...valid, bsn: '12345' }).bsn).toBeTruthy();
    expect(validateDraft({ ...valid, bsn: '1234567890' }).bsn).toBeTruthy();
    expect(validateDraft({ ...valid, bsn: 'abcdefghi' }).bsn).toBeTruthy();
  });

  it('ignores whitespace inside a BSN', () => {
    expect(validateDraft({ ...valid, bsn: '999 900 123' }).bsn).toBeUndefined();
  });

  it('accepts the reserved 999 test range — checksum is deliberately not enforced', () => {
    // The Dutch elfproef would reject these, and the seeded demo patients use
    // them, so shape-only validation is the decision here.
    expect(validateDraft({ ...valid, bsn: '999900128' }).bsn).toBeUndefined();
  });
});

describe('draftToFhirPatient', () => {
  const draft: PatientDraft = {
    firstName: 'Anna',
    lastName: 'de Vries',
    birthDate: '1974-03-12',
    gender: 'female',
    bsn: '999900123',
  };

  it('builds an official name, gender and birth date', () => {
    const patient = draftToFhirPatient(draft);
    expect(patient.resourceType).toBe('Patient');
    expect(patient.name).toEqual([{ use: 'official', family: 'de Vries', given: ['Anna'] }]);
    expect(patient.gender).toBe('female');
    expect(patient.birthDate).toBe('1974-03-12');
  });

  it('splits multiple given names into separate FHIR entries', () => {
    const patient = draftToFhirPatient({ ...draft, firstName: 'Sofie  Marie' });
    expect(patient.name?.[0].given).toEqual(['Sofie', 'Marie']);
  });

  it('attaches the BSN under the Dutch naming system', () => {
    expect(draftToFhirPatient(draft).identifier).toEqual([
      { system: BSN_SYSTEM, value: '999900123' },
    ]);
  });

  it('omits identifier entirely when there is no BSN, rather than sending an empty one', () => {
    expect(draftToFhirPatient({ ...draft, bsn: '' }).identifier).toBeUndefined();
  });

  it('never sets an id — the server assigns it, and the EHR links to that', () => {
    expect(draftToFhirPatient(draft).id).toBeUndefined();
  });

  it('trims stray whitespace out of names', () => {
    const patient = draftToFhirPatient({ ...draft, firstName: ' Anna ', lastName: ' de Vries ' });
    expect(patient.name?.[0].family).toBe('de Vries');
    expect(patient.name?.[0].given).toEqual(['Anna']);
  });

  it('round-trips back through the view model', () => {
    const view = toPatientView({ ...draftToFhirPatient(draft), id: '9' }, AS_OF);
    expect(view.name).toBe('Anna de Vries');
    expect(view.age).toBe(52);
    expect(view.identifier).toBe('999900123');
  });
});

describe('patientsFromBundle', () => {
  it('extracts Patient resources from a searchset', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [{ resource: ANNA }, { resource: { resourceType: 'OperationOutcome' } }, {}],
    };
    expect(patientsFromBundle(bundle)).toEqual([ANNA]);
  });

  it('returns an empty list for an empty or malformed bundle', () => {
    expect(patientsFromBundle({ total: 0 })).toEqual([]);
    expect(patientsFromBundle(undefined)).toEqual([]);
  });
});
