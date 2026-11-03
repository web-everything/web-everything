/** 2026-11-03: #6244/#6262 fix claims were heartbeated for hours by a LIVE but idle fixer session. Idle-head release
 *  read `state === 'idle'`, but real `claude agents` rows are `state:'working'` + `status:'idle'`, so it never fired. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const hung = await import(pathToFileURL(join(root, 'scripts/conveyor/hung-session.mjs')).href);
    // Fixture transcripts: the REAL tail reader and the REAL activity policy run over them; only the path lookup is pinned.
    const line = (ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
    const goodFile = join(lockRoot, 'good.jsonl');
    writeFileSync(goodFile, `${line(iso(T0 - 3 * 3_600_000))}\n`);
    const files = { 'sess-good': goodFile }; // 'sess-bad' has no transcript: activity is unknown
    const activityMsFor = (row) => m.transcriptActivityMs(row, {
      tail: (r, o) => hung.readTranscriptTailActivity(r, { ...o, resolveTranscript: ({ session }) => { if (!files[session]) throw new Error('no transcript'); return files[session]; } }),
    });
    try {
      const rowsBy = { 6244: { name: 'fix-6244', sessionId: 'sess-good' }, 6245: { name: 'fix-6245', sessionId: 'sess-bad' } };
      for (const pr of [6244, 6245]) {
        m.acquireFixDispatchClaim({ repo: 'we', pr, kind: 'fix', headSha: 'sha1', owner: `Mac:${pr}`, lockRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 20 });
      }
      const rows = Object.values(rowsBy).map((r) => ({ ...r, cwd: '/lane', state: 'working', status: 'idle', startedAt: T0 + 1000 }));
      const released = [];
      for (let t = T0 + 60_000; t <= T0 + 60_000 + 35 * 60_000; t += 120_000) {
        const r = m.refreshLiveFixDispatchClaims({
          lockRoot, listAgentsAll: () => rows, hungInfoFor: () => null, awaitingVerifyFor: null, activityMsFor,
          prHeadFor: () => 'sha1', recordEvent: () => {}, nowIso: () => iso(t),
          idleRelease: { enabled: true, idleMinutes: 30, sources: { enabled: 'soak', idleMinutes: 'soak' }, invalid: [] },
        });
        released.push(...(r.released ?? []));
      }
      const violations = [];
      if (!released.some((x) => x.pr === 6244)) violations.push('idle fixer (quiet, readable transcript, unmoved head) kept its claim after 35 min');
      if (released.some((x) => x.pr === 6245)) violations.push('a holder with no readable transcript (unknown activity) lost its claim');
      return { violations };
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
