# Testing — Three-Tier Strategy

> Tier-1 reference. Read when writing or changing tests.

Injected Gemini subprocess tests must set `ANTIGRAVITY_QUOTA_DIR` to a per-test temporary directory:
real backend holds otherwise prevent even the fake child from starting. Real POC branch-sync fixtures
must pass a temporary `lockRoot` through `withPocLandLock`, preserving the mutex without touching host locks.

## GitHub priority admission

The throttle returns a JSON `deferred-low-budget` result without invoking GitHub when a fresh,
identity-scoped GraphQL observation crosses the caller's reservation threshold (background 25%,
normal 10%). CLI status is zero; stderr and the spend report distinguish a skipped pass from success.
Use `isGhDeferred` from `we:scripts/lib/gh-deferred.mjs` before parsing query data or caching results;
a deferred response is not an empty PR list. Discovery CLI passes can use `deferGhPass` to skip before
making decisions. Critical review/drain callers still respect actual exhaustion and secondary backoff.
Test with a temporary throttle root and injected subprocesses; never spend live GitHub quota to test scarcity.

## Standalone probation builds

`scripts/operations/probation-build-run.mjs` accepts `--taskType=doc-fix|bugfix|test-fix|prepare` (doc-fix default),
roster names or legacy JSON in `--worker`, and an allowlisted `--model`. Each omitted session is
generated independently. Different items use separate lane clones; do not reuse an explicit session
and lane for simultaneous runs. Task files, worker logs, commit messages and PR bodies are lane-local.
Before acquiring a lane or claiming, the runner reads the launch card’s `blockedBy` and checks blocker
frontmatter on `origin/main`. Unresolved or missing blockers return `blocked` with their IDs; a local
resolution does not count. The isolation tests cover this refusal and the resolved/no-blocker paths.
Pool discovery uses `defaultPoolRoot` with the script checkout root, never the caller cwd.
Mutation subprocesses must use both the lane cwd and the lane’s script copy: backlog and operation tools
derive their roots from `import.meta.url`. Daemon clones remain read-only launch sources. The isolation
test snapshots every launch-checkout file, including `.git`, across success and pre-worker failure.
Prepare edits only the target card body and preparation stamps, never claims/resolves it, and verifies
the runner-authored stamp before opening a parked PR. Its implementation scope does not bound preparation;
the card path does. Decision preparation remains a Claude judgment role.
Flash keeps the Codex read-only checker; a checker refusal undoes the attempt.
`test-fix` uses Flash without a separate simple flag and refuses non-test worker diffs.
The CI-heal decision currently has no structured failing-file list; do not infer one from check names.
Standalone Findings are publication text: strip absolute local paths, qualify code references using the
standards locus detector, and cap the final excerpt. The temporary-lane regression runs the actual
file-scoped standards gate on a written card. Envelope refusals discard and verify removal of the worker
diff before writing a card-only finding; preserve scope and hold for the builder rather than routing
these cards to auto-prepare. Capture the first gate error before truncating subprocess output, so the
runner result names the failed check even when the output tail only contains the summary.


Verify parallel isolation with the integration test
`scripts/__tests__/lane-pool-acquire-shares-scan-cache.test.mjs` (the three concurrent acquirers case).
The build-run tests separately race real scorecard writers in temporary storage. Probation builds
pass `requireLock: true` through scorecard migration and append, refusing the shared lock's usual
unlocked fallback on timeout. A refused scorecard write is reported on stderr without undoing a
successful build. Operation records use UUID filenames and atomic rename; call logs use append-only
writes, so they do not replace a sibling process's records.

## Shadow reviewer agreement evidence

`review-runner.mjs` appends each shadow prediction through `appendVerdict` as `verdict: observed`,
`mode: shadow`, boolean `wouldClear`, and `applied: false` / `mutated: false`. The builder and reader
reject shadow metadata on bearing verdicts. The existing non-bearing fold keeps these rows in history
without changing clearance, outstanding holds, review-round counts, or live label drift comparisons.
Append failures are reported best-effort on stderr and do not abort the shadow report.

Query the durable evidence offline with
`node scripts/lib/verdict-ledger.mjs shadow-agreement --repo=web-everything/web-everything --human-actor=nic --json`.
Use the exact declared human actor stored in your verdict rows. Without `--human-actor`, only the explicit
`clear-human` ceremony is a human outcome; with it, accepted/changes rows for that actor also qualify.
Declared attribution is not identity verification. `summarizeShadowAgreement` compares the latest preceding
prediction against the next qualifying human outcome for the same repo and PR, consuming each pair once.
It reports superseded predictions and unmatched pending predictions separately. This is PR-level outcome
agreement, not proof that two reviews covered identical content, and it does not enable enforcement.
`summarizeAgreement` retains its separate ledger-versus-live-label drift meaning.

Tests redirect `WE_VERDICT_LEDGER_DIR` and `CONVEYOR_JURY_DIR` into temporary directories and drive the
runner with a read-only `gh` fixture; a file in place of the ledger directory probes real append failure.

## Build-dispatch prepare retirement

A live daemon PID does not prove its prepare worker is live. Probe dispatch-entry `live`,
`expectedBy`, and `lastSeenLiveAt` independently: an explicitly dead session retires past its
expected deadline or after 20 minutes without a live observation. Settlement records
`prepare-session-dead`, clears the claim and guard, and increments `itemPrepareAttempts`
without double-counting a same-tick TTL retirement. Keep this outcome retryable rather than
turning it into a permanent `prepare-unstamped` hold on the next tick.

## Build-dispatch executor admission

Candidate executor prediction must call `decideDispatchRoute` with the dispatch loader's scope, size,
risk, tags and delivery-agent override, then `probationLaunchDecision` with the actual launch setting.
`routing.executed` alone is the fallback: an enabled probation worker can actually execute the build.
Test a real predicted external route with Claude capacity full, and preserve the run record's known
executor when deduplicating it with an earlier executor-less claim. The total own-item WIP cap applies
across both executor pools.

## Constellation conveyor probes

