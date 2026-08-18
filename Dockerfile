# ============================================================================
# freshehr-nictiz-ui — SPA + BFF in one image, one process.
#
# The SPA and the BFF ship together on purpose. The BFF is not optional
# infrastructure around the SPA: it holds the EHRbase credential, which must
# never reach the browser, and it is what makes /api same-origin so the SPA
# needs no CORS configuration at all. Splitting them into an nginx pod and a
# node pod would reintroduce the cross-origin problem that the BFF exists to
# remove, in exchange for nothing.
#
# Build context is the REPOSITORY ROOT, not app/ — `fixtures/` lives above app/
# and is served by /api/golden:
#   docker build -t openfhir/nictiz-ui:dev .
# ============================================================================

# ── Stage 1: build the SPA ───────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /build

# Dependencies first, as their own layer: package*.json changes far less often
# than source, so an edit to src/ reuses the cached npm ci.
COPY app/package.json app/package-lock.json ./
# `npm ci` (not install) — installs exactly the lockfile, which is the whole
# point of committing one. Dev dependencies are needed here: tsc and vite are
# both build-time tools.
RUN npm ci

COPY app/tsconfig.json app/vite.config.ts ./
COPY app/index.html ./
COPY app/src ./src

# `npm run build` is tsc && vite build — the typecheck is deliberately inside
# the image build, so a type error fails the build rather than shipping.
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# tini: node as PID 1 does not reap zombies or forward SIGTERM to itself
# correctly, which makes `kubectl delete pod` wait for the full termination
# grace period on every rollout.
RUN apk add --no-cache tini

WORKDIR /app

# The BFF runs its TypeScript directly through `tsx`, exactly as `npm run
# dev:server` does — so dev and production execute the same code path, and there
# is no build output that can disagree with the source.
#
# A FULL `npm ci` is required, not `--omit=dev`. package.json's `dependencies`
# holds only the SPA's runtime libraries (lit, medblocks-ui, shoelace); the
# BFF's own dependencies — express, dotenv — and tsx itself all sit under
# devDependencies, because from the SPA build's point of view that is what they
# are. Omitting dev here produces an image that builds cleanly and then dies at
# startup with "Cannot find package 'express'".
#
# NODE_ENV is deliberately NOT set before this step: npm treats NODE_ENV
# =production as an implicit --omit=dev, which reintroduces exactly that
# failure. It is set after the install instead.
COPY app/package.json app/package-lock.json ./
RUN npm ci && npm cache clean --force

ENV NODE_ENV=production

# The BFF itself, plus the built SPA from stage 1.
COPY app/server ./server
COPY --from=build /build/dist ./dist

# Served by /api/golden — the golden FLAT fixture. It lives at the repo root,
# which is why the build context is the repo root and not app/.
COPY fixtures ./fixtures

# `dotenv` in server/index.ts reads ../../.env relative to server/, i.e.
# /.env here. That file does not exist in the image and must not: every value
# comes from the container environment (Secret/ConfigMap). dotenv treats a
# missing file as a no-op, so this is silent and intended.

# FIXTURES_DIR is REQUIRED here, not a nicety: the BFF's default resolves
# fixtures relative to server/, which is `<repo>/fixtures` in the working tree
# but `/fixtures` in this image — a path that does not exist. Without it
# /api/golden returns 500.
ENV PORT=3001 \
    STATIC_DIR=/app/dist \
    FIXTURES_DIR=/app/fixtures

# node:22-alpine ships an unprivileged `node` user. Running as root would give a
# process that only serves HTTP write access to its own image contents.
USER node

EXPOSE 3001

# Probed by the Deployment; deliberately outside the auth guard (see server).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# The LOCAL tsx binary, not `npx tsx`: npx resolves against the npm cache and
# happily downloads its own copy at container start — which needs network access
# during startup, ignores the lockfile-pinned version, and fails to resolve
# /app/node_modules at all.
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
