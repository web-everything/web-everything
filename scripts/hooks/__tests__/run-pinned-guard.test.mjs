import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedFixture } from './pinned-fixture.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
const commands = ['PreToolUse', 'Stop', 'SubagentStop'].flatMap(event =>
  settings.hooks[event].flatMap(group => group.hooks.map(hook => hook.command)));
const bashCommand = settings.hooks.PreToolUse.find(group => group.matcher === 'Bash').hooks[0].command;
const fixtures = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture() {
  const f = pinnedFixture(); fixtures.push(f);
  // Both the clone and its parent paths contain spaces in the wiring probes.
  const clone = join(f.temp, 'guard clone with spaces'); renameSync(f.clone, clone);
  f.clone = clone; f.env.WE_GUARD_CLONE = clone;
  const probe = `import {readFileSync} from 'node:fs';
console.log(JSON.stringify({root:process.env.WE_HOOK_ROOT,cwd:process.cwd(),args:process.argv.slice(2),gitKeys:Object.keys(process.env).filter(key=>key.startsWith('GIT_')),input:readFileSync(0,'utf8')}));
console.error('guard stderr'); process.exitCode=Number(process.env.PROBE_EXIT || 0);`;
  for (const command of commands) {
    const script = command.match(/node "\$launcher" (scripts\/[^ ;]+)/)[1];
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
  it('never runs primary or lane copies; preserves root, cwd, stdin, argv and exit status', () => {
    const f = fixture(); const nested = join(f.lane, 'nested'); mkdirSync(nested);
    f.env.WE_HOOK_ROOT = f.primary; f.env.PROBE_EXIT = '7';
    const result = f.launch(nested, 'scripts/guard-bash.mjs', ['--pre', 'space argument']);
    expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({root:f.lane,cwd:nested,args:['--pre','space argument'],gitKeys:[],input:'payload'});
    expect(result.stderr).toBe('guard stderr\n');
  });
  it.each(['tracked', 'untracked'])('denies a %s working-tree edit before executing the guard', kind => {
    const f = fixture();
    writeFileSync(join(f.clone, kind === 'tracked' ? 'scripts/guard-bash.mjs' : 'unexpected'), 'console.log("TAMPERED");');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('not pristine')});
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
    f.env.GIT_WORK_TREE = '/tmp';
    f.env.GIT_CONFIG_COUNT = 'invalid';
    f.env.PROBE_EXIT = '7';
    const result = f.launch();
    expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toMatchObject({root:f.lane,gitKeys:[]});
  });
  it('fails closed when the clone is missing even though lane guards exist', () => {
    const f = fixture(); rmSync(f.clone, {recursive:true,force:true});
    // Run the source launcher to exercise its own clone-missing path.
    const result = spawnSync(process.execPath, [join(repo,'scripts/hooks/run-pinned-guard.mjs'),'scripts/guard-bash.mjs'], {
      cwd:f.lane,env:f.env,encoding:'utf8',maxBuffer:1024*1024,
    });
    expect(result).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('cannot load dedicated clone guard')});
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
  it('denies a busy clone without running a guard or reclaiming the lock, then permits retry', () => {
    const f = fixture();
    const lock = `${f.clone}.guard-lock`; mkdirSync(lock);
    expect(f.launch()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('retry the hook') });
    // An existing lock must remain owned by the other invocation.
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    expect(f.launch().status).toBe(0);
  });
  it('fails closed on a missing clone script and on a cwd outside Git', () => {
    const f = fixture();
    expect(f.launch(f.temp).status).toBe(2);
    rmSync(join(f.clone,'scripts/guard-bash.mjs'));
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('denying (exit 2)')});
  });
  it.each(['scripts/../outside.mjs','../scripts/guard-bash.mjs','/scripts/guard-bash.mjs','scripts/directory','scripts/escape.mjs','scripts/escape-dir/guard.mjs'])('refuses invalid or escaping target %s', script => {
    const f = fixture(); const outside = join(f.temp,'outside'); mkdirSync(outside);
    writeFileSync(join(outside,'guard.mjs'),'console.log("ESCAPE");');
    mkdirSync(join(f.clone,'scripts/directory'));
    symlinkSync(join(outside,'guard.mjs'),join(f.clone,'scripts/escape.mjs'));
    symlinkSync(outside,join(f.clone,'scripts/escape-dir'),'dir');
    expect(f.launch(f.lane,script)).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('denying (exit 2)')});
  });
  it('refuses a scripts directory symlink that escapes the clone', () => {
    const f = fixture(); const scripts = join(f.temp,'outside-scripts');
    renameSync(join(f.clone,'scripts'),scripts); symlinkSync(scripts,join(f.clone,'scripts'),'dir');
    expect(f.launch()).toMatchObject({status:2,stdout:'',stderr:expect.stringContaining('regular file inside clone/scripts')});
  });
  it('warns but runs when FETCH_HEAD is stale, preferring its mtime over HEAD time', () => {
    const f = fixture(); const fetchHead = join(f.clone,'.git/FETCH_HEAD'); writeFileSync(fetchHead,'');
    const old = new Date(Date.now()-25*60*60*1000); utimesSync(fetchHead,old,old);
    expect(f.launch()).toMatchObject({status:0,stderr:expect.stringContaining('>24h behind')});
    utimesSync(fetchHead,new Date(),new Date());
    expect(f.launch().stderr).toBe('guard stderr\n');
  });
  it('falls back to HEAD commit time when FETCH_HEAD is absent', () => {
    const f = fixture();
    const commit = spawnSync('git',['-C',f.clone,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','old'],{
      env:{...f.env,GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'},encoding:'utf8',maxBuffer:1024*1024,
    });
    expect(commit.status,commit.stderr).toBe(0);
    f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(f.launch()).toMatchObject({status:0,stderr:expect.stringContaining('>24h behind')});
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
      f.env.PROBE_EXIT='7'; expect(f.command(f.lane,command,{}).status).toBe(2); delete f.env.PROBE_EXIT;
    }
  });
  it('uses HOME/workspace/.guard-main when WE_GUARD_CLONE is unset', () => {
    const f = fixture(); f.env.HOME=join(f.temp,'home'); mkdirSync(join(f.env.HOME,'workspace'),{recursive:true});
    renameSync(f.clone,join(f.env.HOME,'workspace/.guard-main')); delete f.env.WE_GUARD_CLONE;
    expect(f.command(f.lane,bashCommand,{}).status).toBe(0);
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
