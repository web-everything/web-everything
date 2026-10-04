#!/usr/bin/env node
/* ==================== FOREGROUND ONLY ====================
 * This script is SYNCHRONOUS: it blocks until the delegated Codex task actually completes.
 * Invoke it as a normal FOREGROUND Bash call. NEVER use run_in_background: true.
 * NEVER wrap it in Monitor or a nested wait — there is nothing to watch;
 * the call itself already returns the final result when it finishes.
 * ========================================================= */
/**
 * codex-direct-task.mjs — a PERSONAL, manually-invoked escape hatch: delegate one real coding task to Codex
 * CLI's agentic (tool-bearing) mode, for a Claude Code operator whose own usage is running low.
 *
 * NOT PART OF THE PRODUCT'S OWN DISPATCH PIPELINE. This is deliberately a different thing from the two other
 * Codex-related builds landing the same night:
 *   - `we:scripts/lib/codex-judge-spawn.mjs` (#xqa9ttq) — Codex as a TOOL-FREE, SCHEMA-CONSTRAINED judge/juror
 *     seated inside the review pipeline. That module's argv/parsing pattern is mirrored here where it applies
 *     (the stdin-trap avoidance, JSONL-is-a-stream discipline, parent-imposed timeout wall), but the MODE is
 *     the opposite: this script runs Codex WITH tools, WITH write access, on an OPEN-ENDED prompt, and expects
 *     real file edits as the result — there is no `--output-schema`, no answer to parse out of the stream.
 *   - the `xu2pp2m` review/fix-dispatch minimal-context design — that work is about STRIPPING an agent's
 *     context down for a machine-owned production wrapper installed on someone else's box. This script has no
 *     such constraint: it runs on the OPERATOR'S OWN machine, for the OPERATOR'S OWN judgment call about
 *     when to reach for it, so `we:AGENTS.md`/`we:CLAUDE.md` loading into the scratch clone Codex works in is
 *     harmless (or even useful) rather than a leak to guard against.
 *
 * THE ONE HARD CONSTRAINT: this NEVER commits and NEVER pushes. It hands back a real `git diff`/`git status`
 * for a human (or the calling Claude Code session) to read and decide what to do with — full stop. See
 * `captureDiff` below; nothing in this file ever calls `git commit`, `git push`, or `git add` with real content
 * staging (only `--intent-to-add`, which stages a PATH with ZERO content, purely so `git diff` can show new
 * files inline — see `captureDiff`'s own comment).
 *
 * REAL FLAGS, CONFIRMED LIVE (not assumed from the judge-role probe, `#3371`, which never exercised agentic
 * mode) — `codex --version` was `codex-cli 0.153.4` when this was written:
 *   - `codex exec --help` lists NO `-a`/`--ask-for-approval` (that flag exists only on the top-level `codex`
 *     interactive command, confirmed by a real `unexpected argument '-a'` error from `codex exec` below).
 *     `exec` mode runs unattended by design; `-s workspace-write` alone was sufficient in a real invocation —
 *     no approval prompt, no hang.
 *   - `-s, --sandbox <read-only|workspace-write|danger-full-access>` — `workspace-write` is what this script
 *     always passes (the whole point is letting Codex edit files in its own cwd).
 *   - `-C, --cd <DIR>` sets the working root exactly like `judge-spawn.mjs`'s Claude path and
 *     `codex-judge-spawn.mjs`'s Codex path.
 *   - `--json` prints an EVENT-STREAM (JSONL, one JSON object per line), not one document — same shape family
 *     as the judge role's `--json`, but CARRYING MORE: in agentic mode the stream includes `command_execution`
 *     items (the literal shell command run, its aggregated output, its exit code) and `file_change` items (the
 *     literal path(s) touched and whether each was an `update`/`add`/`delete`), not just `agent_message` text.
 *     THIS WAS THE KEY UNVERIFIED THING per this item's own brief, and it is now verified: a real
 *     `codex exec --json -s workspace-write` run against a real one-line-comment task in a real scratch git
 *     repo produced exactly this — `item_1`/`item_2` were `command_execution` (an `rg --files` probe, then a
 *     `cat`), `item_3` was a `file_change` naming the edited file, `item_4` was the final `agent_message`. The
 *     event stream is genuinely granular and watchable, not a coarse final-blob-only stream. See this repo's
 *     PR description / delivery record for the raw transcript this header summarizes.
 *   - `-o, --output-last-message <FILE>` — same clean "the final word" seam the judge role uses, kept here for
 *     the human-readable summary this script prints, though (unlike the judge role) the REAL deliverable is
 *     the diff, not this file's text.
 *   - `--skip-git-repo-check` is always passed (harmless when the target IS a git repo — which it always is
 *     here, either an existing lane/checkout the caller named or a scratch clone this script made) so a caller
 *     pointing `--dir` at a non-git directory still gets a clear Codex-side error rather than a silent one.
 *   - `--ephemeral` is intentionally NOT passed by default — unlike a judge run (fire-and-forget, `#3371`'s
 *     `--ephemeral`/`--no-session-persistence`), a direct task may fail partway or need a follow-up, and Codex
 *     supports `codex exec resume <thread-id>`/`codex resume` for exactly that. This script reports the
 *     `thread_id` it observes (from the stream's `thread.started` event) specifically so a human can resume by
 *     hand if a run stops short. Pass `--ephemeral` on this script's own CLI to opt out and forward Codex's
 *     `--ephemeral` when session persistence is not wanted.
 *
 * PURE / IMPURE SPLIT, mirroring `codex-judge-spawn.mjs`'s own discipline: `buildCodexDirectTaskArgv`,
 * `buildCodexPrompt`, `buildScratchCloneArgv`, `planDepsInstall`, and `summarizeEvents`/`parseJsonlEvents` are
 * PURE — no fs, no spawn, no clock. `setupScratchClone`, `captureDiff`, `runGate`, and `codexDirectTask` are
 * impure and take injectable `execFn`/`spawnFn` (mirroring `execFileSync`/`spawn`'s own signatures) so every
 * mechanical decision (clone vs. reuse, `ci` vs. `install`, which git/npm calls run and in what order, how the
 * diff is assembled) is unit-testable without a real git/npm/codex process — while the ONE thing that cannot be
 * mocked into confidence (does the agentic JSON stream actually show tool calls?) was checked with a real,
 * live `codex exec` invocation before this file was written, per
 * `we:docs/agent/prototype-based-dev.md`'s "mocking the spawn is the exact seam every real bug lived in" lesson.
 *
 * USAGE
 *   node scripts/codex-direct-task.mjs --task="Add a README section documenting X" --dir=<existing checkout>
 *   node scripts/codex-direct-task.mjs --task-file=/path/to/prompt.txt                # no --dir → fresh scratch clone of THIS repo
 *   node scripts/codex-direct-task.mjs --task="…" --dir=<dir> --gate=full --json
 *
 * Flags: --task=<text> | --task-file=<path> (one required), --dir=<existing dir> (default: fresh scratch
 * clone), --repo-root=<path> (default: this script's own repo root — where a scratch clone is cloned FROM),
 * --model=<model>, --effort=low|medium|high|xhigh|max|ultra, --timeout-ms=<n> (default 30 min), --gate=none|
 * standards|full (default none), --ephemeral, --no-stream (still logs to file, just not to stdout too),
 * --log=<path> (default: alongside the target dir), --wire-origin-to-remote (#3782 — opt-in; a fresh scratch
 * clone's `origin` otherwise stays at the local repoRoot path, non-push-capable, with the real remote only
 * PRINTED for a human to wire up by hand), --json (machine-readable final report on stdout).
 */

