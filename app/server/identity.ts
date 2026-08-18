/**
 * Deciding who a request is from.
 *
 * Extracted from the BFF so it can be unit-tested directly: this is the code
 * that decides whether a request is served at all, and getting it wrong in
 * either direction is costly — too strict and the app is unreachable, too loose
 * and the CDR is open.
 *
 * What this module does NOT do is authenticate. Credentials are verified by the
 * ingress before a request reaches this process; everything here READS an
 * already-verified identity. Re-checking the password would mean this service
 * holding the htpasswd file, which is precisely the coupling the ingress gate
 * exists to avoid.
 */

/** Headers the identity is read from. Lowercase — Node normalises header keys. */
export interface IdentityHeaders {
  /** e.g. `x-auth-request-user` (oauth2-proxy's convention). */
  user: string;
  /** e.g. `x-auth-request-email`. */
  email: string;
}

/** The subset of a request this needs. Keeps it independent of express. */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** First value of a possibly-repeated header. */
function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The username from a Basic `Authorization` header, or null.
 *
 * Deliberately ignores the password half. nginx has already checked it; this is
 * an identity lookup, not an auth decision.
 */
export function basicAuthUser(header: string | string[] | undefined): string | null {
  const value = firstValue(header);
  if (!value) return null;

  // `Basic` per RFC 7617, case-insensitive, followed by the token.
  const match = /^basic\s+(\S+)\s*$/i.exec(value);
  if (!match) return null;

  const token = match[1];

  /**
   * Node's base64 decoder is lenient: it SKIPS invalid characters rather than
   * throwing, so `Buffer.from(garbage, 'base64')` returns a partial buffer and
   * a wrong username instead of an error. Validating the alphabet first is what
   * makes a malformed header fail closed.
   */
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(token)) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }

  // A credential with no ':' is malformed per RFC 7617. Treating the whole
  // string as a username would invent an identity out of a broken header.
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;

  const user = decoded.slice(0, separator).trim();
  return user || null;
}

/**
 * Who the authenticating proxy says this request is from, or null if it did not
 * come through one.
 *
 * Header identity wins over Basic. If an OIDC proxy is in front it forwards a
 * real per-user identity, which is strictly better than a shared basic-auth
 * login — and that migration should not require an application change.
 */
export function callerIdentity(
  headers: HeaderBag,
  names: IdentityHeaders,
  trustBasicAuth: boolean,
): string | null {
  const fromHeader = firstValue(headers[names.user]) ?? firstValue(headers[names.email]);
  if (fromHeader?.trim()) return fromHeader.trim();

  if (trustBasicAuth) return basicAuthUser(headers.authorization);
  return null;
}
