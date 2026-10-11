/**
 * judge-spawn.mjs — the tool-free juror spawn behind one function (#3028, under #3029).
 *
 * ONE HELPER EVERY `judge` STEP CALLS. A juror is a `claude -p` subprocess with the findings shape
 * ENFORCED, the repo context STRIPPED, and NO TOOLS GRANTED BY DEFAULT — a caller may pass an explicit
 * `allowedTools` allow-list, and `assertLaneCwd` then REFUSES the spawn unless its cwd is a lane clone. The flag recipe was measured in session
 * rather than invented, and this module is where it stops being folklore: no caller re-derives it, and
 * every caller gets the same three guarantees below. `judgeSpawn` returns a validated object or throws
 * carrying THE SPAWN'S OWN error text — never a paraphrase this module made up.
 *
 * VERIFIED AGAINST `claude` 2.1.220 (every flag below appears in `claude --help` at that version; the
 * behavioural claims were each reproduced by a real spawn while this file was written). If a future CLI
 * renames a flag, `buildJudgeArgv`'s unit tests still pass while the integration test fails — that split
 * is deliberate, and the integration test is the canary.
 *
 * THREE THINGS THIS BUYS, ONLY THE FIRST OF WHICH IS TIDINESS.
 *
 *  1. `--tools ""` IS A STRUCTURAL GUARANTEE, NOT A REMINDER. The review mandate's rule that a juror never
 *     checks the branch out in a shared tree (`we:skills-src/review/SKILL.md`, citing #2336) stops being
 *     prose the model has to recall and becomes something it CANNOT DO. Note it is STRONGER than the
 *     mandate: the mandate permits a throwaway clone, and a tool-free juror cannot make one. That
 *     escalation path is deliberately outside the judge contract (#3035).
 *
 *  2. THE SHAPE IS ENFORCED BY THE TOOL, NOT APPROXIMATED. `--json-schema` is implemented as a FORCED TOOL
 *     CALL — a conforming run comes back with `stop_reason: "tool_use"` and the answer already parsed in
 *     `structured_output` (reproduced: a schema-constrained spawn returned `stop_reason: "tool_use"` and a
 *     `structured_output` object, not a string). So there is no prose to parse, no fences to strip, and no
 *     ask-and-validate loop to build. Retries are for genuine failures only.
 *
 *  3. A JUROR IS A STRUCTURALLY DISTINCT ACTOR, NOT A NOMINAL ONE — and THIS is the guarantee the item was
 *     originally written without. The repo's independence check (`we:scripts/lib/review-independence.mjs`)
 *     keys reviewer identity on `CLAUDE_CODE_SESSION_ID`, and A SUBAGENT INHERITS ITS PARENT'S VALUE — so
 *     by that test every review run as a subagent IS THE SAME ACTOR AS THE AUTHOR, no matter what the
 *     mandate calls it. `we:scripts/lib/review-core.mjs` tells the model it is "A reviewer subagent
 *     (independent of you and of the PR's original author)", but nothing enforces that sentence: the
 *     independence decider is imported by the LABEL and LAND seams, never by the review path that emits
 *     the claim. A headless `claude -p`, by contrast, DOES NOT ADOPT the inherited `CLAUDE_CODE_SESSION_ID`
 *     — it mints its own (reproduced: three spawns whose environment carried the parent's id each reported
 *     a different `session_id`). Supplying `--session-id` makes that identity DETERMINISTIC and
 *     RECORDABLE instead of merely fresh, which is why `judgeSpawn` derives one from the run id and
 *     RETURNS IT: a caller can record WHICH ACTOR judged, and that record is a machine fact rather than a
 *     sentence in a prompt.
 *
 *     Read the limit honestly, in the #2895 spirit: a distinct session id is not an unforgeable actor
 *     signal (nothing local is — see the header of `review-independence.mjs`). What it buys is that the
 *     juror's identity is no longer AUTOMATICALLY the author's, which is the failure a subagent juror has
 *     by construction and cannot argue its way out of.
 *
 * THE TRAP, RECORDED SO NOBODY RE-FINDS IT. `--bare` strips more context than `--safe-mode` — and forces
 * key-based auth. Its own help text says Anthropic auth is "strictly ANTHROPIC_API_KEY or apiKeyHelper via
 * --settings (OAuth and keychain are never read)", so on a subscription it CANNOT SEE THE LOGIN and the
 * spawn dies with `"Not logged in · Please run /login"` (reproduced: exit 1, `is_error: true`, zero tokens
 * billed). Tier one MUST use `--safe-mode`. `FORBIDDEN_ARGV` names the flag and a unit test asserts the
 * helper never emits it, so the trap is a gate rather than a comment.
 *
 * ARGV CONSTRUCTION IS PURE, AND THAT IS THE TESTABILITY SEAM. `buildJudgeArgv` spawns nothing and touches
 * no environment, so the whole flag contract is unit-testable at zero cost and zero latency; exactly one
 * integration test pays for a real spawn. `parseJudgeOutcome` is likewise pure over the CLI's stdout.
 *
 * WHY STDIN CARRIES THE INPUT. The judged material is a diff and can be large, so it goes on stdin rather
 * than argv — no `ARG_MAX` ceiling, and argv stays a fixed, assertable flag list. It also keeps the
 * positional-prompt slot empty, which matters because `--tools` is VARIADIC: a positional argument sitting
 * after `--tools ""` would be swallowed as a tool name. `buildJudgeArgv` therefore always follows
 * `--tools ""` with an option token, and a unit test pins that.
 *
 * WHY RETRY LOST OUTPUT (held item 223). On 2026-10-10, 15/119 review runs lost their final
 * output even though OTEL showed the juror's API calls completed. Replaying the same requests later
 * succeeded 3/3: a transient loss of final output. Each retry uses a distinct derived session id to
 * preserve reviewer independence, and retains the failed attempt's evidence.
 *
 * NOT IN SCOPE: the hosted-tier backend. This is tier one only; the tier-two substitution sits behind this
 * same signature and is not built here (#3028 "Not in scope").
 *
 * `judgeSpawn` takes an injectable `spawnFn`, and retry settings take an injectable file reader.
 * Argv construction and outcome parsing are pure. A LEAF module: it imports nothing from the review/jury seams.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { realpathSync, statSync, existsSync, readFileSync } from 'node:fs';
import { markWorkerEnv } from '../operations/session-role.mjs';
// #landing-freeze-2779 — a juror's spawn (below) built its env straight off the caller's `env` (default
// `process.env`) with no sanitize step, the same gap named in full in
// `../operations/detached-dispatch.mjs#defaultSpawnDetached`'s own docblock: a static, daemon-minted
// `GH_TOKEN` riding along until it expires mid-run. A tool-bearing juror (`allowedTools` set) can shell out
// like any other worker, so it gets the same treatment as every other spawn site.
import { sanitizeSpawnEnv } from './gh-app-shim.mjs';

/**
 * Are these two paths the SAME DIRECTORY? By inode + device, never by comparing the strings.
 *
 * Every previous version of the driver's-lane check compared spellings, and a reviewer found another spelling
 * each time: `..` walked through a substring test, a symlink walked through `resolve`, a case-variant walked
 * through the JS `realpathSync`, and a macOS FIRMLINK walks through `realpathSync.native` — since 10.15,
 * `/Users/x` and `/System/Volumes/Data/Users/x` are one directory with two on-disk names, and `.native`
 * faithfully returns whichever you asked for. Four axes, four rounds, one root cause: a path is a NAME, and
 * the question is about IDENTITY.
 *
 * `ino` + `dev` is that identity, and it is immune to all four at once. Returns false rather than throwing on
 * an unstattable path — the caller has already refused a nonexistent cwd by then, and a stat failure here
 * must not be louder than the refusal it is helping to make.
 *
 * `dev` IS NOT DECORATION: inode numbers are unique per VOLUME, not globally, and a volume root is inode 2 on
 * most filesystems — so unrelated mounted volumes routinely collide. `stat` is injected because a real
 * collision cannot be constructed on demand, and a test that only runs where one happens to exist defends
 * nothing on the machines where it does not (PR #1197 review, finding 1).
 *
 * @param {string} a
 * @param {string} b
 * @param {(p: string) => {ino: number, dev: number}} [stat] - injected so the `dev` branch is testable
 *   deterministically, on any filesystem.
 */
