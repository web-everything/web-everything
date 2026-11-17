/** S2a: a failed first tick leaves recovery owed to a later boot, without a timer. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { bootProbation, checkProbationAtTick, openProbation, writeProvenGood } from '../../../lib/daemon-rebuild/probation.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';

export default {
  id: 'probation-startup-failure',
  title: 'a later boot recovers an adoption whose first tick throws',
  card: 'PR #6882 S2a I3/I4',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-rebuild/probation.mjs', 'scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/probation.mjs'), 'utf8').includes('export async function bootProbation(');
  },
  async run({ log } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-probation-startup-'));
    const violations = [], events = [];
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'),
      WE_DAEMON_PROBATION_MS: '100', WE_DAEMON_EVENTS: join(root, 'events.jsonl') };
    const good = 'a'.repeat(40), failed = 'b'.repeat(40), adoptedAt = Date.now();
    let at = adoptedAt, head = failed, ticks = 0, restarts = 0, rebuilds = 0;
    const stamp = message => {
      const line = `${new Date(at).toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false })} ET ${message}`;
      events.push(line); log?.(line);
    };
    // Git is an explicit in-memory port: this probe never writes any .git directory.
    // The actual boot hook, finalizer, state persistence and both locks run unchanged.
    const run = args => {
      if (args[0] === 'rev-parse') return { status: args.at(-1) === 'HEAD' ? 0 : 1, stdout: args.at(-1) === 'HEAD' ? head : '' };
      if (args[0] === 'reset') {
        if (readRebuildState(root, env).rejected?.inputsKey !== 'failed-B') violations.push('reset preceded durable rejection');
        head = args.at(-1); stamp('boot-time reset B -> A (injected Git)');
        return { status: 0, stdout: '' };
      }
      if (['ls-files', 'status', 'cat-file', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
      throw new Error(`Unexpected Git operation: ${args[0]}`);
    };
    const options = { root, env, run, now: () => at, emit() {}, log: { error: stamp } };
    const boot = () => withSelfSync({ tickOnce() { ticks++; throw new Error('B first tick failed'); } }, {
      ...options, versions: null, background: false, readHead: () => head, readState: () => ({}),
      acquireRead: () => ({ ok: true }), releaseRead() {},
      rebuild: async () => { rebuilds++; return { moved: false }; },
      applyPendingRollback: opts => bootProbation({ ...options, ...opts }),
      checkProbation: opts => checkProbationAtTick({ ...options, ...opts }),
      onRestart(info) { restarts++; stamp(`onRestart reason=${info.reason}`); return 'restarted'; },
    });
    try {
      mkdirSync(env.WE_DAEMON_STATE_DIR);
      if (!writeProvenGood(root, env, { head: good, mainSha: good, inputsKey: 'good-A', applied: [], provenAt: new Date(at - 1).toISOString() })) throw new Error('good fixture failed');
      writeRebuildState(root, { adopted: { head, mainSha: good, inputsKey: 'failed-B', applied: [] } }, env);
      if (!openProbation({ ...options, sha: failed, prevHead: good, mainSha: good, inputsKey: 'failed-B', applied: [] })) throw new Error('open failed');
      at++;
      try { await boot().tickOnce(); violations.push('first tick did not throw'); }
      catch (error) { if (error.message !== 'B first tick failed') throw error; stamp(error.message); }
      at = adoptedAt + 201;
      rebuilds = 0;
      const next = boot();
      if (await next.tickOnce() !== 'restarted') violations.push('later boot did not restart');
      await next.tickOnce();
      if (head !== good || restarts !== 1 || ticks !== 1 || rebuilds !== 0) violations.push(`head=${head}, restarts=${restarts}, ticks=${ticks}, rebuilds=${rebuilds}`);
      if (readRebuildState(root, env).rejected?.inputsKey !== 'failed-B') violations.push('failed inputs not retained');
    } catch (error) { violations.push(error.message); }
    finally { rmSync(root, { recursive: true, force: true }); }
    return { violations, events };
  },
  judge: report => report.violations,
};
