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
import { loadFlakeHoldState, loadFlakeResults, buildLoadFlakeResolvedComment } from './stand-down.mjs';

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
  };
}

export function planLoadFlakeReverify({ prs = [], load, cores, now, config = reverifyConfig({}) }) {
  if (!(cores > 0) || load.length < 2 || load.slice(0, 2).some((n) => !Number.isFinite(n) || n / cores > config.maxLoadPerCore)) {
    return { deferred: 'host-load' };
  }
  const candidates = prs.flatMap((pr) => {
    const state = loadFlakeHoldState({ comments: pr.comments, headRefOid: pr.headRefOid, now });
    if (!state.live) return [];
    const reds = loadFlakeResults(pr.comments).filter((r) => r.sha === state.hold.alt.sha && r.result === 'red-again');
    if (reds.length && now - Date.parse(reds.at(-1).createdAt) < config.cooloffMs) return [];
    return [{ pr, ...state, attempts: reds.length }];
  }).sort((a, b) => Date.parse(a.hold.createdAt) - Date.parse(b.hold.createdAt));
  return candidates.length ? { candidate: candidates[0] } : { deferred: 'no-candidate' };
}

export async function runLoadFlakeReverify({ repo = 'we', dryRun = false, config = reverifyConfig() } = {}, io = defaultReverifyIo()) {
  const now = io.now();
  const load = io.loadavg();
  const cores = io.cpuCount();
  const early = planLoadFlakeReverify({ load, cores, now, config });
  if (early.deferred === 'host-load') return early;
  const key = repoKeyForSlug(repo);
  if (!key) throw new Error(`unknown repo: ${repo}`);
  const slug = CONSTELLATION_REPOS[key].slug;
  const plan = planLoadFlakeReverify({ prs: await io.listPrs(slug), load, cores, now, config });
  if (!plan.candidate || dryRun) return { ...plan, dryRun };
  const { pr, hold, attempts } = plan.candidate;
  const post = (result, detail = '') => io.comment(slug, pr.number, buildLoadFlakeResolvedComment({ altSha: hold.alt.sha, result, detail }));
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
  await io.prepare(slug, hold.alt.branch, pr.headRefName);
  if (!await io.isAncestor(pr.headRefOid, hold.alt.sha)) return { deferred: 'non-ancestor' };
  // Lease at the saved alt BRANCH (lane-pool resolves origin/<ref>); the head check below pins the exact sha.
  const lane = await io.acquire(hold.alt.branch, pr.number, key);
  try {
    // Acquire must actually have checked out the saved commit, not a newer branch tip.
    if (await io.head(lane.path) !== await io.resolveSha(hold.alt.sha, lane.path)) return { deferred: 'lane-head-mismatch' };
    const verification = await io.verify(lane.path);
    if (!verification.ok) {
      const result = attempts + 1 >= config.maxAttempts ? 'exhausted' : 'red-again';
      await post(result, String(verification.summary ?? '').slice(-1500));
      return { result };
    }
    refusal = await check();
    if (refusal) return refusal;
    await io.push(lane.path, hold.alt.sha, pr.headRefName);
    await post('pushed');
    return { result: 'pushed', pr: pr.number };
  } finally {
    await io.release(lane, key);
  }
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
      try { await runVerification(process.execPath, [resolve(root, 'scripts/verify-lane.mjs')], { cwd, timeoutMs: 40 * 60_000, maxBytes: 16 * 1024 * 1024 }); return { ok: true }; }
      catch (e) { return { ok: false, summary: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.slice(-1500) }; }
    },
    push: (cwd, sha, branch) => command('git', ['push', 'origin', `${sha}:refs/heads/${branch}`], { cwd }),
    comment: (slug, pr, body) => command('gh', ['pr', 'comment', String(pr), '--repo', slug, '--body', body]),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action !== 'sweep') throw new Error('usage: load-flake-reverify.mjs sweep [--repo=we] [--dry-run] [--max-load-per-core=N] [--json]');
  const flags = Object.fromEntries(args.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
  const result = await runLoadFlakeReverify({ repo: flags.repo ?? 'we', dryRun: !!flags['dry-run'], config: reverifyConfig(process.env, flags['max-load-per-core']) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
