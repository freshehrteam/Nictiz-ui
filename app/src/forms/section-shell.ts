/**
 * The three-way "what is there to record?" decision, shared by all four
 * clinical sections.
 *
 * WHY A DECISION AND NOT THREE BLOCKS ON SCREEN
 *
 * Every section in this template offers the same trio: a repeatable list of
 * real entries, an optional global-exclusion EVALUATION ("No known allergies"),
 * and an optional absence-of-information EVALUATION ("No information about
 * allergies"). Rendering all three at once — which is what this form used to do
 * — invites a user to record an allergy AND assert that none are known, which
 * is clinically contradictory and which nothing in the UI forbids.
 *
 * The web template backs this up rather than merely permitting a nicer UI.
 * From `fixtures/eps-patient-summary.webtemplate.json`:
 *
 *   …/exclusion_-_global        min 0 max 1, child global_exclusion_of_* min 1
 *   …/absence_of_information    min 0 max 1, child absence_statement     min 1
 *
 * Each absence EVALUATION is optional as a whole but carries a MANDATORY child,
 * so they are all-or-nothing: a half-filled one is invalid. A three-way choice
 * is therefore the faithful rendering of the model.
 *
 * WHY UNMOUNTING, NOT HIDING
 *
 * `mb-form.mbElements` is a live getter over `mbElementSet`
 * (`node_modules/medblocks-ui/dist/src/medblocks/form/form.js:65`), and
 * `handleChildDisconnect` (:281) deletes from that set when an element leaves
 * the DOM. A field that is unmounted is therefore out of the registry and out
 * of `export()`. That is what makes this safe: the contradictory branch cannot
 * reach the CDR. `display: none` would keep every field registered and still
 * exported — the appearance of exclusivity with none of the substance.
 *
 * WHY PLAIN BUTTONS FOR THE SWITCH
 *
 * The mode is UI state, not clinical data. An `mb-*` control would register
 * itself with `mb-form` and be exported as a field the template has no path
 * for. So: plain buttons in a `role="radiogroup"`.
 */

import { html, type TemplateResult } from 'lit';

export type SectionMode = 'entries' | 'excluded' | 'no-information';

/** What each section renders when the user has nothing to record. */
export interface AbsencePaths {
  /**
   * Optional because Medical Devices genuinely has no `exclusion_-_global`
   * node — omitting this drops the "None known" option for that section
   * rather than binding a path the template does not have.
   */
  exclusion?: { path: string; label: string; options: string[] };
  /** Mandatory child of `absence_of_information` (min=1). */
  absenceStatement: { path: string; label: string; options: string[] };
  /**
   * Free text — the template constrains it to no list (its only annotation is
   * a FHIR `ListEmptyReasons` reference, which is not a local code list).
   *
   * `repeatable` is max=-1 in Devices and max=1 everywhere else. Same field
   * name, different cardinality: the wrong choice emits either a bare path
   * where an indexed one is required or the reverse, and the CDR rejects it.
   */
  reasonForAbsence: { path: string; label: string; repeatable: boolean };
}

export interface SectionRenderContext {
  mode: SectionMode;
  setMode: (mode: SectionMode) => void;
}

interface ModeOption {
  mode: SectionMode;
  label: string;
  hint: string;
}

/**
 * Renders a constrained DV_TEXT picker.
 *
 * `mb-text-select` has NO options property — it reads slotted `mb-option`
 * children via `querySelectorAll`. Handing it an array renders an empty
 * dropdown with no error at all, which the D-9 e2e test exists to catch.
 *
 * These are DV_TEXT, so `value` is the literal string stored in the
 * composition: no `code`, no `terminology` attribute.
 */
function textSelect(path: string, label: string, options: string[], testid: string): TemplateResult {
  return html`
    <mb-text-select .path=${path} label=${label} data-testid=${testid}>
      ${options.map((o) => html`<mb-option value=${o} label=${o}></mb-option>`)}
    </mb-text-select>
  `;
}

