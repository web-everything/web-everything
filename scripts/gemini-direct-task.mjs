#!/usr/bin/env node
/* ==================== FOREGROUND ONLY ====================
 * This script is SYNCHRONOUS: it blocks until the delegated task actually completes.
 * Invoke it as a normal FOREGROUND Bash call. NEVER use run_in_background: true.
 * NEVER wrap it in Monitor or a nested wait — there is nothing to watch;
 * the call itself already returns the final result when it finishes.
 * ========================================================= */
/**
 * gemini-direct-task.mjs — a PERSONAL, manually invoked escape hatch: delegate ONE open-ended coding
 * task to Google's Antigravity CLI (`agy`), then hand a real diff to an operator for review.
 * This is not a schema-constrained judge, and is not part of the product dispatch pipeline.
 *
 * THE ONE HARD CONSTRAINT: this script NEVER runs git commit, git push, content-staging git add, or
 * opens a PR. Only content-free git add --intent-to-add is used to show untracked files in the diff.
 * The prompt also forbids these actions; the agent has shell access and could disobey. captureDiff
 * compares against the recorded start SHA and reports intervening commits even in that case.
 *
 * NO REAL WRITE/READ CONFINEMENT EXISTS. `--add-dir` is bookkeeping only, not a sandbox. `--sandbox`
 * confines the shell only; agy's own in-process native file tools BYPASS it and can read/write outside
 * the target directory. A run with --sandbox is NOT isolated. See backlog/#3633 probes 12–13:
 * backlog/3633-probe-antigravity-cli-against-the-judge-contract.md.
 * “Scoped” means launch cwd + prompt instructions + diff capture in that directory, nothing stronger.
 * The default fresh scratch clone is the only real mitigation supplied here: ordinary edits and nearby
 * wandering are kept away from the primary checkout. It is NOT a guarantee against touching the primary
 * repo by absolute path, the operator's home directory, or anything else on the machine. Existing --dir
 * is an explicit operator choice. A target git diff cannot establish that nothing outside it was touched.
 *
 * REAL FLAGS / EVIDENCE: backlog #3633 probed agy 1.2.1/1.2.2 in a judge role; the operator supplied
 * fresh successful agy 1.2.2 stdin and file-write streams for this task. These are supplied observations,
 * not probes repeated by this implementation. #3632 tested a DIFFERENT, retired standalone Gemini CLI;
 * its verdict and flags do not apply. This implementation uses only agy's observed flag surface:
 * --input-format, --output-format, --disable-slash-commands, --dangerously-skip-permissions (not with --review), --add-dir,
 * --model, --effort, --sandbox, --print-timeout, --print. Local `agy --help` also confirms --continue
 * (most recent conversation) and --conversation (resume by ID); retries use the latter unambiguously.
 * There is NO -C; Node spawn's cwd sets launch cwd.
 * The tool shell's own cwd is UNRELIABLE (#3633 probe 20); the prompt names the absolute target and
 * requires absolute paths, including explicit command working directories, rather than trusting pwd.
 *
 * MODEL FAMILIES: --model/--effort are generic passthroughs, not Gemini-specific (effort vocabulary:
 * low|medium|high). A live `agy models` listing carries multiple real families under one CLI: the default
 * Gemini Pro tier (gemini-3.1-pro-high/low), a fast/cheap Gemini Flash tier for simple, low-judgment tasks
 * (gemini-3.8-flash-high/medium/low, and the 3.7/3.6 predecessor generations), and two Claude backends
 * (claude-sonnet-4-6, claude-opus-4-6-thinking) — this same escape hatch can route Claude through
 * Antigravity's separate quota, distinct from a Claude Code operator's own usage. This is not a validated
 * model/effort recommendation for any of these families; `agy models` is the source of truth, not this file.
 *
 * STDIN: text-mode --print requires a NON-EMPTY VALUE; resume supplies a short continuation instruction
 * via --print without replaying the original task text. '-' is literal text, not a stdin sentinel. The ONLY
 * prompt-on-stdin route is --input-format stream-json --output-format stream-json with --print ''
 * (the explicit empty value is required), plus one JSON-stringified user/message/content event and LF.
 * stdin is then closed. No positional prompt, no argv-size exposure, no inherited stdin-trap pattern.
 * --disable-slash-commands is mandatory: leading '/' text otherwise gets intercepted before the model.
 * --dangerously-skip-permissions is mandatory for useful unattended editing: headless tool auto-denial
 * otherwise returns SUCCESS / exit 0 / empty response (#3633 probes 7 and 19). The one exception is --review
 * (#4194), which omits it ON PURPOSE so shell, writes and reads outside --dir are denied (REVIEW_MODE_SUFFIX).
 *
 * Events carry `event`, not Codex's `type`. Completed step_update tools carry tool_name/tool_info;
 * only the last result carries terminal status, final response/error and inline token usage. No result
 * means terminal:null, including killed runs. No USD figure exists; quota failures are reported through terminal errors/stderr.
 * No model/effort recommendation has been validated for THIS open-ended coding-task role. Unlike Codex's
 * ratified #x8wbivt pin, there is no default pin or invented tier ladder: model/effort are optional
 * passthroughs. agy validates model/effort combinations itself; judge-role results do not validate this role.
 *
 * PURE / IMPURE SPLIT: argv/prompt/stdin builders, clone argv, dependency planning over existsFn,
 * JSONL parsing and summarization have no fs/spawn/clock. Clone/diff/gate helpers take execFn,
 * mkTempDir/existsFn; runAgyDirectExec takes spawnFn. Tests replay the supplied literal event shapes,
 * never launch a real agy/git/npm process. This is a self-contained sibling of codex-direct-task.mjs.
 * The parent SIGKILL wall is the real ceiling (30 min default); --print-timeout is a secondary hint
 * because it does not cover the interactive OAuth hang (#3633 probe 17). geminiDirectTask resumes ONCE
 * after a timeout or a nonzero/null exit without a terminal result, only with an init conversation ID.
 * Each attempt gets the full timeout budget (up to two parent walls); resume sends a short continuation
 * instruction via --print, without replaying the original task text.
 * Logs default inside .git so bookkeeping does not pollute the working-tree diff. Scratch clones are
 * local clones of committed HEAD, not copies of uncommitted changes. Gates are none/standards/full;
 * full runs check:standards + the WHOLE Vitest suite, without changed-test selection.
 *
 * USAGE
 *   node scripts/gemini-direct-task.mjs --task="Document X" --repo-root=/absolute/repo
 *   node scripts/gemini-direct-task.mjs --model=claude-sonnet-4-6 --task="..." --repo-root=<repo>
 *   node scripts/gemini-direct-task.mjs --model=gemini-3.8-flash-high --task="..." --repo-root=<repo>
 *   node scripts/gemini-direct-task.mjs --task-file=/path/task.txt --dir=/existing/checkout --gate=full
 *   node scripts/gemini-direct-task.mjs --help
 */

