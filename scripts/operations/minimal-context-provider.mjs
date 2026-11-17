#!/usr/bin/env node
/**
 * @file scripts/operations/minimal-context-provider.mjs
 * @description THE SHARED PRIMITIVES behind every minimal-context dispatch mechanism — extracted from
 * `we:scripts/operations/deliver-item-wrapper.mjs` (#3627, PR #2107, live-tested end to end against real item
 * #3371) once a SECOND dispatch kind needed the same proven shape (#xu2pp2m, downstream of #3627/#3628).
 *
 * WHY THIS FILE EXISTS, PER THE OPERATOR'S OWN RULING (recorded on `we:backlog/xu2pp2m-*.md`): the reviewer
 * mechanism (`we:scripts/operations/review-dispatch-wrapper.mjs`) and the fixer mechanism (not built yet — out
 * of scope for the item that created this file) are TWO SEPARATE PRIMITIVES, never one monolithic file and
 * never literal duplication. The parts of `deliver-item-wrapper.mjs`'s pattern that are genuinely NOT
 * delivery-specific — the `CLAUDE_RESTRICTED_PROVIDER` argv shape, the trimmed-hooks-settings-file generation,
 * lane acquire/release, and the "run one declared operation, read its structured verdict" gate-running pattern
 * — live HERE, so both mechanisms import the same proven code instead of each re-deriving or copy-pasting it.
 *
 * HONESTY LABEL, SAME CONVENTION `deliver-item-wrapper.mjs` USES. Every export below is a VERBATIM or
 * mechanically-generalized (parameterized, never behaviourally changed) lift of code that was already proven
 * live against real item #3371 — see that file's own header for the verification trail (the `--restricted`
 * vs `--bare` vs `--safe-mode` evidence in particular). Nothing here is a fresh, unverified design; the only
 * new code is the PARAMETERIZATION itself (a `purpose`/`fileName`/`dirName` argument in place of a hardcoded
 * delivery-specific literal), which is mechanical and covered by this file's own tests plus
 * `deliver-item-wrapper.test.mjs`'s pre-existing ~106 tests (unchanged, still passing — see that file's own
 * import list, which now resolves several of its names through this module instead of a local definition).
 *
 * PARK-UNTIL-EXERCISED APPLIES TO THE CONSUMERS, NOT TO A RE-EXTRACTION OF ALREADY-PROVEN CODE. This module
 * itself changes no runtime behaviour for `deliver-item-wrapper.mjs` (an extraction, not a rewrite — its own
 * test suite is the proof); `we:docs/agent/prototype-based-dev.md`'s "park until genuinely exercised" rule
 * applies to the NEW consumer (`review-dispatch-wrapper.mjs`), which is unwired and unexercised, exactly as
 * `deliver-item-wrapper.mjs` itself was before its own live test.
 *
 * IMPURE: `node:child_process`, `node:fs`. Every impure call takes an injectable `run`/`spawnAgent` (mirrors
 * `deliver-item-wrapper.mjs`'s own convention) so every export here is unit-testable with no real subprocess.
 */
import { execFileSync } from 'node:child_process';
import { resolveAiRouting, aiRoutingInputs } from '../lib/ai-routing.mjs';
import { claudeSpawnAlias, resolvePolicyModel, resolvePolicyEffort } from '../lib/dispatch-routing-policy.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

// #3383 — the delivery-telemetry recorder. Imported here, in the ONE module all six dispatch wrappers share,
// so `lane.acquire` and `verify.gate` spans are captured for EVERY dispatch kind from a single edit rather
// than six divergent ones. `activeRecorder()` returns the null recorder when no wrapper has installed one, so
// an uninstrumented caller (and every existing test) behaves exactly as before. See that module's header for
// why the recorder is ambient rather than threaded through these signatures, and for the never-throw contract
// that makes it safe to call from inside a real delivery's critical path.
import { activeRecorder } from './telemetry-store.mjs';

/** The repo root, resolved by SCRIPT LOCATION (this file lives in `scripts/operations/`, same depth as
 *  `deliver-item-wrapper.mjs`, so this resolves to the identical path that file's own `REPO_ROOT` did). Used
 *  for reading/writing THIS module's own files (`.operations/`, etc.) — never as the cwd for a spawned
 *  mechanical-CLI subprocess; see {@link resolveRunCwd} for why those two needs diverge. */
export const REPO_ROOT = new URL('../..', import.meta.url).pathname;

/** Best-effort `git rev-parse --show-toplevel` — mirrors `scripts/lane-pool.mjs`'s own private `tryGit`
 *  helper (not exported from there, so re-derived here identically rather than importing a CLI module that
 *  runs its argv parsing at import time). `null` on any failure: not a git checkout, no `git` binary, a `cwd`
 *  that no longer exists — callers degrade to a safe fallback rather than propagate. */
