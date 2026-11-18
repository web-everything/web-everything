import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { pinnedFixture } from './pinned-fixture.mjs';

const fixtures = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    execFileSync('chmod', ['-R', 'u+w', f.temp]);
    f.cleanup();
  }
});
function fixture(options) {
  const f = pinnedFixture(options); fixtures.push(f);
  f.env.WE_GUARD_LOCK_WAIT_MS = '0';
  return f;
}
function snapshot(f, path = `${f.clone}.guard-good`) {
  // Model sync's verified tree, including any probe the test just added.
  f.git(f.clone, 'add', '-A');
  f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'snapshot fixture');
  f.git(f.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(path);
  for (const name of readdirSync(f.clone)) if (name !== '.git') {
    cpSync(join(f.clone, name), join(path, name), { recursive: true });
  }
  writeFileSync(join(path, '.guard-good.json'), JSON.stringify({ sha: f.git(f.clone, 'rev-parse', 'HEAD'), syncedAt: Date.now() }));
  return path;
}
function lock(f) { writeFileSync(`${f.clone}.guard-lock`, `${process.pid}\n`); }

describe('last-good pinned guard snapshot', () => {
  it('refuses a committed dependency symlink outside the snapshot without executing its external module', () => {
    const f = fixture({ launcherOnly: true });
    const external = join(f.temp, 'external-dependency.mjs');
    const executed = join(f.temp, 'external-executed');
    writeFileSync(external, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'executed');`);
    symlinkSync(external, join(f.clone, 'scripts/dependency.mjs'));
    writeFileSync(join(f.clone, 'scripts/probe.mjs'), 'import "./dependency.mjs"; console.log("guard ran");');
    const good = snapshot(f); lock(f);
    expect(f.git(f.clone, 'ls-files', '-s', 'scripts/dependency.mjs')).toMatch(/^120000 /);
    expect(lstatSync(join(good, 'scripts/dependency.mjs')).isSymbolicLink()).toBe(true);
    const result = f.run(f.lane, 'scripts/probe.mjs', {});
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('guard clone sync is in progress; retry the hook');
    expect(result.stdout).toBe('');
    expect(existsSync(executed)).toBe(false);
  });
  it('warns and retains the old snapshot when publication cannot drain a live reader within its bound', () => {
    const f = fixture({ launcherOnly: true });
    const good = snapshot(f);
    const previous = readFileSync(join(good, '.guard-good.json'), 'utf8');
    f.git(f.clone, 'config', 'we.guardClone', f.clone);
    f.env.WE_GUARD_CLONE = f.clone;
    const readers = `${f.clone}.guard-snapshot-readers`;
    mkdirSync(readers);
    writeFileSync(join(readers, `${process.pid}-abcdef`), '');
    const result = spawnSync(process.execPath, [resolve('scripts/hooks/sync-guard-clone.mjs'), `--origin=${f.primary}`], { cwd: f.lane, env: f.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('last-good snapshot publication warning');
    expect(readFileSync(join(good, '.guard-good.json'), 'utf8')).toBe(previous);
    expect(existsSync(`${f.clone}.guard-snapshot-lock`)).toBe(false);
  });
  it.each(['guard', 'imported dependency', 'extra file', 'fabricated revision', 'unpublished revision', 'origin mismatch'])('rejects a snapshot with %s tampering', kind => {
    const f = fixture({ launcherOnly: true });
    writeFileSync(join(f.clone, 'scripts/dependency.mjs'), 'export const value = "trusted";');
    writeFileSync(join(f.clone, 'scripts/probe.mjs'), 'import {value} from "./dependency.mjs"; console.log(value);');
    const good = snapshot(f); lock(f);
    if (kind === 'guard') writeFileSync(join(good, 'scripts/probe.mjs'), 'console.log("altered");');
    if (kind === 'imported dependency') writeFileSync(join(good, 'scripts/dependency.mjs'), 'export const value = "altered";');
    if (kind === 'extra file') writeFileSync(join(good, 'scripts/extra.mjs'), 'console.log("planted");');
    if (kind === 'fabricated revision') writeFileSync(join(good, '.guard-good.json'), JSON.stringify({ sha: 'f'.repeat(40), syncedAt: Date.now() }));
    if (kind === 'unpublished revision') {
      writeFileSync(join(f.clone, 'scripts/probe.mjs'), 'console.log("unpublished");');
      f.git(f.clone, 'add', 'scripts');
      f.git(f.clone, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'unpublished guard');
      cpSync(join(f.clone, 'scripts/probe.mjs'), join(good, 'scripts/probe.mjs'));
      writeFileSync(join(good, '.guard-good.json'), JSON.stringify({ sha: f.git(f.clone, 'rev-parse', 'HEAD'), syncedAt: Date.now() }));
    }
    if (kind === 'origin mismatch') f.env.WE_GUARD_ORIGIN = 'unexpected-origin';
    const result = f.run(f.lane, 'scripts/probe.mjs', {});
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('guard clone sync is in progress; retry the hook');
  });
  it('allows a verified snapshot with the expected origin', () => {
    const f = fixture({ launcherOnly: true });
    writeFileSync(join(f.clone, 'scripts/probe.mjs'), 'console.log("trusted");');
    snapshot(f); lock(f);
    f.env.WE_GUARD_ORIGIN = f.primary;
    const result = f.run(f.lane, 'scripts/probe.mjs', {});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('trusted\n');
  });
  it('keeps a paused snapshot reader on its original revision through publication and delayed imports', async () => {
    const f = fixture({ launcherOnly: true });
    writeFileSync(join(f.primary, 'scripts/dependency.mjs'), 'export const value = "original";');
    writeFileSync(join(f.primary, 'scripts/pause.mjs'), `import {once} from 'node:events';
console.log('ready'); await once(process.stdin,'data');
const {value}=await import('./dependency.mjs'); console.log(value);`);
    f.git(f.primary, 'add', 'scripts'); f.git(f.primary, 'commit', '-qm', 'reader fixture');
    f.git(f.clone, 'config', 'we.guardClone', f.clone);
    const syncEnv = { ...f.env, WE_GUARD_CLONE: f.clone, WE_GUARD_LOCK_WAIT_MS: '5000' };
    const syncArgs = [resolve('scripts/hooks/sync-guard-clone.mjs'), `--origin=${f.primary}`];
    const initial = spawnSync(process.execPath, syncArgs, { cwd: f.lane, env: syncEnv, encoding: 'utf8' });
    expect(initial.status, initial.stderr).toBe(0);
    lock(f);
    const reader = spawn(process.execPath, [join(f.clone, 'scripts/hooks/run-pinned-guard.mjs'), 'scripts/pause.mjs'], { cwd: f.lane, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const readerClosed = once(reader, 'close');
    let output = '', errors = '';
    reader.stdout.on('data', chunk => { output += chunk; });
    reader.stderr.on('data', chunk => { errors += chunk; });
    let writer;
    let writerClosed;
    try {
      await Promise.race([once(reader.stdout, 'data'), readerClosed.then(() => { throw new Error(`reader exited first: ${errors}`); })]);
      expect(output).toBe('ready\n');
      rmSync(`${f.clone}.guard-lock`);
      writeFileSync(join(f.primary, 'scripts/dependency.mjs'), 'export const value = "replacement";');
      f.git(f.primary, 'add', 'scripts'); f.git(f.primary, 'commit', '-qm', 'replacement');
      writer = spawn(process.execPath, syncArgs, { cwd: f.lane, env: syncEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      writerClosed = once(writer, 'close');
      let syncErrors = '';
      const waiting = new Promise(resolve => writer.stderr.on('data', chunk => {
        syncErrors += chunk;
        if (syncErrors.includes('waiting up to 5000ms')) resolve();
      }));
      await Promise.race([waiting, writerClosed.then(() => { throw new Error(`sync exited before waiting: ${syncErrors}`); })]);
      reader.stdin.end('continue');
      expect((await readerClosed)[0], errors).toBe(0);
      expect(output).toBe('ready\noriginal\n');
      expect((await writerClosed)[0], syncErrors).toBe(0);
      expect(syncErrors).not.toContain('publication warning');
      expect(readFileSync(join(`${f.clone}.guard-good`, 'scripts/dependency.mjs'), 'utf8')).toContain('replacement');
      expect(readdirSync(`${f.clone}.guard-snapshot-readers`)).toEqual([]);
    } finally {
      if (reader.exitCode === null) reader.kill();
      if (writer?.exitCode === null) writer.kill();
      await readerClosed;
      if (writerClosed) await writerClosed;
    }
  }, 30_000);
  it('runs the snapshot immediately under a live lock, preserving entry, root, args and child status', () => {
    const f = fixture({ launcherOnly: true });
    writeFileSync(join(f.clone, 'scripts/probe.mjs'), `console.log(JSON.stringify({entry:process.argv[1],root:process.env.WE_HOOK_ROOT,args:process.argv.slice(2)})); process.exitCode=7;`);
    const good = snapshot(f); lock(f);
    rmSync(join(f.clone, 'scripts/probe.mjs'));
    const result = f.run(f.lane, 'scripts/probe.mjs', {}, ['space argument']);
    expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ entry: join(good, 'scripts/probe.mjs'), root: f.lane, args: ['space argument'] });
    expect(result.stderr).toContain(`last-good snapshot ${f.git(f.clone, 'rev-parse', 'HEAD')}`);
    expect(result.stderr).not.toContain('waiting');
    expect(readdirSync(`${f.clone}.guard-readers`)).toEqual([]);
  });
  it('keeps the real guard allow and deny decisions under a live sync lock', () => {
    const f = fixture(); snapshot(f); lock(f);
    expect(f.run(f.lane, 'scripts/guard-lane.mjs', { tool_name: 'Bash', tool_input: { command: 'echo hello' } }).status).toBe(0);
    const denied = f.run(f.lane, 'scripts/guard-lane.mjs', {
      tool_name: 'Write', cwd: f.lane, tool_input: { file_path: join(f.primary, 'scripts/example.mjs'), content: '' },
    });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain('guard-lane:');
    expect(denied.stderr).toContain('last-good snapshot');
  });
  it.each(['absent', 'no marker', 'tmp only', 'old only', 'stale', 'future', 'bad json', 'bad sha', 'symlink', 'escaping script', 'directory script'])('denies with the existing sync message for %s evidence', kind => {
    const f = fixture({ launcherOnly: true });
    writeFileSync(join(f.clone, 'scripts/probe.mjs'), 'console.log("MUST NOT RUN");');
    const good = `${f.clone}.guard-good`;
    if (kind !== 'absent') {
      const path = snapshot(f, kind === 'tmp only' ? `${good}.tmp-test` : kind === 'old only' ? `${good}.old-test` : good);
      if (kind === 'no marker') rmSync(join(path, '.guard-good.json'));
      if (['stale', 'future', 'bad sha'].includes(kind)) writeFileSync(join(path, '.guard-good.json'), JSON.stringify({
        sha: kind === 'bad sha' ? 'invalid' : 'a'.repeat(40),
        syncedAt: Date.now() + (kind === 'future' ? 60_000 : kind === 'stale' ? -86_400_001 : 0),
      }));
      if (kind === 'bad json') writeFileSync(join(path, '.guard-good.json'), '{');
      if (kind === 'symlink') { rmSync(path, { recursive: true }); symlinkSync(snapshot(f, `${good}.tmp-link`), path); }
      if (kind === 'escaping script') { rmSync(join(path, 'scripts/probe.mjs')); symlinkSync(join(f.clone, 'scripts/probe.mjs'), join(path, 'scripts/probe.mjs')); }
      if (kind === 'directory script') { rmSync(join(path, 'scripts/probe.mjs')); mkdirSync(join(path, 'scripts/probe.mjs')); }
    }
    lock(f);
    for (const args of [[], ['--stop-hook']]) {
      const result = spawnSync(process.execPath, [join(f.clone, 'scripts/hooks/run-pinned-guard.mjs'), ...args, 'scripts/probe.mjs'], { cwd: f.lane, env: f.env, encoding: 'utf8' });
      expect(result.status).toBe(args.length ? 1 : 2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('guard clone sync is in progress; retry the hook');
    }
  });
  it('publishes complete snapshots after verification, replaces on re-sync and removes stale debris', () => {
    const f = fixture({ launcherOnly: true });
    const good = `${f.clone}.guard-good`;
    f.git(f.clone, 'config', 'we.guardClone', f.clone);
    f.env.WE_GUARD_CLONE = f.clone;
    const bin = join(f.temp, 'bin'); mkdirSync(bin);
    const realCp = execFileSync('which', ['cp'], { encoding: 'utf8' }).trim();
    const evidence = join(f.temp, 'copy-evidence.jsonl');
    writeFileSync(join(bin, 'cp'), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2), dest=args.at(-1), stage=require('node:path').dirname(dest);
fs.appendFileSync(${JSON.stringify(evidence)},JSON.stringify({stage,marker:fs.existsSync(stage+'/.guard-good.json'),lock:fs.existsSync(${JSON.stringify(`${f.clone}.guard-lock`)}),old:fs.existsSync(${JSON.stringify(good)})})+'\\n');
process.exit(cp.spawnSync(${JSON.stringify(realCp)},args,{stdio:'inherit'}).status??2);
`, { mode: 0o755 });
    f.env.PATH = `${bin}:${f.env.PATH}`;
    const run = () => spawnSync(process.execPath, [resolve('scripts/hooks/sync-guard-clone.mjs'), `--origin=${f.primary}`], { cwd: f.lane, env: f.env, encoding: 'utf8', timeout: 30_000 });
    let result = run(); expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(good).isDirectory()).toBe(true);
    expect(existsSync(join(good, '.git'))).toBe(false);
    const first = JSON.parse(readFileSync(join(good, '.guard-good.json')));
    expect(first.sha).toBe(f.git(f.clone, 'rev-parse', 'HEAD'));
    expect(first.syncedAt).toBeGreaterThan(Date.now() - 30_000);
    for (const name of readdirSync(f.clone).filter(name => name !== '.git')) expect(existsSync(join(good, name))).toBe(true);
    writeFileSync(join(f.primary, 'new-file'), 'second');
    f.git(f.primary, 'add', '.'); f.git(f.primary, 'commit', '-qm', 'second');
    for (const suffix of ['tmp-stale', 'old-stale']) mkdirSync(`${good}.${suffix}`);
    result = run(); expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(good, 'new-file'), 'utf8')).toBe('second');
    expect(JSON.parse(readFileSync(join(good, '.guard-good.json'))).sha).not.toBe(first.sha);
    expect(readdirSync(dirname(good)).filter(name => name.startsWith('.guard-main.guard-good.'))).toEqual([]);
    const copies = readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) { expect(copy.stage).toContain('.guard-good.tmp-'); expect(copy.marker).toBe(false); expect(copy.lock).toBe(true); }
    expect(copies.some(copy => copy.old)).toBe(true);
  }, 30_000);
});
