/**
 * @description A DEFERRED open-PR read means "owed unknown", never "nothing owed": the ci-heal pass skips the tick —
 * no timeout rerun, no dispatch, no unsupported-row rewrite that would release rows the unread PRs still owe.
 */
import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReconcileCiHealDispatch } from '../ci-heal-pr-dispatch.mjs';

const FRESH = () => ({ fresh: true, behind: 0 });
const deferred = { outcome: 'deferred-low-budget', deferred: true, message: 'author lookup throttled', dispatch: [], refusals: [], notes: [], prs: 0, agents: 0 };

it('a deferred read skips the tick: no rerun, no dispatch, existing unsupported rows untouched, deferral logged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-heal-deferred-'));
  const unsupportedPath = join(dir, 'unsupported.json');
  // An already-recorded owed row for this repo (ci-heal) and for a different stage (fix): both must survive a deferred read.
  const seeded = JSON.stringify([
    { kind: 'unsupported-repo', repo: 'we', prNumber: 11, action: 'ci-heal', at: '2026-11-01T00:00:00.000Z' },
    { kind: 'unsupported-repo', repo: 'we', prNumber: 12, action: 'fix', at: '2026-11-01T00:00:00.000Z' },
  ], null, 2);
  writeFileSync(unsupportedPath, seeded);
  const dispatch = vi.fn(); const retryTimeout = vi.fn();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const out = await runReconcileCiHealDispatch({ checkStaleness: FRESH, reconcile: () => deferred, flushOwed: () => ({}),
      pollAttempts: () => [], flushTimeouts: async () => [], pickFreeLanes: () => [], dispatch, retryTimeout, unsupportedPath });
    expect(out.dispatched).toEqual([]);
    expect(out.refusals).toEqual([]);
    expect(out.readDeferred).toMatch(/author lookup throttled/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(retryTimeout).not.toHaveBeenCalled();
    expect(readFileSync(unsupportedPath, 'utf8')).toBe(seeded); // not rewritten: the unread PRs still owe these rows
    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/open-PR read deferred/);
    expect(logged).toMatch(/owed unknown/);
    expect(logged).toMatch(/author lookup throttled/);
  } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
