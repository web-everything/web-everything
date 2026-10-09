/** Live #4535: pending checks cannot justify a durable not-a-ci-break verdict. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'not-a-ci-break-pinned-red',
  card: '5585',
  title: '#4535: not-a-ci-break recorded 25 s before required "test" went red pinned the head',
  fixedBy: { sha: '8509c022b', where: 'lane/fixd-supersede-verdict', paths: [
    'scripts/conveyor/ci-heal-verdict-recheck.mjs', 'scripts/conveyor/ci-heal-escalation-mark.mjs',
    'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent(root) { return existsSync(join(root, 'scripts/conveyor/ci-heal-verdict-recheck.mjs')); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    if (!this.fixPresent(root)) return { violations: ['verdict recheck is absent; not-a-ci-break pins the red head'] };
    const { contradictingChecks } = await import(pathToFileURL(join(root, 'scripts/conveyor/ci-heal-verdict-recheck.mjs')).href);
    const { buildCiHealEscalationComment, buildCiHealVerdictVoidComment, latestCiHealEscalationForHead, notCiBreakRecordRefusal } = await import(pathToFileURL(join(root, 'scripts/conveyor/ci-heal-escalation-mark.mjs')).href);
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../__tests__/fixtures/ci-heal-verdict/pr4535-2026-10-09.json'), 'utf8'));
    const headSha = fixture.headRefOid;
    const red = contradictingChecks({ escalation: latestCiHealEscalationForHead(fixture.comments, headSha, { recheck: true }),
      headSha, rollup: fixture.statusCheckRollup, requiredChecks: fixture.requiredChecks });
    if (!red.length) violations.push('required red test does not contradict the not-a-ci-break verdict');
    const comments = [...fixture.comments, { author: { login: 'web-everything' }, createdAt: '2026-10-09T05:00:00Z',
      body: buildCiHealVerdictVoidComment({ headSha, red }) }];
    if (latestCiHealEscalationForHead(comments, headSha, { recheck: true }) !== null) violations.push('trusted void leaves the head pinned');
    const statusCheckRollup = fixture.statusCheckRollup.filter((r) => r.startedAt <= fixture.escalationAt)
      .map((r) => r.completedAt > fixture.escalationAt ? { ...r, status: 'IN_PROGRESS', conclusion: null } : r);
    if (notCiBreakRecordRefusal({ headSha, pr: { ...fixture, statusCheckRollup }, requiredChecks: fixture.requiredChecks }) === null) {
      violations.push('unfinished required checks allow recording not-a-ci-break');
    }
    // PR #4560 review: a void is owed per VERDICT. A second contradicted verdict on a head that already has a void
    // must still be voided, or it pins the head again.
    const { planVerdictVoid } = await import(pathToFileURL(join(root, 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs')).href);
    const verdict = { author: { login: 'web-everything' }, createdAt: '2026-10-09T06:00:00Z',
      body: buildCiHealEscalationComment({ headSha, outcome: 'not-a-ci-break', reason: 'second verdict' }) };
    const second = planVerdictVoid({ note: { kind: 'ci-heal-escalated', outcome: 'not-a-ci-break', headSha, prNumber: 4535 },
      pr: { ...fixture, comments: [...comments, verdict] }, repo: fixture.repo, verdictSettings: { recheckNotCiBreak: true },
      readRequiredChecks: () => fixture.requiredChecks });
    if (!second || second.alreadyPosted) violations.push('a later contradicted verdict on an already-voided head is never voided');
    return { violations };
  },
  judge(report) { return report.violations; },
};
