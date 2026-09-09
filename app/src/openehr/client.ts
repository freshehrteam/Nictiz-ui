/**
 * openEHR client. Talks only to the BFF — never directly to EHRbase — so no
 * credentials and no CORS concerns reach the browser.
 */

export type FlatComposition = Record<string, unknown>;

export interface HealthStatus {
  ehrbase: string;
  fhir: string;
  openfhir: string;
  /** Hades, the stack's FHIR terminology server (SNOMED CT / LOINC). */
  hades: string;
  templates: string[];
  ehrbaseBase?: string;
  fhirBase?: string;
  openfhirBase?: string;
  hadesBase?: string;
  ehrbaseDetail?: string;
  fhirDetail?: string;
  openfhirDetail?: string;
  hadesDetail?: string;
  /** Engine version reported by openFHIR's `/status`, when reachable. */
  openfhirVersion?: string;
  /** Hermes release from Hades' CapabilityStatement, when reachable. */
  hadesVersion?: string;
}

export interface Stats {
  templates: number;
  templateIds: string[];
  ehrs: number;
  compositions: number;
  patients: number;
}

export interface CompositionSummary {
  uid: string;
  name: string;
  startTime: string;
  templateId: string;
}

export interface TemplateGroup {
  templateId: string;
  count: number;
  compositions: CompositionSummary[];
}

export interface CompositionResult {
  uid: string;
  raw: any;
}

async function json<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    // EHRbase returns a useful validation body on 422 — surface it verbatim
    // rather than collapsing it to a status code.
    throw new Error(`${context} failed (HTTP ${res.status}): ${text.slice(0, 2000)}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function getHealth(): Promise<HealthStatus> {
  return json<HealthStatus>(await fetch('/api/health'), 'health check');
}

export async function getStats(): Promise<Stats> {
  return json<Stats>(await fetch('/api/stats'), 'stats');
}

export async function listTemplates(): Promise<string[]> {
  const body = await json<{ templates: string[] }>(await fetch('/api/templates'), 'template list');
  return body.templates ?? [];
}

/**
 * The web template for one template id, fetched at runtime.
 *
 * This is what makes the app work for any uploaded template rather than only
 * the committed fixture — see the BFF route for the `Accept` header that does it.
 */
export async function getWebTemplate(templateId: string): Promise<any> {
  return json<any>(
    await fetch(`/api/templates/${encodeURIComponent(templateId)}/webtemplate`),
    'web template fetch',
  );
}

/**
 * Pulls the readable part out of an EHRbase template response.
 *
 * That endpoint answers in XML, and both outcomes wrap the interesting text in
 * an envelope: errors as `<message>…</message>` (alongside an `<error>` code),
 * success as the bare template id. Showing the raw envelope to a user is noise,
 * so unwrap it when we recognise it and fall back to the trimmed body when we
 * don't — an unfamiliar shape is still better surfaced than swallowed.
 */
function templateResponseText(body: string): string {
  return body.match(/<message>([\s\S]*?)<\/message>/)?.[1].trim() || body.trim();
}

/** Uploads an OPT (XML). Returns EHRbase's response body as text. */
export async function uploadTemplate(xml: string): Promise<string> {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Template upload failed (HTTP ${res.status}): ${templateResponseText(text).slice(0, 1000)}`,
    );
  }
  return templateResponseText(text);
}

export async function getGoldenFixture(): Promise<FlatComposition> {
  return json<FlatComposition>(await fetch('/api/golden'), 'golden fixture fetch');
}

/** Compositions in one EHR, flat and grouped by template. */
export async function listCompositions(
  ehrId: string,
): Promise<{ compositions: CompositionSummary[]; groups: TemplateGroup[] }> {
  const body = await json<{ compositions: CompositionSummary[]; groups: TemplateGroup[] }>(
    await fetch(`/api/ehr/${encodeURIComponent(ehrId)}/compositions`),
    'composition list',
  );
  return { compositions: body.compositions ?? [], groups: body.groups ?? [] };
}

