import { describe, expect, it, vi } from 'vitest';
import { buildVerdictComment, runReviewLabelCli } from '../../review-set-label.mjs';
import { DELEGATED_CLEARANCE_INELIGIBLE_LABELS } from '../review-labels.mjs';
import { appendVerdict, EVENT_TYPES, ledgerEventId } from '../verdict-ledger.mjs';
import labelInputHold from '../pr-state/holds/label-input.mjs';

vi.mock('../verdict-ledger.mjs', async importOriginal => ({
  ...await importOriginal(),
  appendVerdict: vi.fn(() => ({ ok: true })),
}));

const head = 'a'.repeat(40);

function run({ evidence, delegated = true, accepted = false, injectAt = 2, repark = false, readError = false,
  args, movedHead, onRead = () => {}, afterVerdict = false, target = 'clear-human' }) {
  const initialLabels = ['review:human', ...(accepted ? ['review:accepted'] : [])];
  const output = [];
  let reads = 0;
  const events = [];
  const ledger = [];
  vi.mocked(appendVerdict).mockImplementation(record => {
    ledger.push(record);
    if (afterVerdict && record.type !== EVENT_TYPES.APPROVAL) {
      ledger.push({ type: EVENT_TYPES.LABEL_INPUT, change: 'added', label: 'review:human',
        sender: 'operator', clearanceBaseline: [ledgerEventId(record)] });
    }
    return { ok: true, record };
  });
  const comments = repark ? [{ author: { login: 'web-everything' },
    body: `<!-- human-surface-repark: ${head} -->` }] : [];
  const provider = {
    readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
    readPrState: vi.fn(() => {
      const blocked = ++reads >= injectAt || (afterVerdict && ledger.length > 0);
      onRead(reads);
      events.push(blocked ? 'blocked-read' : 'eligible-read');
      if (blocked && readError) throw new Error('labels unavailable');
      return { state: 'OPEN', headRefOid: blocked && movedHead ? movedHead : head, comments, body: '',
        labels: blocked && !movedHead ? evidence : initialLabels };
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
      argv: ['7', '--repo=o/r', `--to=${target}`, '--actor=operator', '--reason=operator review',
        ...(args ?? (delegated ? [`--expect-head=${head}`, '--channel=daemon',
          '--delegation-json=' + JSON.stringify({ by: 'operator', scope: 'test', expires: '2099-01-01T00:00:00Z' })] : []))],
      allowClearHuman: true, provider, buildComment: buildVerdictComment,
      successResult: result => result, emit: line => output.push(line),
      signalFix: () => {}, fileApprovalPrevention: () => null,
      findFiledApprovalPrevention: () => null,
    });
  } catch (error) {
    if (typeof error.exitCode !== 'number') throw error;
    exitCode = error.exitCode;
  } finally { exit.mockRestore(); }
  const holds = labelInputHold.evaluate({
    view: { events: [{ type: EVENT_TYPES.LABEL_INPUT, change: 'added', label: 'review:human',
      sender: 'operator' }, ...ledger] },
    facts: { head: { sha: afterVerdict ? movedHead ?? head : head }, now: Date.now() },
  });
  return { provider, output: output.join(''), exitCode, events, ledger, holds };
}

