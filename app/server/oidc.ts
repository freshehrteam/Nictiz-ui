/**
 * OAuth2 client_credentials token manager for the BFF→EHRbase hop.
 *
 * EHRbase validates Bearer tokens against the freshehr Keycloak realm
 * (SECURITY_AUTHTYPE=OAUTH); the BFF authenticates as the `nictiz-ui-svc`
 * service account. Zero dependencies on purpose — Node 22's native fetch is
 * enough, and a new npm dependency would have to survive the image build's
 * devDependencies pruning (see the Dockerfile note in the README).
 *
 * One instance per process. Tokens are cached until shortly before expiry and
 * refreshed on demand; concurrent callers share a single in-flight request so
 * a burst of API traffic cannot stampede Keycloak.
 */

export interface TokenManagerOptions {
  /** Keycloak token endpoint, e.g. `.../realms/freshehr/protocol/openid-connect/token`. */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /**
   * Seconds subtracted from `expires_in` when deciding staleness. A token used
   * at the very end of its lifetime can expire in flight to EHRbase; refreshing
   * early converts that race into a non-event. Must be smaller than the realm's
   * access token lifespan (300 s in the freshehr realm) or every call refreshes.
   */
  skewSeconds?: number;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface TokenManager {
  /** A currently-valid access token, fetching or refreshing if needed. */
  getToken(): Promise<string>;
  /**
   * Drop the cached token so the next getToken() fetches a fresh one. Called
   * when EHRbase answers 401 despite a token we believed valid — clock drift or
   * a Keycloak-side revocation — so one retry with a fresh token can settle it.
   */
  invalidate(): void;
}

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const { tokenUrl, clientId, clientSecret } = options;
  const skewMs = (options.skewSeconds ?? 30) * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let token: string | null = null;
  let staleAt = 0;
  /**
   * The single in-flight refresh, shared by every concurrent caller. Cleared on
   * settle — INCLUDING rejection, so one failed fetch does not poison every
   * future call with the same stale error.
   */
  let inflight: Promise<string> | null = null;

  async function requestToken(): Promise<string> {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    const text = await response.text();

    if (!response.ok) {
      // Keycloak explains failures in error_description ("Invalid client
      // credentials", "Client disabled") — surface that, not just the status.
      let detail = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as { error?: string; error_description?: string };
        detail = body.error_description ?? body.error ?? detail;
      } catch {
        // Not JSON (a proxy error page, say) — the raw excerpt is the best we have.
      }
      throw new Error(`Token request failed (HTTP ${response.status}): ${detail}`);
    }

    let body: { access_token?: string; expires_in?: number };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`Token endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, 120)}`);
    }
    if (!body.access_token) {
      throw new Error('Token response carries no access_token');
    }

    token = body.access_token;
    staleAt = now() + Math.max(0, (body.expires_in ?? 0) * 1000 - skewMs);
    return token;
  }

  return {
    async getToken(): Promise<string> {
      if (token && now() < staleAt) return token;
      if (!inflight) {
        inflight = requestToken().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },

    invalidate(): void {
      token = null;
      staleAt = 0;
    },
  };
}
