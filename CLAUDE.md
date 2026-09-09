# freshehr-nictiz-ui — working notes for Claude

## Dev commands (run in `app/`)

| Command | What it does |
|---|---|
| `npm run dev` | BFF (`:3001`) + vite (`:5173`) together |
| `npm test` | vitest unit suite (~305 tests, no backend needed) |
| `npm run register` | registers `nictiz-ui-svc`, the `openfhir.map` scope, the tenant mapper and the demo user in Keycloak — **idempotent, mandatory once per fresh stack**; without it every BFF call 401s |
| `npm run seed` | demo patients + compositions; guards its own prereqs (backends healthy, "EPS Patient Summary" template present) |
| `npm run test:e2e` | Playwright (~30 specs incl. `@stack`); reuses a running dev server |
| `npm run stack:verify` | **the one-command gate**: unit tests → stack preflight → register → dev server → seed → full e2e |

## Stack dependency

Everything backend-facing uses the stack repo's **dev-bypass ports**, which
exist ONLY via `freshehr-open-health-stack/docker/docker-compose.override.yml`:
8080 hapi · 8081 keycloak · 8082 ehrbase · 8083 openfhir. Bring the stack up
first:

```bash
cd ../freshehr-open-health-stack
make up && make template && make bootstrap && make verify
```

## Test tag convention

- `@stack` in a Playwright test title = needs the real stack + seeded data.
- `npx playwright test --grep-invert @stack` = the 2-test no-backend smoke.

## Coverage gap (known, documented — don't "fix" silently)

The e2e path goes through the dev-bypass ports, so the nginx + oauth2-proxy
**edge** path is never exercised here. Edge coverage lives in the stack repo:
`make smoke` (auth matrix) and `make verify` (data plane through nginx).
