/** Local verify / host-load counterpart to #4999 (CI per-test flake scoring and quarantine).
 * Pure planning plus injectable IO. A quiet host retries one saved fix, never force-pushing.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { runBounded } from '../lib/bounded-child.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { loadFlakeResults, buildLoadFlakeResolvedComment } from './stand-down.mjs';
import { loadFlakeHoldState } from './load-flake-hold.mjs';
import { redactSecrets } from './ci-heal-mark.mjs';

export function reverifyConfig(env = process.env, maxLoadPerCore) {
  const positive = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid reverify limit: ${value}`);
    return n;
  };
  return {
    maxLoadPerCore: positive(maxLoadPerCore ?? env.WE_LOAD_FLAKE_REVERIFY_MAX_LOAD_PER_CORE, 0.75),
    maxAttempts: Math.max(1, Math.floor(positive(env.WE_LOAD_FLAKE_REVERIFY_MAX_ATTEMPTS, 3))),
    cooloffMs: positive(env.WE_LOAD_FLAKE_REVERIFY_COOLOFF_MIN, 30) * 60_000,
    mode: reverifyMode(env),
  };
}

/** `local` (default) re-verifies the held fix on this host; `ci` pushes it unverified so the PR's CI judges it. */
function reverifyMode(env) {
  const mode = env.WE_LOAD_FLAKE_REVERIFY_MODE ?? 'local';
  if (!['local', 'ci'].includes(mode)) throw new Error('invalid reverify mode');
  return mode;
}

export function planLoadFlakeReverify({ prs = [], load, cores, now, config = reverifyConfig({}) }) {
  if (config.mode !== 'ci' && (!(cores > 0) || load.length < 2 || load.slice(0, 2).some((n) => !Number.isFinite(n) || n / cores > config.maxLoadPerCore))) {
    return { deferred: 'host-load' };
  }
  const candidates = prs.flatMap((pr) => {
    const state = loadFlakeHoldState({ comments: pr.comments, headRefOid: pr.headRefOid, now });
    if (!state.live) return [];
    const reds = loadFlakeResults(pr.comments).filter((r) => r.sha === state.hold.alt.sha && r.result === 'red-again');
    if (reds.length && now - Date.parse(reds.at(-1).createdAt) < config.cooloffMs) return [];
    return [{ pr, ...state, attempts: reds.length }];
  }).sort((a, b) => Date.parse(a.hold.createdAt) - Date.parse(b.hold.createdAt));
  return candidates.length ? { candidate: candidates[0], candidates } : { deferred: 'no-candidate' };
}

/** The one repository the registered pass sweeps (the manifest entry has no --repo flag); see `LOAD_FLAKE_REVERIFY_REPOS`. */
export const REVERIFY_DEFAULT_REPO = 'we';

export async function runLoadFlakeReverify({ repo = REVERIFY_DEFAULT_REPO, dryRun = false, config = reverifyConfig() } = {}, io = defaultReverifyIo()) {
  const now = io.now();
  const load = io.loadavg();
  const cores = io.cpuCount();
  const key = repoKeyForSlug(repo);
  if (!key) throw new Error(`unknown repo: ${repo}`);
  const slug = CONSTELLATION_REPOS[key].slug;
  const prs = await io.listPrs(slug);
  const plan = planLoadFlakeReverify({ prs, load, cores, now, config });
  // Holding is the common case: name every PR it holds and the load it saw, so the log proves the pass is
  // evaluating them (a bare "host-load" line cannot be told apart from a pass that sees no holds). Read-only.
  if (plan.deferred === 'host-load') {
    return { ...plan, mode: config.mode, load: load.slice(0, 2).map((n) => Math.round(n * 100) / 100), cores, maxLoadPerCore: config.maxLoadPerCore,
      holds: prs.flatMap((pr) => {
        const state = loadFlakeHoldState({ comments: pr.comments, headRefOid: pr.headRefOid, now });
        return state.live ? [{ pr: pr.number, alt: state.hold.alt.branch, altSha: state.hold.alt.sha }] : [];
      }) };
  }
  if (!plan.candidate || dryRun) return { ...plan, dryRun, mode: config.mode };
  // Take candidates oldest-first until one makes progress. A hold that cannot be worked right now (fix claim
  // live, transient fetch failure) must never starve the younger holds behind it; a hold that can NEVER be worked
  // is ended on the PR instead, so it stops being picked at all.
  let firstError = null;
  let lastDeferral = null;
  for (const candidate of plan.candidates) {
    try {
      const out = await reverifyCandidate({ candidate, key, slug, config }, io);
      if (!NON_PROGRESS.has(out.deferred)) return { ...out, mode: config.mode };
      lastDeferral = out;
    } catch (e) {
      firstError ??= e;
    }
  }
  if (lastDeferral) return { ...lastDeferral, mode: config.mode };
  throw firstError;
}

