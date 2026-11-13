/** Delivered previous-head CI repairs must retire when abandoned, but retain busy fixers. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runAwaitVerifyPass } from '../../await-verify-pass.mjs';

const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const NOW = Date.parse('2026-10-25T17:03:10Z');

export default {
  id: 'await-verify-delivered-previous-ci-never-retired',
  title: 'delivered previous-head CI repairs retire gone sessions and retain busy sessions past the stale window',
  card: 'delivered previous-head CI repair retirement',
  fixedBy: { sha: 'HEAD', where: 'lane-9', paths: [PASS] },
  fixPresent(root) {
    return readFileSync(join(root, PASS), 'utf8').includes("reason: 'delivered-repair-abandoned'");
  },
  async run({ log } = {}) {
    const violations = [];
    for (const state of ['gone', 'busy']) {
      const record = { v: 1, sessionId: '0c5f3830-1522-49ab-8f20-e4108ccc926b', who: 'fix-delivered-ci',
        repo: CONSTELLATION_REPOS.we.slug, pr: 1, kind: 'fix', sha: '6'.repeat(40),
        lane: 'fixture-lane', ref: 'lane/repair', attempt: 1, requestedAt: new Date(NOW).toISOString(),
        previousCi: { ready: { ciFailures: [{ name: 'unit', conclusion: 'FAILURE' }] }, failuresHandedOff: true },
        pendingResume: { kind: 'previous-ci', delivered: true, deliveredAt: new Date(NOW).toISOString() } };
      const store = new Map([[record.sessionId, record]]);
      const io = {
        fixTimingPolicy: () => ({ pushAfterCi: true }),
        pushPolicy: () => ({ pushBeforeGate: false }),
        retryPolicy: () => ({}),
        listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
        writeRecord: r => { store.set(r.sessionId, r); return { ok: true }; },
        clearRecord: key => ({ cleared: store.delete(key) }),
        listSessions: () => state === 'gone' ? [] : [{ sessionId: record.sessionId, name: record.who, status: 'running' }],
      };
      const { rows: allRows } = await runAwaitVerifyPass({ io,
        nowMs: NOW + (state === 'gone' ? 30_000 : 24 * 60 * 60_000),
        ttlMs: 150 * 60_000, loggedPolicyLine: { value: null }, resumedUnclearable: new Set() });
      const rows = allRows.filter(r => r.key);
      log?.(`${state}: waiter=${store.has(record.sessionId)}, rows=${JSON.stringify(rows)}`);
      if (state === 'gone') {
        if (store.size || rows.length !== 1 || rows[0].reason !== 'delivered-repair-abandoned') {
          violations.push('gone: delivered previous-head CI repair was not retired');
        }
      } else if (store.get(record.sessionId) !== record || rows.length !== 1
        || rows[0].action !== 'wait' || rows[0].reason !== 'previous-head CI repair must be verified and re-marked') {
        violations.push('busy: delivered previous-head CI repair lost its exclusion past the stale window');
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