export function sameDirectory(a, b, stat = statSync) {
  try {
    const x = stat(a);
    const y = stat(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/**
 * `realpathSync.native`, with NO fallback. The JS `realpathSync` resolves symlinks but echoes the caller's
 * SPELLING back, so two spellings of one directory compare unequal — see {@link assertLaneCwd}.
 *
 * A `?? realpathSync` fallback was the first cut and it silently restored the bug on any platform taking that
 * branch: no error, no warning, an isolation check quietly absent. `.native` has shipped on every platform
 * since Node 9.2, so the branch was dead — and a dead branch that reopens a security-shaped hole is worse
 * than a startup failure that says so.
 */
export const REAL_PATH = realpathSync.native;
if (typeof REAL_PATH !== 'function') {
  throw new Error('judge-spawn: `fs.realpathSync.native` is unavailable — the lane check cannot distinguish two spellings of one directory without it');
}

/**
 * Resolve the `claude` binary WITHOUT a PATH lookup, when possible. Live-caught 2026-09-23: a headless
 * review-dispatch session's own spawn environment did not carry the nvm-managed `claude` binary's directory
 * on `PATH`, so `nodeSpawn('claude', ...)` failed `ENOENT` — even though the review session ITSELF had
 * started fine moments earlier (its own launch used an absolute path; only the JUROR it then tried to spawn
 * from inside itself used the bare command name + PATH lookup, and that is exactly what broke). This blocked
 * every dispatched review, not only this daemon's.
 *
 * nvm (and most other Node version managers) installs `claude` as a SIBLING of the `node` binary currently
 * running this process — confirmed live: `which claude` and `process.execPath` shared the same directory.
 * Resolving it that way needs no `PATH` lookup at all. Falls back to the bare name (this constant's prior,
 * unconditional value) when that sibling file does not exist — a different install layout is still handled
 * by whatever `PATH` the caller's own environment happens to have, exactly as before this fix.
 * @param {{execPath?: string, exists?: typeof existsSync}} [o] - injectable for the fallback branch's own
 *   test, which cannot otherwise force `process.execPath`'s real sibling to be absent.
 * @returns {string}
 */
export function resolveJudgeCli({ execPath = process.execPath, exists = existsSync } = {}) {
  const sibling = join(dirname(execPath), 'claude');
  return exists(sibling) ? sibling : 'claude';
}

/** The CLI a juror runs as. Named once so a test can assert it and a caller can override the path. */
export const JUDGE_CLI = resolveJudgeCli();

/**
 * How long a juror may run before it is killed — DERIVED, with the measurement it was derived from recorded
 * here so the next person to change a bound can see what it was sized against (#3203).
 *
 * THE MEASUREMENT, 2026-08-19, ten tool-bearing `review-pr` rounds on one repo: 122, 152, 173, 228, 292, 418
 * and 470 seconds, plus TWO kills at the then-current 600s wall.
 *
 * WHY THE PREVIOUS BOUND WAS WRONG, because the shape of the error matters more than the number. #3200
 * removed the per-juror cost ceiling and justified the surviving 600s wall as "real headroom" on wall times of
 * 167–312s. That measurement was sound and the inference was not: those times were produced by jurors running
 * UNDER the ceiling being removed, and a juror that stops when it runs out of budget stops early. The
 * distribution used to size the wall was the distribution the wall was about to invalidate. Any bound
 * justified by data gathered under a tighter bound has this defect.
 *
 * THE DERIVATION: 2× the longest surviving run (470s) = 940s, rounded UP to the next whole five minutes — 20
 * minutes. The multiplier is applied to a value known to be TOO SMALL: two runs were censored by the old wall,
 * so the observed maximum is a lower bound on the real tail, not an estimate of it. Rounding UP follows from
 * that and rounding down would contradict it — the first cut of this constant said "rounded to 15 minutes",
 * which is BELOW its own stated derivation, and the assertion written from the derivation caught it.
 *
 * RE-DERIVE THIS when the juror's work changes — a new lens, a wider tool set, a bigger diff corpus. And note
 * what makes that safe now: hitting this bound is no longer total loss (see `judgeSpawn`), so the cost of it
 * being slightly wrong is a degraded review rather than a discarded one.
 */
export const JUDGE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * How long to wait for `close` after the kill before returning what the streams already delivered. SIGKILL is
 * uncatchable, so `close` normally fires within milliseconds; this is the belt, not the braces.
 */
export const JUDGE_TIMEOUT_GRACE_MS = 2000;

/** Bounded retry policy for transient loss of the juror's final stdout. */
export const UNPARSEABLE_RETRY_SETTING = Object.freeze({
  key: 'judgeUnparseableRetries', env: 'WE_JUDGE_UNPARSEABLE_RETRIES', builtIn: 1, max: 3,
});

/** Resolve a valid retry count from environment, settings, then the built-in default. */
export function resolveUnparseableRetries({
  env = process.env,
  file = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json'),
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const { key, env: envKey, builtIn, max } = UNPARSEABLE_RETRY_SETTING;
  const valid = (value) => {
    if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
  };
  const fromEnv = valid(env[envKey]);
  if (fromEnv !== null) return { value: fromEnv, source: 'env' };
  try {
    const fromFile = valid(JSON.parse(readFile(file))[key]);
    if (fromFile !== null) return { value: fromFile, source: 'settings' };
  } catch { /* unreadable or invalid settings fall through */ }
  return { value: builtIn, source: 'default' };
}

/** A bounded single-line stderr excerpt for failure and retry summaries. */
function stderrSnippet(stderr) {
  return String(stderr).trim().replace(/\s+/g, ' ').slice(-160);
}

/** Final unparseable output, with evidence from every failed attempt. */
export class JudgeUnparseableError extends Error {
  constructor({ attempt, attempts, exitCode, signal, stdout, stderr, wallMs, sessionId, failedAttempts }) {
    const bytes = stdout.length;
    const snippet = stderrSnippet(stderr);
    const tail = String(stderr).trim().slice(-600);
    exitCode = exitCode ?? null;
    signal = signal ?? null;
    super(
      `judge-spawn: the juror did not emit parseable JSON on stdout (attempt ${attempt}/${attempts}, exit ${exitCode ?? 'none'}, signal ${signal ?? 'none'}, stdout ${bytes} bytes${snippet ? `, stderr: ${snippet}` : ''}).\n`
      + `stdout[0..600]: ${String(stdout).slice(0, 600)}\n`
      + (tail ? `stderr[-600..]: ${tail}` : 'stderr: <empty>'),
    );
    this.name = 'JudgeUnparseableError';
    this.unparseable = true;
    this.exitCode = exitCode;
    this.signal = signal;
    this.attempts = attempts;
    this.stderrTail = String(stderr).trim().slice(-1000);
    this.stdoutBytes = bytes;
    this.wallMs = wallMs;
    this.sessionId = sessionId;
    this.failedAttempts = failedAttempts;
    this.telemetry = { sessionId, wallMs, exitCode, signal, stderrTail: this.stderrTail, attempts, failure: 'unparseable-stdout' };
  }
}

/**
 * A juror that hit the wall AND left nothing parseable behind.
 *
 * A DISTINCT TYPE because the run record must distinguish "hit the bound" from "crashed", and before this it
 * could not (#3203, Done-when 3): both arrived as a bare `Error`, so a wall-clock kill read as a juror
 * failure and taught the reader to retry rather than to look. It carries the partial streams because a killed
 * tool-bearing juror has usually done most of the review, and discarding that is the loss this exists to end.
 */
export class JudgeTimeoutError extends Error {
  constructor({ timeoutMs, wallMs, stdout = '', stderr = '' }) {
    super(
      `judge-spawn: the juror exceeded ${timeoutMs}ms and was killed (ran ${wallMs}ms). `
      + 'Its output did not parse, so no partial verdict is available — but this is a BOUND being hit, not a '
      + `crash: see JUDGE_TIMEOUT_MS for what the bound was derived from.\n`
      + `stdout[0..600]: ${String(stdout).slice(0, 600)}\n`
      + `stderr[-600..]: ${String(stderr).trim().slice(-600) || '<empty>'}`,
    );
    this.name = 'JudgeTimeoutError';
    this.timedOut = true;
    this.timeoutMs = timeoutMs;
    this.wallMs = wallMs;
    this.partialStdout = String(stdout);
    this.partialStderr = String(stderr);
  }
}

/**
 * A juror the CLI killed for running out of SPEND — the budget analogue of {@link JudgeTimeoutError} (#3187).
 *
 * A DISTINCT TYPE for the same reason the timeout one is: the run record must distinguish "hit the bound"
 * from "crashed", and for the budget bound it could not. `--max-budget-usd` terminates the juror mid-turn and
 * the CLI reports it as `is_error: true` with `stop_reason: "tool_use"` — a stop reason that NAMES NOTHING
 * ABOUT MONEY, and which a CONFORMING run also carries (a forced-tool-call answer stops for `tool_use` too;
 * see guarantee 2 in this file's header). So the failure was indistinguishable from a crash by inspection.
 *
 * WHAT THAT COST, recorded because it is the expensive half of #3187 and not the obvious half: on the converge
 * run that exposed this, 6 of 8 juror seats died this way and the panel escalated `needs-human` on
 * `mandatory-lens-absent`. That reads as a panel failure. It was a spending limit. The diagnosis went into the
 * wrong place entirely, which is what an error that does not report itself buys you.
 *
 * The ceiling and the spend are BOTH on the message and BOTH on the instance, because either alone leaves the
 * reader guessing: the ceiling without the spend does not show it was reached, and the spend without the
 * ceiling does not show what stopped it.
 */
export class JudgeBudgetError extends Error {
  constructor({ budget, costUsd = 0, stopReason = '', result = '', stderr = '' }) {
    super(
      `judge-spawn: the juror was KILLED BY ITS SPEND CEILING — it spent $${costUsd} against a `
      + `--max-budget-usd of $${budget}. This is a BOUND being hit, not a crash: the CLI reports it as `
      + `is_error with stop_reason=${JSON.stringify(stopReason)}, which names nothing about money, and that `
      + 'is the whole reason this error exists. Raise the ceiling for this caller, or pass `budget: null` for '
      + 'no ceiling (see DEFAULT_BUDGET_USD for what the inherited default was sized against).\n'
      + `result: ${String(result).slice(0, 400) || '<empty>'}\n`
      + `stderr[-600..]: ${String(stderr).trim().slice(-600) || '<empty>'}`,
    );
    this.name = 'JudgeBudgetError';
    this.budgetExceeded = true;
    this.budget = budget;
    this.costUsd = costUsd;
    this.stopReason = stopReason;
  }
}

/**
 * Flags this helper must NEVER emit, with the reason it is banned. `--bare` forces key-based auth and
 * cannot see a subscription login (#3028's recorded trap) — a spawn using it fails "Not logged in".
 */
export const FORBIDDEN_ARGV = Object.freeze(['--bare']);

/**
 * The runtime half of the `--bare` refusal. `buildJudgeArgv` never emits a forbidden flag from its OWN
 * recipe, but this is the check that actually stands between an argv and a process. Separately exported so
 * it is provable on its own.
 *
 * IT IS ALSO REACHABLE THROUGH `judgeSpawn`, which an earlier version of this header denied. `model` is
 * validated only as a non-empty string, so `model: '--bare'` becomes the argv pair `--model --bare` and this
 * guard fires — a real footgun (a flag-shaped option VALUE smuggling a banned flag past the recipe), and the
 * route the unit test uses to pin `judgeSpawn`'s call to this function. The belt-and-braces case the call
 * site is commented for — a future edit making `buildJudgeArgv` emit `--bare` literally — remains
 * unreachable from the public API and is therefore untested; say so rather than imply otherwise.
 *
 * @param {string[]} argv
 * @throws when argv carries any `FORBIDDEN_ARGV` entry.
 */
export function assertNoForbiddenArgv(argv = []) {
  for (const banned of FORBIDDEN_ARGV) {
    if (argv.includes(banned)) {
      throw new Error(`judge-spawn: refusing to spawn with ${banned} — see FORBIDDEN_ARGV and #3028's recorded trap`);
    }
  }
}

/**
 * A tool-bearing juror MUST run in a lane of its OWN. Refuses the spawn otherwise.
 *
 * FOUR EARLIER VERSIONS OF THIS CHECK WERE WRONG, each caught by a reviewer who ran it. They are recorded
 * because every one of them looked correct, and because the next person reaching for a simpler check will
 * reach for one of these:
 *
 *   - ASSERTED, not enforced. The comment claimed the cwd was a lane and that `guard-lane` would deny a
 *     shared-tree write. Nothing set the cwd, and `--safe-mode` disables hooks, so neither was true.
 *   - `path.includes('/.lanes/')` — `…/.lanes/../webeverything` walks straight through the string.
 *   - `resolve()` — normalizes text, never touches the filesystem, so a symlink wearing a lane's shape passes
 *     while the child lands in the shared primary checkout.
 *   - `cwd` defaulting to `process.cwd()` — a review normally runs INSIDE a lane, so an omitted cwd passed by
 *     donating the driver's own tree. That is the tree the juror's mandate tells it to check out, edit and
 *     re-test, and it may carry another session's lease. "A lane is disposable and never shared" is true of a
 *     lane nobody is using; false of the one the driver is standing in.
 *   - full-path equality against the driver — a SUBDIRECTORY of the driver's lane is the same working tree,
 *     and on a case-insensitive filesystem so is a differently-cased spelling.
 *
 * `realpathSync.NATIVE`, not `realpathSync`, and that distinction is the whole of the last bullet: the JS
 * implementation resolves symlinks but echoes back the caller's SPELLING, so `/users/…/lane-13` and
 * `/Users/…/lane-13` compare unequal while naming one directory. The native one returns the on-disk name.
 *
 * @param {string|null} cwd - the lane handed to the juror.
 * @param {string[]|null} allowedTools - null/undefined means a tool-free juror, which is unaffected.
 * @param {string} [selfCwd] - the DRIVER's directory, injected so this is testable.
 * @param {(p: string) => string} [realpath] - injected for the same reason; a test passes identity to reason
 *   about path strings without building real directories.
 */
export function assertLaneCwd(cwd, allowedTools, selfCwd = process.cwd(), realpath = REAL_PATH) {
  if (allowedTools === null || allowedTools === undefined) return;
  const refuse = (why) => {
    throw new Error(
      `judge-spawn: refusing to spawn a TOOL-BEARING juror — ${why}. A juror with tools can write, and `
      + '`--safe-mode` disables the hooks that would otherwise stop it, so a lane of its OWN is the isolation. '
      + 'Acquire one (`node scripts/lane-pool.mjs acquire`) and pass its path as `cwd`. On the operation '
      + 'command line that is `--cwd=<lane>`, which `run.mjs <operation> --help` documents (#3151) — three '
      + 'reviewers hit THIS message with no way to find that out. Or omit `allowedTools` for a tool-free juror.',
    );
  };
  if (cwd === null || cwd === undefined || String(cwd).trim() === '') {
    refuse('no `cwd` was supplied, and there is no safe default — inheriting the driver\'s directory is the '
      + 'defect this exists to prevent');
  }
  // A path that does not exist throws, which is the right answer: a juror cannot run there either.
  let path;
  try {
    path = realpath(resolvePath(String(cwd)));
  } catch {
    refuse(`\`cwd\` ${JSON.stringify(String(cwd))} does not exist, so it cannot be a lane`);
  }
  const lane = laneRootOf(path);
  if (!lane) refuse(`\`cwd\` resolves to ${JSON.stringify(path)}, which is not a lane clone`);
  let selfLane = null;
  try { selfLane = laneRootOf(realpath(resolvePath(String(selfCwd || '.')))); } catch { selfLane = null; }
  // IDENTITY, not spelling — see `sameDirectory`. The string compare is kept as the fast path because it is
  // exact when it fires; `sameDirectory` catches the aliases it cannot see.
  if (selfLane && (lane === selfLane || sameDirectory(lane, selfLane))) {
    refuse(`\`cwd\` is inside the DRIVER'S OWN lane (${JSON.stringify(lane)}) — the juror would be pointed at the `
      + 'working tree its caller is mid-run in, and its mandate is to mutate that tree');
  }
}

/**
 * The lane a resolved path belongs to, or `null`. A lane always lives at `<workspace>/.lanes/<pool>/lane-N`,
 * the same shape `we:scripts/guard-lane.mjs` splits on — so this matches a real pool member and not any
 * directory that happens to be named `.lanes`.
 */
export function laneRootOf(resolvedPath) {
  // NON-GREEDY, so this is the OUTERMOST lane on the path. A greedy `.*` returned the innermost, so a cwd of
  // `…/lane-1/.lanes/y/lane-2` reported a different lane from a driver at `…/lane-1` and the spawn was
  // allowed — while sitting inside the driver's own working tree (PR #1188 review, finding 4).
  const m = /^(.*?[/\\]\.lanes[/\\][^/\\]+[/\\]lane-\d+)(?:[/\\]|$)/.exec(String(resolvedPath));
  return m ? m[1] : null;
}

/** The CLI's own `--effort` enum, per `claude --help` at 2.1.220. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** Defaults for the care→rigor dial. Per-lens callers override all three; these are the cheap middle. */
export const DEFAULT_MODEL = 'sonnet';
export const DEFAULT_EFFORT = 'medium';

/**
 * The per-juror spend ceiling a caller inherits when it declares none — DERIVED, with the measurement it was
 * derived from recorded here, the same way `JUDGE_TIMEOUT_MS` records its own (#3187).
 *
 * WHY THE PREVIOUS VALUE WAS WRONG. `0.5` landed with #3028 sized for a TOOL-FREE juror, and was never
 * revisited when tool-bearing jurors arrived (#3072). A tool-bearing seat reads files, so it spends more, and
 * the inherited ceiling killed it MID-RUN. That is not a cost control; it is a silent truncation of the
 * review, and it does not even report itself as one — see `JudgeBudgetError` for the other half of this fix.
 *
 * THE MEASUREMENT, 2026-08-18, four real tool-bearing `review-pr` rounds: $0.6152, $0.6597, $0.6997 and
 * $0.9042. EVERY ONE EXCEEDS 0.5, so at the inherited default all four would have been killed — and between
 * them they produced ten findings, nine of them real defects a green suite and `check:standards` both missed.
 * Observed separately the same day on the converge path: a seat killed having spent $0.596, then re-run
 * identically at a 3.0 ceiling and finishing at $0.69. Same seat, same input; the ceiling was the only
 * variable.
 *
 * THE DERIVATION: `1.5`, which is ~1.66x the largest surviving observation ($0.9042). Note what that
 * multiplier is applied to, because the honest reading matters: those four runs were themselves produced
 * UNDER a 1.5 ceiling, so the distribution is censored at 1.5 and $0.9042 is a lower bound on the real tail
 * rather than an estimate of it. `1.5` is therefore a value MEASURED AS SUFFICIENT FOR THE LENSES OBSERVED,
 * not one proven sufficient for the widest lens — which is exactly why the two operations that DECLARE a
 * budget at all (`we:scripts/operations/review-pr.mjs`, `we:scripts/operations/review-prep.mjs`) went further
 * and now declare `JUDGE_BUDGET_USD = null`, no ceiling at all, under the same 2026-08-18 operator ruling.
 * "THE TWO THAT DECLARE ONE" IS NOT "THE TWO THAT EXIST" — a third, `we:scripts/operations/explore.mjs`,
 * declares a `judge` step and no budget, and so lands on THIS value. See "WHO INHERITS THIS" below; an
 * earlier draft of this docblock elided that distinction and was wrong because of it.
 *
 * WHY THIS DEFAULT IS NOT ALSO `null`, since that is the obvious question. `we:scripts/lib/judge-panel.mjs`
 * inherits this value as its per-seat default and feeds it to `assertPanelBudget`, which REFUSES any
 * non-positive-finite per-juror budget — an aggregate ceiling cannot be checked over a roster of `null`s. A
 * caller that genuinely wants no ceiling passes `budget: null` per spawn, as both operations do. So the
 * default stays a NUMBER, and its job is to be large enough that inheriting it is never the thing that kills
 * a juror.
 *
 * WHO INHERITS THIS — and why an IMPORTER COUNT is the wrong way to ask. Changing a DEFAULT reaches everything
 * that OMITS the argument, and omitting an argument imports nothing, so a consumer of this value can be
 * invisible to `git grep DEFAULT_BUDGET_USD` by construction. #3187's first round learned this the expensive
 * way: it justified a bounded test run by counting this constant's importers, and CI went red on
 * `we:skills-src/jury/__tests__/panel-fanout.test.mjs`, in a consumer that imports nothing from this file.
 * ROUND 2 THEN GOT IT WRONG AGAIN, one paragraph below that retraction, with a different bad grep — see path
 * 3. Two rounds, two wrong maps of the same change: TRUST NO COUNT HERE THAT WAS NOT RE-DERIVED BY EXECUTING
 * THE PATH. Every claim on this list was proved by running it, not by reading for it.
 * The three live paths, as of #3187:
 *
 *   1. `we:scripts/lib/judge-panel.mjs` — the one module that NAMES this constant as a caller default
 *      (`budget = DEFAULT_BUDGET_USD`), so its whole roster seats here when a caller declares nothing.
 *   2. TRANSITIVELY, anything reaching `judgePanel` without a per-seat budget. `we:skills-src/jury/
 *      panel-fanout.mjs` forwards `budget` only when `typeof payload.budget === 'number'`; a payload without
 *      one falls through to (1). Every hand-run `panel-fanout.mjs` invocation in `we:docs/agent/
 *      delivery-loop.md` and the `converge`/`drain`/`harvest-learnings`/`brand-mark-loop` skills is such a
 *      caller, which is why raising this value NARROWS what their `--max-total-budget-usd` admits.
 *   3. `createDefaultJudge` (`we:scripts/operations/cli-adapter.mjs`) forwards `budget` unconditionally, so a
 *      `judge` step declaration that OMITS it arrives here as `undefined` and takes this default parameter.
 *      THIS PATH IS LIVE, AND `we:scripts/operations/explore.mjs`'s `synthesize` seat (`judgeStep`, ~:646) is
 *      on it: its `request()` returns `{mandate, input, shape, lens}` and the file contains the string
 *      `budget` ZERO times, so the committee synthesizer for `run.mjs explore` (#3150) seats HERE. #3187
 *      therefore raised that live operation's ceiling from $0.5 to $1.5 along with everything else. Harmless,
 *      and arguably intended — that synthesizer is deliberately tool-free, so it was never the seat this card
 *      was unblocking — but it is a spend ceiling this change moved and it must be on this list.
 *
 *      RETRACTED, because getting this wrong twice in two rounds is the point of the section. #3187 round 1
 *      wrote here: *"No declaration does today — both `review-pr` and `review-prep` declare
 *      `JUDGE_BUDGET_USD = null` explicitly — but the path is open"*. That was FALSE, and it was false for the
 *      same reason round 0's importer count was: the grep behind it, `git grep -n "kind: 'judge'"`, matches
 *      only `engine.mjs` and `step-kinds.mjs` — the machinery that CONSTRUCTS the kind — and never a
 *      declaration. Declarations are written `judgeStep(`, and `git grep -n "judgeStep("` finds FOUR in live
 *      operations: `explore.mjs:646`, `review-pr.mjs:913`, `review-pr.mjs:945`, `review-prep.mjs:434`. Only
 *      the last three name a budget. GREP FOR THE DECLARING HELPER, never for the shape it builds.
 *
 * So: when you change this number, run the FULL suite, and expect the breakage somewhere that never mentions
 * it. Tests that pin an inherited total must DERIVE it from this constant rather than write the product out;
 * `judge-panel.test.mjs` and `panel-fanout.test.mjs` both do, and both had to be fixed to.
 *
 * RE-DERIVE THIS when the juror's work changes — a new lens, a wider tool set, a bigger diff corpus.
 */
export const DEFAULT_BUDGET_USD = 1.5;

/**
 * THE ONE SEED ENCODING — the single place a multi-field identity becomes a `deriveSessionId` seed (#3058).
 *
 * WHY IT EXISTS: a space join is not injective. `` `${runId} ${id}` `` maps `("a", "b c#1")` and
 * `("a b", "c#1")` onto the SAME seed, so two structurally different seats in two different runs are recorded
 * as one actor. And `[runId, lens].filter(Boolean).join(' ')` was worse than ambiguous — dropping an absent
 * field before the join collapsed a `runId`-only spawn onto a `lens`-only spawn carrying the same string, with
 * no space anywhere in the input. Both were reproduced before this encoder replaced them.
 *
 * WHY LENGTH-PREFIXED AND NOT NUL-DELIMITED. A NUL delimiter is injective only while you can promise NUL never
 * appears in a field, and that promise is about CALLER INPUT this module does not control — `runId` and `lens`
 * arrive from an operations declaration (`we:scripts/operations/cli-adapter.mjs`). Length-prefixing reserves no
 * byte at all, so it needs no promise and no escaping: it stays injective over arbitrary field content. This
 * repo also already uses NUL as a deliberate in-file sentinel in committed scripts, so it is not a free byte
 * here by convention either.
 *
 * THE ENCODING. `v1|<count>|` then, per field, either `~` for an ABSENT field (`undefined`/`null`) or
 * `<length>:<value>` for a present one. Absent, empty and missing are therefore three different things:
 * `['a']` → `v1|1|1:a`, `['a', undefined]` → `v1|2|1:a~`, `['a', '']` → `v1|2|1:a0:`. Decoding is
 * unambiguous — read the count, then read each field's declared length — which is what injectivity means.
 * `<length>` is in UTF-16 code units, i.e. JS `String.length`, because that is the unit a decoder would slice
 * a JS string by; byte length would be the wrong ruler for this data type, not a stricter one.
 *
 * FIELD SEMANTICS ARE POSITIONAL AND SHARED: field 0 is the run identity, field 1 is the actor's name within
 * that run (a bare `lens` for a direct spawn, a `lens#slot` seat id for a panel seat). Both call sites mean the
 * same thing by the same position, which is why they share this encoder rather than each owning one.
 *
 * @param {Array<string|undefined|null>} fields - the identity fields, in a fixed positional order.
 * @returns {string} an injective encoding of exactly that field list.
 */
export function sessionSeed(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new TypeError('judge-spawn: sessionSeed needs a non-empty array of fields');
  }
  const parts = fields.map((f, i) => {
    if (f === undefined || f === null) return '~';
    if (typeof f !== 'string') {
      throw new TypeError(
        `judge-spawn: sessionSeed field ${i} must be a string, null or undefined, got ${JSON.stringify(f)}`,
      );
    }
    return `${f.length}:${f}`;
  });
  return `v1|${fields.length}|${parts.join('')}`;
}

/**
 * A deterministic RFC 9562 UUIDv8 derived from a seed — the juror's `--session-id`.
 *
 * DETERMINISTIC ON PURPOSE: the same run id and lens always name the same session, so the transcript is
 * findable from the run record and the actor that judged is recorded rather than merely fresh. Version 8
 * is the RFC's CUSTOM version, which is honest about this being a hash rather than random (v4) or a
 * namespaced SHA-1 (v5). Verified accepted by `claude --session-id` at 2.1.220: the CLI echoed the exact
 * id back in its result.
 *
 * SEEDS OF MORE THAN ONE FIELD GO THROUGH `sessionSeed`, NEVER THROUGH A HAND-ROLLED JOIN. This function
 * hashes whatever string it is given and cannot tell an ambiguous seed from an unambiguous one, so the
 * injectivity has to be established before the call — see `sessionSeed`'s header and #3058 for the
 * space-join defect that convention replaced.
 *
 * @param {string} seed - any stable string; multi-field callers pass `sessionSeed([...])`.
 * @returns {string} a lowercase canonical UUID.
 */
export function deriveSessionId(seed) {
  if (typeof seed !== 'string' || !seed.trim()) {
    throw new TypeError('judge-spawn: deriveSessionId needs a non-empty seed string');
  }
  const b = createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; // version 8 — custom
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10x
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A fresh deterministic actor identity for each retry. */
export function retrySessionId(sessionId, attempt) {
  return deriveSessionId(sessionSeed([sessionId, `retry-${attempt}`]));
}

/**
 * THE PURE HALF: the juror's argv. Spawns nothing, reads no environment, touches no disk.
 *
 * The order is FIXED so tests can assert the whole list, and so `--tools ""` is always followed by an
 * option token (see the header on variadic `--tools`). The judged input is NOT here — it goes on stdin.
 *
 * @param {object} opts
 * @param {string} opts.mandate - the stable juror instruction, sent via `--append-system-prompt`.
 * @param {object} opts.shape - a JSON Schema object; enforced via `--json-schema`.
 * @param {string} [opts.model] - per-lens model alias or full name.
 * @param {string} [opts.effort] - per-lens effort, one of `EFFORT_LEVELS`.
 * @param {number} [opts.budget] - hard per-juror ceiling in USD.
 * @param {string} opts.sessionId - the juror's session id; use `deriveSessionId`.
 * @returns {string[]} argv AFTER the binary name.
 */
export function buildJudgeArgv({
  mandate,
  shape,
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  budget = DEFAULT_BUDGET_USD,
  sessionId,
  allowedTools = null,
} = {}) {
  if (allowedTools !== null) {
    // A tool name reaches argv as a bare token, so a flag-shaped one becomes a FLAG — the same hazard
    // `FORBIDDEN_ARGV` exists for, one field over. Refuse anything that is not a plain tool identifier.
    if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
      throw new TypeError('judge-spawn: `allowedTools` must be a non-empty array, or null for a tool-free juror');
    }
    for (const t of allowedTools) {
      if (typeof t !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) {
        throw new TypeError(`judge-spawn: refusing tool name ${JSON.stringify(t)} — a non-identifier reaches argv as a flag`);
      }
    }
    assertNoForbiddenArgv(allowedTools);
  }
  if (typeof mandate !== 'string' || !mandate.trim()) {
    throw new TypeError('judge-spawn: `mandate` must be a non-empty string');
  }
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) {
    throw new TypeError('judge-spawn: `shape` must be a JSON Schema object');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new TypeError('judge-spawn: `model` must be a non-empty string');
  }
  if (!EFFORT_LEVELS.includes(effort)) {
    throw new TypeError(`judge-spawn: \`effort\` must be one of ${EFFORT_LEVELS.join('|')}, got ${JSON.stringify(effort)}`);
  }
  // `null` is UNBOUNDED — the flag is OMITTED rather than given a huge number, so the CLI applies no ceiling at
  // all and nothing has to guess what "big enough" is. Everything else must still be a positive finite number:
  // `undefined` takes the default, and a typo'd string or `0` stays a caller bug rather than a silent licence.
  if (budget !== null && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0)) {
    throw new TypeError('judge-spawn: `budget` must be a positive finite number of USD, or null for no ceiling');
  }
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) {
    throw new TypeError('judge-spawn: `sessionId` must be a canonical lowercase UUID — use deriveSessionId()');
  }

  // TOOL-FREE BY DEFAULT, TOOL-BEARING ONLY ON REQUEST. `--tools ''` is what makes a juror's "never check the
  // branch out in a shared tree" a thing it CANNOT do rather than is asked not to — so it stays the default and
  // every existing caller is unchanged.
  //
  // WHY A TOOL-BEARING VARIANT EXISTS AT ALL. Nine PR reviews run by hand on 2026-08-11/12 found what they
  // found BECAUSE they could act: a `gh` flag bypass found by firing the command at real GitHub, a guard hole
  // reproduced on the parent commit, four decorative tests found by mutating source and watching what stayed
  // green. A juror that can only read a diff finds none of those. The tools ARE the finding mechanism.
  //
  // WHAT REPLACES THE GUARANTEE `--tools ''` GAVE — and the first version of this comment claimed two
  // replacements, one of which did not exist and one of which was switched off. Review caught both:
  //   • it said the spawn's `cwd` is a lane. NOTHING SET IT. The default was `process.cwd()`, so a review run
  //     from the primary checkout spawned a juror with unscoped Bash pointed at the shared tree.
  //   • it said `guard-lane` would deny a shared-tree write. `--safe-mode` DISABLES HOOKS, so the guard the
  //     claim leaned on never ran inside the juror at all.
  // A false claim about a safety property is exactly the kind that must bounce, and it did.
  //
  // THE REAL GUARANTEE, enforced below rather than asserted: a tool-bearing juror MUST be given a lane cwd,
  // and `assertLaneCwd` refuses the spawn otherwise. That does not depend on hooks, on the juror cooperating,
  // or on anyone remembering — if there is no lane, there are no tools. A lane is disposable and never shared,
  // so an unguarded write inside one costs a `lane-pool` refresh. The derived `sessionId` still holds
  // independently, and is a separate property from this one.
  const toolArgs = allowedTools === null
    ? ['--tools', '']                 // variadic — the next token below MUST be an option, and is.
    : ['--allowedTools', ...allowedTools];
  return [
    '-p',
    '--output-format', 'json',
    '--safe-mode',                    // NOT --bare: see FORBIDDEN_ARGV and the header's trap section.
    ...toolArgs,
    '--model', model,
    '--effort', effort,
    // OMITTED when `budget` is null — see the validation above. The 10-minute `timeoutMs` kill in `judgeSpawn`
    // remains the backstop on an unbounded juror, so "no ceiling" means no SPEND ceiling, not no bound at all.
    ...(budget === null ? [] : ['--max-budget-usd', String(budget)]),
    '--no-session-persistence',
    '--session-id', sessionId,
    '--append-system-prompt', mandate,
    '--json-schema', JSON.stringify(shape),
  ];
}

