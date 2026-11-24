import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = 'scripts/conveyor/referral-auto-rule.mjs';
// Probe the supplied tree by executing the real sweep, writer planner and ledger together.
function probe(root) {
  const script = `
    import { sweepAutoRule } from ${JSON.stringify(pathToFileURL(join(root, SOURCE)).href)};
    import { H1, repo, record, recordComment } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/conveyor/__tests__/ruling-fixtures.mjs')).href)};
    import { openReferralFindings, planOperatorRuling } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/operations/record-referral-ruling.mjs')).href)};
    import { rulingNeeded } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/lib/ruling-ledger.mjs')).href)};
    const live = { number: 3794, state: 'OPEN', headRefOid: H1, labels: [], comments: [recordComment(record({ head: H1, runId: 'soak' }), 5)] };
    let writes = 0, spawns = 0;
    const result = sweepAutoRule({ repo, listPrs: () => [live], readPr: () => live, capacity: () => true,
      settings: { enabled: true }, env: {},
      spawnRuler: ({ findings }) => { spawns++; return findings.map(f => ({ key: f.key, verdict: 'real', evidence: 'Quoted diff: introduced missing pointer' })); },
      runRuling: args => {
        const input = Object.fromEntries(args.map(a => { const i = a.indexOf('='); return [a.slice(2, i), a.slice(i + 1)]; }));
        const open = openReferralFindings({ comments: live.comments, repo, pr: live.number, head: H1 });
        const plan = planOperatorRuling({ ...open, head: H1, identity: { login: 'web-everything', type: 'Bot' },
          now: '2026-11-24T12:00:00Z', clearerId: 'soak' }, input);
        live.comments.push({ body: plan.body, author: { login: 'web-everything' } }); writes++;
      } });
    if (spawns !== 1 || writes !== 1 || result[0]?.findings !== 1 || rulingNeeded(live)) process.exit(1);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 128 * 1024,
  }).status === 0;
}
export default {
  id: 'referral-auto-rule-no-sweep-dependency',
  title: 'a pending referral with review capacity receives a ruling without any judge sweep',
  card: 'REFERRAL-AUTO-RULE',
  fixedBy: { sha: '828b743897e5b8b68de558cd8d59be2f90068148', where: 'referral-auto-rule', paths: [SOURCE] },
  fixPresent(root) {
    return spawnSync('git', ['merge-base', '--is-ancestor', this.fixedBy.sha, 'HEAD'], {
      cwd: root, stdio: 'ignore', timeout: 5000,
    }).status === 0;
  },
  run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    return { violations: probe(root) ? [] : ['pending referral did not receive a capacity-gated ruling'] };
  },
  judge: report => report.violations,
};
