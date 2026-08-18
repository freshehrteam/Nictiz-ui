# nictiz-ui

Helm chart for the Nictiz openEHR EMR — the SPA and its BFF, in one pod.

Deploys **alongside** the `health-stack` release from
`freshehr-open-health-stack`, into the same namespace, as a separate release.

## Why one pod

The BFF is not optional infrastructure wrapped around the SPA. It holds the
EHRbase credential (which must never reach the browser) and it is what makes
`/api` same-origin, so the SPA needs no CORS configuration at all. Splitting them
into an nginx pod and a node pod would reintroduce the cross-origin problem the
BFF exists to remove, in exchange for nothing.

## Requirements

| | |
|---|---|
| Namespace | The one the `health-stack` release occupies (`health-stack`) |
| Secret | `ehrbase-secret`, owned by that release — referenced, not copied |
| Secret | `nictiz-ui-basic-auth` (htpasswd), created out-of-band |
| Cluster | ingress-nginx + cert-manager, installed by the stack's Terraform |
| DNS | `ingress.host` resolving to the hcloud load balancer IP |

Same-namespace is not cosmetic: the BFF resolves `ehrbase`, `hapi` and `openfhir`
by bare Service name, and reads the EHRbase password from a namespace-local
Secret.

## Install

Installed from this repo, not from a chart registry. CI validates the chart on
every change (`.github/workflows/helm-lint.yml`) but publishes nothing — a
packaged copy in a registry would be a second artifact that nothing installs
from, and that can silently disagree with the working tree.

```bash
htpasswd -nbB <user> '<password>' > auth
kubectl create secret generic nictiz-ui-basic-auth -n health-stack --from-file=auth
rm auth

helm upgrade --install nictiz-ui . \
  -n health-stack \
  -f values-hetzner.yaml \
  --set ingress.host=nictiz-demo.example.com \
  --set image.tag=v0.1.0
```

## Values worth knowing

| Key | Default | Notes |
|---|---|---|
| `image.tag` | `latest` | Pin an immutable tag in production |
| `ingress.host` | `nictiz-demo.yourdomain.com` | Must resolve to the LB IP |
| `auth.required` | `true` | BFF rejects anything not via the proxy |
| `auth.basicAuth.enabled` | `true` | The ingress gate |
| `auth.basicAuth.create` | `false` | Keep false — see below |
| `auth.defaultUserName` | `Demo User` | Written to `composer` on every composition |
| `networkPolicy.enabled` | `true` | Restricts pod ingress to ingress-nginx |
| `ehrbase.auth.existingSecret` | `ehrbase-secret` | Owned by the health-stack release |

### `auth.basicAuth.create`

Leave it `false`. It renders the htpasswd Secret from values, which puts the only
credential guarding the CDR into a file that tends to end up in git, and into the
Helm release history. It exists for throwaway demo clusters. The chart refuses a
plaintext password outright — nginx compares against a hash, and would otherwise
simply reject every login while looking correctly configured.

### `ehrbase.auth.existingSecret`

Referenced rather than copied so there is one source of truth for the EHRbase
password across two independently-released charts. Terraform generates it, the
health-stack release renders it, this release reads it. Copying the value would
drift silently on rotation — and present as every BFF call 401ing against a CDR
that is working fine.

## How the auth layers fit

| Layer | Does what |
|---|---|
| ingress-nginx basic-auth | Verifies credentials before the BFF is reached |
| BFF `REQUIRE_AUTH` | Rejects requests carrying no proxy identity |
| NetworkPolicy | Only ingress-nginx may connect to the pod |

Layered because the BFF *trusts* the identity its proxy asserts — inherent to
forward-auth. `REQUIRE_AUTH` alone would still believe a forged header from
inside the cluster; the NetworkPolicy is what makes "came through the ingress"
true rather than assumed.

ingress-nginx does not forward `$remote_user` without the `auth-snippet`
annotation, which since v1.9 requires `allow-snippet-annotations` **and**
`annotations-risk-level: Critical` cluster-wide. Rather than weaken a shared
controller for every tenant, the BFF reads the username from the `Authorization`
header nginx already forwards (`TRUST_BASIC_AUTH`).

`/healthz` is served outside the guard: kubelet probes are not authenticated
callers, and gating them would keep the Deployment from ever going ready.

## Migrating to per-user identity

Basic-auth is a **shared login**. It keeps the internet out; it does not tell you
who was at the keyboard, which is why `composer` is a deployment identity rather
than a clinician name.

Put an OIDC proxy (oauth2-proxy) in front and set
`auth.basicAuth.enabled=false`. The BFF already prefers `X-Auth-Request-User` /
`X-Auth-Request-Email` over the basic credential, so real per-user composers
start appearing with no application change.