/**
 * THE OTHER PURE HALF: the CLI's stdout, turned into a validated result or a throw.
 *
 * FAILS LOUD AND FAILS WITH THE SPAWN'S OWN WORDS. When the CLI reports an error it carries its own text
 * in `result` (that is how the `--bare` trap surfaces as "Not logged in · Please run /login"), and this
 * function throws exactly that rather than a paraphrase.
 *
 * IT ALSO NAMES THE BUDGET KILL, which is the one failure the CLI's own words do NOT explain (#3187). That
 * needs the ceiling, which is not in stdout — so `budget` is passed in. It is OPTIONAL and defaults to `null`
 * ("no ceiling was declared, or the caller does not know one"), which switches the branch off: with no ceiling
 * there is nothing to have been killed by, and inventing one in the message would be a guess.
 *
 * @param {string} stdout - the CLI's raw stdout.
 * @param {string} [stderr] - the CLI's stderr, folded into the message when stdout is unparseable.
 * @param {number|null} [budget] - the `--max-budget-usd` this spawn declared, so a budget kill can name it.
 * @returns {{value: object, sessionId: string, costUsd: number, durationMs: number, numTurns: number,
 *            stopReason: string, usage: object}}
 * @throws {JudgeBudgetError} when the juror was terminated by that ceiling.
 */
