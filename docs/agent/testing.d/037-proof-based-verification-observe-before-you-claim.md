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

### Default-parameter dependency tests

The lane-scan resolver's default-parameter tests must mock `platformPreference` and
`readDeclaredSettings` at the module boundary with hoisted `vi.mock` factories; post-import
namespace spies did not reach the resolver's named imports in this suite. Preserve the real
exports and use `mockReturnValueOnce` for each layer case so other callers retain real IO.
Also exercise the real platform reader with a temporary `WE_PLATFORM_PREFERENCES_FILE`
and an empty mocked tool layer, calling `resolveLaneScanPolicy()` without injected arguments.
For an unset environment layer, register the stub for restoration, then explicitly delete the
key; passing `undefined` to `vi.stubEnv` can leave a string value in older Vitest versions.

### Imported action-wrapper inventories

Lane-action boundary tests inventory imported helper targets from every module, including
module/export identity and aliased callees. Keep exact per-occurrence counts, keyed by file,
module, export and callee, for mutating helpers and every helper owned by the change. Only
known read-only/noise helpers (filesystem reads, pure formatters and renderers; redaction scrubbers keep exact counts) may vary in
count; a mutating name or target overrides that exemption. Keep distinct module/export identity
checks for every helper, including noise. Named negative controls must reject repeated existing
mutations as well as aliased cleanup wrappers imported from outside the owned modules.

### Gates in git fixtures

When a publish gate runs the suite that tests its own caller, use a fixture-local npm script in the
temporary git repo to verify gate arguments and green/red handling without recursively launching the
suite. Exercise real subprocesses and git transport. Emit gate chatter in the fixture too: a CLI's
machine-readable JSON stdout must remain parseable when its child gate prints output.

Keep real-Git fixtures compatible with Forge's Git 2.43. An unsupported repository extension can
prevent even read-only repository commands: inspect configuration with `git config --file`, and
prove refusal by comparing filesystem bytes. Git's fetch negotiation may avoid a stale commit-graph,
so verify an existing graph explicitly when testing corruption admission and repair. An `ls-files`
exit 1 alone does not prove an untracked path: sparse-tree read failures can share that exit status.
For a narrowed catch, keep one negative test per independent condition: the expected status with
an unrelated diagnostic, and the expected diagnostic with another status. Fail-closed hook checks
also need nonempty stdout and extra or partial stderr cases, in both reporting and repair modes.
A test promising "only" or "never" must exercise the excluded case as well as the permitted one;
assert the absence of retries or writes, not just the returned error.
Send repository-sized path lists through NUL-delimited stdin, not argv; real-Git regressions should
exceed the host's `getconf ARG_MAX` and prove the argv form fails with `E2BIG` while stdin succeeds.

### Passive-wait hook regression probes

