/**
 * @file scripts/lib/git-transport-branch.mjs
 * @description THE ONE WAY A CREDENTIAL-LESS SESSION PUTS A FILE ON A CI-WATCHED BRANCH — extracted from
 *   `we:scripts/operations/record-verdict-io.mjs` when a SECOND transport needed it (#xaoja7a).
 *
 * WHY IT MOVED. `record-verdict` pushes a verdict request to `ops/review-requests`; `stage-pr-view` now pushes
 * a VIEW request to `ops/pr-views`. Same dance, same hazards, and the hazards are not obvious — a second copy
 * would have re-earned each of them one at a time. What is encoded here was learned the hard way, twice:
 *
 *   · A DEDICATED WORKTREE, NEVER A BRANCH SWITCH. The caller is standing in a lane with its own uncommitted
 *     work, and checking a transport branch out over that lane destroys it. That is not hypothetical: it was
 *     done by hand in the session that wrote `record-verdict-io.mjs`, and it disrupted a running juror
 *     mid-review. The worktree gives the transport branch its own directory and leaves the caller's tree alone.
 *   · EXISTING BRANCHES STAY DETACHED. The live 2026-10-09/10-11 wedge began when a killed writer left a
 *     worktree holding the shared local branch and an unpushed commit. Detached writers cannot block each
 *     other's checkout or move each other's branch ref; push races remain normal non-fast-forward refusals.
 *     Cleanup runs in finally; later writers also reclaim stale clean worktrees, saving unpushed HEADs first.
 *     Dirty worktrees (untracked and ignored files included, whatever the git config says) are left for an
 *     operator, never discarded. A worktree whose writer process is still alive (its `wt-<ms>.owner` pid) is
 *     never reclaimed, however old: age only decides when no live owner is recorded.
 *   · EVERY SIDE EFFECT IS INJECTED — `git` AND the three filesystem calls. `git` alone was not enough and CI
 *     caught it: a suite that injected only `run` still executed the real `mkdirSync` against its fixture root
 *     of `/repo`. Running as root that SUCCEEDED, creating a directory at the filesystem root and leaving the
 *     tests green over a sink that had genuinely written outside its checkout; as an ordinary CI user it failed
 *     `EACCES` and reddened four tests. The green run was the worse outcome, and a partially-injected sink is
 *     what allowed it.
 *   · NOTHING TO COMMIT IS A SUCCESS. Identical bytes already staged is exactly what an idempotent replay
 *     promises; reporting it as a failure would make every retry look broken.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide WHICH checkout the branch belongs to. That is `resolveTransportRoot`
 * (`we:scripts/operations/record-verdict-io.mjs`), which refuses a cross-repo push rather than defaulting —
 * a decision, and decisions stay with their caller.
 *
 * IMPURE by construction (`git`, `fs`), which is why every one of those is a parameter.
 */
import { retryTransientGit } from './git-fetch-retry.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * The env every git call INSIDE the transport worktree runs with (live 2026-10-09 06:52 ET: the review daemon's
 * own clone ended up checked out on `ops/review-requests`, its tree replaced by the ledger branch, and the daemon
 * died on MODULE_NOT_FOUND). The worktree lives INSIDE the board (`<board>/.operations/transport/wt-*`), so any
 * call that does not resolve to the worktree itself — its `.git` file gone, or an inherited `GIT_DIR` /
 * `GIT_WORK_TREE` — silently walks up and runs `checkout -B` on the BOARD. Two guards make that impossible:
 *   · the inherited repo-selecting variables are dropped, so cwd decides the repo;
 *   · `GIT_CEILING_DIRECTORIES` is the worktree's parent, so discovery may never climb out of the worktree:
 *     a broken worktree now fails loudly ("not a git repository") instead of writing the caller's tree.
 */
export function laneGitEnv(path, base = process.env) {
  const env = { ...base };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(path));
  return env;
}

export function worktreeGitEnv(wt, base = process.env) {
  const env = laneGitEnv(wt, base);
  // Every ops/** write goes through this worktree, so it plays the LEDGER role (we:scripts/lib/github-app-identity.mjs):
  // any gh / credential-helper call made for it picks the Ledger App once that role is configured.
  env.WE_GITHUB_APP_ROLE = 'ledger';
  return env;
}

