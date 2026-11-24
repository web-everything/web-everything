/**
 * @file Claim-bound push authority: live PR evidence, ancestry, one leased push, then a hold recheck.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveRealGhBinary } from './gh-app-shim.mjs';
import { readLiveFixClaim, isClaimHolder, pushRefusal, repoKeyOf } from '../conveyor/fix-procedure.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { PUSH_HOLD_LABELS } from './review-hold-model.mjs';

const fail = (code, reason) => ({ ok: false, code, reason });
const hex = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fields = 'labels,state,isDraft,headRefOid,headRefName,isCrossRepository';
function isolatedGit(gitDir, io, use) {
  const temp = mkdtempSync(join(tmpdir(), 'we-push-'));
  try {
    chmodSync(temp, 0o700);
    const gh = resolveRealGhBinary();
    if (!gh) throw new Error('GitHub CLI unavailable');
    const env = { PATH: '/usr/bin:/bin', HOME: temp, XDG_CONFIG_HOME: temp,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh'),
      GH_HOST: 'github.com' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const config = ['core.hooksPath=/dev/null', 'core.commitGraph=false', 'core.fsmonitor=false',
      'gc.auto=0', 'maintenance.auto=false', 'protocol.allow=never',
      `protocol.${io.protocolAllow || 'https'}.allow=always`, 'http.followRedirects=false', 'http.proxy=',
      'credential.helper=', `credential.helper=!'${gh.replaceAll("'", "'\\''")}' auth git-credential`,
      'credential.interactive=never', 'push.gpgSign=false', 'push.followTags=false', 'push.recurseSubmodules=no']
      .flatMap(value => ['-c', value]);
    const git = (dir, args) => (io.spawn || spawnSync)('/usr/bin/git', [...config, '-C', dir, ...args],
      { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    const checked = (dir, args) => {
      const result = git(dir, args);
      if (result.error || result.status !== 0) throw new Error('Git evidence unreadable');
      return result.stdout;
    };
    checked(temp, ['init', '--bare', '-q', '--template=', temp]);
    const common = resolve(gitDir, checked(gitDir, ['rev-parse', '--git-common-dir']).trim());
    try { if (readFileSync(join(common, 'shallow'), 'utf8').trim()) throw new Error('Shallow repository'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeFileSync(join(temp, 'objects/info/alternates'), `${join(common, 'objects')}\n`);
    const ancestor = (head, sha) => {
      checked(temp, ['cat-file', '-e', `${sha}^{commit}`]);
      const result = git(temp, ['merge-base', '--is-ancestor', head, sha]);
      if (result.error || ![0, 1].includes(result.status)) throw new Error('Ancestry unreadable');
      return result.status === 0;
    };
    return use(temp, git, ancestor);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function defaults(io = {}) {
  return {
    readClaim: (repo, pr) => readLiveFixClaim({ repo, pr }), isClaimHolder,
    branchClaimRefusal: (repo, branch, holder) => pushRefusal({ repo, branch,
      sessionId: holder?.sessionId, who: holder?.who, token: holder?.token, strict: true }),
    ghPrView: (repo, pr) => JSON.parse(runGhSync(['pr', 'view', String(pr), '--repo',
      `github.com/${CONSTELLATION_REPOS[repoKeyOf(repo)].slug}`, '--json', fields], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_HOST: 'github.com' },
      throttle: { noMemo: true },
    })),
    isAncestor: (dir, head, sha) => isolatedGit(dir, io, (_temp, _git, ancestor) => ancestor(head, sha)),
    ...io,
  };
}
function readView(io, repo, pr) {
  const view = io.ghPrView(repo, pr);
  if (!view || typeof view !== 'object' || Array.isArray(view) || !Array.isArray(view.labels)
    || view.labels.some(label => !label || typeof label.name !== 'string')
    || !['OPEN', 'CLOSED', 'MERGED'].includes(view.state) || typeof view.isDraft !== 'boolean'
    || typeof view.isCrossRepository !== 'boolean' || typeof view.headRefName !== 'string'
    || !hex(view.headRefOid)) throw new Error('Incomplete PR evidence');
  return view;
}
const held = view => view.labels.find(label => PUSH_HOLD_LABELS.includes(label.name))?.name;

function claimRefusal(io, entry, holder) {
  if (!entry || !io.isClaimHolder(entry, holder)) return fail('not-claim-holder', 'Live claim required');
  if (!entry.meta?.sessionId && !entry.meta?.tokenHash) return fail('not-claim-holder', 'Unbound claim');
  return null;
}

/** Read-only authority check. Callers supply pins and identity, never cached PR evidence. */
export function readPushAuthority({ repo, pr, branch, expectedHead, sha, gitDir, holder, purpose, io } = {}) {
  try {
    if (!hex(sha) || !hex(expectedHead) || typeof branch !== 'string' || !branch.startsWith('lane/')
      || !branch.slice(5) || typeof repo !== 'string' || !repo.trim()
      || typeof purpose !== 'string' || !purpose.trim() || !Number.isSafeInteger(pr) || pr <= 0
      || typeof gitDir !== 'string' || !gitDir.trim()) return fail('bad-input', 'Invalid push inputs');
    repoKeyOf(repo);
  } catch { return fail('bad-input', 'Unknown repo'); }
  const ports = defaults(io);
  try {
    const entry = ports.readClaim(repo, pr);
    const refusal = claimRefusal(ports, entry, holder);
    if (refusal) return refusal;
    const branchRefusal = ports.branchClaimRefusal(repo, branch, holder);
    if (branchRefusal) return fail(branchRefusal.code || 'foreign-claim', branchRefusal.message || 'Branch has a foreign claim; coordinate with its holder');
    const view = readView(ports, repo, pr);
    if (view.state !== 'OPEN') return fail('pr-not-open', 'PR is not open');
    if (view.isDraft && !entry.meta?.draft) return fail('draft', 'PR drafted outside this claim');
    const label = held(view);
    if (label) return fail('hold-label', label);
    if (view.isCrossRepository) return fail('cross-repo', 'Cross-repository PR');
    if (view.headRefName !== branch) return fail('branch-mismatch', 'PR branch differs');
    if (view.headRefOid !== expectedHead) return fail('head-moved', 'PR head differs');
    if (ports.isAncestor(gitDir, expectedHead, sha) !== true) return fail('not-descendant', 'Push must descend from expected head');
    return { ok: true, purpose };
  } catch { return fail('unreadable', 'Cannot read push authority; restore evidence before retrying'); }
}

