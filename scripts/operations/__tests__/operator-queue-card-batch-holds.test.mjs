import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCardBatchHold, fixerWithdrawalEvidence, FIX_BEGIN_COMMENT_LEAD, readCardBatchHolds, SEAL_GRACE_MS } from '../operator-queue-card-batch-holds.mjs';
import { FIX_BEGIN_MARKER } from '../../conveyor/fix-procedure.mjs';

const policy = { filing: { maxAgeMinutes: 60, maxCards: 3 } };
const openedAt = '2026-10-20T17:46:24.138Z';
const opened = Date.parse(openedAt);
const MIN = 60_000;
const active = { kind: 'filing', repo: 'o/n', pr: 5773, batchRef: 'lane/card-batch-filing-4', headSha: 'e'.repeat(40), openedAt,
  holdApplied: true, members: [{ admittedAt: openedAt }] };

describe('classifyCardBatchHold', () => {
  it('an accumulating batch inside its age limit plus grace is owned by the seal job', () => {
    expect(classifyCardBatchHold(active, { now: opened + MIN, policy })).toMatchObject({ status: 'owned', members: 1,
      headSha: 'e'.repeat(40), dueAt: new Date(opened + 60 * MIN + SEAL_GRACE_MS).toISOString() });
  });
  it('past the age limit plus grace, with no live worker, it is overdue', () => {
    expect(classifyCardBatchHold(active, { now: opened + 60 * MIN + SEAL_GRACE_MS + 1, policy }).status).toBe('overdue');
  });
  it('a full batch is owed a seal from its last admission (count beats age)', () => {
    const last = opened + 5 * MIN;
    const full = { ...active, members: [{ admittedAt: openedAt }, {}, { admittedAt: new Date(last).toISOString() }] };
    expect(classifyCardBatchHold(full, { now: last + SEAL_GRACE_MS - 1, policy }).status).toBe('owned');
    expect(classifyCardBatchHold(full, { now: last + SEAL_GRACE_MS + 1, policy }).status).toBe('overdue');
  });
  it('a live lease lock owns it until the lock ends, then the relaunch grace starts from that lease', () => {
    const sealedAt = opened + 61 * MIN;
    const sealing = { ...active, sealedAt: new Date(sealedAt).toISOString(), seal: { reason: 'age', step: 'record-sealed' } };
    const lockExpiresAt = sealedAt + 3 * 60 * MIN;
    expect(classifyCardBatchHold(sealing, { now: sealedAt + 2 * 60 * MIN, policy, lockExpiresAt }).status).toBe('owned');
    // A crashed worker: the lease ran out; the scheduler has the grace to relaunch, then it is overdue.
    expect(classifyCardBatchHold(sealing, { now: lockExpiresAt + SEAL_GRACE_MS - 1, policy, lockExpiresAt }).status).toBe('owned');
    expect(classifyCardBatchHold(sealing, { now: lockExpiresAt + SEAL_GRACE_MS + 1, policy, lockExpiresAt }).status).toBe('overdue');
    // Without any lease, a started seal gets only the grace.
    expect(classifyCardBatchHold(sealing, { now: sealedAt + SEAL_GRACE_MS + 1, policy }).status).toBe('overdue');
  });
  it('a recorded seal failure needs a person, with its reason', () => {
    expect(classifyCardBatchHold({ ...active, sealFailure: { reason: 'verify red' } }, { now: opened, policy }))
      .toMatchObject({ status: 'failed', reason: 'verify red' });
  });
  it.each(['remove-hold', 'ready', 'label-on-green'])('once the seal reached %s the hold is no longer the batch\'s', (step) => {
    expect(classifyCardBatchHold({ ...active, sealedAt: openedAt, seal: { step } }, { now: opened, policy }).status).toBe('done');
  });
  it('a state that never recorded its hold, or has no usable time, is not owned', () => {
    expect(classifyCardBatchHold({ ...active, holdApplied: false }, { now: opened, policy }).status).toBe('overdue');
    expect(classifyCardBatchHold({ ...active, openedAt: undefined, members: [] }, { now: opened, policy }).status).toBe('overdue');
  });
});

