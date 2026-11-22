import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBlockedChecks, decideGateSendBack, sendBackBlockedGate, sendBackBlockedGates } from '../drain-blocked-reason.mjs';
import { classifyPr, unlandableStateReason } from '../../merge-ai-prs.mjs';
import { classifySkipReason } from '../drain-skip-reasons.mjs';
import { FAILED_CHECK_CONCLUSIONS } from '../rollup-collapse.mjs';

const head = 'a'.repeat(40);
const requiredChecks = ['test', 'merge-gate'];
const row = (name, conclusion = 'SUCCESS', extra = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, ...extra });
const fixture = (extra = {}) => ({ number: 7196, headRefOid: head, baseRefName: 'main', body: 'Fix the gate.', title: 'Gate',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  rowsComplete: true, rowsHead: head, statusCheckRollup: [row('test'), row('merge-gate', 'FAILURE', { summary: '\n test-gaming\nignored second line' })], ...extra });
const opts = { defaultBranch: 'main', queueRequiredChecks: requiredChecks };
const decision = (pr = fixture(), ledger = {}) => decideGateSendBack({ pr, headSha: pr.headRefOid, requiredChecks, ledger });

describe('BLOCKED required-check evidence', () => {
  it('names the failed check and first non-empty summary line', () => {
    expect(describeBlockedChecks(fixture(), requiredChecks)).toEqual({ failed: ['required check "merge-gate" FAILURE: test-gaming'], waiting: [], text: 'required check "merge-gate" FAILURE: test-gaming' });
  });
  it.each(FAILED_CHECK_CONCLUSIONS)('recognizes %s as failed', conclusion => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [row('merge-gate', conclusion)] }), ['merge-gate']).failed[0]).toContain(conclusion);
  });
  it('uses title then description when summary has no non-empty line', () => {
    const pr = fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE', { summary: '  ', title: '\n title\nmore', description: 'description' })] });
    expect(describeBlockedChecks(pr, ['merge-gate']).text).toBe('required check "merge-gate" FAILURE: title');
    pr.statusCheckRollup[0].title = '';
    expect(describeBlockedChecks(pr, ['merge-gate']).text).toContain(': description');
  });
  it.each(['IN_PROGRESS', 'QUEUED', 'PENDING'])('reports %s as waiting', status => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [row('merge-gate', null, { status })] }), ['merge-gate']).text).toBe(`waiting on required check "merge-gate" (${status})`);
  });
  it('reports an absent required check as waiting', () => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [] }), ['merge-gate']).text).toBe('waiting on required check "merge-gate" (absent)');
  });
  it('uses the latest run rather than an old failure', () => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE', { completedAt: '2026-01-01' }), row('merge-gate', 'SUCCESS', { completedAt: '2026-02-01' })] }), ['merge-gate']).failed).toEqual([]);
  });
  it.each([false, true])('a newer untimestamped queued replacement supersedes an older timestamped failure without send-back (reverse=%s)', reverse => {
    const older = row('merge-gate', 'FAILURE', { id: 100, completedAt: '2026-01-01T00:00:00Z', summary: 'old failure' });
    const replacement = row('merge-gate', null, { id: 101, status: 'QUEUED' });
    const pr = fixture({ statusCheckRollup: [row('test'), ...(reverse ? [replacement, older] : [older, replacement])] });
    expect(describeBlockedChecks(pr, requiredChecks)).toEqual({ failed: [],
      waiting: ['waiting on required check "merge-gate" (QUEUED)'], text: 'waiting on required check "merge-gate" (QUEUED)' });
    expect(decision(pr)).toEqual({ send: false });
  });
  it('treats an untimestamped queued rollup replacement without run IDs as waiting with no send-back', () => {
    const pr = fixture({ statusCheckRollup: [row('test'),
      row('merge-gate', 'FAILURE', { completedAt: '2026-01-01T00:00:00Z' }),
      row('merge-gate', null, { status: 'QUEUED' })] });
    expect(describeBlockedChecks(pr, requiredChecks).failed).toEqual([]);
    expect(describeBlockedChecks(pr, requiredChecks).text).toBe('waiting on required check "merge-gate" (QUEUED)');
    expect(decision(pr)).toEqual({ send: false });
  });
  it('uses run identity over timestamp availability when a newer failure supersedes an older queued run', () => {
    const pr = fixture({ statusCheckRollup: [row('test'),
      row('merge-gate', 'FAILURE', { id: 101, completedAt: '2026-01-01T00:00:00Z' }),
      row('merge-gate', null, { id: 100, status: 'QUEUED' })] });
    expect(describeBlockedChecks(pr, requiredChecks).failed).toEqual(['required check "merge-gate" FAILURE']);
    expect(decision(pr).send).toBe(true);
  });
  it.each([null, {}, { statusCheckRollup: 'bad' }, { statusCheckRollup: [null] }, { statusCheckRollup: [{ name: 'merge-gate', status: 'ALIEN' }] }])('retains the old reason on unreadable/odd evidence %j', pr => {
    expect(describeBlockedChecks(pr, requiredChecks)).toBeNull();
  });
  it('never throws on hostile accessors or invalid requirements', () => {
    expect(describeBlockedChecks({ get statusCheckRollup() { throw Error('unreadable'); } }, requiredChecks)).toBeNull();
    for (const required of [null, [], [42], ['']]) expect(describeBlockedChecks(fixture(), required)).toBeNull();
  });
  it('never merges or enqueues a failed required check, including prestage mode', () => {
    for (const preparePendingCi of [false, true]) {
      const result = classifyPr(fixture(), { ...opts, preparePendingCi });
      expect(result.decision).toBe('skip');
      expect(result.queueBlockedRelief).toBeUndefined();
      expect(result.reason).toContain(unlandableStateReason('BLOCKED') + '; required check "merge-gate" FAILURE: test-gaming');
      expect(classifySkipReason(result.reason)).toBe('checks-failed');
    }
  });
  it('classifies waiting as checks-pending', () => {
    const pr = fixture({ statusCheckRollup: [row('test'), row('merge-gate', null, { status: 'IN_PROGRESS' })] });
    expect(classifyPr(pr, opts).reason).toContain('waiting on required check "merge-gate" (IN_PROGRESS)');
    expect(classifySkipReason(classifyPr(pr, opts).reason)).toBe('checks-pending');
  });
});

