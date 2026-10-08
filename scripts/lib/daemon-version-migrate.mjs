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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
/** Move a real entry that would otherwise be overwritten or deleted into `<root>/conflicts/<stamp>/`; nothing is ever removed. */
function parkAside(fs, p, src, path) {
  fs.mkdirSync(p.conflicts, { recursive: true });
  const base = join(p.conflicts, path.replaceAll('/', '__'));
  let target = base;
  for (let n = 1; stat(fs, target); n += 1) target = `${base}.${n}`;
  fs.renameSync(src, target);
  return target;
}
/** A plain relative path, as the state-linking code requires: no control or glob characters, no `.`/`..`/`.git` segments. */
const plainRelativePath = path => typeof path === 'string' && path !== '' && !/[\u0000-\u001f\u007f*?[\]\\]/.test(path)
  && !path.endsWith(' ') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
/** `migration.json` is read back by unmigrate, so its paths are untrusted until they pass the same rules as the settings. */
const validRecord = (info, p) => info !== null && typeof info === 'object'
  && Array.isArray(info.moved) && info.moved.every(plainRelativePath)
  && Array.isArray(info.excluded ?? []) && (info.excluded ?? []).every(line => typeof line === 'string' && line.startsWith('/') && plainRelativePath(line.slice(1)))
  && typeof info.legacy === 'string' && dirname(resolve(info.legacy)) === p.root && basename(info.legacy).startsWith('legacy-');
