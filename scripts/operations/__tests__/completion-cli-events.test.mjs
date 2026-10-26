import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendDaemonEvent } from '../../lib/daemon-events.mjs';
import { runReport } from '../completion-cli.mjs';
import {
  applyCompletionUpdate, completionPath, newCompletionRecord, tryReadCompletion, writeCompletion,
} from '../completion-store.mjs';

// Keep even the default-emitter test away from the real daemon event log.
vi.mock('../../lib/daemon-events.mjs', () => ({
  appendDaemonEvent: vi.fn(async () => true),
}));

let dir;
let previousDir;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR, 'we-completion-cli-events-'));
  previousDir = process.env.OPERATION_COMPLETIONS_DIR;
  process.env.OPERATION_COMPLETIONS_DIR = dir;
  vi.clearAllMocks();
});
afterEach(() => {
  if (previousDir === undefined) delete process.env.OPERATION_COMPLETIONS_DIR;
  else process.env.OPERATION_COMPLETIONS_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

const blockedFlags = (patch = {}) => ({
  session: 'fix-42', kind: 'fix', pr: '42', status: 'done',
  outcome: 'blocked-on-permission', denied: 'npm run release', 'session-id': 'owner-A',
  ...patch,
});
const blockedEvent = (command = 'npm run release') => ({
  kind: 'fixer-blocked', pr: '42', detail: { command },
});

function seedBlocked(sessionId, kind = 'fix', session = 'fix-42') {
  const record = applyCompletionUpdate(
    newCompletionRecord({ session, kind, pr: '42', sessionId }),
    { status: 'done', outcome: 'blocked-on-permission', denied: 'old denied command' },
  );
  writeCompletion(record);
  return record;
}

describe('runReport fixer-blocked coordination events', () => {
  it('emits exactly once after the blocked fix completion is readable on disk', () => {
    let observed;
    const emitEvent = vi.fn(() => { observed = tryReadCompletion('fix-42'); });

    const result = runReport(blockedFlags(), { emitEvent });

    expect(result).toEqual({ changed: true, record: expect.objectContaining({
      status: 'done', kind: 'fix', outcome: 'blocked-on-permission', sessionId: 'owner-A',
    }) });
    expect(emitEvent.mock.calls).toEqual([[blockedEvent()]]);
    expect(observed).toEqual(tryReadCompletion('fix-42'));
    expect(observed).toMatchObject(result.record);
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it('defaults emitEvent to appendDaemonEvent', () => {
    const result = runReport(blockedFlags());

    expect(result.changed).toBe(true);
    expect(appendDaemonEvent.mock.calls).toEqual([[blockedEvent()]]);
  });

  it('uses the persisted kind, PR and sanitized denied command when completing a started record', () => {
    const emitEvent = vi.fn();
    runReport({ session: 'fix-42', kind: 'fix', pr: '42', status: 'started', 'session-id': 'owner-A' }, { emitEvent });
    const result = runReport({
      session: 'fix-42', status: 'done', outcome: 'blocked-on-permission',
      denied: 'npm\n run release --token=example-secret', 'session-id': 'owner-A',
    }, { emitEvent });

    expect(result.record.denied).toBe('npm run release --token=[redacted]');
    expect(tryReadCompletion('fix-42').denied).toBe(result.record.denied);
    expect(emitEvent.mock.calls).toEqual([[blockedEvent(result.record.denied)]]);
  });

  it.each([false, true])('emits once for a started ci-heal completion (explicit done kind: %s)', (explicitKind) => {
    const emitEvent = vi.fn();
    runReport({
      session: 'ci-heal-42', kind: 'ci-heal', pr: '42', status: 'started', 'session-id': 'owner-A',
    }, { emitEvent });
    expect(emitEvent).not.toHaveBeenCalled();
    const flags = {
      session: 'ci-heal-42', status: 'done', outcome: 'blocked-on-permission',
      denied: 'git push', 'session-id': 'owner-A',
      ...(explicitKind ? { kind: 'ci-heal' } : {}),
    };
    const result = runReport(flags, { emitEvent });

    expect(result.record).toMatchObject({ kind: 'ci-heal', status: 'done', sessionId: 'owner-A' });
    expect(tryReadCompletion('ci-heal-42')).toMatchObject(result.record);
    expect(emitEvent.mock.calls).toEqual([[blockedEvent('git push')]]);
    runReport(flags, { emitEvent });
    expect(emitEvent.mock.calls).toEqual([[blockedEvent('git push')]]);
  });

  it.each([
    ['fix', 'owner-A'], ['fix', null], ['ci-heal', 'owner-A'], ['ci-heal', null],
  ])('suppresses a re-report using the previous on-disk blocked record (kind %s, sessionId %s)', (kind, sessionId) => {
    const session = `${kind}-42`;
    seedBlocked(sessionId, kind, session);
    const emitEvent = vi.fn();
    const result = runReport(blockedFlags({ session, kind, 'session-id': sessionId ?? '', denied: 'different denied command' }), { emitEvent });

    expect(result.changed).toBe(true);
    expect(tryReadCompletion(session)).toMatchObject({
      outcome: 'blocked-on-permission', sessionId, denied: 'different denied command',
    });
    expect(emitEvent).not.toHaveBeenCalled();
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it('does not suppress a blocked legacy record adopting a different, identified session', () => {
    seedBlocked(null);
    const emitEvent = vi.fn();
    const result = runReport(blockedFlags(), { emitEvent });

    expect(result.record.sessionId).toBe('owner-A');
    expect(emitEvent.mock.calls).toEqual([[blockedEvent()]]);
  });

  it('emits once across repeated done reports from the same session', () => {
    const emitEvent = vi.fn();
    runReport(blockedFlags(), { emitEvent });
    runReport(blockedFlags(), { emitEvent });

    expect(emitEvent.mock.calls).toEqual([[blockedEvent()]]);
  });

  it.each(['fix', 'ci-heal'])('emits again for a new generation reusing the same %s session slug', (kind) => {
    const session = `${kind}-42`;
    seedBlocked('owner-A', kind, session);
    const emitEvent = vi.fn();
    runReport({ session, kind, pr: '42', status: 'started', 'session-id': 'owner-B' }, { emitEvent });
    expect(emitEvent).not.toHaveBeenCalled();
    const result = runReport(blockedFlags({ session, kind, 'session-id': 'owner-B' }), { emitEvent });

    expect(result.record.sessionId).toBe('owner-B');
    expect(emitEvent.mock.calls).toEqual([[blockedEvent()]]);
  });

  it('emits when the same owner changes from another outcome to blocked-on-permission', () => {
    const emitEvent = vi.fn();
    runReport(blockedFlags({ outcome: 'gate-red' }), { emitEvent });
    expect(emitEvent).not.toHaveBeenCalled();
    runReport(blockedFlags(), { emitEvent });

    expect(emitEvent.mock.calls).toEqual([[blockedEvent()]]);
  });

  it.each(['accepted', 'gate-red', 'blocked-on-infra', 'unreported-exit'])('does not emit for outcome %s', (outcome) => {
    const emitEvent = vi.fn();
    const result = runReport(blockedFlags({ outcome }), { emitEvent });

    expect(result.changed).toBe(true);
    expect(tryReadCompletion('fix-42').outcome).toBe(outcome);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it('does not emit for a started report even if its flags contain the blocked outcome', () => {
    const emitEvent = vi.fn();
    const result = runReport(blockedFlags({ status: 'started' }), { emitEvent });

    expect(result.record.status).toBe('started');
    expect(emitEvent).not.toHaveBeenCalled();
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it('does not emit for a review record, even with a fix-shaped session slug', () => {
    const emitEvent = vi.fn();
    runReport({ session: 'fix-42', kind: 'review', pr: '42', status: 'started', 'session-id': 'owner-A' }, { emitEvent });
    const result = runReport(blockedFlags(), { emitEvent });

    expect(result.record.kind).toBe('review');
    expect(result.record.outcome).toBe('blocked-on-permission');
    expect(emitEvent).not.toHaveBeenCalled();
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it.each(['owner-B', ''])('refuses a foreign or anonymous report without emitting (incoming id %s)', (incomingId) => {
    const emitEvent = vi.fn();
    runReport({ session: 'fix-42', kind: 'fix', pr: '42', status: 'started', 'session-id': 'owner-A' }, { emitEvent });
    const before = tryReadCompletion('fix-42');
    const result = runReport(blockedFlags({ 'session-id': incomingId }), { emitEvent });

    expect(result).toMatchObject({ changed: false, refused: true });
    expect(tryReadCompletion('fix-42')).toEqual(before);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it('fails closed on an unreadable completion record without emitting', () => {
    writeFileSync(completionPath('fix-42'), '{invalid json');
    const emitEvent = vi.fn();

    expect(() => runReport(blockedFlags(), { emitEvent })).toThrow(/refusing to read completion record/);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(appendDaemonEvent).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'])('preserves the successful report result when emitEvent fails via %s', async (failure) => {
    const error = new Error('event sink unavailable');
    const emitEvent = failure === 'throw'
      ? vi.fn(() => { throw error; })
      : vi.fn(() => Promise.reject(error));

    const result = runReport(blockedFlags(), { emitEvent });
    // Drain the rejected emitter's microtasks so an unhandled rejection also fails this test run.
    await setImmediate();

    expect(result).toEqual({ changed: true, record: expect.objectContaining({
      status: 'done', outcome: 'blocked-on-permission', denied: 'npm run release',
    }) });
    expect(tryReadCompletion('fix-42')).toMatchObject(result.record);
    expect(emitEvent.mock.calls).toEqual([[blockedEvent()]]);
  });
});