describe('gate send-back', () => {
  it('requires a ready label and red required check', () => {
    expect(decision()).toEqual({ send: true, body: 'required check "merge-gate" FAILURE: test-gaming' });
    expect(decision(fixture({ labels: [] })).send).toBe(false);
    expect(decision(fixture({ statusCheckRollup: [row('test'), row('merge-gate', null, { status: 'IN_PROGRESS' })] })).send).toBe(false);
  });
  it.each(['abc', '', 'z'.repeat(40)])('refuses non-40-hex head %s', headSha => {
    expect(decideGateSendBack({ pr: fixture(), headSha, requiredChecks, ledger: {} }).send).toBe(false);
  });
  it('refuses a moved head or unreadable ledger', () => {
    expect(decideGateSendBack({ pr: fixture(), headSha: 'b'.repeat(40), requiredChecks, ledger: {} }).send).toBe(false);
    expect(decision(fixture(), null).send).toBe(false);
  });
  function withLedger(run) {
    const dir = mkdtempSync(join(tmpdir(), 'drain-blocked-'));
    try { run(join(dir, 'ledger.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('never clears a hold: invokes only --to=changes and records only after success, once per head', () => withLedger(ledgerPath => {
    const pr = fixture({ labels: [...fixture().labels, { name: 'review:human' }, { name: 'review:changes' }, { name: 'review:held-mechanical' }] });
    const exec = vi.fn((command, argv, options) => {
      expect(command).toBe(process.execPath);
      expect(argv.filter(a => a.startsWith('--to='))).toEqual(['--to=changes']);
      expect(argv).not.toEqual(expect.arrayContaining([expect.stringMatching(/--(?:remove|add)-label/)]));
      expect(argv).toContain('--repo=o/r');
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(readFileSync(argv.find(a => a.startsWith('--body-file=')).slice(12), 'utf8')).toBe(decision().body);
      if (exec.mock.calls.length === 1) expect(existsSync(ledgerPath)).toBe(false);
      return { status: 0 };
    });
    const run = p => sendBackBlockedGate({ pr: p, headSha: p.headRefOid, requiredChecks, repo: 'o/r', ledgerPath, exec });
    expect(run(pr).sent).toBe(true);
    expect(run(pr).sent).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(run({ ...pr, headRefOid: 'b'.repeat(40) }).sent).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(run(pr).sent).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(readFileSync(ledgerPath, 'utf8')).toContain('b'.repeat(40));
  }));
  it.each(['nonzero', 'throw'])('does not record the head when review-set-label fails: %s', mode => withLedger(ledgerPath => {
    const exec = vi.fn(() => { if (mode === 'throw') throw Error('failed'); return { status: 1 }; });
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }).sent).toBe(false);
    expect(existsSync(ledgerPath)).toBe(false);
  }));
  it('runs send-back at the BLOCKED skip pass with injected exec, leaving red PRs skipped', () => withLedger(ledgerPath => {
    const pr = fixture();
    const verdict = { ...classifyPr(pr, opts), repo: null, listedHeadSha: head };
    const exec = vi.fn(() => ({ status: 0 }));
    const outcomes = sendBackBlockedGates({ prsByRepo: new Map([[null, [pr]]]), verdicts: [verdict],
      requiredChecksOf: () => requiredChecks, localSlug: 'o/r', cwdOf: () => undefined, ledgerPath, exec });
    expect(outcomes).toEqual([{ num: pr.number, repo: null, sent: true, recorded: true }]);
    expect(verdict.decision).toBe('skip');
    expect(exec).toHaveBeenCalledOnce();
  }));
  it('reports ledger persistence failure after a successful send-back for operator repair', () => withLedger(ledgerPath => {
    const exec = vi.fn(() => {
      // Make the destination unwritable as a file after the successful CLI response.
      mkdirSync(ledgerPath); return { status: 0 }; });
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }))
      .toMatchObject({ sent: true, recorded: false, reason: expect.stringContaining('operator must repair') });
  }));
  it('refuses a corrupt persisted ledger without invoking the CLI', () => withLedger(ledgerPath => {
    writeFileSync(ledgerPath, 'broken');
    const exec = vi.fn();
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }).sent).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  }));
});
