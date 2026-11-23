/** A passing fallback must collect fresh checks before omitting a registered overlay. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeFallbackFreshSmoke } from '../fixtures/rebuild-fallback-fresh-probe.mjs';

export default {
  id: 'rebuild-fallback-fresh-smoke',
  title: 'fresh fallback smoke adopts main and drops the broken overlay',
  card: 'PR #7368 / x1b8hlo',
  fixedBy: { sha: 'working-tree', where: 'working-tree', paths: ['scripts/lib/daemon-rebuild/smoke.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/daemon-rebuild/smoke.mjs'), 'utf8').includes('!freshAdoption && firstSmoke');
  },
  async run() {
    return { immediate: await probeFallbackFreshSmoke(), deferred: await probeFallbackFreshSmoke({ readyOnly: true }) };
  },
  judge(report) {
    return Object.entries(report).flatMap(([kind, r]) => {
      const ok = r.adopted && r.onMain && r.dropped && r.adoptedState && r.checks.length === 2
        && r.checks[0].bad && !r.checks[0].pass && r.checks[0].ghCalls === 2
        && !r.checks[1].bad && r.checks[1].pass && r.checks[1].ghCalls === 2
        && r.checks[1].reuseRows.length === 0 && r.checks[1].reused.length === 0
        && (!r.deferred || (r.deferred.recorded && r.deferred.unchanged && r.deferred.registered === 1));
      return ok ? [] : [`${kind}: fresh fallback adoption or overlay removal failed: ${JSON.stringify(r)}`];
    });
  },
};
