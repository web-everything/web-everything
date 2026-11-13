/** Recover PR checks with a synchronize event, never workflow_dispatch (#3209).
 * Uses a scratch bare repository: no daemon checkout, index or branch is changed.
 * A marked recovery tip is never nudged again, even if posting its comment failed.
 */
import { mkdtempSync, readFileSync, rmSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { recoveryPreflight, recoveryPushCredential } from './recovery-preflight.mjs';
export { recoveryPushCredential } from './recovery-preflight.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { MISSING_RUN_CREDENTIAL_REFUSAL, DEFAULT_MISSING_RUN_THRESHOLD_MS } from './main-red-recovery.mjs';
import { daemonConveyorStateRoot } from '../lib/daemon-last-good.mjs';
import { resolveHandoffSettings } from '../lib/handoff-settings.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { isCacheFresh, defaultCachePath } from '../lib/github-app-auth-env.mjs';
import { installationForOwner, ownerOfSlug, installationCachePath } from '../lib/github-app-installations.mjs';

export const RECOVERY_COMMIT_MARKER = 'Conveyor-Missing-Run-Recovery:';

const defaultReadCache = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** The push token for `repo`'s OWNER (xgq539z). One App installation covers ONE account, so the daemon's own
 *  env token (a web-everything installation) cannot push to a plateauapp PR, and `gh auth token` cannot tell
 *  which owner is wanted. The per-owner cache the gh shim reads is minted by our own code, so a fresh entry
 *  bound to the owner's installation is trusted. Returns null when none applies (caller falls back).
 *  @returns {string|null} */
export function ownerInstallationToken(repo, { env = process.env, readCache = defaultReadCache, now = Date.now() } = {}) {
  const id = installationForOwner(ownerOfSlug(repo), env);
  if (!id) return null;
  const cached = readCache(installationCachePath(defaultCachePath(), id));
  if (!isCacheFresh(cached, now) || String(cached.installationId) !== String(id)) return null;
  return typeof cached.token === 'string' && cached.token.startsWith('ghs_') ? cached.token : null;
}

/** Take the ONE dispatch reservation for `key` (repo + exact head). An exclusive file create is atomic across
 *  processes, so two ticks can never both win, unlike the run listing, which lags a fresh dispatch by seconds.
 *  The reservation is never released: a POST whose outcome is unknown must not be repeated, and a head that
 *  still has no checks goes to ci-heal. Returns false when already taken; throws (caller fails closed) when it
 *  cannot be written.
 *  @returns {boolean} */
export function reserveMissingRunDispatch(key, { env = process.env } = {}) {
  const dir = join(daemonConveyorStateRoot(env), 'missing-run-dispatch');
  mkdirSync(dir, { recursive: true });
  try {
    closeSync(openSync(join(dir, `${createHash('sha256').update(key).digest('hex')}.reserved`), 'wx'));
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

export function pushMissingRunCommit(d, options = {}) {
  const {
  repo, defaultBranch = 'main', exec = execFileSyncThrottled, env = process.env,
  checkClaim = pushRefusal, readCache = defaultReadCache, now = Date.now(),
  reserveDispatch = (key) => reserveMissingRunDispatch(key, { env }),
  } = options;
  const action = 'pull-request-push';
  const defer = (error) => ({ ok: false, action, deferred: true, error });
  let scratch;
  let stage = 'preflight';
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: resolveChildTimeoutMs(env), killSignal: 'SIGKILL', env };
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !Number.isSafeInteger(d?.prNumber)
      || !/^[a-f0-9]{40}$/.test(d?.headSha || '') || !d?.headRefName?.startsWith('lane/')) {
      return defer('recovery requires a repository, PR number, exact head SHA and lane branch');
    }
    // Bypass the shared listing: a cached UNKNOWN or a head changed by a fixer is
    // not authority to mutate. Conflicts belong to the conflict-repair dispatcher.
    const pr = JSON.parse(exec('gh', ['api', `repos/${repo}/pulls/${d.prNumber}`], opts));
    if (pr.state !== 'open' || pr.head?.sha !== d.headSha || pr.head?.ref !== d.headRefName) return defer('PR head or state changed');
    // A stacked or fork PR can never be recovered by this path. Unlike the transient
    // deferrals, report it as a counted failure so the sweep posts a marker and the
    // per-sha cap hands it off instead of re-planning it every tick forever.
    if (pr.head?.repo?.full_name !== repo || pr.base?.ref !== defaultBranch) {
      return { ok: false, action, error: `PR is stacked or from a fork (base ${pr.base?.ref ?? '?'}, head repo ${pr.head?.repo?.full_name ?? '?'}); missing-run push recovery only handles same-repo PRs on ${defaultBranch}` };
    }
    if (pr.mergeable !== true) return defer(pr.mergeable === false ? 'PR has merge conflicts; conflict repair must run first' : 'PR mergeability is unknown; retry after GitHub recalculates');
    const claim = () => checkClaim({ repo, branch: d.headRefName });
    const held = claim();
    if (held !== null) return defer(held?.message || 'fix claim held or unreadable; needs human/ci-heal inspection');
    stage = 'credential';
    // Prefer the repo OWNER's own installation token (xgq539z) so a plateauapp/frontier-ui PR is pushed with
    // an identity that can write to it, even when the daemon's env token belongs to another org.
    const ownerToken = ownerInstallationToken(repo, { env, readCache, now });
    const token = String(ownerToken || env.GH_TOKEN || env.GITHUB_TOKEN || exec('gh', ['auth', 'token', '--hostname', 'github.com'], opts)).trim();
    // An ineligible credential is structural (config, not a race): count it so the per-sha cap hands the PR
    // off instead of re-planning it every tick forever.
    if (!ownerToken && !recoveryPushCredential(token, env)) return { ok: false, action, error: MISSING_RUN_CREDENTIAL_REFUSAL };
    // Explicit admission inputs opt into the full contract. Presence (even an
    // undefined value) matters: incomplete inputs must fail closed. Legacy
    // callers without these inputs retain their existing writer checks.
    if (['recoveryEvidence', 'attemptsForSha', 'attemptsForPr', 'maxRetriesPerSha', 'maxRetriesPerPr']
      .some(key => Object.hasOwn(options, key))) {
      const admission = recoveryPreflight({ ...options, repo, head: d.headSha, headRefName: d.headRefName,
        defaultBranch, claimed: false, token,
        env: ownerToken ? { ...env,
          WE_GH_AUTH_INSTALLATION: String(installationForOwner(ownerOfSlug(repo), env)),
          WE_GH_AUTH_TOKEN_HASH: createHash('sha256').update(token).digest('hex'),
        } : env,
        pr: { state: pr.state, baseRefName: pr.base.ref, isCrossRepository: false,
          mergeable: 'MERGEABLE', headRefOid: pr.head.sha, headRefName: pr.head.ref },
      });
      if (!admission.allow) return defer(admission.reason);
    }
    scratch = mkdtempSync(join(tmpdir(), 'we-missing-run-'));
    // Pin git to the credential just validated, overriding stored helpers and auth
    // headers. The secret is only in the child environment, never argv or logs.
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
    const gitOpts = { ...opts, cwd: scratch, env: { ...gitEnv, WE_CI_PUSH_TOKEN: token,
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } };
    const git = (...args) => String(exec('git', ['-c', 'http.extraHeader=', '-c', 'credential.helper=',
      '-c', 'credential.helper=!f() { echo username=x-access-token; printf "password=%s\\n" "$WE_CI_PUSH_TOKEN"; }; f', ...args], gitOpts)).trim();
    stage = 'fetch';
    git('init', '--bare', '.');
    const remote = `https://github.com/${repo}.git`;
    const ref = `refs/heads/${d.headRefName}`;
    git('fetch', '--no-tags', remote, ref);
    if (git('rev-parse', 'FETCH_HEAD') !== d.headSha) return defer('branch moved before recovery');
    const message = git('show', '-s', '--format=%B', d.headSha);
    if (message.split('\n').some(line => line.startsWith(RECOVERY_COMMIT_MARKER))) {
      // Live 2026-11-11 (#6684/#6633): the marked empty commit produced no pull_request run either. A second empty
      // commit cannot help, but a workflow_dispatch of ci.yml on the branch reports `test`/`smoke` on this head
      // (the manual fix). ONE dispatch per head is enforced by the atomic reservation taken below, NOT by this run
      // listing, which lags a fresh dispatch by seconds. The listing only refuses early: a ci.yml run that is
      // running/done, or any earlier workflow_dispatch, blocks; a fresh queued one is left alone; a stuck one passes.
      stage = 'dispatch';
      const ghEnv = { ...gitEnv, GH_TOKEN: token };
      const existing = JSON.parse(String(exec('gh', ['api', `repos/${repo}/actions/runs?head_sha=${d.headSha}&per_page=100`], { ...opts, env: ghEnv })));
      if (!Number.isSafeInteger(existing.total_count) || existing.total_count < 0 || existing.total_count >= 100
        || !Array.isArray(existing.workflow_runs) || existing.workflow_runs.length !== existing.total_count) {
        return defer('head runs unreadable or incomplete; needs ci-heal inspection');
      }
      // Live #6684/#6633: the pull_request ci.yml run sat `queued` for hours and never reported a check, so a bare
      // "a run exists" guard would refuse exactly the stuck case. A fresh queued/pending run is left alone; a
      // queued run older than the missing-run threshold is stuck. Any earlier dispatch on this head blocks (one per head).
      // The stuck window is the SAME setting the sweep used to call this head overdue (ciMissingAfterPushMin), never
      // a second constant: a window longer than the sweep's would call a stuck run "young" and spend the recovery
      // retries (missingRunRetriesPerSha) on refusals before CI is ever dispatched.
      // Resolved only here (the one place it matters), so a plain push logs no setting provenance.
      const configured = options.thresholdMs ?? resolveHandoffSettings('fix', { env }).value.ciMissingAfterPushMin * 60_000;
      const stuckAfterMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MISSING_RUN_THRESHOLD_MS;
      // 'terminal' = CI was already dispatched, or a ci.yml run is running/done/undatable: counted, ci-heal's job.
      // 'young' = a datable ci.yml run still queued inside the window: merely slow, so a FREE deferral (no counted
      // attempt), retried next tick until it either starts or ages past the window and the dispatch is allowed.
      const classify = (run) => {
        // A run whose workflow path cannot be read might be a ci.yml run: block rather than skip it.
        if (typeof run?.path !== 'string' || run.path === '') return 'terminal';
        if (!run.path.includes('ci.yml')) return 'none';
        if (run?.event === 'workflow_dispatch') return 'terminal';
        if (!['queued', 'waiting', 'pending', 'requested'].includes(String(run?.status))) return 'terminal';
        const created = Date.parse(run?.created_at);
        if (!Number.isFinite(created)) return 'terminal';
        return (now - created) < stuckAfterMs ? 'young' : 'none';
      };
      const kinds = existing.workflow_runs.map(classify);
      if (kinds.includes('terminal')) {
        return { ok: false, action, error: 'recovery commit still has no PR checks and CI was already dispatched for this head; needs ci-heal, not another trigger' };
      }
      if (kinds.includes('young')) return defer('a pull_request ci.yml run is still queued within the missing-run window; retrying next tick');
      // Re-check ownership and the exact head right before mutating (the push path does the same via its lease).
      const heldAtDispatch = claim();
      if (heldAtDispatch !== null) return defer(heldAtDispatch?.message || 'fix claim held or unreadable; needs human/ci-heal inspection');
      const live = JSON.parse(String(exec('gh', ['api', `repos/${repo}/pulls/${d.prNumber}`], { ...opts, env: ghEnv })));
      if (live.state !== 'open' || live.head?.sha !== d.headSha || live.head?.ref !== d.headRefName) return defer('PR head or state changed');
      // The listing above only sees runs GitHub has already indexed. The reservation is what makes it ONE dispatch
      // per head: taken after the last re-check and before the POST, never released (see reserveMissingRunDispatch).
      // GitHub slugs are case-insensitive: one key for `Org/Repo` and `org/repo`.
      if (!reserveDispatch(`${repo.toLowerCase()}@${d.headSha}`)) {
        return { ok: false, action, error: 'ci.yml dispatch already reserved for this head (taken by an earlier attempt, which may not have completed); needs ci-heal, not another trigger' };
      }
      exec('gh', ['api', '-X', 'POST', `repos/${repo}/actions/workflows/ci.yml/dispatches`, '-f', `ref=${d.headRefName}`], { ...opts, env: ghEnv });
      return { ok: true, action, dispatched: true };
    }
    const tree = git('rev-parse', `${d.headSha}^{tree}`);
    stage = 'commit-tree';
    const newHeadSha = git('-c', 'user.name=Web Everything', '-c', 'user.email=conveyor@users.noreply.github.com',
      'commit-tree', tree, '-p', d.headSha, '-m', `ci: recover missing PR checks\n\n${RECOVERY_COMMIT_MARKER} ${d.headSha}`);
    if (!/^[a-f0-9]{40}$/.test(newHeadSha)) throw new Error('invalid commit');
    const heldAtPush = claim();
    if (heldAtPush !== null) return defer(heldAtPush?.message || 'fix claim held or unreadable; needs human/ci-heal inspection');
    stage = 'push';
    git('push', `--force-with-lease=${ref}:${d.headSha}`, remote, `${newHeadSha}:${ref}`);
    return { ok: true, action, newHeadSha };
  } catch {
    // exec errors carry argv/env; never serialize a credential-bearing child error.
    return { ok: false, action, error: `missing-run recovery failed during ${stage}` };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
