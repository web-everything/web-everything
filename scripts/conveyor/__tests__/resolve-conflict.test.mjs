/** Real index-stage fixtures: prove the sanctioned path resolves and stages without checkout. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, planResolution, isLaneClonePath, resolveConflicts } from '../resolve-conflict.mjs';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resolve-conflict.mjs');
const temps = [];
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
/**
 * `sub` puts the conflicted file at `sub/file` (for the symlink-parent case); `oursExec` / `theirsExec` give that
 * side's version the executable bit, so the two conflicting stages differ in mode (100644 vs 100755).
 */
function fixture({ lane = true, merge = true, sub = false, oursExec = false, theirsExec = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'resolve-conflict-')); temps.push(root);
  const dir = join(root, lane ? '.lanes/web-everything/lane-1' : 'ordinary'); mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const rel = sub ? 'sub/file' : 'file';
  const commit = (exec) => { if (exec) chmodSync(join(dir, rel), 0o755); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'); };
  if (sub) mkdirSync(join(dir, 'sub'));
  git('init', '-q', '-b', 'main'); writeFileSync(join(dir, rel), 'base\n'); writeFileSync(join(dir, 'clean'), 'clean\n'); commit();
  git('switch', '-qc', 'other'); writeFileSync(join(dir, rel), 'theirs\n'); commit(theirsExec);
  git('switch', '-q', 'main'); writeFileSync(join(dir, rel), 'ours\n'); commit(oursExec);
  if (merge) { try { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'other'); } catch {} }
  return { dir, git, logPath: join(root, 'log.jsonl'), root };
}
it.each(['ours', 'theirs', 'union'])('resolves %s and records the run', (take) => {
  const f = fixture(); const result = resolveConflicts({ dir: f.dir, files: ['file'], take }, { logPath: f.logPath, cwd: f.dir });
  expect(result.ok).toBe(true); expect(f.git('ls-files', '-u')).toBe('');
  expect(readFileSync(join(f.dir, 'file'), 'utf8')).toBe(take === 'union' ? 'ours\ntheirs\n' : `${take}\n`);
  expect(f.git('show', ':0:file')).toBe(readFileSync(join(f.dir, 'file'), 'utf8'));
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).ok).toBe(true);
});
it.each([{ lane: false }, { merge: false }, { file: 'clean' }, { file: '../escape' }])('refuses before mutation: %j', (options) => {
  const f = fixture(options); const before = f.git('status', '--porcelain');
  expect(resolveConflicts({ dir: f.dir, files: [options.file ?? 'file'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(false);
  expect(f.git('status', '--porcelain')).toBe(before);
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).ok).toBe(false);
});
it('parses repeated files and plans deleted stages', () => {
  expect(parseArgs(['--file=a,b', '--file=c', '--take=ours']).files).toEqual(['a', 'b', 'c']);
  expect(planResolution({ take: 'theirs', stages: { 2: Buffer.from('ours') } })).toMatchObject({ action: 'deleted', stage: 3 });
  expect(isLaneClonePath('/a/.lanes/we/lane-12')).toBe(true);
  expect(isLaneClonePath('/a/.lanes/we/lane-12/sub')).toBe(false);
});

// ── PR #3990 review: selected-side mode, symlink refusal, git-config/filter neutralisation, own-lane only ──
const stageMode = (f, path = 'file') => f.git('ls-files', '-s', '--', path).split(' ')[0];
const isExecOnDisk = (f, path = 'file') => (statSync(join(f.dir, path)).mode & 0o111) !== 0;

describe.each([
  { name: 'theirs is executable, ours is not', opts: { theirsExec: true }, expected: { ours: '100644', theirs: '100755' } },
  { name: 'ours is executable, theirs is not', opts: { oursExec: true }, expected: { ours: '100755', theirs: '100644' } },
])('preserves the selected stage mode when $name', ({ opts, expected }) => {
  it.each(['ours', 'theirs'])('take=%s stages the %s mode', (take) => {
    const f = fixture(opts);
    expect(resolveConflicts({ dir: f.dir, files: ['file'], take }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(true);
    expect(stageMode(f)).toBe(expected[take]);
    expect(isExecOnDisk(f)).toBe(expected[take] === '100755');
  });
  it('take=union stages ours’ mode (ours is the side being kept and extended)', () => {
    const f = fixture(opts);
    expect(resolveConflicts({ dir: f.dir, files: ['file'], take: 'union' }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(true);
    expect(stageMode(f)).toBe(expected.ours);
  });
});

describe('refuses to follow symlinks without touching the external target or the index', () => {
  it('a symlink LEAF', () => {
    const f = fixture(); const external = join(f.root, 'external.txt'); writeFileSync(external, 'EXTERNAL\n');
    rmSync(join(f.dir, 'file')); symlinkSync(external, join(f.dir, 'file'));
    const r = resolveConflicts({ dir: f.dir, files: ['file'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/symlink/i);
    expect(readFileSync(external, 'utf8')).toBe('EXTERNAL\n');
    expect(f.git('ls-files', '-u')).not.toBe('');
  });
  it('a symlink PARENT', () => {
    const f = fixture({ sub: true }); const externalDir = join(f.root, 'external-dir'); mkdirSync(externalDir);
    writeFileSync(join(externalDir, 'file'), 'EXTERNAL\n');
    rmSync(join(f.dir, 'sub'), { recursive: true }); symlinkSync(externalDir, join(f.dir, 'sub'));
    const r = resolveConflicts({ dir: f.dir, files: ['sub/file'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/symlink/i);
    expect(readFileSync(join(externalDir, 'file'), 'utf8')).toBe('EXTERNAL\n');
    expect(f.git('ls-files', '-u')).not.toBe('');
  });
});

describe('the pre-allowed helper never executes repo-config-chosen commands', () => {
  const trigger = (f, name) => {
    const marker = join(f.root, name);
    const script = join(f.root, `${name}.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\n`); chmodSync(script, 0o755);
    return { marker, script };
  };
  it('core.fsmonitor in .git/config', () => {
    const f = fixture(); const { marker, script } = trigger(f, 'fsmonitor-ran');
    f.git('config', 'core.fsmonitor', script);
    // Control: the poisoned config DOES fire for plain git here, so the assertion below is not vacuous.
    try { f.git('status'); } catch { /* the hook's exit status is irrelevant */ }
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(resolveConflicts({ dir: f.dir, files: ['file'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
  it('core.hooksPath hooks (post-index-change)', () => {
    const f = fixture(); const hooks = join(f.root, 'hooks'); mkdirSync(hooks);
    const marker = join(f.root, 'hook-ran');
    writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\ntouch "${marker}"\n`); chmodSync(join(hooks, 'post-index-change'), 0o755);
    f.git('config', 'core.hooksPath', hooks);
    f.git('update-index', '--add', 'clean'); f.git('update-index', '--chmod=+x', 'clean'); // control: plain git fires it
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(resolveConflicts({ dir: f.dir, files: ['file'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
  it('a clean filter wired through .gitattributes', () => {
    const f = fixture(); const { marker, script } = trigger(f, 'filter-ran');
    writeFileSync(join(f.dir, '.gitattributes'), 'file filter=evil\n');
    f.git('config', 'filter.evil.clean', script);
    // Control: plain git DOES run the clean filter for this path (hash-object leaves the conflicted index alone).
    f.git('hash-object', '--path=file', 'clean');
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    expect(resolveConflicts({ dir: f.dir, files: ['file'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(f.git('show', ':0:file')).toBe('theirs\n');
  });
});

describe('operates on the caller’s OWN lane only', () => {
  it('refuses a --dir that is not the process’s own lane (a sibling lane mid-merge)', () => {
    const mine = fixture(); const sibling = fixture(); const before = sibling.git('status', '--porcelain');
    const r = resolveConflicts({ dir: sibling.dir, files: ['file'], take: 'theirs' }, { logPath: mine.logPath, cwd: mine.dir });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/own lane|not the current/i);
    expect(sibling.git('status', '--porcelain')).toBe(before);
    expect(sibling.git('ls-files', '-u')).not.toBe('');
  });
  it('refuses when the process is not inside a git checkout at all', () => {
    const f = fixture(); const elsewhere = mkdtempSync(join(tmpdir(), 'resolve-conflict-cwd-')); temps.push(elsewhere);
    const r = resolveConflicts({ dir: f.dir, files: ['file'], take: 'theirs' }, { logPath: f.logPath, cwd: elsewhere });
    expect(r.ok).toBe(false);
  });
});

it('CLI uses the environment log override and emits one JSON line', () => {
  const f = fixture();
  const output = execFileSync(process.execPath, [SCRIPT, `--dir=${f.dir}`, '--file=file', '--take=theirs'], { cwd: f.dir, env: { ...process.env, WE_RESOLVE_CONFLICT_LOG: f.logPath } }).toString();
  expect(output.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(output)).toMatchObject({ ok: true, loggedTo: f.logPath });
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).files).toEqual([{ file: 'file', take: 'theirs', stage: 3, action: 'resolved' }]);
});

it('resolves a missing chosen stage as deletion and logs that action', () => {
  const f = fixture({ merge: false });
  f.git('rm', 'file'); f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'delete ours');
  try { f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'other'); } catch {}
  const result = resolveConflicts({ dir: f.dir, files: ['file'], take: 'ours' }, { logPath: f.logPath, cwd: f.dir });
  expect(result).toMatchObject({ ok: true, files: [{ action: 'deleted', stage: 2 }] });
  expect(f.git('ls-files', '-u')).toBe('');
  expect(() => readFileSync(join(f.dir, 'file'))).toThrow();
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).files[0].action).toBe('deleted');
});

it('preflights all files before resolving the first', () => {
  const f = fixture(); const before = f.git('status', '--porcelain');
  expect(resolveConflicts({ dir: f.dir, files: ['file', 'clean'], take: 'theirs' }, { logPath: f.logPath, cwd: f.dir }).ok).toBe(false);
  expect(f.git('status', '--porcelain')).toBe(before);
});
