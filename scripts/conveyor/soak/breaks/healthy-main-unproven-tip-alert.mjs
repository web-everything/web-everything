/** PR #6009: a healthy main's new tip must not ask for operator attention while CI starts. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMainRedAlert } from '../../health-watch-main-red.mjs';
import { publishAttention, replay } from '../../../operations/needs-you-feed.mjs';

const SOURCE = 'scripts/conveyor/health-watch-main-red.mjs';
const SHA = 'a'.repeat(40);
const TIP_SHA = 'b'.repeat(40);
const AT = Date.parse('2026-10-26T12:30:00.000Z');
const successfulRuns = [{ headSha: SHA, databaseId: 1, status: 'completed', conclusion: 'success',
  createdAt: '2026-10-26T12:00:00.000Z', updatedAt: '2026-10-26T12:01:00.000Z' }];

export default {
  id: 'healthy-main-unproven-tip-alert',
  title: 'healthy main stays quiet while the new tip has unproven checks',
  card: 'PR #6009',
  fixedBy: { sha: 'HEAD', where: 'lane/red-main-alert', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('!provenGreen && !prev.fingerprint');
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-healthy-main-tip-'));
    const violations = [];
    try {
      for (const [name, checks] of [
        ['pending', [{ name: 'test', status: 'queued', conclusion: null }]],
        ['empty', []], ['unreadable', null],
        ['skipped', [{ name: 'test', status: 'completed', conclusion: 'skipped' }]],
      ]) {
        const stateDir = join(dir, name);
        const path = join(dir, `${name}.jsonl`);
        const tip = checks === null ? null : { sha: TIP_SHA, requiredChecks: ['test'],
          checksTotal: checks.length, checkRuns: checks };
        const options = { dir: stateDir, now: AT, probe: { runs: successfulRuns, tip },
          publish: item => publishAttention(item, { path, now: AT }), readDetails: () => null };
        await runMainRedAlert(options);
        await runMainRedAlert({ ...options, now: AT + 60_000 });
        if (replay({ path }).length) violations.push(`${name}: healthy main published operator attention`);
        const state = JSON.parse(readFileSync(join(stateDir, 'main-red-alert.json'), 'utf8'));
        if (state.fingerprint || state.unknownEmitted || state.seq !== 0) {
          violations.push(`${name}: healthy main persisted alert state`);
        }
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
