/**
 * Projecting the real EPS Bundle onto the profile.
 *
 * Every assertion here is a datapoint the PREVIOUS viewer dropped. That is the
 * point of the file: "the viewer shows everything" is a claim about data, so it
 * is tested against the actual mapped output on disk rather than a mock. A
 * fixture-free test would pass just as happily against a viewer that lost half
 * the document again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import type { FhirBundle } from '../../src/fhir/bundle';
import { epsDocumentView, type Datapoint, type ResourceView } from '../../src/fhir/eps-view';

const REAL_BUNDLE: FhirBundle = JSON.parse(
  readFileSync('../fixtures/eps.example.bundle.json', 'utf8'),
);

const VIEW = epsDocumentView(REAL_BUNDLE);

/** Every resource on the page, including ones nested under a reference. */
function allResources(): ResourceView[] {
  const found: ResourceView[] = [];

  const walk = (datapoints: Datapoint[]): void => {
    for (const datapoint of datapoints) {
      if (datapoint.reference?.view) {
        found.push(datapoint.reference.view);
        walk(datapoint.reference.view.datapoints);
      }
      for (const group of datapoint.groups ?? []) walk(group.datapoints);
    }
  };

  for (const section of VIEW.sections) {
    for (const resource of section.resources) {
      found.push(resource);
      walk(resource.datapoints);
    }
  }
  for (const orphan of VIEW.orphans) {
    found.push(orphan);
    walk(orphan.datapoints);
  }

  return found;
}

function resourceIn(sectionTitle: string, resourceType: string): ResourceView {
  const section = VIEW.sections.find((candidate) => candidate.title === sectionTitle)!;
  return section.resources.find((resource) => resource.resourceType === resourceType)!;
}

function datapoint(resource: ResourceView, path: string): Datapoint {
  return resource.datapoints.find((candidate) => candidate.path === path)!;
}

describe('the section spine', () => {
  it('returns all 17 profile sections, in profile order', () => {
    // The spine comes from the SPEC, not from the document — which is the
    // only way a reader can see that a Medication Summary is missing.
    expect(VIEW.sections).toHaveLength(17);
    expect(VIEW.sections.map((section) => section.spec?.slice).slice(0, 3)).toEqual([
      'sectionProblems',
      'sectionAllergies',
      'sectionMedications',
    ]);
  });

  it('marks exactly the four sections the fixture carries as present', () => {
    expect(
      VIEW.sections.filter((section) => section.present).map((section) => section.spec?.slice),
    ).toEqual([
      'sectionProblems',
      'sectionAllergies',
      'sectionProceduresHx',
      'sectionMedicalDevices',
    ]);
  });

  it('keeps the other 13 as present: false rather than omitting them', () => {
    const absent = VIEW.sections.filter((section) => !section.present);

    expect(absent).toHaveLength(13);
    expect(absent.every((section) => section.resources.length === 0)).toBe(true);
    // Still labelled, so the page can name what is not there.
    expect(absent.every((section) => section.title && section.code)).toBe(true);
  });

  it('matches the devices section on its code despite a different title', () => {
    // The document says "Medical Devices and Implants"; the profile says
    // "Medical Devices". Only the LOINC code makes them the same section.
    const devices = VIEW.sections.find(
      (section) => section.spec?.slice === 'sectionMedicalDevices',
    )!;

    expect(devices.present).toBe(true);
    expect(devices.title).toBe('Medical Devices and Implants');
    expect(devices.code).toBe('46264-8');
  });

  it('captures emptyReason for all four present sections', () => {
    // Previously discarded entirely, though it is a real assertion by the
    // source about why a section holds what it holds.
    const present = VIEW.sections.filter((section) => section.present);

    expect(present.map((section) => section.emptyReason)).toEqual([
      'No known problems',
      'No known allergies',
      'No known procedures',
      'No information about medical devices',
    ]);
  });

  it('captures the narrative without rendering it', () => {
    // Held as a string only. It is server-supplied XHTML; the view never
    // interpolates it as HTML.
    const problems = VIEW.sections.find((section) => section.spec?.slice === 'sectionProblems')!;
    expect(problems.narrative).toContain('<table');
  });

  it('resolves every section entry, leaving none unresolved', () => {
    expect(VIEW.sections.every((section) => section.unresolved.length === 0)).toBe(true);
  });
});

