/** Real index-stage fixtures: prove the sanctioned path resolves and stages without checkout. */
import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, planResolution, isLaneClonePath, resolveConflicts } from '../resolve-conflict.mjs';
const temps = [];
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture({ lane = true, merge = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'resolve-conflict-')); temps.push(root);
  const dir = join(root, lane ? '.lanes/web-everything/lane-1' : 'ordinary'); mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const commit = () => { git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'); };
  git('init', '-q', '-b', 'main'); writeFileSync(join(dir, 'file'), 'base\n'); writeFileSync(join(dir, 'clean'), 'clean\n'); commit();
  git('switch', '-qc', 'other'); writeFileSync(join(dir, 'file'), 'theirs\n'); commit();
  git('switch', '-q', 'main'); writeFileSync(join(dir, 'file'), 'ours\n'); commit();
  if (merge) { try { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'other'); } catch {} }
  return { dir, git, logPath: join(root, 'log.jsonl') };
}
it.each(['ours', 'theirs', 'union'])('resolves %s and records the run', (take) => {
  const f = fixture(); const result = resolveConflicts({ dir: f.dir, files: ['file'], take }, { logPath: f.logPath });
  expect(result.ok).toBe(true); expect(f.git('ls-files', '-u')).toBe('');
  expect(readFileSync(join(f.dir, 'file'), 'utf8')).toBe(take === 'union' ? 'ours\ntheirs\n' : `${take}\n`);
  expect(f.git('show', ':0:file')).toBe(readFileSync(join(f.dir, 'file'), 'utf8'));
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).ok).toBe(true);
});
it.each([{ lane: false }, { merge: false }, { file: 'clean' }, { file: '../escape' }])('refuses before mutation: %j', (options) => {
  const f = fixture(options); const before = f.git('status', '--porcelain');
  expect(resolveConflicts({ dir: f.dir, files: [options.file ?? 'file'], take: 'theirs' }, { logPath: f.logPath }).ok).toBe(false);
  expect(f.git('status', '--porcelain')).toBe(before);
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).ok).toBe(false);
});
it('parses repeated files and plans deleted stages', () => {
  expect(parseArgs(['--file=a,b', '--file=c', '--take=ours']).files).toEqual(['a', 'b', 'c']);
  expect(planResolution({ take: 'theirs', stages: { 2: Buffer.from('ours') } })).toMatchObject({ action: 'deleted', stage: 3 });
  expect(isLaneClonePath('/a/.lanes/we/lane-12')).toBe(true);
  expect(isLaneClonePath('/a/.lanes/we/lane-12/sub')).toBe(false);
});

it('CLI uses the environment log override and emits one JSON line', () => {
  const f = fixture();
  const output = execFileSync(process.execPath, ['scripts/conveyor/resolve-conflict.mjs', `--dir=${f.dir}`, '--file=file', '--take=theirs'], { env: { ...process.env, WE_RESOLVE_CONFLICT_LOG: f.logPath } }).toString();
  expect(output.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(output)).toMatchObject({ ok: true, loggedTo: f.logPath });
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).files).toEqual([{ file: 'file', take: 'theirs', stage: 3, action: 'resolved' }]);
});

it('resolves a missing chosen stage as deletion and logs that action', () => {
  const f = fixture({ merge: false });
  f.git('rm', 'file'); f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'delete ours');
  try { f.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'other'); } catch {}
  const result = resolveConflicts({ dir: f.dir, files: ['file'], take: 'ours' }, { logPath: f.logPath });
  expect(result).toMatchObject({ ok: true, files: [{ action: 'deleted', stage: 2 }] });
  expect(f.git('ls-files', '-u')).toBe('');
  expect(() => readFileSync(join(f.dir, 'file'))).toThrow();
  expect(JSON.parse(readFileSync(f.logPath, 'utf8')).files[0].action).toBe('deleted');
});

it('preflights all files before resolving the first', () => {
  const f = fixture(); const before = f.git('status', '--porcelain');
  expect(resolveConflicts({ dir: f.dir, files: ['file', 'clean'], take: 'theirs' }, { logPath: f.logPath }).ok).toBe(false);
  expect(f.git('status', '--porcelain')).toBe(before);
});
