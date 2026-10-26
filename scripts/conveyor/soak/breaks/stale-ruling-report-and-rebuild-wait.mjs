/** PR #5944: stale report prose and a waiting rebuild must not falsify coordination events. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withReadLock } from '../../../lib/daemon-clone-lock.mjs';
import { rebuildClone } from '../../../lib/daemon-rebuild/rebuild.mjs';
import { gateRulingItems } from '../../../operations/needs-you-feed.mjs';
import { rulingNeeded } from '../../../lib/ruling-ledger.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../../lib/jury-core.mjs';

const FEED = 'scripts/operations/needs-you-feed.mjs';
const REBUILD = 'scripts/lib/daemon-rebuild/rebuild.mjs';
export default {
  id: 'stale-ruling-report-and-rebuild-wait',
  title: 'stale auto-resolved prose retains pending alerts and rebuild lock waits emit no failures',
  card: 'PR #5944',
  fixedBy: { sha: 'HEAD', where: 'lane/daemon-events-ruled', paths: [FEED, REBUILD] },
  fixPresent(root) {
    return !readFileSync(join(root, FEED), 'utf8').includes('const autoResolved =')
      && readFileSync(join(root, REBUILD), 'utf8').includes('REBUILD_FAILURE_REASONS');
  },
  async run() {
    const dir = mkdtempSync(join(tmpdir(), 'soak-ruling-events-'));
    const violations = [], events = [];
    try {
      const repo = 'ruling-fixture/example', head = 'b'.repeat(40), at = '2026-10-20T12:00:00Z';
      const original = { file: 'policy/pointer.md', line: 12, summary: 'policy pointer missing', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
      const runId = 'stale-ruling-report', reviewer = mandatoryReferralReviewer(runId);
      const key = referralFindingKey('judge', original);
      const body = '<!-- authored-by-actor: author -->';
      const record = { version: 1, repo, pr: 5944, head, runId, reviewer, authorBody: body, attempted: true,
        referrals: [{ key, seat: 'judge', original, finding: normalizeFinding(original) }], rulings: [] };
      const live = { headRefOid: head, labels: [{ name: 'advisory:ruling-needed' }], body, createdAt: at };
      const comment = { user: { login: 'web-everything' }, body: renderReferralRecord(record), created_at: at };
      if (rulingNeeded({ ...live, comments: [{ author: { login: comment.user.login }, body: comment.body, createdAt: at }] })?.findings.length !== 1) {
        throw new Error('fixture must contain one live pending finding');
      }
      const item = { repo, pr: 5944, kind: 'ruling-needed', head: 'a'.repeat(40), reason: 'referral hold auto-resolved' };
      for (const unreadable of [false, true]) {
        const { kept } = await gateRulingItems([item], {
          gh: async (_bin, args) => {
            if (unreadable) throw new Error('fixture PR unavailable');
            return JSON.stringify(args[0] === 'pr' ? live : [[comment]]);
          },
          emitEvent: event => events.push(event), log: () => {},
        });
        if (kept.length !== 1) violations.push(`stale reason dropped ${unreadable ? 'unreadable' : 'pending'} alert`);
      }
      const root = join(dir, 'review-daemon'), lockRoot = join(dir, 'locks');
      mkdirSync(root);
      const held = await withReadLock(root, () => rebuildClone({
        root, versions: null, asJob: false, skipCheck: null,
        env: { WE_DAEMON_STATE_DIR: join(dir, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: lockRoot },
        lockOpts: { waitMs: 1, pollMs: 1, owner: 'soak-writer', probe: () => 'alive' },
        emitEvent: event => events.push(event), log: { error() {} },
        run() { throw new Error('lock wait must not reach git'); },
      }), { lockRoot, owner: 'soak-reader' });
      if (!held.ok || held.value.reason !== 'tick-in-progress') violations.push('fixture did not exercise a live rebuild lock wait');
      if (events.length) violations.push(`unexpected coordination events: ${events.map(event => event.kind).join(', ')}`);
      return { violations };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  judge(report) { return report.violations; },
};
