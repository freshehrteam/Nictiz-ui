/**
 * How a stored FHIR Bundle names the patient it belongs to.
 *
 * Its own module for the same reason `identity.ts` is: `index.ts` calls
 * `app.listen()` at import time, so anything that needs to be unit-tested
 * cannot live there. This is pure — no fetch, no config, no server state.
 */

/**
 * The system under which a stored Bundle names its patient.
 *
 * A namespace of this deployment's own rather than openFHIR's document OID,
 * because it asserts something different: not "this document is identified as
 * X" but "this Bundle belongs to patient X here".
 */
export const PATIENT_LINK_SYSTEM = 'http://freshehr.local/fhir/bundle-patient-link';

/**
 * Stamps a Bundle with the patient it belongs to, so it can later be found.
 *
 * The tradeoff is real and deliberate. `Bundle.identifier` is 0..1 in R4 and
 * openFHIR already fills it with the document's own UUID, so writing the
 * patient link DISCARDS that document identity. It is accepted because nothing
 * in this app ever reads that UUID, while without a link the stored Bundles
 * carry no patient reference at all — `Composition.subject` is null and no
 * Patient resource is included — and are therefore undeletable. An
 * unattributable document is worse than an unidentified one.
 *
 * `entry` is passed through by reference, untouched. That is not an
 * optimisation: the openFHIR interceptor decides what to do with a POSTed
 * Bundle by sniffing the Composition entry, and leaving the array referentially
 * identical is what proves this function cannot re-trigger the composition
 * duplication `stripInterceptedProfile` exists to prevent.
 */
export function identifyBundleWithPatient(bundle: any, patientId: string): any {
  if (!bundle || typeof bundle !== 'object' || !patientId) return bundle;
  return { ...bundle, identifier: { system: PATIENT_LINK_SYSTEM, value: patientId } };
}