import { startBuilderLease } from './lib/builder-slot-lease.mjs';
import { pickAgyEvidence, agyRunEvidence, readAgyHold, saveAgyHold } from './lib/antigravity-run-evidence.mjs';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGY_CLI = 'agy';
export const AGY_RESUME_PROMPT = 'Continue the task from where you left off and finish it. Do not restart from scratch or repeat already-completed work.';
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Model/effort compatibility otherwise remains agy's responsibility (see MODEL FAMILIES above).
 * The supplied shared run-quality scorecard evidence reports 83/83 agy-claude review-seat calls on
 * 2026-09-29 rejected --effort for claude-sonnet-4-6 with "invalid model selection (...): --effort is
 * not supported for model \"claude-sonnet-4-6\"". claude-opus-4-6-thinking is included by inference
 * from agy's other named Claude backend, not an independent live confirmation; revisit if a future
 * live trial contradicts it. Every other model id, known or future, still forwards effort to agy.
 */
export const AGY_EFFORT_UNSUPPORTED_MODELS = Object.freeze(['claude-sonnet-4-6', 'claude-opus-4-6-thinking']);

/** #4194 — the suffix a `--review` task carries in place of the edit instruction. agy has NO read-only mode (see
 *  the header: `--sandbox` confines only its shell, never its native file tools), and a review task carries
 *  UNTRUSTED PR text that may try to steer the agent. So a review run omits `--dangerously-skip-permissions`, and
 *  agy's headless permission check then DENIES its shell (`run_command`), its file writes (`write_to_file`) and
 *  any read outside its cwd — re-probed live on agy 1.2.11 (2026-09-26, PR #2714): each came back in the result's
 *  `denied_actions` and left no trace on disk. A read INSIDE its cwd (`--dir`, which for a review must be a
 *  throwaway checkout of public PR code) is still allowed. A denied call ends the turn with no answer, so the task
 *  must carry everything the model needs in its own text; this suffix tells the model so. */
export const REVIEW_MODE_SUFFIX = 'This is a READ-ONLY review: you cannot run commands or write any file (those tool '
  + 'calls are denied and end your turn). Judge from the material in this message, then put your whole answer in '
  + 'your final message.';
