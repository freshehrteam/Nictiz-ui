/**
 * BFF for the Nictiz openEHR EMR.
 *
 * Mandatory, not a convenience. The stack configures no CORS anywhere, and
 * EHRbase is behind HTTP Basic auth that must never reach the browser. This
 * process is the only thing holding credentials, and it gives the SPA a stable
 * same-origin base URL for both back ends.
 *
 * It fronts three servers:
 *   EHRbase 2.28  — compositions, EHRs, templates, AQL
 *   HAPI FHIR R4  — Patient demographics, and the mapped Patient Summary Bundles
 *   openFHIR      — FHIR Connect mapping (openEHR composition -> FHIR Bundle)
 *
 * SECURITY: this process performs NO authentication of its own. Every request
 * runs as one shared EHRbase credential, so anything that can reach this port
 * can read and write every record.
 *
 * That is safe only because of where it is deployed. In the Hetzner deployment
 * the ingress gates the entire host with nginx basic-auth, so an unauthenticated
 * request never arrives. Locally there is no gate at all — do not expose this
 * port beyond localhost without one. `requireUpstreamAuth` below turns the
 * assumption into an enforced invariant rather than a comment. See README.
 */

import express from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { callerIdentity, type HeaderBag } from './identity';

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, '../../.env') });

const EHRBASE_BASE =
  process.env.EHRBASE_BASE ?? 'http://localhost:8082/ehrbase/rest/openehr/v1';
const FHIR_BASE = process.env.FHIR_BASE ?? 'http://localhost:8080/fhir';
const OPENFHIR_BASE = process.env.OPENFHIR_BASE ?? 'http://localhost:8083';
const AUTH_USER = process.env.EHRBASE_AUTH_USER ?? 'ehrbase-user';
const AUTH_PASSWORD = process.env.EHRBASE_AUTH_PASSWORD ?? 'SuperSecretPassword';
const PORT = Number(process.env.PORT ?? 3001);
const ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

/**
 * Where the built SPA lives, when this process is also serving it.
 *
 * In the container the SPA and the BFF are one image and one process: the SPA
 * is then same-origin with its own API by construction, which is why no CORS
 * configuration is needed there. In local dev Vite serves the SPA on :5173 and
 * proxies /api here, so this stays unset and the CORS header above does the job.
 */
const STATIC_DIR = process.env.STATIC_DIR ?? '';

/**
 * Where the golden FLAT fixture lives (served by /api/golden).
 *
 * Configurable because the layout differs between the two ways this runs. In
 * the repo `server/` sits at `app/server/`, so `../../fixtures` is the repo
 * root. In the container `server/` is at `/app/server/`, where the same
 * relative path resolves to `/fixtures` — which does not exist, and the
 * endpoint 500s. The default preserves the repo layout; the image sets this.
 */
const FIXTURES_DIR = process.env.FIXTURES_DIR ?? resolve(here, '../../fixtures');

/**
 * Refuse to serve unless an authenticating proxy is definitely in front.
 *
 * Set to "true" in any deployed environment. It converts the deployment's
 * central assumption — "nothing reaches us unauthenticated" — from a comment
 * into a startup check plus a per-request check, so a misconfigured ingress
 * fails closed (503/401) instead of silently publishing the whole CDR.
 */
const REQUIRE_AUTH = /^(1|true|yes)$/i.test(process.env.REQUIRE_AUTH ?? '');

/**
 * Header naming the authenticated user, set by the proxy.
 *
 * nginx basic-auth exposes the verified username as `$remote_user`, which the
 * ingress forwards as `X-Auth-Request-User` — the same header oauth2-proxy and
 * most OIDC forward-auth proxies emit. Keeping that contract means swapping
 * basic-auth for a real IdP needs no change in this file.
 */
const AUTH_USER_HEADER = (process.env.AUTH_USER_HEADER ?? 'x-auth-request-user').toLowerCase();
const AUTH_EMAIL_HEADER = (process.env.AUTH_EMAIL_HEADER ?? 'x-auth-request-email').toLowerCase();

