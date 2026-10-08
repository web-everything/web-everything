/**
 * @file scripts/lib/daemon-version.mjs
 * @description Card 89 S3 — build and smoke immutable versions; never switch current.
 * A shared clone gives each version private, relocatable Git metadata without writing
 * to the source (unlike worktree registration). Objects remain borrowed from the source;
 * their retention is the caller's responsibility. SIGKILL can leave a .building directory,
 * but never a published version; reuse deliberately ignores all staging directories.
 */
import * as filesystem from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logicalCloneRoot } from './daemon-clone-layout.mjs';
import { isVersionedClone, validateDaemonVersionsSettings } from './daemon-versions-settings.mjs';
import { linkVersionState, carryUntrackedSidecars } from './daemon-version-state.mjs';
import { ensureNodeModulesStore, linkNodeModules } from './daemon-job-snapshots.mjs';
import { candidateSmokeEnv } from './daemon-rebuild/candidate.mjs';
import { makeGit } from './daemon-rebuild/shared.mjs';
import { runLiveSmokeWithRetry } from './daemon-live-smoke.mjs';

/** deps: fs, run(args, options), runSmoke, installer (synchronous), now, env,
 * alert, ensureNodeModulesStore, linkNodeModules, linkVersionState, carryUntrackedSidecars.
 * The store helper owns lockfileKey calculation and its build-once marker.
 */
