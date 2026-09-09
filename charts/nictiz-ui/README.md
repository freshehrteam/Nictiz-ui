# nictiz-ui

Helm chart for the Nictiz openEHR EMR — the SPA and its BFF, in one pod, plus a
session-mode oauth2-proxy that provides the browser login, plus a registration
Job that installs this app's OIDC clients into the stack's Keycloak realm.

Deploys **alongside** the `health-stack` release from
`freshehr-open-health-stack`, into the same namespace, as a separate release.
The stack repo stays agnostic of this app: everything nictiz-ui needs in the
realm, this chart registers itself.

## Why one pod

The BFF is not optional infrastructure wrapped around the SPA. It holds the
EHRbase service-account credential (which must never reach the browser) and it
is what makes `/api` same-origin, so the SPA needs no CORS configuration at all.
Splitting them into an nginx pod and a node pod would reintroduce the
cross-origin problem the BFF exists to remove, in exchange for nothing.

## Requirements

| | |
|---|---|
| Namespace | The one the `health-stack` release occupies (`health-stack`) |
| Secret | `keycloak-secret` (the stack's Keycloak bootstrap admin) — read by the registration Job |
| Realm | `freshehr`, with its `USER` realm role and the `openfhir.map` client scope — the stack's realm import provides all of these (a pre-native-OAuth stack realm lacks the scope; the Job then warns and skips it) |
| Cluster | ingress-nginx + cert-manager, installed by the stack's Terraform |
| DNS | `ingress.host` resolving to the hcloud load balancer IP |

Same-namespace is not cosmetic: the BFF resolves `ehrbase`, `hapi`, `openfhir`
and `keycloak` by bare Service name, and the Job reads the admin credentials
from a namespace-local Secret.

## How registration works

This chart generates its own credentials and registers them, so no realm
content for this app lives in the stack repo:

1. **Secrets** (`templates/secrets.yaml`): the BFF client secret, the
   oauth2-proxy client + cookie secrets, and the demo user's password are
   generated at install and **sticky** across upgrades (re-read from the live
   Secret via `lookup`, only generated when absent).
2. **Registration Job** (`templates/register-job.yaml`, post-install +
   post-upgrade hook): runs `scripts/register-clients.ts` from this app's own
   image against Keycloak's admin API. Idempotent create-or-update of:
   - `nictiz-ui-svc` — `client_credentials` service account for the
     BFF→EHRbase and BFF→openFHIR hops, with the `oauth2-proxy` audience
     mapper, the `tenant: freshehr` claim mapper (the protected openFHIR
     engine keys its data store by that claim), the `openfhir.map` optional
     client scope (the engine's mapping API demands it; the BFF requests it
     via `scope=`), and realm role `USER`;
   - `nictiz-ui` — standard-flow client for the browser login, redirect URI
     derived from `ingress.host` (one source of truth — realm and ingress
     cannot drift);
   - the `demo` human user (optional), realm role `USER`.

Because the Job re-runs on every upgrade and updates in place, it is also the
migration path: Keycloak's `--import-realm` never updates an existing realm,
and this sidesteps that limitation entirely.

**The accepted trade-off:** the Job authenticates with the Keycloak
**bootstrap admin** credentials (from the stack's `keycloak-secret`). That is
the price of keeping app-specific realm content out of the stack repo. The Job
is short-lived and hook-deleted; the admin credentials never reach the serving
pods.

## Install

Installed from this repo, not from a chart registry. CI validates the chart on
every change (`.github/workflows/helm-lint.yml`) but publishes nothing — a
packaged copy in a registry would be a second artifact that nothing installs
from, and that can silently disagree with the working tree.

```bash
helm upgrade --install nictiz-ui . \
  -n health-stack \
  -f values-hetzner.yaml
```

The tag lives in `values-hetzner.yaml` (`image.tag`); cutting a new one is the
chain in [Releasing a new version to
Hetzner](../../README.md#releasing-a-new-version-to-hetzner).

> ⚠ Image tags are **unprefixed**: the build workflow strips the `v` from git
> tags, so git tag `v0.3.0` publishes Docker tag `0.3.0`. Passing
> `image.tag=v0.3.0` ends in `ErrImagePull`.

No out-of-band Secret creation and no manual Keycloak work: the chart
generates its secrets and the Job registers the clients.

## Values worth knowing

| Key | Default | Notes |
|---|---|---|
| `image.tag` | `latest` | Pin an immutable tag in production |
| `ingress.host` | `nictiz-demo.yourdomain.com` | Must resolve to the LB IP; also becomes the OAuth redirect URI |
| `oidc.tokenUrl` | in-cluster Keycloak | Where the BFF fetches its `client_credentials` tokens |
| `oidc.issuerUrl` | *(none — required)* | The realm's PUBLIC issuer on the **stack** host, not this one |
| `keycloak.registration.enabled` | `true` | The self-registration Job |
| `keycloak.registration.adminSecret` | `keycloak-secret` | The stack's bootstrap-admin Secret |
| `keycloak.demoUser.enabled` | `true` | Demo human login; password in `nictiz-ui-demo-user` |
| `auth.required` | `true` | BFF rejects anything not via the proxy |
| `auth.oauth2Proxy.enabled` | `true` | The browser-login gate |
| `auth.oauth2Proxy.cookieRefresh` | `4m` | **Load-bearing** — see below |
| `auth.defaultUserName` | `Demo User` | Local-dev fallback only; deployed, the composer is the logged-in user |
| `networkPolicy.enabled` | `true` | Restricts pod ingress to ingress-nginx |

### `oidc.issuerUrl`

Deliberately has no default. It is the freshehr realm's public issuer on the
health-stack host (e.g. `https://health.example.com/auth/realms/freshehr`) —
the UI's oauth2-proxy fetches OIDC discovery from it and sends the browser
there to log in. A wrong value fails only at login time with an opaque error,
so the chart refuses to render without one (`required`), and CI asserts that
refusal survives refactors.

### `auth.oauth2Proxy.cookieRefresh`

Must stay **below** the realm's `accessTokenLifespan` (300 s). The session
cookie outlives the access token stored inside it; refreshing every 4 minutes
keeps that token fresh. Set it ≥ 5 minutes and `/oauth2/auth` starts failing
once the token expires — nginx then 302s the SPA's background API fetches,
which surfaces as opaque JSON-parse errors in the app, not as a login screen.

## How the auth layers fit

| Layer | Does what |
|---|---|
| ingress-nginx `auth-url` → oauth2-proxy | Redirects anonymous browsers into the Keycloak login; verifies the session on every request |
| `auth-response-headers` | Copies the verified `X-Auth-Request-User`/`-Email`/`-Preferred-Username` onto the proxied request |
| BFF `REQUIRE_AUTH` | Rejects requests carrying no proxy identity |
| BFF → EHRbase | `client_credentials` Bearer token as `nictiz-ui-svc` (EHRbase runs `SECURITY_AUTHTYPE=OAUTH`) |
| BFF → openFHIR | Same `nictiz-ui-svc` token with `scope=openfhir.map` + `tenant: freshehr` claim (the engine runs `openfhir.protected` with per-API scopes; `/status` health probe stays permitAll) |
| NetworkPolicy | Only ingress-nginx may connect to the BFF and proxy pods |

Layered because the BFF *trusts* the identity its proxy asserts — inherent to
forward-auth. `REQUIRE_AUTH` alone would still believe a forged header from
inside the cluster; the NetworkPolicy is what makes "came through the ingress"
true rather than assumed.

Two Ingress objects publish the same host: the main one carries the `auth-url`
gate; a second, ungated one exposes only `/oauth2/*` (the login flow cannot
itself require being logged in). The auth annotations are emitted by the
template, not `values.annotations` — an environment values file that overrides
the annotations map must not be able to drop the access control by accident.

Per-user identity is **done**: oauth2-proxy forwards who logged in, `/api/me`
returns them, and every composition's `composer` is the actual person at the
keyboard.

`/healthz` is served outside the guard: kubelet probes hit the pod directly and
are unaffected by edge auth. Externally the path IS edge-gated — an uptime
monitor pointed at `https://<host>/healthz` must either send a Bearer token or
watch the 302 as its "up" signal.
