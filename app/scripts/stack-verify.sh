#!/usr/bin/env bash
# One-command gate against the real stack: unit tests, client registration,
# seed, and the full Playwright e2e suite (incl. every @stack spec).
#
# Run it after any stack upgrade: cd app && npm run stack:verify
#
# Prereq: the sibling stack repo must be up AND green first —
#   cd ../freshehr-open-health-stack && make up && make template && make bootstrap && make verify
#
# Coverage note: everything here uses the stack's DIRECT dev-bypass ports
# (docker-compose.override.yml), so the nginx + oauth2-proxy EDGE path is NOT
# exercised — that path is covered by the stack repo's `make smoke`/`make verify`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEV_PID=""
cleanup() {
  # Kill the dev server ONLY if this script started it; leave a pre-existing one alone.
  if [ -n "$DEV_PID" ]; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step() { printf '\n── %s ──────────────────────────────────────────\n' "$*"; }

# NB: on connection failure curl still prints 000 via -w and THEN exits
# non-zero — appending a fallback via `|| echo` would yield "000000".
http_code() { local c; c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null) || true; echo "${c:-000}"; }

# ── 1. Dependencies ──────────────────────────────────────────────────────────
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  step "npm ci (node_modules missing or stale)"
  npm ci
fi

# ── 2. Unit tests (no backend needed — fail fast before touching the stack) ──
step "unit tests (vitest)"
npm test

# ── 3. Stack preflight: the dev-bypass ports must answer ─────────────────────
# These ports exist ONLY via the stack's docker/docker-compose.override.yml
# (8080 hapi · 8081 keycloak · 8082 ehrbase · 8083 openfhir).
step "stack preflight (dev-bypass ports)"
preflight_fail=0
check_port() { # <label> <url> <accept-codes-regex>
  local code; code=$(http_code "$2")
  if printf '%s' "$code" | grep -qE "$3"; then
    printf '  up    %-34s HTTP %s\n' "$1" "$code"
  else
    printf '  DOWN  %-34s HTTP %s\n' "$1" "$code"
    preflight_fail=1
  fi
}
check_port "keycloak :8081 OIDC discovery" "http://localhost:8081/auth/realms/freshehr/.well-known/openid-configuration" '^200$'
check_port "hapi :8080 /fhir/metadata"     "http://localhost:8080/fhir/metadata" '^200$'
# EHRbase and openFHIR validate tokens natively even on the bypass ports — a
# bare 401 still proves the service is up; 000 means the port is dead.
check_port "ehrbase :8082 /rest/status"    "http://localhost:8082/ehrbase/rest/status" '^(200|401)$'
check_port "openfhir :8083 /health"        "http://localhost:8083/health" '^200$'
if [ "$preflight_fail" = 1 ]; then
  cat >&2 <<'EOF'

FATAL: stack dev-bypass ports not answering. These ports exist ONLY via the
stack repo's docker/docker-compose.override.yml. Bring the stack up first:

  cd ../../freshehr-open-health-stack
  make up && make template && make bootstrap && make verify

EOF
  exit 1
fi

# ── 4. Client registration (idempotent, mandatory once per fresh stack) ──────
# Creates nictiz-ui-svc, the openfhir.map scope, the tenant mapper and the
# demo user — without it every BFF call to the stack 401s.
step "npm run register"
npm run register

# ── 5. Dev server (BFF :3001 + vite :5173) ───────────────────────────────────
step "dev server"
if [ "$(http_code http://localhost:5173)" != 000 ]; then
  # Reuse only a COMPLETE dev server (vite + BFF). A live :5173 with a dead
  # :3001 is a stale/half-alive leftover we can neither kill (not ours) nor
  # replace (port conflict) — bail out with instructions instead of hanging.
  if [ "$(http_code http://localhost:3001/api/health)" = 200 ]; then
    echo "  reusing dev server already listening on :5173 (+ BFF :3001)"
  else
    echo "FATAL: something answers on :5173 but the BFF :3001 does not — a stale dev server?" >&2
    echo "Stop whatever owns :5173 (or fix its BFF) and re-run." >&2
    exit 1
  fi
else
  npm run dev >/tmp/nictiz-ui-dev.log 2>&1 &
  DEV_PID=$!
  echo "  started npm run dev (pid $DEV_PID, log /tmp/nictiz-ui-dev.log)"
fi
deadline=$(( $(date +%s) + 120 ))
until [ "$(http_code http://localhost:3001/api/health)" = 200 ] && [ "$(http_code http://localhost:5173)" != 000 ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "FATAL: dev server not up within 120s (see /tmp/nictiz-ui-dev.log)" >&2
    exit 1
  fi
  sleep 2
done
echo "  BFF :3001 + vite :5173 answering"

# ── 6. Seed demo data (guards its own prereqs: health + EPS template) ────────
step "npm run seed"
npm run seed

# ── 7. Playwright e2e (reuses the running dev server) ────────────────────────
step "npm run test:e2e"
npm run test:e2e

echo
echo "stack-verify: all green."
