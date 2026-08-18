/**
 * Mandatory-field validation — the guard for "instant feedback instead of a 422".
 *
 * Asserted against the committed web template rather than a hand-built stub, so
 * these fail if the template is regenerated with different cardinalities instead
 * of quietly drifting away from what the CDR enforces.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { mandatoryFields, type WebTemplate } from '../../src/openehr/webtemplate';
import { validateMandatory, summarizeIssues } from '../../src/openehr/validation';
import { ROOT } from '../../src/openehr/flat';

const template = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/eps-patient-summary.webtemplate.json'), 'utf8'),
) as WebTemplate;

const ALLERGY = `${ROOT}/eps_allergies/adverse_reaction_risk`;
const PROBLEM = `${ROOT}/eps_problems/problem_diagnosis`;

describe('mandatoryFields reads min=1 off the template', () => {
  it('finds the clinically mandatory leaves', () => {
    const paths = mandatoryFields(template).map((f) => f.path);

    expect(paths).toContain(`${ALLERGY}/substance`);
    expect(paths).toContain(`${PROBLEM}/problem_diagnosis_name`);
    expect(paths).toContain(`${ROOT}/eps_history_of_procedures/procedure/procedure_name`);
  });

  /**
   * The trap that makes a naive implementation find NOTHING. FLAT elides the
   * ITEM_TREE segment the template nests the field under, and that segment is
   * not even consistently named (`tree` here, `structure` in problem_diagnosis).
   */
  it('emits FLAT paths, with the ITEM_TREE segment elided', () => {
    const paths = mandatoryFields(template).map((f) => f.path);

    expect(paths.some((p) => p.includes('/tree/'))).toBe(false);
    expect(paths.some((p) => p.includes('/structure/'))).toBe(false);
  });

  /**
   * The trap that makes a naive implementation demand the impossible.
   * `onset_of_first_reaction` is an OPTIONAL element (min=0) whose five CHOICE
   * alternatives are each min=1 — "if you pick this one it must have a value".
   * Descending into them yields five requirements that cannot all be satisfied.
   */
  it('does not mistake CHOICE alternatives for five separate requirements', () => {
    const paths = mandatoryFields(template).map((f) => f.path);
    const onset = `${ALLERGY}/onset_of_first_reaction`;

    expect(paths.some((p) => p.startsWith(onset))).toBe(false);
  });

  it('skips out-of-scope narrative branches the form never renders', () => {
    const paths = mandatoryFields(template).map((f) => f.path);
    expect(paths.some((p) => p.includes('fhir_narrative'))).toBe(false);
  });

  it('attributes each field to the repeatable that scopes it', () => {
    const fields = mandatoryFields(template);
    const substance = fields.find((f) => f.path === `${ALLERGY}/substance`);
    const exclusion = fields.find((f) => f.path.includes('global_exclusion_of_adverse_reactions'));

    expect(substance?.repeatableAncestor).toBe(ALLERGY);
    expect(exclusion?.repeatableAncestor).toBeUndefined();
  });
});

describe('a mandatory field inside a repeatable is CONDITIONAL', () => {
  /**
   * The rule that keeps an empty composition saveable. The section is min=0, so
   * "no allergies at all" is valid; only an entry the user has begun must be
   * completed.
   */
  it('does not demand substance for an untouched, empty entry', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: '',
      [`${ALLERGY}:0/criticality`]: '',
    };

    expect(validateMandatory(template, data).valid).toBe(true);
  });

  /**
   * The whole-form version of the same rule, and the most important
   * non-regression here: opening the form and pressing Save must still work.
   * Every mandatory control is present but empty, and none of them is demanded
   * because no entry has been started.
   */
  it('leaves an untouched form saveable — an empty EPS composition is legitimate', () => {
    const data = Object.fromEntries(
      [
        `${ALLERGY}:0/substance`,
        `${ALLERGY}:0/adverse_reaction_event:0/manifestation:0`,
        `${PROBLEM}:0/problem_diagnosis_name`,
        `${ROOT}/eps_medical_devices/medical_device_summary:0/status`,
        `${ROOT}/eps_history_of_procedures/procedure:0/procedure_name`,
      ].map((key) => [key, '']),
    );

    expect(validateMandatory(template, data).issues).toEqual([]);
  });

  it('demands substance once a sibling field in that entry is filled in', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: '',
      [`${ALLERGY}:0/criticality`]: { code: 'at0103', value: 'High risk' },
    };

    const result = validateMandatory(template, data);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.path)).toContain(`${ALLERGY}:0/substance`);
  });

  it('is satisfied when the mandatory field itself is filled in', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: { code: 'N02BE01', value: 'Paracetamol' },
      [`${ALLERGY}:0/criticality`]: { code: 'at0103', value: 'High risk' },
    };

    expect(validateMandatory(template, data).valid).toBe(true);
  });

  /** Each occurrence is judged on its own — entry 1 complete, entry 2 not. */
  it('reports only the incomplete occurrence, and numbers it', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: { code: 'N02BE01', value: 'Paracetamol' },
      [`${ALLERGY}:1/substance`]: '',
      [`${ALLERGY}:1/criticality`]: { code: 'at0103', value: 'High risk' },
    };

    const result = validateMandatory(template, data);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe(`${ALLERGY}:1/substance`);
    expect(result.issues[0].entryNumber).toBe(2);
  });
});