Security hooks (`PreToolUse`, `Stop`, `SubagentStop`) bootstrap the launcher and guards only
from `$HOME/workspace/.guard-main`, never an env-selected clone or the primary or lane copies.
Tests redirect that fixed location through a temporary `HOME`. The launcher derives its clone
from its own realpath and refuses locations other than `<clone>/scripts/hooks/run-pinned-guard.mjs`.
The launcher requires a real regular file within the clone's `scripts/` tree (symlinks cannot
escape), sets `WE_HOOK_ROOT` to the real cwd checkout toplevel, and preserves stdin, argv,
cwd and guard exit codes. From a cwd outside Git (a dispatched worker's scratch directory),
`WE_HOOK_ROOT` is the primary checkout beside the clone (`webeverything` or `web-everything`);
with neither present the launcher denies. For `PreToolUse`, missing clone, launcher, script or
Git evidence fails closed with stderr and exit 2, and the settings wrapper maps any nonzero
launcher result to exit 2. `Stop` and `SubagentStop` use a separate wrapper
(`exec node "$launcher" --stop-hook …`): exit 2 there means "keep going", so a launcher
failure that would recur on every retry exits 1 (non-blocking, stderr shown), and the guard's
own exit code passes through unchanged. `scripts/lib/pinned-hook-command.mjs` recognizes the
two forms separately, and dispatch carries only the deny form as a `PreToolUse` guard.
The hook never fetches. Sync freshness uses only `<clone>/.git/FETCH_HEAD` mtime;
missing, unreadable, non-file, invalid or future-dated evidence denies execution. A last sync
older than 24 hours fails closed with exit 2, the exact recovery command
`node <clone>/scripts/hooks/sync-guard-clone.mjs`, and the launchd template path
`<clone>/scripts/hooks/com.we.guard-main-sync.plist.template`. An old HEAD commit in a
quiet repository does not make a recently synchronized clone stale. The pristine check
requires every `git ls-files -v` tag to be `H`, clean
`status --porcelain --untracked-files=all --ignored` (so a file hidden by `.gitignore` or
`info/exclude`, such as a planted `node_modules` package, also denies) and
`diff-index --quiet HEAD --`, and HEAD equal to origin/main. Test fixtures therefore link
`node_modules` beside the clone, never inside it. Git checks disable
`core.fsmonitor` and `core.untrackedCache`. Refresh with `node scripts/hooks/sync-guard-clone.mjs`
from a repo with the intended origin, or pass `--origin=<url>` from any directory.

The sync script creates a single-branch main clone and records its canonical path in local
Git config (`we.guardClone`). Subsequent runs validate that ownership, origin, main branch,
and main-only fetch refspec before fetch/reset/clean. Every successful run updates
`FETCH_HEAD` mtime, including initial creation and unchanged origin/main. Initial creation
resets HEAD to the fetched origin/main too; the deterministic clone/fetch race regression
advances a temporary local origin after clone completes and verifies convergence before success.
An existing unowned checkout is refused:
move it aside and rerun sync to create the disposable clone. Never point this at a working
checkout; all tracked edits and untracked/ignored files in the owned clone are discarded.
Use an absolute origin URL/path so the scheduler and interactive invocations agree.

Hooks matching one event run in parallel (six share the `Edit|Write` matcher), so launchers
never exclude each other. Each launcher holds a shared lease, a
`<clone>.guard-readers/<pid>-<nonce>` file holding its start time, until its guard exits.
Only sync takes the exclusive sibling `<clone>.guard-lock`, a file holding
`<pid> <start-ms> <nonce>` and published with one hard link, so it exists only once complete.
Sync fetches into the private ref `refs/we-guard/incoming` (empty `--refmap`, no FETCH_HEAD
write) before taking the lock, so the lock covers only `update-ref`, `reset` and `clean`. A
launcher that finds a live sync waits up to 20 seconds, then denies with "retry the hook".
Sync takes its lock before it lists leases, and a launcher re-checks the lock after publishing
its lease, so sync cannot reset a clone a guard is running from. After taking the lock, sync
waits up to 20 seconds for live leases to drain, then refuses with "retry sync" without
resetting or cleaning; a live sync lock is refused before any fetch. Ownership is judged by
process liveness, never by a timer: a pid that is gone, or that now names a process with a
different `ps -o lstart` start time (pid reuse), is an exited owner. Unknown evidence counts as
live. Launchers ignore an exited owner's lock (and an ownerless old-protocol lock directory) but
wait for, then deny behind, an old-protocol directory whose `owner` record is live, judged exactly
as reclaim judges it; an `owner` that is not a readable file denies. That record is
`<pid> <hex nonce>`, never read as a start time: its pid is a reuse only when that process started
after the `owner` file was written. The next
sync reclaims an abandoned lock and prunes exited leases, and the pristine and freshness checks still guard a
clone a crashed sync left half-reset. Reclaim is serialised behind `<clone>.guard-lock.reclaim`
and removes only an existing record judged dead: a lock observed absent is never reclaimed
(a peer may publish at any moment after that read). An old-protocol directory (the empty mkdir
lock, or an earlier revision's directory holding an `owner` record) is reclaimed only when that
record is absent or dead, by unlinking `owner` and then `rmdir`, which cannot remove a lock file
published meanwhile; a directory with other entries is refused and named. An abandoned reclaim marker
(a sync killed inside that few-millisecond step) makes sync refuse and name the marker to
remove. Sync sweeps staging and aside debris left by exited syncs, and ignores entries in
`.guard-readers` that are not `<pid>-<hex>` leases. A launcher killed outright orphans its
guard, which can then run while a sync resets the clone. `WE_GUARD_LOCK_WAIT_MS` may only
shorten either wait (tests use it); it can never lengthen it. Both waits print their effective
bound ("waiting up to <ms>ms"), so the cap is tested without waiting it out, and a test keeps
the launcher's and sync's copies of the lock helpers identical. The soak break
`lane-local-guard-loaded-as-hook` inspects every security event: `PreToolUse`, `Stop` and
`SubagentStop`.
The launcher canonicalizes the clone and guard entry path, passes the guard realpath as
Node's `argv[1]`, and runs in place without a temporary copy. This keeps CLI entry checks
working through symlinked HOME/TMPDIR paths (including macOS `/var` → `/private/var`).
After the child exits, a changed or unreadable entry realpath fails closed with exit 2;
repair the clone with `scripts/hooks/sync-guard-clone.mjs` before retrying.
The named concurrent-sync regression pauses before a delayed import, removes that dependency
in origin/main, verifies sync refuses while the guard's lease is live, and verifies refresh
succeeds after the original import finishes and the lease is released. The named
concurrent-hook regression starts every `Edit|Write` hook at once and requires each to report
ready while all leases are held, then exit 0. Keep test coordination event-driven (stdout and
stderr lines), without sleep/poll loops.

For macOS scheduling, initialize the clone first, then render
`scripts/hooks/com.we.guard-main-sync.plist.template` with
`node scripts/hooks/render-guard-sync-plist.mjs --node-path=<absolute-node> --guard-clone-path=<absolute-clone> --origin-url=<origin> --executable-path=<PATH-including-Git> --log-directory=<existing-absolute-log-directory>`.
Quote each argument as needed and redirect stdout to
`~/Library/LaunchAgents/com.we.guard-main-sync.plist`. The renderer XML-escapes values,
preserves an explicit `DEVELOPER_DIR`, and pins standalone Command Line Tools only when
that directory exists; otherwise it omits the variable so full Xcode can remain selected.
Use the renderer rather than copying the raw template. launchd does not expand shell
variables or tildes. Install with
`launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.we.guard-main-sync.plist"`;
remove with `launchctl bootout gui/$(id -u)/com.we.guard-main-sync`.
It runs every 900 seconds; inspect the configured stderr log after installation.

Use temporary independent guard clones and primary/linked-worktree fixtures under the task's
`TMPDIR`; replace primary and lane guards/launchers to prove neither runs. Settings-wiring
probes execute every configured command through `sh -c` with a temporary `HOME`, including
a hostile `WE_GUARD_CLONE` that must never select a launcher. Cover assume-unchanged and
skip-worktree edits, failed index/diff reads, stale or invalid FETCH_HEAD, and old HEAD
with a fresh sync (no warning). Cover unchanged sync timestamp refreshes.
Sync probes use local temporary origins only, including wrong-origin and unowned-target refusals.

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
See [the commands and output](../../../backlog/3371-probe-one-alternate-provider-against-the-judge-contract.md#probe-10--tool-bearing-doctrine-isolation-attempted-2026-09-10).

The dispatching session subsequently supplied successful unsandboxed baseline/deletion/tool-bearing
runs ([Probe 11](../../../backlog/3371-probe-one-alternate-provider-against-the-judge-contract.md#probe-11--dispatching-sessions-unsandboxed-deletion-proof-2026-09-10)).
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

