/**
 * @file pr-status.test.mjs — proof of the four rules `we:scripts/pr-status.mjs` exists to hold.
 *
 *   RULE 1 (the phase is DERIVED) — `derivePhase` cannot reach `FIXING` or `REVIEWING` without a live worker,
 *     from ANY label, ledger verdict or combination of them; and `selectOwningLane` decides ownership by
 *     ANCESTRY, so a lane whose fixer has committed locally (lane HEAD ahead of the pushed branch head) is still
 *     recognised as the worker — the case an equality test gets exactly backwards.
 *   RULE 2 (rounds from the LEDGER) — `reviewRoundsFromLedger` reads real jury events through the shared fold,
 *     counts a three-round negotiation as 3 no matter how many times a verdict is RESTATED in the stream, and
 *     reports 0 (not 1) for a PR with no ledger.
 *   RULE 3/4 (the stuck reasons, and `needs human`) — bounced-no-fixer and no-reviewer are distinguished, and
 *     `detectPendingQuestion` fires only on the narrow decidable shape and refuses every neighbouring one.
 *   RULE 5 (best-effort transcripts) — a truncated, malformed or empty transcript degrades to a blank line and
 *     never throws.
 *
 * Everything here is pure over fixtures: no live process, no `gh`, no network, no git, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import {
  PHASES,
  STUCK_REASONS,
  ROUND_VERDICTS,
  reviewRoundsFromLedger,
  reviewRoundsFromVerdictLedger,
  reviewRounds,
  latestLedgerVerdict,
  owedFromLedgerVerdict,
  ledgerPanelVerdict,
  selectOwningLane,
  projectDirName,
  parseTranscript,
  lastActivity,
  detectPendingQuestion,
  derivePhase,
  compactElapsed,
  renderReport,
} from '../pr-status.mjs';
import { buildReviewLedgerEvents } from '../lib/jury-ledger.mjs';
import { REVIEW_LABELS } from '../lib/review-escalation.mjs';
import { VERDICTS } from '../lib/jury-core.mjs';
import { VERDICTS as LEDGER_VERDICTS } from '../lib/verdict-ledger.mjs';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────

const BRANCH_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LANE_AHEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';   // the fixer committed locally — HEAD moved on
const UNRELATED = 'cccccccccccccccccccccccccccccccccccccccc';

/** A lane bag for `selectOwningLane`, plus the two injected probes over an explicit ancestry table. */
function probes({ heads, ancestors }) {
  return {
    headOf: (dir) => heads[dir] ?? null,
    // `ancestors[dir]` lists the shas that ARE ancestors of that lane's HEAD (a real `--is-ancestor` also
    // answers true for the head itself, so every table below includes it).
    isAncestor: (dir, ancestor) => (ancestors[dir] || []).includes(ancestor),
  };
}

const live = (pid, elapsed = '4m') => [{ pid, elapsed }];

/** One transcript entry as Claude Code writes it. */
const assistant = (content, { stop_reason = 'end_turn', isSidechain = false } = {}) =>
  ({ type: 'assistant', isSidechain, message: { role: 'assistant', content, stop_reason } });
const userTurn = (text) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const text = (t) => ({ type: 'text', text: t });
const toolUse = (name, input) => ({ type: 'tool_use', name, input });

// ── RULE 2 — rounds come from the ledger ──────────────────────────────────────────────────────────────────────

