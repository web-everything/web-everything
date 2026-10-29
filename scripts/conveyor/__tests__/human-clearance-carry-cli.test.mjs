import { beforeEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { run } from '../human-clearance-carry-cli.mjs';
import { applyHumanClearanceCarry } from '../../lib/human-clearance-carry.mjs';
import { liveCarryFingerprints } from '../../lib/carry-equivalence.mjs';

vi.mock('../../lib/human-clearance-carry.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, applyHumanClearanceCarry: vi.fn(actual.applyHumanClearanceCarry) };
});
beforeEach(() => vi.mocked(applyHumanClearanceCarry).mockClear());

it('CLI exits 1 with one failure JSON line on stdout when arguments are missing', () => {
  const child = spawnSync(process.execPath, [resolve('scripts/conveyor/human-clearance-carry-cli.mjs')], {
    env: { ...process.env, PATH: '' }, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toMatch(/^[^\r\n]+\n$/);
  expect(JSON.parse(child.stdout)).toEqual({ carried: null,
    reason: expect.stringContaining('pr must be a positive integer') });
});

const fromSha = 'a'.repeat(40), toSha = 'b'.repeat(40), fingerprint = 'c'.repeat(64);
const job = { pr: 1, repo: 'web-everything/web-everything' };
const trusted = body => ({ author: { login: 'chalbert' }, body });

function cliFixture({ headSha = toSha, reviews = [], objection = false, incomplete = false } = {}) {
  const comments = [{ ...trusted(`<!-- reviewed-sha: ${fromSha} -->\n<!-- reviewed-diff: ${fingerprint} -->\n<!-- cleared-human: chalbert -->`),
    id: 'clearance', createdAt: '2026-10-01T00:00:00Z' }];
  if (objection) comments.push({ ...trusted('Please stop: this still needs changes.'),
    id: 'objection', createdAt: '2026-10-02T00:00:00Z' });
  const evidence = { humanClearance: { sha: fromSha, diff: fingerprint, actor: 'chalbert' },
    headSha: toSha, headDiffSha: toSha, headDiff: fingerprint };
  const readEvidence = vi.fn(() => evidence);
  let proofFinished = false;
  const exec = vi.fn((file, args) => {
    if (file === 'git') {
      if (args[0] === 'rev-parse') return args.at(-1).startsWith(fromSha) ? fromSha : toSha;
      if (args[0] === 'cat-file' || (args[0] === 'merge-base' && args[1] === '--is-ancestor')) return '';
      if (args[0] === 'rev-list') {
        proofFinished = true;
        return `${toSha} ${fromSha} ${'d'.repeat(40)}`;
      }
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      expect(proofFinished).toBe(true);
      expect(args).toContain('headRefOid,reviews');
      return JSON.stringify({ headRefOid: headSha, reviews });
    }
    if (file === 'gh' && args[0] === 'api') {
      expect(proofFinished).toBe(true);
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: {
        comments: { totalCount: comments.length + (incomplete ? 1 : 0) },
      } } } });
      expect(args).toContain('--paginate');
      return comments.map(c => [c.body, c.createdAt, c.author.login, c.id, '']
        .map(s => s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\t', '\\t')).join('\t')).join('\n');
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'comment') return '';
    throw Error(`unexpected command: ${file} ${args.join(' ')}`);
  });
  const write = vi.fn();
  const options = { ...job, cwd: '.', exec, readEvidence, write, log: vi.fn(),
    carryOptions: { setting: { value: true, source: 'test' }, netPatchSetting: { value: false, source: 'test' },
      equivalence: 'contribution' } };
  return { exec, readEvidence, evidence, comments, options, write,
    run: () => { const status = run(options); return { status, result: JSON.parse(write.mock.calls.at(-1)[0]) }; },
    posts: () => exec.mock.calls.filter(([file, args]) => file === 'gh' && args[0] === 'pr' && args[1] === 'comment') };
}

function changeContent(f) {
  const clearedDiff = 'diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+reviewed\n';
  Object.assign(f.evidence.humanClearance, liveCarryFingerprints(clearedDiff));
  f.evidence.headDiff = clearedDiff.replace('+reviewed', '+unreviewed');
}

