/** Local verify / host-load counterpart to #4999 (CI per-test flake scoring and quarantine).
 * Pure planning plus injectable IO. A quiet host retries one saved fix, never force-pushing.
 */
import os from 'node:os';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { runBounded } from '../lib/bounded-child.mjs';
import { resolveMergeMainBeforeRetry, logMergeMainSource, describeMergeMain, defaultMergeMain } from './load-flake-merge-main.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { loadFlakeResults, buildLoadFlakeResolvedComment, buildLoadFlakeRedispatchResolvedComment } from './stand-down.mjs';
import { loadFlakeHoldState, pushedLoadFlakeFixOwedRearm, loadFlakeAttemptResults } from './load-flake-hold.mjs';
import { enrichPrsWithCompleteComments } from './pr-comments-complete.mjs';
import { redactSecrets } from './ci-heal-mark.mjs';
import { RUNNER_LOCK_ROOT } from '../../skills-src/conveyor/runner-lock.mjs';

export const VERIFY_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'CI', 'NODE_ENV', 'NODE_OPTIONS', 'FORCE_COLOR', 'NO_COLOR',
  'LANE_POOL_ROOT', 'CONVEYOR_RUNNER_LOCK_ROOT', 'PLAYWRIGHT_BROWSERS_PATH', 'WE_VITEST_MAX_WORKERS',
  'SHELL', 'USER', 'LOGNAME', 'WE_HEAVY_*', 'npm_config_*',
]);
const VERIFY_SECRET = /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|API_KEY|ACCESS_KEY|AUTH|SSH_AUTH_SOCK|^WE_GITHUB_APP_/i;
// npm reads these names in ANY case (npm_config_*, NPM_CONFIG_*, mixed), so the match is case-insensitive.
// Beyond auth/key/cert material this also covers proxy and registry knobs (their URLs can embed `user:pass@`),
// one-time passwords, passphrases and CA bundles (`ca`, `cafile`).
const NPM_CREDENTIAL_CONFIG = /^npm_config_(?:.*(?:token|auth|password|key|secret|cert|userconfig|globalconfig|proxy|registry|otp|passphrase).*|cafile|ca)$/i;
// A URL carrying `user:pass@` credentials in ANY allowed value is dropped, whatever the variable is called.
const URL_CREDENTIALS = /:\/\/[^/\s:@]*:[^/\s@]*@/;
// Path-valued knobs: a literal leading `~` must resolve against the REAL home, not the scratch HOME the child gets.
const VERIFY_PATH_VARS = new Set(['LANE_POOL_ROOT', 'CONVEYOR_RUNNER_LOCK_ROOT', 'PLAYWRIGHT_BROWSERS_PATH']);
const expandTilde = (value, home) => (home && (value === '~' || value.startsWith('~/')) ? join(home, value.slice(1)) : value);