function tryGitToplevel(cwd, execFn = execFileSync) {
  try {
    return execFn('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * PURE — the cwd every mechanical-CLI subprocess `run()` spawns (`lane-pool.mjs`, `verify-lane.mjs`,
 * `operations/run.mjs`) should run from: `git rev-parse --show-toplevel` of `processCwd`, when that resolves;
 * {@link REPO_ROOT} (this module's OWN checkout, via `import.meta.url`) only as the fallback for a
 * `processCwd` that is not inside any git checkout at all.
 *
 * THE BUG THIS CLOSES (#xu2pp2m, live run against real PR #2108 from an isolated scratch clone, driver-
 * confirmed). `run()` used to hardcode its subprocess `cwd` to `REPO_ROOT` unconditionally — the checkout
 * THIS FILE happens to live in, derived from its own `import.meta.url` — never the checkout the wrapper is
 * actually being run FROM. `lane-pool.mjs acquire` derives ITS OWN pool root from ITS cwd (`CHECKOUT_ROOT =
 * git rev-parse --show-toplevel` against whatever cwd it is spawned with, then `POOL_ROOT = <that checkout's
 * workspace>/.lanes` — see `scripts/lib/lane-pool-paths.mjs#defaultPoolRoot`). Handing it `REPO_ROOT` when
 * this module's own file happens to sit in a throwaway scratch clone that was never provisioned with its own
 * sibling `.lanes` pool makes it look for lanes in a directory that was never provisioned — exact repro: `✗ no
 * lanes provisioned for "web-everything" under <scratch-clone-parent>/.lanes ... run provision --count=N
 * first`. Resolving from `processCwd` instead — the SAME source `lane-pool.mjs` itself trusts for its own
 * `CHECKOUT_ROOT` — fixes it: an operator/orchestrator whose OWN working checkout is the real, provisioned
 * one gets the pool `lane-pool.mjs` would resolve if invoked directly, even while the wrapper's `.mjs` file
 * itself lives elsewhere. Matches `docs/agent/prototype-based-dev.md`'s Portability note and the
 * `scripts/lib/lane-pool-paths.mjs` doctrine it points at — resolve through the existing path-resolution
 * helpers (or the repo root), never a hand-rolled relative path off this file's own location.
 *
 * @param {string} [processCwd] - typically `process.cwd()`.
 * @param {(cwd: string) => (string|null)} [gitToplevel] - injectable for tests (mirrors this file's own
 *   `run`-injection convention) — defaults to a real `git rev-parse --show-toplevel`.
 * @returns {string}
 */
export function resolveRunCwd(processCwd = process.cwd(), gitToplevel = tryGitToplevel) {
  return gitToplevel(processCwd) || REPO_ROOT;
}

/** How much stdout a mechanical CLI call may produce before Node kills the child. #xu2pp2m: the default is
 *  1 MB, and `review-loop-cli.mjs --json` emits the WHOLE run record — every finding's prose AND, on a
 *  `read`-step finding, the net diff itself. A real PR overflows that, and `execFileSync`'s `ENOBUFS` throw
 *  looks to `dispatchReviewMechanical`'s catch exactly like a crashed CLI: the review is misreported
 *  `blocked-on-infra` and its genuine verdict is lost. 64 MB matches what `we:skills-src/conveyor/runner.mjs`
 *  already allows its own `reconcile-pass.mjs --json` read. */
export const RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** The one blocking `execFileSync` wrapper every mechanical CLI call in this file (and every caller of it)
 *  goes through — cwd defaults to {@link resolveRunCwd}'s answer (the ACTUAL working checkout, never this
 *  module's own script-location-derived `REPO_ROOT` alone — see that function's docblock for the bug this
 *  fixes), still overridable per-call via `opts.cwd` exactly as before. */
export const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8', cwd: resolveRunCwd(), maxBuffer: RUN_MAX_BUFFER_BYTES, ...opts,
});

/**
 * build-orphan-adopt (#4131/#4382 fix) — does `lane`'s working tree still hold at least one commit ahead of
 * its delivery base (`main` by default)? HALF of the resumability check
 * `deliver-item-wrapper.mjs#runAgentToCompletion`'s `resume` branch uses (the other half is a `done` report —
 * see that function) — reused as-is by `scripts/conveyor/build-dispatch-orphan-adopt.mjs`, never re-derived,
 * so both callers agree on what "resumable" means. A report with no surviving commit means the lane was
 * reset, reclaimed, or reused since the report was written, and resuming from it would hand the
 * gate/converge/PR steps a diff that no longer exists — worse than starting over. Fails closed (`false`) on
 * any git error: an unreadable lane is never treated as resumable.
 *
 * PR #2921 review — the default base is `origin/main`, never the local `main`: a pool lane's working branch IS
 * its local `main` (`lane-pool.mjs acquire` runs `checkout -B main origin/main`, and the build commits onto
 * it), so `main..HEAD` is always 0 in a real lane — confirmed live (`main..HEAD` = 0, `origin/main..HEAD` = 1
 * on a lane holding one finished commit). Same base `lane-pool.mjs#laneDirtyOrAhead` uses.
 * @param {{lane: string, base?: string, run?: Function}} o
 * @returns {boolean}
 */
