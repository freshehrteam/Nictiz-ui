/**
 * Registers this app's OIDC clients in the stack's Keycloak realm.
 *
 * The health-stack repo owns the `freshehr` realm but stays agnostic of who
 * consumes it: its realm import carries only the stack's own infrastructure
 * clients. THIS app therefore registers what it needs itself, via the admin
 * API — the same script runs as a Helm hook Job in the cluster and as
 * `npm run register` against the local compose stack.
 *
 * Idempotent by design: create-or-update on every run, so it also serves as
 * the upgrade path (Keycloak's --import-realm never updates an existing
 * realm; this sidesteps that limitation entirely). What it ensures:
 *
 *   - `nictiz-ui-svc` — client_credentials service account for the BFF's
 *     BFF→EHRbase and BFF→openFHIR hops, with the `oauth2-proxy` audience
 *     mapper (so its tokens also pass the stack's edge validator), the
 *     `tenant: freshehr` claim mapper (the protected openFHIR engine keys its
 *     data store by that claim — without it this client is siloed under its
 *     own `sub` and sees none of the stack's mappings), the `openfhir.map`
 *     optional client scope (the engine's mapping API demands it; the BFF
 *     requests it via scope=), and realm role USER.
 *   - `nictiz-ui`     — standard-flow client the UI's session-mode
 *     oauth2-proxy authenticates browser users as; redirect URI derived from
 *     UI_ORIGIN, which IS the chart's ingress.host — one source of truth.
 *   - a demo human user (optional, DEMO_ENABLED) with realm role USER.
 *
 * SECURITY: this runs with the Keycloak bootstrap admin credentials — the
 * price of keeping app-specific realm content out of the stack repo. The Job
 * is short-lived and hook-deleted; the credentials never reach the serving
 * pods.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface DemoUser {
  username: string;
  password: string;
}

export interface RegistrarConfig {
  /** Keycloak base URL including the /auth prefix. */
  url: string;
  realm: string;
  adminUser: string;
  adminPassword: string;
  /** Public origin of the UI, e.g. https://nictiz-demo.freshehr.com */
  uiOrigin: string;
  svcClientId: string;
  svcClientSecret: string;
  uiClientId: string;
  uiClientSecret: string;
  demoUser?: DemoUser;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Realm-reachability polling. Keycloak may still be booting when this runs. */
  waitAttempts?: number;
  waitDelayMs?: number;
}

/** The audience mapper every service token needs to pass the stack's edge validator. */
const AUDIENCE_MAPPER = {
  name: 'oauth2-proxy-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: {
    'included.custom.audience': 'oauth2-proxy',
    'access.token.claim': 'true',
    'id.token.claim': 'false',
  },
};

/**
 * The tenant claim the protected openFHIR engine keys its data store by.
 * Every client of the freshehr stack hardcodes `tenant: freshehr` (same
 * mapper the stack puts on its own api-client/hapi-svc) so all of them share
 * one engine-side store; the engine's fallback is the token's `sub`, which
 * would silo this client into an empty one.
 */
const TENANT_MAPPER = {
  name: 'openfhir-tenant',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-hardcoded-claim-mapper',
  consentRequired: false,
  config: {
    'claim.name': 'tenant',
    'claim.value': 'freshehr',
    'jsonType.label': 'String',
    'access.token.claim': 'true',
    'id.token.claim': 'false',
    'userinfo.token.claim': 'false',
  },
};

/** The one openFHIR per-API scope the BFF needs: /openfhir/tofhir (mapping API). */
const OPENFHIR_SCOPE = 'openfhir.map';

