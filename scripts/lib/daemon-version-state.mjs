/**
 * @file scripts/lib/daemon-version-state.mjs
 * @description Card 89 S2 — dormant module, no runtime consumer yet.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { collectUntrackedPaths, pruneLandedBacklogSidecars } from './daemon-rebuild/local-state.mjs';

const gitAt = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tracked = (root, path) => gitAt(root, ['ls-files', '-z', '--', `:(literal)${path}`]).length > 0;
function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Copy missing entries only; existing target entries (including symlinks) win. */
function mergeMissing(source, target) {
  const sourceStat = lstatSync(source);
  const targetStat = stat(target);
  if (sourceStat.isDirectory()) {
    if (targetStat && !targetStat.isDirectory()) return;
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) mergeMissing(join(source, name), join(target, name));
  } else if (!targetStat) {
    if (sourceStat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
}

/**
 * A state path must be a plain relative path: it is written into the shared info/exclude as `/<path>` and
 * used for recursive removal, so control characters, gitignore glob metacharacters (`* ? [ ] \`), a trailing
 * space (gitignore drops it), and empty/`.`/`..` segments (absolute, doubled or traversing paths) are refused.
 */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f*?[\]\\]/;
function plainRelativePath(path) {
  return typeof path === 'string' && path !== '' && !UNSAFE_PATH_CHARS.test(path) && !path.endsWith(' ')
    && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
      && segment.toLowerCase() !== '.git');
}

/** One state path nested under another would link-then-merge its own symlink into a loop; refuse both. */
const overlaps = (path, others) => others.some(other => other !== path
  && (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)));

/** Only directories, regular files and symlinks can be merged; a fifo would hang the copy, a socket throws. */
function mergeable(source) {
  const entry = lstatSync(source);
  if (entry.isDirectory()) return readdirSync(source).every(name => mergeable(join(source, name)));
  return entry.isFile() || entry.isSymbolicLink();
}

/** Every existing ancestor inside versionDir must be a real directory, never a symlink or a file. */
function realParents(versionDir, path) {
  const segments = path.split('/').slice(0, -1);
  let current = versionDir;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = stat(current);
    if (!entry) return true;
    if (!entry.isDirectory()) return false;
  }
  return true;
}

/** Link persistent state; merged paths are reported separately from ordinary links. */
export function linkVersionState({ versionDir, stateDir, statePaths, alert }) {
  const result = { linked: [], merged: [], refused: [] };
  for (const path of statePaths) {
    if (!plainRelativePath(path) || overlaps(path, statePaths) || !realParents(versionDir, path)) {
      result.refused.push(path);
      alert('state-link-invalid', { path });
      continue;
    }
    const source = join(versionDir, path);
    const target = resolve(stateDir, path);
    mkdirSync(dirname(target), { recursive: true });
    const entry = stat(source);
    if (tracked(versionDir, path) || (entry?.isSymbolicLink()
      && resolve(dirname(source), readlinkSync(source)) !== target)) {
      result.refused.push(path);
      alert('state-link-collision', { path });
      continue;
    }
    if (entry && !entry.isSymbolicLink()) {
      if (!mergeable(source)) {
        result.refused.push(path);
        alert('state-link-invalid', { path });
        continue;
      }
      mergeMissing(source, target);
      rmSync(source, { recursive: true });
      symlinkSync(target, source);
      result.merged.push(path);
      alert('state-link-merged', { path });
    } else {
      if (!entry) {
        mkdirSync(dirname(source), { recursive: true });
        symlinkSync(target, source);
      }
      result.linked.push(path);
    }
  }
  const paths = [...result.linked, ...result.merged];
  if (paths.length) {
    const exclude = resolve(versionDir, gitAt(versionDir, ['rev-parse', '--git-path', 'info/exclude']).trim());
    mkdirSync(dirname(exclude), { recursive: true });
    const content = stat(exclude) ? readFileSync(exclude, 'utf8') : '';
    const lines = new Set(content.split(/\r?\n/));
    const additions = [...new Set(paths.map(path => `/${path}`))].filter(line => !lines.has(line));
    if (additions.length) appendFileSync(exclude,
      `${content && !content.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
  }
  return result;
}

/** Prune main-proven sidecars before carrying the remaining untracked files. */
export function carryUntrackedSidecars({ git, fromRoot, toRoot, mainSha, alert, skipPaths = [] }) {
  const result = { carried: [], skipped: [], refused: [] };
  let paths = collectUntrackedPaths(git);
  if (paths === null) { alert('status-failed'); return result; }
  pruneLandedBacklogSidecars({ git, root: fromRoot, paths, mainSha, alert });
  paths = collectUntrackedPaths(git);
  if (paths === null) { alert('status-failed'); return result; }
  for (const path of paths) {
    if (skipPaths.some(skip => path === skip || path.startsWith(`${skip.replace(/\/+$/, '')}/`))) {
      result.skipped.push(path);
      continue;
    }
    // lstat, never follow: git lists symlinks (preserved as links, never dereferenced) and nested repos as `dir/`.
    const source = join(fromRoot, path);
    const sourceStat = stat(source);
    if (!sourceStat || !(sourceStat.isSymbolicLink() || sourceStat.isFile())) {
      result.refused.push(path);
      alert('untracked-unsupported', { path });
      continue;
    }
    const target = join(toRoot, path);
    if (!realParents(toRoot, path)) {
      result.refused.push(path);
      alert('untracked-unsupported', { path });
      continue;
    }
    if (stat(target) || tracked(toRoot, path)) {
      result.refused.push(path);
      alert('untracked-collision', { path });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else copyFileSync(source, target, constants.COPYFILE_EXCL);
    result.carried.push(path);
  }
  return result;
}

/** Report both names of renames/copies, preserving whitespace in porcelain -z paths. */
export function reportOutgoingDirt({ git, alert }) {
  const status = git(['status', '--porcelain', '-z']);
  if (status.status !== 0) { alert('status-failed'); return []; }
  const entries = String(status.stdout ?? '').split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && i + 1 < entries.length) paths.push(entries[++i]);
  }
  const changed = [...new Set(paths)];
  if (changed.length) alert('version-dirty', { paths: changed });
  return changed;
}