/**
 * Whether to read the caller's identity from the inbound `Authorization` header.
 *
 * ingress-nginx's basic-auth verifies credentials and then passes the original
 * `Authorization` header through to the upstream unchanged. It does NOT emit an
 * identity header of its own: forwarding `$remote_user` requires the
 * `auth-snippet` annotation, which since v1.9 needs `allow-snippet-annotations`
 * flipped on AND `annotations-risk-level: Critical` — two CLUSTER-WIDE
 * relaxations that apply to every Ingress in the cluster, not just this one.
 * Weakening a shared controller to move one username is the wrong trade.
 *
 * So the username is parsed from `Authorization` instead. This is a READ of a
 * credential nginx has ALREADY verified — the request cannot reach here without
 * having passed basic-auth — so it is an identity lookup, not an auth decision.
 * The password half is deliberately never examined.
 */
const TRUST_BASIC_AUTH = /^(1|true|yes)$/i.test(process.env.TRUST_BASIC_AUTH ?? '');

/**
 * Display name when the proxy authenticated someone but told us no name.
 *
 * Ingress basic-auth is a SHARED credential, so this is a deployment identity,
 * not a person. It is deliberately not a plausible human name: a composition in
 * the CDR should not look like it was recorded by a specific clinician when the
 * system cannot actually tell who was at the keyboard.
 */
const DEFAULT_USER_NAME = process.env.DEFAULT_USER_NAME ?? 'Demo User';

/**
 * The namespace under which an EHR's subject points at a FHIR Patient. It is
 * half of the lookup key: `GET /ehr?subject_id=<id>&subject_namespace=fhir`.
 * Changing it orphans every EHR already linked, so it lives in one place.
 */
const FHIR_NAMESPACE = 'fhir';

const authHeader =
  'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`).toString('base64');

const app = express();

/**
 * Never cache API responses.
 *
 * Express sets an `ETag` on every JSON response, so the browser revalidates and
 * happily reuses a cached body — and a SPA that has just created a patient then
 * re-reads a patient list that does not contain them. The same applies to
 * composition lists after a save.
 *
 * Every route here is a live read of clinical data whose whole value is being
 * current, so caching is disabled globally rather than per route.
 */
app.set('etag', false);
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * Liveness/readiness, deliberately BEFORE the auth guard.
 *
 * Kubernetes probes are not authenticated callers. If this sat behind
 * `requireUpstreamAuth` every probe would 401, the Deployment would never go
 * ready, and the rollout would fail with a symptom that looks nothing like its
 * cause. It reports only that the process is up — no stack state, nothing worth
 * gating.
 */
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

/** Binds this process's header configuration to the shared resolver. */
function identityOf(req: express.Request): string | null {
  return callerIdentity(
    req.headers as HeaderBag,
    { user: AUTH_USER_HEADER, email: AUTH_EMAIL_HEADER },
    TRUST_BASIC_AUTH,
  );
}

/**
 * Enforces that an authenticating proxy is in front of us.
 *
 * When REQUIRE_AUTH is on, a request must arrive carrying the proxy's identity
 * header. A request without it did not come through the ingress — it reached
 * this port directly (a misrouted Service, a port-forward, a NetworkPolicy gap)
 * — and serving it would mean answering an unauthenticated caller with the full
 * contents of the CDR.
 *
 * The fail-closed direction matters: the wrong behaviour here is to serve, not
 * to refuse, so an ingress that stops forwarding the header breaks the app
 * loudly instead of quietly removing the only access control there is.
 */
function requireUpstreamAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!REQUIRE_AUTH) return next();

  if (!identityOf(req)) {
    res.status(401).json({
      error: 'Unauthenticated',
      detail:
        'No proxy identity present. This service must be reached through the ' +
        'authenticating ingress, not directly.',
    });
    return;
  }
  next();
}

app.use(express.json({ limit: '10mb' }));
// OPT uploads are XML, not JSON — parsed as raw text and forwarded verbatim.
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/**
 * Mounted AFTER the CORS middleware on purpose.
 *
 * A CORS preflight is an unauthenticated OPTIONS request by specification — the
 * browser sends no custom headers on it, so it can never satisfy the guard.
 * Ahead of CORS it would 401 every preflight and break the dev setup entirely;
 * behind it, the preflight is answered 204 and the real request that follows is
 * the one that gets checked.
 */