const writingTools = ['write_to_file', 'replace_file_content', 'sed_file', 'multi_replace_file_content', 'notebook_edit'];

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`gemini-direct-task: ${name} must be a non-empty string`);
  }
}

function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new TypeError('gemini-direct-task: timeout must be a positive integer in milliseconds (at most 2147483647)');
  }
}

/** Pure argv AFTER agy. No required cwd flag exists; scope is supplied via spawn and the prompt. */
export function buildAgyDirectTaskArgv({ addDirs = [], model, effort, sandbox = false, printTimeoutMs, resumeConversationId = null, review = false } = {}) {
  // Resume supplies a non-empty continuation instruction via text-mode --print and an explicit conversation.
  // stream-json input is for the initial task only: it runs one turn per stdin message.
  const argv = ['--input-format', resumeConversationId === null ? 'stream-json' : 'text', '--output-format', 'stream-json',
    '--disable-slash-commands'];
  // #4194 — without this flag agy denies shell, writes and out-of-cwd reads (see REVIEW_MODE_SUFFIX).
  if (!review) argv.push('--dangerously-skip-permissions');
  if (!Array.isArray(addDirs)) throw new TypeError('gemini-direct-task: addDirs must be an array');
  // An extra dir would re-grant reads outside --dir that a review run exists to deny.
  if (review && addDirs.length) throw new TypeError('gemini-direct-task: --add-dir is not allowed with --review');
  for (const dir of addDirs) {
    requireText(dir, 'addDirs entry');
    argv.push('--add-dir', dir); // bookkeeping only — neither read nor write confinement.
  }
  if (model !== undefined) {
    requireText(model, 'model');
    if (model.trim().startsWith('-')) throw new TypeError('gemini-direct-task: model must not be flag-shaped');
    argv.push('--model', model.trim());
  }
  if (effort !== undefined) {
    if (!['low', 'medium', 'high'].includes(effort)) throw new TypeError('gemini-direct-task: effort must be low|medium|high');
    const modelSupportsEffort = !(typeof model === 'string' && AGY_EFFORT_UNSUPPORTED_MODELS.includes(model.trim()));
    if (modelSupportsEffort) argv.push('--effort', effort); // vocabulary only; agy validates model/effort combinations for every other model.
  }
  if (typeof sandbox !== 'boolean') throw new TypeError('gemini-direct-task: sandbox must be boolean');
  if (sandbox) argv.push('--sandbox'); // shell only; native file tools bypass this confinement.
  if (printTimeoutMs !== undefined) {
    validateTimeout(printTimeoutMs);
    argv.push('--print-timeout', `${printTimeoutMs / 1000}s`);
  }
  if (resumeConversationId !== null) {
    requireText(resumeConversationId, 'resumeConversationId');
    if (resumeConversationId.trim().startsWith('-')) throw new TypeError('gemini-direct-task: resumeConversationId must not be flag-shaped');
    argv.push('--conversation', resumeConversationId);
  }
  return [...argv, '--print', resumeConversationId === null ? '' : AGY_RESUME_PROMPT]; // Initial prompt rides stdin with the required empty value.
}

export function buildAgyPrompt(task, absoluteDir, { review = false } = {}) {
  requireText(task, 'task');
  requireText(absoluteDir, 'absoluteDir');
  if (!isAbsolute(absoluteDir)) throw new TypeError('gemini-direct-task: absoluteDir must be an absolute path');
  if (review) return `${task.trim()}\n\n---\n\n${REVIEW_MODE_SUFFIX}`;
  return `${task.trim()}\n\n---\n\n`
    + `The absolute target directory is ${JSON.stringify(absoluteDir)}. Stay inside this directory. `
    + "Use only absolute paths and never trust your shell's own cwd: it may be agy's internal scratch directory, "
    + 'even when the launch cwd is correct. Set command working directories explicitly using that absolute target; '
    + 'use git -C with the absolute target for git commands. Read and follow the target repository’s agent instructions.\n\n'
    + 'Do not use the grep_search tool — it has a known bug where it can silently report SUCCESS with zero '
    + 'results instead of surfacing a real match. For any code/text search, run a shell command instead '
    + '(e.g. `rg` or `grep`) via your shell-exec capability.\n\n'
    + 'Make the change directly by editing files in this working directory. When you are done, STOP — do '
    + 'not run `git commit`, do not run `git push`, and do not open a pull request. Do not run `git add` '
    + '(the wrapper handles content-free --intent-to-add for diff capture). A human will review the '
    + 'diff and decide what to do with it.';
}