/** Deferrals that leave the hold live and unchanged: the next candidate is tried instead of stopping here. */
const NON_PROGRESS = new Set(['fix-claimed', 'hold-ended']);

async function reverifyCandidate({ candidate, key, slug, config }, io) {
  const { pr, hold, attempts } = candidate;
  const post =(result, detail = '') => io.comment(slug, pr.number, buildLoadFlakeResolvedComment({ altSha: hold.alt.sha, result, detail }));
  const check = async () => {
    const live = await io.readPr(slug, pr.number);
    if (live.state !== 'OPEN' || live.headRefName !== pr.headRefName || live.headRefOid !== pr.headRefOid) {
      await post('head-moved');
      return { deferred: 'head-moved' };
    }
    if (!loadFlakeHoldState({ comments: live.comments, headRefOid: live.headRefOid }).live) return { deferred: 'hold-ended' };
    if (await io.pushRefusal({ repo: key, branch: live.headRefName })) return { deferred: 'fix-claimed' };
    return null;
  };
  let refusal = await check();
  if (refusal) return refusal;
  if (attempts >= config.maxAttempts) { await post('exhausted'); return { result: 'exhausted' }; }
  // Legacy holds have no recorded head: the fresh discovery head is still required as an ancestor.
  try {
    await io.prepare(slug, hold.alt.branch, pr.headRefName);
  } catch (e) {
    // A deleted alt (or head) branch can never be pushed: end the hold. Any other fetch failure is transient and rethrown.
    if (!/couldn't find remote ref/i.test(`${e?.stderr ?? ''}\n${e?.message ?? ''}`)) throw e;
    await post('head-moved', 'The saved alt branch no longer exists on the remote, so it can no longer be pushed.');
    return { deferred: 'alt-gone' };
  }
  if (!await io.isAncestor(pr.headRefOid, hold.alt.sha)) {
    // The PR moved past the saved repair: end the hold so reconcile hands the PR back and this pass stops re-picking it.
    await post('head-moved', 'The saved alt commit is not a descendant of the PR head, so it can no longer be pushed.');
    return { deferred: 'non-ancestor' };
  }
  // Lease at the saved alt BRANCH (lane-pool resolves origin/<ref>); the head check below pins the exact sha.
  const lane = await io.acquire(hold.alt.branch, pr.number, key);
  try {
    // Acquire must actually have checked out the saved commit, not a newer branch tip.
    if (await io.head(lane.path) !== await io.resolveSha(hold.alt.sha, lane.path)) {
      // The alt branch moved past the recorded sha (a re-push posts its own new hold): this hold can never be
      // verified as recorded, so end it instead of re-picking it every sweep.
      await post('head-moved', 'The saved alt branch moved past the recorded commit, so the recorded repair can no longer be verified.');
      return { deferred: 'lane-head-mismatch' };
    }
    if (config.mode !== 'ci') {
      const verification = await io.verify(lane.path);
      if (!verification.ok) {
        // Verify can run 40 minutes: a red result for a PR that moved, or whose hold ended, meanwhile is stale and must
        // never post a terminal `exhausted` (or burn an attempt) against the current head.
        refusal = await check();
        if (refusal) return refusal;
        const result = attempts + 1 >= config.maxAttempts ? 'exhausted' : 'red-again';
        // Verify output is branch-authored text headed for a public comment: redact it, then cut.
        await post(result, redactSecrets(verification.summary ?? '').slice(-1500));
        return { result };
      }
    }
    refusal = await check();
    if (refusal) return refusal;
    await io.push(lane.path, hold.alt.sha, pr.headRefName);
    await post('pushed', config.mode === 'ci'
      ? "Pushed without a local re-verify (WE_LOAD_FLAKE_REVERIFY_MODE=ci); the PR's CI judges it." : '');
    return { result: 'pushed', pr: pr.number };
  } finally {
    await io.release(lane, key);
  }
}

/** The branch under verify is fixer-authored code: run it without the daemon's GitHub App credentials or any token.
 *  HOME is kept (npm and git need it), so credentials already stored under it are NOT hidden from the verify child. */
export function scrubVerifyEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^WE_GITHUB_APP_|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL/i.test(k)));
}