app.use(requireUpstreamAuth);

/**
 * Single place where EHRbase URLs are built. Template ids contain spaces
 * (`EPS Patient Summary`), so encoding lives here and nowhere else.
 */
function ehrbaseUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(`${EHRBASE_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

function fhirUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(`${FHIR_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

async function forward(
  res: express.Response,
  url: string,
  init: RequestInit = {},
): Promise<void> {
  try {
    const upstream = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });

    const body = await upstream.text();
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') ?? 'application/json');
    res.send(body);
  } catch (err) {
    // Stack down is the common case — say so plainly instead of a bare 500.
    res.status(502).json({
      error: 'Cannot reach EHRbase',
      detail: (err as Error).message,
      hint: `Is the stack up? Expected EHRbase at ${EHRBASE_BASE}`,
    });
  }
}

/** FHIR is unauthenticated in this stack, so it gets its own forwarder. */
async function forwardFhir(
  res: express.Response,
  url: string,
  init: RequestInit = {},
): Promise<void> {
  try {
    const upstream = await fetch(url, {
      ...init,
      headers: { Accept: 'application/fhir+json', ...(init.headers ?? {}) },
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') ?? 'application/fhir+json');
    res.send(body);
  } catch (err) {
    res.status(502).json({
      error: 'Cannot reach the FHIR server',
      detail: (err as Error).message,
      hint: `Is the stack up? Expected HAPI FHIR at ${FHIR_BASE}`,
    });
  }
}

/**
 * openFHIR forwarder.
 *
 * Separate from `forward()` for two reasons. It must NOT inject EHRbase's Basic
 * auth — openFHIR has no auth and would reject the header — and, more
 * importantly, **openFHIR answers errors in plain text**, not JSON: the engine
 * does `ResponseEntity.badRequest().body(e.getMessage())`, so a mapping failure
 * arrives as a bare sentence. Passing that through verbatim would make the
 * browser's `json()` helper die on a parse error and report a syntax error
 * instead of the engine's actual complaint, which is the one thing worth
 * knowing. Non-2xx bodies are therefore wrapped as `{ error: <text> }`.
 */
async function forwardOpenFhir(
  res: express.Response,
  url: string,
  init: RequestInit = {},
): Promise<void> {
  try {
    const upstream = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });

    const body = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: body.trim() || `openFHIR returned HTTP ${upstream.status}`,
      });
    }
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') ?? 'application/json');
    res.send(body);
  } catch (err) {
    res.status(502).json({
      error: 'Cannot reach openFHIR',
      detail: (err as Error).message,
      hint: `Is the stack up? Expected openFHIR at ${OPENFHIR_BASE}`,
    });
  }
}

// --- EHRbase helpers --------------------------------------------------------

