/**
 * The static EPS profile model.
 *
 * These guard the DATA, not behaviour: the section spine is transcribed from
 * `composition-eu-eps` by hand, and a transcription error — a duplicated LOINC
 * code, a dropped section — would not fail a build or a render. It would just
 * quietly show the reader the wrong profile.
 */

import { describe, it, expect } from 'vitest';

import {
  EPS_COMPOSITION_ELEMENTS,
  EPS_ELEMENTS,
  EPS_SECTIONS,
  elementsFor,
  sectionSpecFor,
} from '../../src/fhir/eps-model';

describe('EPS_SECTIONS', () => {
  it('carries all 17 profile sections', () => {
    expect(EPS_SECTIONS).toHaveLength(17);
  });

  it('is in profile order, starting at Problems and ending at Patient History', () => {
    expect(EPS_SECTIONS[0].slice).toBe('sectionProblems');
    expect(EPS_SECTIONS[16].slice).toBe('sectionPatientHx');
  });

  it('gives every section a unique LOINC code', () => {
    // A duplicate would make `sectionSpecFor` match the wrong slice, and the
    // document section would land under someone else's heading.
    const codes = EPS_SECTIONS.map((section) => section.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every section a unique slice name, which the testids are built from', () => {
    const slices = EPS_SECTIONS.map((section) => section.slice);
    expect(new Set(slices).size).toBe(slices.length);
  });

  it('marks exactly the five mandatory sections with min 1', () => {
    expect(EPS_SECTIONS.filter((section) => section.min === 1).map((s) => s.slice)).toEqual([
      'sectionProblems',
      'sectionAllergies',
      'sectionMedications',
      'sectionProceduresHx',
      'sectionMedicalDevices',
    ]);
  });

  it('admits a DocumentReference in every section', () => {
    expect(
      EPS_SECTIONS.every((section) => section.entryTypes.includes('DocumentReference')),
    ).toBe(true);
  });

  it('carries the LOINC codes our own mapping actually emits', () => {
    // The four openFHIR produces today. If any of these drifted, the live
    // document would stop matching its spec section and fall through to the
    // "Additional sections" bucket.
    const codes = EPS_SECTIONS.map((section) => section.code);
    expect(codes).toEqual(expect.arrayContaining(['48765-2', '11450-4', '46264-8', '47519-4']));
  });
});

describe('sectionSpecFor', () => {
  it('matches by LOINC code', () => {
    expect(sectionSpecFor('11450-4', undefined)?.slice).toBe('sectionProblems');
    expect(sectionSpecFor('46264-8', undefined)?.slice).toBe('sectionMedicalDevices');
  });

  it('prefers the code over a title that disagrees with it', () => {
    // Our own output titles the devices section "Medical Devices and
    // Implants" while carrying `46264-8`. The code is the identity.
    expect(sectionSpecFor('46264-8', 'Something else entirely')?.slice).toBe(
      'sectionMedicalDevices',
    );
  });

  it('falls back to a normalised title when there is no code', () => {
    expect(sectionSpecFor(undefined, 'Problems')?.slice).toBe('sectionProblems');
    expect(sectionSpecFor(undefined, '  history of procedures  ')?.slice).toBe(
      'sectionProceduresHx',
    );
    expect(sectionSpecFor(undefined, 'Allergies & Intolerances')?.slice).toBe('sectionAllergies');
  });

  it('keeps every section title distinct after normalisation', () => {
    // The fallback map is keyed by the normalised title, and normalisation
    // drops "and". Two titles collapsing to one key would make a document
    // section match the wrong slice whenever its code is missing.
    const normalised = EPS_SECTIONS.map(
      (section) => sectionSpecFor(undefined, section.title)?.slice,
    );

    expect(normalised).toEqual(EPS_SECTIONS.map((section) => section.slice));
  });

  it('returns undefined for a section the profile does not describe', () => {
    // Not an error: the caller appends it as an extra rather than dropping it.
    expect(sectionSpecFor('99999-9', 'Invented section')).toBeUndefined();
    expect(sectionSpecFor(undefined, undefined)).toBeUndefined();
  });
});

describe('elementsFor', () => {
  it('returns the element list for a modelled type', () => {
    expect(elementsFor('AllergyIntolerance').map((e) => e.path)).toContain('reaction');
  });

  it('returns an empty list for an unknown type rather than throwing', () => {
    // The view still renders such a resource — every populated key comes
    // through the residual pass instead.
    expect(elementsFor('Nonesuch')).toEqual([]);
  });

  it('describes all seven reaction sub-fields the IG obliges or we populate', () => {
    const reaction = elementsFor('AllergyIntolerance').find((e) => e.path === 'reaction');

    expect(reaction?.children?.map((child) => child.path)).toEqual([
      'substance',
      'manifestation',
      'description',
      'onset',
      'severity',
      'exposureRoute',
      'note',
    ]);
  });

  it('extends the obligation floor with what our mapping produces', () => {
    // Procedure obliges 3 elements; our Bundle populates 14. Both are here,
    // and only the obliged ones are flagged as such.
    const procedure = elementsFor('Procedure');
    expect(procedure.filter((e) => e.obliged).map((e) => e.path)).toEqual([
      'code',
      'subject',
      'performed[x]',
    ]);
    expect(procedure.map((e) => e.path)).toEqual(
      expect.arrayContaining(['focalDevice', 'usedReference', 'note', 'complication']),
    );
  });

  it('gives every element a unique path within its type', () => {
    for (const [resourceType, elements] of Object.entries(EPS_ELEMENTS)) {
      const paths = elements.map((element) => element.path);
      expect(new Set(paths).size, resourceType).toBe(paths.length);
    }
  });

  it('gives every element a label, so nothing renders as an empty row heading', () => {
    const all = [...Object.values(EPS_ELEMENTS).flat(), ...EPS_COMPOSITION_ELEMENTS];
    expect(all.every((element) => element.label.trim().length > 0)).toBe(true);
  });
});

describe('EPS_COMPOSITION_ELEMENTS', () => {
  it('covers the Composition header the profile requires', () => {
    expect(EPS_COMPOSITION_ELEMENTS.map((element) => element.path)).toEqual(
      expect.arrayContaining([
        'identifier',
        'status',
        'type',
        'subject',
        'date',
        'author',
        'title',
      ]),
    );
  });
});
