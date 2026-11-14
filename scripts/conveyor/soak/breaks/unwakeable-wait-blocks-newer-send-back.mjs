/** A stale unwakeable wait (its session is gone) must be retired once a newer review:changes send-back exists. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runSlotAwareAwaitPass } from '../../await-verify-loop.mjs';

const LOOP = 'scripts/conveyor/await-verify-loop.mjs';
const NOW = Date.parse('2026-11-10T15:00:00Z');
const REQUESTED = new Date(NOW - 3_600_000).toISOString();

export default {
  id: 'unwakeable-wait-blocks-newer-send-back',
  title: 'a stale unwakeable fix wait with a dead session stayed owed and blocked a newer review:changes send-back',
  card: 'PR #6595 (fix daemon, proven 2026-11-10 10:36 ET)',
  fixedBy: { sha: '9bb8d330d8', where: 'lane/retire-unwakeable-wait', paths: [LOOP] },
  fixPresent(root) {
    const source = readFileSync(join(root, LOOP), 'utf8');
    return source.includes('shouldRetireUnwakeable') && source.includes('retired unwakeable wait');
  },
  async run({ log } = {}) {
    const violations = [];
    for (const [reason, over] of [
      ['delivered-previous-ci', { pendingResume: { kind: 'red', delivered: true } }],
      ['resume-exhausted', { pendingResume: { kind: 'red', detail: 'previous-head CI failures' } }],
    ]) {
      const record = { v: 1, sessionId: 'fix-6595', who: 'fix-6595', repo: CONSTELLATION_REPOS.we.slug, pr: 6595,
        kind: 'fix', sha: '7'.repeat(40), lane: '/lanes/lane-9', ref: 'lane/stale-fix', attempt: 1,
        requestedAt: REQUESTED, ...over };
      const store = new Map([[record.sessionId, record]]);
      const row = { key: record.sessionId, pr: record.pr, who: record.who, action: 'wait',
        ...(reason === 'delivered-previous-ci'
          ? { reason: 'previous-head CI repair must be verified and re-marked' }
          : { result: 'resume-exhausted; previous-head CI failures retained; operator recovery required' }) };
      const io = {
        listRecords: () => [...store.entries()].map(([key, r]) => ({ key, record: r })),
        prState: () => ({ open: true }),
        sessionLive: () => false,
        newerVerdictSince: () => true,
        clearStoredRecordIf: (key) => { store.delete(key); return { cleared: true }; },
      };
      const out = await runSlotAwareAwaitPass({ io, runPass: async () => ({ rows: [row] }), allowResume: true,
        settings: { parkedReleasesSlot: true }, claims: [], nowMs: NOW, ttlMs: 150 * 60_000, cap: 2, log: () => {} });
      log?.(`${reason}: waiter=${store.has(record.sessionId)}, excluded=${out.excluded?.length ?? '?'}`);
      if (store.has(record.sessionId) || !out.cleared?.includes(record.sessionId)) {
        violations.push(`${reason}: stale unwakeable wait was not retired despite a dead session and a newer send-back`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
