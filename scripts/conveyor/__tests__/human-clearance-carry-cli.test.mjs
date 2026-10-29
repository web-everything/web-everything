import { beforeEach, describe, it, expect, vi } from 'vitest';
import { run } from '../human-clearance-carry-cli.mjs';
import { applyHumanClearanceCarry } from '../../lib/human-clearance-carry.mjs';

vi.mock('../../lib/human-clearance-carry.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, applyHumanClearanceCarry: vi.fn(actual.applyHumanClearanceCarry) };
});
beforeEach(() => vi.mocked(applyHumanClearanceCarry).mockClear());

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