export function laneHasCommitAhead({ lane, base = 'origin/main', run: runFn = run } = {}) {
  try {
    const out = runFn('git', ['rev-list', '--count', `${base}..HEAD`], { cwd: lane });
    const n = Number(String(out ?? '').trim());
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

/** The tool allowlist `--restricted` needs handed back explicitly (verified against the real CLI while writing
 *  `deliver-item-wrapper.mjs`: `--tools=default` does NOT restore what `--restricted` removes — a probe asking
 *  for a Bash call under `--tools=default` came back "no shell tool available"). This is what a minimal-context
 *  agent needs to build/edit + report; extend it here, in the one place, if a future brief needs more. */
export const RESTRICTED_PROVIDER_TOOLS = 'Bash,Edit,Write,Read,Glob,Grep';

// ================================================================================================
// 1. The `CLAUDE_RESTRICTED_PROVIDER` argv shape — VERIFIED against the real CLI (v2.1.266) while building
//    `deliver-item-wrapper.mjs`: `--restricted` (never `--bare`, which requires a real API key and cannot use
//    the operator's own OAuth/subscription auth; never `--safe-mode`, independently smoke-tested and REJECTED —
//    a `--settings=<hooks file>` layered on top of `--safe-mode` never fires) + an explicit `--tools` allowlist
//    (required — `--tools=default` does not restore what `--restricted` removes) + `--strict-mcp-config` (closes
//    a leak `--restricted` alone does not: without it a personal MCP tool surface still showed up) +
//    `--disable-slash-commands` (defense in depth — `--restricted`'s own help text never mentions skills at all,
//    unlike `--safe-mode`'s) + a TRIMMED `--settings` file. See `deliver-item-wrapper.mjs`'s own
//    `CLAUDE_RESTRICTED_PROVIDER` docblock for the full verification trail (auth-without-a-key, hooks-firing,
//    and `--resume`, each independently re-run against the real CLI).
// ================================================================================================

/**
 * PURE argv builder — the fresh-spawn/`-p --session-id` shape, or the `--resume` shape when `resumeSessionId`
 * is given. No `-p` in the resume branch — verified, not a bug: a real `--resume <uuid> "<prompt>"` run with
 * redirected (non-TTY) stdout and no `-p` completed as a clean headless turn (this CLI treats non-interactive
 * stdout as non-interactive on its own).
 *
 * `tools` is overridable (defaults to {@link RESTRICTED_PROVIDER_TOOLS}) so a future caller that genuinely
 * needs a narrower or wider allowlist than the delivery/review default can say so explicitly, in one place,
 * rather than hand-rolling a second argv builder.
 *
 * `addDirs` (#4348) — extra working directories, one `--add-dir <dir>` pair each, on BOTH branches. `--restricted`
 * confines the file tools to the working directories, `--add-dir` included (`claude --help`), so a cross-locus
 * delivery whose cwd is the impl lane needs its WE lane (the spec, the `## Progress` bookkeeping) added here or
 * the agent cannot read it. Omitted → argv byte-identical to before.
 */
/** Shared guard for the four Claude-only helper launchers. Resolve first; validate before launch.
 * Keep inherited bytes (including omitted flags). Unsupported providers refuse rather than
 * silently launching a different model. Account selection is deliberately outside this role.
 */
export function resolveHelperRouting(current, { env = process.env, resolved, log = console.error } = {}) {
  if (current.model !== undefined) resolvePolicyModel('claude', current.model);
  const lines = [];
  resolved ??= resolveAiRouting({ env, log: line => lines.push(line) });
  const report = line => { if (log !== false) { try { log(line); } catch { /* diagnostic only */ } } };
  for (const line of lines) report(line);
  // The cascade retains lower-layer values on invalid input. Helpers must refuse
  // that fallback, including when the retained coordinator is entirely inherited.
  const invalid = (resolved.invalid ?? []).filter(detail =>
    /^(?:platform|tool|env)(?:\.helper(?=[.=:])|[=:])/.test(detail));
  if (invalid.length) throw new TypeError(`aiRouting.helper: invalid routing settings: ${invalid.join('; ')}`);
  const { coordinator } = aiRoutingInputs('helper', resolved);
  if (!coordinator) return current;
  report(`policy-cascade · aiRouting.helper: ${JSON.stringify(coordinator)} (${JSON.stringify(
    Object.fromEntries(Object.entries(resolved.sources ?? {}).filter(([key]) => key.startsWith('helper.coordinator.'))))})`);
  if (coordinator.provider !== undefined && coordinator.provider !== 'claude') {
    throw new TypeError(`aiRouting.helper: unsupported provider ${coordinator.provider}; this launcher requires Claude`);
  }
  const next = { ...current };
  // claudeSpawnAlias alone passes unknown values through: validate the catalogue first.
  const tiers = ['haiku', 'sonnet', 'opus'];
  const tier = model => tiers.indexOf(claudeSpawnAlias(resolvePolicyModel('claude', model)));
  if (coordinator.model !== undefined) {
    const proposed = tier(coordinator.model);
    if (current.model === undefined) report('aiRouting.helper: current model has no proven floor; ignoring model override');
    else if (proposed < tier(current.model)) report(`aiRouting.helper: model ${coordinator.model} below current ${current.model}; ignoring lowering override`);
    else next.model = claudeSpawnAlias(resolvePolicyModel('claude', coordinator.model));
  }
  if (coordinator.effort !== undefined) {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    resolvePolicyEffort('claude', coordinator.effort);
    if (current.effort === undefined) {
      report('aiRouting.helper: implicit CLI effort has no proven floor; ignoring effort override');
    } else {
      resolvePolicyEffort('claude', current.effort);
      if (efforts.indexOf(coordinator.effort) < efforts.indexOf(current.effort)) {
        report(`aiRouting.helper: effort ${coordinator.effort} below current ${current.effort}; ignoring lowering override`);
      } else next.effort = coordinator.effort;
    }
  }
  // Validate the final model even when only effort/provider was overridden.
  if (next.model !== undefined) tier(next.model);
  return next;
}

export function buildRestrictedProviderArgv({
  sessionId, prompt, resumeSessionId = null, settingsFile, tools = RESTRICTED_PROVIDER_TOOLS, addDirs = [], model = 'sonnet', effort = 'medium',
  currentModel, currentEffort, env = process.env, resolved, log,
}) {
  // Resume floors must be the session's persisted settings, explicitly supplied by the caller.
  // Missing floors leave that dimension with the session; fresh-launch defaults prove nothing.
  // Inherited resumes omit pins even when persisted settings are supplied.
  const current = resumeSessionId
    ? { model: currentModel ?? undefined, effort: currentEffort ?? undefined }
    : { model, effort };
  ({ model, effort } = resolveHelperRouting(current, { env, resolved, log }));
  const resumeRoutingFlags = [
    ...(model !== current.model ? ['--model', claudeSpawnAlias(model)] : []),
    ...(effort !== current.effort ? ['--effort', effort] : []),
  ];
  const RESTRICTED_FLAGS = [
    '--restricted', '--tools', tools, '--strict-mcp-config',
    '--disable-slash-commands', '--settings', settingsFile,
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
  ];
  return resumeSessionId
    ? [...RESTRICTED_FLAGS, ...resumeRoutingFlags, '--resume', String(resumeSessionId), prompt]
    : [...RESTRICTED_FLAGS, '--model', claudeSpawnAlias(model), '--effort', effort, '-p', '--session-id', String(sessionId), prompt];
}

// ================================================================================================
// 2. Minimal-context hooks-settings generation — REAL SCHEMA (`we:.claude/settings.json`'s own hook-
//    registration shape, trimmed). GENERALIZED (moved here from `deliver-item-wrapper.mjs`'s
//    `ensureDeliveryHooksSettingsFile`) into a FACTORY: `createHooksSettingsWriter(fileName, settings)` returns
//    a writer closed over its own filename + settings object, so a caller gets a real, independently-callable
//    `ensure<Whatever>HooksSettingsFile()` function rather than having to pass `fileName`/`settings` at every
//    call site. `deliver-item-wrapper.mjs`'s own `ensureDeliveryHooksSettingsFile` is now literally
//    `createHooksSettingsWriter('delivery-agent-hooks-settings.json', DELIVERY_HOOKS_SETTINGS)` — the exact
//    same generated function, not a re-derived copy.
//
//    WRITES EVERY CALL, never guarded behind `existsSync` — the same #3627 bug-8 correctness fix
//    `deliver-item-wrapper.mjs`'s own version already carries: a settings object is a pure function of its
//    caller's own frozen constant, so re-writing it every call is idempotent in the sense that matters (same
//    bytes out every time) and a STALE on-disk file from a schema that has since changed (e.g. a
//    `permissions.allow` block added later) must never survive because the file merely "already existed".
// ================================================================================================

/**
 * @param {string} fileName - written under `<REPO_ROOT>.operations/<fileName>`.
 * @param {object} settings - the hooks-settings object (already the real `--settings=<path>` JSON schema).
 * @returns {() => string} a writer that materializes `settings` to disk every call and returns the path.
 */
export function createHooksSettingsWriter(fileName, settings) {
  return function ensureHooksSettingsFile() {
    const dir = `${REPO_ROOT}.operations`;
    const path = `${dir}/${fileName}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    return path;
  };
}

// ================================================================================================
// 3. The blocking spawn + failure-capture pattern — the part of `CLAUDE_RESTRICTED_PROVIDER.spawn` that is NOT
//    delivery-specific (delivery-specific env construction / lane-path / reports-dir resolution stays in
//    `deliver-item-wrapper.mjs`, which composes those with this generic call).
// ================================================================================================

/**
 * Best-effort capture of a spawn failure's stdout/stderr, written under `.operations/<dirName>/` — GENERALIZED
 * from `deliver-item-wrapper.mjs`'s `persistDeliverySpawnFailure` (`dirName` used to be the hardcoded
 * `'delivery-spawn-failures'`). Never throws: a failure to write the capture must never mask the real spawn
 * error it exists to explain.
 *
 * @param {string} dirName - the `.operations/` subdirectory, e.g. `'delivery-spawn-failures'` /
 *   `'review-spawn-failures'`.
 * @param {string} sessionSlug
 * @param {Error} error
 * @param {{resumeSessionId?: (string|null)}} [o]
 * @returns {string|null} the path written, or `null` on a capture failure.
 */
export function persistSpawnFailure(dirName, sessionSlug, error, { resumeSessionId = null } = {}) {
  try {
    const dir = `${REPO_ROOT}.operations/${dirName}`;
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/${sessionSlug}${resumeSessionId ? '-resume' : ''}-${Date.now()}.json`;
    writeFileSync(path, `${JSON.stringify({
      sessionSlug,
      resumeSessionId,
      at: new Date().toISOString(),
      message: error && error.message ? String(error.message) : null,
      status: error && 'status' in error ? error.status : null,
      signal: error && 'signal' in error ? error.signal : null,
      stdout: error && error.stdout != null ? String(error.stdout) : null,
      stderr: error && error.stderr != null ? String(error.stderr) : null,
    }, null, 2)}\n`);
    return path;
  } catch {
    return null; // best-effort — never let the CAPTURE itself mask the real spawn failure.
  }
}

// ================================================================================================
// 4. Lane acquire/release — REAL CLI surface, lifted verbatim from `deliver-item-wrapper.mjs`'s own
//    `acquireLane`/`resetStaleVerifyMarker`, GENERALIZED only by making `purpose` an explicit (still
//    `'conveyor-delivery'`-defaulted, so every existing call site is byte-identical) parameter instead of a
//    hardcoded literal — a review dispatch acquires for `--purpose=review-loop`, never `conveyor-delivery`.
// ================================================================================================

/**
 * REAL. Acquires a lane via `lane-pool.mjs acquire --adopt`, stamping the ACQUIRING subprocess's own
 * `CLAUDE_CODE_SESSION_ID` to `claudeSessionId` — never left to inherit whatever the CALLING wrapper process's
 * own env carries — so `--adopt` records the eventual occupant's real identity (`guard-lane.mjs` later compares
 * against exactly this). Then best-effort clears any STALE `.git/.lane-verify` marker a prior occupant left
 * behind via `verify-lane.mjs reset` (`resetStaleVerifyMarker`) — see that function's own docblock.
 *
 * TWO REAL SHAPES, BOTH VERIFIED, SELECTED BY WHETHER `lane` IS GIVEN:
 *   - NUMBERED (the ORIGINAL `deliver-item-wrapper.mjs` shape, byte-for-byte unchanged — argv order is a real
 *     contract several tests pin exactly): a tick plan hands this a specific lane NUMBER
 *     (`--lane=<N> --purpose=<p> --session=<slug> --scope=<s> --item=<i> --adopt`), and the real path is
 *     re-resolved afterward via `resolveLanePath` (a fresh, authoritative read) — this branch returns nothing,
 *     matching its pre-extraction behaviour (every existing caller discards the return value).
 *   - UNNUMBERED (`we:skills-src/review/review-agent-brief.md` step 1's own real, already-proven shape:
 *     `--purpose=<p> --session=<slug> [--wait-ms=<n>] --adopt`, no `--lane=`/`--scope=`/`--item=` at all) —
 *     lets `lane-pool.mjs` pick any free lane. VERIFIED against the real CLI while building this extraction:
 *     `lane-pool.mjs acquire`'s own stdout is JUST the acquired lane's absolute path (every informational line —
 *     "acquired lane-N for...", the holder slug, the release command — goes to STDERR, confirmed by a real
 *     `1>file 2>file` redirect), so this branch reads that stdout directly as the lane path and RETURNS it —
 *     there is no lane number to re-resolve a path from afterward.
 *
 * @param {{lane?: (number|string), sessionSlug: string, scope?: string, item?: (string|number), claudeSessionId: string, purpose?: string, waitMs?: number, base?: string}} o
 *   `purpose` defaults to `'conveyor-delivery'` — the delivery wrapper's own pre-existing behaviour, unchanged.
 *   `lane` omitted (undefined/null) selects the UNNUMBERED shape; `waitMs` (only meaningful there) adds
 *   `--wait-ms=<n>`, matching the review brief's own `--wait-ms=30000` self-healing-momentary-capacity-flicker
 *   reasoning (see that brief's step 1 for the full account). `base` (only meaningful there too, #xu2pp2m
 *   fixer) adds `--base=<ref>`, landing the acquired clone on a predecessor lane's pushed tip (a `lane/*` ref)
 *   instead of `origin/main` — see the UNNUMBERED branch's own comment below for why a fixer needs this.
 * @param {{run?: Function}} [io]
 * @returns {string|undefined} the acquired lane's real path for the UNNUMBERED shape; `undefined` for the
 *   NUMBERED shape (unchanged — callers there already re-resolve via `resolveLanePath`).
 */
export function acquireLane(
  {
    lane, sessionSlug, scope, item, claudeSessionId, purpose = 'conveyor-delivery', waitMs, base,
    // PR #2921 review — a RESUMED delivery (build-orphan-adopt) must re-lease its lane WITHOUT the reset to
    // `origin/main`, or the reset would wipe the finished commit it exists to resume. NUMBERED shape only;
    // `false` (every other caller) leaves the argv byte-identical.
    noReset = false,
    // build-path-codex-isolation-locus — the checkout a NON-`we` locus item's own lane must be acquired
    // against (`repoProfile(key).checkoutPath`, e.g. `$HOME/workspace/plateau-app`), never the calling
    // process's own cwd-derived default. `undefined` (every existing caller) is byte-identical to before this
    // parameter existed: `lane-pool.mjs acquire` gets no `--repo=` and falls back to its own
    // `git rev-parse --show-toplevel` of `resolveRunCwd()`, exactly as it always has. See
    // `deliver-item-wrapper.mjs#resolveDeliveryLocus`/`acquireImplLane` for the real caller.
    repo,
  } = {},
  { run: runFn = run } = {},
) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: claudeSessionId };

  // #3383 — the `lane.acquire` span. This is the highest-value single instrumentation point in the system:
  // it is 6/6 across the wrappers, and it is where the one saturation fact the wrappers currently THROW AWAY
  // lives. Today a bounded-wait acquire that finds no free lane returns an empty path, the caller turns it
  // into the string `'blocked-on-infra (no free lane)'`, and the fact that the pool was saturated — and for
  // how long the caller waited before giving up — is lost. `shape` distinguishes the numbered (tick-planned)
  // acquire from the unnumbered (take-any-free-lane) one, because only the latter can starve.
  const laneSpan = activeRecorder().startSpan('lane.acquire', {
    attributes: {
      purpose, shape: lane != null ? 'numbered' : 'unnumbered',
      ...(lane != null ? { lane: String(lane) } : {}),
      ...(waitMs != null ? { waitMs } : {}),
      ...(base != null ? { base: String(base) } : {}),
      ...(item != null ? { item: String(item) } : {}),
    },
  });

  let acquireOut;
  try {
  if (lane != null) {
    // NUMBERED — the ORIGINAL argv, unchanged (order is a real, test-pinned contract). `repo` is not
    // meaningful here: a NUMBERED acquire always names a lane in the CALLING side's own tick-planned pool
    // (today, always WE's — see `dispatch-lane-io.mjs`'s own `deliverItemDetachedProvider`), so this branch
    // never reads it.
    acquireOut = runFn('node', [
      'scripts/lane-pool.mjs', 'acquire', `--lane=${lane}`, `--purpose=${purpose}`,
      `--session=${sessionSlug}`, `--scope=${scope}`, `--item=${item}`, '--adopt',
      ...(noReset ? ['--no-reset'] : []),
    ], { env });
  } else {
    // UNNUMBERED — the real review-brief shape: no --lane/--scope/--item, optional --wait-ms. GENERALIZED
    // (#xu2pp2m fixer) with an optional `--base=<ref>` — the real, verified `lane-pool.mjs acquire` flag
    // (`scripts/lane-pool.mjs`'s own usage string, `#2386`) that lands the freshly-acquired clone on a
    // PREDECESSOR LANE'S PUSHED TIP instead of `origin/main` — exactly what a fixer needs to reconstitute a
    // bounced PR's `lane/*` ref rather than rebuild from scratch (`we:skills-src/conveyor/fix-agent-brief.md`
    // step 1's own `--base={{LANE_REF}}` shape, now generalized onto the shared unnumbered acquire path a
    // PR-dispatched wrapper uses — a fixer has no pre-assigned lane NUMBER from a tick plan, same as a review
    // dispatch, so it takes whatever free lane the pool hands back and points it at the PR's own ref via
    // `--base`). Omitted (`undefined`) for every existing caller (review dispatch, and the delivery wrapper's
    // own NUMBERED branch, which never reaches this branch at all) — behavior for every caller that does not
    // pass `base` is byte-for-byte unchanged.
    const args = ['scripts/lane-pool.mjs', 'acquire', `--purpose=${purpose}`, `--session=${sessionSlug}`];
    // build-path-codex-isolation-locus — `--repo=<checkoutPath>` picks WHICH repo's pool this unnumbered
    // acquire draws from (`lane-pool.mjs`'s own `--repo=` override, default cwd's toplevel otherwise). This is
    // the ONE new caller of this branch that needs a repo OTHER than the one `resolveRunCwd()` would derive —
    // `deliver-item-wrapper.mjs#acquireImplLane` acquiring a `frontierui`/`plateau-app` implementation lane
    // from a process whose own cwd is WE's checkout. Every existing caller (review dispatch) omits `repo` and
    // is byte-identical to before.
    if (repo != null) args.push(`--repo=${repo}`);
    // `--item=` records this lane's item in the lane-ports registry (same as the NUMBERED branch already
    // does) — added only when the caller actually has one (review dispatch never does), so that caller's own
    // pinned argv is unaffected.
    if (item != null) args.push(`--item=${item}`);
    if (waitMs != null) args.push(`--wait-ms=${waitMs}`);
    if (base != null) args.push(`--base=${base}`);
    args.push('--adopt');
    acquireOut = runFn('node', args, { env });
  }
  } catch (e) {
    // A THROWN acquire (the pool CLI itself crashed or refused) — an `error` span, then the original error
    // propagates untouched. Telemetry is a bystander here, never a participant.
    laneSpan.fail(e, { outcome: 'acquire-threw' });
    throw e;
  }

  // A freshly acquired lane must never inherit a STALE `.git/.lane-verify` marker from a prior occupant's run
  // (#3627 attempt-5 live-run finding) — best-effort: a marker-reset failure must not fail the whole acquire.
  if (lane != null) {
    laneSpan.ok({ outcome: 'acquired' });
    try {
      const lanePath = resolveLanePath(lane, { run: runFn });
      resetStaleVerifyMarker(lanePath, { run: runFn, claudeSessionId });
    } catch {
      // best-effort — see docblock above.
    }
    return undefined;
  }

  const lanePath = String(acquireOut ?? '').trim();
  if (lanePath === '') {
    // THE POOL-SATURATION SIGNAL (#3383). Not an exception and not a crash — the bounded wait expired with
    // every lane occupied. Recorded as an `error` span with the classified outcome `no-free-lane`, so
    // `goldenSignals` counts it in BOTH the error rate (this dispatch did not happen) and, via the reason
    // breakdown, as capacity rather than as a defect. That distinction is the whole point of classifying the
    // reason instead of only counting failures.
    laneSpan.fail('no free lane after bounded wait', { outcome: 'no-free-lane' });
  } else {
    laneSpan.ok({ outcome: 'acquired', lane: lanePath.split('/').pop() });
  }
  try {
    resetStaleVerifyMarker(lanePath, { run: runFn, claudeSessionId });
  } catch {
    // best-effort — see docblock above.
  }
  return lanePath;
}

