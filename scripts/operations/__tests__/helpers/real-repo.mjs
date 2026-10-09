/**
 * @file real-repo.mjs — REAL git fixtures for the operations suites (#3264).
 *
 * WHY THIS MODULE EXISTS, stated as the bug it closes. `we:scripts/operations/record-verdict-io.mjs` shipped
 * a sink that ran `git fetch --quiet origin ops/review-requests` and then, on the very next line,
 * `git worktree add --detach <wt> origin/ops/review-requests`. Every unit test passed, because `run` is an
 * injected stub and a stub returning `''` accepts any argv. It died in production with
 * `fatal: invalid reference: origin/ops/review-requests`: a bare `git fetch origin <branch>` writes
 * `FETCH_HEAD` and only updates `refs/remotes/origin/<branch>` when the CLONE'S CONFIGURED REFSPEC covers it.
 * A full clone carries `+refs/heads/*:refs/remotes/origin/*` and so it does; a `--single-branch` clone does
 * not, and the cloud session's checkouts are of that kind. The fix is `trackingRefspec` (#3264, landed as
 * PR #1544).
 *
 * A STUB RETURNING `''` CANNOT HAVE CLONE GEOMETRY. That is the entire bug class, and no amount of argv
 * assertion closes it — asserting the argv only pins today's spelling, it never says whether the spelling
 * WORKS. The only witness that can answer is a real `.git` directory with a real `remote.origin.fetch`. So
 * these three fixtures build one:
 *
 *   · `withRealRepo`     — one repo, no remote. For sinks that only need a working tree with history.
 *   · `withBareOrigin`   — a real bare `origin` plus a FULL clone. The wildcard-refspec geometry, i.e. the
 *                          geometry that hid #3264 for months because `we:` itself is cloned this way.
 *   · `withNarrowClone`  — the same, cloned `--single-branch`. THE ONE THAT REPRODUCES THE BUG.
 *
 * ── THREE HARD-WON DETAILS, so nobody rediscovers them ──────────────────────────────────────────────────
 *
 * (1) HERMETICITY NEEDS TWO LAYERS, not one. This machine's `--global` config carries `commit.gpgsign=true`
 *     with an ssh signing program that does not exist in a test worker. Passing `-c commit.gpgsign=false`
 *     per invocation covers `init`/`clone`, which run BEFORE any local config exists — but it does NOT
 *     cover the code under test, whose own `execFileSync('git', …)` is not ours to add flags to. So every
 *     fixture repo also gets `user.email` / `user.name` / `commit.gpgsign` written into its OWN
 *     `.git/config`. Without that second layer, the first real commit a SINK makes dies on a missing signing
 *     program, and the failure looks like a bug in the sink.
 *
 * (2) NEVER `git remote set-url origin https://github.com/…` TO GET A REALISTIC SLUG. `record-verdict`'s
 *     `defaultOriginRepo` derives `owner/name` from the origin URL, so a fixture needs a plausible slug. An
 *     earlier attempt at this harness set a real GitHub URL — and the next `git fetch origin` LEFT THE
 *     MACHINE and pulled the real repository. The origin here is instead a bare repo whose DIRECTORY is
 *     named `<tmp>/web-everything/web-everything.git`: `defaultOriginRepo`'s regex reads the identical slug off
 *     it, and it resolves to a path that exists nowhere but this temp dir.
 *
 * (3) UNIQUE TEMP DIRS AND `finally` CLEANUP. The suite is sharded, so two workers run these concurrently;
 *     a fixed path would have them fight over one `.git`. And cleanup runs on the throwing path too —
 *     these fixtures register real `git worktree` entries, and a leftover directory is not merely litter,
 *     it wedges the NEXT `worktree add` on the same branch (the failure `createRecordVerdictSinks`'s own
 *     `finally` block exists to prevent).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The slug every fixture origin answers to. Chosen to match this repo's real `origin` so a sink that
 * compares the two (`resolveTransportRoot`, #3261) takes its NORMAL path rather than its refusal path —
 * see detail (2) for why this is a directory name and never a URL.
 */
