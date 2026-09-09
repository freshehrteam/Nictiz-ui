/**
 * End-to-end: patient → composition → prepopulate → edit → save → read back.
 *
 * Everything tagged `@stack` needs EHRbase, HAPI FHIR and seeded demo data:
 *
 *   npm run dev:server   # then, once
 *   npm run seed
 *
 * Two of these tests are regression guards the evaluation PoC paid for in
 * debugging time, and they are the reason this suite exists at all:
 *
 *   "import actually binds"  — `import()` diverts unmatched keys to
 *      `deferredData` and `serialize()` merges them back, so an import that
 *      populates ZERO fields still produces a perfect import→export diff. Any
 *      test that checks only the round-trip passes while the form is empty.
 *
 *   "every select renders options" — `mb-text-select` reads slotted
 *      `<mb-option>` children and silently renders an empty dropdown if given
 *      an array instead. Asserting the element is *attached* catches nothing.
 */

import { test, expect, type Page } from '@playwright/test';

const TEMPLATE = 'EPS Patient Summary';

/**
 * Lands on a seeded patient's compositions and returns their id.
 *
 * `which: 'last'` is for tests that WRITE. Reading and writing the same patient
 * makes this suite order-dependent: a save adds a small composition that then
 * becomes the newest, and a later read test that opens "the first one" silently
 * measures a sparse record instead of the seeded golden one.
 */
