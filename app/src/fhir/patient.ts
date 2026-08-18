/**
 * FHIR Patient → view model.
 *
 * Kept free of DOM and fetch so it can be unit-tested directly, and so the
 * seeding script and the SPA agree on what a patient looks like.
 *
 * FHIR's Patient is permissive in ways that matter here: `name` is a list of
 * HumanName, each with a list of `given`, any of which may be absent; `gender`
 * is optional; `birthDate` may be a partial date (`1974`, `1974-03`). Every
 * field below therefore degrades to something displayable rather than throwing.
 */

export interface FhirPatient {
  resourceType?: string;
  id?: string;
  identifier?: { system?: string; value?: string }[];
  name?: { use?: string; family?: string; given?: string[]; prefix?: string[] }[];
  gender?: string;
  birthDate?: string;
}

/** The naming system Dutch deployments register a BSN under. */
export const BSN_SYSTEM = 'http://fhir.nl/fhir/NamingSystem/bsn';

export interface PatientView {
  id: string;
  /** "Anna de Vries", or a clearly-marked fallback — never an empty string. */
  name: string;
  /** Initials for the avatar chip, e.g. "AV". */
  initials: string;
  /** Whole years at `asOf`, or undefined when birthDate is absent/unparsable. */
  age?: number;
  /** `male` | `female` | `other` | `unknown` | undefined. */
  sex?: string;
  birthDate?: string;
  /** First identifier value — the BSN in a Dutch deployment. */
  identifier?: string;
}

type HumanName = NonNullable<FhirPatient['name']>[number];

/** The name FHIR marks `official`, else the first one present. */
function preferredName(patient: FhirPatient): HumanName | undefined {
  const names = patient.name ?? [];
  return names.find((n) => n.use === 'official') ?? names[0];
}

export function formatName(patient: FhirPatient): string {
  const name = preferredName(patient);
  const given = (name?.given ?? []).filter(Boolean).join(' ');
  const full = [given, name?.family].filter(Boolean).join(' ').trim();
  return full || `(unnamed patient ${patient.id ?? '?'})`;
}

export function initialsOf(patient: FhirPatient): string {
  const name = preferredName(patient);
  const first = (name?.given ?? []).find(Boolean)?.[0];
  const last = name?.family?.[0];
  const initials = [first, last].filter(Boolean).join('').toUpperCase();
  return initials || '?';
}

/**
 * Whole years between `birthDate` and `asOf`.
 *
 * Partial FHIR dates (`1974`, `1974-03`) are padded to the first of the period,
 * which is the conventional reading and the only one that yields a number at
 * all. An unparsable or future date returns undefined rather than a negative
 * age — a wrong number is worse than a blank here.
 */
export function ageFrom(birthDate: string | undefined, asOf: Date = new Date()): number | undefined {
  if (!birthDate) return undefined;

  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(birthDate);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2] ?? '01') - 1;
  const day = Number(match[3] ?? '01');
  const born = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(born.getTime())) return undefined;

  let age = asOf.getUTCFullYear() - year;
  // Not yet had this year's birthday.
  const monthDiff = asOf.getUTCMonth() - month;
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getUTCDate() < day)) age -= 1;

  return age >= 0 ? age : undefined;
}

/**
 * The patient's BSN, or undefined.
 *
 * Matched on the naming SYSTEM, not simply "the first identifier with a value":
 * HAPI assigns its own internal identifier to a patient created without one, so
 * taking the first would display a UUID under a "BSN" label — a meaningless
 * number presented as a citizen service number, which is worse than a blank.
 */
export function bsnOf(patient: FhirPatient): string | undefined {
  return patient.identifier?.find((i) => i.system === BSN_SYSTEM && i.value)?.value;
}

export function toPatientView(patient: FhirPatient, asOf: Date = new Date()): PatientView {
  return {
    id: patient.id ?? '',
    name: formatName(patient),
    initials: initialsOf(patient),
    age: ageFrom(patient.birthDate, asOf),
    sex: patient.gender,
    birthDate: patient.birthDate,
    identifier: bsnOf(patient),
  };
}

/** Pulls Patient resources out of a FHIR searchset Bundle. */
export function patientsFromBundle(bundle: any): FhirPatient[] {
  return (bundle?.entry ?? [])
    .map((e: any) => e?.resource)
    .filter((r: any) => r?.resourceType === 'Patient');
}

// --- creating a patient -----------------------------------------------------

export interface PatientDraft {
  firstName: string;
  lastName: string;
  /** ISO `YYYY-MM-DD`, as an `<input type="date">` produces. */
  birthDate: string;
  gender: string;
  /** Optional — a patient may be unidentified, or foreign with no BSN. */
  bsn?: string;
}

/**
 * Validates a draft, returning one message per offending field.
 *
 * BSN is checked for SHAPE only — nine digits — not for the Dutch 11-test
 * checksum. That is a deliberate choice: the elfproef would reject the reserved
 * `999…` range used for test data, and this application seeds exactly such
 * patients. A transposed digit therefore passes; the trade is accepted so that
 * test and foreign identifiers remain enterable.
 */
export function validateDraft(draft: PatientDraft): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!draft.firstName.trim()) errors.firstName = 'First name is required.';
  if (!draft.lastName.trim()) errors.lastName = 'Last name is required.';

  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(draft.birthDate ?? '');
  if (!draft.birthDate) {
    errors.birthDate = 'Date of birth is required.';
  } else if (!date) {
    errors.birthDate = 'Date of birth must be a full date (YYYY-MM-DD).';
  } else {
    const [year, month, day] = date.slice(1).map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    // `Date` ROLLS OVER rather than rejecting: `1974-02-31` silently becomes
    // 3 March. Comparing the parts back is the only way to catch a date that
    // does not exist — otherwise an impossible DOB is stored as a plausible one.
    const rolled =
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day;

    if (rolled) errors.birthDate = 'That date does not exist.';
    else if (parsed.getTime() > Date.now()) {
      errors.birthDate = 'Date of birth cannot be in the future.';
    }
  }

  const bsn = (draft.bsn ?? '').replace(/\s/g, '');
  if (bsn && !/^\d{9}$/.test(bsn)) errors.bsn = 'A BSN is exactly 9 digits.';

  return errors;
}

/**
 * Builds the FHIR Patient resource for a validated draft.
 *
 * No `id` is set: the server assigns it, and that id is in turn what the EHR's
 * `subject.external_ref` carries — so the openEHR record is linked to whatever
 * FHIR decides to call this patient, never to a value invented here.
 */
export function draftToFhirPatient(draft: PatientDraft): FhirPatient & Record<string, unknown> {
  const bsn = (draft.bsn ?? '').replace(/\s/g, '');

  return {
    resourceType: 'Patient',
    ...(bsn ? { identifier: [{ system: BSN_SYSTEM, value: bsn }] } : {}),
    name: [
      {
        use: 'official',
        family: draft.lastName.trim(),
        // Middle names are typed into the same box, so split on whitespace:
        // FHIR models each given name as its own list entry.
        given: draft.firstName.trim().split(/\s+/).filter(Boolean),
      },
    ],
    gender: draft.gender || 'unknown',
    birthDate: draft.birthDate,
    active: true,
  };
}