async function ehrbase(path: string, query: Record<string, string> = {}, init: RequestInit = {}) {
  return fetch(ehrbaseUrl(path, query), {
    ...init,
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function listTemplateIds(): Promise<string[]> {
  const upstream = await ehrbase('definition/template/adl1.4');
  if (!upstream.ok) return [];
  const templates = await upstream.json();
  return Array.isArray(templates)
    ? templates.map((t: any) => t.template_id ?? t.templateId).filter(Boolean)
    : [];
}

/**
 * Runs an AQL query with bound parameters.
 *
 * Parameterised rather than interpolated: an ehrId reaching AQL as a raw string
 * is an injection seam, and EHRbase's `query_parameters` is the supported way
 * to close it. (The PoC interpolated and stripped quotes by hand.)
 */
async function aql(
  q: string,
  parameters: Record<string, unknown> = {},
): Promise<{ rows: unknown[][] }> {
  const upstream = await ehrbase('query/aql', {}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      Object.keys(parameters).length ? { q, query_parameters: parameters } : { q },
    ),
  });
  if (!upstream.ok) {
    throw new Error(`AQL failed (HTTP ${upstream.status}): ${(await upstream.text()).slice(0, 500)}`);
  }
  return upstream.json() as Promise<{ rows: unknown[][] }>;
}

/** One AQL count, or 0 when the query fails — used only for dashboard tiles. */
async function countOf(q: string): Promise<number> {
  try {
    const result = await aql(q);
    return Number(result.rows?.[0]?.[0] ?? 0);
  } catch {
    return 0;
  }
}

// --- identity ---------------------------------------------------------------

/**
 * Who the proxy says is calling. The SPA reads this once at startup and uses it
 * for `composer` on every composition.
 *
 * With ingress basic-auth the username is a shared account, so this is the
 * deployment's identity rather than an individual's — `DEFAULT_USER_NAME`
 * exists to make that legible in the CDR instead of inventing a person. When a
 * real IdP replaces basic-auth it forwards the same headers with per-user
 * values and this endpoint starts returning real clinicians unchanged.
 */
app.get('/api/me', (req, res) => {
  const id = identityOf(req) ?? '';

  res.json({
    id: id || 'anonymous',
    // A bare basic-auth username ("demo") is a login handle, not a display
    // name; showing it as the composer would misrepresent it as a person.
    name: id ? (DEFAULT_USER_NAME || id) : DEFAULT_USER_NAME,
    authenticated: Boolean(id),
  });
});

// --- health & stats ---------------------------------------------------------

/** Reachability of both back ends plus the template list. */
app.get('/api/health', async (_req, res) => {
  const health: Record<string, unknown> = {};

  try {
    const templates = await listTemplateIds();
    health.ehrbase = 'up';
    health.templates = templates;
  } catch (err) {
    health.ehrbase = 'down';
    health.templates = [];
    health.ehrbaseDetail = (err as Error).message;
  }

  try {
    const upstream = await fetch(fhirUrl('metadata', { _summary: 'true' }), {
      headers: { Accept: 'application/fhir+json' },
    });
    health.fhir = upstream.ok ? 'up' : `error ${upstream.status}`;
  } catch (err) {
    health.fhir = 'down';
    health.fhirDetail = (err as Error).message;
  }

  health.ehrbaseBase = EHRBASE_BASE;
  health.fhirBase = FHIR_BASE;
  res.json(health);
});

/** Counts for the Dashboard and Settings tiles. */
app.get('/api/stats', async (_req, res) => {
  const templates = await listTemplateIds().catch(() => [] as string[]);

  const [ehrs, compositions] = await Promise.all([
    countOf('SELECT COUNT(e/ehr_id/value) FROM EHR e'),
    countOf('SELECT COUNT(c/uid/value) FROM EHR e CONTAINS COMPOSITION c'),
  ]);

  let patients = 0;
  try {
    const upstream = await fetch(fhirUrl('Patient', { _summary: 'count' }), {
      headers: { Accept: 'application/fhir+json' },
    });
    if (upstream.ok) patients = Number((await upstream.json())?.total ?? 0);
  } catch {
    // FHIR down — reported by /api/health; a zero tile is honest enough here.
  }

  res.json({ templates: templates.length, templateIds: templates, ehrs, compositions, patients });
});

// --- templates --------------------------------------------------------------

app.get('/api/templates', async (_req, res) => {
  try {
    res.json({ templates: await listTemplateIds() });
  } catch (err) {
    res.status(502).json({ error: 'Could not list templates', detail: (err as Error).message });
  }
});

/**
 * The web template for one template id.
 *
 * `Accept: application/openehr.wt+json` is what turns EHRbase's OPT route into
 * the web-template projection `mb-form` consumes. This is the RUNTIME source
 * (plan "Web template source"): it works for any uploaded template, where the
 * committed fixture only covers the one. It returns 9 top-level children to the
 * fixture's 15 — the 6 extra are pure RM housekeeping and no clinical field
 * differs.
 */
app.get('/api/templates/:id/webtemplate', (req, res) =>
  forward(res, ehrbaseUrl(`definition/template/adl1.4/${encodeURIComponent(req.params.id)}`), {
    headers: { Accept: 'application/openehr.wt+json' },
  }),
);

/**
 * Uploads an OPT. The body is XML, kept verbatim — see express.text() above.
 *
 * `Accept` MUST be XML here. The ADL 1.4 upload endpoint only produces XML, so
 * asking for JSON — as `forward` does by default — makes EHRbase reject the
 * request with 406 Not Acceptable before it ever looks at the body. Success and
 * error bodies alike come back as XML.
 */
app.post('/api/templates', (req, res) =>
  forward(res, ehrbaseUrl('definition/template/adl1.4'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
    body: typeof req.body === 'string' ? req.body : String(req.body ?? ''),
  }),
);

// --- patients (FHIR) --------------------------------------------------------

/**
 * Patient search. `name` maps onto HAPI's `name` search parameter; with no
 * query it lists the first page. Both are verified supported on this server.
 */
app.get('/api/patients', (req, res) => {
  const query: Record<string, string> = { _count: String(req.query._count ?? 50) };
  if (req.query.name) query.name = String(req.query.name);
  if (req.query.identifier) query.identifier = String(req.query.identifier);
  if (req.query.birthdate) query.birthdate = String(req.query.birthdate);
  return forwardFhir(res, fhirUrl('Patient', query));
});

app.get('/api/patients/:id', (req, res) =>
  forwardFhir(res, fhirUrl(`Patient/${encodeURIComponent(req.params.id)}`)),
);

/**
 * The EHR belonging to a FHIR patient.
 *
 * Resolution is by the subject reference stamped at EHR-creation time. EHRbase
 * answers 404 when nothing matches, which is a legitimate answer — a patient
 * with no EHR yet — so it is translated into a 404 body the SPA can branch on
 * rather than surfaced as an error.
 */
app.get('/api/patients/:id/ehr', async (req, res) => {
  try {
    const upstream = await ehrbase('ehr', {
      subject_id: req.params.id,
      subject_namespace: FHIR_NAMESPACE,
    });

    if (upstream.status === 404) {
      return res.status(404).json({ error: 'No EHR for this patient', patientId: req.params.id });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'EHR lookup failed',
        detail: (await upstream.text()).slice(0, 500),
      });
    }

    const body = await upstream.json();
    res.json({ ehrId: body?.ehr_id?.value ?? null, ehr: body });
  } catch (err) {
    res.status(502).json({ error: 'Cannot reach EHRbase', detail: (err as Error).message });
  }
});

