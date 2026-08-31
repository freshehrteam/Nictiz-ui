/**
 * Who a request is from — the check that decides whether it is served at all.
 *
 * Both failure directions are expensive and neither is loud:
 *   - too strict → the whole EMR 401s behind a correctly-configured ingress
 *   - too loose  → a malformed or absent header yields an identity, and the
 *                  BFF serves the entire CDR to it
 *
 * The second is the dangerous one, because nothing about it looks like a
 * failure. Most of these tests exist to pin it down.
 */

import { describe, expect, it } from 'vitest';

import { callerIdentity } from '../../server/identity';

const HEADERS = { user: 'x-auth-request-user', email: 'x-auth-request-email' };

describe('callerIdentity', () => {
  it('reads the proxy identity header', () => {
    expect(callerIdentity({ 'x-auth-request-user': 'alice' }, HEADERS)).toBe('alice');
  });

  it('falls back to the email header when no user header is set', () => {
    expect(callerIdentity({ 'x-auth-request-email': 'a@example.com' }, HEADERS)).toBe(
      'a@example.com',
    );
  });

  it('prefers the user header over the email header', () => {
    const id = callerIdentity(
      { 'x-auth-request-user': 'alice', 'x-auth-request-email': 'a@example.com' },
      HEADERS,
    );
    expect(id).toBe('alice');
  });

  it('returns null for a request with no identity at all', () => {
    // This is what makes the BFF fail closed on a direct hit that bypassed the
    // ingress — the single most important case here.
    expect(callerIdentity({}, HEADERS)).toBeNull();
  });

  it('IGNORES an Authorization header — only the proxy headers carry identity', () => {
    // The BFF must never mint an identity out of a credential nothing here
    // verified. Bearer tokens are validated at the edge; by the time a request
    // arrives, identity lives in the X-Auth-Request-* headers or nowhere.
    const bearer = { authorization: 'Bearer abc.def.ghi' };
    expect(callerIdentity(bearer, HEADERS)).toBeNull();
    const basic = { authorization: `Basic ${Buffer.from('demo:pw').toString('base64')}` };
    expect(callerIdentity(basic, HEADERS)).toBeNull();
  });

  it('treats a blank header as no identity', () => {
    // An empty forwarded header means the proxy did not identify anyone.
    // Accepting it would authenticate a request as the empty user.
    expect(callerIdentity({ 'x-auth-request-user': '   ' }, HEADERS)).toBeNull();
    expect(callerIdentity({ 'x-auth-request-user': '' }, HEADERS)).toBeNull();
  });

  it('falls through to the email header when the user header is blank', () => {
    const id = callerIdentity(
      { 'x-auth-request-user': '', 'x-auth-request-email': 'a@example.com' },
      HEADERS,
    );
    expect(id).toBe('a@example.com');
  });

  it('trims surrounding whitespace from a forwarded identity', () => {
    expect(callerIdentity({ 'x-auth-request-user': ' alice ' }, HEADERS)).toBe('alice');
  });

  it('reads the first value when the header is repeated', () => {
    expect(callerIdentity({ 'x-auth-request-user': ['first', 'second'] }, HEADERS)).toBe('first');
  });

  it('honours reconfigured header names', () => {
    const custom = { user: 'x-forwarded-user', email: 'x-forwarded-email' };
    expect(callerIdentity({ 'x-forwarded-user': 'bob' }, custom)).toBe('bob');
    // The default name must NOT be consulted once it has been reconfigured.
    expect(callerIdentity({ 'x-auth-request-user': 'bob' }, custom)).toBeNull();
  });
});
