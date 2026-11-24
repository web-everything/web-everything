## Developing & manually testing in a lane

An entry guard placed in the first side-effect import must finish synchronously before
transferring execution. Awaiting IO in that guard lets sibling entry dependencies evaluate.
The tools-root subprocess fixture pins this: a later dependency throws if local evaluation
starts, while the selected tools entry records its actual cwd, argv and exit status.
Tools-root redirection accepts only the three entries declared in `TOOLS_ROOT_ENTRIES`;
an ordinary `scripts/` runner importing one of them as a library must stay local, even
when a counterpart exists in the tools checkout. Pin both the no-spawn seam and the real
import path. Pin every explicit resolver rejection reason, including a successful Git
probe that names a different checkout root. The default event-writer fixtures must cover
both timeout and excessive-output recovery before selected tooling starts.

The synchronous tools-root wrapper cannot forward a signal addressed only to its PID;
the selected child (or the event writer) can outlive it. Supervisors must terminate the
whole process group. Moving to async signal forwarding also requires deferring sibling
entry imports; awaiting the first side-effect import alone does not defer them.
Oversized-input fixtures must measure requested ranges and cumulative bytes through the
filesystem seam, including short reads; rejection alone does not prove bounded IO.

Every edit — including an ad-hoc "just fix this one thing" — happens in an **isolated lane clone**, never the main checkout (#2123; the writer model in [platform-decisions.md#pr-flow-rollout-mechanism](../platform-decisions.md#pr-flow-rollout-mechanism)). The lane trigger is *making an edit*, not *running a command*. The main checkout stays the human's — its dev server on `:3000`/`:8080` is theirs; don't build or serve into it.

**1 — Pick or provision a lane** (persistent clone pool under `~/workspace/.lanes/<repo>/lane-N`, git objects shared via `--reference`, own HEAD):
```bash
node scripts/lane-pool.mjs status --json     # per-lane path / head / clean / deps
node scripts/lane-pool.mjs provision --count=N   # create/refresh N lanes
```
Lane deps prefer pnpm 12+ with matching lockfiles and a shared store at `~/.cache/we-pnpm-store` (override `WE_PNPM_STORE_DIR`); npm ci remains the per-lane fallback, and backend switches rebuild `node_modules`. A lane whose marker matches either backend's current hash is left alone, so a lane changes backend only when its install inputs change: the lockfiles, or for pnpm the store path and the store's generation token (`.we-lane-store-generation`, created once per store). A pnpm lane also reads stale when a top-level `node_modules` link no longer resolves (store content deleted under it), and an install during which the store was wiped and recreated stamps no marker. A not-ready pnpm lane always reinstalls from an empty `node_modules`. The shared store trades per-lane isolation for disk and speed: a write into a store file is visible to every lane and survives `git clean`. To recover, delete the whole store directory; the recreated store gets a new token, so every pnpm lane reads stale and reinstalls on its next acquire. Lockfile parity also requires each pnpm package's registry integrity to be one of npm's hashes for that name@version; any other pnpm resolution fails parity, and lanes then use npm ci. Keep `package-lock.json` authoritative for npm and run `npm run check:lockfile-parity` after lockfile updates.

With a `packageManager` pin, pnpm 12 writes a YAML stream containing an environment lockfile
and a project lockfile. The parity reader and installer helper run before `node_modules`
exists, so they must import only `node:` builtins. Keep a copied-script child-process
regression with real YAML lockfiles and no dependency installation. Parity must read all
documents and select the project importer;
the environment's own `packages` map is not project dependency evidence. Run the
`pnpm --version` probe from `os.tmpdir()`, since probing inside the repository can rewrite
its lockfile. Regression coverage lives in `check-lockfile-parity.test.mjs` and
`lane-deps-installer.test.mjs` under `scripts/__tests__/`.

Use a `clean` lane. `git -C <lane> reset --hard <sha>` to check out any local commit (shared objects — no fetch needed, works for un-pushed HEADs).

**2 — Boot the lane's OWN dev pair.** The `.env.local` port pair is **not auto-loaded** — export it first, or the servers fall back to the main band (`:3000`/`:8080`) and collide:
```bash
cd ~/workspace/.lanes/web-everything/lane-N
set -a; source .env.local; set +a        # sets WE_VITE_PORT / WE_ELEVENTY_PORT
npm run dev
```
Verify Playwright/curl against **that** lane's `WE_ELEVENTY_PORT` (the 11ty docs site) — not `:8080`.

**3 — The constellation render-siblings (#2166 → #2282 → #2349).** Every WE grid page SSRs through the pinned FUI build-artifact, resolved as a `frontierui` checkout *sibling* of the WE repo root — which a lane clone (`<pool>/lane-N`) has no sibling for, so `build:docs` and the 11ty dev-serve would hard-fail with *"pinned FUI artifact missing at …/.lanes/web-everything/frontierui/dist/tools/component-render/cli.mjs"*. `lane-pool.mjs provision`/`refresh` now provisions **real, pushable git clones** at the pool root (`~/workspace/.lanes/web-everything/frontierui`, `~/workspace/.lanes/web-everything/plateau-app`) — one clone per sibling repo, serving every lane at the same `../<name>` path. Each clone is fetched/reset to `origin/main` and rebuilt via its own `npm run build:tools` (where it has one — FUI does, ~1.2s; plateau-app doesn't, a plain clone is enough). You only need each sibling's PRIMARY checkout to exist locally (it's the source the pool-root clone's `origin` URL is derived from):
```bash
cd ~/workspace/frontierui && npm run build:tools   # optional — the pool-root clone builds its own dist/ on provision/refresh
```
If a sibling's primary checkout is missing entirely, provision warns and skips that sibling (the pool is still usable for non-render work). A pool-root sibling that is DIRTY or AHEAD of its own `origin/main` (real local state, now that it's a pushable clone) is left untouched on refresh, same as a lane (`--force` overrides).

**4 — Known lane limitations.**
- For rendering/screenshots, a **static build is most reliable**: `npx @11ty/eleventy --output=/tmp/site-X --quiet`, then `python3 -m http.server` in that dir. (This is how you diff two commits: build each into its own dir, serve on two ports, screenshot.)
- **Visual baselines**: `tests/visual/rendered-site-visual.spec.ts` (the snapshot-baseline spec, #2236) targets its OWN dedicated, Playwright-booted Eleventy server (`WE_VISUAL_FIXTURE_PORT`, default `:8099`) rendered from the checked-in frozen fixture set (`tests/visual/fixtures/backlog/*.md`, via `WE_VISUAL_FIXTURES=1`) — it needs no `:8080` at all, so it regenerates cleanly from ANY lane with no coordination or collision risk with the main checkout. The sibling `tests/visual/fui-card-cross-origin-render.spec.ts` is a live token-render check (not a snapshot baseline) and still reads `WE_ELEVENTY_PORT` (default `:8080`), so regenerate/run *that* one from a checkout that owns `:8080` (or the lane's own bound port, per step 2 above). To add a new frozen-fixture visual target, see the header comment in `tests/visual/pages.json`.

> **Visual-regression substrate is self-hosted Playwright, in-repo committed `-linux` PNG baselines — no hosted SaaS** (decision #2233, ratified 2026-07-09). The governing rule + rationale + evidence-gated escape hatches (Argos-as-review-UI-only #2233 fork 2; graduate-baselines-off-PNG #1967) live in [platform-decisions.md#visual-regression-substrate](../platform-decisions.md#visual-regression-substrate).

> **Skill/memory replay substrate is an ephemeral throwaway clone (`mkdtemp` + `git init`, `rmSync`), never the shared lane pool** (decision #2274, ratified 2026-07-09). Even testing the lane tooling itself uses a fabricated `LANE_POOL_ROOT` under a temp dir, never allocated production lanes; `--dry-run` is never the fidelity substrate. Full rule + rationale in [platform-decisions.md#skill-memory-replay-substrate](../platform-decisions.md#skill-memory-replay-substrate).

