/** Missing Forge telemetry must not swallow the next real disk/prune alert. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export default {
  id: 'forge-disk-prune-note-escalation',
  title: 'Forge unobservable note stays low and a subsequent breach notifies once',
  card: 'PR #6913',
  fixedBy: { sha: 'pending', where: 'lane/forge-disk-prune-smell-r2', paths: [
    'scripts/conveyor/health-watch-core.mjs', 'scripts/conveyor/health-smells/forge-disk-prune.mjs',
  ] },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/conveyor/health-watch-core.mjs'), 'utf8').includes('findingBecameHigh');
    } catch { return false; }
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || ROOT;
    const { default: smell } = await import(pathToFileURL(join(root, 'scripts/conveyor/health-smells/forge-disk-prune.mjs')).href);
    const { emptyHealthState, stepEpisodes, planActions } = await import(pathToFileURL(join(root, 'scripts/conveyor/health-watch-core.mjs')).href);
    const now = Date.parse('2026-11-16T05:00:00Z');
    const key = `${smell.id}::forge-disk-prune`;
    const tick = (state, telemetry, time) => stepEpisodes(state, [{ smell, results: smell.evaluate({}, {
      now: time, episodes: state.episodes, readForgeHealth: () => ({ telemetry: { sampledAtET: new Date(now).toISOString(), ...telemetry } }),
    }) }], time);
    const notify = result => planActions(result.transitions, { [smell.id]: smell }).filter(p => p.kind === 'notify' && !p.suppressed);
    const violations = [];
    const note = tick(emptyHealthState(), {}, now);
    if (note.state.episodes[key]?.severity !== 'low' || notify(note).length) violations.push('missing telemetry opens a high/notifying episode');
    // JSON persistence mirrors daemon restart between ticks.
    const resumed = JSON.parse(JSON.stringify(note.state));
    const breach = tick(resumed, { diskUsedPct: 100, prune: { consecutiveRefused: 469 } }, now + 1);
    if (breach.state.episodes[key]?.escalation?.status !== 'needs-you' || notify(breach).length !== 1) violations.push('real breach does not emit exactly one needs-you notification');
    const missing = tick(breach.state, {}, now + 2);
    if (missing.state.episodes[key]?.severity !== 'high' || missing.state.episodes[key]?.escalation?.status !== 'needs-you' || notify(missing).length) violations.push('missing telemetry clears or re-notifies an existing breach');
    return { violations };
  },
  judge(report) { return report.violations; },
};