import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { admissionLockRoot } from './readiness/heavy-admission.mjs';

import {
  CODEX_EFFORT_MAP, CODEX_MODEL, CODEX_TIER_EFFORT, assertCodexModel, resolveCodexEffort,
} from './lib/codex-model-routing.mjs';

// ── constants ─────────────────────────────────────────────────────────────────────────────────────
export const CODEX_CLI = 'codex';

/** #4194 — the suffix a `--review` task carries in place of the edit instruction. Codex reads the checkout under its
 *  own `read-only` sandbox; `gemini-direct-task.mjs#REVIEW_MODE_SUFFIX` differs on purpose (agy runs with its shell
 *  and writes denied, so its task carries the PR text itself). */
export const REVIEW_MODE_SUFFIX = 'This is a READ-ONLY review. Do not edit, create or delete any file, do not run '
  + '`git commit`/`git push`/`git add`, do not install dependencies, and do not open a pull request. Read what you '
  + 'need, then put your whole answer in your final message.';
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — an open-ended coding task, not a quick judge call.

/**
 * #x8wbivt (`#3635`)'s ratified routing constants are RE-EXPORTED here, not defined here.
 *
 * They used to be defined in this file, because when #3635 landed this was the only Codex CLI call site on
 * `main` — its own implementation note says exactly that, and flags the other two sites (the judge seat and
 * the delivery provider, both on unmerged branches then) as a follow-up that must import these same names
 * "rather than keeping its own separate `CODEX_EFFORT_MAP` copy". That follow-up is now done: the constants
 * live in `we:scripts/lib/codex-model-routing.mjs`, the one place a re-ratification has to touch.
 *
 * The re-export is deliberate and permanent, not a shim. `CODEX_MODEL`, `CODEX_EFFORT_MAP`,
 * `CODEX_TIER_EFFORT` and `resolveCodexEffort` are part of THIS module's published surface (its tests and
 * `we:skills-src/use-codex/SKILL.md` both name them), so they keep resolving from here unchanged.
 */
export {
  CODEX_EFFORT_MAP,
  CODEX_MODEL,
  CODEX_TIER_EFFORT,
  resolveCodexEffort,
} from './lib/codex-model-routing.mjs';

// ── pure: argv / prompt construction ─────────────────────────────────────────────────────────────

/**
 * The real `codex exec` argv for agentic/workspace-write mode, translated from a REAL `codex exec --help`
 * (see file header) rather than the judge-role probe. PURE — no positional prompt (mirrors
 * `codex-judge-spawn.mjs`'s stdin-trap avoidance): the task rides stdin, closed via `.end()`, which is what
 * actually avoids the deadlock `#3371` probe 0 found, not merely "using stdin at all".
 *
 * @param {object} opts
 * @param {string} opts.cwd - the directory Codex should treat as its working root (an existing checkout, or a
 *   freshly-made scratch clone). REQUIRED.
 * @param {string} [opts.outputLastMessageFile] - if given, Codex writes its final message there too.
 * @param {string} [opts.model] - #x8wbivt: defaults to the ratified `CODEX_MODEL` pin — a caller must pass an
 *   explicit different string to override it; there is no way to omit `-m` entirely any more; omitting the
 *   CLI's own implicit-default resolution was the whole point of the ratification.
 * @param {'low'|'medium'|'high'|'xhigh'|'max'|'ultra'} [opts.effort] - a `CODEX_EFFORT_MAP` key, forwarded
 *   UNCHANGED as `-c model_reasoning_effort=<level>` (the map is an identity — nothing is clamped down to
 *   `high` any more; see `CODEX_EFFORT_MAP`). Throws on any other value. #x8wbivt: defaults to the `sonnet`
 *   rung's `medium` (via `CODEX_TIER_EFFORT`) for the same "never implicit" reason as `model` — resolve a
 *   `tier` through `resolveCodexEffort` before calling this if the caller thinks in rungs rather than raw
 *   levels.
 * @param {boolean} [opts.ephemeral] - forwards Codex's own `--ephemeral` (no session persistence). Default
 *   false — see file header for why this script's default differs from the judge role's.
 * @param {string[]} [opts.addDirs] - forwarded as repeated `--add-dir`, for a task that legitimately needs to
 *   touch more than one directory (rare; most callers leave this empty).
 * @param {string[]} [opts.writableRoots] - edit-only gitdir, admission lock root and private temp root.
 * @param {string} [opts.tempRoot] - edit-only fixture temp directory, pinned in the child shell environment.
 * @returns {string[]} argv AFTER the `codex` binary name.
 */
