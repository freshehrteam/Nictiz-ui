/**
 * Identity resolution, and the composer it produces.
 *
 * This is data-integrity territory rather than UI polish: `composer|name` is
 * MANDATORY at the COMPOSITION root and is written into every composition the
 * app files. The failure mode being guarded against is silent — a composition
 * stored against the wrong (or fallback) identity looks completely normal in
 * the CDR, and there is nothing to notice later.
 *
 * The two traps that these tests exist for:
 *   1. `resolveUser()` is async but `currentUser()` is read synchronously
 *      during render. Anything that captures the name at module-evaluation
 *      time freezes the pre-resolution fallback forever.
 *   2. `/api/me` failing must not take the app down. Identity is metadata; the
 *      EMR is still usable without it, and blocking on it would trade a whole
 *      application for a display name.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session module caches the resolved user in module scope, so every test
 * needs a fresh copy. `resetModules` + dynamic import is the only way to get
 * one; a shared import would leak the previous test's identity.
 */
async function freshSession() {
  vi.resetModules();
  return import('../../src/auth/session');
}

async function freshContext() {
  vi.resetModules();
  const session = await import('../../src/auth/session');
  const context = await import('../../src/forms/context');
  return { session, context };
}

/** Stubs `fetch` with one JSON response, as `/api/me` would answer it. */
function stubMe(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('currentUser before resolution', () => {
  it('returns a fallback rather than an empty name', async () => {
    const { currentUser } = await freshSession();

    // An empty composer is not a cosmetic problem: EHRbase rejects the
    // composition outright, so there must always be something here.
    expect(currentUser().name).toBeTruthy();
  });

  it('does not invent a plausible clinician', async () => {
    const { currentUser } = await freshSession();

    // The fallback is used when the system genuinely does not know who is at
    // the keyboard. Filing that under a realistic-looking human name would
    // misattribute a clinical record.
    expect(currentUser().name).toBe('Unknown User');
    expect(currentUser().id).toBe('unknown');
  });
});

describe('resolveUser', () => {
  it('adopts the identity the BFF reports', async () => {
    stubMe({ id: 'demo', name: 'Demo User', authenticated: true });
    const { resolveUser, currentUser } = await freshSession();

    await resolveUser();

    expect(currentUser().name).toBe('Demo User');
    expect(currentUser().id).toBe('demo');
  });

  it('falls back to the name when the BFF sends no id', async () => {
    stubMe({ name: 'Demo User' });
    const { resolveUser, currentUser } = await freshSession();

    await resolveUser();

    expect(currentUser().id).toBe('Demo User');
  });

  it('keeps the fallback when the BFF answers without a name', async () => {
    // A response that parses but carries nothing usable must not blank out the
    // composer — that would turn a degraded identity into a rejected save.
    stubMe({ id: 'demo', authenticated: true });
    const { resolveUser, currentUser } = await freshSession();

    await resolveUser();

    expect(currentUser().name).toBe('Unknown User');
  });

  it('survives a non-OK response', async () => {
    stubMe({ error: 'nope' }, false);
    const { resolveUser, currentUser } = await freshSession();

    await expect(resolveUser()).resolves.toBeDefined();
    expect(currentUser().name).toBe('Unknown User');
  });

  it('survives fetch rejecting outright', async () => {
    // Offline, or the BFF down. The app must still start.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { resolveUser, currentUser } = await freshSession();

    await expect(resolveUser()).resolves.toBeDefined();
    expect(currentUser().name).toBe('Unknown User');
  });
});

describe('composer wiring (the freeze trap)', () => {
  it('reflects the resolved user, not the value at import time', async () => {
    stubMe({ id: 'demo', name: 'Demo User' });
    const { session, context } = await freshContext();

    // `forms/context` is imported BEFORE resolution here, exactly as it is at
    // runtime. If FORM_CTX.composer were a plain property it would have already
    // captured the fallback and this would fail.
    expect(context.FORM_CTX.composer).toBe('Unknown User');

    await session.resolveUser();

    expect(context.FORM_CTX.composer).toBe('Demo User');
  });

  it('builds contextDefaults from the current identity', async () => {
    stubMe({ id: 'demo', name: 'Demo User' });
    const { session, context } = await freshContext();

    await session.resolveUser();

    expect(context.contextDefaults()['composer|name']).toBe('Demo User');
  });

  it('stamps the resolved composer onto a composition', async () => {
    stubMe({ id: 'demo', name: 'Demo User' });
    const { session, context } = await freshContext();
    await session.resolveUser();

    const flat = context.withCompositionContext({}, 'eps', '2026-01-01T09:00:00');

    // The end-to-end assertion that matters: what actually reaches the CDR.
    expect(flat['eps/composer|name']).toBe('Demo User');
  });
});
