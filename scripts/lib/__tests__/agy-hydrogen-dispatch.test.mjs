import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, resolveOperationRoute, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { resolveDispatchRoute } from '../dispatch-routing-policy-io.mjs';
import { decideDispatchRoute } from '../dispatch-contracts.mjs';
import { criticalWorkVerdict } from '../critical-work.mjs';
import { assertAgyHydrogenBuildAdmission } from '../agy-sandbox.mjs';
import { runProbationBuild } from '../../operations/probation-build-run.mjs';

const model = 'gemini-4-hydrogen-medium';
const dispatch = { kind: 'build', taskType: 'doc-fix', size: 1, simple: true, scopePaths: ['we:docs/guide.md'] };
// Explicit policy routing exercises all production admission guards.
function hydrogenPolicy() {
  const policy = structuredClone(DEFAULT_ROUTING_POLICY);
  policy.operations['build:doc-fix'] = { provider: 'agy-gemini', model: 'hydrogen', fallback: [{ provider: 'claude', model: 'sonnet' }] };
  return policy;
}
const options = () => ({ routingPolicy: hydrogenPolicy(), env: { WE_ROUTING_BUILDER: 'auto' } });

describe('production Hydrogen dispatch admission', () => {
  it.each(['doc-fix', 'prevention-card', 'prepare-card'])('%s defaults select Hydrogen medium', taskType => {
    for (const entry of [DEFAULT_ROUTING_POLICY.operations[taskType], DEFAULT_ROUTING_POLICY.taskTypes[taskType]])
      expect(entry).toMatchObject({ provider: 'agy-gemini', model: 'hydrogen' });
    expect(resolveDispatchRoute(dispatch, { routingPolicy: DEFAULT_ROUTING_POLICY, env: {} }))
      .toMatchObject({ outcome: 'refused', refusal: expect.stringMatching(/confinement unavailable/) });
  });

  it('derives the human-required restriction without a supplied gate verdict', () => {
    expect(decideDispatchRoute({ ...dispatch, humanRequired: true }, options()))
      .toMatchObject({ outcome: 'routed', routed: 'claude', probationWorker: null });
  });

  it.each(['docs/', 'docs', 'we:docs/', 'scripts/', 'frontierui:.github/'])('treats ancestor scope %s as critical', path => {
    expect(criticalWorkVerdict({ filesTouched: [path] }).critical).toBe(true);
  });
  it('retains declared critical scope when a card path is also supplied', () => {
    expect(decideDispatchRoute({ ...dispatch, scopePaths: ['we:docs/'], cardPath: 'backlog/1234.md' }, options()))
      .toMatchObject({ outcome: 'routed', routed: 'claude', probationWorker: null });
  });

  it.each([8, undefined])('refuses policy worker reconstruction with size %s', size => {
    expect(decideDispatchRoute({ ...dispatch, size }, options()))
      .toMatchObject({ outcome: 'refused', refusal: expect.stringMatching(/envelope/) });
  });
  it('refuses non-simple policy workers before a checker can run', () => {
    expect(decideDispatchRoute({ ...dispatch, simple: false }, options()))
      .toMatchObject({ outcome: 'refused', refusal: expect.stringMatching(/simple/) });
  });
  it('refuses executable documentation through restrictive target admission', () => {
    expect(resolveDispatchRoute({ ...dispatch, scopePaths: ['we:docs/tool.mjs'] }, options()))
      .toMatchObject({ outcome: 'refused', refusal: expect.stringMatching(/admissible documentation/) });
  });
  it.each(['hydrogen', 'hydrogen-low'])('reaches confinement refusal for %s with otherwise admitted evidence', alias => {
    const opts = options();
    opts.routingPolicy.operations['build:doc-fix'].model = alias;
    expect(resolveDispatchRoute(dispatch, opts))
      .toMatchObject({ outcome: 'refused', probationWorker: null, refusal: expect.stringMatching(/confinement unavailable/) });
  });
  it('fails closed on an unregistered delivery identity', () => {
    expect(() => assertAgyHydrogenBuildAdmission(dispatch, 'gemini-4-hydrogen-high')).toThrow(/not eligible for delivery/);
  });
  it.each([
    [{ size: 8 }, /envelope/], [{ size: undefined }, /envelope/],
    [{ simple: false }, /simple/], [{ humanRequired: true }, /critical/],
    [{ scopePaths: ['we:docs/'] }, /critical/],
    [{ scopePaths: ['we:docs/tool.mjs'] }, /admissible/],
    [{ scopePaths: ['docs/a.md', 'docs/b.md', 'docs/c.md'] }, /envelope/],
  ])('the live launch guard refuses incomplete or unsafe evidence %j', (extra, reason) => {
    expect(() => assertAgyHydrogenBuildAdmission({ ...dispatch, ...extra }, model)).toThrow(reason);
    expect(() => assertAgyHydrogenBuildAdmission({ ...dispatch, ...extra }, model)).toThrow(/use another provider or request operator review/);
  });

  it.each(['doc-fix', 'prepare', 'test-fix'])('direct %s runner hand-offs cannot bypass admission or start a worker', async taskType => {
    const runWorker = vi.fn(), claim = vi.fn();
    const result = await runProbationBuild({ num: '1234', session: 'guard-test', taskType,
      scope: dispatch.scopePaths, worker: { id: 'antigravity-gemini', model, executor: 'antigravity' } }, {
      openBlockers: () => [], acquireLane: () => 'lane', resetHookSurface: () => ({ clean: true }),
      findItem: () => ({ raw: '---\nsize: 1\nsimple: true\n---\n', scope: dispatch.scopePaths }),
      log: () => {}, runWorker, claim,
    });
    expect(result).toMatchObject({ outcome: 'escalated-needs-human', executor: 'none', detail: expect.stringMatching(taskType === 'doc-fix' ? /confinement unavailable/ : /documentation builds/) });
    expect(runWorker).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});


describe('Hydrogen never resolves on review, juror, judge or merge-path routes', () => {
  const identities = ['hydrogen', 'hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low'];
  const keys = [...new Set([
    'review-seat', 'review-seat:mandatory:security', 'review-seat:mandatory:correctness',
    'review-seat:advisory:*', 'review-seat:advisory:agy-correctness', 'review-seat:red-team',
    'extra-juror:*', 'extra-juror:security', 'review-seat:extra-juror:security',
    'judge', 'judge:review-pr', 'review', 'red-team', 'merge', 'land',
    ...Object.keys(DEFAULT_ROUTING_POLICY.operations).filter(key => /review|juror|judge|red-team|merge|land/.test(key)),
  ])];
  const inputs = keys.flatMap(operation => {
    const separator = operation.indexOf(':');
    return [{ operation }, ...(separator < 0 ? [] : [{
      operation: operation.slice(0, separator), taskType: operation.slice(separator + 1),
    }])];
  });
  const safeRoute = { provider: 'claude', model: 'sonnet', fallback: [] };
  const unsafe = (provider, model) => ({ provider, model, fallback: [] });

  it.each(inputs)('default policy excludes Hydrogen for %j', input => {
    const route = resolveOperationRoute(input);
    for (const seat of route ? [route, ...route.fallback] : []) {
      expect(seat.model).not.toMatch(/hydrogen/);
    }
  });

  for (const provider of ['agy-gemini', 'antigravity']) {
    it.each(identities)(`${provider}/%s refuses every protected operation override before resolution`, model => {
      for (const input of inputs) {
        const key = input.taskType ? `${input.operation}:${input.taskType}` : input.operation;
        const base = structuredClone(DEFAULT_ROUTING_POLICY);
        base.operations[key] = { inherit: true };
        expect(() => resolveOperationRoute({ ...input,
          policy: applyRoutingOverrides(base, { [key]: unsafe(provider, model) }),
        })).toThrow(/small-tier model.*refused.*larger model or request operator review/);
      }
    });

    it.each(identities)(`${provider}/%s cannot bypass validation through inherited routes or fallbacks`, model => {
      for (const input of inputs) {
        for (const placement of ['primary', 'fallback', 'task-type', 'wildcard', 'overlay']) {
          const policy = structuredClone(DEFAULT_ROUTING_POLICY);
          const key = input.taskType ? `${input.operation}:${input.taskType}` : input.operation;
          const route = unsafe(provider, model);
          const options = { ...input, policy };
          if (placement === 'primary') policy.operations[key] = route;
          if (placement === 'fallback') policy.operations[key] = { ...safeRoute, fallback: [route] };
          if (placement === 'task-type') {
            policy.operations[key] = { inherit: true };
            options.taskType = input.taskType ?? 'small-delivery';
            policy.taskTypes[options.taskType] = route;
          }
          if (placement === 'wildcard') {
            delete policy.operations[key];
            delete policy.operations[input.operation];
            delete policy.operations[input.operation.split(':')[0]];
            policy.operations['*'] = route;
          }
          if (placement === 'overlay') {
            policy.operations[key] = { inherit: true };
            options.aiRouting = route;
            options.operatorKeys = [];
          }
          const refusal = placement === 'overlay' && provider === 'antigravity'
            ? /small-tier model.*refused|unsupported seat provider/ : /small-tier model.*refused/;
          expect(() => resolveOperationRoute(options), `${key}: ${placement}`).toThrow(refusal);
        }
      }
    });
  }

  it.each(['neon', 'gemini-4-neon-high'])('also refuses the small tier %s in protected policy entries', model => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations.judge = unsafe('agy-gemini', model);
    expect(() => validateRoutingPolicy(policy)).toThrow(/small-tier model.*refused/);
  });
});
