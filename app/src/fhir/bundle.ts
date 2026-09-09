/**
 * FHIR Bundle client — the mapping half of the save pipeline.
 *
 * Three calls, in the order the pipeline makes them: map a composition to a
 * Bundle via openFHIR, store that Bundle, read it back by id. Everything goes
 * through the BFF; openFHIR has no CORS and no auth, so a direct browser call
 * is not an option regardless of credentials.
 *
 * The types below are DELIBERATELY MINIMAL. A full FHIR R4 model is a large
 * dependency for a viewer that reads a handful of fields, and every field this
 * app actually touches is optional in practice — a mapping that omits one must
 * degrade to "not recorded", not to a type error. So these describe the shape
 * this code navigates, not the specification.
 */

/** A coded value. Only the parts the viewer renders. */
export interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

/**
 * A reference to another resource.
 *
 * `reference` may be a `urn:uuid:` (what an IPS document Bundle uses between
 * its own entries) or a relative `Type/id`. `display` is the fallback when the
 * target is not in the Bundle at all.
 */
export interface Reference {
  reference?: string;
  display?: string;
}

export interface FhirResource {
  resourceType: string;
  id?: string;
  meta?: { profile?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

export interface BundleEntry {
  /** `urn:uuid:…` in a document Bundle; absent on some entries. */
  fullUrl?: string;
  resource?: FhirResource;
}

export interface FhirBundle {
  resourceType: 'Bundle';
  id?: string;
  type?: string;
  timestamp?: string;
  /**
   * The document's OWN identity, distinct from the server-assigned `id`.
   *
   * A document Bundle carries one, and it is what survives being copied
   * between servers — the `id` does not.
   */
  identifier?: { system?: string; value?: string };
  meta?: { profile?: string[]; [key: string]: unknown };
  entry?: BundleEntry[];
}

/**
 * Same contract as the other clients: surface the server's body verbatim.
 *
 * It matters more here than elsewhere. openFHIR reports mapping failures as
 * PLAIN TEXT, which the BFF wraps as `{ error: … }` precisely so this parses —
 * and the engine's own sentence ("Couldn't find a Context Mapper…") is the only
 * thing that says which mapping is missing.
 */
async function json<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 2000);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === 'string') detail = parsed.error;
    } catch {
      // Not JSON — the raw text is already the most useful thing to report.
    }
    throw new Error(`${context} failed (HTTP ${res.status}): ${detail}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * Maps a canonical composition to a FHIR Bundle.
 *
 * `canonical` is passed through untouched — openFHIR sniffs the payload shape
 * to decide how to read it, so reshaping it here would change the engine's
 * interpretation. The BFF wraps it into the Parameters envelope the engine's
 * `$tofhir` operation expects; this side stays a bare composition POST.
 */
export async function toFhir(templateId: string, canonical: unknown): Promise<FhirBundle> {
  return json<FhirBundle>(
    await fetch(`/api/openfhir/$tofhir?templateId=${encodeURIComponent(templateId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(canonical),
    }),
    'openFHIR mapping',
  );
}

/**
 * Stores a Bundle and returns its server-assigned id.
 *
 * The id is the whole point: it is what the summary route carries, so a
 * reload or a deep link re-reads the Bundle rather than depending on state
 * held in memory. The BFF strips the IPS Composition profile before storing —
 * see `stripInterceptedProfile` there for why that is not cosmetic.
 *
 * `patientId` is what makes the stored Bundle attributable. openFHIR emits no
 * patient reference of its own — `Composition.subject` is null and there is no
 * Patient resource — so without it the Bundle cannot later be found, and in
 * particular cannot be removed when the patient is deleted. It is optional so
 * that the endpoint stays backward-compatible; see `identifyBundleWithPatient`
 * in the BFF for what it costs.
 *
 * `compositionUid` names the composition this Bundle was mapped from, so the
 * compositions view can nest it under its source. Also optional — a Bundle
 * stored without it is listed but not attributed.
 */
export async function storeBundle(
  bundle: FhirBundle,
  patientId?: string,
  compositionUid?: string,
): Promise<string> {
  const params = new URLSearchParams();
  if (patientId) params.set('patientId', patientId);
  if (compositionUid) params.set('compositionUid', compositionUid);
  const query = params.size ? `?${params}` : '';
  const stored = await json<FhirBundle>(
    await fetch(`/api/fhir/Bundle${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
    }),
    'Bundle store',
  );

  if (!stored.id) {
    throw new Error('Bundle was stored but the server returned no id');
  }
  return stored.id;
}

export async function readBundle(id: string): Promise<FhirBundle> {
  return json<FhirBundle>(
    await fetch(`/api/fhir/Bundle/${encodeURIComponent(id)}`),
    'Bundle read',
  );
}

/**
 * One stored Bundle as a list row. Mirrors the BFF's `bundle-summaries.ts` —
 * the BFF reduces each stored document to these fields so the list never
 * pulls tens of kilobytes per row into the browser.
 */
export interface BundleSummary {
  id: string;
  type?: string;
  timestamp?: string;
  lastUpdated?: string;
  entryCount: number;
  title?: string;
  date?: string;
  /** The versioned composition uid this Bundle was mapped from, when stamped. */
  compositionUid?: string;
}

/**
 * Every stored Bundle naming this patient, newest first.
 *
 * Patient-linked, not EHR-linked — see `identifyBundleWithPatient` in the BFF
 * — so it answers even for a patient with no openEHR record yet.
 */
export async function listPatientBundles(patientId: string): Promise<BundleSummary[]> {
  const body = await json<{ bundles?: BundleSummary[] }>(
    await fetch(`/api/patients/${encodeURIComponent(patientId)}/bundles`),
    'Bundle list',
  );
  return body.bundles ?? [];
}
