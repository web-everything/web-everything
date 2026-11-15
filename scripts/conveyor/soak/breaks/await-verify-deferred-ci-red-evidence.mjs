/** PR #6848: a busy fixer must not receive infrastructure-only advice after local evidence changes. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAwaitVerifyPass } from '../../await-verify-pass.mjs';

const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const SHA = 'e'.repeat(40);
const OTHER = 'd'.repeat(40);
const NOW = Date.parse('2026-11-14T22:44:00Z');

export default {
  id: 'await-verify-deferred-ci-red-evidence',
  title: 'deferred CI-red delivery revalidates the lane and local infrastructure verdict',
  card: 'PR #6848',
  fixedBy: { sha: 'HEAD', where: 'lane/await-verify-ci-red-resume', paths: [PASS] },
  fixPresent(root) {
    return readFileSync(join(root, PASS), 'utf8').includes('const current = await infraCiRedEvidence(');
  },
  async run({ log } = {}) {
    const violations = [];
    for (const variant of ['unchanged', 'lane-moved', 'lane-dirty', 'marker-red', 'marker-void', 'marker-sha']) {
      let record = { v: 1, kind: 'fix', pr: 6770, repo: 'web-everything/web-everything',
        sha: SHA, sessionId: 'fix-deferred-ci-red', who: 'fix-6770', lane: '/lanes/lane-9', ref: 'lane/x',
        attempt: 1, retries: 2, requestedAt: new Date(NOW - 60_000).toISOString() };
      let busy = true;
      let lane = { head: SHA, dirty: false, treeHash: 'tree' };
      let marker = { sha: SHA, status: 'infrastructure-failure', startedAt: new Date(NOW - 1000).toISOString(),
        infrastructure: { reason: 'verify-unsettled' } };
      const prompts = [];
      const io = {
        listRecords: () => record ? [{ key: 'fix-deferred-ci-red', record }] : [],
        writeRecord: next => { record = next; return { ok: true }; },
        clearRecord: () => { record = null; return { cleared: true }; },
        laneState: () => lane,
        readMarker: () => marker,
        readPreviousHead: () => SHA,
        readPreviousRequired: () => ({ source: 'live', checks: ['test'] }),
        readPreviousChecks: () => [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE',
          details_url: 'https://github.com/web-everything/web-everything/actions/runs/43632493009/job/1' }],
        listSessions: () => [{ sessionId: 'fix-deferred-ci-red', state: busy ? 'busy' : 'done', busy }],
        resume: ({ prompt }) => { prompts.push(prompt); return { resumed: true }; },
        rerequest: () => ({ ok: true }),
      };
      const tick = ms => runAwaitVerifyPass({ io, nowMs: NOW + ms, loggedPolicyLine: { value: null },
        resumedUnclearable: new Set() });
      await tick(0);
      if (record?.pendingResume?.kind !== 'ci-red' || prompts.length) violations.push(`${variant}: CI-red was not queued while busy`);
      busy = false;
      if (variant === 'lane-moved') lane = { ...lane, head: OTHER };
      if (variant === 'lane-dirty') lane = { ...lane, dirty: true };
      if (variant === 'marker-red') marker = { ...marker, status: 'red', exitCode: 1, infrastructure: null };
      if (variant === 'marker-void') marker = null;
      if (variant === 'marker-sha') marker = { ...marker, sha: OTHER };
      const { rows } = await tick(60_000);
      const delivered = prompts.filter(p => p.includes('FAILED for real')).length;
      log?.(`${variant}: CI-red deliveries=${delivered}; ${rows[0]?.result}`);
      if (variant === 'unchanged') {
        if (delivered !== 1 || record) violations.push(`${variant}: valid delivery did not clear the wait exactly once`);
      } else {
        if (delivered || !record || record.pendingResume?.kind === 'ci-red') {
          violations.push(`${variant}: stale CI-red advice displaced current lane/verdict handling`);
        }
        // Dropping the stale resume must leave the ordinary local-verdict path actionable next tick.
        if (variant === 'marker-red') {
          await tick(120_000);
          if (!prompts.some(p => p.includes('Verify is RED'))) violations.push(`${variant}: current local red was lost`);
        }
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
