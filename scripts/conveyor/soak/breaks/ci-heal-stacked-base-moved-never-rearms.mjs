/**
 * Live PR #4792: a trusted legacy needs-human escalation remained keyed to the victim's head
 * after its stacked base moved. Only fix-dispatch runs: the victim stays ci-red on the SAME
 * head throughout. RED refuses forever; GREEN holds before round 2, then dispatches ci-heal
 * after the base push. No base-head line is recorded, exercising the legacy timestamp rule.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runSoak } from '../soak.mjs';
import { sessionMatches } from '../invariants.mjs';
import { buildCiHealEscalationComment } from '../../ci-heal-escalation-mark.mjs';

const ROUNDS = 6;
const PUSH_ROUND = 2;
const BASE = 'lane/soak-stacked-base';

function baseCommittedAt(w) {
  return execFileSync('git', ['show', '-s', '--format=%cI', `refs/heads/${BASE}`], {
    cwd: w.repos.we.originPath, encoding: 'utf8', maxBuffer: 1024 * 1024,
  }).trim();
}

export default {
  id: 'ci-heal-stacked-base-moved-never-rearms',
  title: 'a legacy ci-heal escalation re-arms when the stacked base moves, with the victim head unchanged',
  card: 'live PR #4792 (stacked on PR #4779)',
  fixedBy: {
    sha: '866f5a08a0d7fb24703532cbfca6e23c9457b0b4,f78d45bf18e33bcd23fec123c36f3578a0042d79',
    where: 'this branch (live PR #4792)',
    paths: ['scripts/conveyor/ci-heal-escalation-mark.mjs', 'scripts/conveyor/reconcile-core.mjs', 'scripts/conveyor/reconcile-pass.mjs'],
  },
  fixPresent(root) {
    try {
      return /escalationStaleAgainstBase/.test(readFileSync(join(root, 'scripts/conveyor/ci-heal-escalation-mark.mjs'), 'utf8'))
        && /enrichEscalationBase/.test(readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8'));
    } catch { return false; }
  },
  run({ log } = {}) {
    return runSoak({
      name: 'break:ci-heal-stacked-base-moved-never-rearms',
      // Seed 8 selects fix:hang for ci-heal-2 (roll ~0.1975), so the fake worker
      // cannot push the victim after dispatch. The unchanged-head assertion guards this choice.
      seed: 8,
      // The CLI red/green runner lacks Vitest's defaults. Keep launches on the
      // fake --bg session surface that this scenario observes in both runners.
      env: { WE_PROBATION_LAUNCH: 'off', WE_WORKER_WRAPPER: 'off' },
      rounds: ROUNDS, daemons: ['fix-dispatch'], mainEvery: 0, scorecards: false, fleet: false,
      setup(w) {
        const baseHeadSha = w.git.createBranch('we', BASE, {
          files: { 'soak/stacked-base.txt': 'base with inherited CI failure\n' },
        });
        const basePr = w.gh.openPr({ repo: 'we', head: BASE, base: 'main',
          title: 'soak: stacked base still open', body: 'No backlog item for this one.' });
        const victimHead = 'lane/soak-stacked-base-victim';
        w.git.createBranch('we', victimHead, { from: BASE,
          files: { 'soak/stacked-victim.txt': 'victim inherits red from its base\n' } });
        const victimPr = w.gh.openPr({ repo: 'we', head: victimHead, base: BASE,
          title: 'soak: legacy escalation awaiting a base fix', body: 'No backlog item for this one.' });
        w.gh.setChecks('we', victimPr, [{ name: 'test', conclusion: 'FAILURE' }]);
        const victimHeadSha = w.gh.pr('we', victimPr).headRefOid;
        const escalation = buildCiHealEscalationComment({ headSha: victimHeadSha, outcome: 'needs-human',
          reason: 'soak: required check failure inherited from the stacked base (live #4792)' });
        const comment = w.gh.comment('we', victimPr, escalation, { author: 'web-everything' });
        return { victimPr, basePr, victimHeadSha, baseHeadSha, createdAt: comment.createdAt,
          initialBaseDate: baseCommittedAt(w), pushed: false, countAtPush: null, finalCount: null };
      },
      async perRound(w, round, ctx, api) {
        const count = () => w.claude.sessions().filter(s => sessionMatches(s.name, 'ci-heal', ctx.victimPr)).length;
        if (round === PUSH_ROUND) {
          ctx.countAtPush = count();
          // Git commit timestamps have second precision; guarantee strictly AFTER the comment,
          // even on a fast host. createBranch from itself makes a normal fast-forward push.
          await delay(Math.max(0, Date.parse(ctx.createdAt) + 1000 - Date.now()));
          ctx.newBaseHeadSha = w.git.createBranch('we', BASE, { from: BASE,
            files: { 'soak/stacked-base.txt': 'base fix pushed\n' } });
          ctx.newBaseDate = baseCommittedAt(w);
          ctx.pushed = true;
          api.say(`r${round} base PR #${ctx.basePr} pushed; ${ctx.countAtPush} victim ci-heal sessions before push`);
        }
        ctx.finalCount = count();
        ctx.finalVictimHeadSha = w.gh.pr('we', ctx.victimPr).headRefOid;
        ctx.finalBasePrHeadSha = w.gh.pr('we', ctx.basePr).headRefOid;
        if (round === ROUNDS - 1) api.say(`r${round} final: ${ctx.finalCount} ci-heal-${ctx.victimPr} session(s)`);
      },
      log,
    });
  },
  judge(report) {
    const c = report.ctx ?? {};
    if (c.victimPr == null || !c.pushed) return ['scenario setup problem: victim missing or round-2 base push never ran'];
    const problems = [];
    if (c.baseHeadSha === c.newBaseHeadSha || c.finalBasePrHeadSha !== c.newBaseHeadSha
        || !(Date.parse(c.initialBaseDate) <= Date.parse(c.createdAt))
        || !(Date.parse(c.newBaseDate) > Date.parse(c.createdAt))) {
      problems.push('scenario setup problem: base PR must advance from before the escalation to a commit strictly after it');
    }
    if (c.finalVictimHeadSha !== c.victimHeadSha) problems.push('scenario setup problem: victim head changed');
    if (c.countAtPush !== 0) problems.push(`scenario setup problem: ${c.countAtPush} ci-heal sessions BEFORE the base push; escalation never held`);
    if ((c.finalCount ?? 0) <= (c.countAtPush ?? 0)) {
      problems.push(`PR #${c.victimPr}: still 0 ci-heal sessions ${ROUNDS - 1 - PUSH_ROUND} ticks after the stacked base moved — legacy escalation refuses forever (live PR #4792)`);
    }
    return problems;
  },
};
