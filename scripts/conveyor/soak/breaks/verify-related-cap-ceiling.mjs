import { requeueGateCeiling } from '../../verify-dispatch.mjs';
import { resolveDefaultGate } from '../../../lib/verify-lane-gate.mjs';

export default {
  id: 'verify-related-cap-ceiling',
  title: 'bounded related tests and one audited retry after a gate ceiling',
  card: 'verify-related-cap-dor-2026-11-21',
  fixedBy: { sha: 'verify-related-cap', where: 'scripts/conveyor/verify-dispatch.mjs', paths: ['scripts/conveyor/verify-dispatch.mjs'] },
  fixPresent() { return true; },
  async run() {
    const violations = [];
    const plan = resolveDefaultGate({ env: {}, allowCardOnlySkip: false,
      fileConfig: { selection: 'pr', relatedMode: 'import-only', relatedMaxTests: 40, alwaysRunTests: ['own.test.mjs'] },
      runGit: args => {
        if (args[0] === 'merge-base') return 'base';
        if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : 'scripts/lib/hub.mjs';
        if (args[0] === 'ls-files') return '';
        throw new Error('graph unavailable');
      } });
    if (!plan.command.includes("vitest run 'own.test.mjs'") || plan.command.includes('vitest related')) violations.push('unbounded gate');
    let marker = { status: 'infrastructure-failure', sha: 'head', runId: 'old-job', suites: plan.command };
    let queued = 0;
    const o = { dir: 'lane', headSha: 'head', runId: 'old-job', afterJob: 'old-job', timedOutPhase: 'gate', ceilingMs: 60000,
      readState: () => ({ headSha: 'head', marker }), writeMarker: m => { marker = m; }, enqueue: () => { queued++; },
      fallbackGate: () => ({ command: plan.command, selection: plan.decision.selection }) };
    if (!requeueGateCeiling(o) || marker.requeue?.afterJob !== 'old-job') violations.push('missing audited retry');
    marker = JSON.parse(JSON.stringify({ ...marker, status: 'infrastructure-failure' }));
    if (requeueGateCeiling({ ...o, afterJob: 'next-job' }) || queued !== 1) violations.push('retry loop');
    return { violations };
  },
  judge(report) { return report.violations; },
};
