import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  const f = pinnedFixture({ launcherOnly: true }); fixtures.push(f);
  // HOME contains spaces in the wiring probes.
  const clone = f.clone;
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
      f.env.PROBE_EXIT='7'; expect(f.command(f.lane,command,{}).status).toBe(2); delete f.env.PROBE_EXIT;
    }
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
      expect(f.command(f.lane,command,{})).toMatchObject({status:2, stdout:'', stderr:expect.stringContaining('launcher missing')});
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