Inject `exec` and `fetchOpenPrs` into `makeCliMechanicalPasses` to inspect each repo's argv
and snapshot lifetime without spawning workers. Review briefs select the checkout with
`--repo` on the pool `acquire`; release stays `--all-pools --session=<slug>` (it sweeps every pool).
The fix and review refusal writers preserve each other's actions in `unsupported-repo.json`.
CI history keeps WE's filename and adds the constellation key for sibling repos, including
when `CONVEYOR_CI_QUEUE_FILE` supplies the base path. Subprocess tests that use fake `gh`
still acquire the throttle lock; set `LANE_POOL_ROOT` to a temporary directory in a sandbox.

## Runner activity report

`node scripts/operations/run.mjs runner-activity --json` reports the liveness of all three known
standalone conveyor daemons in `verdict.runners` — an array of `{ name, present, pid, alive,
heartbeatAt, source, livenessSource, state, stalled, stalledReason, ... }`, one entry per daemon in
`KNOWN_DAEMONS` (`scripts/operations/runner-activity-io.mjs`): `dispatcher` (the mechanized tick
driver, `skills-src/conveyor/runner.mjs`), `fix-dispatch` (`reconcile-fix-dispatch-daemon.mjs`,
#3870), and `review` (`review-daemon.mjs`, #3876) — each its own machine-global singleton lease
under the same primitive (`skills-src/conveyor/runner-lock.mjs`), keyed distinctly so none contend.
Every entry uses the same four-state vocabulary — `down` (no lease) / `dead` (the recorded PID no
longer identifies that daemon's own process) / `alive-and-stalled` / `alive-and-idle` — computed
identically per daemon by `assessDaemonState`. Only `dispatcher` corroborates against a tick (the
driven checkout's `.conveyor/driver-status.json`: zero-based tick number, timestamp, planned
dispatch lists, the tick core's own held-work stalls); `fix-dispatch` and `review` have no tick
concept of their own and are assessed on heartbeat freshness alone. A single snapshot proves
recency, not continuous progress between observations. The stale window is the existing runner
lease duration. Missing first-tick data stays null, with the fresh lease providing startup evidence.

The top-level `state`/`stalled`/`stalledReason`/`dispatching`/`checkout` fields mirror the
`dispatcher` entry specifically — the pre-existing "driver health" vocabulary, kept so a caller that
only ever cared about the conveyor dispatcher reads the same shape as before this operation reported
on three daemons. `inFlightDispatches`, `completedDispatches`, `lastTick`, and `dispatching` stay
dispatcher-only top-level fields; the fix-dispatch/review daemons have no dispatch-lane or tick
concept of their own, so those are never forced into their `runners[]` entries.

**Failure isolation.** Reading ONE daemon's own lock directory (a corrupt `lock.json`, an unreadable
lock dir, or a lease with no usable PID) never aborts the whole snapshot: it surfaces only in that
daemon's own entry as `present: null` (distinct from `present: false`, a genuinely absent lease) plus
an `error` string, and `state: 'down'`. The other daemons' entries are unaffected. This is narrower
than it sounds — it covers only the lease file's own read/parse. A genuine `ps`/`lsof` infra failure
during a daemon's process-identity check (a permission error, a timeout — never a plain "no such
PID", which is ordinary process-gone evidence) still propagates as an operation error for the WHOLE
read, for every daemon, not just the dispatcher: the pre-existing #3884 fix (a timeout must never
silently masquerade as "dead") generalizes to all three rather than staying dispatcher-only.

In-flight rows reuse `inFlightDispatchesFor`, `stampLiveness`, and `dispatchStillHolds`. Terminal
dispatch effects supply `applied`/`failed` outcomes. Their dispatch-step finish time orders recent
outcomes; legacy records without it explicitly report a `last-attempt-proxy`. Call-log completion
is not dispatch completion: a dispatch call can complete without launching anything.

The IO shell places all synchronous file/store reads inside a 10-second, SIGKILL-bounded snapshot
subprocess; process/session reads have a 2-second bound within it. A failed required read is an
operation error, never `down`. Corrupt individual run records are counted as partial history, and
an unavailable session listing preserves unknown liveness. This report performs no restart,
reaping, tick execution, or liveness write-back. For runner-activity only, CLI persistence (including
resume reads, all run-record writes, and call-log appends) uses separate 2-second SIGKILL-bounded
children. Store failures refuse the invocation; call-log failures remain best-effort. Other operations
retain their existing CLI stores. Relative runner script paths are resolved against the runner PID's
cwd before identity checking and deriving the checkout; cwd itself is not the checkout.

## Proof-based verification — observe before you claim

The first rule of verifying anything here is **observe the real running system; don't reason about
what it probably does.** A diagnosis is a *finding* backed by output, not a plausible hunch. This
applies to every "does it work / why is it broken" moment, not just to written test files.

**The discipline:**
- **Reproduce against the live system first.** Probe what the user actually sees: `curl` the served
  HTML, drive a real browser (Playwright — see the recipe below), run the gate, `grep` the real
  output. Let the result name the cause.
  - **Ad-hoc Playwright recipe.** Node ESM resolves `import { chromium } from 'playwright'` relative
    to the *script file's* directory, **not** the cwd — so a script in `/tmp` fails even when you
    launch it from the repo root. Write the throwaway script **inside the repo tree** (e.g. a
    git-ignored `./.probe.mjs`), `node ./.probe.mjs`, then delete it. The first port is whatever the
    user named; otherwise probe 3000/8080 (WE) and 6000/6080 (FUI). Always capture `page.on('console')`
    + `page.on('pageerror')` so silent client-side failures surface. For "is the current page marked?"
    questions, dump each nav link's `aria-current` and class — don't eyeball the screenshot.
- **The render layer is not the server output.** A page can be in the DOM yet invisible because of
  client-side JS (a filter adding `is-filtered-out`, `display:none`) or persisted `localStorage`
  state. `curl` proves what the server *sent*; only a real browser proves what the user *sees*. If
  the claim is about visibility/interaction, the browser is the only valid probe.
- **"Cache / stale tab / hard-reload / it's just uncommitted" are hypotheses, never diagnoses.**
  They are the convenient explanations that *feel* right without a test. Rule each in or out by
  observation before you offer it. (Eleventy renders from disk regardless of git state — uncommitted
  is almost never why something is "missing"; the real cause is usually a render/wiring bug. The
  `/backlog/` type-filter once hid every `type: review` item this exact way — a one-`curl` find that
  three untested guesses missed.)
- **A probe can lie too.** If you guessed a selector, storage key, port, or fixture, the run may be
  inconclusive (it tested the wrong thing and "passed"). Say so — an inconclusive run is not proof,
  and presenting it as one repeats the original sin one level down.
- **When you fix a class of bug, add a gate guard and prove the guard fires** — reintroduce the bug,
  watch it error, restore. An untested guard is itself an untested claim. (Worked example: the
  type-filter-coverage guard in `scripts/check-standards.mjs` §10.) Note `check:standards` does **not**
  run the 11ty build, so render-layer bugs stay green-invisible — smoke template changes with a real
  build/probe too.

### Gates in git fixtures

When a publish gate runs the suite that tests its own caller, use a fixture-local npm script in the
temporary git repo to verify gate arguments and green/red handling without recursively launching the
suite. Exercise real subprocesses and git transport. Emit gate chatter in the fixture too: a CLI's
machine-readable JSON stdout must remain parseable when its child gate prints output.

### Passive-wait hook regression probes

Test Stop/SubagentStop with distinct parent and subagent JSONL files: SubagentStop prefers
`agent_transcript_path`, falling back to `transcript_path` only when absent; an unreadable or malformed
selected file fails open. Keep Monitor cases event-specific: any Monitor call plus passive-wait
language blocks SubagentStop, even with its immediate "started" result, while Stop permits it.
Agent/Task remain excluded for both events.
The PreToolUse Monitor guard denies only when `agent_id` identifies a subagent and leaves main-session
watches alone. Exercise each script through stdin as well as its pure decision functions; these
probes verify local decisions and wiring, not whether the upstream harness fires every hook.

### Nested CLI isolation probes

Establish an ordinary child CLI baseline before attributing failure to isolation. In #3371 Probe 10,
`codex exec` failed at app-server initialization and even Seatbelt's allow-all `true` control failed
at `sandbox_apply`; neither result tested doctrine exclusion. Parent-shell edits do not prove child
agent tools work. Deleting a tracked doctrine file also leaves it recoverable via `git show HEAD:AGENTS.md`,
which the same probe observed: distinguish automatic context exclusion from enforced read denial.
See [the commands and output](../../backlog/3371-probe-one-alternate-provider-against-the-judge-contract.md#probe-10--tool-bearing-doctrine-isolation-attempted-2026-09-10).

The dispatching session subsequently supplied successful unsandboxed baseline/deletion/tool-bearing
runs ([Probe 11](../../backlog/3371-probe-one-alternate-provider-against-the-judge-contract.md#probe-11--dispatching-sessions-unsandboxed-deletion-proof-2026-09-10)).
Attribute that evidence to its actual observer; do not repeat nested probes already blocked by Seatbelt
or describe supplied observations as locally reproduced. Root AGENTS.md deletion before child startup
prevents its automatic loading in that setup; it does not erase Git history or other instruction sources.
The `we:scripts/lib/isolation-provider.mjs` preparation port owns a disposable clone, not a process sandbox.
Await preparation before launch, preserve exclusive ownership until the child exits, collect results,
then await cleanup in `finally`. Injected-exec tests verify preparation mechanics, not model context.

**Correction — Probe 9's "no override flag" conclusion was wrong (#3371 Probe 12, 2026-09-11).** A real
Codex config override, `-c project_doc_max_bytes=0`, suppresses the CLI's automatic doctrine-file
injection, live-verified in both `-s read-only` and `-s workspace-write` (tool-bearing) modes, with real
tool use still working. It is weaker than deletion — the file stays on disk and a deliberate `cat
AGENTS.md` still recovers it, also live-verified — so `we:scripts/lib/isolation-provider.mjs` gained
`createConfigOverrideIsolationProvider` as a second backend alongside the deletion one, not a replacement.
Lesson for future nested-CLI probes: a probe that finds no override flag by trying one or two candidate
flags (`--ignore-user-config`, a bare `-C`) has not shown none exists — check the CLI's full `-c
key=value` config surface (`codex exec --help`, or grep the installed binary's embedded config schema)
before concluding a capability is absent.

### Hard rule — every verification must be agent-runnable; if it needs a real runtime, the harness is a dependency

A verification item is only *real* if an agent can **reproduce its proof mechanically** — run a
command, observe the result. "Verify end-to-end in a real browser / a real extension host / a real
device" is **not** a finished verification when no harness exists to drive that runtime headlessly;
it's a claim waiting on a human, and "I eyeballed it / I reasoned it works" is exactly the untested
guess the discipline above forbids.

So, as a **hard rule**:

- **If a verification's proof needs a runtime the standard tiers can't reach** — a real service worker
  / Background Fetch / push (happy-dom has none), a real VS Code Extension Development Host (Vitest
  never loads one), a real device sensor, a GPU, a secure-context-only API — then **the test harness
  that makes that runtime agent-runnable is its own backlog item, and the verification item carries a
  `blockedBy` edge to it.** Build the harness first; verify against it second.
- **Never claim a real-runtime verification you did not mechanically observe.** If part of a claim
  genuinely cannot be driven even with the harness (e.g. a network transfer that only survives in a
  flagged real profile), say so explicitly and file that residual — an inconclusive run is not proof
  (see "A probe can lie too").
- **The harness card's own DoD is a green sample** in that runtime (a trivial spec going green via the
  lane's command), so the harness itself is proven before anything depends on it.

This is why a card whose only remaining step is "verify in a real X" is **not agent-ready** until its
harness exists: at batch/selection pre-flight it reads as `blocked-in-fact` (a needed gate verified
absent) and the remediation is to scaffold the harness card and add the `blockedBy` edge — not to skip
the item, and never to mark it done off an un-run claim. Worked example: #675 (real SW + Background
Fetch) `blockedBy` #684 (the real-Chromium SW E2E lane); #676 (real extension host) `blockedBy` #685
(the `@vscode/test-electron` host harness).

## Pyramid

| Tier | Pattern | Runner | Env | Purpose |
|------|---------|--------|-----|---------|
| Unit | `*.test.ts` | Vitest | happy-dom | Single class/function, mocked deps |
| Integration | `*.test.ts` | Vitest | happy-dom | Multiple components together |
| E2E | `*.spec.ts` | Playwright (`chromium`) | real browser | User flows on the live demo |
| SW / durable-tier | `*.sw.spec.ts` | Playwright (`chromium-sw`) | real browser, **SW allowed** | Service-worker + Background-Fetch reload-survival |

> **Real-browser service-worker lane (#684).** Vitest runs under happy-dom — **no service
> worker, no Background Fetch** — and the default `chromium` E2E project neither allows SW
> registration nor serves a SW origin. A verification whose proof needs a real runtime (e.g.
> #675's durable-tier reload-survival) must depend on a harness that provides it. The
> `chromium-sw` Playwright project is that harness: it runs `*.sw.spec.ts` in a context with
> `serviceWorkers: 'allow'`, served by the zero-dependency static fixture server at
> `plugs/__tests__/e2e/sw-fixtures/serve.mjs` (http://localhost:3210 — a SW-capable origin
> sending `Service-Worker-Allowed: /`). Drive reload-survival via the reusable
> `sw-fixtures/rehydrate-helper.ts` (`assertSurvivesHardReload(page, task)`): register → arm →
> hard-reload → assert the worker re-hydrated. The fixture's Background-Fetch feature-detect
> honours `window.__forceNoBgFetch`, so the degraded (navigation-guard re-arm) branch is
> exercised deterministically. **Residual manual step:** a true Background-Fetch *network*
> transfer surviving reload may need a flagged/real Chromium profile — drive what headless can,
> document the rest as the one manual check.

### Locations
```
plugs/{module}/__tests__/unit/*.test.ts
plugs/{module}/__tests__/integration/*.test.ts
blocks/__tests__/unit/{group}/*.test.ts
blocks/__tests__/integration/*.test.ts
plugs/__tests__/e2e/*.spec.ts
plugs/__tests__/e2e/*.sw.spec.ts          # real-browser SW lane (chromium-sw project)
plugs/__tests__/e2e/sw-fixtures/          # static fixture server + SW/page + rehydrate-helper
```

## What to test where

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| New class/function | Yes | Maybe | No |
| Bug fix | Yes (reproduce) | If cross-component | If user-visible |
| New public method | Yes | If uses injectors | No |
| Parser | Yes | Yes (with registry) | No |
| Attribute | Yes | Yes (with DOM) | Yes (user flow) |
| Store | Yes | Maybe | If in demo |
| Demo feature | No | No | Yes |

## Quality guidelines
Real Git fixtures must pass `-c gc.auto=0 -c maintenance.auto=false` on their Git invocations.
A large seed commit can launch detached maintenance/repack that outlives `execFileSync`, racing
recursive snapshots and cleanup. Apply the same flags to bounded production freshness fetches;
do not hide the race with sleeps, cleanup retries, or exclusions from the snapshot.

1. Test behavior, not implementation.
2. One concept per test; descriptive names (`should notify listeners on setItem`).
3. Arrange-Act-Assert. Reset state in `beforeEach`/`afterEach`.
4. Mock external deps with `vi.fn()` / spies.

## Coverage
Enforced in `vitest.config.ts` — **80% minimum** for lines, functions, branches, statements over `plugs/**/*.ts` and `blocks/**/*.ts`. Excluded: `**/index.ts`, `**/__tests__/**`, `*.test.ts`, `*.spec.ts`, config files.

### Per-diff trust-chain branch floor (#2876)

`check:standards` runs the separate `diff-branch-coverage` check with an 80% floor
(`DIFF_BRANCH_COVERAGE_FLOOR` in `scripts/lib/diff-branch-coverage.mjs`). Generate
`coverage/coverage-final.json` with `npx vitest run --coverage` after editing source.
The default base is `HEAD` (staged + unstaged + untracked additions); for committed
branch changes, set `DIFF_COVERAGE_BASE` to the intended base commit, typically the
PR merge-base. The gate reports its base and does not fetch or guess a remote base.

Only added/replaced lines in `isTrustChainTier` files are attributed. Deletions,
empty diffs and changes outside the tier require no coverage report. Each Istanbul
branch outcome whose parent or arm range intersects changed lines counts once;
multiline ranges include body edits. This conservatively includes V8 function ranges.
An empty branch map is valid (no branches); missing files, malformed counters and
reports older than changed source fail closed. The timestamp check catches ordinary
stale local reports, but is not a source hash or provenance attestation: generate
coverage in the same checkout, after edits, and do not reuse copied reports.

The result says how many branches introduced or touched by this diff were exercised.
It does not establish implementation correctness or assertion quality. The existing
scoped-planes coverage thresholds remain independent.

## Commands
```bash
npm test                            # all unit + integration
npx vitest run blocks/              # a directory
npx vitest run path/to/file.test.ts # one file
npx vitest watch                    # watch mode
npm start                           # dev server (needed for E2E)
npm run test:integration            # E2E (Playwright)
npx vitest run --coverage           # coverage report
```

## Developing & manually testing in a lane

Every edit — including an ad-hoc "just fix this one thing" — happens in an **isolated lane clone**, never the main checkout (#2123; the writer model in [platform-decisions.md#pr-flow-rollout-mechanism](platform-decisions.md#pr-flow-rollout-mechanism)). The lane trigger is *making an edit*, not *running a command*. The main checkout stays the human's — its dev server on `:3000`/`:8080` is theirs; don't build or serve into it.

**1 — Pick or provision a lane** (persistent clone pool under `~/workspace/.lanes/<repo>/lane-N`, git objects shared via `--reference`, own HEAD):
```bash
node scripts/lane-pool.mjs status --json     # per-lane path / head / clean / deps
node scripts/lane-pool.mjs provision --count=N   # create/refresh N lanes
```
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

> **Visual-regression substrate is self-hosted Playwright, in-repo committed `-linux` PNG baselines — no hosted SaaS** (decision #2233, ratified 2026-07-09). The governing rule + rationale + evidence-gated escape hatches (Argos-as-review-UI-only #2233 fork 2; graduate-baselines-off-PNG #1967) live in [platform-decisions.md#visual-regression-substrate](./platform-decisions.md#visual-regression-substrate).

> **Skill/memory replay substrate is an ephemeral throwaway clone (`mkdtemp` + `git init`, `rmSync`), never the shared lane pool** (decision #2274, ratified 2026-07-09). Even testing the lane tooling itself uses a fabricated `LANE_POOL_ROOT` under a temp dir, never allocated production lanes; `--dry-run` is never the fidelity substrate. Full rule + rationale in [platform-decisions.md#skill-memory-replay-substrate](./platform-decisions.md#skill-memory-replay-substrate).

## Web Cases — protocol conformance fixtures
"Web Cases" are the source of truth for protocol conformity: live documentation examples **and** input fixtures for E2E conformance testing.
- **Directory**: `src/cases/<protocol-id>/`
- **Naming**: ordered — `01-registry-standard.html`, `02-edge-case.html`.
- **Format**: raw HTML fragments. ❌ No `<html>`/`<body>`/`div.wrapper`. ✅ Only the directive/component and its direct children.

**Mandatory coverage per protocol:**
1. **Registry Standard** — happy path using valid registry defaults.
2. **Visual Overrides** — inline slot/template customization.
3. **Parameterization** — passing args via attributes (`args-*`).
4. **Reliability** — error handling, timeouts, forgivable failures.
5. **Deferred/Lazy** — interaction with the loading/visibility Intent.

### Stale-state inventory

`node scripts/operations/run.mjs stale-state --json` inventories this checkout's active/preparing
backlog claims, its repository lane pool, and the configured operation run store. Read
`verdict.records` together with `verdict.gaps`; a failed source enumeration is never an empty-source
claim. Corrupt run records remain visible as unknown. Lane status preserves lease read/parse failures
as `readError`; the inventory retains each such lane as a lease record with unknown owner liveness.

`pidAlive` records the current probe of the recorded PID; `ownerPidAlive` drives the verdict.
The lease `pid` is the acquire CLI, not the agent, so leases without a durable `agentPid` have unknown
owner liveness even if their recorded PID is dead. Probes reuse `reconcile-pass.mjs#probePid`;
null/invalid PIDs and foreign-host PIDs remain unknown. TTL and run completion never prove death.
Claims do not normally record an owner or PID; the report preserves that missing evidence as null.

`hasUnsafeWork` reuses lane status cleanliness and supplements its behind count with a read-only
count of commits absent from local origin refs. No fetch occurs: remote ref freshness is a named
limit, and false is never cleanup authorization. Unassociated claims/runs have null work safety.
Age is milliseconds since the recorded acquisition/start time, or null when missing/unreadable.

The CLI normally persists runs and call telemetry even for compute-only operations. This inventory
uses the existing memory run store and omits the optional call logger to honor its zero-write contract.
All child git reads inherit `GIT_OPTIONAL_LOCKS=0` so status does not refresh an index. Cleanup stays
with supported manual lifecycle commands; never edit lease/claim files by hand.

## Builder prepare admission probes

The builder's `cliPlanTick` and `cliDispatch` must pass the same
`WE_MAX_CONCURRENT_LANES` override to their tick subprocesses. Otherwise the
second read can lose a planned prepare to capacity and report the original
build's `needs-prepare` hold. Probe both through `planTick`, `readTick`, and
`shapeDispatchRead` without applying dispatch effects. A refused prepare must
release its claim and discard its proposed guard so the next tick can retry;
only a claimed prepare guard's TTL retirement consumes the prepare retry budget.

## Dispatch eligibility reports

When the runner is alive but an item does not move, use
`node scripts/operations/run.mjs dispatch-eligibility --item=NNN --json` (omit `--item` for
all cleared queue entries). Supply the runner's `--bookkeepingFile=<path>` when available.
The report reuses `dispatch-lane-io.mjs#readTick` and `dispatch-lane.mjs#shapeDispatchRead`.
`verdict.items[].gates` records the executed short-circuit path; later gates were not evaluated.
`buildAdmission.selection` records the existing `selectClearedRows` / `clearedNotReady` checks;
`buildAdmission.gates` is `dispatchPlan`'s ordered build trace. A build hold can route to preparation
or PR repair; `buildAdmission.prepare` records `planPrepareSpawns`'s guard, existing-PR and lane checks.
The first blocking gate names the failing recorded condition, including that alternate prepare route. `markers` are observed values, not additional
admission rules: a missing `deliveryAgent` is not a refusal in this path, and an omitted
`deliveryTarget` resolves to `main`.

Attach the JSON, observation time, item id, and expected progress to a starvation bug filed
through the `file-item` operation. Preserve `guardsFrom`, dropped bookkeeping and unreadable
record counts: an incomplete observation must not read as a complete guard check.

Eligibility reads explicitly send `config.verbose: false` to the tick CLI: omitting it advances
and persists the runner's bounded diagnostic verbose window, even if liveness recording is disabled.
The prepare trace records `dispatch-paused` before its other gates so an unscoped item's build
`scope` hold does not mask the pause. Whole-queue shaping errors appear on the affected entry as
`error` with `eligible: false`; single-item invariant failures retain the CLI error contract.

### Standalone worker declines

No-change already-done reports must reach `planHoldRouting` before the decline prefix is added.
The shared classifier requires `spec already done on main: commit <sha>`; the worker verifies
Done-when against main and supplies that citation. Exercise the existing `landRoute` with a temporary
Git origin: assert `graduatedTo`, unchanged scope, unrelated-citation refusal, and launch-checkout
isolation. A bare already-exists assertion is insufficient and retains the decline path.

Standalone no-change builds (#4552): replay with an empty implementation diff and a launcher report (Codex `lastMessage` or Gemini `events.finalResponse`). Assert the Findings note and scope removal on disk, the `worker-declined` dispatch hold, and the router lease that prevents duplicate landing. The card stays open; the existing verified PR path parks it `review:pending`. Missing final text must exercise the same path with a generic finding. Codex `--json` can emit JSONL before its pretty-printed report: replay that mixed stdout, prefer the report, and fall back to completed agent-message events or a fresh lane log before cleanup. Gemini uses result responses or per-step agent-response deltas. Never reuse an untouched prior-run log. Blocker references in decline Findings are advisory (`possible blocker: #NNN`); prepare verifies them before setting `blockedBy`.

## Claude subagent usage

`node scripts/operations/agent-usage-report.mjs --session=<id>` extracts usage automatically from
Claude's persisted parent and child transcripts. Omit `--session` to use `CLAUDE_CODE_SESSION_ID`
with the cwd project slug; `--transcript=<parent.jsonl>` is the unambiguous cross-project form.
Run ingestion after the children finish: records are append-only snapshots, and a later scan of the
same agent does not update an earlier snapshot. This CLI does not install a scheduler or Claude hook.
It is suitable for a serialized session-end job; overlapping writers are not supported.

The script streams **every line** of each child, reusing `inspect-agent-health/agent-health.mjs`'s
project root, decorated-id handling and transcript resolver. `CLAUDE_PROJECTS_DIR` overrides that
root (set before module import). Sidecar `toolUseId` and parent `tool_result.tool_use_id` link the
actual `Agent` dispatch; structured `toolUseResult.agentId` or textual `agentId:` supplies the child
when the sidecar is absent. Task metadata prefers the sidecar description, then dispatch description,
otherwise null; raw prompts are never a fallback. Descriptions are capped at 200 characters, including
an ellipsis when truncated. Explicit child paths must resolve inside `PROJECTS_DIR` after symlink
resolution; outside paths (including sibling-prefix collisions) are rejected and counted in `skipped`.
The resolver compares against the physical project-store root while preserving `PROJECTS_DIR` for
diagnostics. ID-search candidates use the same containment check; escaping symlinks are skipped before
choosing the newest valid hit. Regression fixtures must include a deliberately symlinked store root:
realpath-normalized temporary roots alone mask mismatches between logical and physical paths.
Missing children and malformed transcript rows are counted explicitly.

The local sidecar is `.operations/agent-usage/<day>.jsonl`, covered by the existing `.operations/`
gitignore rule. Like `call-log-store.mjs`, its default root is the **script's checkout**, never cwd.
Separate physical lane clones therefore have separate defaults; set `OPERATION_AGENT_USAGE_DIR` to
one absolute directory to aggregate across them. Each timestamp day's `agentId` is the dedupe key;
no historical directory scan occurs on append. The first physical transcript line supplies the timestamp,
otherwise mtime does. For mtime-only transcripts, ingest after they stop changing so the day stays stable.

Records retain `task`, `modelTier`, `delegatedProvider`, `delegatedModel`, every `delegations` occurrence,
nullable `outcome`, `timestamp`/`timestampSource`, `agentId`, `sessionId`, transcript paths and `toolUseId`.
A single Claude model/provider is a string; multiple distinct models/providers are arrays so mixed runs
are not silently assigned to their last provider. `delegatedModel` is a `{command, model}` object, an
array for repeated invocations, or null for none. `delegations` additionally records the provider and
whether its model was explicit, the current script default, or unspecified. Codex's default comes from
its real exported `CODEX_MODEL`. Gemini's wrapper has **no pinned default**: it delegates model selection
to agy, so absent flags yield null, not a guessed model. The current Codex pin is a fallback inference,
not proof of the pin a historical checkout used.

Both command fields contain only the detected invocation's normalized argv, with content-bearing
`task`, `task-file`, `prompt`, `message`, `description`, `body` and `text` values replaced by
`[redacted]` (case-insensitive, both separate and equals forms). The result is capped at 300 characters,
including a truncation ellipsis. Shell wrappers and adjacent commands are not copied into this summary;
model extraction still uses the original parsed flags. Keep this transformation pure and redact before
capping: truncating raw content still leaks its prefix.

Only assistant `Bash` tool uses executing the named direct-task script count as delegation. The
conservative shell classifier understands literal script paths, node, common wrappers, shell `-c`,
quotes, comments, separators and heredocs. It does not evaluate shell variables, aliases or dynamically
generated commands. This counts recorded invocations, not proof that the external provider succeeded.
PR outcomes retain nearby text evidence for a created/opened/merged/rejected/closed PR or a bare PR URL;
these are best-effort transcript observations, not independently verified GitHub state or attribution.

`node scripts/operations/agent-usage-report.mjs --report --days=7` prints dispatch counts by exact
Claude model string, delegated provider and day. `--since=YYYY-MM-DD` is inclusive; `--days=N` includes
today in UTC. `--json` works in both scan and report modes. Each distinct model/provider observed in a
mixed dispatch receives one count, so category sums can exceed total dispatches. Missing models count
as `unknown`. Corrupt store rows are skipped and counted; scans also report corruption encountered in
target day files. Keep this unscored operational log separate from the committed delegation trial scorecard.

Tests under `scripts/operations/__tests__/agent-usage-report.test.mjs` create temporary project trees and
redirect the store. They exercise missing sidecars/children, full reads beyond the health helper's tail
budget, shell false positives, model changes, day rotation, reruns, corrupt rows and the actual CLI.

### Cross-clone numbering regression

`lane-drain-numbering.test.mjs` must exercise two separate repositories: a blocker numbered in
clone A, then a dependent landed in clone B with an empty local ledger. The shared `origin/main`
`bornAs` record supplies the fallback; local-ledger persistence alone cannot prove this path.
Unknown references report `in-flight` when a provisional item is visible in the checkout or a
local/remote branch tree, otherwise `unresolvable` (potentially dead, not proven dead: refs may be
unfetched). Dry-run returns the same diagnostics without changing numbering state. The fallback
visits explicit reference syntax, preserving bare birth-hash prose and `resolutionNote` quotes;
the older local-ledger blind-rewrite behavior is unchanged.

### Multi-repo check contract

`scripts/__tests__/multi-repo-checks.test.mjs` scans non-test JS/TS sources in
`scripts/conveyor`, `scripts/operations`, `skills-src/conveyor`, and `scripts/lib`.
The pure TypeScript-AST scanner ignores comments, checks repository scoping on gh
calls, and rejects duplicated constellation slugs. Specific exceptions live in
`scripts/lib/we-only-checks.json`; an exception with no remaining finding fails
with “remove this entry”. This is a Vitest contract, not a standards-gate rule.
The isolated parked-review workflow cannot import the shared table; its table is
pinned to `CONSTELLATION_REPOS` by `scripts/lib/__tests__/review-core.test.mjs`.

### Operator notification probes

`operator-notify` consumes only `operator-queue`'s `ready` rows. Tests inject the notifier,
including child CLI probes; never exercise real desktop delivery in this suite. Persisted
successes deduplicate until an item leaves NEEDS YOU; queue errors preserve all prior keys.
The operations IO fidelity gate requires the shared real-repo fixture even for filesystem
state: the notifier test proves its external state path leaves that checkout clean.

A core file that dynamically imports its CLI cannot await that import at module scope when
its CLI statically imports the core. A staged Node probe of that cycle exits 13 with unsettled
top-level await. Defer the import with `.then(...)`, and test both entry paths as subprocesses.

### Daemon worker risk routing

For the [daemon model rule](platform-decisions.md#daemon-claude-worker-risk), exercise
card loading through `readTick` and spawn argv: a pure router test cannot catch
`findItem` dropping frontmatter risk. Review daemon fixtures must inject both
`readPrs` and `readAgents` to exercise its shared PR snapshot; that snapshot carries
escalation reasons and touched paths into the session model selection.

### Explicit Claude spawn models

Operator rule (2026-09-29): every fresh daemon-launched Claude session must pass an explicit
`--model`; only `--resume` retains the existing session's model. `buildAgentArgv` refuses an
unresolvable model with `notApplied`. Its launch-kind table test covers every `LAUNCH_KINDS`
member, plus review/inspect, and the provider test checks that kind survives request narrowing.
Preserve routed choices; defaults use `workerTierFor` and `CLAUDE_SPAWN_MODEL_BY_TIER`.

### Automatic item-prepare retirement

Prepare claims reuse build claim locks and orphan PID classification, with the shared 15-minute heartbeat
TTL plus confirmed dead ownership (a known live worker still wins). Retirement reads the card from remote
main and checks this attempt's prepare PR; a failed read keeps the claim. Tests must cover stale run-store
rows and prior guards so a retired claim actually frees capacity. A completed unstamped result is held as
`prepare-unstamped`, including across daemon restarts and cooldown expiry; the hold clears when main carries
a valid `preparedDate`. An open PR's committed stamp is checked separately while it awaits landing.

Prepare result recovery: pass durable prepare holds into tick-core before candidate selection (including
its dispatch-lane re-read); filtering after its two-slot cap starves every later card. Held item guards
are excluded from capacity. Replay two held queue leaders plus two eligible successors. The daemon
uses `prepare-stamp-pending` for sectioned results and a detached lane worker to run `prepare-stamp`,
verify the committed stamp and submit via `open-pr --mode=label-on-green`; only missing sections retain
`prepare-unstamped`. Test fresh-main and existing-PR recovery, lane-local command paths, stale section
observations, resolved cards, failed stamps, freeze/dry-run, and a fresh Node `--bogus-flag` boot.


### Probation prepare validation and fallback

A prepare worker's clean exit is not a landable result. Require the substantive card sections, run
`prepare-stamp` in the acquired lane, and return a rejected stamp's diagnostic to the worker once
before abandoning. The #4325 regression produced 43 lines but lost them to the guarded writer's
locus-prefix validation; briefs must teach repository-prefixed code references. A no-diff result
must retain the worker's final explanation (#4322's old launcher log omitted it).

The build dispatcher reads durable `probation-launch` scorecard rows for WE `taskType: prepare`.
Two consecutive attempts without a PR activate `prepare-route-fallback`: subsequent prepares disable
probation and retain explicit Claude Sonnet argv. Re-reading history across ticks/restarts does not
reset this route; a newer successful probation prepare clears it. Test the diagnostic repair through
the parked-PR path, bounded refusal, and the daemon's dispatch environment as well as its route decision.

### Prepare launch evidence and brief boundaries

Standalone Claude prepares use `skills-src/conveyor/prepare-item-agent-brief.md`; probation's
runner reads `skills-src/conveyor/prepare-item-worker-brief.md`. Keep these separate: worker-only
instructions delegate stamping and publishing to a runner that standalone sessions do not have.
Dispatch success requires a persisted effect with a handle, never the planning verdict alone;
regress failed effects through the CLI reader and assert immediate claim release with the error.
Prepare retirement probes the worker handle independently of the daemon-owned claim PID.
A failed session listing remains unknown. The daemon's records live in the coordination
`build-dispatch-runs` store; scratch-started Claude transcripts live under dispatch project paths,
even after the session changes into a lane. Lane-only transcript searches miss those sessions.


### Builder postmortem accounting

Stream headless JSONL and match the first user message plus the dispatch attempt identity.
A session slug can be reused across attempts (observed for `conveyor-4341b`); join by
run/effect ID, worker UUID, implementation repo/lane and timestamps instead. Distinguish
preparation effects from build attempts: a `b` suffix alone does not prove a failed build.
Pair tool IDs and union their intervals before subtracting from wall time. Coalesce usage
by assistant message ID; split known external verify intervals from model/unobserved time
when a resumed transcript spans the gate. Tool `is_error=false` does not establish green
tests when output was piped through `tail` or a later report command succeeded. Intended
mutation RED runs and changed-input reruns are not waste. `lastSeenLiveAt` is not completion,
and `pr-opened` is not landed. Preserve unknown timings rather than converting them to zero.
The 2026-09-30 worked example and source offsets are in
`reports/2026-09-30-builder-postmortem.md`; operational metrics belong in the existing
`run-rating.mjs` / `run-scorecard-store.mjs` machinery, not a parallel history store.

## Prepare PR isolation

Prepare-item refs (`lane/<item>-prepare-item-*`) receive a fixed item-specific title from the open-pr producer,
never a commit subject. Other `-prepare-` refs (prepare-decision, prepare-stamp) are not guarded: decision
prepares legitimately touch research files. Its submission boundary fetches origin/main, checks the full three-dot diff
against the unique target card, rejects lane merge commits, and pins the observed source SHA before
calling pr-land. Observation failures refuse publication. Prepare agents acquire fresh origin/main
lanes and never merge another lane. Regression histories live in
`we:scripts/operations/__tests__/prepare-pr.test.mjs`.

Builder red-draft recovery: test the raw draft snapshot before normalization (the build-policy projection drops draft metadata). GitHub REST check-runs responses contain a `check_runs` array, unlike the bare arrays returned by annotations and pull files. Exercise that IO shape, author liveness, durable PR-level retry accounting, exact branch forwarding, and comment plus `blocked:needs-human` construction. The recovery pass runs before in-flight holds; dry runs never dispatch. `WE_BUILD_DAEMON_RED_DRAFT_MINUTES` defaults to 60.

## Prepare failure diagnosis and release

`we:scripts/conveyor/prepare-failure-policy.mjs` records evidence and cause per attempt in the
coordination-root prepare failure ledger. Only observed rate-limit/network faults permit two automatic
retries; wrapper errors, timeouts and missing output alone are unknown. Unknowns reserve a prevention
landing job once per cause and stay held. A pending/failed filing is not a landed card: inspect its
record and job output, never blindly respawn it.

Release through `we:scripts/conveyor/prepare-failure-releases.json`: cite the exact attempt, known cause,
report evidence and full fix commit. The daemon verifies the commit is in its own ancestry before
applying the data. A later attempt is not covered by an earlier release. Route entries use target
`route:prepare` and exact scorecard `handle:scoredAt` keys; every failed probation attempt must be covered
before the latched route returns. Neither elapsed time nor a later successful run clears that latch.
The incident report `reports/2026-09-30-prepare-failures-root-causes.md` distinguishes worker cause from
claim retirement: dead-session cleanup frees capacity but does not prove why authoring failed.

Stamp-recovery reservations do not expire. A terminal recovery error is recorded in its dispatch log,
classified by the daemon, and cannot spawn again without a remaining transient budget or a cited fix.
A new starting marker prevents the previous failure from being mistaken for the newly running job.
Historical probation evidence can accompany an item release under its exact `probationAttempt` key;
this improves the recorded diagnosis but does not authorize a route release.

Red-draft inactivity in `we:skills-src/conveyor/build-dispatch-daemon.mjs` is measured from the later of the current head commit’s committed date and the builder effect’s `lastSeenLiveAt`. Never age recovery from PR `updated_at`: labels, check reruns and advisory notes refresh it without author activity. Replay a recent PR metadata update with old author evidence, and separately assert that a live author, a recent commit or recent live observation prevents recovery. Missing both usable timestamps fails closed.

### Preparation terminal handoff

Prepare probation launches carry the original dispatch run ID and effect key into the terminal writer.
A stamp on main invalidates prepare guards and holds before build planning; a positively live worker
still retains ownership. Probe with an in-flight run on disk, duplicate terminal delivery, a restarted
reader, and a stamped card at the next daemon tick. Held dispatch reads must not invoke the full planner.
Use the integration Vitest config for we:scripts/operations/__tests__/dispatch-lane-integration.test.mjs;
the default config excludes that file. Keep dead-PID and unknown-session crash recovery tests.

## GitHub spend regression probes

Use TOTAL App GraphQL counter movement over a named wall-clock window as the success metric.
Per-caller counter deltas include concurrent traffic and are not query costs. The metered read
queries in `we:scripts/lib/gh-metered-reads.mjs` include `rateLimit { cost }`; the throttle
records that response cost and a query hash without storing request variables or response bodies.
Historical ledger rows without cost remain estimates and cannot supply a measured per-shape projection.

Git-derived already-done results must preserve the body-disclaimer exclusion. Default GitHub
merge commits contain a title, not the original PR body; a potentially implementing match must
fall back unless that body is available. Older nonstandard merges are irrelevant only when git
ancestry proves they predate the item's creation (including its bornAs/JIT-number alias).
PR-limit fixtures should compare the existing authorship classifier over git's author, message,
and parsed co-author trailers, and assert no GitHub invocation on a successful git read.

Already-done CLI fixtures must run in their own git checkout: complete history proves zero host
calls; shallow history exercises the metered GraphQL fallback. Preserve exact stale-ID call counts
and cache replay assertions on that fallback. Keep the fake host's throttle store private so another
suite cannot consume its budget. Numbering fixtures likewise pass a private `lockRoot` to the real
mutex instead of acquiring the developer's shared drain lock.

### Direct heavy-run hook probes

The `heavy-enforce` guard requires admission even for one-file Vitest runs, `related`,
and direct `check-standards.mjs` execution. Use `node scripts/readiness/heavy-admission.mjs run -- npx vitest run <file>`
or the admitted `npm run test:unit -- <file>` / `npm run check:standards` scripts.
`WE_FULL_SUITE_OK` bypasses only full-suite selection, never admission. Guard tests should
assert the suggested command verbatim and probe stdin-to-stdout hook wiring; unrelated
allow-case fixtures must use admitted commands.
