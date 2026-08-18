/**
 * The EPS profile, as data.
 *
 * A viewer that renders only what a Bundle happens to contain cannot tell the
 * reader what is MISSING — an absent Medication Summary looks exactly like a
 * section nobody thought to map. So the section spine here is static: it comes
 * from the profile, not from the document, and the document is laid over it.
 *
 * Source of truth is the machine-readable
 * `https://build.fhir.org/ig/hl7-eu/eps/` StructureDefinitions — the section
 * slices from `composition-eu-eps`, the element lists from the IG's obligation
 * profiles (`*-obl-eu-eps`), which mark exactly what a consumer SHOULD:display.
 * The HTML pages truncate their tables, so they are not the source.
 *
 * Deliberately inert: no I/O, no DOM, no knowledge of any Bundle. Everything
 * that touches an actual document lives in `eps-view.ts`.
 */

export interface EpsElement {
  /** FHIR element path relative to the resource, e.g. `reaction.manifestation`. */
  path: string;
  label: string;
  /** How to render the value once extracted. */
  kind:
    | 'code'
    | 'reference'
    | 'date'
    | 'period'
    | 'string'
    | 'boolean'
    | 'quantity'
    | 'backbone';
  /** Nested elements, for backbone kinds (`reaction`, `ingredient`, `dosage`…). */
  children?: EpsElement[];
  /**
   * True when the IG's obligation profile marks this element SHOULD:display.
   *
   * Recorded because it is a real fact about the spec and costs nothing to
   * carry, NOT because the view grades against it — the viewer makes no
   * conformance judgement. It exists for tests and for future use.
   */
  obliged?: boolean;
}

export interface EpsSectionSpec {
  /** The slice name in `composition-eu-eps`, e.g. `sectionProblems`. */
  slice: string;
  title: string;
  /** The section's LOINC code — the only reliable way to match a document section. */
  code: string;
  /**
   * The profile's cardinality floor.
   *
   * Kept for ordering and labelling ONLY. Nothing renders a conformance
   * verdict from it: a `min: 1` section the document omits is shown as "not
   * present", neutrally, exactly like a `min: 0` one.
   */
  min: 0 | 1;
  entryTypes: readonly string[];
}

/** Every section admits a DocumentReference, so it is appended to each list. */
const DOC_REF = 'DocumentReference';

/**
 * All 17 sections of `composition-eu-eps`, IN PROFILE ORDER.
 *
 * The order is the profile's, not alphabetical and not "what we can map" —
 * that is what makes this a view of the EPS rather than of our own pipeline.
 */