/**
 * EHRbase 2.28 rejects an empty `{}` body with
 * `JSON parse error: Missing [_type] value` — it requires a fully typed
 * EHR_STATUS. Verified against the running CDR.
 *
 * `external_ref` is what makes `GET /ehr?subject_id=…&subject_namespace=fhir`
 * resolve. Without it the EHR is an orphan: still valid, but unreachable from
 * any patient — which is exactly the state of the 41 EHRs this stack inherited
 * from the PoC.
 */
function ehrStatusFor(fhirPatientId?: string) {
  const status: Record<string, unknown> = {
    _type: 'EHR_STATUS',
    archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1',
    name: { _type: 'DV_TEXT', value: 'EHR Status' },
    subject: { _type: 'PARTY_SELF' },
    is_queryable: true,
    is_modifiable: true,
  };

  if (fhirPatientId) {
    status.subject = {
      _type: 'PARTY_SELF',
      external_ref: {
        _type: 'PARTY_REF',
        namespace: FHIR_NAMESPACE,
        type: 'PERSON',
        id: { _type: 'GENERIC_ID', value: fhirPatientId, scheme: 'FHIR' },
      },
    };
  }

  return status;
}

/**
 * Creates a FHIR Patient and an EHR linked to it, in that order.
 *
 * Order matters: the EHR's subject reference needs the patient id, so the
 * patient must exist first. If EHR creation then fails the patient is left
 * behind — reported rather than rolled back, because a patient with no EHR is
 * recoverable (POST again) while a silent partial success is not.
 */
