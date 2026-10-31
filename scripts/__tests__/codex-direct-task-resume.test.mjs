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
    expect(() => assertResumeThreadId('01a1941d-8f2e-7242-8cfe-788d55f26a75')).not.toThrow();
    for (const bad of ['', null, 42, '-flag', 'a;b', 'a b', '../x']) expect(() => assertResumeThreadId(bad)).toThrow(/resumeThreadId/);
    expect(() => assertResumeThreadId('t1', { ephemeral: true })).toThrow(/ephemeral/);
  });

  it('is the same check the argv builder applies', () => {
    expect(() => buildCodexDirectTaskArgv({ cwd: '/lane', resumeThreadId: 'a;b' })).toThrow(/resumeThreadId/);
    expect(buildCodexDirectTaskArgv({ cwd: '/lane', resumeThreadId: 't1' }).slice(-3)).toEqual(['resume', 't1', '-']);
  });
});

describe('parseResumeFlag', () => {
  it('returns undefined when the flag is absent', () => {
    expect(parseResumeFlag({ dir: '/lane' })).toBeUndefined();
  });

  it('returns the thread id with --dir', () => {
    expect(parseResumeFlag({ resume: 'thread-1', dir: '/lane' })).toBe('thread-1');
  });

  it.each([
    ['a bare --resume with no value', { resume: true, dir: '/lane' }, /needs a value/],
    ['an empty value', { resume: '', dir: '/lane' }, /needs a value/],
    ['an invalid id', { resume: 'a;b', dir: '/lane' }, /resumeThreadId/],
    ['--ephemeral', { resume: 't1', dir: '/lane', ephemeral: true }, /ephemeral/],
    ['--output-schema-file', { resume: 't1', dir: '/lane', 'output-schema-file': 's.json' }, /output-schema/],
    ['no --dir (a fresh scratch clone would not hold the work)', { resume: 't1' }, /requires --dir/],
  ])('refuses %s', (_name, flags, message) => {
    expect(() => parseResumeFlag(flags)).toThrow(message);
  });
});

describe('codexDirectTask resumeThreadId', () => {
  it('passes the thread id through to `codex exec ... resume <id> -` and reports events.threadId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-resume-'));
    const { fn: spawnFn, seen } = fakeSpawn('{"type":"thread.started","thread_id":"thread-9"}\n{"type":"turn.completed"}\n');
    try {
      const report = await codexDirectTask({ task: 'fix line 3', dir, gate: 'none', selfReview: false, stream: false,
        resumeThreadId: 'thread-9', spawnFn, execFn: execFnFor(dir), log: false,
        readQuotaFn: () => ({ quota: null, rolloutFile: null }) });
      expect(seen.argv.slice(-3)).toEqual(['resume', 'thread-9', '-']);
      expect(report.events.threadId).toBe('thread-9');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves a fresh run unresumed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-resume-'));
    const { fn: spawnFn, seen } = fakeSpawn('{"type":"thread.started","thread_id":"t"}\n');
    try {
      await codexDirectTask({ task: 't', dir, gate: 'none', selfReview: false, stream: false, spawnFn,
        execFn: execFnFor(dir), log: false, readQuotaFn: () => ({ quota: null, rolloutFile: null }) });
      expect(seen.argv).not.toContain('resume');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a bad or ephemeral resume before any git or Codex work', async () => {
    const spawnFn = vi.fn();
    const execFn = vi.fn();
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: 'a;b', spawnFn, execFn })).rejects.toThrow(/resumeThreadId/);
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: 't1', ephemeral: true, spawnFn, execFn })).rejects.toThrow(/ephemeral/);
    await expect(codexDirectTask({ task: 't', resumeThreadId: 't1', repoRoot: '/nowhere', spawnFn, execFn })).rejects.toThrow(/requires --dir/);
    await expect(codexDirectTask({ task: 't', dir: '/nowhere', resumeThreadId: 't1', outputSchemaFile: 's.json', spawnFn, execFn })).rejects.toThrow(/output-schema/);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(execFn).not.toHaveBeenCalled();
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
    [['--resume=t1'], /requires --dir/],
    [['--resume=t1', '--dir=/nowhere', '--output-schema-file=s.json'], /output-schema/],
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
