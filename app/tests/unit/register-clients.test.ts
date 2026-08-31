/**
 * Self-registration against the stack's Keycloak realm.
 *
 * The contract that matters: the script must be IDEMPOTENT (it is the upgrade
 * path — --import-realm never updates an existing realm), the client secret
 * must WIN over whatever the realm currently holds (drift here presents as
 * every BFF call 401ing), and a wrong realm must fail loudly rather than
 * half-register.
 */

import { describe, expect, it } from 'vitest';

import { registerClients, type RegistrarConfig } from '../../scripts/register-clients';

/** Minimal in-memory Keycloak admin API. */
function fakeKeycloak(opts: { realmRoles?: string[] } = {}) {
  const realmRoles = (opts.realmRoles ?? ['USER', 'ADMIN']).map((name, i) => ({
    id: `role-${i}`,
    name,
  }));
  const clients: Array<Record<string, any>> = [];
  const users: Array<Record<string, any>> = [];
  const mappers = new Map<string, Array<Record<string, any>>>();
  const roleMappings = new Map<string, Array<{ id: string; name: string }>>();
  const passwords = new Map<string, string>();
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${nextId++}`;

  const impl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input), 'http://x');
    const path = url.pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });

    if (path.endsWith('/realms/freshehr') && method === 'GET') return json({ realm: 'freshehr' });
    if (path.endsWith('/realms/master/protocol/openid-connect/token'))
      return json({ access_token: 'admin-token' });

    const m = path.match(/\/admin\/realms\/freshehr(\/.*)$/);
    if (!m) return new Response('not found', { status: 404 });
    const sub = m[1];
    // Admin API bodies are JSON; the token request above is form-urlencoded.
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    let match: RegExpMatchArray | null;
    if (sub === '/clients' && method === 'GET') {
      const wanted = url.searchParams.get('clientId');
      return json(clients.filter((c) => c.clientId === wanted));
    }
    if (sub === '/clients' && method === 'POST') {
      const dbId = id('client');
      clients.push({ id: dbId, ...body });
      if (body.serviceAccountsEnabled) {
        const uid = id('svc-user');
        users.push({ id: uid, username: `service-account-${body.clientId}`, serviceAccountOf: dbId });
      }
      return json(null, 201);
    }
    if ((match = sub.match(/^\/clients\/([^/]+)$/)) && method === 'PUT') {
      const c = clients.find((c) => c.id === match![1]);
      if (!c) return new Response('no client', { status: 404 });
      Object.assign(c, body);
      return json(null, 204);
    }
    if ((match = sub.match(/^\/clients\/([^/]+)\/protocol-mappers\/models$/))) {
      const list = mappers.get(match[1]) ?? [];
      if (method === 'GET') return json(list);
      list.push(body);
      mappers.set(match[1], list);
      return json(null, 201);
    }
    if ((match = sub.match(/^\/clients\/([^/]+)\/service-account-user$/))) {
      const u = users.find((u) => u.serviceAccountOf === match![1]);
      return u ? json(u) : new Response('no svc user', { status: 404 });
    }
    if ((match = sub.match(/^\/roles\/([^/]+)$/))) {
      const role = realmRoles.find((r) => r.name === decodeURIComponent(match![1]));
      return role ? json(role) : new Response('no role', { status: 404 });
    }
    if ((match = sub.match(/^\/users\/([^/]+)\/role-mappings\/realm$/))) {
      const list = roleMappings.get(match[1]) ?? [];
      if (method === 'GET') return json(list);
      list.push(...body);
      roleMappings.set(match[1], list);
      return json(null, 204);
    }
    if (sub.startsWith('/users?') || sub === '/users') {
      if (method === 'GET') {
        const wanted = url.searchParams.get('username');
        return json(users.filter((u) => u.username === wanted));
      }
      users.push({ id: id('user'), ...body });
      return json(null, 201);
    }
    if ((match = sub.match(/^\/users\/([^/]+)\/reset-password$/))) {
      passwords.set(match[1], body.value);
      return json(null, 204);
    }
    return new Response(`unhandled ${method} ${sub}`, { status: 500 });
  }) as unknown as typeof fetch;

  return { impl, clients, users, mappers, roleMappings, passwords };
}

const CFG: Omit<RegistrarConfig, 'fetchImpl'> = {
  url: 'http://keycloak.test/auth',
  realm: 'freshehr',
  adminUser: 'admin',
  adminPassword: 'admin',
  uiOrigin: 'https://emr.example.com',
  svcClientId: 'nictiz-ui-svc',
  svcClientSecret: 'svc-secret',
  uiClientId: 'nictiz-ui',
  uiClientSecret: 'ui-secret',
  demoUser: { username: 'demo', password: 'demo-pw' },
  waitAttempts: 2,
  waitDelayMs: 1,
};

describe('registerClients', () => {
  it('creates both clients, the audience mapper, roles and the demo user', async () => {
    const kc = fakeKeycloak();
    await registerClients({ ...CFG, fetchImpl: kc.impl });

    const svc = kc.clients.find((c) => c.clientId === 'nictiz-ui-svc')!;
    expect(svc.serviceAccountsEnabled).toBe(true);
    expect(svc.secret).toBe('svc-secret');
    expect(kc.mappers.get(svc.id)![0].config['included.custom.audience']).toBe('oauth2-proxy');

    const ui = kc.clients.find((c) => c.clientId === 'nictiz-ui')!;
    expect(ui.standardFlowEnabled).toBe(true);
    expect(ui.redirectUris).toEqual(['https://emr.example.com/oauth2/callback']);
    expect(ui.webOrigins).toEqual(['https://emr.example.com']);

    // The service account and the demo user both hold the USER realm role.
    const svcUser = kc.users.find((u) => u.serviceAccountOf === svc.id)!;
    expect(kc.roleMappings.get(svcUser.id)!.map((r) => r.name)).toContain('USER');
    const demo = kc.users.find((u) => u.username === 'demo')!;
    expect(kc.roleMappings.get(demo.id)!.map((r) => r.name)).toContain('USER');
    expect(kc.passwords.get(demo.id)).toBe('demo-pw');
  });

  it('is idempotent — a second run updates in place instead of duplicating', async () => {
    const kc = fakeKeycloak();
    await registerClients({ ...CFG, fetchImpl: kc.impl });
    await registerClients({ ...CFG, fetchImpl: kc.impl, svcClientSecret: 'rotated' });

    expect(kc.clients.filter((c) => c.clientId === 'nictiz-ui-svc')).toHaveLength(1);
    expect(kc.clients.filter((c) => c.clientId === 'nictiz-ui')).toHaveLength(1);
    expect(kc.users.filter((u) => u.username === 'demo')).toHaveLength(1);
    // The mapper is not duplicated; the secret is overwritten (secret WINS).
    const svc = kc.clients.find((c) => c.clientId === 'nictiz-ui-svc')!;
    expect(kc.mappers.get(svc.id)).toHaveLength(1);
    expect(svc.secret).toBe('rotated');
    // Roles are not stacked twice either.
    const demo = kc.users.find((u) => u.username === 'demo')!;
    expect(kc.roleMappings.get(demo.id)!.filter((r) => r.name === 'USER')).toHaveLength(1);
  });

  it('updates the redirect URI when the host changes', async () => {
    const kc = fakeKeycloak();
    await registerClients({ ...CFG, fetchImpl: kc.impl });
    await registerClients({ ...CFG, fetchImpl: kc.impl, uiOrigin: 'https://new.example.com' });

    const ui = kc.clients.find((c) => c.clientId === 'nictiz-ui')!;
    expect(ui.redirectUris).toEqual(['https://new.example.com/oauth2/callback']);
  });

  it('skips the demo user when not configured', async () => {
    const kc = fakeKeycloak();
    await registerClients({ ...CFG, fetchImpl: kc.impl, demoUser: undefined });
    expect(kc.users.find((u) => u.username === 'demo')).toBeUndefined();
  });

  it('fails loudly when the USER realm role is missing (wrong realm)', async () => {
    // Half-registering against the wrong realm would look like success and
    // then 403 at runtime. The stack's realm import owns the role; its absence
    // means this is not that realm.
    const kc = fakeKeycloak({ realmRoles: [] });
    await expect(registerClients({ ...CFG, fetchImpl: kc.impl })).rejects.toThrow(/USER.*not found/);
  });

  it('fails when Keycloak never becomes reachable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      registerClients({ ...CFG, fetchImpl: impl, waitAttempts: 2, waitDelayMs: 1 }),
    ).rejects.toThrow(/not reachable/);
  });
});