export async function registerClients(cfg: RegistrarConfig): Promise<void> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const log = cfg.log ?? (() => {});
  const base = cfg.url.replace(/\/$/, '');
  const realmBase = `${base}/admin/realms/${cfg.realm}`;

  // ── Wait for the realm — Keycloak may still be importing/booting ───────────
  const attempts = cfg.waitAttempts ?? 60;
  const delay = cfg.waitDelayMs ?? 5000;
  for (let i = 1; ; i++) {
    try {
      const probe = await fetchImpl(`${base}/realms/${cfg.realm}`);
      if (probe.ok) break;
      // 404 with Keycloak up = the realm import failed; keep waiting anyway —
      // a rolling pod serves 404 briefly while importing.
      log(`realm probe ${i}/${attempts}: HTTP ${probe.status}`);
    } catch (err) {
      log(`realm probe ${i}/${attempts}: ${(err as Error).message}`);
    }
    if (i >= attempts) {
      throw new Error(`Keycloak realm '${cfg.realm}' not reachable at ${base} after ${attempts} attempts`);
    }
    await new Promise((r) => setTimeout(r, delay));
  }

  // ── Admin token (bootstrap admin lives in the master realm) ────────────────
  const tokenRes = await fetchImpl(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: cfg.adminUser,
      password: cfg.adminPassword,
    }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`Admin login failed (HTTP ${tokenRes.status}): ${(await tokenRes.text()).slice(0, 300)}`);
  }
  const { access_token: token } = (await tokenRes.json()) as { access_token: string };

  async function api(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetchImpl(`${realmBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`${method} ${path} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return res;
  }

  /** Create the client, or update it in place — the secret must WIN over drift. */
  async function ensureClient(rep: Record<string, unknown>): Promise<string> {
    const found = (await (
      await api('GET', `/clients?clientId=${encodeURIComponent(rep.clientId as string)}`)
    ).json()) as Array<{ id: string }>;

    if (found.length > 0) {
      await api('PUT', `/clients/${found[0].id}`, rep);
      log(`updated client ${rep.clientId}`);
      return found[0].id;
    }
    await api('POST', '/clients', rep);
    const created = (await (
      await api('GET', `/clients?clientId=${encodeURIComponent(rep.clientId as string)}`)
    ).json()) as Array<{ id: string }>;
    log(`created client ${rep.clientId}`);
    return created[0].id;
  }

  async function ensureMapper(
    clientDbId: string,
    mapper: { name: string } & Record<string, unknown>,
  ): Promise<void> {
    const mappers = (await (
      await api('GET', `/clients/${clientDbId}/protocol-mappers/models`)
    ).json()) as Array<{ name: string }>;
    if (!mappers.some((m) => m.name === mapper.name)) {
      await api('POST', `/clients/${clientDbId}/protocol-mappers/models`, mapper);
      log(`added ${mapper.name} mapper`);
    }
  }

  /**
   * Attach a realm client scope as OPTIONAL on the client (requested via
   * scope=). Tolerates the scope not existing: a stack realm from before
   * openFHIR native OAuth has no per-API scopes AND an unprotected engine, so
   * the BFF works there without it — warn rather than fail the whole
   * registration.
   */
  async function ensureOptionalScope(clientDbId: string, scopeName: string): Promise<void> {
    const all = (await (await api('GET', '/client-scopes')).json()) as Array<{
      id: string;
      name: string;
    }>;
    const scope = all.find((s) => s.name === scopeName);
    if (!scope) {
      log(
        `WARNING: client scope '${scopeName}' not found in realm '${cfg.realm}' — ` +
          `stack realm predates openFHIR native OAuth; skipping (BFF→openFHIR will only work unprotected)`,
      );
      return;
    }
    const attached = (await (
      await api('GET', `/clients/${clientDbId}/optional-client-scopes`)
    ).json()) as Array<{ name: string }>;
    if (!attached.some((s) => s.name === scopeName)) {
      await api('PUT', `/clients/${clientDbId}/optional-client-scopes/${scope.id}`);
      log(`attached optional client scope ${scopeName}`);
    }
  }

  /** The USER realm role is owned by the stack's realm import — never created here. */
  async function realmRole(name: string): Promise<{ id: string; name: string }> {
    try {
      return (await (await api('GET', `/roles/${encodeURIComponent(name)}`)).json()) as {
        id: string;
        name: string;
      };
    } catch (err) {
      throw new Error(
        `Realm role '${name}' not found — is '${cfg.realm}' the health-stack realm? (${(err as Error).message})`,
      );
    }
  }

  async function ensureRealmRole(userId: string, roleName: string): Promise<void> {
    const assigned = (await (
      await api('GET', `/users/${userId}/role-mappings/realm`)
    ).json()) as Array<{ name: string }>;
    if (assigned.some((r) => r.name === roleName)) return;
    await api('POST', `/users/${userId}/role-mappings/realm`, [await realmRole(roleName)]);
    log(`granted realm role ${roleName}`);
  }

  // ── 1) The BFF's service account ───────────────────────────────────────────
  const svcDbId = await ensureClient({
    clientId: cfg.svcClientId,
    name: 'Nictiz EMR BFF',
    description: 'client_credentials service account for the nictiz-ui BFF→EHRbase and BFF→openFHIR hops. Registered by the nictiz-ui release.',
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    secret: cfg.svcClientSecret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    fullScopeAllowed: true,
  });
  await ensureMapper(svcDbId, AUDIENCE_MAPPER);
  await ensureMapper(svcDbId, TENANT_MAPPER);
  await ensureOptionalScope(svcDbId, OPENFHIR_SCOPE);
  const svcUser = (await (
    await api('GET', `/clients/${svcDbId}/service-account-user`)
  ).json()) as { id: string };
  await ensureRealmRole(svcUser.id, 'USER');

  // ── 2) The browser-login client for the UI's oauth2-proxy ──────────────────
  await ensureClient({
    clientId: cfg.uiClientId,
    name: 'Nictiz EMR browser login',
    description: 'Standard-flow client the nictiz-ui oauth2-proxy (session mode) authenticates browser users as. Registered by the nictiz-ui release.',
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    secret: cfg.uiClientSecret,
    serviceAccountsEnabled: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    fullScopeAllowed: true,
    redirectUris: [`${cfg.uiOrigin.replace(/\/$/, '')}/oauth2/callback`],
    webOrigins: [cfg.uiOrigin.replace(/\/$/, '')],
  });

  // ── 3) The demo human user ─────────────────────────────────────────────────
  if (cfg.demoUser) {
    const { username, password } = cfg.demoUser;
    const found = (await (
      await api('GET', `/users?username=${encodeURIComponent(username)}&exact=true`)
    ).json()) as Array<{ id: string }>;

    let userId: string;
    if (found.length > 0) {
      userId = found[0].id;
    } else {
      await api('POST', '/users', {
        username,
        enabled: true,
        firstName: 'Demo',
        lastName: 'User',
        email: `${username}@example.com`,
        emailVerified: true,
      });
      const created = (await (
        await api('GET', `/users?username=${encodeURIComponent(username)}&exact=true`)
      ).json()) as Array<{ id: string }>;
      userId = created[0].id;
      log(`created user ${username}`);
    }
    // Reset on every run so the Secret always matches what Keycloak accepts.
    await api('PUT', `/users/${userId}/reset-password`, {
      type: 'password',
      value: password,
      temporary: false,
    });
    await ensureRealmRole(userId, 'USER');
  }

  log('registration complete');
}