describe('mb-search keeps its value on .data', () => {
  /**
   * A coded control that has never been touched is an OBJECT, not undefined —
   * `{ code: '', value: '' }`. Treating "is an object" as "has a value" would
   * pass every empty coded field silently.
   */
  it('treats an empty coded object as empty', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: { code: '', value: '', terminology: '' },
      [`${ALLERGY}:0/criticality`]: { code: 'at0103', value: 'High risk' },
    };

    expect(validateMandatory(template, data).valid).toBe(false);
  });

  it('treats a populated coded object as filled', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: { code: 'N02BE01', value: 'Paracetamol', terminology: 'ATC' },
    };

    expect(validateMandatory(template, data).valid).toBe(true);
  });
});

describe('only the mounted branch is checked', () => {
  /**
   * The absence statements are min=1, but they live in branches that are
   * unmounted unless the section is in that mode. An unmounted field is absent
   * from `mb-form.data`, so it must not be demanded — otherwise every section
   * shows an error for a control that is not on screen.
   */
  it('ignores an absence statement whose branch is not rendered', () => {
    const data = {
      [`${ALLERGY}:0/substance`]: { code: 'N02BE01', value: 'Paracetamol' },
    };

    expect(validateMandatory(template, data).valid).toBe(true);
  });

  it('demands the absence statement when that branch IS rendered and empty', () => {
    const data = {
      [`${ROOT}/eps_allergies/absence_of_information/absence_statement`]: '',
    };

    const result = validateMandatory(template, data);
    expect(result.valid).toBe(false);
    expect(result.issues[0].label).toBe('Absence statement');
  });
});

describe('a repeatable leaf is satisfied by any one occurrence', () => {
  /** manifestation is a repeatable ELEMENT: :0 empty but :1 filled is fine. */
  it('accepts a filled second manifestation', () => {
    const event = `${ALLERGY}:0/adverse_reaction_event:0`;
    const data = {
      [`${ALLERGY}:0/substance`]: { code: 'N02BE01', value: 'Paracetamol' },
      [`${event}/manifestation:0`]: '',
      [`${event}/manifestation:1`]: { code: '271807003', value: 'Rash' },
    };

    expect(validateMandatory(template, data).valid).toBe(true);
  });

  it('demands one when the event is started but no manifestation is given', () => {
    const event = `${ALLERGY}:0/adverse_reaction_event:0`;
    const data = {
      [`${ALLERGY}:0/substance`]: { code: 'N02BE01', value: 'Paracetamol' },
      [`${event}/manifestation:0`]: '',
      [`${event}/severity_of_reaction`]: { code: 'at0093', value: 'Severe' },
    };

    const result = validateMandatory(template, data);
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.label)).toContain('Manifestation');
  });
});

describe('summarizeIssues', () => {
  it('names the fields, and truncates a long list', () => {
    expect(summarizeIssues([])).toBe('no missing mandatory fields');

    const many = ['A', 'B', 'C', 'D'].map((label) => ({ path: label, label }));
    expect(summarizeIssues(many)).toBe('A, B, C and 1 more');
  });
});

/**
 * The two web-template FORMATS.
 *
 * This is the defect that made the first working implementation mark nothing at
 * all in the running app while passing every test against the fixture.
 *
 * `tools/webtemplate-gen` emits the RAW shape: ELEMENT nodes inside `tree` /
 * `structure` ITEM_TREE containers, with the DV type on a `value` child.
 * EHRbase's `/webtemplate` endpoint — which is what the app fetches at runtime —
 * emits the SIMPLIFIED shape: the containers are gone and the DV type sits on
 * the field node itself.
 *
 * Recognising only ELEMENT matches everything in the fixture and nothing in
 * production, so the form silently reverts to letting the CDR 422 do the work.
 * Both fixtures are committed and asserted to agree.
 */
describe('both web-template formats yield the same requirements', () => {
  const simplified = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../fixtures/eps-patient-summary.webtemplate.simplified.json'),
      'utf8',
    ),
  ) as WebTemplate;

  it('finds the same mandatory fields in the raw and simplified shapes', () => {
    const raw = mandatoryFields(template).map((f) => f.path).sort();
    const simple = mandatoryFields(simplified).map((f) => f.path).sort();

    expect(simple).toEqual(raw);
    expect(simple.length).toBeGreaterThan(0);
  });

  it('reads the DV type off the field node in the simplified shape', () => {
    const substance = mandatoryFields(simplified).find((f) => f.path === `${ALLERGY}/substance`);

    expect(substance?.valueType).toBe('DV_CODED_TEXT');
    expect(substance?.repeatableAncestor).toBe(ALLERGY);
  });

  it('still avoids the CHOICE trap in the simplified shape', () => {
    const paths = mandatoryFields(simplified).map((f) => f.path);
    expect(paths.some((p) => p.startsWith(`${ALLERGY}/onset_of_first_reaction`))).toBe(false);
  });

  /**
   * ACTION state machinery: min=1 and repeated seven times in the raw shape,
   * not mandatory at all in the simplified one. EHRbase sets it itself.
   */
  it('excludes ism_transition from both', () => {
    for (const t of [template, simplified]) {
      expect(mandatoryFields(t).some((f) => f.path.includes('ism_transition'))).toBe(false);
    }
  });

  it('validates real form data against the simplified shape', () => {
    const started = {
      [`${ALLERGY}:0/substance`]: '',
      [`${ALLERGY}:0/criticality`]: { code: 'at0103', value: 'High risk' },
    };

    expect(validateMandatory(simplified, started).valid).toBe(false);
  });
});
