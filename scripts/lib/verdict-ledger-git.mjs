/**
 * @file scripts/lib/verdict-ledger-git.mjs
 * @description Layer 1b of the ledger outbox (see verdict-ledger-outbox-spool.mjs): which remote a board writes to
 *   (one canonical identity per remote, however its URL is spelled), where that remote's outbox lives, the scrubbed
 *   board git env, and what a FAILED push proves (git's own per-ref `--porcelain` status record, nothing else).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { withGitError, worktreeGitEnv } from './git-transport-branch.mjs';
import { workspaceFor } from './lane-pool-paths.mjs';
import { OUTBOX_DIR_ENV } from './verdict-ledger-outbox-spool.mjs';

/** The origin key of `board`: its origin URL, hashed. Run with repo selectors scrubbed, so cwd alone decides. */
export function originKeyFor({ board, run = defaultGit } = {}) {
  const url = String(withGitError(run)(['remote', 'get-url', 'origin'], { cwd: board, env: boardEnv(board), timeout: ORIGIN_LOOKUP_TIMEOUT_MS })).trim();
  if (!url) throw new Error(`verdict-ledger-outbox: ${board} has no origin URL`);
  return createHash('sha256').update(canonicalRemote(url, resolve(board))).digest('hex').slice(0, 16);
}

/** Bounded: the origin lookup runs before any flush deadline exists. */
export const ORIGIN_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * ONE identity per remote, however it is spelled (round 5: `https://github.com/o/r.git` and `git@github.com:o/r`
 * must share one outbox, or the backstop never visits one of them). host lowercased, user/port/protocol, `.git` and
 * trailing slashes dropped. A local path stays a resolved path.
 */
