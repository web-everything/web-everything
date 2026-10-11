/**
 * Card xu7kxtt (#5472, ruling P4) — replay fixtures for the accept carry-forward rule and its two consumers:
 * the restamp decision (review-set-label) and the review daemon's carry sweep. Live case: PR #4535, 2026-10-09.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  decideAcceptCarryForward, latestAcceptRecord, resolveAcceptCarryForward, ACCEPT_CARRY_FORWARD_SETTINGS_FILE,
  laterReviewHold, isKnownMachineBody,
} from '../accept-carry-forward.mjs';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment } from '../../review-set-label.mjs';
import {
  parseLatestHumanClearedSha, parseOperatorClearance, REVIEW_LABELS, decideMechanicalPark, isReviewHoldLabel, hasUnclearedReviewLabel,
} from '../review-escalation.mjs';
import {
  readDrainAcceptance, carryHumanClearanceOnIdenticalDiff, readDrainCarryEvidence, buildDrainReasonComment, MERGE_TRACE_KIND,
  buildTestGamingParkReason, buildHeldReviewHoldReason, decideTestGamingPark, readNetDiffAtHead,
} from '../../merge-ai-prs.mjs';
import { ADVISORY_NOTE_MARKER } from '../../conveyor/advisory-round-count.mjs';
import { REBASE_ONTO_MAIN_COMMENT_MARKER, MISSING_RUN_COMMENT_MARKER } from '../../conveyor/main-red-recovery.mjs';
import { HUNG_CI_COMMENT_MARKER } from '../../conveyor/ci-red-recovery-watch.mjs';
import { QUEUE_CAP_REFUSAL_MARKER } from '../../conveyor/queue-cap-refusal-count.mjs';
import { REARM_DEFERRED_MARKER } from '../../conveyor/parked-pr-conflict-watch.mjs';
import { STUCK_DISPATCH_MARKER } from '../../conveyor/stuck-pr-dispatch-marker.mjs';
import { acceptanceCoversHead, normalizeDiffFingerprint } from '../review-escalation.mjs';
import {
  planAcceptCarry, sweepAcceptCarry, _resetAcceptCarryMemo, defaultRunRestamp, defaultCloneDirFor,
  transientBackoffMs, TRANSIENT_BACKOFF_BASE_MS, TRANSIENT_BACKOFF_MAX_MS,
} from '../../conveyor/accept-carry-sweep.mjs';

const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/accept-carry-forward-4535.json'), 'utf8'));
const OTHER_FP = 'a'.repeat(64);
// Marker-anchored fixtures come from the drain's OWN exported builders, never a hand-typed look-alike (PR #4631 round 4, F1):
// `MECHANICAL_PARK_RE` anchors on this text, so a reworded drain park must redden the tests.
const PARK_REASON = buildTestGamingParkReason(['1 test removed']);
const parkBody = (reason) => buildDrainReasonComment('park', reason);
// PR #4631 (ruling a): the drain's own mechanical-park label, read from the single source (a rename reddens these tests).
const MECH_LABEL = REVIEW_LABELS.heldMechanical;
// The live #4535 re-park labels with the hold the drain now writes for that park (its own label, never review:human).
const MECH_AFTER_REPARK = fx.labelsAfterRepark.map((l) => (l === 'review:human' ? MECH_LABEL : l));
const OLD = fx.acceptedHead;
const NEW = fx.newHead;

describe('#4535 replay — merge-queue refresh fcc29ce1 → 143107a87, net diff unchanged', () => {
  const record = latestAcceptRecord(fx.comments);

  it('reads the operator clear-human record at the accepted head with its strict reviewed-diff', () => {
    expect(record).toMatchObject({ sha: OLD, diff: fx.netDiff[OLD], humanCleared: true, actor: 'chalbert', laterBodyDerivedHold: false });
  });

  it('the net diff is byte-identical on both heads (the fixture is the real measurement)', () => {
    expect(fx.netDiff[NEW]).toBe(fx.netDiff[OLD]);
  });

  it('carries the clearance to the new head, recorded with both SHAs', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(v).toMatchObject({ action: 'carry', from: OLD, to: NEW, human: true });
  });

  it('off = today: nothing carried', () => {
    expect(decideAcceptCarryForward({ setting: 'off', record, headSha: NEW, headDiff: fx.netDiff[NEW] }).action).toBe('off');
  });

  // PR #4631 (operator ruling a): the live re-park put `review:human` on #4535; the drain now parks the same case with its
  // OWN label. The live labels stay the measurement — and a `review:human` like them is never crossed.
  it('restamp crosses ONLY the drain\'s mechanical park with that proof, and drops it + the advisory labels', () => {
    const humanCarry = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    const d = decideSetLabel({ to: 'restamp', currentLabels: MECH_AFTER_REPARK, humanCarry });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe('review:accepted');
    expect(d.removeLabels).toEqual(expect.arrayContaining([MECH_LABEL, 'advisory:accepted', 'review:awaiting-advisory']));
    expect(d.removeLabels).not.toContain('review:human');
    expect(d.keepsHuman).toBe(false);
    // The live #4535 labels (a review:human hold): the same proof never lifts it.
    expect(decideSetLabel({ to: 'restamp', currentLabels: fx.labelsAfterRepark, humanCarry }).allowed).toBe(false);
  });

  it('the review daemon sweep plans #4535 and hands it to the sanctioned re-stamp once per head', () => {
    _resetAcceptCarryMemo();
    const prs = [{ number: 4535, labels: MECH_AFTER_REPARK.map((name) => ({ name })), headRefOid: NEW, comments: fx.comments }];
    expect(planAcceptCarry(prs, { setting: 'on' })).toEqual([{ num: 4535, head: NEW, from: OLD }]);
    const calls = [];
    const runRestamp = (c) => { calls.push(c); return { ok: true, detail: 'ok' }; };
    expect(sweepAcceptCarry({ prs, repo: fx.repo, setting: 'on', runRestamp })).toEqual([{ num: 4535, carry: 'carried', detail: 'ok' }]);
    expect(sweepAcceptCarry({ prs, repo: fx.repo, setting: 'on', runRestamp })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('the sweep never plans a review:human PR — the live #4535 labels, or the drain label with a person\'s hold beside it', () => {
    for (const labels of [fx.labelsAfterRepark, [...MECH_AFTER_REPARK, 'review:human']]) {
      expect(planAcceptCarry([{ number: 4535, labels, headRefOid: NEW, comments: fx.comments }], { setting: 'on' })).toEqual([]);
    }
  });
});

describe('guards — anything but a proven-identical net diff falls back to today', () => {
  const record = latestAcceptRecord(fx.comments);
  beforeEach(() => _resetAcceptCarryMemo());

  it('a changed net diff (conflict resolution, new commit) owes a review; for a human clearance it goes back to the operator', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: OTHER_FP });
    expect(v.action).toBe('review-owed');
    expect(v.reason).toMatch(/goes back to the operator/);
    const d = decideSetLabel({ to: 'restamp', currentLabels: MECH_AFTER_REPARK, humanCarry: v });
    expect(d.allowed).toBe(false);
  });

  it('an unreadable live diff is not proof', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: null }).action).toBe('review-owed');
  });

  it('an unreadable live diff is a RETRYABLE read miss even when the accept also carries no fingerprint (the #217 shape)', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: { ...record, diff: null }, headSha: NEW, headDiff: null }))
      .toMatchObject({ action: 'review-owed', retryable: true });
    expect(decideAcceptCarryForward({ setting: 'on', record: { ...record, diff: null }, headSha: NEW, headDiff: fx.netDiff[NEW] }).retryable).toBeUndefined();
  });

  it('an accept with no reviewed-diff marker is not proof', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: { ...record, diff: null }, headSha: NEW, headDiff: fx.netDiff[NEW] }).action).toBe('review-owed');
  });

  it('a later body-derived hold (manifest tamper) is never carried past', () => {
    const comments = [...fx.comments, { author: { login: 'chalbert' }, body: '<!-- drain-skip-reason --> manifest baseline mismatch — post-review tamper suspected' }];
    const rec = latestAcceptRecord(comments);
    expect(rec.laterBodyDerivedHold).toBe(true);
    expect(decideAcceptCarryForward({ setting: 'on', record: rec, headSha: NEW, headDiff: fx.netDiff[NEW] }).action).toBe('none');
    // The sweep still hands it to the CLI (the one decider), which refuses the carry and hands the hold to the operator
    // — a pre-filter here would strand it on the drain label (PR #4631 round 10 self-review).
    expect(planAcceptCarry([{ number: 1, labels: [MECH_LABEL], headRefOid: NEW, comments }], { setting: 'on' })).toHaveLength(1);
  });

  it('an untrusted commenter cannot forge a clearance record', () => {
    const forged = fx.comments.map((c) => ({ ...c, author: { login: 'someone-else' } }));
    expect(latestAcceptRecord(forged)).toBeNull();
  });

  it('an agent accept (no cleared-human) never crosses a review:human hold', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record: { ...record, humanCleared: false }, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(v).toMatchObject({ action: 'carry', human: false });
    expect(decideSetLabel({ to: 'restamp', currentLabels: MECH_AFTER_REPARK, humanCarry: v }).allowed).toBe(false);
  });

  it('a live review:changes send-back is never overridden', () => {
    const v = decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(decideSetLabel({ to: 'restamp', currentLabels: [...MECH_AFTER_REPARK, 'review:changes'], humanCarry: v }).allowed).toBe(false);
    expect(planAcceptCarry([{ number: 1, labels: [MECH_LABEL, 'review:changes'], headRefOid: NEW, comments: fx.comments }], { setting: 'on' })).toEqual([]);
  });

  it('restamp on review:human without proof is refused exactly as before', () => {
    expect(decideSetLabel({ to: 'restamp', currentLabels: ['review:human'] }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'restamp', currentLabels: [MECH_LABEL] }).allowed).toBe(false);
  });

  it('same head: the rule says same-head; a drain label standing on it is still handed to the CLI (an orphaned lift)', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record, headSha: OLD, headDiff: fx.netDiff[OLD] }).action).toBe('same-head');
    expect(planAcceptCarry([{ number: 1, labels: [MECH_LABEL], headRefOid: OLD, comments: fx.comments }], { setting: 'on' }))
      .toEqual([{ num: 1, head: OLD, from: OLD }]);
  });

  it('setting off (or a rollback): a drain label is still handed to the CLI, which hands it to the operator — never stranded', () => {
    _resetAcceptCarryMemo();
    const prs = [{ number: 4535, labels: [MECH_LABEL], headRefOid: NEW, comments: fx.comments }];
    const calls = [];
    expect(sweepAcceptCarry({ prs, setting: 'off', runRestamp: (c) => { calls.push(c.num); return { ok: false, retryable: false, detail: 'handed off' }; } }))
      .toEqual([{ num: 4535, carry: 'refused', detail: 'handed off' }]);
    expect(calls).toEqual([4535]);
  });

  it('PRs with no drain label, or with a person\'s hold or a send-back beside it, are never planned', () => {
    for (const labels of [[], ['review:pending'], ['review:accepted'], ['review:human'], [MECH_LABEL, 'review:human'], [MECH_LABEL, 'review:changes']]) {
      expect(planAcceptCarry([{ number: 1, labels, headRefOid: NEW, comments: fx.comments }], { setting: 'on' })).toEqual([]);
    }
  });
});

// PR #4631 review round 1 (F2-F4): `laterVerdict` was a rule input NO caller supplied, so a deliberate later hold that
// leaves no `reviewed-sha` marker was invisible and an identical diff cancelled it. It is now read off the thread by
// `latestAcceptRecord`, so the drain gate, the restamp and the sweep all see it from the one place.
describe('a later verdict or deliberate hold is never carried past (positive identification, every consumer)', () => {
  const BOT = { login: 'web-everything' };
  const after = (body, author = BOT) => [...fx.comments, { author, body, createdAt: '2026-10-09T15:00:00Z' }];
  // The REAL builder, never a hand-typed look-alike (PR #4631 round 4, F1): `MECHANICAL_PARK_RE` anchors on the marker and
  // heading, so a reworded drain park must redden these cases instead of silently never carrying.
  const drainPark = parkBody;
  const verdict = (comments) => decideAcceptCarryForward({ setting: 'on', record: latestAcceptRecord(comments), headSha: NEW, headDiff: fx.netDiff[NEW] });
  const planned = (comments) => planAcceptCarry([{ number: 7, labels: [MECH_LABEL], headRefOid: NEW, comments }], { setting: 'on' });

  const BLOCKING = {
    'a changes verdict (review-set-label / review-pr)': '🔁 review — changes requested\n\nRecorded by agent. A real concern.',
    'a human-review changes verdict': '🔁 human review — changes requested\n\nfix the thing',
    'a re-arm (an independent re-review is owed)': '🔧 conveyor fix — re-armed for re-review\n\nround 2',
    'a stand-down': '🛑 conveyor fix — stood down, human judgment needed\n\nreason: needs-judgment',
    'a CI-heal escalation': '🚦 conveyor CI-heal — escalated\n\nout of attempts',
    'a CI-heal void verdict': '🚦 conveyor CI-heal — verdict void\n\nthe head moved',
    'a referral hold': 'review paused: blocked referral findings',
    'an escalation-policy drain park': drainPark('review escalation: blast-radius over threshold'),
    // PR-author text inside a trusted comment must not forge the exemption (anchored match, not a substring).
    'a drain park whose reason merely MENTIONS test-gaming (path text from the PR)': drainPark('review escalation: touches scripts/test-gaming suspected—notes.test.mjs'),
    'a drain park that quotes the exempt phrase after other text': drainPark('blast radius — see also: test-gaming suspected — in the PR body'),
    'a manifest-tamper drain park': drainPark('manifest baseline mismatch — post-review tamper'),
  };

  for (const [name, body] of Object.entries(BLOCKING)) {
    it(`${name} after the clear-human blocks the carry in the rule (the sweep hands it to the CLI, which hands it off)`, () => {
      const comments = after(body);
      expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
      expect(verdict(comments).action).toBe('none');
      expect(planned(comments)).toHaveLength(1);
    });
  }

  // PR #4631 round 3: authorship cannot classify free text on this host (the drain posts under the operator's login), so
  // the rule is inverted — ANY author's comment that is not a known machine shape is a possible hold. Failing closed
  // costs a re-review (today's behaviour); an untrusted commenter can only ever force that, never lift a hold.
  it('an untrusted commenter\'s comment is a possible hold too: it can force a re-review, never lift a hold', () => {
    const comments = after(BLOCKING['a changes verdict (review-set-label / review-pr)'], { login: 'someone-else' });
    expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
    expect(verdict(comments).action).toBe('none');
  });

  // Free text from the operator's own login, in every shape a person objects in (round 3, F2): none of these is a machine
  // shape, so each supersedes the accept in the rule AND in the sweep plan. The list is deliberately not a phrase list.
  const FREE_TEXT_HOLDS = ['hold, don\'t merge', 'Hold.', 'not yet', 'NACK', 'I have concerns about the restamp path', 'wait for the security pass',
    '/hold', 'do not merge until #4700 lands', 'lgtm but let me look again', '🛑 stop', '👎'];
  for (const text of FREE_TEXT_HOLDS) {
    it(`operator free text ${JSON.stringify(text)} after the clear-human blocks the carry (rule; the CLI then hands it off)`, () => {
      const comments = after(text, { login: 'chalbert' });
      expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
      expect(verdict(comments).action).toBe('none');
      expect(planned(comments)).toHaveLength(1);
    });
  }

  // The machine shapes this very PR's thread carries after a clearance: they must NOT block, or the carry never fires.
  const MACHINE_SHAPES = {
    'fix claim': '🔒 conveyor fix-begin — fix claim held\n\n**Who:** `fix-4631`',
    'fix claim released': '🔓 conveyor fix-end — fix claim released\n\n`fix-4631` released the claim',
    'CI-heal note': '🩹 conveyor CI-heal — rebased & re-pushed\nreason: red-ci',
    'fix evidence': '🔧 conveyor fix — merge conflict with `main` resolved (merge commit `40e703fa1`)',
    'verify verdict': '✅ conveyor fix — verify GREEN for exactly `40e703fa1`',
    'restack note': '🔧 conveyor restack — PR #4631 brought up to date with its base PR',
    'conveyor note': '🔔 conveyor — needs your decision\n\nneeds your decision: a session is blocked',
    'restamp note': '📌 review — acceptance re-stamped after a mechanical head move',
    // The REAL builders / constants, not hand-typed look-alikes: a look-alike let the bold-marker mismatch through in round 3.
    'advisory note (accept, real marker)': `${ADVISORY_NOTE_MARKER}\n\n**Advisory outcome:** \`accept\``,
    'drain skip reason': buildDrainReasonComment('skip', 'required check `test` is pending'),
    'drain land reason': buildDrainReasonComment('land', 'landed'),
    'drain merge trace': buildDrainReasonComment(MERGE_TRACE_KIND, 'head abc'),
    'drain review-coverage note': buildDrainReasonComment('review-coverage', 'not examined: x'),
    'drain stacked-base-close note': buildDrainReasonComment('stacked-base-close', 'may be closed'),
    'rebase-onto-main note': `${REBASE_ONTO_MAIN_COMMENT_MARKER}\n\nmain moved`,
    'CI-hung-recovery note': `${HUNG_CI_COMMENT_MARKER}\n\nre-ran`,
    'missing-run-recovery note': `${MISSING_RUN_COMMENT_MARKER}\n\nno run`,
    'queue-cap refusal note': QUEUE_CAP_REFUSAL_MARKER,
    'rearm-withheld note': REARM_DEFERRED_MARKER,
    'stuck-PR inspection note': STUCK_DISPATCH_MARKER,
    'empty body': '',
  };
  for (const [name, body] of Object.entries(MACHINE_SHAPES)) {
    it(`a ${name} after the clear-human does not block`, () => {
      const comments = after(body);
      expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
      expect(verdict(comments).action).toBe('carry');
    });
  }

  it('machine shapes are anchored on the LEADING line: the same text further down is free text and blocks', () => {
    const comments = after(`hold on, I do not think this is right.\n\n${MACHINE_SHAPES['fix claim']}`, { login: 'chalbert' });
    expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
  });

  it('a drain PARK that is not the mechanical shape stays a verdict even though other drain reason comments are chatter', () => {
    const comments = after(buildDrainReasonComment('park', 'review escalation: blast-radius over threshold'));
    expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
  });

  it('an advisory note whose outcome is `changes` is a finding, not chatter: it blocks', () => {
    const comments = after(`${ADVISORY_NOTE_MARKER}\n\n**Advisory outcome:** \`changes\``);
    expect(latestAcceptRecord(comments).laterVerdict).toBe(true);
    expect(verdict(comments).action).toBe('none');
  });

  it('the anti-test-gaming drain park (a function of the diff) does NOT block: the #4535 shape this card exists for', () => {
    // Both the reason (`buildTestGamingParkReason`, the text the drain writes into the comment AND the ledger row) and the
    // comment (`buildDrainReasonComment`) come from the drain's own exported builders.
    const comments = after(drainPark(buildTestGamingParkReason(['1 test removed'])));
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments)).toMatchObject({ action: 'carry', human: true });
    expect(planned(comments)).toEqual([{ num: 7, head: NEW, from: OLD }]);
  });

  it('the stacked-base variant of the real test-gaming park reason is the same mechanical shape', () => {
    const comments = after(drainPark(buildTestGamingParkReason(['1 test removed'], { sharedPaths: ['a.test.mjs'] }, 4600)));
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
  });

  it('the drain restating an already-standing hold (posted after the test-gaming re-park strips ready-to-merge) does NOT block', () => {
    const comments = after(drainPark(buildHeldReviewHoldReason({ labels: ['review:human'], body: '' })));
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(planned(comments)).toEqual([{ num: 7, head: NEW, from: OLD }]);
  });

  it('neutral conveyor chatter (fix claims, CI-heal notes) does not block', () => {
    const comments = after('🔒 conveyor fix-begin — fix claim held\n\n**Who:** `fix-1`');
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments).action).toBe('carry');
  });

  it('a verdict posted BEFORE the clear-human is superseded by it and does not block', () => {
    const early = [{ author: BOT, body: '🔁 review — changes requested\n\nold round', createdAt: '2026-10-09T09:00:00Z' }];
    const comments = [fx.comments[0], ...early, ...fx.comments.slice(1)];
    expect(latestAcceptRecord(comments).laterVerdict).toBe(false);
    expect(verdict(comments).action).toBe('carry');
  });

  it('an explicit laterVerdict fact still blocks (OR with the derived one)', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: latestAcceptRecord(fx.comments), headSha: NEW, headDiff: fx.netDiff[NEW], laterVerdict: true }).action).toBe('none');
  });

  it('both later-hold facts are derived into the record the rule is handed (not left to each caller to supply)', () => {
    const rec = latestAcceptRecord(after(BLOCKING['a changes verdict (review-set-label / review-pr)']));
    expect(Object.keys(rec)).toEqual(expect.arrayContaining(['laterVerdict', 'laterBodyDerivedHold']));
  });
});

// The restamp CLI end to end against a REAL throwaway git repo (the plateau-app #217 shape: the clear-human comment has
// only `reviewed-sha`, no diff marker, so the carry proof is re-derived from git). Pins F1 (the posted comment keeps the
// `cleared-human` marker) and the caller-level half of F2-F4 (a later hold makes the restamp refuse with NO write).
describe('review-set-label --to=restamp across a review:human re-hold (CLI, real git)', () => {
  let dir = null;
  let heads = null;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).trim();
  const build = () => {
    dir = mkdtempSync(join(tmpdir(), 'acf-restamp-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'base\n'); git('add', 'f.txt'); git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'lane/x');
    writeFileSync(join(dir, 'a.txt'), 'feature\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'feature');
    const cleared = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'g.txt'), 'unrelated main work\n'); git('add', 'g.txt'); git('commit', '-q', '-m', 'main moves');
    git('checkout', '-q', 'lane/x');
    git('merge', '-q', '--no-edit', '--no-ff', 'main');
    const head = git('rev-parse', 'HEAD');
    // PR #4631 round 7: a commit with a DIFFERENT net diff that the branch does not point at (the H1 of the
    // force-push race: the PR read names it, the branch has since moved to the identical-diff head).
    git('checkout', '-q', '-b', 'other', cleared);
    writeFileSync(join(dir, 'a.txt'), 'something else entirely\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'unreviewed');
    const unreviewed = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'lane/x');
    git('remote', 'add', 'origin', dir);
    heads = { cleared, head, unreviewed };
  };
  beforeAll(build);
  afterAll(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } } });

  const BOT = { login: 'web-everything' };
  const clearComment = () => ({ author: BOT, body: `✅ review — cleared\n<!-- reviewed-sha: ${heads.cleared} -->\n<!-- cleared-human: chalbert -->` });

  // PR #4631 (operator ruling 2026-10-10 ~14:20 ET, option a): the drain's mechanical park is its OWN label. Its presence
  // is the whole proof the hold is mechanical — no ledger row, no label timeline, no event count is read.
  const MECH = REVIEW_LABELS.heldMechanical;

  /** Drives the real CLI with a recording provider; returns what was written. `liveLabels` = the hand-off's live re-read. */
  const restamp = ({ comments, labels = [MECH], liveLabels = labels, reviews = [], fullComments = null, setting = 'on', headRefOid = null }) => {
    const writes = { setLabels: [], postComment: [] };
    const reads = { reviews: 0, comments: 0 };
    const provider = {
      name: 'stub', currentRepo: () => 'o/n',
      readPrReviews: () => { reads.reviews += 1; if (reviews === null) throw new Error('gh api failed'); return reviews; },
      readComments: () => { reads.comments += 1; if (fullComments === null) throw new Error('gh api failed'); return fullComments; },
      readPrState: () => ({ labels: labels.map((name) => ({ name })), comments, headRefOid: headRefOid ?? heads.head, headRefName: 'lane/x', state: 'OPEN', isDraft: false, body: '', title: '' }),
      readLabels: () => liveLabels.map((name) => ({ name })),
      setLabels: (_r, _p, spec) => { writes.setLabels.push(spec); },
      postComment: (_r, _p, body) => { writes.postComment.push(body); },
    };
    const chunks = [];
    const realExit = process.exit.bind(process);
    const prev = { GIT_DIR: process.env.GIT_DIR, WE_ACCEPT_CARRY_FORWARD: process.env.WE_ACCEPT_CARRY_FORWARD };
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    process.env.GIT_DIR = join(dir, '.git');
    process.env.WE_ACCEPT_CARRY_FORWARD = setting;
    let exitCode = 0;
    try {
      runReviewLabelCli({
        defaultActor: 'test', usage: 'usage: test', emit: (l) => chunks.push(String(l)), provider,
        argv: ['9', '--repo=o/n', '--to=restamp', '--actor=review-daemon', '--channel=accept-carry-forward', '--reason=head moved by a mechanical pass'],
        buildComment: ({ to, actor, headSha, reason, reviewedDiff, clearerId, independence, humanClearance }) => buildVerdictComment({
          to, actor, headSha, reason, reviewedDiff, clearerId, independence, channel: 'accept-carry-forward', humanClearance,
        }),
        successResult: (o) => ({ ok: true, ...o }),
        refusalResult: ({ decision }) => ({ error: decision.reason, refused: true, ...(decision.retryable ? { retryable: true } : {}) }),
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; } finally {
      process.exit = realExit;
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return { exitCode, writes, reads, out: chunks.join('') };
  };

  it('F1: a clearance proven by re-derived git diff still stamps cleared-human on the NEW head', () => {
    const r = restamp({ comments: [clearComment()] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.postComment).toHaveLength(1);
    const body = r.writes.postComment[0];
    expect(body).toContain(`reviewed-sha: ${heads.head}`);
    expect(body).toContain('cleared-human: chalbert');
    // The next hold check binds reviewed-sha and cleared-human to one comment: it must now name the NEW head.
    expect(parseLatestHumanClearedSha([clearComment(), { author: BOT, body }])).toBe(heads.head);
    expect(parseOperatorClearance([{ author: BOT, body }])).toEqual({ actor: 'chalbert' });
  });

  const NO_WRITES = { setLabels: [], postComment: [] };
  const printedOf = (r) => JSON.parse(r.out.trim().split('\n').pop());
  // A DECIDED refusal across the drain's mechanical park hands the hold to the operator: the drain label becomes
  // `review:human` (+ awaiting-advisory), with a comment naming why — and NO acceptance (no accept label, no markers).
  const expectHandedOff = (r) => {
    expect(r.exitCode).not.toBe(0);
    // Explanation first, then awaiting-advisory, then the swap (once `review:human` stands the sweep stops planning it).
    expect(r.writes.setLabels).toEqual([{ add: 'review:awaiting-advisory', remove: [] }, { add: 'review:human', remove: [MECH] }]);
    expect(r.writes.postComment).toHaveLength(1);
    expect(r.writes.postComment[0]).toMatch(/mechanical hold handed to the operator/);
    expect(r.writes.postComment[0]).not.toMatch(/reviewed-sha|cleared-human|reviewed-diff/);
    expect(printedOf(r)).toMatchObject({ refused: true });
    expect(printedOf(r).retryable).toBeUndefined();
  };

  it('F2-F4: a deliberate changes verdict after the clear-human refuses the carry and hands the hold to the operator (no accept)', () => {
    const later = { author: BOT, body: '🔁 review — changes requested\n\nRecorded by agent. A real concern.' };
    expectHandedOff(restamp({ comments: [clearComment(), later] }));
  });

  it('F1 (plain restamp, no live hold): a diff-less clearance on a review:accepted PR still keeps cleared-human', () => {
    const r = restamp({ comments: [clearComment()], labels: ['review:accepted'] });
    expect(r.exitCode).toBe(0);
    const body = r.writes.postComment[0];
    expect(body).toContain(`reviewed-sha: ${heads.head}`);
    expect(body).toContain('cleared-human: chalbert');
    expect(parseLatestHumanClearedSha([clearComment(), { author: BOT, body }])).toBe(heads.head);
  });

  // PR #4631 round 11 (operator ruling 2026-10-10 ~19:25 ET): the PLAIN restamp's own clearance carry
  // (`decideRestampHumanClearance`, a clearance whose markers already cover the head) read no formal review at all, so it
  // re-dated the `cleared-human` record past a standing CHANGES_REQUESTED review — after which the carry rule saw that
  // review as "before the accept". Every carry of a clearance now checks the latest formal review state first.
  const coveringClear = () => ({ author: BOT, createdAt: '2026-10-09T12:00:00Z',
    body: `✅ review — cleared\n<!-- reviewed-sha: ${heads.head} -->\n<!-- reviewed-diff: ${'d'.repeat(64)} -->\n<!-- cleared-human: chalbert -->` });
  const botChanges = (submitted_at = '2026-10-09T13:00:00Z') => ({ state: 'CHANGES_REQUESTED', submitted_at, user: { login: 'plateau-reviewer[bot]' } });
  it('ROUND 11: a plain restamp refuses to carry a clearance past a standing CHANGES_REQUESTED review (bot or operator): NO write', () => {
    for (const login of ['plateau-reviewer[bot]', 'chalbert']) {
      const r = restamp({ comments: [coveringClear()], labels: ['review:accepted'], reviews: [{ ...botChanges(), user: { login } }] });
      expect(r.exitCode).not.toBe(0);
      expect(r.writes).toEqual(NO_WRITES);
      expect(printedOf(r)).toMatchObject({ refused: true });
      expect(printedOf(r).retryable).toBeUndefined();
      expect(printedOf(r).error).toMatch(/formal GitHub changes-requested review stands/i);
    }
  });
  it('ROUND 11: the review submitted BEFORE the clearance still refuses while it is that reviewer\'s latest decisive state', () => {
    const r = restamp({ comments: [coveringClear()], labels: ['review:accepted'], reviews: [botChanges('2026-10-09T11:00:00Z')] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });
  it('ROUND 11: unreadable reviews refuse the plain clearance carry as a retryable miss (nothing written)', () => {
    const r = restamp({ comments: [coveringClear()], labels: ['review:accepted'], reviews: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(printedOf(r)).toMatchObject({ refused: true, retryable: true });
  });
  it('ROUND 11: with no standing review (or one the reviewer later approved) the plain restamp still carries cleared-human', () => {
    for (const reviews of [[], [botChanges('2026-10-09T11:00:00Z'), { state: 'APPROVED', submitted_at: '2026-10-09T11:30:00Z', user: { login: 'plateau-reviewer[bot]' } }]]) {
      const r = restamp({ comments: [coveringClear()], labels: ['review:accepted'], reviews });
      expect(r.exitCode).toBe(0);
      expect(r.reads.reviews).toBe(1);
      expect(r.writes.postComment[0]).toContain('cleared-human: chalbert');
    }
  });

  it('F2-F4: a later escalation-policy drain park refuses the carry and hands the hold to the operator (no accept)', () => {
    const later = { author: BOT, body: parkBody('review escalation: blast-radius over threshold') };
    expectHandedOff(restamp({ comments: [clearComment(), later] }));
  });

  // Operator ruling 2026-10-10 ~14:20 ET (option a): `review:human` always means a person set the hold and is NEVER
  // removed automatically, whatever the evidence beside it (a drain park comment, an identical diff, a clean thread).
  it('RULING (a): a review:human hold is never lifted by a restamp, even with the full #4535 mechanical evidence: NO write', () => {
    const later = { author: BOT, body: parkBody(PARK_REASON) };
    const r = restamp({ comments: [clearComment(), later], labels: ['review:human'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(r.out).toMatch(/review:human is uncleared — a person set it/);
  });

  it('the #4535 shape: the drain\'s mechanical park + its test-gaming park comment after the clear-human — the carry lifts ONLY the drain label', () => {
    const later = { author: BOT, body: parkBody(PARK_REASON) };
    const r = restamp({ comments: [clearComment(), later] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.postComment[0]).toContain('cleared-human: chalbert');
    expect(r.writes.setLabels).toEqual([{ add: 'review:accepted', remove: [MECH] }]);
  });

  // The two holes the round-9 stand-down named, now closed by construction (no history is read to attribute a hold):
  it('CONCURRENT: an operator review:human added while the drain parked (both labels stand) is never lifted: NO write', () => {
    const later = { author: BOT, body: parkBody(PARK_REASON) };
    const r = restamp({ comments: [clearComment(), later], labels: [MECH, 'review:human'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('REMOVE + RE-ADD: the operator swapped the drain label for their own review:human after the park: NO write', () => {
    const later = { author: BOT, body: parkBody(PARK_REASON) };
    const r = restamp({ comments: [clearComment(), later], labels: ['review:human'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('a held-park restatement beside a review:human hold changes nothing: NO write', () => {
    const held = { author: BOT, body: parkBody(buildHeldReviewHoldReason({ labels: ['review:human'], body: '' })) };
    const r = restamp({ comments: [clearComment(), held], labels: ['review:human'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('a review:changes beside the drain label is never crossed: NO write', () => {
    const r = restamp({ comments: [clearComment()], labels: [MECH, 'review:changes'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('setting off (or rolled back): a drain label is handed to the operator, never stranded (no accept)', () => {
    expectHandedOff(restamp({ comments: [clearComment(), { author: BOT, body: parkBody(PARK_REASON) }], setting: 'off' }));
  });

  // Crash between writes: a lift posts its record (cleared-human naming the LIVE head) and then its label swap fails.
  const clearedAtLive = () => ({ author: BOT, body: `📌 review — acceptance re-stamped after a rebase (no new review)\n<!-- reviewed-sha: ${heads.head} -->\n<!-- cleared-human: chalbert -->` });
  it('ORPHANED LIFT: a clearance already naming the live head under the drain label is lifted (not handed off, not skipped)', () => {
    const r = restamp({ comments: [clearComment(), { author: BOT, body: parkBody(PARK_REASON) }, clearedAtLive()] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.setLabels).toEqual([{ add: 'review:accepted', remove: [MECH] }]);
    expect(r.writes.postComment[0]).toContain('cleared-human: chalbert');
  });

  it('ORPHANED LIFT with a later objection is handed off; with unreadable reviews it is a RETRYABLE miss', () => {
    expectHandedOff(restamp({ comments: [clearComment(), clearedAtLive(), { author: { login: 'chalbert' }, body: 'hold' }] }));
    const r = restamp({ comments: [clearComment(), clearedAtLive()], reviews: null });
    expect(r.writes).toEqual(NO_WRITES);
    expect(printedOf(r)).toMatchObject({ refused: true, retryable: true });
  });

  it('a clear-human past comment 100 is read in full across the drain label even when page 1\'s latest record is not human', () => {
    const agentAccept = { author: BOT, body: `✅ review — accepted\n<!-- reviewed-sha: ${heads.cleared} -->` };
    const page = [agentAccept, ...filler(99)];
    const r = restamp({ comments: page, fullComments: [...page, clearComment()] });
    expect(r.reads.comments).toBe(1);
    expect(r.exitCode).toBe(0);
    expect(r.writes.setLabels).toEqual([{ add: 'review:accepted', remove: [MECH] }]);
  });

  it('hand-off re-reads live labels: a review:human that appeared since the run read the PR is left alone (no label write)', () => {
    const later = { author: BOT, body: '🔁 review — changes requested\n\nRecorded by agent.' };
    const r = restamp({ comments: [clearComment(), later], liveLabels: [MECH, 'review:human'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  // PR #4631 round 3 (F2, security): a formal GitHub review is not in `gh pr view --json comments`; it is read through its
  // own paginated call and an unreadable one is a RETRYABLE miss, never "no review stands".
  const review = (state, submitted_at = '2026-10-09T16:00:00Z') => ({ state, submitted_at, user: { login: 'rev' } });
  it('a formal CHANGES_REQUESTED review after the clear-human refuses the carry (the hold goes to the operator, no accept)', () => {
    expectHandedOff(restamp({ comments: [clearComment()], reviews: [review('CHANGES_REQUESTED')] }));
  });

  it('a review that only COMMENTS after the clear-human is a possible objection too (no accept)', () => {
    expectHandedOff(restamp({ comments: [clearComment()], reviews: [review('COMMENTED')] }));
  });

  it('an APPROVED or DISMISSED review does not block, and neither does an empty review list', () => {
    for (const reviews of [[], [review('APPROVED')], [review('DISMISSED')]]) {
      const r = restamp({ comments: [clearComment()], reviews });
      expect(r.exitCode).toBe(0);
      expect(r.writes.setLabels[0].add).toBe('review:accepted');
    }
  });

  it('unreadable formal reviews refuse as a RETRYABLE read miss, with NO write', () => {
    const r = restamp({ comments: [clearComment()], reviews: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(JSON.parse(r.out.trim().split('\n').pop())).toMatchObject({ refused: true, retryable: true });
  });

  // Truncated-read row: `gh pr view --json comments` stops at one page (100). A full page is re-read through the paginated
  // comments call; a hold past comment 100 must be seen, and a failed re-read is a retryable miss, never "no hold".
  const filler = (n) => Array.from({ length: n }, (_, i) => ({ author: BOT, body: `🔒 conveyor fix-begin — fix claim held #${i}` }));
  it('a full 100-comment page is re-read in full: a hold past comment 100 refuses the carry (no accept)', () => {
    const page = [clearComment(), ...filler(99)];
    const r = restamp({ comments: page, fullComments: [...page, { author: { login: 'chalbert' }, body: 'hold, don\'t merge' }] });
    expect(r.reads.comments).toBe(1);
    expectHandedOff(r);
  });

  it('a full page whose complete thread has nothing standing against the clearance still carries', () => {
    const page = [clearComment(), ...filler(99)];
    const r = restamp({ comments: page, fullComments: [...page, ...filler(5)] });
    expect(r.exitCode).toBe(0);
    expect(r.writes.setLabels[0].add).toBe('review:accepted');
  });

  it('a failed complete-thread re-read is a RETRYABLE miss, with NO write', () => {
    const r = restamp({ comments: [clearComment(), ...filler(99)], fullComments: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(JSON.parse(r.out.trim().split('\n').pop())).toMatchObject({ refused: true, retryable: true });
  });

  it('a short thread is not re-read (no extra gh hop)', () => {
    const r = restamp({ comments: [clearComment()] });
    expect(r.reads).toEqual({ reviews: 1, comments: 0 });
  });

  // Plain (no live hold) restamp of a review:accepted PR: an unreadable review list must not mint the accept WITHOUT its
  // `cleared-human` marker (that would drop the operator's clearance for good on a mere read miss).
  it('plain restamp: unreadable reviews refuse as RETRYABLE instead of minting an accept without the clearance marker', () => {
    const r = restamp({ comments: [clearComment()], labels: ['review:accepted'], reviews: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
    expect(JSON.parse(r.out.trim().split('\n').pop())).toMatchObject({ refused: true, retryable: true });
  });

  // PR #4631 round 11 (operator ruling 2026-10-10 ~19:25 ET): every restamp is a carry, so every restamp reads the formal
  // reviews once (it replaces the earlier "a plain accept pays no extra gh call" pin). The full-thread read stays reserved
  // to a human-cleared carry on a short thread.
  it('every restamp reads the formal reviews exactly once; the full thread only for a human carry', () => {
    const agent = { author: BOT, body: `✅ review — accepted\n<!-- reviewed-sha: ${heads.cleared} -->` };
    expect(restamp({ comments: [agent], labels: ['review:accepted'] }).reads).toEqual({ reviews: 1, comments: 0 });
    expect(restamp({ comments: [clearComment()], labels: ['review:accepted'], setting: 'off' }).reads).toEqual({ reviews: 1, comments: 0 });
  });
  it('ROUND 11: a restamp of a plain AGENT accept refuses past a standing CHANGES_REQUESTED review (any setting): NO write', () => {
    const agent = { author: BOT, body: `✅ review — accepted\n<!-- reviewed-sha: ${heads.cleared} -->` };
    for (const setting of ['on', 'off']) {
      const r = restamp({ comments: [agent], labels: ['review:accepted'], setting, reviews: [{ state: 'CHANGES_REQUESTED', submitted_at: '2020-01-01T00:00:00Z', user: { login: 'plateau-reviewer[bot]' } }] });
      expect(r.exitCode).not.toBe(0);
      expect(r.writes).toEqual(NO_WRITES);
      expect(printedOf(r).error).toMatch(/the accept is not carried/);
      expect(printedOf(r).retryable).toBeUndefined();
    }
    const unread = restamp({ comments: [agent], labels: ['review:accepted'], reviews: null });
    expect(unread.writes).toEqual(NO_WRITES);
    expect(printedOf(unread)).toMatchObject({ refused: true, retryable: true });
  });

  it('operator free text "hold, don\'t merge" after the clear-human refuses the carry (no accept)', () => {
    expectHandedOff(restamp({ comments: [clearComment(), { author: { login: 'chalbert' }, body: 'hold, don\'t merge' }] }));
  });

  it('a content refusal (changed diff) is a settled decision, NOT retryable: the hold goes to the operator', () => {
    expectHandedOff(restamp({ comments: [{ ...clearComment(), body: `${clearComment().body}\n<!-- reviewed-diff: ${OTHER_FP} -->` }] }));
  });

  it('a failed hand-off write is RETRYABLE (the sweep comes back), never a settled refusal', () => {
    const r = restamp({ comments: [{ ...clearComment(), body: `${clearComment().body}\n<!-- reviewed-diff: ${OTHER_FP} -->` }], liveLabels: null });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes.setLabels).toEqual([]);
    expect(printedOf(r)).toMatchObject({ refused: true, retryable: true });
  });

  // PR #4631 round 7 (toctou-head-binding). The PR read names head H1 (a different diff); the branch, fetched later,
  // points at the identical-diff head. The proof must be read AT H1, the commit the restamp stamps, never at the branch.
  it('the head the PR read names is the head whose diff is proven: a branch now at an identical-diff head proves nothing for it (no accept)', () => {
    const r = restamp({ comments: [clearComment()], headRefOid: heads.unreviewed });
    expectHandedOff(r);
    expect(r.writes.setLabels.map((s) => s.add)).not.toContain('review:accepted');
  });

  it('a head whose commit is not in the clone after the fetch is unproven (never the branch\'s diff instead), NO write', () => {
    const r = restamp({ comments: [clearComment()], headRefOid: 'f'.repeat(40) });
    expect(r.exitCode).not.toBe(0);
    expect(r.writes).toEqual(NO_WRITES);
  });

  it('plain restamp (no live hold): the cleared-human marker is never minted onto a head whose own diff was not read', () => {
    const r = restamp({ comments: [clearComment()], labels: ['review:accepted'], headRefOid: heads.unreviewed });
    for (const body of r.writes.postComment) expect(body).not.toContain('cleared-human');
  });

  // The shared SHA-bound read every proof site uses (review-set-label, the drain carry, readDrainAcceptance), real git.
  describe('readNetDiffAtHead — the diff is the named commit\'s own, never the branch\'s', () => {
    const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir, env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    it('reads at the SHA and binds `rev` to it', () => {
      const net = readNetDiffAtHead({ exec, headSha: heads.head, headRef: 'lane/x' });
      expect(net).toMatchObject({ scored: true, rev: heads.head });
      expect(net.text).toContain('+feature');
    });
    it('a SHA the branch does not point at yields THAT commit\'s diff, not the branch tip\'s', () => {
      const net = readNetDiffAtHead({ exec, headSha: heads.unreviewed, headRef: 'lane/x' });
      expect(net).toMatchObject({ scored: true, rev: heads.unreviewed });
      expect(net.text).toContain('+something else entirely');
    });
    it('an absent commit, a branch name in place of a SHA, or a read bound elsewhere is unscored', () => {
      expect(readNetDiffAtHead({ exec, headSha: 'f'.repeat(40), headRef: 'lane/x' }).scored).toBe(false);
      expect(readNetDiffAtHead({ exec, headSha: 'lane/x', headRef: 'lane/x' })).toMatchObject({ scored: false, reason: 'head-unbound' });
      expect(readNetDiffAtHead({ exec, headSha: heads.head, netDiff: () => ({ scored: true, text: 'x', rev: 'origin/lane/x' }) }))
        .toMatchObject({ scored: false, reason: 'head-mismatch' });
      expect(readNetDiffAtHead({ exec, headSha: heads.head, netDiff: () => { throw new Error('git'); } }))
        .toMatchObject({ scored: false, reason: 'diff-failed' });
    });
  });
});

// PR #4631 (operator ruling 2026-10-10 ~14:20 ET, option a): the drain's test-gaming park picks its LABEL; the label is
// the proof. A decided refusal (or no clearance at all) parks `review:human`; only a read miss parks the drain's own label.
describe('decideTestGamingPark — the drain\'s mechanical park uses its OWN label, never review:human (pure)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const park = (o = {}) => decideTestGamingPark({ setting: 'on', currentLabels: ['review:accepted'], humanClearedSha: A, headSha: B, carryRetryable: true, ...o });

  it('an operator clearance on an older head whose carry could not be read: review:held-mechanical, never review:human', () => {
    const d = park();
    expect(d.addLabel).toBe(MECH_LABEL);
    expect(d.removeLabels).not.toContain('review:human');
    expect(d.removeLabels).toContain('review:accepted');
    expect(d).toEqual(decideMechanicalPark({ currentLabels: ['review:accepted'] }));
  });
  it('a DECIDED refusal (diff changed / later verdict), no clearance, the same head, a fetch miss, or the setting off: review:human', () => {
    for (const o of [{ carryRetryable: false }, { humanClearedSha: null }, { headSha: null }, { headSha: A }, { setting: 'off' }]) {
      expect(park(o).addLabel).toBe('review:human');
    }
  });
  it('a drain label already standing stays the drain\'s on a re-listed PR (never converted to review:human by the drain)', () => {
    expect(park({ currentLabels: [MECH_LABEL], humanClearedSha: null, carryRetryable: false }).addLabel).toBe(MECH_LABEL);
    // …unless a person's hold already stands beside it (then the ordinary park, which never removes it).
    expect(park({ currentLabels: [MECH_LABEL, 'review:human'], humanClearedSha: null, carryRetryable: false }).addLabel).toBe('review:human');
  });
  it('the mechanical label is a hold like any other (never mergeable, refused next to an accept, CI review-gate)', () => {
    expect(isReviewHoldLabel(MECH_LABEL)).toBe(true);
    expect(hasUnclearedReviewLabel([MECH_LABEL])).toBe(true);
    expect(hasUnclearedReviewLabel([MECH_LABEL, 'review:accepted'])).toBe(true);
    expect(hasUnclearedReviewLabel([MECH_LABEL], { allowPending: true })).toBe(true);
  });
  it('only the operator (clear-human) or a proven carry (restamp) lifts it — an agent accept never does', () => {
    expect(decideSetLabel({ to: 'accepted', currentLabels: [MECH_LABEL] }).allowed).toBe(false);
    const cleared = decideSetLabel({ to: 'clear-human', currentLabels: [MECH_LABEL] });
    expect(cleared.allowed).toBe(true);
    expect(cleared.removeLabels).toContain(MECH_LABEL);
    const carry = { action: 'carry', human: true, from: A, to: B, reason: 'identical' };
    expect(decideSetLabel({ to: 'restamp', currentLabels: [MECH_LABEL], humanCarry: carry })).toMatchObject({ allowed: true, addLabel: 'review:accepted' });
    // review:human is never crossed, with or without the drain label beside it.
    expect(decideSetLabel({ to: 'restamp', currentLabels: ['review:human'], humanCarry: carry }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'restamp', currentLabels: [MECH_LABEL, 'review:human'], humanCarry: carry }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'restamp', currentLabels: [MECH_LABEL], humanCarry: { ...carry, action: 'review-owed' } }).allowed).toBe(false);
  });
});


// PR #4631 round 3 (F2): the thread reader's two new channels, pure.
describe('later hold channels — free text and formal reviews (pure)', () => {
  const rec = (reviews) => latestAcceptRecord(fx.comments, reviews);
  const at = rec().at;
  const rv = (state, submitted_at) => ({ state, submitted_at });
  it('the fixture clearance has a time to order reviews against', () => { expect(at).toBe('2026-10-09T13:58:47Z'); });
  it('CHANGES_REQUESTED / COMMENTED / PENDING after the accept stand against it; APPROVED / DISMISSED do not', () => {
    for (const state of ['CHANGES_REQUESTED', 'COMMENTED', 'changes_requested']) expect(laterReviewHold([rv(state, '2026-10-09T15:00:00Z')], at)).toBe(true);
    // PENDING is an unsubmitted draft (visible only to its author): nobody has objected yet.
    for (const state of ['APPROVED', 'DISMISSED', 'PENDING']) expect(laterReviewHold([rv(state, '2026-10-09T15:00:00Z')], at)).toBe(false);
  });
  it('a missing / unparseable time or accept time fails closed', () => {
    expect(laterReviewHold([rv('CHANGES_REQUESTED', undefined)], at)).toBe(true);
    expect(laterReviewHold([rv('CHANGES_REQUESTED', 'nope')], at)).toBe(true);
    expect(laterReviewHold([rv('CHANGES_REQUESTED', '2026-10-09T09:00:00Z')], null)).toBe(true);
  });
  // PR #4631 round 11 (operator ruling 2026-10-10 ~19:25 ET): the LATEST formal review state decides, not only reviews
  // timed after the accept. A restamp re-dates the accept record without being a review, so a CHANGES_REQUESTED review
  // that lands between the clearance and a restamp would otherwise read as "before the accept" and be laundered.
  const rvBy = (login, state, submitted_at) => ({ state, submitted_at, user: { login } });
  it('a reviewer\'s CHANGES_REQUESTED submitted BEFORE the accept still stands while it is that reviewer\'s latest decisive state', () => {
    expect(laterReviewHold([rvBy('plateau-reviewer[bot]', 'CHANGES_REQUESTED', '2026-10-09T09:00:00Z')], at)).toBe(true);
    expect(laterReviewHold([rvBy('chalbert', 'CHANGES_REQUESTED', '2026-10-09T09:00:00Z')], at)).toBe(true);
    // A login-less review is its own reviewer: nothing can supersede it.
    expect(laterReviewHold([rv('CHANGES_REQUESTED', '2026-10-09T09:00:00Z')], at)).toBe(true);
    // A COMMENTED review is not decisive: it never supersedes a standing CHANGES_REQUESTED.
    expect(laterReviewHold([
      rvBy('plateau-reviewer[bot]', 'CHANGES_REQUESTED', '2026-10-09T08:00:00Z'), rvBy('plateau-reviewer[bot]', 'COMMENTED', '2026-10-09T09:00:00Z'),
    ], at)).toBe(true);
  });
  it('an earlier CHANGES_REQUESTED the same reviewer later APPROVED, or that was DISMISSED, no longer stands', () => {
    expect(laterReviewHold([
      rvBy('plateau-reviewer[bot]', 'CHANGES_REQUESTED', '2026-10-09T08:00:00Z'), rvBy('plateau-reviewer[bot]', 'APPROVED', '2026-10-09T09:00:00Z'),
    ], at)).toBe(false);
    expect(laterReviewHold([rvBy('plateau-reviewer[bot]', 'DISMISSED', '2026-10-09T09:00:00Z')], at)).toBe(false);
    // Another reviewer's approval does not lift it.
    expect(laterReviewHold([
      rvBy('plateau-reviewer[bot]', 'CHANGES_REQUESTED', '2026-10-09T08:00:00Z'), rvBy('chalbert', 'APPROVED', '2026-10-09T09:00:00Z'),
    ], at)).toBe(true);
    // A COMMENTED review before the accept is superseded by it (it decides nothing).
    expect(laterReviewHold([rvBy('plateau-reviewer[bot]', 'COMMENTED', '2026-10-09T09:00:00Z')], at)).toBe(false);
  });
  it('a review in the SAME second as the accept counts (GitHub times are whole seconds)', () => {
    expect(laterReviewHold([rvBy('x', 'COMMENTED', at)], at)).toBe(true);
  });
  it('a restamp between the CHANGES_REQUESTED and the carry does not launder it', () => {
    const restampComment = { author: { login: 'chalbert' }, createdAt: '2026-10-09T16:00:00Z',
      body: ['📌 review — acceptance re-stamped after a rebase (no new review)', `<!-- reviewed-sha: ${NEW} -->`,
        `<!-- reviewed-diff: ${fx.netDiff[NEW]} -->`, '<!-- cleared-human: chalbert -->'].join('\n') };
    const record = latestAcceptRecord([...fx.comments, restampComment], [rvBy('plateau-reviewer[bot]', 'CHANGES_REQUESTED', '2026-10-09T15:00:00Z')]);
    expect(record.at).toBe('2026-10-09T16:00:00Z');
    expect(record.laterVerdict).toBe(true);
    expect(decideAcceptCarryForward({ setting: 'on', record, headSha: 'f'.repeat(40), headDiff: fx.netDiff[NEW] }).action).toBe('none');
  });
  it('the camelCase `submittedAt` shape (gh pr view --json reviews) is read too', () => {
    expect(laterReviewHold([{ state: 'CHANGES_REQUESTED', submittedAt: '2026-10-09T15:00:00Z' }], at)).toBe(true);
  });
  it('the record carries the review fact into the rule: a standing review blocks, none carries, undefined = no channel', () => {
    const decide = (record) => decideAcceptCarryForward({ setting: 'on', record, headSha: NEW, headDiff: fx.netDiff[NEW] });
    expect(decide(rec([rv('CHANGES_REQUESTED', '2026-10-09T15:00:00Z')])).action).toBe('none');
    expect(decide(rec([])).action).toBe('carry');
    expect(decide(rec(undefined)).action).toBe('carry');
  });
  it('unreadable reviews (null) are a RETRYABLE refusal, not "no review stands against it"', () => {
    expect(decideAcceptCarryForward({ setting: 'on', record: rec(null), headSha: NEW, headDiff: fx.netDiff[NEW] })).toMatchObject({ action: 'review-owed', retryable: true });
  });
  it('isKnownMachineBody: verdicts / re-arms / non-mechanical parks are never machine shapes', () => {
    for (const b of ['🔁 review — changes requested', '🔧 conveyor fix — re-armed for re-review', '🛑 conveyor fix — stood down', 'review paused: x',
      parkBody('review escalation: x'), 'hello']) expect(isKnownMachineBody(b)).toBe(false);
    expect(isKnownMachineBody(undefined)).toBe(true);
    expect(isKnownMachineBody('  \n ')).toBe(true);
  });
});

// PR #4631 round 3 (F1/F3, test-coverage): the drain's anti-test-gaming carry used to be inline in `runCli`, so no test
// reddened if a clause of it was deleted. It is now `carryHumanClearanceOnIdenticalDiff`; ONE test per clause, each of
// which goes red if that clause is removed (the #4535 shape is the positive control).
describe('carryHumanClearanceOnIdenticalDiff — the drain\'s anti-test-gaming carry step', () => {
  const TEXT = 'diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+feature\n';
  const FP = normalizeDiffFingerprint(TEXT);
  const BOT = { login: 'web-everything' };
  const clear = (over = '') => ({ author: BOT, createdAt: '2026-10-09T13:58:47Z',
    body: `✅ review — cleared\n<!-- reviewed-sha: ${OLD} -->\n<!-- reviewed-diff: ${FP} -->${over}\n<!-- cleared-human: chalbert -->` });
  const agentAccept = () => ({ author: BOT, createdAt: '2026-10-09T13:58:47Z', body: `✅ review — accepted\n<!-- reviewed-sha: ${OLD} -->\n<!-- reviewed-diff: ${FP} -->` });
  const base = () => ({ setting: 'on', comments: [clear()], reviews: [], humanClearedSha: OLD, headSha: NEW, pinnedHeadSha: NEW, netDiffText: { scored: true, text: TEXT, rev: NEW } });
  const run = (over = {}) => carryHumanClearanceOnIdenticalDiff({ ...base(), ...over });

  it('the fixture\'s own fingerprint is what the live text fingerprints to (the positive control is real)', () => {
    expect(FP).toMatch(/^[0-9a-f]{64}$/);
  });
  it('#4535 shape: a human clearance at the old head + a byte-identical net diff rebinds the clearance to the live head', () => {
    expect(run()).toMatchObject({ carried: true, humanClearedSha: NEW });
  });
  it('clause `carry.human`: an AGENT accept never carries a human clearance (the gate keeps re-parking)', () => {
    expect(run({ comments: [agentAccept()] })).toMatchObject({ carried: false, humanClearedSha: OLD });
  });
  it('clause `carry.from === humanClearedSha`: a record naming a different head than the parsed clearance does not carry', () => {
    expect(run({ humanClearedSha: 'b'.repeat(40) })).toMatchObject({ carried: false, humanClearedSha: 'b'.repeat(40) });
  });
  it('clause setting: off = today, nothing carried', () => {
    expect(run({ setting: 'off' })).toMatchObject({ carried: false, humanClearedSha: OLD });
  });
  it('clause scored: an unscored or empty net diff is never fingerprinted (an empty text would fingerprint to something)', () => {
    expect(run({ netDiffText: { scored: false, text: TEXT } })).toMatchObject({ carried: false, humanClearedSha: OLD });
    expect(run({ netDiffText: { scored: true, text: '' } })).toMatchObject({ carried: false, humanClearedSha: OLD });
    expect(run({ netDiffText: null })).toMatchObject({ carried: false, humanClearedSha: OLD });
  });
  it('a changed net diff is not carried', () => {
    expect(run({ netDiffText: { scored: true, text: `${TEXT}+one more line\n`, rev: NEW } })).toMatchObject({ carried: false, humanClearedSha: OLD });
  });
  // PR #4631 (ruling a): `retryable` picks the park label — a READ miss parks the drain's own review:held-mechanical (the
  // sweep retries), a DECIDED refusal parks review:human (a review of the change is owed).
  it('retryable: a read miss (unscored diff, mis-bound diff, moved head, unreadable reviews) vs a decision (changed diff, agent accept)', () => {
    for (const o of [{ netDiffText: { scored: false, text: TEXT } }, { netDiffText: { scored: true, text: TEXT, rev: 'b'.repeat(40) } },
      { pinnedHeadSha: 'c'.repeat(40) }, { reviews: null }]) {
      expect(run(o)).toMatchObject({ carried: false, retryable: true });
    }
    for (const o of [{ netDiffText: { scored: true, text: `${TEXT}+one more line\n`, rev: NEW } }, { comments: [agentAccept()] }]) {
      expect(run(o)).toMatchObject({ carried: false, retryable: false });
    }
    expect(run()).toMatchObject({ carried: true, retryable: false });
  });
  // PR #4631 round 7 (toctou-head-binding): the batch diff was read at the branch NAME; a push between that read and the
  // live head read leaves an identical text that belongs to ANOTHER commit. Only a diff read at the live SHA proves it.
  it('clause `netDiffText.rev === headSha`: an identical diff read at the branch name or at another commit does not carry', () => {
    expect(run({ netDiffText: { scored: true, text: TEXT, rev: 'origin/lane/x' } })).toMatchObject({ carried: false, humanClearedSha: OLD });
    expect(run({ netDiffText: { scored: true, text: TEXT, rev: 'b'.repeat(40) } })).toMatchObject({ carried: false, humanClearedSha: OLD });
    expect(run({ netDiffText: { scored: true, text: TEXT } })).toMatchObject({ carried: false, humanClearedSha: OLD });
  });
  it('clause `pinnedHeadSha === headSha`: a live head other than the one this pass merges (pinned) does not carry', () => {
    expect(run({ pinnedHeadSha: 'c'.repeat(40) })).toMatchObject({ carried: false, humanClearedSha: OLD });
    expect(run({ pinnedHeadSha: null })).toMatchObject({ carried: false, humanClearedSha: OLD });
  });
  // The drain's call site hands `readHeadDiff` (readNetDiffAtHead in the PR's clone), never the batch text.
  it('readHeadDiff: read at exactly the live head, only once a carry is otherwise possible; its result is what is proven', () => {
    const calls = [];
    const reader = (text, rev = undefined) => (sha) => { calls.push(sha); return { scored: true, text, rev: rev ?? sha }; };
    expect(run({ netDiffText: null, readHeadDiff: reader(TEXT) })).toMatchObject({ carried: true, humanClearedSha: NEW });
    expect(calls).toEqual([NEW]);
    expect(run({ netDiffText: { scored: true, text: TEXT, rev: NEW }, readHeadDiff: reader(`${TEXT}+changed\n`) }).carried).toBe(false);
    expect(run({ netDiffText: null, readHeadDiff: reader(TEXT, 'origin/lane/x') }).carried).toBe(false);
    expect(run({ netDiffText: null, readHeadDiff: () => { throw new Error('git'); } }).carried).toBe(false);
    expect(run({ netDiffText: null, readHeadDiff: () => null }).carried).toBe(false);
    calls.length = 0;
    run({ pinnedHeadSha: 'c'.repeat(40), readHeadDiff: reader(TEXT) });
    run({ humanClearedSha: NEW, readHeadDiff: reader(TEXT) });
    expect(calls).toEqual([]);
  });
  it('nothing to carry: no clearance, no head, or the clearance already names the head', () => {
    expect(run({ humanClearedSha: null }).carried).toBe(false);
    expect(run({ headSha: null }).carried).toBe(false);
    expect(run({ humanClearedSha: NEW })).toMatchObject({ carried: false, humanClearedSha: NEW });
  });
  it('a later verdict, free-text hold, or standing formal review after the clearance each stop the carry', () => {
    expect(run({ comments: [clear(), { author: BOT, body: '🔁 review — changes requested\n\nx' }] }).carried).toBe(false);
    expect(run({ comments: [clear(), { author: { login: 'chalbert' }, body: 'hold, don\'t merge' }] }).carried).toBe(false);
    expect(run({ reviews: [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-10-09T15:00:00Z' }] }).carried).toBe(false);
  });
  it('unreadable reviews (null) or no review list at all fail closed to the re-park', () => {
    expect(run({ reviews: null }).carried).toBe(false);
    expect(run({ reviews: undefined }).carried).toBe(false);
  });

  // The call site's wiring (`readDrainCarryEvidence`): what runCli hands the carry. A regression that stopped passing
  // `reviews` would fail closed forever, so the evidence function is pinned directly.
  it('readDrainCarryEvidence: a short thread keeps its page and reads only the reviews', () => {
    const calls = [];
    const ev = readDrainCarryEvidence({ comments: [clear()], readComments: () => { calls.push('c'); return []; }, readReviews: () => { calls.push('r'); return [{ state: 'APPROVED' }]; } });
    expect(calls).toEqual(['r']);
    expect(ev.comments).toHaveLength(1);
    expect(ev.reviews).toEqual([{ state: 'APPROVED' }]);
  });
  it('readDrainCarryEvidence: a full 100-comment page is replaced by the complete thread', () => {
    const page = Array.from({ length: 100 }, () => ({ author: BOT, body: '🔒 conveyor fix-begin — x' }));
    const full = [...page, { author: BOT, body: 'hold' }];
    expect(readDrainCarryEvidence({ comments: page, readComments: () => full, readReviews: () => [] }).comments).toBe(full);
  });
  it('readDrainCarryEvidence: any read miss (thrown, non-array) yields reviews:null and never throws', () => {
    const page = Array.from({ length: 100 }, () => ({ body: 'x' }));
    expect(readDrainCarryEvidence({ comments: page, readComments: () => { throw new Error('gh'); }, readReviews: () => [] }).reviews).toBeNull();
    expect(readDrainCarryEvidence({ comments: page, readComments: () => 'nope', readReviews: () => [] }).reviews).toBeNull();
    expect(readDrainCarryEvidence({ comments: [], readComments: () => [], readReviews: () => { throw new Error('gh'); } }).reviews).toBeNull();
    expect(readDrainCarryEvidence({ comments: [], readComments: () => [], readReviews: () => ({}) }).reviews).toBeNull();
    expect(readDrainCarryEvidence({}).reviews).toBeNull();
  });
  it('end to end through the evidence: a hold past comment 100 stops the drain carry; a clean full thread still carries', () => {
    const page = [clear(), ...Array.from({ length: 99 }, () => ({ author: BOT, body: '🔒 conveyor fix-begin — x' }))];
    const carryWith = (full) => {
      const ev = readDrainCarryEvidence({ comments: page, readComments: () => full, readReviews: () => [] });
      return carryHumanClearanceOnIdenticalDiff({ ...base(), comments: ev.comments, reviews: ev.reviews }).carried;
    };
    expect(carryWith([...page, { author: { login: 'chalbert' }, body: 'hold, don\'t merge' }])).toBe(false);
    expect(carryWith([...page, { author: BOT, body: '🔓 conveyor fix-end — released' }])).toBe(true);
  });
});

describe('the sweep runs the restamp in the PR repo\'s own checkout and remembers only settled outcomes (PR #4631 F1/F2)', () => {
  beforeEach(() => _resetAcceptCarryMemo());
  const prs = [{ number: 217, labels: [MECH_LABEL], headRefOid: NEW, comments: fx.comments }];
  const cand = { repo: 'plateauapp/plateau-app', num: 217, head: NEW, from: OLD };
  const spawnOf = (result) => { const calls = []; return { calls, spawn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; } }; };

  it('F1: a non-local repo\'s restamp child is pinned to that repo\'s checkout (cwd), and --repo names it', () => {
    const { calls, spawn } = spawnOf({ status: 0, stdout: '{"ok":true}\n' });
    expect(defaultRunRestamp(cand, { spawn, cloneDirFor: () => '/clones/plateau-app' }).ok).toBe(true);
    expect(calls[0].opts.cwd).toBe('/clones/plateau-app');
    expect(calls[0].args).toContain('--repo=plateauapp/plateau-app');
  });

  it('F1: no checkout provisioned → nothing is spawned and the outcome is retryable (not a refusal)', () => {
    const { calls, spawn } = spawnOf({ status: 0, stdout: '' });
    expect(defaultRunRestamp(cand, { spawn, cloneDirFor: () => null })).toMatchObject({ ok: false, retryable: true });
    expect(calls).toHaveLength(0);
  });

  it('F1: the clone resolver maps a constellation slug to its checkout and returns null when it is not there', () => {
    expect(defaultCloneDirFor('plateauapp/plateau-app', { profileOf: () => ({ checkoutPath: '/c/pa' }), exists: (p) => p === '/c/pa/.git' })).toBe('/c/pa');
    expect(defaultCloneDirFor('plateauapp/plateau-app', { profileOf: () => ({ checkoutPath: '/c/pa' }), exists: () => false })).toBeNull();
    expect(defaultCloneDirFor('nope/nope', { profileOf: () => null })).toBeNull();
    expect(defaultCloneDirFor(null)).toBeUndefined();
  });

  it('F2: a printed DECISION is settled; a read-miss refusal, a crash, a timeout and a signal are retryable', () => {
    const run = (result) => defaultRunRestamp(cand, { spawn: () => result, cloneDirFor: () => '/c' });
    expect(run({ status: 1, stdout: '{"error":"changed","refused":true}\n' })).toMatchObject({ ok: false, retryable: false });
    expect(run({ status: 1, stdout: '{"error":"no diff","refused":true,"retryable":true}\n' }).retryable).toBe(true);
    expect(run({ status: 1, stdout: '{"error":"gh pr view failed"}\n' }).retryable).toBe(true);
    expect(run({ status: 1, stdout: 'Error: boom\n' }).retryable).toBe(true);
    expect(run({ status: null, signal: 'SIGTERM', stdout: '' }).retryable).toBe(true);
    expect(run({ status: null, error: new Error('ETIMEDOUT'), stdout: '' }).retryable).toBe(true);
  });

  it('F2: a transient failure is retried on the next tick for the same head; a success is then remembered', () => {
    const results = [{ ok: false, retryable: true, detail: 'fetch miss' }, { ok: true, detail: 'carried' }];
    const runRestamp = () => results.shift();
    let t = 5_000_000;
    const sweep = () => sweepAcceptCarry({ prs, repo: 'plateauapp/plateau-app', setting: 'on', runRestamp, now: () => t });
    expect(sweep()).toEqual([{ num: 217, carry: 'retry', detail: 'fetch miss' }]);
    expect(sweep()).toEqual([]); // inside the backoff window
    t += TRANSIENT_BACKOFF_BASE_MS;
    expect(sweep()).toEqual([{ num: 217, carry: 'carried', detail: 'carried' }]);
    t += TRANSIENT_BACKOFF_MAX_MS;
    expect(sweep()).toEqual([]);
  });

  it('F2: a settled refusal is not retried for the same head, and a thrown runner counts as transient', () => {
    let n = 0;
    const refuse = () => { n += 1; return { ok: false, retryable: false, detail: 'changed diff' }; };
    sweepAcceptCarry({ prs, setting: 'on', runRestamp: refuse }); sweepAcceptCarry({ prs, setting: 'on', runRestamp: refuse });
    expect(n).toBe(1);
    _resetAcceptCarryMemo();
    expect(sweepAcceptCarry({ prs, setting: 'on', runRestamp: () => { throw new Error('spawn blew up'); } })[0].carry).toBe('retry');
  });

  it('F2: transient retries back off exponentially (capped) and are never given up on', () => {
    let n = 0;
    let t = 1_000_000;
    const flaky = () => { n += 1; return { ok: false, retryable: true, detail: 'x' }; };
    const tick = () => sweepAcceptCarry({ prs, setting: 'on', runRestamp: flaky, now: () => t });
    tick(); tick(); // second call is inside the backoff window
    expect(n).toBe(1);
    t += transientBackoffMs(1); tick();
    expect(n).toBe(2);
    t += transientBackoffMs(1); tick(); // window is now longer
    expect(n).toBe(2);
    expect(transientBackoffMs(1)).toBe(TRANSIENT_BACKOFF_BASE_MS);
    expect(transientBackoffMs(50)).toBe(TRANSIENT_BACKOFF_MAX_MS);
    for (let i = 0; i < 20; i += 1) { t += TRANSIENT_BACKOFF_MAX_MS; tick(); } // a long outage still retries
    expect(n).toBe(22);
  });
});

describe('setting cascade (card x5wnfcg)', () => {
  it('env > settings file > built-in off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acf-'));
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ acceptCarryForward: 'on' }));
    expect(resolveAcceptCarryForward({ env: {}, file })).toEqual({ value: 'on', source: 'settings' });
    expect(resolveAcceptCarryForward({ env: { WE_ACCEPT_CARRY_FORWARD: 'off' }, file })).toEqual({ value: 'off', source: 'env' });
    expect(resolveAcceptCarryForward({ env: {}, file: join(dir, 'missing.json') })).toEqual({ value: 'off', source: 'default' });
  });

  it('the platform preference ships on', () => {
    expect(JSON.parse(readFileSync(ACCEPT_CARRY_FORWARD_SETTINGS_FILE, 'utf8')).acceptCarryForward).toBe('on');
  });
});

describe('plateau-app #217 replay — clearance stamped with reviewed-sha only (no diff marker), refreshed 808f0deb → 4339cf57', () => {
  const OLD217 = '808f0deba4d8' + '0'.repeat(28);
  const NEW217 = '4339cf573915' + '0'.repeat(28);
  const DIFF = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n';
  const view = { headRefOid: NEW217, headRefName: 'lane/xadunn9-wip-deeplinks',
    comments: [{ author: { login: 'web-everything[bot]' }, body: `✅ review — cleared\n<!-- reviewed-sha: ${OLD217} -->\n<!-- cleared-human: chalbert -->` }] };
  const exec = (cmd) => { if (cmd === 'gh') return JSON.stringify(view); throw new Error('unexpected'); };
  const read = (texts, carrySetting = 'on', { comments = view.comments, readReviews = () => [] } = {}) => readDrainAcceptance({
    pr: 217, repo: 'plateauapp/plateau-app', cwd: '/clone', carrySetting, readReviews,
    exec: (cmd) => { if (cmd === 'gh') return JSON.stringify({ ...view, comments }); throw new Error('unexpected'); },
    netDiff: ({ rev }) => (texts[rev] == null ? { scored: false } : { scored: true, text: texts[rev], rev }) });

  // PR #4631 round 7 (red-team): the derived fingerprint is only derived for an accept that still STANDS — the same
  // later-objection rule the restamp path applies. Each objection shape, and each read miss, leaves SHA identity.
  describe('a later objection, or an unprovable thread, means no derived fingerprint (not covered)', () => {
    const both = { [OLD217]: DIFF, [NEW217]: DIFF };
    const clearC = { ...view.comments[0], createdAt: '2026-10-09T10:00:00Z' };
    const cases = [
      ['a later changes verdict', { comments: [clearC, { author: { login: 'web-everything[bot]' }, body: '🔁 review — changes requested\n\nx' }] }],
      ['operator free text after it', { comments: [clearC, { author: { login: 'chalbert' }, body: 'hold, don\'t merge' }] }],
      ['a formal CHANGES_REQUESTED review after it', { comments: [clearC], readReviews: () => [{ state: 'CHANGES_REQUESTED', submitted_at: '2026-10-09T11:00:00Z' }] }],
      ['unreadable formal reviews (throw)', { comments: [clearC], readReviews: () => { throw new Error('gh api failed'); } }],
      ['unreadable formal reviews (non-array)', { comments: [clearC], readReviews: () => ({}) }],
      ['a full first page of comments', { comments: [clearC, ...Array.from({ length: 99 }, () => ({ author: { login: 'web-everything[bot]' }, body: '🔒 conveyor fix-begin — x' }))] }],
    ];
    for (const [name, opts] of cases) {
      it(name, () => {
        const ev = read(both, 'on', opts);
        expect(ev.acceptedDiff).toBeNull();
        expect(acceptanceCoversHead(ev).covers).toBe(false);
      });
    }
    it('positive control: the same accept with nothing after it and an empty review list still covers', () => {
      expect(acceptanceCoversHead(read(both, 'on', { comments: [clearC] })).covers).toBe(true);
    });
  });

  // PR #4631 round 7 (toctou-head-binding): the live side is read AT the head SHA, never at the branch name.
  it('the live read is keyed by the head SHA: a diff available only under the branch name proves nothing', () => {
    const ev = read({ [OLD217]: DIFF, 'lane/xadunn9-wip-deeplinks': DIFF });
    expect(ev.headReadFailed).toBe(true);
    expect(acceptanceCoversHead(ev).covers).toBe(false);
  });

  it('identical net diff on both heads: the accept covers the refreshed head (derived from git)', () => {
    const ev = read({ [OLD217]: DIFF, [NEW217]: DIFF });
    expect(ev.acceptedDiffDerived).toBe(true);
    expect(acceptanceCoversHead(ev).covers).toBe(true);
  });

  it('a changed net diff does not cover', () => {
    const ev = read({ [OLD217]: DIFF, [NEW217]: DIFF.replace('+b', '+c') });
    expect(acceptanceCoversHead(ev).covers).toBe(false);
  });

  it('an unreadable accepted head leaves today\'s SHA identity (not covered)', () => {
    const ev = read({ [NEW217]: DIFF });
    expect(ev.acceptedDiff).toBeNull();
    expect(acceptanceCoversHead(ev).covers).toBe(false);
  });

  it('setting off = today', () => {
    expect(acceptanceCoversHead(read({ [OLD217]: DIFF, [NEW217]: DIFF }, 'off')).covers).toBe(false);
  });
});