export function buildCodexDirectTaskArgv({
  cwd,
  outputLastMessageFile,
  model = CODEX_MODEL,
  effort = CODEX_TIER_EFFORT.sonnet,
  ephemeral = false,
  addDirs = [],
  writableRoots = [],
  tempRoot,
  review = false,
} = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new TypeError('codex-direct-task: `cwd` must be a non-empty path');
  }
  // #4194 — REVIEW MODE runs Codex under its own `read-only` sandbox: a review seat reads the checkout and reports
  // findings; it must never edit anything. Every other caller keeps `workspace-write`, unchanged.
  const argv = ['exec', '--json', '-s', review ? 'read-only' : 'workspace-write', '--skip-git-repo-check', '-C', cwd];
  if (outputLastMessageFile) {
    if (typeof outputLastMessageFile !== 'string' || !outputLastMessageFile.trim()) {
      throw new TypeError('codex-direct-task: `outputLastMessageFile` must be a non-empty path when given');
    }
    argv.push('-o', outputLastMessageFile);
  }
  if (ephemeral) argv.push('--ephemeral');
  for (const dir of addDirs) {
    if (typeof dir !== 'string' || !dir.trim()) {
      throw new TypeError('codex-direct-task: every entry in `addDirs` must be a non-empty path');
    }
    argv.push('--add-dir', dir);
  }
  // #3635 Fork 1 — UNCONDITIONAL. This previously read `if (model !== undefined) { … }`, which was already
  // DEAD (the `model = CODEX_MODEL` parameter default means `model` is never `undefined` here, so the branch
  // always ran) — but it read as a guard, and a later edit that dropped the parameter default would have
  // turned a dead branch into the exact silent-inheritance hole `codex-judge-spawn.mjs` actually shipped.
  // Validation now goes through the one shared `assertCodexModel`, so all three call sites agree on what a
  // usable model name is.
  argv.push('-m', assertCodexModel(model, 'codex-direct-task'));
  if (effort !== undefined) {
    const mapped = Object.hasOwn(CODEX_EFFORT_MAP, effort) ? CODEX_EFFORT_MAP[effort] : undefined;
    if (!mapped) {
      throw new TypeError(`codex-direct-task: \`effort\` must be one of ${Object.keys(CODEX_EFFORT_MAP).join('|')}, got ${JSON.stringify(effort)}`);
    }
    argv.push('-c', `model_reasoning_effort=${mapped}`);
  }
  // #4665 — grant only the edit job's bookkeeping/fixture roots, never the whole lane pool.
  // JSON string/array encoding is also valid TOML for these paths; argv is passed without a shell.
  if (!review) {
    if (!Array.isArray(writableRoots) || writableRoots.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new TypeError('codex-direct-task: `writableRoots` must contain non-empty paths');
    }
    argv.push('-c', 'sandbox_workspace_write.network_access=true');
    if (writableRoots.length) argv.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`);
    if (tempRoot) {
      for (const name of ['TMPDIR', 'TMP', 'TEMP']) {
        argv.push('-c', `shell_environment_policy.set.${name}=${JSON.stringify(tempRoot)}`);
      }
    }
  }
  // NO POSITIONAL PROMPT — see file header. Everything rides stdin, closed via `.end()`.
  return argv;
}

/**
 * The task text sent on stdin. Folds in an explicit "do not commit/push" instruction — belt-and-braces
 * alongside `captureDiff`'s own tolerance for a run that commits anyway (see that function's header): telling
 * the agent the deliverable is a diff, not a commit, is cheap and makes the common case match the contract
 * without relying on `captureDiff`'s fallback path.
 * @param {string} task
 * @returns {string}
 */
export function buildCodexPrompt(task, { review = false } = {}) {
  if (typeof task !== 'string' || !task.trim()) {
    throw new TypeError('codex-direct-task: `task` must be a non-empty string');
  }
  // #4194 — a REVIEW task's deliverable is its final message, not a diff: say so, instead of the default
  // "make the change directly" suffix that would contradict a read-only review brief.
  if (review) return `${task.trim()}\n\n---\n\n${REVIEW_MODE_SUFFIX}`;
  return (
    `${task.trim()}\n\n---\n\n`
    + 'Make the change directly by editing files in this working directory. When you are done, STOP — do '
    + 'not run `git commit`, do not run `git push`, and do not open a pull request. A human will review the '
    + 'diff and decide what to do with it.\n\n'
    // heavy-enforce: Codex's own shell calls are not under the Claude Bash guard, so say it in the prompt too.
    + 'Run tests ONLY through the host heavy-run queue: `node scripts/readiness/heavy-admission.mjs run -- npx '
    + 'vitest run <test-file>` (or `npm run test:unit -- <test-file>`, `npm run check:standards`). Never run a '
    + 'bare `npx vitest`, `npm test`, or `node scripts/check-standards.mjs` — they skip the queue and overload the host.'
  );
}

/** `git clone <repoRoot> <dest>` — a LOCAL clone (hardlinked objects, no network), mirroring
 * `we:scripts/lane-pool.mjs#cloneLane`'s object-sharing intent for the common case (repoRoot is a local
 * checkout) without needing `--reference` (that flag exists to share objects with a THIRD repo; cloning
 * directly FROM the local repo root already gets git's automatic hardlink sharing on one filesystem). PURE.
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.dest
 * @returns {string[]} argv after the `git` binary name.
 */
export function buildScratchCloneArgv({ repoRoot, dest }) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    throw new TypeError('codex-direct-task: `repoRoot` must be a non-empty path');
  }
  if (typeof dest !== 'string' || !dest.trim()) {
    throw new TypeError('codex-direct-task: `dest` must be a non-empty path');
  }
  return ['clone', '--quiet', repoRoot, dest];
}

/**
 * Does `dir` need `npm ci`/`npm install`, and which one? Mirrors `we:scripts/lane-pool.mjs#ensureDeps`'s
 * `useCi = existsSync(package-lock.json)` rule (not imported — that function is private to lane-pool.mjs and
 * this script deliberately does not depend on the lane-pool module, since a scratch clone here is a one-shot,
 * unleased directory, not a pool member). PURE over an injected `existsFn` so this is testable without touching
 * a real filesystem.
 * @param {string} dir
 * @param {(path: string) => boolean} existsFn
 * @returns {{bin: string, args: string[]}|null} the command to run, or `null` if there is no `package.json`
 *   at all (nothing to install).
 */
export function planDepsInstall(dir, existsFn) {
  if (!existsFn(join(dir, 'package.json'))) return null;
  const useCi = existsFn(join(dir, 'package-lock.json'));
  return { bin: 'npm', args: [useCi ? 'ci' : 'install'] };
}

/** One parsed JSONL line, or `null` for a blank/unparsable one. Never throws. PURE. */
export function parseJsonlLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

/** Every parsed event from a raw JSONL stdout blob, blank/unparsable lines dropped. PURE. */
export function parseJsonlEvents(stdout) {
  return String(stdout).split('\n').map(parseJsonlLine).filter(Boolean);
}

/**
 * A short, human-readable digest of an agentic run's event stream — counts by type, the literal shell commands
 * run, the literal files touched, the terminal status, and the thread id (for a manual `codex exec resume`).
 * PURE.
 * @param {object[]} events - parsed JSONL events, in order (see `parseJsonlEvents`).
 * @returns {{threadId: string|null, turns: number, commands: string[], filesChanged: {path: string, kind:
 *   string}[], agentMessages: string[], terminal: string|null, usage: object}}
 */
