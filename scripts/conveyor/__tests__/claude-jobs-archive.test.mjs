import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { archiveClaudeJobs, formatClaudeJobsArchiveLine } from '../claude-jobs-archive.mjs';

let root, jobsRoot, archiveRoot;
const now = Date.parse('2026-10-06T02:00:00Z');
const day = 86400000;
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'claude-jobs-archive-test-'));
  jobsRoot = join(root, '.claude', 'jobs'); archiveRoot = join(root, '.claude', 'jobs-archive');
  fs.mkdirSync(jobsRoot, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function entry(id, state = 'done', age = 3 * day) {
  const path = join(jobsRoot, id); fs.mkdirSync(path);
  fs.writeFileSync(join(path, 'state.json'), JSON.stringify({ state }));
  fs.utimesSync(join(path, 'state.json'), new Date(now - age), new Date(now - age));
  return path;
}
const sweep = (opts = {}) => archiveClaudeJobs({ jobsRoot, archiveRoot, now, env: {}, ...opts });

describe('Claude jobs archive', () => {
  it('moves only old terminal jobs, preserves contents and projects, counts skips and collisions', () => {
    for (const state of ['done', 'stopped', 'failed']) entry(state, state);
    entry('young', 'done', day);
    for (const state of ['working', 'blocked', 'unknown']) entry(state, state);
    entry('missing-status', null);
    fs.mkdirSync(join(jobsRoot, 'no-state'));
    fs.writeFileSync(join(entry('corrupt'), 'state.json'), '{');
    fs.writeFileSync(join(jobsRoot, 'file'), 'plain');
    const projects = join(root, '.claude', 'projects'); fs.mkdirSync(projects);
    fs.writeFileSync(join(projects, 'transcript.jsonl'), 'untouched');
    fs.symlinkSync(projects, join(jobsRoot, 'link'));
    entry('collision');
    const dest = join(archiveRoot, '2026-10-05', 'collision'); fs.mkdirSync(dest, { recursive: true });
    const log = vi.fn(); const result = sweep({ log });
    expect(result).toMatchObject({ listed: 13, eligible: 4, moved: 3, young: 1, active: 4, noState: 1, unparsable: 1, collisions: 1, errors: 0, complete: true, archiveDir: join(archiveRoot, '2026-10-05') });
    for (const state of ['done', 'stopped', 'failed']) {
      expect(fs.existsSync(join(jobsRoot, state))).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(result.archiveDir, state, 'state.json')))).toEqual({ state });
    }
    for (const id of ['young', 'working', 'blocked', 'unknown', 'missing-status', 'no-state', 'corrupt', 'collision', 'file', 'link']) expect(fs.existsSync(join(jobsRoot, id))).toBe(true);
    expect(fs.readFileSync(join(projects, 'transcript.jsonl'), 'utf8')).toBe('untouched');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(formatClaudeJobsArchiveLine(result));
  });
  it('dry runs without creating the archive, and stops at caps and time budgets', () => {
    entry('a'); entry('b');
    expect(sweep({ dryRun: true })).toMatchObject({ moved: 2, dryRun: true });
    expect(fs.existsSync(archiveRoot)).toBe(false);
    expect(sweep({ timeBudgetMs: 0 })).toMatchObject({ moved: 0, complete: false });
    expect(sweep({ maxMoves: 1 })).toMatchObject({ moved: 1, complete: false });
    expect(fs.existsSync(join(jobsRoot, 'a'))).toBe(false);
    expect(fs.existsSync(join(jobsRoot, 'b'))).toBe(true);
  });
  it('validates env overrides and config, and logs disabled runs', () => {
    entry('a', 'done', day);
    const log = vi.fn();
    expect(sweep({ env: { WE_CLAUDE_JOBS_ARCHIVE: '0' }, log })).toMatchObject({ disabled: true, moved: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(sweep({ dryRun: true, env: { WE_CLAUDE_JOBS_ARCHIVE_AGE_DAYS: '1' } }).moved).toBe(1);
    expect(sweep({ olderThanMs: 0, env: { WE_CLAUDE_JOBS_ARCHIVE_MAX_PER_RUN: '0' } })).toMatchObject({ moved: 0, complete: false });
    for (const value of ['bad', 'NaN', 'Infinity', '-1', '']) {
      expect(sweep({ env: { WE_CLAUDE_JOBS_ARCHIVE_AGE_DAYS: value } }).young).toBe(1);
      expect(sweep({ olderThanMs: 0, dryRun: true, env: { WE_CLAUDE_JOBS_ARCHIVE_MAX_PER_RUN: value } }).moved).toBe(1);
    }
    expect(sweep({ dryRun: true, olderThanMs: 0, env: { WE_CLAUDE_JOBS_ARCHIVE_MAX_PER_RUN: '0.5' } }).moved).toBe(1);
    for (const olderThanMs of [NaN, '0', null]) expect(sweep({ olderThanMs }).young).toBe(1);
  });
  it('fails closed on invalid mtime, unreadable state and per-entry rename errors', () => {
    entry('a'); entry('b');
    expect(sweep({ fs: { ...fs, statSync: () => ({ mtimeMs: NaN }) } }).young).toBe(2);
    expect(sweep({ fs: { ...fs, readFileSync: () => { throw Error('denied'); } } }).noState).toBe(2);
    expect(sweep({ fs: { ...fs, renameSync: () => { throw Error('denied'); } } })).toMatchObject({ errors: 2, moved: 0 });
  });
  it('refuses nested archives and projects paths, including symlink aliases', () => {
    expect(() => sweep({ archiveRoot: join(jobsRoot, 'archive') })).toThrow();
    expect(() => sweep({ archiveRoot: jobsRoot })).toThrow();
    const projects = join(root, '.claude', 'projects'); fs.mkdirSync(projects);
    for (const key of ['jobsRoot', 'archiveRoot']) expect(() => sweep({ [key]: projects })).toThrow();
    fs.mkdirSync(archiveRoot); fs.symlinkSync(projects, join(archiveRoot, '2026-10-05'));
    expect(() => sweep()).toThrow();
    fs.unlinkSync(join(archiveRoot, '2026-10-05'));
    const alias = join(root, 'alias'); fs.symlinkSync(projects, alias);
    expect(() => sweep({ archiveRoot: join(alias, 'new') })).toThrow();
    fs.symlinkSync(jobsRoot, join(root, 'jobs-alias'));
    expect(() => sweep({ archiveRoot: join(root, 'jobs-alias', 'new') })).toThrow();
  });
  it('runs the one-shot CLI against temporary roots', () => {
    entry('a', 'done', 1000 * day);
    const args = ['scripts/conveyor/health-watch.mjs', 'claude-jobs-archive', `--claude-jobs-root=${jobsRoot}`, `--claude-jobs-archive-root=${archiveRoot}`, `--state-root=${root}`];
    const opts = { encoding: 'utf8', timeout: 10000, env: { ...process.env, WE_CLAUDE_JOBS_ARCHIVE: '1', WE_CLAUDE_JOBS_ARCHIVE_AGE_DAYS: '0', WE_CLAUDE_JOBS_ARCHIVE_MAX_PER_RUN: '1000' } };
    expect(JSON.parse(execFileSync(process.execPath, [...args, '--dry-run', '--json'], opts))).toMatchObject({ moved: 1, dryRun: true });
    expect(fs.existsSync(join(jobsRoot, 'a'))).toBe(true);
    expect(execFileSync(process.execPath, args, opts)).toContain('claude-jobs-archive: moved 1/1 eligible');
    expect(fs.existsSync(join(jobsRoot, 'a'))).toBe(false);
  });
});
