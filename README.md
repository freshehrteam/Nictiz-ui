# freshehr-nictiz-ui

A small clinical workspace over openEHR: a FHIR patient list, a per-patient
composition browser grouped by template, a hand-written Medblocks form for the
**EPS Patient Summary** template, and a technical/settings view.

Built on the decision reached in a dedicated evaluation: **Medblocks UI with
hand-written forms** ("Track B"). The evaluation and its defect catalogue live
in a separate (private) evaluation repository.

---

## Running it

Needs Node 20+ and the local stack (EHRbase on `:8082`, HAPI FHIR on `:8080`,
Keycloak on `:8081` — the BFF fetches its EHRbase tokens there, as the
`nictiz-ui-svc` client).

```bash
cp .env.example .env          # defaults match the local stack
cd app && npm install
npm ls @shoelace-style/shoelace   # must show exactly one copy

npm run register              # once per fresh stack — registers this app's
                              # OIDC clients in the local Keycloak realm
npm run dev                   # BFF :3001 + Vite :5173
npm run seed                  # once — creates the demo patients
```

Then open http://localhost:5173.

| Command | What it does |
|---|---|
| `npm run dev` | BFF and Vite together |
| `npm run register` | Registers `nictiz-ui-svc`/`nictiz-ui` + the demo user in the local Keycloak (idempotent; the stack repo stays agnostic of this app) |
| `npm run seed` | Creates 6 demo patients, each with a linked EHR and one composition |
| `npm test` | Unit tests — no backend needed |
| `npm run test:e2e` | Browser tests — needs the stack up and seeded |
| `npm run build` | Typecheck and production build |

---

## Security — read before deploying

**The application performs no user authentication of its own.** The BFF talks
to EHRbase and openFHIR as one shared service account (`nictiz-ui-svc`, OAuth2
`client_credentials` against the freshehr Keycloak realm; the openFHIR calls
carry scope `openfhir.map` and the hardcoded `tenant: freshehr` claim the
protected engine keys its store by) and applies no per-user access control.
Whoever gets past the gate can read and write every record in the CDR.

Two different postures follow from that:

**Locally** there is no gate at all. Anything that can reach port 3001 has full
access. Do not expose that port beyond localhost. (Browser SSO also does not
work locally — the compose stack pins Keycloak's issuer in-network
(`KC_HOSTNAME`), a documented stack limitation — so `/api/me` reports the
anonymous "Demo User" fallback. Exercise the identity path directly:
`curl -H 'x-auth-request-user: alice' localhost:3001/api/me`.)

