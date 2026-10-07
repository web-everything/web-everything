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
 *   · THE WORKTREE IS ALWAYS REMOVED, and the registration always pruned, in that order and in a `finally`.
 *     A stranded worktree makes the NEXT `worktree add` on the same branch fail, which turns one bad run into
 *     every subsequent one failing.
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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  // A caller-specific check run INSIDE the worktree, after `checkout -B` and BEFORE anything is written.
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
} = {}) {
  if (!board || !branch) throw new TypeError('git-transport-branch: `board` and `branch` are both required');
  if (!files.length) throw new TypeError('git-transport-branch: nothing to stage — `files` is empty');

  const wt = join(board, '.operations', 'transport', `wt-${now()}`);
  mkdir(dirname(wt), { recursive: true });
  const created = createIfAbsent
    && !run(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: board }).trim();
  try {
    if (created) {
      // An orphan WITHOUT a checkout: `--no-checkout` keeps the board's files out of the worktree, the
      // symbolic-ref points HEAD at the unborn branch, and `read-tree --empty` drops the index the add seeded
      // from the board's HEAD. `checkout --orphan` would do all three but writes the board's whole tree first.
      // The stale local branch goes first: branch refs are shared by every worktree, and a leftover from an
      // earlier run would become the new commit's parent.
      try { run(['update-ref', '-d', `refs/heads/${branch}`], { cwd: board }); } catch { /* none */ }
      run(['worktree', 'add', '--force', '--no-checkout', '--detach', wt, 'HEAD'], { cwd: board });
      run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: wt });
      run(['read-tree', '--empty'], { cwd: wt });
      return writeCommitPush({ run, mkdir, write, read, wt, files, message, branch, created, assertReady, board });
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
    run(['checkout', '-B', branch, `origin/${branch}`], { cwd: wt });

    return writeCommitPush({ run, mkdir, write, read, wt, files, message, branch, created, assertReady, board });
  } finally {
    // ALWAYS, and in this order: remove the directory, then prune the registration. Dropping either one leaves
    // the next run on this branch wedged.
    try { rm(wt, { recursive: true, force: true }); } catch { /* already gone */ }
    // PRUNED IN `board`, not in whatever directory the driver happens to be: the worktree was registered in the
    // board's checkout, so pruning elsewhere leaves a stale registration in the repo that will need it (#3261).
    try { run(['worktree', 'prune'], { cwd: board }); } catch { /* best effort */ }
  }
}

/** The tail both starts share: the caller's check, the writes, and the commit + push (never a force). */
function writeCommitPush({ run, mkdir, write, read, wt, files, message, branch, created, assertReady, board }) {
  if (assertReady) assertReady({ run, wt, board, branch, created });

  for (const file of files) {
    const abs = join(wt, file.path);
    mkdir(dirname(abs), { recursive: true });
    // `content` may be a function of the file's CURRENT bytes on the freshly fetched tip (`null` when absent):
    // an APPEND is only correct if it is computed against the tip the push will race, so it must be computed
    // here, inside the worktree, and again on every retry (#3255).
    write(abs, typeof file.content === 'function' ? file.content({ existing: read(abs) }) : file.content);
    run(['add', '--', file.path], { cwd: wt });
  }

  const staged = run(['diff', '--cached', '--name-only'], { cwd: wt }).trim();
  if (!staged) return { paths: files.map((f) => f.path), pushed: false, reason: 'identical content already staged' };

  run(['commit', '--quiet', '-m', message], { cwd: wt });
  // A FULL refname: on a created branch the remote has no `<branch>` for a short name to resolve against.
  run(['push', '--quiet', 'origin', created ? `HEAD:refs/heads/${branch}` : `HEAD:${branch}`], { cwd: wt });
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
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}
