/**
 * Web-template-driven field typing — the plan's dedicated `body_site` test.
 *
 * This is the guard for the P7 rule: derive the control from the value child,
 * never from the field name. `body_site` appears three times in this one
 * template with three different shapes, and getting any of them wrong fails
 * silently in one direction or is rejected by the CDR in the other.
 *
 * Asserted against the committed web template, so it fails if the template is
 * ever regenerated with different types rather than quietly drifting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeField, findNode, isCoded, type WebTemplate } from '../../src/openehr/webtemplate';

const template = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/eps-patient-summary.webtemplate.json'), 'utf8'),
) as WebTemplate;

/**
 * Paths as the web template nests them — including the ITEM_TREE segment that
 * FLAT keys omit. FLAT collapses it; the template does not.
 *
 * Note that the segment is NOT always called `tree`: the problem_diagnosis
 * archetype names its structure `structure`, while the others use `tree` (and
 * medical_device_summary has both a `tree` and a `tree2`). One more reason not
 * to construct these paths by convention — look them up.
 */
const PROBLEMS_BODY_SITE = 'eps_problems/problem_diagnosis/structure/body_site';
const PROCEDURES_BODY_SITE = 'eps_history_of_procedures/procedure/tree/body_site';
const DEVICES_BODY_SITE =
  'eps_medical_devices/medical_device_summary/tree/device_details/body_site';

describe('body_site is three different fields with one name', () => {
  it('is DV_CODED_TEXT and repeatable in Problems → mb-search + mb-repeatable-simple', () => {
    const shape = describeField(template, PROBLEMS_BODY_SITE);
    expect(shape?.valueType).toBe('DV_CODED_TEXT');
    expect(shape?.repeatable).toBe(true);
  });

  it('is DV_TEXT and repeatable in Procedures → mb-input + mb-repeatable-simple', () => {
    const shape = describeField(template, PROCEDURES_BODY_SITE);
    expect(shape?.valueType).toBe('DV_TEXT');
    expect(shape?.repeatable).toBe(true);
  });

  it('is DV_TEXT and SINGLE in Devices → a bare mb-input, no index, no wrapper', () => {
    const shape = describeField(template, DEVICES_BODY_SITE);
    expect(shape?.valueType).toBe('DV_TEXT');
    expect(shape?.repeatable).toBe(false);
  });

  it('so the field name alone can never decide the control', () => {
    const shapes = [PROBLEMS_BODY_SITE, PROCEDURES_BODY_SITE, DEVICES_BODY_SITE].map((p) =>
      describeField(template, p),
    );
    const distinct = new Set(shapes.map((s) => `${s?.valueType}/${s?.repeatable}`));
    expect(distinct.size).toBe(3);
  });

  it('isCoded distinguishes the coded one from the two text ones', () => {
    expect(isCoded(template, PROBLEMS_BODY_SITE)).toBe(true);
    expect(isCoded(template, PROCEDURES_BODY_SITE)).toBe(false);
    expect(isCoded(template, DEVICES_BODY_SITE)).toBe(false);
  });
});

describe('describeField', () => {
  it('reads the type off the value child, not the ELEMENT node', () => {
    // The ELEMENT itself is rmType ELEMENT; only its `value` child is typed.
    const node = findNode(template.tree, PROBLEMS_BODY_SITE);
    expect(node?.rmType).toBe('ELEMENT');
    expect(describeField(template, PROBLEMS_BODY_SITE)?.valueType).toBe('DV_CODED_TEXT');
  });

  it('extracts an archetype-local code list from a coded field', () => {
    const shape = describeField(
      template,
      'eps_medical_devices/medical_device_summary/tree/status',
    );
    expect(shape?.valueType).toBe('DV_CODED_TEXT');
    expect(shape?.options).toEqual([
      { code: 'at0003', label: 'Never' },
      { code: 'at0004', label: 'Current' },
      { code: 'at0005', label: 'Previous' },
    ]);
  });

  it('reports no code list for a terminology-backed field, so it needs mb-search', () => {
    const shape = describeField(
      template,
      'eps_allergies/adverse_reaction_risk/tree/substance',
    );
    expect(shape?.valueType).toBe('DV_CODED_TEXT');
    expect(shape?.options).toBeUndefined();
  });

  it('tolerates FLAT indices in the path', () => {
    expect(
      describeField(template, 'eps_problems/problem_diagnosis:0/structure/body_site:0')?.valueType,
    ).toBe('DV_CODED_TEXT');
  });

  it('consumes a leading template-root segment', () => {
    const rootId = template.tree?.id;
    expect(describeField(template, `${rootId}/${PROBLEMS_BODY_SITE}`)?.valueType).toBe(
      'DV_CODED_TEXT',
    );
  });

  it('returns undefined for a path the template does not have', () => {
    expect(describeField(template, 'eps_allergies/does_not_exist')).toBeUndefined();
  });
});

describe('the template we build against', () => {
  it('has the four clinical sections the forms target, and no medications', () => {
    const sections = (template.tree?.children ?? []).map((c) => c.id);
    expect(sections).toContain('eps_allergies');
    expect(sections).toContain('eps_problems');
    expect(sections).toContain('eps_medical_devices');
    expect(sections).toContain('eps_history_of_procedures');
    // The mockup shows Medications and Vital Signs; this template has neither.
    expect(sections).not.toContain('eps_medications');
    expect(sections).not.toContain('eps_vital_signs');
  });
});