function modeOptions(absence: AbsencePaths): ModeOption[] {
  const options: ModeOption[] = [
    { mode: 'entries', label: 'Recorded', hint: 'Record one or more entries' },
  ];

  if (absence.exclusion) {
    options.push({
      mode: 'excluded',
      label: 'None known',
      hint: 'Positively assert that there are none',
    });
  }

  options.push({
    mode: 'no-information',
    label: 'No information',
    hint: 'The information was not available',
  });

  return options;
}

/** The segmented control. Plain buttons — see the file comment. */
function modeSwitcher(
  key: string,
  mode: SectionMode,
  onModeChange: (mode: SectionMode) => void,
  absence: AbsencePaths,
): TemplateResult {
  return html`
    <div class="mode-switcher" role="radiogroup" aria-label="What is there to record?">
      ${modeOptions(absence).map(
        (o) => html`
          <button
            type="button"
            role="radio"
            class="mode-option ${mode === o.mode ? 'selected' : ''}"
            aria-checked=${mode === o.mode ? 'true' : 'false'}
            title=${o.hint}
            @click=${() => onModeChange(o.mode)}
            data-testid=${`${key}/mode-${o.mode}`}
          >
            ${o.label}
          </button>
        `,
      )}
    </div>
  `;
}

/** The `no-information` branch: mandatory statement plus optional free-text reason. */
function absenceBranch(key: string, absence: AbsencePaths): TemplateResult {
  const { absenceStatement, reasonForAbsence } = absence;

  const reason = reasonForAbsence.repeatable
    ? html`
        <mb-repeatable-simple .path=${reasonForAbsence.path}>
          <mb-input
            .path=${`${reasonForAbsence.path}:0`}
            label=${reasonForAbsence.label}
            data-testid=${`${key}/reason-for-absence`}
          ></mb-input>
        </mb-repeatable-simple>
      `
    : html`
        <mb-input
          .path=${reasonForAbsence.path}
          label=${reasonForAbsence.label}
          data-testid=${`${key}/reason-for-absence`}
        ></mb-input>
      `;

  return html`
    <fieldset class="entry">
      <legend>Information unavailable</legend>
      <div class="field-grid">
        ${textSelect(
          absenceStatement.path,
          absenceStatement.label,
          absenceStatement.options,
          `${key}/absence-statement`,
        )}
        <div class="field-wide">${reason}</div>
      </div>
    </fieldset>
  `;
}

/** The `excluded` branch: the global-exclusion statement, on its own. */
function exclusionBranch(key: string, exclusion: NonNullable<AbsencePaths['exclusion']>) {
  return html`
    <fieldset class="entry">
      <legend>Nothing known</legend>
      <div class="field-grid">
        ${textSelect(exclusion.path, exclusion.label, exclusion.options, `${key}/global-exclusion`)}
      </div>
    </fieldset>
  `;
}

/**
 * A section: the mode switcher, then exactly one branch.
 *
 * Only the chosen branch is returned, so the others are absent from the DOM and
 * therefore from `export()`.
 */
export function sectionShell(opts: {
  key: string;
  mode: SectionMode;
  onModeChange: (mode: SectionMode) => void;
  entriesLabel: string;
  absence: AbsencePaths;
  renderEntries: () => TemplateResult;
}): TemplateResult {
  const { key, mode, onModeChange, entriesLabel, absence, renderEntries } = opts;

  // A section with no exclusion node (Devices) can still be handed 'excluded'
  // by stale state; fall back rather than render a branch that cannot bind.
  const effective: SectionMode = mode === 'excluded' && !absence.exclusion ? 'entries' : mode;

  let branch: TemplateResult;
  if (effective === 'entries') {
    branch = renderEntries();
  } else if (effective === 'excluded') {
    branch = exclusionBranch(key, absence.exclusion!);
  } else {
    branch = absenceBranch(key, absence);
  }

  return html`
    <div class="section-choice">
      ${modeSwitcher(key, effective, onModeChange, absence)}
      <span class="mode-caption">
        ${effective === 'entries' ? entriesLabel : 'No entries will be recorded for this section.'}
      </span>
    </div>
    ${branch}
  `;
}