describe('reviewRoundsFromLedger — rounds are read from the ledger, never counted out of prose', () => {
  it('a PR with NO ledger is 0 rounds, not 1 — never reviewed must not read as reviewed once', () => {
    expect(reviewRoundsFromLedger([])).toBe(0);
    expect(reviewRoundsFromLedger(null)).toBe(0);
    expect(reviewRoundsFromLedger(undefined)).toBe(0);
  });

  it('a seated roster at ledger round 0 IS one round (ledger rounds are 0-based, the loop counts from 1)', () => {
    const events = buildReviewLedgerEvents({ lensVerdicts: { correctness: VERDICTS.ACCEPT }, rounds: 1 });
    expect(reviewRoundsFromLedger(events)).toBe(1);
  });

  it('a three-round negotiation reports 3', () => {
    const events = buildReviewLedgerEvents({ lensVerdicts: { correctness: VERDICTS.CHANGES }, rounds: 3 });
    expect(reviewRoundsFromLedger(events)).toBe(3);
  });

  it('RESTATING a verdict does not add rounds — the double-count that string-scanning comments produces', () => {
    // Three rounds, but every lens re-reports its verdict and the same finding is re-filed: eleven verdict-ish
    // records in the stream, one negotiation of three rounds. A `grep -c verdict` over comment bodies is exactly
    // what turns this into "r11".
    const finding = { summary: 'the same finding, re-reported each round', category: 'correctness', file: 'a.mjs' };
    const events = buildReviewLedgerEvents({
      lensVerdicts: {
        correctness: VERDICTS.CHANGES, security: VERDICTS.ACCEPT,
        simplicity: VERDICTS.ACCEPT, 'standards-conformance': VERDICTS.ACCEPT,
      },
      findings: [finding, finding, finding],
      rounds: 3,
    });
    expect(events.filter((e) => e.type === 'verdict').length).toBeGreaterThan(3);
    expect(reviewRoundsFromLedger(events)).toBe(3);
  });

  it('a stream of foreign lines that names no roster is 0 rounds, not 1 — total, never a throw', () => {
    expect(reviewRoundsFromLedger([{ type: 'not-a-jury-event' }, null, 'garbage', 42])).toBe(0);
  });

  it('ledgerPanelVerdict reports the strictest panel verdict, and null with no ledger', () => {
    const bounced = buildReviewLedgerEvents({
      lensVerdicts: { correctness: VERDICTS.CHANGES, security: VERDICTS.ACCEPT }, rounds: 2,
    });
    expect(ledgerPanelVerdict(bounced)).toBe(VERDICTS.CHANGES);
    expect(ledgerPanelVerdict([])).toBeNull();
  });
});

// ── RULE 2 — the OTHER append-only ledger, the one today's open PRs actually live in ─────────────────────────

/** Verdict-ledger rows as `verdict-ledger.mjs` writes them (only the fields this module reads). */
const row = (pr, verdict) => ({ v: 1, kind: 'we.review-verdict', pr, verdict, repo: 'web-everything/web-everything' });

describe('reviewRoundsFromVerdictLedger — one qualifying row is one round', () => {
  it('counts only rows for THIS pr', () => {
    const records = [row(1563, 'changes'), row(1569, 'changes'), row(1563, 'changes')];
    expect(reviewRoundsFromVerdictLedger(records, 1563)).toBe(2);
    expect(reviewRoundsFromVerdictLedger(records, 1569)).toBe(1);
    expect(reviewRoundsFromVerdictLedger(records, 9999)).toBe(0);
  });

  it('counts a reviewer JUDGING the diff — accepted, changes, human', () => {
    for (const v of ROUND_VERDICTS) expect(reviewRoundsFromVerdictLedger([row(7, v)], 7)).toBe(1);
    expect(ROUND_VERDICTS).toEqual([LEDGER_VERDICTS.ACCEPTED, LEDGER_VERDICTS.CHANGES, LEDGER_VERDICTS.HUMAN]);
  });

  it('does NOT count pending, restamped or clear-human — none of them reviewed anything', () => {
    // The three exclusions are the ledger module's own definitions: `pending` is the drain parking the PR,
    // `restamped` is an acceptance carried across a rebase with no review run, `clear-human` lifts a hold.
    const noise = [
      row(7, LEDGER_VERDICTS.PENDING), row(7, LEDGER_VERDICTS.RESTAMPED), row(7, LEDGER_VERDICTS.CLEAR_HUMAN),
    ];
    expect(reviewRoundsFromVerdictLedger(noise, 7)).toBe(0);
    expect(reviewRoundsFromVerdictLedger([...noise, row(7, 'changes')], 7)).toBe(1);
  });

  it('ignores junk rows instead of throwing', () => {
    expect(reviewRoundsFromVerdictLedger([null, 'x', {}, { pr: 'nope' }], 7)).toBe(0);
    expect(reviewRoundsFromVerdictLedger(null, 7)).toBe(0);
  });

  it('matches a string pr id as well as a number', () => {
    expect(reviewRoundsFromVerdictLedger([row(1563, 'changes')], '1563')).toBe(1);
  });
});

describe('latestLedgerVerdict — latest-wins, the ledger\'s only rule', () => {
  it('returns the last recorded verdict for the PR, including non-round rows', () => {
    const records = [row(7, 'changes'), row(7, 'accepted'), row(9, 'changes'), row(7, LEDGER_VERDICTS.PENDING)];
    expect(latestLedgerVerdict(records, 7)).toBe(LEDGER_VERDICTS.PENDING);
    expect(latestLedgerVerdict(records, 9)).toBe('changes');
    expect(latestLedgerVerdict(records, 11)).toBeNull();
    expect(latestLedgerVerdict(null, 7)).toBeNull();
  });
});