/**
 * Write files onto `branch` in `board`'s checkout and push them.
 *
 * @param {object} o
 * @param {string} o.board - the checkout whose `origin` owns the branch.
 * @param {string} o.branch - the transport branch, e.g. `ops/review-requests`.
 * @param {Array<{path: string, content: string}>} o.files - repo-relative paths and their bytes.
 * @param {string} o.message - the commit message.
 * @returns {{paths: string[], pushed: boolean, reason?: string}}
 */
/**
 * An EXPLICIT refspec, because `git fetch origin <branch>` does not create `origin/<branch>` (#3264).
 *
 * Hit live onboarding plateau-app: the fetch succeeded, wrote `FETCH_HEAD` and nothing else, and the next line
 * died with `fatal: invalid reference: origin/ops/review-requests`. The remote-tracking ref is updated only when
 * the CLONE'S CONFIGURED refspec covers the branch — a full clone carries `+refs/heads/*:refs/remotes/origin/*`
 * and so it does, but a `--single-branch` clone does not, and a cloud-session checkout is of that kind.
 *
 * LIVES HERE, not in `we:scripts/operations/record-verdict-io.mjs` where it was first written: it is a fact
 * about git's refspec grammar, true of every transport branch, and this module is the one every transport now
 * shares. Putting it the other way round would also make the import cycle — that module imports this one.
 */
