import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

vi.mock('../../lib/write-all-sync.mjs', () => ({ writeAllSync: vi.fn(), writeLineSync: vi.fn() }));
import { writeLineSync } from '../../lib/write-all-sync.mjs';
import { createReviewJobIo, dispatchReviewJob, runReviewJob, runReviewJobCli } from '../review-job.mjs';

const origin = 'git@example.test:team/repo.git';
const repo = 'web-everything/web-everything';
let dir;
let priorExit;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-job-source-'));
  priorExit = process.exitCode;
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = priorExit;
  rmSync(dir, { recursive: true, force: true });
});

function captureIo(options = {}) {
  const spawnNode = vi.fn(() => ({ status: 0, stdout: `${dir}\n`, stderr: '' }));
  const io = createReviewJobIo({ root: dir, dir, env: {}, log: () => {}, spawnNode, ...options });
  return { io, spawnNode };
}
function acquire(io, lane) {
  return io.acquireLane({ laneRepo: dir, slug: 'review-10', actorId: 'actor', waitMs: 0, lane });
}
function dispatch(options = {}) {
  const spawnJob = vi.fn(() => null);
  dispatchReviewJob({ pr: 10, repo, root: '/daemon', dir, env: {},
    ciGate: () => ({ allowed: true }), checkStaleness: () => ({ fresh: true, behind: 0 }),
    readCompletion: () => null, resolveSettingsEnv: () => null, spawnJob, ...options });
  return spawnJob.mock.calls[0][0];
}
function cli(flags, env = {}) {
  const runJob = vi.fn(() => ({ refused: true }));
  runReviewJobCli(['run', '--pr=10', `--repo=${repo}`, ...flags], { runJob, env });
  return runJob;
}

