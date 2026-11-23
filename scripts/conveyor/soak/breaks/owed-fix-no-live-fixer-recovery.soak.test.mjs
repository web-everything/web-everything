import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import b, { probe } from './owed-fix-no-live-fixer-recovery.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

const root = fileURLToPath(new URL('../../../../', import.meta.url));

describe('owed-fix no-live-fixer behavioral replay', () => {
  it.each([
    ['ordinaryParkedRows', 'preserves ordinary planner rows across draft, closed and referral recovery gates on later ticks'],
    ['ordinaryAuthFlake', 'preserves ordinary fix and CI-heal rows when the recovery login probe fails'],
    ['kindIsolation', 'dispatches an owed fix after CI-heal escalates on the same head'],
    ['releaseFailure', 'a refused or thrown release consumes one retry and escalates once'],
    ['recovery', 'releases a stale claim and dispatches exactly once for its head'],
    ['escalation', 'escalates the second miss once without redispatching'],
    ['parked', 'preserves operator-parked and draft claims without dispatch'],
    ['unreadable', 'refuses unreadable liveness evidence without side effects'],
    ['cachedPlan', 'restores the repair on a structured clone of the plan, as the daemon plan cache serves it'],
    ['capacityDeferral', 'keeps the allowance when capacity refuses the launch, and never escalates a never-launched repair'],
  ])('%s: %s', scenario => {
    expect(probe(root, scenario).violations).toEqual([]);
  });

  it.each(['never-release', 'always-redispatch', 'missing-module'])(
    'rejects %s behavior in the supplied checkout', regression => {
      const dir = mkdtempSync(join(tmpdir(), 'owed-fix-regression-'));
      try {
        if (regression !== 'missing-module') {
          mkdirSync(join(dir, 'scripts/conveyor'), { recursive: true });
          const source = new URL('../../owed-fix-recovery.mjs', import.meta.url).href;
          writeFileSync(join(dir, 'scripts/conveyor/owed-fix-recovery.mjs'), `
            import { recoverOwedFixes as realRecover } from ${JSON.stringify(source)};
            export function recoverOwedFixes(input, deps) {
              ${regression === 'never-release'
                ? 'return realRecover(input, { ...deps, releaseClaim: () => ({ released: true }) });'
                : `const out = realRecover(input, deps);
                   out.dispatch = deps.plan({ ...input, prs: input.prs.map(pr => ({ ...pr, fixClaim: null })) }).dispatch;
                   return out;`}
            }
          `);
        }
        expect(probe(dir).violations.length).toBeGreaterThan(0);
        expect(b.fixPresent(dir)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
