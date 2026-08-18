/**
 * The defect workarounds, tested against a stand-in for `mb-form`.
 *
 * A fake rather than the real component: the behaviours being guarded are
 * *our* compensations, and the real Lit 1 element cannot be driven headlessly
 * without also importing the Shoelace beta that `tests/setup.ts` exists to
 * patch. The fake reproduces exactly the contract each workaround depends on.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ensureSearchHandlers,
  importComposition,
  exportComposition,
  boundValues,
  type MbForm,
} from '../../src/openehr/medblocks';
import { ROOT } from '../../src/openehr/flat';

/**
 * Stands in for `mb-form`, reproducing the two behaviours that matter:
 *   - keys matching a known element path bind; everything else goes to
 *     `deferredData` (D-1)
 *   - `serialize()` merges deferredData back in unless the flag is off
 */
function fakeForm(elementPaths: string[], repeatablePaths: string[] = []): MbForm {
  const bound: Record<string, unknown> = {};
  const form = {
    mbElements: Object.fromEntries(elementPaths.map((p) => [p, {}])),
    repeatables: Object.fromEntries(repeatablePaths.map((p) => [p, {}])),
    deferredData: {} as Record<string, unknown>,
    serializeDeferredData: true,

    import(data: Record<string, unknown>) {
      for (const [key, value] of Object.entries(data)) {
        if (elementPaths.includes(key)) bound[key] = value;
        else form.deferredData[key] = value;
      }
    },

    serialize() {
      // Empty values are dropped, exactly as Medblocks' hasValue() filter does —
      // this is why seeding an empty `:0` marker costs nothing at the CDR.
      const nonEmpty = Object.fromEntries(
        Object.entries(bound).filter(([, v]) => v !== '' && v != null),
      );
      return form.serializeDeferredData ? { ...nonEmpty, ...form.deferredData } : nonEmpty;
    },

    export(includeDeferred = true) {
      const previous = form.serializeDeferredData;
      form.serializeDeferredData = includeDeferred;
      const out = form.serialize();
      form.serializeDeferredData = previous;
      return out;
    },
  };

  return form as unknown as MbForm;
}

describe('ensureSearchHandlers (D-10)', () => {
  it('assigns a handler to every search element that lacks one', () => {
    const root = document.createElement('div');
    root.innerHTML = '<mb-search></mb-search><mb-search-multiple></mb-search-multiple>';
    const handleSearch = vi.fn(async () => []);

    ensureSearchHandlers(root, handleSearch);

    for (const el of root.querySelectorAll('mb-search, mb-search-multiple')) {
      expect((el as any).handleSearch).toBe(handleSearch);
    }
  });

  it('does not overwrite a handler an element already has', () => {
    const root = document.createElement('div');
    root.innerHTML = '<mb-search></mb-search>';
    const existing = vi.fn(async () => []);
    (root.querySelector('mb-search') as any).handleSearch = existing;

    ensureSearchHandlers(root, vi.fn(async () => []));

    expect((root.querySelector('mb-search') as any).handleSearch).toBe(existing);
  });

  it('reaches elements that connect late — repeatable copies, i.e. the actual bug', () => {
    const root = document.createElement('div');
    root.innerHTML = '<mb-search></mb-search>';
    const handleSearch = vi.fn(async () => []);
    ensureSearchHandlers(root, handleSearch);

    // The user clicks "add" on a repeatable and a second search appears.
    root.insertAdjacentHTML('beforeend', '<mb-search id="late"></mb-search>');
    expect((root.querySelector('#late') as any).handleSearch).toBeUndefined();

    ensureSearchHandlers(root, handleSearch);
    expect((root.querySelector('#late') as any).handleSearch).toBe(handleSearch);
  });

  it('ignores non-search elements', () => {
    const root = document.createElement('div');
    root.innerHTML = '<mb-input></mb-input>';
    ensureSearchHandlers(root, vi.fn(async () => []));
    expect((root.querySelector('mb-input') as any).handleSearch).toBeUndefined();
  });
});