app.post('/api/patients', async (req, res) => {
  try {
    const created = await fetch(fhirUrl('Patient'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
      body: JSON.stringify(req.body),
    });

    if (!created.ok) {
      return res.status(created.status).json({
        error: 'Patient creation failed',
        detail: (await created.text()).slice(0, 1000),
      });
    }

    const patient = await created.json();
    const patientId = patient?.id;
    if (!patientId) {
      return res.status(502).json({ error: 'FHIR returned a patient with no id', patient });
    }

    const ehrRes = await ehrbase('ehr', {}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(ehrStatusFor(patientId)),
    });

    if (!ehrRes.ok) {
      return res.status(502).json({
        error: 'Patient created but EHR creation failed',
        patientId,
        detail: (await ehrRes.text()).slice(0, 1000),
      });
    }

    const ehr = await ehrRes.json();
    res.status(201).json({ patientId, ehrId: ehr?.ehr_id?.value ?? null, patient });
  } catch (err) {
    res.status(502).json({ error: 'Patient creation failed', detail: (err as Error).message });
  }
});

// --- EHRs & compositions ----------------------------------------------------

/** Creates a bare EHR, optionally linked to a patient. */
app.post('/api/ehr', (req, res) =>
  forward(res, ehrbaseUrl('ehr'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(ehrStatusFor(req.body?.patientId)),
  }),
);

/**
 * Compositions in one EHR, newest first, grouped by template.
 *
 * The grouping is done here in JS because EHRbase's AQL engine does NOT support
 * `GROUP BY` — it is a parse error, verified against this server. Both shapes
 * are returned: `compositions` flat for anything that wants a list, `groups`
 * for the template-keyed browser.
 */
