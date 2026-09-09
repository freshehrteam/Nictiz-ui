/**
 * Medical devices section (plan P7).
 *
 * `body_site` HERE is the third of its three shapes in this one template:
 *
 *   Problems    …/problem_diagnosis:0/body_site:0            DV_CODED_TEXT, repeatable
 *   Procedures  …/procedure:0/body_site:0                    DV_TEXT,       repeatable
 *   Devices     …/device_details:0/body_site                 DV_TEXT,       SINGLE   ← this file
 *
 * All three were read off the web template's value child, never guessed from
 * the field name. Getting it wrong here fails in both directions: `mb-search`
 * would emit |code/|terminology attributes the CDR rejects, and wrapping it in
 * `mb-repeatable-simple` would emit `body_site:0`, a path this section does not
 * have. Verified against the golden fixture, which stores it bare:
 *
 *   …/medical_device_summary:0/device_details:0/body_site = Left hip
 *
 * Every other field below is likewise typed from the template: DV_TEXT →
 * mb-input, DV_DATE_TIME → mb-date, DV_CODED_TEXT with a local list →
 * mb-select, DV_IDENTIFIER → mb-input on the `|id` attribute.
 */

import { html, type TemplateResult } from 'lit';
import { ROOT } from '../openehr/flat';
import {
  sectionShell,
  type SectionRenderContext,
  type AbsencePaths,
} from './section-shell';
import { DEVICE_ABSENCE_STATEMENT } from '../terminology/codelists';

const SECTION = `${ROOT}/eps_medical_devices`;

/** Section root — also used by the view to infer a stored composition's mode. */
export const DEVICES_SECTION = SECTION;
export const DEVICES_ENTRIES = `${SECTION}/medical_device_summary`;

/**
 * The ONLY status this form ever records.
 *
 * `status` (at0002) is a mandatory DV_CODED_TEXT whose archetype list is
 * at0003 Never / at0004 Current / at0005 Previous — but this UI records
 * devices that are in use, so the choice was removed from the form and every
 * saved entry is stamped "Current" (at0004, "currently fitted or implanted" —
 * the openEHR counterpart of FHIR's `active`).
 *
 * Stamped at EXPORT, not defaulted on a hidden control, because Medblocks
 * only serialises elements whose value has been *set* — a default bound via a
 * property never reaches `export()` (the `composer` lesson), and the CDR
 * answers with a 422 naming at0002 rather than anything on screen.
 */
export const DEVICE_STATUS_CURRENT = {
  code: 'at0004',
  value: 'Current',
  terminology: 'local',
} as const;

/**
 * Stamps `status` = Current onto every occupied `medical_device_summary:n`.
 *
 * "Occupied" = any exported key under the entry; `export(false)` has already
 * dropped empty values and seeded `:0` markers, so a prefix appearing here
 * means the user actually put data in that entry. Unconditional on purpose: a
 * legacy composition loaded with Never/Previous passes through `deferredData`
 * (excluded from export) and is re-stamped Current on its next save — the
 * invariant this exists to hold.
 */