/** REAL — shells `verify-lane.mjs reset` (its own sanctioned marker-clear subcommand) against a just-acquired
 *  lane. Swallows a refusal/crash rather than throwing (a `reset` refusal is either "no marker to clear" —
 *  already a no-op — or "a live foreign lease holds this lane" — a real reason to leave it alone). */
export function resetStaleVerifyMarker(lanePath, { run: runFn = run, claudeSessionId } = {}) {
  try {
    runFn('node', ['scripts/verify-lane.mjs', 'reset', `--repo=${lanePath}`, '--json'],
      { env: { ...process.env, CLAUDE_CODE_SESSION_ID: claudeSessionId } });
  } catch {
    // best-effort — see acquireLane's docblock above.
  }
}

/**
 * REAL — releases a lane-pool lease by session (`--all-pools --session=<slug>`, matching the review-agent
 * brief's own step-4 shape, `we:skills-src/review/review-agent-brief.md`). GENERALIZED out of
 * `deliver-item-wrapper.mjs`'s `releaseClaimAndLane` — that function ALSO releases a backlog CLAIM
 * (`scripts/backlog.mjs release`), which is delivery/build-specific (a review dispatch never claims a backlog
 * item), so only the lane-pool half moves here; `deliver-item-wrapper.mjs` keeps its own `releaseClaimAndLane`
 * calling this plus its own claim-release call.
 *
 * @param {{lane: number|string, sessionSlug: string, bestEffort?: boolean}} o
 * @param {{run?: Function}} [io]
 */
