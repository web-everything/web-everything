/** PR #5370: replay the production routing → dispatch adapter → feature runner hand-off, without processes. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'argon-feature-dispatch',
  title: 'feature builds launch Argon with Codex checking and honour backend/checker holds',
  card: 'PR #5370 / 6163',
  fixedBy: { sha: 'HEAD', where: 'lane/argon-build', paths: [
    'scripts/lib/dispatch-contracts.mjs', 'scripts/lib/dispatch-routing-policy-io.mjs',
    'scripts/lib/dispatch-routing-policy.json', 'scripts/operations/dispatch-providers/probation-worker.mjs',
    'scripts/operations/probation-build-run.mjs', 'scripts/operations/dispatch-lane-io.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/operations/dispatch-providers/probation-worker.mjs'), 'utf8')
      .includes("taskTypes: Object.freeze(['doc-fix', 'test-fix', 'build-new-feature'])")
      && readFileSync(join(root, 'scripts/operations/dispatch-lane-io.mjs'), 'utf8').includes('routing-fallback: ${kind} → unchanged path');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, why) => { if (!ok) violations.push(why); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    try {
      const { resolveDispatchRoute } = await load('scripts/lib/dispatch-routing-policy-io.mjs');
      const { PROBATION_WORKERS } = await load('scripts/lib/provider-routing.mjs');
      const { routeDispatchProvider } = await load('scripts/operations/dispatch-lane-io.mjs');
      const { probationWorkerDetachedProvider } = await load('scripts/operations/dispatch-providers/probation-worker.mjs');
      const { parseArgs } = await load('scripts/operations/probation-build-run.mjs');
      const routingPolicy = JSON.parse(readFileSync(join(sourceRoot, 'scripts/lib/dispatch-routing-policy.json'), 'utf8'));
      const task = { kind: 'build', size: 3, scopePaths: ['we:scripts/example.mjs'] };
      const trial = { subjectClass: 'work-agent', provider: 'codex', model: PROBATION_WORKERS.codex.model, taskType: 'build-new-feature' };
      for (const held of [null, 'antigravity', 'codex']) {
        const scorecards = [trial, ...(held ? [{ provider: held, status: 'quota-exhausted',
          scoredAt: '2026-10-15T10:00:00Z', quotaResetsAt: '2099-01-01T00:00:00Z' }] : [])];
        const route = resolveDispatchRoute(task, { routingPolicy, scorecards, now: Date.parse('2026-10-15T12:00:00Z') });
        if (held) {
          check(route.probationWorker?.id !== 'antigravity-argon', `${held} hold still yielded Argon`);
          if (held === 'codex') check(!route.probationWorker, 'held Codex still yielded a worker/checker');
          continue;
        }
        check(route.probationWorker?.id === 'antigravity-argon', 'production feature policy bypassed Argon');
        let argv;
        routeDispatchProvider({ launchKind: 'build', num: '9001', sessionSlug: 'argon-soak',
          repo: 'we', probationWorker: route.probationWorker }, {
          probationLaunch: 'on', scriptExists: () => true,
          agent: () => { throw new Error('feature fell back to Claude'); },
          probation: request => probationWorkerDetachedProvider(request, {
            logPathFor: () => '/tmp/argon-soak.log',
            spawnDetached: args => { argv = args; return { pid: 123 }; },
          }),
        });
        const parsed = parseArgs(argv.slice(1));
        check(parsed.taskType === 'build-new-feature' && parsed.worker.checker === 'codex'
          && parsed.worker.simpleOnly === false, 'feature identity or checker lost at the runner boundary');
        // The inherited route has no policy fallback chain: a missing agy (worker) binary must yield to the
        // next eligible roster worker (Codex); a missing codex (Codex itself, and Argon's checker) must take the
        // unchanged Claude path — never a doomed detached run.
        for (const [missing, expected] of [['antigravity', 'probation:codex'], ['codex', 'claude']]) {
          let launched = 'none';
          try {
            launched = routeDispatchProvider({ launchKind: 'build', num: '9001', sessionSlug: 'argon-soak',
              repo: 'we', probationWorker: route.probationWorker, table: { model: 'sonnet' } }, {
              probationLaunch: 'on', scriptExists: () => true, providerAvailable: provider => provider !== missing,
              agent: () => 'claude', probation: request => `probation:${request.probationWorker.id}`,
            });
          } catch (error) { launched = `refused: ${error.message}`; }
          check(launched === expected, `${missing} unavailable: the inherited Argon pick launched '${launched}', expected '${expected}'`);
        }
      }
    } catch (error) { violations.push(error.message); }
    return { violations };
  },
  judge: report => report.violations,
};
