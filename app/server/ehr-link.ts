/**
 * Adoption of the EHR that the stack's HAPI PatientInterceptor provisions.
 *
 * Every Patient POSTed to HAPI triggers `com.syntaric.hapi.PatientInterceptor`
 * (baked into the hapi-openfhir image), which creates an EHR in EHRbase and
 * writes its id back onto the Patient as an identifier. That EHR is the one
 * the openFHIR pipeline stores compositions into, so it is the canonical one —
 * the BFF must ADOPT it rather than create its own, or every patient ends up
 * with two EHRs and clinical data split across them (measured live before this
 * module existed).
 *
 * The interceptor's EHR is created with an empty body — no `external_ref` — so
 * adoption means rewriting its EHR_STATUS to carry the subject reference that
 * makes `GET /ehr?subject_id=…&subject_namespace=…` resolve. The pure halves
 * of that live here; the HTTP halves stay in index.ts.
 */

/**
 * Matched by suffix, not equality: the interceptor source writes
 * `http://openehr.org/NamingSystem/ehr-id`, but the JAR deployed in the stack
 * emits a malformed `http://https://openehr.org/NamingSystem/ehr-id`. Both
 * must resolve until the HAPI image is rebuilt, and the suffix is the part
 * that identifies the naming system either way.
 */
const EHR_ID_SYSTEM_SUFFIX = 'openehr.org/NamingSystem/ehr-id';

/**
 * The EHR id the HAPI interceptor stamped onto a Patient, or null when the
 * Patient carries none — which is what a stack without the interceptor
 * produces, and what tells the caller to provision an EHR itself.
 */
export function interceptorEhrId(patient: unknown): string | null {
  const identifiers = (patient as { identifier?: unknown })?.identifier;
  if (!Array.isArray(identifiers)) return null;

  for (const id of identifiers) {
    const system = typeof id?.system === 'string' ? id.system : '';
    const value = typeof id?.value === 'string' ? id.value : '';
    if (value && system.endsWith(EHR_ID_SYSTEM_SUFFIX)) return value;
  }
  return null;
}

/**
 * An existing EHR_STATUS rewritten to point at a patient.
 *
 * Returns the PUT body and the version uid to send as `If-Match`, or null when
 * the status carries no uid — without one the optimistic-locking PUT cannot be
 * made, and guessing a version would be worse than failing.
 *
 * The uid is STRIPPED from the body: `If-Match` is what carries the version in
 * an EHR_STATUS PUT, and a body uid naming the previous version is a seam for
 * the CDR to reject. Everything else (name, is_queryable, other_details, …) is
 * preserved as the interceptor created it — only `subject` is replaced.
 */
export function adoptedEhrStatus(
  status: unknown,
  subject: Record<string, unknown>,
): { body: Record<string, unknown>; versionUid: string } | null {
  const current = status as { uid?: { value?: unknown } } | null;
  const versionUid = typeof current?.uid?.value === 'string' ? current.uid.value : '';
  if (!versionUid) return null;

  const { uid: _uid, ...rest } = current as Record<string, unknown>;
  return { body: { ...rest, subject }, versionUid };
}
