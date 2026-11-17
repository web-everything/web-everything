import { sameRepoUrl, ensureLaneAlternates } from './lane-alternates.mjs';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from './git-bounded.mjs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { laneGitHardeningEnv, redactUrlCredentials, scrubGitRepoEnv } from './lane-git-hardening.mjs';

export { redactUrlCredentials };

/** The canonical origin as an operator push target: a local path is made absolute; a URL keeps its scheme and host,
 *  with credentials stripped as `redactUrlCredentials` does. */
export function releasePushTarget(url) {
  if (!/^[^/]*:/.test(url)) return resolve(url);
  return redactUrlCredentials(url);
}

const clean = value => redactUrlCredentials(String(value)).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 2000);

export function salvageStamp(date) {
  return date.toISOString().slice(0, 16).replaceAll('-', '').replace('T', '-').replace(':', '');
}

export function salvageRefName(lane, date) {
  if (!Number.isSafeInteger(lane) || lane < 1) throw new Error('invalid salvage lane');
  return `salvage/lane-${lane}-${salvageStamp(date)}`;
}

/** Only a verified remote SHA and a durable record count as a completed salvage. */
export async function salvagePushLane({ lane, laneDir, io, now = () => new Date() }) {
  let unmatched = [];
  try {
    const ahead = await io.aheadShas(laneDir);
    if (!Array.isArray(ahead)) throw new Error('incomplete ahead evidence');
    if (!ahead.length) return { status: 'none-ahead', unmatched };
    unmatched = await io.unmatchedShas(laneDir, ahead);
    if (!Array.isArray(unmatched)) throw new Error('incomplete patch-match evidence');
    if (!unmatched.length) return { status: 'matched', unmatched };
    const base = salvageRefName(lane, now());
    for (let attempt = 1; attempt <= 100; attempt++) {
      const ref = attempt === 1 ? base : `${base}-${attempt}`;
      if (await io.remoteSha(ref) !== null) continue;
      const pushed = await io.push(laneDir, ref, ahead[0]);
      if (pushed?.ok !== true) throw new Error('salvage push refused');
      if (await io.remoteSha(ref) !== ahead[0]) throw new Error('salvage remote SHA verification failed');
      await io.record(lane, `${ref} ${ahead[0]}\n`);
      return { status: 'pushed', ref, sha: ahead[0], unmatched };
    }
    throw new Error('100 salvage names occupied; inspect remote salvage branches and retry next minute');
  } catch (e) {
    return { status: 'failed', unmatched, reason: clean(e?.message || e || 'salvage failed') };
  }
}

/** The filesystem root: owned by root and never a repository (git cannot discover one above it), so a git call run
 *  there reads no repository config. Exported for its test. */
export const NO_REPO_CWD = parse(resolve('/')).root;

