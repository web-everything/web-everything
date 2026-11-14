import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
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
/** Tamper with `guard` in the clone and forge its index stat fields so git's stat cache
 * matches the rogue content exactly (same size, mtime, mode). Returns the file's path. */
function forgeStatCache(f) {
  const file = join(f.clone, 'guard');
  const before = statSync(file);
  chmodSync(file, 0o644); writeFileSync(file, 'rogue');
  utimesSync(file, before.atime, before.mtime); chmodSync(file, before.mode);
  // Seed an exact stat-cache hit without staging the same-size tampered content.
  // Assert the cache itself; Git may elect to hash it on a racy timestamp.
  f.git(f.clone, 'update-index', '--index-version=2');
  const indexPath = join(f.clone, '.git/index');
  const index = readFileSync(indexPath);
  expect(index.toString('ascii', 0, 4)).toBe('DIRC');
  expect(index.readUInt32BE(4)).toBe(2);
  expect(index.readUInt32BE(8)).toBe(1);
  const blob = index.subarray(52, 72).toString('hex');
  expect(blob).toBe(f.git(f.clone, 'rev-parse', 'HEAD:guard'));
  const tampered = statSync(file, { bigint: true });
  for (const [offset, ns] of [[12, tampered.ctimeNs], [20, tampered.mtimeNs]]) {
    index.writeUInt32BE(Number(ns / 1_000_000_000n), offset);
    index.writeUInt32BE(Number(ns % 1_000_000_000n), offset + 4);
  }
  // Git can smudge size to zero when writing a racily clean index. Populate all
  // stat fields explicitly so this fixture always represents a matching cache.
  const statFields = [[28, tampered.dev], [32, tampered.ino], [36, 0o100644n], [40, tampered.uid], [44, tampered.gid], [48, tampered.size]];
  for (const [offset, value] of statFields) index.writeUInt32BE(Number(value & 0xffffffffn), offset);
  createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  writeFileSync(indexPath, index);
  expect(readFileSync(indexPath)).toEqual(index);
  for (const [offset, value] of statFields) {
    expect(index.readUInt32BE(offset)).toBe(Number(value & 0xffffffffn));
  }
  expect(statSync(file).mode).toBe(before.mode);
  expect(statSync(file).mtime.getTime()).toBe(before.mtime.getTime());
  expect(readFileSync(file, 'utf8')).toBe('rogue');
  return file;
}
/** A `git` shim that runs `body` (JS, with `realGit` and `args` in scope) once, on the first git
 * call made while the sync lock is held; every call is then forwarded to the real git. */
function lockRaceGit(f, name, body) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.temp, name); mkdirSync(bin);
  const evidence = join(f.temp, `${name}-ran`);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
const sh = (cwd, ...a) => { const r = spawnSync(realGit, a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
if (existsSync(${JSON.stringify(`${f.clone}.guard-lock`)}) && !existsSync(${JSON.stringify(evidence)})) {
  writeFileSync(${JSON.stringify(evidence)}, 'ran');
  ${body}
}
process.exit(spawnSync(realGit, args, {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
  f.env.PATH = bin + ':' + f.env.PATH;
  return evidence;
}
/** A `git` shim that replaces the stdout of any call whose argv includes `flag`. */
function fakeOutputGit(f, name, flag, output) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(f.temp, name); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.argv.includes(${JSON.stringify(flag)})) { process.stdout.write(${output}, () => process.exit(0)); return; }
process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
  f.env.PATH = bin + ':' + f.env.PATH;
}
describe('dedicated guard clone synchronization (temporary local origins only)',()=>{
  it('rechecks read-only permissions inside the lock after preparation', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.temp, 'race-git'); mkdirSync(bin);
    const evidence = join(f.temp, 'made-writable');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { existsSync, chmodSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (existsSync(${JSON.stringify(`${f.clone}.guard-lock`)}) && !existsSync(${JSON.stringify(evidence)})) {
  chmodSync(${JSON.stringify(join(f.clone, 'guard'))}, 0o644);
  writeFileSync(${JSON.stringify(evidence)}, 'changed after preparation');
}
process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(evidence)).toBe(true);
    expect(statSync(join(f.clone, 'guard')).mode & 0o222).toBe(0);
  });
  it.each([
    ['core.trustctime', 'false'], ['core.checkStat', 'minimal'],
    ['core.fsmonitor', 'true'], ['core.untrackedCache', 'true'],
    ['core.ignoreStat', 'true'], ['core.assumeUnchanged', 'true'],
  ])('repairs stat-cache tampering and hardens %s=%s before verification', (key, value) => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.git(f.clone, 'config', '--local', key, value);
    const file = forgeStatCache(f);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.temp, 'cached-stat-git'); mkdirSync(bin);
    const evidence = join(f.temp, 'reset-index');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const indexPath = ${JSON.stringify(join(f.clone, '.git/index'))};
if (args.includes('reset')) {
  writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ cached: existsSync(indexPath) }));
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('using whole-tree repair');
    expect(readFileSync(file, 'utf8')).toBe('first');
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual({ cached: false });
    expect(f.git(f.clone, 'config', '--local', '--get', 'core.trustctime')).toBe('true');
    if (key !== 'core.trustctime') {
      expect(spawnSync('git', ['config', '--local', '--get', key], { cwd: f.clone, env: f.env }).status).toBe(1);
    }
    expect(statSync(file).mode & 0o222).toBe(0);
  });
  it('refuses a failed whole-tree reset and repairs the missing index on retry', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.git(f.clone, 'config', '--local', 'core.trustctime', 'false');
    const file = join(f.clone, 'guard');
    chmodSync(file, 0o644); writeFileSync(file, 'rogue'); chmodSync(file, 0o444);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.temp, 'failed-reset-git'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.argv.includes('reset')) process.exit(128);
