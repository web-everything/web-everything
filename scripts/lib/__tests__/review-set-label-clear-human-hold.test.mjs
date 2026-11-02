import { describe, expect, it, vi } from 'vitest';
import { buildVerdictComment, runReviewLabelCli } from '../../review-set-label.mjs';
import { DELEGATED_CLEARANCE_INELIGIBLE_LABELS } from '../review-labels.mjs';

vi.mock('../verdict-ledger.mjs', async importOriginal => ({
  ...await importOriginal(),
  appendVerdict: vi.fn(() => ({ ok: true })),
}));

const head = 'a'.repeat(40);

function run({ evidence, delegated = true, accepted = false, injectAt = 2, repark = false, readError = false }) {
  const initialLabels = ['review:human', ...(accepted ? ['review:accepted'] : [])];
  const output = [];
  let reads = 0;
  const events = [];
  const comments = repark ? [{ author: { login: 'web-everything' },
    body: `<!-- human-surface-repark: ${head} -->` }] : [];
  const provider = {
    readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
    readPrState: vi.fn(() => {
      const blocked = ++reads >= injectAt;
      events.push(blocked ? 'blocked-read' : 'eligible-read');
      if (blocked && readError) throw new Error('labels unavailable');
      return { state: 'OPEN', headRefOid: head, comments, body: '',
        labels: blocked ? evidence : initialLabels };
    }),
    readLabels: () => initialLabels,
    setLabels: vi.fn(() => events.push('label-write')),
    postComment: vi.fn(() => events.push('comment-write')),
    addLabels: vi.fn(() => events.push('add-labels')),
    removeLabels: vi.fn(() => events.push('remove-labels')),
  };
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
    throw Object.assign(new Error('exit'), { exitCode: code });
  });
  let exitCode = 0;
  try {
    runReviewLabelCli({
      argv: ['7', '--repo=o/r', '--to=clear-human', '--actor=operator', '--reason=operator review',
        ...(delegated ? [`--expect-head=${head}`, '--channel=daemon',
          '--delegation-json=' + JSON.stringify({ by: 'operator', scope: 'test', expires: '2099-01-01T00:00:00Z' })] : [])],
      allowClearHuman: true, provider, buildComment: buildVerdictComment,
      successResult: result => result, emit: line => output.push(line),
      signalFix: () => {}, fileApprovalPrevention: () => null,
      findFiledApprovalPrevention: () => null,
    });
  } catch (error) {
    if (typeof error.exitCode !== 'number') throw error;
    exitCode = error.exitCode;
  } finally { exit.mockRestore(); }
  return { provider, output: output.join(''), exitCode, events };
}

describe('delegated clear-human final label guard', () => {
  // Every admission read after the initial observation, in both write orders.
  // The accepted path has a fourth read inside reassertHumanClearance.
  const readBoundaries = [
    { accepted: false, injectAt: 2, boundary: 'before comment', priorWrites: [] },
    { accepted: false, injectAt: 3, boundary: 'before swap', priorWrites: ['comment-write'] },
    { accepted: true, injectAt: 2, boundary: 'before accepted swap', priorWrites: [] },
    { accepted: true, injectAt: 3, boundary: 'before accepted comment', priorWrites: ['label-write'] },
    { accepted: true, injectAt: 4, boundary: 'before reassert', priorWrites: ['label-write', 'comment-write'] },
  ];
  const blockers = [...DELEGATED_CLEARANCE_INELIGIBLE_LABELS.map(label => ({
    label, evidence: ['review:human', { name: label }],
  })),
  { label: 'unreadable labels', evidence: null },
  { label: 'malformed labels', evidence: ['review:human', { name: null }] },
  { label: 'failed read', readError: true }];

  it.each(readBoundaries.flatMap(boundary => blockers.map(blocker => ({ ...boundary, ...blocker }))))(
    'refuses $label at read $injectAt ($boundary), with no subsequent comment or label writes', testCase => {
      const result = run({ ...testCase, repark: true });
      expect(result.exitCode).toBe(1);
      expect(result.provider.readPrState).toHaveBeenCalledTimes(testCase.injectAt);
      const rejectedAt = result.events.indexOf('blocked-read');
      expect(result.events.slice(rejectedAt)).toEqual(['blocked-read']);
      // Explicitly account for earlier successful writes; a later read cannot undo them.
      expect(result.events.filter(event => event.endsWith('write'))).toEqual(testCase.priorWrites);
      expect(result.provider.addLabels).not.toHaveBeenCalled();
      expect(result.provider.removeLabels).not.toHaveBeenCalled();
      if (testCase.injectAt === 2) {
        expect(result.provider.postComment).not.toHaveBeenCalled();
        expect(result.provider.setLabels).not.toHaveBeenCalled();
      }
      if (!testCase.readError) expect(result.output).toContain('delegated clearance refused');
    },
  );

  it('still reasserts an eligible delegated clearance with a matching repark marker', () => {
    const result = run({ accepted: true, repark: true, injectAt: Infinity });
    expect(result.exitCode).toBe(0);
    expect(result.provider.readPrState).toHaveBeenCalledTimes(4);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.setLabels).toHaveBeenCalledTimes(2);
    expect(result.provider.setLabels).toHaveBeenLastCalledWith('o/r', '7', {
      add: 'review:accepted', remove: ['review:human'],
    });
  });

  it('preserves operator reassertion over an operator hold with a matching repark marker', () => {
    const result = run({ delegated: false, accepted: true, repark: true, injectAt: 3,
      evidence: ['review:human', 'review:accepted', 'operator:hold'] });
    expect(result.exitCode).toBe(0);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.setLabels).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['review:changes', ['review:human', 'review:changes']],
    ['operator:hold', ['review:human', { name: 'operator:hold' }]],
    ['unreadable labels', null],
    ['malformed labels', ['review:human', { name: null }]],
  ])('refuses %s arriving on the second read before comment or label writes', (_name, evidence) => {
    const result = run({ evidence });
    expect(result.provider.readPrState).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('delegated clearance refused');
    expect(result.provider.postComment).not.toHaveBeenCalled();
    expect(result.provider.setLabels).not.toHaveBeenCalled();
  });

  it('refuses a second-read hold before swapping an already accepted PR', () => {
    const result = run({ evidence: ['review:human', 'review:accepted', 'operator:hold'], accepted: true });
    expect(result.exitCode).toBe(1);
    expect(result.provider.postComment).not.toHaveBeenCalled();
    expect(result.provider.setLabels).not.toHaveBeenCalled();
  });

  it('preserves the human operator path when a hold arrives on the second read', () => {
    const result = run({ evidence: ['review:human', 'operator:hold'], delegated: false });
    expect(result.exitCode).toBe(0);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.setLabels).toHaveBeenCalledOnce();
  });
});