export function parseJudgeOutcome(stdout, stderr = '', budget = null) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout));
  } catch {
    for (const line of String(stdout).split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        const candidate = JSON.parse(line);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && ('session_id' in candidate || 'structured_output' in candidate || 'is_error' in candidate || candidate.type === 'result')) {
          parsed = candidate;
          break;
        }
      } catch { /* stray stdout lines are not result objects */ }
    }
    if (parsed === undefined) {
      const tail = String(stderr).trim().slice(-600);
      const err = new Error(
        `judge-spawn: the juror did not emit parseable JSON on stdout.\n` +
        `stdout[0..600]: ${String(stdout).slice(0, 600)}\n` +
        (tail ? `stderr[-600..]: ${tail}` : 'stderr: <empty>'),
      );
      err.unparseableStdout = true;
      throw err;
    }
  }

  if (parsed?.is_error) {
    // THE BUDGET KILL, CHECKED FIRST — because it is the one case where the CLI's own error text (below) does
    // not explain what happened, and the branch that would otherwise swallow it is the verbatim-passthrough.
    //
    // THE PREDICATE, and why each conjunct is load-bearing:
    //   `is_error`        — we are already inside it; a CONFORMING run also stops for `tool_use` (header
    //                       guarantee 2: `--json-schema` is a FORCED TOOL CALL), so the error flag is the only
    //                       thing separating a budget kill from a successful answer.
    //   `stop_reason`     — `"tool_use"` is how the CLI surfaces a mid-turn budget termination. An `is_error`
    //                       with any other stop reason is a different failure and keeps its existing message
    //                       (the `end_turn` empty-result case below is a real one, reproduced twice).
    //   `budget !== null` — with no ceiling declared there is no ceiling to have been killed by, and the
    //                       message would have to invent a number. Both declared operations run this way.
    //
    // DELIBERATELY NOT PART OF THE PREDICATE: any comparison of `total_cost_usd` against `budget`. The
    // observed kills straddle it — $0.596 against a 0.5 ceiling is over, and a kill recorded at or just under
    // its ceiling is equally possible since the CLI stops the turn rather than the billing. Gating on an
    // inequality that is not guaranteed would silently drop the case back into the unlabelled branch, which is
    // the exact failure this exists to end. The two numbers are REPORTED, not used as the test.
    if (parsed.stop_reason === 'tool_use' && budget !== null) {
      throw new JudgeBudgetError({
        budget,
        costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
        stopReason: parsed.stop_reason,
        result: parsed.result ?? '',
        stderr,
      });
    }
    if (parsed.result) {
      // The CLI's OWN error text, verbatim — never reworded.
      throw new Error(`judge-spawn: the juror failed: ${parsed.result}`);
    }
    // `result` is empty — the CLI gave no error text at all (reproduced twice in one night, cause
    // unknown, resolved both times by a blind retry). A bare "<no result text>" placeholder left the
    // caller nothing to act on, so surface everything else that IS available: the raw parsed object
    // (stop_reason, subtype, session_id, whatever else the CLI emitted) plus the stderr stream the
    // caller passed in — including its `exit code N` fallback when the process produced no stderr.
    const tail = String(stderr).trim().slice(-600);
    throw new Error(
      `judge-spawn: the juror failed with no result text. ` +
      `parsed: ${JSON.stringify(parsed).slice(0, 600)}\n` +
      (tail ? `stderr[-600..]: ${tail}` : 'stderr: <empty>'),
    );
  }

  const value = parsed?.structured_output;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'judge-spawn: the juror returned no `structured_output` object — the enforced shape did not land. ' +
      `stop_reason=${JSON.stringify(parsed?.stop_reason)} result=${JSON.stringify(parsed?.result ?? null).slice(0, 400)}`,
    );
  }

  return {
    value,
    sessionId: parsed.session_id ?? '',
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0,
    numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : 0,
    stopReason: parsed.stop_reason ?? '',
    usage: parsed.usage ?? {},
  };
}