describe('importComposition (D-1, D-8)', () => {
  const SUBSTANCE = `${ROOT}/eps_allergies/adverse_reaction_risk:0/substance|code`;

  it('reports what BOUND, not what was handed over', async () => {
    const form = fakeForm([SUBSTANCE]);

    const report = await importComposition(form, {
      [SUBSTANCE]: 'A01AA',
      [`${ROOT}/eps_allergies/container/fhir_narrative/narrative`]: '<html/>',
    });

    expect(report.read).toBe(2);
    expect(report.bound).toBe(1);
    expect(report.deferred).toBe(1);
  });

  it('does not report a perfect import when NOTHING bound — the D-1 trap', async () => {
    // Every key mismatches. A naive import→export diff would look flawless.
    const form = fakeForm([SUBSTANCE]);
    const report = await importComposition(form, { 'wrong/path': 'x', 'also/wrong': 'y' });

    expect(report.bound).toBe(0);
    expect(report.deferred).toBe(2);
    // And the misleading evidence: the round-trip still matches perfectly.
    expect(form.export(true)).toEqual({ 'wrong/path': 'x', 'also/wrong': 'y' });
  });

  it('restores serializeDeferredData afterwards', async () => {
    const form = fakeForm([SUBSTANCE]);
    form.serializeDeferredData = true;
    await importComposition(form, { [SUBSTANCE]: 'A01AA' });
    expect(form.serializeDeferredData).toBe(true);
  });

  it('seeds empty :0 markers for repeatables absent from the data (D-8)', async () => {
    const repeatable = `${ROOT}/eps_allergies/adverse_reaction_risk`;
    const form = fakeForm([SUBSTANCE], [repeatable]);

    await importComposition(form, {});

    // The marker was passed to import(); without it getCount() returns 0 and
    // mb-repeatable-simple evaluates Array(-1) → RangeError.
    expect(form.deferredData).toHaveProperty(`${repeatable}:0`, '');
  });

  it('takes the repeatable list from the form registry, including nested ones', async () => {
    const nested = `${ROOT}/eps_allergies/adverse_reaction_risk:0/adverse_reaction_event`;
    const form = fakeForm([SUBSTANCE], [`${ROOT}/eps_allergies/adverse_reaction_risk`, nested]);

    await importComposition(form, {});

    expect(form.deferredData).toHaveProperty(`${nested}:0`, '');
  });

  it('leaves an empty seeded marker out of what serialize() would submit', async () => {
    const repeatable = `${ROOT}/eps_problems/problem_diagnosis`;
    const form = fakeForm([repeatable + ':0'], [repeatable]);
    await importComposition(form, {});
    expect(boundValues(form)).toEqual({});
  });
});

describe('exportComposition (D-2, D-3)', () => {
  it('normalises the unprefixed strays mb-context emits', () => {
    const form = fakeForm(['category|code']);
    form.import({ 'category|code': '433' });

    const out = exportComposition(form);
    expect(out[`${ROOT}/category|code`]).toBe('433');
    expect(out['category|code']).toBeUndefined();
  });

  it('excludes deferred passthrough from what is submitted', () => {
    const path = `${ROOT}/eps_allergies/adverse_reaction_risk:0/comment`;
    const form = fakeForm([path]);
    form.import({ [path]: 'mine', 'stray/key': 'not mine' });

    const out = exportComposition(form);
    expect(out[path]).toBe('mine');
    expect(out['stray/key']).toBeUndefined();
  });

  /**
   * EHRbase rejects a composition missing any of these with HTTP 400, and
   * Medblocks does not emit a default the user never touched — so an untouched
   * form would fail to save without this. Verified against the live CDR.
   */
  it('guarantees the mandatory COMPOSITION attributes', () => {
    const path = `${ROOT}/eps_allergies/adverse_reaction_risk:0/comment`;
    const form = fakeForm([path]);
    form.import({ [path]: 'mine' });

    const out = exportComposition(form);
    expect(out[`${ROOT}/composer|name`]).toBeTruthy();
    expect(out[`${ROOT}/context/start_time`]).toBeTruthy();
    expect(out[`${ROOT}/language|code`]).toBe('en');
    expect(out[`${ROOT}/language|terminology`]).toBe('ISO_639-1');
    // NL, not the hardcoded 'IN' Medblocks falls back to (D-4).
    expect(out[`${ROOT}/territory|code`]).toBe('NL');
    expect(out[`${ROOT}/territory|terminology`]).toBe('ISO_3166-1');
  });

  it('never overrides context the user actually entered', () => {
    const composer = `${ROOT}/composer|name`;
    const form = fakeForm([composer]);
    form.import({ [composer]: 'Dr Jansen' });

    expect(exportComposition(form)[composer]).toBe('Dr Jansen');
  });
});

describe('boundValues', () => {
  it('ignores passthrough and restores the flag', () => {
    const path = `${ROOT}/eps_problems/problem_diagnosis:0/comment`;
    const form = fakeForm([path]);
    form.import({ [path]: 'bound', 'stray/key': 'deferred' });

    expect(boundValues(form)).toEqual({ [path]: 'bound' });
    expect(form.serializeDeferredData).toBe(true);
  });
});