export function reverifyConfig(env = process.env, maxLoadPerCore) {
  const verifyEnvAllow = (env.WE_LOAD_FLAKE_VERIFY_ENV_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (verifyEnvAllow.some((name) => VERIFY_SECRET.test(name))) throw new Error('secret name in WE_LOAD_FLAKE_VERIFY_ENV_ALLOW');
  if (verifyEnvAllow.some((name) => NPM_CREDENTIAL_CONFIG.test(name))) throw new Error('npm credential-config name in WE_LOAD_FLAKE_VERIFY_ENV_ALLOW');
  const positive = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid reverify limit: ${value}`);
    return n;
  };
  return {
    verifyEnvAllow,
    maxLoadPerCore: positive(maxLoadPerCore ?? env.WE_LOAD_FLAKE_REVERIFY_MAX_LOAD_PER_CORE, 0.75),
    maxAttempts: Math.max(1, Math.floor(positive(env.WE_LOAD_FLAKE_REVERIFY_MAX_ATTEMPTS, 3))),
    cooloffMs: positive(env.WE_LOAD_FLAKE_REVERIFY_COOLOFF_MIN, 30) * 60_000,
    mode: reverifyMode(env),
    // #xg0rkxn — merge current main into the head before a quiet-host retry (policy-cascade shape, source logged).
    mergeMainBeforeRetry: resolveMergeMainBeforeRetry({ env }).value,
  };
}

/** `local` (default) re-verifies the held fix on this host; `ci` pushes it unverified so the PR's CI judges it. */
function reverifyMode(env) {
  const mode = env.WE_LOAD_FLAKE_REVERIFY_MODE ?? 'local';
  if (!['local', 'ci'].includes(mode)) throw new Error('invalid reverify mode');
  return mode;
}

export function planLoadFlakeReverify({ prs = [], load, cores, now, config = reverifyConfig({}) }) {
  const quiet = cores > 0 && load.length >= 2 && load.slice(0, 2).every((n) => Number.isFinite(n) && n / cores <= config.maxLoadPerCore);
  let loadDeferred = false;
  if (config.mode !== 'ci' && !quiet) {
    return { deferred: 'host-load' };
  }
  const candidates = prs.flatMap((pr) => {
    const state = loadFlakeHoldState({ comments: pr.comments, headRefOid: pr.headRefOid, now });
    if (!state.live) return [];
    if (state.hold.redispatch) {
      if (!quiet) { loadDeferred = true; return []; }
      return [{ pr, ...state, attempts: loadFlakeAttemptResults(pr.comments).filter((r) => r.redispatch && r.result === 'redispatched').length }];
    }
    const reds = loadFlakeAttemptResults(pr.comments).filter((r) => r.sha === state.hold.alt.sha && r.result === 'red-again');
    if (reds.length && now - Date.parse(reds.at(-1).createdAt) < config.cooloffMs) return [];
    return [{ pr, ...state, attempts: reds.length }];
  }).sort((a, b) => Date.parse(a.hold.createdAt) - Date.parse(b.hold.createdAt));
  return candidates.length ? { candidate: candidates[0], candidates } : { deferred: loadDeferred ? 'host-load' : 'no-candidate' };
}

/** Programmatic default stays WE; the CLI sweeps the constellation when no repo is specified. */
export const REVERIFY_DEFAULT_REPO = 'we';
export const REVERIFY_SWEEP_REPOS = Object.keys(CONSTELLATION_REPOS);

export async function runLoadFlakeReverify({ repo = REVERIFY_DEFAULT_REPO, dryRun = false, config = reverifyConfig() } = {}, io = defaultReverifyIo(config)) {
  const now = io.now();
  const load = io.loadavg();
  const cores = io.cpuCount();
  const key = repoKeyForSlug(repo);
  if (!key) throw new Error(`unknown repo: ${repo}`);
  const slug = CONSTELLATION_REPOS[key].slug;
  const prs = await io.listPrs(slug);
  // A pushed fix is a finished fix round: re-arm it before anything else (needs no verify, so host load cannot defer it).
  const rearmed = dryRun ? [] : await rearmPushedFixes({ prs, slug }, io);
  const plan = { ...planLoadFlakeReverify({ prs, load, cores, now, config }), ...(rearmed.length ? { rearmed } : {}) };
  // Holding is the common case: name every PR it holds and the load it saw, so the log proves the pass is
  // evaluating them (a bare "host-load" line cannot be told apart from a pass that sees no holds). Read-only.
  if (plan.deferred === 'host-load') {
    return { ...plan, load: load.slice(0, 2).map((n) => Math.round(n * 100) / 100), cores, maxLoadPerCore: config.maxLoadPerCore,
      holds: prs.flatMap((pr) => {
        const state = loadFlakeHoldState({ comments: pr.comments, headRefOid: pr.headRefOid, now });
        return state.live ? [{ pr: pr.number, alt: state.hold.alt.branch, altSha: state.hold.alt.sha, ...(state.hold.redispatch ? { redispatch: true } : {}) }] : [];
      }) };
  }
  if (!plan.candidate || dryRun) return { ...plan, dryRun };
  // Take candidates oldest-first until one makes progress. A hold that cannot be worked right now (fix claim
  // live, transient fetch failure) must never starve the younger holds behind it; a hold that can NEVER be worked
  // is ended on the PR instead, so it stops being picked at all.
  let firstError = null;
  let lastDeferral = null;
  const redispatched = [];
  const finish = (out) => ({ ...out, ...(rearmed.length ? { rearmed } : {}), ...(redispatched.length ? { redispatched } : {}) });
  // Cheap redispatches all run first; then the saved-fix path still stops after one progress outcome.
  for (const candidate of plan.candidates.filter((c) => c.hold.redispatch)) {
    try {
      redispatched.push({ pr: candidate.pr.number, ...await reverifyCandidate({ candidate, key, slug, config, load, cores }, io) });
    } catch (e) {
      redispatched.push({ pr: candidate.pr.number, error: String(e?.message ?? e) });
    }
  }
  for (const candidate of plan.candidates.filter((c) => !c.hold.redispatch)) {
    try {
      const out = await reverifyCandidate({ candidate, key, slug, config }, io);
      if (!NON_PROGRESS.has(out.deferred)) return finish(out);
      lastDeferral = out;
    } catch (e) {
      firstError ??= e;
    }
  }
  if (lastDeferral) return finish(lastDeferral);
  if (redispatched.length) return finish(firstError ? { error: String(firstError.message ?? firstError) } : {});
  throw firstError;
}

/** Deferrals that leave the hold live and unchanged: the next candidate is tried instead of stopping here. */
const NON_PROGRESS = new Set(['fix-claimed', 'hold-ended', 'hold-changed']);

/**
 * Re-arm every bounced PR whose head is a fix this pass pushed (live #4361). The fixer that wrote the fix stood down on
 * the load-flake hold, so it never ran the re-arm a normal fix round ends with; without it the PR keeps
 * `review:changes` on a head that already is the fix, and reconcile reads it as "owed a fix" forever. Re-reads the PR
 * right before acting, and a failure on one PR never stops the others.
 */
export async function rearmPushedFixes({ prs = [], slug }, io) {
  const out = [];
  for (const pr of prs) {
    if (!pushedLoadFlakeFixOwedRearm(pr)) continue;
    try {
      const live = await io.readPr(slug, pr.number);
      const owed = live.state === 'OPEN' && live.headRefOid === pr.headRefOid && pushedLoadFlakeFixOwedRearm(live);
      if (!owed) continue;
      await io.rearm(slug, pr.number);
      out.push({ pr: pr.number, sha: owed.sha, result: 'rearmed' });
    } catch (e) {
      out.push({ pr: pr.number, result: 'rearm-failed', error: String(e?.message ?? e).split('\n')[0].slice(0, 300) });
    }
  }
  return out;
}

async function reverifyCandidate({ candidate, key, slug, config, load, cores }, io) {
  const { pr, hold, attempts } = candidate;
  let mergeMain = null;
  const post = (result, text = '') => {
    // The merge note goes LAST: the comment builders keep the final 1500 characters.
    const detail = [text, describeMergeMain(mergeMain)].filter(Boolean).join('\n\n');
    return io.comment(slug, pr.number, hold.redispatch
      ? buildLoadFlakeRedispatchResolvedComment({ result, detail })
      : buildLoadFlakeResolvedComment({ altSha: hold.alt.sha, result, detail }));
  };
  const check = async () => {
    const live = await io.readPr(slug, pr.number);
    if (live.state !== 'OPEN' || live.headRefName !== pr.headRefName || live.headRefOid !== pr.headRefOid) {
      await post('head-moved');
      return { deferred: 'head-moved' };
    }
    const state = loadFlakeHoldState({ comments: live.comments, headRefOid: live.headRefOid });
    if (!state.live) return { deferred: 'hold-ended' };
    if (state.hold.alt.branch !== hold.alt.branch || state.hold.alt.sha !== hold.alt.sha || state.hold.createdAt !== hold.createdAt) return { deferred: 'hold-changed' };
    if (await io.pushRefusal({ repo: key, branch: live.headRefName })) return { deferred: 'fix-claimed' };
    return null;
  };
  let refusal = await check();
  if (refusal) return refusal;
  // #xg0rkxn (live plateau #220): a re-dispatch on the old head re-runs without whatever main fixed meanwhile (#221, the
  // very timing tests that flaked). Merge main into the head first; a conflict is left to the conflict-fix path.
  if (hold.redispatch && attempts < config.maxAttempts && config.mergeMainBeforeRetry && typeof io.mergeMain === 'function') {
    mergeMain = await io.mergeMain({ slug, branch: pr.headRefName, headSha: pr.headRefOid, base: pr.baseRefName || 'main' });
    if (mergeMain?.result !== 'up-to-date') console.error(`load-flake reverify: ${slug}#${pr.number} main ${mergeMain?.result}${mergeMain?.sha ? ` → ${mergeMain.sha.slice(0, 9)}` : ''} before the retry`);
  }
  if (hold.redispatch) {
    const result = attempts >= config.maxAttempts ? 'exhausted' : 'redispatched';
    await post(result, result === 'redispatched'
      ? `host load ${load.slice(0, 2).map((n) => Math.round(n * 100) / 100).join('/')} on ${cores} cores ≤ ${config.maxLoadPerCore}/core; the fix loop re-dispatches a fixer against the same review findings (attempt ${attempts + 1} of ${config.maxAttempts})` : '');
    return { result, pr: pr.number };
  }
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
    // The push ends the fixer's round, so it owes the round's re-arm (live #4361). A failure here is retried by the
    // catch-up at the top of the next sweep.
    let rearm = [];
    const bounced = (pr.labels ?? []).some((l) => (typeof l === 'string' ? l : l?.name) === 'review:changes');
    if (bounced) try {
      rearm = await rearmPushedFixes({ prs: [{ ...(await io.readPr(slug, pr.number)), number: pr.number }], slug }, io);
    } catch (e) {
      rearm = [{ pr: pr.number, result: 'rearm-failed', error: String(e?.message ?? e).slice(0, 300) }];
    }
    return { result: 'pushed', pr: pr.number, ...(rearm.length ? { rearm: rearm[0].result } : {}) };
  } finally {
    await io.release(lane, key);
  }
}