/**
 * Which mode a stored composition implies.
 *
 * Called before `import()` binds, so the correct branch is already mounted when
 * the values arrive. Without this, a stored "No known allergies" would open on
 * the entries branch: the value would be invisible AND — because the exclusion
 * field is not in the DOM and so not in the registry — silently dropped on the
 * next save.
 *
 * Two rules here are not obvious, and both were found against real stored data
 * rather than reasoned about:
 *
 * 1. ENTRIES WIN. Records written before this form enforced the choice can
 *    carry entries AND an absence statement at once — the exact contradiction
 *    this feature exists to prevent. There is no way to honour both, so the
 *    branch holding real clinical entries is the one that opens: choosing an
 *    absence branch would unmount dozens of populated fields and drop them on
 *    the next save. The user can still switch, and is warned when they do.
 *
 * 2. ONLY THE CLINICAL STATEMENT COUNTS. EHRbase emits RM housekeeping for any
 *    block that exists at all — `language|code`, `encoding|code`,
 *    `_work_flow_id|id`, `_guideline_id|id`. Treating "any key under this
 *    block" as evidence makes every such block look filled, so the check is
 *    narrowed to the mandatory statement leaf each block is built around.
 */
export function inferMode(stored: Record<string, unknown>, sectionPath: string): SectionMode {
  // The `|`-suffixed RM attributes above are never the statement itself, and
  // the statement is always a direct child of the block.
  const hasStatement = (block: string): boolean =>
    Object.entries(stored).some(([key, value]) => {
      const prefix = `${sectionPath}/${block}/`;
      if (!key.startsWith(prefix)) return false;

      const leaf = key.slice(prefix.length);
      if (leaf.includes('/') || leaf.includes('|') || leaf.startsWith('_')) return false;

      return hasValue(value);
    });

  // An entry key is anything under the section that is not one of the two
  // absence blocks — i.e. the repeatable clinical entries themselves.
  const hasEntries = Object.entries(stored).some(([key, value]) => {
    if (!key.startsWith(`${sectionPath}/`)) return false;
    const rest = key.slice(sectionPath.length + 1);
    if (rest.startsWith('exclusion_-_global/') || rest.startsWith('absence_of_information/')) {
      return false;
    }

    // Section-level RM housekeeping (…/eps_allergies/language|code) is not a
    // clinical entry. Only the FIRST segment is tested, because `|` deeper in
    // the path can be real data: Devices stores its UDI at
    // …/medical_device:0/unique_device_identifier_udi|id, and skipping every
    // key containing `|` would read a UDI-only record as having no entries.
    const head = rest.split('/')[0];
    if (head.includes('|') || head.startsWith('_')) return false;

    return hasValue(value);
  });

  if (hasEntries) return 'entries';
  if (hasStatement('exclusion_-_global')) return 'excluded';
  if (hasStatement('absence_of_information')) return 'no-information';
  return 'entries';
}

/** Whether the branch currently on screen holds anything the user typed. */
export function branchHasData(
  data: Record<string, unknown>,
  mode: SectionMode,
  sectionPath: string,
  entriesPath: string,
): boolean {
  const prefix =
    mode === 'entries'
      ? entriesPath
      : mode === 'excluded'
        ? `${sectionPath}/exclusion_-_global`
        : `${sectionPath}/absence_of_information`;

  return Object.entries(data).some(([key, value]) => {
    if (!key.startsWith(prefix)) return false;
    return hasValue(value);
  });
}

/**
 * `mb-form.data` returns each element's `.data`, whose shape varies by control:
 * a bare string for `mb-input`, `{ code, value, terminology }` for coded ones,
 * and — the trap — `mb-search` keeps its coded value on `.data` while `.value`
 * stays empty, so reading `.value` would report a filled field as untouched.
 */
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasValue);
  }
  return true;
}
