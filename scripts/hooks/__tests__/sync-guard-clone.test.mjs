import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../sync-guard-clone.mjs');
const temps=[];
afterEach(()=>{for(const temp of temps.splice(0)) { execFileSync('chmod', ['-R', 'u+w', temp]); rmSync(temp,{recursive:true,force:true}); }});
function fixture() {
  const temp=realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(),'guard-sync-'))); temps.push(temp);
  const origin=join(temp,'origin with spaces'); mkdirSync(origin);
  const clone=join(temp,'dedicated guard clone');
  const env={...process.env,WE_GUARD_CLONE:clone,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const key of Object.keys(env)) if(key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env,encoding:'utf8',timeout:30_000,maxBuffer:1024*1024}).trim();
  git(origin,'init','-b','main'); git(origin,'config','user.name','Fixture'); git(origin,'config','user.email','fixture@example.test');
  writeFileSync(join(origin,'guard'),'first'); git(origin,'add','.'); git(origin,'commit','-qm','first');
  const repo=join(temp,'operated'); git(temp,'clone','--',origin,repo);
  const run=(args=[],cwd=repo)=>spawnSync(process.execPath,[script,...args],{cwd,env,encoding:'utf8',timeout:30_000,maxBuffer:1024*1024});
  return {temp,origin,clone,repo,env,git,run, writable() { execFileSync('chmod', ['-R', 'u+w', clone]); }};
}
function deadPid() {
  return Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());
}
/** Route git through a recording shim; returns the JSONL log path. */
function gitLog(f) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.temp, 'recording-git'); mkdirSync(bin);
  const log = join(f.temp, 'git-calls.jsonl');
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const {appendFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
  f.env.PATH = bin + ':' + f.env.PATH;
  return log;
}
describe('dedicated guard clone synchronization (temporary local origins only)',()=>{
  it('locks an in-place guard against concurrent sync until late imports finish', async () => {
    const f = fixture();
    mkdirSync(join(f.origin, 'scripts/hooks'), { recursive: true });
    copyFileSync(resolve(dirname(script), 'run-pinned-guard.mjs'), join(f.origin, 'scripts/hooks/run-pinned-guard.mjs'));
    writeFileSync(join(f.origin, 'scripts/late-v1.mjs'), 'export const revision = "original revision";');
    writeFileSync(join(f.origin, 'scripts/delayed.mjs'), `
import { fileURLToPath } from 'node:url';
console.log(JSON.stringify({ entry: fileURLToPath(import.meta.url) }));
await new Promise(resolve => process.stdin.once('data', resolve));
const { revision } = await import('./late-v1.mjs');
console.log(revision);
`);
    f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'original delayed import');
    expect(f.run().status).toBe(0);
    expect(statSync(join(f.clone, '.git/FETCH_HEAD')).isFile()).toBe(true);
    const child = spawn(process.execPath, [join(f.clone, 'scripts/hooks/run-pinned-guard.mjs'), 'scripts/delayed.mjs'], {
      cwd: f.repo, env: f.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 25_000,
    });
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    const nextLine = () => Promise.race([
      once(lines, 'line').then(([line]) => line),
      closed.then(([code]) => { throw new Error(`guard exited before its next output line (${code})`); }),
    ]);
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      const ready = await nextLine();
      const entry = JSON.parse(ready).entry;
      expect(entry).toBe(join(f.clone, 'scripts/delayed.mjs'));
      // The running guard holds a shared lease, not the exclusive sync lock.
      expect(readdirSync(`${f.clone}.guard-readers`)).toHaveLength(1);
      expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
      rmSync(join(f.origin, 'scripts/late-v1.mjs'));
      writeFileSync(join(f.origin, 'scripts/late-v2.mjs'), 'export const revision = "new revision";');
      writeFileSync(join(f.origin, 'scripts/delayed.mjs'), 'console.log("new guard");');
      f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'remove original dependency');
      f.env.WE_GUARD_LOCK_WAIT_MS = '50';
      const refresh = f.run();
      delete f.env.WE_GUARD_LOCK_WAIT_MS;
      expect(refresh).toMatchObject({ status: 2, stderr: expect.stringContaining('retry sync') });
      expect(refresh.stderr).toContain('guard hook(s) still running');
      expect(existsSync(join(f.clone, 'scripts/late-v1.mjs'))).toBe(true);
      expect(existsSync(join(f.clone, 'scripts/late-v2.mjs'))).toBe(false);
      expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
      const imported = nextLine();
      child.stdin.end('continue');
      expect(await imported).toBe('original revision');
      expect((await closed)[0], stderr).toBe(0);
      expect(readdirSync(`${f.clone}.guard-readers`)).toEqual([]);
      const refreshAfterExit = f.run();
      expect(refreshAfterExit.status, refreshAfterExit.stderr).toBe(0);
      expect(existsSync(join(f.clone, 'scripts/late-v1.mjs'))).toBe(false);
      expect(existsSync(join(f.clone, 'scripts/late-v2.mjs'))).toBe(true);
    } finally {
      if (!child.stdin.writableEnded) child.stdin.end('continue');
      await closed;
      lines.close();
    }
  }, 30_000);
  it.each(['live sync lock', 'live guard lease'])('refuses a %s without fetching, resetting, cleaning or reclaiming it', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const held = kind === 'live sync lock' ? `${f.clone}.guard-lock` : join(`${f.clone}.guard-readers`, `${process.pid}-feed`);
    if (kind === 'live sync lock') { mkdirSync(held); writeFileSync(join(held, 'owner'), `${process.pid} other\n`); }
    else writeFileSync(held, '');
    f.writable();
    writeFileSync(join(f.clone, 'keep'), 'precious');
    const log = gitLog(f);
    f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    expect(f.run()).toMatchObject({ status: 2, stderr: expect.stringContaining('retry sync') });
    expect(readFileSync(join(f.clone, 'keep'), 'utf8')).toBe('precious');
    expect(existsSync(held)).toBe(true);
    if (kind === 'live guard lease') expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    for (const args of calls) expect(args.filter(arg => ['fetch', 'reset', 'clean', 'clone'].includes(arg)), args.join(' ')).toEqual([]);
  });
  it.each(['dead owner', 'no owner record'])('reclaims a sync lock left by a %s and prunes dead guard leases', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const lock = `${f.clone}.guard-lock`; mkdirSync(lock);
    if (kind === 'dead owner') writeFileSync(join(lock, 'owner'), `${deadPid()} crashed\n`);
    const lease = join(`${f.clone}.guard-readers`, `${deadPid()}-dead`);
    writeFileSync(lease, '');
    writeFileSync(join(f.origin, 'guard'), 'second'); f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'second');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('second');
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(lease)).toBe(false);
    expect(readdirSync(dirname(f.clone)).filter(name => name.includes('.guard-lock'))).toEqual([]);
  });
  it('syncs to HOME/workspace/.guard-main with WE_GUARD_CLONE unset, where the settings launcher looks', () => {
    const f = fixture(); delete f.env.WE_GUARD_CLONE;
    f.env.HOME = join(f.temp, 'home with spaces');
    mkdirSync(f.env.HOME);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const clone = join(f.env.HOME, 'workspace/.guard-main');
    expect(f.git(clone, 'config', '--local', '--get', 'we.guardClone')).toBe(clone);
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'main'));
    expect(existsSync(f.clone)).toBe(false);
    const settings = JSON.parse(readFileSync(resolve(dirname(script), '../../.claude/settings.json'), 'utf8'));
    const launcher = settings.hooks.PreToolUse[0].hooks[0].command.match(/launcher="([^"]+)"/)[1];
    expect(launcher.replace('$HOME', f.env.HOME)).toBe(join(clone, 'scripts/hooks/run-pinned-guard.mjs'));
  });
  it('clones origin/main only using the current repository origin, then resets and cleans only its owned clone',()=>{
    const f=fixture(); expect(f.run()).toMatchObject({status:0});
    expect(f.git(f.clone,'config','--get','remote.origin.url')).toBe(f.origin);
    expect(f.git(f.clone,'config','--get-all','remote.origin.fetch')).toBe('+refs/heads/main:refs/remotes/origin/main');
    expect(f.git(f.clone,'config','--local','--get','we.guardClone')).toBe(f.clone);
    writeFileSync(join(f.repo,'keep'),'operated checkout');
    f.writable();
    writeFileSync(join(f.clone,'guard'),'discard edit'); writeFileSync(join(f.clone,'untracked'),'discard');
    writeFileSync(join(f.clone,'.gitignore'),'ignored'); writeFileSync(join(f.clone,'ignored'),'discard ignored');
    writeFileSync(join(f.origin,'guard'),'second'); f.git(f.origin,'add','.'); f.git(f.origin,'commit','-qm','second');
    const result=f.run(); expect(result.status,result.stderr).toBe(0);
    expect(readFileSync(join(f.clone,'guard'),'utf8')).toBe('second');
    for(const name of ['untracked','.gitignore','ignored']) expect(existsSync(join(f.clone,name))).toBe(false);
    expect(readFileSync(join(f.repo,'keep'),'utf8')).toBe('operated checkout');
    expect(f.git(f.clone,'rev-parse','HEAD')).toBe(f.git(f.origin,'rev-parse','main'));
  });
  it('removes all working-tree write bits after both initial clone and refresh', () => {
    const f = fixture();
    for (const revision of ['initial', 'refresh']) {
      const result = f.run(); expect(result.status, result.stderr).toBe(0);
      expect(statSync(f.clone).mode & 0o222, revision).toBe(0);
      expect(statSync(join(f.clone, 'guard')).mode & 0o222, revision).toBe(0);
    }
  });
  it('converges initial HEAD to origin/main when origin advances between clone and fetch', () => {
    const f = fixture();
    const before = f.git(f.origin, 'rev-parse', 'HEAD');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }).trim();
    const bin = join(f.temp, 'git-wrapper'); mkdirSync(bin);
    const marker = join(f.temp, 'cloned-head');
    // Advance the local origin only after the real clone completes, before the
    // sync process can fetch. No timing or external remote is involved.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const git = (...argv) => execFileSync(${JSON.stringify(realGit)}, argv, {
  encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
});
process.stdout.write(git(...args));
if (args.includes('clone')) {
  writeFileSync(${JSON.stringify(marker)}, git('-C', ${JSON.stringify(f.clone)}, 'rev-parse', 'HEAD').trim());
  git('-C', ${JSON.stringify(f.origin)}, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'advance during initial sync');
}
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Guard clone synchronized to origin/main.');
    expect(readFileSync(marker, 'utf8')).toBe(before);
    const after = f.git(f.origin, 'rev-parse', 'HEAD');
    expect(after).not.toBe(before);
    expect(f.git(f.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(after);
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(after);
  });
  it('refreshes FETCH_HEAD on initial and unchanged syncs without changing HEAD', () => {
    const f = fixture(); const started = Date.now();
    const initial = f.run(); expect(initial.status, initial.stderr).toBe(0);
    const fetchHead = join(f.clone, '.git/FETCH_HEAD');
    expect(statSync(fetchHead).mtimeMs).toBeGreaterThanOrEqual(started - 1000);
    const head = f.git(f.clone, 'rev-parse', 'HEAD');
    const old = new Date(Date.now() - 25*60*60*1000);
    utimesSync(fetchHead, old, old);
    const refreshed = Date.now();
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(statSync(fetchHead).mtimeMs).toBeGreaterThanOrEqual(refreshed - 1000);
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(head);
  });
  it('supports --origin from outside a repository',()=>{
    const f=fixture(); expect(f.run([`--origin=${f.origin}`],f.temp).status).toBe(0);
  });
  it('refuses a different origin before any reset or cleanup',()=>{
    const f=fixture(); expect(f.run().status).toBe(0); f.writable();
    writeFileSync(join(f.clone,'keep'),'precious'); const before=f.git(f.clone,'rev-parse','HEAD');
    const result=f.run([`--origin=${f.repo}`]);
    expect(result).toMatchObject({status:2,stderr:expect.stringContaining('different origin')});
    expect(readFileSync(join(f.clone,'keep'),'utf8')).toBe('precious'); expect(f.git(f.clone,'rev-parse','HEAD')).toBe(before);
  });
  it('refuses an unrelated matching-origin checkout without an ownership marker',()=>{
    const f=fixture(); f.env.WE_GUARD_CLONE=f.repo; writeFileSync(join(f.repo,'keep'),'precious');
    expect(f.run()).toMatchObject({status:2,stderr:expect.stringContaining('move it aside')}); expect(readFileSync(join(f.repo,'keep'),'utf8')).toBe('precious');
  });
  it('refuses symlink targets and linked worktrees without modifying them',()=>{
    const f=fixture(); symlinkSync(f.repo,f.clone,'dir'); expect(f.run().status).toBe(2); rmSync(f.clone);
    f.git(f.repo,'worktree','add','-b','worktree',f.clone); writeFileSync(join(f.clone,'keep'),'precious');
    expect(f.run().status).toBe(2); expect(readFileSync(join(f.clone,'keep'),'utf8')).toBe('precious');
  });
  it.each(['branch','fetch'])('refuses altered %s configuration in an owned clone',kind=>{
    const f=fixture(); expect(f.run().status).toBe(0); f.writable(); writeFileSync(join(f.clone,'keep'),'precious');
    if(kind==='branch') f.git(f.clone,'checkout','-b','other');
    else f.git(f.clone,'config','remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*');
    expect(f.run().status).toBe(2); expect(readFileSync(join(f.clone,'keep'),'utf8')).toBe('precious');
  });
  it('does not let inherited Git directory overrides redirect destructive commands',()=>{
    const f=fixture(); expect(f.run().status).toBe(0); writeFileSync(join(f.repo,'keep'),'precious');
    f.env.GIT_DIR=join(f.repo,'.git'); f.env.GIT_WORK_TREE=f.repo;
    for (const key of ['GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE']) f.env[key] = join(f.temp, 'invalid');
    f.env.GIT_CONFIG_COUNT = 'invalid';
    expect(f.run([`--origin=${f.origin}`]).status).toBe(0);
    expect(readFileSync(join(f.repo,'keep'),'utf8')).toBe('precious');
  });
});
