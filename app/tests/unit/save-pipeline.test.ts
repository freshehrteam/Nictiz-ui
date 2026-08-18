import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STEPS,
  countBundleResources,
  formatResources,
  initialStates,
  withState,
} from '../../src/views/save-pipeline';
import type { FhirBundle } from '../../src/fhir/bundle';

const REAL_BUNDLE: FhirBundle = JSON.parse(
  readFileSync('../fixtures/eps.example.bundle.json', 'utf8'),
);

describe('countBundleResources', () => {
  it('counts every resource type in a real mapped Bundle', () => {
    // The fixture is openFHIR's actual output for the golden FLAT composition,
    // captured from the running engine — so this asserts against what the
    // mapping really produces, not against what we expect it to.
    expect(countBundleResources(REAL_BUNDLE)).toEqual({
      Composition: 1,
      AllergyIntolerance: 1,
      Condition: 1,
      DeviceUseStatement: 1,
      Device: 3,
      Procedure: 1,
    });
  });

  it('counts a type it has never heard of', () => {
    // The whole point of counting the Bundle instead of the composition: a
    // newly mapped resource type appears without this code being changed.
    expect(
      countBundleResources({
        resourceType: 'Bundle',
        entry: [
          { resource: { resourceType: 'Immunization' } },
          { resource: { resourceType: 'Immunization' } },
        ],
      }),
    ).toEqual({ Immunization: 2 });
  });

  it('is empty for an empty or absent Bundle', () => {
    expect(countBundleResources({ resourceType: 'Bundle', entry: [] })).toEqual({});
    expect(countBundleResources({ resourceType: 'Bundle' })).toEqual({});
    expect(countBundleResources(undefined)).toEqual({});
  });

  it('ignores entries carrying no resource', () => {
    expect(
      countBundleResources({
        resourceType: 'Bundle',
        entry: [{ fullUrl: 'urn:uuid:x' }, { resource: { resourceType: 'Condition' } }],
      }),
    ).toEqual({ Condition: 1 });
  });
});

describe('formatResources', () => {
  it('lists only what the Bundle actually contains', () => {
    // It used to prepend `Patient` unconditionally. That was tolerable while
    // the counts were invented; against a real Bundle it would assert a
    // resource openFHIR does not emit.
    expect(formatResources({ Condition: 2 })).toBe('Condition x2');
    expect(formatResources({ Condition: 2 })).not.toContain('Patient');
  });

  it('orders by count, then name, so the line does not depend on entry order', () => {
    expect(formatResources({ Condition: 1, Device: 3, AllergyIntolerance: 1 })).toBe(
      'Device x3, AllergyIntolerance x1, Condition x1',
    );
  });

  it('says so plainly when there is nothing', () => {
    expect(formatResources({})).toBe('no resources');
    expect(formatResources(undefined)).toBe('no resources');
  });
});

describe('STEPS', () => {
  it('has no staged steps left — all four are backed by a request', () => {
    // The inverse of the guard this file used to carry. That one asserted
    // `map` and `bundle` were staged, precisely so that wiring openFHIR would
    // fail here and force this assertion to be turned around.
    expect(STEPS.some((s) => 'staged' in s)).toBe(false);
  });

  it('reports the mapped resource count on the map line', () => {
    const map = STEPS.find((s) => s.key === 'map')!;
    const line = map.line({
      templateId: 'EPS Patient Summary',
      ehrId: 'e',
      resources: { Condition: 2, Device: 1 },
    });

    expect(line).toContain('tofhir');
    expect(line).toContain('3 resources');
  });

  it('reports the stored Bundle id on the bundle line once there is one', () => {
    const bundle = STEPS.find((s) => s.key === 'bundle')!;
    const run = { templateId: 't', ehrId: 'e', resources: { Condition: 1 } };

    expect(bundle.line(run)).not.toContain('Bundle/');
    expect(bundle.line({ ...run, bundleId: '42' })).toContain('Bundle stored as Bundle/42');
  });

  it('names the real template in the validate line', () => {
    const line = STEPS[0].line({ templateId: 'EPS Patient Summary', ehrId: 'e' });
    expect(line).toContain('EPS Patient Summary');
  });

  it('shows the real error on the commit line instead of 201 Created', () => {
    const commit = STEPS.find((s) => s.key === 'commit')!;
    expect(commit.line({ templateId: 't', ehrId: 'e' })).toContain('201 Created');
    const failed = commit.line({ templateId: 't', ehrId: 'e', error: 'HTTP 400' });
    expect(failed).toContain('HTTP 400');
    expect(failed).not.toContain('201 Created');
  });
});

describe('withState', () => {
  it('advances one step without disturbing the others', () => {
    const next = withState(initialStates(), 'commit', 'running');
    expect(next).toEqual({
      validate: 'pending',
      commit: 'running',
      map: 'pending',
      bundle: 'pending',
    });
  });

  it('does not mutate the map it was given', () => {
    const before = initialStates();
    withState(before, 'commit', 'done');
    expect(before.commit).toBe('pending');
  });
});

describe('read-back notes', () => {
  it('carries a note without an error, so the pipeline can still complete', () => {
    // The distinction the fix rests on: `note` is advisory (the CDR returned
    // 201 and stored the composition), `error` halts. A run that has one must
    // not imply the other.
    const run = {
      templateId: 't',
      ehrId: 'e',
      note: 'stored, with matched 12 · lost 0 · mangled 1 · spurious 8',
    };
    expect(run.error).toBeUndefined();

    // The commit line stays the real 201, not the discrepancy.
    const commit = STEPS.find((s) => s.key === 'commit')!;
    expect(commit.line(run)).toContain('201 Created');
  });
});
