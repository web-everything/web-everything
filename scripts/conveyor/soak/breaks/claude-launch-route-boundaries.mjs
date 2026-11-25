/** PR #7468: the route guard blocked sibling CI heals and intentional Claude supervisors. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Native soak runs must not inherit an operator's live routing overrides or completion store.
function isolated(run) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-claude-route-'));
    const overrides = { WE_PLATFORM_PREFERENCES_FILE: join(dir, 'preferences.json'),
      OPERATION_COMPLETIONS_DIR: join(dir, 'completions') };
    const prior = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    writeFileSync(overrides.WE_PLATFORM_PREFERENCES_FILE, '{}');
    Object.assign(process.env, overrides);
    try { return await run(); }
    finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export default {
  id: 'claude-launch-route-boundaries',
  title: 'Claude route evidence preserves sibling CI heals, wrapped supervisors and retryable no-start refusals',
  card: 'PR #7468',
  fixedBy: { sha: 'PR-7468-repair', where: 'lane/direct-exec-guard', paths: [
    'scripts/lib/dispatch-routing-policy.mjs', 'scripts/operations/worker-wrapper-launch.mjs',
    'scripts/operations/dispatch-lane-io.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs',
  ] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/lib/dispatch-routing-policy.mjs'), 'utf8').includes('export function claudeSupervisorRouteFor');
  },
  run: isolated(async () => {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const load = path => import(pathToFileURL(join(root, path)).href);
    const { defaultClaudeProvider, createDispatchSinks } = await load('scripts/operations/dispatch-lane-io.mjs');
    const { launchWrappedClaudeWorker } = await load('scripts/operations/worker-wrapper-launch.mjs');
    const { dispatchFix } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { DISPATCH_EFFECT } = await load('scripts/operations/dispatch-lane.mjs');
    const violations = [];
    const specs = [];
    const wrap = options => launchWrappedClaudeWorker({ ...options,
      launch: spec => { specs.push(spec); return { wrapperPid: 42 }; },
    });
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const request = { sessionId, sessionSlug: 'route-replay', launchKind: 'ci-heal', repo: 'frontierui',
      pr: 42, prompt: 'Repair sibling CI', cwd: '/unused', table: null, policyRoute: null,
      advisorFor: () => ({ reason: 'kind-not-in-trial' }),
    };
    for (const shape of [{}, { extraArgs: ['--model', 'opus'], modelReason: 'operator pin' }]) {
      const count = specs.length;
      try {
        const handle = defaultClaudeProvider({ ...request, ...shape }, { wrapKind: () => true, launchWrapped: wrap });
        if (handle !== 'pid:42' || specs.length !== count + 1 || specs.at(-1).route.provider !== 'claude') {
          violations.push('sibling CI heal did not launch exactly one Claude worker with route evidence');
        }
      } catch (e) { violations.push(`sibling CI heal refused: ${e.message}`); }
    }
    for (const executor of ['codex', 'antigravity']) {
      const count = specs.length;
      let stamped = 0;
      try {
        const result = dispatchFix({ pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/build-docs.mjs'] }, {
          root: '/repo', readBrief: () => '{{PR_NUM}} {{LANE_REF}}', readFixClaim: () => null,
          acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, stampExecutor: () => {},
          stampRunner: () => { stamped++; }, postNotice: () => {}, mintSessionId: () => sessionId,
          sessionCwdFor: () => '/unused', ensureSessionCwd: p => p, grantConflictHelper: () => {},
          isolateSession: () => ({}), resolveSettingsEnv: () => null,
          advisorFor: () => ({ enabled: false, reason: 'kind-not-in-trial' }), recordAdvisor: () => {},
          wrapFix: true, launchWrapped: wrap,
          executorDecision: { executor, mode: 'wrapped', policyRoute: { provider: executor } },
        });
        if (result.agentId !== 'pid:42' || specs.length !== count + 1 || stamped !== 1
          || specs.at(-1).route.reason !== `wrapped ${executor} task: Claude supervisor`) {
          violations.push(`${executor} supervisor did not start with its own route and runner`);
        }
      } catch (e) { violations.push(`${executor} supervisor refused: ${e.message}`); }
    }
    let released = 0;
    const sinks = createDispatchSinks({ root: '/repo', mintSessionId: () => sessionId,
      reserveLane: () => ({ reserved: true, lane: 2, session: 'route-replay' }), releaseLane: () => { released++; },
      sessionCwdFor: () => '/unused', ensureSessionCwd: p => p, resolveSettingsEnv: () => null,
      resolveLaneGrant: () => ({}), grantLanePermission: () => {}, ensureWorktreeIsolation: () => {},
      provider: r => defaultClaudeProvider({ ...r, advisorFor: request.advisorFor }, {
        wrapKind: () => true, launchWrapped: wrap,
      }),
    });
    const count = specs.length;
    try {
      await sinks[DISPATCH_EFFECT]({ ...request, lane: 2, routing: {
        policyRoute: { provider: 'codex', fallback: [{ provider: 'claude' }] },
      } });
      violations.push('unreduced Codex route was accepted as a taken Claude fallback');
    } catch (e) {
      if (!e.notApplied || released !== 1) violations.push('guard refusal did not release the lane as proven not started');
    }
    if (specs.length !== count) violations.push('refused route started a process');
    return { violations };
  }),
  judge: report => report.violations,
};