describe('reviewRounds — the higher of the two ledgers, never their sum', () => {
  it('takes the jury ledger when only it saw the review', () => {
    const juryEvents = buildReviewLedgerEvents({ lensVerdicts: { correctness: VERDICTS.CHANGES }, rounds: 4 });
    expect(reviewRounds({ juryEvents, verdictRecords: [], pr: 7 })).toBe(4);
  });

  it('takes the verdict ledger when only it saw the review — the case for today\'s open PRs', () => {
    const verdictRecords = Array.from({ length: 7 }, () => row(1563, 'changes'));
    expect(reviewRounds({ juryEvents: [], verdictRecords, pr: 1563 })).toBe(7);
  });

  it('does not SUM the two when both have rows — a review writes to one path, not both', () => {
    const juryEvents = buildReviewLedgerEvents({ lensVerdicts: { correctness: VERDICTS.CHANGES }, rounds: 3 });
    const verdictRecords = [row(7, 'changes'), row(7, 'changes')];
    expect(reviewRounds({ juryEvents, verdictRecords, pr: 7 })).toBe(3);
  });

  it('is 0 when neither ledger has anything, and total over no arguments', () => {
    expect(reviewRounds({ juryEvents: [], verdictRecords: [], pr: 7 })).toBe(0);
    expect(reviewRounds()).toBe(0);
  });
});

describe('owedFromLedgerVerdict — one normalizer over BOTH ledger vocabularies', () => {
  it('maps the jury panel vocabulary', () => {
    expect(owedFromLedgerVerdict(VERDICTS.CHANGES)).toBe('fix');
    expect(owedFromLedgerVerdict(VERDICTS.ACCEPT)).toBe('none');
    expect(owedFromLedgerVerdict(VERDICTS.NEEDS_HUMAN)).toBe('human');
  });

  it('maps prevention-outstanding to its OWN owed value — the fourth verdict is not a flavour of the other three', () => {
    expect(owedFromLedgerVerdict(VERDICTS.PREVENTION_OUTSTANDING)).toBe('prevention');
  });

  // PR #1574 review, juror finding 1. The switch this replaces had no arm for `prevention-outstanding`, so a
  // converged PR read as `STUCK: no review label`. Derived from the ENUM, so a fifth member reddens this test
  // the moment it is added, alongside the `check:standards` totality gate the table is now annotated for.
  it('is TOTAL over the jury VERDICTS enum — no member falls through to null', () => {
    for (const verdict of Object.values(VERDICTS)) {
      expect(owedFromLedgerVerdict(verdict), `VERDICTS member "${verdict}" has no owed mapping`).not.toBeNull();
    }
  });

  it('inherits nothing — a prototype member name is unknown, not an accidental hit', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(owedFromLedgerVerdict(key), key).toBeNull();
    }
  });

  it('maps the verdict-ledger vocabulary, including the two clears that are not acceptances', () => {
    expect(owedFromLedgerVerdict(LEDGER_VERDICTS.CHANGES)).toBe('fix');
    expect(owedFromLedgerVerdict(LEDGER_VERDICTS.ACCEPTED)).toBe('none');
    expect(owedFromLedgerVerdict(LEDGER_VERDICTS.RESTAMPED)).toBe('none');
    expect(owedFromLedgerVerdict(LEDGER_VERDICTS.CLEAR_HUMAN)).toBe('none');
    expect(owedFromLedgerVerdict(LEDGER_VERDICTS.PENDING)).toBe('review');
    expect(owedFromLedgerVerdict(LEDGER_VERDICTS.HUMAN)).toBe('human');
  });

  it('is null for anything it does not know — a guess here would name the wrong stall', () => {
    expect(owedFromLedgerVerdict('who knows')).toBeNull();
    expect(owedFromLedgerVerdict(null)).toBeNull();
    expect(owedFromLedgerVerdict(undefined)).toBeNull();
  });
});

// ── RULE 1 — ownership is ancestry, and liveness is separate from it ──────────────────────────────────────────