describe('review-job lane source pass-through', () => {
  it.each(['origin', 'reference', 'both', 'neither'])('acquire argv carries only supplied sources: %s', selected => {
    const options = { ...(selected === 'origin' || selected === 'both' ? { origin } : {}),
      ...(selected === 'reference' || selected === 'both' ? { reference: dir } : {}) };
    const { io, spawnNode } = captureIo(options);
    // Both preferred acquisition and the automatic fallback use the same source.
    expect(acquire(io, 7)).toEqual({ lanePath: dir });
    expect(acquire(io)).toEqual({ lanePath: dir });
    for (const [, argv, spawnOptions] of spawnNode.mock.calls) {
      expect(argv.filter(arg => /^--(?:origin|reference)=/.test(arg))).toEqual([
        ...(options.origin ? [`--origin=${origin}`] : []), ...(options.reference ? [`--reference=${dir}`] : []),
      ]);
      expect(spawnOptions.cwd).toBe(dir);
    }
    io.releaseLane('review-10');
    const release = spawnNode.mock.calls.at(-1)[1];
    expect(release).toContain('release');
    expect(release.filter(arg => /^--(?:origin|reference)=/.test(arg))).toEqual([]);
  });

  it('CLI carries sources through runJob into the production acquire IO', () => {
    const { spawnNode } = captureIo();
    runReviewJobCli(['run', '--pr=10', `--repo=${repo}`, `--origin=${origin}`, `--reference=${dir}`], {
      env: {}, runJob: options => {
        const io = createReviewJobIo({ ...options, env: {}, spawnNode });
        acquire(io);
        return { refused: true };
      },
    });
    expect(spawnNode.mock.calls[0][1]).toEqual(expect.arrayContaining([`--origin=${origin}`, `--reference=${dir}`]));
  });

  it.each(['explicit', 'environment', 'neither'])('detached argv preserves sources and recovery flags: %s', mode => {
    const sources = mode === 'explicit' ? { origin, reference: dir }
      : mode === 'environment' ? { env: { REVIEW_JOB_LANE_ORIGIN: origin, REVIEW_JOB_LANE_REFERENCE: dir } } : {};
    const child = dispatch({ ...sources, preferLane: 7, redTeamOnly: true, redTeamMode: 'resume' });
    expect(child.argv.filter(arg => /^--(?:origin|reference)=/.test(arg))).toEqual(mode === 'neither' ? []
      : [`--origin=${origin}`, `--reference=${dir}`]);
    expect(child.argv).toEqual(expect.arrayContaining(['--prefer-lane=7', '--red-team-only=resume']));
  });

  it('environment defaults reach CLI and acquire; explicit values override invalid defaults', () => {
    const env = { REVIEW_JOB_LANE_ORIGIN: origin, REVIEW_JOB_LANE_REFERENCE: dir };
    expect(cli([], env)).toHaveBeenCalledWith(expect.objectContaining({ origin, reference: dir }));
    const { io, spawnNode } = captureIo({ env });
    acquire(io);
    expect(spawnNode.mock.calls[0][1]).toEqual(expect.arrayContaining([`--origin=${origin}`, `--reference=${dir}`]));
    const invalidEnv = { REVIEW_JOB_LANE_ORIGIN: 'bad remote', REVIEW_JOB_LANE_REFERENCE: 'relative' };
    expect(cli([`--origin=${origin}`, `--reference=${dir}`], invalidEnv)).toHaveBeenCalledWith(expect.objectContaining({ origin, reference: dir }));
    expect(dispatch({ origin, reference: dir, env: invalidEnv }).argv).toEqual(expect.arrayContaining([`--origin=${origin}`, `--reference=${dir}`]));
    expect(() => captureIo({ origin, reference: dir, env: invalidEnv })).not.toThrow();
  });

  it('without sources the CLI preserves the existing job options', () => {
    const runJob = cli([]);
    expect(runJob.mock.calls[0][0]).not.toHaveProperty('origin');
    expect(runJob.mock.calls[0][0]).not.toHaveProperty('reference');
  });

  it.each(['https://example.test/team/repo.git', 'ssh://git@example.test/team/repo.git',
    'git://example.test/repo.git', 'file:///shared/repo.git', origin, 'example.test:/shared/repo.git', 'git@[::1]:repo.git'])('accepts remote syntax %s', value => {
    expect(cli([`--origin=${value}`])).toHaveBeenCalledWith(expect.objectContaining({ origin: value }));
  });

  it.each(['', 'relative/path', '/local/repo', 'https://', 'ssh://[', 'bad remote', 'ext::helper', 'git@:repo', 'git@host:repo\ncontrol'])('invalid origin is refused before running: %j', value => {
    const runJob = cli([`--origin=${value}`]);
    expect(runJob).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(writeLineSync).toHaveBeenCalledTimes(1);
    expect(writeLineSync).toHaveBeenCalledWith(2, 'review-job: error: --origin must be a URL or scp-style git remote');
  });

  it.each(['empty', 'relative', 'missing', 'file'])('invalid reference is refused before running: %s', kind => {
    const file = join(dir, 'file');
    writeFileSync(file, 'fixture');
    const reference = { empty: '', relative: 'primary', missing: join(dir, 'missing'), file }[kind];
    expect(cli([`--reference=${reference}`])).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(writeLineSync).toHaveBeenCalledTimes(1);
    expect(writeLineSync).toHaveBeenCalledWith(2, 'review-job: error: --reference must be an absolute existing directory');
  });

  it.each(['--origin', '--reference'])('missing equals value is refused: %s', flag => {
    expect(cli([flag])).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it.each(['REVIEW_JOB_LANE_ORIGIN', 'REVIEW_JOB_LANE_REFERENCE'])('invalid environment default is refused: %s', key => {
    const env = { [key]: 'invalid value' };
    expect(cli([], env)).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(() => captureIo({ env })).toThrow(/--(?:origin|reference) must/);
    expect(() => dispatch({ env })).toThrow(/--(?:origin|reference) must/);
  });

  it('runJob validates its source options when constructing default IO', () => {
    expect(() => runReviewJob({ pr: 10, repo, origin: 'bad remote', env: {} })).toThrow(/--origin must/);
    expect(() => runReviewJob({ pr: 10, repo, reference: 'relative', env: {} })).toThrow(/--reference must/);
  });

  it('real CLI exits 2 with exactly one error line for an invalid source', () => {
    // Dependency deprecation warnings vary by Node version; assert the CLI's own diagnostic.
    const result = spawnSync(process.execPath, ['scripts/operations/review-job.mjs', 'run', '--pr=10', `--repo=${repo}`, '--origin=bad remote'],
      { encoding: 'utf8', timeout: 30_000, env: { PATH: '', NODE_NO_WARNINGS: '1' } });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('review-job: error: --origin must be a URL or scp-style git remote\n');
  });
});
