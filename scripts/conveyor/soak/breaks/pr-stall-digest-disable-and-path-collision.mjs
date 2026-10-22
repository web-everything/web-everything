/** PR #5817: disabling the stall digest must release queue suppression; feed/state paths must be disjoint. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishStalledDigest } from '../../pr-stall-digest.mjs';
import { runStallSweep, STALL_SWEEP_DEFAULTS } from '../../pr-stall-sweep.mjs';
import { runPrSweep } from '../../pr-sweep.mjs';
import { acknowledge, replay, runOnce, sidecarsOf } from '../../../operations/needs-you-feed.mjs';

const SOURCE = 'scripts/conveyor/pr-stall-digest.mjs';
export default {
  id: 'pr-stall-digest-disable-and-path-collision',
  title: 'disabled stall producers release queue heads and colliding feed paths preserve digest state',
  card: 'PR #5817',
  fixedBy: { sha: 'HEAD', where: 'lane/stall-sweep-3', paths: [SOURCE, 'scripts/conveyor/pr-stall-sweep.mjs', 'scripts/conveyor/pr-sweep.mjs', 'scripts/operations/needs-you-feed.mjs'] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('releaseStalledSuppression'); },
  async run() {
    const root = mkdtempSync(join(tmpdir(), 'soak-stall-digest-'));
    const violations = [];
    const now = Date.parse('2026-10-22T14:00:00Z');
    const repo = 'acme/widgets', head = 'a'.repeat(40);
    const item = { lane: 'operator', repo, pr: 1, head, state: 'needs-decision:note' };
    const notify = () => ({ ok: true });
    try {
      for (const [name, config] of [['digest-off', { mode: 'shadow', digest: false }], ['sweep-off', { mode: 'off', digest: true }]]) {
        const dir = join(root, name, 'pr-stall-sweep'), path = join(root, name, 'events.jsonl');
        publishStalledDigest({ items: [item] }, { feedPath: path, stateDir: dir, env: {}, now, notify });
        acknowledge({ path });
        const settings = { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: path }, allowPrimary: { value: true } };
        const env = { WE_PR_STALL_SWEEP_MODE: config.mode, WE_PR_STALL_SWEEP_DIGEST: String(config.digest) };
        const poll = () => runOnce({ settings, env, now, liveGate: false, log: () => {},
          exec: () => JSON.stringify({ ready: [{ repo, number: 1, head }] }) });
        // A poll can run before the cleanup pass: disabled producer keys must already cease suppressing it.
        if (!(await poll()).lines.length) violations.push(`${name}: stale stalled key suppressed the ready head`);
        const report = await runPrSweep({ now, env, config: {},
          settings: { value: { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, repos: [repo] }, sources: {} },
          readPrevious: () => ({ stallSweep: { lastRunAt: now } }), readPrs: () => [], readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}),
          notify, flush: () => ({}), persist: () => {}, append: () => {},
          stallSweep: args => runStallSweep({ ...args, dir, settings: { value: { ...STALL_SWEEP_DEFAULTS, ...config }, sources: {}, errors: [] }, log: () => {} }),
          stallDigest: (pass, options) => publishStalledDigest(pass, { ...options, feedPath: path }) });
        if (report.errors.length) violations.push(`${name}: ${report.errors.join('; ')}`);
        const keys = JSON.parse(readFileSync(sidecarsOf(path).state, 'utf8')).openKeys;
        if (keys.some(key => key.endsWith(':stalled'))) violations.push(`${name}: cleanup retained stalled suppression`);
        await poll();
        if (!replay({ path }).some(event => event.kind === 'needs-you')) violations.push(`${name}: queue never published the head`);
      }
      const stateDir = join(root, 'collision', 'pr-stall-sweep');
      mkdirSync(stateDir, { recursive: true });
      const mine = join(stateDir, 'digest-state.json'), before = '{"published":[],"unnotified":[],"marker":"untouched"}\n';
      writeFileSync(mine, before);
      const result = publishStalledDigest({ items: [item] }, { env: { WE_NEEDS_YOU_FEED: mine }, stateDir, now, notify });
      if (!result.errors.length) violations.push('colliding feed path was accepted');
      if (result.lines.length) violations.push('colliding feed path published a line');
      if (readFileSync(mine, 'utf8') !== before) violations.push('colliding feed path overwrote digest state');
      return { violations };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