async function selectPatient(page: Page, which: 'first' | 'last' = 'first'): Promise<string> {
  await page.goto('/#/patients');
  const cards = page.locator('.patient-card');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  await (which === 'first' ? cards.first() : cards.last()).click();
  await expect(page).toHaveURL(/#\/patients\/[^/]+\/compositions/);
  return page.url().match(/#\/patients\/([^/]+)\//)?.[1] ?? '';
}

/** Waits for mb-form to have registered its elements — Lit 1 binds async. */
async function formReady(page: Page): Promise<void> {
  await expect(page.locator('mb-form')).toBeAttached({ timeout: 15_000 });
  await page.waitForFunction(
    () => (Object.keys((document.querySelector('mb-form') as any)?.mbElements ?? {}).length ?? 0) > 20,
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('shell and navigation', () => {
  test('@stack dashboard reports every back end and non-zero counts', async ({ page }) => {
    await page.goto('/#/dashboard');

    await expect(page.locator('.pill', { hasText: 'EHRbase up' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.pill', { hasText: 'openFHIR up' })).toBeVisible();

    // All three, by exact text. `hasText: 'FHIR up'` alone is a substring match
    // that the openFHIR pill also satisfies, so HAPI's row could vanish and the
    // assertion would still pass. toHaveText normalises the template's newline
    // padding, which an anchored /^FHIR up$/ regex would not.
    await expect(page.locator('.pill')).toHaveText(['EHRbase up', 'FHIR up', 'openFHIR up']);

    // Counts render as soon as /api/stats answers.
    const patients = page.locator('.tile', { hasText: 'Patients (FHIR)' }).locator('.value');
    await expect(patients).not.toHaveText('', { timeout: 15_000 });
    expect(Number(await patients.textContent())).toBeGreaterThan(0);
  });

  test('routes are addressable and survive a reload', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.locator('h2', { hasText: 'Settings' })).toBeVisible();

    await page.reload();
    await expect(page.locator('h2', { hasText: 'Settings' })).toBeVisible();
  });
});

test.describe('patients', () => {
  test('@stack lists seeded patients with demographics', async ({ page }) => {
    await page.goto('/#/patients');

    const cards = page.locator('.patient-card');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    expect(await cards.count()).toBeGreaterThan(0);

    // The mockup's patient — age is computed, not stored.
    const anna = page.locator('.patient-card', { hasText: 'Anna de Vries' });
    await expect(anna).toBeVisible();
    await expect(anna).toContainText('female');
    await expect(anna).toContainText('1974-03-12');
  });

  test('@stack search narrows the list server-side', async ({ page }) => {
    await page.goto('/#/patients');
    await expect(page.locator('.patient-card').first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid=patient-search]').fill('Vries');
    await expect(page.locator('.patient-card', { hasText: 'Anna de Vries' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('.patient-card', { hasText: 'Lars Smit' })).toHaveCount(0);
  });

  test('@stack creating a patient auto-generates a linked EHR', async ({ page }) => {
    await page.goto('/#/patients');
    await expect(page.locator('.patient-card').first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid=new-patient]').click();
    await expect(page.locator('[data-testid=new-patient-form]')).toBeVisible();

    // Required fields are enforced before anything is sent.
    await page.locator('[data-testid=np-save]').click();
    await expect(page.locator('[data-testid=np-firstName-error]')).toBeVisible();
    await expect(page.locator('[data-testid=np-lastName-error]')).toBeVisible();
    await expect(page.locator('[data-testid=np-birthDate-error]')).toBeVisible();

    // BSN is optional, but must be 9 digits when given.
    await page.locator('[data-testid=np-bsn]').fill('123');
    await page.locator('[data-testid=np-save]').click();
    await expect(page.locator('[data-testid=np-bsn-error]')).toBeVisible();

    // A name unique to this run, so repeated runs cannot collide.
    const surname = `Testpatient${Date.now()}`;
    await page.locator('[data-testid=np-firstName]').fill('Nieuwe Jan');
    await page.locator('[data-testid=np-lastName]').fill(surname);
    await page.locator('[data-testid=np-birthDate]').fill('1966-05-04');
    await page.selectOption('[data-testid=np-gender]', 'male');
    await page.locator('[data-testid=np-bsn]').fill('999900201');
    await page.locator('[data-testid=np-save]').click();

    // Lands on the new patient's compositions, which means an EHR resolved —
    // the view routes there only when one came back.
    await expect(page).toHaveURL(/#\/patients\/[^/]+\/compositions/, { timeout: 20_000 });
    await expect(page.locator('[data-testid=patient-name]')).toContainText(surname);

    const patientId = page.url().match(/#\/patients\/([^/]+)\//)?.[1] ?? '';

    // The EHR is generated by EHRbase and linked by subject reference. Nothing
    // client-side chose it, and without the link the patient is unreachable.
    const ehrId = await page.evaluate(async (id) => {
      const fhir = await import('/src/fhir/client.ts');
      return fhir.getPatientEhr(id);
    }, patientId);
    expect(ehrId).toMatch(/^[0-9a-f-]{36}$/);

    // Multiple given names became separate FHIR entries, and the BSN was stored
    // under the Dutch naming system rather than HAPI's internal identifier.
    //
    // Search by surname rather than scanning the full list: this suite creates
    // a patient on every run, so the unfiltered list grows without bound and
    // eventually pages the newest one off the end.
    await page.goto('/#/patients');
    await page.locator('[data-testid=patient-search]').fill(surname);

    const card = page.locator('.patient-card', { hasText: surname });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Nieuwe Jan');
    await expect(card).toContainText('999900201');
    await expect(card).toContainText('male');
  });

  test('@stack selecting a patient shows their header and compositions', async ({ page }) => {
    await selectPatient(page);

    await expect(page.locator('[data-testid=patient-name]')).toBeVisible();
    await expect(page.locator('[data-testid=new-composition]')).toBeVisible();
    await expect(page.locator('.template-item', { hasText: TEMPLATE })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('@stack lists every server template, not only those the patient has records for', async ({
    page,
  }) => {
    await selectPatient(page);
    await expect(page.locator(`[data-testid="template-${TEMPLATE}"]`)).toBeVisible({
      timeout: 15_000,
    });

    // The left pane is built from the SERVER's template list; the patient's
    // groups only supply the counts. Anything uploaded must appear even with
    // zero records, or it can never be reached to record the first one.
    const { server, listed } = await page.evaluate(async () => {
      const client = await import('/src/openehr/client.ts');
      return {
        server: await client.listTemplates(),
        listed: [...document.querySelectorAll('eps-compositions .template-item')].map(
          (el) => el.getAttribute('data-testid')?.replace(/^template-/, '') ?? '',
        ),
      };
    });

    expect(server.length).toBeGreaterThan(0);
    for (const templateId of server) expect(listed).toContain(templateId);
  });

  test('@stack the per-template "+ New" names its own template in the URL', async ({ page }) => {
    const patientId = await selectPatient(page);
    await page.locator(`[data-testid="new-${TEMPLATE}"]`).click();

    // The template must travel in the URL rather than being inherited from
    // whichever row happened to be selected.
    await expect(page).toHaveURL(
      new RegExp(
        `#/patients/${patientId}/compositions/new\\?template=${encodeURIComponent(
          TEMPLATE,
        ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      ),
    );
    await expect(page.locator('[data-testid=mb-form]')).toBeAttached({ timeout: 20_000 });
  });
});

test.describe('composition form', () => {
  test('@stack refuses a template with no hand-written form instead of rendering EPS fields', async ({
    page,
  }) => {
    const patientId = await selectPatient(page);

    // The dangerous case: the form used to render EPS Patient Summary's fields
    // for ANY template id in the URL, binding EPS paths against a foreign
    // template. It must refuse rather than offer a form that cannot save.
    await page.goto(
      `/#/patients/${patientId}/compositions/new?template=${encodeURIComponent('No Such Template')}`,
    );

    await expect(page.locator('[data-testid=form-status]')).toContainText('No form has been built', {
      timeout: 20_000,
    });
    await expect(page.locator('mb-form')).toHaveCount(0);
    await expect(page.locator('[data-testid=form-save]')).toHaveCount(0);

    await page.locator('[data-testid=form-back]').click();
    await expect(page).toHaveURL(new RegExp(`#/patients/${patientId}/compositions$`));
  });

  test('@stack prepopulates from a stored composition — and actually BINDS it', async ({ page }) => {
    await selectPatient(page);

    // Open the RICHEST composition this patient has, not simply the newest.
    // Compositions are listed newest first, and earlier runs of this very suite
    // add small ones — so "first" drifts to a sparse record and the assertion
    // below would measure the wrong thing.
    const richest = await page.evaluate(async () => {
      const client = await import('/src/openehr/client.ts');
      const fhir = await import('/src/fhir/client.ts');
      const patientId = window.location.hash.match(/#\/patients\/([^/]+)\//)?.[1] ?? '';
      const ehrId = await fhir.getPatientEhr(patientId);
      const { compositions } = await client.listCompositions(ehrId!);

      const sizes = await Promise.all(
        compositions.map(async (c: { uid: string }) => ({
          uid: c.uid,
          size: Object.keys(await client.getComposition(ehrId!, c.uid)).length,
        })),
      );
      return sizes.sort((a, b) => b.size - a.size)[0];
    });
    expect(richest.size).toBeGreaterThan(100);

    await page.locator(`[data-testid="composition-${richest.uid.split('::')[0]}"]`).click();
    await formReady(page);
    await expect(page.locator('[data-testid=form-status]')).toContainText('Loaded', {
      timeout: 20_000,
    });

    // THE GUARD (D-1): passthrough is excluded, so this counts only values that
    // reached a real field. Without it, an import binding nothing looks perfect.
    const bound = await page.evaluate(() => {
      const form = document.querySelector('mb-form') as any;
      const previous = form.serializeDeferredData;
      form.serializeDeferredData = false;
      const values = form.serialize(form.mbElements) ?? {};
      form.serializeDeferredData = previous;
      return Object.keys(values).length;
    });
    expect(bound).toBeGreaterThan(50);

    // And prove it in the DOM, not only through the library's own accounting.
    //
    // A CODED result lives on `mb-search.data` as {code, value, terminology};
    // `.value` stays EMPTY and holds only plain-text results. Asserting on
    // `.value` therefore reads as "nothing bound" for a field that is visibly
    // populated — so check the data object, and the rendered input the user
    // actually sees, rather than the property whose name suggests it.
    const substance = page.locator('mb-search').first();
    await expect(substance).toBeAttached();

    const coded = await substance.evaluate((el: any) => ({
      data: el.data ?? null,
      shown: el.shadowRoot?.querySelector('sl-input, input')?.value ?? null,
    }));

    expect(coded.data?.code).toBeTruthy();
    expect(coded.data?.terminology).toBeTruthy();
    expect(coded.shown).toBeTruthy();
  });

  test('@stack every select-type control renders at least one option (D-9)', async ({ page }) => {
    await selectPatient(page);
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    // mb-text-select silently renders an EMPTY dropdown when handed an options
    // array instead of slotted children. Attachment alone proves nothing.
    const empty = await page.evaluate(() =>
      [...document.querySelectorAll('mb-select, mb-text-select, mb-buttons')]
        .filter((el) => el.querySelectorAll('mb-option').length === 0)
        .map((el) => (el as any).path ?? el.tagName),
    );
    expect(empty).toEqual([]);
  });

  test('@stack terminology search returns results — handleSearch is wired (D-10)', async ({
    page,
  }) => {
    await selectPatient(page);
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    // Every mb-search must have received a handler; mb-form propagates it only
    // via a one-shot watcher, so late-connecting children get undefined.
    const unwired = await page.evaluate(
      () =>
        [...document.querySelectorAll('mb-search, mb-search-multiple')].filter(
          (el) => typeof (el as any).handleSearch !== 'function',
        ).length,
    );
    expect(unwired).toBe(0);

    const results = await page.evaluate(async () => {
      const el = document.querySelector('mb-search') as any;
      return (await el.handleSearch({ searchString: 'Amox', constraints: ['atc:substance'] })).length;
    });
    expect(results).toBeGreaterThan(0);
  });

  test('@stack save → 201 → read back with 0 lost and 0 mangled', async ({ page }) => {
    // Writes go to the LAST patient so they cannot displace the golden
    // composition the prepopulation test above reads from the first.
    const patientId = await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    // Enter a coded substance through the real control, so the assertion covers
    // terminology binding rather than a hand-built payload.
    await page.locator('mb-search').first().click();
    await page.keyboard.type('Amox');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const el = document.querySelector('mb-search') as any;
      el.shadowRoot?.querySelectorAll('sl-menu-item')[0]?.click();
    });

    const result = await page.evaluate(
      async ({ patientId, template }) => {
        const mb = await import('/src/openehr/medblocks.ts');
        const flat = await import('/src/openehr/flat.ts');
        const client = await import('/src/openehr/client.ts');
        const fhir = await import('/src/fhir/client.ts');

        const form = document.querySelector('mb-form') as any;
        const submitted = mb.exportComposition(form, flat.ROOT);
        const ehrId = await fhir.getPatientEhr(patientId);
        const { uid } = await client.postComposition(ehrId!, template, submitted);
        const readBack = await client.getComposition(ehrId!, uid);
        const diff = flat.diffFlat(submitted, readBack);

        return {
          uid,
          submitted,
          lost: diff.lost,
          mangled: diff.mangled,
          matched: diff.matched.length,
        };
      },
      { patientId, template: TEMPLATE },
    );

    expect(result.lost).toEqual([]);
    expect(result.mangled).toEqual([]);
    expect(result.matched).toBeGreaterThan(0);
    expect(result.uid).toContain('::');

    // The coded value round-tripped as a DV_CODED_TEXT, not a bare string:
    // omitting `text` in the search result is what keeps the code (D/seed).
    const keys = Object.keys(result.submitted);
    expect(keys.some((k) => k.endsWith('substance|code'))).toBe(true);
    expect(keys.some((k) => k.endsWith('substance|terminology'))).toBe(true);

    // Territory must be NL. Medblocks defaults it to IN (India) silently unless
    // set via mb-form.ctx — this never errors, it just files the wrong country.
    expect(result.submitted['eps_patient_summary/territory|code']).toBe('NL');
    // Mandatory attributes EHRbase rejects the composition without.
    expect(result.submitted['eps_patient_summary/composer|name']).toBeTruthy();
    expect(result.submitted['eps_patient_summary/context/start_time']).toBeTruthy();
  });

  test('@stack Devices and Procedures round-trip, and body_site keeps its three shapes', async ({
    page,
  }) => {
    const patientId = await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    const R = 'eps_patient_summary';
    const DEVICE = `${R}/eps_medical_devices/medical_device_summary:0`;
    const PROCEDURE = `${R}/eps_history_of_procedures/procedure:0`;

    async function typeInto(testid: string, text: string): Promise<void> {
      const el = page.locator(`[data-testid="${testid}"]`).first();
      await el.scrollIntoViewIfNeeded();
      await el.click();
      await page.keyboard.type(text);
    }

    // `status` is MANDATORY (min=1, at0002) on a device summary that carries
    // any data, but the form renders NO control for it — exportComposition()
    // stamps the fixed "Current" onto every occupied entry (asserted below),
    // which is what keeps this save off the 422.
    await expect(page.locator(`[data-testid="${DEVICE}/status"]`)).toHaveCount(0);

    await typeInto(`${DEVICE}/device_details:0/body_site`, 'Left hip');
    await typeInto(`${DEVICE}/device_details:0/medical_device/device_name`, 'Ceramic hip implant');
    // procedure_name is likewise mandatory (min=1, at0002).
    await typeInto(`${PROCEDURE}/procedure_name`, 'Appendectomy');
    await typeInto(`${PROCEDURE}/body_site`, 'McBurney point area');

    const result = await page.evaluate(
      async ({ patientId, template }) => {
        const mb = await import('/src/openehr/medblocks.ts');
        const flat = await import('/src/openehr/flat.ts');
        const client = await import('/src/openehr/client.ts');
        const fhir = await import('/src/fhir/client.ts');

        const form = document.querySelector('mb-form') as any;
        const submitted = mb.exportComposition(form, flat.ROOT);
        const ehrId = await fhir.getPatientEhr(patientId);
        const { uid } = await client.postComposition(ehrId!, template, submitted);
        const readBack = await client.getComposition(ehrId!, uid);
        const diff = flat.diffFlat(submitted, readBack);

        return { uid, submitted, lost: diff.lost, mangled: diff.mangled };
      },
      { patientId, template: TEMPLATE },
    );

    expect(result.lost).toEqual([]);
    expect(result.mangled).toEqual([]);

    // THE P7 GUARD. One field name, three FLAT shapes — all derived from the
    // web template's value child, never from the name:
    //
    //   Devices     bare path, no index   (DV_TEXT, max=1)
    //   Procedures  indexed path          (DV_TEXT, max=-1)
    //   Problems    coded, indexed        (DV_CODED_TEXT, max=-1) — see below
    expect(result.submitted[`${DEVICE}/device_details:0/body_site`]).toBe('Left hip');
    expect(result.submitted[`${PROCEDURE}/body_site:0`]).toBe('McBurney point area');

    // Rendering Devices' as repeatable would have produced this key instead.
    expect(result.submitted[`${DEVICE}/device_details:0/body_site:0`]).toBeUndefined();
    // And rendering either text one as coded would have produced these.
    expect(result.submitted[`${PROCEDURE}/body_site:0|code`]).toBeUndefined();
    expect(result.submitted[`${DEVICE}/device_details:0/body_site|code`]).toBeUndefined();

    // The stamped status DOES carry the coded triple — proof both that the
    // absence above is a real distinction (not a form that codes nothing) and
    // that the occupied entry got its fixed "Current" without any control.
    expect(result.submitted[`${DEVICE}/status|code`]).toBe('at0004');
    expect(result.submitted[`${DEVICE}/status|value`]).toBe('Current');
    expect(result.submitted[`${DEVICE}/status|terminology`]).toBe('local');
  });

  test('@stack a composition with no data for a repeatable does not crash (D-8)', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await selectPatient(page);
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    // Importing an empty composition is the exact trigger: getCount() returns 0
    // and mb-repeatable-simple evaluates Array(-1) → RangeError, killing every
    // repeatable on the page.
    await page.evaluate(async () => {
      const mb = await import('/src/openehr/medblocks.ts');
      await mb.importComposition(document.querySelector('mb-form') as any, {});
    });

    expect(errors.filter((e) => e.includes('Invalid array length'))).toEqual([]);
    await expect(page.locator('mb-repeatable-simple').first()).toBeVisible();
  });
});

test.describe('mandatory fields', () => {
  /**
   * The point of the feature: a required field missing means the save is
   * refused HERE, not by an EHRbase 422 that names an RM path after the whole
   * form has been filled in.
   */
  test('@stack refuses to save an entry that is missing a mandatory field', async ({ page }) => {
    await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    // Start an allergy WITHOUT the mandatory substance: pick a criticality.
    // That is what turns the entry from "not started" into "incomplete".
    await page.locator('[data-testid$="/criticality"] sl-button, [data-testid$="/criticality"] button').first().click();
    await page.waitForTimeout(400);

    await page.locator('[data-testid=form-save]').click();

    const status = page.locator('[data-testid=form-status]');
    await expect(status).toContainText('Cannot save yet', { timeout: 10_000 });
    await expect(status).toContainText('Substance');

    // The offending control is marked, and the section says how many.
    await expect(page.locator('[data-testid=missing-allergies]')).toContainText('required field');
    expect(await page.locator('[data-missing]').count()).toBeGreaterThan(0);

    // Nothing was submitted — the pipeline panel is for real POSTs only.
    await expect(page.locator('eps-save-pipeline .pipeline-card')).toHaveCount(0);
  });

  /**
   * The mark has to clear as soon as the field is filled in. Medblocks writes
   * to `.data` and to no property of the host, so without an `mb-input`
   * listener the form would stay red and train the user to ignore it.
   */
  test('@stack the marker clears as soon as the field is filled in', async ({ page }) => {
    await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    await page.locator('[data-testid$="/criticality"] sl-button, [data-testid$="/criticality"] button').first().click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid=form-save]').click();
    await expect(page.locator('[data-testid=form-status]')).toContainText('Cannot save yet', {
      timeout: 10_000,
    });

    // Fill the substance through the real terminology control.
    await page.locator('mb-search').first().click();
    await page.keyboard.type('Amox');
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const el = document.querySelector('mb-search') as any;
      el.shadowRoot?.querySelectorAll('sl-menu-item')[0]?.click();
    });

    // No second save press — the marks must update on their own.
    await expect(page.locator('[data-testid=missing-allergies]')).toHaveCount(0, { timeout: 10_000 });
  });

  /**
   * The most important non-regression. `min=1` inside a repeatable is
   * CONDITIONAL: an EPS composition with no allergies at all is valid, so an
   * untouched form must still save.
   */
  test('@stack an untouched form still saves — empty is legitimate', async ({ page }) => {
    await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    await page.locator('[data-testid=form-save]').click();

    await expect(page.locator('[data-testid=form-status]')).toContainText('Saved', {
      timeout: 30_000,
    });
  });

  /**
   * The required set follows the MOUNTED branch: switching a section to "No
   * information" unmounts substance and makes the absence statement mandatory
   * instead.
   */
  test('@stack switching to "No information" changes which field is required', async ({ page }) => {
    await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    page.on('dialog', (d) => d.accept());
    await page.locator('[data-testid="allergies/mode-no-information"]').click();
    await page.waitForTimeout(600);

    await page.locator('[data-testid=form-save]').click();

    const status = page.locator('[data-testid=form-status]');
    await expect(status).toContainText('Cannot save yet', { timeout: 10_000 });
    await expect(status).toContainText('Absence statement');
  });
});

test.describe('settings', () => {
  test('@stack shows both servers and the template list', async ({ page }) => {
    await page.goto('/#/settings');

    await expect(page.locator('.pill.up').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.template-row', { hasText: TEMPLATE })).toBeVisible();
    await expect(page.locator('[data-testid=opt-upload]')).toBeAttached();
  });
});

test.describe('save pipeline and the Patient Summary', () => {
  /**
   * The whole point of wiring openFHIR: all four steps are backed by a real
   * request now, and the last one hands off to a viewer that renders what the
   * mapping produced.
   *
   * The clinical assertion at the end is what makes this test worth having. A
   * pipeline that reaches `done` proves the calls returned; only seeing the
   * substance that was TYPED INTO THE FORM come back out of the Bundle proves
   * the composition, the mapping and the viewer are all talking about the same
   * patient data.
   */
  test('@stack saves, maps, stores and renders the Patient Summary', async ({ page }) => {
    const substance = `Peanut butter (e2e ${Date.now()})`;

    await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    // mb-* controls hold their value on `.data`, never on `.value` — setting
    // `.value` here silently no-ops and the save is refused for a missing
    // mandatory field instead.
    await page.evaluate((value) => {
      const control = document.querySelector(
        '[data-testid$="/adverse_reaction_risk:0/substance"]',
      ) as (HTMLElement & { data?: unknown }) | null;
      if (control) control.data = { value, code: '762952008', terminology: 'SNOMED-CT' };
    }, substance);

    await page.locator('[data-testid=form-save]').click();

    // Every step reaches done — including `map` and `bundle`, which used to be
    // a sleep loop and would have "passed" this with the stack switched off.
    for (const step of ['validate', 'commit', 'map', 'bundle']) {
      await expect(page.locator(`[data-testid=step-${step}]`)).toHaveAttribute(
        'data-state',
        'done',
        { timeout: 60_000 },
      );
    }

    // The counts on those steps come from the Bundle, so they name real types.
    await expect(page.locator('[data-testid=step-bundle]')).toContainText('Bundle stored as Bundle/');
    await expect(page.locator('[data-testid=step-map]')).toContainText('tofhir');

    // The call to action navigates rather than just closing the modal, which
    // is exactly what it used to do.
    await page.locator('[data-testid=pipeline-cta]').click();
    await expect(page).toHaveURL(/\/summary\?.*bundle=\d+/, { timeout: 15_000 });

    const summary = page.locator('eps-patient-summary');
    await expect(summary.locator('[data-testid=summary-banner]')).toBeVisible({ timeout: 15_000 });
    await expect(summary).toContainText('Allergies and Intolerances');

    // The substance entered at the top of this test, having travelled through
    // EHRbase, openFHIR and the FHIR server. The resource CARD replaced the
    // old per-type table: the viewer now lists every datapoint down the page
    // rather than a handful of columns across it.
    await expect(
      summary.locator('[data-testid=eps-resource-AllergyIntolerance]').first(),
    ).toContainText(substance);

    // All 17 profile sections are on the page, including the ones this
    // document does not carry — that is what the spec-driven spine buys.
    await expect(summary.locator('[data-testid^=eps-section-]')).toHaveCount(17);

    // A section the mapping never emitted is present but COLLAPSED, so its
    // body is asserted after opening it rather than through the closed
    // `<details>`, whose contents Playwright correctly treats as hidden.
    const vitals = summary.locator('[data-testid=eps-section-sectionVitalSigns]');
    await expect(vitals).toBeAttached();
    await vitals.locator('summary').click();
    await expect(vitals).toContainText('Not present in this document');

    // The code, not just the display text — a mapped section is open already.
    await expect(summary.locator('[data-testid=eps-section-sectionAllergies]')).toContainText(
      'http://loinc.org|48765-2',
    );
  });

  /**
   * Deep-linking and reload work because only the Bundle ID is in the URL and
   * the Bundle itself is re-read. This is the test that would fail if the
   * Bundle were ever kept in memory instead of persisted.
   */
  test('@stack re-reads the Bundle on a hard reload', async ({ page }) => {
    const substance = `Reload probe (e2e ${Date.now()})`;

    await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);

    await page.evaluate((value) => {
      const control = document.querySelector(
        '[data-testid$="/adverse_reaction_risk:0/substance"]',
      ) as (HTMLElement & { data?: unknown }) | null;
      if (control) control.data = { value, code: '762952008', terminology: 'SNOMED-CT' };
    }, substance);

    await page.locator('[data-testid=form-save]').click();
    await expect(page.locator('[data-testid=step-bundle]')).toHaveAttribute('data-state', 'done', {
      timeout: 60_000,
    });
    await page.locator('[data-testid=pipeline-cta]').click();
    await expect(page).toHaveURL(/\/summary\?.*bundle=\d+/, { timeout: 15_000 });

    const url = page.url();
    await page.goto(url);

    await expect(
      page.locator('eps-patient-summary [data-testid=eps-resource-AllergyIntolerance]').first(),
    ).toContainText(substance, { timeout: 20_000 });
  });

  /**
   * A Bundle id that does not resolve is an error state with a way out — not a
   * blank page, and not a crash.
   */
  test('@stack reports a Bundle that cannot be read', async ({ page }) => {
    const patientId = await selectPatient(page);
    await page.goto(
      `/#/patients/${patientId}/compositions/does-not-matter/summary?bundle=999999999`,
    );

    const error = page.locator('[data-testid=summary-error]');
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toContainText('Could not load the Patient Summary');
    await expect(error.locator('button')).toBeVisible();
  });
});

test.describe('updating an existing composition', () => {
  /**
   * Re-saving a loaded composition must create a NEW VERSION, not a duplicate.
   *
   * The regression this guards is specific and was reachable from the normal
   * flow: the FLAT read-back carries the composition's own `_uid`, so sending
   * it back through `POST /composition` is a create with an id the CDR already
   * holds — `412 Provided Id … already exists`. Only an update path with
   * `If-Match` gets a second save through.
   */
  test('@stack saves an edited composition as a new version instead of 412', async ({ page }) => {
    const first = `Version one (e2e ${Date.now()})`;

    // Create one to edit.
    const patientId = await selectPatient(page, 'last');
    await page.locator('[data-testid=new-composition]').click();
    await formReady(page);
    await page.evaluate((value) => {
      const el = document.querySelector(
        '[data-testid$="/adverse_reaction_risk:0/substance"]',
      ) as (HTMLElement & { data?: unknown }) | null;
      if (el) el.data = { value, code: '762952008', terminology: 'SNOMED-CT' };
    }, first);
    await page.locator('[data-testid=form-save]').click();
    await expect(page.locator('[data-testid=step-bundle]')).toHaveAttribute('data-state', 'done', {
      timeout: 60_000,
    });

    // The first save is a create.
    await expect(page.locator('[data-testid=step-commit]')).toContainText('201 Created');
    await page.locator('[data-testid=pipeline-cta]').click();
    await expect(page).toHaveURL(/\/summary\?/, { timeout: 15_000 });

    // Reopen that record and edit it.
    const uid = decodeURIComponent(page.url()).match(/compositions\/([^/?]+)/)![1];
    // A full reload rather than a hash change: coming from the summary view,
    // the form is re-entered with a different uid and must fetch from scratch.
    await page.goto('/#/patients');
    await page.goto(
      `/#/patients/${patientId}/compositions/${encodeURIComponent(uid)}` +
        `?template=${encodeURIComponent(TEMPLATE)}`,
    );
    await formReady(page);
    // `formReady` only waits for the form to BIND; the composition fetch that
    // populates it is a separate round trip, so the status is the thing to
    // wait on before editing.
    await expect(page.locator('[data-testid=form-status]')).toContainText('Loaded', {
      timeout: 60_000,
    });

    const second = `Version two (e2e ${Date.now()})`;
    await page.evaluate((value) => {
      const el = document.querySelector(
        '[data-testid$="/adverse_reaction_risk:0/substance"]',
      ) as (HTMLElement & { data?: unknown }) | null;
      if (el) el.data = { value, code: '762952008', terminology: 'SNOMED-CT' };
    }, second);

    await page.locator('[data-testid=form-save]').click();

    // The second save is an UPDATE — this is the assertion that used to 412.
    await expect(page.locator('[data-testid=step-commit]')).toHaveAttribute('data-state', 'done', {
      timeout: 60_000,
    });
    await expect(page.locator('[data-testid=step-commit]')).toContainText('200 OK (new version)');
    await expect(page.locator('[data-testid=form-status]')).toContainText('Saved');

    // `_uid` is excluded from the diff, so a version bump is not reported as a
    // mangled value — the save must read as clean, not as a warning.
    await expect(page.locator('[data-testid=form-status]')).not.toContainText('differs');

    // The uid keeps its object id and gains a version.
    const objectId = uid.split('::')[0];
    await page.locator('[data-testid=pipeline-cta]').click();
    await expect(page).toHaveURL(new RegExp(`${objectId}%3A%3A[^/]*%3A%3A\\d+`), { timeout: 15_000 });
  });
});

/**
 * Deleting a patient, and the guard in front of it.
 *
 * The @stack test is SELF-CLEANING: it creates its own patient and deletes only
 * that one. Deleting a seeded patient would be a slow-motion disaster for this
 * suite — most tests here open "the first patient", so removing one silently
 * changes what every other test is measuring.
 */
test.describe('deleting a patient', () => {
  test('the confirm dialog is dismissible and never opens focused on the destructive action', async ({
    page,
  }) => {
    await page.goto('/#/patients');
    const cards = page.locator('.patient-card');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });

    // The first card's delete button, whoever that patient happens to be. This
    // test never confirms, so it cannot delete anything.
    await page.locator('[data-testid^=delete-patient-]').first().click();
    await expect(page.locator('[data-testid=confirm-dialog]')).toBeVisible();

    // Focus lands on Cancel, so a stray Enter cannot complete the delete.
    await expect(page.locator('[data-testid=confirm-cancel]')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid=confirm-dialog]')).toHaveCount(0);

    // A click on the backdrop dismisses; a click on the card must not.
    await page.locator('[data-testid^=delete-patient-]').first().click();
    await expect(page.locator('[data-testid=confirm-dialog]')).toBeVisible();
    await page.locator('[data-testid=confirm-dialog]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid=confirm-dialog]')).toBeVisible();

    await page.locator('[data-testid=confirm-backdrop]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid=confirm-dialog]')).toHaveCount(0);
  });

  test('@stack deletes the patient it created, with its compositions and bundles', async ({
    page,
  }) => {
    // --- create a patient of this test's own ---
    const surname = `Deleteme${Date.now()}`;
    await page.goto('/#/patients');
    await expect(page.locator('.patient-card').first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid=new-patient]').click();
    await page.locator('[data-testid=np-firstName]').fill('Wegwerp');
    await page.locator('[data-testid=np-lastName]').fill(surname);
    await page.locator('[data-testid=np-birthDate]').fill('1970-01-01');
    await page.locator('[data-testid=np-save]').click();

    await expect(page).toHaveURL(/#\/patients\/[^/]+\/compositions/, { timeout: 20_000 });
    const patientId = page.url().match(/#\/patients\/([^/]+)\//)?.[1] ?? '';
    expect(patientId).toBeTruthy();

    // --- give them a composition and a linked Bundle ---
    //
    // Through the client modules rather than the form UI: this test is about
    // the delete cascade, and driving the whole save pipeline here would make a
    // failure in the form look like a failure in the delete.
    const seeded = await page.evaluate(
      async ([id, templateId]) => {
        const fhir = await import('/src/fhir/client.ts');
        const openehr = await import('/src/openehr/client.ts');
        const bundleMod = await import('/src/fhir/bundle.ts');

        const ehrId = await fhir.getPatientEhr(id);
        const flat = await openehr.getGoldenFixture();
        const { uid } = await openehr.postComposition(ehrId!, templateId, flat);

        const canonical = await openehr.getCompositionCanonical(ehrId!, uid);
        const bundle = await bundleMod.toFhir(templateId, canonical);
        // The patient id is what makes the Bundle findable by the delete.
        await bundleMod.storeBundle(bundle, id);

        return { ehrId };
      },
      [patientId, TEMPLATE],
    );
    expect(seeded.ehrId).toBeTruthy();

    // The preview must SEE them, or the delete has nothing to prove.
    const preview = await page.evaluate(async (id) => {
      const fhir = await import('/src/fhir/client.ts');
      return fhir.getDeletionPreview(id);
    }, patientId);
    expect(preview.compositions).toBeGreaterThan(0);
    expect(preview.bundles).toBeGreaterThan(0);

    // --- cancel must not delete ---
    await page.goto('/#/patients');
    await page.locator('[data-testid=patient-search]').fill(surname);
    const card = page.locator('.patient-card', { hasText: surname });
    await expect(card).toBeVisible({ timeout: 15_000 });

    await page.locator(`[data-testid=delete-patient-${patientId}]`).click();
    const dialog = page.locator('[data-testid=confirm-dialog]');
    await expect(dialog).toBeVisible();
    // The dialog names the patient, so it is impossible to confirm blind.
    await expect(dialog).toContainText(surname);
    await expect(dialog).toContainText('cannot be undone');

    await page.locator('[data-testid=confirm-cancel]').click();
    await expect(dialog).toHaveCount(0);
    // The card survives — this is the assertion that catches a delete firing
    // on open, which a test that only ever confirms would never notice.
    await expect(card).toBeVisible();

    // --- confirm deletes ---
    await page.locator(`[data-testid=delete-patient-${patientId}]`).click();
    await expect(dialog).toBeVisible();
    await page.locator('[data-testid=confirm-accept]').click();

    await expect(page.locator('.message.success')).toContainText(surname, { timeout: 30_000 });
    await expect(page.locator('.message.success')).toContainText('removed');
    await expect(card).toHaveCount(0);

    // --- and it is gone from both back ends ---
    const after = await page.evaluate(async ([id, ehrId]) => {
      const readStatus = await fetch(`/api/patients/${id}`).then((r) => r.status);
      const bundles = await fetch(
        `/api/patients/${id}/deletion-preview`,
      ).then((r) => r.json());
      const compositions = await fetch(`/api/ehr/${ehrId}/compositions`)
        .then((r) => r.json())
        .then((d) => d.compositions.length);
      return { readStatus, bundles: bundles.bundles, compositions };
    }, [patientId, seeded.ehrId!]);

    // HAPI answers 410 Gone for a deleted resource, not 404.
    expect([404, 410]).toContain(after.readStatus);
    expect(after.bundles).toBe(0);
    expect(after.compositions).toBe(0);
  });

  /**
   * The header's delete goes through a DIFFERENT owner than the list's.
   *
   * The header emits an event and the shell owns the dialog, so this path can
   * break while the patient-list one still passes. What it has to get right and
   * the list does not: leaving the patient-scoped views. Every view below the
   * header is keyed on a patient id that no longer resolves.
   */
  test('@stack the header delete also leaves the patient-scoped views', async ({ page }) => {
    const surname = `Hdrdel${Date.now()}`;
    await page.goto('/#/patients');
    await expect(page.locator('.patient-card').first()).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid=new-patient]').click();
    await page.locator('[data-testid=np-firstName]').fill('Kop');
    await page.locator('[data-testid=np-lastName]').fill(surname);
    await page.locator('[data-testid=np-birthDate]').fill('1980-01-01');
    await page.locator('[data-testid=np-save]').click();
    await expect(page).toHaveURL(/#\/patients\/[^/]+\/compositions/, { timeout: 20_000 });

    const patientId = page.url().match(/#\/patients\/([^/]+)\//)?.[1] ?? '';

    await page.locator('[data-testid=header-delete-patient]').click();
    await expect(page.locator('[data-testid=confirm-dialog]')).toContainText(surname);
    await page.locator('[data-testid=confirm-accept]').click();

    await expect(page).toHaveURL(/#\/patients$/, { timeout: 20_000 });
    await expect(page.locator('[data-testid=header-delete-patient]')).toHaveCount(0);

    const status = await page.evaluate(
      (id) => fetch(`/api/patients/${id}`).then((r) => r.status),
      patientId,
    );
    expect([404, 410]).toContain(status);
  });
});