describe('selectOwningLane — ancestry, not equality (rule 1)', () => {
  it('claims the lane whose HEAD IS the branch head', () => {
    const lanes = [{ lane: 'lane-26', dir: '/l/26', live: live(1454) }];
    const owner = selectOwningLane({
      branchHead: BRANCH_HEAD, lanes,
      ...probes({ heads: { '/l/26': BRANCH_HEAD }, ancestors: { '/l/26': [BRANCH_HEAD] } }),
    });
    expect(owner).toMatchObject({ lane: 'lane-26', live: { pid: 1454 } });
  });

  it('STILL claims the lane once the fixer has COMMITTED LOCALLY — the case equality gets backwards', () => {
    // The lane HEAD has moved past the pushed branch head. Sha equality is now false; ancestry is still true,
    // and this is the exact moment an operator most needs to see "someone is on it".
    const lanes = [{ lane: 'lane-26', dir: '/l/26', live: live(1454) }];
    const owner = selectOwningLane({
      branchHead: BRANCH_HEAD, lanes,
      ...probes({ heads: { '/l/26': LANE_AHEAD }, ancestors: { '/l/26': [BRANCH_HEAD, LANE_AHEAD] } }),
    });
    expect(owner).not.toBeNull();
    expect(owner.lane).toBe('lane-26');
  });

  it('does not claim a lane sitting on unrelated work', () => {
    const lanes = [{ lane: 'lane-3', dir: '/l/3', live: live(99) }];
    const owner = selectOwningLane({
      branchHead: BRANCH_HEAD, lanes,
      ...probes({ heads: { '/l/3': UNRELATED }, ancestors: { '/l/3': [UNRELATED] } }),
    });
    expect(owner).toBeNull();
  });

  it('returns an owning lane that is IDLE, with live:null — so a stopped-to-ask agent is still findable', () => {
    const lanes = [{ lane: 'lane-26', dir: '/l/26', live: [] }];
    const owner = selectOwningLane({
      branchHead: BRANCH_HEAD, lanes,
      ...probes({ heads: { '/l/26': BRANCH_HEAD }, ancestors: { '/l/26': [BRANCH_HEAD] } }),
    });
    expect(owner).toMatchObject({ lane: 'lane-26', live: null });
  });

  it('prefers the LIVE owner when a stale lane also carries the branch', () => {
    const lanes = [
      { lane: 'lane-stale', dir: '/l/stale', live: [] },
      { lane: 'lane-live', dir: '/l/live', live: live(777) },
    ];
    const owner = selectOwningLane({
      branchHead: BRANCH_HEAD, lanes,
      ...probes({
        heads: { '/l/stale': BRANCH_HEAD, '/l/live': LANE_AHEAD },
        ancestors: { '/l/stale': [BRANCH_HEAD], '/l/live': [BRANCH_HEAD, LANE_AHEAD] },
      }),
    });
    expect(owner.lane).toBe('lane-live');
  });

  it('skips a lane whose probes throw or whose HEAD is unreadable — never claims one on a failed read', () => {
    const lanes = [{ lane: 'lane-bad', dir: '/l/bad', live: live(1) }, { lane: 'lane-boom', dir: '/l/boom', live: live(2) }];
    const owner = selectOwningLane({
      branchHead: BRANCH_HEAD,
      lanes,
      headOf: (dir) => { if (dir === '/l/boom') throw new Error('git exploded'); return null; },
      isAncestor: () => true,
    });
    expect(owner).toBeNull();
  });

  it('answers null with no branch head, no lanes, or missing probes', () => {
    expect(selectOwningLane({ branchHead: null, lanes: [{ lane: 'x', dir: '/x' }], ...probes({ heads: {}, ancestors: {} }) })).toBeNull();
    expect(selectOwningLane({ branchHead: BRANCH_HEAD, lanes: [], ...probes({ heads: {}, ancestors: {} }) })).toBeNull();
    expect(selectOwningLane({ branchHead: BRANCH_HEAD, lanes: [{ lane: 'x', dir: '/x' }] })).toBeNull();
    expect(selectOwningLane()).toBeNull();
  });
});

// ── RULE 1 — the phase itself ─────────────────────────────────────────────────────────────────────────────────

const WORKER = { lane: 'lane-26', pid: 1454, elapsed: '4m' };