/**
 * Total context the request actually loaded — fresh input plus both cache halves.
 *
 * This is the number the #3028 measurement reports, and it is taken from the CLI's OWN `usage` block
 * rather than estimated. Cache reads COUNT: they are context the model was given, even when they are
 * cheap, and the whole claim under test is about how much context a juror carries.
 *
 * @param {object} usage - a result's `usage` object.
 * @returns {number} tokens.
 */
export function loadedContextTokens(usage = {}) {
  const n = (k) => (typeof usage?.[k] === 'number' ? usage[k] : 0);
  return n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
}

/**
 * THE ONE FUNCTION A `judge` STEP CALLS. Spawns a tool-free juror and returns its validated answer.
 *
 * THIS SATISFIES THE PROVIDER PORT (`JudgeProvider`, named next to `createDefaultJudge` in
 * `we:scripts/operations/cli-adapter.mjs`, #3370). That port is the stable request/outcome shape a second
 * implementation (#3371) must match; this function is ONE implementation of it, not the port itself — its
 * Claude-specific argv (`buildJudgeArgv`) and stdout parsing (`parseJudgeOutcome`) are exactly what a
 * different provider would replace, and nothing here changed to make that true.
 *
 * @param {object} opts
 * @param {string} opts.mandate - the stable juror instruction (system prompt suffix).
 * @param {string} opts.input - the material to judge; written to the juror's stdin.
 * @param {object} opts.shape - JSON Schema the answer is FORCED to satisfy.
 * @param {string} [opts.model] - per-lens model.
 * @param {string} [opts.effort] - per-lens effort.
 * @param {number} [opts.budget] - hard USD ceiling for this juror.
 * @param {string} [opts.runId] - run identity the session id derives from.
 * @param {string} [opts.lens] - lens name, mixed into the session id so a panel's jurors differ.
 * @param {string} [opts.sessionId] - an explicit session id, overriding the derivation.
 * @param {string|null} [opts.cwd] - the juror's lane. REQUIRED when `allowedTools` is set, and deliberately
 *   defaulted to `null` rather than `process.cwd()` — see {@link assertLaneCwd}.
 * @param {object} [opts.env] - environment for the spawn; defaults to the caller's.
 * @param {string} [opts.cli] - the binary to run.
 * @param {number} [opts.timeoutMs] - kill the juror after this long.
 * @param {number} [opts.retries] - retries for unparseable stdout; otherwise resolved from settings.
 * @param {(line: string) => void} [opts.log] - retry diagnostics.
 * @param {Function} [opts.spawnFn] - injectable `child_process.spawn`, for tests.
 * @returns {Promise<{value: object, sessionId: string, costUsd: number, durationMs: number,
 *                    wallMs: number, numTurns: number, stopReason: string, usage: object,
 *                    loadedContextTokens: number, argv: string[], attempts: number, failedAttempts: object[]}>}
 */