export function buildAgyStdinLine(prompt) {
  requireText(prompt, 'prompt');
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
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
    throw new TypeError('gemini-direct-task: `repoRoot` must be a non-empty path');
  }
  if (typeof dest !== 'string' || !dest.trim()) {
    throw new TypeError('gemini-direct-task: `dest` must be a non-empty path');
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

/** One parsed line, or null. Malformed/non-string input is harmless. PURE. */
export function parseJsonlLine(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

export function parseJsonlEvents(stdout) {
  return typeof stdout === 'string' ? stdout.split('\n').map(parseJsonlLine).filter(Boolean) : [];
}

/** Informational trace only: filesTouched is best-effort; the REAL deliverable is the git diff. PURE. */
export function summarizeAgyEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const conversationId = list.find((e) => e?.event === 'init')?.conversation_id ?? null;
  const steps = list.filter((e) => e?.event === 'step_update').map((e) => e.step_update);
  const toolCalls = steps.filter((s) => s?.step_type === 'tool' && s.state === 'DONE')
    .map((s) => ({ name: s.tool_name, params: s.tool_info?.parameters, output: s.tool_info?.output }));
  // Tool outcome is independent of step lifecycle and the CLI's terminal self-report.
  const toolErrors = steps.filter((s) => s?.status === 'TOOL_ERROR')
    .map((s) => ({ name: s.tool_name, params: s.tool_info?.parameters, output: s.tool_info?.output }));
  const filesTouched = [...new Set(toolCalls.filter((t) => writingTools.includes(t.name)).flatMap((t) => {
    if (!t.params || typeof t.params !== 'object') return [];
    return Object.entries(t.params).filter(([key, value]) =>
      /^(target_?file|file_?path|path|notebook_?path|notebook_?file)$/i.test(key)
      && typeof value === 'string' && value.trim()).map(([, value]) => value);
  }))];
  // ACTIVE and DONE both carry deltas (DONE can be just a newline); concatenate per step.
  const messages = new Map();
  for (const s of steps) {
    if (s?.step_type !== 'agent_response' || typeof s.text_delta !== 'string') continue;
    const key = JSON.stringify([s.conversation_id, s.step_index]);
    messages.set(key, (messages.get(key) ?? '') + s.text_delta);
  }
  const result = [...list].reverse().find((e) => e?.event === 'result')?.result;
  return {
    conversationId, toolCalls, toolErrors, filesTouched, agentMessages: [...messages.values()],
    terminal: typeof result?.status === 'string' ? result.status : null,
    finalResponse: typeof result?.response === 'string' ? result.response : null,
    errorMessage: result?.error ?? null,
    usage: result?.usage && typeof result.usage === 'object' ? result.usage : {},
  };
}

/** `execFileSync`-shaped default with room for large diffs and git/npm/gate output. */
export const defaultExecFn = (bin, args, opts = {}) =>
  execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024, ...opts });

/**
 * Make a fresh scratch clone of `repoRoot` and install its deps — the default target when the
 * caller names no existing directory. Injectable `execFn`/`mkTempDir`/`existsFn` for testing without a real
 * git/npm process.
 *
 * #3782 — this function used to unconditionally rewrite the clone's `origin` from the local `repoRoot` path
 * to the REAL push remote. This file's own header is honest that agy has no real read/write confinement (its
 * native file tools bypass `--sandbox`/`--add-dir`), but that is a DIFFERENT gap from this one: even a
 * perfectly-confined agent, given a push-capable origin, could push. A live probe on the operator's own
 * machine found ambient SSH-agent credentials that would authenticate such a push — real, not theoretical —
 * which is why `we:scripts/codex-direct-task.mjs`'s matching function was fixed the same way under #3782; this
 * one mirrors that fix rather than leaving an identical gap unpatched here.
 *
 * Least-privilege by default: leave `origin` at the local `repoRoot` path (git clone's own default, not
 * push-capable) and resolve+return the real remote URL as `realOrigin` for the caller to print, rather than
 * wiring it into the clone's git config. `wireOriginToRemote: true` opts back into the old behavior.
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {(prefix: string) => string} [opts.mkTempDir]
 * @param {Function} [opts.execFn]
 * @param {(path: string) => boolean} [opts.existsFn]
 * @param {boolean} [opts.installDeps] - default true; a caller in a hurry for a task that touches no code
 *   dependent on `node_modules` may pass false.
 * @param {boolean} [opts.wireOriginToRemote] - default false (#3782). When true, opts back into the pre-#3782
 *   behavior: rewrite the clone's `origin` to the real remote so a human can push straight from it.
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
    throw new TypeError('gemini-direct-task: `repoRoot` must be a non-empty path');
  }
  const dest = mkTempDir(join(tmpdir(), 'we-gemini-direct-'));
  execFn('git', buildScratchCloneArgv({ repoRoot, dest }));
  // Resolve the real push remote so it can be REPORTED — never silently wired in by default (#3782).
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
 * because agy ran with a real shell and COULD run `git commit` on its own despite the prompt's instruction
 * not to (see `buildAgyPrompt`). `git diff <startSha>` compares a fixed starting point to the CURRENT
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
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('gemini-direct-task: `dir` must be a non-empty path');
  if (typeof startSha !== 'string' || !startSha.trim()) throw new TypeError('gemini-direct-task: `startSha` must be a non-empty sha');

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

/**
 * Stream raw JSONL to logFile and optionally stdout. Always resolves, including spawn/log/timeout errors.
 * The parent wall kills with SIGKILL; the child's close event drains remaining output before reporting.
 * Runs one attempt. Resume mode appends to the log and closes stdin without replaying the task.
 * No child process is created by unit tests: spawnFn is injectable.
 */
