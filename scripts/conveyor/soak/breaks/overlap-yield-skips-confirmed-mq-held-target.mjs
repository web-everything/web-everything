/** A typed, exact-head refusal removes a yield delay only for the current pass. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SOURCE = 'scripts/conveyor/overlap-yield-enqueueable.mjs';

export function probe(filter, keyOf) {
  const repo = 'fixture/overlap', headSha = 'a'.repeat(40);
  const row = {repo,number:42,headSha,requiredCheckGreen:true,labels:['ready-to-merge']};
  const outcome = {repo,num:42,headSha,outcome:'not-enqueued',kind:'mq-same-head-failed'};
  const violations = [];
  for (const cause of ['head-failed','unknown']) {
    const key = keyOf({...outcome,cause},repo);
    const rows = filter({openPrRows:[row],localSlug:repo,heldTargets:new Set(key ? [key] : [])});
    if (cause === 'head-failed' && rows.length !== 0) violations.push('confirmed exact-head hold remains a yield target');
    if (cause === 'unknown' && rows.length !== 1) violations.push('unknown hold changed overlap yield');
  }
  return violations;
}

export default {
  id:'overlap-yield-skips-confirmed-mq-held-target',
  title:'overlap yield skips confirmed same-head holds and preserves unknown holds',
  card:'DRAIN-CLS-G',
  fixedBy:{sha:'pending',where:'DRAIN-CLS-G',paths:[SOURCE,'scripts/merge-ai-prs.mjs']},
  fixPresent(root) {
    try {
      const output = execFileSync(process.execPath,['--input-type=module','-e',`
        import { pathToFileURL } from 'node:url';
        const m = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(JSON.stringify((${probe.toString()})(m.filterEnqueueableOverlapRows,m.confirmedHeldTargetKey)));
      `,resolve(root,SOURCE)],{encoding:'utf8',timeout:10_000,maxBuffer:64*1024,stdio:['ignore','pipe','pipe']});
      const violations = JSON.parse(output);
      return Array.isArray(violations) && violations.length === 0;
    } catch { return false; }
  },
  async run({log} = {}) {
    const m = await import('../../overlap-yield-enqueueable.mjs');
    const violations = probe(m.filterEnqueueableOverlapRows,m.confirmedHeldTargetKey);
    log?.(`overlap-yield confirmed hold: ${violations.length} violation(s)`);
    return {violations};
  },
  judge(report) { return report.violations; },
};
