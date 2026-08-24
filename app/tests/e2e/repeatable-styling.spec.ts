/**
 * Regression guard for D-11 — an added repeatable occurrence must look like the
 * first one.
 *
 * `mb-repeatable-simple` renders occurrence 0 through a `<slot>` (light DOM) and
 * occurrences 1+ through `unsafeHTML(outerHTML)` inside its SHADOW root. All of
 * `views.css` is scoped `eps-composition-form <descendant>`, and descendant
 * selectors do not cross a shadow boundary, so without `repeatable-styles.ts`
 * the copy silently falls back to browser defaults:
 *
 *     .field-grid  grid -> block      fieldset padding  14px -> 10.5px
 *     mb-input     block -> inline    fieldset border   1px  -> 2px groove
 *
 * Asserting the copy is *attached* catches none of that — this asserts computed
 * style, which is the only thing that reflects the bug.
 */
import { test, expect, type Page } from '@playwright/test';

async function openBlankForm(page: Page): Promise<void> {
  await page.goto('/#/patients');
  const cards = page.locator('.patient-card');
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  await cards.first().click();
  await expect(page).toHaveURL(/#\/patients\/[^/]+\/compositions/);
  await page.locator('a,button').filter({ hasText: /new|create|record/i }).first().click();
  await expect(page.locator('mb-form')).toBeAttached({ timeout: 20_000 });
}

/** Computed styles of the first occurrence (light DOM) vs an added one (shadow). */
async function measure(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('mb-repeatable-simple') as HTMLElement & { shadowRoot: ShadowRoot };
    const cs = (el: Element | null | undefined, p: string) =>
      el ? getComputedStyle(el).getPropertyValue(p) : 'NOT-FOUND';
    const shape = (fs: Element | null | undefined, mb: Element | null | undefined) => ({
      grid: cs(fs?.querySelector('.field-grid'), 'display'),
      cols: cs(fs?.querySelector('.field-grid'), 'grid-template-columns'),
      pad: cs(fs, 'padding-left'),
      border: cs(fs, 'border-top-width'),
      mbDisplay: cs(mb, 'display'),
    });
    return {
      original: shape(r.querySelector('fieldset.entry'), r.querySelector('mb-input')),
      copy: shape(r.shadowRoot.querySelector('fieldset.entry'), r.shadowRoot.querySelector('mb-input')),
    };
  });
}

test('@stack an added adverse reaction risk is styled like the first (D-11)', async ({ page }) => {
  await openBlankForm(page);
  await expect(page.locator('mb-repeatable-simple').first()).toBeAttached({ timeout: 20_000 });

  // Click the repeatable's own Add button, which lives in its shadow root.
  await page.evaluate(() => {
    const r = document.querySelector('mb-repeatable-simple') as HTMLElement & { shadowRoot: ShadowRoot };
    (r.shadowRoot.querySelector('sl-button') as HTMLElement | null)?.click();
  });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const r = document.querySelector('mb-repeatable-simple') as HTMLElement & { shadowRoot: ShadowRoot };
        return r.shadowRoot.querySelectorAll('fieldset.entry').length;
      }),
    )
    .toBe(1);

  const { original, copy } = await measure(page);

  // The copy must match the original on every property the boundary breaks.
  expect(copy).toEqual(original);

  // And those values must be OUR layout, not a UA default that happens to agree.
  expect(original.grid).toBe('grid');
  expect(original.mbDisplay).toBe('block');
  expect(original.cols.split(' ').length).toBeGreaterThan(1);
});

test('@stack every repeatable on the page gets the occurrence styles (D-11)', async ({ page }) => {
  await openBlankForm(page);
  await expect(page.locator('mb-repeatable-simple').first()).toBeAttached({ timeout: 20_000 });

  // D-11 is not specific to Allergies: it hits every repeatable, including the
  // nested ones (adverse_reaction_event, manifestation, body_site).
  const report = await page.evaluate(() => {
    const all = [...document.querySelectorAll('mb-repeatable-simple')];
    return {
      total: all.length,
      withShadow: all.filter((r) => r.shadowRoot).length,
      unstyled: all.filter((r) => {
        const sr = r.shadowRoot;
        if (!sr) return false;
        const hasSheet = sr.adoptedStyleSheets.length > 0 || !!sr.querySelector('style');
        return !hasSheet;
      }).length,
    };
  });
  console.log('REPEATABLES:', JSON.stringify(report));

  expect(report.total).toBeGreaterThan(1);
  expect(report.unstyled).toBe(0);
});
