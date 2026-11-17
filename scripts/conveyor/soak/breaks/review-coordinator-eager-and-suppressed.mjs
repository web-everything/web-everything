/** PR #6956 / R903: a review coordinator crashed CLI imports and never reached added seats. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DISPATCH = 'scripts/operations/review-dispatch.mjs';

export default {
  id: 'review-coordinator-eager-and-suppressed',
  title: 'review coordinator is lazy, reaches added seats, and respects operator-owned pins',
  card: 'PR #6956 operator send-back R903',
  fixedBy: { sha: 'HEAD', where: 'lane/ai-routing-review-sites', paths: [DISPATCH] },
  fixPresent(root) {
    const source = readFileSync(join(root, DISPATCH), 'utf8');
    return source.includes('operatorKeys ??= readRoutingPolicy.operatorKeys();')
      && source.includes('aiRouting: seatAiRouting');
  },
  async run({ sourceRoot = REPO_ROOT, log } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-review-coordinator-'));
    const violations = [];
    try {
      const preferences = join(dir, 'preferences.json');
      writeFileSync(preferences, '{}');
      const moduleUrl = pathToFileURL(join(sourceRoot, DISPATCH)).href;
      const policyUrl = pathToFileURL(join(sourceRoot, 'scripts/lib/dispatch-routing-policy-io.mjs')).href;
      const probes = [
        { name: 'lazy-import', coordinator: { effort: 'ultra' },
          code: `await import(${JSON.stringify(moduleUrl)});` },
        { name: 'added-seat-routing-and-operator-pins',
          coordinator: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
          code: `
            import assert from 'node:assert/strict';
            const { reviewSeatRoutes } = await import(${JSON.stringify(moduleUrl)});
            const { readRoutingPolicy } = await import(${JSON.stringify(policyUrl)});
            const routingPolicy = readRoutingPolicy();
            const context = { routingPolicy, available: ['codex', 'agy-claude'],
              providerAvailable: () => true, scorecards: [], callsRemaining: 10 };
            const result = reviewSeatRoutes(context);
            assert.equal(result.routes.length, 3);
            assert.ok(result.routes.every(r => r.provider === 'codex' && r.model === 'gpt-6-astra' && r.effort === 'high'));
            for (const key of ['review-seat:standards-conformance', 'review-seat', 'review', '*']) {
              const protectedContext = { ...context, available: ['codex'], operatorKeys: [key] };
              const baseline = reviewSeatRoutes({ ...protectedContext, aiRouting: {} }).routes.find(r => r.key === 'standards-conformance');
              const protectedRoute = reviewSeatRoutes(protectedContext).routes.find(r => r.key === 'standards-conformance');
              assert.deepEqual(protectedRoute, baseline);
              assert.equal(protectedRoute.model, 'gpt-6-luna');
              assert.equal(protectedRoute.effort, 'medium');
            }
          ` },
      ];
      for (const probe of probes) {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe.code], {
          encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, WE_PLATFORM_PREFERENCES_FILE: preferences,
            WE_CODEX_MODEL_BY_TASK: '{"review":{"model":"gpt-6-luna","effort":"medium"}}',
            WE_AI_ROUTING: JSON.stringify({ review: { coordinator: probe.coordinator } }),
          },
        });
        if (child.error || child.status !== 0) {
          violations.push({ invariant: probe.name, detail: String(child.error ?? child.stderr).slice(0, 3000) });
        }
        log?.(`${probe.name}: ${child.status === 0 ? 'GREEN' : 'RED'}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return { violations };
  },
  judge: report => report.violations.map(v => `${v.invariant}: ${v.detail}`),
};