export function ensureDeviceStatus(flat: Record<string, unknown>): Record<string, unknown> {
  const out = { ...flat };

  const entries = new Set<string>();
  for (const key of Object.keys(out)) {
    const m = key.match(/^(.*eps_medical_devices\/medical_device_summary:\d+)\//);
    if (m) entries.add(m[1]);
  }

  for (const entry of entries) {
    out[`${entry}/status|code`] = DEVICE_STATUS_CURRENT.code;
    out[`${entry}/status|value`] = DEVICE_STATUS_CURRENT.value;
    out[`${entry}/status|terminology`] = DEVICE_STATUS_CURRENT.terminology;
  }

  return out;
}

/**
 * The device itself. `unique_device_identifier_udi` and `distinct_identifier`
 * are DV_IDENTIFIER, whose FLAT form is `…|id` — bound directly because
 * Medblocks ships no DV_IDENTIFIER control.
 *
 * `|id` is an attribute on a LEAF path, which is safe. The rule that bans `|`
 * in element paths (D-5) applies to paths that continue past the attribute;
 * `fromFlat` splits on `|` and would never match those.
 */
function medicalDevice(base: string): TemplateResult {
  return html`
    <fieldset class="nested">
      <legend>Device</legend>

      <div class="field-grid">
        <mb-input
          .path=${`${base}/device_name`}
          label="Device name"
          data-testid=${`${base}/device_name`}
        ></mb-input>

        <mb-input .path=${`${base}/type`} label="Type" data-testid=${`${base}/type`}></mb-input>

        <mb-input
          .path=${`${base}/manufacturer`}
          label="Manufacturer"
          data-testid=${`${base}/manufacturer`}
        ></mb-input>

        <mb-input
          .path=${`${base}/unique_device_identifier_udi|id`}
          label="Unique device identifier (UDI)"
          data-testid=${`${base}/udi`}
        ></mb-input>

        <mb-input
          .path=${`${base}/distinct_identifier|id`}
          label="Distinct identifier"
          data-testid=${`${base}/distinct_identifier`}
        ></mb-input>

        <mb-input
          .path=${`${base}/serial_number`}
          label="Serial number"
          data-testid=${`${base}/serial_number`}
        ></mb-input>

        <mb-input
          .path=${`${base}/model_number`}
          label="Model number"
          data-testid=${`${base}/model_number`}
        ></mb-input>

        <mb-input
          .path=${`${base}/batch_lot_number`}
          label="Batch / lot number"
          data-testid=${`${base}/batch_lot_number`}
        ></mb-input>

        <mb-input
          .path=${`${base}/software_version`}
          label="Software version"
          data-testid=${`${base}/software_version`}
        ></mb-input>

        <mb-date
          .path=${`${base}/date_of_manufacture`}
          label="Date of manufacture"
          time
          data-testid=${`${base}/date_of_manufacture`}
        ></mb-date>

        <mb-date
          .path=${`${base}/date_of_expiry`}
          label="Date of expiry"
          time
          data-testid=${`${base}/date_of_expiry`}
        ></mb-date>
      </div>

      <mb-input .path=${`${base}/comment`} label="Comment" data-testid=${`${base}/comment`}></mb-input>
    </fieldset>
  `;
}

/** One `device_details:n` cluster — where and when the device was in use. */
function deviceDetails(base: string): TemplateResult {
  return html`
    <fieldset class="nested">
      <legend>Device details</legend>

      <!--
        DV_TEXT and NOT repeatable here (max=1) — unlike the identically-named
        field in Problems (coded, repeatable) and Procedures (text, repeatable).
        Hence a bare mb-input with no :0 and no mb-repeatable-simple wrapper.
      -->
      <div class="field-grid">
        <mb-input
          .path=${`${base}/body_site`}
          label="Body site"
          data-testid=${`${base}/body_site`}
        ></mb-input>

        <mb-date
          .path=${`${base}/start_date`}
          label="Start date"
          time
          data-testid=${`${base}/start_date`}
        ></mb-date>

        <mb-date
          .path=${`${base}/end_date`}
          label="End date"
          time
          data-testid=${`${base}/end_date`}
        ></mb-date>
      </div>

      ${medicalDevice(`${base}/medical_device`)}
    </fieldset>
  `;
}

/** One `medical_device_summary:n` entry. */
function deviceSummary(base: string): TemplateResult {
  return html`
    <fieldset class="entry">
      <legend>Medical device summary</legend>

      <!--
        NO BACKTICKS IN THIS COMMENT - one would terminate the template literal.

        status (at0002, min=1) is deliberately NOT rendered. The form always
        records it as Current - see DEVICE_STATUS_CURRENT / ensureDeviceStatus,
        which exportComposition() applies so occupied entries still satisfy the
        CDR's 1..1 constraint. With no control mounted, validateMandatory()
        finds no occurrence of the path in the live registry and correctly
        stays silent about it.
      -->
      <mb-repeatable-simple .path=${`${base}/device_details`}>
        ${deviceDetails(`${base}/device_details:0`)}
      </mb-repeatable-simple>
    </fieldset>
  `;
}

/**
 * What Medical Devices offers when there is nothing to record.
 *
 * NOTE the two asymmetries with the other three sections, both read from the
 * web template rather than assumed:
 *
 *   - There is NO `exclusion_-_global` node here, so `exclusion` is omitted and
 *     the shell drops the "None known" option for this section. Binding one
 *     would emit a path the template does not have.
 *   - `reason_for_absence` is max=-1 here (max=1 in Procedures), so it needs
 *     the `:0` index and a repeatable wrapper. Same field name, different
 *     cardinality — the body_site lesson in miniature.
 */
const ABSENCE: AbsencePaths = {
  absenceStatement: {
    path: `${SECTION}/absence_of_information/absence_statement`,
    label: 'Absence statement',
    options: DEVICE_ABSENCE_STATEMENT,
  },
  reasonForAbsence: {
    path: `${SECTION}/absence_of_information/reason_for_absence`,
    label: 'Reason for absence',
    repeatable: true,
  },
};

export function devicesFields(ctx: SectionRenderContext): TemplateResult {
  return html`
    <section>
      <h2>Medical devices</h2>
      ${sectionShell({
        key: 'devices',
        mode: ctx.mode,
        onModeChange: ctx.setMode,
        entriesLabel: 'Recorded medical devices',
        absence: ABSENCE,
        renderEntries: () => html`
          <mb-repeatable-simple .path=${DEVICES_ENTRIES}>
            ${deviceSummary(`${DEVICES_ENTRIES}:0`)}
          </mb-repeatable-simple>
        `,
      })}
    </section>
  `;
}