export function summarizeEvents(events) {
  const threadId = events.find((e) => e?.type === 'thread.started')?.thread_id ?? null;
  const turns = events.filter((e) => e?.type === 'turn.started').length;
  const commands = events
    .filter((e) => e?.type === 'item.completed' && e.item?.type === 'command_execution')
    .map((e) => e.item.command);
  const filesChanged = events
    .filter((e) => e?.type === 'item.completed' && e.item?.type === 'file_change')
    .flatMap((e) => (Array.isArray(e.item.changes) ? e.item.changes : []))
    .map((c) => ({ path: c.path, kind: c.kind }));
  const agentMessages = events
    .filter((e) => e?.type === 'item.completed' && e.item?.type === 'agent_message')
    .map((e) => e.item.text);
  let terminal = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn.completed' || events[i]?.type === 'turn.failed') { terminal = events[i].type; break; }
  }
  const usage = [...events].reverse().find((e) => e?.type === 'turn.completed')?.usage ?? {};
  return { threadId, turns, commands, filesChanged, agentMessages, terminal, usage };
}

// ── the ratified quota signal (#x8wbivt Fork 4) ──────────────────────────────────────────────────

/**
 * #x8wbivt — RATIFIED 2026-09-11. `codex exec --json` never carries a USD figure (confirmed, `#3371`), but a
 * real quota-CONSUMPTION signal exists in the PERSISTED session — a rollout file Codex writes to
 * `$CODEX_HOME/sessions/<year>/<month>/<day>/rollout-<timestamp>-<thread-id>.jsonl` (verified live: `codex
 * exec` with no `--ephemeral` reliably wrote one, findable by thread id, on `codex-cli 0.153.4`) — as an
 * `event_msg` of type `token_count` whose `rate_limits` block carries `primary.used_percent`,
 * `primary.window_minutes`, `primary.resets_at`, and `plan_type`. `resolveCodexHome` honours `$CODEX_HOME`
 * (Codex's own env var, confirmed via `codex exec --help`), falling back to `~/.codex`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveCodexHome(env = process.env) {
  return (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()) ? env.CODEX_HOME.trim() : join(homedir(), '.codex');
}

/** Every file path under `dir`, recursing through subdirectories. Injectable `readdirFn` so this needs no
 * real filesystem in a test. Tolerates a missing/unreadable `dir` (returns `[]`) — a fresh `CODEX_HOME` with
 * no `sessions/` directory yet is a real, non-error state, not a bug. */
function walkFiles(dir, readdirFn) {
  let entries;
  try { entries = readdirFn(dir); } catch { return []; }
  let out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    out = entry.isDirectory() ? out.concat(walkFiles(full, readdirFn)) : out.concat([full]);
  }
  return out;
}

/**
 * Locate the rollout file a given `codex exec` run wrote, by its `thread_id` (observed off the stream's
 * `thread.started` event — see `summarizeEvents`). The date-bucketed directory layout is not reconstructed
 * from the run's start time (that would need a clock this function has no reason to take); instead every
 * session file under `<codexHome>/sessions` is walked and matched by its trailing `-<threadId>.jsonl`, which
 * the observed real filename shape (`rollout-<timestamp>-<thread-id>.jsonl`) makes a safe, unambiguous match —
 * a UUID thread id never collides with another run's.
 * @param {object} opts
 * @param {string} opts.codexHome
 * @param {string} opts.threadId
 * @param {(dir: string) => import('node:fs').Dirent[]} [opts.readdirFn]
 * @returns {string|null}
 */
export function findRolloutFile({ codexHome, threadId, readdirFn = (d) => readdirSync(d, { withFileTypes: true }) } = {}) {
  if (typeof codexHome !== 'string' || !codexHome.trim()) return null;
  if (typeof threadId !== 'string' || !threadId.trim()) return null;
  const files = walkFiles(join(codexHome, 'sessions'), readdirFn);
  return files.find((f) => f.endsWith(`-${threadId}.jsonl`)) ?? null;
}

/**
 * The ratified quota fields (`primary.used_percent`/`window_minutes`/`resets_at`, `plan_type`) out of a
 * rollout file's raw JSONL text — the LAST `token_count` event wins (a multi-turn run logs one per turn; the
 * most recent is the current reading, mirroring `summarizeEvents`'/`parseCodexJudgeOutcome`'s own "the
 * terminal/latest event is the one that matters" discipline). Never throws on a malformed/empty file — returns
 * `null`, the same "an honest absence, not a crash" shape `summarizeEvents` uses for an empty stream. PURE.
 * @param {string} jsonlText
 * @returns {{usedPercent: number|null, windowMinutes: number|null, resetsAt: number|null, planType:
 *   string|null, raw: object}|null}
 */
export function parseRolloutQuota(jsonlText) {
  const lines = String(jsonlText).split('\n');
  let last = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj?.type === 'event_msg' && obj.payload?.type === 'token_count' && obj.payload?.rate_limits) {
      last = obj.payload.rate_limits;
    }
  }
  if (!last) return null;
  return {
    usedPercent: last.primary?.used_percent ?? null,
    windowMinutes: last.primary?.window_minutes ?? null,
    resetsAt: last.primary?.resets_at ?? null,
    planType: last.plan_type ?? null,
    raw: last,
  };
}

/**
 * Read-only quota lookup: find the run's rollout file and parse its quota signal, WITHOUT removing anything.
 * This is `codexDirectTask`'s own default — unlike the ephemeral, fire-and-forget judge role
 * (`codex-judge-spawn.mjs`, #xqa9ttq), this script's rollout is deliberately left on disk by default
 * specifically so a human can `codex exec resume <thread-id>` a run that stopped short (see file header);
 * deleting it after every run would silently remove that feature.
 * @param {object} opts
 * @param {string} opts.codexHome
 * @param {string} opts.threadId
 * @param {Function} [opts.readdirFn]
 * @param {(path: string) => string} [opts.readFileFn]
 * @returns {{quota: object|null, rolloutFile: string|null}}
 */
export function readRolloutQuota({ codexHome, threadId, readdirFn, readFileFn = (p) => readFileSync(p, 'utf8') } = {}) {
  const rolloutFile = findRolloutFile({ codexHome, threadId, readdirFn });
  if (!rolloutFile) return { quota: null, rolloutFile: null };
  try {
    return { quota: parseRolloutQuota(readFileFn(rolloutFile)), rolloutFile };
  } catch {
    return { quota: null, rolloutFile };
  }
}

/**
 * #x8wbivt Fork 4's RATIFIED resolution, verbatim: "write the rollout normally, read the one quota record,
 * then explicitly delete the rollout file" — the same net cleanliness `--ephemeral` gives, but the signal
 * gets read first. ALWAYS deletes the rollout file it found, even when the read/parse itself throws (a
 * partially-written or malformed rollout must not be left behind either — belt-and-braces, matching this
 * file's `captureDiff`/`runGate` "report the failure, never let it block cleanup" discipline).
 *
 * NOT called by `codexDirectTask` below by default — see `readRolloutQuota`'s header for why (this script's
 * resume feature). Exists for a caller with no resume use case: the ratified default shape for a fire-and-
 * forget Codex role (mirrors what `codex-judge-spawn.mjs` should do once it drops its hardcoded `--ephemeral`
 * — see #x8wbivt's card). `codexDirectTask` itself exposes this via `clearRolloutAfterRun: true` for an
 * operator who explicitly has no resume need for a given run.
 * @param {object} opts
 * @param {string} opts.codexHome
 * @param {string} opts.threadId
 * @param {Function} [opts.readdirFn]
 * @param {(path: string) => string} [opts.readFileFn]
 * @param {(path: string) => void} [opts.removeFileFn]
 * @returns {{quota: object|null, rolloutFile: string|null, deleted: boolean}}
 */
