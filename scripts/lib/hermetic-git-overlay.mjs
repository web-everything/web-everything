/**
 * @file hermetic-git-overlay.mjs — a FIXTURE for tests that must run a real tool over the real checkout's tree
 * (check:standards, a CLI that derives its root from its own file location) without reading the live remote refs
 * (card xcu4cqf, hermetic tests by default).
 *
 * The overlay is a tiny throwaway git dir: the real working tree (`GIT_WORK_TREE`), the real object store (through
 * `objects/info/alternates`, nothing copied), a copy of the real index, and its OWN refs: `main` and `origin/main`
 * both pinned to the real `HEAD` commit. A child run with {@link GitOverlay.env} sees exactly the checkout's content,
 * but `origin/main` is a fixture that never moves when someone pushes — so its result cannot drift with live data.
 * The hermetic `git` shim sees `GIT_DIR` outside every real checkout and lets it through.
 *
 * Costs milliseconds and a ~1–2 MB index copy, unlike a clone or a tree copy (tens of thousands of files).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * @typedef {{gitDir: string, head: string, env: {GIT_DIR: string, GIT_WORK_TREE: string}, cleanup: () => void}} GitOverlay
 */

/**
 * @param {string} root the real checkout (its working tree)
 * @param {{base?: string}} [o] parent dir for the overlay (default: the OS temp dir)
 * @returns {GitOverlay}
 */
export function makeGitOverlay(root, { base = tmpdir() } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const absGitDir = git(['rev-parse', '--absolute-git-dir']);
  const commonRaw = git(['rev-parse', '--git-common-dir']);
  const common = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw);
  const head = git(['rev-parse', 'HEAD']);

  const dir = mkdtempSync(join(base, 'we-git-overlay-'));
  for (const sub of ['objects/info', 'refs/heads', 'refs/remotes/origin', 'refs/tags', 'info']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'objects', 'info', 'alternates'), `${join(common, 'objects')}\n`);
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'refs', 'heads', 'main'), `${head}\n`);
  writeFileSync(join(dir, 'refs', 'remotes', 'origin', 'main'), `${head}\n`);
  writeFileSync(join(dir, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n');
  writeFileSync(join(dir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n');
  if (existsSync(join(absGitDir, 'index'))) copyFileSync(join(absGitDir, 'index'), join(dir, 'index'));
  if (existsSync(join(common, 'info', 'exclude'))) copyFileSync(join(common, 'info', 'exclude'), join(dir, 'info', 'exclude'));

  return {
    gitDir: dir,
    head,
    env: { GIT_DIR: dir, GIT_WORK_TREE: root },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
