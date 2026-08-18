/**
 * Composition context — the administrative attributes every composition
 * carries, regardless of which clinical section is being filled in.
 *
 * These are fixed/administrative values rather than clinical input. They are
 * emitted via `mb-context`, which Medblocks treats specially: context elements
 * are excluded from `nonContextPaths()` and can be defaulted without the user
 * touching them.
 *
 * `category`, `language`, `territory`, `composer` and `context/start_time` are
 * all MANDATORY at the COMPOSITION root — EHRbase rejects the composition
 * outright if any is missing. Because Medblocks does not reliably export a
 * default that the user never touched, `ensureMandatoryContext()` in
 * `openehr/medblocks.ts` guarantees them at export time.
 */

import { html, type TemplateResult } from 'lit';
import { ROOT } from '../openehr/flat';
import { currentUser, nowLocalIso } from '../auth/session';

/**
 * Values for `mb-form.ctx` — the ONLY supported way to override Medblocks'
 * context defaults.
 *
 * FINDING (criterion C3): medblocks' openEHRFlat plugin hardcodes fallbacks in
 * `getContextValue`, notably `territory: ctx.territory || 'IN'` (India) and
 * `setting: 238 "other care"`. A `.value` binding on `mb-context` does NOT
 * override them — only the form-level `ctx` object does. A Dutch deployment
 * that misses this silently files every composition under territory IN.
 */
/**
 * `composer` is a GETTER, not a stored string.
 *
 * The logged-in user is resolved asynchronously at startup (`resolveUser()` in
 * `auth/session`), which finishes AFTER this module is evaluated. A plain
 * property would capture the pre-resolution fallback and every composition
 * would be filed against it forever. Reading through a getter means whoever
 * consumes `ctx` at render time gets the identity that is current then.
 */
export const FORM_CTX = {
  territory: 'NL',
  language: 'en',
  /** Whoever is logged in — not an application name. See `auth/session`. */
  get composer(): string {
    return currentUser().name;
  },
};

/**
 * Built per call for the same reason `FORM_CTX.composer` is a getter: a
 * module-level object literal would freeze the composer at import time.
 */
export function contextDefaults(): Record<string, string> {
  return {
    'category|code': '433',
    'category|value': 'event',
    'category|terminology': 'openehr',
    'language|code': FORM_CTX.language,
    'language|terminology': 'ISO_639-1',
    'territory|code': FORM_CTX.territory,
    'territory|terminology': 'ISO_3166-1',
    'composer|name': FORM_CTX.composer,
  };
}

/**
 * Stamps composition context onto a FLAT payload that has none.
 *
 * Used by the seeding script and by any caller assembling a composition outside
 * the form (which emits its own context). Existing keys are never overwritten.
 */
export function withCompositionContext(
  flat: Record<string, unknown>,
  root: string,
  startTime: string = nowLocalIso(),
): Record<string, unknown> {
  const out = { ...flat };

  for (const [suffix, value] of Object.entries(contextDefaults())) {
    const key = `${root}/${suffix}`;
    out[key] ??= value;
  }
  out[`${root}/context/start_time`] ??= startTime;

  return out;
}

/** `2026-08-18T09:14:03` -> `18 Aug 2026, 09:14`. */
function formatRecorded(startTime: string): string {
  const parsed = new Date(startTime);
  if (Number.isNaN(parsed.getTime())) return startTime;

  return parsed.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Composer and recorded-date are shown, not asked for.
 *
 * Both are facts the system already knows — who is logged in, and when they
 * started recording — so they are rendered as read-only text rather than as
 * inputs. Two reasons this is not merely cosmetic:
 *
 *   - As `mb-input`s they were EMPTY on screen. A default bound via `.value` is
 *     a no-op (mb-* controls hold their value on `.data`), so the form showed a
 *     blank mandatory field and relied entirely on `ensureMandatoryContext()`
 *     to rescue the save.
 *   - Neither is a clinical judgement, so letting a user type a different
 *     composer records an untruth about who authored the composition.
 *
 * They still reach the CDR: `ensureMandatoryContext()` in `openehr/medblocks`
 * stamps `composer|name` and `context/start_time` at export time. Nothing is
 * bound here, so there is deliberately no mb-* element for either.
 */
export function contextFields(startTime: string): TemplateResult {
  return html`
    <section>
      <h2>Composition context</h2>

      <!-- Values come from mb-form.ctx (see FORM_CTX above), not from here. -->
      <mb-context .path=${`${ROOT}/category`}></mb-context>
      <mb-context .path=${`${ROOT}/language`}></mb-context>
      <mb-context .path=${`${ROOT}/territory`}></mb-context>

      <dl class="context-facts">
        <div>
          <dt>Composer</dt>
          <dd data-testid="context/composer">${FORM_CTX.composer}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd data-testid="context/start_time">${formatRecorded(startTime)}</dd>
        </div>
      </dl>
    </section>
  `;
}
