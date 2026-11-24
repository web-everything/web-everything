/**
 * @file Claim-bound push authority: live PR evidence, ancestry, one leased push, then a hold recheck.
 * Not claimed:
 * (i) No defence against code running in the same process. The pre-push hook is the raw-push boundary.
 * (ii) No detection of a human marking ready and then drafting again within one hold. Hold labels are the human signal.
 * (iii) Tracker freshness is only as accurate as the hook's daysBetween.
 * (iv) Legacy unbound claims are fail-closed in strict mode only.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readLiveFixClaim, isClaimHolder, pushRefusal, repoKeyOf } from '../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot, validateFixClaimMeta } from '../conveyor/fix-claim-store.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { protectedBranchNames, staleTrackerPushDecision } from '../guard-prototype-tracker.mjs';
import { POC_REGISTRY_PATH, normalizeRegistry } from './poc-branches.mjs';
import { findTrackerPath, parseTracker } from './prototype-tracker-data.mjs';
import { localToday } from './local-date.mjs';
import { dirname, relative } from 'node:path';
import { pushGuardDecision, readPushLease } from '../guard-git-push.mjs';
import { PUSH_HOLD_LABELS } from './review-hold-model.mjs';

const fail = (code, reason) => ({ ok: false, code, reason });
const hex = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fields = 'labels,state,isDraft,headRefOid,headRefName,isCrossRepository';
function resolveGh(io) {
  if (io.gh) return io.gh; // Private test factory only.
  for (const path of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      const stat = (io.stat || statSync)(path);
      if (stat.isFile() && [0, process.getuid()].includes(stat.uid) && !(stat.mode & 0o022)) return path;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Trusted GitHub CLI unavailable');
}
function childEnv(home) {
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gh'),
    GH_HOST: 'github.com' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
function trackerRefusal({ repo, branch, expectedHead, sha }, temp, git) {
  // Read the hook's registry strictly: its tolerant reader would erase unreadable protection evidence.
  const raw = JSON.parse(readFileSync(POC_REGISTRY_PATH, 'utf8'));
  const registry = normalizeRegistry(raw);
  if (!Array.isArray(raw.branches) || registry.dropped.length) throw new Error('Protection registry unreadable');
  if (repoKeyOf(repo) !== 'we' || !protectedBranchNames(registry).includes(branch)) return null;
  const root = resolve(dirname(POC_REGISTRY_PATH), '../..');
  const tracker = findTrackerPath({ backlogDir: join(root, 'backlog') });
  if (!tracker) return fail('protected-branch', 'Restore prototype tracker before retrying');
  const path = relative(root, tracker);
  const read = args => {
    const result = git(temp, args);
    if (result.error || result.status !== 0) throw new Error('Tracker evidence unreadable');
    return result.stdout;
  };
  const latest = parseTracker(read(['show', `${sha}:${path}`])).latestDate;
  if (!latest) return fail('protected-branch', 'Restore prototype tracker date before retrying');
  const reason = staleTrackerPushDecision({ matchedLines: [{ branch }], trackerLatestDate: latest,
    todayDate: localToday(), touchesTracker: read(['diff', '--name-only', expectedHead, sha]).split('\n').includes(path) });
  return reason ? fail('protected-branch', reason) : null;
}
function isolatedGit(gitDir, io, use) {
  const temp = mkdtempSync(join(tmpdir(), 'we-push-'));
  try {
    chmodSync(temp, 0o700);
    const gh = io.gh;
    if (!gh) throw new Error('GitHub CLI unavailable');
    const env = childEnv(temp);
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
  const lockRoot = fixDispatchClaimRoot(resolveCoordinationRoot({ env: {} }));
  return {
    readClaim: (repo, pr) => readLiveFixClaim({ repo, pr, lockRoot }), isClaimHolder,
    branchClaimRefusal: (repo, branch, holder) => pushRefusal({ repo, branch,
      sessionId: holder?.sessionId, who: holder?.who, token: holder?.token, strict: true, lockRoot }),
    ghPrView: (repo, pr) => JSON.parse((io.runGh || runGhSync)(['pr', 'view', String(pr), '--repo',
      `github.com/${CONSTELLATION_REPOS[repoKeyOf(repo)].slug}`, '--json', fields], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: childEnv(homedir()),
      throttle: { noMemo: true, bin: io.gh },
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

function claimRefusal(io, entry, holder, { repo, pr, branch }) {
  if (!entry || !io.isClaimHolder(entry, holder)) return fail('not-claim-holder', 'Live claim required');
  if (!entry.meta?.sessionId && !entry.meta?.tokenHash) return fail('not-claim-holder', 'Unbound claim');
  const meta = entry.meta;
  if (!validateFixClaimMeta(meta)
    || ('sidecarAt' in entry && (typeof entry.sidecarAt !== 'string'
      || new Date(entry.sidecarAt).toISOString() !== entry.sidecarAt))) throw new Error('Incomplete claim');
  if (meta.repo !== repoKeyOf(repo) || meta.pr !== pr || meta.kind !== 'fixing' || meta.branch !== branch)
    return fail('not-claim-holder', 'Claim does not match requested push');
  return null;
}

// Private factory; only the separate test harness exposes injected ports.
function createAuthorizedPush(testIo = {}) {
/** Read-only authority check. Callers supply pins and identity, never cached PR evidence. */
function readPushAuthority({ repo, pr, branch, expectedHead, sha, gitDir, holder, purpose, io } = {}) {
  try {
    if (!hex(sha) || !hex(expectedHead) || typeof branch !== 'string' || !branch.startsWith('lane/')
      || !branch.slice(5) || typeof repo !== 'string' || !repo.trim()
      || typeof purpose !== 'string' || !purpose.trim() || !Number.isSafeInteger(pr) || pr <= 0
      || typeof gitDir !== 'string' || !gitDir.trim()) return fail('bad-input', 'Invalid push inputs');
    repoKeyOf(repo);
  } catch { return fail('bad-input', 'Unknown repo'); }
  let ports;
  try { ports = defaults({ ...testIo, ...io, gh: io?.gh || resolveGh(testIo) }); } catch { return fail('unreadable', 'Trusted GitHub CLI unavailable'); }
  try {
    const entry = ports.readClaim(repo, pr);
    const refusal = claimRefusal(ports, entry, holder, { repo, pr, branch });
    if (refusal) return refusal;
    const branchRefusal = ports.branchClaimRefusal(repo, branch, holder);
    if (branchRefusal) return fail(branchRefusal.code || 'foreign-claim', branchRefusal.message || 'Branch has a foreign claim; coordinate with its holder');
    const view = readView(ports, repo, pr);
    if (view.state !== 'OPEN') return fail('pr-not-open', 'PR is not open');
    if (view.isDraft && !entry.sidecarAt) return fail('draft', 'PR drafted outside this claim');
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
function authorizedPush(options = {}) {
  const { repo, pr, branch, expectedHead, sha, gitDir, purpose } = options;
  let ports;
  try { ports = defaults({ ...testIo, gh: resolveGh(testIo) }); } catch { return fail('unreadable', 'Trusted GitHub CLI unavailable'); }
  // Validate and read initial evidence before constructing the isolated transport.
  const authority = readPushAuthority({ ...options, io: { ...ports, isAncestor: () => true } });
  if (!authority.ok) return authority;
  try { return isolatedGit(gitDir, ports, (temp, git, ancestor) => {
    if ((testIo.isAncestor || ((_dir, head, next) => ancestor(head, next)))(temp, expectedHead, sha) !== true)
      return fail('not-descendant', 'Push must descend from expected head');
    const url = testIo.remoteUrl || `https://github.com/${CONSTELLATION_REPOS[repoKeyOf(repo)].slug}.git`;
    const args = ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--no-recurse-submodules',
      `--force-with-lease=refs/heads/${branch}:${expectedHead}`, url, `${sha}:refs/heads/${branch}`];
    try {
      const tracker = trackerRefusal(options, temp, git);
      if (tracker) return tracker;
    } catch { return fail('protected-branch', 'Cannot verify prototype tracker; restore evidence before retrying'); }
    let lease = null, leaseReadError = false;
    try {
      lease = readPushLease({ cwd: gitDir, exec: (_bin, args) => {
        const result = git(gitDir, args);
        if (result.error || result.status !== 0) throw new Error('Lease path unreadable');
        return result.stdout;
      } });
    } catch { leaseReadError = true; }
    const guardReason = pushGuardDecision(`${sha} ${sha} refs/heads/${branch} ${expectedHead}`, { lease, leaseReadError });
    if (guardReason) return fail(leaseReadError ? 'unreadable' : 'pinned-checkout', guardReason);
    // Keep the live authority read adjacent to the push: all other probes must finish first.
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
    const post = defaults({ ...testIo, gh: ports.gh });
    try {
      const entry = post.readClaim(repo, pr);
      const refusal = claimRefusal(post, entry, options.holder, { repo, pr, branch });
      if (refusal) return { ...fail('pushed-under-hold', refusal.reason), pushed: true };
      if (post.branchClaimRefusal(repo, branch, options.holder))
        return { ...fail('pushed-under-hold', 'Branch has a foreign claim; coordinate with its holder'), pushed: true };
      const view = readView(post, repo, pr);
      const reason = held(view) || (view.state !== 'OPEN' ? 'PR is not open'
        : view.isDraft && !entry.sidecarAt ? 'PR drafted outside this claim'
        : view.isCrossRepository ? 'Cross-repository PR'
        : view.headRefOid !== sha ? 'Post-push PR head differs'
        : view.headRefName !== branch ? 'Post-push PR branch differs' : null);
      if (reason) return { ...fail('pushed-under-hold', reason), pushed: true };
    } catch { return { ...fail('pushed-under-hold', 'Post-push evidence unreadable; block hand-back'), pushed: true }; }
    return { ok: true, pushed: sha, purpose };
  }); } catch { return fail('unreadable', 'Cannot read isolated push evidence; restore evidence before retrying'); }
}

  return { authorizedPush, readPushAuthority };
}
const publicKeys = new Set(['repo', 'pr', 'branch', 'expectedHead', 'sha', 'gitDir', 'holder', 'purpose']);
function snapshotOptions(options) {
  const data = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid push option');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => !keys.has(key) || !('value' in descriptors[key])))
      throw new Error('Push options must be data properties');
    return Object.fromEntries(Reflect.ownKeys(descriptors).map(key => [key, descriptors[key].value]));
  };
  if (['io', 'remoteUrl', 'protocolAllow'].some(key => key in options)) throw new Error('Unknown push option');
  const snapshot = data(options, publicKeys);
  const holder = data(snapshot.holder ?? {}, new Set(['sessionId', 'who', 'token']));
  return Object.freeze({ ...snapshot, holder: Object.freeze({ sessionId: holder.sessionId, who: holder.who, token: holder.token }) });
}
function publicCall(method, options = {}) {
  let snapshot;
  try { snapshot = snapshotOptions(options);
  } catch { return fail('bad-input', 'Invalid push options; use plain data properties'); }
  return createAuthorizedPush()[method](snapshot);
}
export const authorizedPush = options => publicCall('authorizedPush', options);
export const readPushAuthority = options => publicCall('readPushAuthority', options);