export async function buildVersion({ clone, home, sha = 'HEAD', settings, force = false, repo, deps = {} }) {
  const source = resolve(clone);
  const logical = logicalCloneRoot(source);
  const name = basename(logical);
  if (!force && !isVersionedClone(name, settings)) return { status: 'disabled' };
  const config = validateDaemonVersionsSettings(settings);
  const fs = deps.fs ?? filesystem;
  const env = { ...(deps.env ?? process.env), GIT_OPTIONAL_LOCKS: '0' };
  const run = deps.run ?? ((args, options) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }));
  const gitAt = cwd => makeGit({ run, cwd, env });
  const git = gitAt(source);
  const checked = (runner, args) => {
    const result = runner(args);
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error || ''}`);
    return String(result.stdout ?? '').trim();
  };
  const objects = repo ? resolve(repo) : source; // where commits are read and borrowed from (S6: repo.git)
  const fullSha = checked(gitAt(objects), ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(fullSha)) throw new Error('Invalid resolved commit SHA');
  const root = join(resolve(home), name);
  const versionsRoot = join(root, 'versions');
  if (fs.existsSync(versionsRoot)) {
    for (const entry of fs.readdirSync(versionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      let record;
      try { record = JSON.parse(fs.readFileSync(join(versionsRoot, entry.name, '.version.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
      if (record.sha === fullSha && record.id === entry.name
        && ['built', 'smoke-failed'].includes(record.status)) {
        return { status: 'reused', id: entry.name, dir: join(versionsRoot, entry.name) };
      }
    }
  }
  const builtAt = new Date((deps.now ?? Date.now)()).toISOString();
  const stamp = builtAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `${stamp}-${fullSha.slice(0, 12)}`;
  const dir = join(versionsRoot, id);
  const temp = join(versionsRoot, `.building-${id}-${process.pid}`);
  fs.mkdirSync(versionsRoot, { recursive: true });
  // Exclusive ownership: a concurrent invocation must not remove another build's staging tree.
  fs.mkdirSync(temp);
  const alert = deps.alert ?? (() => {});
  try {
    checked(git, ['clone', '--shared', '--no-checkout', '--quiet', '--', objects, temp]);
    const versionGit = gitAt(temp);
    checked(versionGit, ['checkout', '--detach', '--quiet', fullSha]);
    const store = (deps.ensureNodeModulesStore ?? ensureNodeModulesStore)({
      jobsDir: resolve(config.nodeModulesStore ?? join(resolve(home), '.node-modules-store')),
      sourceDir: temp, install: deps.installer,
    });
    (deps.linkNodeModules ?? linkNodeModules)(temp, store.dir);
    fs.appendFileSync(join(temp, '.git', 'info', 'exclude'), '\n/node_modules\n/.version.json\n');
    // Carry only plain relative paths, without following checkout symlinks or overwriting code.
    for (const path of new Set(config.carryPaths)) {
      if (path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
        || path === 'node_modules' || path.startsWith('node_modules/')) throw new Error(`Unsafe carry path: ${path}`);
      if (!fs.existsSync(join(source, path))) continue;
      if (checked(versionGit, ['ls-files', '-z', '--', `:(literal)${path}`])) continue;
      let parent = temp;
      for (const part of path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        if (fs.existsSync(parent) && !fs.lstatSync(parent).isDirectory()) throw new Error(`Unsafe carry parent: ${path}`);
      }
      const target = join(temp, path);
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.cpSync(join(source, path), target, { recursive: true, dereference: false, force: false, verbatimSymlinks: true });
    }
    (deps.linkVersionState ?? linkVersionState)({
      versionDir: temp, stateDir: join(root, 'state'), statePaths: config.statePaths, alert,
    });
    if (config.carryUntracked) {
      // No fetched main proof is supplied in S3: pruning would mutate the read-only source.
      (deps.carryUntrackedSidecars ?? carryUntrackedSidecars)({
        git, fromRoot: source, toRoot: temp, alert,
        skipPaths: [...config.statePaths, ...config.carryPaths, 'node_modules', '.version.json'],
      });
    }
    const smoke = await (deps.runSmoke ?? runLiveSmokeWithRetry)({
      root: temp, env: candidateSmokeEnv({ root: logical, env }),
    });
    if (!smoke || typeof smoke.verdict !== 'string') throw new Error('Smoke returned no verdict');
    const status = smoke.verdict === 'pass' ? 'built' : 'smoke-failed';
    const record = { id, sha: fullSha, builtAt, lockKey: store.key, smoke, status };
    fs.writeFileSync(join(temp, '.version.json.tmp'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(join(temp, '.version.json.tmp'), join(temp, '.version.json'));
    fs.renameSync(temp, dir);
    return { ...record, dir };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const value = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  if (['migrate', 'unmigrate', 'plist'].includes(command)) {
    // Card 89 S6. Exit 0 = done, 1 = error, 2 = refused (nothing changed or already undone).
    try {
      const allowed = command === 'plist'
        ? /^--(?:clone|file|backup-dir|revert-from)=.+$/ : /^--(?:clone|home)=.+$/;
      if (!value('clone') || args.some(arg => !allowed.test(arg) && !['--json', '--dry-run', '--force'].includes(arg))
        || (command === 'plist' && !value('file'))) {
        throw new Error('Usage: daemon-version.mjs migrate|unmigrate --clone=<ws>/<name> [--home=<clones root>] [--dry-run] [--force] [--json]  |  plist --clone=<ws>/<name> --file=<plist> --backup-dir=<dir> | --revert-from=<backup>');
      }
      const mod = await import('./daemon-version-migrate.mjs');
      const { loadDaemonVersionsSettingsFile } = await import('./daemon-versions-settings.mjs');
      const common = { clone: value('clone'), home: value('home'), settings: loadDaemonVersionsSettingsFile() };
      const result = command === 'plist'
        ? mod.rewritePlist({ file: value('file'), name: basename(logicalCloneRoot(value('clone'))), backupDir: value('backup-dir'), revertFrom: value('revert-from') })
        : await mod[command]({ ...common, dryRun: args.includes('--dry-run'), force: args.includes('--force') });
      console.log(JSON.stringify(result));
      if (result.status === 'refused') process.exitCode = 2;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (command !== 'build') {
    try {
      if (!['switch', 'rollback', 'gc', 'status'].includes(command) || !value('clone') || !value('home')
        || args.some(arg => !/^--(?:clone|home|id|expect-current|to|reason|by)=.+$/.test(arg)
          && !['--json', '--force', '--dry-run'].includes(arg))
        || (args.includes('--dry-run') && !['switch', 'status'].includes(command))) {
        throw new Error('Usage: daemon-version.mjs switch|rollback|gc|status --clone=<path> --home=<dir> [--id=<id> --expect-current=<id|null>] [--to=<id>] [--reason=<text>] [--by=<actor>] [--force] [--dry-run] [--json] (always prints one JSON line; exit 0 = done, 1 = error, 2 = not done: busy|aborted|refused|no-previous|recovery-pending, or disabled for switch/rollback)');
      }
      const api = await import('./daemon-version-switch.mjs');
      const name = basename(logicalCloneRoot(value('clone')));
      const result = await api[command === 'switch' ? 'switchCurrent' : command]({
        clone: value('clone'), home: value('home'), id: value('id'),
        expectCurrent: value('expect-current') === 'null' ? null : value('expect-current'),
        to: value('to'), reason: value('reason'), by: value('by'), dryRun: args.includes('--dry-run'),
        settings: args.includes('--force') ? { enabled: { [name]: true } } : undefined,
      });
      console.log(JSON.stringify(result));
      // Exit 0 means the command did what was asked (or the feature is dormant); 2 means it did not,
      // so a caller that only checks the exit code never mistakes a lost lock or a refusal for success.
      // `disabled` is a failure only for a command that was meant to change something.
      if (['busy', 'aborted', 'refused', 'no-previous', 'recovery-pending', 'probation-failed'].includes(result?.status)
        || (result?.status === 'disabled' && ['switch', 'rollback'].includes(command))) process.exitCode = 2;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (!value('clone') || !value('home')
    || args.some(arg => !/^--(?:clone|home|sha)=.+$/.test(arg) && !['--json', '--force'].includes(arg))) {
    console.error('Usage: daemon-version.mjs build --clone=<path> --home=<dir> [--sha=<rev>] [--force] [--json]');
    process.exitCode = 1;
  } else {
    try {
      const result = await buildVersion({ clone: value('clone'), home: value('home'), sha: value('sha'), force: args.includes('--force') });
      console.log(args.includes('--json') ? JSON.stringify(result) : `${result.status}${result.dir ? ` ${result.dir}` : ''}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
