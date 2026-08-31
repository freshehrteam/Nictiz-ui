/**
 * Deciding who a request is from.
 *
 * Extracted from the BFF so it can be unit-tested directly: this is the code
 * that decides whether a request is served at all, and getting it wrong in
 * either direction is costly — too strict and the app is unreachable, too loose
 * and the CDR is open.
 *
 * What this module does NOT do is authenticate. Credentials are verified at the
 * edge — oauth2-proxy answers the ingress's auth-url subrequest after a
 * Keycloak login (or a valid Bearer JWT), and the ingress forwards the verified
 * identity as X-Auth-Request-User / X-Auth-Request-Email. Everything here READS
 * that already-verified identity. Re-checking the credential would mean this
 * service talking OIDC itself, which is precisely the coupling the edge proxy
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
 * Who the authenticating proxy says this request is from, or null if it did not
 * come through one.
 *
 * A blank or whitespace-only header counts as NO identity: an empty forwarded
 * header means the proxy did not identify anyone, and accepting it would
 * authenticate the request as the empty user. A blank user header falls
 * through to the email header for the same reason — blank is absence, not a
 * value.
 */
export function callerIdentity(headers: HeaderBag, names: IdentityHeaders): string | null {
  const user = firstValue(headers[names.user])?.trim();
  if (user) return user;
  const email = firstValue(headers[names.email])?.trim();
  if (email) return email;
  return null;
}