/** The push boundary: a rejected lease is never retried. */
export function authorizedPush(options = {}) {
  const { repo, pr, branch, expectedHead, sha, gitDir, purpose } = options;
  const ports = defaults(options.io);
  // Validate and read initial evidence before constructing the isolated transport.
  const authority = readPushAuthority({ ...options, io: { ...ports, isAncestor: () => true } });
  if (!authority.ok) return authority;
  try { return isolatedGit(gitDir, options.io || {}, (temp, git, ancestor) => {
    if ((options.io?.isAncestor || ((_dir, head, next) => ancestor(head, next)))(temp, expectedHead, sha) !== true)
      return fail('not-descendant', 'Push must descend from expected head');
    const url = options.io?.remoteUrl || `https://github.com/${CONSTELLATION_REPOS[repoKeyOf(repo)].slug}.git`;
    const args = ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules',
      `--force-with-lease=refs/heads/${branch}:${expectedHead}`, url, `${sha}:refs/heads/${branch}`];
    const final = readPushAuthority({ ...options, io: { ...ports, isAncestor: () => true } });
    if (!final.ok) return final;
    try {
      const result = ports.gitPush ? ports.gitPush(temp, args) : git(temp, args);
      const lines = result.stdout?.split('\n');
      if (lines?.at(-1) === '') lines.pop();
      const ref = lines?.[1]?.split('\t');
      if (result.error || result.status !== 0 || lines?.length !== 3 || lines[0] !== `To ${url}`
        || lines[2] !== 'Done' || ref?.length !== 3 || ref[0] !== ' '
        || ref[1] !== `${sha}:refs/heads/${branch}` || !/^[a-f0-9]+\.\.[a-f0-9]+$/.test(ref[2]))
        return fail('push-rejected', 'Push rejected; inspect remote and re-read authority before retrying');
    } catch { return fail('push-rejected', 'Push failed; inspect remote before retrying'); }
    const post = defaults(options.io);
    try {
      const entry = post.readClaim(repo, pr);
      const refusal = claimRefusal(post, entry, options.holder);
      if (refusal) return { ...fail('pushed-under-hold', refusal.reason), pushed: true };
      if (post.branchClaimRefusal(repo, branch, options.holder))
        return { ...fail('pushed-under-hold', 'Branch has a foreign claim; coordinate with its holder'), pushed: true };
      const view = readView(post, repo, pr);
      const reason = held(view) || (view.state !== 'OPEN' ? 'PR is not open'
        : view.isDraft && !entry.meta?.draft ? 'PR drafted outside this claim'
        : view.isCrossRepository ? 'Cross-repository PR'
        : view.headRefOid !== sha ? 'Post-push PR head differs'
        : view.headRefName !== branch ? 'Post-push PR branch differs' : null);
      if (reason) return { ...fail('pushed-under-hold', reason), pushed: true };
    } catch { return { ...fail('pushed-under-hold', 'Post-push evidence unreadable; block hand-back'), pushed: true }; }
    return { ok: true, pushed: sha, purpose };
  }); } catch { return fail('unreadable', 'Cannot read isolated push evidence; restore evidence before retrying'); }
}