export const EPS_SECTIONS: readonly EpsSectionSpec[] = [
  {
    slice: 'sectionProblems',
    title: 'Problems',
    code: '11450-4',
    min: 1,
    entryTypes: ['Condition', DOC_REF],
  },
  {
    slice: 'sectionAllergies',
    title: 'Allergies and Intolerances',
    code: '48765-2',
    min: 1,
    entryTypes: ['AllergyIntolerance', DOC_REF],
  },
  {
    slice: 'sectionMedications',
    title: 'Medication Summary',
    code: '10160-0',
    min: 1,
    entryTypes: [
      'MedicationStatement',
      'MedicationRequest',
      'MedicationAdministration',
      'MedicationDispense',
      DOC_REF,
    ],
  },
  {
    slice: 'sectionImmunizations',
    title: 'Immunizations',
    code: '11369-6',
    min: 0,
    entryTypes: ['Immunization', DOC_REF],
  },
  {
    slice: 'sectionResults',
    title: 'Results',
    code: '30954-2',
    min: 0,
    entryTypes: ['Observation', 'DiagnosticReport', DOC_REF],
  },
  {
    slice: 'sectionProceduresHx',
    title: 'History of Procedures',
    code: '47519-4',
    min: 1,
    entryTypes: ['Procedure', DOC_REF],
  },
  {
    slice: 'sectionMedicalDevices',
    title: 'Medical Devices',
    code: '46264-8',
    min: 1,
    entryTypes: ['DeviceUseStatement', DOC_REF],
  },
  {
    slice: 'sectionAdvanceDirectives',
    title: 'Advance Directives',
    code: '42348-3',
    min: 0,
    entryTypes: ['Consent', DOC_REF],
  },
  {
    slice: 'sectionAlert',
    title: 'Alerts',
    code: '104605-1',
    min: 0,
    entryTypes: ['Flag', DOC_REF],
  },
  {
    slice: 'sectionFunctionalStatus',
    title: 'Functional Status',
    code: '47420-5',
    min: 0,
    entryTypes: ['Condition', 'ClinicalImpression', DOC_REF],
  },
  {
    slice: 'sectionPregnancyHx',
    title: 'History of Pregnancy',
    code: '10162-6',
    min: 0,
    entryTypes: ['Observation', DOC_REF],
  },
  {
    slice: 'sectionPatientStory',
    title: 'Patient Story',
    code: '81338-6',
    min: 0,
    entryTypes: [DOC_REF],
  },
  {
    slice: 'sectionPlanOfCare',
    title: 'Plan of Care',
    code: '18776-5',
    min: 0,
    entryTypes: ['CarePlan', 'ImmunizationRecommendation', DOC_REF],
  },
  {
    slice: 'sectionSocialHistory',
    title: 'Social History',
    code: '29762-2',
    min: 0,
    entryTypes: ['Observation', DOC_REF],
  },
  {
    slice: 'sectionVitalSigns',
    title: 'Vital Signs',
    code: '8716-3',
    min: 0,
    entryTypes: ['Observation', DOC_REF],
  },
  {
    slice: 'sectionTravelHx',
    title: 'Travel History',
    code: '10182-4',
    min: 0,
    entryTypes: ['Observation', DOC_REF],
  },
  {
    slice: 'sectionPatientHx',
    title: 'Patient History',
    code: '11329-0',
    min: 0,
    entryTypes: [DOC_REF],
  },
];

