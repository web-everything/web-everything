/** PR #5817: explicit disable releases suppression; settings failures preserve it; feed/state paths are disjoint. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishStalledDigest } from '../../pr-stall-digest.mjs';
import { runStallSweep, STALL_SWEEP_DEFAULTS } from '../../pr-stall-sweep.mjs';
import { runPrSweep } from '../../pr-sweep.mjs';
import { acknowledge, replay, runOnce, sidecarsOf, unacknowledged } from '../../../operations/needs-you-feed.mjs';

const SOURCE = 'scripts/conveyor/pr-stall-digest.mjs';
export default {
  id: 'pr-stall-digest-disable-and-path-collision',
  title: 'explicit disable releases queue heads, settings failures retain stalls, and feed paths preserve digest state',
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
        publishStalledDigest({ items: [item, { ...item, pr: 2 }] }, { feedPath: path, stateDir: dir, env: {}, now, notify });
        acknowledge({ path });
        // A new state after ack remains visible until the disabled producer explicitly clears it.
        publishStalledDigest({ items: [item, { ...item, pr: 2, state: 'ruling-needed:dispute' }] }, { feedPath: path, stateDir: dir, env: {}, now, notify });
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
        if (unacknowledged({ path }).some(event => event.kind === 'stalled')) violations.push(`${name}: disabled producer left an unacknowledged stall`);
        if (!replay({ path }).some(event => event.kind === 'cleared' && event.was === 'stalled' && event.pr === 2)) violations.push(`${name}: no clear event for the disabled producer`);
        await poll();
        if (!replay({ path }).some(event => event.kind === 'needs-you')) violations.push(`${name}: queue never published the head`);
      }
      for (const failure of ['platform-read', 'env-mode']) {
        const dir = join(root, failure, 'pr-stall-sweep'), path = join(root, failure, 'events.jsonl');
        const prefs = join(root, failure, 'prefs.json');
        const env = { WE_PLATFORM_PREFERENCES_FILE: prefs, WE_PR_STALL_SWEEP_MODE: failure === 'env-mode' ? 'typo' : 'shadow' };
        let alerts = 0;
        const options = { feedPath: path, stateDir: dir, env: {}, now, notify: () => { alerts++; return { ok: true }; } };
        publishStalledDigest({ items: [item] }, options);
        writeFileSync(prefs, failure === 'platform-read' ? '{broken json' : '{}');
        const files = [path, sidecarsOf(path).state, join(dir, 'digest-state.json')];
        const before = files.map(file => readFileSync(file, 'utf8'));
        const report = await runPrSweep({ now, env, config: {},
          settings: { value: { idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90, repos: [repo] }, sources: {} },
          readPrevious: () => ({ stallSweep: { lastRunAt: now } }), readPrs: () => [], readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}),
          notify: options.notify, flush: () => ({}), persist: () => {}, append: () => {},
          stallSweep: args => runStallSweep({ ...args, dir, log: () => {} }),
          stallDigest: (pass, opts) => publishStalledDigest(pass, { ...opts, feedPath: path }) });
        if (!report.errors.length) violations.push(`${failure}: settings failure was not reported`);
        if (files.some((file, i) => readFileSync(file, 'utf8') !== before[i])) violations.push(`${failure}: settings failure changed feed or digest state`);
        const poll = await runOnce({ env, now, liveGate: false, log: () => {},
          settings: { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: path }, allowPrimary: { value: true } },
          exec: () => JSON.stringify({ ready: [{ repo, number: 1, head }] }) });
        if (poll.lines.length) violations.push(`${failure}: settings failure released queue suppression`);
        if (!unacknowledged({ path }).some(event => event.kind === 'stalled')) violations.push(`${failure}: settings failure hid the operator item`);
        writeFileSync(prefs, '{}');
        env.WE_PR_STALL_SWEEP_MODE = 'shadow';
        const recovered = publishStalledDigest({ items: [item] }, { ...options, env });
        if (recovered.lines.length || alerts !== 1) violations.push(`${failure}: recovery republished or repeated the alert`);
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
