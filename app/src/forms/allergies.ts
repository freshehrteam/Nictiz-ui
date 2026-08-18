/**
 * Track B — hand-written Medblocks form for the Allergies section.
 *
 * This is the core evaluation surface (plan P3). It deliberately exercises:
 *   - nested repeatables: adverse_reaction_risk:n / adverse_reaction_event:n
 *   - a repeatable *leaf*: manifestation:n
 *   - terminology search (mb-search) for substance (ATC) and manifestation (SNOMED)
 *   - archetype-local coded text (mb-buttons / mb-select)
 *   - the conditional "no known allergies" exclusion/absence pattern
 *
 * FLAT paths are written explicitly and are relative to the `mb-form` root
 * (`eps_patient_summary`), which is how Medblocks composes them.
 */

import { html, type TemplateResult } from 'lit';
import { ROOT } from '../openehr/flat';
import {
  sectionShell,
  type SectionRenderContext,
  type AbsencePaths,
} from './section-shell';
import {
  CRITICALITY,
  VERIFICATION_STATUS,
  ACTIVE_INACTIVE_STATUS,
  SEVERITY_OF_REACTION,
  ALLERGY_CATEGORY,
  REACTION_MECHANISM,
  ALLERGY_GLOBAL_EXCLUSION,
  ALLERGY_ABSENCE_STATEMENT,
  type CodeOption,
} from '../terminology/codelists';

/** Section root — also used by the view to infer a stored composition's mode. */
export const ALLERGIES_SECTION = `${ROOT}/eps_allergies`;
export const ALLERGIES_ENTRIES = `${ALLERGIES_SECTION}/adverse_reaction_risk`;

/** Renders a local (`at*`) code list as buttons when short, a select when long. */
function codedField(
  path: string,
  label: string,
  options: CodeOption[],
  opts: { terminology?: string } = {},
): TemplateResult {
  const terminology = opts.terminology ?? 'local';
  const asButtons = options.length <= 3;

  const optionEls = options.map(
    (o) => html`<mb-option value=${o.code} label=${o.label} terminology=${terminology}></mb-option>`,
  );

  return asButtons
    ? html`<mb-buttons .path=${path} label=${label} data-testid=${path}>${optionEls}</mb-buttons>`
    : html`<mb-select .path=${path} label=${label} data-testid=${path}>${optionEls}</mb-select>`;
}

/** One `adverse_reaction_event:n` block — nested inside a reaction risk. */
function reactionEvent(base: string): TemplateResult {
  return html`
    <fieldset class="nested">
      <legend>Reaction event</legend>

      <div class="field-grid">
        <mb-input
          .path=${`${base}/specific_substance`}
          label="Specific substance"
          data-testid=${`${base}/specific_substance`}
        ></mb-input>

        ${codedField(`${base}/severity_of_reaction`, 'Severity', SEVERITY_OF_REACTION)}

        <mb-input
          .path=${`${base}/route_of_exposure`}
          label="Route of exposure"
          data-testid=${`${base}/route_of_exposure`}
        ></mb-input>

        <mb-date
          .path=${`${base}/onset_of_reaction`}
          label="Onset of reaction"
          time
          data-testid=${`${base}/onset_of_reaction`}
        ></mb-date>

        <!--
          manifestation is a repeatable *leaf* (manifestation:0, :1 ...), not a
          repeatable container. mb-repeatable-simple wraps the leaf directly.
          Full width: a terminology search needs room for its result list.
        -->
        <div class="field-wide">
          <mb-repeatable-simple .path=${`${base}/manifestation`}>
            <mb-search
              .path=${`${base}/manifestation:0`}
              label="Manifestation (SNOMED CT)"
              .constraints=${['snomed:manifestation']}
              data-testid=${`${base}/manifestation`}
            ></mb-search>
          </mb-repeatable-simple>
        </div>

        <div class="field-wide">
          <mb-input
            .path=${`${base}/reaction_description`}
            label="Reaction description"
            data-testid=${`${base}/reaction_description`}
          ></mb-input>
        </div>

        <div class="field-wide">
          <mb-input
            .path=${`${base}/comment`}
            label="Comment"
            data-testid=${`${base}/comment`}
          ></mb-input>
        </div>
      </div>
    </fieldset>
  `;
}