process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    const originalPath = f.env.PATH;
    f.env.PATH = bin + ':' + originalPath;
    const failed = f.run();
    expect(failed.status).toBe(2);
    expect(failed.stdout).not.toContain('synchronized');
    expect(existsSync(join(f.clone, '.git/index'))).toBe(false);
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
    f.env.PATH = originalPath;
    const retried = f.run(); expect(retried.status, retried.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('first');
    expect(statSync(file).mode & 0o222).toBe(0);
  });
  it.each(['failed', 'incomplete', 'oversized'])('fails closed when stat-check configuration cannot be read: %s', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.temp, 'unreadable-config-git'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('config') && (args.includes('--list') || args.slice(args.indexOf('config') + 1).some(arg => /^core\\./i.test(arg)))) {
  if (${JSON.stringify(kind)} === 'failed') process.exit(128);
  process.stdout.write(${JSON.stringify(kind)} === 'oversized' ? 'x'.repeat(2 * 1024 * 1024) : 'core.trustctime\\nfalse');
  process.exit(0);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('synchronized');
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it('preserves every unchanged file ctime when one file changes', () => {
    const f = fixture();
    mkdirSync(join(f.origin, 'nested'));
    for (const name of ['unchanged', 'nested/stable', 'odd \n name ']) writeFileSync(join(f.origin, name), 'stable');
    f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'stable files');
    expect(f.run().status).toBe(0);
    const names = ['unchanged', 'nested/stable', 'odd \n name '];
    const before = names.map(name => statSync(join(f.clone, name)).ctimeMs);
    writeFileSync(join(f.origin, 'guard'), 'second');
    f.git(f.origin, 'commit', '-am', 'one change');
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(names.map(name => statSync(join(f.clone, name)).ctimeMs)).toEqual(before);
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('second');
  });
  it('leaves all file ctimes unchanged on no-change sync and refreshes FETCH_HEAD', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const before = statSync(join(f.clone, 'guard')).ctimeMs;
    const fetchHead = join(f.clone, '.git/FETCH_HEAD');
    utimesSync(fetchHead, new Date(0), new Date(0));
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(statSync(join(f.clone, 'guard')).ctimeMs).toBe(before);
    expect(statSync(fetchHead).mtimeMs).toBeGreaterThan(Date.now() - 5000);
  });
  it('excludes a slow fetch from the lock and reports opt-in timing', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.temp, 'slow-git'); mkdirSync(bin);
    const evidence = join(f.temp, 'fetch-lock');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('fetch')) {
  writeFileSync(${JSON.stringify(evidence)}, String(existsSync(${JSON.stringify(`${f.clone}.guard-lock`)})));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
}
process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    f.env.WE_GUARD_SYNC_TIMING = '1';
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(evidence, 'utf8')).toBe('false');
    const match = /guard-sync-timing lock_hold_ms=(\d+) fetch_ms=(\d+) total_ms=(\d+)/.exec(result.stderr);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeLessThan(Number(match[2]) / 2);
    expect(Number(match[3])).toBeGreaterThanOrEqual(Number(match[2]));
  });
  it('repairs dirty and ignored files even when incoming equals HEAD', () => {
    const f = fixture(); expect(f.run().status).toBe(0); f.writable();
    writeFileSync(join(f.clone, 'guard'), 'dirty');
    writeFileSync(join(f.clone, '.git/info/exclude'), 'ignored\n');
    writeFileSync(join(f.clone, 'ignored'), 'planted');
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('first');
    expect(existsSync(join(f.clone, 'ignored'))).toBe(false);
    expect(statSync(join(f.clone, 'guard')).mode & 0o222).toBe(0);
  });
  it.each(['failed', 'incomplete', 'oversized', 'selective reset'])('falls back to whole-tree repair for %s diff evidence', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    writeFileSync(join(f.origin, 'guard'), 'second');
    f.git(f.origin, 'commit', '-am', 'advance');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(f.temp, 'uncertain-git'); mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const kind = ${JSON.stringify(kind)};
const marker = ${JSON.stringify(join(f.temp, 'reset-failed'))};
if (kind === 'selective reset' && process.argv.includes('reset') && !existsSync(marker)) {
  writeFileSync(marker, 'failed after selective chmod'); process.exit(1);
}
if (kind !== 'selective reset' && process.argv.includes('--name-only')) {
  if (kind === 'failed') process.exit(1);
  process.stdout.write(kind === 'oversized' ? 'x'.repeat(2 * 1024 * 1024) : 'guard');
} else process.exit(spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 2);
`, { mode: 0o755 });
    f.env.PATH = bin + ':' + f.env.PATH;
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('using whole-tree repair');
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('second');
    expect(statSync(join(f.clone, 'guard')).mode & 0o222).toBe(0);
    expect(f.git(f.clone, 'status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'HEAD'));
  });
  it('protects additions, deletions, renames and file-directory transitions with unusual names', () => {
    const f = fixture();
    mkdirSync(join(f.origin, 'to-file'));
    writeFileSync(join(f.origin, 'to-file/child'), 'child');
    writeFileSync(join(f.origin, 'to-dir'), 'file');
    writeFileSync(join(f.origin, 'stable'), 'stable');
    f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'before transitions');
    expect(f.run().status).toBe(0);
    const before = statSync(join(f.clone, 'stable')).ctimeMs;
    rmSync(join(f.origin, 'to-file'), { recursive: true });
    writeFileSync(join(f.origin, 'to-file'), 'now a file');
    rmSync(join(f.origin, 'to-dir'));
    mkdirSync(join(f.origin, 'to-dir'));
    const odd = 'to-dir/odd \n name ';
    writeFileSync(join(f.origin, odd), 'new');
    f.git(f.origin, 'mv', 'guard', 'renamed');
    f.git(f.origin, 'add', '-A'); f.git(f.origin, 'commit', '-qm', 'transitions');
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('whole-tree repair');
    expect(statSync(join(f.clone, 'stable')).ctimeMs).toBe(before);
    for (const name of ['to-file', 'to-dir', odd, 'renamed']) expect(statSync(join(f.clone, name)).mode & 0o222).toBe(0);
    expect(existsSync(join(f.clone, 'guard'))).toBe(false);
    expect(f.git(f.clone, 'status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
  });
  it('refuses hidden index entries instead of accepting an unchanged revision as pristine', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.git(f.clone, 'update-index', '--assume-unchanged', 'guard');
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not pristine');
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it('syncs when the tracked-file listing is larger than the 1 MiB default command buffer', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    // ~1.2 MB of ordinary entries, as a repository of about 20k tracked files would print.
    fakeOutputGit(f, 'large-index-git', 'ls-files', "'H x\\0'.repeat(300000)");
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('synchronized');
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it('refuses with a clear message, never a truncated listing, past the tracked-file listing bound', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.env.WE_GUARD_LISTING_MAX_BYTES = '4'; // the bound can only be shortened, for tests
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('tracked-file listing is larger than 4 bytes');
    expect(result.stdout).not.toContain('synchronized');
    // The refusal happens before any repair step, so the guard tree is still read-only.
    expect(statSync(join(f.clone, 'guard')).mode & 0o222).toBe(0);
    expect(statSync(f.clone).mode & 0o222).toBe(0);
    expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
  });
  it('ignores a plan made stale when another sync advances the incoming ref before the lock is taken', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    writeFileSync(join(f.origin, 'guard'), 'a'); f.git(f.origin, 'commit', '-qam', 'prepared against this');
    const evidence = lockRaceGit(f, 'incoming-race-git', `
      require('node:fs').writeFileSync(${JSON.stringify(join(f.origin, 'other'))}, 'b');
      sh(${JSON.stringify(f.origin)}, 'add', 'other'); sh(${JSON.stringify(f.origin)}, 'commit', '-qm', 'concurrent');
      sh(${JSON.stringify(f.clone)}, 'fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', '+refs/heads/main:refs/we-guard/incoming');`);
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(evidence)).toBe(true);
    expect(readFileSync(join(f.clone, 'other'), 'utf8')).toBe('b');
    // 'other' is absent from the stale plan: only a discarded plan leaves it read-only.
    expect(statSync(join(f.clone, 'other')).mode & 0o222).toBe(0);
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'HEAD'));
  });
  it('ignores a plan made stale when another sync moves HEAD before the lock is taken', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    writeFileSync(join(f.origin, 'guard'), 'second'); f.git(f.origin, 'commit', '-qam', 'middle');
    writeFileSync(join(f.origin, 'guard'), 'first'); f.git(f.origin, 'commit', '-qam', 'back to the original tree');
    // Prepared against base..incoming (no paths); the lock holder-to-be's rival leaves HEAD at "middle".
    const evidence = lockRaceGit(f, 'head-race-git', `
      const fs = require('node:fs'); const path = require('node:path');
      sh(${JSON.stringify(f.clone)}, 'fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', '+refs/heads/main:refs/we-guard/tmp');
      const middle = sh(${JSON.stringify(f.clone)}, 'rev-parse', 'refs/we-guard/tmp~1');
      spawnSync('chmod', ['-R', 'u+w', ${JSON.stringify(f.clone)}]);
      sh(${JSON.stringify(f.clone)}, 'reset', '--hard', middle);
      sh(${JSON.stringify(f.clone)}, 'update-ref', '-d', 'refs/we-guard/tmp');
      for (const name of fs.readdirSync(${JSON.stringify(f.clone)})) if (name !== '.git') spawnSync('chmod', ['-R', 'a-w', path.join(${JSON.stringify(f.clone)}, name)]);
      fs.chmodSync(${JSON.stringify(f.clone)}, fs.statSync(${JSON.stringify(f.clone)}).mode & ~0o222);`);
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(existsSync(evidence)).toBe(true);
    expect(result.stderr).not.toContain('selective repair uncertain');
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('first');
    expect(statSync(join(f.clone, 'guard')).mode & 0o222).toBe(0);
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'HEAD'));
  });
  it.each([
    ['a replacement character', "'guard\\ufffd\\0'"],
    ['a dot-dot path part', "'a/../guard\\0'"],
    ['a single-dot path part', "'./guard\\0'"],
    ['a .git path part', "'.git/config\\0'"],
    ['a differently-cased .GIT path part', "'.GIT/config\\0'"],
    ['an empty path part', "'a//guard\\0'"],
    ['an empty name', "'\\0'"],
    ['an unterminated name (no NUL framing)', "'guard'"],
  ])('falls back to whole-tree repair for ambiguous diff evidence: %s', (_kind, output) => {
    const f = fixture(); expect(f.run().status).toBe(0);
    writeFileSync(join(f.origin, 'guard'), 'second'); f.git(f.origin, 'commit', '-qam', 'advance');
    fakeOutputGit(f, 'ambiguous-diff-git', '--name-only', output);
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('preparation uncertain; using whole-tree repair');
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('second');
    expect(statSync(join(f.clone, 'guard')).mode & 0o222).toBe(0);
    expect(f.git(f.clone, 'status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('');
  });
  it('never chmods through a directory that became a symlink: falls back to whole-tree repair', () => {
    const f = fixture();
    mkdirSync(join(f.origin, 'd')); writeFileSync(join(f.origin, 'd/f'), 'inside');
    f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'directory');
    expect(f.run().status).toBe(0);
    const external = join(f.temp, 'external'); mkdirSync(external);
    writeFileSync(join(external, 'f'), 'outside'); chmodSync(join(external, 'f'), 0o644);
    rmSync(join(f.origin, 'd'), { recursive: true }); symlinkSync(external, join(f.origin, 'd'));
    f.git(f.origin, 'add', '-A'); f.git(f.origin, 'commit', '-qm', 'directory becomes a symlink');
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('selective repair uncertain');
    expect(lstatSync(join(f.clone, 'd')).isSymbolicLink()).toBe(true);
    expect(statSync(join(external, 'f')).mode & 0o777).toBe(0o644);
  });
  it('overrides inherited stat-weakening configuration after removing local values', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const home = join(f.temp, 'home'); mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tignoreStat = true\n\tcheckStat = minimal\n');
    f.env.HOME = home;
    f.git(f.clone, 'config', '--local', 'core.ignoreStat', 'true');
    const file = join(f.clone, 'guard');
    chmodSync(file, 0o644); writeFileSync(file, 'rogue'); chmodSync(file, 0o444);
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('weakened stat checks');
    expect(readFileSync(file, 'utf8')).toBe('first');
    const effective = key => spawnSync('git', ['config', '--get', key], {
      cwd: f.clone, encoding: 'utf8',
      env: Object.fromEntries(Object.entries(f.env).filter(([name]) => !name.startsWith('GIT_'))),
    }).stdout.trim();
    expect(effective('core.ignorestat')).toBe('false');
    expect(effective('core.checkstat')).toBe('default');
    expect(effective('core.trustctime')).toBe('true');
  });
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
    writeFileSync(held, kind === 'live sync lock' ? `${process.pid} 0 other\n` : '');
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
    if (kind === 'live guard lease') expect(existsSync(`${f.clone}.guard-lock`)).toBe(false);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.filter(arg => ['reset', 'clean', 'clone', 'update-ref'].includes(arg)), args.join(' ')).toEqual([]);
      // A live sync is refused before any fetch; behind a live lease only the private ref is fetched.
      if (args.includes('fetch')) {
        expect(kind, args.join(' ')).toBe('live guard lease');
        expect(args).toEqual(expect.arrayContaining(['--refmap=', '--no-write-fetch-head', '+refs/heads/main:refs/we-guard/incoming']));
      }
    }
  });
  it.each(['dead owner', 'no owner record', 'reused pid'])('reclaims a sync lock left by a %s and prunes dead guard leases', kind => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const lock = `${f.clone}.guard-lock`;
    if (kind === 'no owner record') mkdirSync(lock);
    else writeFileSync(lock, kind === 'dead owner' ? `${deadPid()} 0 crashed\n` : `${process.pid} 1000 reused\n`);
    const readers = `${f.clone}.guard-readers`;
    const dead = join(readers, `${deadPid()}-dead`);
    const reused = join(readers, `${process.pid}-beef`);
    writeFileSync(dead, ''); writeFileSync(reused, '1000');
    writeFileSync(join(readers, '.DS_Store'), 'not a lease');
    const debris = join(dirname(f.clone), `${basename(lock)}.new-${deadPid()}-abc`);
    writeFileSync(debris, 'crashed publish');
    writeFileSync(join(f.origin, 'guard'), 'second'); f.git(f.origin, 'add', '.'); f.git(f.origin, 'commit', '-qm', 'second');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.clone, 'guard'), 'utf8')).toBe('second');
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(reused)).toBe(false);
    expect(readdirSync(readers)).toEqual(['.DS_Store']);
    expect(readdirSync(dirname(f.clone)).filter(name => name.includes('.guard-lock'))).toEqual([]);
  });
  it.each([
    ['unset', undefined], ['oversized', '600000'], ['huge', '1e9'], ['invalid', 'soon'], ['negative', '-5'],
  ])('caps sync wait overrides at 20 seconds: %s', async (_kind, value) => {
    const f = fixture(); expect(f.run().status).toBe(0);
    if (value === undefined) delete f.env.WE_GUARD_LOCK_WAIT_MS; else f.env.WE_GUARD_LOCK_WAIT_MS = value;
    const lease = join(`${f.clone}.guard-readers`, `${process.pid}-feed`);
    writeFileSync(lease, '');
    const child = spawn(process.execPath, [script], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stderr = '';
    await new Promise((resolveWait, reject) => {
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.includes('guard hook(s) to finish')) resolveWait(); });
      closed.then(([code]) => reject(new Error(`sync exited (${code}) before waiting: ${stderr}`)));
    });
    expect(stderr).toContain('waiting up to 20000ms for 1 guard hook(s)');
    rmSync(lease);
    expect((await closed)[0], stderr).toBe(0);
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
    // A live pid whose recorded start real ps would call a reuse: unknown evidence keeps it live.
    const lease = join(`${f.clone}.guard-readers`, `${process.pid}-beef`);
    writeFileSync(lease, '1000');
    expect(f.run()).toMatchObject({ status: 2, stderr: expect.stringContaining('guard hook(s) still running') });
    expect(existsSync(lease)).toBe(true);
    rmSync(lease);
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