export async function runAgyDirectExec({
  dir, task, model, effort, addDirs, sandbox = false, timeoutMs = DEFAULT_TIMEOUT_MS,
  logFile, stream = true, spawnFn = nodeSpawn, cli = AGY_CLI, resumeConversationId = null, review = false,
  // Injected processes must not consume or publish the host's real quota observations.
  // Callers exercising quota behavior can inject both store operations explicitly.
  readHold = spawnFn === nodeSpawn ? readAgyHold : () => null,
  saveHold = spawnFn === nodeSpawn ? saveAgyHold : () => {},
} = {}) {
  let argv = [];
  let stdinLine;
  try {
    validateTimeout(timeoutMs);
    argv = buildAgyDirectTaskArgv({ model, effort, addDirs, sandbox, printTimeoutMs: timeoutMs, resumeConversationId, review });
    if (resumeConversationId === null) stdinLine = buildAgyStdinLine(buildAgyPrompt(task, dir, { review }));
    requireText(logFile, 'logFile');
    // A killed process can leave a partial final line. Separate attempts before appending new JSONL.
    if (resumeConversationId !== null) appendFileSync(logFile, '\n');
    else writeFileSync(logFile, '');
    const hold = readHold(model);
    if (hold) return { stdout: '', stderr: `agy quota exhausted: ${hold.fallbackDecision} until ${hold.quotaResetsAt}`, code: 1, timedOut: false, argv, ...hold };
  } catch (e) {
    return { stdout: '', stderr: e.message, code: null, timedOut: false, argv };
  }
  return new Promise((resolvePromise) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let child;
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
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeSignalListeners();
      const evidence = agyRunEvidence({ stdout: out, stderr: err, requestedModel: model });
      try { saveHold(evidence); } catch (e) { err += `quota hold persistence failed: ${e.message}`; code = 1; }
      if (evidence.fallbackDecision !== 'none') {
        code = 1;
        err += `agy: ${evidence.fallbackDecision}; quota reset ${evidence.quotaResetsAt ?? 'unknown'}`;
      }
      resolvePromise({ stdout: out, stderr: err, code, timedOut, argv, ...evidence });
    };
    const recordError = (e) => { err += `${e.message}\n`; };
    try {
      child = spawnFn(cli, argv, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      recordError(e);
      settle(null);
      return;
    }
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGKILL');
      } catch { /* already gone, or process-group kill is unavailable */ }
      try { child.kill('SIGKILL'); } catch (e) { recordError(e); settle(null); }
    }, timeoutMs);
    timer.unref?.();
    const stdoutDecoder = new TextDecoder();
    const recordStdout = (text) => {
      if (!text) return;
      out += text;
      try {
        appendFileSync(logFile, text);
        if (stream) process.stdout.write(text);
      } catch (e) {
        recordError(e);
        try { child.kill('SIGKILL'); } catch { settle(null); }
      }
    };
    child.stdout?.on('data', (d) => recordStdout(stdoutDecoder.decode(d, { stream: true })));
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { recordError(e); settle(null); });
    child.on('close', (code) => {
      recordStdout(stdoutDecoder.decode());
      settle(code);
    });
    child.stdin?.on('error', recordError); // EPIPE can precede close on an early CLI rejection.
    try { child.stdin?.end(stdinLine); } catch (e) {
      recordError(e);
      try { child.kill('SIGKILL'); } catch { settle(null); }
    }
  });
}

