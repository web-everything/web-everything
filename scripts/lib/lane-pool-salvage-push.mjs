import { sameRepoUrl, ensureLaneAlternates } from './lane-alternates.mjs';
import { boundedGitCommand, BOUNDED_GIT_GRACE_MS } from './git-bounded.mjs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { laneGitHardeningEnv, scrubGitRepoEnv } from './lane-git-hardening.mjs';

const clean = value => String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 2000);

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
      return { status: 'pushed', ref, unmatched };
    }
    throw new Error('100 salvage names occupied; inspect remote salvage branches and retry next minute');
  } catch (e) {
    return { status: 'failed', unmatched, reason: clean(e?.message || e || 'salvage failed') };
  }
}

export function realSalvageIo({ repo, preflightLaneDir, backupRoot = process.env.WE_LANE_BACKUP_ROOT || join(homedir(), 'workspace', '.operations', 'backup'), runGit = execFileSync }) {
  const env = laneGitHardeningEnv({ ...scrubGitRepoEnv(process.env), GIT_OPTIONAL_LOCKS: '0' });
  // resolveRepo makes configured local origins absolute; explicit --origin paths remain invocation-relative.
  const origin = repo.originUrl ? (/^[^/]*:/.test(repo.originUrl) ? repo.originUrl : resolve(repo.originUrl)) : null;
  const normalizeRemoteName = name => name.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const transport = (command, ...args) => {
    if (!origin) throw new Error('canonical origin unresolved; supply --origin or a primary --reference');
    return ['-c', 'remote.origin.uploadpack=git-upload-pack', '-c', 'remote.origin.receivepack=git-receive-pack',
      '-c', 'remote.origin.pushurl=', '-c', 'push.gpgSign=false', '-c', 'gpg.ssh.defaultKeyCommand=', command, ...args];
  };
  // `bounded` runs the command under git-bounded.mjs so a timeout kills the whole process group (index-pack, ssh).
  const git = (dir, args, timeout = 120_000, bounded = false) => {
    const cmd = bounded ? boundedGitCommand(args, timeout) : { file: 'git', args };
    return runGit(cmd.file, cmd.args, {
      cwd: dir, env, encoding: 'utf8', timeout: bounded ? timeout + BOUNDED_GIT_GRACE_MS : timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };
  const checkTransportConfig = dir => {
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
      // Git resolves even a URL argument as a remote name first. Only the exact
      // origin subsection is allowed in lane config; URL aliases must be refused,
      // not overridden with -c (remote URLs are multi-valued). Split at the LAST
      // dot because a remote subsection can itself contain dots or line separators.
      const remoteName = /^remote\./i.test(key) ? key.slice(7, key.lastIndexOf('.')) : null;
      const unsafeRemote = remoteName !== null && (remoteName !== 'origin'
        || (origin && (normalizeRemoteName(remoteName) === normalizeRemoteName(origin) || sameRepoUrl(remoteName, origin))));
      if (['local', 'worktree'].includes(scope)
        && (unsafeRemote || /^(?:credential\.|https?\.|protocol\.|fetch\.bundleuri$|core\.(?:askpass|gitproxy|sshcommand)$|ssh\.|gpg\.|push\.gpgsign$|user\.signingkey$|commit\.gpgsign$|remote\.[\s\S]*\.(?:proxy|proxyauthmethod|vcs|uploadpack|receivepack|pushurl)$)/i.test(key))) {
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
    // A fetch into a lane without alternates re-downloads the repository; repair them first (best effort, add-only).
    if (command === 'fetch' && (repo.alternatesReferencePath || repo.referencePath)) {
      try { ensureLaneAlternates({ laneDir: dir, referencePath: repo.alternatesReferencePath || repo.referencePath, laneOrigin: origin, referenceOrigin: origin }); } catch { /* never blocks the salvage */ }
    }
    return git(dir, transportArgs, 120_000, true);
  };
  return {
    aheadShas: dir => git(dir, ['rev-list', `origin/${repo.branch}..HEAD`]).split('\n').filter(Boolean),
    unmatchedShas: (dir, ahead) => {
      // All branch tips are needed for exact-SHA reachability, but only the integration branch
      // participates in patch equivalence. Explicit refspecs also make pruning independent of lane config.
      transportGit(dir, 'fetch', '--recurse-submodules=no', '--prune', '--no-tags', origin, '+refs/heads/*:refs/remotes/origin/*',
        // ops/* carries the verdict ledger (huge history, never lane work): the lane's diet config excludes it, and this explicit
        // refspec would otherwise pull ~117k objects on every release (lane-68, 2026-11-01).
        '^refs/heads/ops/*');
      const matched = new Set();
      for (const line of git(dir, ['cherry', `origin/${repo.branch}`, 'HEAD']).split('\n')) {
        if (line.startsWith('- ')) matched.add(line.slice(2).trim());
      }
      return ahead.filter(sha => !matched.has(sha)
        && !git(dir, ['for-each-ref', '--exclude=refs/remotes/origin/ops/*', '--contains', sha, 'refs/remotes/origin', '--count=1']));
    },
    push: (dir, ref, sha) => {
      transportGit(dir, 'push', '--recurse-submodules=no', origin, `${sha}:refs/heads/${ref}`);
      return { ok: true };
    },
    remoteSha: ref => {
      const output = transportGit(repo.referencePath, 'ls-remote', origin, `refs/heads/${ref}`);
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