app.get('/api/ehr/:ehrId/compositions', async (req, res) => {
  try {
    const result = await aql(
      `SELECT c/uid/value, c/name/value, c/context/start_time/value, ` +
        `c/archetype_details/template_id/value ` +
        `FROM EHR e[ehr_id/value=$ehrId] CONTAINS COMPOSITION c ` +
        `ORDER BY c/context/start_time/value DESC`,
      { ehrId: req.params.ehrId },
    );

    const compositions = (result.rows ?? []).map(([uid, name, startTime, templateId]) => ({
      uid: String(uid ?? ''),
      name: String(name ?? ''),
      startTime: String(startTime ?? ''),
      templateId: String(templateId ?? '(no template)'),
    }));

    const byTemplate = new Map<string, typeof compositions>();
    for (const c of compositions) {
      const bucket = byTemplate.get(c.templateId);
      if (bucket) bucket.push(c);
      else byTemplate.set(c.templateId, [c]);
    }

    res.json({
      compositions,
      groups: [...byTemplate.entries()].map(([templateId, items]) => ({
        templateId,
        count: items.length,
        compositions: items,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not list compositions', detail: (err as Error).message });
  }
});

/**
 * Stores a composition. `templateId` is a per-request parameter, not a server
 * constant: the Compositions view is template-driven, so the same BFF has to
 * serve whichever template the form was built from.
 */
app.post('/api/ehr/:ehrId/composition', (req, res) => {
  const templateId = String(req.query.templateId ?? '');
  if (!templateId) {
    return res.status(400).json({
      error: 'templateId is required',
      hint: 'POST /api/ehr/:ehrId/composition?templateId=EPS%20Patient%20Summary',
    });
  }

  return forward(
    res,
    ehrbaseUrl(`ehr/${encodeURIComponent(req.params.ehrId)}/composition`, {
      format: 'FLAT',
      templateId,
    }),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(req.body),
    },
  );
});

/**
 * Reads one composition back.
 *
 * `?format=canonical` opts into the canonical RM representation; anything else
 * (including no parameter) stays FLAT. The default is deliberate: the save
 * pipeline's read-back diff compares FLAT keys, so changing it would silently
 * break that comparison. Canonical is a SECOND representation for a different
 * consumer — openFHIR sniffs the payload shape (`_type: COMPOSITION` means
 * canonical) — not a replacement, so it is requested explicitly by whoever
 * needs it. EHRbase returns canonical when the `format` parameter is omitted.
 */
/**
 * Updates a composition — a NEW VERSION of an existing one.
 *
 * Distinct from the POST above, and not interchangeable with it. EHRbase
 * addresses a create and an update differently: POST mints a new composition,
 * while PUT targets the VERSIONED OBJECT id (the uid with its `::domain::N`
 * suffix removed) and requires `If-Match` naming the exact version being
 * replaced. Sending an edited composition back through POST re-submits its
 * existing `_uid` as if it were new, which EHRbase rejects with
 * `412 Provided Id … already exists`.
 *
 * `If-Match` is what makes the update safe rather than last-write-wins: if the
 * composition changed since it was loaded, the precondition fails instead of
 * silently overwriting the other edit.
 */
app.put('/api/ehr/:ehrId/composition/:uid', (req, res) => {
  const templateId = String(req.query.templateId ?? '');
  if (!templateId) {
    return res.status(400).json({
      error: 'templateId is required',
      hint: 'PUT /api/ehr/:ehrId/composition/:uid?templateId=EPS%20Patient%20Summary',
    });
  }

  // The path takes the versioned OBJECT id; `If-Match` takes the full versioned
  // uid. Splitting here keeps that asymmetry in one place.
  const versionedUid = req.params.uid;
  const objectId = versionedUid.split('::')[0];

  return forward(
    res,
    ehrbaseUrl(`ehr/${encodeURIComponent(req.params.ehrId)}/composition/${encodeURIComponent(objectId)}`, {
      format: 'FLAT',
      templateId,
    }),
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': versionedUid,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(req.body),
    },
  );
});

app.get('/api/ehr/:ehrId/composition/:uid', (req, res) => {
  const canonical = String(req.query.format ?? '').toLowerCase() === 'canonical';
  return forward(
    res,
    ehrbaseUrl(
      `ehr/${encodeURIComponent(req.params.ehrId)}/composition/${encodeURIComponent(req.params.uid)}`,
      canonical ? {} : { format: 'FLAT' },
    ),
  );
});

// --- openFHIR mapping -------------------------------------------------------

/**
 * Maps a composition to a FHIR Bundle via FHIR Connect.
 *
 * The body is forwarded verbatim: the engine deduces the incoming payload type
 * from its shape rather than from a parameter, so re-serialising it is enough
 * to change how it is read. `templateId` names the FhirConnect context, and
 * both it and the OPT must be registered in openFHIR — not merely in EHRbase —
 * or the engine answers 400 (no context) or 500 (no OPT).
 */
app.post('/api/openfhir/tofhir', (req, res) => {
  const templateId = String(req.query.templateId ?? '');
  if (!templateId) {
    return res.status(400).json({
      error: 'templateId is required',
      hint: 'POST /api/openfhir/tofhir?templateId=EPS%20Patient%20Summary',
    });
  }

  const url = new URL(`${OPENFHIR_BASE.replace(/\/$/, '')}/openfhir/tofhir`);
  url.searchParams.set('templateId', templateId);

  return forwardOpenFhir(res, url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
  });
});

// --- FHIR Bundles -----------------------------------------------------------

/**
 * The IPS Composition profile, and the reason storing a Bundle needs care.
 *
 * This stack's HAPI is not stock: it carries the openFHIR interceptor, whose
 * `fhir-create-filter.intercepted-profiles` lists exactly this URL. A Bundle
 * whose Composition still declares it is not stored as a Bundle at all — the
 * interceptor maps it back to openEHR and commits it to EHRbase as a NEW
 * composition, answering with a composition URL and no Bundle id. Persisting a
 * freshly mapped Bundle would therefore duplicate the composition on every
 * single save, into a CDR whose composition DELETE is disabled.
 *
 * Verified against the running stack, which is the only way this is knowable.
 */
const IPS_COMPOSITION_PROFILE =
  'http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips';

/**
 * Strips the profile that triggers the interceptor, leaving everything else —
 * including the Bundle's own IPS profile — untouched.
 *
 * The cost is honest and bounded: the STORED copy is no longer profile-tagged
 * as an IPS Composition. What makes it a patient summary clinically — the
 * document type, the LOINC code, the section order and every clinical resource
 * — is preserved, and the viewer renders from those. The alternative was
 * writing a duplicate composition to the CDR on every save.
 */
function stripInterceptedProfile(bundle: any): any {
  if (!bundle || !Array.isArray(bundle.entry)) return bundle;

  return {
    ...bundle,
    entry: bundle.entry.map((entry: any) => {
      const profiles = entry?.resource?.meta?.profile;
      if (entry?.resource?.resourceType !== 'Composition' || !Array.isArray(profiles)) {
        return entry;
      }

      const kept = profiles.filter((p: unknown) => p !== IPS_COMPOSITION_PROFILE);
      if (kept.length === profiles.length) return entry;

      const meta = { ...entry.resource.meta };
      if (kept.length) meta.profile = kept;
      else delete meta.profile;

      const resource = { ...entry.resource, meta };
      if (!Object.keys(meta).length) delete resource.meta;

      return { ...entry, resource };
    }),
  };
}

/** Stores a mapped Bundle. See `stripInterceptedProfile` for why it is edited. */
app.post('/api/fhir/Bundle', (req, res) =>
  forwardFhir(res, fhirUrl('Bundle'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', Prefer: 'return=representation' },
    body: JSON.stringify(stripInterceptedProfile(req.body)),
  }),
);

app.get('/api/fhir/Bundle/:id', (req, res) =>
  forwardFhir(res, fhirUrl(`Bundle/${encodeURIComponent(req.params.id)}`)),
);

/** The golden FLAT fixture — the seeding source and the test baseline. */
app.get('/api/golden', async (_req, res) => {
  try {
    const file = resolve(FIXTURES_DIR, 'eps.example.flat.json');
    res.type('application/json').send(await readFile(file, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: 'golden fixture missing', detail: (err as Error).message });
  }
});

// --- 404s -------------------------------------------------------------------

/**
 * Unknown /api routes answer JSON, not Express's default HTML error page.
 *
 * Every client helper in the SPA parses the response body as JSON to build its
 * error message. Express's stock 404 is an HTML document, so a mistyped or
 * removed endpoint surfaces in the UI as a JSON syntax error — which points at
 * the parser rather than at the missing route, and hides the actual status.
 *
 * Registered before the static handler so it wins for /api paths (the SPA
 * fallback below deliberately never matches them).
 */
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'No such endpoint',
    detail: `${req.method} /api${req.path}`,
  });
});

