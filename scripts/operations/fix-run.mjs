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
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT } from './detached-dispatch.mjs';

// LAZY on purpose: `deliver-item-wrapper.mjs` reaches `dispatch-providers/fix.mjs` (which imports this file) through
// `dispatch-lane-io.mjs` -> `dispatch-provider-registry.mjs`, so a static import here is a cycle that makes the
// wrapper load before its own mocked/initialised dependencies are bound.
const resolveDeliveryAgentProvider = async (name) => (await import('./deliver-item-wrapper.mjs')).resolveDeliveryAgentProvider(name);

/** Executors this launcher can run today (each needs a write-capable delivery provider). */
export const FIX_RUN_EXECUTORS = Object.freeze(['codex']);

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
    const before = run('git', ['rev-parse', 'HEAD'], { cwd: lanePath });
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
      run('git', ['push', 'origin', `HEAD:refs/heads/${ref}`], { cwd: lanePath }); // never --force
      run('node', [resolve(weRoot, 'scripts', 'conveyor', 'rearm-review.mjs'), pr, ...(launch.repo ? [`--repo=${launch.repo}`] : [])], { cwd: weRoot });
      result = `PR #${pr} (pushed ${after.slice(0, 9)}, re-armed review:pending)`;
    }
    write(`fix-run: PR #${pr} finished - ${result}\n`);
    return { code: 0, result };
  } catch (e) {
    writeErr(`fix-run: PR #${pr} FAILED: ${String(e?.message ?? e)}\n`);
    return { code: 1, result: null };
  } finally {
    try { laneRelease?.(); } catch (e) { writeErr(`fix-run: lane release failed: ${String(e?.message ?? e)}\n`); }
  }
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const { code } = await runFixCli(process.argv.slice(2));
  process.exitCode = code;
}
