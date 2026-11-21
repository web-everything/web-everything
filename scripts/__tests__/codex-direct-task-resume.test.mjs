/**
 * @file Tests for the R302 `--resume=<threadId>` CLI flag and the `resumeThreadId` option on `codexDirectTask`.
 * A Codex follow-up fix resumes its earlier thread so it keeps that thread's context instead of re-reading files.
 * Kept apart from codex-direct-task.test.mjs, which another open PR holds.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertResumeThreadId, parseResumeFlag, buildCodexDirectTaskArgv, codexDirectTask } from '../codex-direct-task.mjs';

const THREAD_ID = '01a1941d-8f2e-7242-8cfe-788d55f26a75';
const resolveBinaryFn = () => '/fixture/bin/codex';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'codex-direct-task.mjs');

beforeEach(() => vi.stubEnv('WE_BUILD_SELF_REVIEW_ENABLED', 'false'));
afterEach(() => vi.unstubAllEnvs());

function fakeSpawn(stdout) {
  const seen = { argv: null, calls: 0 };
  const fn = (_cli, argv) => {
    seen.argv = argv; seen.calls += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { on: () => {}, end: () => {} };
    child.kill = () => {};
    setTimeout(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0); }, 0);
    return child;
  };
  return { fn, seen };
}

const execFnFor = dir => (_bin, args) => {
  if (args.includes('--absolute-git-dir')) return join(dir, 'git-metadata');
  if (args.includes('rev-parse')) return 'startsha\n';
  return '';
};

describe('assertResumeThreadId', () => {
  it('accepts a session id and refuses empty, non-string, shell-shaped and ephemeral resumes', () => {
    expect(() => assertResumeThreadId(THREAD_ID)).not.toThrow();
    for (const bad of ['', null, 42, '-flag', 'a;b', 'a b', '../x']) expect(() => assertResumeThreadId(bad)).toThrow(/resumeThreadId/);
    expect(() => assertResumeThreadId(THREAD_ID, { ephemeral: true })).toThrow(/ephemeral/);
  });

  it('refuses a non-UUID session name', () => {
    expect(() => assertResumeThreadId('thread-1')).toThrow(/must be a UUID/);
  });

  it('is the same check the argv builder applies', () => {
    expect(() => buildCodexDirectTaskArgv({ cwd: '/lane', resumeThreadId: 'a;b' })).toThrow(/resumeThreadId/);
    expect(buildCodexDirectTaskArgv({ cwd: '/lane', resumeThreadId: THREAD_ID }).slice(-3)).toEqual(['resume', THREAD_ID, '-']);
  });
});

describe('parseResumeFlag', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseResumeFlag({ dir: '/lane' })).toBeUndefined();
  });

  it('returns the thread id with --dir', () => {
    expect(parseResumeFlag({ resume: THREAD_ID, dir: '/lane' })).toBe(THREAD_ID);
  });

  it.each([
    ['a bare --resume with no value', { resume: true, dir: '/lane' }, /needs a value/],
    ['an empty value', { resume: '', dir: '/lane' }, /needs a value/],
    ['a non-UUID session name', { resume: 'thread-1', dir: '/lane' }, /must be a UUID/],
    ['an invalid id', { resume: 'a;b', dir: '/lane' }, /resumeThreadId/],
    ['--ephemeral', { resume: THREAD_ID, dir: '/lane', ephemeral: true }, /ephemeral/],
    ['--output-schema-file', { resume: THREAD_ID, dir: '/lane', 'output-schema-file': 's.json' }, /output-schema/],
    ['no --dir (a fresh scratch clone would not hold the work)', { resume: THREAD_ID }, /requires --dir/],
  ])('refuses %s', (_name, flags, message) => {
    expect(() => parseResumeFlag(flags)).toThrow(message);
  });
});

describe('codexDirectTask resumeThreadId', () => {
  it('passes the thread id through to `codex exec ... resume <id> -` and reports events.threadId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-resume-'));
    const { fn: spawnFn, seen } = fakeSpawn(`${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n{"type":"turn.completed"}\n`);
    try {
      const report = await codexDirectTask({ task: 'fix line 3', dir, gate: 'none', selfReview: false, stream: false,
        resumeThreadId: THREAD_ID, resolveBinaryFn, spawnFn, execFn: execFnFor(dir), log: false,
        readQuotaFn: () => ({ quota: null, rolloutFile: null }) });
      expect(seen.argv.slice(-3)).toEqual(['resume', THREAD_ID, '-']);
      expect(report.events.threadId).toBe(THREAD_ID);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves a fresh run unresumed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-resume-'));
    const { fn: spawnFn, seen } = fakeSpawn(`${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`);
    try {
      await codexDirectTask({ task: 't', dir, gate: 'none', selfReview: false, stream: false, resolveBinaryFn, spawnFn,
        execFn: execFnFor(dir), log: false, readQuotaFn: () => ({ quota: null, rolloutFile: null }) });
      expect(seen.argv).not.toContain('resume');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a bad or ephemeral resume before any git or Codex work', async () => {
    const spawnFn = vi.fn();
    const execFn = vi.fn();
    const resolveBinaryFn = vi.fn();
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: 'a;b', resolveBinaryFn, spawnFn, execFn })).rejects.toThrow(/resumeThreadId/);
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: 'thread-1', resolveBinaryFn, spawnFn, execFn })).rejects.toThrow(/must be a UUID/);
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: THREAD_ID, ephemeral: true, resolveBinaryFn, spawnFn, execFn })).rejects.toThrow(/ephemeral/);
    await expect(codexDirectTask({ task: 't', resumeThreadId: THREAD_ID, repoRoot: '/nowhere', resolveBinaryFn, spawnFn, execFn })).rejects.toThrow(/requires --dir/);
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: THREAD_ID, outputSchemaFile: 's.json', resolveBinaryFn, spawnFn, execFn })).rejects.toThrow(/output-schema/);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(execFn).not.toHaveBeenCalled();
    expect(resolveBinaryFn).not.toHaveBeenCalled();
  });
});

describe('CLI --resume', () => {
  // A private jobs dir keeps a regressed --detach from writing a job record into the real one.
  const run = args => {
    const jobsDir = mkdtempSync(join(tmpdir(), 'we-resume-jobs-'));
    try {
      return spawnSync(process.execPath, [SCRIPT, '--task=x', ...args],
        { encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEX_JOBS_DIR: jobsDir } });
    } finally { rmSync(jobsDir, { recursive: true, force: true }); }
  };

  it.each([
    [[`--resume=${THREAD_ID}`], /requires --dir/],
    [[`--resume=${THREAD_ID}`, '--dir=/nowhere', '--output-schema-file=s.json'], /output-schema/],
    [['--resume=thread-1', '--dir=/nowhere'], /must be a UUID/],
    [['--resume', '--dir=/nowhere'], /needs a value/],
    [['--resume=a;b', '--dir=/nowhere', '--detach'], /resumeThreadId/],
  ])('exits 2 on %j without running Codex', (args, message) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toMatch(/recordPath/);
  });

  it('documents the flag in --help', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', timeout: 30000 });
    expect(result.stdout).toContain('--resume=<threadId>');
  });
});