/** One `adverse_reaction_risk:n` block. */
function reactionRisk(base: string): TemplateResult {
  return html`
    <fieldset class="entry">
      <legend>Adverse reaction risk</legend>

      <mb-search
        .path=${`${base}/substance`}
        label="Substance (ATC)"
        .constraints=${['atc:substance']}
        data-testid=${`${base}/substance`}
      ></mb-search>

      <div class="field-grid">
        ${codedField(`${base}/criticality`, 'Criticality', CRITICALITY)}
        ${codedField(`${base}/verification_status`, 'Verification status', VERIFICATION_STATUS)}
        ${codedField(`${base}/active_inactive_status`, 'Status', ACTIVE_INACTIVE_STATUS)}

        <!--
          category and reaction_mechanism are DV_TEXT in the FLAT fixture (bare
          string, no |code) even though the template offers a fixed option list —
          so they use mb-text-select, not mb-select. Getting this wrong emits
          |code/|terminology attributes the CDR rejects.
        -->
        <!--
          mb-text-select has NO options property: it reads slotted mb-option
          children via querySelectorAll('mb-option'). Passing an array silently
          renders an empty dropdown.

          These are DV_TEXT, so the mb-option value is the literal string stored
          in the composition — no code, no terminology.
        -->
        <mb-text-select
          .path=${`${base}/category`}
          label="Category"
          data-testid=${`${base}/category`}
        >
          ${ALLERGY_CATEGORY.map(
            (o) => html`<mb-option value=${o.label} label=${o.label}></mb-option>`,
          )}
        </mb-text-select>

        <mb-text-select
          .path=${`${base}/reaction_mechanism`}
          label="Reaction mechanism"
          data-testid=${`${base}/reaction_mechanism`}
        >
          ${REACTION_MECHANISM.map(
            (o) => html`<mb-option value=${o.label} label=${o.label}></mb-option>`,
          )}
        </mb-text-select>

        <!--
          onset_of_first_reaction carries an explicit /date_time_value leaf in
          the fixture, while onset_of_last_reaction does not. Mirroring the
          fixture exactly matters more than internal consistency here.
        -->
        <mb-date
          .path=${`${base}/onset_of_first_reaction/date_time_value`}
          label="Onset of first reaction"
          time
          data-testid=${`${base}/onset_of_first_reaction`}
        ></mb-date>

        <mb-date
          .path=${`${base}/onset_of_last_reaction`}
          label="Onset of last reaction"
          time
          data-testid=${`${base}/onset_of_last_reaction`}
        ></mb-date>
      </div>

      <mb-input .path=${`${base}/comment`} label="Comment" data-testid=${`${base}/comment`}></mb-input>

      <mb-repeatable-simple .path=${`${base}/adverse_reaction_event`}>
        ${reactionEvent(`${base}/adverse_reaction_event:0`)}
      </mb-repeatable-simple>
    </fieldset>
  `;
}

/**
 * What Allergies offers when there is nothing to record.
 *
 * Both statements are DV_TEXT with a constrained list in the web template, so
 * they render as `mb-text-select` with literal-string options.
 * `reason_for_absence` is max=1 here, hence not repeatable.
 */
const ABSENCE: AbsencePaths = {
  exclusion: {
    path: `${ALLERGIES_SECTION}/exclusion_-_global/global_exclusion_of_adverse_reactions`,
    label: 'Global exclusion of adverse reactions',
    options: ALLERGY_GLOBAL_EXCLUSION,
  },
  absenceStatement: {
    path: `${ALLERGIES_SECTION}/absence_of_information/absence_statement`,
    label: 'Absence statement',
    options: ALLERGY_ABSENCE_STATEMENT,
  },
  reasonForAbsence: {
    path: `${ALLERGIES_SECTION}/absence_of_information/reason_for_absence`,
    label: 'Reason for absence',
    repeatable: false,
  },
};

export function allergiesFields(ctx: SectionRenderContext): TemplateResult {
  return html`
    <section>
      <h2>Allergies &amp; intolerances</h2>
      ${sectionShell({
        key: 'allergies',
        mode: ctx.mode,
        onModeChange: ctx.setMode,
        entriesLabel: 'Recorded allergies and intolerances',
        absence: ABSENCE,
        renderEntries: () => html`
          <mb-repeatable-simple .path=${ALLERGIES_ENTRIES}>
            ${reactionRisk(`${ALLERGIES_ENTRIES}:0`)}
          </mb-repeatable-simple>
        `,
      })}
    </section>
  `;
}