/** Fixer-authored verification gets only required knobs and explicit non-secret extensions.
 *  HOME and temp paths point into disposable scratch directories, and npm's user/global config paths are dropped so
 *  the child's npm never loads the daemon's ~/.npmrc auth. This is ENV HYGIENE, not a sandbox: the child still runs
 *  as the daemon's OS user and can read credential files by absolute path or reach keychain-backed helpers.
 *  Isolating it from those needs a separate OS user or a sandbox profile. Pure. */
export function scrubVerifyEnv(env = process.env, { allow = [], scratchDir, home = env.HOME || os.homedir() } = {}) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k, v]) => !VERIFY_SECRET.test(k)
    && !/^(HOME|TMPDIR|TMP|TEMP|GIT_ASKPASS)$|^(GITHUB_|GH_|SSH_)/.test(k)
    && !NPM_CREDENTIAL_CONFIG.test(k)
    && !(typeof v === 'string' && URL_CREDENTIALS.test(v))
    && (allow.includes(k) || VERIFY_ENV_ALLOWLIST.some((name) => name.endsWith('*') ? k.startsWith(name.slice(0, -1)) : k === name)))
    .map(([k, v]) => [k, VERIFY_PATH_VARS.has(k) && typeof v === 'string' ? expandTilde(v, home) : v]));
  if (scratchDir) Object.assign(clean, { HOME: join(scratchDir, 'home'), TMPDIR: join(scratchDir, 'tmp'), TMP: join(scratchDir, 'tmp'), TEMP: join(scratchDir, 'tmp') });
  return clean;
}

