---
name: cloudflare-deploy-state
description: WE public site is deployed live+gated on Cloudflare Workers (NOT Pages as
metadata: 
  node_type: memory
  type: project
  originSessionId: b085805b-88bb-4dc7-a7b5-07631e1e195b
---

The public WE Eleventy site (#1137, epic #1104 phase 1) is **live + gated** as of 2026-07-02 at
**`web-everything.<account-subdomain>.workers.dev`**, with **full auto-deploy on push to `main`**.

**Platform pivot — deviates from ratified #1135.** #1135 ratified *Cloudflare Pages + Pages Function*,
but Cloudflare retired the standalone Pages "Connect to Git" flow, so the gate is a **Worker**
(`we:worker.js`, `we:wrangler.toml` = Workers Static Assets) not a Pages Function. Recorded as a rider on
backlog/1135 + updated #1137 (`codifiedIn: one-off`, no platform-decisions.md change). See [[repo-constellation]].

**Auto-deploy = cross-repo GitHub Actions** (`we:.github/workflows/deploy.yml`). Single-repo CI CANNOT
build this site: `build:docs` shells out to FUI's component-render tool (`../frontierui/dist/tools/
component-render/cli.mjs`, ratified #1946/#2016). So the workflow checks out **both** `chalbert/web-everything`
+ `chalbert/frontierui` as siblings (via repo secret `FUI_READ_TOKEN`, a fine-grained PAT Contents:Read on
frontierui), runs FUI `build:tools`, then WE `build:docs`, then `wrangler deploy`. ~2 min/run, verified green.

**⚠️ LEAK GOTCHA (fixed, do not regress):** the gate Worker only guards content if it intercepts EVERY
request. `run_worker_first = true` (boolean) is **silently ineffective in wrangler 4.106** — static GETs get
served un-gated (observed a real content leak). The working form is the **array**: `run_worker_first = ["/*"]`.
CI's `wrangler-action` is **pinned to `wranglerVersion: 4.106.0`** so a version drift can't reintroduce it.
Also: `workers_dev` MUST be a top-level wrangler.toml key — placed after `[assets]` TOML folds it into the
assets table and it's ignored. Always re-verify GET `/` returns the splash after any deploy/config change.

**Other facts not in the repo:**
- Cloudflare account subdomain permanently **`<account-subdomain>`** (API won't change it). Account ID `<account-id>`.
- Local creds: gitignored `we:.cloudflare.env` (scoped token needs **Workers Scripts · Edit**; DNS·Edit + Zone·Read for the later domain step).
- Worker secrets: `GATE_COOKIE_SECRET` (auto-generated random) + `GATE_CODE` (user's, from Dashlane).

**Deferred:** custom domain (Squarespace nameservers → Cloudflare) + `workers_dev=false` are held until
**#2127** (claims-truth audit) clears — the real go-live gate. Squarespace has no DNS API; that's one manual
nameserver change by the user.
