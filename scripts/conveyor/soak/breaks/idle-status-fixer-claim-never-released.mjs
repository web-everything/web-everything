/** 2026-11-03: #6244/#6262 fix claims were heartbeated for hours by a LIVE but idle fixer session. Idle-head release
 *  read `state === 'idle'`, but real `claude agents` rows are `state:'working'` + `status:'idle'`, so it never fired.
 *  Second half (operator send-back, PR #6346 round 2): even once the status was read, the REAL hung detector flags a
 *  silent idle holder hung after 30 min, so the claim loop skipped idle release (needs 90 min quiet) for good. This
 *  scenario therefore runs with NO hungInfoFor / hungThresholdMs / activityMsFor stub: the real transcript reader and
 *  the real hung detector run over fixture transcripts. The sweep runs in a child process because the transcript
 *  directory (CLAUDE_PROJECTS_DIR) is read once, when the tree's modules first load. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const CHILD = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { root, lockRoot, T0, rows } = JSON.parse(process.env.SOAK_IDLE_ARGS);
const m = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-dispatch-claim.mjs')).href);
const iso = (ms) => new Date(ms).toISOString();
for (const pr of [6244, 6245]) {
  m.acquireFixDispatchClaim({ repo: 'we', pr, kind: 'fix', headSha: 'sha1', owner: 'Mac:' + pr, lockRoot, nowMs: T0, nowIso: iso(T0), leaseMinutes: 20 });
}
const released = [];
for (let t = T0 + 60_000; t <= T0 + 60_000 + 35 * 60_000; t += 120_000) {
  const r = m.refreshLiveFixDispatchClaims({
    lockRoot, listAgentsAll: () => rows, awaitingVerifyFor: null,
    prHeadFor: () => 'sha1', recordEvent: () => {}, nowIso: () => iso(t),
    idleRelease: { enabled: true, idleMinutes: 30, sources: { enabled: 'soak', idleMinutes: 'soak' }, invalid: [] },
  });
  released.push(...(r.released ?? []).map((x) => x.pr));
}
process.stdout.write('SOAK_RESULT ' + JSON.stringify({ released }) + '\\n');
`;

export default {
  id: 'idle-status-fixer-claim-never-released',
  title: 'a live fixer at status:idle with an unmoved PR head kept its fix claim for hours (idle release only read state:idle, and the real hung detector pre-empted it)',
  card: 'we:backlog (delivery fix 2026-11-03, #6244/#6262)',
  fixedBy: { sha: 'f432496da8', where: 'lane/claim-liveness-idle-pid-reuse', paths: ['scripts/conveyor/fix-dispatch-claim.mjs'] },
  // The fix ships in the SAME change as this break, so the scenario is always required GREEN: reverting the fix turns it red.
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const lockRoot = mkdtempSync(join(tmpdir(), 'idle-claim-soak-'));
    try {
      const projects = join(lockRoot, 'projects');
      const claims = join(lockRoot, 'claims');
      const T0 = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      const CWD = '/lane';
      const line = (ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
      // 'sess-bad' has no transcript: activity is unknown and its claim must be kept.
      const dir = join(projects, CWD.replaceAll('/', '-'));
      mkdirSync(dir, { recursive: true });
      mkdirSync(claims, { recursive: true });
      writeFileSync(join(dir, 'sess-good.jsonl'), `${line(iso(T0 - 3 * 3_600_000))}\n`);
      const rows = [{ name: 'fix-6244', sessionId: 'sess-good' }, { name: 'fix-6245', sessionId: 'sess-bad' }]
        .map((r) => ({ ...r, cwd: CWD, state: 'working', status: 'idle', startedAt: T0 + 1000 }));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CLAUDE_PROJECTS_DIR: projects, SOAK_IDLE_ARGS: JSON.stringify({ root, lockRoot: claims, T0, rows }) },
      });
      const hit = /^SOAK_RESULT (.+)$/m.exec(child.stdout ?? '');
      if (!hit) return { violations: [`scenario child produced no result (exit ${child.status}): ${String(child.stderr ?? '').slice(0, 300)}`] };
      const { released } = JSON.parse(hit[1]);
      const violations = [];
      if (!released.includes(6244)) violations.push('idle fixer (quiet 3h, readable transcript, unmoved head, real hung detector) kept its claim after 35 min');
      if (released.includes(6245)) violations.push('a holder with no readable transcript (unknown activity) lost its claim');
      return { violations };
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