export function collectAndClearRolloutQuota({
  codexHome,
  threadId,
  readdirFn,
  readFileFn = (p) => readFileSync(p, 'utf8'),
  removeFileFn = (p) => rmSync(p, { force: true }),
} = {}) {
  const rolloutFile = findRolloutFile({ codexHome, threadId, readdirFn });
  if (!rolloutFile) return { quota: null, rolloutFile: null, deleted: false };
  let quota = null;
  try {
    quota = parseRolloutQuota(readFileFn(rolloutFile));
  } catch {
    quota = null; // malformed/unreadable — still delete below, nothing lingers either way.
  } finally {
    try { removeFileFn(rolloutFile); } catch { /* best-effort cleanup — nothing further to do if this fails too */ }
  }
  return { quota, rolloutFile, deleted: true };
}

// ── impure: scratch clone, diff capture, gate ────────────────────────────────────────────────────

/** `execFileSync`-shaped default with room for large diffs and git/npm/gate output. */
export const defaultExecFn = (bin, args, opts = {}) =>
  execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024, ...opts });

/**
 * Make a fresh, isolated scratch clone of `repoRoot` and install its deps — the default target when the
 * caller names no existing directory. Injectable `execFn`/`mkTempDir`/`existsFn` for testing without a real
 * git/npm process.
 *
 * #3782 — RATIFIED 2026-09-22 (this item's own resolution). This used to unconditionally rewrite the clone's
 * `origin` from the local `repoRoot` path to the REAL push remote ("so a human who likes the diff can push
 * straight from the scratch clone if they choose to"), while `buildCodexPrompt` told Codex — in prose alone —
 * never to commit or push. Codex runs here with `-s workspace-write` and a real shell; nothing enforced that
 * sentence. #3690 Fork 1 rules that authority over what a delegated agent may DO belongs to the typed-operation
 * catalog, never to a transport's prompt text — this rewrite was exactly that gap: it handed the clone a
 * push-capable origin by default. A live probe on this operator's own machine (see the PR this landed in)
 * found ambient SSH-agent credentials that WOULD authenticate a push through that rewritten origin — the risk
 * was real, not theoretical.
 *
 * The fix is least-privilege by default: leave `origin` at the local `repoRoot` path (clone's default) and
 * resolve+return the real remote URL as `realOrigin` for the caller to print, rather than wiring it into the
 * clone's git config. A human who wants the convenience the old comment described can still get it — either
 * by running `git -C <dest> remote set-url origin <realOrigin>` themselves after reading the printed report,
 * or by passing `wireOriginToRemote: true` here (CLI: `--wire-origin-to-remote`) to opt back into the old
 * behavior explicitly. Nothing about `--dir` (an existing checkout a caller names directly) changes — that
 * checkout's own `origin` was never touched by this function and still is not.
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {(prefix: string) => string} [opts.mkTempDir]
 * @param {Function} [opts.execFn]
 * @param {(path: string) => boolean} [opts.existsFn]
 * @param {boolean} [opts.installDeps] - default true; a caller in a hurry for a task that touches no code
 *   dependent on `node_modules` may pass false.
 * @param {boolean} [opts.wireOriginToRemote] - default false (#3782). When true, opts back into the pre-#3782
 *   behavior: rewrite the clone's `origin` to the real remote so a human can push straight from it. Best-effort
 *   either way — an offline/no-remote `repoRoot` (e.g. a test fixture) just leaves `realOrigin` null.
 * @returns {{dest: string, cloned: true, depsInstall: {bin: string, args: string[]}|null, realOrigin:
 *   string|null, originWired: boolean}}
 */
export function setupScratchClone({
  repoRoot,
  mkTempDir = (prefix) => mkdtempSync(prefix),
  execFn = defaultExecFn,
  existsFn = existsSync,
  installDeps = true,
  wireOriginToRemote = false,
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    throw new TypeError('codex-direct-task: `repoRoot` must be a non-empty path');
  }
  const dest = mkTempDir(join(tmpdir(), 'we-codex-direct-'));
  execFn('git', buildScratchCloneArgv({ repoRoot, dest }));
  // Resolve the real push remote so it can be REPORTED — never silently wired in by default (#3782). Best-
  // effort: an offline/no-remote repoRoot (e.g. a test fixture) just leaves `realOrigin` null; `origin` in the
  // clone stays at the local `repoRoot` path (git clone's own default), which is not push-capable to anywhere
  // that matters.
  let realOrigin = null;
  try {
    const url = execFn('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']).trim();
    if (url) realOrigin = url;
  } catch { /* no origin on repoRoot, or remote command unavailable */ }
  let originWired = false;
  if (wireOriginToRemote && realOrigin) {
    try {
      execFn('git', ['-C', dest, 'remote', 'set-url', 'origin', realOrigin]);
      originWired = true;
    } catch { /* set-url failed — clone still works with the local-path origin */ }
  }

  const depsInstall = installDeps ? planDepsInstall(dest, existsFn) : null;
  if (depsInstall) execFn(depsInstall.bin, depsInstall.args, { cwd: dest, stdio: 'inherit' });
  return { dest, cloned: true, depsInstall, realOrigin, originWired };
}

/**
 * The real diff/status in `dir`, captured relative to `startSha` — NOT relative to the working tree's index,
 * because Codex ran with a real shell and COULD run `git commit` on its own despite the prompt's instruction
 * not to (see `buildCodexPrompt`). `git diff <startSha>` compares a fixed starting point to the CURRENT
 * working tree regardless of how many commits landed in between, so the reported diff is correct either way —
 * and `commits` below tells the caller plainly if that happened, because it changes what "review this diff"
 * means for them (there is now a commit boundary inside it they may want to `git reset --soft` before using
 * it). This function NEVER commits, stages real content, or pushes — the one `git add` it runs is
 * `--intent-to-add`, which stages a PATH with ZERO byte content, purely so a brand-new untracked file shows up
 * INSIDE `git diff`'s output instead of being invisible to it (untracked files never appear in `git diff`,
 * intent-to-add or not, except as the empty-old-side entries this trick produces).
 * @param {object} opts
 * @param {string} opts.dir
 * @param {string} opts.startSha
 * @param {Function} [opts.execFn]
 * @returns {{status: string, diff: string, diffStat: string, commits: string[], hasChanges: boolean}}
 */