/** Creates an EHR, optionally linked to a FHIR patient. */
export async function createEhr(patientId?: string): Promise<string> {
  const body = await json<any>(
    await fetch('/api/ehr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patientId ? { patientId } : {}),
    }),
    'EHR creation',
  );
  const ehrId = body?.ehr_id?.value ?? body?.ehrId;
  if (!ehrId) {
    throw new Error(`EHR creation returned no ehr_id: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return ehrId;
}

/** Stores a composition. `templateId` is per request, never a server constant. */
export async function postComposition(
  ehrId: string,
  templateId: string,
  flat: FlatComposition,
): Promise<CompositionResult> {
  const raw = await json<any>(
    await fetch(
      `/api/ehr/${encodeURIComponent(ehrId)}/composition?templateId=${encodeURIComponent(templateId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flat),
      },
    ),
    'composition POST',
  );
  return { uid: extractUid(raw), raw };
}

/**
 * Stores a NEW VERSION of an existing composition.
 *
 * Editing a loaded composition cannot go through `postComposition`: the FLAT
 * read-back carries the composition's own `_uid`, and re-POSTing that is a
 * create with an id EHRbase already knows, which it refuses with
 * `412 … already exists`.
 *
 * `_uid` is stripped before sending. The uid belongs in the URL and the
 * `If-Match` header, which the BFF derives from `uid`; leaving it in the body
 * as well makes the payload assert its own identity, and EHRbase treats that
 * as a conflicting id rather than as a no-op.
 */
export async function updateComposition(
  ehrId: string,
  templateId: string,
  uid: string,
  flat: FlatComposition,
): Promise<CompositionResult> {
  const body = Object.fromEntries(
    Object.entries(flat).filter(([key]) => !key.endsWith('/_uid')),
  );

  const raw = await json<any>(
    await fetch(
      `/api/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(uid)}` +
        `?templateId=${encodeURIComponent(templateId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    'composition PUT',
  );
  return { uid: extractUid(raw), raw };
}

/**
 * With `format=FLAT` and `Prefer: return=representation`, EHRbase returns the
 * composition as a FLAT object — the uid is the `<root>/_uid` key, NOT the
 * canonical-format `uid.value`. Both shapes are handled so the client keeps
 * working if the representation preference changes.
 */
function extractUid(raw: any): string {
  if (typeof raw?.uid?.value === 'string') return raw.uid.value;
  if (typeof raw?.uid === 'string') return raw.uid;

  const flatUid = Object.entries(raw ?? {}).find(([k]) => k.endsWith('/_uid'));
  if (typeof flatUid?.[1] === 'string') return flatUid[1];

  throw new Error(
    `composition POST succeeded but no uid was found in the response (keys: ${Object.keys(raw ?? {})
      .slice(0, 5)
      .join(', ')}…)`,
  );
}

export async function getComposition(ehrId: string, uid: string): Promise<FlatComposition> {
  return json<FlatComposition>(
    await fetch(`/api/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(uid)}`),
    'composition GET',
  );
}

/**
 * The same composition in CANONICAL form (`_type: COMPOSITION`).
 *
 * A second representation, not a replacement for `getComposition`: openFHIR
 * deduces the payload type from its shape, and the canonical form is what makes
 * it map the full RM structure. The FLAT read-back stays the input to the save
 * diff, which compares FLAT keys and would break on this shape.
 *
 * Typed as `unknown` deliberately — nothing here inspects the canonical body,
 * it is only handed to the mapping engine, and inventing an RM type for it
 * would be a fiction this app never validates.
 */
export async function getCompositionCanonical(ehrId: string, uid: string): Promise<unknown> {
  return json<unknown>(
    await fetch(
      `/api/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(uid)}?format=canonical`,
    ),
    'canonical composition GET',
  );
}