export const FIXTURE_SLUG = 'web-everything/web-everything';

/** The default branch of every fixture. Named explicitly so `init.defaultBranch` cannot decide it for us. */
export const DEFAULT_BRANCH = 'main';

/**
 * IDENTITY, layer one of detail (1): flags on the invocation itself, which is the only layer that can
 * exist during `init` and `clone` — there is no repo yet to hold a local config.
 */
const IDENTITY_FLAGS = [
  // A large seed commit can detach a repack even though execFileSync waits for the commit.
  // Fixture Git must finish all writes before snapshots or finally cleanup can run.
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'user.email=harness@example.invalid',
  '-c', 'user.name=Ops Harness',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  // `init` warns about the default branch name otherwise, and a warning on stderr is noise every fixture
  // would otherwise carry.
  '-c', 'init.defaultBranch=' + DEFAULT_BRANCH,
];

/**
 * Run real `git`. Throws with git's own stderr folded into the message, because a fixture that fails
 * silently is worse than no fixture — this whole module exists to make git's real complaints visible.
 *
 * @param {string[]} args
 * @param {{cwd: string, env?: object, input?: string}} opts
 * @returns {string} stdout
 */
export function git(args, { cwd, env = undefined, input = undefined }) {
  try {
    return String(execFileSync('git', [...IDENTITY_FLAGS, ...args], {
      cwd,
      encoding: 'utf8',
      // stdin is only opened when there is something to feed it — `hash-object --stdin` is the one caller
      // that needs it, and leaving it `ignore` everywhere else keeps a git that decides to prompt from
      // hanging the suite instead of failing it.
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(env ? { env } : {}),
      ...(input === undefined ? {} : { input }),
    }));
  } catch (cause) {
    const stderr = String(cause?.stderr ?? '').trim();
    throw new Error(`real-repo: git ${args.join(' ')} (in ${cwd}) failed: ${stderr || cause?.message || cause}`, { cause });
  }
}

/**
 * IDENTITY, layer two of detail (1). Written into the repo's OWN config so that git invocations WE DO NOT
 * MAKE — the un-injected `execFileSync('git', …)` inside the code under test, and any `git` it runs in a
 * worktree of this repo — commit successfully. A worktree shares its parent's repo-level config, so writing
 * it once here covers every worktree a sink adds later.
 *
 * @param {string} gitDir a work tree root, or a bare repo's own directory
 */
export function writeLocalIdentity(gitDir) {
  git(['config', 'user.email', 'harness@example.invalid'], { cwd: gitDir });
  git(['config', 'user.name', 'Ops Harness'], { cwd: gitDir });
  git(['config', 'commit.gpgsign', 'false'], { cwd: gitDir });
  git(['config', 'tag.gpgsign', 'false'], { cwd: gitDir });
  // The `-c gc.auto=0` in IDENTITY_FLAGS only covers OUR git calls. The code under test runs un-injected git
  // (fetch/commit/push) in this repo, and that can detach a `gc --auto` that is still writing into
  // `.git/objects` when the fixture's `finally` cleanup runs (ENOTEMPTY, seen on main @ b751cfac0 under load).
  git(['config', 'gc.auto', '0'], { cwd: gitDir });
  git(['config', 'maintenance.auto', 'false'], { cwd: gitDir });
}

/** Write `files` (a map of repo-relative path → content), stage exactly those paths, and commit. */
function commitFiles(cwd, files, message) {
  const paths = Object.keys(files);
  for (const rel of paths) {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, files[rel]);
  }
  git(['add', '--', ...paths], { cwd });
  git(['commit', '--quiet', '-m', message], { cwd });
  return git(['rev-parse', 'HEAD'], { cwd }).trim();
}

/** A fresh, uniquely-named scratch root. `realpathSync` because git reports resolved paths and a symlinked
 *  `/tmp` would make every path assertion in every caller wrong in a way that reads as a real failure. */
