/**
 * The BFF→EHRbase token manager.
 *
 * What matters here is the caching contract: a token is fetched once and
 * reused, refreshed before it expires, and a burst of concurrent callers must
 * produce ONE request to Keycloak — a stampede on the token endpoint is a
 * self-inflicted outage. Failures must reject with the reason Keycloak gave,
 * and must NOT poison the manager: the next call retries.
 */

import { describe, expect, it, vi } from 'vitest';

import { createTokenManager } from '../../server/oidc';

/** A fake Keycloak: answers every POST with the queued response. */
function fakeFetch(
  responses: Array<{ status?: number; body?: unknown; text?: string }>,
) {
  let calls = 0;
  const impl = vi.fn(async () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    const text = next.text ?? JSON.stringify(next.body ?? {});
    return new Response(text, {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, count: () => calls, mock: impl };
}

function tokenResponse(token: string, expiresIn = 300) {
  return { body: { access_token: token, expires_in: expiresIn } };
}

const OPTS = {
  tokenUrl: 'http://keycloak.test/token',
  clientId: 'nictiz-ui-svc',
  clientSecret: 's3cret',
};

describe('createTokenManager', () => {
  it('fetches a token and sends client_credentials as form-urlencoded', async () => {
    const kc = fakeFetch([tokenResponse('tok-1')]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    expect(await tokens.getToken()).toBe('tok-1');

    const [url, init] = kc.mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPTS.tokenUrl);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const params = new URLSearchParams(String(init.body));
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('nictiz-ui-svc');
    expect(params.get('client_secret')).toBe('s3cret');
  });

  it('caches the token within its lifetime', async () => {
    let nowMs = 0;
    const kc = fakeFetch([tokenResponse('tok-1', 300), tokenResponse('tok-2', 300)]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl, now: () => nowMs });

    expect(await tokens.getToken()).toBe('tok-1');
    nowMs = 200_000; // 200 s in — well before the 300 s − 30 s skew boundary
    expect(await tokens.getToken()).toBe('tok-1');
    expect(kc.count()).toBe(1);
  });

  it('refreshes once the skew window is reached, not at full expiry', async () => {
    let nowMs = 0;
    const kc = fakeFetch([tokenResponse('tok-1', 300), tokenResponse('tok-2', 300)]);
    const tokens = createTokenManager({
      ...OPTS,
      fetchImpl: kc.impl,
      now: () => nowMs,
      skewSeconds: 30,
    });

    expect(await tokens.getToken()).toBe('tok-1');
    // 271 s: token still technically alive (expires at 300 s) but inside the
    // 30 s skew — using it risks it dying in flight to EHRbase.
    nowMs = 271_000;
    expect(await tokens.getToken()).toBe('tok-2');
    expect(kc.count()).toBe(2);
  });

  it('shares one HTTP request among concurrent callers', async () => {
    const kc = fakeFetch([tokenResponse('tok-1')]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    const results = await Promise.all([
      tokens.getToken(),
      tokens.getToken(),
      tokens.getToken(),
    ]);

    expect(results).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(kc.count()).toBe(1);
  });

  it('invalidate() forces the next call to fetch fresh', async () => {
    const kc = fakeFetch([tokenResponse('tok-1'), tokenResponse('tok-2')]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    expect(await tokens.getToken()).toBe('tok-1');
    tokens.invalidate();
    expect(await tokens.getToken()).toBe('tok-2');
    expect(kc.count()).toBe(2);
  });

  it("rejects a 401 with Keycloak's error_description", async () => {
    const kc = fakeFetch([
      {
        status: 401,
        body: { error: 'invalid_client', error_description: 'Invalid client credentials' },
      },
    ]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    await expect(tokens.getToken()).rejects.toThrow(/HTTP 401.*Invalid client credentials/);
  });

  it('rejects a 500 with the status and body excerpt', async () => {
    const kc = fakeFetch([{ status: 500, text: 'Internal Server Error' }]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    await expect(tokens.getToken()).rejects.toThrow(/HTTP 500.*Internal Server Error/);
  });

  it('rejects malformed JSON rather than caching garbage', async () => {
    const kc = fakeFetch([{ status: 200, text: '<html>proxy error page</html>' }]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    await expect(tokens.getToken()).rejects.toThrow(/non-JSON/);
  });

  it('rejects a 200 with no access_token', async () => {
    const kc = fakeFetch([{ status: 200, body: { expires_in: 300 } }]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    await expect(tokens.getToken()).rejects.toThrow(/no access_token/);
  });

  it('is not poisoned by a failed fetch — the next call retries', async () => {
    // The trap: an in-flight promise cached forever would replay the first
    // failure to every future caller, turning one Keycloak blip into a
    // permanent outage that only a pod restart clears.
    const kc = fakeFetch([{ status: 500, text: 'boom' }, tokenResponse('tok-2')]);
    const tokens = createTokenManager({ ...OPTS, fetchImpl: kc.impl });

    await expect(tokens.getToken()).rejects.toThrow(/HTTP 500/);
    expect(await tokens.getToken()).toBe('tok-2');
    expect(kc.count()).toBe(2);
  });
});