describe('Device resources', () => {
  it('surfaces all three, which the table viewer could not show at all', () => {
    const devices = allResources().filter((resource) => resource.resourceType === 'Device');

    expect(devices.map((device) => device.title).sort()).toEqual([
      'Ceramic hip implant',
      'focal device name',
      'used device name',
    ]);
  });

  it('reaches each one through the reference that names it', () => {
    const statement = resourceIn('Medical Devices and Implants', 'DeviceUseStatement');
    const procedure = resourceIn('Procedures', 'Procedure');

    expect(datapoint(statement, 'device').reference?.view?.title).toBe('Ceramic hip implant');
    expect(datapoint(procedure, 'usedReference').reference?.view?.title).toBe('used device name');

    const focal = datapoint(procedure, 'focalDevice').groups![0].datapoints.find(
      (child) => child.path === 'manipulated',
    )!;
    expect(focal.reference?.view?.title).toBe('focal device name');
  });

  it('does not also list a transitively-reached Device as an orphan', () => {
    // Rendered inline under the resource that references it, so listing it
    // again at the bottom would double-count the document.
    expect(VIEW.orphans).toEqual([]);
  });

  it('lists a genuinely unreferenced entry as an orphan', () => {
    const stray = epsDocumentView({
      resourceType: 'Bundle',
      entry: [
        { resource: { resourceType: 'Composition', section: [] } },
        { fullUrl: 'urn:uuid:loose', resource: { resourceType: 'Device', modelNumber: 'M-9' } },
      ],
    });

    expect(stray.orphans.map((orphan) => orphan.resourceType)).toEqual(['Device']);
  });

  it('does not summarise a populated backbone as absent', () => {
    // `udiCarrier` holds no scalar text of its own, only children. An empty
    // summary renders as `—` — "not present" — directly above the child that
    // proves otherwise.
    const statement = resourceIn('Medical Devices and Implants', 'DeviceUseStatement');
    const udi = datapoint(datapoint(statement, 'device').reference!.view!, 'udiCarrier');

    expect(udi.present).toBe(true);
    expect(udi.text).toBe('1 entry');
  });

  it('exposes the hip implant with its UDI, lot number and expiry', () => {
    const statement = resourceIn('Medical Devices and Implants', 'DeviceUseStatement');
    const device = datapoint(statement, 'device').reference!.view!;

    expect(datapoint(device, 'lotNumber').text).toBe('LOT-HIP-2018');
    expect(datapoint(device, 'serialNumber').text).toBe('HIP-SN-987654');
    expect(datapoint(device, 'expirationDate').text).toBe('2022-02-03T04:05:06+00:00');
    expect(datapoint(device, 'udiCarrier').groups?.[0].datapoints[0].text).toBe(
      'UDI-HIP-0987654321',
    );
  });
});

describe('codings', () => {
  it('keeps all four Condition.clinicalStatus codings, not just the first', () => {
    // The exact loss the old `coding[0]` behaviour caused: three of these
    // four were invisible.
    const condition = resourceIn('Problems', 'Condition');
    const status = datapoint(condition, 'clinicalStatus');

    expect(status.codings).toHaveLength(4);
    expect(status.codings.map((coding) => coding.code)).toEqual([
      'active',
      'resolved',
      'remission',
      'recurrence',
    ]);
  });

  it('carries the system alongside the code, so the pair can be rendered', () => {
    const allergy = resourceIn('Allergies and Intolerances', 'AllergyIntolerance');
    const [coding] = datapoint(allergy, 'code').codings;

    expect(coding.system).toBe('https://termgit.elga.gv.at/CodeSystem/atc-deutsch-wido');
    expect(coding.code).toBe('A01AA');
  });
});

