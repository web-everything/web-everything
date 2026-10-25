/** PR #5919: a first up-to-date early push must not discard an open self-review's waiter. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAwaitVerifyPass, AWAIT_VERIFY_LIMITS } from '../../await-verify-pass.mjs';
import { selfReviewHold } from '../../await-verify.mjs';
import { selfReviewReleaseRefusal } from '../../fix-procedure.mjs';

const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const SHA = '6'.repeat(40);
const TREE = 'f'.repeat(64);
const NOW = Date.parse('2026-10-25T17:03:10Z');

export default {
  id: 'await-verify-no-op-self-review',
  title: 'a no-op early push retains the self-review hold and bounded recovery',
  card: 'PR #5919, send-back x1b8hlo item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/port-1023a-b', paths: [PASS] },
  fixPresent(root) {
    return readFileSync(join(root, PASS), 'utf8').includes("['green', 'no-new-commit'].includes(record.pendingResume?.kind)");
  },
  async run({ log } = {}) {
    const violations = [];
    for (const state of ['pending', 'must-fix']) {
      const record = { v: 1, sessionId: 'fix-5919-session', who: 'fix-5919', repo: 'web-everything/web-everything',
        pr: 5919, kind: 'fix', sha: SHA, lane: '/lanes/lane-2', ref: 'lane/port-1023a-b', attempt: 1,
        requestedAt: new Date(NOW).toISOString() };
      let review = { ...record, state, startedAt: record.requestedAt, returnedAt: record.requestedAt };
      const store = new Map([[record.sessionId, record]]);
      const prompts = [];
      let pushes = 0;
      const io = {
        pushPolicy: () => ({ pushBeforeGate: true, source: 'standard', invalid: [] }),
        listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
        writeRecord: r => { store.set(r.sessionId, r); return { ok: true }; },
        clearRecord: key => { store.delete(key); },
        laneState: () => ({ head: SHA, dirty: false, treeHash: TREE }),
        readMarker: () => ({ sha: SHA, status: 'running', treeHash: TREE, startedAt: record.requestedAt }),
        readSelfReview: () => review,
        push: () => { pushes++; return { ok: true, upToDate: true }; },
        rerequest: () => { violations.push(`${state}: unexpectedly re-requested verify`); },
        listSessions: () => [{ sessionId: record.sessionId, name: record.who, status: 'idle' }],
        resume: ({ prompt }) => { prompts.push(prompt); return { resumed: true }; },
      };
      const tick = nowMs => runAwaitVerifyPass({ io, nowMs, ttlMs: 150 * 60_000,
        loggedPolicyLine: { value: null }, resumedUnclearable: new Set() });
      await tick(NOW + 30_000);
      const refusal = selfReviewReleaseRefusal({ selfReview: review, completion: null,
        sessionId: record.sessionId, who: record.who, hold: selfReviewHold });
      log?.(`${state}: resumes=${prompts.length}, waiter=${store.has(record.sessionId)}, release=${refusal?.split(':')[0]}`);
      if (prompts.length || !store.has(record.sessionId)) violations.push(`${state}: hand-back issued and waiter lost while fix-end refuses release`);

      // After the bounded hold, recover the reviewer instead of authorizing hand-back.
      await tick(NOW + AWAIT_VERIFY_LIMITS.selfReviewMaxMs + 1);
      if (prompts.length !== 1 || !prompts[0].includes('Do not hand back yet')
        || !prompts[0].includes('self-review clean|must-fix') || store.size) {
        violations.push(`${state}: bounded finish-the-review recovery missing`);
      }

      // A returned review releases a new wait exactly once, without another early push.
      prompts.length = 0;
      store.set(record.sessionId, { ...record, earlyPush: { sha: SHA, attempts: 1, ok: true, done: true, upToDate: true } });
      review = { ...review, state: 'clean', returnedAt: new Date(NOW + 60_000).toISOString() };
      await tick(NOW + 70_000);
      await tick(NOW + 80_000);
      if (prompts.length !== 1 || !prompts[0].includes('## Fix evidence') || store.size || pushes !== 1) {
        violations.push(`${state}: clean no-op did not complete exactly once`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
