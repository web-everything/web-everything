import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../sync-guard-clone.mjs');
const { LEGACY, lockWaitMs, readRecord, reclaim } = await import('../sync-guard-clone.mjs');
const temps=[];
afterEach(()=>{for(const temp of temps.splice(0)) { execFileSync('chmod', ['-R', 'u+w', temp]); rmSync(temp,{recursive:true,force:true}); }});
function fixture() {
  const temp=realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(),'guard-sync-'))); temps.push(temp);
  const origin=join(temp,'origin with spaces'); mkdirSync(origin);
  const clone=join(temp,'dedicated guard clone');
  const env={...process.env,TMPDIR:temp,WE_GUARD_CLONE:clone,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  for(const key of Object.keys(env)) if(key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env,encoding:'utf8',timeout:30_000,maxBuffer:1024*1024}).trim();
  git(origin,'init','-b','main'); git(origin,'config','user.name','Fixture'); git(origin,'config','user.email','fixture@example.test');
  mkdirSync(join(origin, 'scripts/hooks'), { recursive: true });
  copyFileSync(resolve(dirname(script), 'run-pinned-guard.mjs'), join(origin, 'scripts/hooks/run-pinned-guard.mjs'));
  writeFileSync(join(origin, 'scripts/probe.mjs'), 'console.log("verified reader");');
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
/** Install a hermetic git shim; body runs only after successful real Git calls. */
function afterGit(f, body) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.temp, 'controlled-git'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 2);
const target = args.includes('clone') ? args.at(-1) : args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
${body}
`, { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
}
function reader(f, root = f.clone) {
  return spawnSync(process.execPath, [join(root, 'scripts/hooks/run-pinned-guard.mjs'), 'scripts/probe.mjs'], {
    cwd: f.repo, env: { ...f.env, WE_GUARD_ORIGIN: f.origin, WE_GUARD_LOCK_WAIT_MS: '50' },
    input: '', encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
}
function verifiedRevision(f, revision) {
  expect(dirname(revision)).toBe(`${f.clone}.revs`);
  expect(lstatSync(join(revision, '.git')).isDirectory()).toBe(true);
  expect(f.git(revision, 'status', '--porcelain', '--ignored', '--untracked-files=all')).toBe('');
  expect(f.git(revision, 'ls-files', '-v').split('\n').every(line => line.startsWith('H '))).toBe(true);
  expect(f.git(revision, 'rev-parse', 'HEAD')).toBe(f.git(revision, 'rev-parse', 'origin/main'));
  expect(f.git(revision, 'config', '--get', 'we.guardClone')).toBe(f.clone);
  expect(statSync(join(revision, '.git/FETCH_HEAD')).isFile()).toBe(true);
  expect(reader(f, revision)).toMatchObject({ status: 0, stdout: 'verified reader\n' });
}
describe('dedicated guard clone synchronization (temporary local origins only)',()=>{
  it('atomically publishes only complete verified revisions, including reads during a live sync', async () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const old = realpathSync(f.clone);
    const oldHead = f.git(old, 'rev-parse', 'HEAD');
    f.git(f.origin, 'commit', '--allow-empty', '-qm', 'next revision');
    const newHead = f.git(f.origin, 'rev-parse', 'HEAD');
    const server = createServer();
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const connection = once(server, 'connection');
    afterGit(f, `if (args.includes('fetch') && !fs.existsSync(${JSON.stringify(join(f.temp, 'fetch-paused'))})) {
  fs.writeFileSync(${JSON.stringify(join(f.temp, 'fetch-paused'))}, 'paused');
  const socket = require('node:net').connect(${server.address().port}, '127.0.0.1');
  socket.once('data', () => socket.end());
}`);
    const child = spawn(process.execPath, [script], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25_000 });
    const closed = once(child, 'close');
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    let socket; let timer;
    const samples = [];
    const sample = () => {
      const revision = realpathSync(f.clone);
      expect(lstatSync(f.clone).isSymbolicLink()).toBe(true);
      verifiedRevision(f, revision);
      expect(reader(f)).toMatchObject({ status: 0, stdout: 'verified reader\n' });
      samples.push(f.git(revision, 'rev-parse', 'HEAD'));
    };
    let samplingError;
    try {
      [socket] = await Promise.race([connection, closed.then(([code]) => { throw new Error(`sync exited before fetch barrier (${code}): ${stderr}`); })]);
      expect(existsSync(`${f.clone}.guard-lock`)).toBe(true);
      expect(realpathSync(f.clone)).toBe(old);
      sample(); // Reader must complete while sync is paused and still holds its lock.
      timer = setInterval(() => {
        try { sample(); } catch (error) { samplingError ??= error; }
      }, 25);
      socket.write('continue');
      const [code] = await closed;
      clearInterval(timer);
      expect(code, stderr).toBe(0);
      if (samplingError) throw samplingError;
      sample();
      expect(new Set(samples)).toEqual(new Set([oldHead, newHead]));
      expect(realpathSync(f.clone)).not.toBe(old);
      expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(newHead);
      expect(f.git(old, 'rev-parse', 'HEAD')).toBe(oldHead);
    } finally {
      clearInterval(timer); socket?.destroy();
      if (child.exitCode === null) child.kill();
      await closed;
      await new Promise(resolveClose => server.close(resolveClose));
    }
  }, 30_000);
  it.each(['dirty', 'ignored', 'ahead', 'hidden flag', 'unreadable evidence'])('keeps the old live revision when candidate verification fails: %s', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const old = realpathSync(f.clone);
    const oldHead = f.git(old, 'rev-parse', 'HEAD');
    const before = readdirSync(`${f.clone}.revs`).sort();
    f.git(f.origin, 'commit', '--allow-empty', '-qm', 'new candidate');
    const injected = join(f.temp, 'candidate-tampered');
    afterGit(f, `if (args.includes('update-index') && args.includes('--refresh')) {
  fs.writeFileSync(${JSON.stringify(injected)}, target);
  const git = (...argv) => {
    const r = spawnSync(${JSON.stringify(execFileSync('which', ['git'], { encoding: 'utf8' }).trim())}, ['-C', target, ...argv], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 2);
  };
  const kind = ${JSON.stringify(kind)};
  if (kind === 'dirty' || kind === 'ignored') {
    fs.chmodSync(target, 0o755);
    if (kind === 'ignored') fs.writeFileSync(path.join(target, '.git/info/exclude'), 'planted\\n');
    fs.writeFileSync(path.join(target, 'planted'), 'tampering');
  }
  if (kind === 'ahead') git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'unfetched');
  if (kind === 'hidden flag') git('update-index', '--skip-worktree', 'guard');
  if (kind === 'unreadable evidence') git('update-ref', '-d', 'refs/remotes/origin/main');
}`);
    const result = f.run();
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(injected)).toBe(true);
    expect(readFileSync(injected, 'utf8')).not.toBe(old);
    expect(lstatSync(f.clone).isSymbolicLink()).toBe(true);
    expect(realpathSync(f.clone)).toBe(old);
    expect(f.git(old, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(reader(f)).toMatchObject({ status: 0, stdout: 'verified reader\n' });
    expect(readdirSync(`${f.clone}.revs`).sort()).toEqual(before);
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
    expect(readdirSync(dirname(f.clone)).filter(name => name.startsWith(`${basename(f.clone)}.swap-`))).toEqual([]);
  });
  it('migrates an owned legacy real directory and retains its complete revision', () => {
    const f = fixture();
    f.git(f.temp, 'clone', '--single-branch', '--branch', 'main', '--', f.origin, f.clone);
    f.git(f.clone, 'config', 'we.guardClone', f.clone);
    writeFileSync(join(f.clone, '.git/FETCH_HEAD'), '');
    const oldHead = f.git(f.clone, 'rev-parse', 'HEAD');
    f.git(f.origin, 'commit', '--allow-empty', '-qm', 'advance before migration');
    expect(lstatSync(f.clone).isDirectory()).toBe(true);
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(f.clone).isSymbolicLink()).toBe(true);
    verifiedRevision(f, realpathSync(f.clone));
    const legacy = readdirSync(`${f.clone}.revs`).filter(name => name.startsWith('legacy-'));
    expect(legacy).toHaveLength(1);
    expect(f.git(join(`${f.clone}.revs`, legacy[0]), 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'HEAD'));
  });
  it('prunes read-only revisions by mtime, keeping live plus the two most recent others', () => {
    const f = fixture(); const revisions = []; const base = Date.now();
    for (let index = 0; index < 4; index++) {
      const result = f.run(); expect(result.status, result.stderr).toBe(0);
      const revision = realpathSync(f.clone); revisions.push(revision);
      // Reverse recency deliberately so name order and creation order cannot pass.
      const time = new Date(base - (index === 0 ? 1000 : index === 1 ? 2000 : 10_000));
      utimesSync(revision, time, time);
    }
    expect(new Set(readdirSync(`${f.clone}.revs`).map(name => join(`${f.clone}.revs`, name))))
      .toEqual(new Set([realpathSync(f.clone), revisions[0], revisions[1]]));
    expect(existsSync(revisions[2])).toBe(false);
    verifiedRevision(f, realpathSync(f.clone));
  });
  it('sweeps dead sync swap debris and incomplete revisions without touching live', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const old = realpathSync(f.clone); const pid = deadPid();
    const partial = join(`${f.clone}.revs`, `${pid}-abcdef123456`);
    mkdirSync(partial); writeFileSync(join(partial, 'incomplete'), 'half built');
    const swap = `${f.clone}.swap-${pid}-abcdef123456`; symlinkSync(partial, swap, 'dir');
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(partial)).toBe(false);
    expect(lstatSync(old).isDirectory()).toBe(true);
    expect(readdirSync(dirname(f.clone))).not.toContain(basename(swap));
    verifiedRevision(f, realpathSync(f.clone));
  });
  it('swaps revisions while an old guard runs and preserves its late imports and entry path', async () => {
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
    const oldRevision = realpathSync(f.clone);
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
      expect(entry).toBe(join(oldRevision, 'scripts/delayed.mjs'));
      // Sync publishes another revision without changing this process's realpath.
      expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
      rmSync(join(f.origin, 'scripts/late-v1.mjs'));
      writeFileSync(join(f.origin, 'scripts/late-v2.mjs'), 'export const revision = "new revision";');
      writeFileSync(join(f.origin, 'scripts/delayed.mjs'), 'console.log("new guard");');
      f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'remove original dependency');
      f.env.WE_GUARD_LOCK_WAIT_MS = '50';
      const refresh = f.run();
      delete f.env.WE_GUARD_LOCK_WAIT_MS;
      expect(refresh.status, refresh.stderr).toBe(0);
      expect(lstatSync(f.clone).isSymbolicLink()).toBe(true);
      expect(realpathSync(f.clone)).not.toBe(oldRevision);
      expect(existsSync(join(oldRevision, 'scripts/late-v1.mjs'))).toBe(true);
      expect(existsSync(join(oldRevision, 'scripts/late-v2.mjs'))).toBe(false);
      expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
      const imported = nextLine();
      child.stdin.end('continue');
      expect(await imported).toBe('original revision');
      expect((await closed)[0], stderr).toBe(0);
      expect(f.git(oldRevision, 'status', '--porcelain', '--ignored', '--untracked-files=all')).toBe('');
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
  it('refuses a live sync lock without fetching, resetting, cleaning or reclaiming it', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const held = `${f.clone}.guard-lock`;
    writeFileSync(held, `${process.pid} 0 other\n`);
    f.writable();
    writeFileSync(join(f.clone, 'keep'), 'precious');
    const before = f.git(f.clone, 'rev-parse', 'refs/remotes/origin/main');
    writeFileSync(join(f.origin, 'guard'), 'second'); f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'second');
    const log = gitLog(f);
    f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    expect(f.run()).toMatchObject({ status: 2, stderr: expect.stringContaining('retry sync') });
    expect(readFileSync(join(f.clone, 'keep'), 'utf8')).toBe('precious');
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('first');
    expect(f.git(f.clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(before);
    expect(existsSync(held)).toBe(true);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.filter(arg => ['reset', 'clean', 'clone', 'update-ref'].includes(arg)), args.join(' ')).toEqual([]);
      expect(args).not.toContain('fetch');
    }
  });
  it.each(['dead owner', 'no owner record', 'reused pid'])('reclaims a sync lock left by a %s without changing the previous revision', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const lock = `${f.clone}.guard-lock`;
    if (kind === 'no owner record') mkdirSync(lock);
    else writeFileSync(lock, kind === 'dead owner' ? `${deadPid()} 0 crashed\n` : `${process.pid} 1000 reused\n`);
    const oldRevision = realpathSync(f.clone);
    const debris = join(dirname(f.clone), `${basename(lock)}.new-${deadPid()}-abc`);
    writeFileSync(debris, 'crashed publish');
    writeFileSync(join(f.origin, 'guard'), 'second'); f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'second');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('second');
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(join(oldRevision, 'guard'), 'utf8')).toBe('first');
    expect(readdirSync(dirname(f.clone)).filter(name => name.includes('.guard-lock'))).toEqual([]);
  });
  it('ignores legacy live guard leases instead of draining them', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    mkdirSync(`${f.clone}.guard-readers`, { recursive: true });
    const lease = join(`${f.clone}.guard-readers`, `${process.pid}-feed`);
    writeFileSync(lease, '');
    f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    const old = realpathSync(f.clone);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('guard hook(s)');
    expect(realpathSync(f.clone)).not.toBe(old);
    expect(existsSync(lease)).toBe(true);
  });
  it('lockWaitMs only ever shortens the 20 second bound', () => {
    const previous = process.env.WE_GUARD_LOCK_WAIT_MS;
    try {
      for (const [value, expected] of [[undefined, 20_000], ['600000', 20_000], ['1e9', 20_000], ['Infinity', 20_000],
        ['soon', 20_000], ['-5', 20_000], ['', 0], ['0', 0], ['50', 50], ['20000', 20_000]]) {
        if (value === undefined) delete process.env.WE_GUARD_LOCK_WAIT_MS; else process.env.WE_GUARD_LOCK_WAIT_MS = value;
        expect(lockWaitMs(), String(value)).toBe(expected);
      }
    } finally {
      if (previous === undefined) delete process.env.WE_GUARD_LOCK_WAIT_MS; else process.env.WE_GUARD_LOCK_WAIT_MS = previous;
    }
  });
  it.each(['fails', 'prints junk'])('treats unavailable process-start evidence as live when ps %s', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const bin = join(f.temp, 'ps-shim'); mkdirSync(bin);
    writeFileSync(join(bin, 'ps'), kind === 'fails' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\necho "not a date"\n', { mode: 0o755 });
    f.env.PATH = `${bin}:${f.env.PATH}`;
    f.env.WE_GUARD_LOCK_WAIT_MS = '50';
    f.writable(); writeFileSync(join(f.clone, 'keep'), 'precious');
    const lock = `${f.clone}.guard-lock`;
    writeFileSync(lock, `${process.pid} 1000 holder\n`);
    expect(f.run()).toMatchObject({ status: 2, stderr: expect.stringContaining('another sync is running') });
    expect(readFileSync(lock, 'utf8')).toContain('holder');
    expect(readFileSync(join(f.clone, 'keep'), 'utf8')).toBe('precious');
  });
  it('does not reclaim a lock published after an absent observation', () => {
    const temp = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'guard-reclaim-'))); temps.push(temp);
    const lock = join(temp, 'clone.guard-lock');
    const live = `${process.pid} 0 live\n`;
    let published = false;
    reclaim(lock, '', `${process.pid} 0 reclaimer\n`, { beforeRemove() { writeFileSync(lock, live, { flag: 'wx' }); published = true; } });
    // An absent observation never reaches the remove step, so a lock published in that window survives.
    expect(published).toBe(false);
    writeFileSync(lock, live, { flag: 'wx' });
    expect(readRecord(lock)).toBe(live);
    expect(readdirSync(temp)).toEqual(['clone.guard-lock']);
  });
  it('removes a legacy lock directory only while it is still an empty directory', () => {
    const temp = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'guard-reclaim-'))); temps.push(temp);
    const lock = join(temp, 'clone.guard-lock');
    mkdirSync(lock);
    const live = `${process.pid} 0 live\n`;
    // A peer replaces the abandoned directory with a live lock file inside the window.
    reclaim(lock, LEGACY, `${process.pid} 0 reclaimer\n`, { beforeRemove() { rmSync(lock, { recursive: true }); writeFileSync(lock, live, { flag: 'wx' }); } });
    expect(readRecord(lock)).toBe(live);
    rmSync(lock);
    mkdirSync(lock);
    reclaim(lock, LEGACY, `${process.pid} 0 reclaimer\n`);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(temp)).toEqual([]);
  });
  it('reclaims a lock directory from an earlier revision only when its owner record is dead', () => {
    const temp = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'guard-reclaim-'))); temps.push(temp);
    const lock = join(temp, 'clone.guard-lock');
    const record = `${process.pid} 0 reclaimer\n`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), `${process.pid} other\n`);
    expect(() => reclaim(lock, LEGACY, record)).toThrow('another sync is running');
    expect(readFileSync(join(lock, 'owner'), 'utf8')).toContain('other');
    // The real earlier record is `<pid> <12-hex nonce>`; an all-digit nonce is not a start time.
    writeFileSync(join(lock, 'owner'), `${process.pid} 123456789012\n`);
    expect(() => reclaim(lock, LEGACY, record)).toThrow('another sync is running');
    // A live pid whose process started after the record was written is a reuse.
    utimesSync(join(lock, 'owner'), new Date(1_000_000), new Date(1_000_000));
    reclaim(lock, LEGACY, record);
    expect(existsSync(lock)).toBe(false);
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), `${deadPid()} 9f3a0c2b7e41\n`);
    reclaim(lock, LEGACY, record);
    expect(existsSync(lock)).toBe(false);
    mkdirSync(lock);
    writeFileSync(join(lock, 'unexpected'), '');
    expect(() => reclaim(lock, LEGACY, record)).toThrow(`then remove ${lock}`);
    expect(existsSync(join(lock, 'unexpected'))).toBe(true);
    expect(readdirSync(temp)).toEqual(['clone.guard-lock']);
  });
  it('a sync recovers from a dead earlier-revision lock directory', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const lock = `${f.clone}.guard-lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), `${deadPid()} crashed\n`);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
  it('serialises reclaim: a live reclaimer blocks a second one, which leaves the lock where it is', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const lock = `${f.clone}.guard-lock`;
    writeFileSync(lock, `${deadPid()} 0 crashed\n`);
    writeFileSync(`${lock}.reclaim`, `${process.pid} 0 reclaiming\n`);
    expect(f.run()).toMatchObject({ status: 2, stderr: expect.stringContaining('another sync is reclaiming') });
    expect(readFileSync(lock, 'utf8')).toContain('crashed');
    rmSync(`${lock}.reclaim`);
    writeFileSync(`${lock}.reclaim`, `${deadPid()} 0 crashed reclaim\n`);
    const blocked = f.run();
    expect(blocked).toMatchObject({ status: 2, stderr: expect.stringContaining(`then remove ${lock}.reclaim`) });
    rmSync(`${lock}.reclaim`);
    expect(f.run().status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
  it('syncs to HOME/workspace/.guard-main with WE_GUARD_CLONE unset, where the settings launcher looks', () => {
    const f = fixture(); delete f.env.WE_GUARD_CLONE;
    f.env.HOME = join(f.temp, 'home with spaces');
    mkdirSync(f.env.HOME);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const clone = join(f.env.HOME, 'workspace/.guard-main');
    expect(lstatSync(clone).isSymbolicLink()).toBe(true);
    expect(dirname(realpathSync(clone))).toBe(`${clone}.revs`);
    expect(f.git(clone, 'config', '--local', '--get', 'we.guardClone')).toBe(clone);
    expect(f.git(clone, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'main'));
    expect(existsSync(f.clone)).toBe(false);
    const settings = JSON.parse(readFileSync(resolve(dirname(script), '../../.claude/settings.json'), 'utf8'));
    const launcher = settings.hooks.PreToolUse[0].hooks[0].command.match(/launcher="([^"]+)"/)[1];
    expect(launcher.replace('$HOME', f.env.HOME)).toBe(join(clone, 'scripts/hooks/run-pinned-guard.mjs'));
  });
  it('publishes a clean origin/main revision without resetting or cleaning the previous live tree',()=>{
    const f=fixture(); expect(f.run()).toMatchObject({status:0});
    expect(f.git(f.clone,'config','--get','remote.origin.url')).toBe(f.origin);
    expect(f.git(f.clone,'config','--get-all','remote.origin.fetch')).toBe('+refs/heads/main:refs/remotes/origin/main');
    expect(f.git(f.clone,'config','--local','--get','we.guardClone')).toBe(f.clone);
    writeFileSync(join(f.repo,'keep'),'operated checkout');
    const oldRevision = realpathSync(f.clone);
    f.writable();
    writeFileSync(join(f.clone,'guard'),'discard edit'); writeFileSync(join(f.clone,'untracked'),'discard');
    writeFileSync(join(f.clone,'.gitignore'),'ignored'); writeFileSync(join(f.clone,'ignored'),'discard ignored');
    writeFileSync(join(f.origin,'guard'),'second'); f.git(f.origin,'add','.'); f.git(f.origin,'commit','-qm','second');
    const result=f.run(); expect(result.status,result.stderr).toBe(0);
    expect(readFileSync(join(f.clone,'guard'),'utf8')).toBe('second');
    for(const name of ['untracked','.gitignore','ignored']) expect(existsSync(join(f.clone,name))).toBe(false);
    expect(readFileSync(join(oldRevision, 'guard'), 'utf8')).toBe('discard edit');
    expect(readFileSync(join(oldRevision, 'ignored'), 'utf8')).toBe('discard ignored');
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
  writeFileSync(${JSON.stringify(marker)}, git('-C', args.at(-1), 'rev-parse', 'HEAD').trim());
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
  it('refuses symlinks outside its revision root and linked worktrees without modifying them',()=>{
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