function scratch(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Run `fn(ctx)` and tear the scratch root down afterwards — on the throwing path too; see detail (3). */
async function within(tmp, ctx, fn) {
  try {
    return await fn(ctx);
  } finally {
    // Git's background housekeeping can briefly race recursive removal of .git/objects.
    // Retry transient cleanup failures, but still throw if the directory cannot be removed.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * ONE real repo with one real commit, no remote.
 *
 * For sinks whose only git dependency is "there is a checkout here with history" — `claim`'s dirty-file
 * probe, `verify`'s status read, `gate-health`'s log walk. Those do not need a remote, and giving them one
 * would only invite a test to accidentally depend on it.
 *
 * @param {(ctx: {tmp: string, root: string, git: Function, commit: Function, head: Function}) => any} fn
 */
export async function withRealRepo(fn) {
  const tmp = scratch('we-real-repo-');
  const root = join(tmp, 'repo');
  mkdirSync(root, { recursive: true });
  git(['init', '--quiet', '-b', DEFAULT_BRANCH, '.'], { cwd: root });
  writeLocalIdentity(root);
  commitFiles(root, { 'README.md': '# fixture\n' }, 'fixture: initial commit');
  return within(tmp, {
    tmp,
    root,
    git: (args, opts = {}) => git(args, { cwd: root, ...opts }),
    commit: (files, message = 'fixture: commit') => commitFiles(root, files, message),
    head: (rev = 'HEAD') => git(['rev-parse', rev], { cwd: root }).trim(),
  }, fn);
}

/**
 * The shared body of both clone fixtures. `cloneArgs` is the ONLY difference between them, and it is the
 * only difference that matters: it decides `remote.origin.fetch`, which decides whether a bare
 * `fetch origin <branch>` produces `refs/remotes/origin/<branch>`. See this file's header.
 */
async function withClone({ prefix, cloneArgs, narrow }, fn) {
  const tmp = scratch(prefix);
  let seedCounter = 0;
  // Detail (2): the SLUG comes from the directory name. `<tmp>/web-everything/web-everything.git` reads as
  // `web-everything/web-everything` through `defaultOriginRepo`'s regex and resolves to nothing off this machine.
  const origin = join(tmp, ...FIXTURE_SLUG.split('/'));
  mkdirSync(dirname(origin), { recursive: true });
  git(['init', '--bare', '--quiet', '-b', DEFAULT_BRANCH, `${origin}.git`], { cwd: tmp });
  const originDir = `${origin}.git`;
  writeLocalIdentity(originDir);

  /**
   * Create or advance `branch` ON THE ORIGIN at `from`, optionally adding `files`.
   *
   * BUILT WITH PLUMBING, no clone and no working tree. The obvious implementation — clone the origin,
   * commit, push, delete the clone — is correct but costs a clone per seeded branch, and these suites seed
   * two or three per test on top of the fixture's own. `hash-object` → `update-index` → `write-tree` →
   * `commit-tree` → `update-ref` produces the same objects at a fraction of the cost, against a scratch
   * `GIT_INDEX_FILE` so the origin's own index (a bare repo has none) is never involved.
   *
   * With no `files`, the branch is simply POINTED at `from` — no empty commit, so "was this branch re-cut"
   * stays a question about history rather than about how the fixture built it.
   */
  const seedBranch = (branch, files = {}, from = DEFAULT_BRANCH) => {
    let parent = '';
    try { parent = git(['rev-parse', '--verify', `${from}^{commit}`], { cwd: originDir }).trim(); } catch { parent = ''; }
    const names = Object.keys(files);
    if (!names.length) {
      if (!parent) throw new Error(`real-repo: seedOriginBranch(${branch}) has no files and no \`${from}\` to point at`);
      git(['update-ref', `refs/heads/${branch}`, parent], { cwd: originDir });
      return;
    }
    const index = join(tmp, `seed-index-${branch.replace(/[^a-z0-9]+/gi, '-')}-${seedCounter++}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    if (parent) git(['read-tree', parent], { cwd: originDir, env });
    for (const rel of names) {
      const blob = git(['hash-object', '-w', '--stdin'], { cwd: originDir, input: files[rel] }).trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { cwd: originDir, env });
    }
    const tree = git(['write-tree'], { cwd: originDir, env }).trim();
    const commitArgs = ['commit-tree', tree, '-m', `fixture: seed ${branch}`];
    if (parent) commitArgs.push('-p', parent);
    const commit = git(commitArgs, { cwd: originDir, env }).trim();
    git(['update-ref', `refs/heads/${branch}`, commit], { cwd: originDir });
    rmSync(index, { force: true });
  };

  // The origin needs a `main` before anything can clone it, built the same plumbing way.
  seedBranch(DEFAULT_BRANCH, { 'README.md': '# fixture origin\n' }, '(root)');

  const clone = join(tmp, 'clone');
  git(['clone', '--quiet', ...cloneArgs, originDir, clone], { cwd: tmp });
  writeLocalIdentity(clone);

  const ctx = {
    tmp,
    origin: originDir,
    clone,
    narrow,
    slug: FIXTURE_SLUG,
    git: (args, opts = {}) => git(args, { cwd: clone, ...opts }),
    commit: (files, message = 'fixture: commit', cwd = clone) => commitFiles(cwd, files, message),
    /** The clone's configured fetch refspecs — the fixture's OWN geometry, assertable by callers. */
    fetchRefspecs: () => git(['config', '--get-all', 'remote.origin.fetch'], { cwd: clone }).split('\n').map((s) => s.trim()).filter(Boolean),
    /** Branch names that actually exist on the bare origin — the only honest "did the push land" read. */
    originBranches: () => git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: originDir }).split('\n').map((s) => s.trim()).filter(Boolean),
    /** File content as it exists ON THE ORIGIN, never through the clone's working tree. */
    showOnOrigin: (branch, path) => git(['show', `${branch}:${path}`], { cwd: originDir }),
    /** Create or advance `branch` ON THE ORIGIN at `from`, optionally adding `files`. See `seedBranch`. */
    seedOriginBranch: seedBranch,
    /** Point the origin's HEAD elsewhere, so a fixture may delete the branch HEAD currently names. */
    setOriginHead: (branch) => git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: originDir }),
  };
  return within(tmp, ctx, fn);
}

/**
 * A real bare `origin` plus a FULL clone — `+refs/heads/*:refs/remotes/origin/*`.
 *
 * This is the geometry that HID #3264. `we:` itself is cloned this way, so the broken `fetch origin <branch>`
 * worked on every developer machine and in CI, and only failed on the narrow checkouts a cloud session gets.
 * A test here therefore proves the happy path still works; it CANNOT prove the bug is fixed. For that, use
 * `withNarrowClone`.
 */
export async function withBareOrigin(fn) {
  return withClone({ prefix: 'we-bare-origin-', cloneArgs: [], narrow: false }, fn);
}

/**
 * A real bare `origin` plus a `--single-branch` clone. **THE FIXTURE THAT REPRODUCES #3264.**
 *
 * `--single-branch` narrows `remote.origin.fetch` to `+refs/heads/main:refs/remotes/origin/main` — no
 * wildcard. In such a clone `git fetch origin ops/review-requests` succeeds, writes `FETCH_HEAD`, and leaves
 * no `refs/remotes/origin/ops/review-requests` behind; the next command to name that ref dies with
 * `fatal: invalid reference`. Callers should ASSERT the geometry (`fetchRefspecs()` has no `*`) rather than
 * trusting the flag, so that a future git whose `--single-branch` behaves differently fails loudly here
 * instead of quietly turning the reproduction back into a happy path.
 */
export async function withNarrowClone(fn) {
  return withClone({ prefix: 'we-narrow-clone-', cloneArgs: ['--single-branch', '--branch', DEFAULT_BRANCH], narrow: true }, fn);
}
