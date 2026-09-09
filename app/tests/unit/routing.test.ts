/**
 * Route parsing and the form registry.
 *
 * These two together are what stop a composition being recorded against the
 * wrong template. The route must carry the template id verbatim — creation used
 * to fall back to "whatever the server listed first", so the template depended
 * on UI state rather than on the URL — and the registry decides which templates
 * have a hand-written form at all.
 */

import { describe, expect, it } from 'vitest';

import { parseRoute } from '../../src/shell';
import { getTemplateForm, isRecordable, recordableTemplateIds } from '../../src/forms/registry';

const EPS = 'EPS Patient Summary';

describe('parseRoute', () => {
  it('falls back to the dashboard for unknown and empty hashes', () => {
    expect(parseRoute('').view).toBe('dashboard');
    expect(parseRoute('#/').view).toBe('dashboard');
    expect(parseRoute('#/nonsense').view).toBe('dashboard');
    expect(parseRoute('#/dashboard').view).toBe('dashboard');
  });

  it('routes the patient list and settings', () => {
    expect(parseRoute('#/patients').view).toBe('patients');
    expect(parseRoute('#/settings').view).toBe('settings');
  });

  it('routes a patient to their compositions', () => {
    expect(parseRoute('#/patients/p-1/compositions')).toMatchObject({
      view: 'compositions',
      patientId: 'p-1',
    });
  });

  it('treats a bare patient id as their compositions', () => {
    expect(parseRoute('#/patients/p-1')).toMatchObject({
      view: 'compositions',
      patientId: 'p-1',
    });
  });

  it('carries the template through to a new composition', () => {
    expect(parseRoute(`#/patients/p-1/compositions/new?template=${encodeURIComponent(EPS)}`)).toEqual({
      view: 'form',
      patientId: 'p-1',
      uid: 'new',
      templateId: EPS,
    });
  });

  it('leaves the template undefined when the URL omits it', () => {
    // The form must be able to tell "no template named" from "this template",
    // rather than silently substituting one.
    expect(parseRoute('#/patients/p-1/compositions/new').templateId).toBeUndefined();
  });

  it('routes a composition summary, carrying the Bundle id', () => {
    expect(
      parseRoute(`#/patients/p-1/compositions/c-9/summary?template=${encodeURIComponent(EPS)}&bundle=42`),
    ).toEqual({
      view: 'summary',
      patientId: 'p-1',
      uid: 'c-9',
      templateId: EPS,
      bundleId: '42',
    });
  });

  it('leaves the Bundle id undefined when the URL omits it', () => {
    // The view must be able to tell "no Bundle named" from "this Bundle" — the
    // first is an error state, not an empty summary.
    expect(parseRoute('#/patients/p-1/compositions/c-9/summary').bundleId).toBeUndefined();
  });

  it('still routes a bare uid to the form, not the summary', () => {
    // `summary` only means the summary in position 4; a composition uid of
    // that name must not be mistaken for it.
    expect(parseRoute('#/patients/p-1/compositions/summary')).toMatchObject({
      view: 'form',
      uid: 'summary',
    });
  });

  it('routes a stored Bundle to the summary view, with no composition in context', () => {
    // `uid` must stay undefined — it is what flips the summary's back button
    // from "back to composition" to "back to compositions".
    expect(parseRoute('#/patients/p-1/bundles/42')).toEqual({
      view: 'summary',
      patientId: 'p-1',
      bundleId: '42',
    });
    expect(parseRoute('#/patients/p-1/bundles/42').uid).toBeUndefined();
  });

  it('treats a bare /bundles with no id as the compositions view', () => {
    expect(parseRoute('#/patients/p-1/bundles')).toMatchObject({
      view: 'compositions',
      patientId: 'p-1',
    });
  });

  it('decodes uids and templates containing reserved characters', () => {
    const uid = 'abc-123::local.ehrbase.org::1';
    const route = parseRoute(
      `#/patients/p-1/compositions/${encodeURIComponent(uid)}?template=${encodeURIComponent(EPS)}`,
    );

    expect(route).toEqual({ view: 'form', patientId: 'p-1', uid, templateId: EPS });
  });
});

describe('template form registry', () => {
  it('reports EPS Patient Summary as recordable, with its sections', () => {
    const form = getTemplateForm(EPS);

    expect(isRecordable(EPS)).toBe(true);
    expect(form?.sections.map((s) => s.key)).toEqual([
      'allergies',
      'problems',
      'devices',
      'procedures',
    ]);
  });

  it('refuses templates that have no hand-written form', () => {
    // Uploading an OPT to the CDR does not make it fillable here — that gap is
    // exactly what the compositions view has to show rather than hide.
    expect(isRecordable('Vital Signs')).toBe(false);
    expect(getTemplateForm('Vital Signs')).toBeUndefined();
  });

  it('lists only registered templates', () => {
    expect(recordableTemplateIds()).toEqual([EPS]);
  });
});
