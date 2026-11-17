/** Replay refusal history through successive production planner ticks with a one-card window. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const CORE = 'scripts/conveyor/tick-core.mjs';

export default {
  id: 'prepare-refusal-window-starvation',
  title: 'refused prepares survive ticks without starving the prepare-ahead window and become eligible after expiry',
  card: 'PR #7002 operator send-back',
  fixedBy: { sha: 'HEAD', where: 'lane/b1-runtime-priority', paths: [CORE] },
  fixPresent: () => true,
  async run({ sourceRoot = ROOT } = {}) {
    const { planTick, PREPARE_REFUSAL_WINDOW_MS } = await import(pathToFileURL(join(sourceRoot, CORE)).href);
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const now = Date.parse('2026-11-17T12:00:00Z');
    const input = {
      state: { queue: [{ num: '#099', buildPriority: 0 }, { num: 100 }] },
      plan: { held: [{ num: '#099', reason: 'needs-prepare' }, { num: 100, reason: 'needs-prepare' }] },
      freeLanes: [5], config: { prepareAheadWindow: 1 },
    };
    const first = planTick({ ...input, now, bookkeeping: { prepareRefusals: { 99: [now - 1, now - 2] } } });
    check(first.decisions.spawnPrepareItems[0]?.num === 100, 'first tick: refused card starves the next eligible prepare');
    const second = planTick({ ...input, now: now + 1000, bookkeeping: first.nextState });
    check(!second.decisions.spawnPrepareItems.some(s => s.num === '#099'), 'second tick: refusal history was lost and the refused item redispatched');
    check(second.nextState.prepareRefusals?.[99]?.length === 2, 'second tick: recent refusal history did not persist');
    const expired = planTick({ ...input, now: now + PREPARE_REFUSAL_WINDOW_MS, bookkeeping: second.nextState });
    check(expired.decisions.spawnPrepareItems[0]?.num === '#099', 'expired refusal history still blocks the item');
    check(Object.keys(expired.nextState.prepareRefusals ?? {}).length === 0, 'expired refusal keys were retained');
    return { violations };
  },
  judge: report => report.violations,
};