/** The Composition's own header elements — `type` is fixed to LOINC 60591-5. */
export const EPS_COMPOSITION_ELEMENTS: readonly EpsElement[] = [
  { path: 'identifier', label: 'Identifier', kind: 'string', obliged: true },
  { path: 'status', label: 'Status', kind: 'string', obliged: true },
  { path: 'type', label: 'Type', kind: 'code', obliged: true },
  { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
  { path: 'date', label: 'Date', kind: 'date', obliged: true },
  { path: 'author', label: 'Author', kind: 'reference', obliged: true },
  { path: 'title', label: 'Title', kind: 'string', obliged: true },
  { path: 'custodian', label: 'Custodian', kind: 'reference' },
  { path: 'attester', label: 'Attester', kind: 'backbone' },
  { path: 'language', label: 'Language', kind: 'string' },
];

/**
 * The elements shown per resource type.
 *
 * `obliged: true` marks the IG's SHOULD:display floor. The rest are elements
 * OUR OWN mapping populates but the obligation profiles do not mention —
 * `Procedure` obliges 3 elements while our Bundle carries 14, `Device` obliges
 * only `type` while carrying 13. Listing them here is what gives them a proper
 * label and ordering; anything still unlisted is caught by the view's residual
 * pass, so no key in the Bundle can be dropped silently either way.
 */
export const EPS_ELEMENTS: Readonly<Record<string, readonly EpsElement[]>> = {
  AllergyIntolerance: [
    { path: 'clinicalStatus', label: 'Clinical status', kind: 'code', obliged: true },
    { path: 'verificationStatus', label: 'Verification status', kind: 'code' },
    { path: 'type', label: 'Type', kind: 'string', obliged: true },
    { path: 'category', label: 'Category', kind: 'string' },
    { path: 'criticality', label: 'Criticality', kind: 'string' },
    { path: 'code', label: 'Substance', kind: 'code', obliged: true },
    { path: 'patient', label: 'Patient', kind: 'reference', obliged: true },
    { path: 'onset[x]', label: 'Onset', kind: 'date', obliged: true },
    { path: 'lastOccurrence', label: 'Last occurrence', kind: 'date' },
    { path: 'note', label: 'Note', kind: 'string' },
    {
      path: 'reaction',
      label: 'Reaction',
      kind: 'backbone',
      obliged: true,
      children: [
        { path: 'substance', label: 'Substance', kind: 'code' },
        { path: 'manifestation', label: 'Manifestation', kind: 'code', obliged: true },
        { path: 'description', label: 'Description', kind: 'string' },
        { path: 'onset', label: 'Onset', kind: 'date' },
        { path: 'severity', label: 'Severity', kind: 'string', obliged: true },
        { path: 'exposureRoute', label: 'Exposure route', kind: 'code' },
        { path: 'note', label: 'Note', kind: 'string' },
      ],
    },
  ],

  Condition: [
    { path: 'clinicalStatus', label: 'Clinical status', kind: 'code', obliged: true },
    { path: 'verificationStatus', label: 'Verification status', kind: 'code' },
    { path: 'category', label: 'Category', kind: 'code', obliged: true },
    { path: 'severity', label: 'Severity', kind: 'code', obliged: true },
    { path: 'code', label: 'Problem', kind: 'code', obliged: true },
    { path: 'bodySite', label: 'Body site', kind: 'code' },
    { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
    { path: 'onset[x]', label: 'Onset', kind: 'date', obliged: true },
    { path: 'abatementDateTime', label: 'Abatement', kind: 'date' },
    {
      path: 'stage',
      label: 'Stage',
      kind: 'backbone',
      children: [
        { path: 'summary', label: 'Summary', kind: 'code' },
        { path: 'type', label: 'Type', kind: 'code' },
        { path: 'assessment', label: 'Assessment', kind: 'reference' },
      ],
    },
    {
      path: 'evidence',
      label: 'Evidence',
      kind: 'backbone',
      children: [
        { path: 'code', label: 'Code', kind: 'code' },
        { path: 'detail', label: 'Detail', kind: 'reference' },
      ],
    },
    { path: 'note', label: 'Note', kind: 'string' },
  ],

  MedicationStatement: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'medication[x]', label: 'Medication', kind: 'code', obliged: true },
    { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
    { path: 'effective[x]', label: 'Effective', kind: 'period', obliged: true },
    {
      path: 'dosage',
      label: 'Dosage',
      kind: 'backbone',
      obliged: true,
      children: [
        { path: 'text', label: 'Text', kind: 'string', obliged: true },
        { path: 'timing', label: 'Timing', kind: 'string', obliged: true },
        { path: 'route', label: 'Route', kind: 'code' },
        { path: 'doseAndRate', label: 'Dose and rate', kind: 'quantity' },
      ],
    },
    { path: 'note', label: 'Note', kind: 'string' },
  ],

  MedicationRequest: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'intent', label: 'Intent', kind: 'string' },
    { path: 'medication[x]', label: 'Medication', kind: 'code', obliged: true },
    { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
    { path: 'authoredOn', label: 'Authored on', kind: 'date' },
    {
      path: 'dosageInstruction',
      label: 'Dosage instruction',
      kind: 'backbone',
      obliged: true,
      children: [
        { path: 'text', label: 'Text', kind: 'string', obliged: true },
        { path: 'timing', label: 'Timing', kind: 'string', obliged: true },
        { path: 'route', label: 'Route', kind: 'code' },
        { path: 'doseAndRate', label: 'Dose and rate', kind: 'quantity' },
      ],
    },
  ],

  Medication: [
    { path: 'code', label: 'Medication', kind: 'code', obliged: true },
    { path: 'form', label: 'Form', kind: 'code', obliged: true },
    {
      path: 'ingredient',
      label: 'Ingredient',
      kind: 'backbone',
      obliged: true,
      children: [
        { path: 'item[x]', label: 'Item', kind: 'code', obliged: true },
        { path: 'strength', label: 'Strength', kind: 'quantity', obliged: true },
      ],
    },
  ],

  Immunization: [
    { path: 'status', label: 'Status', kind: 'string', obliged: true },
    { path: 'vaccineCode', label: 'Vaccine', kind: 'code', obliged: true },
    { path: 'patient', label: 'Patient', kind: 'reference', obliged: true },
    { path: 'occurrence[x]', label: 'Occurrence', kind: 'date', obliged: true },
    { path: 'lotNumber', label: 'Lot number', kind: 'string' },
    { path: 'site', label: 'Site', kind: 'code' },
    { path: 'route', label: 'Route', kind: 'code' },
    { path: 'note', label: 'Note', kind: 'string' },
  ],

  Procedure: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'statusReason', label: 'Status reason', kind: 'code' },
    { path: 'category', label: 'Category', kind: 'code' },
    { path: 'code', label: 'Procedure', kind: 'code', obliged: true },
    { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
    { path: 'performed[x]', label: 'Performed', kind: 'date', obliged: true },
    { path: 'reasonCode', label: 'Reason', kind: 'code' },
    { path: 'bodySite', label: 'Body site', kind: 'code' },
    { path: 'outcome', label: 'Outcome', kind: 'code' },
    { path: 'complication', label: 'Complication', kind: 'code' },
    { path: 'note', label: 'Note', kind: 'string' },
    {
      path: 'focalDevice',
      label: 'Focal device',
      kind: 'backbone',
      children: [
        { path: 'action', label: 'Action', kind: 'code' },
        { path: 'manipulated', label: 'Manipulated', kind: 'reference' },
      ],
    },
    { path: 'usedReference', label: 'Device used', kind: 'reference' },
    { path: 'usedCode', label: 'Device used (coded)', kind: 'code' },
  ],

  DeviceUseStatement: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
    { path: 'timing[x]', label: 'Timing', kind: 'period', obliged: true },
    { path: 'device', label: 'Device', kind: 'reference', obliged: true },
    { path: 'bodySite', label: 'Body site', kind: 'code', obliged: true },
    { path: 'note', label: 'Note', kind: 'string' },
  ],

  Device: [
    { path: 'identifier', label: 'Identifier', kind: 'string' },
    {
      path: 'udiCarrier',
      label: 'UDI carrier',
      kind: 'backbone',
      children: [
        { path: 'deviceIdentifier', label: 'Device identifier', kind: 'string' },
        { path: 'carrierHRF', label: 'Human-readable form', kind: 'string' },
        { path: 'issuer', label: 'Issuer', kind: 'string' },
      ],
    },
    { path: 'distinctIdentifier', label: 'Distinct identifier', kind: 'string' },
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'type', label: 'Type', kind: 'code', obliged: true },
    { path: 'deviceName', label: 'Name', kind: 'backbone', children: [
      { path: 'name', label: 'Name', kind: 'string' },
      { path: 'type', label: 'Name type', kind: 'string' },
    ] },
    { path: 'manufacturer', label: 'Manufacturer', kind: 'string' },
    { path: 'manufactureDate', label: 'Manufacture date', kind: 'date' },
    { path: 'expirationDate', label: 'Expiration date', kind: 'date' },
    { path: 'lotNumber', label: 'Lot number', kind: 'string' },
    { path: 'serialNumber', label: 'Serial number', kind: 'string' },
    { path: 'modelNumber', label: 'Model number', kind: 'string' },
    {
      path: 'version',
      label: 'Version',
      kind: 'backbone',
      children: [
        { path: 'type', label: 'Type', kind: 'code' },
        { path: 'value', label: 'Value', kind: 'string' },
      ],
    },
    { path: 'patient', label: 'Patient', kind: 'reference' },
    { path: 'note', label: 'Note', kind: 'string' },
  ],

  Flag: [
    { path: 'extension', label: 'Extension', kind: 'string', obliged: true },
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'category', label: 'Category', kind: 'code', obliged: true },
    { path: 'code', label: 'Code', kind: 'code', obliged: true },
    { path: 'subject', label: 'Subject', kind: 'reference', obliged: true },
    { path: 'period', label: 'Period', kind: 'period' },
  ],

  Patient: [
    { path: 'identifier', label: 'Identifier', kind: 'string', obliged: true },
    {
      path: 'name',
      label: 'Name',
      kind: 'backbone',
      obliged: true,
      children: [
        { path: 'use', label: 'Use', kind: 'string', obliged: true },
        { path: 'text', label: 'Text', kind: 'string', obliged: true },
        { path: 'family', label: 'Family', kind: 'string', obliged: true },
        { path: 'given', label: 'Given', kind: 'string', obliged: true },
      ],
    },
    { path: 'telecom', label: 'Telecom', kind: 'string', obliged: true },
    { path: 'gender', label: 'Gender', kind: 'string', obliged: true },
    { path: 'birthDate', label: 'Date of birth', kind: 'date', obliged: true },
    { path: 'address', label: 'Address', kind: 'string', obliged: true },
    {
      path: 'generalPractitioner',
      label: 'General practitioner',
      kind: 'reference',
      obliged: true,
    },
  ],

  Practitioner: [
    { path: 'identifier', label: 'Identifier', kind: 'string' },
    {
      path: 'name',
      label: 'Name',
      kind: 'backbone',
      obliged: true,
      children: [
        { path: 'family', label: 'Family', kind: 'string', obliged: true },
        { path: 'given', label: 'Given', kind: 'string', obliged: true },
      ],
    },
    { path: 'telecom', label: 'Telecom', kind: 'string', obliged: true },
    { path: 'address', label: 'Address', kind: 'string', obliged: true },
  ],

  Organization: [
    { path: 'identifier', label: 'Identifier', kind: 'string' },
    { path: 'name', label: 'Name', kind: 'string', obliged: true },
    { path: 'telecom', label: 'Telecom', kind: 'string', obliged: true },
    { path: 'address', label: 'Address', kind: 'string', obliged: true },
  ],

  PractitionerRole: [
    { path: 'practitioner', label: 'Practitioner', kind: 'reference' },
    { path: 'organization', label: 'Organization', kind: 'reference', obliged: true },
    { path: 'code', label: 'Role', kind: 'code' },
    { path: 'specialty', label: 'Specialty', kind: 'code' },
  ],

  Observation: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'category', label: 'Category', kind: 'code' },
    { path: 'code', label: 'Code', kind: 'code' },
    { path: 'subject', label: 'Subject', kind: 'reference' },
    { path: 'effective[x]', label: 'Effective', kind: 'date' },
    { path: 'value[x]', label: 'Value', kind: 'quantity' },
    { path: 'note', label: 'Note', kind: 'string' },
  ],

  Consent: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'scope', label: 'Scope', kind: 'code' },
    { path: 'category', label: 'Category', kind: 'code' },
    { path: 'patient', label: 'Patient', kind: 'reference' },
    { path: 'dateTime', label: 'Date', kind: 'date' },
  ],

  DocumentReference: [
    { path: 'status', label: 'Status', kind: 'string' },
    { path: 'type', label: 'Type', kind: 'code' },
    { path: 'subject', label: 'Subject', kind: 'reference' },
    { path: 'date', label: 'Date', kind: 'date' },
    { path: 'description', label: 'Description', kind: 'string' },
  ],
};

