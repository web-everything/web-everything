/** #7483/#7452: stale gate reds must request fresh evidence without writing a verdict. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const PROBE = `
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { sendBackBlockedGate, decideGateSendBack } = await import(process.argv[1]);
const head = 'a'.repeat(40), repo = 'web-everything/web-everything';
const early = '2026-11-25T14:35:06Z', late = '2026-11-25T15:07:20Z';
const pr = { number: 7483, headRefOid: head, rowsHead: head, rowsComplete: true, labels: ['ready-to-merge'],
  statusCheckRollup: [{ name: 'merge-gate', status: 'completed', conclusion: 'failure', completedAt: early,
    detailsUrl: 'https://github.com/' + repo + '/actions/runs/45635463327' }] };
if (process.argv[2] === 'signal') {
  console.log(JSON.stringify(decideGateSendBack({ pr, headSha: head, requiredChecks: ['merge-gate'], ledger: { [head]: true } }).send));
} else {
  const violations = [];
  for (const shape of ['#7483', '#7452', 'freeze-lift']) {
    const dir = mkdtempSync(join(tmpdir(), 'soak-gate-clear-')), ledgerPath = join(dir, 'ledger');
    let posts = 0, writes = 0;
    try {
      if (shape === '#7452') writeFileSync(ledgerPath, JSON.stringify({ [repo + '#' + pr.number]: { [head]: true } }));
      const exec = (cmd, args, options) => {
        if (cmd !== 'gh') { writes++; return { status: 0 }; }
        if (args[0] === 'pr') return { status: 0, stdout: JSON.stringify({ headRefOid: head }) };
        if (args.includes('POST')) {
          if (args.join(' ') === 'api -X POST repos/' + repo + '/actions/runs/45635463327/rerun'
            && options.env.WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS === '1') posts++;
          return { status: 0 };
        }
        return { status: 0, stdout: JSON.stringify({ id: 45635463327, repository: { full_name: repo }, name: 'Merge gate',
          path: '.github/workflows/merge-gate.yml', event: 'pull_request_target', head_sha: head, run_attempt: 1,
          status: 'completed', conclusion: 'failure', updated_at: early }) };
      };
      const o = { pr, headSha: head, repo, ledgerPath, exec, requiredChecks: ['merge-gate'],
        readMain: () => ({ runs: [{ status: 'completed', conclusion: 'success', createdAt: early }], settledAt: shape === '#7483' ? late : early }),
        readFreeze: () => ({ frozen: false, publishedAt: shape === 'freeze-lift' ? late : early }),
        readComments: () => [{ id: 'C1', author: { login: 'web-everything' }, createdAt: shape === '#7452' ? late : early,
          body: shape === '#7452' ? '✅ review — \`review:human\` cleared' : '✅ review — accepted' }] };
      const first = sendBackBlockedGate(o); sendBackBlockedGate(o);
      if (first.sent || posts !== 1 || writes) violations.push(shape + ': stale gate bounced or REST rerun was not exactly once');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(violations));
}
`;
function probe(root, mode = 'scenario') {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
    pathToFileURL(join(root, 'scripts/lib/drain-blocked-reason.mjs')).href, mode],
  { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  try { return r.status === 0 ? JSON.parse(r.stdout.trim().split('\n').pop()) : null; } catch { return null; }
}
export default {
  id: 'merge-gate-stale-after-clear', title: 'Clearing main, review or freeze refreshes a stale gate without bouncing',
  card: 'MERGE-GATE-RERUN-ON-CLEAR', fixedBy: { sha: 'pending', where: 'merge-gate rerun on clear', paths: ['scripts/lib/drain-blocked-reason.mjs'] },
  fixPresent: root => probe(root, 'signal') === true,
  async run() { return { violations: probe(process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname) ?? ['stale gate probe unreadable'] }; },
  judge: report => report.violations,
};
