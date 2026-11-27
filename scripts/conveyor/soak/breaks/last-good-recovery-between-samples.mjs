/** PR #7590: adoption between health samples must separate consecutive hold alarms. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import smell from '../../health-smells/daemon-held-on-last-good.mjs';
import { emptyHealthState, runHealthTick, MINUTE, HOUR } from '../../health-watch-core.mjs';
import { probeSelfSync } from '../../health-watch.mjs';

const SOURCE = 'scripts/conveyor/health-smells/daemon-held-on-last-good.mjs';
const CORE = 'scripts/conveyor/health-watch-core.mjs';
const NOW = Date.parse('2026-11-27T07:00:00Z');

export default {
  id: 'last-good-recovery-between-samples',
  title: 'a recovered last-good hold cannot suppress the next hold alarm',
  card: 'PR #7590',
  fixedBy: { sha: 'HEAD', where: 'lane/last-good-hold-alarm-we', paths: [SOURCE, CORE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('resolvedEpisodeId:')
      && readFileSync(join(root, CORE), 'utf8').includes('r.resolvedEpisodeId === ep.id');
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-last-good-recovery-'));
    const violations = [];
    const sample = (held, adopted, previous, now) => {
      writeFileSync(join(dir, 'fixture-daemon.rebuild.json'), JSON.stringify({ held, adopted }));
      return runHealthTick(previous, { selfSync: probeSelfSync(dir) }, [smell], now);
    };
    const notifications = result => result.plan.filter(p => p.kind === 'notify' && p.suppressed === null);
    const key = `${smell.id}::clone:fixture-daemon`;
    try {
      for (const firstSampleMinute of [2, 32]) {
        const oldHold = { since: new Date(NOW - 10 * HOUR).toISOString(), reason: 'smoke-rejected',
          failed: 'live-smoke', lastGood: 'same-head', target: 'candidate' };
        const opened = sample(oldHold, null, emptyHealthState(), NOW);
        const oldId = opened.state.episodes[key]?.measure.episodeId;
        if (notifications(opened).length !== 1) violations.push('initial ten-hour hold did not notify');
        const held = { ...oldHold, since: new Date(NOW + MINUTE).toISOString() };
        const adopted = { at: new Date(NOW + 30_000).toISOString(), head: 'same-head' };
        const next = sample(held, adopted, opened.state, NOW + firstSampleMinute * MINUTE);
        if (!next.transitions.some(t => t.type === 'closed' && t.episode.measure.episodeId === oldId)) {
          violations.push(`sample ${firstSampleMinute}: previous hold was not retired`);
        }
        if (firstSampleMinute === 2 && (next.state.episodes[key] || notifications(next).length)) {
          violations.push('one-minute replacement hold inherited the old alert');
        }
        const alarm = firstSampleMinute === 2 ? sample(held, adopted, next.state, NOW + 32 * MINUTE) : next;
        if (notifications(alarm).length !== 1 || alarm.state.episodes[key]?.measure.episodeId === oldId) {
          violations.push(`sample ${firstSampleMinute}: next aged hold did not notify with a fresh identity`);
        }
        const repeat = sample(held, adopted, alarm.state, NOW + 33 * MINUTE);
        if (notifications(repeat).length) violations.push('replacement hold notified twice');
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
