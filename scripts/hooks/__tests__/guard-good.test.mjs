import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
  mkdirSync(path);
  for (const name of readdirSync(f.clone)) if (name !== '.git') {
    cpSync(join(f.clone, name), join(path, name), { recursive: true });
  }
  writeFileSync(join(path, '.guard-good.json'), JSON.stringify({ sha: f.git(f.clone, 'rev-parse', 'HEAD'), syncedAt: Date.now() }));
  return path;
}
function lock(f) { writeFileSync(`${f.clone}.guard-lock`, `${process.pid}\n`); }

describe('last-good pinned guard snapshot', () => {
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
