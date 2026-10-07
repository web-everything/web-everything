#!/usr/bin/env node
/**
 * @file scripts/operations/fix-run.mjs
 * @description Card 87 follow-up — ONE BORROWED FIX, IN ITS OWN PROCESS, ON A NON-CLAUDE EXECUTOR. The per-dispatch
 * entry point `dispatch-providers/fix.mjs#fixDetachedProvider` spawns detached when a fix borrows a builder slot
 * (`scripts/lib/fix-slot-borrow.mjs`) and the borrowed executor is not Claude.
 *
 *   node scripts/operations/fix-run.mjs --pr=7 --session=fix-7 --ref=lane/7-x --prompt-file=/tmp/.../fix-7.md \
 *     --provider=codex [--repo=owner/repo] [--lane-repo=<checkout>] [--scope=we:a.mjs] [--num=7]
 *
 * SAME CLAIM, BRIEF AND REVIEW as a Claude fix; ONLY THE LAUNCHER AND EXECUTOR DIFFER:
 *   - claim:  already taken by `reconcile-fix-dispatch.mjs#dispatchFix` (carries `borrowed`); this process never takes one.
 *   - brief:  the exact filled `fix-agent-brief.md` prompt `dispatchFix` built, handed over as `--prompt-file`.
 *   - review: after the agent exits, a push of new commits is followed by `rearm-review.mjs` — the same hand-back
 *             the brief's step 7 makes — so an independent re-review is owed; nothing here ever clears a gate.
 *
 * WHY THE LAUNCHER (not the agent) PUSHES. Codex runs in the same no-network `:workspace` sandbox as a build
 * (`codex-delivery-provider.mjs`, UNKNOWN 3): it cannot `gh`, `lane-pool` or `git push`. So this launcher owns every
 * step that needs the network or the lane pool — acquire the lane at the PR's head ref, push, re-arm, release — and
 * the agent only edits and commits in the lane. A preamble on the brief says so. `antigravity-*` has no delivery
 * provider on main, so it is refused up front rather than launched half-working.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './detached-dispatch.mjs';
// Imported FROM the leaf, never the other way round (see `fix.mjs#FIX_RUN_EXECUTORS`): this file's top-level `await`
// below deadlocks if `dispatch-providers/fix.mjs` imports it back.
import { FIX_RUN_EXECUTORS } from './dispatch-providers/fix.mjs';
import { LANE_CONFIG_LIST_ARGS, laneGitConfigArgs, laneGitHardeningEnv } from '../lib/lane-git-hardening.mjs';

// LAZY on purpose: `deliver-item-wrapper.mjs` reaches `dispatch-providers/fix.mjs` (which imports this file) through
// `dispatch-lane-io.mjs` -> `dispatch-provider-registry.mjs`, so a static import here is a cycle that makes the
// wrapper load before its own mocked/initialised dependencies are bound.
const resolveDeliveryAgentProvider = async (name) => (await import('./deliver-item-wrapper.mjs')).resolveDeliveryAgentProvider(name);

export { FIX_RUN_EXECUTORS };

/** The agent can write anywhere in the lane's `.git` (hooks, config), and the push runs OUTSIDE its sandbox with our
 *  credentials. The code-running keys are pinned inert through the shared `lane-git-hardening` helper (env form, so
 *  the pins also hold for anything git itself spawns). */
export const HARDENED_GIT_ARGS = Object.freeze(laneGitConfigArgs());

/** Lane-local config keys that name a command, proxy, remote rewrite or credential source and are NOT pinned inert
 *  (a pin to a fixed value would break legitimate auth). A lane whose local/worktree scope defines one is refused
 *  BEFORE the agent runs and again before the push — a baseline an earlier agent poisoned is not trusted. Pure. */
const RISKY_LANE_CONFIG_RE = /^(credential\..*|core\.(askpass|gitproxy)|http\..*|https\..*|url\..+\.(insteadof|pushinsteadof)|protocol\..*|remote\..+\.(pushurl|proxy|receivepack|uploadpack|vcs)|include\.path|includeif\..+|filter\..+|alias\..+)$/i;
const SAFE_REMOTE_URL_RE = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/i;
export function riskyLaneConfig(listOutput) {
  const parts = String(listOutput ?? '').split('\0');
  const found = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i];
    if (scope !== 'local' && scope !== 'worktree') continue;
    const [key, ...rest] = parts[i + 1].split('\n');
    if (RISKY_LANE_CONFIG_RE.test(key)) found.push(key);
    else if (/^remote\..+\.url$/i.test(key) && !SAFE_REMOTE_URL_RE.test(rest.join('\n'))) found.push(key);
  }
  return found;
}

const PENDING_REARM_MAX_AGE_MS = 7 * 24 * 3_600_000;
const pendingRearmDir = () => join(homedir(), '.claude', 'conveyor', 'fix-run-pending');
const pendingKey = (repo, pr) => `${String(repo ?? 'we').replace(/[^\w.-]/g, '_')}-${String(pr).replace(/[^\w.-]/g, '_')}.json`;