/** Resolve target, record HEAD, run with at most one resume, capture diff, gate. NEVER commit/push/open a PR. */
export async function geminiDirectTask({
  task, dir, repoRoot, model, effort, addDirs, sandbox = false, timeoutMs = DEFAULT_TIMEOUT_MS,
  gate = 'none', logFile, stream = true, installDeps = true, wireOriginToRemote = false, review = false,
  execFn = defaultExecFn, spawnFn = nodeSpawn, mkTempDir = mkdtempSync, existsFn = existsSync,
} = {}) {
  requireText(task, 'task');
  validateTimeout(timeoutMs);
  buildAgyDirectTaskArgv({ model, effort, addDirs, sandbox }); // fail before cloning on invalid input.
  if (!['none', 'standards', 'full'].includes(gate)) throw new TypeError('gemini-direct-task: gate must be none|standards|full');
  let scratch = null;
  let targetDir;
  if (dir === undefined) {
    requireText(repoRoot, 'repoRoot (required when dir is omitted)');
    repoRoot = resolve(repoRoot);
    scratch = setupScratchClone({
      repoRoot, execFn, mkTempDir, existsFn, installDeps, wireOriginToRemote,
    });
    targetDir = resolve(scratch.dest);
  } else {
    requireText(dir, 'dir');
    targetDir = resolve(dir);
    if (!existsFn(targetDir)) throw new Error(`gemini-direct-task: --dir=${targetDir} does not exist`);
  }
  const startSha = execFn('git', ['-C', targetDir, 'rev-parse', 'HEAD']).trim();
  // Default bookkeeping is hidden from git status. Explicit --log paths are the operator's choice.
  const gitDir = logFile ? null : execFn('git', ['-C', targetDir, 'rev-parse', '--absolute-git-dir']).trim();
  const resolvedLogFile = logFile ? resolve(logFile) : join(gitDir, 'gemini-direct-task.jsonl');
  mkdirSync(dirname(resolvedLogFile), { recursive: true });
  const runOptions = {
    dir: targetDir, task, model, effort, addDirs, sandbox, timeoutMs,
    logFile: resolvedLogFile, stream, spawnFn, review,
  };
  let run = await runAgyDirectExec(runOptions);
  let summary = summarizeAgyEvents(parseJsonlEvents(run.stdout));
  let resumeConversationId = null;
  // A terminal result is a completed failure/success, not a mid-run crash. Without an init ID there
  // is nothing safe to resume; --continue could select another concurrent task's conversation.
  if (run.quotaState !== 'exhausted' && !['skip-backend-mismatch', 'skip-model-mismatch'].includes(run.fallbackDecision) && (run.timedOut || (run.code !== 0 && summary.terminal === null))
      && typeof summary.conversationId === 'string' && summary.conversationId.trim()
      && !summary.conversationId.trim().startsWith('-')) {
    resumeConversationId = summary.conversationId;
    // Exactly one additional call, never recursion/a loop. Give the resumed work a full fresh parent
    // SIGKILL wall: the original budget may already be exhausted, leaving no time to make progress.
    run = await runAgyDirectExec({ ...runOptions, resumeConversationId });
    // Status/events describe the final attempt; the append-only resume log preserves both traces.
    // In particular, an earlier result must not mask a resumed attempt that crashes before any result.
    summary = summarizeAgyEvents(parseJsonlEvents(run.stdout));
    summary.conversationId ??= resumeConversationId;
  }
  // Startup errors can precede every JSONL event. Preserve the CLI's remedy instead of losing stderr.
  if (!summary.errorMessage && run.stderr.trim()) summary.errorMessage = run.stderr.trim();
  const diff = captureDiff({ dir: targetDir, startSha, execFn });
  const gateResult = runGate({ dir: targetDir, mode: gate, execFn });
  return {
    model, effort: effort ?? null,
    dir: targetDir,
    scratch: scratch ? {
      created: true,
      source: repoRoot,
      depsInstall: scratch.depsInstall,
      // #3782: origin stays at the local repoRoot path by default (not push-capable) — realOrigin is only
      // ever reported, never silently wired in, unless the caller opted in via wireOriginToRemote.
      realOrigin: scratch.realOrigin,
      originWired: scratch.originWired,
    } : { created: false },
    ...agyRunEvidence({ requestedModel: model }), ...pickAgyEvidence(run),
    startSha, argv: run.argv, logFile: resolvedLogFile, exitCode: run.code, timedOut: run.timedOut,
    resumed: resumeConversationId !== null, resumeConversationId,
    events: summary, diff, gate: gateResult,
  };
}