describe('delegated clear-human final label guard', () => {
  it.each([false, true])('retains a new head human hold arriving between ledger appends (accepted=%s)', accepted => {
    const result = run({ accepted, injectAt: Infinity, afterVerdict: true, movedHead: 'b'.repeat(40) });
    expect(result.exitCode).toBe(1);
    expect(result.ledger.map(row => row.type ?? EVENT_TYPES.VERDICT)).toEqual([
      EVENT_TYPES.VERDICT, EVENT_TYPES.LABEL_INPUT,
    ]);
    expect(result.holds).toEqual([expect.objectContaining({ code: 'label-input:review:human' })]);
    expect(result.provider.postComment).not.toHaveBeenCalled();
    expect(result.provider.setLabels).not.toHaveBeenCalled();
  });

  // Every admission read, including the initial observation, in both write orders.
  // Read 3 rechecks admission between the verdict and approval appends.
  // The accepted path has a fifth read inside reassertHumanClearance.
  const readBoundaries = [
    { accepted: false, injectAt: 1, boundary: 'initial observation', priorWrites: [] },
    { accepted: true, injectAt: 1, boundary: 'initial accepted observation', priorWrites: [] },
    { accepted: false, injectAt: 2, boundary: 'before comment', priorWrites: [] },
    { accepted: false, injectAt: 3, boundary: 'before approval', priorWrites: [] },
    { accepted: false, injectAt: 4, boundary: 'before swap', priorWrites: ['comment-write'] },
    { accepted: true, injectAt: 2, boundary: 'before accepted swap', priorWrites: [] },
    { accepted: true, injectAt: 3, boundary: 'before accepted approval', priorWrites: [] },
    { accepted: true, injectAt: 4, boundary: 'before accepted comment', priorWrites: ['label-write'] },
    { accepted: true, injectAt: 5, boundary: 'before reassert', priorWrites: ['label-write', 'comment-write'] },
  ];
  const expectBoundaryLedger = (result, injectAt) => {
    // Account for EVERY durable row even at refusals after a successful write.
    expect(result.ledger).toEqual(injectAt <= 2 ? [] : [
      expect.objectContaining({ coverage: expect.objectContaining({ headSha: head }) }),
      ...(injectAt === 3 ? [] : [expect.objectContaining({ type: EVENT_TYPES.APPROVAL,
        delegation: { by: 'operator', scope: 'test', expires: '2099-01-01T00:00:00Z' } })]),
    ]);
  };
  const delegation = '--delegation-json=' + JSON.stringify({
    by: 'operator', scope: 'test', expires: '2099-01-01T00:00:00Z',
  });
  it.each([
    { name: 'expired', expires: '2000-01-01T00:00:00Z' },
    { name: 'missing', expires: undefined },
    { name: 'unparsable', expires: 'not-a-date' },
    { name: 'ISO-shaped but unparsable', expires: '2099-99-99T00:00:00Z' },
    { name: 'empty', expires: '' },
    { name: 'null', expires: null },
  ])('refuses $name delegation expiry without any durable write', ({ expires }) => {
    const result = run({ injectAt: Infinity, args: [`--expect-head=${head}`,
      '--delegation-json=' + JSON.stringify({ by: 'operator', scope: 'review:human', expires })] });
    expect(result.ledger).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('--delegation-json');
    expect(result.holds).toEqual([expect.objectContaining({ code: 'label-input:review:human' })]);
  });

  it.each([1, 2])('refuses delegation expiring during read %s before both ledger appends', expireAt => {
    const expiry = Date.parse('2099-01-01T00:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(expiry - 1);
    try {
      const result = run({ injectAt: Infinity, onRead: read => {
        if (read === expireAt) now.mockReturnValue(expiry);
      } });
      expect(result.exitCode).toBe(1);
      expect(result.ledger).toEqual([]);
      expect(result.events).toEqual(['eligible-read', 'eligible-read']);
      expect(result.holds).toEqual([expect.objectContaining({ code: 'label-input:review:human' })]);
    } finally { now.mockRestore(); }
  });

  it.each([false, true])('retains the human hold with zero ledger appends when review:changes arrives on the second read (accepted=%s)', accepted => {
    const result = run({ accepted, evidence: ['review:human', 'review:changes'], injectAt: 2 });
    expect(result.exitCode).toBe(1);
    expect(result.provider.readPrState).toHaveBeenCalledTimes(2);
    expect(result.ledger).toEqual([]);
    expect(result.holds).toEqual([expect.objectContaining({ code: 'label-input:review:human' })]);
    expect(result.events).toEqual(['eligible-read', 'blocked-read']);
  });
  it.each([
    { name: 'short --expect-head', args: ['--expect-head=abcdef0', delegation] },
    { name: 'empty --expect-head', args: ['--expect-head=', delegation] },
    { name: 'bare --expect-head', args: ['--expect-head', delegation] },
    { name: 'non-hex --expect-head', args: [`--expect-head=${'g'.repeat(40)}`, delegation] },
    { name: 'overlong --expect-head', args: [`--expect-head=${'a'.repeat(41)}`, delegation] },
    { name: '--new-head', args: [`--expect-head=${head}`, delegation, `--new-head=${head}`] },
    { name: 'empty --new-head', args: [`--expect-head=${head}`, delegation, '--new-head='] },
    { name: 'bare --new-head', args: [`--expect-head=${head}`, delegation, '--new-head'] },
    { name: 'missing --delegation-json', args: [`--expect-head=${head}`] },
    { name: 'delegated daemon without --expect-head', args: [delegation, '--channel=daemon'] },
    { name: 'delegation alone without --expect-head', args: [delegation] },
    { name: 'daemon alone without --expect-head', args: ['--channel=daemon'] },
    { name: 'normalized daemon without --expect-head', args: ['--channel= DAEMON '] },
    { name: 'punctuated daemon without --expect-head', args: ['--channel= DAEMON. '] },
    { name: 'bare delegation without --expect-head', args: ['--delegation-json'] },
  ])('refuses pinned clear-human with $name before any PR read or write', ({ args }) => {
    const result = run({ args, injectAt: Infinity });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('pinned clear-human requires --expect-head=<full 40-hex SHA> and --delegation-json (and no --new-head)');
    expect(result.provider.readPrState).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
  });

  it.each(readBoundaries.filter(boundary => boundary.injectAt < 5))(
    'refuses a moved head at read $injectAt ($boundary), with no subsequent writes', testCase => {
      const result = run({ ...testCase, movedHead: 'b'.repeat(40), repark: true });
      expect(result.exitCode).toBe(1);
      expect(result.provider.readPrState).toHaveBeenCalledTimes(testCase.injectAt);
      expect(result.events.slice(result.events.indexOf('blocked-read'))).toEqual(['blocked-read']);
      expect(result.events.filter(event => event.endsWith('write'))).toEqual(testCase.priorWrites);
      expect(result.provider.addLabels).not.toHaveBeenCalled();
      expect(result.provider.removeLabels).not.toHaveBeenCalled();
      expectBoundaryLedger(result, testCase.injectAt);
      expect(result.output).toContain(testCase.injectAt === 1 ? 'live head differs from --expect-head'
        : 'head changed before acceptance; hold retained');
    },
  );
  const blockers = [...DELEGATED_CLEARANCE_INELIGIBLE_LABELS.map(label => ({
    label, evidence: ['review:human', { name: label }],
  })),
  { label: 'unreadable labels', evidence: null },
  { label: 'malformed labels', evidence: ['review:human', { name: null }] },
  { label: 'failed read', readError: true }];

  it.each(readBoundaries.flatMap(boundary => blockers
    .filter(blocker => boundary.injectAt < 5 || !blocker.readError)
    .map(blocker => ({ ...boundary, ...blocker }))))(
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
      expectBoundaryLedger(result, testCase.injectAt);
      if (testCase.injectAt === 2) {
        expect(result.provider.postComment).not.toHaveBeenCalled();
        expect(result.provider.setLabels).not.toHaveBeenCalled();
      }
      if (!testCase.readError) expect(result.output).toContain('delegated clearance refused');
    },
  );

  it.each(['read failure', 'head movement'])(
    'reports delegated clearance success and warns on post-clearance %s without further writes', failure => {
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const result = run({ accepted: true, repark: true, injectAt: 5,
          readError: failure === 'read failure', movedHead: failure === 'head movement' ? 'b'.repeat(40) : undefined });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.output)).toMatchObject({ to: 'clear-human', decision: { allowed: true } });
        expect(result.output).not.toContain('refused');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('post-clearance'));
        expect(result.provider.readPrState).toHaveBeenCalledTimes(5);
        expect(result.events.slice(result.events.indexOf('blocked-read'))).toEqual(['blocked-read']);
        expect(result.events.filter(event => event.endsWith('write'))).toEqual(['label-write', 'comment-write']);
        expect(result.provider.addLabels).not.toHaveBeenCalled();
        expect(result.provider.removeLabels).not.toHaveBeenCalled();
        expectBoundaryLedger(result, 5);
      } finally { warn.mockRestore(); }
    },
  );

  it('still reasserts an eligible delegated clearance with a matching repark marker', () => {
    const result = run({ accepted: true, repark: true, injectAt: Infinity });
    expect(result.exitCode).toBe(0);
    expect(result.provider.readPrState).toHaveBeenCalledTimes(5);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.setLabels).toHaveBeenCalledTimes(2);
    expect(result.provider.setLabels).toHaveBeenLastCalledWith('o/r', '7', {
      add: 'review:accepted', remove: ['review:human'],
    });
    expect(result.ledger).toHaveLength(2);
    expect(result.ledger[1].type).toBe(EVENT_TYPES.APPROVAL);
    expect(result.holds).toBeNull();
  });

  it('preserves operator reassertion over an operator hold with a matching repark marker', () => {
    const result = run({ delegated: false, accepted: true, repark: true, injectAt: 3,
      evidence: ['review:human', 'review:accepted', 'operator:hold'] });
    expect(result.exitCode).toBe(0);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.setLabels).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('delegated clear-human reaches only enumerated provider writes, excluding mechanical handoff (accepted=%s)', accepted => {
    const result = run({ accepted, repark: true, injectAt: Infinity });
    expect(result.exitCode).toBe(0);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.postComment).toHaveBeenCalledWith('o/r', '7',
      expect.stringContaining(`<!-- reviewed-sha: ${head} -->`));
    expect(result.provider.setLabels.mock.calls).toEqual(Array.from({ length: accepted ? 2 : 1 }, () =>
      ['o/r', '7', { add: 'review:accepted', remove: ['review:human'] }]));
    expect(result.provider.addLabels).not.toHaveBeenCalled();
    expect(result.provider.removeLabels).not.toHaveBeenCalled();
    expect(result.events.filter(event => !event.endsWith('read'))).toEqual(accepted
      ? ['label-write', 'comment-write', 'label-write'] : ['comment-write', 'label-write']);
    expectBoundaryLedger(result, Infinity);
  });

  it.each(['accepted', 'changes', 'restamp', 'rearm'])(
    'refuses delegated flags on %s before mechanical handoff or any durable write', target => {
      const result = run({ target, injectAt: Infinity });
      expect(result.exitCode).toBe(2);
      expect(result.provider.readPrState).not.toHaveBeenCalled();
      expect(result.events).toEqual([]);
      expect(result.ledger).toEqual([]);
    },
  );

  it('refuses delegation expiring between ledger appends before comment or label writes', () => {
    const expiry = Date.parse('2099-01-01T00:00:00Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(expiry - 1);
    try {
      const result = run({ injectAt: Infinity, onRead: read => {
        if (read === 3) now.mockReturnValue(expiry);
      } });
      expect(result.exitCode).toBe(1);
      expectBoundaryLedger(result, 3);
      expect(result.events).toEqual(['eligible-read', 'eligible-read', 'eligible-read']);
      expect(result.output).toContain('delegation expired between ledger appends');
    } finally { now.mockRestore(); }
  });

  it.each(['not-json', 'null', '{}', '[]'])(
    'refuses invalid delegation %s before any PR read or write', delegationJson => {
      const result = run({ args: [`--expect-head=${head}`, `--delegation-json=${delegationJson}`] });
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--delegation-json');
      expect(result.events).toEqual([]);
    },
  );

  it('accepts a full uppercase expected head after normalization', () => {
    const result = run({ args: [`--expect-head=${head.toUpperCase()}`, delegation], injectAt: Infinity });
    expect(result.exitCode).toBe(0);
    expect(result.provider.postComment).toHaveBeenCalledOnce();
    expect(result.provider.setLabels).toHaveBeenCalledOnce();
  });

  it.each(['read failure', 'head movement'])(
    'preserves operator best-effort reassertion on %s', failure => {
      const result = run({ delegated: false, accepted: true, repark: true, injectAt: 3,
        readError: failure === 'read failure', movedHead: failure === 'head movement' ? 'b'.repeat(40) : undefined });
      expect(result.exitCode).toBe(0);
      expect(result.provider.postComment).toHaveBeenCalledOnce();
      expect(result.provider.setLabels).toHaveBeenCalledOnce();
    },
  );

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