/**
 * A repair that is PUSHED but not yet re-armed (the re-arm call failed): the next launch of the same PR opens its lane
 * at that pushed tip, sees no new commit, and would otherwise skip the re-arm for good. This records "owed" durably
 * between the two steps so a no-change retry can finish the hand-back. Default = a file under `~/.claude/conveyor`.
 */
export const defaultPendingRearm = (dir = pendingRearmDir()) => ({
  read(repo, pr, now = Date.now()) {
    try {
      const v = JSON.parse(readFileSync(join(dir, pendingKey(repo, pr)), 'utf8'));
      return v && typeof v.sha === 'string' && now - Number(v.at) < PENDING_REARM_MAX_AGE_MS ? v : null;
    } catch { return null; }
  },
  write(repo, pr, sha, now = Date.now()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, pendingKey(repo, pr)), JSON.stringify({ sha, at: now }), { mode: 0o600 });
  },
  clear(repo, pr) { try { unlinkSync(join(dir, pendingKey(repo, pr))); } catch { /* already gone */ } },
});

/** Best-effort removal of the one-shot brief file (and its private directory) once the launcher has read it. */
export function removePromptFile(file) {
  try { unlinkSync(file); } catch { return; }
  const dir = dirname(file);
  if (basename(dir).startsWith('we-fix-borrow-')) { try { rmdirSync(dir); } catch { /* not empty / gone */ } }
}

const REQUIRED_FLAGS = Object.freeze(['session', 'pr', 'ref', 'prompt-file']);

/** PURE. `--k=v` argv -> launch shape; refuses a missing required flag by name. */
export function parseFixRunArgv(argv = []) {
  const flags = {};
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = 'true';
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const missing = REQUIRED_FLAGS.filter((n) => !String(flags[n] ?? '').trim());
  if (missing.length) {
    throw new TypeError(`fix-run: missing required flag(s) ${missing.map((m) => `--${m}=`).join(', ')}`);
  }
  const opt = (k) => (String(flags[k] ?? '').trim() || null);
  return {
    pr: String(flags.pr).trim(), sessionSlug: String(flags.session).trim(), ref: String(flags.ref).trim(),
    promptFile: String(flags['prompt-file']).trim(),
    item: opt('num'), repo: opt('repo'), laneRepo: opt('lane-repo'), scope: opt('scope'),
    provider: opt('provider') ?? 'codex', effort: opt('effort'), model: opt('model'),
  };
}

/** Prepended to the brief: the agent's sandbox has no network, so the launcher owns the networked steps. */
export const SANDBOX_PREAMBLE = [
  '## LAUNCHER OVERRIDE (read first — it wins over the brief below)',
  'You run in a sandbox with NO network, inside a lane clone that is ALREADY acquired and already at the PR head.',
  'Do NOT run `gh`, `lane-pool.mjs`, `fix-procedure.mjs`, `rearm-review.mjs` or `git push`; skip every brief step that does.',
  'Do the judgment work only: apply the reviewer finding in this directory, then `git commit` it here.',
  'The launcher pushes your commit(s) and re-arms review after you exit. If nothing needs changing, commit nothing.',
  '',
  '---',
  '',
].join('\n');

const sh = (cmd, args, opts) => String(execFileSync(cmd, args, { encoding: 'utf8', ...opts }) ?? '').trim();

/** Lane path = last non-empty stdout line of `lane-pool acquire` (it prints the path last). */
export function parseAcquiredLanePath(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const path = lines.filter((l) => l.startsWith('/')).pop();
  if (!path) throw new Error(`fix-run: lane-pool acquire printed no lane path (got ${JSON.stringify(lines.slice(-2))})`);
  return path;
}

/**
 * THE CLI AS A FUNCTION. Exit 1 only when the launch itself threw; "agent made no change" is exit 0.
 * @returns {Promise<{code:number, result:string|null}>}
 */