export async function judgeSpawn({
  mandate,
  input,
  shape,
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  budget = DEFAULT_BUDGET_USD,
  runId,
  lens,
  sessionId,
  // NO DEFAULT. A tool-bearing juror that inherits its driver's directory is PR #1178's blocking defect;
  // `assertLaneCwd` refuses a null cwd outright. A tool-free juror ignores this entirely, so `process.cwd()`
  // is substituted below only once tools are known to be absent.
  cwd = null,
  env = process.env,
  cli = JUDGE_CLI,
  timeoutMs = JUDGE_TIMEOUT_MS,
  allowedTools = null,
  spawnFn = nodeSpawn,
  retries,
  log = (line) => { try { process.stderr.write(line + '\n'); } catch { /* best effort */ } },
} = {}) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new TypeError('judge-spawn: `input` must be a non-empty string — there is nothing to judge');
  }
  // A run id + lens names the juror DETERMINISTICALLY, so its transcript is findable from the run record
  // and the actor that judged is recorded. With neither supplied there is nothing stable to derive from,
  // so fall back to a one-off seed — still a distinct actor, just not a reproducible name.
  //
  // BOTH FIELDS ARE ALWAYS ENCODED, PRESENT OR NOT (#3058). The predecessor here was
  // `[runId, lens].filter(Boolean).join(' ')`, and the `filter` is what made it wrong: dropping an absent
  // field before the join made a `runId`-only spawn and a `lens`-only spawn carrying the same string derive
  // ONE id. `sessionSeed` encodes an absent field as an absent field, so position is preserved and the two
  // shapes stay distinct. The `filter` survives only as the "is anything nameable at all" test below, where
  // it decides between a stable name and a one-off — it no longer touches the seed's contents.
  const seed = (runId || lens)
    ? sessionSeed([runId, lens])
    : `judge:${Date.now()}:${Math.random()}`;
  const sid = sessionId ?? deriveSessionId(seed);
  assertLaneCwd(cwd, allowedTools);
  // Only reached for a tool-free juror, which cannot write and for which the directory is immaterial.
  const spawnCwd = cwd ?? process.cwd();
  const setting = retries === undefined ? resolveUnparseableRetries({ env }) : { value: retries, source: 'caller' };
  retries = setting.value;
  const total = 1 + retries;
  const failedAttempts = [];
  let wallMs = 0;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    const thisSid = attempt === 1 ? sid : retrySessionId(sid, attempt);
    const argv = buildJudgeArgv({ mandate, shape, model, effort, budget, sessionId: thisSid, allowedTools });

    // Belt-and-braces: the trap can never reach a real process, even if `buildJudgeArgv` is later edited.
    assertNoForbiddenArgv(argv);

    const startedAt = Date.now();
    // THE KILL RESOLVES, IT DOES NOT REJECT (#3203). It used to reject, which threw away every byte the juror had
    // already written — and a tool-bearing juror at the wall has usually done most of the review. Killing and
    // then settling with the accumulated streams turns total loss into a parse attempt: often the answer IS
    // there and only the process failed to exit.
    const { stdout, stderr, code, signal, timedOut } = await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnFn(cli, argv, { cwd: spawnCwd, env: markWorkerEnv(sanitizeSpawnEnv(env)), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new Error(`judge-spawn: could not start \`${cli}\`: ${e.message}`));
        return;
      }
      let out = '';
      let err = '';
      let timer = null;
      let grace = null;
      let killed = false;
      let settled = false;
      // `close` and the grace timer can both fire; whichever is first wins and the other is inert.
      const settle = (r) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        resolve(r);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          killed = true;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          // Settling on `close` rather than here is what preserves the partial output: Node delivers the
          // buffered `data` events first. The grace timer only covers a `close` that never arrives.
          grace = setTimeout(() => settle({ stdout: out, stderr: err, code: null, signal: null, timedOut: true }), JUDGE_TIMEOUT_GRACE_MS);
          if (typeof grace.unref === 'function') grace.unref();
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        reject(new Error(`judge-spawn: \`${cli}\` failed to run: ${e.message}`));
      });
      child.on('close', (c, signal) => settle({ stdout: out, stderr: err, code: c, signal, timedOut: killed }));
      // The judged material rides stdin — see the header on ARG_MAX and the variadic `--tools`.
      child.stdin?.on('error', () => { /* the child may exit before we finish writing; `close` reports it */ });
      child.stdin?.end(input);
    });

    const thisAttemptMs = Date.now() - startedAt;
    wallMs += thisAttemptMs;
    // A KILLED JUROR IS TRIED, NOT DISCARDED. The wall is a bound on runaway, and a juror that emitted its
    // answer and then failed to exit has produced a perfectly good review — the old code threw it away along
    // with the ones that really had nothing. `timedOut` rides out on the result so the run record can say which
    // happened, because "hit the bound" and "crashed" are different facts about a review.
    if (timedOut) {
      let outcome = null;
      try { outcome = parseJudgeOutcome(stdout, stderr, budget); } catch { outcome = null; }
      if (!outcome) throw new JudgeTimeoutError({ timeoutMs, wallMs, stdout, stderr });
      return { ...outcome, wallMs, attempts: attempt, failedAttempts, timedOut: true, loadedContextTokens: loadedContextTokens(outcome.usage), argv };
    }
    // `parseJudgeOutcome` throws with the CLI's own words; a non-zero exit with unparseable stdout lands there too.
    let outcome;
    try {
      outcome = parseJudgeOutcome(stdout, stderr || (code === 0 ? '' : `exit code ${code}`), budget);
    } catch (error) {
      if (error.unparseableStdout !== true) throw error;
      failedAttempts.push({
        attempt, sessionId: thisSid, exitCode: code ?? null, signal: signal ?? null,
        stdoutBytes: stdout.length, stderrTail: stderr.trim().slice(-1000), wallMs: thisAttemptMs,
      });
      if (attempt < total) {
        const snippet = stderrSnippet(stderr);
        const nextSid = retrySessionId(sid, attempt + 1);
        log(`judge-spawn: juror ${lens || '-'} attempt ${attempt}/${total} emitted no parseable JSON (exit ${code ?? 'none'}, signal ${signal ?? 'none'}, stdout ${stdout.length} bytes${snippet ? `, stderr: ${snippet}` : ''}); retrying with a fresh session id ${nextSid} — ${UNPARSEABLE_RETRY_SETTING.key}=${retries} (source: ${setting.source})`);
        continue;
      }
      throw new JudgeUnparseableError({
        attempt, attempts: total, exitCode: code, signal, stdout, stderr, wallMs, sessionId: thisSid, failedAttempts,
      });
    }
    return { ...outcome, wallMs, attempts: attempt, failedAttempts, timedOut: false, loadedContextTokens: loadedContextTokens(outcome.usage), argv };
  }
}
