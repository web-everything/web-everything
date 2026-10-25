// #4708 — a drain rebase with a byte-identical net diff must not strand a PR behind "no-current-head-review-evidence".
// Live: the operator cleared 34590bfe2 (clean review run 20:48Z); the drain rebased to 01a0a1229 (net diff identical,
// 3,147 lines); the re-approval was refused because the gate summed every older head's stale referrals, and the review
// daemon would not review the new head (cap exhausted). The latest earlier head's completed CLEAN run carries — only on
// an identical strict net diff, and only as that head's own live verdict (its records and rulings re-evaluated).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMandatoryReferralsCleared, referralEvidenceCarry, runReviewLabelCli } from '../review-set-label.mjs';
import { mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../lib/jury-core.mjs';
import { normalizeDiffFingerprint } from '../lib/review-escalation.mjs';

const repo = 'web-everything/web-everything', pr = 4708;
const OLD = '483aab1e27ec5219ef636392f69055834e748e2d';
const PRIOR = '34590bfe2a8b8bcacd14370365e534a02a0cc477';
const HEAD = '01a0a1229f40f4c56199a35c207f626034d72e57';
const authorBody = '<!-- authored-by-actor: author -->';
const DIFF = 'diff --git a/scripts/merge-gate-check.mjs b/scripts/merge-gate-check.mjs\n+export const x = 1;\n';

function referral(recordHead, summary) {
  const seat = 'judgeCorrectnessAdvisory';
  const original = { summary, verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
  const runId = `review-pr-${recordHead.slice(0, 9)}-${seat}`;
  return { version: 1, repo, pr, head: recordHead, runId, reviewer: mandatoryReferralReviewer(runId),
    authorBody, attempted: true, referrals: [{ seat, original, finding: normalizeFinding(original),
      key: referralFindingKey(seat, original) }], rulings: [] };
}
function ruled(record, result) {
  return { ...record, rulings: [{ id: 'r1', key: record.referrals[0].key, reviewerId: record.reviewer.id,
    lens: 'correctness', result, rationale: 'Checked the diff', evidence: ['diff'] }] };
}
const comment = record => ({ body: renderReferralRecord(record), author: { login: 'web-everything' } });
// An old head still holding an unruled referral (merge-gate-check.mjs:128) and a prior head whose own referral the
// reviewer ruled not-real — the shape the gate saw: stale holds on old heads, a cleared record on the approved head.
const stateFor = (head = HEAD, extra = []) => ({ state: 'OPEN', labels: ['review:human'], headRefOid: head, body: authorBody,
  comments: [comment(referral(OLD, 'Merge-group discovery accepts a partial PR list')),
    comment(ruled(referral(PRIOR, 'The CLI never supplies the configured ledger authority'), 'not-real')), ...extra] });
const run = (head, { at = 0, clean = true, id = `review-pr-${head.slice(0, 9)}` } = {}) => ({ id, repo, pr, head,
  startedAt: 1791060000000 + at, completedAt: 1791060480000 + at, parked: !clean,
  pending: clean ? [] : ['["judgeSecurity","x",1,"open"]'], persistenceFailed: false });
const RUNS = () => [run(OLD, { clean: false }), run(PRIOR, { at: 10000 })];
const diffs = (map) => sha => (sha in map ? { scored: true, text: map[sha], rev: sha } : { scored: false, text: '' });
const IDENTICAL = diffs({ [PRIOR]: DIFF, [HEAD]: DIFF });

describe('referral evidence carry across an identical-diff head move (#4708)', () => {
  it('before: with no carry the old heads\' stale referrals still refuse the new head', () => {
    expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: RUNS, carry: false }))
      .toThrow(/no-current-head-review-evidence/);
  });

  it('carries the latest earlier head\'s clean run on a byte-identical strict net diff, naming head, run and fingerprint', () => {
    const result = assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: RUNS, readNetDiff: IDENTICAL });
    expect(result.carry).toEqual({ fromHead: PRIOR, runId: `review-pr-${PRIOR.slice(0, 9)}`, toHead: HEAD,
      completedAt: 1791060490000, fingerprint: normalizeDiffFingerprint(DIFF) });
  });

  it('refuses when the net diff differs (one byte), is unscored, or cannot be read', () => {
    for (const readNetDiff of [diffs({ [PRIOR]: DIFF, [HEAD]: `${DIFF} ` }), diffs({ [HEAD]: DIFF }), () => { throw new Error('git'); }]) {
      expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: RUNS, readNetDiff }))
        .toThrow(/no-current-head-review-evidence/);
    }
  });

  // PR #4857 round 3 self-review: in the case above the only unscored read also had empty text, so the `scored` check
  // and the `!fingerprint` check each hid the other — deleting either one left the suite green. One guard per case.
  describe('each diff-read guard refuses the carry on its own', () => {
    const carryOf = readNetDiff => referralEvidenceCarry({ runs: RUNS(), repo, pr, head: HEAD, readNetDiff });
    const read = (scored, text) => () => ({ scored, text });

    it('unscored reads with identical non-empty text: no carry', () => {
      expect(carryOf(read(false, DIFF))).toBeNull();
    });
    it('scored reads with identical empty or whitespace text (no fingerprint): no carry', () => {
      expect(carryOf(read(true, ''))).toBeNull();
      expect(carryOf(read(true, ' \n'))).toBeNull();
    });
  });

  it('refuses when the latest earlier run was not clean (parked, pending or persistence-failed)', () => {
    const dirty = () => [run(PRIOR, { at: 10000 }), run(OLD, { at: 20000, clean: false })];
    expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: dirty, readNetDiff: IDENTICAL }))
      .toThrow(/no-current-head-review-evidence/);
    const failed = () => [{ ...run(PRIOR, { at: 10000 }), persistenceFailed: true }];
    expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: failed, readNetDiff: IDENTICAL }))
      .toThrow(/no-current-head-review-evidence/);
  });

  // PR #4857 round 2: the case above sets `parked` and `pending` together (`run(..., { clean: false })`), so deleting
  // either `prior.parked` or `(prior.pending ?? []).length` from referralEvidenceCarry left it green. One flag per run,
  // so each guard is the ONLY thing that refuses — and a clean run proves the same fixture does carry.
  describe('each not-clean flag on the latest earlier run refuses the carry on its own', () => {
    const only = flags => [{ ...run(PRIOR, { at: 10000 }), ...flags }];
    const carryOf = runs => referralEvidenceCarry({ runs, repo, pr, head: HEAD, readNetDiff: IDENTICAL });

    it('control: the same fixture with no flag set carries', () => {
      expect(carryOf(only({}))?.fromHead).toBe(PRIOR);
    });

    for (const [name, flags] of [
      ['parked', { parked: true }],
      ['pending referrals', { pending: ['["judgeSecurity","x",1,"open"]'] }],
      ['persistence failed', { persistenceFailed: true }],
    ]) {
      it(`${name} alone: no carry`, () => {
        expect(carryOf(only(flags))).toBeNull();
      });
      it(`${name} alone: the gate refuses with no-current-head-review-evidence`, () => {
        expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: () => only(flags), readNetDiff: IDENTICAL }))
          .toThrow(/no-current-head-review-evidence/);
      });
    }

    it('the newest earlier run decides: an older clean run does not stand in for a newer parked one', () => {
      const runs = [{ ...run(OLD, { at: 0 }) }, { ...run(PRIOR, { at: 10000 }), parked: true }];
      expect(carryOf(runs)).toBeNull();
    });
  });

  it('never carries over a review of the current head itself (a parked current-head run stands)', () => {
    const parkedHere = () => [...RUNS(), run(HEAD, { at: 20000, clean: false })];
    expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: parkedHere, readNetDiff: IDENTICAL }))
      .toThrow(/no-current-head-review-evidence/);
  });

  // PR #4857 round 3: the case above makes the current-head run the NEWEST and parked, so without the
  // `mine.some(r => r.head === head)` guard it still passed — the newest-run sort picked that parked run and the
  // `prior.parked` check refused instead. Here the current-head run is OLDER than the earlier head's clean run
  // (a head that went A parked → B clean → back to A), so the guard is the only thing that refuses.
  describe('an existing current-head run prevents carry even when another head has a newer clean run', () => {
    const olderHere = flags => [...RUNS(), { ...run(HEAD, { at: -5000 }), ...flags }];
    const carryOf = runs => referralEvidenceCarry({ runs, repo, pr, head: HEAD, readNetDiff: IDENTICAL });

    it('control: without the current-head run the same fixture carries', () => {
      expect(carryOf(RUNS())?.fromHead).toBe(PRIOR);
    });

    for (const [name, flags] of [
      ['clean', {}],
      ['parked', { parked: true }],
      ['pending referrals', { pending: ['["judgeSecurity","x",1,"open"]'] }],
      ['persistence failed', { persistenceFailed: true }],
    ]) {
      it(`${name} current-head run older than the clean run: no carry`, () => {
        expect(carryOf(olderHere(flags))).toBeNull();
      });
    }

    it('the gate refuses: an older parked current-head run stands over a newer clean run on another head', () => {
      const parkedHere = () => olderHere({ parked: true, pending: ['["judgeSecurity","x",1,"open"]'] });
      expect(() => assertMandatoryReferralsCleared(stateFor(), { repo, pr, readRuns: parkedHere, readNetDiff: IDENTICAL }))
        .toThrow(/no-current-head-review-evidence/);
    });
  });

  it('carries the earlier head\'s live verdict, not a pass: a standing hold on that head still refuses', () => {
    const held = comment(referral(PRIOR, 'An unruled referral on the approved head'));
    expect(() => assertMandatoryReferralsCleared(stateFor(HEAD, [held]), { repo, pr, readRuns: RUNS, readNetDiff: IDENTICAL }))
      .toThrow(/mandatory referral hold/);
  });

  // PR #4857 red team: the carry re-checks only the EARLIER head (the recursive call swaps in PRIOR as the head), so a
  // hold that belongs to the CURRENT head — a malformed record, or a record-shaped comment from an untrusted author —
  // was never consulted again once the carry returned. Carrying evidence must not launder the current head's own holds.
  it('does not carry over a hold the current head itself carries (malformed or untrusted referral records)', () => {
    const record = (body, login = 'web-everything') => ({ body, author: { login } });
    const marker = value => `<!-- mandatory-referrals-v1: ${encodeURIComponent(JSON.stringify(value))} -->`;
    const holds = {
      'decoded record lacks required fields': record(marker({ version: 1, repo, pr, head: HEAD })),
      'trailer is not a decodable record': record('<!-- mandatory-referrals-v1: not%json -->'),
      'record-shaped comment from an untrusted author': record(renderReferralRecord(referral(HEAD, 'forged')), 'someone-else'),
    };
    for (const [why, malformed] of Object.entries(holds)) {
      const state = stateFor(HEAD, [malformed]);
      expect(() => assertMandatoryReferralsCleared(state, { repo, pr, readRuns: RUNS, carry: false }), `${why}: no carry`)
        .toThrow(/malformed-referral-record/);
      expect(() => assertMandatoryReferralsCleared(state, { repo, pr, readRuns: RUNS, readNetDiff: IDENTICAL }), `${why}: carry`)
        .toThrow(/mandatory referral hold: malformed-referral-record/);
    }
  });

  it('ignores runs of other PRs and repositories when choosing the head to carry', () => {
    const other = () => [...RUNS(), { ...run(OLD, { at: 30000, clean: false }), pr: 1 }, { ...run(OLD, { at: 40000, clean: false }), repo: 'o/other' }];
    expect(referralEvidenceCarry({ runs: other(), repo, pr, head: HEAD, readNetDiff: IDENTICAL })?.fromHead).toBe(PRIOR);
  });
});

