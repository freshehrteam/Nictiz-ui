/**
 * Archetype-local code lists, extracted verbatim from the generated web
 * template (`fixtures/eps-patient-summary.webtemplate.json`).
 *
 * These are NOT terminology-server lookups — they are `at*` local terms defined
 * by the archetypes themselves, and their authoritative source is the template.
 * `mb-buttons` / `mb-select` render them directly.
 *
 * Every code below was cross-checked against the golden FLAT fixture, so the
 * options a user can pick are exactly the ones the CDR accepts.
 */

export interface CodeOption {
  code: string;
  label: string;
}

/** `|terminology` value for archetype-local terms. */
export const LOCAL_TERMINOLOGY = 'local';

export const CRITICALITY: CodeOption[] = [
  { code: 'at0102', label: 'Low' },
  { code: 'at0103', label: 'High' },
  { code: 'at0124', label: 'Indeterminate' },
];

export const VERIFICATION_STATUS: CodeOption[] = [
  { code: 'at0064', label: 'Unconfirmed' },
  { code: 'at0065', label: 'Confirmed' },
  { code: 'at0066', label: 'Refuted' },
];

export const ACTIVE_INACTIVE_STATUS: CodeOption[] = [
  { code: 'at0131', label: 'Active' },
  { code: 'at0132', label: 'Inactive' },
];

export const SEVERITY_OF_REACTION: CodeOption[] = [
  { code: 'at0011', label: 'Mild' },
  { code: 'at0012', label: 'Moderate' },
  { code: 'at0013', label: 'Severe' },
];

/**
 * Allergy category / reaction mechanism use *value-as-code* local terms
 * (code === label), unlike the `at*` lists. Preserved exactly as the template
 * defines them.
 */
export const ALLERGY_CATEGORY: CodeOption[] = [
  { code: 'Food', label: 'Food' },
  { code: 'Medication', label: 'Medication' },
  { code: 'Environment', label: 'Environment' },
  { code: 'Biologic', label: 'Biologic' },
];

export const REACTION_MECHANISM: CodeOption[] = [
  { code: 'Allergy', label: 'Allergy' },
  { code: 'Intolerance', label: 'Intolerance' },
];

// --- Problems -------------------------------------------------------------

export const PROBLEM_SEVERITY: CodeOption[] = [
  { code: 'at0047', label: 'Mild' },
  { code: 'at0048', label: 'Moderate' },
  { code: 'at0049', label: 'Severe' },
];

export const DIAGNOSTIC_CERTAINTY: CodeOption[] = [
  { code: 'at0074', label: 'Suspected' },
  { code: 'at0075', label: 'Probable' },
  { code: 'at0076', label: 'Confirmed' },
];

export const PROBLEM_ACTIVE_INACTIVE: CodeOption[] = [
  { code: 'at0026', label: 'Active' },
  { code: 'at0027', label: 'Inactive' },
];

export const RESOLUTION_PHASE: CodeOption[] = [
  { code: 'at0084', label: 'Resolved' },
  { code: 'at0097', label: 'Relapsed' },
];

export const REMISSION_STATUS: CodeOption[] = [{ code: 'at0090', label: 'In remission' }];

export const OCCURRENCE: CodeOption[] = [{ code: 'at0096', label: 'Recurrence' }];

// --- Medical devices ------------------------------------------------------

// --- Procedures -----------------------------------------------------------

/**
 * `procedure:n/ism_transition/careflow_step` — DV_CODED_TEXT.
 *
 * The template declares seven `ism_transition*` nodes on this ACTION, but only
 * the first carries this code list; the rest are unconstrained variants. The
 * form binds the first, which is also the one the golden fixture populates
 * (`…/ism_transition/careflow_step|code = at0041`).
 */
export const CAREFLOW_STEP: CodeOption[] = [
  { code: 'at0004', label: 'Procedure planned' },
  { code: 'at0038', label: 'Procedure postponed' },
  { code: 'at0039', label: 'Procedure cancelled' },
  { code: 'at0068', label: 'Procedure commenced' },
  { code: 'at0041', label: 'Procedure aborted' },
  { code: 'at0043', label: 'Procedure completed' },
];

// --- Composition context --------------------------------------------------

export const COMPOSITION_CATEGORY: CodeOption[] = [{ code: '433', label: 'event' }];

// --- Absence & exclusion statements ---------------------------------------

/**
 * The "nothing to record" statements, one pair per section.
 *
 * Unlike everything above these are DV_TEXT, not DV_CODED_TEXT: the web
 * template constrains them to a fixed list but stores the bare string, so they
 * render through `mb-text-select` with `mb-option value` carrying the literal
 * label — no `code`, no `terminology`, or the CDR rejects the payload.
 *
 * Values are verbatim from `fixtures/eps-patient-summary.webtemplate.json`
 * (the `inputs[].list[].value` of each ELEMENT's `value` child). Note
 * "No known food allergies", plural — matching the template, not prose.
 *
 * `reason_for_absence` is deliberately absent here: the template gives it no
 * list at all, so it stays free text.
 */
export const ALLERGY_GLOBAL_EXCLUSION: string[] = [
  'No known allergies',
  'No known medication allergies',
  'No known environmental allergies',
  'No known food allergies',
];

export const ALLERGY_ABSENCE_STATEMENT: string[] = ['No information about allergies'];

export const PROBLEM_GLOBAL_EXCLUSION: string[] = ['No known problems'];

export const PROBLEM_ABSENCE_STATEMENT: string[] = ['No information about current problems'];

/**
 * Medical devices has NO `exclusion_-_global` node — only absence of
 * information. That asymmetry is why the section shell makes the exclusion
 * branch optional rather than assuming all four sections match.
 */
export const DEVICE_ABSENCE_STATEMENT: string[] = ['No information about medical devices'];

export const PROCEDURE_GLOBAL_EXCLUSION: string[] = ['No known procedures'];

export const PROCEDURE_ABSENCE_STATEMENT: string[] = [
  'No information about past history of procedures',
];
