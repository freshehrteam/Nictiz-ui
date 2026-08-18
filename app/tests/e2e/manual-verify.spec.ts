/**
 * The mutual-exclusion guarantee, end to end.
 *
 * These cover the four manual checks the feature was specified against, kept as
 * tests because each one guards a failure that is SILENT in the UI:
 *
 *   1. A section opens on its entries branch, with no absence block on screen.
 *   2. Switching branches UNMOUNTS the others — verified against mb-form's own
 *      element registry, not just the DOM, since registry membership is what
 *      decides whether a field reaches the CDR.
 *   3. Switching away from a branch holding data asks first, and declining
 *      preserves what was typed.
 *   4. A stored "None known" composition reopens on the None-known branch with
 *      its value bound, and re-saving does not drop it. Without the mode
 *      inference in `prepopulate()`, this last one loses stored data with no
 *      error anywhere.
 *
 * Note `.data`, never `.value`: mb-input and mb-search both keep their value on
 * `.data`, and `.value` reads as empty for a visibly populated field.
 */
import { test, expect, type Page } from '@playwright/test';

const ROOT = 'eps_patient_summary';

async function selectPatient(page: Page): Promise<string> {
  await page.goto('/#/patients');
  const cards = page.locator('.patient-card');
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  await cards.first().click();
  await expect(page).toHaveURL(/#\/patients\/[^/]+\/compositions/);
  return page.url().match(/#\/patients\/([^/]+)\//)?.[1] ?? '';
}

async function formReady(page: Page): Promise<void> {
  await expect(page.locator('mb-form')).toBeAttached({ timeout: 15_000 });
  await page.waitForFunction(
    () => (Object.keys((document.querySelector('mb-form') as any)?.mbElements ?? {}).length ?? 0) > 20,
    undefined, { timeout: 15_000 },
  );
}

test('MANUAL 1-2: allergies defaults to entries; switching unmounts the other branches', async ({ page }) => {
  await selectPatient(page);
  await page.locator('[data-testid=new-composition]').click();
  await formReady(page);

  // Defaults to the entries branch, and the absence block is NOT on screen.
  await expect(page.locator('[data-testid="allergies/mode-entries"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-testid="allergies/absence-statement"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="allergies/global-exclusion"]')).toHaveCount(0);
  await expect(page.locator(`[data-testid="${ROOT}/eps_allergies/adverse_reaction_risk:0/substance"]`)).toBeAttached();

  // Switch to "None known": entry fields go, one constrained picker appears.
  await page.locator('[data-testid="allergies/mode-excluded"]').click();
  const excl = page.locator('[data-testid="allergies/global-exclusion"]');
  await expect(excl).toBeAttached();
  await expect(page.locator(`[data-testid="${ROOT}/eps_allergies/adverse_reaction_risk:0/substance"]`)).toHaveCount(0);

  // It is a real constrained pick-list, not free text.
  const opts = await excl.locator('mb-option').evaluateAll((els) => els.map((e) => e.getAttribute('value')));
  expect(opts).toContain('No known allergies');
  expect(opts).toContain('No known food allergies');

  // And the unmounted entry fields have LEFT the element registry (the whole point).
  const stillRegistered = await page.evaluate((root) => {
    const form = document.querySelector('mb-form') as any;
    return Object.keys(form.mbElements ?? {}).filter((k) => k.includes(`${root}/eps_allergies/adverse_reaction_risk`));
  }, ROOT);
  expect(stillRegistered).toEqual([]);

  // Devices offers no "None known" — it has no exclusion node in the template.
  await expect(page.locator('[data-testid="devices/mode-excluded"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="devices/mode-no-information"]')).toBeAttached();
});

test('MANUAL 3: switching away from a branch with data warns, and declining preserves it', async ({ page }) => {
  await selectPatient(page);
  await page.locator('[data-testid=new-composition]').click();
  await formReady(page);

  // Type into an entry field through the real UI. Setting `.value` directly
  // would NOT register: mb-input keeps its value on `.data`.
  const comment = page.locator(`[data-testid="${ROOT}/eps_allergies/adverse_reaction_risk:0/comment"]`);
  await comment.locator('sl-input').click();
  await page.keyboard.type('peanut trace');
  await expect
    .poll(() =>
      page.evaluate(
        (root) =>
          (document.querySelector('mb-form') as any).data?.[
            `${root}/eps_allergies/adverse_reaction_risk:0/comment`
          ],
        ROOT,
      ),
    )
    .toBe('peanut trace');

  // Decline the confirm: mode must not change and the value must survive.
  page.once('dialog', (d) => d.dismiss());
  await page.locator('[data-testid="allergies/mode-excluded"]').click();
  await expect(page.locator('[data-testid="allergies/mode-entries"]')).toHaveAttribute('aria-checked', 'true');
  const kept = await page.evaluate((root) => {
    const form = document.querySelector('mb-form') as any;
    return form.mbElements[`${root}/eps_allergies/adverse_reaction_risk:0/comment`]?.data;
  }, ROOT);
  expect(kept).toBe('peanut trace');

  // Accepting does switch.
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-testid="allergies/mode-excluded"]').click();
  await expect(page.locator('[data-testid="allergies/mode-excluded"]')).toHaveAttribute('aria-checked', 'true');
});

test('MANUAL 3b + 4: saving "None known" carries the exclusion and NO entry keys, and round-trips', async ({ page }) => {
  await selectPatient(page);
  await page.locator('[data-testid=new-composition]').click();
  await formReady(page);

  await page.locator('[data-testid="allergies/mode-excluded"]').click();
  await expect(page.locator('[data-testid="allergies/global-exclusion"]')).toBeAttached();

  // Pick the constrained value, and give the other sections enough to be valid.
  // `.data` is the property every mb-* control stores its value on; setting it
  // and firing input is what the components themselves do.
  await page.evaluate((root) => {
    const form = document.querySelector('mb-form') as any;
    const set = (path: string, value: any) => {
      const el = form.mbElements[path];
      if (!el) throw new Error(`no element at ${path}`);
      el.data = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new CustomEvent('mb-input', { bubbles: true, detail: el }));
    };
    set(`${root}/eps_allergies/exclusion_-_global/global_exclusion_of_adverse_reactions`, 'No known allergies');
    set(`${root}/eps_history_of_procedures/procedure:0/procedure_name`, 'Appendectomy');
    set(`${root}/eps_medical_devices/medical_device_summary:0/status`, { code: 'at0004', value: 'Current', terminology: 'local' });
  }, ROOT);

  const submitted = await page.evaluate(async (root) => {
    const mb = await import('/src/openehr/medblocks.ts');
    return mb.exportComposition(document.querySelector('mb-form') as any, root);
  }, ROOT);

  // The exclusion is carried...
  expect(submitted[`${ROOT}/eps_allergies/exclusion_-_global/global_exclusion_of_adverse_reactions`]).toBe('No known allergies');
  // ...and NOT a single contradictory entry key came with it.
  const entryKeys = Object.keys(submitted).filter((k) => k.includes('eps_allergies/adverse_reaction_risk'));
  expect(entryKeys).toEqual([]);
  // Nor any absence-of-information key, the third branch.
  expect(Object.keys(submitted).filter((k) => k.includes('eps_allergies/absence_of_information'))).toEqual([]);

  // Save it for real. A CLEAN save navigates to the saved record (which then
  // starts loading it), so the "Saved" status is transient — the durable proof
  // is that the URL left /new, which only a 0-lost/0-mangled diff does.
  await page.locator('[data-testid=form-save]').click();
  await expect(page).toHaveURL(/compositions\/(?!new)[^?]+/, { timeout: 30_000 });

  // ROUND TRIP: reload that record from scratch.
  const url = page.url();
  await page.goto('/#/patients');
  await page.goto(url);
  await formReady(page);
  await expect(page.locator('[data-testid=form-status]')).toContainText('Loaded', { timeout: 30_000 });

  // It must land on the "None known" branch with the stored value bound.
  await expect(page.locator('[data-testid="allergies/mode-excluded"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-testid="mode-allergies"]')).toContainText('None known');
  const bound = await page.evaluate((root) => {
    const form = document.querySelector('mb-form') as any;
    return form.mbElements[`${root}/eps_allergies/exclusion_-_global/global_exclusion_of_adverse_reactions`]?.data;
  }, ROOT);
  expect(bound).toBe('No known allergies');

  // What the SECOND save would submit. This is the regression that would
  // otherwise silently drop stored exclusion data: the value must still be
  // there, and no entry keys may have crept back in.
  const resubmitted = await page.evaluate(async (root) => {
    const mb = await import('/src/openehr/medblocks.ts');
    return mb.exportComposition(document.querySelector('mb-form') as any, root);
  }, ROOT);

  expect(
    resubmitted[`${ROOT}/eps_allergies/exclusion_-_global/global_exclusion_of_adverse_reactions`],
  ).toBe('No known allergies');
  expect(Object.keys(resubmitted).filter((k) => k.includes('eps_allergies/adverse_reaction_risk'))).toEqual([]);

  // And save it again for real — a clean diff navigates once more.
  await page.locator('[data-testid=form-save]').click();
  await expect(page).toHaveURL(/compositions\/(?!new)[^?]+/, { timeout: 30_000 });
  await expect(page.locator('[data-testid=form-status]')).not.toContainText('read-back differs', {
    timeout: 30_000,
  });
});
