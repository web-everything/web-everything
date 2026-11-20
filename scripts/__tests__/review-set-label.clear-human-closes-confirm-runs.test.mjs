import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeConfirmRunsAfterClearance } from '../review-set-label.mjs';

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const run = (id0, { pr = 7, repo = REPO, rev = HEAD, kind = 'confirm', step = kind, confirm, effects } = {}) => ({
  v: 1, id: id0.startsWith('review-pr-') || id0 === 'other' ? id0 : `review-pr-${id0}`, op: 'review-pr', input: { pr, repo },
  findings: { read: { netBasis: { rev } }, ...(confirm === undefined ? {} : { confirm }) },
  pending: kind ? { kind, step } : null,
  ...(effects === undefined ? {} : { effects }),
});

const ledgerEffect = (overrides = {}) => ({
  type: 'review.ledger-events', status: 'pending', step: 'ledgerEvents',
  lastAttemptBy: 'human', humanAttempts: 1, ...overrides,
});

const ledgerRun = (id, options = {}) => run(id, {
  kind: 'effect', step: 'ledgerEvents', confirm: 'abstain',
  effects: [ledgerEffect()],
  ...options,
});

describe('clear-human closes open confirm runs (live: #6381 #6595 #6637 #6633)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'confirm-runs-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = r => writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r));

  it('ids restricts settlement to indexed runs and leaves an unlisted stuck run untouched', () => {
    put(ledgerRun('listed'));
    put(ledgerRun('unlisted'));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir,
      ids: ['review-pr-listed'], resumeEffect: id => { calls.push(id); return true; } });
    expect(calls).toEqual(['review-pr-listed']);
    expect(out).toEqual({ closed: ['review-pr-listed'], failed: [] });
  });

  it('ids does not resume a pending effect other than ledgerEvents', () => {
    put(ledgerRun('otherstep', { step: 'advisoryLabel' }));
    const calls = [];
    const resume = id => { calls.push(id); return true; };
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir,
      ids: ['review-pr-otherstep'], resume, resumeEffect: resume });
    expect(calls).toEqual([]);
    expect(out).toEqual({ closed: [], failed: [] });
  });

  it('empty ids never falls back to scanning the run store', () => {
    put(ledgerRun('unlisted'));
    const calls = [];
    expect(closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, ids: [],
      resumeEffect: id => { calls.push(id); return true; } })).toEqual({ closed: [], failed: [] });
    expect(calls).toEqual([]);
  });

  it('human accept settles the needs-human run', () => {
    put(ledgerRun('91368953'));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir,
      resume: () => { throw new Error('effect resume must not answer again'); },
      resumeEffect: id => { calls.push(id); return true; } });
    expect(calls).toEqual(['review-pr-91368953']);
    expect(out).toEqual({ closed: ['review-pr-91368953'], failed: [] });
  });

  it.each([
    ['different head', { rev: OTHER }],
    ['different PR', { pr: 8 }],
    ['different repo', { repo: 'x/y' }],
    ['non-abstain answer', { confirm: 'accepted' }],
    ['missing answer', { confirm: undefined }],
    ['different pending step', { step: 'advisoryLabel' }],
    ...['declared', 'failed', 'pending', 'in-flight', 'refused', 'unknown', undefined].map(status => [`another ${status} effect type`, {
      effects: [
        ledgerEffect(),
        { type: 'review.advisory-label', status },
      ],
    }]),
    ...[
      { humanAttempts: 0, lastAttemptBy: 'auto' },
      { humanAttempts: 0 },
      { lastAttemptBy: 'auto' },
      { humanAttempts: undefined, lastAttemptBy: undefined },
    ].map(proof => [`no human abstain attempt proof ${JSON.stringify(proof)}`, { effects: [ledgerEffect(proof)] }]),
    ...['in-flight', 'refused', 'applied'].map(status => [`no pending ledger effect (${status})`, {
      effects: [ledgerEffect({ status })],
    }]),
    ['wrong ledger effect step', { effects: [ledgerEffect({ step: 'advisoryLabel' })] }],
    ['empty effects', { effects: [] }],
    ['only applied non-ledger effects', { effects: [{ type: 'review.advisory-label', status: 'applied' }] }],
    ['missing effects', { effects: undefined }],
    ['invalid effects', { effects: {} }],
  ])('leaves a ledger effect with %s untouched', (_label, options) => {
    put(ledgerRun('held', options));
    const calls = [];
    const resume = id => { calls.push(id); return true; };
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume, resumeEffect: resume });
    expect(calls).toEqual([]);
    expect(out).toEqual({ closed: [], failed: [] });
  });

  it('settles a pending human-attempted ledger effect with applied sibling and case-insensitive head matching', () => {
    put(ledgerRun('retry', { rev: HEAD.toUpperCase(), effects: [
      ledgerEffect(),
      { type: 'review.advisory-label', status: 'applied' },
    ] }));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir,
      resumeEffect: id => { calls.push(id); return true; } });
    expect(calls).toEqual(['review-pr-retry']);
    expect(out.closed).toEqual(calls);
  });

  it('ignores unreadable and invalid JSON ledger runs', () => {
    symlinkSync(join(dir, 'missing.json'), join(dir, 'review-pr-unreadable.json'));
    writeFileSync(join(dir, 'review-pr-invalid.json'), `{"confirm":"abstain","head":"${HEAD}",`);
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir,
      resumeEffect: id => { calls.push(id); return true; } });
    expect(calls).toEqual([]);
    expect(out).toEqual({ closed: [], failed: [] });
  });

  it.each(['', 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40)])('does not settle ledger effects for invalid headSha %j', headSha => {
    put(ledgerRun('invalidhead', { rev: headSha }));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha, dir,
      resumeEffect: id => { calls.push(id); return true; } });
    expect(calls).toEqual([]);
    expect(out).toEqual({ closed: [], failed: [] });
  });

  it('reports a failed ledger effect resume as not closed', () => {
    put(ledgerRun('failed'));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir,
      resumeEffect: id => { calls.push(id); return false; } });
    expect(calls).toEqual(['review-pr-failed']);
    expect(out).toEqual({ closed: [], failed: ['review-pr-failed'] });
  });

  it('abstains the confirm run of the cleared PR at the cleared head', () => {
    put(run('same'));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: id => { calls.push(id); return true; } });
    expect(calls).toEqual(['review-pr-same']);
    expect(out.closed).toEqual(['review-pr-same']);
  });

  it('leaves a confirm run on a different head, another PR, another repo, or a non-confirm pending ask open', () => {
    put(run('otherhead', { rev: OTHER }));
    put(run('otherpr', { pr: 8 }));
    put(run('otherrepo', { repo: 'x/y' }));
    put(run('effect', { kind: 'effect' }));
    put(run('done', { kind: null }));
    const calls = [];
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: id => { calls.push(id); return true; } });
    expect(calls).toEqual([]);
    expect(out.closed).toEqual([]);
  });

  it('ignores a record whose id does not match its filename', () => {
    writeFileSync(join(dir, 'review-pr-forged.json'), JSON.stringify(run('other')));
    const calls = [];
    closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: id => { calls.push(id); return true; } });
    expect(calls).toEqual([]);
  });

  it('does nothing without a full head sha and reports a failed abstain as not closed', () => {
    put(run('same'));
    expect(closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: '', dir, resume: () => true }).closed).toEqual([]);
    const out = closeConfirmRunsAfterClearance({ repo: REPO, pr: 7, headSha: HEAD, dir, resume: () => false });
    expect(out.closed).toEqual([]);
    expect(out.failed).toEqual(['review-pr-same']);
  });
});