describe('per-resource coverage', () => {
  it('exposes all seven AllergyIntolerance reaction sub-fields', () => {
    // The old table showed one of these — the manifestation.
    const allergy = resourceIn('Allergies and Intolerances', 'AllergyIntolerance');
    const [reaction] = datapoint(allergy, 'reaction').groups!;

    expect(reaction.datapoints.filter((child) => child.present).map((child) => child.path)).toEqual(
      [
        'substance',
        'manifestation',
        'description',
        'onset',
        'severity',
        'exposureRoute',
        'note',
      ],
    );
  });

  it('exposes the Procedure fields the 5-column table dropped', () => {
    const procedure = resourceIn('Procedures', 'Procedure');
    const present = procedure.datapoints
      .filter((candidate) => candidate.present)
      .map((candidate) => candidate.path);

    expect(present).toEqual(
      expect.arrayContaining([
        'focalDevice',
        'usedReference',
        'usedCode',
        'note',
        'complication',
        'statusReason',
        'reasonCode',
      ]),
    );
  });

  it('exposes the Condition fields beyond the obligation floor', () => {
    const condition = resourceIn('Problems', 'Condition');
    const present = condition.datapoints
      .filter((candidate) => candidate.present)
      .map((candidate) => candidate.path);

    expect(present).toEqual(
      expect.arrayContaining(['stage', 'evidence', 'note', 'abatementDateTime', 'bodySite']),
    );
  });

  it('leaves no residual datapoint on any fixture resource', () => {
    // The residual pass is the backstop for keys the model does not name. An
    // empty residual across the whole fixture is what says the model has
    // caught up with the data — and a non-empty one is a to-do, not a bug.
    for (const resource of allResources()) {
      expect(resource.residual.map((r) => r.path), resource.resourceType).toEqual([]);
    }
  });

  it('catches an unmodelled key through the residual pass', () => {
    const odd = epsDocumentView({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Composition',
            section: [
              {
                title: 'Problems',
                code: { coding: [{ code: '11450-4' }] },
                entry: [{ reference: 'Condition/c1' }],
              },
            ],
          },
        },
        { resource: { resourceType: 'Condition', id: 'c1', someNewField: 'kept' } },
      ],
    });

    const condition = odd.sections.find((section) => section.present)!.resources[0];
    expect(condition.residual.map((r) => ({ path: r.path, label: r.label, text: r.text }))).toEqual([
      { path: 'someNewField', label: 'Some new field', text: 'kept' },
    ]);
  });
});

describe('dates and choice elements', () => {
  it('keeps full precision rather than trimming to the day', () => {
    // `dayOf` truncation would have lost the time and the offset here.
    const condition = resourceIn('Problems', 'Condition');
    expect(datapoint(condition, 'onset[x]').text).toBe('2022-02-03T04:05:06+00:00');
    expect(datapoint(condition, 'onset[x]').raw).toBe('2022-02-03T04:05:06+00:00');
  });

  it('resolves a [x] choice to its type-suffixed key', () => {
    // `onset[x]` is stored as `onsetDateTime`. Reading the literal path finds
    // nothing, silently, which is how a mapped onset would vanish.
    const procedure = resourceIn('Procedures', 'Procedure');
    expect(datapoint(procedure, 'performed[x]').text).toBe('2021-06-15T08:30:00+00:00');
  });

  it('renders a period as both of its ends', () => {
    const statement = resourceIn('Medical Devices and Implants', 'DeviceUseStatement');
    expect(datapoint(statement, 'timing[x]').text).toBe(
      '2019-03-10T09:00:00+00:00 → 2023-02-03T04:05:06+00:00',
    );
  });
});