**Deployed** (see [Deploying to Hetzner](#deploying-to-hetzner)) the gate is the
ingress: every request is checked against the chart's session-mode oauth2-proxy
(`auth-url` subrequest); an anonymous browser is redirected into the Keycloak
login (realm `freshehr`), and the verified identity is forwarded to the BFF as
`X-Auth-Request-User`. The BFF refuses anything that did not come through it
(`REQUIRE_AUTH`), so a misconfigured ingress or a direct pod connection fails
closed instead of quietly serving the CDR.

That IS **per-user identity**: `composer` records the person who logged in.
What is still missing before this touches real patient data is per-user
*authorisation* (everyone with a realm account has the same full access) and an
audit trail. The Settings view states the same thing in the UI so it cannot be
overlooked.

Demo patients created by `npm run seed` are fictional. They carry the FHIR tag
`data-origin = demo` and use BSNs from the reserved `999…` test range.

---

## Deploying to Hetzner

The app runs **alongside** the
[`freshehr-open-health-stack`](https://github.com/freshehr/freshehr-open-health-stack)
deployment (the "stack repo" referenced throughout this README): the same
k3s cluster on hcloud, the same `health-stack` namespace, its own Helm release.

Two repositories, two releases, deliberately. They version and deploy
independently; what couples them is the shared Keycloak realm — this release
registers its own clients in it via the admin API, so the stack repo carries
nothing nictiz-ui-specific.

```
                    hcloud load balancer
                             │
                    ingress-nginx (k3s)
                             │
      ┌──────────────────────┴───────────────────────┐
      │                                              │
  health.<domain>                          nictiz-demo.<domain>
  /fhir /openfhir → Bearer (oauth2-proxy)  /  (SPA + /api) → Keycloak login
  /ehrbase → EHRbase validates natively    /oauth2/* (the login flow itself)
  /auth    → Keycloak (public)                       │
      │                                              │
  hapi · ehrbase · openfhir  ◄── in-cluster ──  nictiz-ui (SPA + BFF)
```

Separate hostnames on purpose, and the reason is **which kind of caller** each
host serves. The health-stack host exposes the raw back-end APIs to *machines*
(Bearer JWTs from the realm's service-account clients, validated by the stack's
Bearer-only oauth2-proxy). `nictiz-demo` serves *humans*: a session-mode
oauth2-proxy owns the browser login for this host. Both flows live in one realm
— one set of users, one place to rotate secrets — but each host runs the proxy
mode its callers need.

The BFF is unaffected by either gate: it reaches `ehrbase`, `hapi`, `openfhir`
and `keycloak` over in-cluster Service DNS, and edge auth applies only to
traffic arriving through the ingress. The same is true of the openFHIR
interceptor's server-to-server calls.

> Scripting against either host needs a Bearer token from the realm:
> `make token` in the stack repo, or the `client_credentials` flow with
> `terraform output -raw kc_api_client_secret`.

### One-time setup

**1. Publish the image.** Push a `v*` tag, or run the `build-image` workflow.
Needs `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repo secrets.

**2. Point DNS at the load balancer.**

```bash
terraform -chdir=<stack>/terraform/envs/hetzner output load_balancer_ipv4
# → A record: nictiz-demo.<domain>
```

**3. Make sure the stack is deployed.** That is the whole requirement: this
chart generates its own client secrets and a post-install Job registers its
OIDC clients + the demo user in the freshehr realm through Keycloak's admin
API (credentials from the stack's `keycloak-secret`). The stack repo carries
nothing nictiz-ui-specific — see "How registration works" in
[`charts/nictiz-ui/README.md`](charts/nictiz-ui/README.md).

### Install

```bash
helm upgrade --install nictiz-ui charts/nictiz-ui \
  -n health-stack \
  -f charts/nictiz-ui/values-hetzner.yaml \
  --set ingress.host=nictiz-demo.<domain> \
  --set image.tag=0.2.1     # NOTE: unprefixed — git tag v0.2.1 publishes Docker tag 0.2.1
```

The namespace **must** be the health-stack one: the BFF resolves `ehrbase`,
`hapi`, `openfhir` and `keycloak` by bare Service name, and the registration
Job reads the Keycloak admin credentials from that release's
`keycloak-secret`. Both are namespace-local.

### Verify

```bash
kubectl rollout status deploy/nictiz-ui -n health-stack

curl -s -o /dev/null -w '%{http_code}\n' https://nictiz-demo.<domain>/            # 302 → /oauth2/start
TOKEN=$(cd <stack>/docker && make -s token)   # or any api-client client_credentials token
curl -H "Authorization: Bearer $TOKEN" https://nictiz-demo.<domain>/api/health     # 200
```

In the browser: log in as `demo` — password from
`kubectl get secret nictiz-ui-demo-user -n health-stack -o jsonpath='{.data.password}' | base64 -d`.

`/api/health` reports whether the BFF can reach EHRbase and HAPI — the check that
confirms the two releases are actually wired together.

### Bootstrapping the template

An empty CDR has no template, so the form has nothing to render. Upload the OPT
and register it with openFHIR. From the stack repo, both steps are:

```bash
make template     # uploads every OPT in docker/openfhir/bootstrap into EHRbase
make bootstrap    # makes openFHIR re-scan that dir for mappings
```

The stack ships the **EPS** set only (`EPS Patient Summary`), which is the
template `src/forms/registry.ts` has a form for, so a clean bootstrap needs no
further care.

**Check what is already registered if the CDR is not fresh.** openFHIR keys
mappers by archetype **globally**, so EPS and IPS mappers for the same archetype
collide — five are shared. A CDR that already carries IPS mappers (or a reused
Postgres volume) will keep them, and `tofhir` then returns 200 with an empty
Bundle: a save that looks successful and produces no clinical resources. Confirm
the returned Bundle has more than one entry before believing the path works.

### How the auth actually fits together

| Layer | Does what | Fails how |
|---|---|---|
| ingress-nginx `auth-url` → oauth2-proxy | Sends anonymous browsers to the Keycloak login; verifies the session per request | 302 to login before the BFF is reached |
| BFF `REQUIRE_AUTH` | Rejects requests with no proxy identity | 401 — a direct pod hit cannot bypass the gate |
| BFF → EHRbase / openFHIR | Bearer token as `nictiz-ui-svc` (`client_credentials`; openFHIR additionally checks scope `openfhir.map` + the `tenant` claim) | 502 with a Keycloak hint when tokens cannot be fetched |
| NetworkPolicy | Only ingress-nginx may open a connection to the pods | Lateral in-cluster access is refused |

The three are layered because the BFF *trusts* the identity its proxy asserts —
inherent to forward-auth. `REQUIRE_AUTH` alone would still believe a forged
header from inside the cluster; the NetworkPolicy is what makes "came through
the ingress" true rather than assumed. k3s enforces NetworkPolicy out of the box.

`/healthz` sits deliberately outside the guard: kubelet probes hit the pod
directly and are unaffected by edge auth. Externally the path IS gated — an
uptime monitor on it must send a Bearer token or treat the 302 as "up".

**Per-user identity is done**: oauth2-proxy forwards who logged in, and
`composer` records that person on every composition. What remains is per-user
*authorisation* and an audit trail (see Known limitations).

---

## Architecture

Sequence and component diagrams for the save → FHIR translation → display flow
live in [`docs/`](docs/) as PlantUML sources.

```
app/
  src/
    main.ts               entry; imports the Shoelace theme BEFORE app css
    shell.ts              <eps-app> — sidebar nav + hash router
    views/                dashboard, patients, compositions, composition-form,
                          settings, patient-header
    forms/                allergies, problems, devices, procedures, context
                          registry.ts — which templates have a form (see below)
    terminology/          the handleSearch seam + seed data
    openehr/              flat.ts, client.ts, medblocks.ts, webtemplate.ts,
                          validation.ts — mandatory-field checking (see below)
    fhir/                 client.ts, patient.ts
    styles/               theme.css, views.css
  server/index.ts         the BFF
  scripts/seed.ts         demo data
  tests/unit, tests/e2e
tools/webtemplate-gen/    OPT XML → web template JSON (offline, Maven)
fixtures/                 committed web templates (both formats — see
                          "Mandatory fields") + golden FLAT composition
```

**The BFF is mandatory.** The stack configures no CORS anywhere, and the
EHRbase service-account credential must never reach the browser.

**Light DOM is mandatory.** Every component uses
`createRenderRoot() { return this }`, because inside a Lit 3 shadow root
`mb-form`'s slot traversal cannot see its children. The consequence is that Lit
silently drops `static styles`, so **all CSS lives in `src/styles/*.css`**,
scoped by tag name.

**The web template is fetched at runtime** from
`GET /api/templates/:id/webtemplate`, so the app works for any uploaded
template, not only the committed fixture.

---

## Templates, forms and the creation flow

Two things are easy to conflate, and conflating them is a data-integrity bug:

| | |
|---|---|
| **A template on the CDR** | An uploaded OPT. Compositions can be *stored* against it. |
| **A template with a form** | One with hand-written fields in `src/forms/registry.ts`. Compositions can be *entered* for it. |

Track B means forms are hand-written, so uploading an OPT does **not** make it
fillable here — someone has to build the fields. `src/forms/registry.ts` is the
single place that knows which templates those are.

The compositions view therefore lists **every template on the server**, with the
patient's record count beside each. Templates with no form are listed but marked
`no form yet` and cannot be recorded against; ones the patient has records under
but the server no longer has are marked `not on server`.

Creation is always **per template**: each row has its own `+`, and the template
id travels in the URL —
`#/patients/:id/compositions/new?template=<templateId>`. The form renders the
sections the registry holds for that id, and **refuses to open** for a template
with no form, one missing from the CDR, or a URL naming no template at all.

That last part is the point of the design. The form previously rendered EPS
Patient Summary's fields for *any* template id, so a composition could be filled
in against a foreign template — binding EPS paths that the CDR would reject at
save, or store wrongly. Adding a template means adding it to the registry; there
is no path where an unregistered template reaches the form.

---

## Working on the forms

Medblocks has ten known defects, **nine of which fail silently**. All the
compensations live in one file — `src/openehr/medblocks.ts` — so their cost is
visible and they cannot be dropped by accident. Full detail is in the
evaluation's `docs/TRACK-B-GAPS-AND-WORKAROUNDS.md`.

The authoring rules, all of which fail silently:

1. Paths are **root-absolute**, built from `ROOT`. CDR keys then import verbatim.
2. Repeatable **children** need an explicit `:0`; the container path has none.
3. The tag is **`mb-repeatable-simple`** — `mb-repeatable` does not exist and
   renders an inert element.
4. Set language/territory via **`mb-form.ctx`**, never `mb-context.value` —
   territory otherwise silently defaults to **`IN`** (India).
5. Bind object-valued props with `.prop=${…}`; as attributes they are
   `JSON.parse`d and throw.
6. Never put `|attr` mid-path (`fromFlat` splits on `|`). On a leaf it is fine.
7. `mb-text-select` takes slotted `<mb-option>` children, **not** an `options`
   array — an array renders an empty dropdown.
8. Terminology results must **omit `text`**, or `mb-search` stores a plain
   string and silently discards the code.
9. Seed empty `:0` markers before import — a repeatable with no data throws
   `RangeError` and breaks every repeatable on the page.
10. Never validate with import→export alone — unmatched keys pass through
    `deferredData` and fake a perfect round-trip.

**Derive the control from the web template's `value` child, never the field
name.** `body_site` is the standing proof: three shapes in one template.

| Section | FLAT key | Type | Control |
|---|---|---|---|
| Problems | `…/problem_diagnosis:0/body_site:0` | DV_CODED_TEXT, repeatable | `mb-search` in `mb-repeatable-simple` |
| Procedures | `…/procedure:0/body_site:0` | DV_TEXT, repeatable | `mb-input` in `mb-repeatable-simple` |
| Devices | `…/device_details:0/body_site` | DV_TEXT, single | bare `mb-input` |

`src/openehr/webtemplate.ts` answers this question from the template itself, and
`tests/unit/webtemplate.test.ts` guards all three.

### Two more things found while building this

- **`composer` is mandatory but never exported until touched.** Medblocks
  serialises only values a user has set, so a `ctx` default and a visibly filled
  input still produce `HTTP 400 Composition missing mandatory attribute:
  composer`. `ensureMandatoryContext()` guarantees it.
- **`mb-search` stores coded results on `.data`, not `.value`.** `.value` stays
  empty for a coded field, so asserting on it reads as "nothing bound" for a
  field that is plainly populated.

---

## Mandatory fields

Every field the OPT marks `min = 1` is enforced **in the form**, before anything
is submitted. Previously the only thing checking them was EHRbase, which answers
a missing one with

```
HTTP 422 … /content[openEHR-EHR-EVALUATION.adverse_reaction_risk.v2]
           /data[at0001]/items[at0002]: attribute value is mandatory
```

— an RM path, after the whole form has been filled in, naming nothing the user
can see on screen. Now the save is refused in the browser, the field is named in
the template's own words, and the control is marked where it sits.

Nothing hardcodes the list: `mandatoryFields()` in `src/openehr/webtemplate.ts`
reads `min` from the same template the CDR validates against, so the two cannot
drift apart. For `EPS Patient Summary` it resolves to 15 fields — substance,
manifestation, problem/diagnosis name, device name, procedure name and the
absence statements. The CDR remains the authority; this is a fast pre-check that
removes the common rejection, not a reimplementation of EHRbase's validation.

**Four traps, each of which produces a validator that is worse than none.**

| | |
|---|---|
| **Two template formats** | `tools/webtemplate-gen` emits ELEMENT nodes wrapped in `tree`/`structure` ITEM_TREEs. EHRbase's `/webtemplate` — what the app actually fetches — hoists the DV type onto the field node and drops the wrapper. Matching only `ELEMENT` finds every field in the fixture and **none** in production. |
| **CHOICE alternatives** | `onset_of_first_reaction` is optional (`min = 0`) but each of its five `*_value` alternatives is `min = 1` — "if you pick this one, it needs a value". Descending into them demands five mutually exclusive fields at once. The walk stops at the leaf. |
| **Elided structure segments** | FLAT keys omit the ITEM_TREE segment the template nests fields under, and it is not always called `tree` (`problem_diagnosis` calls it `structure`). Paths must be emitted in FLAT form or nothing matches. |
| **`min = 1` inside a repeatable is conditional** | `substance` is mandatory *within an allergy*, but a composition with no allergies is valid. Demanding it on an untouched form makes an empty composition unsaveable. Only an entry the user has actually started is checked. |

Two consequences in the UI, both in `src/views/composition-form.ts`:

- **The marks are stamped onto the DOM, and `required` is set alongside.**
  Medblocks implements `required` properly on every control used here, so it is
  set to keep `mb-form.validate()` in step. It cannot drive the UI on its own
  though: `validate()` returns one boolean, not *which* field in *which* repeat
  occurrence — and those occurrence paths only exist at runtime, on copies the
  repeatable cloned.
- **Validation re-runs on `mb-input`.** Medblocks controls hold their value on
  `.data` and write to no property of the host, so Lit never re-renders on its
  own and a field would stay red after being filled in.

Only the mounted branch is ever checked. Each section renders one of
entries / excluded / no-information, so switching to "No information" stops
demanding `substance` and starts demanding the absence statement — which falls
out of reading `mb-form.data` rather than being special-cased.

## Data model

Patients live in FHIR; records live in openEHR. **New patient** on the Patients
view creates both in one call — the FHIR Patient first, then an EHR whose
subject reference carries that patient's id. The EHR id is generated by EHRbase;
nothing client-side invents one.

Name and date of birth are required; BSN is optional (an unidentified or foreign
patient may have none) and validated for **shape only** — nine digits, no
elfproef checksum, because the checksum would reject the reserved `999…` range
this project seeds with.

The link is the EHR's subject reference, stamped at creation time:

```ts
subject: {
  _type: 'PARTY_SELF',
  external_ref: {
    _type: 'PARTY_REF', namespace: 'fhir', type: 'PERSON',
    id: { _type: 'GENERIC_ID', value: fhirPatientId, scheme: 'FHIR' },
  },
}
```

That is what makes `GET /ehr?subject_id=…&subject_namespace=fhir` resolve. EHRs
created without it are orphans — valid, but unreachable from any patient. This
CDR holds 41 such EHRs left by the evaluation PoC; they are deliberately left
alone rather than given invented demographics.

### Deleting a patient

The delete button on a patient card (and in the patient header) removes the FHIR
Patient, their openEHR compositions and their stored FHIR Bundles, in that
order — patient **last**, so a failure part-way leaves a state the user can
still find and retry.

It is deliberately **not transactional**. Nothing spans EHRbase and HAPI, so
`DELETE /api/patients/:id` always answers with a report of what it actually
removed rather than pretending a rollback happened:

```jsonc
{ "patientId": "42", "ehrId": "…",
  "compositions": { "found": 2, "deleted": 2, "failed": [] },
  "bundles":      { "found": 1, "deleted": 1, "failed": [] },
  "patient":      { "deleted": true } }
```

A partial failure is a `200` with a populated `failed[]`, not an error — read
that array rather than treating a resolved call as total success.
`GET /api/patients/:id/deletion-preview` returns the same counts up front, and
is what lets the confirmation dialog name real numbers.

**Bundles are found by `Bundle.identifier`.** openFHIR emits no patient
reference at all — `Composition.subject` is null and no Patient resource is
included — so the BFF stamps the patient id onto the Bundle as it is stored
(`?patientId=` on `POST /api/fhir/Bundle`). That **overwrites openFHIR's
per-document UUID**, which is a real loss of document identity, accepted because
nothing in this app reads that UUID and an unattributable Bundle cannot be
cleaned up at all.

Three things this does **not** do, none of them surfaced in the UI:

- **The openEHR EHR shell survives.** `DELETE /ehr/{id}` is `405` on this CDR and
  the admin API is `403` with the BFF's credentials. What is left is an empty
  EHR, but it is left.
- **Composition deletion is logical.** openEHR appends a deleted version; the CDR
  retains the full version history.
- **Pre-existing Bundles are untouched.** Bundles stored before this linkage
  existed — 38 of them on the demo stack — carry no patient identifier and are
  unattributable. Clear them wholesale with HAPI's `$expunge` if demo data needs
  a reset.

Two things about this stack that its own CapabilityStatement gets wrong, both
found by probing it and both worked around in the BFF:

- HAPI advertises `conditionalDelete: multiple` on Bundle, but refuses a
  conditional delete matching more than one resource with
  `412 HAPI-0962`. Bundles are therefore resolved to ids and deleted one by one.
- `_summary=count` serves a **cached** count that survives a delete, and
  `_elements=id` returns a SUBSETTED searchset with no `entry` array at all.
  Both are why those queries carry `Cache-Control: no-cache` and why the id
  search reads full resources.

---

## Known limitations

- **No per-user authorisation or audit trail** (above). Login is per-user
  (Keycloak), but every account has the same full access to every record.
- **Composition scope.** The form covers Allergies, Problems, Medical Devices
  and History of Procedures — the four sections this template actually has. The
  visual mockup shows Medications and Vital Signs; `EPS Patient Summary`
  contains neither.
- **`|other` fields cannot bind.** `fromFlat` splits on `|`, so an element whose
  path contains `|other` never matches. Affects two keys in Problems.
- **Terminology is a local seed list.** `LocalTerminologyProvider` is a stand-in
  behind a narrow `TerminologyProvider` seam; a Snowstorm or Ontoserver client
  replaces it without touching form code.
- **Medblocks is on Lit 1 with one maintainer.** Accepted with open eyes; the
  custom renderer spiked in the evaluation remains the planned successor.
- **Deleting a patient leaves the EHR shell behind**, deletes compositions only
  logically, and cannot reach Bundles stored before the patient link existed.
  See [Deleting a patient](#deleting-a-patient).