/** The element list for a type, or `[]` when the model has never heard of it. */
export function elementsFor(resourceType: string): readonly EpsElement[] {
  return EPS_ELEMENTS[resourceType] ?? [];
}

/**
 * Trimmed, lower-cased, punctuation-insensitive — the form titles are compared in.
 *
 * `&` becomes `and` before the punctuation is stripped, and the resulting
 * standalone `and` is then dropped: a title differing from the spec's only by
 * "Allergies & Intolerances" versus "Allergies and Intolerances" is the same
 * section, and treating it as an unrecognised one would push a mapped section
 * into the "not in profile" bucket over a typographic choice.
 *
 * Only ever a FALLBACK. Titles are free text and differ between mappings
 * ("Medical Devices and Implants" for the spec's "Medical Devices"), which is
 * why the code match is tried first.
 */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_CODE = new Map(EPS_SECTIONS.map((section) => [section.code, section]));
const BY_TITLE = new Map(
  EPS_SECTIONS.map((section) => [normaliseTitle(section.title), section]),
);

/**
 * Which spec section a document section is, by LOINC code then by title.
 *
 * Code first because it is the only stable identity: our own openFHIR output
 * titles the devices section "Medical Devices and Implants" while carrying the
 * spec's `46264-8`. `undefined` means the section is not part of the profile —
 * the caller surfaces it as an extra rather than discarding it.
 */
export function sectionSpecFor(
  code: string | undefined,
  title: string | undefined,
): EpsSectionSpec | undefined {
  if (code) {
    const byCode = BY_CODE.get(code);
    if (byCode) return byCode;
  }

  if (title) {
    const byTitle = BY_TITLE.get(normaliseTitle(title));
    if (byTitle) return byTitle;
  }

  return undefined;
}
