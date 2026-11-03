/** 2026-11-03: #6244/#6262 fix claims were heartbeated for hours by a LIVE but idle fixer session. Idle-head release
 *  read `state === 'idle'`, but real `claude agents` rows are `state:'working'` + `status:'idle'`, so it never fired. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export default {
  id: 'idle-status-fixer-claim-never-released',
  title: 'a live fixer at status:idle with an unmoved PR head kept its fix claim for hours (idle release only read state:idle)',
  card: 'we:backlog (delivery fix 2026-11-03, #6244/#6262)',
  fixedBy: { sha: 'f432496da8', where: 'lane/claim-liveness-idle-pid-reuse', paths: ['scripts/conveyor/fix-dispatch-claim.mjs'] },
  // The fix ships in the SAME change as this break, so the scenario is always required GREEN: reverting the fix turns it red.
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const m = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-dispatch-claim.mjs')).href);
    const lockRoot = mkdtempSync(join(tmpdir(), 'idle-claim-soak-'));
    const T0 = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    try {
      m.acquireFixDispatchClaim({ repo: 'we', pr: 6244, kind: 'fix', headSha: 'sha1', owner: 'Mac:1', lockRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 20 });
      const rows = [{ name: 'fix-6244', state: 'working', status: 'idle', startedAt: T0 + 1000 }];
      const released = [];
      for (let t = T0 + 60_000; t <= T0 + 60_000 + 35 * 60_000; t += 120_000) {
        const r = m.refreshLiveFixDispatchClaims({
          lockRoot, listAgentsAll: () => rows, hungInfoFor: () => null, awaitingVerifyFor: null, activityMsFor: () => 0,
          prHeadFor: () => 'sha1', recordEvent: () => {}, nowIso: () => iso(t),
          idleRelease: { enabled: true, idleMinutes: 30, sources: { enabled: 'soak', idleMinutes: 'soak' }, invalid: [] },
        });
        released.push(...(r.released ?? []));
      }
      const violations = released.length === 1 ? [] : [`idle fixer claim not released after 35 min with an unmoved head (released=${released.length})`];
      return { violations };
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