/** Hosts whose `host:o/r`, `host:/o/r` and `https://host/o/r` all name ONE repository. */
const FLAT_PATH_HOSTS = new Set(['github.com', 'ssh.github.com', 'gitlab.com', 'bitbucket.org']);
export function canonicalRemote(url, base = process.cwd()) {
  // Round 6: merge ONLY spellings of the same endpoint — protocol, user, the scheme's default port, a trailing slash
  // and a trailing `.git` on a HOSTED path. The host is case-folded (DNS); the path keeps its case; a non-default port
  // stays part of the identity; a LOCAL path is resolved against the board and kept exactly (no `.git` folding).
  // Round 7: an scp-style `host:path` is relative to the remote user's HOME (`~/path`), `ssh://host/path` and
  // `host:/path` are ABSOLUTE — different repositories on a generic host. Only providers whose paths are known to be
  // flat (one namespace, whatever the spelling) fold the two.
  const u = String(url ?? '').trim();
  const proto = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)$/i.exec(u);
  const scp = /^(?:([^@/]+)@)?([^:/\\]+):(.+)$/.exec(u);
  let user = null;
  let transport = null;
  let host = null;
  let port = null;
  let path = null;
  if (proto && proto[1].toLowerCase() !== 'file') {
    const scheme = proto[1].toLowerCase();
    user = proto[2] ?? null; host = proto[3]; path = proto[5]; // absolute, except git's `ssh://host/~/path`
    transport = /ssh/.test(scheme) ? 'ssh' : scheme; // round 11: http and https are different endpoints
    if (transport === 'ssh' && path.startsWith('/~')) path = path.slice(1); // `/~/x` and `/~user/x` are home paths
    const defaults = { ssh: '22', 'git+ssh': '22', 'ssh+git': '22', https: '443', http: '80', git: '9418' };
    port = proto[4] && proto[4] !== defaults[scheme] ? proto[4] : null;
  } else if (!proto && scp && !/^[a-zA-Z]:[\\/]/.test(u) && !u.startsWith('/') && !u.startsWith('.')) {
    user = scp[1] ?? null; host = scp[2]; transport = 'ssh';
    // Round 10: an explicit `~` / `~user` is kept as written; only a plain relative path gains the implied `~/`.
    path = scp[3].startsWith('/') || scp[3].startsWith('~') ? scp[3] : `~/${scp[3]}`;
  }
  if (!host) return `file:${resolve(base, u.replace(/^file:\/\//, '')).replace(/\/+$/, '')}`;
  host = host.toLowerCase();
  path = path.replace(/\/+$/, '');
  if (FLAT_PATH_HOSTS.has(host)) {
    // One namespace: the user is only an auth detail, `~/` and `/` are the same place, `.git` is optional.
    return `${host}${port ? `:${port}` : ''}/${path.replace(/^~\//, '').replace(/^\/+/, '').replace(/\.git$/, '')}`;
  }
  // Generic host (round 8): the user decides whose HOME `~/` is, and `repo` and `repo.git` may both exist.
  // Round 9: the transport class too (an https and an ssh daemon on one host may serve different trees).
  // Only the IMPLICIT home (`~/…`) depends on the login; `~name/…` names its home whoever logs in (round 11).
  const who = path.startsWith('~/') && user ? `${user}@` : '';
  return `${transport}://${who}${host}${port ? `:${port}` : ''}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * The outbox directory for `board`: env override, else `<workspace>/.operations/verdict-ledger-outbox/<origin-key>`.
 * Keyed by the board's ORIGIN URL so two clones of the same remote share one outbox (and one flusher). Each entry
 * ALSO records its origin key, and a flusher pushes only entries whose key matches its own board, so a row can never
 * reach a different remote even through a misconfigured override or an inherited `GIT_DIR` (audit 2026-10-21).
 */
export function outboxDirFor({ board, env = process.env, run = defaultGit } = {}) {
  if (env?.[OUTBOX_DIR_ENV]) return resolve(env[OUTBOX_DIR_ENV]);
  return join(workspaceFor(resolve(board)), '.operations', 'verdict-ledger-outbox', originKeyFor({ board, run }));
}

/** The board-side git env: no inherited repo selectors, the LEDGER app role for the push credential. */
export function boardEnv(board, extra = {}) {
  const env = worktreeGitEnv(join(board, '.git'));
  delete env.GIT_CEILING_DIRECTORIES; // the board is the repo here; discovery from its root is what we want
  return { ...env, ...extra };
}

/** Every git call is bounded (audit 2026-10-21): a hung push must not hold the flusher lock or the daemon tick. */
export const GIT_CALL_TIMEOUT_MS = 120_000;
export function defaultGit(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
    timeout: GIT_CALL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...opts,
  });
}

/**
 * What a FAILED push proves, read ONLY from git's own per-ref status line (`! [rejected] … (fetch first)`,
 * `! [remote rejected] … (hook declined)`); our push names exactly one ref, so any status line is about it. Free text
 * anywhere else (a `remote:` line that happens to say "cannot lock ref") proves nothing (audit round 4).
 *   'race'    — refused because the tip moved: provably not landed; refetch and retry.
 *   'refused' — refused for another reason (hook, protection, permissions): provably not landed; do not retry.
 *   'unknown' — no status line: the remote may or may not hold it.
 */
const RACE_REASON_RE = /fetch first|non-fast-forward|stale info|cannot lock ref|incorrect old value/i;
/**
 * Round 5: ONLY a `git push --porcelain` status RECORD on STDOUT for the EXACT destination ref counts — a line of the
 * form `<flag>\t<src>:<dst>\t<summary>`. Diagnostic prose (stderr, `remote:` lines, the formatted message) never does.
 */
export function classifyPushFailure(e, ref = 'refs/heads/ops/review-requests') {
  const verdicts = [];
  for (const line of String(e?.stdout ?? '').split(/\r?\n/)) {
    const m = /^([ +\-*=!])\t([^\t]*):([^\t]+)\t(.*)$/.exec(line);
    if (!m || m[3] !== ref) continue;
    // A non-rejected record for our ref beside a failed exit is never "not landed". Round 6: only an EXPLICIT
    // `[rejected]` / `[remote rejected]` summary is a verdict; `[remote failure]` and anything else stay UNKNOWN.
    if (m[1] !== '!' || !/^\[(rejected|remote rejected)\]/.test(m[4].trim())) return 'unknown';
    verdicts.push(RACE_REASON_RE.test(m[4]) ? 'race' : 'refused');
  }
  // Round 11: EVERY record for our ref must be a rejection (several destinations: one may have accepted).
  if (!verdicts.length) return 'unknown';
  return verdicts.every((v) => v === 'race') ? 'race' : 'refused';
}

/** A push-phase failure of the flush. `results` holds the entries that DID land before it. */
export class OutboxFlushError extends Error {
  constructor(message, { errors = [], attempts = 0, results = new Map(), kind = 'flush' } = {}) {
    super(message);
    this.name = 'OutboxFlushError';
    this.errors = errors;
    this.attempts = attempts;
    this.results = results;
    this.kind = kind;
  }
}
