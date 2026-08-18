/**
 * Who a request is from — the check that decides whether it is served at all.
 *
 * Both failure directions are expensive and neither is loud:
 *   - too strict → the whole EMR 401s behind a correctly-configured ingress
 *   - too loose  → a malformed or absent credential yields an identity, and the
 *                  BFF serves the entire CDR to it
 *
 * The second is the dangerous one, because nothing about it looks like a
 * failure. Most of these tests exist to pin it down.
 */

import { describe, expect, it } from 'vitest';

import { basicAuthUser, callerIdentity } from '../../server/identity';

const HEADERS = { user: 'x-auth-request-user', email: 'x-auth-request-email' };

/** Encodes a credential the way a browser would. */
function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

describe('basicAuthUser', () => {
  it('extracts the username from a well-formed header', () => {
    expect(basicAuthUser(basic('demo', 'secret123'))).toBe('demo');
  });

  it('accepts the scheme case-insensitively (RFC 7617)', () => {
    const encoded = Buffer.from('demo:secret').toString('base64');
    expect(basicAuthUser(`basic ${encoded}`)).toBe('demo');
    expect(basicAuthUser(`BASIC ${encoded}`)).toBe('demo');
    expect(basicAuthUser(`BaSiC ${encoded}`)).toBe('demo');
  });

  it('keeps the whole username when the password contains a colon', () => {
    // Splitting on the LAST colon, or on all of them, would silently truncate
    // or mangle the username for anyone whose password contains one.
    expect(basicAuthUser(basic('demo', 'pass:with:colons'))).toBe('demo');
  });

  it('handles a username containing an @ (email-style logins)', () => {
    expect(basicAuthUser(basic('user@example.com', 'pw'))).toBe('user@example.com');
  });

  it('handles non-ASCII usernames', () => {
    expect(basicAuthUser(basic('gaspär', 'pw'))).toBe('gaspär');
  });

  it('returns null when the header is absent', () => {
    expect(basicAuthUser(undefined)).toBeNull();
    expect(basicAuthUser('')).toBeNull();
  });

  it('rejects a non-Basic scheme', () => {
    // A Bearer token is not a basic credential; reading a username out of it
    // would be inventing one.
    expect(basicAuthUser('Bearer abc.def.ghi')).toBeNull();
    expect(basicAuthUser('Digest username="demo"')).toBeNull();
  });

  it('rejects a malformed base64 payload rather than decoding garbage', () => {
    // The trap this guards: Node's base64 decoder SKIPS invalid characters
    // instead of throwing, so a garbage token decodes to a partial string and
    // yields a plausible-looking username. Fail closed instead.
    expect(basicAuthUser('Basic !!!not-base64!!!')).toBeNull();
    expect(basicAuthUser('Basic @@@@')).toBeNull();
  });

  it('rejects a credential with no colon separator', () => {
    // Per RFC 7617 this is malformed. Treating the whole string as a username
    // would manufacture an identity from a broken header.
    const noColon = Buffer.from('demoonly').toString('base64');
    expect(basicAuthUser(`Basic ${noColon}`)).toBeNull();
  });

  it('rejects an empty username', () => {
    const emptyUser = Buffer.from(':passwordonly').toString('base64');
    expect(basicAuthUser(`Basic ${emptyUser}`)).toBeNull();
  });

  it('rejects a whitespace-only username', () => {
    const blank = Buffer.from('   :pw').toString('base64');
    expect(basicAuthUser(`Basic ${blank}`)).toBeNull();
  });

  it('rejects the scheme with no token at all', () => {
    expect(basicAuthUser('Basic')).toBeNull();
    expect(basicAuthUser('Basic ')).toBeNull();
  });

  it('reads the first value when the header is repeated', () => {
    expect(basicAuthUser([basic('first', 'pw'), basic('second', 'pw')])).toBe('first');
  });
});

describe('callerIdentity', () => {
  it('prefers the proxy identity header', () => {
    const id = callerIdentity({ 'x-auth-request-user': 'alice' }, HEADERS, true);
    expect(id).toBe('alice');
  });

  it('falls back to the email header when no user header is set', () => {
    const id = callerIdentity({ 'x-auth-request-email': 'a@example.com' }, HEADERS, true);
    expect(id).toBe('a@example.com');
  });

  it('prefers a real IdP identity over the shared basic-auth login', () => {
    // The migration path: once an OIDC proxy is in front it forwards a real
    // per-user identity, which must win over the shared account.
    const id = callerIdentity(
      { 'x-auth-request-user': 'alice', authorization: basic('demo', 'pw') },
      HEADERS,
      true,
    );
    expect(id).toBe('alice');
  });

  it('uses Basic when it is trusted and no header identity is present', () => {
    const id = callerIdentity({ authorization: basic('demo', 'pw') }, HEADERS, true);
    expect(id).toBe('demo');
  });

  it('IGNORES Basic when it is not trusted', () => {
    // With an IdP in front, the Authorization header may carry something that
    // is not a verified basic credential at all. Reading a username from it
    // would trust a value nothing checked.
    const id = callerIdentity({ authorization: basic('demo', 'pw') }, HEADERS, false);
    expect(id).toBeNull();
  });

  it('returns null for a request with no identity at all', () => {
    // This is what makes the BFF fail closed on a direct hit that bypassed the
    // ingress — the single most important case here.
    expect(callerIdentity({}, HEADERS, true)).toBeNull();
  });

  it('treats a blank header as no identity', () => {
    // An empty forwarded header means the proxy did not identify anyone.
    // Accepting it would authenticate a request as the empty user.
    expect(callerIdentity({ 'x-auth-request-user': '   ' }, HEADERS, true)).toBeNull();
  });

  it('falls through to Basic when the identity header is blank', () => {
    const id = callerIdentity(
      { 'x-auth-request-user': '', authorization: basic('demo', 'pw') },
      HEADERS,
      true,
    );
    expect(id).toBe('demo');
  });

  it('trims surrounding whitespace from a forwarded identity', () => {
    expect(callerIdentity({ 'x-auth-request-user': ' alice ' }, HEADERS, true)).toBe('alice');
  });

  it('honours reconfigured header names', () => {
    const custom = { user: 'x-forwarded-user', email: 'x-forwarded-email' };
    expect(callerIdentity({ 'x-forwarded-user': 'bob' }, custom, false)).toBe('bob');
    // The default name must NOT be consulted once it has been reconfigured.
    expect(callerIdentity({ 'x-auth-request-user': 'bob' }, custom, false)).toBeNull();
  });
});
