/** Replay PR #7417: the newest 2,000 ticks never span a busy loop's alarm window. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MINUTE = 60_000;

export default {
  id: 'zero-success-record-cap',
  title: 'busy failing loops retain bounded evidence across the zero-success alarm window',
  card: 'PR #7417 red-team send-back x1b8hlo item 1',
  fixedBy: { sha: 'HEAD', where: 'zero-success retention', paths: ['scripts/conveyor/health-loop-ticks.mjs'] },
  fixPresent(root) {
    // Behavioral check against the selected tree, independent of source markers and the scenario judge.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { pathToFileURL } from 'node:url';
       const { mergeLoopTicks, zeroSuccessVerdicts } = await import(pathToFileURL(process.argv[1]));
       const now = 1800000000000;
       const records = Array.from({ length: 3601 }, (_, i) => ({ at: now - i * 1000,
         loop: 'prepare', attempted: 1, succeeded: 0, failed: 1 }));
       const kept = mergeLoopTicks([], records, { now });
       process.exit(kept.length <= 2000 && zeroSuccessVerdicts(kept, { now })[0]?.breach ? 0 : 1);`,
      join(root, 'scripts/conveyor/health-loop-ticks.mjs')],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 65_536 });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || ROOT } = {}) {
    const { runHealthTick } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/health-watch-core.mjs')));
    const { parseDrainCatchupTicks, zeroSuccessVerdicts } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/health-loop-ticks.mjs')));
    const { default: smell } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/health-smells/zero-success-alarm.mjs')));
    const saved = { minutes: process.env.WE_ZERO_SUCCESS_MINUTES, ticks: process.env.WE_ZERO_SUCCESS_MIN_TICKS };
    const cases = [];
    try {
      process.env.WE_ZERO_SUCCESS_MIN_TICKS = '3';
      for (const [minutes, stepMs] of [[60, 1000], [1440, 30_000]]) {
        process.env.WE_ZERO_SUCCESS_MINUTES = String(minutes);
        const now = Date.parse('2026-11-24T12:00:00Z');
        const lines = Array.from({ length: minutes * MINUTE / stepMs + 1 }, (_, i) =>
          `[drain-daemon] ${new Date(now - i * stepMs).toISOString()} enqueue-on-event: catch-up #7395 — could not finish (class=unknown)`);
        const result = runHealthTick(null, { loopTicks: { records: parseDrainCatchupTicks(lines.join('\n')) } }, [smell], now);
        const kept = result.state.loopTicks;
        cases.push({ minutes, retained: kept.length,
          spanMinutes: (kept.at(-1).at - kept[0].at) / MINUTE,
          breach: zeroSuccessVerdicts(kept, { now, windowMs: minutes * MINUTE })[0]?.breach,
          open: Object.values(result.state.episodes).filter((e) => e.status === 'open').length });
      }
    } finally {
      if (saved.minutes === undefined) delete process.env.WE_ZERO_SUCCESS_MINUTES;
      else process.env.WE_ZERO_SUCCESS_MINUTES = saved.minutes;
      if (saved.ticks === undefined) delete process.env.WE_ZERO_SUCCESS_MIN_TICKS;
      else process.env.WE_ZERO_SUCCESS_MIN_TICKS = saved.ticks;
    }
    return { cases };
  },
  judge({ cases }) {
    return cases.flatMap((c) => c.retained <= 2000 && c.breach && c.open === 1
      ? [] : [`${c.minutes}m window: retained=${c.retained}, span=${c.spanMinutes}m, breach=${c.breach}, open=${c.open}`]);
  },
};