describe('derivePhase — a working phase is unreachable without a live worker (rule 1)', () => {
  it('a bounced PR with NO live worker is STUCK: bounced, no fixer — a label is not a worker', () => {
    const got = derivePhase({ labels: [REVIEW_LABELS.changes], worker: null });
    expect(got.phase).toBe(PHASES.STUCK);
    expect(got.reason).toBe(STUCK_REASONS.BOUNCED_NO_FIXER);
    expect(got.display).toBe('STUCK: bounced, no fixer');
  });

  it('a parked PR with NO live worker is STUCK: no reviewer — the reason that stranded #1567', () => {
    const got = derivePhase({ labels: [REVIEW_LABELS.pending], worker: null });
    expect(got.reason).toBe(STUCK_REASONS.NO_REVIEWER);
    expect(got.display).toBe('STUCK: no reviewer');
  });

  it('NO combination of labels or ledger verdicts reaches FIXING or REVIEWING without a worker', () => {
    const labelSets = [
      [], [REVIEW_LABELS.pending], [REVIEW_LABELS.changes], [REVIEW_LABELS.human],
      [REVIEW_LABELS.pending, REVIEW_LABELS.changes], [REVIEW_LABELS.changes, REVIEW_LABELS.human],
      ['checking'], [{ name: REVIEW_LABELS.changes }],
    ];
    const owedValues = [null, 'fix', 'review', 'human', 'prevention'];
    for (const labels of labelSets) {
      for (const ledgerOwed of owedValues) {
        const got = derivePhase({ labels, worker: null, ledgerOwed });
        expect(got.phase, `labels=${JSON.stringify(labels)} owed=${ledgerOwed}`).toBe(PHASES.STUCK);
      }
    }
  });

  it('a bounced PR WITH a live worker in its lane is FIXING', () => {
    expect(derivePhase({ labels: [REVIEW_LABELS.changes], worker: WORKER })).toMatchObject({ phase: PHASES.FIXING, display: 'FIXING' });
  });

  it('a parked PR WITH a live worker in its lane is REVIEWING', () => {
    expect(derivePhase({ labels: [REVIEW_LABELS.pending], worker: WORKER })).toMatchObject({ phase: PHASES.REVIEWING });
  });

  it('accepts label-object shapes exactly as gh emits them', () => {
    expect(derivePhase({ labels: [{ name: REVIEW_LABELS.changes }], worker: null }).reason).toBe(STUCK_REASONS.BOUNCED_NO_FIXER);
  });

  it('READY wins over everything — nothing is owed, so nobody needs to be working', () => {
    expect(derivePhase({ labels: [REVIEW_LABELS.accepted], worker: null }).phase).toBe(PHASES.READY);
    expect(derivePhase({ labels: ['ready-to-merge'], worker: WORKER }).phase).toBe(PHASES.READY);
    expect(derivePhase({
      labels: [REVIEW_LABELS.accepted], worker: null, pendingQuestion: { asked: true, question: 'ok?' },
    }).phase).toBe(PHASES.READY);
  });

  it('a review:human LABEL is its own reason, NEVER "needs human" — the gate is not a question', () => {
    expect(derivePhase({ labels: [REVIEW_LABELS.human], worker: null }).reason).toBe(STUCK_REASONS.HUMAN_GATE);
  });

  it('an unanswered question outranks a live worker — a session parked at a prompt is not progress', () => {
    const got = derivePhase({
      labels: [REVIEW_LABELS.changes], worker: WORKER, pendingQuestion: { asked: true, question: 'which one?' },
    });
    expect(got.display).toBe('STUCK: needs human');
  });

  it('falls back to the LEDGER for what is owed when the PR carries no review label', () => {
    expect(derivePhase({ labels: [], worker: null, ledgerOwed: 'fix' }).reason).toBe(STUCK_REASONS.BOUNCED_NO_FIXER);
    expect(derivePhase({ labels: [], worker: null, ledgerOwed: 'review' }).reason).toBe(STUCK_REASONS.NO_REVIEWER);
    expect(derivePhase({ labels: [], worker: null, ledgerOwed: 'human' }).reason).toBe(STUCK_REASONS.HUMAN_GATE);
    expect(derivePhase({ labels: [], worker: null, ledgerOwed: null }).reason).toBe(STUCK_REASONS.NO_LABEL);
  });

  it('a LABEL always outranks the ledger fallback — the ledger only speaks when no label does', () => {
    expect(derivePhase({ labels: [REVIEW_LABELS.pending], worker: null, ledgerOwed: 'fix' }).reason)
      .toBe(STUCK_REASONS.NO_REVIEWER);
  });

  it('a ledger that says CLEARED with no label to match reads READY, not a stall', () => {
    expect(derivePhase({ labels: [], worker: null, ledgerOwed: 'none' }).phase).toBe(PHASES.READY);
  });

  // PR #1574 review, juror finding 2. `owed === 'none'` used to be reachable only inside the `else` of
  // `if (worker)`, so a lane whose fixer session was still alive when the ledger cleared the PR — the
  // `AGREEMENT.UNLABELED` window verdict-ledger.mjs's shadow checker exists to catch — reported FIXING for a PR
  // that was done. The sibling test above only ever passed `worker: null`, which is why it stayed green.
  it('a ledger that says CLEARED reads READY EVEN WITH A LIVE WORKER — a worker is not evidence anything is owed', () => {
    expect(derivePhase({ labels: [], worker: WORKER, ledgerOwed: 'none' }).phase).toBe(PHASES.READY);
    expect(derivePhase({ labels: [], worker: WORKER, ledgerOwed: 'none' }).display).toBe('READY');
  });

  it('a converged PR whose prevention guard is UNFILED says so — not "no review label", not "human gate"', () => {
    const got = derivePhase({ labels: [], worker: null, ledgerOwed: 'prevention' });
    expect(got.phase).toBe(PHASES.STUCK);
    expect(got.reason).toBe(STUCK_REASONS.PREVENTION_UNFILED);
    expect(got.display).toBe('STUCK: prevention unfiled');
    expect(got.reason).not.toBe(STUCK_REASONS.NO_LABEL);
    expect(got.reason).not.toBe(STUCK_REASONS.HUMAN_GATE);
  });

  it('a live worker on a prevention-outstanding PR is FIXING — filing the guard is authoring, not reviewing', () => {
    expect(derivePhase({ labels: [], worker: WORKER, ledgerOwed: 'prevention' }).phase).toBe(PHASES.FIXING);
  });

  // The prevention the #1574 review named for finding 2: the per-case tests above each vary ONE axis, which is
  // exactly how the missing branch hid. This enumerates BOTH axes against the docblock's stated precedence.
  it('THE PRECEDENCE MATRIX — every {worker} x {owed} pair matches the documented order', () => {
    const owedValues = [null, 'fix', 'review', 'human', 'prevention', 'none'];
    for (const worker of [null, WORKER]) {
      for (const ledgerOwed of owedValues) {
        const got = derivePhase({ labels: [], worker, ledgerOwed });
        const where = `worker=${worker ? 'live' : 'null'} owed=${ledgerOwed}`;
        if (ledgerOwed === 'none') {
          // Rung 1 — nothing is owed. Wins over a live worker, in BOTH columns.
          expect(got.phase, where).toBe(PHASES.READY);
        } else if (worker) {
          // Rung 3 — a live worker, named by what is owed. Never READY, never STUCK.
          expect(got.phase, where).toBe(ledgerOwed === 'review' || ledgerOwed === 'human'
            ? PHASES.REVIEWING : PHASES.FIXING);
        } else {
          // Rung 4 — the owed-work stall, one distinct reason per owed value.
          expect(got.phase, where).toBe(PHASES.STUCK);
          expect(got.reason, where).toBe({
            fix: STUCK_REASONS.BOUNCED_NO_FIXER,
            review: STUCK_REASONS.NO_REVIEWER,
            human: STUCK_REASONS.HUMAN_GATE,
            prevention: STUCK_REASONS.PREVENTION_UNFILED,
            null: STUCK_REASONS.NO_LABEL,
          }[String(ledgerOwed)]);
        }
      }
    }
  });

  it('an unanswered question still outranks a live worker, but NOT a cleared ledger — rung 2 sits below rung 1', () => {
    const asked = { asked: true, question: 'which one?' };
    expect(derivePhase({ labels: [], worker: WORKER, ledgerOwed: 'fix', pendingQuestion: asked }).reason)
      .toBe(STUCK_REASONS.NEEDS_HUMAN);
    expect(derivePhase({ labels: [], worker: WORKER, ledgerOwed: 'none', pendingQuestion: asked }).phase)
      .toBe(PHASES.READY);
  });

  it('a live worker on a PR the ledger says needs REVIEW is REVIEWING, not FIXING', () => {
    expect(derivePhase({ labels: [], worker: WORKER, ledgerOwed: 'review' }).phase).toBe(PHASES.REVIEWING);
  });

  it('a live worker on a never-parked PR is FIXING — the lane is still building it', () => {
    expect(derivePhase({ labels: [], worker: WORKER }).phase).toBe(PHASES.FIXING);
  });

  it('takes no arguments at all without throwing', () => {
    expect(derivePhase().phase).toBe(PHASES.STUCK);
  });
});