describe('document header', () => {
  it('exposes the Bundle identifier and timestamp, neither previously shown', () => {
    const meta = Object.fromEntries(VIEW.bundleMeta.map((d) => [d.path, d.text]));

    expect(meta.identifier).toBe('a7ee00e0-f3ba-4289-9a66-faf57321f1c2');
    expect(meta.timestamp).toBe('2026-08-18T08:36:30.505+00:00');
    expect(meta.type).toBe('document');
    expect(meta['meta.profile']).toBe(
      'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips',
    );
  });

  it('exposes Composition status, type and author', () => {
    const composition = VIEW.composition!;

    expect(datapoint(composition, 'status').text).toBe('final');
    expect(datapoint(composition, 'type').text).toBe('Patient summary Document');
    expect(datapoint(composition, 'type').codings[0].code).toBe('60591-5');
    expect(datapoint(composition, 'author').text).toBe('openFHIR');
    expect(datapoint(composition, 'title').text).toBe('Patient Summary');
  });

  it('does not repeat the sections as a Composition datapoint', () => {
    // They are the page's own structure; listing them again as a residual
    // blob would duplicate the whole document.
    expect(VIEW.composition!.residual.map((r) => r.path)).toEqual([]);
  });
});

describe('degenerate input', () => {
  it('still returns the full spine for a Bundle with no Composition', () => {
    const empty = epsDocumentView({ resourceType: 'Bundle', entry: [] });

    expect(empty.sections).toHaveLength(17);
    expect(empty.sections.every((section) => !section.present)).toBe(true);
    expect(empty.composition).toBeUndefined();
  });

  it('survives an undefined Bundle', () => {
    const none = epsDocumentView(undefined);

    expect(none.sections).toHaveLength(17);
    expect(none.bundleMeta).toEqual([]);
    expect(none.orphans).toEqual([]);
  });

  it('appends a section the profile does not describe rather than dropping it', () => {
    const extra = epsDocumentView({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Composition',
            section: [{ title: 'Locally invented section', code: { coding: [{ code: '99999-9' }] } }],
          },
        },
      ],
    });

    expect(extra.sections).toHaveLength(18);
    expect(extra.sections[17]).toMatchObject({
      title: 'Locally invented section',
      spec: undefined,
      present: true,
    });
  });

  it('keeps an unresolvable entry as text instead of dropping it', () => {
    const dangling = epsDocumentView({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Composition',
            section: [
              {
                title: 'Allergies and Intolerances',
                entry: [{ reference: 'urn:uuid:gone', display: 'Penicillin' }],
              },
            ],
          },
        },
      ],
    });

    const allergies = dangling.sections.find((section) => section.present)!;
    expect(allergies.resources).toEqual([]);
    expect(allergies.unresolved).toEqual(['Penicillin']);
  });

  it('does not recurse forever on a reference cycle', () => {
    // A Patient whose generalPractitioner points back at a resource that
    // references the Patient. Without a cycle guard this is a stack overflow.
    const cyclic = epsDocumentView({
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Composition',
            section: [
              {
                title: 'Problems',
                code: { coding: [{ code: '11450-4' }] },
                entry: [{ reference: 'Patient/p1' }],
              },
            ],
          },
        },
        {
          resource: {
            resourceType: 'Patient',
            id: 'p1',
            generalPractitioner: [{ reference: 'PractitionerRole/r1' }],
          },
        },
        {
          resource: {
            resourceType: 'PractitionerRole',
            id: 'r1',
            practitioner: { reference: 'Patient/p1' },
          },
        },
      ],
    });

    const patient = cyclic.sections.find((section) => section.present)!.resources[0];
    const role = datapoint(patient, 'generalPractitioner').reference!.view!;

    expect(role.resourceType).toBe('PractitionerRole');
    // The hop back to the Patient stops at a label rather than expanding.
    expect(datapoint(role, 'practitioner').reference?.view).toBeUndefined();
    expect(datapoint(role, 'practitioner').text).toBe('Patient');
  });
});