export function trackingRefspec(branch) {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

/**
 * THE PUSH-REF GUARD (operator decision 2026-10-08, after PR #4318 gave the applier workflow `contents: write`).
 * A write token that can push is only as safe as the ref it is allowed to push to. Pure.
 * @param {string} branch the short branch name a transport wants to push to
 * @param {string|null} allowRef when given, the ONE full ref this transport may push (`refs/heads/<name>`)
 * @throws {Error} on a ref that is unsafe to push (forced `+`, option-like `-`, a refspec `:`, whitespace, a
 *   non-branch namespace) or, with `allowRef`, anything other than exactly that ref
 */
export function assertPushRef(branch, allowRef = null) {
  const b = String(branch ?? '');
  if (!b || b.startsWith('+') || b.startsWith('-') || /[\s:^~?*\[\\]|\.\.|@\{|^refs\/|\/$|\.lock$/.test(b)) {
    throw new Error(`git-transport-branch: refusing to push unsafe ref "${b}" (no force/+, no refspec ":", no refs/ prefix, no option-like or ref-syntax characters)`);
  }
  if (allowRef != null && `refs/heads/${b}` !== allowRef) {
    throw new Error(`git-transport-branch: refusing to push "refs/heads/${b}": this transport may push ONLY ${allowRef}`);
  }
  return `refs/heads/${b}`;
}


/** Keep git's actual diagnostic on the first line, which callers retain in their write-miss messages. */
const wrappedRunners = new WeakSet();
function withGitError(run) {
  if (wrappedRunners.has(run)) return run;
  const wrapped = (args, opts) => {
    try { return run(args, opts); } catch (cause) {
      const lines = String(cause?.stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const reason = lines.filter((line) => /^(fatal:|error:)/.test(line)).at(-1)
        || lines.at(-1) || String(cause?.message ?? cause).split('\n')[0];
      const error = new Error(`git ${args.join(' ')} failed: ${reason}`, { cause });
      error.status = cause?.status;
      error.stderr = cause?.stderr;
      throw error;
    }
  };
  wrappedRunners.add(wrapped);
  return wrapped;
}

const stderrLog = (line) => process.stderr.write(`${line}\n`);

/**
 * LIVENESS, NOT AGE (red team: a writer stuck in a slow post-commit hook has an old, clean worktree that is
 * still in use). Each writer drops `wt-<ms>.owner` next to its worktree holding its pid; the sweep leaves any
 * worktree whose owner process is still alive. A reused pid only ever keeps a dead writer's worktree longer,
 * which is the safe direction. A missing or unreadable owner file falls back to the age rule (old writers, or
 * one killed before it wrote the file).
 */
const ownerFile = (root, name) => join(root, `${name}.owner`);
const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
};

function readOwnerPid(read, file) {
  const text = read(file);
  if (text == null) return null;
  try {
    const pid = JSON.parse(text)?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/**
 * Argument list for the guard's "is anything uncommitted here?" probe. Spelled out so no user/repo git config
 * (`status.showUntrackedFiles=no`, `diff.ignoreSubmodules=all`, ...; command-line flags outrank config) can hide a file from it: untracked and
 * ignored files count too, because the HEAD backup cannot preserve them.
 */
export const DIRTY_PROBE_ARGS = Object.freeze([
  'status', '--porcelain', '--untracked-files=all', '--ignored=traditional', '--ignore-submodules=none',
]);

/**
 * Index flags can hide edits from status: assume-unchanged (`h`), skip-worktree (`S`), or both (`s`).
 * Destructive cleanup requires every tracked file to carry the plain `H` tag. Probe errors propagate
 * so callers refuse cleanup when the index cannot be read.
 */
export function hasHiddenIndexFlags(run, options) {
  return run(['ls-files', '-v'], options).split(/\r?\n/).some((line) => line && line[0] !== 'H');
}

/**
 * Best-effort recovery of killed writers. Only old wt-<milliseconds> directories directly in the transport
 * root qualify. Save a clean HEAD not known to be on origin BEFORE removing its worktree; dirty or broken
 * worktrees stay put. All git and filesystem probes are injectable, just like the staging path.
 * @param {object} o
 * @param {string} o.board
 * @param {string} o.branch
 * @param {string} [o.exclude] the worktree this writer is about to create
 */
export function reclaimStrandedTransportWorktrees({
  board, branch, run = defaultGit, now = () => Date.now(), staleMs = 10 * 60_000,
  log = stderrLog, exists = existsSync, exclude = null, read = readExisting, alive = processAlive,
  rm = rmSync,
} = {}) {
  run = withGitError(run);
  // Even an unavailable logging sink must not turn maintenance into a write failure.
  const warn = (line) => { try { log(line.replace(/[\r\n]+/g, ' ')); } catch { /* best effort */ } };
  try {
    const root = resolve(board, '.operations', 'transport');
    const listed = run(['worktree', 'list', '--porcelain'], { cwd: board });
    for (const entry of listed.split(/\r?\n\r?\n/)) {
      const path = entry.split(/\r?\n/).find((line) => line.startsWith('worktree '))?.slice(9);
      // Quoted/unrecognised paths are deliberately left alone rather than guessed.
      if (!path || dirname(resolve(path)) !== root || (exclude && resolve(path) === resolve(exclude))) continue;
      const name = basename(path);
      const match = /^wt-(\d+)$/.exec(name);
      if (!match || now() - Number(match[1]) < staleMs) continue;
      try {
        if (!exists(path)) continue; // finally's prune handles missing directories
        // Absent/garbled record -> age rule. A record we cannot READ throws into the catch below: left alone.
        const ownerPid = readOwnerPid(read, ownerFile(root, name));
        if (ownerPid && alive(ownerPid)) continue; // its writer is still running, however long that takes
        const wtOpts = { cwd: path, env: worktreeGitEnv(path) };
        const hiddenIndexBits = hasHiddenIndexFlags(run, wtOpts);
        if (hiddenIndexBits || run([...DIRTY_PROBE_ARGS], wtOpts).trim()) {
          warn(`git-transport-branch: WARNING dirty stranded worktree ${path}; left untouched`);
          continue;
        }
        let sha = null;
        try { sha = run(['rev-parse', 'HEAD'], wtOpts).trim(); }
        catch (headError) {
          // A killed orphan writer may not have made its first commit. Prove the symbolic branch
          // is absent before treating a HEAD failure as unborn; other failures must retain the tree.
          const ref = run(['symbolic-ref', '--quiet', 'HEAD'], wtOpts).trim();
          if (!ref.startsWith('refs/heads/')) throw headError;
          let absent = false;
          try { run(['show-ref', '--verify', '--quiet', ref], wtOpts); }
          catch (e) { if (e.status !== 1) throw e; absent = true; }
          if (!absent) throw headError;
        }
        let backup = null;
        if (sha) {
          try { run(['merge-base', '--is-ancestor', sha, `origin/${branch}`], { cwd: board }); }
          catch {
            backup = `refs/transport-stranded/${name}`;
            run(['update-ref', backup, sha], { cwd: board });
          }
        }
        run(['worktree', 'remove', '--force', path], { cwd: board });
        try { rm(ownerFile(root, name), { force: true }); } catch { /* best effort */ }
        warn(`git-transport-branch: reclaimed ${path}${backup ? `; preserved at ${backup}` : ''}`);
      } catch (e) {
        warn(`git-transport-branch: stranded worktree sweep failed for ${path}: ${e.message}`);
      }
    }
  } catch (e) {
    warn(`git-transport-branch: stranded worktree sweep failed: ${e.message}`);
  }
}

export function stageOnTransportBranch({
  board,
  branch,
  files = [],
  message,
  run = defaultGit,
  mkdir = mkdirSync,
  write = writeFileSync,
  read = readExisting,
  rm = rmSync,
  now = () => Date.now(),
  log = stderrLog,
  exists = existsSync,
  // A caller-specific check run INSIDE the worktree, after worktree creation and BEFORE anything is written.
  // `record-verdict` passes `assertApplierRidesBoard` here (#3264): a board whose tree lacks the applier
  // workflow accepts the push and applies nothing, and the board's own tree is the only place that question
  // can be asked — which is only possible once the worktree exists. It throws to refuse; the `finally` below
  // still prunes, so a refusal never leaks a worktree. Generic by default: a transport with nothing to assert
  // passes nothing.
  assertReady = null,
  // #3779: START THE BRANCH when the remote does not have it yet, instead of dying on `invalid reference`.
  // Off by default, so every existing transport keeps its one extra guarantee: a branch that CI created is the
  // only branch it will write to, and a typo in a branch name fails rather than minting a new branch. The
  // handoff home turns it on for its first push only; the new branch is an ORPHAN (no parent, only `files`),
  // never a fork of whatever `board` has checked out.
  createIfAbsent = false,
  // The ONE full ref this transport may push, e.g. `refs/heads/ops/review-requests`. Checked BEFORE any git call
  // (so a refused ref fetches, checks out and writes nothing) and the push then names that full ref.
  allowRef = null,
} = {}) {
  if (!board || !branch) throw new TypeError('git-transport-branch: `board` and `branch` are both required');
  assertPushRef(branch, allowRef);
  if (!files.length) throw new TypeError('git-transport-branch: nothing to stage — `files` is empty');

  run = withGitError(run);
  const wt = join(board, '.operations', 'transport', `wt-${now()}`);
  mkdir(dirname(wt), { recursive: true });
  // EVERY call with `cwd: wt` goes through this: it can only ever act on the worktree, never the board above it.
  const wtEnv = worktreeGitEnv(wt);
  const runWt = (args, opts = {}) => run(args, { ...opts, cwd: wt, env: { ...wtEnv, ...(opts.env || {}) } });
  const created = createIfAbsent
    && !run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: board }).trim();
  const owner = ownerFile(dirname(wt), basename(wt));
  try {
    // Claim liveness BEFORE the worktree exists, so no sweep can ever see this worktree without its owner.
    // Best effort: if it cannot be written the worktree is merely subject to the age rule, as before.
    try { write(owner, `${JSON.stringify({ pid: process.pid })}\n`); } catch { /* best effort */ }
    reclaimStrandedTransportWorktrees({ board, branch, run, now, log, exists, exclude: wt, read, rm });
    if (created) {
      // An orphan WITHOUT a checkout: `--no-checkout` keeps the board's files out of the worktree, the
      // symbolic-ref points HEAD at the unborn branch, and `read-tree --empty` drops the index the add seeded
      // from the board's HEAD. `checkout --orphan` would do all three but writes the board's whole tree first.
      // The stale local branch goes first: branch refs are shared by every worktree, and a leftover from an
      // earlier run would become the new commit's parent.
      try { run(['update-ref', '-d', `refs/heads/${branch}`], { cwd: board }); } catch { /* none */ }
      run(['worktree', 'add', '--force', '--no-checkout', '--detach', wt, 'HEAD'], { cwd: board });
      runWt(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      runWt(['read-tree', '--empty']);
      return writeCommitPush({ run, runWt, mkdir, write, read, wt, files, message, branch, created, assertReady, board, allowRef });
    }
    // AN EXPLICIT REFSPEC, never a bare `fetch origin <branch>` (#3264). The bare form writes `FETCH_HEAD` and
    // creates `refs/remotes/origin/<branch>` only when the CLONE'S CONFIGURED refspec covers it — true of a full
    // clone, false of a `--single-branch` one, which is what a cloud-session checkout is. The `worktree add`
    // below then dies on `fatal: invalid reference`. This helper was extracted from `record-verdict`'s sink as
    // it stood BEFORE that fix landed, so the bare form came with it; naming the destination here is what keeps
    // the extraction from regressing it — and now for EVERY transport that shares this code, not just one.
    retryTransientGit(() => run(['fetch', '--quiet', 'origin', trackingRefspec(branch)], { cwd: board }));
    // `--force` on the worktree add is about the DIRECTORY, not the branch: a leftover registration from a
    // killed run must not stop this one. The branch itself is taken from the freshly fetched remote tip.
    run(['worktree', 'add', '--force', '--detach', wt, `origin/${branch}`], { cwd: board });
    // Stay detached: the 2026-10-09/10-11 stranded branch holder must never wedge a new writer.
    // Concurrent writers also need independent HEADs; the remote arbitrates their non-forced pushes.

    return writeCommitPush({ run, runWt, mkdir, write, read, wt, files, message, branch, created, assertReady, board, allowRef });
  } finally {
    // Remove this run's directory, then prune its registration. A killed run misses finally entirely;
    // the next writer's best-effort sweep handles its stale worktree without discarding unpushed work.
    try { rm(wt, { recursive: true, force: true }); } catch { /* already gone */ }
    try { rm(owner, { force: true }); } catch { /* already gone */ }
    // PRUNED IN `board`, not in whatever directory the driver happens to be: the worktree was registered in the
    // board's checkout, so pruning elsewhere leaves a stale registration in the repo that will need it (#3261).
    try { run(['worktree', 'prune'], { cwd: board }); } catch { /* best effort */ }
  }
}

/** The tail both starts share: the caller's check, the writes, and the commit + push (never a force). */
function writeCommitPush({ run, runWt, mkdir, write, read, wt, files, message, branch, created, assertReady, board, allowRef }) {
  // The caller's check gets a runner that keeps the worktree guard on its `cwd: wt` calls (and leaves others alone).
  const guarded = (args, opts = {}) => (opts.cwd === wt ? runWt(args, opts) : run(args, opts));
  if (assertReady) assertReady({ run: guarded, wt, board, branch, created });

  for (const file of files) {
    const abs = join(wt, file.path);
    mkdir(dirname(abs), { recursive: true });
    // `content` may be a function of the file's CURRENT bytes on the freshly fetched tip (`null` when absent):
    // an APPEND is only correct if it is computed against the tip the push will race, so it must be computed
    // here, inside the worktree, and again on every retry (#3255).
    write(abs, typeof file.content === 'function' ? file.content({ existing: read(abs) }) : file.content);
    runWt(['add', '--', file.path]);
  }

  const staged = runWt(['diff', '--cached', '--name-only']).trim();
  if (!staged) return { paths: files.map((f) => f.path), pushed: false, reason: 'identical content already staged' };

  runWt(['commit', '--quiet', '-m', message]);
  // A FULL refname: on a created branch the remote has no `<branch>` for a short name to resolve against.
  runWt(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  return { paths: files.map((f) => f.path), pushed: true, ...(created ? { created: true } : {}) };
}

/** The file's current text, or `null` when it does not exist. Any other read error is real and propagates. */
function readExisting(abs) {
  try { return readFileSync(abs, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
}

/**
 * READ files off a transport branch's remote tip, touching nothing local but the remote-tracking ref.
 *
 * THROWS on any failure to learn the tip (unreachable remote, absent branch): the caller must turn that into
 * "unreadable", never into "empty". A path that is absent on a tip we DID read is `null` - a true answer.
 *
 * @param {{board: string, branch: string, paths: string[], run?: Function}} o
 * @returns {Record<string, string|null>} path -> text, or null when the path is not on the branch.
 */
export function readFromTransportBranch({ board, branch, paths = [], run = defaultGit } = {}) {
  if (!board || !branch) throw new TypeError('git-transport-branch: `board` and `branch` are both required');
  retryTransientGit(() => run(['fetch', '--quiet', 'origin', trackingRefspec(branch)], { cwd: board }));
  const out = {};
  for (const path of paths) {
    const listed = run(['ls-tree', '--name-only', `origin/${branch}`, '--', path], { cwd: board }).trim();
    out[path] = listed ? run(['show', `origin/${branch}:${path}`], { cwd: board }) : null;
  }
  return out;
}

function defaultGit(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
