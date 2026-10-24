import { afterEach, describe, expect, it, vi } from 'vitest';
import * as carry from '../numbering-carry.mjs';
import { assertMandatoryReferralsCleared } from '../../review-set-label.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../jury-core.mjs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMintedReviewRunId, readReviewRunEvidence, readReviewRunHeads } from '../../conveyor/review-referral-hold.mjs';
import { chosenRunIdRecord, newRunRecord } from '../../operations/run-record.mjs';
import { createFileRunStore, newRunId, resolveRunsDir, tryReadRun, writeRun } from '../../operations/run-store.mjs';
import { createRegistry, op } from '../../operations/registry.mjs';
import { compute } from '../../operations/step-kinds.mjs';
import { runOperationCli } from '../../operations/cli-adapter.mjs';

const repo = 'web-everything/web-everything', pr = 5505;
// Ids shaped as `newRunId('review-pr')` mints them: only those count as a completed clean review.
const PRIOR_RUN = 'review-pr-7d7c3c1e-0b1f-4c39-9a51-000000000001';
const LIVE_RUN = 'review-pr-7d7c3c1e-0b1f-4c39-9a51-000000000002';
const CLEAN_RUN = 'review-pr-7d7c3c1e-0b1f-4c39-9a51-000000000003';
const FROM = '7ae496bef00d2096959b5f6d20cfd0394b976898';
const TO = '440cd1c4c18c773d1669189862322e9d0153b7b7';
const OLD = 'a'.repeat(40);
const authorBody = '<!-- authored-by-actor: author -->';
const on = { value: true, source: 'test' }, off = { value: false, source: 'test' };
function record(head) {
  const original = { summary: 'Earlier finding requires a ruling', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const seat = 'judgeCorrectnessAdvisory', runId = `review-pr-${head}`;
  return { author: { login: 'web-everything' }, body: renderReferralRecord({ version: 1, repo, pr, head, runId,
    authorBody, reviewer: mandatoryReferralReviewer(runId), attempted: true, rulings: [],
    referrals: [{ seat, original, finding: normalizeFinding(original), key: referralFindingKey(seat, original) }] }) };
}
const acceptance = { id: 'accepted-prior', author: { login: 'chalbert' }, createdAt: '2026-10-17T12:00:00Z',
  body: `✅ review — accepted\n<!-- reviewed-sha: ${FROM} -->` };
const cleanRun = { repo, pr, head: FROM, startedAt: 1, completedAt: 2, pending: [], parked: false, persistenceFailed: false };
function replay({ held = false, liveHeld = false, runs = [cleanRun], prove = vi.fn(() => ({ ok: true, reason: 'verified numbering' })), setting,
  onRead = () => {}, guardOverride, labelsOnly = false, numberingSetting = on, netPatchSetting = off,
  human = false, exec, readRuns = () => runs, readRunHeads } = {}) {
  const state = { state: 'OPEN', body: authorBody, labels: ['review:pending'], headRefOid: TO,
    comments: [record(held ? FROM : OLD), human ? { ...acceptance,
      body: `${acceptance.body}\n<!-- cleared-human: chalbert -->` } : acceptance] };
  if (liveHeld) state.comments.unshift(record(TO));
  if (labelsOnly) state.comments.push({ author: { login: 'chalbert' },
    body: carry.buildNumberingRestampBody({ fromSha: FROM, toSha: TO, human: false, writer: 'review-daemon' }) });
  const checked = [], writes = [];
  const guard = vi.fn((s, context) => {
    checked.push(s.headRefOid);
    return assertMandatoryReferralsCleared(s, { ...context, env: {}, cardReadable: () => true,
      readRuns, ...(readRunHeads ? { readRunHeads } : {}), readNetDiff: sha => ({ scored: true, text: `diff at ${sha}` }) });
  });
  const result = carry.restampAfterNumbering({ repo, pr, state, reviews: [], enabled: true, acceptCarry: 'on',
    numberingSetting, netPatchSetting, ...(setting ? { referralEvidenceSetting: setting } : {}), prove, exec,
    guardReferrals: guardOverride ?? guard,
    readLiveState: () => { onRead(state); return { state, reviews: [] }; },
    provider: { postComment: (_r, _p, body) => {
      writes.push('comment'); state.comments.push({ id: 'new', author: { login: 'chalbert' }, body });
    }, setLabels: () => writes.push('labels'), editComment: () => writes.push('withdraw') } });
  return { result, checked, writes, state, prove, guard };
}
afterEach(() => { carry._resetNumberingRestampMemo(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Keep the real identical-net-patch proof in the replay; only its read-only Git IO is fake.
function identicalNetPatchReader() {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
  return vi.fn((_cmd, args) => {
    if (args[0] === 'merge-base') return Buffer.from(OLD);
    if (args[0] === 'diff') return Buffer.from(patch);
    if (args[0] === 'patch-id') return Buffer.from(`${'b'.repeat(40)} ${'0'.repeat(40)}\n`);
    throw Error(`Unexpected git read: ${args.join(' ')}`);
  });
}

// Raw git plumbing for the five renamed/re-id'd cards in #5505. Exercise the real proof,
// including bornAs stamps, rather than trusting a numbering subject or a mocked verdict.
function cardsOnlyReader() {
  const pairs = [['xh2rf6g', '6200'], ['xpdw3em', '6201'], ['xeluwak', '6202'], ['xxvode8', '6203'], ['x4pfhf5', '6204']];
  const blobs = new Map();
  const zero = '0'.repeat(40);
  let raw = '';
  for (const [i, [hash, number]] of pairs.entries()) {
    const beforeOid = (i * 2 + 1).toString(16).padStart(40, '0');
    const afterOid = (i * 2 + 2).toString(16).padStart(40, '0');
    blobs.set(beforeOid, `---\nid: ${hash}\n---\nSee #${hash}.\n`);
    blobs.set(afterOid, `---\nbornAs: ${hash}\nid: ${number}\n---\nSee #${number}.\n`);
    raw += `:100644 000000 ${beforeOid} ${zero} D\0backlog/${hash}-card.md\0`;
    raw += `:000000 100644 ${zero} ${afterOid} A\0backlog/${number}-card.md\0`;
  }
  return (_cmd, args) => {
    let out;
    if (args[0] === 'cat-file') out = args[1] === 'blob' ? blobs.get(args[2])
      : args[1] === '-t' ? 'blob' : args[1] === '-s' ? String(Buffer.byteLength(blobs.get(args[2]))) : '';
    else if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === `${FROM}^{commit}`) out = FROM;
    else if (args[0] === 'rev-list') out = `${TO} ${FROM}\n`;
    else if (args[0] === 'log') out = `drain: JIT-number ${pairs.map(([h, n]) => `${h}→#${n}`).join(', ')} at land (#2288)\n`;
    else if (args[0] === 'ls-tree' || args[0] === 'grep') out = '';
    else if (args[0] === 'diff-tree') out = raw;
    else throw Error(`Unexpected git read: ${args.join(' ')}`);
    if (out === undefined) throw Error('Missing blob');
    return Buffer.from(out);
  };
}

describe('numbering carry referral evidence', () => {
  it.each(['parked', 'pending'])('refuses a %s live-head run without a referral record even when the prior head is clean', status => {
    const liveRun = { ...cleanRun, head: TO, parked: status === 'parked', pending: status === 'pending' ? ['finding'] : [] };
    const { result, writes } = replay({ runs: [cleanRun, liveRun] });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('no-current-head-review-evidence') });
    expect(writes).toEqual([]);
  });
  it.each(['parked', 'pending'])('rechecks a %s live-head run that arrives before writing', status => {
    const runs = [cleanRun];
    const { result, writes } = replay({ runs, onRead: () => runs.push({ ...cleanRun, head: TO,
      parked: status === 'parked', pending: status === 'pending' ? ['finding'] : [] }) });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('no-current-head-review-evidence') });
    expect(writes).toEqual([]);
  });
  it.each(['parked', 'pending'])('withdraws the new record if a %s live-head run arrives before labels', status => {
    const runs = [cleanRun];
    let reads = 0;
    const { result, writes } = replay({ runs, onRead: () => { if (++reads === 2) runs.push({ ...cleanRun, head: TO,
      parked: status === 'parked', pending: status === 'pending' ? ['finding'] : [] }); } });
    expect(result).toMatchObject({ action: 'retry', withdrawn: 1 });
    expect(writes).toEqual(['comment', 'withdraw']);
  });
  it.each([false, true])('label-only recovery refuses an unfinished live-head run (arrives on recheck: %s)', late => {
    const liveRun = { ...cleanRun, head: TO, parked: true };
    const runs = late ? [cleanRun] : [cleanRun, liveRun];
    const { result, writes } = replay({ runs, labelsOnly: true, onRead: () => runs.push(liveRun) });
    expect(result.action).toBe('retry');
    expect(writes).toEqual([]);
  });
  // PR #5520 red team: a run whose `advise` never finished has no review evidence, but it
  // did review the live head. The real run store and readers must still see it.
  describe('persisted live-head run that never finished advise', () => {
    let dir;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const persist = (id, head, verdict, adviseFinished) => writeRun({ ...newRunRecord({ id, op: 'review-pr' }),
      findings: { read: { repo, pr, netBasis: { rev: head } } }, verdict,
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: '2026-10-17T12:00:00Z', finishedAt: '2026-10-17T12:00:30Z', durationMs: 30000 },
        { step: 'advise', stepIndex: 1, startedAt: '2026-10-17T12:00:30Z',
          ...(adviseFinished ? { finishedAt: '2026-10-17T12:01:00Z', durationMs: 30000 } : {}) }] }, dir);
    const live = {
      'persistence-failed': { verdict: 'needs-human', pendingReferrals: ['referral-persistence-failed'] },
      'no verdict yet': undefined,
    };
    it.each(Object.keys(live).flatMap(kind => [0, 1, 2].map(arriveAt => [kind, arriveAt])))(
      'refuses a %s live-head run (arrives on read %s)', (kind, arriveAt) => {
        dir = mkdtempSync(join(tmpdir(), 'numbering-unfinished-'));
        persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
        const arrive = () => persist(LIVE_RUN, TO, live[kind], false);
        if (!arriveAt) arrive();
        let reads = 0;
        const { result, writes, guard } = replay({ readRuns: () => readReviewRunEvidence({ dir, memo: new Map(), persist: false }),
          readRunHeads: () => readReviewRunHeads({ dir, memo: new Map(), persist: false }),
          onRead: () => { if (++reads === arriveAt) arrive(); } });
        expect(result.action).toBe('retry');
        expect(writes).toEqual(arriveAt === 2 ? ['comment', 'withdraw'] : []);
        expect(guard.mock.results.findLast(r => r.type === 'throw').value)
          .toMatchObject({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN' });
      });
    // The shared guard itself, without the re-stamp writer: the typed codes and the #4708 identical-diff carry.
    const guardState = { state: 'OPEN', body: authorBody, labels: ['review:pending'], headRefOid: TO, comments: [record(OLD)] };
    it.each(Object.keys(live))('default run readers refuse an unfinished %s live-head review through resolveRunsDir', kind => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-default-readers-'));
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      expect(resolveRunsDir()).toBe(dir);
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      persist(LIVE_RUN, TO, live[kind], false);
      // Use both production reader defaults. Identical diffs would otherwise allow carry
      // from the clean prior review because the evidence projection omits this live run.
      const readNetDiff = vi.fn(() => ({ scored: true, text: 'same diff' }));
      expect(() => assertMandatoryReferralsCleared(guardState, {
        repo, pr, env: {}, cardReadable: () => true, readNetDiff,
      })).toThrow(expect.objectContaining({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN' }));
      expect(readNetDiff).not.toHaveBeenCalled();
    });
    it('default run readers carry clean prior evidence when no run reviewed the live head', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-default-readers-'));
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      expect(assertMandatoryReferralsCleared(guardState, {
        repo, pr, env: {}, cardReadable: () => true,
        readNetDiff: () => ({ scored: true, text: 'same diff' }),
      })).toMatchObject({ carry: { fromHead: FROM, toHead: TO, runId: PRIOR_RUN } });
    });
    const guardDirect = (readRunHeads, readNetDiff = sha => ({ scored: true, text: 'same diff' })) => {
      try {
        return assertMandatoryReferralsCleared(guardState, { repo, pr, env: {}, cardReadable: () => true, readNetDiff,
          readRuns: () => readReviewRunEvidence({ dir, memo: new Map(), persist: false }), readRunHeads });
      } catch (e) { return e; }
    };
    it('the guard reports an unfinished live-head run and never carries identical-diff evidence over it', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-unfinished-'));
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      persist(LIVE_RUN, TO, live['persistence-failed'], false);
      const outcome = guardDirect(() => readReviewRunHeads({ dir, memo: new Map(), persist: false }));
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN',
        message: expect.stringContaining('no-current-head-review-evidence') });
    });
    it('the guard reports no review run, and the identical-diff carry stands in, only when no run reviewed the live head', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-unfinished-'));
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      const heads = () => readReviewRunHeads({ dir, memo: new Map(), persist: false });
      expect(guardDirect(heads)).toMatchObject({ carry: { fromHead: FROM, toHead: TO, runId: PRIOR_RUN } });
      expect(guardDirect(heads, sha => ({ scored: true, text: `diff at ${sha}` })))
        .toMatchObject({ code: 'MANDATORY_REFERRAL_NO_REVIEW_RUN' });
    });
    it('a missing run store is not proof that nobody reviewed the live head', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-unfinished-'));
      const absent = join(dir, 'absent');
      const heads = () => readReviewRunHeads({ dir: absent, memo: new Map(), persist: false });
      expect(guardDirect(heads)).toMatchObject({ code: 'MANDATORY_REFERRAL_RUN_STORE_MISSING' });
      const { result, writes } = replay({ readRuns: () => [], readRunHeads: heads,
        guardOverride: (s, context) => assertMandatoryReferralsCleared(s, { ...context, env: {}, cardReadable: () => true,
          readRuns: s.headRefOid === FROM ? () => [cleanRun] : () => [], readRunHeads: heads,
          readNetDiff: sha => ({ scored: true, text: `diff at ${sha}` }) }) });
      expect(result.action).toBe('retry');
      expect(writes).toEqual([]);
    });
    it('persists run heads in their own cache and still sees an unfinished run on a warm read', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-unfinished-'));
      persist(LIVE_RUN, TO, live['persistence-failed'], false);
      const cold = readReviewRunHeads({ dir, memo: new Map() });
      const evidence = readReviewRunEvidence({ dir, memo: new Map() });
      const warm = readReviewRunHeads({ dir, memo: new Map(), readRun: () => { throw Error('cache miss'); } });
      expect(cold).toEqual([{ id: LIVE_RUN, repo, pr, head: TO }]);
      expect(warm).toEqual(cold);
      // Main now retains incomplete attempts for retry accounting. They must stay
      // explicitly uncompleted and pending, so they still prove no clean review.
      expect(evidence).toEqual([{ id: LIVE_RUN, repo, pr, head: TO,
        startedAt: Date.parse('2026-10-17T12:00:00Z'), completedAt: null,
        incomplete: true, parked: false, attempted: false, persistenceFailed: false,
        count: 0, pending: ['review-incomplete'], rulings: [] }]);
      expect(readdirSync(dir).filter(n => n.endsWith('.cache')).sort())
        .toEqual(['.review-run-evidence.cache', '.review-run-heads.cache']);
    });
    // PR #5520 operator send-back (red team, review-referral-hold.mjs:114): `--run-id` chooses a run's file name, and
    // the readers find review runs by name. So no review run is ever written outside `review-pr-`, and one under a
    // chosen id inside it (anything but the id `newRunId` mints) never counts as a clean review.
    const OUTSIDE_IDS = ['custom-live', 'heavy-queue-0001fe94-2f78-4924-b3f2-0de22166a2ef', 'live', 'REVIEW-PR-live'];
    const CUSTOM_IDS = ['review-pr-live', 'review-pr-0001FE94-2F78-4924-B3F2-0DE22166A2EF',
      'review-pr-00000000-0000-0000-0000-000000000000', `${PRIOR_RUN}.x`];
    const defaultGuard = (readNetDiff = () => ({ scored: true, text: 'same diff' })) => {
      vi.stubEnv('OPERATION_RUNS_DIR', dir);
      try { return assertMandatoryReferralsCleared(guardState, { repo, pr, env: {}, cardReadable: () => true, readNetDiff }); }
      catch (e) { return e; }
    };
    it.each(OUTSIDE_IDS)('custom run IDs never hide a review run outside the review-pr- names the guard reads (%s)', id => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      expect(() => persist(id, TO, live['persistence-failed'], false)).toThrow(/does not match operation `review-pr`/);
      // Nor may another operation write into the namespace, where it would replace or hide a review run.
      expect(() => writeRun(newRunRecord({ id: `review-pr-${id}`, op: 'heavy-queue' }), dir)).toThrow(/does not match operation/);
      expect(readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([]);
    });
    it.each(CUSTOM_IDS.flatMap(id => Object.keys(live).map(kind => [id, kind])))(
      'custom run IDs never bypass the unfinished live-head review guard (%s, %s)', (id, kind) => {
        dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
        persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
        persist(id, TO, live[kind], false);
        const readNetDiff = vi.fn(() => ({ scored: true, text: 'same diff' }));
        expect(defaultGuard(readNetDiff)).toMatchObject({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN' });
        expect(readNetDiff).not.toHaveBeenCalled();
        const { result, writes } = replay({ readRuns: () => readReviewRunEvidence({ dir, memo: new Map(), persist: false }),
          readRunHeads: () => readReviewRunHeads({ dir, memo: new Map(), persist: false }) });
        expect(result.action).toBe('retry');
        expect(writes).toEqual([]);
      });
    it.each(CUSTOM_IDS)('a completed clean review under custom run ID %s never satisfies the guard', id => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      persist(id, TO, { verdict: 'accept', pendingReferrals: [] }, true);
      expect(defaultGuard()).toMatchObject({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN' });
      // Nor as the accepted prior head's evidence for the numbering carry.
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      persist(id, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      const { result, writes } = replay({ readRuns: () => readReviewRunEvidence({ dir, memo: new Map(), persist: false }),
        readRunHeads: () => readReviewRunHeads({ dir, memo: new Map(), persist: false }) });
      expect(result.action).toBe('retry');
      expect(writes).toEqual([]);
    });
    it.each(CUSTOM_IDS)('a clean review under custom run ID %s is never carried onto a head nobody reviewed', id => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      persist(id, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      const readNetDiff = vi.fn(() => ({ scored: true, text: 'same diff' }));
      expect(defaultGuard(readNetDiff)).toMatchObject({ code: 'MANDATORY_REFERRAL_NO_REVIEW_RUN' });
      expect(readNetDiff).not.toHaveBeenCalled();
    });
    it.each(CUSTOM_IDS)('a newer review under custom run ID %s that lost its referrals is never hidden by an older clean run', id => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      persist(CLEAN_RUN, TO, { verdict: 'accept', pendingReferrals: [] }, true);
      writeRun({ ...newRunRecord({ id, op: 'review-pr' }), findings: { read: { repo, pr, netBasis: { rev: TO } } },
        verdict: { verdict: 'needs-human', pendingReferrals: ['referral-persistence-failed'] },
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: '2026-10-17T13:00:00Z' },
          { step: 'advise', stepIndex: 1, startedAt: '2026-10-17T13:00:30Z', finishedAt: '2026-10-17T13:01:00Z', durationMs: 30000 }] }, dir);
      expect(defaultGuard()).toMatchObject({ message: expect.stringContaining('referral-persistence-failed') });
    });
    // The id's shape cannot prove it was minted: `--run-id=review-pr-<uuid v4>` looks exactly like `newRunId`'s.
    const CHOSEN_MINTED_SHAPE = 'review-pr-0001fe94-2f78-4924-b3f2-0de22166a2ef';
    const reviewFixtureCli = (argv, store) => {
      const declaration = op('review-pr', { input: {}, verdictFrom: 'lookup', lookup: compute({ reads: [], fn: () => ({ ok: true }) }) });
      const registry = createRegistry();
      registry.register(declaration);
      return runOperationCli({ declaration, argv, registry, store, sinks: {}, newRunId: () => newRunId('review-pr') });
    };
    it('a chosen run ID shaped like a minted one is recorded as chosen and never satisfies the guard', async () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      const result = await reviewFixtureCli([`--run-id=${CHOSEN_MINTED_SHAPE}`], createFileRunStore(dir));
      expect(result.code).toBe(0);
      const written = tryReadRun(CHOSEN_MINTED_SHAPE, dir);
      expect(written).toMatchObject({ id: CHOSEN_MINTED_SHAPE, idChosen: true });
      expect(isMintedReviewRunId(CHOSEN_MINTED_SHAPE)).toBe(true);
      // The same record, completed clean on the live head: still never the clean review.
      writeRun({ ...written, findings: { read: { repo, pr, netBasis: { rev: TO } } },
        verdict: { verdict: 'accept', pendingReferrals: [] },
        stepTimings: [{ step: 'read', stepIndex: 0, startedAt: '2026-10-17T12:00:00Z' },
          { step: 'advise', stepIndex: 1, startedAt: '2026-10-17T12:00:30Z', finishedAt: '2026-10-17T12:01:00Z', durationMs: 30000 }] }, dir);
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      expect(readReviewRunEvidence({ dir, memo: new Map(), persist: false }).find(r => r.id === CHOSEN_MINTED_SHAPE))
        .toMatchObject({ custom: true });
      expect(defaultGuard()).toMatchObject({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN' });
    });
    it('a chosen run ID never replaces an existing review run, so a parked review never vanishes', async () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      persist(LIVE_RUN, TO, live['persistence-failed'], false);
      const before = tryReadRun(LIVE_RUN, dir);
      const result = await reviewFixtureCli([`--run-id=${LIVE_RUN}`], createFileRunStore(dir));
      expect(result).toMatchObject({ code: 2, stopped: 'refused' });
      expect(result.lines.join('\n')).toContain('names an existing review run record');
      expect(tryReadRun(LIVE_RUN, dir)).toEqual(before);
      // An unreadable record under that id is not proof the id is free.
      const store = { read: () => { throw Error('corrupt'); } };
      expect(chosenRunIdRecord({ id: LIVE_RUN }, store)).toHaveProperty('error');
    });
    it('both readers tag a run under a chosen id custom, and only the id newRunId mints untagged', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-custom-id-'));
      persist(LIVE_RUN, TO, live['persistence-failed'], false);
      persist('review-pr-custom-live', TO, live['persistence-failed'], false);
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      persist('review-pr-custom-prior', FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      const byId = runs => Object.fromEntries(runs.map(r => [r.id, r.custom]));
      expect(byId(readReviewRunHeads({ dir, memo: new Map(), persist: false }))).toEqual({
        [LIVE_RUN]: undefined, 'review-pr-custom-live': true, [PRIOR_RUN]: undefined, 'review-pr-custom-prior': true });
      expect(byId(readReviewRunEvidence({ dir, memo: new Map(), persist: false })))
        // Incomplete attempts are retained too; their custom identity must survive
        // alongside the completed evidence rather than disappearing from this check.
        .toEqual({ [LIVE_RUN]: undefined, 'review-pr-custom-live': true,
          [PRIOR_RUN]: undefined, 'review-pr-custom-prior': true });
      expect(isMintedReviewRunId(newRunId('review-pr'))).toBe(true);
    });
    it('still carries numbering evidence when no run reviewed the live head', () => {
      dir = mkdtempSync(join(tmpdir(), 'numbering-unfinished-'));
      persist(PRIOR_RUN, FROM, { verdict: 'accept', pendingReferrals: [] }, true);
      const { result, writes } = replay({ readRuns: () => readReviewRunEvidence({ dir, memo: new Map(), persist: false }),
        readRunHeads: () => readReviewRunHeads({ dir, memo: new Map(), persist: false }) });
      expect(result.action).toBe('restamped');
      expect(writes).toEqual(['comment', 'labels']);
    });
  });
  it('does not treat a matching error message as proof that no live-head review ran', () => {
    const { result, writes } = replay({ guardOverride: state => {
      if (state.headRefOid === TO) throw Error('mandatory referral hold: no-current-head-review-evidence; unrelated refusal');
    } });
    expect(result.action).toBe('retry');
    expect(writes).toEqual([]);
  });
  it.each(['parked', 'pending', 'persistenceFailed', 'clean'])('refuses a %s live-head run first observed by the carry evidence read', status => {
    let reads = 0;
    const liveRun = { ...cleanRun, head: TO, parked: status === 'parked',
      pending: status === 'pending' ? ['finding'] : [], persistenceFailed: status === 'persistenceFailed' };
    // Read 1 checks FROM, read 2 checks TO, read 3 checks whether TO can carry evidence.
    const { result, checked, writes, guard } = replay({ readRuns: () => ++reads >= 3 ? [cleanRun, liveRun] : [cleanRun] });
    expect(result.action).toBe('retry');
    expect(checked).toEqual([FROM, TO]);
    expect(guard.mock.results.at(-1).value).toMatchObject({ code: 'MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN' });
    expect(writes).toEqual([]);
  });
  it.each(['unproven', 'disabled'])('identical-net-patch fallback guards only the live head before every write (numbering: %s)', mode => {
    const exec = identicalNetPatchReader();
    const prove = vi.fn(() => ({ ok: false, reason: 'not numbering' }));
    const { result, checked, writes } = replay({ exec, prove, netPatchSetting: on,
      numberingSetting: mode === 'disabled' ? off : on, human: mode === 'disabled',
      runs: [cleanRun, { ...cleanRun, head: TO }] });
    expect(result).toMatchObject({ action: 'restamped', reason: expect.stringContaining('identical git patch-id') });
    expect(checked).toEqual([TO, TO, TO]);
    expect(writes).toEqual(['comment', 'labels']);
    expect(exec.mock.calls.some(([, args]) => args[0] === 'patch-id')).toBe(true);
    if (mode === 'disabled') expect(prove).not.toHaveBeenCalled();
  });
  it.each(['unproven', 'disabled'])('identical-net-patch fallback refuses missing live-head evidence without writes (numbering: %s)', mode => {
    const { result, checked, writes } = replay({ exec: identicalNetPatchReader(),
      prove: () => ({ ok: false }), netPatchSetting: on,
      numberingSetting: mode === 'disabled' ? off : on, human: mode === 'disabled' });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('no-current-head-review-evidence') });
    expect(checked).toEqual([TO]);
    expect(writes).toEqual([]);
  });
  it.each([1, 2])('identical-net-patch fallback refuses a live-head hold before write %s', holdAt => {
    let reads = 0;
    const { result, checked, writes } = replay({ exec: identicalNetPatchReader(),
      prove: () => ({ ok: false }), netPatchSetting: on, runs: [cleanRun, { ...cleanRun, head: TO }],
      onRead: state => { if (++reads === holdAt) state.comments.unshift(record(TO)); } });
    expect(result.action).toBe('retry');
    expect(checked).toEqual(Array(holdAt + 1).fill(TO));
    expect(writes).toEqual(holdAt === 1 ? [] : ['comment', 'withdraw']);
  });
  it.each([false, true])('refuses a held referral recorded on the new head even when the prior head is clean (labelsOnly: %s)', labelsOnly => {
    const { result, writes } = replay({ liveHeld: true, labelsOnly });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('mandatory referral hold') });
    expect(writes).toEqual([]);
  });
  it.each([false, true])('rechecks a live-head hold that arrives before writing (labelsOnly: %s)', labelsOnly => {
    const { result, writes } = replay({ labelsOnly, onRead: state => state.comments.unshift(record(TO)) });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('mandatory referral hold') });
    expect(writes).toEqual([]);
  });
  it('withdraws the new record when a live-head hold arrives before labels', () => {
    let reads = 0;
    const { result, writes } = replay({ onRead: state => { if (++reads === 2) state.comments.unshift(record(TO)); } });
    expect(result).toMatchObject({ action: 'retry', withdrawn: 1 });
    expect(writes).toEqual(['comment', 'withdraw']);
  });
  it('refuses a live-head referral persistence failure', () => {
    const { result, writes } = replay({ runs: [cleanRun, { ...cleanRun, head: TO, persistenceFailed: true }] });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('referral-persistence-failed') });
    expect(writes).toEqual([]);
  });
  it('rechecks a live-head persistence failure before writing', () => {
    const runs = [cleanRun];
    const { result, writes } = replay({ runs, onRead: () => runs.push({ ...cleanRun, head: TO, persistenceFailed: true }) });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('referral-persistence-failed') });
    expect(writes).toEqual([]);
  });
  it.each([1, 2])('does not tolerate live-head guard read failures (live check: %s)', failAt => {
    let liveChecks = 0;
    const { result, writes } = replay({ guardOverride: state => {
      if (state.headRefOid === TO && ++liveChecks === failAt) throw Error('referral evidence unreadable');
    } });
    expect(result).toMatchObject({ action: 'retry', reason: 'referral evidence unreadable' });
    expect(writes).toEqual([]);
  });
  it.each([false, true])('refuses an unreadable write-time proof even when current-head referrals clear (labelsOnly: %s)', labelsOnly => {
    const prove = vi.fn().mockReturnValueOnce({ ok: true, reason: 'numbering' })
      .mockReturnValue({ ok: false, retryable: true, reason: 'unreadable recheck' });
    const { result, writes } = replay({ prove, labelsOnly, guardOverride: () => {} });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('unreadable recheck') });
    expect(writes).toEqual([]);
  });
  it.each(['refused', 'thrown'])('refuses a %s write-time proof independently of a clearing referral guard', failure => {
    const prove = vi.fn().mockReturnValueOnce({ ok: true, reason: 'numbering' }).mockImplementation(() => {
      if (failure === 'thrown') throw Error('unreadable recheck');
      return { ok: false, reason: 'numbering no longer proven' };
    });
    const { result, writes } = replay({ prove, guardOverride: () => {} });
    expect(result.action).toBe('retry');
    expect(writes).toEqual([]);
  });
  it('withdraws the new record if the proof becomes unreadable before labels even when referrals clear', () => {
    const prove = vi.fn().mockReturnValueOnce({ ok: true, reason: 'numbering' })
      .mockReturnValueOnce({ ok: true, reason: 'numbering' })
      .mockReturnValue({ ok: false, retryable: true, reason: 'unreadable label recheck' });
    const { result, writes } = replay({ prove, guardOverride: () => {} });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('unreadable label recheck'), withdrawn: 1 });
    expect(writes).toEqual(['comment', 'withdraw']);
  });
  it.each([
    ['enabled', on, [FROM, TO, FROM, TO, FROM, TO]],
    ['disabled', off, [TO, TO, TO]],
  ])('referral evidence %s guards the live head before every write', (_name, setting, expectedHeads) => {
    const { result, checked, writes } = replay({ setting, runs: [cleanRun, { ...cleanRun, head: TO }] });
    expect(result.action).toBe('restamped');
    expect(checked).toEqual(expectedHeads);
    expect(writes).toEqual(['comment', 'labels']);
  });
  it('scopes proof and both referral heads to the planned accepted-head to live-head pair and PR', () => {
    const { result, prove, guard } = replay();
    expect(result.action).toBe('restamped');
    expect(prove).toHaveBeenCalledTimes(3);
    for (const [options] of prove.mock.calls) {
      expect(options).toEqual({ fromSha: FROM, toSha: TO, exec: expect.any(Function), cwd: undefined });
    }
    expect(guard.mock.calls.map(([state, context]) => [state.headRefOid, context]))
      .toEqual([FROM, TO, FROM, TO, FROM, TO].map(head => [head, { repo, pr }]));
  });
  it('re-stamps a proven numbering move using the clean accepted prior head at every write', () => {
    const { result, checked, writes, state } = replay();
    expect(result.action).toBe('restamped');
    expect(checked).toEqual([FROM, TO, FROM, TO, FROM, TO]);
    expect(writes).toEqual(['comment', 'labels']);
    expect(state.headRefOid).toBe(TO);
  });
  it('still refuses a held referral on the accepted prior head', () => {
    const { result, checked, writes } = replay({ held: true });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('mandatory referral hold') });
    expect(checked).toEqual([FROM]);
    expect(writes).toEqual([]);
  });
  it('an unproven move retains the current-head refusal', () => {
    const { result, checked, writes } = replay({ prove: () => ({ ok: false, reason: 'author edit' }) });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('no-current-head-review-evidence') });
    expect(checked).toEqual([TO]);
    expect(writes).toEqual([]);
  });
  it('proves and re-stamps the #5505 cards-only rename and re-id shape', () => {
    const prove = options => carry.proveNumberingOnlyMove({ ...options, exec: cardsOnlyReader() });
    expect(prove({ fromSha: FROM, toSha: TO })).toMatchObject({ ok: true, pairs: expect.arrayContaining([['xh2rf6g', '6200']]) });
    expect(replay({ prove }).result.action).toBe('restamped');
  });
  it('setting off restores the old current-head refusal', () => {
    const prove = vi.fn(() => ({ ok: true }));
    const { result, checked, writes } = replay({ prove, setting: off });
    expect(result.reason).toContain('no-current-head-review-evidence');
    expect(checked).toEqual([TO]);
    expect(prove).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('rechecks a referral that becomes held before writing', () => {
    const { result, checked, writes } = replay({ onRead: state => state.comments.unshift(record(FROM)) });
    expect(result).toMatchObject({ action: 'retry', reason: expect.stringContaining('mandatory referral hold') });
    expect(checked).toEqual([FROM, TO, FROM]);
    expect(writes).toEqual([]);
  });
  it('re-proves the move before writing and falls back to the live-head guard on a read failure', () => {
    const prove = vi.fn().mockReturnValueOnce({ ok: true, reason: 'numbering' })
      .mockReturnValue({ ok: false, retryable: true, reason: 'unreadable recheck' });
    const { result, checked, writes } = replay({ prove });
    expect(result.reason).toContain('no-current-head-review-evidence');
    expect(checked).toEqual([FROM, TO, TO]);
    expect(writes).toEqual([]);
  });
  it('still returns the original proof refusal if the live-head referral guard clears an unproven move', () => {
    const checked = [];
    const { result, writes } = replay({ prove: () => ({ ok: false, reason: 'non-numbering edit' }),
      guardOverride: state => checked.push(state.headRefOid) });
    expect(result).toEqual({ action: 'refused', reason: 'non-numbering edit' });
    expect(checked).toEqual([TO]);
    expect(writes).toEqual([]);
  });
  it('label-only recovery proves numbering and checks the accepted prior head', () => {
    const { result, checked, writes } = replay({ labelsOnly: true });
    expect(result).toMatchObject({ action: 'restamped', labelsOnly: true });
    expect(checked).toEqual([FROM, TO, FROM, TO]);
    expect(writes).toEqual(['labels']);
  });
  it('fails closed if the proof is unreadable', () => {
    const { result, checked, writes } = replay({ prove: () => ({ ok: false, retryable: true, reason: 'unreadable' }) });
    expect(result.reason).toContain('no-current-head-review-evidence');
    expect(checked).toEqual([TO]);
    expect(writes).toEqual([]);
  });
  it('defaults on and resolves platform, tool and environment provenance', () => {
    const resolve = carry.resolveNumberingCarryReferralEvidenceSetting;
    expect(resolve({ env: {}, platform: {}, tool: {} })).toEqual({ value: true, source: 'standard' });
    expect(resolve({ env: {}, platform: { numberingCarryReferralEvidence: false }, tool: {} }))
      .toEqual({ value: false, source: 'platform' });
    expect(resolve({ env: {}, platform: {}, tool: { numberingCarryReferralEvidence: false } }))
      .toEqual({ value: false, source: 'tool' });
    expect(resolve({ env: { WE_REVIEW_NUMBERING_CARRY_REFERRAL_EVIDENCE: 'off' }, platform: {}, tool: {} }))
      .toEqual({ value: false, source: 'env' });
    expect(resolve({ env: { WE_REVIEW_NUMBERING_CARRY_REFERRAL_EVIDENCE: 'invalid' },
      platform: {}, tool: { numberingCarryReferralEvidence: false } }))
      .toEqual({ value: false, source: 'tool' });
  });
  it('logs the setting and its source', () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    replay({ setting: { value: true, source: 'provenance-test' } });
    expect(log.mock.calls.flat().join('')).toContain('review.numberingCarryReferralEvidence=true (provenance-test)');
  });
});
