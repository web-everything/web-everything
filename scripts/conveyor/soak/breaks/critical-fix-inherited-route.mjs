/**
 * PR #5382 red-team finding: valid inherited or missing fix:critical-work routes return null and
 * crash critical fix dispatch. Exercise the disk-backed policy reader and both Claude launch paths
 * in an isolated runtime copy; no worker or GitHub operation is launched.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = 'scripts/conveyor/reconcile-fix-dispatch.mjs';
const CHILD = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dispatchFix, launchTableFor } from './scripts/conveyor/reconcile-fix-dispatch.mjs';
import { validateRoutingPolicy } from './scripts/lib/dispatch-routing-policy.mjs';
const policyPath = new URL('./scripts/lib/dispatch-routing-policy.json', import.meta.url);
const original = JSON.parse(readFileSync(policyPath, 'utf8'));
const planned = { pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x',
  scope: ['we:scripts/lib/provider-routing.mjs'] };
const fixSettings = { claudeEscalationModel: 'sonnet' };
const violations = [], observations = [];
for (const variant of ['inherited', 'missing', 'inherited-no-opus-alias', 'missing-no-opus-alias', 'explicit']) {
  const policy = structuredClone(original);
  if (variant.startsWith('inherited')) policy.operations['fix:critical-work'] = { inherit: true };
  else if (variant.startsWith('missing')) delete policy.operations['fix:critical-work'];
  else policy.operations['fix:critical-work'] = { provider: 'claude', model: 'sonnet', effort: 'medium', fallback: [] };
  if (variant.endsWith('no-opus-alias')) delete policy.aliases.claude.opus;
  validateRoutingPolicy(policy);
  writeFileSync(policyPath, JSON.stringify(policy));
  for (const wrapped of [false, true]) {
    try {
      const expected = variant === 'explicit' ? 'sonnet' : 'opus';
      const table = launchTableFor(planned, null, { fixSettings });
      assert.equal(table.model, original.aliases.claude[expected]);
      assert.equal(table.effort, variant === 'explicit' ? 'medium' : 'high');
      let argv;
      dispatchFix(planned, {
        root: '/repo', readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SCOPE}} {{SESSION_SLUG}}',
        readFixClaim: () => null, acquireClaim: () => ({ ok: true }), postNotice: () => {},
        grantConflictHelper: () => {}, readHistoryInputs: () => null,
        wrapFix: wrapped, fixSettings, executorDecision: { executor: 'claude', reason: 'critical work' },
        spawnAgent: args => { argv = args; return 'backgrounded · abcdef12 · fix-42\\n'; },
        launchWrapped: spec => { argv = spec.bgArgv; return { handle: 'pid:1' }; },
      });
      assert.ok(argv, 'Claude launcher must be reached');
      assert.equal(argv[argv.indexOf('--model') + 1], expected);
      observations.push(variant + ' wrapped=' + wrapped + ' model=' + expected);
    } catch (error) { violations.push(variant + ' wrapped=' + wrapped + ': ' + error.message); }
  }
}
process.stdout.write(JSON.stringify({ violations, observations }));
`;

export default {
  id: 'critical-fix-inherited-route',
  title: 'critical fix dispatch survives inherited and missing critical-work routes',
  card: 'PR #5382 red-team finding, 2026-10-15',
  fixedBy: { sha: 'HEAD', where: 'lane/sonnet-default', paths: [SOURCE] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('critical-work fallback');
  },
  async run({ log, sourceRoot = ROOT } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-critical-fix-route-'));
    try {
      cpSync(join(sourceRoot, 'scripts'), join(dir, 'scripts'), { recursive: true });
      cpSync(join(sourceRoot, 'skills-src'), join(dir, 'skills-src'), { recursive: true });
      cpSync(join(sourceRoot, 'schemas'), join(dir, 'schemas'), { recursive: true });
      cpSync(join(sourceRoot, 'src/_data'), join(dir, 'src/_data'), { recursive: true });
      cpSync(join(sourceRoot, 'package.json'), join(dir, 'package.json'));
      symlinkSync(join(sourceRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, 'child.mjs'), CHILD);
      const report = JSON.parse(execFileSync(process.execPath, [join(dir, 'child.mjs')], {
        cwd: dir, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, WE_DISPATCH_ROUTING_SNAPSHOT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      }));
      log?.(JSON.stringify(report));
      return report;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge: report => report.violations,
};
