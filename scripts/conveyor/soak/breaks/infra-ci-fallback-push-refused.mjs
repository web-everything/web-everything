/** Live #6693 2026-11-12 08:12Z: the infra CI-green fallback chose correctly, then routed into the push step, which refused (the fix claim is not held by the pass's session) and resumed the fixer with push-refused instead of ending the round. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runAwaitVerifyPass } from '../../await-verify-pass.mjs';

const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const SHA = '2b1b8e435f'.padEnd(40, '0');
const TREE = 'f'.repeat(64);
const NOW = Date.parse('2026-11-12T08:12:10Z');

export default {
  id: 'infra-ci-fallback-push-refused',
  title: 'an infra verify failure with green required CI hands the round back without a second push (live #6693 push-refused)',
  card: 'PR for lane/await-verify-ci-green-fallback (R895+R903)',
  fixedBy: { sha: '33ee0ead26032a28739b1a690e1a25a67e7b87b5', where: 'lane/await-verify-ci-green-fallback', paths: [PASS] },
  fixPresent(root) { return readFileSync(join(root, PASS), 'utf8').includes('skipPush: true'); },
  async run({ log } = {}) {
    const violations = [];
    const record = { v: 1, sessionId: 'fix-6693', who: 'fix-6693', repo: CONSTELLATION_REPOS.we.slug, pr: 6693, kind: 'fix',
      sha: SHA, lane: '/lanes/lane-9', ref: 'lane/x', attempt: 1, retries: 2, infraRetry: { attempts: 3 }, requestedAt: new Date(NOW - 3_600_000).toISOString(),
      earlyPush: { ok: true, sha: SHA, upToDate: true, attempts: 1, done: true } };
    const store = new Map([[record.sessionId, record]]);
    const prompts = [];
    let pushes = 0;
    const io = {
      listRecords: () => [...store.entries()].map(([key, r]) => ({ key, record: r })),
      writeRecord: r => { store.set(r.sessionId, r); return { ok: true }; },
      clearRecord: key => { store.delete(key); },
      laneState: () => ({ head: SHA, dirty: false, treeHash: TREE }),
      readMarker: () => ({ sha: SHA, status: 'infrastructure-failure', treeHash: TREE, infrastructure: { reason: 'verify-timeout', detail: 'SIGKILL after 1800000ms' } }),
      rerequest: () => ({ ok: true }),
      push: () => { pushes++; return { ok: false, reason: 'refusing to push lane/x: the fix claim is not held by this session' }; },
      listSessions: () => [{ sessionId: record.sessionId, name: record.who, status: 'idle' }],
      resume: ({ prompt }) => { prompts.push(prompt); return { resumed: true }; },
      readPreviousHead: async () => SHA,
      readPreviousRequired: async () => ({ checks: ['test'], source: 'live' }),
      readPreviousChecks: async () => [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      infraFallbackToCi: () => ({ enabled: true, source: 'standard' }),
    };
    await runAwaitVerifyPass({ io, nowMs: NOW, ttlMs: 150 * 60_000, loggedPolicyLine: { value: null }, resumedUnclearable: new Set(),
      retryPolicy: { value: { infraRetry: { maxAttempts: 3, backoffMinutes: 15 } }, sources: {} } });
    log?.(`pushes=${pushes} prompts=${prompts.length} first=${(prompts[0] ?? '').slice(0, 60)}`);
    if (pushes) violations.push('the fallback pushed a head that was already early-pushed');
    if (prompts.length !== 1 || /push-refused|refus/i.test(prompts[0] ?? '') || !(prompts[0] ?? '').includes('before/after evidence comment')) violations.push('the round did not end with the green hand-back');
    return { violations };
  },
  judge: report => report.violations,
};