export function captureDiff({ dir, startSha, execFn = defaultExecFn }) {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('codex-direct-task: `dir` must be a non-empty path');
  if (typeof startSha !== 'string' || !startSha.trim()) throw new TypeError('codex-direct-task: `startSha` must be a non-empty sha');

  const status = execFn('git', ['-C', dir, 'status', '--porcelain', '-z']);
  const untracked = status.split('\0').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3));
  if (untracked.length) {
    try { execFn('git', ['-C', dir, 'add', '--intent-to-add', '--', ...untracked]); } catch { /* best-effort */ }
  }
  const diff = execFn('git', ['-C', dir, 'diff', startSha]);
  const diffStat = execFn('git', ['-C', dir, 'diff', '--stat', startSha]);
  const commitsRaw = execFn('git', ['-C', dir, 'log', '--oneline', `${startSha}..HEAD`]);
  const commits = commitsRaw.split('\n').map((l) => l.trim()).filter(Boolean);
  return { status: status.split('\0').filter(Boolean).join('\n'), diff, diffStat, commits, hasChanges: diff.trim().length > 0 || commits.length > 0 };
}

/**
 * Optionally run this repo's own gate on the result — NEVER commits. `mode`:
 *   - `'none'` (default): does nothing.
 *   - `'standards'`: `npm run check:standards` only — fast, catches convention breaks.
 *   - `'full'`: `check:standards` + `npm run test:unit` (the WHOLE suite — this script does not attempt to
 *     compute which tests are "relevant to what changed"; that scoping is a real gap, called out in this
 *     script's own `--help` text and in the landing report rather than silently claimed).
 * @param {object} opts
 * @param {string} opts.dir
 * @param {'none'|'standards'|'full'} opts.mode
 * @param {Function} [opts.execFn]
 * @returns {{ran: boolean, mode: string, steps: {cmd: string, pass: boolean, output: string}[], pass: boolean}}
 */
export function runGate({ dir, mode, execFn = defaultExecFn }) {
  if (mode === 'none' || !mode) return { ran: false, mode: 'none', steps: [], pass: true };
  const plan = mode === 'full'
    // xaipsbs — both are the package scripts, which run through the host admission pool.
    ? [['npm', ['run', 'check:standards']], ['npm', ['run', 'test:unit']]]
    : [['npm', ['run', 'check:standards']]];
  const steps = [];
  for (const [bin, args] of plan) {
    let output = '';
    let pass = true;
    try {
      output = execFn(bin, args, { cwd: dir });
    } catch (e) {
      pass = false;
      output = `${e.stdout ?? ''}${e.stderr ?? e.message ?? ''}`;
    }
    steps.push({ cmd: `${bin} ${args.join(' ')}`, pass, output });
  }
  return { ran: true, mode, steps, pass: steps.every((s) => s.pass) };
}

// ── impure: the real codex exec spawn, streaming JSONL to a log file + (optionally) stdout ─────────

/**
 * Spawn `codex exec` in agentic/workspace-write mode against `dir`, streaming its JSONL event stream to
 * `logFile` (always) and to `process.stdout` (unless `stream: false`) as it arrives — poll-able via
 * `tail -f <logFile>` from another terminal, not just a final blob. A PARENT-IMPOSED timeout wall (Codex has
 * no CLI timeout flag, confirmed by `#3371` probe 6 for the judge role and unchanged here) SIGKILLs the child
 * and resolves (not rejects) with whatever partial JSONL was captured — a killed run's lines are each still
 * individually parseable (`#3371` probe 6).
 * @param {object} opts
 * @param {string} opts.dir
 * @param {string} opts.task
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {boolean} [opts.ephemeral]
 * @param {number} [opts.timeoutMs]
 * @param {string} opts.logFile
 * @param {boolean} [opts.stream]
 * @param {Function} [opts.spawnFn]
 * @param {string} [opts.cli]
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, timedOut: boolean, argv: string[]}>}
 */
export async function runCodexDirectExec({
  dir,
  task,
  model,
  effort,
  ephemeral = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logFile,
  stream = true,
  spawnFn = nodeSpawn,
  cli = CODEX_CLI,
  gitDir = join(dir, '.git'),
  writableRoots = [],
  tempRoot,
  env = process.env,
  review = false,
} = {}) {
  // Inside `.git/` — NEVER inside the working tree. A real live run against this very script found the bug
  // this avoids: a last-message/log file written into `dir` shows up as an untracked `??` file and pollutes
  // `captureDiff`'s output with the SCRIPT's own bookkeeping instead of only the task's real changes. Mirrors
  // `we:scripts/lane-pool.mjs`'s own `DEPS_MARKER`/`LEASE_MARKER` convention — inside `.git/` is "never
  // tracked or git-cleaned... never seen by `git status --porcelain`" for exactly this reason.
  const outputLastMessageFile = join(gitDir, 'codex-direct-task-last-message.txt');
  const argv = buildCodexDirectTaskArgv({ cwd: dir, outputLastMessageFile, model, effort, ephemeral, review, writableRoots, tempRoot });
  const prompt = buildCodexPrompt(task, { review });
  writeFileSync(logFile, ''); // truncate/create — this run owns the file from byte 0.

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnFn(cli, argv, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
        env: !review && tempRoot ? { ...env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot } : env });
    } catch (e) {
      reject(new Error(`codex-direct-task: could not start \`${cli}\`: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    let timer = null;
    let killed = false;
    let settled = false;
    const removeSignalListeners = () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
    const onSignal = (signal) => {
      try {
        if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone, or process-group kill is unavailable */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      removeSignalListeners();
      process.kill(process.pid, signal);
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    const settle = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeSignalListeners();
      resolvePromise(r);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        try {
          if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone, or process-group kill is unavailable */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const stdoutDecoder = new TextDecoder();
    const recordStdout = (text) => {
      if (!text) return;
      out += text;
      appendFileSync(logFile, text);
      if (stream) process.stdout.write(text);
    };
    child.stdout?.on('data', (d) => recordStdout(stdoutDecoder.decode(d, { stream: true })));
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      removeSignalListeners();
      reject(new Error(`codex-direct-task: \`${cli}\` failed to run: ${e.message}`));
    });
    child.on('close', (code) => {
      recordStdout(stdoutDecoder.decode());
      settle({ stdout: out, stderr: err, code, timedOut: killed, argv, outputLastMessageFile });
    });
    // NO POSITIONAL PROMPT — the task rides stdin, and `.end()` closes it (the stdin-trap avoidance).
    child.stdin?.on('error', () => { /* the child may exit before we finish writing; `close` reports it */ });
    child.stdin?.end(prompt);
  });
}

