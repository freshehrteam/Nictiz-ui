/**
 * History of procedures section (plan P7).
 *
 * `body_site` HERE is DV_TEXT and repeatable — the middle of its three shapes:
 *
 *   Problems    …/problem_diagnosis:0/body_site:0     DV_CODED_TEXT, repeatable
 *   Procedures  …/procedure:0/body_site:0             DV_TEXT,       repeatable  ← this file
 *   Devices     …/device_details:0/body_site          DV_TEXT,       single
 *
 * So: `mb-input` (not `mb-search`, which Problems uses) wrapped in
 * `mb-repeatable-simple` (which Devices does not need). Read off the web
 * template's value child, and confirmed by the golden fixture, which stores it
 * as plain text under an index:
 *
 *   …/procedure:0/body_site:0 = McBurney point area
 *
 * `procedure` is an ACTION, so it also carries an `ism_transition` — the
 * careflow step, which is DV_CODED_TEXT with an archetype-local list.
 */

import { html, type TemplateResult } from 'lit';
import { ROOT } from '../openehr/flat';
import {
  sectionShell,
  type SectionRenderContext,
  type AbsencePaths,
} from './section-shell';
import {
  CAREFLOW_STEP,
  PROCEDURE_GLOBAL_EXCLUSION,
  PROCEDURE_ABSENCE_STATEMENT,
} from '../terminology/codelists';

const SECTION = `${ROOT}/eps_history_of_procedures`;

/** Section root — also used by the view to infer a stored composition's mode. */
export const PROCEDURES_SECTION = SECTION;
export const PROCEDURES_ENTRIES = `${SECTION}/procedure`;

/** A repeatable DV_TEXT leaf: the container has no index, the child has `:0`. */
function repeatableText(base: string, field: string, label: string): TemplateResult {
  return html`
    <mb-repeatable-simple .path=${`${base}/${field}`}>
      <mb-input
        .path=${`${base}/${field}:0`}
        label=${label}
        data-testid=${`${base}/${field}`}
      ></mb-input>
    </mb-repeatable-simple>
  `;
}

/** One `procedure:n` ACTION. */
function procedure(base: string): TemplateResult {
  return html`
    <fieldset class="entry">
      <legend>Procedure</legend>

      <!--
        MANDATORY (min=1, at0002). An entry with any other field filled in but
        no procedure_name is rejected with

          HTTP 422 …/items[at0002]: Attribute has 0 occurrences, but must be 1..1

        so it is marked required here rather than discovered at save time.
      -->
      <div class="field-grid">
        <mb-input
          .path=${`${base}/procedure_name`}
          label="Procedure name (required)"
          required
          data-testid=${`${base}/procedure_name`}
        ></mb-input>

        <mb-input
          .path=${`${base}/procedure_type`}
          label="Procedure type"
          data-testid=${`${base}/procedure_type`}
        ></mb-input>
      </div>

      <!--
        DV_TEXT here, repeatable. The identically-named field in Problems is
        DV_CODED_TEXT and uses mb-search; rendering this one that way would emit
        |code/|terminology attributes the CDR rejects.
      -->
      <div class="field-grid">
        ${repeatableText(base, 'body_site', 'Body site')}
        ${repeatableText(base, 'indication', 'Indication')}
        ${repeatableText(base, 'outcome', 'Outcome')}
        ${repeatableText(base, 'complication', 'Complication')}

        <mb-date
          .path=${`${base}/start_datetime`}
          label="Start"
          time
          data-testid=${`${base}/start_datetime`}
        ></mb-date>

        <mb-date
          .path=${`${base}/end_datetime`}
          label="End"
          time
          data-testid=${`${base}/end_datetime`}
        ></mb-date>

        <mb-date
          .path=${`${base}/time`}
          label="Procedure time"
          time
          data-testid=${`${base}/time`}
        ></mb-date>
      </div>

      <fieldset class="nested">
        <legend>Devices used</legend>

        <mb-repeatable-simple .path=${`${base}/focal_device`}>
          <mb-input
            .path=${`${base}/focal_device:0/device_name`}
            label="Focal device name"
            data-testid=${`${base}/focal_device`}
          ></mb-input>
        </mb-repeatable-simple>

        <div class="field-grid">
          <mb-input
            .path=${`${base}/used_device/device_name`}
            label="Used device name"
            data-testid=${`${base}/used_device/device_name`}
          ></mb-input>

          <mb-input
            .path=${`${base}/used_device/type`}
            label="Used device type"
            data-testid=${`${base}/used_device/type`}
          ></mb-input>
        </div>
      </fieldset>

      <!--
        ACTION carries an ISM_TRANSITION. careflow_step is DV_CODED_TEXT with an
        archetype-local list, so it is a coded select — the |code/|value/
        |terminology triple the fixture stores.
      -->
      <mb-select
        .path=${`${base}/ism_transition/careflow_step`}
        label="Careflow step"
        data-testid=${`${base}/careflow_step`}
      >
        ${CAREFLOW_STEP.map(
          (o) => html`<mb-option value=${o.code} label=${o.label} terminology="local"></mb-option>`,
        )}
      </mb-select>

      <div class="field-grid">
        <mb-input .path=${`${base}/reason`} label="Reason" data-testid=${`${base}/reason`}></mb-input>
        <mb-input
          .path=${`${base}/comment`}
          label="Comment"
          data-testid=${`${base}/comment`}
        ></mb-input>
      </div>
    </fieldset>
  `;
}

/**
 * What Procedures offers when there is nothing to record.
 * `reason_for_absence` is max=1 HERE, unlike Devices where the same field
 * repeats — hence not repeatable.
 */
const ABSENCE: AbsencePaths = {
  exclusion: {
    path: `${SECTION}/exclusion_-_global/global_exclusion_of_procedures`,
    label: 'Global exclusion of procedures',
    options: PROCEDURE_GLOBAL_EXCLUSION,
  },
  absenceStatement: {
    path: `${SECTION}/absence_of_information/absence_statement`,
    label: 'Absence statement',
    options: PROCEDURE_ABSENCE_STATEMENT,
  },
  reasonForAbsence: {
    path: `${SECTION}/absence_of_information/reason_for_absence`,
    label: 'Reason for absence',
    repeatable: false,
  },
};

export function proceduresFields(ctx: SectionRenderContext): TemplateResult {
  return html`
    <section>
      <h2>History of procedures</h2>
      ${sectionShell({
        key: 'procedures',
        mode: ctx.mode,
        onModeChange: ctx.setMode,
        entriesLabel: 'Recorded procedures',
        absence: ABSENCE,
        renderEntries: () => html`
          <mb-repeatable-simple .path=${PROCEDURES_ENTRIES}>
            ${procedure(`${PROCEDURES_ENTRIES}:0`)}
          </mb-repeatable-simple>
        `,
      })}
    </section>
  `;
}
