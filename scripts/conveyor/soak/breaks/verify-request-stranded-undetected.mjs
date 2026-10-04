/**
 * @file breaks/verify-request-stranded-undetected.mjs — live break, 2026-10-04 (PR #3890's fixer). A verify request
 * that nothing will ever settle went unnoticed for 3 hours.
 *
 * LIVE INCIDENT: from 13:36Z to 16:44Z a plain file at the pool root (`~/workspace/.lanes/.metadata_never_index`)
 * made every verify-daemon tick throw ENOTDIR (root fix: PR #3902). Five `request`ed markers (lanes 2/3/8/11/12)
 * sat at `running` for HEAD with no dispatcher `runId`. PR #3890's fixer looped 9 x `check --wait=540000`
 * timeouts. The daemon still logged a line every tick, so `daemon-silent` never fired, and no smell read the
 * markers themselves.
 *
 * FIX — `health-smells/fixer-verify-never-settles.mjs` + `health-watch.mjs#probeLaneVerifyMarkers`: a lane marker
 * running for HEAD with no runId past 20 min (or a dispatched run past every ceiling) is a breach.
 *
 * SCENARIO: a fixture pool holding the exact `.metadata_never_index` file and lane-2's real stranded marker
 * (requested 14:02:52Z), judged at 15:29Z through every registered smell that declares the `laneVerifyMarkers`
 * probe. RED = no smell breaches on lane-2. GREEN = one does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHA = '0d1f5972d59ecdfbfcd76f06245a215337fde9b5';
const NOW = Date.parse('2026-10-04T15:29:00.000Z');

export default {
  id: 'verify-request-stranded-undetected',
  title: 'a verify request no daemon ever dispatched sat at running for hours and no health smell flagged it',
  card: 'verify never settles — live PR #3890 fixer loop, 2026-10-04 (PR #3903)',
  fixedBy: { sha: '222074b48', where: 'lane/verify-pool-scan-non-dir', paths: ['scripts/conveyor/health-smells/fixer-verify-never-settles.mjs', 'scripts/conveyor/health-watch.mjs'] },
  fixPresent(root) {
    return existsSync(join(root, 'scripts/conveyor/health-smells/fixer-verify-never-settles.mjs'));
  },
  async run({ log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-verify-stranded-'));
    const violations = [];
    try {
      writeFileSync(join(dir, '.metadata_never_index'), '');
      const gitDir = join(dir, 'web-everything', 'lane-2', '.git');
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, '.lane-verify'), JSON.stringify({ sha: SHA, status: 'running', startedAt: '2026-10-04T14:02:52.772Z', finishedAt: null, suites: 'npx vitest related … && npm run check:standards', exitCode: null }));
      const hw = await import('../../health-watch.mjs');
      const { SMELLS } = await import('../../health-smells/index.mjs');
      let markers = [];
      try { markers = hw.probeLaneVerifyMarkers ? hw.probeLaneVerifyMarkers({ poolRoot: dir, readHead: () => SHA }) : []; }
      catch (e) { violations.push({ invariant: 'crash', detail: `probe threw: ${e.message}` }); }
      const readers = SMELLS.filter((s) => (s.probes || []).includes('laneVerifyMarkers'));
      const breaches = readers.flatMap((s) => s.evaluate({ laneVerifyMarkers: markers }, { now: NOW }).filter((d) => d.breach && String(d.subject).includes('lane-2')).map((d) => `${s.id}: ${d.summary}`));
      log?.(breaches.join('\n') || 'no breach');
      if (!breaches.length) violations.push({ invariant: 'unflagged', detail: `lane-2's verify request stranded at running for 86 min (no runId) — ${readers.length} smell(s) read lane verify markers, none breached` });
      return { violations, breaches };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