export function releaseLane({ lane, sessionSlug, bestEffort = false }, { run: runFn = run } = {}) {
  const opts = bestEffort ? { stdio: 'ignore' } : {};
  if (bestEffort) {
    try { runFn('node', ['scripts/lane-pool.mjs', 'release', `--lane=${lane}`, `--session=${sessionSlug}`], opts); } catch { /* best-effort */ }
    return;
  }
  runFn('node', ['scripts/lane-pool.mjs', 'release', `--lane=${lane}`, `--session=${sessionSlug}`], opts);
}

/**
 * REAL — releases EVERY pool's lease for a session in one call (`--all-pools`), the shape a dispatched agent
 * that does not track which numbered lane/pool it holds uses (`we:skills-src/review/review-agent-brief.md`
 * step 4: `node scripts/lane-pool.mjs release --all-pools --session={{SESSION_SLUG}}`). Best-effort by design
 * — a release failure at exit time must not crash an otherwise-complete dispatch.
 *
 * @param {string} sessionSlug
 * @param {{run?: Function}} [io]
 */
export function releaseAllPools(sessionSlug, { run: runFn = run } = {}) {
  try { runFn('node', ['scripts/lane-pool.mjs', 'release', '--all-pools', `--session=${sessionSlug}`]); } catch { /* best-effort */ }
}

