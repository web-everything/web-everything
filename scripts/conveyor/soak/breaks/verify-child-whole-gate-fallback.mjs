/**
 * @file breaks/verify-child-whole-gate-fallback.mjs — live break, 2026-10-05 (coroner-2, held card 66).
 *
 * LIVE INCIDENT: after #4015 (per-phase admission) the verify daemon still ran gates with `admissionMode: gate`,
 * `relatedMode: null` — 16-21 min instead of 3-5 (lane-14 @20fa583f 00:48Z; lanes 5, 9, 10 at 00:53Z). The lanes
 * stamped their default gate with their OWN verify-lane (older base, no verify-settings.json ⇒ relatedMode `all`)
 * while the daemon child resolved under its plist env (`WE_VERIFY_RELATED=import-only`). The child only varied the
 * standards policy when matching the stamped `--gate`, so it took the command as an opaque explicit gate.
 *
 * FIX — `scripts/lib/verify-lane-gate.mjs` `matchRequestedDefaultGate` (setting `matchRequestVariants: true`),
 * used by `scripts/verify-lane.mjs` for a dispatched child.
 *
 * SCENARIO: the requester stamped under (relatedMode all, factor 1); the child resolves under (import-only, 3).
 * RED = no selected plan is recovered (whole-gate admission). GREEN = the requester's own selection is returned.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'verify-child-whole-gate-fallback',
  title: 'a dispatched verify child fell back to whole-gate admission when the requester stamped under other settings',
  card: 'held card 66 (coroner-2, 2026-10-05) — lane/verify-gate-waste',
  fixedBy: { sha: '418fbfdbe', where: 'lane/verify-gate-waste', paths: ['scripts/lib/verify-lane-gate.mjs', 'scripts/verify-lane.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/lib/verify-lane-gate.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('export function matchRequestedDefaultGate');
  },
  async run({ log } = {}) {
    const gate = await import('../../../lib/verify-lane-gate.mjs');
    const changedFiles = ['scripts/a.mjs'];
    // A resolver shaped like resolveDefaultGate: the command depends on related mode, timeout factor and standards.
    const resolveUnder = (env) => {
      const relatedMode = env.WE_VERIFY_RELATED || 'import-only';
      const factor = Number(env.WE_VERIFY_TEST_TIMEOUT_FACTOR || 3);
      const targets = relatedMode === 'all' ? 'scripts/a.mjs scripts/__tests__/a.test.mjs' : 'scripts/a.mjs';
      const flags = factor === 1 ? '' : ` --testTimeout=${5000 * factor} --hookTimeout=${10000 * factor}`;
      const standards = (env.WE_VERIFY_STANDARDS || 'auto') === 'always' ? ' && npm run check:standards' : '';
      const testCommand = `npx vitest related ${targets} --run --passWithNoTests${flags}`;
      return { command: testCommand + standards, testCommand, decision: { changedFiles, relatedMode, testTimeoutFactor: factor } };
    };
    const stamped = resolveUnder({ WE_VERIFY_RELATED: 'all', WE_VERIFY_TEST_TIMEOUT_FACTOR: '1', WE_VERIFY_STANDARDS: 'always' }).command;
    const resolved = resolveUnder({});
    const plan = gate.matchRequestedDefaultGate
      ? gate.matchRequestedDefaultGate({ gate: stamped, env: {}, resolved, resolveUnder })
      : (resolved.command === stamped ? resolved : null);
    log?.(JSON.stringify({ stamped, plan: plan?.testCommand ?? null }));
    const violations = [];
    if (!plan) violations.push({ invariant: 'whole-gate-fallback', detail: 'the stamped default gate was not recognized — the child would run it with whole-gate admission' });
    else if (!stamped.startsWith(plan.testCommand)) violations.push({ invariant: 'weaker-gate', detail: `the recovered plan runs ${plan.testCommand}, not the stamped selection` });
    return { violations, out: { plan: plan?.testCommand ?? null } };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