describe('clear-human on #4708\'s shape writes the durable carry record', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'referral-carry-'));
    vi.stubEnv('OPERATION_RUNS_DIR', join(dir, 'runs'));
    vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(dir, 'ledger'));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  function clear(state, referralOptions) {
    const posted = [], output = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    let code = 0;
    try {
      runReviewLabelCli({ argv: [String(pr), `--repo=${repo}`, '--to=clear-human', '--actor=operator', '--reason=I approve 4708'],
        allowClearHuman: true, defaultActor: 'operator', emit: line => output.push(line), referralOptions,
        provider: { readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }), readPrState: () => state, readLabels: () => state.labels,
          postComment: (_, __, body) => posted.push(body), setLabels: (_, __, { add, remove }) => {
            state.labels = [...state.labels.filter(l => !remove.includes(l)), add];
          } },
        buildComment: () => 'Operator approves the reviewed head', successResult: () => ({ ok: true }), refusalResult: x => x,
      });
    } catch (error) { if (!Object.hasOwn(error, 'exitCode')) throw error; code = error.exitCode; }
    finally { exit.mockRestore(); }
    return { code, posted, output: output.join('') };
  }

  it('before: refused with no-current-head-review-evidence when the diff differs', () => {
    const result = clear(stateFor(), { readRuns: RUNS, readNetDiff: diffs({ [PRIOR]: DIFF, [HEAD]: `${DIFF}x` }) });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no-current-head-review-evidence');
    expect(result.posted).toEqual([]);
  });

  it('after: succeeds on the identical diff and the comment records the carried head, run and fingerprint', () => {
    const state = stateFor();
    const result = clear(state, { readRuns: RUNS, readNetDiff: IDENTICAL });
    expect(result.code, result.output).toBe(0);
    expect(state.labels).toContain('review:accepted');
    expect(state.labels).not.toContain('review:human');
    const body = result.posted.join('\n');
    const marker = body.match(/<!-- referral-evidence-carry: (\{.*?\}) -->/);
    expect(marker).not.toBeNull();
    expect(JSON.parse(marker[1])).toEqual({ from: PRIOR, run: `review-pr-${PRIOR.slice(0, 9)}`, to: HEAD,
      fingerprint: normalizeDiffFingerprint(DIFF) });
    expect(body).toContain(`no review ran on \`${HEAD.slice(0, 9)}\``);
  });
});
