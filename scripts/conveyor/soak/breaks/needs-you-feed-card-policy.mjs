/** #7181: the attention feed must follow redTeam.confirmedBreaks (degraded = card), not a hardcoded send-back. */
import { gateReadyItems } from '../../../operations/needs-you-feed.mjs';
import { renderRedTeamComment } from '../../../operations/review-extra-seats.mjs';
import { GATE_OUTCOMES, parseRedTeamComment, redTeamGateMarker, redTeamResultId } from '../../../lib/red-team-gate.mjs';

const head = 'a'.repeat(40);
export default {
  id: 'needs-you-feed-card-policy',
  title: 'degraded breaks the gate already carded raise no owed-send-back alarm; a broken one still does',
  card: 'PR #7181',
  fixedBy: { sha: 'HEAD', where: 'lane/needs-you-break-policy', paths: ['scripts/operations/needs-you-feed.mjs'] },
  fixPresent() { return true; },
  async run() {
    const violations = [];
    const kindFor = async (impact) => {
      const body = renderRedTeamComment({ pr: 7181, rev: head, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
        findings: [1, 2].map(i => ({ summary: 'confirmed break', category: 'edge-case', impactIfUnfixed: impact, file: 'scripts/x.mjs', line: 2 + i,
          confirmedByRecheck: true, recheckReason: 'real' })) });
      const id = redTeamResultId(parseRedTeamComment(body));
      const comments = [{ user: { login: 'web-everything' }, body, created_at: '2026-10-10T02:04:41Z' },
        { user: { login: 'web-everything' }, created_at: '2026-10-10T02:05:00Z',
          body: `${redTeamGateMarker(7181, head, GATE_OUTCOMES.CARD_QUEUED, id)}\n- 2 finding(s) filed as a follow-up card (#1, #2).` }];
      const gh = async (_f, args) => args[0] === 'pr' ? JSON.stringify({ headRefOid: head, labels: [], comments }) : JSON.stringify([comments]);
      const report = { ready: [{ repo: 'owner/repo', number: 7181, title: 't' }] };
      const items = [{ repo: 'owner/repo', pr: 7181, head, kind: 'needs-you', reason: 'ready', pick: 'pick 7181' }];
      const { kept } = await gateReadyItems(items, report, { gh, log: () => {}, fixClaimLive: () => false,
        readPolicy: () => ({ broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' }) });
      return kept[0]?.kind;
    };
    if (await kindFor('degraded') === 'confirmed-break-owed-send-back') violations.push('carded degraded breaks still alarm');
    if (await kindFor('broken') !== 'confirmed-break-owed-send-back') violations.push('a broken break with only a card record stopped alarming');
    return { violations };
  },
  judge(report) { return report.violations; },
};
