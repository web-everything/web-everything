/** Phase B refusals must keep admitted CI-heals in the next pass's cursor. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import slowPrelude from './ci-heal-starved-by-slow-prelude.mjs';

export default {
  id: 'ci-heal-yielded-launch-cursor',
  title: 'adoption between admission and launch retains the earliest unlaunched CI-heal, including across waves',
  card: '#6919',
  fixedBy: { sha: 'working-tree', where: 'lane', paths: ['scripts/operations/ci-heal-pr-dispatch.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/ci-heal-pr-dispatch.mjs'), 'utf8').includes('deferred.push(entry.prNumber)');
  },
  async run({ runDispatch } = {}) {
    return {
      afterLaunch: await slowPrelude.run({ adoption: 'after-first-launch', runDispatch }),
      duringAdmission: await slowPrelude.run({ adoption: 'during-admission', runDispatch }),
      missingHost: await slowPrelude.run({ hostRecheck: false, runDispatch }),
    };
  },
  judge(report) {
    const violations = [];
    for (const key of ['afterLaunch', 'duringAdmission']) {
      const result = report?.[key];
      if (JSON.stringify(result?.dispatched?.map(row => row.pr)) !== '[1]') violations.push(`${key}: only the first launch is exempt`);
      if (JSON.stringify(result?.deferred) !== '[2,3,4,5,6]' || result?.nextCursor !== 2) violations.push(`${key}: earliest yielded PR lost from cursor`);
      if (result?.yieldedForAdoption !== true) violations.push(`${key}: adoption yield not reported`);
      const expected = key === 'afterLaunch' ? [2, 3, 4, 5, 6] : [2];
      if (JSON.stringify(result?.refusals?.filter(row => row.kind === 'adoption-yield').map(row => row.pr)) !== JSON.stringify(expected)) {
        violations.push(`${key}: missing adoption-yield refusals`);
      }
    }
    if (report?.missingHost?.dispatched?.length !== 0 || report?.missingHost?.refusals?.filter(row => row.kind === 'host-load').length !== 6) {
      violations.push('missing host recheck must refuse every launch');
    }
    return violations;
  },
};
