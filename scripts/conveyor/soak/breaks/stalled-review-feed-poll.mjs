/** PR #5765: a queue poll must not resolve an alert its report cannot represent. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';
import { decideSameHeadHold, raiseNoVerdictNeedsYou } from '../../review-referral-hold.mjs';
import { publishAttention, runOnce, unacknowledged, acknowledge, replay } from '../../../operations/needs-you-feed.mjs';

const SOURCE = 'scripts/operations/needs-you-feed.mjs';
export default {
  id: 'stalled-review-feed-poll',
  title: 'routine queue polls preserve a settled stalled-review alert until operator acknowledgement',
  card: 'PR #5765',
  fixedBy: { sha: 'HEAD', where: 'lane/grad-stalled-review-claim-2026-10-20', paths: [SOURCE] },
  fixPresent(root) { return readFileSync(join(root, SOURCE), 'utf8').includes('clearKinds: REPORT_KINDS'); },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-stalled-review-feed-'));
    try {
      const path = join(dir, 'events.jsonl'), repo = ghRepoSlug('we'), head = 'a'.repeat(40);
      const now = Date.parse('2026-10-20T12:00:00Z');
      const pr = { number: 5765, headRefOid: head, labels: ['review:pending'], comments: [] };
      const runs = Array.from({ length: 9 }, (_, i) => ({
        id: `lost-${i}`, repo, pr: pr.number, head, parked: false,
        startedAt: now - 7200_000 - i * 120_000, completedAt: now - 3600_000 - i * 120_000,
      }));
      const hold = decideSameHeadHold(pr, runs, { repo, env: {}, now, retry: { cooldownReleases: 6, source: 'tool' } });
      const violations = [];
      if (!hold?.noVerdict?.exhausted) return { violations: ['nine lost verdicts did not exhaust the hold'] };
      const raise = () => raiseNoVerdictNeedsYou({ repo, prNumber: pr.number, hold, dir, now,
        log: () => {}, publish: item => publishAttention(item, { path, now }) });
      const published = raise();
      if (!published) violations.push('the exhausted hold did not publish');
      const ordinary = { repo, number: 99, head, reason: 'ready' };
      const poll = report => runOnce({ checkoutRoot: join(dir, 'workspace/.lanes/we/lane-1'),
        env: { WE_NEEDS_YOU_FEED: path }, now: now + 1, log: () => {}, exec: () => JSON.stringify(report),
        gh: async (_file, args) => {
          if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, labels: [] });
          if (args[0] === 'api') return '[[]]';
          violations.push(`unexpected live-gate read: ${args.join(' ')}`);
          throw new Error('unexpected live-gate read');
        } });
      await poll({ ready: [ordinary] });
      await poll({ ready: [] });
      await poll({ ready: [] });
      const visible = unacknowledged({ path }).filter(e => e.kind === 'review-no-verdict').length;
      if (visible !== 1) violations.push(`unresolved stalled-review alerts visible after complete polls: ${visible}, expected 1`);
      if (unacknowledged({ path }).some(e => e.pr === ordinary.number)) violations.push('resolved report-owned alert was retained');
      const republished = raise();
      if (republished) violations.push('a settled claim published twice');
      if (replay({ path }).some(e => e.kind === 'cleared' && e.was === 'review-no-verdict')) violations.push('poll falsely cleared the exhausted hold');
      acknowledge({ path });
      await poll({ ready: [] });
      if (unacknowledged({ path }).length) violations.push('acknowledged alerts reappeared');
      return { published, visible, republished, violations };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  judge(report) { return report.violations; },
};