// ── RULE 4 — `needs human` fires only on the narrow decidable shape ───────────────────────────────────────────

describe('detectPendingQuestion — narrow by construction (rule 4)', () => {
  it('fires when the last main-chain assistant turn ends on a question with no tool_use after it', () => {
    const got = detectPendingQuestion([
      userTurn('go'),
      assistant([toolUse('Read', { file_path: 'a.mjs' })], { stop_reason: 'tool_use' }),
      assistant([text('I found two ways to do this.\n\nShould I keep the old flag as an alias?')]),
    ]);
    expect(got.asked).toBe(true);
    expect(got.question).toBe('Should I keep the old flag as an alias?');
  });

  it('does NOT fire when the turn ended on a tool_use — the agent acted, it did not hand over', () => {
    expect(detectPendingQuestion([
      assistant([text('Should I keep the old flag?'), toolUse('Bash', { command: 'npm test' })], { stop_reason: 'tool_use' }),
    ]).asked).toBe(false);
  });

  it('does NOT fire when a later main-chain entry exists — the question was already answered', () => {
    expect(detectPendingQuestion([
      assistant([text('Should I keep the old flag?')]),
      userTurn('yes, keep it'),
    ]).asked).toBe(false);
  });

  it('does NOT fire on a SIDECHAIN turn — a sub-agent reporting back is not the session waiting', () => {
    expect(detectPendingQuestion([
      assistant([text('main loop still working')], { stop_reason: 'tool_use' }),
      assistant([text('Which file did you mean?')], { isSidechain: true }),
    ]).asked).toBe(false);
  });

  it('does NOT fire on an UNKNOWN or absent stop_reason — unknown is never read as a stop', () => {
    expect(detectPendingQuestion([
      { type: 'assistant', message: { role: 'assistant', content: [text('Shall I proceed?')] } },
    ]).asked).toBe(false);
    expect(detectPendingQuestion([assistant([text('Shall I proceed?')], { stop_reason: 'max_tokens' })]).asked).toBe(false);
  });

  it('does NOT fire when the closing line is a statement', () => {
    expect(detectPendingQuestion([assistant([text('Done. Tests are green and the PR is open.')])]).asked).toBe(false);
  });

  it('does NOT fire when the question is buried above a later statement line', () => {
    expect(detectPendingQuestion([
      assistant([text('Should I keep the flag?\n\nI went ahead and kept it.')]),
    ]).asked).toBe(false);
  });

  it('reports nothing on an empty, junk or non-assistant tail', () => {
    expect(detectPendingQuestion([]).asked).toBe(false);
    expect(detectPendingQuestion(null).asked).toBe(false);
    expect(detectPendingQuestion([userTurn('hello?')]).asked).toBe(false);
    expect(detectPendingQuestion([{ type: 'summary', summary: 'x?' }]).asked).toBe(false);
  });

  it('THE ACKNOWLEDGED FALSE POSITIVE: a finished run whose summary ends on a question mark reads as asked', () => {
    // Documented in the file header as the one wrong answer this rule can give. Pinned here so the limitation
    // is a KNOWN property of the code rather than something a later reader has to rediscover.
    expect(detectPendingQuestion([
      assistant([text('All done — landed as #1570. Want anything else?')]),
    ]).asked).toBe(true);
  });

  it('THE ACKNOWLEDGED FALSE NEGATIVE: a question with no question mark is not detected', () => {
    expect(detectPendingQuestion([
      assistant([text('Let me know whether to keep the old flag as an alias.')]),
    ]).asked).toBe(false);
  });
});

