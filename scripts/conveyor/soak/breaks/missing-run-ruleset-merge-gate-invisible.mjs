/** Live #5060: classic protection checks hid a ruleset-only merge-gate that never ran. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLASSIC_CONTEXTS = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });

export default {
  id: 'missing-run-ruleset-merge-gate-invisible',
  title: 'PR #5060 (2026-10-13): a head whose ruleset-only merge-gate never ran was invisible to the missing-run pass — never re-triggered, review refused forever (merge-gate=missing)',
  card: '#5060',
  fixedBy: { sha: 'd77826772', where: 'lane/missing-run-ruleset-checks', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs'), 'utf8');
    const sweep = source.split('export function sweepMissingRunRecovery(')[1]?.split('\nexport ')[0];
    return sweep?.includes('readAttributedRequiredChecks') ?? false;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { sweepMissingRunRecovery, triggerCiForPr } = await import(pathToFileURL(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs')).href);
    const { buildMissingRunComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/main-red-recovery.mjs')).href);
    const triggered = [];
    const result = sweepMissingRunRecovery({
      repo: ['web-everything', 'web-everything'].join('/'), apply: true, mainRuns: [],
      now: Date.parse('2026-10-13T11:00:00Z'),
      readOpenPrs: () => [{
        number: 5060, headRefName: 'lane/5060', baseRefName: 'main', headRefOid: '9cb7cc0',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [...CLASSIC_CONTEXTS.map(name => done(name)), done('review-gate', 'FAILURE')],
      }],
      readRequiredContexts: () => CLASSIC_CONTEXTS,
      readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'merge-gate'],
      readHeadCommittedAt: () => '2026-10-12T21:21:24Z', readComments: () => [],
      trigger: d => {
        triggered.push(d.prNumber);
        return { ok: true, action: 'pull-request-push' };
      },
      postComment: () => {}, clearLabel: () => true,
    });
    const variants = [];
    for (const [baseRefName, mergeable] of [['lane/parent', 'MERGEABLE'], ['main', 'CONFLICTING']]) {
      let mutations = 0;
      const variant = sweepMissingRunRecovery({
        repo: ['web-everything', 'web-everything'].join('/'), apply: true, mainRuns: [],
        now: Date.parse('2026-10-13T11:00:00Z'),
        readOpenPrs: () => [{ number: 5061, headRefName: 'lane/5061', baseRefName, headRefOid: 'healthy', mergeable,
          statusCheckRollup: CLASSIC_CONTEXTS.map(name => done(name)) }],
        readRequiredContexts: () => CLASSIC_CONTEXTS,
        readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'merge-gate'],
        readHeadCommittedAt: () => '2026-10-12T21:21:24Z', readComments: () => [],
        trigger: () => { mutations++; return { ok: true }; },
        restack: () => { mutations++; return { ok: true }; }, postComment: () => {}, clearLabel: () => true,
      });
      variants.push({ baseRefName, mergeable, dispatches: variant.dispatch.length, mutations });
    }
    const comments = [];
    let attempts = 0;
    const successive = [];
    for (const headRefOid of ['first-head', 'second-head']) {
      successive.push(sweepMissingRunRecovery({
        repo: ['web-everything', 'web-everything'].join('/'), apply: true, mainRuns: [], maxRetriesPerSha: 1,
        now: Date.parse('2026-10-13T11:00:00Z'),
        readOpenPrs: () => [{ number: 5062, headRefName: 'lane/5062', baseRefName: 'main', headRefOid,
          mergeable: 'MERGEABLE', statusCheckRollup: CLASSIC_CONTEXTS.map(name => done(name)) }],
        readRequiredContexts: () => CLASSIC_CONTEXTS,
        readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'never-emitted'],
        readHeadCommittedAt: () => '2026-10-12T21:21:24Z', readComments: () => comments,
        trigger: () => { attempts++; return { ok: true, action: 'pull-request-push' }; },
        postComment: (_, facts) => comments.push({ viewerDidAuthor: true, body: buildMissingRunComment(facts) }),
        clearLabel: () => true,
      }));
    }
    // Review #5152: two historical restacks must not strand a fresh classic/stalled head.
    const freshHeads = [];
    for (const [baseRefName, statusCheckRollup] of [['main', [done('smoke')]], ['lane/parent', []]]) {
      let mutations = 0;
      const fresh = sweepMissingRunRecovery({
        repo: ['web-everything', 'web-everything'].join('/'), apply: true, mainRuns: [],
        now: Date.parse('2026-10-13T11:00:00Z'),
        readOpenPrs: () => [{ number: 5064, headRefName: 'lane/5064', baseRefName, headRefOid: 'fresh-head',
          mergeable: 'MERGEABLE', statusCheckRollup }],
        readRequiredContexts: () => CLASSIC_CONTEXTS,
        readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'merge-gate'],
        readHeadCommittedAt: () => '2026-10-12T21:21:24Z',
        readComments: () => ['old-head-1', 'old-head-2'].map(headSha => ({
          viewerDidAuthor: true, body: buildMissingRunComment({ headSha }),
        })),
        trigger: () => { mutations++; return { ok: true }; },
        restack: () => { mutations++; return { ok: true }; }, postComment: () => {}, clearLabel: () => true,
      });
      freshHeads.push({ baseRefName, dispatches: fresh.dispatch.length, mutations });
    }
    let forkReads = 0;
    const forkSha = 'a'.repeat(40);
    const fork = sweepMissingRunRecovery({
      repo: ['web-everything', 'web-everything'].join('/'), apply: true, mainRuns: [],
      now: Date.parse('2026-10-13T11:00:00Z'),
      readOpenPrs: () => [{ number: 5063, headRefName: 'lane/5063', baseRefName: 'main', headRefOid: forkSha,
        mergeable: 'MERGEABLE', statusCheckRollup: CLASSIC_CONTEXTS.map(name => done(name)) }],
      readRequiredContexts: () => CLASSIC_CONTEXTS,
      readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'merge-gate'],
      readHeadCommittedAt: () => '2026-10-12T21:21:24Z', readComments: () => [],
      trigger: (d, opts) => triggerCiForPr(d, { ...opts, exec: (file, args) => {
        if (file !== 'gh' || args[0] !== 'api') throw new Error('fork must never reach git');
        forkReads++;
        return JSON.stringify({ state: 'open', mergeable: true, base: { ref: 'main' },
          head: { sha: forkSha, ref: 'lane/5063', repo: { full_name: 'someone/web-everything' } } });
      } }), postComment: () => {}, clearLabel: () => true,
    });
    return { ...result, triggered, variants, attempts, successive, freshHeads, fork, forkReads };
  },
  judge(report) {
    return [
      ...(!report.triggered.includes(5060) ? ['PR #5060 missing ruleset-only merge-gate was not triggered'] : []),
      ...report.variants.filter(v => v.dispatches || v.mutations).map(v => `inapplicable ruleset check mutated ${v.baseRefName}/${v.mergeable}`),
      ...(report.attempts !== 1 || report.successive[1].dispatch.length ? ['missing-run budget reset across SHAs'] : []),
      ...report.freshHeads.filter(v => v.dispatches !== 1 || v.mutations !== 1)
        .map(v => `old-SHA markers stranded a fresh classic head on ${v.baseRefName}`),
      ...(report.forkReads !== 1 || report.fork.applied[0]?.ok !== false
        || !report.fork.applied[0]?.error?.includes('fork') ? ['fork was not refused at push preflight'] : []),
    ];
  },
};
