/**
 * @file scripts/lib/daemon-version-migrate.mjs
 * @description Card 89 S6 — move one daemon clone onto immutable versions (migrate) and back (unmigrate).
 *
 * migrate: refuse overlays / tracked dirt / an already-migrated clone; make `<home>/<name>/repo.git` (a local
 * clone, so objects are hard-linked and independent of the legacy clone); build + smoke v0 from the clone's HEAD;
 * point `current` at it; enable the clone on this host (`settings.local.json`); RENAME each state path into
 * `<home>/<name>/state/` and leave a symlink behind; then swap `<clone>` for a symlink to `current`, parking the
 * old directory as `<home>/<name>/legacy-<stamp>`. Running processes keep their open files and cwd (inodes).
 * unmigrate reverses each step with renames, so the tree, the state files and the clone key come back unchanged.
 * Also: plist rewriting that moves only ProgramArguments and WorkingDirectory onto `current`.
 */
import * as filesystem from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { logicalCloneRoot } from './daemon-clone-layout.mjs';
import { validateDaemonVersionsSettings } from './daemon-versions-settings.mjs';
import { switchCurrent } from './daemon-version-switch.mjs';
import { readOverlays } from './daemon-overlays.mjs';

const stat = (fs, path) => { try { return fs.lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
function git(cwd, args) {
  const r = gitIn(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr || r.error || ''}`.trim());
  return String(r.stdout).trim();
}
/** Copy entries the target lacks (a file re-created in the rename gap); existing target entries win. */
function mergeMissing(fs, source, target) {
  const s = fs.lstatSync(source);
  const t = stat(fs, target);
  if (s.isDirectory()) {
    if (t && !t.isDirectory()) return;
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) mergeMissing(fs, join(source, name), join(target, name));
  } else if (!t) {
    if (s.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else fs.copyFileSync(source, target);
  }
}
/** Put moved state paths back as real entries (used by a failed migrate and by unmigrate). */
function restoreState(fs, p, list) {
  const restored = [];
  for (const path of list) {
    const src = join(p.logical, path);
    const dest = join(p.state, path);
    if (!stat(fs, dest)) continue;
    const here = stat(fs, src);
    if (here) {
      if (here.isDirectory()) mergeMissing(fs, src, dest);
      fs.rmSync(src, { recursive: true, force: true });
    }
    fs.mkdirSync(dirname(src), { recursive: true });
    fs.renameSync(dest, src);
    restored.push(path);
  }
  return restored;
}
function stripExclude(fs, file, lines) {
  if (!lines?.length || !stat(fs, file)) return;
  const drop = new Set(lines);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(l => !drop.has(l)).join('\n'));
}
const paths = (name, clone, home) => {
  const logical = logicalCloneRoot(clone);
  const root = join(resolve(home ?? join(dirname(logical), '.daemon-clones')), name);
  return { logical, root, state: join(root, 'state'), repo: join(root, 'repo.git'), marker: join(root, 'settings.local.json'), record: join(root, 'migration.json') };
};

export async function migrate({ clone, home, settings, dryRun = false, force = false, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  const name = basename(logicalCloneRoot(clone));
  const p = paths(name, clone, home);
  const config = validateDaemonVersionsSettings(settings ?? { });
  const here = stat(fs, p.logical);
  if (!here?.isDirectory()) return { status: 'refused', reason: here?.isSymbolicLink() ? 'already-a-symlink' : 'clone-missing' };
  if (stat(fs, join(p.root, 'current'))) return { status: 'refused', reason: 'already-migrated' };
  const overlays = readOverlays(p.logical, { env: deps.env ?? process.env });
  if (overlays.length) return { status: 'refused', reason: 'overlays', overlays: overlays.map(o => o.ref) };
  const dirt = git(p.logical, ['status', '--porcelain', '--untracked-files=no']);
  if (dirt && !force) return { status: 'refused', reason: 'tracked-dirt', dirt: dirt.split('\n').slice(0, 20) };
  const sha = git(p.logical, ['rev-parse', '--verify', 'HEAD^{commit}']);
  // v0 is built from this HEAD, so HEAD itself must understand the host-local enable file; otherwise the
  // migrated daemon runs the old in-place rebuild inside a version folder (found live 2026-10-08, rolled back).
  if (deps.requireHostEnable !== false
    && gitIn(p.logical, ['grep', '-q', 'settings.local.json', sha, '--', 'scripts/lib/daemon-version-runtime.mjs']).status !== 0) {
    return { status: 'refused', reason: 'clone-lacks-host-enable', hint: 'let the clone sync to a main that has card 89 S6' };
  }
  const originUrl = git(p.logical, ['config', '--get', 'remote.origin.url']);
  const stateNow = config.statePaths.filter(path => stat(fs, join(p.logical, path)));
  if (dryRun) return { status: 'dry-run', name, sha, originUrl, root: p.root, wouldMove: stateNow };

  const steps = [];
  fs.mkdirSync(p.root, { recursive: true });
  if (!stat(fs, join(p.repo, 'HEAD'))) {
    git(dirname(p.logical), ['clone', '--bare', '--quiet', '--', p.logical, p.repo]);
    git(p.repo, ['remote', 'set-url', 'origin', originUrl]);
    steps.push('repo.git');
  }
  git(p.repo, ['fetch', '--quiet', '--no-tags', '--', p.logical, '+HEAD:refs/migrate/base']);
  // State first: rename (atomic, same volume), then link back so the live daemon keeps writing to the same
  // place. Done before the build so the version's state links resolve while its smoke runs.
  const moved = [];
  const exclude = join(p.logical, '.git', 'info', 'exclude');
  const added = [];
  const undo = () => { restoreState(fs, p, moved); stripExclude(fs, exclude, added); };
  for (const path of stateNow) {
    const src = join(p.logical, path);
    const dest = join(p.state, path);
    if (stat(fs, src)?.isSymbolicLink()) continue;
    fs.mkdirSync(dirname(dest), { recursive: true });
    if (stat(fs, dest)) { mergeMissing(fs, src, dest); fs.rmSync(src, { recursive: true, force: true }); }
    else fs.renameSync(src, dest);
    const gap = stat(fs, src); // recreated by a writer in the microsecond gap
    if (gap) { if (gap.isDirectory()) mergeMissing(fs, src, dest); fs.rmSync(src, { recursive: true, force: true }); }
    fs.symlinkSync(dest, src);
    moved.push(path);
  }
  // A symlink is not matched by a `dir/` ignore pattern, so keep the legacy tree looking clean to git.
  const have = stat(fs, exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  for (const path of moved) if (!have.split('\n').includes(`/${path}`)) added.push(`/${path}`);
  if (added.length) fs.appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${added.join('\n')}\n`);
  steps.push(`state ${moved.length}`);

  const on = { ...config, enabled: { [name]: true } };
  // A smoke-failed version of this commit is reusable by the builder; a retry must build afresh.
  const versionsDir = join(p.root, 'versions');
  if (stat(fs, versionsDir)) for (const entry of fs.readdirSync(versionsDir)) {
    try {
      const r = JSON.parse(fs.readFileSync(join(versionsDir, entry, '.version.json'), 'utf8'));
      if (r.sha === sha && r.status !== 'built') fs.rmSync(join(versionsDir, entry), { recursive: true, force: true });
    } catch { /* staging or unreadable: not ours */ }
  }
  // Injected by the CLI: daemon-version.mjs is the entry module there, and importing it back would deadlock.
  const buildVersion = deps.buildVersion ?? (await import('./daemon-version.mjs')).buildVersion;
  const built = await buildVersion({ clone: p.logical, home: dirname(p.root), sha, settings: on, force: true, repo: p.repo, deps: deps.buildDeps });
  const record = built.status === 'reused' ? JSON.parse(fs.readFileSync(join(built.dir, '.version.json'), 'utf8')) : built;
  if (record.status !== 'built') { undo(); return { status: 'refused', reason: 'smoke-failed', id: record.id, smoke: record.smoke?.smoke?.results?.filter(r => !r.ok), steps }; }
  steps.push(`v0 ${record.id}`);
  const switched = await switchCurrent({ clone: p.logical, home: dirname(p.root), id: record.id, expectCurrent: null, settings: on, by: 'migrate', reason: 'migrate v0' });
  if (switched.status !== 'switched') { undo(); return { status: 'refused', reason: `switch-${switched.status}`, switched, steps }; }
  steps.push('current');
  fs.writeFileSync(p.marker, `${JSON.stringify({ enabled: true })}\n`);
  steps.push('enabled');

  const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const legacy = join(p.root, `legacy-${stamp}`);
  const tmp = join(dirname(p.logical), `${name}.tmp-link`);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(relative(dirname(p.logical), join(p.root, 'current')), tmp);
  fs.renameSync(p.logical, legacy);
  try { fs.renameSync(tmp, p.logical); }
  catch (error) { fs.renameSync(legacy, p.logical); throw error; }
  steps.push('swapped');
  fs.writeFileSync(p.record, `${JSON.stringify({ migratedAt: new Date((deps.now ?? Date.now)()).toISOString(), legacy, moved, excluded: added, v0: record.id, sha, originUrl }, null, 2)}\n`);
  return { status: 'migrated', name, v0: record.id, legacy, moved, steps };
}

export async function unmigrate({ clone, home, settings, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  const name = basename(logicalCloneRoot(clone));
  const p = paths(name, clone, home);
  const config = validateDaemonVersionsSettings(settings ?? { });
  if (!stat(fs, p.logical)?.isSymbolicLink()) return { status: 'refused', reason: 'not-migrated' };
  let info;
  try { info = JSON.parse(fs.readFileSync(p.record, 'utf8')); } catch { return { status: 'refused', reason: 'no-migration-record' }; }
  if (!stat(fs, info.legacy)?.isDirectory()) return { status: 'refused', reason: 'legacy-missing', legacy: info.legacy };
  // Put the legacy directory back first, so a daemon that wakes up sees a real clone as soon as possible.
  fs.unlinkSync(p.logical);
  try { fs.renameSync(info.legacy, p.logical); }
  catch (error) { fs.symlinkSync(relative(dirname(p.logical), join(p.root, 'current')), p.logical); throw error; }
  const restored = restoreState(fs, p, config.statePaths);
  stripExclude(fs, join(p.logical, '.git', 'info', 'exclude'), info.excluded);
  fs.rmSync(p.marker, { force: true });
  for (const f of ['current', 'previous', 'state.json', 'migration.json']) fs.rmSync(join(p.root, f), { force: true });
  return { status: 'unmigrated', name, restored, versionsKept: join(p.root, 'versions') };
}

/** Move only ProgramArguments strings and WorkingDirectory from `<ws>/<name>` onto `<ws>/.daemon-clones/<name>/current`. */
export function versionedPlistText(text, { name }) {
  const swap = value => value.replace(new RegExp(`^(.*)/${name}(?=/|$)`), (all, ws) => (ws.endsWith('/.daemon-clones') ? all : `${ws}/.daemon-clones/${name}/current`));
  let out = text.replace(/(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/, (m, a, body, z) => a + body.replace(/<string>([^<]*)<\/string>/g, (s, v) => `<string>${swap(v)}</string>`) + z);
  out = out.replace(/(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/, (m, a, v, z) => a + swap(v) + z);
  return out;
}

export function rewritePlist({ file, name, backupDir, revertFrom, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  if (revertFrom) { fs.copyFileSync(revertFrom, file); return { status: 'reverted', file }; }
  const text = fs.readFileSync(file, 'utf8');
  const next = versionedPlistText(text, { name });
  if (next === text) return { status: 'noop' };
  if (!backupDir) throw new Error('--backup-dir is required');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `${basename(file)}.pre-versions`);
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, next);
  return { status: 'rewritten', backup };
}