// ── RULE 5 — the transcript is best-effort ────────────────────────────────────────────────────────────────────

describe('parseTranscript / lastActivity — a broken transcript costs one line, never the report', () => {
  it('skips the half-written tail line another process is still appending', () => {
    const jsonl = [
      JSON.stringify(assistant([toolUse('Bash', { description: 'run the standards gate', command: 'npm run check:standards' })], { stop_reason: 'tool_use' })),
      '{"type":"assistant","message":{"content":[{"type":"tool_u',
    ].join('\n');
    const entries = parseTranscript(jsonl);
    expect(entries).toHaveLength(1);
    expect(lastActivity(entries)).toBe('Bash: run the standards gate');
  });

  it('falls back to the command, then the file path, then the bare tool name', () => {
    expect(lastActivity([assistant([toolUse('Bash', { command: 'npm run check:standards' })])])).toBe('Bash: npm run check:standards');
    expect(lastActivity([assistant([toolUse('Read', { file_path: 'scripts/pr-status.mjs' })])])).toBe('Read: scripts/pr-status.mjs');
    expect(lastActivity([assistant([toolUse('Glob', {})])])).toBe('Glob');
  });

  it('reports trailing prose as `says:`, whitespace collapsed', () => {
    expect(lastActivity([assistant([text('  writing   the\n\n  tests  ')])])).toBe('says: writing the tests');
  });

  it('takes the LAST activity in the file, including from a sub-agent', () => {
    expect(lastActivity([
      assistant([toolUse('Read', { file_path: 'a.mjs' })]),
      assistant([toolUse('Bash', { description: 'run tests' })], { isSidechain: true }),
    ])).toBe('Bash: run tests');
  });

  it('truncates a long detail rather than blowing the column', () => {
    const got = lastActivity([assistant([toolUse('Bash', { command: 'x'.repeat(200) })])]);
    expect(got.endsWith('…')).toBe(true);
    expect(got.length).toBeLessThanOrEqual(76);
  });

  it('returns empty for empty, junk and unparseable input instead of throwing', () => {
    expect(parseTranscript('')).toEqual([]);
    expect(parseTranscript('not json\n{')).toEqual([]);
    expect(parseTranscript(null)).toEqual([]);
    expect(lastActivity([])).toBe('');
    expect(lastActivity(null)).toBe('');
    expect(lastActivity([{ type: 'assistant', message: { content: 'plain string content' } }])).toBe('says: plain string content');
  });
});

