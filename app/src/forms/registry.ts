/**
 * Which templates this app can actually record against.
 *
 * Track B means forms are hand-written, so a template is recordable only when
 * someone has built fields for it — uploading an OPT to EHRbase does NOT make it
 * fillable here. That distinction used to be invisible: the compositions view
 * offered "New composition" for whatever template happened to be first on the
 * server, and the form then rendered EPS Patient Summary's fields regardless of
 * the template id it was given. The result bound EPS paths against a foreign
 * template — a form that looks complete and fails at save, or stores badly.
 *
 * This registry is the one place that knows the difference. The compositions
 * view lists every server template but only offers creation for the ids here,
 * and the form refuses to render for anything else.
 */

import { allergiesFields, ALLERGIES_SECTION, ALLERGIES_ENTRIES } from './allergies';
import { problemsFields, PROBLEMS_SECTION, PROBLEMS_ENTRIES } from './problems';
import { devicesFields, DEVICES_SECTION, DEVICES_ENTRIES } from './devices';
import { proceduresFields, PROCEDURES_SECTION, PROCEDURES_ENTRIES } from './procedures';
import type { SectionRenderContext } from './section-shell';

export interface FormSection {
  key: string;
  title: string;
  /** Shown beside the section title, as in the mockup. */
  archetype: string;
  /**
   * FLAT path of the section root, e.g. `…/eps_allergies`.
   *
   * The view needs this to infer a stored composition's mode from its keys and
   * to check whether the branch being switched away from holds data. Declaring
   * it here keeps the four path prefixes in one place instead of duplicating
   * them in the view.
   */
  sectionPath: string;
  /** FLAT path of the repeatable that holds real entries. */
  entriesPath: string;
  /**
   * Takes the section's mode plus a setter: which of the three branches is
   * mounted is form state, and only the view holds state.
   */
  render: (ctx: SectionRenderContext) => unknown;
}

export interface TemplateForm {
  templateId: string;
  /** Short label for lists, where the full template id is too long. */
  label: string;
  description: string;
  /** The composition archetype, shown on the context card. */
  rootArchetype: string;
  sections: FormSection[];
}

const EPS_PATIENT_SUMMARY: TemplateForm = {
  templateId: 'EPS Patient Summary',
  label: 'EPS Patient Summary',
  description: 'Allergies, problems, medical devices and procedures.',
  rootArchetype: 'openEHR-EHR-COMPOSITION.health_summary.v1',
  sections: [
    {
      key: 'allergies',
      title: 'Allergies & intolerances',
      archetype: 'openEHR-EHR-EVALUATION.adverse_reaction_risk.v2',
      sectionPath: ALLERGIES_SECTION,
      entriesPath: ALLERGIES_ENTRIES,
      render: allergiesFields,
    },
    {
      key: 'problems',
      title: 'Problems & diagnoses',
      archetype: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1',
      sectionPath: PROBLEMS_SECTION,
      entriesPath: PROBLEMS_ENTRIES,
      render: problemsFields,
    },
    {
      key: 'devices',
      title: 'Medical devices',
      archetype: 'openEHR-EHR-EVALUATION.device_summary.v0',
      sectionPath: DEVICES_SECTION,
      entriesPath: DEVICES_ENTRIES,
      render: devicesFields,
    },
    {
      key: 'procedures',
      title: 'History of procedures',
      archetype: 'openEHR-EHR-ACTION.procedure.v1',
      sectionPath: PROCEDURES_SECTION,
      entriesPath: PROCEDURES_ENTRIES,
      render: proceduresFields,
    },
  ],
};

/** Every template with a hand-written form, keyed by the id EHRbase knows. */
export const TEMPLATE_FORMS: Record<string, TemplateForm> = {
  [EPS_PATIENT_SUMMARY.templateId]: EPS_PATIENT_SUMMARY,
};

export function getTemplateForm(templateId: string): TemplateForm | undefined {
  return TEMPLATE_FORMS[templateId];
}

/** True when a form exists — i.e. a new composition may be started. */
export function isRecordable(templateId: string): boolean {
  return templateId in TEMPLATE_FORMS;
}

export function recordableTemplateIds(): string[] {
  return Object.keys(TEMPLATE_FORMS);
}
