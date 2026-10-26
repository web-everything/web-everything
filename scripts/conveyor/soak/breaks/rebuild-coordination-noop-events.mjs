/** PR #5940: repeated contention and recovered swaps must not flood coordination events. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildClone } from '../../../lib/daemon-rebuild/rebuild.mjs';
import { writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { withReadLock } from '../../../lib/daemon-clone-lock.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/rebuild.mjs';
export default {
  id: 'rebuild-coordination-noop-events',
  title: 'contended ticks and recovered adoptions stay quiet while a real failure reaches the coordination feed',
  card: 'PR #5940',
  fixedBy: { sha: 'HEAD', where: 'lane/daemon-events-rebuild', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('FAILURE_REASONS.has'); },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-rebuild-events-'));
    const violations = [];
    try {
      const root = join(dir, 'review-daemon');
      mkdirSync(root);
      const env = {
        WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_OVERLAY_DIR: join(dir, 'overlays'),
        WE_DAEMON_CLONE_LOCK_ROOT: join(dir, 'locks'), WE_DAEMON_EVENTS: join(dir, 'events.jsonl'),
        WE_DAEMON_AUTO_REBASE: '0',
      };
      const head = 'b'.repeat(40);
      let failStatus = false;
      const options = {
        root, env, versions: null, asJob: false, skipCheck: null,
        lockOpts: { waitMs: 5, pollMs: 1 }, log: { error() {} },
        // Only Git observations are injected; locks, recovery, wrapper and JSONL writer are real.
        run(args) {
          if (args[0] === 'rev-parse') return { status: args.includes('MERGE_HEAD') ? 1 : 0, stdout: head };
          if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'main' };
          if (args[0] === 'status' && failStatus) return { status: 1, stdout: '' };
          if (['ls-files', 'status', 'rev-list', 'cat-file'].includes(args[0])) return { status: 0, stdout: '' };
          throw new Error(`unexpected git: ${args.join(' ')}`);
        },
        runSmoke() { throw new Error('unexpected smoke'); },
        prState() { throw new Error('unexpected PR read'); },
      };
      const locked = await withReadLock(root, async () => {
        for (let tick = 0; tick < 3; tick++) {
          const result = await rebuildClone(options);
          if (result.reason !== 'tick-in-progress') violations.push(`contention returned ${result.reason}`);
        }
      }, { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT, owner: 'soak-reader' });
      if (!locked.ok) violations.push('fixture did not acquire its read lock');

      writeRebuildState(root, {
        inProgress: { target: head, prevHead: 'a'.repeat(40), verified: true, startedAt: '2000-01-01T00:00:00Z' },
      }, env);
      const recovered = await rebuildClone(options);
      if (recovered.reason !== 'recovered-adopted' || recovered.moved !== false || !recovered.adopted) {
        violations.push('fixture did not recover the previously completed swap');
      }
      const records = () => existsSync(env.WE_DAEMON_EVENTS)
        ? readFileSync(env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      if (records().length) violations.push('idle ticks emitted coordination events');

      failStatus = true;
      const failed = await rebuildClone(options);
      if (failed.reason !== 'status-failed') violations.push(`failure returned ${failed.reason}`);
      const events = records();
      if (events.length !== 1 || events[0].kind !== 'rebuild-failed' || events[0].detail?.reason !== 'status-failed') {
        violations.push('real status failure did not produce exactly one coordination event');
      }
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