/**
 * REAL (`deliver-item-wrapper.mjs`'s own `resolveLanePath`, verbatim) — the SINGLE source of truth for "which
 * real, absolute path is lane N right now" (`we:scripts/lib/lane-pool-paths.mjs`/`verify-lane.mjs`'s own
 * convention), read via `lane-pool.mjs status --json` rather than re-derived relative-path math (which silently
 * computes the WRONG path when this file is imported from anywhere but the primary checkout).
 */
export function resolveLanePath(lane, { run: runFn = run } = {}) {
  const out = runFn('node', ['scripts/lane-pool.mjs', 'status', '--json']);
  const parsed = JSON.parse(out);
  const rows = Array.isArray(parsed.lanes) ? parsed.lanes : [];
  const found = rows.find((r) => Number(r.lane) === Number(lane));
  if (!found || !found.path) {
    throw new Error(`minimal-context-provider: lane-pool.mjs status --json reported no entry/path for lane-${lane}`);
  }
  return found.path;
}

// ================================================================================================
// 5. The gate-running pattern — REAL, routed through the DECLARED `verify` operation
//    (`scripts/operations/verify.mjs`, wired into `run.mjs`), lifted verbatim from `deliver-item-wrapper.mjs`'s
//    own `runVerifyOperation`. "Run one declared operation, read its structured verdict" is the SAME shape a
//    purely-mechanical review dispatch needs for `review-loop-cli.mjs` — not reused directly (the review CLI's
//    own output shape and outcome enum differ from `verify`'s), but the THREE-VALUED, never-flat-ok/not-ok
//    reading discipline this function models is exactly what `review-dispatch-wrapper.mjs`'s own read of
//    `review-loop-cli.mjs --json` follows.
// ================================================================================================