export function realSalvageIo({ repo, preflightLaneDir, backupRoot = process.env.WE_LANE_BACKUP_ROOT || join(homedir(), 'workspace', '.operations', 'backup'), runGit = execFileSync, accountHome }) {
  const baseEnv = { ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0' };
  const env = laneGitHardeningEnv(baseEnv);
  // The canonical-origin listing run in the VALIDATED primary only: the operator's own credential helper / askpass
  // there authenticates an HTTPS origin. No lane is ever the cwd of a call with this env (PR #6319, R674 route a). Its
  // global config comes from the OS account's home, never a caller-set HOME (`accountHome` is a test fixture hook).
  const primaryEnv = laneGitHardeningEnv(baseEnv, { credentialPins: false, ...(accountHome ? { home: accountHome } : {}) });
  // resolveRepo makes configured local origins absolute; explicit --origin paths remain invocation-relative.
  const origin = repo.originUrl ? (/^[^/]*:/.test(repo.originUrl) ? repo.originUrl : resolve(repo.originUrl)) : null;
  const normalizeRemoteName = name => name.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const transport = (command, ...args) => {
    if (!origin) throw new Error('canonical origin unresolved; supply --origin or a primary --reference');
    return ['-c', 'remote.origin.uploadpack=git-upload-pack', '-c', 'remote.origin.receivepack=git-receive-pack',
      '-c', 'remote.origin.pushurl=', '-c', 'push.gpgSign=false', '-c', 'gpg.ssh.defaultKeyCommand=', command, ...args];
  };
  // `bounded` runs the command under git-bounded.mjs so a timeout kills the whole process group (index-pack, ssh).
  const git = (dir, args, timeout = 120_000, bounded = false, callEnv = env) => {
    const cmd = bounded ? boundedGitCommand(args, timeout) : { file: 'git', args };
    return runGit(cmd.file, cmd.args, {
      cwd: dir, env: callEnv, encoding: 'utf8', timeout: bounded ? timeout + BOUNDED_GIT_GRACE_MS : timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };
  const gitRun = git;
  // `callEnv`: the env the checked transport itself runs under, so the check reads the same global config git applies
  // (the primary listing reads it from the account home, not a caller-set HOME — PR #6319 self-review).
  const checkTransportConfig = (dir, { primary = false, callEnv = env } = {}) => {
    const git = (d, args) => gitRun(d, args, 120_000, false, callEnv);
    // An explicit URL still passes through url.*.insteadOf / pushInsteadOf. Refuse
    // every effective rewrite (including includes and global config) before transport.
    // NUL-delimited names keep newlines in a subsection from hiding a rewrite key.
    const keys = git(dir, ['config', '--null', '--name-only', '--list', '--includes']);
    if (keys.split('\0').some(key => /^url\.[\s\S]*\.(?:push)?insteadof$/i.test(key))) {
      throw new Error('URL rewriting configured; canonical origin cannot be trusted — remove the rewrite and retry');
    }
    // Keep operator auth from global/system scope, but never give a lane's helper,
    // proxy, headers or TLS settings access to the unattended transport. Name-only
    // scope/origin/key records avoid confusing newlines in URL subsections with key/value separators.
    const scoped = git(dir, ['config', '--null', '--name-only', '--show-scope', '--show-origin', '--list', '--includes']);
    const parts = scoped ? scoped.split('\0') : [];
    if (parts.length && parts.pop() !== '') throw new Error('incomplete transport config; inspect the lane manually');
    if (parts.length % 3) throw new Error('incomplete transport config; inspect the lane manually');
    // Apple Git can label its toolchain config 'unknown'. Trust that only when
    // its absolute file origin is outside every repository-controlled directory.
    let laneRoots;
    const externalFile = configOrigin => {
      if (!configOrigin.startsWith('file:') || !isAbsolute(configOrigin.slice(5))) return false;
      try {
        const canonical = path => existsSync(path) ? realpathSync(path) : resolve(path);
        if (!laneRoots) {
          const dirs = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).split('\n');
          const bare = git(dir, ['rev-parse', '--is-bare-repository']);
          if (dirs.length !== 2 || dirs.some(path => !isAbsolute(path)) || !['true', 'false'].includes(bare)) return false;
          if (bare === 'false') dirs.push(git(dir, ['rev-parse', '--show-toplevel']));
          if (dirs.some(path => !isAbsolute(path))) return false;
          laneRoots = [resolve(dir), ...dirs].map(canonical);
        }
        const path = canonical(configOrigin.slice(5));
        return laneRoots.every(root => {
          const rel = relative(root, path);
          return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
        });
      } catch { return false; }
    };
    for (let i = 0; i < parts.length; i += 3) {
      const [scope, configOrigin, key] = parts.slice(i, i + 3);
      if ((!['system', 'global', 'local', 'worktree', 'command'].includes(scope)
        && !(scope === 'unknown' && externalFile(configOrigin))) || !key || !configOrigin) {
        throw new Error('unknown transport config scope; inspect the lane manually');
      }
      // Git resolves even a URL argument as a remote name first, so a remote NAMED
      // like the canonical origin redirects the transport; URL aliases must be refused,
      // not overridden with -c (remote URLs are multi-valued). Split at the LAST
      // dot because a remote subsection can itself contain dots or line separators.
      const remoteName = /^remote\./i.test(key) ? key.slice(7, key.lastIndexOf('.')) : null;
      const aliasesOrigin = remoteName !== null && !!origin
        && (normalizeRemoteName(remoteName) === normalizeRemoteName(origin) || sameRepoUrl(remoteName, origin));
      // A lane may configure only the exact `origin` subsection. The primary (the operator's own checkout, not an
      // agent-writable lane) may carry ordinary extra remotes (upstream, a fork): the transport names the canonical
      // URL explicitly, so only a remote aliasing that URL can redirect it, and that alias is refused for every key.
      const unsafeRemote = aliasesOrigin || (!primary && remoteName !== null && remoteName !== 'origin');
      // `primary`: its signing keys (commit.gpgsign, …) and hooks are not lane control. Its local/worktree credential,
      // askpass, proxy, TLS and protocol keys ARE refused, like a lane's: the primary listing runs without the credential
      // resets, and "primary" is only a checkout outside the pool roots (any `~/workspace/*` clone with the right origin
      // qualifies), which an agent can create. The operator's helper is trusted from global/system scope only — the
      // send-back's "never --local / --worktree" (PR #6319 self-review). URL rewrites and origin aliases are refused too.
      // `hook.*`: config-defined hooks (`hook.<name>.command` + `.event`) run even with the core.hooksPath pin.
      if (['local', 'worktree'].includes(scope)
        && (unsafeRemote || /^(?:credential\.|https?\.|protocol\.|fetch\.bundleuri$|core\.(?:askpass|gitproxy|sshcommand)$|ssh\.)/i.test(key)
          || !primary && /^(?:hook\.|gpg\.|push\.gpgsign$|user\.signingkey$|commit\.gpgsign$|remote\.[\s\S]*\.(?:proxy|proxyauthmethod|vcs|uploadpack|receivepack|pushurl)$)/i.test(key))) {
        throw new Error('lane-controlled transport configuration; inspect the lane manually and remove it before retrying');
      }
    }
  };
  // Release must scrub executable lane config before its status/litter checks. Keep a
  // refusal observed before that scrub: removing an include or rewrite cannot erase it.
  let preflightError;
  if (preflightLaneDir && origin) {
    try { checkTransportConfig(preflightLaneDir); }
    catch (error) { preflightError = error; }
  }
  const transportGit = (dir, command, ...args) => {
    const transportArgs = transport(command, ...args);
    if (preflightError) throw preflightError;
    checkTransportConfig(dir);
    if (command === 'fetch') refuseTrackingSymrefs(dir);
    // A fetch into a lane without alternates re-downloads the repository; repair them first (best effort, add-only).
    if (command === 'fetch' && repo.alternatesReferencePath) {
      try { ensureLaneAlternates({ laneDir: dir, referencePath: repo.alternatesReferencePath, laneOrigin: origin, referenceOrigin: origin }); } catch { /* never blocks the salvage */ }
    }
    return git(dir, transportArgs, 120_000, true);
  };
  // A fetch writes THROUGH a symbolic ref (PR #6319, R639): a lane-made refs/remotes/origin/main -> refs/heads/work/keep
  // would reset the lane's unpushed branch to the pushed tip. Only the ordinary origin/HEAD alias of a plain origin/*
  // ref is accepted (Git reports a symref's final target, so a chain through another symref is caught too). Unreadable
  // counts as unsafe.
  const refuseTrackingSymrefs = dir => {
    const listing = git(dir, ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes/origin/']);
    const unsafe = [];
    for (const line of listing ? listing.split('\n') : []) {
      const [name, target, extra] = line.split('\0');
      if (extra !== undefined || !name) throw new Error('unreadable origin tracking refs; inspect the lane manually');
      if (target && !(name === 'refs/remotes/origin/HEAD' && target.startsWith('refs/remotes/origin/') && target !== name)) {
        unsafe.push(`${clean(name)} is a symbolic ref to ${clean(target)}`);
      }
    }
    if (unsafe.length) {
      throw new Error(`${unsafe.slice(0, 5).join('; ')}; a fetch would write through it — remove it (git update-ref --no-deref -d <ref>)`);
    }
    // A filesystem symlink redirects the same writes without showing as a symbolic ref: `.git/refs/remotes/origin ->
    // ../heads` let the pruning fetch reset and delete local branches, and a symlinked `refs/release-verify` or reflog
    // directory sends the writes into another repository (PR #6319 self-review). Every directory and entry on the path
    // of a namespace a fetch writes (refs and reflogs) must be real; a missing one is fine.
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!isAbsolute(common)) throw new Error('unreadable lane git dir; inspect the lane manually');
    const walk = (path, shown) => {
      let entry;
      try { entry = lstatSync(path); } catch (e) {
        if (e?.code === 'ENOENT') return false;
        throw new Error(`unreadable ${shown}; inspect the lane manually`);
      }
      if (entry.isSymbolicLink()) throw new Error(`${shown} is a filesystem symlink; a fetch would write through it — remove it`);
      return entry.isDirectory();
    };
    const below = (path, shown) => {
      if (!walk(path, shown)) return;
      for (const name of readdirSync(path)) below(join(path, name), `${shown}/${clean(name)}`);
    };
    for (const namespace of ['refs/remotes/origin', 'refs/release-verify']) {
      for (const root of [[], ['logs']]) {
        const parts = [...root, ...namespace.split('/')];
        let path = common;
        for (const [i, part] of parts.entries()) {
          path = join(path, part);
          if (i === parts.length - 1) below(path, parts.join('/'));
          else if (!walk(path, parts.slice(0, i + 1).join('/'))) break;
        }
      }
    }
  };
  // ops/* carries the verdict ledger (huge history, never lane work): the lane's diet config excludes it, and an explicit
  // refspec would otherwise pull ~117k objects on every release (lane-68, 2026-11-01).
  const notOps = '^refs/heads/ops/*';
  // Fetch every non-ops origin head into refs/remotes/origin/*. Explicit refspecs make pruning independent of lane config.
  // No FETCH_HEAD (nothing reads it): Git opens it with a plain fopen, so a lane-made `.git/FETCH_HEAD ->
  // refs/heads/<branch>` symlink would overwrite that branch before the release guard looks (PR #6319 self-review).
  // No auto-maintenance either: lane gc.*/maintenance.* config must not expire reflogs, repack or prune during release.
  const fetchHeads = dir => transportGit(dir, 'fetch', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance',
    '--prune', '--no-tags', origin, '+refs/heads/*:refs/remotes/origin/*', notOps);
  // The release proof needs only the origin's OBJECTS, never its refs: fetch into a fresh private namespace (no
  // FETCH_HEAD, no tracking refs) and delete it again without dereferencing, so no lane-controlled ref is ever written.
  const fetchVerifyObjects = dir => {
    transport('fetch'); // an unresolved origin refuses before any lane read
    const ns = `refs/release-verify/${randomBytes(8).toString('hex')}`;
    const owned = () => {
      const listing = git(dir, ['for-each-ref', '--format=%(refname)', `${ns}/`]);
      return listing ? listing.split('\n').filter(Boolean) : [];
    };
    if (owned().length) throw new Error(`${ns} already holds refs; inspect the lane manually`);
    try {
      // No auto-maintenance: lane gc.* config must not repack or prune the lane during a release check.
      transportGit(dir, 'fetch', '--recurse-submodules=no', '--no-write-fetch-head', '--no-auto-maintenance', '--no-tags', origin,
        `+refs/heads/*:${ns}/*`, notOps);
    } finally {
      const refs = owned();
      if (refs.length) {
        runGit('git', ['update-ref', '--stdin'], {
          cwd: dir, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'], input: refs.map(ref => `option no-deref\ndelete ${ref}\n`).join(''),
        });
      }
    }
  };
  // Every canonical-origin listing (the release proof and the salvage ref check) runs here. The primary's auth keys
  // are exempt only in a checkout resolveRepo validated as the primary (found by name, or proven not a lane):
  // `primaryPath`. A release run from inside a lane keeps that lane as referencePath, so without a validated primary
  // the listing runs under the strict lane rules, where a credential helper, http.* or askpass key refuses
  // (PR #6319 send-back). Only the validated-primary listing drops the credential.helper / core.askPass reset pins, so
  // the operator's own helper authenticates an HTTPS origin; the fallback (a possible lane) keeps them, as do every
  // lane fetch and the salvage push (PR #6319 operator ruling, R674 route a). Terminal prompts stay off either way.
  // The no-pins listing is checked against the primary but RUNS outside any repository (`NO_REPO_CWD`): a URL listing
  // needs none, and the primary's `.git/config` is writable by agents, so a helper or URL rewrite planted there after the
  // check would otherwise run without the resets (PR #6319 self-review, check-then-run race). Only the account's global /
  // system config applies to it — the scope the send-back trusts.
  const listOrigin = (...patterns) => {
    const args = transport('ls-remote', origin, ...patterns);
    const primaryDir = repo.primaryPath || null;
    const dir = primaryDir || repo.referencePath;
    const callEnv = primaryDir ? primaryEnv : env;
    checkTransportConfig(dir, { primary: !!primaryDir, callEnv });
    return git(primaryDir ? NO_REPO_CWD : dir, args, 120_000, true, callEnv);
  };
  return {
    fetchHeads,
    fetchVerifyObjects,
    /** The canonical origin's branch tips right now (ops/* excluded), checked against the primary checkout and read
     *  outside any repository (never the lane).
     *  Throws on anything but complete `<sha>\trefs/heads/<name>` lines, so a caller can fail closed. */
    remoteHeads: () => {
      const output = listOrigin('refs/heads/*');
      const shas = [];
      for (const line of output ? output.split('\n') : []) {
        const match = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/heads\/(.+)$/.exec(line);
        if (!match) throw new Error('unreadable canonical origin head listing');
        if (!match[2].startsWith('ops/')) shas.push(match[1]);
      }
      return shas;
    },
    aheadShas: dir => git(dir, ['rev-list', `origin/${repo.branch}..HEAD`]).split('\n').filter(Boolean),
    unmatchedShas: (dir, ahead) => {
      // All branch tips are needed for exact-SHA reachability, but only the integration branch
      // participates in patch equivalence.
      fetchHeads(dir);
      const matched = new Set();
      for (const line of git(dir, ['cherry', `origin/${repo.branch}`, 'HEAD']).split('\n')) {
        if (line.startsWith('- ')) matched.add(line.slice(2).trim());
      }
      return ahead.filter(sha => !matched.has(sha)
        && !git(dir, ['for-each-ref', '--exclude=refs/remotes/origin/ops/*', '--contains', sha, '--format=%(refname)\t%(symref)', 'refs/remotes/origin'])
          // A symbolic ref (origin/HEAD, or one aimed at the unrefreshed ops namespace) is never reachability evidence.
          .split('\n').some(line => line && !line.split('\t')[1]));
    },
    push: (dir, ref, sha, { createOnly = false } = {}) => {
      // An empty expected SHA atomically requires absence, even if another writer wins after remoteSha().
      const condition = createOnly ? [`--force-with-lease=refs/heads/${ref}:`] : [];
      transportGit(dir, 'push', '--recurse-submodules=no', ...condition, origin, `${sha}:refs/heads/${ref}`);
      return { ok: true };
    },
    remoteSha: ref => {
      if (preflightError) throw preflightError;
      const output = listOrigin(`refs/heads/${ref}`);
      if (!output) return null;
      const lines = output.split('\n');
      const [sha, name] = lines[0].split(/\s+/);
      if (lines.length !== 1 || !/^[a-f0-9]{40,64}$/.test(sha) || name !== `refs/heads/${ref}`) {
        throw new Error('unreadable salvage remote ref');
      }
      return sha;
    },
    record: (lane, text) => {
      const dir = join(backupRoot, `lane-${lane}-preserve`);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'salvage-ref.txt'), text);
    },
  };
}
