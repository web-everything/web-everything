// R497 step 2 (remote-exec git-sync design): SHADOW timing of the WIP git snapshot the future git-bundle
// transport will ship. No behaviour change: the result is only timed and recorded in the run receipt.
//
// The lane is never written to. The tree is built with a TEMP index (GIT_INDEX_FILE) in a SCRATCH object
// directory (GIT_OBJECT_DIRECTORY) that reads the lane's own object store through GIT_ALTERNATE_OBJECT_DIRECTORIES,
// so no object, index, HEAD or ref of the lane changes. It never throws: every failure is returned as {ok:false,error}.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test-shaped files that are gitignored but a test run needs (the 127 `ignored-test-file` fallbacks).
export const TEST_SHAPED = /(^|\/)(__tests__|__fixtures__|fixtures|test|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const PRUNED = /(^|\/)(node_modules|\.git)(\/|$)/;
const OFF = new Set(['0', 'off', 'false', 'no']);
export const shadowSnapshotEnabled = (env = process.env, enabled) =>
  enabled !== undefined ? Boolean(enabled) : !OFF.has(String(env.WE_REMOTE_SHADOW_SNAPSHOT ?? '').toLowerCase());

const defaultGit = (args, { cwd, env, input, timeout }) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
    if (error) return reject(Object.assign(new Error(`git ${args[0]} failed: ${String(stderr).trim().slice(0, 300) || error.message}`), { code: error.code }));
    resolve(stdout.toString());
  });
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
});

export async function shadowSnapshot({ cwd = process.cwd(), env = process.env, git = defaultGit, now = Date.now, timeoutMs = 60000, keepScratch = false } = {}) {
  const start = now();
  let scratch;
  const result = { ok: false, tree: null, commit: null, ignoredAdded: 0, fileCount: 0, durationMs: 0, error: null };
  try {
    scratch = await mkdtemp(join(tmpdir(), 'we-wip-snapshot-'));
    const laneObjects = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { cwd, env, timeout: timeoutMs })).trim();
    // Start from a clean git env: nothing inherited can redirect index/objects/refs at the lane.
    const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE)$/.test(k)));
    const shadow = {
      ...clean,
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: laneObjects,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'wip-snapshot', GIT_AUTHOR_EMAIL: 'wip-snapshot@invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'wip-snapshot', GIT_COMMITTER_EMAIL: 'wip-snapshot@invalid', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    const run = (args, input) => git(args, { cwd, env: shadow, input, timeout: timeoutMs });
    await mkdir(shadow.GIT_OBJECT_DIRECTORY, { recursive: true });
    const head = (await run(['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
    if (head) await run(['read-tree', head]);
    await run(['add', '-A']);
    // Ignored test-shaped files, force-added (design pick 2). node_modules/.git are never listed.
    const ignored = (await run(['ls-files', '-o', '-i', '--exclude-standard', '-z', '--', ':(exclude,glob)**/node_modules/**']))
      .split('\0').filter((p) => p && !PRUNED.test(p) && TEST_SHAPED.test(p));
    if (ignored.length) await run(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], ignored.join('\0') + '\0');
    result.ignoredAdded = ignored.length;
    result.tree = (await run(['write-tree'])).trim();
    result.fileCount = (await run(['ls-tree', '-r', '--name-only', '-z', result.tree])).split('\0').filter(Boolean).length;
    result.commit = (await run(['commit-tree', result.tree, ...(head ? ['-p', head] : []), '-m', 'wip snapshot (shadow)'])).trim();
    if (keepScratch) result.scratchObjects = shadow.GIT_OBJECT_DIRECTORY;
    result.ok = true;
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 400);
  } finally {
    if (scratch && !keepScratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    result.durationMs = Math.max(0, Math.round(now() - start));
  }
  return result;
}

/** One-line hook for the remote ship path: `await shadowSnapshotStage({ cwd, begin, env })` next to manifest-build.
 * `begin(stage)` is remote-exec's timing starter; it returns a closer that takes extra receipt fields. Never throws. */
export async function shadowSnapshotStage({ cwd, begin, env = process.env, enabled, ...rest } = {}) {
  if (!shadowSnapshotEnabled(env, enabled)) return null;
  let done = () => {};
  try { done = begin ? begin('wip-snapshot-shadow') : done; } catch { /* timing is best effort */ }
  const result = await shadowSnapshot({ cwd, env, ...rest });
  try {
    done({ shadow: true, ok: result.ok, ignoredAdded: result.ignoredAdded, fileCount: result.fileCount, ...(result.tree ? { tree: result.tree } : {}), ...(result.error ? { error: result.error } : {}) });
  } catch { /* never fail the run */ }
  return result;
}
