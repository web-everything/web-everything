/**
 * Live #3915 (2026-10-04): based on #3889's lane, so main-only CI never starts.
 * Replay through the real pass: expected absence must name the base, not fail a check read.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'stacked-pr-missing-checks-refused',
  title: 'a stacked PR waits for its base instead of refusing missing required checks (#3915)',
  card: 'PR #3915; base PR #3889',
  fixedBy: { sha: 'uncommitted', where: 'working tree', paths: ['scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes("kind: basePrNumber !== null ? 'stacked-awaiting-base'");
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { runReconcilePass } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const checks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
    const pr = { number: 3915, headRefName: 'lane/stacked', baseRefName: 'lane/fix-ruling-needed-surface',
      headRefOid: 'a'.repeat(40), isDraft: true, labels: [], comments: [], statusCheckRollup: [] };
    const base = { ...pr, number: 3889, headRefName: pr.baseRefName, baseRefName: 'main',
      statusCheckRollup: checks.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })) };
    let reads = 0;
    const pass = prs => runReconcilePass({ repo: 'we', readPrs: () => prs, readAgents: () => [], enrich: a => a,
      readRequiredChecks: () => ({ checks }), readChecks: () => { reads++; return []; },
      enrichMainRed: prs => ({ prs, mainRedWindows: [] }), enrichAlreadyLanded: p => p, enrichBaseRef: p => p,
      enrichSystemFix: p => p, enrichFixClaims: p => p, enrichTimeouts: p => p, enrichReferralHolds: p => p,
      resolveMainSha: () => null });
    const violations = [];
    const live = pass([pr, base]);
    if (reads || live.refusals.some(r => r.kind === 'check-read-failed')) violations.push('stacked absence read or refused');
    if (!live.notes.some(n => n.kind === 'stacked-awaiting-base' && n.basePrNumber === 3889)) violations.push('base PR not surfaced');
    if (live.dispatch.some(d => d.prNumber === 3915)) violations.push('unchecked stack dispatched');
    if (!pass([pr]).notes.some(n => n.kind === 'stacked-base-orphaned' && n.basePrNumber === null)) violations.push('orphan not surfaced');
    if (!pass([{ ...pr, baseRefName: 'main' }]).owedTriggers.some(t => t.prNumber === 3915)) violations.push('main absence not owed a re-trigger');
    return { violations };
  },
  judge(report) { return report.violations; },
};
