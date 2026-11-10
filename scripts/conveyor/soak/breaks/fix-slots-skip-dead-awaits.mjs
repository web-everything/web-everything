/**
 * @file breaks/fix-slots-skip-dead-awaits.mjs — LIVE incident 2026-11-05/06: the fix-dispatch daemon ran 0 fixers.
 * Its 3 slots were held by owed await-verify records the pass can never wake (delivered previous-CI, resume-exhausted),
 * so live PRs were deferred "fix slot full ... 0 working". FIX: runSlotAwareAwaitPass excludes unwakeable owed records
 * from admission (logged), keeping them on disk; exhausted ones stay operator-visible.
 * SCENARIO: three OLDER dead records (delivered, exhausted, delivered) plus one live owed resume, cap 3 with a stubbed
 * pass that answers phase A with the real wait-row shapes. RED = the live record was deferred or a dead one admitted.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const LOOP = 'scripts/conveyor/await-verify-loop.mjs';

export async function replay(root = REPO_ROOT) {
  if (!existsSync(join(root, LOOP))) return { harness: false };
  const { runSlotAwareAwaitPass } = await import(pathToFileURL(join(root, LOOP)).href);
  const at = (n) => new Date(Date.UTC(2026, 10, 3, 0, n)).toISOString();
  const mk = (pr, n) => ({ key: `we#${pr}`, record: { repo: 'we', pr, kind: 'fix', requestedAt: at(n), pendingResume: { kind: 'previous-ci' } } });
  const records = [mk(1, 1), mk(2, 2), mk(3, 3), mk(9, 50)];
  const waitRows = {
    'we#1': { action: 'wait', reason: 'previous-head CI repair must be verified and re-marked' },
    'we#2': { action: 'wait', result: 'resume-exhausted; previous-head CI failures retained; operator recovery required' },
    'we#3': { action: 'wait', reason: 'previous-head CI repair must be verified and re-marked' },
  };
  const woken = [];
  const runPass = async ({ io, allowResume }) => {
    if (!allowResume) return { rows: Object.entries(waitRows).map(([key, r]) => ({ key, pr: Number(key.slice(3)), ...r })) };
    for (const e of io.listRecords()) woken.push(e.key);
    return { rows: [] };
  };
  const io = { listRecords: () => records, prState: async () => ({ open: true }) };
  const lines = [];
  const out = await runSlotAwareAwaitPass({ io, runPass, allowResume: true, settings: { parkedReleasesSlot: true }, claims: [],
    nowMs: Date.parse(at(60)), ttlMs: 3_600_000, cap: 3, log: (l) => lines.push(l) });
  return { harness: true, admitted: out.admitted, woken, excludedLines: lines.length };
}

export default {
  id: 'fix-slots-skip-dead-awaits',
  title: 'unwakeable await-verify records held the fix slots, so the daemon ran 0 fixers',
  card: 'delivery blocker 2026-11-05 (fix-slots-skip-dead-awaits)',
  fixedBy: { sha: 'pending', where: 'lane/fix-slots-skip-dead-awaits', paths: [LOOP, 'scripts/conveyor/fixer-slot-rules.mjs'] },
  fixPresent(root) { return existsSync(join(root, LOOP)); },
  async run({ log } = {}) {
    try {
      const report = await replay();
      log?.(JSON.stringify(report));
      const violations = [];
      if (!report.harness) violations.push({ invariant: 'harness', detail: 'no slot-aware pass' });
      else {
        if (!report.admitted.includes('we#9')) violations.push({ invariant: 'live-resume-admitted', detail: `live record not admitted (admitted ${report.admitted.join(',')})` });
        if (report.admitted.some((k) => k !== 'we#9')) violations.push({ invariant: 'dead-not-admitted', detail: `dead record admitted (${report.admitted.join(',')})` });
        if (report.excludedLines !== 3) violations.push({ invariant: 'exclusion-logged', detail: `${report.excludedLines} log lines for 3 exclusions` });
      }
      return { violations, report };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
