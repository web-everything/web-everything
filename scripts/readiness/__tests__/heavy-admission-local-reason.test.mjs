// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localReasonFor, recordLocalReason } from '../heavy-admission.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('R830/R823: every local run records a reason', () => {
  it('maps each local path to a non-empty reason', () => {
    expect(localReasonFor({ forceLocal: true })).toBe('local-flag');
    expect(localReasonFor({ useContainer: true })).toBe('local-container');
    expect(localReasonFor({ bypass: 'held' })).toBe('local-admission-held');
    expect(localReasonFor({ decisionReason: 'remote.enabled=false (standard)' })).toBe('local-remote-disabled');
    expect(localReasonFor({ decisionReason: 'remote.enabled=true; loadPerCore=1 <= 2' })).toBe('local-below-threshold');
    expect(localReasonFor({ decisionReason: 'remote.enabled=true; load-unreadable' })).toBe('local-load-unreadable');
    expect(localReasonFor({})).not.toBe('');
  });

  it('writes a remote-fallbacks row for a local-by-design run', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'local-reason-'));
    roots.push(lockRoot);
    recordLocalReason({ lockRoot, reason: localReasonFor({ forceLocal: true }), cwd: '/x/lane-9', argv: ['vitest', 'run', 'a.test.mjs'], env: {}, clock: Date.now });
    const row = JSON.parse(readFileSync(join(lockRoot, 'remote-fallbacks.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ reason: 'local-flag', lane: 'lane-9' });
    expect(row.kind).toBeTruthy();
  });
});