/** --flag=value parsing, with repeatable --add-dir. Pure and independently testable. */
export function parseFlags(argv) {
  const flags = {};
  const values = ['task', 'task-file', 'dir', 'repo-root', 'model', 'effort', 'add-dir', 'timeout-ms', 'wait-ms', 'gate', 'log'];
  const booleans = ['sandbox', 'no-stream', 'no-install', 'wire-origin-to-remote', 'json', 'help', 'review'];
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (!arg.startsWith('--') || ![...values, ...booleans].includes(key)) {
      throw new TypeError(`gemini-direct-task: unknown argument ${arg}`);
    }
    if (values.includes(key)) {
      if (eq === -1 || !arg.slice(eq + 1).trim()) throw new TypeError(`gemini-direct-task: --${key}=<value> required`);
      const value = arg.slice(eq + 1);
      if (key === 'add-dir') flags[key] = [...(flags[key] ?? []), value];
      else flags[key] = value;
    } else {
      if (eq !== -1) throw new TypeError(`gemini-direct-task: --${key} takes no value`);
      flags[key] = true;
    }
  }
  if (flags['wait-ms'] !== undefined && (!/^\d+$/.test(flags['wait-ms']) || !Number.isSafeInteger(Number(flags['wait-ms'])))) throw new TypeError('Invalid --wait-ms');
  return flags;
}

export const HELP = `usage: node scripts/gemini-direct-task.mjs --task=<text>|--task-file=<path>
  --wait-ms=N              Bounds the wait for external builder capacity.
  --dir=<existing checkout>  Default: fresh scratch clone; --repo-root=<path> REQUIRED without --dir.
  --model=<slug> --effort=low|medium|high  Optional passthroughs; no validated recommendation for this role.
  --add-dir=<dir>            Repeatable bookkeeping only, NOT a sandbox or permission boundary.
  --sandbox                  Confines the shell only, NOT agy's own native file tools.
  --timeout-ms=<n>            Parent SIGKILL ceiling PER ATTEMPT, default 30 min; print-timeout is a hint.
  --gate=none|standards|full  Default none; full = check:standards + WHOLE Vitest suite.
  --no-stream                Still logs JSONL; suppresses live stdout.
  --log=<path>               Default <dir>/.git/gemini-direct-task.jsonl.
  --no-install               Skip scratch clone dependency installation.
  --wire-origin-to-remote    #3782: opt-in — rewrite a fresh scratch clone's origin to the real remote so a
                             human can push straight from it. Default: origin stays at the local repoRoot
                             path (not push-capable); the real remote is only printed. No effect with --dir.
  --json                     Full report only on stdout (implies --no-stream).
  --review                   #4194: a READ-ONLY review task — agy runs without --dangerously-skip-permissions,
                             so shell, file writes and reads outside --dir are denied; the task text must carry
                             everything to judge, and the answer comes back in the final message
                             (events.finalResponse). Point --dir at a throwaway checkout.
Timeout or nonzero/null exit without a terminal result: resume exactly once via --conversation <ID>,
only with a captured init conversation ID. No ID means no retry. Each attempt gets a fresh timeout
budget (up to twice --timeout-ms); the original prompt is not replayed. Both attempts stay in the log.
Report status/events describe the last attempt; resumed and resumeConversationId identify the retry.
No real write/read confinement exists. Review the diff; this script never commits or pushes.`;