// ── CLI entrypoint (the Job and `npm run register` both land here) ───────────
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const env = process.env;
  const demoEnabled = !/^(0|false|no)$/i.test(env.DEMO_ENABLED ?? 'true');
  registerClients({
    // Dev fallbacks target the local compose stack (Keycloak on :8081,
    // bootstrap admin admin/admin, fixed dev client secrets matching the BFF's
    // own dev fallbacks). Deployed, the Job sets every one of these.
    url: env.KC_URL ?? 'http://localhost:8081/auth',
    realm: env.KC_REALM ?? 'freshehr',
    adminUser: env.KC_ADMIN_USER ?? 'admin',
    adminPassword: env.KC_ADMIN_PASSWORD ?? 'admin',
    uiOrigin: env.UI_ORIGIN ?? 'http://localhost:3001',
    svcClientId: env.OIDC_CLIENT_ID ?? 'nictiz-ui-svc',
    svcClientSecret: env.OIDC_CLIENT_SECRET ?? 'dev-nictiz-ui-svc-secret',
    uiClientId: env.OAUTH2_CLIENT_ID ?? 'nictiz-ui',
    uiClientSecret: env.OAUTH2_CLIENT_SECRET ?? 'dev-nictiz-ui-oauth2-secret',
    demoUser: demoEnabled
      ? { username: env.DEMO_USERNAME ?? 'demo', password: env.DEMO_PASSWORD ?? 'demo' }
      : undefined,
    log: (m) => console.log(`[register] ${m}`),
    waitAttempts: Number(env.KC_WAIT_ATTEMPTS ?? 60),
    waitDelayMs: Number(env.KC_WAIT_DELAY_MS ?? 5000),
  }).catch((err) => {
    console.error(`[register] FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
}