describe('readCardBatchHolds', () => {
  it('reads the active slot and the sealed archive, keys by repo#pr, and lets a failure win over owned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-batch-holds-'));
    mkdirSync(join(dir, 'sealed'));
    writeFileSync(join(dir, 'o-n-filing.json'), JSON.stringify(active));
    writeFileSync(join(dir, 'sealed', 'o-n-5-filing.json'), JSON.stringify({ ...active, pr: 5775, sealedAt: openedAt, seal: { step: 'record-sealed' } }));
    writeFileSync(join(dir, 'sealed', 'o-n-5-filing.json.lock'), JSON.stringify({ owner: 'seal:1', expiresAt: opened + 120 * MIN, token: 't' }));
    writeFileSync(join(dir, 'sealed', 'o-n-3r1-filing.json'), JSON.stringify({ ...active, pr: 5774, sealedAt: openedAt, seal: { reason: 'extracted' } }));
    writeFileSync(join(dir, 'sealed', 'o-n-4-filing.json'), JSON.stringify({ ...active, sealFailure: { reason: 'verify red' } }));
    writeFileSync(join(dir, 'o-n-prevention.json'), JSON.stringify({ seq: 9, lastSealedState: 'x' }));
    writeFileSync(join(dir, 'broken.json'), '{');
    const { holds, errors } = readCardBatchHolds({ stateDir: dir, now: opened + 1, policy });
    const later = readCardBatchHolds({ stateDir: dir, now: opened + 90 * MIN, policy }).holds;
    expect(later.get('o/n#5775').status).toBe('owned');
    expect(holds.get('o/n#5773').status).toBe('failed');
    expect(holds.get('o/n#5774').status).toBe('owned');
    expect(holds.size).toBe(3);
    expect(errors).toHaveLength(1);
  });
  it('a missing state directory is empty, not an error', () => {
    expect(readCardBatchHolds({ stateDir: join(tmpdir(), 'no-such-card-batch-dir-x'), policy }).holds.size).toBe(0);
  });
});

describe('fixerWithdrawalEvidence', () => {
  const label = 'review-status:draft-withdrawn';
  const clean = { claims: [{ kind: 'fixing', entry: null }, { kind: 'fix', entry: null }], comments: [],
    labelEvents: [{ event: 'labeled', label: 'review:pending', actor: 'bot' }, { event: 'labeled', label, actor: 'chalbert' }],
    sealActors: ['chalbert'], label };
  it('a clean read (one seal-actor label event, no claim, no fix-begin comment) is no evidence', () => {
    expect(fixerWithdrawalEvidence(clean)).toBeNull();
  });
  it('keeps the comment lead in step with fix-procedure', () => { expect(FIX_BEGIN_COMMENT_LEAD).toBe(FIX_BEGIN_MARKER); });
  it.each([
    ['a fix claim', { claims: [{ kind: 'fixing', entry: { owner: 'fix:x', meta: { who: 'fixer-1', draft: true, reason: 'withdrawn' } } }] }, 'fixer-1'],
    ['an unreadable claim', { claims: [{ kind: 'fixing', entry: 'unreadable' }] }, 'unreadable'],
    ['an unreadable claim ledger', { claims: null }, 'unreadable'],
    ['a fix-begin --draft --reason=withdrawn comment', { comments: [{ body: `${FIX_BEGIN_MARKER}\n\nThe PR is now **draft** (\`withdrawn\`)` }] }, 'fix-begin'],
    ['unreadable comments', { comments: null }, 'comments unreadable'],
    ['a non-seal actor on the label', { labelEvents: [{ event: 'labeled', label, actor: 'plateau-worker[bot]' }] }, 'plateau-worker[bot]'],
    ['a removed-and-re-added label', { labelEvents: [...clean.labelEvents, { event: 'unlabeled', label, actor: 'chalbert' }, { event: 'labeled', label, actor: 'chalbert' }] }, 're-added'],
    ['no label event', { labelEvents: [] }, '0 times'],
    ['unreadable label history', { labelEvents: null }, 'unreadable'],
  ])('%s is evidence', (_name, override, text) => {
    expect(fixerWithdrawalEvidence({ ...clean, ...override })).toContain(text);
  });
});
