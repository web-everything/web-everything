/** S2a: a failed startup leaves durable probation for the next boot to enforce. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSelfSync } from '../../../lib/daemon-self-sync.mjs';
import { bootProbation, checkProbationAtTick, openProbation, writeProvenGood } from '../../../lib/daemon-rebuild/probation.mjs';
import { readRebuildState, writeRebuildState } from '../../../lib/daemon-rebuild/state.mjs';
import { inspectCloneLock } from '../../../lib/daemon-clone-lock.mjs';

export default {
  id: 'probation-startup-failure',
  title: 'startup failure after adoption rolls back at a later boot',
  card: 'PR #6882 / S2a I3-I4',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2-probation-r928',
    paths: ['scripts/lib/daemon-rebuild/probation.mjs', 'scripts/lib/daemon-self-sync.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/probation.mjs'), 'utf8').includes('export async function bootProbation(');
  },
  async run({ log = () => {} } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'soak-probation-startup-'));
    const violations = [], timeline = [];
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    const adoption = Date.parse('2026-11-16T20:00:00Z');
    let at = adoption, head = B, resets = 0, restarts = 0, rebuilds = 0, ticks = 0;
    const env = { WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'),
      WE_DAEMON_PROBATION_MS: '1000', WE_DAEMON_EVENTS: join(root, 'events.jsonl') };
    const record = message => {
      const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', hour12: false,
        dateStyle: 'short', timeStyle: 'long' }).format(at);
      timeline.push(`${et} ${message}`); log(timeline.at(-1));
    };
    const run = args => {
      if (args[0] === 'rev-parse') return args.at(-1) === 'MERGE_HEAD'
        ? { status: 1, stdout: '' } : { status: 0, stdout: head };
      if (args[0] === 'reset') {
        if (!inspectCloneLock(root, { lockRoot: env.WE_DAEMON_CLONE_LOCK_ROOT }).writer) violations.push('reset outside clone write lock');
        if (readRebuildState(root, env).rejected?.inputsKey !== 'bad') violations.push('reset before rejection persisted');
        head = args.at(-1); resets++; record('boot reset B -> A');
        return { status: 0, stdout: '' };
      }
      if (['ls-files', 'status', 'cat-file', 'rev-list'].includes(args[0])) return { status: 0, stdout: '' };
      throw new Error(`Unexpected Git operation: ${args[0]}`);
    };
    const options = { root, env, run, now: () => at, emit() {}, log: { error: record } };
    const wrap = () => withSelfSync({ tickOnce() { ticks++; throw new Error('B tick startup failure'); } }, {
      root, env, now: () => at, readHead: () => head, log: { error: record }, versions: null, background: false,
      readState: () => ({ adopted: null }), acquireRead: () => ({ ok: true }), releaseRead() {},
      rebuild: async () => { rebuilds++; throw new Error('B startup failed before rebuild'); },
      applyPendingRollback: boot => bootProbation({ ...options, bootHead: boot.bootHead, bootAt: boot.bootAt, lockWaitMs: 0 }),
      checkProbation: tick => checkProbationAtTick({ ...options, ...tick, run }),
      onRestart(info) { restarts++; record(`onRestart(${info.reason})`); return 'restarted'; },
    });
    try {
      writeRebuildState(root, { adopted: { head: B, inputsKey: 'bad', mainSha: A, applied: [] } }, env);
      if (!writeProvenGood(root, env, { head: A, inputsKey: 'good', mainSha: A, applied: [], provenAt: new Date(at - 1).toISOString() })
        || !openProbation({ ...options, sha: B, prevHead: A, inputsKey: 'bad', mainSha: A, applied: [] })) throw new Error('fixture adoption failed');
      record('adopt B');
      const first = wrap();
      try { await first.tickOnce(); violations.push('B startup unexpectedly succeeded'); }
      catch (error) { record(error.message); }
      if (resets || restarts) violations.push('startup failure reset before a later boot');
      at = adoption + 2001;
      const next = wrap();
      const result = await next.tickOnce();
      await next.tickOnce(); // Duplicate entry still invokes the caller only once.
      if (result !== 'restarted' || head !== A || resets !== 1 || restarts !== 1 || rebuilds !== 1 || ticks !== 0) {
        violations.push(`result=${result} resets=${resets} restarts=${restarts} rebuilds=${rebuilds} ticks=${ticks}`);
      }
      if (readRebuildState(root, env).rejected?.inputsKey !== 'bad') violations.push('failed inputs lost');
    } catch (error) { violations.push(error.message); }
    finally { rmSync(root, { recursive: true, force: true }); }
    return { violations, timeline };
  },
  judge: report => report.violations,
};