describe('projectDirName — the ~/.claude/projects encoding', () => {
  it('encodes a lane cwd exactly as Claude Code does, doubled dash and all', () => {
    expect(projectDirName('/Users/x/workspace/.lanes/web-everything/lane-1'))
      .toBe('-Users-x-workspace--lanes-web-everything-lane-1');
  });

  it('is total over junk input', () => {
    expect(projectDirName('')).toBe('');
    expect(projectDirName(null)).toBe('');
  });
});

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('compactElapsed', () => {
  it('compacts every ps elapsed shape', () => {
    expect(compactElapsed('00:47')).toBe('47s');
    expect(compactElapsed('04:12')).toBe('4m');
    expect(compactElapsed('01:02:30')).toBe('1h02m');
    expect(compactElapsed('3-04:05:06')).toBe('3d04h');
  });

  it('returns an unparseable value trimmed rather than dropping it', () => {
    expect(compactElapsed('  weird  ')).toBe('weird');
    expect(compactElapsed(undefined)).toBe('');
  });
});

describe('renderReport', () => {
  it('renders the columned table with the live-activity continuation line', () => {
    const out = renderReport([
      { pr: 1563, phaseDisplay: 'STUCK: bounced, no fixer', reviewRounds: 13, fixCommits: 14, worker: null, title: 'file every prevention owed by the reviews on #1556' },
      { pr: 1569, phaseDisplay: 'FIXING', reviewRounds: 3, fixCommits: 13, worker: { lane: 'lane-26', pid: 1454, elapsed: '4m' }, title: 'review: measure the review system', activity: 'Bash: npm run check:standards' },
    ]);
    expect(out).toBe([
      'PR    PHASE                     REV  FIX  WORKER                TITLE',
      '1563  STUCK: bounced, no fixer  r13  c14                        file every prevention owed by the…',
      '1569  FIXING                    r3   c13  ● lane-26 pid1454 4m  review: measure the review system',
      '      └─ now: Bash: npm run check:standards',
      '',
    ].join('\n'));
  });

  it('prints the QUESTION instead of the activity, so the row says why it is stuck', () => {
    const out = renderReport([
      { pr: 1571, phaseDisplay: 'STUCK: needs human', reviewRounds: 1, fixCommits: 2, worker: null, title: 'replay the recorded reviews', activity: 'says: something', question: 'Should I keep the old flag as an alias?' },
    ]);
    expect(out).toContain('      └─ asks: Should I keep the old flag as an alias?');
    expect(out).not.toContain('└─ now:');
  });

  it('renders a header-only table when nothing is open, and never throws on junk', () => {
    expect(renderReport([]).trim()).toBe('PR    PHASE                     REV  FIX  WORKER                TITLE');
    expect(() => renderReport(null)).not.toThrow();
  });
});

// Managed-session evidence closes the lane-only false STUCK reports (#3990/#4017).
describe('owner-aware absence verdicts', () => {
  const live = { phase: 'FIXING', headline: 'live fix-3990 since 2026-10-06T11:00:00Z' };
  it('review:changes with an observed live fixer is not stuck', () => {
    const result = derivePhase({ labels: ['review:changes'], ownerState: live });
    expect(result.phase).toBe('FIXING');
    expect(result.display).toContain('fix-3990');
    expect(result.display).not.toContain('STUCK');
  });
  it.each(['HANDED-OFF', 'WAITING-CI', 'IN-REVIEW', 'STUCK'])('uses the sharper %s evidence for absence-derived stalls', phase => {
    for (const labels of [[], ['review:changes'], ['review:pending']]) {
      expect(derivePhase({ labels, ownerState: { phase, headline: 'observed reason' } }).display).toBe(`${phase}: observed reason`);
    }
  });
  it('keeps the existing human and prevention gates', () => {
    expect(derivePhase({ labels: ['review:human'], ownerState: live }).reason).toBe(STUCK_REASONS.HUMAN_GATE);
    expect(derivePhase({ pendingQuestion: { asked: true }, ownerState: live }).reason).toBe(STUCK_REASONS.NEEDS_HUMAN);
    expect(derivePhase({ ledgerOwed: 'prevention', ownerState: live }).reason).toBe(STUCK_REASONS.PREVENTION_UNFILED);
  });
});