// ── the orchestrator ──────────────────────────────────────────────────────────────────────────────

/**
 * THE ENTRY POINT a caller (a CLI invocation, or another script) uses. Resolves the target directory
 * (caller-named, or a fresh scratch clone), runs `codex exec`, captures the diff, optionally gates, and
 * returns a full report. NEVER commits, NEVER pushes.
 * @param {object} opts
 * @param {string} opts.task
 * @param {string} [opts.dir] - an existing checkout/lane to work in. Omit to get a fresh scratch clone.
 * @param {string} [opts.repoRoot] - where to clone FROM when `dir` is omitted. Required in that case.
 * @param {string} [opts.model] - #x8wbivt: defaults to `CODEX_MODEL` (via `buildCodexDirectTaskArgv`'s own
 *   default) when omitted — never left to the CLI's own implicit resolution.
 * @param {string} [opts.effort] - explicit effort wins over `tier` — see `resolveCodexEffort`.
 * @param {'haiku'|'sonnet'|'opus'} [opts.tier] - #x8wbivt: the ratified rung vocabulary. Resolved to a real
 *   `model_reasoning_effort` value via `resolveCodexEffort`; ignored when `effort` is also given.
 * @param {boolean} [opts.ephemeral]
 * @param {number} [opts.timeoutMs]
 * @param {'none'|'standards'|'full'} [opts.gate]
 * @param {string} [opts.logFile]
 * @param {boolean} [opts.stream]
 * @param {boolean} [opts.installDeps]
 * @param {boolean} [opts.wireOriginToRemote] - #3782: default false — forwarded to `setupScratchClone`. Only
 *   meaningful when `dir` is omitted (a scratch clone is actually made); ignored for a caller-named `--dir`.
 * @param {boolean} [opts.clearRolloutAfterRun] - #x8wbivt Fork 4: when true, use the ratified read-then-delete
 *   shape (`collectAndClearRolloutQuota`) instead of the default read-only lookup — only worth setting for a
 *   caller with no `codex exec resume` use case for this particular run (see `readRolloutQuota`'s header).
 *   Default false: this script's whole point is resumability.
 * @param {NodeJS.ProcessEnv} [opts.env] - for `resolveCodexHome`. Default `process.env`.
 * @param {Function} [opts.execFn]
 * @param {Function} [opts.spawnFn]
 * @param {(prefix: string) => string} [opts.mkTempDir]
 * @param {(path: string) => boolean} [opts.existsFn]
 * @param {Function} [opts.readQuotaFn] - injectable, default `readRolloutQuota`.
 * @param {Function} [opts.collectQuotaFn] - injectable, default `collectAndClearRolloutQuota`.
 * @returns {Promise<object>} the full report — see the CLI's `--json` output for its exact shape.
 */