/** Human report prints the full artifact, not merely a diff stat or the agent's self-report. PURE. */
export function formatReport(report) {
  const lines = [
    `gemini-direct-task: ${report.scratch.created ? 'scratch clone' : 'target dir'} → ${report.dir}`,
    ...(report.scratch.created && report.scratch.realOrigin ? [
      report.scratch.originWired
        ? `origin wired to the real remote (--wire-origin-to-remote): ${report.scratch.realOrigin}`
        : `origin left at the local clone source (#3782, not push-capable). Real remote: ${report.scratch.realOrigin}\n`
          + `  to push from here yourself: git -C ${report.dir} remote set-url origin ${report.scratch.realOrigin}`,
    ] : []),
    `conversation: ${report.events.conversationId ?? '<none>'}  terminal: ${report.events.terminal ?? '<none>'}  exit: ${report.exitCode}  timedOut: ${report.timedOut}`,
    ...(report.events.toolErrors.length ? [
      `WARNING: TOOL ERRORS DURING RUN (${report.events.toolErrors.length}) — the terminal status above may not reflect real success:`,
      ...report.events.toolErrors.map((t) => `  ${t.name}: ${t.output ?? '<no output>'}`),
    ] : []),
    `tool calls: ${report.events.toolCalls.length}  files touched (informational): ${report.events.filesTouched.length}`,
    `model: requested=${report.requestedModel ?? 'unknown'} reported=${report.servedModel ?? 'unknown'} backend=${report.servedBackend ?? 'unknown'} evidence=${report.modelEvidence ?? 'unavailable'} decision=${report.fallbackDecision ?? 'none'}`,
    `log: ${report.logFile}`,
    `usage (tokens only): ${JSON.stringify(report.events.usage)}`,
  ];
  if (report.resumed) lines.push(`resumed once: ${report.resumeConversationId}`);
  if (report.events.errorMessage) lines.push(`error: ${report.events.errorMessage}`);
  if (report.events.finalResponse) lines.push(`agent response:\n${report.events.finalResponse}`);
  if (report.diff.commits.length) {
    lines.push('AGENT MADE COMMITS despite the instruction — review these boundaries:', ...report.diff.commits);
  }
  lines.push(report.diff.commits.length
    ? 'The wrapper committed/pushed nothing; the agent violated the no-commit instruction above.'
    : 'NOTHING WAS COMMITTED OR PUSHED BY THIS SCRIPT. The agent was instructed likewise; pushes cannot be verified by a local diff.');
  lines.push("This run had NO real sandbox — agy's own file tools can read/write outside the target directory even with --sandbox on (see this file's header). Review the diff below before trusting that nothing else on this machine was touched. A target diff cannot prove that.");
  lines.push(`\nstatus:\n${report.diff.status || '(clean)'}`, `diff stat:\n${report.diff.diffStat || '(empty)'}`,
    `diff against ${report.startSha}:\n${report.diff.diff || '(empty)'}`);
  if (report.gate.ran) {
    lines.push(`gate (${report.gate.mode}): ${report.gate.pass ? 'PASS' : 'FAIL'}`);
    for (const step of report.gate.steps) lines.push(`${step.pass ? 'PASS' : 'FAIL'} ${step.cmd}\n${step.output}`);
  }
  return lines.join('\n');
}

/** Injectable orchestration seam lets CLI flag/report tests run without any real process. */
export async function main(argv = process.argv.slice(2), { taskFn = geminiDirectTask, readFileFn = readFileSync, slotOptions = {} } = {}) {
  const flags = parseFlags(argv);
  if (flags.help) { console.log(HELP); return; }
  if (Boolean(flags.task) === Boolean(flags['task-file'])) {
    throw new TypeError('gemini-direct-task: pass exactly one of --task=<text> or --task-file=<path>');
  }
  const task = flags['task-file'] ? readFileFn(resolve(flags['task-file']), 'utf8') : flags.task;
  const slot = await startBuilderLease({ ...slotOptions, class: 'antigravity', purpose: 'gemini-direct-task',
    ...(flags['wait-ms'] === undefined ? {} : { waitMs: Number(flags['wait-ms']) }) });
  if (!slot.ok) {
    console.error(slot.reason === 'unreadable' ? `gemini-direct-task: builder slot store unreadable: ${slot.error}`
      : `gemini-direct-task: no external builder slot free (cap ${slot.cap}, holders: ${JSON.stringify(slot.holders)})`);
    process.exitCode = 75;
    return;
  }
  let report;
  try {
    report = await taskFn({
      task, dir: flags.dir ? resolve(flags.dir) : undefined,
      repoRoot: flags['repo-root'] ? resolve(flags['repo-root']) : undefined,
      model: flags.model, effort: flags.effort, addDirs: flags['add-dir']?.map((dir) => resolve(dir)),
      sandbox: Boolean(flags.sandbox), timeoutMs: flags['timeout-ms'] ? Number(flags['timeout-ms']) : DEFAULT_TIMEOUT_MS,
      gate: flags.gate ?? 'none', logFile: flags.log ? resolve(flags.log) : undefined,
      stream: !flags['no-stream'] && !flags.json, installDeps: !flags['no-install'],
      wireOriginToRemote: Boolean(flags['wire-origin-to-remote']),
      review: Boolean(flags.review),
      // npm install normally inherits stdout. Keep --json machine-readable during scratch setup too.
      execFn: flags.json ? (bin, args, opts = {}) => defaultExecFn(bin, args, {
        ...opts, ...(opts.stdio === 'inherit' ? { stdio: ['ignore', 2, 2] } : {}),
      }) : defaultExecFn,
    });
  } finally { slot.close(); }
  console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (report.timedOut || report.exitCode !== 0 || report.events.terminal !== 'SUCCESS' || !report.gate.pass
      || report.events.toolErrors.some((t) => writingTools.includes(t.name))) {
    process.exitCode = 1;
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
