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
export async function buildVersion({ clone, home, sha = 'HEAD', settings, force = false, deps = {} }) {
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
  const fullSha = checked(git, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
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
    checked(git, ['clone', '--shared', '--no-checkout', '--quiet', '--', source, temp]);
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
  if (command !== 'build') {
    try {
      if (!['switch', 'rollback', 'gc', 'status'].includes(command) || !value('clone') || !value('home')
        || args.some(arg => !/^--(?:clone|home|id|expect-current|to|reason|by)=.+$/.test(arg)
          && !['--json', '--force', '--dry-run'].includes(arg))
        || (args.includes('--dry-run') && !['switch', 'status'].includes(command))) {
        throw new Error('Usage: daemon-version.mjs switch|rollback|gc|status --clone=<path> --home=<dir> [--id=<id> --expect-current=<id|null>] [--to=<id>] [--reason=<text>] [--by=<actor>] [--force] [--dry-run] [--json]');
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
