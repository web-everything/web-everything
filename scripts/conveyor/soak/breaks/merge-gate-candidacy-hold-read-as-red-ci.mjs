/** PR #5008 / drafts #5011–#5019: candidacy HOLDs must not strand review and promotion as red CI. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const done = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const identity = x => x;
const sha = 'a'.repeat(40);
// Real job-log row wording from the #4965/#5008 incident, projected onto the replay PRs.
const candidacyLog = number => `2026-10-12T09:49:30.3934630Z #${number}: HOLD
2026-10-12T09:49:30.3936795Z   hold              candidate-label        no "ready-to-merge" label — the drain never considers it
2026-10-12T09:49:30.3938131Z   hold              producer-certified     not AI-generated, no ready-to-merge label, not human-cleared
2026-10-12T09:49:30.3939344Z   pass              default-base           base main vs main
2026-10-12T09:49:30.3956372Z   pass              red-main-freeze        no freeze (ops/red-main-freeze:red-main-freeze.json + ci.yml@main)
2026-10-12T09:49:30.3959878Z merge-gate: HOLD — held`;
const log5008 = `#5008: HOLD
  hold              candidate-label        no "ready-to-merge" label — the drain never considers it
  hold              red-main-freeze        main is RED (freeze: manual freeze: merge-queue switch: ruleset apply (operator go 2026-10-12))
  pass              ledger                 labels: labels clear (ledger not consulted)
merge-gate: HOLD — held`;

export default {
  id: 'merge-gate-candidacy-hold-read-as-red-ci',
  title: "PR #5008 / drafts #5011–#5019 (2026-10-12): the required merge-gate's candidacy HOLD was read as red CI — ci-heal dispatched, review refused, drafts never promoted",
  card: 'ciheal-mergegate-hold (epic #4075/#3383)',
  fixedBy: { sha: 'bd66390ab5e56356d4d326a2c1a618a7902791b2', where: 'lane/ciheal-mergegate-hold', paths: ['scripts/lib/merge-gate-hold-class.mjs', 'scripts/conveyor/reconcile-pass.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('excusePrMergeGateHolds'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { runReconcilePass } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const { parsePrResultTable } = await import(pathToFileURL(join(root, 'scripts/lib/merge-gate-hold-class.mjs')).href);
    const prs = [5008, 5012, 5020].map(number => ({
      number, state: 'OPEN', headRefOid: sha, headRefName: `lane/${number}-example`, baseRefName: 'main',
      labels: [{ name: 'review:pending' }], comments: [], isDraft: number !== 5008,
      statusCheckRollup: [
        ...['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(name => ({
          ...done(name), conclusion: number === 5020 && name === 'test' ? 'FAILURE' : 'SUCCESS',
        })),
        { ...done('merge-gate'), conclusion: 'FAILURE', detailsUrl: `https://github.com/web-everything/web-everything/actions/runs/38245735516/job/${114798995647 + number - 5008}` },
      ],
    }));
    const plan = runReconcilePass({
      readPrs: () => prs, readAgents: () => [], enrich: identity,
      readRequiredChecks: () => ({ checks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'] }),
      readChecks: () => { throw new Error('complete fixture rollups must not hydrate checks'); },
      readMergeGateVerdict: ({ prNumber }) => ({
        ...parsePrResultTable(prNumber === 5008 ? log5008 : candidacyLog(prNumber), prNumber),
        head_sha: sha, completed_at: '2026-10-12T11:56:08Z',
      }),
      readFreeze: () => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }),
      mergeGateSetting: { value: 'on', source: 'soak' },
      enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
      ...Object.fromEntries(['enrichAlreadyLanded', 'enrichBaseRef', 'enrichSystemFix', 'enrichEscalationBase', 'enrichFixClaims', 'enrichTimeouts', 'enrichReferralHolds', 'enrichLedgerHolds', 'enrichRulings', 'enrichScopeBloat', 'enrichCodeQL', 'enrichMechanicalRound'].map(k => [k, identity])),
      resolveMainSha: () => null, readPriority: () => null, now: Date.parse('2026-10-12T13:00:00Z'),
    });
    const dispatched = (number, kind) => plan.dispatch.some(d => d.prNumber === number && d.kind === kind);
    const violations = [];
    if (dispatched(5008, 'ci-heal')) violations.push('PR #5008 candidacy + cleared manual freeze incorrectly dispatched ci-heal');
    if (!dispatched(5008, 'review')) violations.push('PR #5008 candidacy + cleared manual freeze was not owed review');
    if (!dispatched(5012, 'promote-draft')) violations.push('PR #5012 candidacy-only draft was not owed promote-draft');
    if (!dispatched(5020, 'ci-heal')) violations.push('PR #5020 real test FAILURE was not owed ci-heal');
    return { violations };
  },
  judge(report) { return report.violations; },
};
