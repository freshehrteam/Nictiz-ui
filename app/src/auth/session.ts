/**
 * The logged-in user.
 *
 * Identity is decided OUTSIDE this app. The deployed stack gates the whole host
 * at the ingress (forward-auth to oauth2-proxy: anonymous browsers are sent to
 * the Keycloak login), so by the time a request reaches the BFF it has already
 * been authenticated and carries who the user is (`X-Auth-Request-User`); the
 * BFF re-exposes that at `GET /api/me`. This module's job is only to make that
 * answer available synchronously to the form layer.
 *
 * `resolveUser()` must be awaited once at startup, before any form renders.
 * Until it resolves — and in unit tests, which never call it — `currentUser()`
 * returns the fallback below, so nothing ever renders with an empty composer.
 *
 * `composer` and `context/start_time` are both MANDATORY at the COMPOSITION
 * root, and neither is a clinical judgement: the composer is whoever is logged
 * in, and the start time is when they started recording. Presenting them as
 * empty inputs asked the user to type facts the system already knows, and left
 * a mandatory field blank by default.
 */

export interface User {
  /** DV_IDENTIFIER-ish handle. Unused today; here so callers can grow into it. */
  id: string;
  /** What lands in `composer|name`. */
  name: string;
}

/**
 * Used until `resolveUser()` answers, and in unit tests. Not a pretend login:
 * it is what a composition is attributed to when the identity layer told us
 * nothing, and it is deliberately recognisable as such in the CDR.
 */
const FALLBACK_USER: User = {
  id: 'unknown',
  name: 'Unknown User',
};

let user: User = FALLBACK_USER;

/**
 * Whether the edge proxy actually identified someone. False locally (no gate)
 * and until `resolveUser()` answers — which is exactly when a logout button
 * would be a lie: there is no session to end.
 */
let authenticated = false;

/**
 * Who is recording. Synchronous by design — `mb-form.ctx` and
 * `ensureMandatoryContext()` both need an answer during render, not a promise.
 */
export function currentUser(): User {
  return user;
}

/**
 * Asks the BFF who the authenticated caller is and caches the answer.
 *
 * Called once from `main.ts` before the shell mounts. A failure here is not
 * fatal: identity is not what makes the app usable, and blocking the whole EMR
 * because one metadata call failed would be the wrong trade. The fallback user
 * stands in, and the composition still satisfies EHRbase's mandatory composer.
 */
export async function resolveUser(): Promise<User> {
  try {
    const res = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    if (!res.ok) return user;

    const body = (await res.json()) as (Partial<User> & { authenticated?: boolean }) | null;
    if (body?.name) user = { id: body.id ?? body.name, name: body.name };
    authenticated = body?.authenticated === true;
  } catch {
    // Offline or BFF down — the fallback already covers it.
  }
  return user;
}

/** True only when the BFF reported a proxy-verified identity. */
export function isAuthenticated(): boolean {
  return authenticated;
}

/**
 * Ends the session: a full-page navigation to oauth2-proxy's sign-out
 * endpoint, which clears the session cookie AND (via the proxy's backend
 * logout URL) ends the Keycloak SSO session — without that second half the
 * next request would silently log the same user straight back in. Landing
 * back on `/` unauthenticated then redirects to the Keycloak login.
 *
 * A navigation, not a fetch: the proxy sits in FRONT of this origin, and the
 * cookie it must clear belongs to the top-level document.
 */
export function logout(): void {
  window.location.href = '/oauth2/sign_out';
}

/**
 * "Now", in the seconds-precision form openEHR expects for DV_DATE_TIME.
 *
 * Local time deliberately, not UTC: this stamps when the user sat down to
 * record, and `toISOString()` would shift that by the timezone offset — a
 * composition recorded at 09:00 in Amsterdam filed as 07:00.
 */
export function nowLocalIso(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 19);
}
