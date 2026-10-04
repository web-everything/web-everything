/**
 * @file scripts/__tests__/fixtures/shared-git-fixture.mjs
 * @description One origin + reference git fixture per TEST FILE instead of one per test.
 *
 * The real-git lane-pool tests each rebuilt the same throwaway bare origin + reference checkout in a
 * `beforeEach` (init, clone, commit, push) — pure file-system churn repeated for every test. This builds them
 * once (`beforeAll`), records their exact state, and after every test puts them back: refs (branches, tags,
 * remote-tracking refs, stash) to the recorded SHAs, HEAD to the recorded branch, the working tree and index
 * to HEAD with every untracked/ignored file removed, and `.git/config`, `.git/info/*` and `.git/hooks/*`
 * back to their recorded bytes (new files there are deleted). Each test therefore starts from the same state a
 * fresh per-test fixture gave it, while everything else a test creates (pool root, shims, scratch clones)
 * still lives in its own fresh per-test temp dir, so no other path is shared between tests.
 *
 * Not restored: unreachable objects a test added to the object store, and reflogs. Neither is visible to
 * ref-based logic (branch containment, `ls-remote`, `cherry`, fetch), which is all these tests exercise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Files under the git dir whose bytes we record and restore (refs are handled through `update-ref`).
const TRACKED_GIT_FILES = (gitDir) => {
  const out = ['config'];
  for (const sub of ['info', 'hooks']) {
    const d = join(gitDir, sub);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      if (statSync(join(d, name)).isFile()) out.push(`${sub}/${name}`);
    }
  }
  return out;
};

function gitDirOf(dir) {
  return existsSync(join(dir, '.git')) ? join(dir, '.git') : dir;
}

function readRefs(dir) {
  const map = new Map();
  for (const line of git(['for-each-ref', '--format=%(objectname) %(refname)'], dir).split('\n').filter(Boolean)) {
    const i = line.indexOf(' ');
    map.set(line.slice(i + 1), line.slice(0, i));
  }
  return map;
}

/** Record the full restorable state of one repo (bare or non-bare). */
export function snapshotRepo(dir) {
  const gitDir = gitDirOf(dir);
  const bare = gitDir === dir;
  let head;
  try { head = { symbolic: git(['symbolic-ref', 'HEAD'], dir) }; } catch { head = { sha: git(['rev-parse', 'HEAD'], dir) }; }
  const files = new Map(TRACKED_GIT_FILES(gitDir).map((rel) => [rel, readFileSync(join(gitDir, rel))]));
  return { dir, gitDir, bare, head, refs: readRefs(dir), files };
}

/** Put one repo back to its snapshot. Writes only what changed, so an untouched repo costs a few reads. */
export function restoreRepo(snap) {
  const { dir, gitDir, bare, head, refs, files } = snap;
  // Refs: delete extras, reset changed/missing ones — one `update-ref --stdin` transaction.
  const now = readRefs(dir);
  const cmds = [];
  for (const [ref, sha] of now) if (!refs.has(ref)) cmds.push(`delete ${ref} ${sha}`);
  for (const [ref, sha] of refs) if (now.get(ref) !== sha) cmds.push(`update ${ref} ${sha}`);
  if (cmds.length) execFileSync('git', ['update-ref', '--no-deref', '--stdin'], { cwd: dir, input: cmds.join('\n') + '\n' });
  // HEAD.
  if (head.symbolic) {
    let cur = null;
    try { cur = git(['symbolic-ref', 'HEAD'], dir); } catch { /* detached */ }
    if (cur !== head.symbolic) git(['symbolic-ref', 'HEAD', head.symbolic], dir);
  } else {
    git(['update-ref', '--no-deref', 'HEAD', head.sha], dir);
  }
  // Git-dir files: config, info/*, hooks/* back to recorded bytes; new ones removed.
  for (const rel of TRACKED_GIT_FILES(gitDir)) if (!files.has(rel)) rmSync(join(gitDir, rel), { force: true });
  for (const [rel, bytes] of files) {
    const p = join(gitDir, rel);
    if (!existsSync(p) || !readFileSync(p).equals(bytes)) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bytes);
    }
  }
  for (const f of ['index.lock', 'HEAD.lock', 'config.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(join(gitDir, f))) rmSync(join(gitDir, f), { recursive: true, force: true });
  }
  if (bare) return;
  // Working tree + index: only touch them when they differ from HEAD (`status` sees untracked + ignored too).
  const dirty = execFileSync('git', ['status', '--porcelain', '--ignored', '--untracked-files=all'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  if (dirty || cmds.length) {
    git(['reset', '--quiet', '--hard', 'HEAD'], dir);
    git(['clean', '-ffdxq'], dir);
  }
}

/**
 * Snapshot the repos a `beforeAll` just built under `root`. Returns `restore()` for `afterEach` (puts every
 * repo back to this snapshot) and `dispose()` for `afterAll` (removes `root`).
 */
export function sharedRepos(root, repoDirs) {
  const snaps = repoDirs.map(snapshotRepo);
  return {
    restore() { for (const s of snaps) restoreRepo(s); },
    dispose() { rmSync(root, { recursive: true, force: true }); },
  };
}