describe('human clearance carry CLI', () => {
  it('uses the exported drain acceptance reader and emits one no-clearance JSON line', () => {
    const exec = vi.fn((file, args) => {
      expect(file).toBe('gh');
      expect(args).toEqual(['pr', 'view', '1', '--repo', job.repo, '--json', 'headRefOid,headRefName,comments']);
      return JSON.stringify({ headRefOid: toSha, comments: [] });
    });
    const write = vi.fn();
    expect(run({ ...job, cwd: '.', exec, write })).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ carried: null, reason: expect.any(String) });
    expect(write.mock.calls[0][0]).toMatch(/\n$/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(applyHumanClearanceCarry).not.toHaveBeenCalled();
  });

  it('re-reads fresh head, complete comments and formal reviews after proof and posts the carry once', () => {
    const f = cliFixture();
    expect(f.run()).toEqual({ status: 0, result: { carried: { fromSha, toSha, fingerprint } } });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(applyHumanClearanceCarry).toHaveBeenCalledTimes(1);
    expect(applyHumanClearanceCarry).toHaveBeenCalledWith(expect.objectContaining({ evidence: f.evidence,
      readLiveEvidence: expect.any(Function), numberingOnly: false }));
    expect(f.readEvidence).toHaveBeenCalledWith(expect.objectContaining(job));
    expect(f.exec.mock.calls.some(([, args]) => args[1] === 'graphql')).toBe(true);
    expect(f.posts()).toHaveLength(1);
    const body = f.posts()[0][1].at(-1);
    expect(body).toContain(`<!-- reviewed-sha: ${toSha} -->`);
    expect(body).toContain(`<!-- human-clearance-carried: from=${fromSha} to=${toSha} diff=${fingerprint} -->`);
  });

  it('refuses a non-mechanical content change with different live and clearance fingerprints without posting', () => {
    const f = cliFixture();
    changeContent(f);
    f.options.carryOptions.numberingSetting = { value: false, source: 'test' };
    const live = liveCarryFingerprints(f.evidence.headDiff);
    expect(live.diff).not.toBe(f.evidence.humanClearance.diff);
    expect(live.contribution).not.toBe(f.evidence.humanClearance.contribution);

    expect(f.run()).toEqual({ status: 0, result: { carried: null,
      reason: 'carry not proven; normal review required' } });
    expect(f.options.log.mock.calls.some(([line]) => line.includes('net diff changed'))).toBe(true);
    expect(f.posts()).toHaveLength(0);
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('fails closed with nonzero status when evidence.headReadFailed is true despite a valid head', () => {
    const f = cliFixture();
    f.evidence.headReadFailed = true;
    expect(f.run()).toEqual({ status: 1, result: { carried: null,
      reason: expect.stringContaining('initial head or live net diff unreadable') } });
    expect(applyHumanClearanceCarry).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each([0, -1, 'x'])('rejects invalid pr %s with failure JSON and nonzero status before reading evidence', pr => {
    const f = cliFixture();
    f.options.pr = pr;
    expect(f.run()).toEqual({ status: 1, result: { carried: null,
      reason: expect.stringContaining('pr must be a positive integer') } });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.readEvidence).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('rejects an invalid repo slug with failure JSON and nonzero status before reading evidence', () => {
    const f = cliFixture();
    f.options.repo = 'owner/repo/extra';
    expect(f.run()).toEqual({ status: 1, result: { carried: null,
      reason: expect.stringContaining('repo must be an owner/name slug') } });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.readEvidence).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(['omitted', 'empty'].flatMap(mode => [
    [mode, 'content change', 0, 'carry not proven; normal review required'],
    [mode, 'head read failed', 1, 'initial head or live net diff unreadable'],
    [mode, 'moved head', 0, 'head moved'],
    [mode, 'missing formal reviews', 1, 'formal reviews unreadable'],
  ]))('production defaults with carryOptions %s refuse %s without posting', (mode, scenario, status, reason) => {
    const f = cliFixture({ headSha: scenario === 'moved head' ? 'e'.repeat(40) : toSha,
      reviews: scenario === 'missing formal reviews' ? null : [] });
    if (scenario === 'content change') changeContent(f);
    if (scenario === 'head read failed') f.evidence.headReadFailed = true;
    if (mode === 'omitted') delete f.options.carryOptions;
    else f.options.carryOptions = {};

    expect(f.run()).toEqual({ status, result: { carried: null, reason: expect.stringContaining(reason) } });
    expect(f.posts()).toHaveLength(0);
    if (scenario !== 'head read failed') {
      expect(applyHumanClearanceCarry).toHaveBeenCalledTimes(1);
      expect(applyHumanClearanceCarry).toHaveBeenCalledWith(expect.not.objectContaining({ setting: expect.anything() }));
    }
  });

  it('returns carried null for a dry run whose carried.recorded is false', () => {
    const f = cliFixture();
    f.options.carryOptions.dryRun = true;
    expect(f.run()).toEqual({ status: 0, result: { carried: null,
      reason: 'carry not proven; normal review required' } });
    expect(applyHumanClearanceCarry.mock.results.at(-1).value.carried.recorded).toBe(false);
    expect(f.posts()).toHaveLength(0);
  });

  it('returns carried null and the defer reason when the durable record write fails', () => {
    const f = cliFixture();
    const original = f.exec.getMockImplementation();
    f.exec.mockImplementation((file, args, options) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'comment') throw Error('record unavailable');
      return original(file, args, options);
    });
    expect(f.run()).toEqual({ status: 0, result: { carried: null,
      reason: expect.stringContaining('durable record could not be written') } });
    expect(applyHumanClearanceCarry.mock.results.at(-1).value).toMatchObject({ action: 'defer' });
    expect(f.posts()).toHaveLength(1);
  });

  it.each([
    ['a moved head', { headSha: 'e'.repeat(40) }, 'head moved', 0],
    ['a newer objection', { objection: true }, 'later verdict or unknown comment', 0],
    ['missing formal reviews', { reviews: null }, 'formal reviews unreadable', 1],
    ['malformed formal reviews', { reviews: {} }, 'formal reviews unreadable', 1],
    ['a formal review hold', { reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' },
      submittedAt: '2026-10-02T00:00:00Z' }] }, 'formal review hold', 0],
    ['an incomplete thread', { incomplete: true }, 'live re-read failed', 1],
  ])('refuses %s at the live re-read without posting; normal review remains the fallback', (_name, live, reason, status) => {
    const f = cliFixture(live);
    expect(f.run()).toEqual({ status, result: { carried: null, reason: expect.stringContaining(reason) } });
    expect(f.posts()).toHaveLength(0);
  });

  it.each(['invalid live JSON', 'missing live head', 'live exec failure', 'oversized live output'])('refuses unreadable input at the live re-read: %s', mode => {
    const f = cliFixture();
    const original = f.exec.getMockImplementation();
    f.exec.mockImplementation((file, args, options) => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        if (mode === 'invalid live JSON') return '{';
        if (mode === 'missing live head') return JSON.stringify({ reviews: [] });
        throw Object.assign(Error(mode), { code: mode === 'oversized live output' ? 'ENOBUFS' : 'EIO' });
      }
      return original(file, args, options);
    });
    expect(f.run()).toEqual({ status: 1, result: { carried: null, reason: expect.stringContaining('live re-read failed') } });
    expect(f.posts()).toHaveLength(0);
  });

  it.each([
    [null, null, true], [fingerprint, null, false], [null, fingerprint, false],
  ])('retains numberingOnly for diff=%s contribution=%s', (diff, contribution, numberingOnly) => {
    const f = cliFixture();
    f.evidence.humanClearance = { ...f.evidence.humanClearance, diff, contribution };
    f.run();
    expect(applyHumanClearanceCarry).toHaveBeenCalledWith(expect.objectContaining({ numberingOnly }));
  });

  it('does not apply carry when the clearance is already bound to the head', () => {
    const f = cliFixture();
    f.evidence.humanClearance.sha = toSha;
    expect(f.run()).toEqual({ status: 0, result: { carried: null, reason: expect.any(String) } });
    expect(applyHumanClearanceCarry).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each(['malformed JSON', 'missing head', 'missing comments', 'oversized output'])('fails closed on unreadable initial evidence: %s', mode => {
    const exec = vi.fn(() => {
      if (mode === 'oversized output') throw Object.assign(Error('read failed (output-too-large)'), { code: 'ENOBUFS' });
      if (mode === 'malformed JSON') return '{';
      return JSON.stringify(mode === 'missing head' ? { comments: [] } : { headRefOid: toSha });
    });
    const write = vi.fn();
    expect(run({ ...job, cwd: '.', exec, write })).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ carried: null, reason: expect.any(String) });
    expect(applyHumanClearanceCarry).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