export function defaultReverifyIo({ run = execFileSync, runVerification = runBounded, root = resolve(dirname(fileURLToPath(import.meta.url)), '../..') } = {}) {
  const command = (bin, args, opts = {}) => run(bin, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts });
  const gh = (args) => JSON.parse(command('gh', args));
  const lanePool = (...args) => command(process.execPath, [resolve(root, 'scripts/lane-pool.mjs'), ...args]);
  return {
    now: Date.now, loadavg: os.loadavg, cpuCount: () => os.cpus().length,
    listPrs: (slug) => gh(['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid,baseRefName,comments']),
    readPr: (slug, pr) => gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,headRefName,headRefOid,comments']),
    pushRefusal,
    isAncestor: (head, sha) => {
      try { command('git', ['merge-base', '--is-ancestor', head, sha]); return true; }
      catch (e) { if (e.status === 1) return false; throw e; }
    },
    prepare: (slug, alt, head) => command('git', ['fetch', `https://github.com/${slug}.git`, `refs/heads/${alt}`, `refs/heads/${head}`]),
    // The pool is the daemon checkout's own (same origin as every other lane acquire).
    acquire: (ref, pr) => JSON.parse(lanePool('acquire', `--base=${ref}`, `--purpose=load-flake-reverify-${pr}`, '--json')),
    release: (lane) => lanePool('release', `--lane=${lane.lane}`, `--session=${lane.holder}`),
    head: (cwd) => command('git', ['rev-parse', 'HEAD'], { cwd }).trim(),
    resolveSha: (sha, cwd) => command('git', ['rev-parse', `${sha}^{commit}`], { cwd }).trim(),
    verify: async (cwd) => {
      // Kill the entire verification process group on timeout before releasing its lane.
      try { await runVerification(process.execPath, [resolve(root, 'scripts/verify-lane.mjs')], { cwd, env: scrubVerifyEnv(), timeoutMs: 40 * 60_000, maxBytes: 16 * 1024 * 1024 }); return { ok: true }; }
      catch (e) { return { ok: false, summary: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.slice(-1500) }; }
    },
    // Pushed from the daemon's own checkout, never the lane: the lane just ran fixer-authored code that could have
    // planted hooks or git config there. `prepare` already fetched the saved commit into this checkout. Hooks are
    // off, and a plain refspec (no force) means a non-fast-forward is refused.
    push: (_laneCwd, sha, branch) => command('git', ['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', 'origin', `${sha}:refs/heads/${branch}`]),
    comment: (slug, pr, body) => command('gh', ['pr', 'comment', String(pr), '--repo', slug, '--body', body]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action !== 'sweep') throw new Error('usage: load-flake-reverify.mjs sweep [--repo=we] [--dry-run] [--max-load-per-core=N] [--json]');
  const flags = Object.fromEntries(args.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
  const result = await runLoadFlakeReverify({ repo: flags.repo ?? REVERIFY_DEFAULT_REPO, dryRun: !!flags['dry-run'], config: reverifyConfig(process.env, flags['max-load-per-core']) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
