import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCardBatchHold, readCardBatchHolds, SEAL_GRACE_MS, SEAL_RUN_MS } from '../operator-queue-card-batch-holds.mjs';

const policy = { filing: { maxAgeMinutes: 60 } };
const openedAt = '2026-10-20T17:46:24.138Z';
const opened = Date.parse(openedAt);
const active = { kind: 'filing', repo: 'o/n', pr: 5773, batchRef: 'lane/card-batch-filing-4', openedAt, holdApplied: true, members: [{}] };

describe('classifyCardBatchHold', () => {
  it('an accumulating batch inside its age limit plus grace is owned by the seal job', () => {
    expect(classifyCardBatchHold(active, { now: opened + 61_000, policy })).toMatchObject({ status: 'owned', members: 1,
      dueAt: new Date(opened + 60 * 60_000 + SEAL_GRACE_MS).toISOString() });
  });
  it('past the age limit plus grace it is overdue', () => {
    expect(classifyCardBatchHold(active, { now: opened + 60 * 60_000 + SEAL_GRACE_MS + 1, policy }).status).toBe('overdue');
  });
  it('a started seal is owned for the seal lease, then overdue', () => {
    const sealedAt = '2026-10-20T19:00:00.000Z';
    const sealing = { ...active, sealedAt, seal: { reason: 'age', step: 'record-sealed' } };
    expect(classifyCardBatchHold(sealing, { now: Date.parse(sealedAt) + 1, policy }).status).toBe('owned');
    expect(classifyCardBatchHold(sealing, { now: Date.parse(sealedAt) + SEAL_RUN_MS + 1, policy }).status).toBe('overdue');
  });
  it('a recorded seal failure needs a person, with its reason', () => {
    expect(classifyCardBatchHold({ ...active, sealFailure: { reason: 'verify red' } }, { now: opened, policy }))
      .toMatchObject({ status: 'failed', reason: 'verify red' });
  });
  it('a finished seal that still carries the hold is not owned', () => {
    expect(classifyCardBatchHold({ ...active, seal: { step: 'label-on-green' } }, { now: opened, policy }).status).toBe('done');
  });
  it('state with no usable time is not owned', () => {
    expect(classifyCardBatchHold({ ...active, openedAt: undefined }, { now: opened, policy }).status).toBe('overdue');
  });
});

describe('readCardBatchHolds', () => {
  it('reads the active slot and the sealed archive, keys by repo#pr, and lets a failure win over owned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-batch-holds-'));
    mkdirSync(join(dir, 'sealed'));
    writeFileSync(join(dir, 'o-n-filing.json'), JSON.stringify(active));
    writeFileSync(join(dir, 'sealed', 'o-n-3r1-filing.json'), JSON.stringify({ ...active, pr: 5774, sealedAt: openedAt, seal: { reason: 'extracted' } }));
    writeFileSync(join(dir, 'sealed', 'o-n-4-filing.json'), JSON.stringify({ ...active, sealFailure: { reason: 'verify red' } }));
    writeFileSync(join(dir, 'o-n-prevention.json'), JSON.stringify({ seq: 9, lastSealedState: 'x' }));
    writeFileSync(join(dir, 'broken.json'), '{');
    const { holds, errors } = readCardBatchHolds({ stateDir: dir, now: opened + 1, policy });
    expect(holds.get('o/n#5773').status).toBe('failed');
    expect(holds.get('o/n#5774').status).toBe('owned');
    expect(holds.size).toBe(2);
    expect(errors).toHaveLength(1);
  });
  it('a missing state directory is empty, not an error', () => {
    expect(readCardBatchHolds({ stateDir: join(tmpdir(), 'no-such-card-batch-dir-x'), policy }).holds.size).toBe(0);
  });
});
