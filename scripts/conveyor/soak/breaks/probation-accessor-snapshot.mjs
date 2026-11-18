/** PR 7061: replay the operator's three probes against the real pure probation core.
 * No production wiring is claimed. The shared-map case pins the prior round's fix;
 * records mutation and top-level boot exceptions discriminate this repair.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as currentCore from '../../../lib/daemon-rebuild/probation.mjs';

const SOURCE = 'scripts/lib/daemon-rebuild/probation.mjs';
const GOOD = 'a'.repeat(40), ADOPTED = 'b'.repeat(40);
const at = Date.parse('2026-11-15T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const evidence = () => ({
  boot: { daemonId: 'worker', pid: 101, head: ADOPTED, startedAt: iso(at) },
  tick: { daemonId: 'worker', pid: 101, head: ADOPTED, lastTickDoneAt: iso(at + 1) },
});

export function replay(core = currentCore) {
  const { freezeProbation, recordProof, evaluateProbation } = core;
  const options = { adoptionId: 'accessor-probe', sha: ADOPTED, provenGood: GOOD,
    adoptedAt: iso(at), registered: [{ id: 'worker' }, { id: 'review' }],
    readClosure: (_, sha) => ({ complete: true, files: { 'worker.mjs': sha } }) };
  const files = {};
  const shared = freezeProbation({ ...options, registered: [{ id: 'worker' }], readClosure(_, sha) {
    files['worker.mjs'] = sha;
    return { complete: true, files };
  } });
  const poppingRecords = recordsFirst => {
    const restored = JSON.parse(JSON.stringify(freezeProbation(options)));
    const state = recordsFirst ? { records: undefined, ...restored } : restored;
    Object.defineProperty(state, 'records', { enumerable: true, get() {
      state.owed.pop();
      return { worker: evidence() };
    } });
    return evaluateProbation(state, at + 2);
  };
  const throwingBoot = nested => {
    const original = freezeProbation(options), proof = evidence();
    Object.defineProperty(nested ? proof.boot : proof, nested ? 'pid' : 'boot',
      { enumerable: true, get() { throw new Error('unreadable boot'); } });
    try {
      const next = recordProof(original, 'worker', proof, at + 2);
      return { noOp: next === original, action: evaluateProbation(next, at + 2).action };
    } catch (error) { return { throws: error.message }; }
  };
  return {
    sharedFiles: evaluateProbation(shared, at + 2),
    recordsPopOwed: poppingRecords(false),
    recordsBeforeOwed: poppingRecords(true),
    throwingBoot: throwingBoot(false),
    nestedThrowingBoot: throwingBoot(true),
  };
}

export default {
  id: 'probation-accessor-snapshot',
  title: 'accessor input cannot silently discharge probation or escape as a boot exception',
  card: 'PR 7061 — R986 I1 operator send-back',
  fixedBy: { sha: 'HEAD', where: 'lane/blue-green-s2a1-owed-set', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('function sanitize('); },
  async run({ log } = {}) {
    const report = replay();
    log?.(JSON.stringify(report));
    return report;
  },
  judge(report) {
    const expected = {
      sharedFiles: { action: 'pending', owed: ['worker'] },
      recordsPopOwed: { action: 'pending', owed: ['review'] },
      recordsBeforeOwed: { action: 'pending', owed: ['review'] },
      throwingBoot: { noOp: true, action: 'pending' },
      nestedThrowingBoot: { noOp: true, action: 'pending' },
    };
    return Object.keys(expected).filter(key => JSON.stringify(report[key]) !== JSON.stringify(expected[key]))
      .map(key => `${key}: ${JSON.stringify(report[key])}`);
  },
};