export async function runFixCli(argv = [], {
  run = sh,
  readPrompt = (p) => readFileSync(p, 'utf8'),
  removePrompt = removePromptFile,
  pendingRearm = defaultPendingRearm(),
  resolveProvider = resolveDeliveryAgentProvider,
  weRoot = REPO_ROOT,
  write = (l) => process.stdout.write(l),
  writeErr = (l) => process.stderr.write(l),
} = {}) {
  let launch;
  let laneRelease = null;
  try {
    launch = parseFixRunArgv(argv);
    if (!FIX_RUN_EXECUTORS.includes(launch.provider)) {
      throw new TypeError(`fix-run: executor ${JSON.stringify(launch.provider)} has no fix launcher (supported: ${FIX_RUN_EXECUTORS.join('|')})`);
    }
  } catch (e) {
    writeErr(`error: ${String(e?.message ?? e)}\n`);
    const raw = (Array.isArray(argv) ? argv : []).find((a) => typeof a === 'string' && a.startsWith('--prompt-file='));
    if (raw) removePrompt(raw.slice('--prompt-file='.length)); // never leave the brief behind on a refused launch
    return { code: 1, result: null };
  }
  const { pr, sessionSlug, ref } = launch;
  write(`fix-run: starting borrowed repair of PR #${pr} (session ${sessionSlug}, provider ${launch.provider}) - pid ${process.pid}\n`);
  try {
    const brief = readPrompt(launch.promptFile);
    const poolArgs = [
      resolve(weRoot, 'scripts', 'lane-pool.mjs'), 'acquire', ...(launch.laneRepo ? [`--repo=${launch.laneRepo}`] : []),
      '--purpose=conveyor-fix', `--session=${sessionSlug}`, ...(launch.scope ? [`--scope=${launch.scope}`] : []), `--base=${ref}`,
    ];
    const lanePath = parseAcquiredLanePath(run('node', poolArgs, { cwd: weRoot }));
    const laneNum = basename(lanePath).replace(/^lane-/, '');
    laneRelease = () => run('node', [
      resolve(weRoot, 'scripts', 'lane-pool.mjs'), 'release', ...(launch.laneRepo ? [`--repo=${launch.laneRepo}`] : []),
      `--lane=${laneNum}`, `--session=${sessionSlug}`,
    ], { cwd: weRoot });
    const gitEnv = laneGitHardeningEnv(process.env);
    const laneConfig = () => run('git', [...LANE_CONFIG_LIST_ARGS], { cwd: lanePath, env: gitEnv });
    const before = run('git', ['rev-parse', 'HEAD'], { cwd: lanePath });
    const configBefore = laneConfig();
    const risky = riskyLaneConfig(configBefore);
    if (risky.length) throw new Error(`lane git config defines command/credential/remote-rewrite keys (${risky.join(', ')}); refusing to run in it`);
    const rearm = () => run('node', [resolve(weRoot, 'scripts', 'conveyor', 'rearm-review.mjs'), pr, ...(launch.repo ? [`--repo=${launch.repo}`] : [])], { cwd: weRoot });
    // A prior run pushed this exact tip and then failed to re-arm (this lane opened AT that tip): finish the hand-back
    // now, before spending a whole agent run on it.
    if (pendingRearm.read(launch.repo, pr)?.sha === before) {
      rearm();
      pendingRearm.clear(launch.repo, pr);
      const result = `PR #${pr} (already pushed ${before.slice(0, 9)}; re-armed review:pending after a failed earlier re-arm)`;
      write(`fix-run: PR #${pr} finished - ${result}\n`);
      return { code: 0, result };
    }
    const provider = await resolveProvider(launch.provider);
    await provider.spawn({
      sessionId: undefined, prompt: SANDBOX_PREAMBLE + brief, lane: laneNum, sessionSlug, item: launch.item ?? '', attemptTag: '',
      ...(launch.model ? { model: launch.model } : {}), ...(launch.effort ? { effort: launch.effort } : {}),
    }, { resolveLane: () => lanePath });
    const after = run('git', ['rev-parse', 'HEAD'], { cwd: lanePath });
    let result;
    if (after === before) {
      result = 'no-change (agent committed nothing; claim lapses and the PR is re-planned)';
    } else {
      // The agent could write the lane's `.git`; this push runs outside its sandbox with our credentials, so refuse
      // if its repo-local config (remote URL, sshCommand, insteadOf, credential helper, includes...) changed or is now
      // risky, and run the push with the code-running keys pinned inert (env, so no gap after the check) and no hooks.
      const configAfter = laneConfig();
      if (configAfter !== configBefore || riskyLaneConfig(configAfter).length) {
        throw new Error('lane git config changed while the agent ran; refusing to push');
      }
      // Record the owed re-arm BEFORE the push (best effort): a crash anywhere after the push must not lose it.
      try { pendingRearm.write(launch.repo, pr, after); } catch (e) { writeErr(`fix-run: could not record the pending re-arm: ${String(e?.message ?? e)}\n`); }
      run('git', [...HARDENED_GIT_ARGS, 'push', '--no-verify', 'origin', `HEAD:refs/heads/${ref}`], { cwd: lanePath, env: gitEnv }); // never --force
      rearm();
      pendingRearm.clear(launch.repo, pr);
      result = `PR #${pr} (pushed ${after.slice(0, 9)}, re-armed review:pending)`;
    }
    write(`fix-run: PR #${pr} finished - ${result}\n`);
    return { code: 0, result };
  } catch (e) {
    writeErr(`fix-run: PR #${pr} FAILED: ${String(e?.message ?? e)}\n`);
    return { code: 1, result: null };
  } finally {
    removePrompt(launch.promptFile); // one-shot, untrusted text: gone on every exit, success or not
    try { laneRelease?.(); } catch (e) { writeErr(`fix-run: lane release failed: ${String(e?.message ?? e)}\n`); }
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const { code } = await runFixCli(process.argv.slice(2));
  process.exitCode = code;
}
