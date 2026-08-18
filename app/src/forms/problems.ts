/**
 * Track B — hand-written Medblocks form for the Problems section (plan P4).
 *
 * Problems was chosen over Procedures because it concentrates both traps:
 *   R4 — `body_site` here is DV_CODED_TEXT (|code/|value/|terminology), while
 *        the identically-named field is plain DV_TEXT in Procedures and
 *        DV_TEXT + non-repeatable in Medical Devices.
 *   R5 — the only two `|other` keys in the entire 329-key fixture live here.
 */

import { html, type TemplateResult } from 'lit';
import { ROOT } from '../openehr/flat';
import {
  sectionShell,
  type SectionRenderContext,
  type AbsencePaths,
} from './section-shell';
import {
  PROBLEM_SEVERITY,
  DIAGNOSTIC_CERTAINTY,
  PROBLEM_ACTIVE_INACTIVE,
  RESOLUTION_PHASE,
  REMISSION_STATUS,
  OCCURRENCE,
  PROBLEM_GLOBAL_EXCLUSION,
  PROBLEM_ABSENCE_STATEMENT,
  type CodeOption,
} from '../terminology/codelists';

/** Section root — also used by the view to infer a stored composition's mode. */
export const PROBLEMS_SECTION = `${ROOT}/eps_problems`;
export const PROBLEMS_ENTRIES = `${PROBLEMS_SECTION}/problem_diagnosis`;

function codedField(path: string, label: string, options: CodeOption[]): TemplateResult {
  const optionEls = options.map(
    (o) => html`<mb-option value=${o.code} label=${o.label} terminology="local"></mb-option>`,
  );
  return options.length <= 3
    ? html`<mb-buttons .path=${path} label=${label} data-testid=${path}>${optionEls}</mb-buttons>`
    : html`<mb-select .path=${path} label=${label} data-testid=${path}>${optionEls}</mb-select>`;
}

function qualifiers(base: string): TemplateResult {
  const q = `${base}/problem_diagnosis_qualifier`;
  return html`
    <fieldset class="nested">
      <legend>Problem qualifiers</legend>
      <div class="field-grid">
        ${codedField(`${q}/active_inactive`, 'Active / inactive', PROBLEM_ACTIVE_INACTIVE)}
        ${codedField(`${q}/resolution_phase`, 'Resolution phase', RESOLUTION_PHASE)}
        ${codedField(`${q}/remission_status`, 'Remission status', REMISSION_STATUS)}
        ${codedField(`${q}/occurrence`, 'Occurrence', OCCURRENCE)}
      </div>
    </fieldset>
  `;
}

/**
 * The two `|other` keys (trap R5).
 *
 * `result` here is a DV_CODED_TEXT whose value falls outside the constrained
 * list, so openEHR encodes it via the `|other` attribute rather than
 * |code/|value. Medblocks has no dedicated control for this, so it is driven
 * as an explicit attribute path — which is itself a C3/C10 finding.
 *
 * Note the asymmetry, faithfully mirrored from the fixture:
 *   clinical_evidence:0/result:0|other   <- result IS indexed
 *   stage:0/result|other                 <- result is NOT indexed
 */
function otherFields(base: string): TemplateResult {
  return html`
    <fieldset class="nested">
      <legend>Evidence &amp; staging (<code>|other</code> trap)</legend>

      <mb-input
        .path=${`${base}/clinical_evidence:0/result:0|other`}
        label="Clinical evidence — result (other)"
        data-testid="problems/clinical-evidence-other"
      ></mb-input>

      <mb-input
        .path=${`${base}/stage:0/evidence`}
        label="Stage — evidence"
        data-testid="problems/stage-evidence"
      ></mb-input>

      <mb-input
        .path=${`${base}/stage:0/result|other`}
        label="Stage — result (other)"
        data-testid="problems/stage-result-other"
      ></mb-input>
    </fieldset>
  `;
}

function problemDiagnosis(base: string): TemplateResult {
  return html`
    <fieldset class="entry">
      <legend>Problem / diagnosis</legend>

      <mb-search
        .path=${`${base}/problem_diagnosis_name`}
        label="Problem / diagnosis (SNOMED CT)"
        .constraints=${['snomed:finding']}
        data-testid=${`${base}/problem_diagnosis_name`}
      ></mb-search>

      <!--
        TRAP R4: coded body_site. Rendered with mb-search (not mb-input) purely
        because the web template says the value child is DV_CODED_TEXT here.
        The same field name in Procedures/Devices must render as a plain input.
      -->
      <mb-repeatable-simple .path=${`${base}/body_site`}>
        <mb-search
          .path=${`${base}/body_site:0`}
          label="Body site (SNOMED CT — coded here, plain text in Procedures)"
          .constraints=${['snomed:body-site']}
          data-testid=${`${base}/body_site`}
        ></mb-search>
      </mb-repeatable-simple>

      <div class="field-grid">
        ${codedField(`${base}/severity`, 'Severity', PROBLEM_SEVERITY)}
        ${codedField(`${base}/diagnostic_certainty`, 'Diagnostic certainty', DIAGNOSTIC_CERTAINTY)}

        <mb-date
          .path=${`${base}/date_time_of_onset`}
          label="Date of onset"
          time
          data-testid=${`${base}/date_time_of_onset`}
        ></mb-date>

        <mb-date
          .path=${`${base}/date_time_of_resolution`}
          label="Date of resolution"
          time
          data-testid=${`${base}/date_time_of_resolution`}
        ></mb-date>
      </div>

      ${qualifiers(base)} ${otherFields(base)}

      <mb-input
        .path=${`${base}/comment`}
        label="Comment"
        data-testid=${`${base}/comment`}
      ></mb-input>
    </fieldset>
  `;
}

/**
 * What Problems offers when there is nothing to record.
 * `reason_for_absence` is max=1 here — not repeatable, unlike Devices.
 */
const ABSENCE: AbsencePaths = {
  exclusion: {
    path: `${PROBLEMS_SECTION}/exclusion_-_global/global_exclusion_of_problems_diagnoses`,
    label: 'Global exclusion of problems / diagnoses',
    options: PROBLEM_GLOBAL_EXCLUSION,
  },
  absenceStatement: {
    path: `${PROBLEMS_SECTION}/absence_of_information/absence_statement`,
    label: 'Absence statement',
    options: PROBLEM_ABSENCE_STATEMENT,
  },
  reasonForAbsence: {
    path: `${PROBLEMS_SECTION}/absence_of_information/reason_for_absence`,
    label: 'Reason for absence',
    repeatable: false,
  },
};

export function problemsFields(ctx: SectionRenderContext): TemplateResult {
  return html`
    <section>
      <h2>Problems &amp; diagnoses</h2>
      ${sectionShell({
        key: 'problems',
        mode: ctx.mode,
        onModeChange: ctx.setMode,
        entriesLabel: 'Recorded problems and diagnoses',
        absence: ABSENCE,
        renderEntries: () => html`
          <mb-repeatable-simple .path=${PROBLEMS_ENTRIES}>
            ${problemDiagnosis(`${PROBLEMS_ENTRIES}:0`)}
          </mb-repeatable-simple>
        `,
      })}
    </section>
  `;
}