/** Credentials in a remote url never reach a record or a log. */
const redactUrl = url => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i, '$1***@').replace(/[?#].*$/s, '');
/**
 * A relative local-path remote (`../origin.git`) means "relative to where git runs"; copied into repo.git and every
 * version it would point somewhere else, so each later fetch fails. Make it absolute against the original clone,
 * before anything moves. Anything that names a host (`scheme://`, scp-style `host:path`) or is already absolute stays.
 */
function absoluteRemote(logical, url) {
  if (url === '' || isAbsolute(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\\]+:/.test(url)) return url;
  return resolve(logical, url);
}
const readRecord = (fs, p) => { try { return JSON.parse(fs.readFileSync(p.record, 'utf8')); } catch { return null; } };
const tmpLinkOf = p => join(dirname(p.logical), `${basename(p.logical)}.tmp-link`);
/**
 * The swap is two renames: the clone aside to `legacy`, then a link to `current` in its place. A kill between them
 * leaves no clone at all. The migration record is written BEFORE the first rename, so it is the journal: with the
 * clone missing, a valid record, and its `legacy` still a directory, the swap was cut short.
 */
function interruptedSwap(fs, p) {
  if (stat(fs, p.logical)) return null;
  const info = readRecord(fs, p);
  return validRecord(info, p) && stat(fs, info.legacy)?.isDirectory() && stat(fs, join(p.root, 'current')) ? info : null;
}
/** Place the link at the clone path (second rename); safe to repeat. */
function linkClone(fs, p) {
  const tmp = tmpLinkOf(p);
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(relative(dirname(p.logical), join(p.root, 'current')), tmp);
  fs.renameSync(tmp, p.logical);
}
const stampOf = deps => new Date((deps.now ?? Date.now)()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Put moved state paths back as real entries (used by a failed migrate and by unmigrate). */
function restoreState(fs, p, list) {
  const restored = [];
  for (const path of list) {
    const src = join(p.logical, path);
    const dest = join(p.state, path);
    if (!stat(fs, dest)) continue;
    const here = stat(fs, src);
    if (here?.isSymbolicLink()) fs.rmSync(src, { force: true });
    else if (here) {
      // A writer put a real entry where the link was: keep it (merged into the state, and whole in conflicts/).
      if (here.isDirectory()) mergeMissing(fs, src, dest);
      parkAside(fs, p, src, path);
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
/**
 * The clones root the runtime will look in, from the settings FILE alone. The daemon runs under launchd with its
 * own environment, so neither the operator's shell nor its cwd can be assumed to match: an env override or a
 * relative clonesRoot is refused by `homeProblem` instead of being guessed at.
 */
function runtimeHome(logical, settings) {
  const { clonesRoot } = validateDaemonVersionsSettings(settings ?? {});
  return clonesRoot ? resolve(clonesRoot) : join(dirname(logical), '.daemon-clones');
}
function homeProblem(logical, settings, home, env) {
  const config = validateDaemonVersionsSettings(settings ?? {});
  const wanted = runtimeHome(logical, settings);
  const hint = 'omit --home, or set an absolute clonesRoot in the daemon-versions settings file and nowhere else';
  if (env?.WE_DAEMON_VERSIONS_CLONES_ROOT !== undefined) return { reason: 'clones-root-env', hint: 'the daemon cannot be shown to share this environment variable; unset it' };
  if (config.clonesRoot && !isAbsolute(config.clonesRoot)) return { reason: 'clones-root-relative', hint };
  if (home !== undefined && resolve(home) !== wanted) return { reason: 'home-not-discoverable', home: resolve(home), runtimeHome: wanted, hint };
  return null;
}
/** Files in `<home>/<name>` that migrate may overwrite: remembered exactly (bytes or link text) so a rollback restores them. */
const HOME_FILES = ['current', 'previous', 'state.json', 'migration.json', 'settings.local.json'];
const MAX_HOME_FILE_BYTES = 1024 * 1024;
/** JSON-safe, so the same snapshot can sit in the on-disk intent and survive a killed process. */
function snapshotHomeFiles(fs, root) {
  const saved = {};
  for (const f of HOME_FILES) {
    const s = stat(fs, join(root, f));
    if (!s) continue;
    if (s.isSymbolicLink()) saved[f] = { link: fs.readlinkSync(join(root, f)) };
    else if (s.isFile() && s.size <= MAX_HOME_FILE_BYTES) saved[f] = { data: fs.readFileSync(join(root, f)).toString('base64'), mode: s.mode & 0o777 };
    else throw new Error(`${join(root, f)} is not a plain file of at most ${MAX_HOME_FILE_BYTES} bytes: refusing to migrate over it`);
  }
  return saved;
}
/** Each file is replaced by rename, so a kill mid-restore never leaves a file missing; one failure does not skip the rest. */
function restoreHomeFiles(fs, root, saved) {
  const failures = [];
  for (const f of HOME_FILES) {
    const file = join(root, f);
    const before = saved[f];
    try {
      if (!before) { fs.rmSync(file, { force: true }); continue; }
      const temp = `${file}.restore-${process.pid}`;
      fs.rmSync(temp, { force: true });
      if (before.link !== undefined) fs.symlinkSync(before.link, temp);
      else { fs.writeFileSync(temp, Buffer.from(before.data, 'base64')); fs.chmodSync(temp, before.mode); }
      fs.renameSync(temp, file);
    } catch (error) { failures.push(`${f}: ${error.message}`); }
  }
  if (failures.length) throw new Error(`could not restore home files: ${failures.join('; ')}`);
}
/**
 * The durable record of a migrate in flight, written BEFORE its first state rename and deleted when it ends. It is
 * what lets a run that was killed (no `catch` ran) be undone exactly: the state paths it may have moved, the
 * exclude lines it appended, and the home files as they were.
 */
const intentFile = p => join(p.root, 'migrate-intent.json');
const HOME_FILE_SET = new Set(HOME_FILES);
function readIntent(fs, p) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(intentFile(p), 'utf8')); } catch { return null; }
  const ok = raw !== null && typeof raw === 'object' && Array.isArray(raw.paths) && raw.paths.every(plainRelativePath)
    && Array.isArray(raw.exclude) && raw.exclude.every(l => typeof l === 'string' && l.startsWith('/') && plainRelativePath(l.slice(1)))
    && raw.home !== null && typeof raw.home === 'object'
    && Object.entries(raw.home).every(([f, v]) => HOME_FILE_SET.has(f) && v !== null && typeof v === 'object'
      && (typeof v.link === 'string' || (typeof v.data === 'string' && Number.isInteger(v.mode))));
  return ok ? raw : null;
}
function writeIntent(fs, p, intent) {
  const temp = `${intentFile(p)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
  fs.renameSync(temp, intentFile(p));
}
/** A migrate that was killed midway: put the state, exclude lines and home files back; the caller then starts fresh. */
function recoverFromIntent(fs, p) {
  if (!stat(fs, intentFile(p))) return;
  const intent = readIntent(fs, p);
  if (intent) {
    restoreState(fs, p, intent.paths);
    stripExclude(fs, join(p.logical, '.git', 'info', 'exclude'), intent.exclude);
    restoreHomeFiles(fs, p.root, intent.home);
  } // else unreadable: killed while writing it, before any state was touched
  fs.rmSync(`${p.record}.tmp`, { force: true });
  fs.rmSync(intentFile(p), { force: true });
}
/** One migrate per clone: an exclusive lock file holding the owner's pid; a dead owner's lock is taken over. */
function acquireLock(fs, p) {
  const file = join(p.root, 'migrate.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return { release: () => fs.rmSync(file, { force: true }) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number.parseInt(String(fs.readFileSync(file, 'utf8')), 10);
      let alive = pid !== process.pid && Number.isInteger(pid) && pid > 0;
      if (alive) try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) return { held: pid };
      fs.rmSync(file, { force: true });
    }
  }
  return { held: 0 };
}
const paths = (name, clone, home, stamp) => {
  const logical = logicalCloneRoot(clone);
  const root = join(resolve(home), name);
  return { logical, root, state: join(root, 'state'), repo: join(root, 'repo.git'), marker: join(root, 'settings.local.json'), record: join(root, 'migration.json'), conflicts: join(root, 'conflicts', stamp) };
};

/**
 * One migrate per clone, and a migrate that was killed midway is undone from its on-disk intent before this one
 * starts, so a re-run never has to guess whether a half-moved path is ours.
 */
export async function migrate(args) {
  const { clone, home, settings, dryRun = false, deps = {} } = args;
  const fs = deps.fs ?? filesystem;
  const logical = logicalCloneRoot(clone);
  // The runtime finds a clone's home from the settings file alone. A home it will not look in would migrate into a
  // folder nothing reads (the daemon would go dark), so refuse rather than build there.
  const problem = homeProblem(logical, settings, home, deps.env ?? process.env);
  if (problem) return { status: 'refused', ...problem };
  const p = paths(basename(logical), clone, runtimeHome(logical, settings), stampOf(deps));
  const here = stat(fs, p.logical);
  if (!here && interruptedSwap(fs, p)) return resumeSwap(fs, p, dryRun);
  if (here?.isSymbolicLink() && !dryRun && stat(fs, intentFile(p)) && validRecord(readRecord(fs, p), p)) {
    fs.rmSync(intentFile(p), { force: true }); // killed after the link went in, before the intent was dropped: nothing left to undo
  }
  if (!here?.isDirectory()) return { status: 'refused', reason: here?.isSymbolicLink() ? 'already-a-symlink' : 'clone-missing' };
  if (dryRun) return migrateInner(args);
  const createdRoot = !stat(fs, p.root);
  fs.mkdirSync(p.root, { recursive: true });
  const lock = acquireLock(fs, p);
  if (!lock.release) {
    if (createdRoot) try { fs.rmdirSync(p.root); } catch { /* not empty: not ours */ }
    return { status: 'refused', reason: 'migrate-in-progress', pid: lock.held };
  }
  try {
    recoverFromIntent(fs, p);
    return await migrateInner(args);
  } finally {
    lock.release();
    if (createdRoot) try { fs.rmdirSync(p.root); } catch { /* a migration lives here now */ }
  }
}

/** Finish a swap that was killed after the clone went aside: everything else was already done and recorded. */
function resumeSwap(fs, p, dryRun) {
  if (dryRun) return { status: 'dry-run', wouldResumeSwap: true, legacy: interruptedSwap(fs, p).legacy };
  const lock = acquireLock(fs, p);
  if (!lock.release) return { status: 'refused', reason: 'migrate-in-progress', pid: lock.held };
  try {
    const info = interruptedSwap(fs, p); // re-read under the lock: the other run may have finished it
    if (!info) return { status: 'refused', reason: 'clone-missing' };
    linkClone(fs, p);
    fs.rmSync(intentFile(p), { force: true });
    return { status: 'migrated', name: basename(p.logical), v0: info.v0, legacy: info.legacy, moved: info.moved, steps: ['swapped'], resumed: true };
  } finally { lock.release(); }
}

async function migrateInner({ clone, settings, dryRun = false, force = false, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  const name = basename(logicalCloneRoot(clone));
  const stamp = stampOf(deps);
  const config = validateDaemonVersionsSettings(settings ?? { });
  const p = paths(name, clone, runtimeHome(logicalCloneRoot(clone), settings), stamp);
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
  const originUrl = absoluteRemote(p.logical, git(p.logical, ['config', '--get', 'remote.origin.url']));
  const stateNow = config.statePaths.filter(path => stat(fs, join(p.logical, path)));
  // A destination left by an earlier run is state we cannot tell from a stale copy: stop before touching anything.
  const existing = stateNow.filter(path => !stat(fs, join(p.logical, path))?.isSymbolicLink() && stat(fs, join(p.state, path)));
  if (existing.length && !force) return { status: 'refused', reason: 'state-exists', existing, hint: 'inspect <home>/<name>/state, or pass --force to keep the clone entries that lose under conflicts/' };
  if (dryRun) return { status: 'dry-run', name, sha, originUrl: redactUrl(originUrl), root: p.root, wouldMove: stateNow };

  const steps = [];
  const moved = [];
  const exclude = join(p.logical, '.git', 'info', 'exclude');
  const added = []; // exclude lines this run appended (never a line the user already had)
  const legacy = join(p.root, `legacy-${stamp}`);
  const tmp = tmpLinkOf(p);
  // Everything after the first state move is undone, whether it ends in a refusal or a throw: the clone gets its
  // own state back and no `current`, marker or record is left pointing at a half-migrated home. Home files that
  // existed before this run (an earlier marker, switch state) are not ours to delete; `current` was checked absent.
  const homeBefore = snapshotHomeFiles(fs, p.root);
  const rollback = () => {
    restoreState(fs, p, moved);
    stripExclude(fs, exclude, added);
    fs.rmSync(tmp, { force: true });
    restoreHomeFiles(fs, p.root, homeBefore); // contents and link targets, not just whether the file existed
    fs.rmSync(`${p.record}.tmp`, { force: true });
    fs.rmSync(intentFile(p), { force: true });
  };
  const haveLines = (stat(fs, exclude) ? fs.readFileSync(exclude, 'utf8') : '').split('\n');
  // Down before the first rename: a kill from here on is undone by the next run from this file alone.
  writeIntent(fs, p, { paths: stateNow, exclude: stateNow.map(path => `/${path}`).filter(line => !haveLines.includes(line)), home: homeBefore });
  try {
    fs.mkdirSync(p.root, { recursive: true });
    if (!stat(fs, join(p.repo, 'HEAD'))) {
      git(dirname(p.logical), ['clone', '--bare', '--quiet', '--', p.logical, p.repo]);
      git(p.repo, ['remote', 'set-url', '--', 'origin', originUrl]);
      steps.push('repo.git');
    }
    git(p.repo, ['fetch', '--quiet', '--no-tags', '--', p.logical, '+HEAD:refs/migrate/base']);
    // State first: rename (atomic, same volume), then link back so the live daemon keeps writing to the same
    // place. Done before the build so the version's state links resolve while its smoke runs.
    for (const path of stateNow) {
      const src = join(p.logical, path);
      const dest = join(p.state, path);
      if (stat(fs, src)?.isSymbolicLink()) {
        // Our own link from a run that died after moving this path: take it over so the record and undo cover it.
        if (fs.readlinkSync(src) === dest) moved.push(path);
        continue;
      }
      fs.mkdirSync(dirname(dest), { recursive: true });
      // With --force the clone's entry is the live one: the stale destination is parked, never merged over or deleted.
      if (stat(fs, dest)) parkAside(fs, p, dest, path);
      fs.renameSync(src, dest);
      moved.push(path); // before the link, so a crash between the rename and the symlink still rolls back
      const gap = stat(fs, src); // recreated by a writer in the microsecond gap
      if (gap) { if (gap.isDirectory()) mergeMissing(fs, src, dest); parkAside(fs, p, src, path); }
      fs.symlinkSync(dest, src);
    }
    // A symlink is not matched by a `dir/` ignore pattern, so keep the legacy tree looking clean to git.
    const have = stat(fs, exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const fresh = moved.map(path => `/${path}`).filter(line => !haveLines.includes(line));
    if (fresh.length) fs.appendFileSync(exclude, `${have && !have.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`);
    added.push(...fresh);
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
    if (record.status !== 'built') { rollback(); return { status: 'refused', reason: 'smoke-failed', id: record.id, smoke: record.smoke?.smoke?.results?.filter(r => !r.ok), steps }; }
    steps.push(`v0 ${record.id}`);
    const switched = await switchCurrent({ clone: p.logical, home: dirname(p.root), id: record.id, expectCurrent: null, settings: on, by: 'migrate', reason: 'migrate v0' });
    if (switched.status !== 'switched') { rollback(); return { status: 'refused', reason: `switch-${switched.status}`, switched, steps }; }
    steps.push('current');
    fs.writeFileSync(p.marker, `${JSON.stringify({ enabled: true })}\n`);
    steps.push('enabled');

    // The record is the journal of the two-rename swap: it goes down (atomically) before the first rename, so a kill
    // between them is finished by `migrate` or undone by `unmigrate` from it. `home` is where `current` lives, for
    // the plist helper. A swapped clone always has its record.
    const journal = `${p.record}.tmp`;
    fs.writeFileSync(journal, `${JSON.stringify({ migratedAt: new Date((deps.now ?? Date.now)()).toISOString(), legacy, moved, excluded: added, v0: record.id, sha, originUrl: redactUrl(originUrl), home: dirname(p.root) }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(journal, p.record);
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(relative(dirname(p.logical), join(p.root, 'current')), tmp);
    fs.renameSync(p.logical, legacy);
    try { fs.renameSync(tmp, p.logical); }
    catch (error) {
      // If even the way back fails the real clone sits at `legacy`: rolling back now would recreate an empty clone dir.
      try { fs.renameSync(legacy, p.logical); } catch (restoreError) { error.cloneAtLegacy = legacy; error.rollbackError = restoreError; }
      throw error;
    }
    steps.push('swapped');
    fs.rmSync(intentFile(p), { force: true }); // done: nothing left to undo
    return { status: 'migrated', name, v0: record.id, legacy, moved, steps };
  } catch (error) {
    if (!error.cloneAtLegacy) try { rollback(); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
}

/** Reverse a migration from what the record says was moved, never from today's settings. */
export async function unmigrate(args) {
  const { clone, home, settings, dryRun = false, deps = {} } = args;
  if (dryRun) return unmigrateInner(args);
  const fs = deps.fs ?? filesystem;
  const logical = logicalCloneRoot(clone);
  const p = paths(basename(logical), clone, home ?? runtimeHome(logical, settings), stampOf(deps));
  if (!stat(fs, p.root)) return unmigrateInner(args); // nothing to lock; it will report not-migrated
  const lock = acquireLock(fs, p);
  if (!lock.release) return { status: 'refused', reason: 'migrate-in-progress', pid: lock.held };
  try { return await unmigrateInner(args); } finally { lock.release(); }
}

async function unmigrateInner({ clone, home, settings, dryRun = false, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  const name = basename(logicalCloneRoot(clone));
  // Same default as migrate, so a clone migrated under a configured clonesRoot is found again without --home.
  const p = paths(name, clone, home ?? runtimeHome(logicalCloneRoot(clone), settings), stampOf(deps));
  const here = stat(fs, p.logical);
  let info = null;
  try { info = JSON.parse(fs.readFileSync(p.record, 'utf8')); } catch { /* none or unreadable: judged below */ }
  // A run that died after putting the legacy clone back (the record is deleted last) is finished by running it again.
  const resuming = here?.isDirectory() && info !== null && validRecord(info, p) && !stat(fs, info.legacy);
  // A migrate killed between its two swap renames: no clone at all, and the record's legacy is the real one.
  const interrupted = !here && interruptedSwap(fs, p) !== null;
  if (!here?.isSymbolicLink() && !resuming && !interrupted) return { status: 'refused', reason: 'not-migrated' };
  if (info === null) return { status: 'refused', reason: 'no-migration-record' };
  if (!validRecord(info, p)) return { status: 'refused', reason: 'bad-migration-record' };
  if (!resuming && !stat(fs, info.legacy)?.isDirectory()) return { status: 'refused', reason: 'legacy-missing', legacy: info.legacy };
  if (dryRun) return { status: 'dry-run', name, legacy: info.legacy, resuming, interrupted, wouldRestore: info.moved.filter(path => stat(fs, join(p.state, path))) };
  if (interrupted) {
    fs.rmSync(tmpLinkOf(p), { force: true });
    fs.renameSync(info.legacy, p.logical); // the second rename never happened: undo the first
  } else if (!resuming) {
    // Put the legacy directory back first, so a daemon that wakes up sees a real clone as soon as possible.
    fs.unlinkSync(p.logical);
    try { fs.renameSync(info.legacy, p.logical); }
    catch (error) { fs.symlinkSync(relative(dirname(p.logical), join(p.root, 'current')), p.logical); throw error; }
  }
  const restored = restoreState(fs, p, info.moved);
  stripExclude(fs, join(p.logical, '.git', 'info', 'exclude'), info.excluded);
  fs.rmSync(p.marker, { force: true });
  fs.rmSync(tmpLinkOf(p), { force: true }); // a stale link from a swap that died before its first rename
  for (const f of ['current', 'previous', 'state.json', 'migration.json', 'migrate-intent.json']) fs.rmSync(join(p.root, f), { force: true });
  return { status: 'unmigrated', name, restored, versionsKept: join(p.root, 'versions') };
}

/**
 * Move only ProgramArguments strings and WorkingDirectory from `<ws>/<name>` onto `<home>/<name>/current`. `home` is
 * the clones root the migration used; without it, the default `<ws>/.daemon-clones`.
 */
export function versionedPlistText(text, { name, home }) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const current = home && join(home, name, 'current');
  // Lazy `(.*?)`: the first `/<name>` is the clone itself; a later directory with the same name inside it is not.
  const swap = value => {
    if (current && (value === current || value.startsWith(`${current}/`))) return value; // already moved
    // `/<name>/current` right after the match is a version path under some other root: moved already, never nested again.
    return value.replace(new RegExp(`^(.*?)/${escaped}(?=/|$)(/current(?=/|$))?`), (all, ws, moved) => (moved ? all : current ?? (ws.endsWith('/.daemon-clones') ? all : `${ws}/.daemon-clones/${name}/current`)));
  };
  let out = text.replace(/(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/, (m, a, body, z) => a + body.replace(/<string>([^<]*)<\/string>/g, (s, v) => `<string>${swap(v)}</string>`) + z);
  out = out.replace(/(<key>WorkingDirectory<\/key>\s*<string>)([^<]*)(<\/string>)/, (m, a, v, z) => a + swap(v) + z);
  return out;
}

/**
 * Where `current` lives for a clone, in order: an explicit `--home`; the migrated clone itself (its link points at
 * `<home>/<name>/current`, whatever the settings say today); the record under the settings-derived home; the default
 * migrate would use from those settings. A relative root is refused: launchd's cwd is not ours.
 */
function plistHome(fs, { clone, home, settings }) {
  const logical = logicalCloneRoot(clone);
  const name = basename(logical);
  const absolute = root => { if (!isAbsolute(root)) throw new Error(`clones root must be an absolute path, got "${root}"`); return resolve(root); };
  if (home !== undefined) return absolute(home);
  if (stat(fs, logical)?.isSymbolicLink()) {
    const target = resolve(dirname(logical), fs.readlinkSync(logical));
    if (basename(target) === 'current' && basename(dirname(target)) === name) return dirname(dirname(target));
  }
  const configured = validateDaemonVersionsSettings(settings ?? {}).clonesRoot;
  if (configured) absolute(configured);
  const wanted = runtimeHome(logical, settings);
  const info = readRecord(fs, paths(name, clone, wanted, ''));
  return typeof info?.home === 'string' && isAbsolute(info.home) ? info.home : wanted;
}

export function rewritePlist({ file, name, clone, home, settings, backupDir, revertFrom, dryRun = false, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  if (revertFrom) {
    if (dryRun) return { status: 'dry-run', wouldRevert: true, file };
    writeAtomic(fs, file, fs.readFileSync(revertFrom));
    return { status: 'reverted', file };
  }
  const text = fs.readFileSync(file, 'utf8');
  const next = versionedPlistText(text, clone ? { name, home: plistHome(fs, { clone, home, settings }) } : { name });
  if (next === text) return { status: 'noop' };
  if (!backupDir) throw new Error('--backup-dir is required');
  if (dryRun) return { status: 'dry-run', wouldRewrite: true, file };
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `${basename(file)}.pre-versions`);
  fs.copyFileSync(file, backup);
  writeAtomic(fs, file, next);
  return { status: 'rewritten', backup };
}
/** A launchd plist is read by a live service: write beside it and rename, so a crash never leaves half a file. */
function writeAtomic(fs, file, data) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}
