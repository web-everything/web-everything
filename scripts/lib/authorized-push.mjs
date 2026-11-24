/**
 * @file Claim-bound push authority: live PR evidence, ancestry, one leased push, then a hold recheck.
 */
import { spawnSync } from 'node:child_process';
import { readLiveFixClaim, isClaimHolder, repoKeyOf } from '../conveyor/fix-procedure.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { PUSH_HOLD_LABELS } from './review-hold-model.mjs';

const fail = (code, reason) => ({ ok: false, code, reason });
const hex = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fields = 'labels,state,isDraft,headRefOid,headRefName,isCrossRepository';
function git(gitDir, args, spawn = spawnSync) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_REPLACE_REF_BASE', 'GIT_COMMON_DIR',
    'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) delete env[key];
  return spawn('git', ['-c', 'core.commitGraph=false', '-C', gitDir, ...args], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
}
function defaults(io = {}) {
  return {
    readClaim: (repo, pr) => readLiveFixClaim({ repo, pr }), isClaimHolder,
    ghPrView: (repo, pr) => JSON.parse(runGhSync(['pr', 'view', String(pr), '--repo',
      `github.com/${CONSTELLATION_REPOS[repoKeyOf(repo)].slug}`, '--json', fields], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_HOST: 'github.com' },
      throttle: { noMemo: true },
    })),
    isAncestor: (dir, head, sha) => {
      const result = git(dir, ['merge-base', '--is-ancestor', head, sha], io.spawn);
      if (result.error || ![0, 1].includes(result.status)) throw new Error('Ancestry unreadable');
      return result.status === 0;
    },
    readPushUrls: dir => {
      // --push includes pushurl and Git's URL rewrite rules; --all exposes multi-destination pushes.
      const result = git(dir, ['remote', 'get-url', '--push', '--all', 'origin'], io.spawn);
      if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error('Destination unreadable');
      return result.stdout.trim().split('\n');
    },
    gitPush: (dir, args) => git(dir, args, io.spawn), ...io,
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
    if (!entry || !ports.isClaimHolder(entry, holder)) return fail('not-claim-holder', 'Live claim required');
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
  const authority = readPushAuthority(options);
  if (!authority.ok) return authority;
  const { repo, pr, branch, expectedHead, sha, gitDir, purpose } = options;
  const ports = defaults(options.io);
  let urls, entry;
  try {
    urls = ports.readPushUrls(gitDir);
    const slug = CONSTELLATION_REPOS[repoKeyOf(repo)].slug.toLowerCase();
    const matches = url => typeof url === 'string'
      && /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s?#]+?)(?:\.git)?$/i.exec(url)?.[1].toLowerCase() === slug;
    if (!Array.isArray(urls) || urls.length !== 1 || !matches(urls[0]))
      return fail('destination-mismatch', 'Origin push destination must match the authorized repo; repair remote configuration');
  } catch { return fail('unreadable', 'Cannot read origin push destination; repair remote configuration before retrying'); }
  try {
    entry = ports.readClaim(repo, pr);
    if (!entry || !ports.isClaimHolder(entry, options.holder)) return fail('not-claim-holder', 'Live claim required');
  } catch { return fail('unreadable', 'Cannot read push claim; restore evidence before retrying'); }
  try {
    const result = ports.gitPush(gitDir, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no',
      `--force-with-lease=refs/heads/${branch}:${expectedHead}`, urls[0], `${sha}:refs/heads/${branch}`]);
    if (result.status !== 0) return fail('push-rejected', 'Push rejected; re-read authority before retrying');
  } catch { return fail('push-rejected', 'Push failed; inspect remote before retrying'); }
  try {
    const view = readView(ports, repo, pr);
    const reason = held(view) || (view.state !== 'OPEN' ? 'PR is not open'
      : view.isDraft && !entry.meta?.draft ? 'PR drafted outside this claim'
      : view.isCrossRepository ? 'Cross-repository PR' : null);
    if (reason) return { ...fail('pushed-under-hold', reason), pushed: true };
  } catch { return { ...fail('pushed-under-hold', 'Post-push evidence unreadable; block hand-back'), pushed: true }; }
  return { ok: true, pushed: sha, purpose };
}