/**
 * REAL — routed through the DECLARED `verify` operation instead of a raw `verify-lane.mjs --json` shell-out.
 * THREE-VALUED: `pass` / `fail` / `unrun` — an operation-level crash, or a verdict whose `unrun` count is
 * nonzero while `failed` is zero (a stale/foreign/corrupt marker — an environment problem, not evidence of
 * anything wrong in a diff) must never collapse into `fail`. See `deliver-item-wrapper.mjs`'s own
 * `runVerifyOperation` docblock (unchanged here) for the full reasoning and the #3627 live-run finding this
 * discipline traces to.
 */
export function runVerifyOperation(lanePath, { run: runFn = run, attempt = 1 } = {}) {
  // #3383 — the `verify.gate` span, the second 6/6-adjacent seam (3 of the 6 wrappers route their gate
  // through here, and the other three reach it via `runGateWithOneRetry`). `attempt` is threaded so a RETRIED
  // gate is distinguishable from a first pass — the uniform retry axis the wrappers have never had. The gate
  // is a DURABLE span name: it runs `test:unit && check:standards`, minutes long, and a process killed inside
  // it is exactly the case worth seeing as `abandoned` rather than as silence.
  const span = activeRecorder().startSpan('verify.gate', {
    attempt,
    attributes: { lane: String(lanePath ?? '').split('/').pop() || null },
  });
  /** Close the span from the three-valued verdict, then hand the caller's own result straight back. The
   *  THREE-VALUED reading is preserved end to end: only `fail` is an `error` span. An `unrun` is a stale or
   *  foreign marker — an environment fact, not evidence about the diff — so it closes `unset`, which is
   *  precisely what OTel's third status code is for, and it keeps `unrun` out of the gate's error RATE. */
  const close = (result) => {
    if (result.outcome === 'pass') span.ok({ outcome: 'pass' });
    else if (result.outcome === 'fail') {
      span.fail(`gate red (${Number(result.verdict?.failed) || 0} failing)`, {
        outcome: 'gate-red', failed: Number(result.verdict?.failed) || 0,
      });
    } else span.end({ status: 'unset', statusMessage: 'gate unrun', attributes: { outcome: 'unrun' } });
    return result;
  };

  let out;
  try {
    out = runFn('node', ['scripts/operations/run.mjs', 'verify', `--checkout=${lanePath}`, '--json']);
  } catch (e) {
    return close({ outcome: 'unrun', detail: String(e.stdout || e.message || e), verdict: null });
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return close({ outcome: 'unrun', detail: String(out), verdict: null });
  }
  const verdict = parsed.verdict || {};
  if (verdict.ok === true) return close({ outcome: 'pass', detail: null, verdict });
  const outcome = (Number(verdict.failed) || 0) > 0 ? 'fail' : 'unrun';
  return close({ outcome, detail: JSON.stringify(verdict.blocking ?? verdict, null, 2), verdict });
}
