import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedFixture } from './pinned-fixture.mjs';
import { dispatchGuardHooks } from '../../lib/dispatch-bg-isolation.mjs';
import soakBreak from '../../conveyor/soak/breaks/lane-local-guard-loaded-as-hook.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
const hookCommands = event => settings.hooks[event].flatMap(group => group.hooks.map(hook => hook.command));
const stopCommands = ['Stop', 'SubagentStop'].flatMap(hookCommands);
const commands = [...hookCommands('PreToolUse'), ...stopCommands];
const isStop = command => stopCommands.includes(command);
const scriptOf = command => command.match(/node "\$launcher" (?:--stop-hook )?(scripts\/[^ ;']+)/)[1];
const editCommands = settings.hooks.PreToolUse.find(group => group.matcher === 'Edit|Write').hooks.map(hook => hook.command);
const bashCommand = settings.hooks.PreToolUse.find(group => group.matcher === 'Bash').hooks[0].command;
const fixtures = [];
/** A process id that has exited, for abandoned lock and lease records. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(child.stdout.trim());
}
/** A sync lock file `<pid> <start-ms> <nonce>`; with no pid, an old-protocol lock directory. */
function syncLock(f, pid, started = '') {
  const lock = `${f.clone}.guard-lock`;
  if (pid === undefined) mkdirSync(lock);
  else writeFileSync(lock, `${pid} ${started} test\n`);
  return lock;
}
const leases = f => {
  try { return readdirSync(join(f.clone, '.git/guard-readers')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
function commitClone(f, message) {
  f.git(f.clone, 'add', '-A');
  f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message);
  f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}
/** Start a hook asynchronously; `line()` resolves its next stdout line or rejects if it exits first. */
function start(f, args, { shell = false, cwd = f.lane } = {}) {
  const child = shell
    ? spawn('sh', ['-c', args], { cwd, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, [join(f.clone, 'scripts/hooks/run-pinned-guard.mjs'), ...args], { cwd, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  const stderrWaiters = [];
  child.stderr.on('data', chunk => {
    stderr += chunk;
    for (const waiter of stderrWaiters.splice(0)) if (stderr.includes(waiter.text)) waiter.resolve(); else stderrWaiters.push(waiter);
  });
  const exited = closed.then(([code]) => { throw new Error(`hook exited (${code}) first: ${stderr}`); });
  exited.catch(() => {});
  return {
    child, closed,
    get stderr() { return stderr; },
    line: () => Promise.race([once(lines, 'line').then(([line]) => line), exited]),
    stderrIncludes: text => stderr.includes(text) ? Promise.resolve()
      : Promise.race([new Promise(resolve => stderrWaiters.push({ text, resolve })), exited]),
    finish: async () => { if (!child.stdin.writableEnded) child.stdin.end(); const [code] = await closed; lines.close(); return code; },
  };
}
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture() {
  const f = pinnedFixture({ launcherOnly: true }); fixtures.push(f);
  // HOME contains spaces in the wiring probes.
  const clone = f.clone;
  const probe = `import {readFileSync} from 'node:fs';
console.log(JSON.stringify({root:process.env.WE_HOOK_ROOT,cwd:process.cwd(),args:process.argv.slice(2),gitKeys:Object.keys(process.env).filter(key=>key.startsWith('GIT_')),input:readFileSync(0,'utf8')}));
console.error('guard stderr'); process.exitCode=Number(process.env.PROBE_EXIT || 0);`;
  for (const command of commands) {
    const script = scriptOf(command);
    writeFileSync(join(clone, script), probe);
    for (const cwd of [f.primary, f.lane]) writeFileSync(join(cwd, script), 'console.log("UNTRUSTED GUARD");');
  }
  for (const cwd of [f.primary, f.lane]) writeFileSync(join(cwd, 'scripts/hooks/run-pinned-guard.mjs'), 'console.log("UNTRUSTED LAUNCHER");');
  f.git(clone, 'add', '.');
  f.git(clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'trusted probes');
  f.git(clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  f.launch = (cwd = f.lane, script = 'scripts/guard-bash.mjs', args = []) =>
    spawnSync(process.execPath, [join(clone, 'scripts/hooks/run-pinned-guard.mjs'), script, ...args], {
      cwd, env: f.env, input: 'payload', encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
  return f;
}

describe('dedicated clone guard launcher', () => {
  it('observes revision-local reader leases while running and verifies their cleanup', async () => {
    const f = fixture();
    writeFileSync(join(f.clone, 'scripts/guard-bash.mjs'), "console.log('ready'); process.stdin.resume();");
    commitClone(f, 'lease observation');
    const hook = start(f, ['scripts/guard-bash.mjs']);
    try {
      expect(await hook.line()).toBe('ready');
      expect(leases(f)).toHaveLength(2); // Launcher and child each own a record.
    } finally {
      expect(await hook.finish(), hook.stderr).toBe(0);
    }
    expect(leases(f)).toEqual([]);
  });
  it.each(['dirty', 'ahead', 'origin', 'stale', 'outside', 'nested', 'alias', 'closed'])('verifies successor evidence before executing any successor code: %s', kind => {
    const f = fixture();
    const revisions = `${f.clone}.revs`; mkdirSync(revisions);
    const successor = join(revisions, 'successor');
    f.git(f.temp, 'clone', '--', f.clone, successor);
    writeFileSync(join(successor, '.git/FETCH_HEAD'), '');
    writeFileSync(join(successor, 'scripts/hooks/run-pinned-guard.mjs'), 'console.log("UNVERIFIED SUCCESSOR"); process.exit(0);');
    if (kind !== 'dirty') {
      f.git(successor, 'add', '.');
      f.git(successor, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'successor launcher');
      if (kind !== 'ahead') f.git(successor, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    }
    let redirect = successor;
    if (kind === 'origin') f.env.WE_GUARD_ORIGIN = 'expected-origin';
    if (kind === 'stale') utimesSync(join(successor, '.git/FETCH_HEAD'), new Date(1), new Date(1));
    if (kind === 'outside' || kind === 'nested') {
      redirect = kind === 'outside' ? join(f.temp, 'outside') : join(revisions, 'nested/revision');
      mkdirSync(dirname(redirect), { recursive: true }); renameSync(successor, redirect);
    }
    if (kind === 'alias') {
      const outside = join(f.temp, 'outside'); renameSync(successor, outside); symlinkSync(outside, successor, 'dir');
    }
    if (kind === 'closed') symlinkSync(f.clone, join(successor, '.git/guard-successor'), 'dir');
    symlinkSync(redirect, join(f.clone, '.git/guard-successor'), 'dir');
    expect(f.launch()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('denying (exit 2)') });
    expect(leases(f)).toEqual([]);
    if (existsSync(join(redirect, '.git/guard-readers'))) expect(readdirSync(join(redirect, '.git/guard-readers'))).toEqual([]);
  });
  it('never runs primary or lane copies; preserves root, cwd, stdin, argv and exit status', () => {
    const f = fixture(); const nested = join(f.lane, 'nested'); mkdirSync(nested);
    f.env.WE_HOOK_ROOT = f.primary; f.env.PROBE_EXIT = '7';
    const result = f.launch(nested, 'scripts/guard-bash.mjs', ['--pre', 'space argument']);
    expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({root:f.lane,cwd:nested,args:['--pre','space argument'],gitKeys:[],input:'payload'});
    expect(result.stderr).toBe('guard stderr\n');
  });
  it.each(['clone', 'HOME'])('a real deny-guard still denies through a symlinked %s and TMPDIR', kind => {
    const f = fixture();
    const script = 'scripts/guard-monitor-subagent.mjs';
    copyFileSync(join(repo, script), join(f.clone, script));
    f.git(f.clone, 'add', '.');
    f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'real deny guard');
    f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // Model /var -> /private/var portably, without relying on host symlinks.
    const alias = join(f.temp, 'var');
    symlinkSync(kind === 'HOME' ? f.env.HOME : f.clone, alias, 'dir');
    const temporary = join(f.temp, 'private/var');
    mkdirSync(temporary, { recursive: true });
    f.env.TMPDIR = join(f.temp, 'temporary alias');
    symlinkSync(temporary, f.env.TMPDIR, 'dir');
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Monitor', agent_id: 'subagent' };
    let result;
    if (kind === 'HOME') {
      f.env.HOME = alias;
      expect(realpathSync(f.env.HOME)).not.toBe(f.env.HOME);
      const command = commands.find(command => command.includes(script));
      expect(command).toBeTypeOf('string');
      result = f.command(f.lane, command, payload);
    } else {
      const launcher = join(alias, 'scripts/hooks/run-pinned-guard.mjs');
      expect(realpathSync(launcher)).not.toBe(launcher);
      result = spawnSync(process.execPath, [launcher, script], {
        cwd: f.lane, env: f.env, input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
    }
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(result.stderr).toBe('');
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it('runs in place with a canonical argv entry path', () => {
    const f = fixture();
    writeFileSync(join(f.clone, 'scripts/guard-bash.mjs'), `
import { fileURLToPath } from 'node:url';
console.log(JSON.stringify({ entry: fileURLToPath(import.meta.url), argv: process.argv[1] }));
`);
    f.git(f.clone, 'add', '.');
    f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'entry probe');
    f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = f.launch();
    expect(result.status, result.stderr).toBe(0);
    const entry = realpathSync(join(f.clone, 'scripts/guard-bash.mjs'));
    expect(JSON.parse(result.stdout)).toEqual({ entry, argv: entry });
  });
  it.each(['symlink', 'missing'])('refuses a successful child whose entry path becomes %s and releases its lock', kind => {
    const f = fixture();
    writeFileSync(join(f.clone, 'scripts/guard-bash.mjs'), `
import { unlinkSync, symlinkSync } from 'node:fs';
unlinkSync(process.argv[1]);
if (${JSON.stringify(kind)} === 'symlink') symlinkSync('replacement.mjs', process.argv[1]);
`);
    writeFileSync(join(f.clone, 'scripts/replacement.mjs'), 'process.exitCode = 0;');
    f.git(f.clone, 'add', '.');
    f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'path mutation probe');
    f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = f.launch();
    expect(result).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('denying (exit 2)') });
    if (kind === 'symlink') expect(result.stderr).toContain('guard entry path changed during execution');
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it.each(['tracked', 'untracked'])('denies a %s working-tree edit before executing the guard', kind => {
    const f = fixture();
    writeFileSync(join(f.clone, kind === 'tracked' ? 'scripts/guard-bash.mjs' : 'unexpected'), 'console.log("TAMPERED");');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('not pristine')});
  });
  it('names the offending paths (capped, control characters stripped) in the not-pristine deny', () => {
    const f = fixture();
    writeFileSync(join(f.clone, 'stray-cache.tmp'), 'x');
    const result = f.launch();
    expect(result).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('not pristine') });
    expect(result.stderr).toContain('stray-cache.tmp');
    expect(result.stderr).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });
  it('does not deny a clean clone whose index stat data is stale (chmod after sync changes ctime)', () => {
    const f = fixture();
    const target = join(f.clone, 'scripts/guard-bash.mjs');
    f.git(f.clone, 'update-index', '--refresh', '-q');
    chmodSync(target, 0o444);
    chmodSync(target, 0o644);
    expect(f.launch()).toMatchObject({ status: 0 });
  });
  it('denies a clean local commit ahead of origin/main', () => {
    const f = fixture();
    f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'local');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('HEAD differs from origin/main')});
  });
  it('denies missing origin/main evidence', () => {
    const f = fixture(); f.git(f.clone, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('denying (exit 2)')});
  });
  it('checks the expected origin when configured and denies a missing origin', () => {
    const f = fixture(); f.env.WE_GUARD_ORIGIN = f.primary;
    expect(f.launch().status).toBe(0);
    f.env.WE_GUARD_ORIGIN = f.lane;
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('origin differs')});
    f.git(f.clone, 'config', '--unset-all', 'remote.origin.url');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('denying (exit 2)')});
  });
  it('clears every inherited GIT_* override for clone checks, hook root and child, preserving other env', () => {
    const f = fixture();
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_FUTURE_OVERRIDE']) {
      f.env[key] = join(f.temp, 'invalid');
    }
    f.env.GIT_WORK_TREE = f.temp;
    f.env.GIT_CONFIG_COUNT = 'invalid';
    f.env.PROBE_EXIT = '7';
    const result = f.launch();
    expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({root:f.lane,gitKeys:[]});
  });
  it('fails closed when the clone is missing even though lane guards exist', () => {
    const f = fixture(); rmSync(f.clone, {recursive:true,force:true});
    const result = f.command(f.lane, bashCommand, {});
    expect(result).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('launcher missing')});
  });
  it('denies a non-repository clone with FETCH_HEAD present', () => {
    const f = fixture();
    rmSync(join(f.clone, '.git'), { recursive: true, force: true });
    mkdirSync(join(f.clone, '.git'));
    writeFileSync(join(f.clone, '.git/FETCH_HEAD'), '');
    writeFileSync(join(f.clone, 'scripts/guard-bash.mjs'), 'console.log("UNCHECKED GUARD EXECUTED");');
    expect(f.launch()).toMatchObject({
      status: 2, stdout: '', stderr: expect.stringContaining('denying (exit 2)'),
    });
  });
  it('runs every hook of one matcher concurrently on one clone without denying any', async () => {
    const f = fixture();
    // Each guard reports readiness, then waits for the test.
    const barrier = `console.log('ready'); process.stdin.resume(); process.stdin.on('end', () => console.log('done'));`;
    for (const command of editCommands) writeFileSync(join(f.clone, scriptOf(command)), barrier);
    commitClone(f, 'barrier probes');
    expect(editCommands.length).toBeGreaterThan(1);
    const hooks = editCommands.map(command => start(f, command, { shell: true }));
    try {
      expect(await Promise.all(hooks.map(hook => hook.line()))).toEqual(editCommands.map(() => 'ready'));
      expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
    } finally {
      const codes = await Promise.all(hooks.map(hook => hook.finish()));
      expect(codes, hooks.map(hook => hook.stderr).join('\n')).toEqual(editCommands.map(() => 0));
    }
    expect(leases(f)).toEqual([]);
  }, 30_000);
  it.each(['dead owner', 'no owner record', 'reused pid'])('runs past a sync lock left by a %s, keeping the integrity checks', kind => {
    const f = fixture();
    // A reused pid is alive but started long after the recorded owner did.
    const lock = kind === 'reused pid' ? syncLock(f, process.pid, 1000)
      : syncLock(f, kind === 'dead owner' ? deadPid() : undefined);
    expect(f.launch()).toMatchObject({ status: 0, stderr: 'guard stderr\n' });
    // Abandoned locks are reclaimed by the next sync, not by hooks.
    expect(existsSync(lock)).toBe(true);
    writeFileSync(join(f.clone, 'scripts/guard-bash.mjs'), 'console.log("HALF RESET");');
    expect(f.launch()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('not pristine') });
    expect(leases(f)).toEqual([]);
  });
  it.each(['file', 'legacy directory', 'unreadable legacy owner'])('ignores a LIVE sync lock (%s) without waiting or denying', kind => {
    const f = fixture(); f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    const lock = syncLock(f, kind === 'file' ? process.pid : undefined);
    if (kind === 'legacy directory') writeFileSync(join(lock, 'owner'), `${process.pid} 123456789012\n`);
    if (kind === 'unreadable legacy owner') mkdirSync(join(lock, 'owner'));
    expect(f.launch()).toMatchObject({ status: 0, stderr: 'guard stderr\n' });
    expect(existsSync(lock)).toBe(true);
    expect(leases(f)).toEqual([]);
  });
  it.each(['tracked', 'ignored', 'ahead'])('still denies a tampered live symlink revision (%s) while sync owns the lock', kind => {
    const f = fixture();
    const revisions = `${f.clone}.revs`; mkdirSync(revisions);
    const live = join(revisions, 'old'); renameSync(f.clone, live); symlinkSync(live, f.clone, 'dir');
    f.env.WE_GUARD_LOCK_WAIT_MS = '50'; syncLock(f, process.pid);
    if (kind === 'tracked') writeFileSync(join(live, 'scripts/guard-bash.mjs'), 'console.log("TAMPERED");');
    if (kind === 'ignored') {
      writeFileSync(join(live, '.git/info/exclude'), 'planted\n');
      writeFileSync(join(live, 'planted'), 'ignored tampering');
    }
    if (kind === 'ahead') f.git(live, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'local');
    expect(f.launch()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining(
      kind === 'ahead' ? 'HEAD differs from origin/main' : 'not pristine') });
  });
  it.each(['fails', 'prints junk'])('does not consult process-start evidence when ps %s', kind => {
    const f = fixture(); f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    const bin = join(f.temp, 'ps-shim'); mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), kind === 'fails' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\necho "not a date"\n', { mode: 0o755 });
    f.env.PATH = `${bin}:${f.env.PATH}`;
    const lock = syncLock(f, process.pid, 1000);
    expect(f.launch()).toMatchObject({ status: 0, stderr: 'guard stderr\n' });
    expect(existsSync(lock)).toBe(true);
    expect(leases(f)).toEqual([]);
  });
  it.each(['planted', 'node_modules/shadow/index.js'])('denies an ignored file planted in the clone: %s', planted => {
    const f = fixture();
    writeFileSync(join(f.clone, '.git/info/exclude'), `${planted.split('/')[0]}\n`);
    mkdirSync(dirname(join(f.clone, planted)), { recursive: true });
    writeFileSync(join(f.clone, planted), 'console.log("PLANTED");');
    expect(f.git(f.clone, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(f.launch()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('not pristine') });
  });
  // Soak tests run only under the soak config, so the break's event coverage is pinned here.
  it.each(['Stop', 'SubagentStop'])('the lane-local-guard soak break flags a %s hook reverted to a lane-local guard', async event => {
    const f = fixture();
    const tree = join(f.temp, 'soak-tree');
    const previous = process.env.SOAK_TREE_ROOT;
    try {
      const reverted = structuredClone(settings);
      reverted.hooks[event][0].hooks[0].command = 'node scripts/guard-stop-passive-wait.mjs';
      mkdirSync(join(tree, '.claude'), { recursive: true });
      writeFileSync(join(tree, '.claude/settings.json'), JSON.stringify(reverted));
      mkdirSync(join(tree, 'scripts/hooks'), { recursive: true });
      copyFileSync(join(repo, 'scripts/hooks/run-pinned-guard.mjs'), join(tree, 'scripts/hooks/run-pinned-guard.mjs'));
      process.env.SOAK_TREE_ROOT = tree;
      const { violations } = await soakBreak.run();
      expect(violations).toContain('hook runs the lane-local script: node scripts/guard-stop-passive-wait.mjs');
      // A command that only mentions the pinned launcher but runs the lane copy is still flagged.
      const mention = `node scripts/guard-stop-passive-wait.mjs # $HOME/workspace/.guard-main/scripts/hooks/run-pinned-guard.mjs`;
      reverted.hooks[event][0].hooks[0].command = mention;
      writeFileSync(join(tree, '.claude/settings.json'), JSON.stringify(reverted));
      expect((await soakBreak.run()).violations).toContain(`hook runs the lane-local script: ${mention.slice(0, 80)}`);
      process.env.SOAK_TREE_ROOT = repo;
      expect((await soakBreak.run()).violations).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.SOAK_TREE_ROOT; else process.env.SOAK_TREE_ROOT = previous;
    }
  });
  it('keeps identical copies of any lock helpers still shared by launcher and sync', () => {
    const source = file => readFileSync(join(repo, file), 'utf8');
    // One function's text: its own line when it closes there, else through its closing `}` line.
    const helper = (text, name) => {
      const lines = text.split('\n');
      const start = lines.findIndex(line => line.replace(/^export /, '').startsWith(`function ${name}(`));
      expect(start, name).toBeGreaterThanOrEqual(0);
      const end = lines[start].trimEnd().endsWith('}') ? start : lines.indexOf('}', start);
      expect(end, name).toBeGreaterThanOrEqual(start);
      return lines.slice(start, end + 1).join('\n').replace(/^export /, '');
    };
    const launcher = source('scripts/hooks/run-pinned-guard.mjs');
    const sync = source('scripts/hooks/sync-guard-clone.mjs');
    for (const name of ['lockWaitMs', 'pause', 'processStart', 'alive', 'holderAlive', 'legacyOwnerAlive']) {
      // Readers may drop lock helpers entirely; any retained copy must stay identical.
      if (new RegExp(`^function ${name}\\(`, 'm').test(launcher)) {
        expect(helper(launcher, name), name).toBe(helper(sync, name));
      }
    }
    if (launcher.includes('function lockWaitMs(')) expect(launcher).toContain('const MAX_WAIT_MS = 20_000;');
    expect(sync).toContain('const MAX_WAIT_MS = 20_000;');
  });
  it('never fetches, resets, cleans or reclaims, even while a live sync holds its lock', () => {
    const f = fixture();
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const bin = join(f.temp, 'bin'); mkdirSync(bin);
    const log = join(f.temp, 'git-args.jsonl');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const {appendFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    expect(f.launch().status).toBe(0);
    f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    const lock = syncLock(f, process.pid);
    expect(f.launch().status).toBe(0);
    expect(existsSync(lock)).toBe(true);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.filter(arg => ['fetch', 'pull', 'clone', 'reset', 'clean', 'checkout', 'gc', 'prune'].includes(arg)), args.join(' ')).toEqual([]);
    }
  });
  it('fails closed on a missing clone script and on a cwd outside Git with no primary beside the clone', () => {
    const f = fixture();
    expect(f.launch(f.temp)).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('outside Git') });
    rmSync(join(f.clone,'scripts/guard-bash.mjs'));
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('denying (exit 2)')});
  });
  it('dispatched scratch worker executes pinned guards against the primary beside the clone', () => {
    const f = fixture();
    const primary = join(dirname(f.clone), 'webeverything'); mkdirSync(primary);
    f.git(primary, 'init', '-q', '-b', 'main');
    const scratch = join(f.temp, 'operations/dispatch/scratch'); mkdirSync(scratch, { recursive: true });
    const carried = dispatchGuardHooks({ preToolUse: settings.hooks.PreToolUse, repoRoot: '/unused' })
      .flatMap(group => group.hooks.map(hook => hook.command));
    expect(carried).toEqual(hookCommands('PreToolUse'));
    for (const command of carried) {
      const result = f.command(scratch, command, { cwd: scratch });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ root: realpathSync(primary), cwd: scratch });
    }
  });
  it('refuses a malformed path before any containment check', () => {
    const f = fixture();
    for (const script of ['scripts/../outside.mjs', '../scripts/guard-bash.mjs', '/scripts/guard-bash.mjs']) {
      expect(f.launch(f.lane, script)).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('expected a relative path inside scripts') });
    }
  });
  it.each(['scripts/directory/guard', 'scripts/directory', 'scripts/escape.mjs', 'scripts/escape-dir/guard.mjs'])('refuses committed escaping or non-file target %s on a pristine clone', script => {
    const f = fixture(); const outside = join(f.temp, 'outside'); mkdirSync(outside);
    const ran = join(f.temp, 'ESCAPED');
    writeFileSync(join(outside, 'guard.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(ran)}, '1');`);
    mkdirSync(join(f.clone, 'scripts/directory/guard'), { recursive: true });
    writeFileSync(join(f.clone, 'scripts/directory/guard/keep'), '');
    symlinkSync(join(outside, 'guard.mjs'), join(f.clone, 'scripts/escape.mjs'));
    symlinkSync(outside, join(f.clone, 'scripts/escape-dir'), 'dir');
    commitClone(f, 'escaping entries');
    expect(f.git(f.clone, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(f.launch().status).toBe(0);
    expect(f.launch(f.lane, script)).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('clone guard must be a regular file inside clone/scripts') });
    expect(existsSync(ran)).toBe(false);
  });
  it('refuses a scripts directory symlink that escapes the clone', () => {
    const f = fixture(); const scripts = join(f.temp,'outside-scripts');
    renameSync(join(f.clone,'scripts'),scripts); symlinkSync(scripts,join(f.clone,'scripts'),'dir');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('launcher must be located')});
  });
  function ageHead(f, hours) {
    const date = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const commit = spawnSync('git', ['-C', f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      'commit', '--allow-empty', '-qm', 'aged head'], {
      env: {...f.env, GIT_AUTHOR_DATE:date, GIT_COMMITTER_DATE:date}, encoding:'utf8', maxBuffer:1024*1024,
    });
    expect(commit.status, commit.stderr).toBe(0);
    f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  it.each([25, 169])('allows a quiet repository with a %sh-old HEAD after a recent sync, without warning', hours => {
    const f = fixture(); ageHead(f, hours);
    expect(f.launch()).toMatchObject({status:0, stderr:'guard stderr\n'});
  });
  it.each([25, 169])('denies a %sh-old sync even when HEAD is fresh and gives exact recovery paths', hours => {
    const f = fixture();
    const old = new Date(Date.now() - hours*60*60*1000);
    utimesSync(join(f.clone, '.git/FETCH_HEAD'), old, old);
    const result = f.launch();
    expect(result).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('last sync was more than 24h ago')});
    expect(result.stderr).toContain(`node ${join(f.clone, 'scripts/hooks/sync-guard-clone.mjs')}`);
    expect(result.stderr).toContain(join(f.clone, 'scripts/hooks/com.we.guard-main-sync.plist.template'));
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it('allows a sync just under 24h old', () => {
    const f = fixture(); const recent = new Date(Date.now() - (24*60*60*1000 - 60_000));
    utimesSync(join(f.clone, '.git/FETCH_HEAD'), recent, recent);
    expect(f.launch()).toMatchObject({status:0, stderr:'guard stderr\n'});
  });
  it.each(['missing', 'directory', 'future', 'invalid'])('denies %s FETCH_HEAD evidence with exact recovery paths', kind => {
    const f = fixture(); const path = join(f.clone, '.git/FETCH_HEAD');
    if (kind === 'missing' || kind === 'directory') {
      rmSync(path);
      if (kind === 'directory') mkdirSync(path);
    } else {
      const time = kind === 'future' ? new Date(Date.now() + 60*60*1000) : new Date(0);
      utimesSync(path, time, time);
    }
    const result = f.launch();
    expect(result).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('freshness')});
    expect(result.stderr).toContain(`node ${join(f.clone, 'scripts/hooks/sync-guard-clone.mjs')}`);
    expect(result.stderr).toContain(join(f.clone, 'scripts/hooks/com.we.guard-main-sync.plist.template'));
  });
  it.each(['--assume-unchanged', '--skip-worktree'])('denies hidden edits and even unmodified %s entries', flag => {
    const f = fixture(); const script = 'scripts/guard-bash.mjs';
    f.git(f.clone, 'update-index', flag, script);
    expect(f.launch()).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('not pristine')});
    writeFileSync(join(f.clone, script), 'console.log("HIDDEN TAMPERING");');
    expect(f.git(f.clone, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(f.launch()).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('not pristine')});
  });
  it.each(['ls-files', 'diff-index'])('fails closed on failed %s evidence and disables Git caches', check => {
    const f = fixture();
    const realGit = spawnSync('which', ['git'], {encoding:'utf8'}).stdout.trim();
    const bin = join(f.temp, 'bin'); mkdirSync(bin);
    const log = join(f.temp, 'git-args.jsonl');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const {appendFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (args.includes(${JSON.stringify(check)})) { console.error('unreadable audit evidence'); process.exit(1); }
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
process.exit(result.status ?? 2);
`, {mode:0o755});
    f.env.PATH = bin + ':' + f.env.PATH;
    expect(f.launch()).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('denying (exit 2)')});
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const audit = calls.find(args => args.includes(check));
    expect(audit).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false', 'core.untrackedCache=false']));
    if (check === 'ls-files') expect(audit.slice(-3)).toEqual(['ls-files', '-v', '-z']);
    else expect(audit.slice(-4)).toEqual(['diff-index', '--quiet', 'HEAD', '--']);
  });
  describe('retry re-reads all evidence on every attempt', () => {
    const wrap = (f, body) => {
      const realGit = spawnSync('which', ['git'], {encoding:'utf8'}).stdout.trim();
      const bin = join(f.temp, 'bin'); mkdirSync(bin);
      const count = join(f.temp, 'count');
      writeFileSync(join(bin, 'git'), `#!${process.execPath}
const {appendFileSync, readFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
const seen = name => { appendFileSync(${JSON.stringify(count)}, name+'\\n'); return readFileSync(${JSON.stringify(count)}, 'utf8').split('\\n').filter(x => x === name).length; };
${body}
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
process.exit(result.status ?? 2);
`, {mode:0o755});
      f.env.PATH = bin + ':' + f.env.PATH;
    };
    it('passes only after a transient dirty status clears and everything is clean together', () => {
      const f = fixture();
      wrap(f, "if (args.includes('status') && seen('status') === 1) { console.log(' M scripts/guard-bash.mjs'); process.exit(0); }");
      expect(f.launch()).toMatchObject({status: 0});
    });
    it('denies when a hidden-flag entry appears on a later attempt after an earlier dirty status', () => {
      const f = fixture();
      wrap(f, "if (args.includes('status') && seen('status') === 1) { console.log(' M scripts/guard-bash.mjs'); process.exit(0); }\nif (args.includes('ls-files') && seen('ls-files') >= 2) { process.stdout.write('S scripts/guard-bash.mjs\\0'); process.exit(0); }");
      expect(f.launch()).toMatchObject({status: 2, stdout: '', stderr: expect.stringContaining('not pristine')});
    });
  });
  it('derives the clone from its own realpath despite a hostile clone override', () => {
    const f = fixture(); f.env.WE_GUARD_CLONE = f.lane;
    expect(f.launch().status).toBe(0);
  });
  it('refuses a launcher copied outside the required clone-relative location', () => {
    const f = fixture(); const misplaced = join(f.temp, 'run-pinned-guard.mjs');
    copyFileSync(join(f.clone, 'scripts/hooks/run-pinned-guard.mjs'), misplaced);
    const result = spawnSync(process.execPath, [misplaced, 'scripts/guard-bash.mjs'], {
      cwd:f.lane, env:f.env, encoding:'utf8', maxBuffer:1024*1024,
    });
    expect(result).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('launcher must be located')});
  });
});

describe('configured settings wrappers executed via sh -c', () => {
  it('executes every security command from the dedicated clone, never either working checkout', () => {
    const f = fixture();
    for (const command of commands) {
      expect(command).not.toContain('git rev-parse');
      const result = f.command(f.lane,command,{hello:'world'});
      expect(result.status,result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({root:f.lane,input:'{"hello":"world"}'});
      // PreToolUse maps every failure to a deny; Stop hooks keep Claude Code's own exit-code meaning.
      f.env.PROBE_EXIT='7'; expect(f.command(f.lane,command,{}).status).toBe(isStop(command) ? 7 : 2);
      f.env.PROBE_EXIT='2'; expect(f.command(f.lane,command,{}).status).toBe(2); delete f.env.PROBE_EXIT;
    }
  });
  it.each(['stale sync', 'missing launcher', 'missing guard'])('a %s never blocks Stop or SubagentStop, but still denies PreToolUse', kind => {
    const f = fixture();
    if (kind === 'stale sync') { const old = new Date(Date.now() - 25*60*60*1000); utimesSync(join(f.clone, '.git/FETCH_HEAD'), old, old); }
    if (kind === 'missing launcher') rmSync(join(f.clone, 'scripts/hooks/run-pinned-guard.mjs'));
    if (kind === 'missing guard') { for (const command of stopCommands) rmSync(join(f.clone, scriptOf(command)), { force: true }); rmSync(join(f.clone, 'scripts/guard-bash.mjs')); }
    expect(stopCommands.length).toBeGreaterThan(0);
    for (const command of stopCommands) {
      const result = f.command(f.lane, command, { hook_event_name: 'Stop', stop_hook_active: false });
      expect(result, command).toMatchObject({ status: 1, stdout: '', stderr: expect.stringContaining('stop guard skipped') });
    }
    expect(f.command(f.lane, bashCommand, {})).toMatchObject({ status: 2, stdout: '' });
  });
  it('runs every configured hook while a live sync holds the lock', () => {
    const f = fixture(); f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    const lock = syncLock(f, process.pid);
    for (const command of commands) {
      const result = f.command(f.lane, command, {});
      expect(result.status, `${command}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ root: f.lane, input: '{}' });
      expect(result.stderr).toBe('guard stderr\n');
    }
    expect(existsSync(lock)).toBe(true);
  });
  it('ignores an env-selected launcher for every hook, including when the fixed launcher is missing', () => {
    const f = fixture(); const hostile = join(f.temp, 'hostile');
    mkdirSync(join(hostile, 'scripts/hooks'), {recursive:true});
    writeFileSync(join(hostile, 'scripts/hooks/run-pinned-guard.mjs'), 'console.log("HOSTILE LAUNCHER");');
    f.env.WE_GUARD_CLONE = hostile;
    for (const command of commands) {
      expect(command).not.toContain('WE_GUARD_CLONE');
      expect(f.command(f.lane,command,{})).toMatchObject({status:0, stdout:expect.not.stringContaining('HOSTILE')});
    }
    rmSync(f.clone, {recursive:true, force:true});
    for (const command of commands) {
      expect(f.command(f.lane,command,{})).toMatchObject({status:isStop(command) ? 1 : 2, stdout:'', stderr:expect.stringContaining('launcher missing')});
    }
  });
  it('fails closed for missing clone, missing launcher, broken launcher and missing guard', () => {
    const f = fixture(); const launcher=join(f.clone,'scripts/hooks/run-pinned-guard.mjs');
    rmSync(join(f.clone,'scripts/guard-bash.mjs'));
    expect(f.command(f.lane,bashCommand,{})).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('cannot load dedicated clone guard')});
    rmSync(launcher);
    expect(f.command(f.lane,bashCommand,{})).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('launcher missing')});
    writeFileSync(launcher,'throw new Error("broken bootstrap");');
    expect(f.command(f.lane,bashCommand,{})).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('broken bootstrap')});
    rmSync(f.clone,{recursive:true,force:true});
    expect(f.command(f.lane,bashCommand,{})).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('launcher missing')});
  });
});
