# Public deploy — phase-1 gate (#1137, #1104 phase 1)

The committed, credential-free half of the public WE-site deploy. Per the **#1135** ratification the
substrate is Cloudflare and the phase-1 shared-code gate is an edge function.

**Platform note (2026-07-02):** Cloudflare retired the standalone Pages "Connect to Git" flow for new
sites and steers them to **Workers Static Assets** (the go-forward unified platform). So the gate is now a
**Worker** (`we:worker.js`) fronting the Eleventy `_site/` build served through the `ASSETS` binding —
not a Pages Function. Same behaviour, same #1135 intent (one Cloudflare substrate carrying every later
phase: KV for phase-3 per-person codes, Access for phase-5 login). This directory keeps the gate's unit
tests + this runbook; the Worker itself lives at the repo root so `wrangler.toml`'s `main` points at it.

## What's here / relevant files

- `we:worker.js` — the gate Worker. `run_worker_first = true` makes it intercept **every** request
  (asset paths included) so nothing is served un-gated. A valid signed `we_gate` cookie → `env.ASSETS.fetch`
  serves the static file; `POST /__gate` with the correct code sets the cookie and 302s in; everything else
  gets the splash. **Not a security boundary** — one shared code keeping anonymous/casual traffic out
  (#1135 scope). Per-person codes are phase 3 (Workers KV), login is phase 5 (Access); both extend this
  Worker's `code === SECRET` seam without a re-platform.
- `we:wrangler.toml` — Worker + Static-Assets config (`main = "worker.js"`, `[assets] directory = "./_site"`,
  `binding = "ASSETS"`, `run_worker_first = true`).
- `functions/__tests__/gate.test.ts` — the gate's unit tests (`npx vitest run functions`).

## Deploy — production path: `.github/workflows/deploy.yml` (corrected 2026-07-03)

**Not** Cloudflare's own Workers Builds git integration — that dashboard "Create application → import
`web-everything/web-everything`" flow was tried and disconnected: a single-repo Cloudflare checkout can't reach
the sibling `../frontierui` repo that `build:docs` needs (see below), so it can never produce a working
build. The actual deployer is a **cross-repo GitHub Action** (`we:.github/workflows/deploy.yml`), which runs
on every push to `main`:

1. Checks out `web-everything/web-everything` **and** `frontier-ui/frontierui` as siblings under `$GITHUB_WORKSPACE`
   (the FUI checkout needs a `FUI_READ_TOKEN` fine-grained PAT, `Contents:Read` on `frontier-ui/frontierui`).
2. Builds FUI's tools first (`npm run build:tools`, ratified #1946/#2016 ordering) — produces
   `dist/tools/component-render/cli.mjs`, which WE's Eleventy build shells out to.
3. Builds the WE site (`npm run build:docs`, **not** `npm run build` — the demo build (`build:demo` →
   `vite build`) resolves an alias graph into the sibling FUI repo that a bare single-repo checkout can't
   provide; the public gated site is the self-contained Eleventy docs build).
4. Deploys via `cloudflare/wrangler-action@v3` (`command: deploy`), pinned to `wranglerVersion: "4.106.0"`
   — the version verified to honor `run_worker_first = ["/*"]` (see `we:wrangler.toml`'s comment: an
   earlier boolean form leaked ungated content).

Repo secrets it needs (`Settings → Secrets and variables → Actions`): `FUI_READ_TOKEN`,
`CLOUDFLARE_API_TOKEN` (Workers Scripts · Edit), `CLOUDFLARE_ACCOUNT_ID`.

**Worker secrets** (separate from the above — set once on the Worker itself, persist across deploys):

```sh
wrangler secret put GATE_CODE               # the shared entry code
wrangler secret put GATE_COOKIE_SECRET      # a long random HMAC key (e.g. openssl rand -hex 32)
```

Until the secrets are set the gate **fails closed** (splash for everyone — a lockout, never a content
leak).

**Go-live gate:** the #2127 claims-truth audit that used to block this **is resolved** (2026-07-02) — see
[#1137](/backlog/1137-public-deploy-we-site-live-behind-a-splash-shared-entry-code/). The gated
`*.workers.dev` preview is already live; pointing the real (Squarespace) domain and flipping
`workers_dev=false` in `we:wrangler.toml` is the sole remaining step, and it is a **human** one (registrar
DNS + Cloudflare dashboard access an agent doesn't hold) — see #1137's card for the runbook and its
DNS/email-continuity prerequisite.

### Manual fallback (credentialed, one-off)

From a `wrangler`-authenticated session (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in env):

```sh
npm run build:docs                          # produce _site/
wrangler deploy                             # upload the Worker + _site assets
```

## Local check

The gate logic is pure (Web Crypto + cookie parsing) and unit-tested — it verifies the signed-cookie
round-trip, the shared-code accept/reject, the asset passthrough, and that a missing secret fails closed
(never a leak). Run with `npx vitest run functions`. Validate the deploy config without deploying with
`wrangler deploy --dry-run`.