// --- static SPA -------------------------------------------------------------

/**
 * Serves the built SPA from the same process, when STATIC_DIR is set.
 *
 * Registered LAST so it can never shadow an /api route: express matches in
 * registration order, and the history fallback below answers anything, so
 * mounting it earlier would swallow API calls and return index.html for them.
 */
if (STATIC_DIR) {
  const staticRoot = resolve(STATIC_DIR);
  if (!existsSync(staticRoot)) {
    // Fail at startup, not on the first page load: an image built without the
    // SPA should not come up looking healthy and then 404 every request.
    console.error(`[bff] STATIC_DIR does not exist: ${staticRoot}`);
    process.exit(1);
  }

  app.use(express.static(staticRoot));

  /**
   * History fallback for the SPA.
   *
   * Routing is hash-based (`#/patients/...`), so the server only ever sees `/`
   * in normal use. This exists for the cases that still reach the server with a
   * path — a stale bookmark, a manually typed URL — which would otherwise 404
   * inside a single-page app that could have rendered them.
   *
   * Scoped to GET and to non-/api paths so a mistyped API call still returns a
   * JSON 404 rather than a page of HTML that the fetch layer cannot parse.
   */
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(resolve(staticRoot, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[bff] listening on http://localhost:${PORT}`);
  console.log(`[bff] EHRbase -> ${EHRBASE_BASE}`);
  console.log(`[bff] FHIR    -> ${FHIR_BASE}`);
  console.log(`[bff] openFHIR-> ${OPENFHIR_BASE}`);
  if (STATIC_DIR) console.log(`[bff] SPA     -> ${resolve(STATIC_DIR)}`);
  console.log(
    `[bff] auth    -> ${
      REQUIRE_AUTH
        ? `REQUIRED (header${TRUST_BASIC_AUTH ? ' or basic' : ''})`
        : 'NOT ENFORCED (local dev only)'
    }`,
  );
});