export function defaultReverifyIo({ run = execFileSync, runVerification = runBounded, verifyEnvAllow = [], readComments, root = resolve(dirname(fileURLToPath(import.meta.url)), '../..') } = {}) {
  const command = (bin, args, opts = {}) => run(bin, args, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts });
  const gh = (args) => JSON.parse(command('gh', args));
  const lanePool = (...args) => command(process.execPath, [resolve(root, 'scripts/lane-pool.mjs'), ...args]);
  return {
    now: Date.now, loadavg: os.loadavg, cpuCount: () => os.cpus().length,
    // `gh pr list --json comments` stops at 100: a hold past that was invisible here while fix-dispatch (which reads the
    // complete thread) kept refusing the PR as `load-flake-hold` (live #4017, 286 comments). Same complete reader as fix-dispatch.
    listPrs: (slug) => enrichPrsWithCompleteComments(
      gh(['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid,baseRefName,labels,comments']),
      { repo: slug, ...(readComments ? { readComments } : {}) }),
    // Complete thread, same as listPrs: a capped read could miss a later re-arm or verdict and re-arm twice.
    readPr: (slug, pr) => {
      const view = { number: pr, ...gh(['pr', 'view', String(pr), '--repo', slug, '--json', 'state,headRefName,headRefOid,labels,comments']) };
      const [complete] = enrichPrsWithCompleteComments([view], { repo: slug, ...(readComments ? { readComments } : {}), onError: (_pr, e) => { throw e; } });
      return complete;
    },
    // The one sanctioned label swap for a finished fix round: review:changes → re-armed (never accepted, never drops review:human).
    rearm: (slug, pr) => command(process.execPath, [resolve(root, 'scripts/conveyor/rearm-review.mjs'), String(pr), `--repo=${slug}`, '--actor=load-flake reverify pass']),
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
      const scratchDir = mkdtempSync(join(os.tmpdir(), 'we-reverify-'));
      try {
        mkdirSync(join(scratchDir, 'home')); mkdirSync(join(scratchDir, 'tmp'));
        const env = scrubVerifyEnv(process.env, { allow: verifyEnvAllow, scratchDir });
        env.CONVEYOR_RUNNER_LOCK_ROOT ??= RUNNER_LOCK_ROOT;
        env.PLAYWRIGHT_BROWSERS_PATH ??= join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright');
        await runVerification(process.execPath, [resolve(root, 'scripts/verify-lane.mjs')], { cwd, env, timeoutMs: 40 * 60_000, maxBytes: 16 * 1024 * 1024 });
        return { ok: true };
      }
      catch (e) { return { ok: false, summary: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.slice(-1500) }; }
      finally {
        // Branch-authored code wrote into this directory: an unremovable entry must never replace the verify result
        // (a throw in `finally` would turn a green or red outcome into a pass-level error and re-pick the candidate).
        try { rmSync(scratchDir, { recursive: true, force: true }); }
        catch (e) { console.warn(`load-flake reverify: could not remove scratch dir ${scratchDir}: ${e.message}`); }
      }
    },
    // Pushed from the daemon's own checkout, never the lane: the lane just ran fixer-authored code that could have
    // planted hooks or git config there. `prepare` already fetched the saved commit into this checkout. Hooks are
    // off, and a plain refspec (no force) means a non-fast-forward is refused.
    push: (_laneCwd, sha, branch) => command('git', ['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', 'origin', `${sha}:refs/heads/${branch}`]),
    comment: (slug, pr, body) => command('gh', ['pr', 'comment', String(pr), '--repo', slug, '--body', body]),
    // #xg0rkxn — merge main into the PR head in this daemon checkout (plumbing only, no force), see load-flake-merge-main.mjs.
    mergeMain: (args) => defaultMergeMain(args, { run, cwd: root }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action !== 'sweep') throw new Error('usage: load-flake-reverify.mjs sweep [--repo=we] [--dry-run] [--max-load-per-core=N] [--json]');
  const flags = Object.fromEntries(args.map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
  const config = reverifyConfig(process.env, flags['max-load-per-core']);
  const mergeMainPolicy = resolveMergeMainBeforeRetry();
  logMergeMainSource(mergeMainPolicy);
  const repos = {};
  for (const repo of flags.repo ? [flags.repo] : REVERIFY_SWEEP_REPOS) {
    try { repos[repo] = await runLoadFlakeReverify({ repo, dryRun: !!flags['dry-run'], config }); }
    catch (e) { repos[repo] = { repo, error: String(e?.message ?? e) }; }
  }
  process.stdout.write(`${JSON.stringify({ mode: config.mode, mergeMainBeforeRetry: { value: mergeMainPolicy.value, source: mergeMainPolicy.source }, repos })}\n`);
}
