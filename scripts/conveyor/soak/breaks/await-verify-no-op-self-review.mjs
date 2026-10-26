/** PR #5919: a first up-to-date early push must not discard an open self-review's waiter. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runAwaitVerifyPass, defaultAwaitVerifyIo, AWAIT_VERIFY_LIMITS } from '../../await-verify-pass.mjs';
import { selfReviewHold, selfReviewKey, selfReviewStoreDir } from '../../await-verify.mjs';
import { selfReviewReleaseRefusal } from '../../fix-procedure.mjs';

const PASS = 'scripts/conveyor/await-verify-pass.mjs';
const SHA = '6'.repeat(40);
const TREE = 'f'.repeat(64);
const NOW = Date.parse('2026-10-25T17:03:10Z');

export default {
  id: 'await-verify-no-op-self-review',
  title: 'a no-op early push retains self-review holds and observes verification during push and deferred hand-back',
  card: 'PR #5919, send-back 5726 item 1',
  fixedBy: { sha: 'HEAD', where: 'lane/port-1023a-b', paths: [PASS] },
  fixPresent(root) {
    const source = readFileSync(join(root, PASS), 'utf8');
    return source.includes("['green', 'no-new-commit'].includes(record.pendingResume?.kind)")
      && source.includes('dir: selfReviewStoreDir(env), strict: true')
      && source.includes('if (pendingNoOp)')
      && source.includes('lane: currentLane');
  },
  async run({ log } = {}) {
    const violations = [];
    for (const deferred of ['paused', 'busy', 'failed', 'during-push', 'during-rerequest']) {
      const duringPush = deferred.startsWith('during-');
      const record = { v: 1, sessionId: 'fix-5919-deferred', who: 'fix-5919', repo: CONSTELLATION_REPOS.we.slug,
        pr: 5919, kind: 'fix', sha: SHA, lane: '/lanes/lane-2', ref: 'lane/port-1023a-b', attempt: 1,
        requestedAt: new Date(NOW).toISOString() };
      const store = new Map([[record.sessionId, record]]);
      const prompts = [];
      let delayed = true;
      let pushes = 0;
      const io = {
        pushPolicy: () => ({ pushBeforeGate: true, source: 'standard', invalid: [] }),
        listRecords: () => [...store.entries()].map(([key, record]) => ({ key, record })),
        writeRecord: r => { store.set(r.sessionId, r); return { ok: true }; },
        clearRecord: key => { store.delete(key); },
        laneState: () => ({ head: SHA, dirty: false, treeHash: TREE }),
        readMarker: () => delayed && deferred === 'during-rerequest' ? null : ({ sha: SHA, status: delayed ? 'running' : 'red', exitCode: delayed ? null : 1,
          treeHash: TREE, startedAt: record.requestedAt, failureDetails: { summary: 'deferred verification failed' } }),
        readSelfReview: () => null,
        push: () => { pushes++; if (duringPush) delayed = false; return { ok: true, upToDate: true }; },
        rerequest: () => { violations.push(`${deferred}: unexpectedly re-requested verify`); },
        listSessions: () => [{ sessionId: record.sessionId, name: record.who,
          status: delayed && deferred === 'busy' ? 'running' : 'idle' }],
        resume: ({ prompt }) => {
          if (delayed && deferred === 'failed') return { resumed: false };
          prompts.push(prompt); return { resumed: true };
        },
      };
      const tick = allowResume => runAwaitVerifyPass({ io, allowResume, nowMs: NOW + 30_000,
        ttlMs: 150 * 60_000, loggedPolicyLine: { value: null }, resumedUnclearable: new Set() });
      await tick(deferred !== 'paused');
      if (!duringPush && (store.get(record.sessionId)?.pendingResume?.kind !== 'no-new-commit' || prompts.length)) {
        violations.push(`${deferred}: no-op resume was not deferred`);
      }
      delayed = false;
      await tick(true);
      await tick(true);
      log?.(`${deferred}: delivered=${prompts.length}, waiter=${store.has(record.sessionId)}`);
      if (prompts.length !== 1 || !prompts[0].includes('Verify is RED')
        || !prompts[0].includes('deferred verification failed') || prompts[0].includes('## Fix evidence')
        || store.size || pushes !== 1) {
        violations.push(`${deferred}: deferred no-op hand-back displaced the red repair path`);
      }
    }
    for (const state of ['pending', 'must-fix']) {
      const record = { v: 1, sessionId: 'fix-5919-session', who: 'fix-5919', repo: CONSTELLATION_REPOS.we.slug,
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
    // Exercise the production filesystem reader, not a throwing substitute: errors must retain the waiter.
    for (const failure of ['malformed-json', 'invalid-state', 'unreadable']) {
      const root = mkdtempSync(join(tmpdir(), 'soak-no-op-review-'));
      try {
        const env = { WE_AWAIT_VERIFY_STORE: root };
        const dir = selfReviewStoreDir(env);
        const record = { v: 1, sessionId: 'fix-5919-session', who: 'fix-5919', repo: CONSTELLATION_REPOS.we.slug,
          pr: 5919, kind: 'fix', sha: SHA, lane: '/lanes/lane-2', ref: 'lane/port-1023a-b', attempt: 1,
          requestedAt: new Date(NOW).toISOString() };
        const file = join(dir, `${selfReviewKey(record)}.json`);
        if (failure === 'unreadable') writeFileSync(dir, 'not a directory');
        else { mkdirSync(dir); writeFileSync(file, failure === 'malformed-json' ? '{' : '{"state":"unknown"}'); }
        const production = await defaultAwaitVerifyIo({ env, dispatchIo: {}, stopSessionFn: () => {},
          pushRefusalFn: () => null, readClaimFn: () => null,
          exec: () => { throw new Error('unexpected external command'); } });
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
          readSelfReview: production.readSelfReview,
          push: () => { pushes++; return { ok: true, upToDate: true }; },
          rerequest: () => { violations.push(`${failure}: unexpectedly re-requested verify`); },
          listSessions: () => [{ sessionId: record.sessionId, name: record.who, status: 'idle' }],
          resume: ({ prompt }) => { prompts.push(prompt); return { resumed: true }; },
        };
        const tick = nowMs => runAwaitVerifyPass({ io, nowMs, ttlMs: 150 * 60_000,
          loggedPolicyLine: { value: null }, resumedUnclearable: new Set() });
        for (const nowMs of [NOW + 30_000, NOW + AWAIT_VERIFY_LIMITS.selfReviewMaxMs + 1]) {
          const { rows } = await tick(nowMs);
          const error = rows.find(row => row.result?.startsWith('error: self-review record '))?.result;
          log?.(`${failure}: resumes=${prompts.length}, waiter=${store.has(record.sessionId)}, ${error ?? 'NO READ ERROR'}`);
          if (prompts.length || !store.has(record.sessionId) || !error) {
            violations.push(`${failure}: read error bypassed hold or lost its error report`);
          }
        }
        if (failure === 'unreadable') { rmSync(dir); mkdirSync(dir); }
        const repairedAt = NOW + AWAIT_VERIFY_LIMITS.selfReviewMaxMs + 60_000;
        writeFileSync(file, JSON.stringify({ ...record, state: 'clean', returnedAt: new Date(repairedAt).toISOString() }));
        await tick(repairedAt + 10_000);
        await tick(repairedAt + 20_000);
        if (prompts.length !== 1 || !prompts[0].includes('## Fix evidence') || store.size || pushes !== 1) {
          violations.push(`${failure}: repaired self-review did not release exactly once without re-push`);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    return { violations };
  },
  judge: report => report.violations,
};
