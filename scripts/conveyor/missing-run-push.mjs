/** Recover PR checks with a synchronize event, never workflow_dispatch (#3209).
 * Uses a scratch bare repository: no daemon checkout, index or branch is changed.
 * A marked recovery tip is never nudged again, even if posting its comment failed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSyncThrottled, ghAuthIdentity } from '../lib/gh-throttle.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { MISSING_RUN_CREDENTIAL_REFUSAL } from './main-red-recovery.mjs';
import { isCacheFresh, defaultCachePath } from '../lib/github-app-auth-env.mjs';
import { installationForOwner, ownerOfSlug, installationCachePath } from '../lib/github-app-installations.mjs';

export const RECOVERY_COMMIT_MARKER = 'Conveyor-Missing-Run-Recovery:';

export function recoveryPushCredential(token, env = {}) {
  if (!token) return false;
  // Unknown installation tokens include Actions' default GITHUB_TOKEN. Only trust
  // the token-bound provenance set by our installation-token minting code.
  if (token.startsWith('ghs_')) return ghAuthIdentity({ ...env, GH_TOKEN: token }).startsWith('app-installation-');
  return /^(ghp_|github_pat_|gho_)/.test(token);
}

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

export function pushMissingRunCommit(d, {
  repo, defaultBranch = 'main', exec = execFileSyncThrottled, env = process.env,
  checkClaim = pushRefusal, readCache = defaultReadCache, now = Date.now(),
} = {}) {
  const action = 'pull-request-push';
  const defer = (error) => ({ ok: false, action, deferred: true, error });
  let scratch;
  let stage = 'preflight';
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, killSignal: 'SIGKILL', env };
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
    if (held) return defer(held.message);
    stage = 'credential';
    // Prefer the repo OWNER's own installation token (xgq539z) so a plateauapp/frontier-ui PR is pushed with
    // an identity that can write to it, even when the daemon's env token belongs to another org.
    const ownerToken = ownerInstallationToken(repo, { env, readCache, now });
    const token = String(ownerToken || env.GH_TOKEN || env.GITHUB_TOKEN || exec('gh', ['auth', 'token', '--hostname', 'github.com'], opts)).trim();
    // An ineligible credential is structural (config, not a race): count it so the per-sha cap hands the PR
    // off instead of re-planning it every tick forever.
    if (!ownerToken && !recoveryPushCredential(token, env)) return { ok: false, action, error: MISSING_RUN_CREDENTIAL_REFUSAL };
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
    if (message.split('\n').some(line => line.startsWith(RECOVERY_COMMIT_MARKER))) return { ok: false, action, error: 'recovery commit still has no PR checks; needs ci-heal, not another empty commit' };
    const tree = git('rev-parse', `${d.headSha}^{tree}`);
    stage = 'commit-tree';
    const newHeadSha = git('-c', 'user.name=Web Everything', '-c', 'user.email=conveyor@users.noreply.github.com',
      'commit-tree', tree, '-p', d.headSha, '-m', `ci: recover missing PR checks\n\n${RECOVERY_COMMIT_MARKER} ${d.headSha}`);
    if (!/^[a-f0-9]{40}$/.test(newHeadSha)) throw new Error('invalid commit');
    const heldAtPush = claim();
    if (heldAtPush) return defer(heldAtPush.message);
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