export async function codexDirectTask({
  task,
  dir,
  repoRoot,
  model,
  effort,
  tier,
  ephemeral = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  gate = 'none',
  logFile,
  stream = true,
  installDeps = true,
  wireOriginToRemote = false,
  clearRolloutAfterRun = false,
  review = false,
  env = process.env,
  execFn = defaultExecFn,
  spawnFn = nodeSpawn,
  mkTempDir = (prefix) => mkdtempSync(prefix),
  existsFn = existsSync,
  readQuotaFn = readRolloutQuota,
  collectQuotaFn = collectAndClearRolloutQuota,
} = {}) {
  if (typeof task !== 'string' || !task.trim()) {
    throw new TypeError('codex-direct-task: `task` must be a non-empty string');
  }

  let targetDir = dir;
  let scratch = null;
  if (!targetDir) {
    if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
      throw new TypeError('codex-direct-task: `dir` was omitted, so `repoRoot` is required to make a scratch clone from');
    }
    scratch = setupScratchClone({
      repoRoot, mkTempDir, execFn, existsFn, installDeps, wireOriginToRemote,
    });
    targetDir = scratch.dest;
  } else if (!existsFn(targetDir)) {
    throw new Error(`codex-direct-task: --dir=${targetDir} does not exist`);
  }

  const startSha = execFn('git', ['-C', targetDir, 'rev-parse', 'HEAD']).trim();
  // Same `.git/`-hiding reasoning as `outputLastMessageFile` above — the default log file must never leak
  // into `captureDiff`'s output. A caller-supplied `--log=<path>` is trusted as-is (their choice, their risk).
  const gitDir = execFn('git', ['-C', targetDir, 'rev-parse', '--absolute-git-dir']).trim();
  const resolvedLogFile = logFile || join(gitDir, 'codex-direct-task.jsonl');
  mkdirSync(dirname(resolvedLogFile), { recursive: true });

  // #x8wbivt: resolve the effort rung ONCE, here — the same explicit value then flows into both the real
  // argv (`runCodexDirectExec` → `buildCodexDirectTaskArgv`) and, implicitly, the model pin (which
  // `buildCodexDirectTaskArgv` defaults on its own when `model` is omitted).
  const resolvedEffort = resolveCodexEffort({ tier, effort });

  // A private temp root isolates concurrent fixture repositories. Keep it for manual resume/debugging,
  // just like the persisted Codex session and log; review mode allocates no new writable roots.
  const tempRoot = review ? undefined : mkdtempSync(join(tmpdir(), 'we-codex-task-tmp-'));
  const writableRoots = review ? [] : [gitDir, resolve(admissionLockRoot(resolve(targetDir), env)), tempRoot];
  const run = await runCodexDirectExec({
    dir: targetDir, task, model, effort: resolvedEffort, ephemeral, timeoutMs, logFile: resolvedLogFile, stream, spawnFn, review,
    gitDir, writableRoots, tempRoot, env,
  });
  const events = parseJsonlEvents(run.stdout);
  const summary = summarizeEvents(events);
  let lastMessage = null;
  try { lastMessage = readFileSync(run.outputLastMessageFile, 'utf8'); } catch { lastMessage = null; }

  const diff = captureDiff({ dir: targetDir, startSha, execFn });
  const gateResult = runGate({ dir: targetDir, mode: gate, execFn });

  // #x8wbivt Fork 4: surface the quota signal for any run that actually persisted a rollout (an `--ephemeral`
  // run writes none — nothing to read). Default is read-ONLY (`readQuotaFn`/`readRolloutQuota`) to preserve
  // this script's resume feature; `clearRolloutAfterRun` opts into the ratified read-then-delete shape.
  let quota = null;
  let quotaRolloutFile = null;
  let quotaRolloutCleared = false;
  if (!ephemeral && summary.threadId) {
    const codexHome = resolveCodexHome(env);
    const lookup = clearRolloutAfterRun
      ? collectQuotaFn({ codexHome, threadId: summary.threadId })
      : readQuotaFn({ codexHome, threadId: summary.threadId });
    quota = lookup.quota;
    quotaRolloutFile = lookup.rolloutFile;
    quotaRolloutCleared = Boolean(lookup.deleted);
  }

  return {
    model, effort: resolvedEffort,
    dir: targetDir,
    scratch: scratch ? {
      created: true,
      source: repoRoot,
      depsInstall: scratch.depsInstall,
      // #3782: `origin` inside the scratch clone stays at the local `repoRoot` path by default (NOT
      // push-capable to anywhere that matters) — `realOrigin` is only ever REPORTED, never silently wired in,
      // unless the caller explicitly opted in via `wireOriginToRemote`/`--wire-origin-to-remote`.
      realOrigin: scratch.realOrigin,
      originWired: scratch.originWired,
    } : { created: false },
    startSha,
    argv: run.argv,
    logFile: resolvedLogFile,
    exitCode: run.code,
    timedOut: run.timedOut,
    events: summary,
    lastMessage,
    diff,
    gate: gateResult,
    // #x8wbivt Fork 4 — the ratified budget signal, mirroring `judge-spawn.mjs`/`judge-panel.mjs`'s
    // `costUsd`/timing reporting shape on the Claude side (no USD figure exists here; this is the real
    // consumption analogue Codex actually offers).
    quotaUsedPercent: quota?.usedPercent ?? null,
    quotaWindowMinutes: quota?.windowMinutes ?? null,
    quotaResetsAt: quota?.resetsAt ?? null,
    quotaPlanType: quota?.planType ?? null,
    quotaRolloutFile,
    quotaRolloutCleared,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

function repoRootFromCwd() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(
      'usage: node scripts/codex-direct-task.mjs --task=<text>|--task-file=<path> [--dir=<checkout>] '
      + '[--repo-root=<path>] [--model=<m>] [--effort=low|medium|high|xhigh|max|ultra] [--tier=haiku|sonnet|opus] '
      + '[--timeout-ms=<n>] [--gate=none|standards|full] [--ephemeral] [--clear-rollout-after-run] '
      + '[--no-stream] [--log=<path>] [--no-install] [--wire-origin-to-remote] [--review] [--json]\n'
      + '  --review (#4194): a READ-ONLY review task — Codex runs under `-s read-only` and is told to answer in its '
      + 'final message (the report\'s `lastMessage`) instead of editing files.\n'
      + '  --model defaults to the ratified CODEX_MODEL pin (#x8wbivt); --effort/--tier default to the '
      + "sonnet rung's `medium` — neither is ever left to codex's own implicit default. --tier is ignored "
      + 'when --effort is also given.\n'
      + "  --wire-origin-to-remote (#3782): a fresh scratch clone's `origin` stays at the local repoRoot path "
      + 'by default (not push-capable) — the real remote is only printed. Pass this to opt back into rewriting '
      + "origin to the real remote so a human can push straight from the clone. No effect with --dir.",
    );
    return;
  }
  const task = flags['task-file'] ? readFileSync(resolve(flags['task-file']), 'utf8') : flags.task;
  if (!task || typeof task !== 'string' || !task.trim()) {
    console.error('codex-direct-task: pass --task=<text> or --task-file=<path>');
    process.exitCode = 2;
    return;
  }
  const dir = flags.dir ? resolve(flags.dir) : undefined;
  const repoRoot = flags['repo-root'] ? resolve(flags['repo-root']) : (dir ? undefined : repoRootFromCwd());
  const timeoutMs = flags['timeout-ms'] ? Number(flags['timeout-ms']) : DEFAULT_TIMEOUT_MS;

  let report;
  try {
    report = await codexDirectTask({
      task,
      dir,
      repoRoot,
      model: flags.model,
      effort: flags.effort,
      tier: flags.tier,
      ephemeral: Boolean(flags.ephemeral),
      timeoutMs,
      gate: flags.gate || 'none',
      logFile: flags.log ? resolve(flags.log) : undefined,
      stream: !flags['no-stream'],
      installDeps: !flags['no-install'],
      wireOriginToRemote: Boolean(flags['wire-origin-to-remote']),
      clearRolloutAfterRun: Boolean(flags['clear-rollout-after-run']),
      review: Boolean(flags.review),
    });
  } catch (e) {
    console.error(`codex-direct-task: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n──────────────────────────────────────────────────────────');
    console.log(`codex-direct-task: ${report.scratch.created ? 'scratch clone' : 'target dir'} → ${report.dir}`);
    if (report.scratch.created && report.scratch.realOrigin) {
      console.log(report.scratch.originWired
        ? `  origin wired to the real remote (--wire-origin-to-remote): ${report.scratch.realOrigin}`
        : `  origin left at the local clone source (#3782, not push-capable). Real remote: ${report.scratch.realOrigin}\n`
          + `    to push from here yourself: git -C ${report.dir} remote set-url origin ${report.scratch.realOrigin}`);
    }
    console.log(`  thread: ${report.events.threadId ?? '<none>'}  turns: ${report.events.turns}  terminal: ${report.events.terminal ?? '<none — timed out or killed>'}  timedOut: ${report.timedOut}  exit: ${report.exitCode}`);
    console.log(`  tool calls: ${report.events.commands.length}  files touched: ${report.events.filesChanged.length}`);
    for (const f of report.events.filesChanged) console.log(`    - ${f.kind} ${f.path}`);
    console.log(`  log: ${report.logFile}`);
    if (report.quotaUsedPercent !== null) {
      console.log(`  quota: ${report.quotaUsedPercent}% used of a ${report.quotaWindowMinutes}min window (plan: ${report.quotaPlanType})${report.quotaRolloutCleared ? ' — rollout file cleared after read' : ''}`);
    }
    if (report.diff.commits.length) {
      console.log(`  ⚠ codex made ${report.diff.commits.length} commit(s) despite being told not to — review before using this diff:`);
      for (const c of report.diff.commits) console.log(`    ${c}`);
    }
    console.log(report.diff.hasChanges ? `\n${report.diff.diffStat}` : '\n  (no changes)');
    if (report.gate.ran) {
      console.log(`\n  gate (${report.gate.mode}): ${report.gate.pass ? 'PASS' : 'FAIL'}`);
      for (const s of report.gate.steps) console.log(`    ${s.pass ? '✓' : '✗'} ${s.cmd}`);
    }
    console.log('\n  NOTHING WAS COMMITTED OR PUSHED. Review the diff above (or `cd` into the dir and run `git diff`), then commit/land it yourself if you want it.');
    console.log('──────────────────────────────────────────────────────────\n');
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
