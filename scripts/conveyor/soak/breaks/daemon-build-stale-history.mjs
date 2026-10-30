/** PR #6035: exclude direct commits and fail closed when adoption evidence disappears. */
import { createStateLister } from '../../health-smells/daemon-build-stale.mjs';
import { emptyHealthState, runHealthTick } from '../../health-watch-core.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = 'scripts/conveyor/health-smells/daemon-build-stale.mjs';
const NOW = Date.parse('2026-10-28T18:00:00Z');
const MINUTE = 60_000;
const SHA = 'a'.repeat(40);
const state = { cloneKey: 'fixture-daemon', raw: JSON.stringify({ adopted: { mainSha: SHA } }) };
const drain = { sha: 'b'.repeat(40), ctMs: NOW - 6 * 60 * MINUTE, subject: 'drain: mark card resolved (#2748)' };
const recent = { sha: 'c'.repeat(40), ctMs: NOW - 30 * MINUTE, subject: 'Merge pull request #6014 from x/y' };

function replay(smell, io, config = {}, previous = emptyHealthState()) {
  return runHealthTick(previous, {}, [{
    ...smell, evaluate: (probes, ctx) => smell.evaluate(probes, { ...ctx, io }),
  }], NOW, { config: { mode: 'shadow', ...config } });
}

export default {
  id: 'daemon-build-stale-history',
  title: 'daemon adoption alerts count PR merges and fail closed on missing evidence',
  card: 'PR #6035',
  fixedBy: { sha: 'HEAD', where: 'lane/daemon-build-stale', paths: [SOURCE] },
  fixPresent(root) {
    // Probe behavior in the specified tree; a source marker cannot prove the filter works.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { default: smell } = await import(${JSON.stringify(pathToFileURL(join(root, SOURCE)).href)});
      const results = smell.evaluate({}, { now: ${NOW}, io: {
        listStates: () => [${JSON.stringify(state)}], mergesSince: () => [${JSON.stringify(drain)}],
      } });
      process.exit(results.length === 1 && results[0].breach === false && results[0].measure.behind === 0 ? 0 : 1);
    `], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    return probe.status === 0;
  },
  async run() {
    const { default: smell } = await import('../../health-smells/daemon-build-stale.mjs');
    const violations = [];
    for (const [name, commits] of [['drain-only', [drain]], ['recent-PR', [drain, recent]]]) {
      const tick = replay(smell, { listStates: () => [state], mergesSince: () => commits });
      if (tick.plan.some(p => p.kind === 'notify') || tick.transitions.some(t => t.type === 'opened')) {
        violations.push(`${name}: old direct commit opened an operator alert`);
      }
    }
    for (const [name, io, config] of [
      ['empty-directory', { listStates: createStateLister({ readdir: () => [], directory: 'fixture-state' }) }],
      ['empty-listing', { listStates: () => [] }],
      ['invalid-threshold', { listStates: () => [state], mergesSince: () => [{ ...recent, ctMs: NOW - 5 * 60 * MINUTE }] },
        { daemonBuildStaleMaxMs: '2h' }],
    ]) {
      const tick = replay(smell, io, config);
      const notifications = tick.plan.filter(p => p.kind === 'notify' && p.suppressed == null);
      if (notifications.length !== 1) violations.push(`${name}: missing operator alert in shadow mode`);
    }
    const stale = replay(smell, {
      listStates: () => [state], mergesSince: () => [{ ...recent, ctMs: NOW - 5 * 60 * MINUTE }],
    });
    const recovered = replay(smell, { listStates: () => [state], mergesSince: () => [drain] }, {}, stale.state);
    if (!recovered.transitions.some(t => t.type === 'closed')) {
      violations.push('recovery: adopting all PR merges did not close the stale episode');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
