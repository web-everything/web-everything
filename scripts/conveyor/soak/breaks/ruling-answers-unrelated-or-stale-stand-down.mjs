/** PR #5309: replay the operator ruling through the real fix daemon's tick and write ports. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'ruling-answers-unrelated-or-stale-stand-down',
  title: 'referral rulings answer only their bound questions and revalidate before writes',
  card: 'PR #5309 (operator ruling on the #5246 needs-judgment hold)',
  fixedBy: { sha: 'uncommitted', where: 'lane/ruling-resolves-stand-down', paths: [
    'scripts/conveyor/ruling-resolved-stand-down.mjs', 'scripts/conveyor/stand-down.mjs',
    'skills-src/conveyor/fix-agent-brief.md', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent(root) {
    const resolver = readFileSync(join(root, 'scripts/conveyor/ruling-resolved-stand-down.mjs'), 'utf8');
    return resolver.includes('const beforeWrite = await readPr(pr)') && resolver.includes('changesLabelEvents')
      && readFileSync(join(root, 'skills-src/conveyor/fix-agent-brief.md'), 'utf8').includes('--finding-refs=')
      && !readFileSync(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs'), 'utf8').includes('...rulingStandDown.rows.filter');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const load = p => import(pathToFileURL(join(root, p)).href);
    const { runTickAllRepos } = await load('skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
    const { runRulingResolvesStandDownPass } = await load('scripts/conveyor/ruling-resolved-stand-down.mjs');
    const { buildStandDownComment } = await load('scripts/conveyor/stand-down.mjs');
    const { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } = await load('scripts/lib/jury-core.mjs');
    const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
    const repo = CONSTELLATION_REPOS.we.slug, head = 'a'.repeat(40), runId = 'review-pr-5246';
    const comment = (id, body, login = 'web-everything') => ({ id, body, author: { login }, createdAt: `2026-10-14T20:15:0${id}Z` });
    const fixture = ({ bound = true, second = false } = {}) => {
      const seat = 'judgeCorrectnessAdvisory', reviewer = mandatoryReferralReviewer(runId);
      const findings = [{ file: 'scripts/x.mjs', line: 51, summary: 'finding the fixer asked about', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' },
        ...(second ? [{ file: '', summary: 'new blocking finding', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }] : [])];
      const referrals = findings.map(f => ({ key: referralFindingKey(seat, f), seat, original: f, finding: normalizeFinding(f) }));
      const record = { version: 1, repo, pr: 5246, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->', attempted: true, referrals,
        rulings: referrals.map((f, i) => ({ id: `${runId}:${i}`, key: f.key, reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'checked', evidence: ['diff'] })) };
      const ruling = { version: 1, repo, pr: 5246, head, actor: 'chalbert', channel: 'chat', reason: 'not real',
        at: '2026-10-14T20:15:03Z', clearerId: 'operator-session', rulings: [{ runId, key: referrals[0].key, result: 'not-real' }] };
      return { number: 5246, headRefOid: head, labels: ['review:changes', 'review:human'], labelEvents: [], body: record.authorBody,
        createdAt: '2026-10-14T19:00:00Z', comments: [comment(1, renderReferralRecord(record)),
          comment(2, buildStandDownComment({ reason: 'needs-judgment', detail: bound ? 'Please rule on :51.' : 'Which conflicting instruction should I follow?',
            findingRefs: bound ? [{ runId, key: referrals[0].key }] : undefined })),
          comment(3, buildOperatorRulingComment(ruling), 'chalbert')] };
    };
    const empty = () => ({ dispatched: [], refusals: [], reconcileRefusals: [], rows: [] });
    const tick = rulingStandDownTick => runTickAllRepos({ repos: [repo], fixTick: empty, ciHealTick: empty,
      hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty, notesTick: empty,
      awaitVerifyTick: empty, stuckFixerTick: empty, supersedeTick: empty, rulingStandDownTick,
      authGateOverride: () => ({ paused: true, reason: 'hermetic replay' }) });
    const violations = [];
    const brief = readFileSync(join(root, 'skills-src/conveyor/fix-agent-brief.md'), 'utf8').replace(/\\\r?\n/g, '');
    const command = brief.match(/node[^\n]*stand-down\.mjs[^\n]*--reason=needs-judgment[^\n]*/)?.[0];
    if (!command?.includes('--finding-refs=')) violations.push('producer: fixer referral stand-down omits finding refs');
    for (const scenario of ['unrelated-question', 'older-question', 'same-head-block', 'post-failure', 'label-failure',
      'commentless-relabel', 'post-head-moved', 'post-new-review', 'post-relabel']) {
      const pr = fixture({ bound: scenario !== 'unrelated-question' }), writes = [];
      if (scenario === 'older-question') pr.comments.unshift(comment(0,
        buildStandDownComment({ reason: 'needs-judgment', detail: 'An older unrelated design question' })));
      let reads = 0, failPost = scenario === 'post-failure', failLabels = scenario === 'label-failure';
      const pass = () => runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr],
        readPr: () => scenario === 'same-head-block' && ++reads === 2 ? fixture({ second: true }) : pr,
        postComment: (_n, body) => {
          if (failPost) { failPost = false; throw new Error('transient comment failure'); }
          writes.push('answer'); pr.comments.push(comment(4, body));
          if (scenario === 'post-head-moved') pr.headRefOid = 'b'.repeat(40);
          if (scenario === 'post-new-review') pr.comments.push(comment(5, 'New changes-requested review.'));
          if (scenario === 'post-relabel') pr.labelEvents.push({ event: 'labeled', label: { name: 'review:changes' }, created_at: '2026-10-14T20:15:03Z' });
        },
        editLabels: (_n, plan) => {
          if (failLabels) { failLabels = false; throw new Error('transient label failure'); }
          writes.push('labels'); pr.labels = pr.labels.filter(l => !plan.removeLabels.includes(l));
        }, log: () => {} });
      const first = await tick(pass);
      if (first.dispatched.length) violations.push(`${scenario}: counted a resolution as a fix dispatch`);
      if (scenario === 'unrelated-question' || scenario === 'older-question' || scenario === 'same-head-block') {
        if (writes.length || !pr.labels.includes('review:changes')) violations.push(`${scenario}: cleared an unanswered hold`);
      } else if (scenario.startsWith('post-') && scenario !== 'post-failure') {
        if (writes.join(',') !== 'answer' || !pr.labels.includes('review:changes')) violations.push(`${scenario}: stale label write after answer post`);
      } else if (scenario === 'commentless-relabel') {
        // Same head, no new comment: only the complete label timeline shows the new request.
        pr.labels.push('review:changes');
        pr.labelEvents.push({ event: 'labeled', label: { name: 'review:changes' }, created_at: '2026-10-14T20:15:05Z' });
        const before = writes.length;
        await tick(pass);
        if (writes.length !== before || !pr.labels.includes('review:changes')) violations.push(`${scenario}: prior answer removed the new review signal`);
      } else {
        if (first.rulingStandDown.rows[0]?.action !== 'error' || !pr.labels.includes('review:changes')) violations.push(`${scenario}: failure lost the retry candidate`);
        const second = await tick(pass);
        if (second.dispatched.length) violations.push(`${scenario}: retry counted as a fix dispatch`);
        if (second.rulingStandDown.rows[0]?.action !== 'resolve' || writes.join(',') !== 'answer,labels'
          || pr.labels.includes('review:changes') || !pr.labels.includes('review:human')) violations.push(`${scenario}: retry did not finish exactly once with the human gate kept`);
      }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
