/**
 * @file review-set-label.test.mjs — proof of the PURE `decideSetLabel` (#2470, increment 2). The `gh` calls are
 *   the I/O boundary (the CLI's concern); the verdict → label-swap decision — including INVARIANT 2 (a
 *   review:human PR is never cleared to accepted here) — is decided in the pure decider and unit-tested here
 *   against fixtures, no network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync, existsSync, realpathSync, symlinkSync, copyFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideSetLabel, presentRemoveLabels, buildVerdictComment, neutralizeCommentMarkers, normalizeChannel,
  runReviewLabelCli, projectVerdictCommentLength, REVIEW_LABEL_TARGETS, GH_COMMENT_MAX,
  checkBodyFileLocation, bodyFileRoots, publishDelegationTrialCommit,
  // #x9krtkb — the restamp path's carried-human-clearance decision (bug 1) and its CLI wiring (bug 2's
  // `--new-head`, exercised through `runReviewLabelCli` below with a stub provider).
  decideRestampHumanClearance,
  // #3334 — re-exported by the single home from `we:scripts/lib/reasonless-bounce.mjs`; imported from HERE on
  // purpose, so this suite proves the home actually exposes the rule its `decideSetLabel` enforces.
  REASONLESS_BOUNCE_REFUSAL, isReasonlessBounce, bounceEvidenceFromWriteUp,
} from '../review-set-label.mjs';
// #3334, routes 2 and 3 — asserted through the OTHER two sanctioned paths' own entry points, because a shared
// core one caller forgets to ask is the defect this item closes.
import { buildDelegationMarker } from '../lib/delegation-marker.mjs';
import { readStore } from '../conveyor/run-scorecard-store.mjs';
import { logDelegationTrial } from '../conveyor/log-delegation-trial.mjs';
import { REVIEW_PR_CHANNEL } from '../operations/review-pr.mjs';
import { isPreWriteRefusal } from '../operations/review-pr-io.mjs';
import { factsFromRun, buildRequest } from '../operations/record-verdict.mjs';
import { validateRequest } from '../apply-review-request.mjs';
import { importGraph } from '../operations/__tests__/import-graph.mjs';
import {
  parseReviewedSha, decideReviewGate, parseReviewedDiff, parseReviewedContribution,
  normalizeDiffFingerprint, normalizeContributionFingerprint, parseOperatorClearance,
  buildClearedHumanMarker, parseLatestHumanClearedSha, shouldReparkForTestTampering,
  buildReviewedShaMarker, buildReviewedDiffMarker, buildReviewedContributionMarker,
} from '../lib/review-escalation.mjs';
import { parseClearerActorId, parseAuthorActorId, readAuthorActorStamps } from '../lib/review-independence.mjs';
import { REVIEW_LABELS, READY_TO_MERGE_LABEL } from '../lib/review-escalation.mjs';
import { ADVISORY_LABELS } from '../lib/advisory-labels.mjs';

const human = [{ name: REVIEW_LABELS.human }, { name: 'ready-to-merge' }];
const pending = [{ name: REVIEW_LABELS.pending }, { name: 'ready-to-merge' }];
const accepted = [{ name: REVIEW_LABELS.accepted }, { name: 'ready-to-merge' }];
const neither = [{ name: 'ready-to-merge' }];

describe('decideSetLabel — INVARIANT 2 (review:human is human-ceremony-only)', () => {
  it('REFUSES accepted on a review:human PR (gate-self reason, no swap)', () => {
    const d = decideSetLabel({ to: 'accepted', currentLabels: human });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('gate-self: review:human is human-ceremony-only — clear via /review in a session');
    expect(d.addLabel).toBe('');
    expect(d.removeLabels).toEqual([]);
  });
});

describe('decideSetLabel — accepted', () => {
  it('on a review:pending PR: adds review:accepted, removes review:pending (and the always-requested changes)', () => {
    const d = decideSetLabel({ to: 'accepted', currentLabels: pending });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
    expect(d.removeLabels).toEqual([REVIEW_LABELS.pending, REVIEW_LABELS.changes]);
  });

  it('with neither human nor pending: still allowed (no human gate), adds review:accepted', () => {
    const d = decideSetLabel({ to: 'accepted', currentLabels: neither });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
    expect(d.removeLabels).toEqual([REVIEW_LABELS.pending, REVIEW_LABELS.changes]);
  });

  // #2974 — the bug: accepting a bounced-but-fixed PR left BOTH review:accepted and review:changes on it, and
  // three consumers (lane-resume.mjs#land, pr-watch.mjs's PARK_LABELS/isReadyToLand, status-board.mjs) read
  // review:changes raw with no accepted-first ordering, so a self-contradictory pair looked like a live bounce
  // to every one of them. Observed live on PR #1064: labels after --to=accepted were
  // [ready-to-merge, review:accepted, review:changes].
  it('accepting a PR carrying review:changes drops BOTH review:changes and review:pending — neither survives', () => {
    const changesAndPending = [{ name: REVIEW_LABELS.changes }, { name: REVIEW_LABELS.pending }, { name: 'ready-to-merge' }];
    const d = decideSetLabel({ to: 'accepted', currentLabels: changesAndPending });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
    const finalLabels = presentRemoveLabels(d.removeLabels, changesAndPending);
    expect(finalLabels).toContain(REVIEW_LABELS.changes);
    expect(finalLabels).toContain(REVIEW_LABELS.pending);
    // Simulate the resulting label set the way the CLI would apply it: the PR's current labels, minus the
    // narrowed removals, plus the added label. Neither 'changes' nor 'pending' survives.
    const current = changesAndPending.map((l) => l.name);
    const after = new Set([...current.filter((n) => !finalLabels.includes(n)), d.addLabel]);
    expect(after.has(REVIEW_LABELS.changes)).toBe(false);
    expect(after.has(REVIEW_LABELS.pending)).toBe(false);
    expect(after.has(REVIEW_LABELS.accepted)).toBe(true);
  });

  // #2974 — presentRemoveLabels already narrows removeLabels to what the PR actually carries, so requesting
  // `changes` in the removal set unconditionally must never hand `gh pr edit --remove-label` an absent label.
  it('requesting review:changes removal on a PR that never carried it narrows to nothing extra (no absent-label error)', () => {
    const d = decideSetLabel({ to: 'accepted', currentLabels: pending });
    const removals = presentRemoveLabels(d.removeLabels, pending);
    expect(removals).toEqual([REVIEW_LABELS.pending]);
    expect(removals).not.toContain(REVIEW_LABELS.changes);
  });

  // The sibling invariant this item explicitly protects: adding review:changes to accepted's removals must not
  // have touched INVARIANT 2 — accepted stays refused on a review:human PR, unconditionally.
  it('still REFUSES on a review:human PR — INVARIANT 2 is unmoved by the #2974 fix', () => {
    const humanChanges = [{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.changes }];
    const d = decideSetLabel({ to: 'accepted', currentLabels: humanChanges });
    expect(d.allowed).toBe(false);
    expect(d.removeLabels).toEqual([]);
  });

  // accepted must still never remove review:human even when it drops changes+pending.
  it('never removes review:human on a non-human accept path (there is none to remove, but pin the shape)', () => {
    const d = decideSetLabel({ to: 'accepted', currentLabels: pending });
    expect(d.removeLabels).not.toContain(REVIEW_LABELS.human);
  });
});

// #2974 — TOTALITY over REVIEW_LABEL_TARGETS × every starting label combination the four labels can form. Two
// invariants must hold for EVERY (target, starting-set) pair, not just the fixtures above: (1) review:human is
// NEVER removed unless the target IS clear-human, and (2) review:accepted and review:changes never coexist in
// the RESULTING label set (simulated the way the CLI actually applies a swap: current labels, minus the
// removals narrowed to what's present, plus the added label). This is what actually pins "accepted never
// returns ok:true while leaving accepted and changes together" — over the whole space, not one fixture.
describe('decideSetLabel — totality over REVIEW_LABEL_TARGETS × starting label sets (#2974)', () => {
  const ALL = [REVIEW_LABELS.human, REVIEW_LABELS.pending, REVIEW_LABELS.accepted, REVIEW_LABELS.changes];
  // Every subset of the four review labels (16 combinations, incl. empty), each plus a non-review label that
  // must never be touched by any swap.
  const powerset = (arr) => arr.reduce((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
  const startingSets = powerset(ALL).map((names) => [...names, 'ready-to-merge']);

  for (const to of REVIEW_LABEL_TARGETS) {
    for (const names of startingSets) {
      const label = `to='${to}' starting=[${names.join(',')}]`;
      it(`${label} — never leaves review:accepted and review:changes together, and never drops human unless clear-human`, () => {
        const currentLabels = names.map((name) => ({ name }));
        const d = decideSetLabel({ to, currentLabels });
        // #2832 supersedes this assertion's original form. #2974 wrote it as "a non-review label is NEVER named
        // in a decision's removals" — true until #2832 made the hold/go-ahead pair self-consistent BY
        // CONSTRUCTION: writing a review-hold label must atomically strip `ready-to-merge`, because a hold and a
        // go-ahead on one PR is the contradiction that merged WE #956 and plateau-app #134. So the rule is now
        // conditional on the target, and asserting it in BOTH directions is strictly stronger than the blanket
        // form it replaces — it pins which targets strip and which must not.
        const HOLD_PRODUCING = new Set(['changes', 'rearm']);   // the targets whose addLabel IS a review hold
        if (!d.allowed) {
          // A refusal changes nothing — the resulting set IS the starting set, and it names NO removals at all
          // (not even the go-ahead: a refused hold must never strip anything).
          expect(d.removeLabels).toEqual([]);
          if (names.includes(REVIEW_LABELS.human)) expect(names).toContain(REVIEW_LABELS.human);
          return;
        }
        if (HOLD_PRODUCING.has(to)) {
          expect(d.removeLabels).toContain(READY_TO_MERGE_LABEL);
        } else {
          // `accepted` and `clear-human` CLEAR a hold — they must leave the go-ahead alone, or accepting a PR
          // would strip the very label the drain collects it by.
          expect(d.removeLabels).not.toContain(READY_TO_MERGE_LABEL);
        }
        const removals = presentRemoveLabels(d.removeLabels, currentLabels);
        const after = new Set([...names.filter((n) => !removals.includes(n)), d.addLabel]);
        // (1) review:human survives every allowed swap except clear-human.
        if (names.includes(REVIEW_LABELS.human) && to !== 'clear-human') {
          expect(after.has(REVIEW_LABELS.human)).toBe(true);
        }
        if (to === 'clear-human') {
          expect(after.has(REVIEW_LABELS.human)).toBe(false);
        }
        // (2) THE #2974 INVARIANT: accepted and changes never coexist in the resulting set.
        expect(after.has(REVIEW_LABELS.accepted) && after.has(REVIEW_LABELS.changes)).toBe(false);
      });
    }
  }
});

describe('decideSetLabel — changes (a bounce lands nothing)', () => {
  it('on a review:human PR: allowed, adds review:changes, does NOT remove review:human', () => {
    const d = decideSetLabel({ to: 'changes', currentLabels: human });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.changes);
    expect(d.removeLabels).not.toContain(REVIEW_LABELS.human);
  });

  it('on a review:pending PR: allowed, adds review:changes, removes review:pending', () => {
    const d = decideSetLabel({ to: 'changes', currentLabels: pending });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.changes);
    expect(d.removeLabels).toContain(REVIEW_LABELS.pending);
  });

  it('strips a stale review:accepted (a bounce must never leave the PR looking accepted)', () => {
    const d = decideSetLabel({ to: 'changes', currentLabels: accepted });
    expect(d.allowed).toBe(true);
    expect(d.removeLabels).toContain(REVIEW_LABELS.accepted);
    // review:human is never in the removal set, even on the changes path.
    expect(d.removeLabels).not.toContain(REVIEW_LABELS.human);
  });

  // #2412 review-fix — redteam:accepted carries no SHA marker of its own (unlike review:accepted), so a bounce
  // is the one unambiguous "this diff needs fresh eyes" signal that can invalidate a prior independent-validator
  // sign-off. Without this, an engine-tier PR bounced and re-fixed could re-accept on a stale redteam verdict
  // that never saw the fix (#2412's own layer-4 requirement would then be satisfied by a label left over from
  // BEFORE the bounce).
  it('also strips a stale redteam:accepted (an independent validator sign-off predating the bounce)', () => {
    const d = decideSetLabel({ to: 'changes', currentLabels: [{ name: REVIEW_LABELS.accepted }, { name: REVIEW_LABELS.redteamAccepted }] });
    expect(d.allowed).toBe(true);
    expect(d.removeLabels).toContain(REVIEW_LABELS.redteamAccepted);
  });
});

describe('decideSetLabel — rearm (#2644, folded in from the conveyor decideRearm)', () => {
  const changes = [{ name: REVIEW_LABELS.changes }, { name: 'ready-to-merge' }];
  const humanChanges = [{ name: REVIEW_LABELS.human }, { name: REVIEW_LABELS.changes }];

  it('re-arms a review:changes bounce → review:pending, dropping review:changes (and #2832 stripping ready-to-merge)', () => {
    const d = decideSetLabel({ to: 'rearm', currentLabels: changes });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.pending);
    // #2832 — re-arm applies review:pending (a hold), so ready-to-merge is stripped in the same swap.
    expect(d.removeLabels).toEqual([REVIEW_LABELS.changes, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL]);
    expect(d.keepsHuman).toBe(false);
  });

  it('NEVER emits review:accepted and NEVER removes review:human (the #2630 invariant)', () => {
    const d = decideSetLabel({ to: 'rearm', currentLabels: humanChanges });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).not.toBe(REVIEW_LABELS.accepted);
    expect(d.removeLabels).toEqual([REVIEW_LABELS.changes, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL]);
    expect(d.removeLabels).not.toContain(REVIEW_LABELS.human);
    expect(d.keepsHuman).toBe(true);
  });

  // #x01u7az — LIVE BUG, PR #2549 (2026-09-24): a `review:human` PR was re-armed after a mechanical
  // `--round=conflict` fix, and this target added `review:pending` ON TOP of the still-live `review:human` —
  // two review:* hold labels on one PR at once, neither ever telling a reader the other exists. At most ONE
  // review:* hold may be live at a time; `review:human` already IS the hold on a gate-self PR, so a rearm there
  // must add NOTHING.
  it('does NOT add review:pending on a review:human PR — the human hold IS already the pending-review state', () => {
    const d = decideSetLabel({ to: 'rearm', currentLabels: humanChanges });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe('');
    expect(d.addLabel).not.toBe(REVIEW_LABELS.pending);
    // Simulate the swap the way the CLI applies it: never leaves human+pending coexisting.
    const removals = presentRemoveLabels(d.removeLabels, humanChanges);
    const after = new Set([...humanChanges.map((l) => l.name).filter((n) => !removals.includes(n)), d.addLabel].filter(Boolean));
    expect(after.has(REVIEW_LABELS.human)).toBe(true);
    expect(after.has(REVIEW_LABELS.pending)).toBe(false);
  });

  it('still adds review:pending on an ordinary (non-gate-self) rearm — only the review:human case changes', () => {
    const d = decideSetLabel({ to: 'rearm', currentLabels: changes });
    expect(d.addLabel).toBe(REVIEW_LABELS.pending);
  });

  it('refuses (idempotent no-op) when there is no review:changes to re-arm', () => {
    expect(decideSetLabel({ to: 'rearm', currentLabels: pending }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'rearm', currentLabels: human }).allowed).toBe(false);
    expect(decideSetLabel({ to: 'rearm', currentLabels: [] }).allowed).toBe(false);
  });

  // #2412 review-fix — same reasoning as the `changes` branch: a re-arm hands a repaired bounce back for a
  // fresh, independent re-review, so a stale redteam:accepted from before the fix must not survive it either.
  it('also strips a stale redteam:accepted', () => {
    const d = decideSetLabel({ to: 'rearm', currentLabels: [...changes, { name: REVIEW_LABELS.redteamAccepted }] });
    expect(d.allowed).toBe(true);
    expect(d.removeLabels).toContain(REVIEW_LABELS.redteamAccepted);
  });
});

// #2895 — the gate-self clearance target. The pair of invariants that matter: `clear-human` is the ONLY target
// that removes review:human, and adding it must not have loosened `accepted` (which stays refused on gate-self).
describe('decideSetLabel — clear-human (#2895, the ONE target that drops review:human)', () => {
  it('clears a gate-self PR: adds accepted, drops human + pending, keepsHuman false', () => {
    const d = decideSetLabel({ to: 'clear-human', currentLabels: human });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
    expect(d.removeLabels).toContain(REVIEW_LABELS.human);
    expect(d.keepsHuman).toBe(false);
  });

  it('also drops a live review:changes — a cleared PR must not still read as a bounce', () => {
    const d = decideSetLabel({ to: 'clear-human', currentLabels: [...human, { name: REVIEW_LABELS.changes }] });
    expect(presentRemoveLabels(d.removeLabels, [...human, { name: REVIEW_LABELS.changes }]))
      .toEqual([REVIEW_LABELS.human, REVIEW_LABELS.changes]);
  });

  it('REFUSES on a PR with no review:human — it is not a backdoor accept for an ordinary parked PR', () => {
    const d = decideSetLabel({ to: 'clear-human', currentLabels: pending });
    expect(d.allowed).toBe(false);
    expect(d.addLabel).toBe('');
    expect(d.reason).toMatch(/no review:human/);
  });

  // The regression that would matter most: adding this target must not have made `accepted` clearable.
  it('did NOT loosen INVARIANT 2 — accepted is still refused on the very same gate-self PR', () => {
    expect(decideSetLabel({ to: 'accepted', currentLabels: human }).allowed).toBe(false);
  });

  // #1920 round-2 review — like `changes`/`rearm`, a `clear-human` clearance must not let a stale independent
  // validator sign-off (no SHA marker of its own) ride through the ceremony from an earlier, different head.
  it('also strips a stale redteam:accepted (unlike the plain `accepted` target — see its own comment)', () => {
    const d = decideSetLabel({ to: 'clear-human', currentLabels: [...human, { name: REVIEW_LABELS.redteamAccepted }] });
    expect(d.allowed).toBe(true);
    expect(d.removeLabels).toContain(REVIEW_LABELS.redteamAccepted);
  });

  // #x01u7az — LIVE BUG, PR #2578 (2026-09-24): advisory:accepted was stamped at 13:29:54Z while the PR was
  // still review:human, then review:human was cleared at 13:38:11Z via clear-human — but the advisory label was
  // left behind and rode through three more review rounds with review:human gone, i.e. with no PR left for it
  // to have meant anything about (`advisory:*` only ever describes a `review:human` PR — see
  // `we:scripts/lib/advisory-labels.mjs`'s own header). `clear-human` must drop it in the SAME write.
  it('also drops advisory:accepted when clearing a gate-self PR — an advisory only means something on review:human', () => {
    const d = decideSetLabel({
      to: 'clear-human',
      currentLabels: [...human, { name: ADVISORY_LABELS.ACCEPTED }],
    });
    expect(d.allowed).toBe(true);
    expect(d.removeLabels).toContain(ADVISORY_LABELS.ACCEPTED);
  });

  it('also drops advisory:changes when clearing a gate-self PR (whichever advisory label is present)', () => {
    const d = decideSetLabel({
      to: 'clear-human',
      currentLabels: [...human, { name: ADVISORY_LABELS.CHANGES }],
    });
    expect(d.allowed).toBe(true);
    expect(d.removeLabels).toContain(ADVISORY_LABELS.CHANGES);
  });

});

// #2895 — the `clear-human` PRECONDITIONS, asserted behaviourally. Two separate things are pinned here and it
// matters that they are not confused:
//   • the `allowClearHuman` opt-in — an ACCIDENT guard. A caller that did not ask for the target gets a clean
//     refusal instead of stumbling into it. It is NOT a trust boundary: it is an ordinary parameter, so an
//     importer that wants it passes it, and #2895 accepted that when it deferred the unforgeable actor signal.
//   • the HONESTY TAX — `--actor` and `--reason` are mandatory, so a clearance nobody authorised takes a
//     fabricated name and a fabricated quote rather than a silent label add. This is the mitigation that
//     replaces the missing signal, so its refusals are load-bearing, not cosmetic.
// Both refuse through the `{"error":…}` JSON contract and BEFORE the first `gh` call, so no network, no mocking.
describe('runReviewLabelCli — the clear-human preconditions (#2895)', () => {
  const CFG = {
    defaultActor: 'test',
    usage: 'usage: test',
    buildComment: () => 'unused',
    successResult: (o) => ({ ok: true, ...o }),
    refusalResult: ({ decision }) => ({ error: decision.reason }),
  };

  /** Run the harness with stdout + process.exit captured. Returns the parsed JSON payload and the exit code. */
  function runCli(cfg) {
    const chunks = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit.bind(process);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = null;
    let threw = null;
    // #3061 — collect through the injected emitter; the CLI drains through `fs.writeSync(1, …)`, which a
    // `process.stdout.write` patch cannot observe.
    try { runReviewLabelCli({ ...CFG, emit: (line) => { chunks.push(String(line)); }, ...cfg }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else threw = e; }
    finally { process.stdout.write = realWrite; process.exit = realExit; }
    if (threw) throw threw;
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  it('a caller that did not opt in REFUSES through the JSON contract, and reaches no gh call', () => {
    const { exitCode, payload } = runCli({ argv: ['1048', '--repo=o/n', '--to=clear-human'] });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/did not opt in/);
  });

  // m1 — a caller PINNING the target skipped the `!fixedTo &&`-guarded validation entirely in the first cut and
  // blew up with a TypeError after `gh pr view`. Every clear-human precondition is checked at the point of use.
  it('a caller PINNING fixedTo:clear-human refuses too — not a TypeError, and not after a gh mutation', () => {
    const { exitCode, payload } = runCli({ argv: ['1048', '--repo=o/n'], fixedTo: 'clear-human' });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/did not opt in/);
  });

  // THE HONESTY TAX, refusal 1 of 2. The default actor must NOT satisfy it: the record has to name whoever
  // asked, and 'loop-console operator' names nobody.
  it('REFUSES an opted-in clear-human with no --actor — the default actor is not an answer', () => {
    const { exitCode, payload } = runCli({
      argv: ['1048', '--repo=o/n', '--to=clear-human', '--reason=operator said accept 1048'],
      allowClearHuman: true,
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/requires an explicit --actor/);
  });

  // THE HONESTY TAX, refusal 2 of 2. A blank/whitespace reason is the same as none — otherwise `--reason=` is a
  // one-character way to satisfy the thing whose whole purpose is that it has to be written out.
  it('REFUSES an opted-in clear-human with no stated reason, including a whitespace-only one', () => {
    for (const reasonArg of [[], ['--reason='], ['--reason=   ']]) {
      const { exitCode, payload } = runCli({
        argv: ['1048', '--repo=o/n', '--to=clear-human', '--actor=Nicolas Gilbert', ...reasonArg],
        allowClearHuman: true,
      });
      expect(exitCode).not.toBe(0);
      expect(payload.error).toMatch(/requires --reason/);
    }
  });

  it('the ordinary targets are unaffected — the opt-in gates clear-human only', () => {
    const { payload } = runCli({ argv: ['1048', '--repo=o/n', '--to=nonsense'] });
    expect(payload.error).toMatch(/invalid --to — expected 'accepted' or 'changes'/);
  });
});

describe('presentRemoveLabels — intersect the decision removals with the labels actually present', () => {
  it('a removeLabel NOT in currentLabels is not passed through (never handed to gh)', () => {
    // changes wants to drop [pending, accepted, ready-to-merge], but this PR carries only pending +
    // ready-to-merge → accepted must not survive; #2832: the go-ahead IS carried, so it is stripped.
    const d = decideSetLabel({ to: 'changes', currentLabels: pending });
    const removals = presentRemoveLabels(d.removeLabels, pending);
    expect(removals).toEqual([REVIEW_LABELS.pending, READY_TO_MERGE_LABEL]);
    expect(removals).not.toContain(REVIEW_LABELS.accepted);
  });

  it('keeps only present labels when both are carried', () => {
    const carries = [{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.accepted }];
    const d = decideSetLabel({ to: 'changes', currentLabels: carries });
    expect(presentRemoveLabels(d.removeLabels, carries)).toEqual([REVIEW_LABELS.pending, REVIEW_LABELS.accepted]);
  });

  it('never intersects review:human into the removals on a bounce', () => {
    const d = decideSetLabel({ to: 'changes', currentLabels: human });
    expect(presentRemoveLabels(d.removeLabels, human)).not.toContain(REVIEW_LABELS.human);
  });
});

describe('#2832 — decideSetLabel keeps ready-to-merge self-consistent with the review-hold family', () => {
  const readyPending = [{ name: REVIEW_LABELS.pending }, { name: READY_TO_MERGE_LABEL }];
  const readyAccepted = [{ name: 'review:pending' }, { name: READY_TO_MERGE_LABEL }];
  const readyChanges = [{ name: REVIEW_LABELS.changes }, { name: READY_TO_MERGE_LABEL }];

  it('changes (a hold) atomically strips ready-to-merge alongside the review labels', () => {
    const d = decideSetLabel({ to: 'changes', currentLabels: readyPending });
    expect(d.addLabel).toBe(REVIEW_LABELS.changes);
    expect(d.removeLabels).toContain(READY_TO_MERGE_LABEL);
    // and once narrowed to the labels actually carried, ready-to-merge is really dropped
    expect(presentRemoveLabels(d.removeLabels, readyPending)).toContain(READY_TO_MERGE_LABEL);
  });

  it('rearm (→ review:pending, a hold) atomically strips ready-to-merge', () => {
    const d = decideSetLabel({ to: 'rearm', currentLabels: readyChanges });
    expect(d.addLabel).toBe(REVIEW_LABELS.pending);
    expect(presentRemoveLabels(d.removeLabels, readyChanges)).toContain(READY_TO_MERGE_LABEL);
  });

  it('accepted CLEARS the hold, so ready-to-merge is a consistent go-ahead → NOT stripped', () => {
    const d = decideSetLabel({ to: 'accepted', currentLabels: readyAccepted });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.accepted);
    expect(d.removeLabels).not.toContain(READY_TO_MERGE_LABEL);
    expect(presentRemoveLabels(d.removeLabels, readyAccepted)).not.toContain(READY_TO_MERGE_LABEL);
  });
});

describe('decideSetLabel — bad input', () => {
  it('throws on an unknown verdict', () => {
    expect(() => decideSetLabel({ to: 'merge', currentLabels: neither })).toThrow();
    expect(() => decideSetLabel({ to: undefined, currentLabels: neither })).toThrow();
  });
});

describe('buildVerdictComment — the stamp must survive the REAL reader (#2882/#2409)', () => {
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  const OLDER = '0123456789abcdef0123456789abcdef01234567';
  // Round-trip through the actual consumer, never a string-position assertion. The first cut of #2882 asserted
  // `indexOf(SHA) < indexOf(older)` and passed while being WRONG: parseReviewedSha is last-match-wins, so the
  // leading stamp lost to a quoted marker. Verifying producer and consumer independently is what hid it.
  const readBack = (comment) => parseReviewedSha([{ body: comment }]);

  it('round-trips to the stamped sha even when the body quotes an OLDER marker', () => {
    const comment = buildVerdictComment({
      to: 'accepted', actor: 'op', headSha: SHA,
      body: `re-accepting; the prior round covered <!-- reviewed-sha: ${OLDER} -->, the head only moved by rebase`,
    });
    expect(readBack(comment)).toBe(SHA);
  });

  it('round-trips when the body quotes SEVERAL markers, including one at the very end', () => {
    const comment = buildVerdictComment({
      to: 'accepted', actor: 'op', headSha: SHA,
      body: `first <!-- reviewed-sha: ${OLDER} --> and last <!-- reviewed-sha: ${'a'.repeat(40)} -->`,
    });
    expect(readBack(comment)).toBe(SHA);
  });

  it('neutralises quoted markers but keeps them READABLE — the write-up still says what it meant', () => {
    const out = neutralizeCommentMarkers(`prior round: <!-- reviewed-sha: ${OLDER} -->`);
    expect(out).toContain(OLDER);
    expect(out).toContain('reviewed-sha');
    expect(out).not.toContain('<!--');
  });

  it('reads back nothing on a changes verdict, even with a quoted marker in the body', () => {
    const comment = buildVerdictComment({
      to: 'changes', actor: 'op', headSha: SHA, body: `see <!-- reviewed-sha: ${OLDER} -->`,
    });
    expect(readBack(comment)).toBe(null);
    expect(comment).toContain('🔁 review — changes requested');
  });

  it('stamps nothing (never a garbage marker) when the head SHA is unavailable', () => {
    expect(readBack(buildVerdictComment({ to: 'accepted', actor: 'op', headSha: '' }))).toBe(null);
    expect(readBack(buildVerdictComment({ to: 'accepted', actor: 'op', headSha: 'not-a-sha' }))).toBe(null);
  });

  it('includes the caller body, and stays the one-liner when none is passed', () => {
    const withBody = buildVerdictComment({ to: 'accepted', actor: 'op', headSha: SHA, body: '## Findings\n1 major' });
    expect(withBody).toContain('## Findings');
    expect(readBack(withBody)).toBe(SHA);
    const bare = buildVerdictComment({ to: 'accepted', actor: 'op', headSha: SHA });
    // #2898 — with no `channel` the sentence names the ACTOR and no surface at all. It used to name the
    // Plateau Loop review console unconditionally; see the attribution suite below.
    expect(bare).toContain('Recorded by op.');
    expect(readBack(bare)).toBe(SHA);
  });

  // #x9xqexm — the CONTRIBUTION stamp. Without it the drain has only the base-dependent `reviewed-diff` digest,
  // which changes whenever `main` moves a context line or a hunk offset under the lane — so the drain's own
  // rebase-drop pass revokes the clearance within minutes (observed on PR #1100, 3m07s after `--to=clear-human`).
  describe('the contribution stamp (#x9xqexm)', () => {
    const DIFF = ['diff --git a/f.mjs b/f.mjs', 'index 111..222 100644', '@@ -1,2 +1,2 @@', ' ctx', '-a', '+b'].join('\n');

    it('BOTH acceptance targets stamp sha + diff + contribution, all three round-tripping', () => {
      for (const to of ['accepted', 'clear-human']) {
        const c = buildVerdictComment({ to, actor: 'op', headSha: SHA, reason: 'r', reviewedDiff: DIFF });
        expect(parseReviewedSha([{ body: c }])).toBe(SHA);
        expect(parseReviewedDiff([{ body: c }])).toBe(normalizeDiffFingerprint(DIFF));
        expect(parseReviewedContribution([{ body: c }])).toBe(normalizeContributionFingerprint(DIFF));
      }
    });

    it('the two digests are DISTINCT values — a contribution stamp is not a re-spelling of the diff stamp', () => {
      expect(normalizeContributionFingerprint(DIFF)).not.toBe(normalizeDiffFingerprint(DIFF));
    });

    it('a `changes` verdict stamps neither, and an unreadable diff stamps no contribution marker', () => {
      const bounce = buildVerdictComment({ to: 'changes', actor: 'op', headSha: SHA, reviewedDiff: DIFF });
      expect(parseReviewedContribution([{ body: bounce }])).toBe(null);
      // The fail-soft path: `computeNetDiffText` missed, so `reviewedDiff` is '' — the sha still stamps and the
      // gate falls back to SHA identity, which is the STRICTER behaviour.
      const noDiff = buildVerdictComment({ to: 'clear-human', actor: 'op', headSha: SHA, reason: 'r' });
      expect(parseReviewedSha([{ body: noDiff }])).toBe(SHA);
      expect(parseReviewedContribution([{ body: noDiff }])).toBe(null);
    });

    it('the size pre-flight counts the markers it now posts — never an under-count (#1056 M2 class)', () => {
      const body = 'y'.repeat(1000);
      const actual = buildVerdictComment({
        to: 'clear-human', actor: 'op', headSha: SHA, body, reason: 'r', reviewedDiff: DIFF,
      }).length;
      expect(projectVerdictCommentLength({ body, actor: 'op', reason: 'r' })).toBeGreaterThanOrEqual(actual);
    });
  });
});

// PR #1056 review, M2 — ENUM TOTALITY over the label-swap target set. The `GH_COMMENT_MAX` pre-flight exists to
// guarantee the durable comment can actually POST before the label swap is applied, because the failure mode is
// the worst one this module has: label applied, comment rejected, PR left `review:accepted` with NO
// `reviewed-sha` marker — and `acceptanceCoversHead` fails OPEN on a missing marker, silently disarming the
// staleness gate. The first cut projected `to: 'accepted'` only, so a `clear-human` comment (a longer heading
// plus its attribution) was under-counted and a body just under the cap walked straight into that state. This
// asserts the projection is an UPPER BOUND over EVERY target AND over the other unbounded argv inputs (`actor`,
// `reason`), so neither a new target nor a long free-text field can re-open the hole.
describe('projectVerdictCommentLength — total over REVIEW_LABEL_TARGETS (#1056 M2)', () => {
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  const ACTOR = 'Nicolas Gilbert';
  const REASON = 'operator in-session: "accept 1048"';

  it('has at least one target it must cover, and covers the whole declared set', () => {
    expect(REVIEW_LABEL_TARGETS.length).toBeGreaterThan(0);
    expect(REVIEW_LABEL_TARGETS).toContain('clear-human');
  });

  for (const to of REVIEW_LABEL_TARGETS) {
    it(`projected >= actual for to='${to}' — the pre-flight can never under-count it`, () => {
      for (const body of ['', 'x', '## Findings\n\nsomething\n', 'y'.repeat(60000)]) {
        const actual = buildVerdictComment({ to, actor: ACTOR, headSha: SHA, body, reason: REASON }).length;
        expect(projectVerdictCommentLength({ body, actor: ACTOR, reason: REASON }))
          .toBeGreaterThanOrEqual(actual);
      }
    });
  }

  // The concrete regression: a body sized so `accepted` fits under the cap but `clear-human` does not. Under the
  // first cut this passed the pre-flight; it must now be rejected.
  it('rejects the band where accepted fits but clear-human does not — the exact M2 window', () => {
    const at = (to, n) => buildVerdictComment({
      to, actor: ACTOR, headSha: 'f'.repeat(40), body: 'y'.repeat(n), reason: REASON,
    });
    // Solve for the body that renders to exactly the cap as `accepted` (the chrome is a fixed additive amount,
    // so one correction step lands it exactly — asserted below rather than assumed).
    const guess = GH_COMMENT_MAX - at('accepted', 0).length;
    const n = guess - (at('accepted', guess).length - GH_COMMENT_MAX);
    expect(at('accepted', n).length).toBe(GH_COMMENT_MAX);
    expect(at('clear-human', n).length).toBeGreaterThan(GH_COMMENT_MAX);
    expect(projectVerdictCommentLength({ body: 'y'.repeat(n), actor: ACTOR, reason: REASON }))
      .toBeGreaterThan(GH_COMMENT_MAX);
  });

  // The second dimension the first cut missed: `--actor` and `--reason` are argv, so they are unbounded too. A
  // fixed-width placeholder in the projection would under-count exactly the same way the fixed target did.
  it('covers a long actor and a long reason — both are unbounded argv, not fixed-width chrome', () => {
    const body = 'y'.repeat(1000);
    const actor = 'a'.repeat(4000);
    const reason = 'r'.repeat(8000);
    const actual = buildVerdictComment({ to: 'clear-human', actor, headSha: SHA, body, reason }).length;
    expect(projectVerdictCommentLength({ body, actor, reason })).toBeGreaterThanOrEqual(actual);
    // and the short-input projection would have MISSED it — that is the whole point of passing them through.
    expect(projectVerdictCommentLength({ body })).toBeLessThan(actual);
  });
});

// #2898 — THE CHANNEL. The record used to assert the Plateau Loop review console for every caller. It was
// caught in the wild on PR #1146, whose comment credited the console in one sentence and the declared
// `review-pr` operation in another, three lines apart. The DoD is exactly these three properties.
describe('buildVerdictComment — the attribution states the surface it came through (#2898)', () => {
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  const render = (o) => buildVerdictComment({ to: 'accepted', actor: 'op', headSha: SHA, ...o });

  it('renders the channel it is GIVEN, and a different caller renders a different one', () => {
    const viaOperation = render({ channel: 'the declared `review-pr` operation (#3035)' });
    const viaConsole = render({ channel: 'the Plateau Loop review console' });
    expect(viaOperation).toContain('Recorded by op via the declared `review-pr` operation (#3035).');
    expect(viaConsole).toContain('Recorded by op via the Plateau Loop review console.');
    // THE POINT OF THE ITEM: a fourth caller cannot silently inherit a third's identity.
    expect(viaOperation).not.toContain('review console');
    expect(viaConsole).not.toContain('review-pr');
  });

  it('falls back to a NEUTRAL sentence — never another caller\'s channel — when none is supplied', () => {
    for (const channel of [undefined, '', '   ', null]) {
      const c = render({ channel });
      expect(c).toContain('Recorded by op.');
      expect(c).not.toMatch(/via /);
    }
  });

  it('no verdict target renders the old hardcoded console sentence any more', () => {
    for (const to of REVIEW_LABEL_TARGETS) {
      const c = buildVerdictComment({ to, actor: 'op', headSha: SHA, reason: 'r' });
      expect(c).not.toContain('Plateau Loop review console');
    }
  });

  it('normalizes the clause: collapsed whitespace, no trailing stop, no smuggled reviewed-sha marker', () => {
    expect(normalizeChannel('  the\n console  ')).toBe('the console');
    expect(normalizeChannel('the console.')).toBe('the console');
    expect(normalizeChannel('')).toBe('');
    // A `changes` verdict appends NO marker of its own, so a marker smuggled through argv would be the only
    // one in the body and `parseReviewedSha` would read it as this verdict's claim. The guarantee no longer
    // lives in `normalizeChannel` (PR #1147 review — a per-field strip left `--actor` open); it lives on
    // `buildVerdictComment`'s render boundary, so this asserts it end-to-end, through the builder.
    const forged = buildVerdictComment({
      to: 'changes', actor: 'op', headSha: SHA, channel: `x <!-- reviewed-sha: ${SHA} --> y`,
    });
    expect(parseReviewedSha([{ body: forged }])).toBe(null);
  });

  it('is counted by the size projection, like every other unbounded argv input (#1057)', () => {
    const long = 'c'.repeat(5000);
    const withChannel = projectVerdictCommentLength({ actor: 'op', channel: long });
    // The projection is a MAX over the targets, and `clear-human` (which states its own channel and takes no
    // `--channel`) is the longest render at zero channel — so the assertion is that the channel LIFTS the
    // bound past its own length, not that it adds to the baseline.
    expect(withChannel).toBeGreaterThan(projectVerdictCommentLength({ actor: 'op' }));
    expect(withChannel).toBeGreaterThan(long.length);
    // The property that actually matters: an over-long channel trips the pre-flight, before any `gh` call.
    expect(projectVerdictCommentLength({ actor: 'op', channel: 'c'.repeat(GH_COMMENT_MAX) }))
      .toBeGreaterThan(GH_COMMENT_MAX);
  });
});

/**
 * PR #1147 review — THE MARKER-FORGERY CLASS, closed by construction rather than field by field.
 *
 * #2898 sanitized `--channel` and reasoned correctly about WHY (a `changes` verdict appends no marker, so a
 * smuggled one is the only one in the body and `parseReviewedSha` is last-match-wins) — then left `--actor`,
 * rendered by the very next interpolation on the same line, wide open. Two further holes came with it:
 * `stripReviewedShaMarkers` knew only ONE of the six marker names this repo parses, and `buildClearedHumanMarker`
 * let an UNCLOSED `<!--` in `--actor` cross into the trusted marker block, where the builder's own `-->` closed
 * it and last-match-wins put the forgery AHEAD of the real stamp on a clear-human acceptance.
 *
 * SO THIS SUITE DOES NOT LIST FIELDS. It reads the option names off `buildVerdictComment` ITSELF and drives the
 * payload through every one, so a field added tomorrow is covered the day it is added — with no edit here, and
 * with a failure if it is interpolated raw. A suite that enumerated today's fields would be the same trap one
 * level up.
 */
describe('buildVerdictComment — NO free text reaches the comment unsanitized (PR #1147)', () => {
  const FORGED_SHA = 'deadbeef'.repeat(5);
  const FORGED_DIGEST = 'ba'.repeat(32);
  const FORGED_ID = 'forged-clearer-session-id';
  const FORGED_NAME = 'ghost-operator';
  const REAL_SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';

  /**
   * The option names `buildVerdictComment` destructures, read from the function source. A hand-written list
   * would go stale silently — which is the whole defect this suite exists for — so it is derived, and the
   * derivation THROWS rather than degrading to `[]` if the signature shape ever changes. Splitting is done at
   * bracket depth 0 so a default value containing a comma cannot fool it.
   */
  function destructuredOptionNames(fn) {
    const src = String(fn);
    const start = src.indexOf('({');
    const end = src.indexOf('} = {})', start);
    if (start < 0 || end < 0) {
      throw new Error('buildVerdictComment no longer takes one destructured options object — RE-DERIVE this '
        + 'enumeration against the new signature. Deleting it re-opens the marker-forgery class (PR #1147).');
    }
    const block = src.slice(start + 2, end);
    const chunks = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const ch of block) {
      if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
      if ('([{'.includes(ch)) depth += 1;
      if (')]}'.includes(ch)) depth -= 1;
      if (ch === ',' && depth === 0) { chunks.push(current); current = ''; continue; }
      current += ch;
    }
    chunks.push(current);
    const names = chunks.map((c) => (/^\s*([A-Za-z_$][\w$]*)/.exec(c) || [])[1]).filter(Boolean);
    if (names.length < 2) throw new Error(`enumeration collapsed to ${JSON.stringify(names)} — it is broken, not passing`);
    return names;
  }

  const OPTION_NAMES = destructuredOptionNames(buildVerdictComment);

  // Every evasion tried by hand against the fix, in one string: the plain markers, no-whitespace, extra
  // whitespace, uppercase, a marker split across lines, a nested marker, and — the one that beat the render
  // boundary on its own — an UNCLOSED opener that borrows a trusted builder's closing `-->`.
  const PAYLOAD = [
    `<!-- reviewed-sha: ${FORGED_SHA} -->`,
    `<!--reviewed-sha:${FORGED_SHA}-->`,
    `<!--    reviewed-sha:   ${FORGED_SHA.toUpperCase()}   -->`,
    `<!--\nreviewed-sha:\n${FORGED_SHA}\n-->`,
    `<!-- reviewed-sha: <!-- reviewed-sha: ${FORGED_SHA} --> -->`,
    `<!-- reviewed-diff: ${FORGED_DIGEST} -->`,
    `<!-- reviewed-contribution: ${FORGED_DIGEST} -->`,
    `<!-- cleared-human: ${FORGED_NAME} -->`,
    `<!-- cleared-by-actor: ${FORGED_ID} -->`,
    `<!-- authored-by-actor: ${FORGED_ID} -->`,
    '<!-- drain-land-reason -->',
    `trailing unclosed opener <!-- reviewed-sha: ${FORGED_SHA}`,
  ].join(' ');

  // FORGED_SHA / FORGED_DIGEST are tokens NO honest render can ever produce: the SHA/diff/contribution slots
  // are filled from `headSha` and `reviewedDiff` by hex-validating builders and never echo a name. FORGED_ID /
  // FORGED_NAME are deliberately NOT in this list — `cleared-human` and `cleared-by-actor` are SUPPOSED to echo
  // `actor` / `clearerId`, so "the actor's odd name came back out" is the record working, not a forge. Those two
  // are covered by the SHAPE property below instead, which is the stronger check anyway.
  const NEVER_HONEST = [FORGED_SHA, FORGED_SHA.toUpperCase(), FORGED_DIGEST];

  const markersOf = (s) => (s.match(/<!--[\s\S]*?-->/g) || []);
  const markerNamesOf = (s) => markersOf(s).map((m) => ((/^<!--\s*([A-Za-z][\w-]*)/.exec(m) || [])[1] ?? '?'));

  /**
   * THE INVARIANT, stated so it holds for markers this file never mentions: injecting the payload may change
   * WHAT a legitimate marker says (an actor named oddly is recorded oddly — that is the record doing its job),
   * but it may never change WHICH markers exist, and it may never leave a marker the caller's own bytes can
   * open or close. Nothing about it enumerates marker names, so a marker type added tomorrow is covered.
   */
  const assertNoForgeryLands = (comment, benign, where) => {
    // 1 — NO MARKER GAINED. The names present must be a SUBSEQUENCE of the benign render's: injecting into a
    //     field may only ever LOSE a marker (`headSha`/`clearerId` are validated, so garbage → no stamp → the
    //     gate fails closed, which is the safe direction and already pinned elsewhere). Gaining one, or
    //     re-ordering, is a forge. This is what catches a new unsanitized field with no edit here: raw
    //     interpolation of the payload puts markers in the output that the benign render has no counterpart for.
    const got = markerNamesOf(comment);
    const want = markerNamesOf(benign);
    let cursor = 0;
    for (const name of got) {
      cursor = want.indexOf(name, cursor);
      expect(cursor, `${where} · marker "${name}" is not one the benign render stamps (got [${got}] vs [${want}])`)
        .toBeGreaterThanOrEqual(0);
      cursor += 1;
    }
    // 2 — WELL FORMED, NOT NESTED. No `<` or `>` may survive INSIDE a marker: a nested `<!--` re-opens, and a
    //     stray `>` closes early. This is the property `buildClearedHumanMarker` broke.
    for (const raw of markersOf(comment)) expect(raw, `${where} · marker shape`).toMatch(/^<!--[^<>]*-->$/);
    // 3 — NO DANGLING OPENER. An unclosed `<!--` in free text borrows the NEXT marker's `-->`; that is exactly
    //     how `--actor` reached past the render boundary before the fix.
    expect((comment.match(/<!--/g) || []).length, `${where} · openers`).toBe(markersOf(comment).length);
    // 4 — THE ESCALATION ITSELF. The three CONTENT-fingerprint parsers gate the drain, and none of them ever
    //     echoes a caller-supplied name, so a forged token surfacing there is unambiguously a forge. The
    //     IDENTITY parsers (`cleared-human` / `cleared-by-actor` / `authored-by-actor`) are excluded on purpose:
    //     they are SUPPOSED to return the actor the caller named, so "the odd name came back out" is the record
    //     working. Their integrity is what checks 1–3 assert, which is the stronger statement anyway — the
    //     bytes can be odd, but they can never BE or OPEN a marker.
    const read = {
      reviewedSha: parseReviewedSha([{ body: comment }]),
      reviewedDiff: parseReviewedDiff([{ body: comment }]),
      reviewedContribution: parseReviewedContribution([{ body: comment }]),
    };
    for (const [parser, value] of Object.entries(read)) {
      for (const forged of NEVER_HONEST) {
        expect(`${where} · ${parser} · ${String(value ?? '')}`).not.toContain(forged);
      }
    }
    // 5 — the identity parsers are still READ, so a crash or a runaway scan would surface here rather than
    //     going unexercised; their VALUES are judged by the clearance test below.
    parseClearerActorId([{ body: comment }]);
    parseAuthorActorId(comment);
    readAuthorActorStamps(comment);
    return read;
  };

  it('enumerates the builder\'s own option names rather than a hand-written list', () => {
    // A sanity floor only: the ASSERTION is that the derivation works, not that these are all there are. A new
    // field lands in `OPTION_NAMES` automatically and is driven by the suite below with no edit here.
    expect(OPTION_NAMES).toEqual(expect.arrayContaining(['to', 'actor', 'headSha', 'body', 'reason', 'channel']));
    expect(destructuredOptionNames(buildVerdictComment).length).toBe(OPTION_NAMES.length);
  });

  // A realistic baseline, so every verdict renders its FULL shape (all trusted markers present) and the payload
  // has real markers to try to outrank rather than an empty field to be the only marker in.
  const baseArgs = (to) => ({
    to, actor: 'op', headSha: REAL_SHA, reason: 'a reason', reviewedDiff: 'diff --git a/x b/x\n+one\n',
    clearerId: 'real-clearer', channel: 'the console',
  });

  it.each(REVIEW_LABEL_TARGETS)('no single option forges a marker on a `%s` verdict', (to) => {
    const benign = buildVerdictComment(baseArgs(to));
    for (const name of OPTION_NAMES) {
      if (name === 'to') continue; // the verdict target is a closed vocabulary, iterated by the `each` above
      const args = { ...baseArgs(to), [name]: PAYLOAD };
      assertNoForgeryLands(buildVerdictComment(args), benign, `to=${to} field=${name}`);
    }
  });

  it.each(REVIEW_LABEL_TARGETS)('no COMBINATION of options forges a marker on a `%s` verdict', (to) => {
    const args = { ...baseArgs(to) };
    for (const name of OPTION_NAMES) if (name !== 'to') args[name] = PAYLOAD;
    args.headSha = REAL_SHA; // keep the real stamp present, so the payload has something to try to outrank
    args.reviewedDiff = 'diff --git a/x b/x\n+one\n';
    args.independence = { independent: false, status: 'unknown-author', reason: PAYLOAD };
    const benign = buildVerdictComment({
      ...baseArgs(to), independence: { independent: false, status: 'unknown-author', reason: 'why' },
    });
    assertNoForgeryLands(buildVerdictComment(args), benign, `to=${to} field=<all>`);
  });

  it.each(REVIEW_LABEL_TARGETS)('a `%s` verdict never acquires a clearance record it did not stamp', (to) => {
    const args = { ...baseArgs(to) };
    for (const name of OPTION_NAMES) if (name !== 'to') args[name] = PAYLOAD;
    const clearance = parseOperatorClearance([{ body: buildVerdictComment(args) }]);
    // `clear-human` stamps one (naming the actor, however odd the name); nothing else may have one at all.
    if (to === 'clear-human') expect(clearance).not.toBe(null);
    else expect(clearance).toBe(null);
  });

  it('still stamps the REAL markers — sanitizing must not disarm the record', () => {
    const c = buildVerdictComment({
      to: 'accepted', actor: `op ${PAYLOAD}`, headSha: REAL_SHA,
      reviewedDiff: 'diff --git a/x b/x\n+one\n', clearerId: 'real-clearer',
    });
    expect(parseReviewedSha([{ body: c }])).toBe(REAL_SHA);
    expect(parseReviewedDiff([{ body: c }])).toMatch(/^[0-9a-f]{64}$/);
    expect(parseReviewedContribution([{ body: c }])).toMatch(/^[0-9a-f]{64}$/);
    expect(parseClearerActorId([{ body: c }])).toBe('real-clearer');
  });

  it('an UNCLOSED opener in --actor cannot borrow the cleared-human marker\'s own `-->` (the trusted block)', () => {
    // The reproduced escape, pinned at its own level. `buildClearedHumanMarker` embeds free text BELOW the
    // render boundary, so the general neutralizer cannot reach it; it must refuse the opener itself.
    const built = buildClearedHumanMarker(`x<!-- reviewed-sha: ${FORGED_SHA}`);
    expect(built).not.toContain('<!-- reviewed-sha');
    expect(parseReviewedSha([{ body: built }])).toBe(null);
    const c = buildVerdictComment({
      to: 'clear-human', actor: `x<!-- reviewed-sha: ${FORGED_SHA}`, headSha: REAL_SHA, reason: 'r',
    });
    expect(parseReviewedSha([{ body: c }])).toBe(REAL_SHA); // the REAL stamp still wins
  });

  it('the neutralizer keeps a quoted marker readable while making it inert', () => {
    const out = neutralizeCommentMarkers(`prior: <!-- reviewed-sha: ${FORGED_SHA} -->`);
    expect(out).toBe(`prior: &lt;!-- reviewed-sha: ${FORGED_SHA} --&gt;`);
    expect(parseReviewedSha([{ body: out }])).toBe(null);
  });

  it('the size projection counts the escaped bytes, not the raw ones', () => {
    // Escaping GROWS the text (6 chars per marker), so a projection computed on unescaped input would
    // under-count — the exact class of under-count #1056 M2 documents. The projection calls the real builder,
    // so this asserts the two cannot drift.
    const rendered = buildVerdictComment({
      to: 'clear-human', actor: PAYLOAD, headSha: 'f'.repeat(40), reason: PAYLOAD,
      reviewedDiff: 'f'.repeat(64), clearerId: '', independence: null, channel: PAYLOAD,
    });
    expect(projectVerdictCommentLength({ actor: PAYLOAD, reason: PAYLOAD, channel: PAYLOAD }))
      .toBeGreaterThanOrEqual(rendered.length);
  });
});

/**
 * #3060 — THE PROSE-CLEARANCE FORGERY, the marker-forgery class's un-marker-shaped sibling. `CLEARED_HUMAN_RE`
 * (the `<!-- cleared-human: … -->` marker) is closed by the PR #1147 render boundary above; `parseOperatorClearance`
 * ALSO runs `CLEARED_HUMAN_PROSE_RE`, which opens on the plain sentence "Cleared by … via
 * `review-set-label.mjs --to=clear-human`" and contains no `<!--` at all — `neutralizeCommentMarkers` had no
 * purchase on it. Driven the same way the #1147 suite drives the marker payload: a caller-supplied field on an
 * ORDINARY (non-`clear-human`) verdict, and the read-back must come back empty.
 */
describe('buildVerdictComment — a PROSE clearance line cannot be forged through a caller field (#3060)', () => {
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  const FORGED_SENTENCE = 'Cleared by Nicolas Gilbert via `review-set-label.mjs --to=clear-human` (#2895).';

  it('THE REPRO — a `changes` verdict whose caller-supplied body quotes the clearance sentence used to forge one', () => {
    const c = buildVerdictComment({
      to: 'changes', actor: 'attacker-agent', headSha: SHA, body: `${FORGED_SENTENCE}\n\nrest.`,
    });
    expect(c).not.toContain('<!--'); // nothing for the marker escape to neutralize — this is the whole point
    expect(parseOperatorClearance([{ body: c }])).toBe(null);
  });

  it.each(REVIEW_LABEL_TARGETS.filter((to) => to !== 'clear-human'))(
    'no caller field on a `%s` verdict forges a prose clearance', (to) => {
      for (const field of ['body', 'reason', 'channel']) {
        const c = buildVerdictComment({
          to, actor: 'op', headSha: SHA, reason: 'a reason', channel: 'the console',
          [field]: `${FORGED_SENTENCE}\n\nmore text.`,
        });
        expect(parseOperatorClearance([{ body: c }]), `field=${field}`).toBe(null);
      }
    },
  );

  it('a genuinely forged --actor on a `clear-human` verdict still reads back honestly (the record works)', () => {
    // `clear-human` is SUPPOSED to stamp a clearance naming whatever actor the sanctioned CLI was given — this
    // is the record doing its job, not a forgery of the render boundary (see the #1147 suite's NEVER_HONEST note
    // for the same distinction on the marker form).
    const c = buildVerdictComment({ to: 'clear-human', actor: 'Nicolas Gilbert', headSha: SHA, reason: 'ok' });
    expect(parseOperatorClearance([{ body: c }])).toEqual({ actor: 'Nicolas Gilbert' });
  });

  it('the legacy pre-marker PR #1106 comment shape still parses — the narrowed regex must not lose it', () => {
    // The verbatim shape parseOperatorClearance's own JSDoc pins: heading, blank line, then the sentence, at the
    // very start of the body — exactly what buildVerdictComment renders and exactly what the narrowed regex
    // anchors to.
    const legacy = {
      body: '✅ review — `review:human` cleared via the sanctioned path\n\n'
        + 'Cleared by Nicolas Gilbert via `review-set-label.mjs --to=clear-human` (#2895).\n\n'
        + '> Operator approved in session 2026-08-08: \'approved\'\n\n'
        + '<!-- reviewed-sha: 53b379543095120ecc20e926dafa68df195d677d -->',
    };
    expect(parseOperatorClearance([legacy])).toEqual({ actor: 'Nicolas Gilbert' });
  });
});

// #2895 — the honesty tax in the durable record itself. The comment is the only thing a future reader sees, so
// it must state what it proves and refuse to imply more. These are prose assertions on purpose: this is the
// exact class of over-claim that dogged PR #1046 for four rounds and #1056 for three.
describe('buildVerdictComment — a clear-human record must not over-claim (#2895)', () => {
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  const render = (o) => buildVerdictComment({
    to: 'clear-human', actor: 'Nicolas Gilbert', headSha: SHA,
    reason: 'operator in-session: "accept 1048"', ...o,
  });

  it('quotes the stated reason verbatim and names the actor', () => {
    const c = render({});
    expect(c).toMatch(/Nicolas Gilbert/);
    expect(c).toMatch(/> operator in-session: "accept 1048"/);
  });

  it('says the sanctioned path was followed and explicitly NOT that a human followed it', () => {
    const c = render({});
    expect(c).toMatch(/does NOT prove: that a human performed/i);
    expect(c).toMatch(/free text and nothing verifies/i);
  });

  it('makes no unforgeability claim anywhere — no "cannot", no terminal confirmation, no structural barrier', () => {
    const c = render({ body: '## Findings\n\nall good\n' });
    expect(c).not.toMatch(/confirmed at a terminal/i);
    expect(c).not.toMatch(/no agent can/i);
    expect(c).not.toMatch(/unforgeable(?! actor signal)/i);
    expect(c).not.toMatch(/structural/i);
  });

  it('still stamps the reviewed-sha marker — the clearance IS an acceptance (#2409)', () => {
    expect(parseReviewedSha([{ body: render({}) }])).toBe(SHA);
  });
});

// PR #1057 review — WHERE the size guard is called, which is a different claim from whether the projection is
// correct. The projection above was already total (no target could be under-counted); the defect was that its ONE
// call site sat inside the CLI's `if (bodyFileArg)` branch, so `--reason` — a second unbounded free-text input,
// added later — walked around it whenever no `--body-file` was passed. Reproduced against a `gh` that enforces
// GitHub's cap: `gh pr edit` landed (review:human removed), `gh pr comment` was rejected, and the PR was left
// ACCEPTED with no `reviewed-sha` marker — the fail-OPEN state the pre-flight exists to prevent, made worse by
// `clear-human` then refusing to re-run ("nothing to clear"). Hermetic: a fake `gh` on PATH records every call,
// so "refused before any gh call" and "refused before the SWAP" are both observable rather than asserted.
describe('the GH_COMMENT_MAX guard is reachable-around by nothing (PR #1057)', () => {
  const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, a.slice(0, 2).join(' ') + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({ labels: [{ name: 'review:human' }], headRefOid: 'f'.repeat(40), state: 'OPEN' }));
  process.exit(0);
}
process.exit(0);
`;
  let shimDir;
  let logPath;

  beforeAll(() => {
    shimDir = mkdtempSync(join(tmpdir(), 'review-label-shim-'));
    writeFileSync(join(shimDir, 'gh'), FAKE_GH);
    chmodSync(join(shimDir, 'gh'), 0o755);
    logPath = join(shimDir, 'gh-calls.log');
  });
  afterAll(() => { try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  const ghCalls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
  beforeEach(() => { try { rmSync(logPath, { force: true }); } catch { /* first run */ } });

  // THE UNCOVERED BOUNDARY CASE: a long `--reason` and NO `--body-file`. Drives the REAL entrypoint, because the
  // hole was in the entrypoint's control flow — an in-process call to the harness would have missed it entirely.
  it('a long --reason with NO --body-file is refused, and reaches no gh call at all', () => {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-set-label.mjs');
    // Under the cap on its own — GitHub only rejects the RENDERED comment, which adds the clear-human chrome.
    const reason = 'r'.repeat(65200);
    expect(reason.length).toBeLessThan(GH_COMMENT_MAX);
    const r = spawnSync('node', [script, '1048', '--repo=o/n', '--to=clear-human', '--actor=Nicolas Gilbert',
      `--reason=${reason}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: logPath },
    });
    expect(r.status).not.toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(payload.error).toMatch(/--reason/);
    expect(payload.error).toMatch(new RegExp(`over GitHub's ${GH_COMMENT_MAX} limit`));
    expect(ghCalls()).toEqual([]);
  });

  // And the guard that makes it unskippable: the check on the RENDERED bytes inside the harness. No free-text
  // argv here at all, so an argv projection could not possibly catch this — an importer with its own
  // `buildComment` is exactly the call path the CLI-block-only guard left open.
  it('an importer whose buildComment renders over the cap is refused BEFORE the label swap', () => {
    const chunks = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit.bind(process);
    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    process.env.GH_CALL_LOG = logPath;
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = null;
    try {
      runReviewLabelCli({
        argv: ['1048', '--repo=o/n', '--to=clear-human', '--actor=op', '--reason=operator said clear it'],
        allowClearHuman: true,
        defaultActor: 'test',
        usage: 'usage: test',
        buildComment: () => 'z'.repeat(GH_COMMENT_MAX + 1),
        successResult: (o) => ({ ok: true, ...o }),
        refusalResult: ({ decision }) => ({ error: decision.reason }),
        emit: (line) => { chunks.push(String(line)); }, // #3061 — see runHarness
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally {
      process.stdout.write = realWrite; process.exit = realExit; process.env.PATH = realPath;
      delete process.env.GH_CALL_LOG;
    }
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(chunks.join('')).error).toMatch(/rendered comment is \d+ chars/);
    // It observed the PR (a read) and then stopped. #2979 moved the fingerprint's diff read off `gh pr diff`
    // onto `computeNetDiffText` (which shells `git`), so no `pr diff` appears in the gh log any more. What
    // matters to this guard is unchanged and still asserted: no MUTATION happened.
    expect(ghCalls()).toEqual(['pr view']);
    expect(ghCalls().some((c) => c === 'pr edit' || c === 'pr comment')).toBe(false);
  });
});

// PR #1056 review, round 4 / C3 — THE SUCCESS PATH. Every other CLI-level `clear-human` assertion in this file is
// a REFUSAL, and the recorded `gh` calls top out at `['pr view']` or `[]`. That is structurally the SAME defect as
// round 1's blocking B1 on this PR: *a refusal looks identical whether the gate works or is dead*, so a
// refusal-only suite cannot tell "clear-human is correctly wired" apart from "clear-human is unreachable". These
// tests drive the REAL entrypoint all the way THROUGH the impure half against a recording fake `gh` and assert the
// three things that actually have to land: the label swap, the attributed comment, and the `reviewed-sha` stamp.
// (`xsfp7k0` is the general rule this instantiates.) They double as the size pre-flight's missing NEGATIVE
// CONTROL: a body that FITS must be let through, or the guard above could pass its tests by refusing everything.
describe('clear-human drives the swap END-TO-END (#2895, PR #1056 C3)', () => {
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  const ACTOR = 'Nicolas Gilbert';
  const REASON = 'operator in-session: "read the panel, clear 1048"';
  /** #2844 — the pinned clearing-actor session id for this block (see `env()`). */
  const CLEARER = 'session-operator-1048';

  // Records the FULL argv of every call (not just the verb pair), flips the observed labels once `pr edit` has
  // run so the post-swap re-read is honest, and copies the posted `--body-file` out so the durable comment can be
  // read back through the real `parseReviewedSha`.
  const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  const labels = fs.existsSync(process.env.GH_EDIT_FLAG)
    ? [{ name: 'review:accepted' }, { name: 'ready-to-merge' }]
    : [{ name: 'review:human' }, { name: 'review:pending' }, { name: 'ready-to-merge' }];
  process.stdout.write(JSON.stringify({ labels, headRefOid: process.env.GH_HEAD_SHA, state: 'OPEN' }));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'edit') { fs.writeFileSync(process.env.GH_EDIT_FLAG, '1'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'comment') {
  fs.writeFileSync(process.env.GH_COMMENT_BODY, fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8'));
  process.exit(0);
}
process.exit(0);
`;

  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-set-label.mjs');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-label-success-'));
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
  });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  beforeEach(() => {
    for (const f of ['gh-calls.log', 'edited', 'comment.md']) {
      try { rmSync(join(dir, f), { force: true }); } catch { /* first run */ }
    }
  });

  const env = () => ({
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    GH_CALL_LOG: join(dir, 'gh-calls.log'),
    GH_EDIT_FLAG: join(dir, 'edited'),
    GH_COMMENT_BODY: join(dir, 'comment.md'),
    GH_HEAD_SHA: SHA,
    // #2844 — PIN the clearing actor. Inherited from `process.env` it would differ between a harness run and a
    // bare CI shell, which silently changes both the rendered comment (the `cleared-by-actor` stamp) and the
    // size projection — the exact kind of environment-dependent length the cap test below must not float on.
    CLAUDE_CODE_SESSION_ID: CLEARER,
  });
  /** Every recorded call as its full argv array. */
  const calls = () => (existsSync(join(dir, 'gh-calls.log'))
    ? readFileSync(join(dir, 'gh-calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  /** The values that FOLLOW each occurrence of `flag` in an argv array (adjacency, not mere presence). */
  const valuesOf = (argv, flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
  const runClear = (extra) => spawnSync('node', [script, '1048', '--repo=o/n', '--to=clear-human',
    `--actor=${ACTOR}`, `--reason=${REASON}`, ...extra], { encoding: 'utf8', env: env() });

  it('returns ok:true and lands the label swap, the attributed comment and the reviewed-sha stamp', () => {
    const bodyPath = join(dir, 'findings.md');
    writeFileSync(bodyPath, '## Findings\n\nNo blocking issues; the panel reduced to accept.\n', 'utf8');
    const r = runClear([`--body-file=${bodyPath}`]);

    // 1. The payload is a SUCCESS, not a refusal — the assertion the whole suite was missing.
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(payload).toMatchObject({ ok: true, pr: 1048, to: 'clear-human' });
    expect(payload.labels).toContain(REVIEW_LABELS.accepted);
    expect(payload.labels).not.toContain(REVIEW_LABELS.human);

    // 2. The swap that actually reached `gh`: accepted ADDED and human REMOVED, on one `pr edit`.
    const edit = calls().find((c) => c[0] === 'pr' && c[1] === 'edit');
    expect(edit).toBeDefined();
    expect(valuesOf(edit, '--add-label')).toEqual([REVIEW_LABELS.accepted]);
    expect(valuesOf(edit, '--remove-label')).toContain(REVIEW_LABELS.human);
    // The parked state goes too — a cleared PR must not still read as awaiting review.
    expect(valuesOf(edit, '--remove-label')).toContain(REVIEW_LABELS.pending);
    // `review:changes` was NOT on the PR, so `presentRemoveLabels` must have dropped it (gh errors on an absent
    // label), and the whole arc ran in order: observe → edit → comment → re-read.
    expect(valuesOf(edit, '--remove-label')).not.toContain(REVIEW_LABELS.changes);
    expect(calls().map((c) => c.slice(0, 2).join(' ')))
      // #2979 — the reviewed-diff read moved off `gh pr diff` onto `computeNetDiffText` (which shells `git`),
      // so the GH call sequence carries no `pr diff`. #2964 — the MUTATION order is now comment → edit: this PR
      // carries `review:human`/`review:pending` and NOT `review:accepted`, so the durable record (with its
      // marker) goes first, where an orphan is inert. The dedicated ordering suite below owns that property; the
      // pin is kept here so a silent re-flip cannot pass this end-to-end test.
      .toEqual(['pr view', 'pr comment', 'pr edit', 'pr view']);

    // 3. The durable comment — the honesty tax as it is actually posted, not as the module describes it.
    const comment = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(comment).toContain(`Cleared by ${ACTOR} via \`review-set-label.mjs --to=clear-human\` (#2895).`);
    expect(comment).toContain(`> ${REASON}`);
    expect(comment).toContain('What it does NOT prove: that a human performed it.');
    expect(comment).toContain('## Findings');
    // A well-formed marker, proven through the REAL reader rather than a substring check.
    expect(parseReviewedSha([{ body: comment }])).toBe(SHA);
  });

  // THE NEGATIVE CONTROL for the size pre-flight (dropped, not replaced, when the ceremony block was deleted —
  // PR #1056 round 4). A guard that refuses everything passes every refusal test ever written; this pins the
  // other side at the exact boundary — the largest body that still renders under the cap must go THROUGH.
  it('lets a body that renders exactly AT the cap through — the size guard is not a blanket refusal', () => {
    // The projection MUST be given the same clearer id the child process will see (`env()` pins it), or this
    // helper under-counts the #2844 stamp + independence note and the "exactly at the cap" body overshoots.
    const at = (body) => projectVerdictCommentLength({ body, actor: ACTOR, reason: REASON, clearerId: CLEARER });
    const guess = GH_COMMENT_MAX - at('');
    const body = 'y'.repeat(guess - (at('y'.repeat(guess)) - GH_COMMENT_MAX));
    expect(at(body)).toBe(GH_COMMENT_MAX); // exactly at the cap, not one char under
    const bodyPath = join(dir, 'max-findings.md');
    writeFileSync(bodyPath, body, 'utf8');

    const r = runClear([`--body-file=${bodyPath}`]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()).ok).toBe(true);
    expect(calls().map((c) => c.slice(0, 2).join(' '))).toContain('pr comment');
    expect(readFileSync(join(dir, 'comment.md'), 'utf8').length).toBeLessThanOrEqual(GH_COMMENT_MAX);
  });

  // PR #1056 review, C2 — the DOCUMENTED invocation, exercised as documented. `npm run <script>` writes its two
  // banner lines to STDOUT ahead of the payload, so the wrapper the skill hands the operator used to break the
  // module's stated contract (`{"ok":…}`/`{"error":…}` as the whole of stdout): an agent parsed stdout, threw on
  // a clearance that had in fact landed, and a naive retry then hit "nothing to clear" — reading like a second
  // failure. The class is "a package.json wrapper around a JSON-contract CLI is never exercised as documented".
  it('the documented `npm run --silent review:clear` wrapper puts ONLY JSON on stdout', () => {
    const r = spawnSync('npm', ['run', '--silent', 'review:clear', '--',
      '1048', '--repo=o/n', `--actor=${ACTOR}`], { cwd: repoRoot, encoding: 'utf8', env: env() });
    expect(r.status).not.toBe(0);
    // The WHOLE of stdout must parse — a banner line ahead of the payload is exactly what this catches.
    const payload = JSON.parse(r.stdout);
    expect(payload.error).toMatch(/requires --reason/);
    expect(calls()).toEqual([]); // refused before any gh call
  }, 60000);

  // …and the pin that keeps the DOC honest, which no amount of testing npm itself would give: if the skill ever
  // documents the wrapper without `--silent`, the banner problem is back and the test above stops covering it.
  it('the /review skill never documents the wrapper without --silent', () => {
    const skill = readFileSync(join(repoRoot, 'skills-src', 'review', 'SKILL.md'), 'utf8');
    for (const m of skill.matchAll(/npm run[^\n]*review:clear/g)) {
      expect(m[0]).toContain('--silent');
    }
  });
});

// #2953 — a verdict on an already-merged/closed PR must fail closed, not report `{"ok":true}` for a label swap
// that is inert. Observed live on WE PR #1073: `review:changes` was applied six minutes after `mergedAt` and the
// CLI reported success, which was read as a live bounce the drain had ignored — a false reproduction of #2750.
// Hermetic: a fake `gh` on PATH reports a non-OPEN state, so both "refused" and "refused before any mutation"
// are observable.
describe('runReviewLabelCli fails closed on a non-OPEN PR (#2953)', () => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-set-label.mjs');
  const fakeGh = (state) => `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, a.slice(0, 2).join(' ') + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({ labels: [{ name: 'review:pending' }], headRefOid: 'f'.repeat(40), state: '${state}' }));
  process.exit(0);
}
process.exit(0);
`;
  let shimDir;
  let logPath;
  const setUpShim = (state) => {
    shimDir = mkdtempSync(join(tmpdir(), 'review-label-state-'));
    writeFileSync(join(shimDir, 'gh'), fakeGh(state));
    chmodSync(join(shimDir, 'gh'), 0o755);
    logPath = join(shimDir, 'gh-calls.log');
  };
  afterEach(() => { try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  const ghCalls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);

  for (const state of ['MERGED', 'CLOSED']) {
    it(`refuses a --to=changes verdict on a ${state} PR, naming the state, and reaches no mutating gh call`, () => {
      setUpShim(state);
      // A bounce carries findings now (#xd6moh1); what is under test here is the non-OPEN refusal, which
      // must still fire and must still reach no mutation.
      const findings = join(shimDir, 'findings.md');
      writeFileSync(findings, 'the one changed line is wrong');
      const r = spawnSync('node', [script, '1073', '--repo=o/n', '--to=changes', '--actor=op', `--body-file=${findings}`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: logPath },
      });
      expect(r.status).not.toBe(0);
      const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
      expect(payload.error).toMatch(new RegExp(state));
      expect(payload.error).toMatch(/not OPEN/);
      expect(payload.ok).not.toBe(true);
      // Observed once (the read) and stopped — no `pr edit` / `pr comment` mutation reached.
      expect(ghCalls()).toEqual(['pr view']);
    });
  }

  it('the decisive #2953 case: --to=accepted also refuses on a MERGED PR (not just the changes bounce)', () => {
    setUpShim('MERGED');
    const r = spawnSync('node', [script, '1073', '--repo=o/n', '--to=accepted', '--actor=op'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_CALL_LOG: logPath },
    });
    expect(r.status).not.toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(payload.error).toMatch(/MERGED/);
    expect(ghCalls()).toEqual(['pr view']);
  });
});

// #2964 — THE ORDER THE TWO WRITES LAND IN. `runReviewLabelCli` makes two non-atomic `gh` calls (the durable
// verdict comment, which carries the `reviewed-sha` marker, and the label swap). Either can land alone, so the
// ONLY thing that can be engineered is WHICH half is safe to lose — and the answer is not the same in both cases:
//   • not yet accepted → COMMENT FIRST (an orphan marker with no `review:accepted` behind it is never read);
//   • already accepted → SWAP FIRST (an orphan marker there would FRESHEN the #2409 coverage of an acceptance
//     that never landed, handing the drain a tree no successful swap vouched for).
// These tests assert the ORDER and its consequence — not merely that both calls happened, which the defective
// pre-#2964 order satisfies just as well. The drain-side consequence is proven through the REAL
// `parseReviewedSha` + `decideReviewGate`, so a change to how the gate reads a marker cannot leave them passing
// vacuously.
describe('runReviewLabelCli — the write ORDER is the safety property (#2964)', () => {
  const OLD_SHA = '1111111111111111111111111111111111111111';
  const NEW_SHA = '2222222222222222222222222222222222222222';
  const ACTOR = 'Nicolas Gilbert';
  /** The marker the PR ALREADY carries from an earlier accept — the "durable record" the hazard is about. */
  const PRIOR_ACCEPT_COMMENT = { body: `✅ review — accepted\n\n<!-- reviewed-sha: ${OLD_SHA} -->` };

  // `GH_FAIL_ON` names a verb pair ('pr edit' / 'pr comment') that exits 1 with a transient-looking stderr — the
  // 5xx / rate-limit / network blip the item is about. `pr view` is always honest so the run gets that far, and
  // (like the other fake-`gh` suites in this file) it reports NO `headRefName`, so the #2979 net-diff read is
  // unscored and no `reviewed-diff` marker is stamped. That is deliberate on two counts: it keeps the run
  // hermetic — a branch name here sends `computeNetDiffText` to the network for a ref that does not exist — and
  // it isolates the ordering property on the `reviewed-sha` marker, which is the one `acceptanceCoversHead`
  // fails OPEN on. Both markers ride the same comment, so ordering them is one act.
  //
  // /bin/sh, not node, unlike the other fake-`gh` shims in this file: the ordering tests below invoke `gh` ~20
  // times, and a node shim pays a whole node startup on each. Nothing here needs node.
  const FAKE_GH = `#!/bin/sh
verb="$1 $2"
printf '%s\\n' "$verb" >> "$GH_CALL_LOG"
if [ "$verb" = 'pr view' ]; then
  if [ -f "$GH_EDIT_FLAG" ]; then labels="$GH_LABELS_AFTER"; else labels="$GH_LABELS_BEFORE"; fi
  printf '{"labels":%s,"headRefOid":"%s","state":"OPEN"}' "$labels" "$GH_HEAD_SHA"
  exit 0
fi
if [ "$verb" = "$GH_FAIL_ON" ]; then
  echo 'HTTP 502: Bad gateway - transient' >&2
  exit 1
fi
if [ "$verb" = 'pr edit' ]; then : > "$GH_EDIT_FLAG"; exit 0; fi
if [ "$verb" = 'pr comment' ]; then
  prev=''
  for a in "$@"; do
    if [ "$prev" = '--body-file' ]; then body="$a"; fi
    prev="$a"
  done
  mkdir -p "$GH_COMMENT_DIR"
  n=$(find "$GH_COMMENT_DIR" -name '*.md' | wc -l | tr -d ' ')
  cp "$body" "$GH_COMMENT_DIR/$n.md"
  exit 0
fi
exit 0
`;

  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-set-label.mjs');
  let dir;
  // A `changes` bounce must carry findings (#xd6moh1). Irrelevant to the ordering rule under test, but the
  // CLI refuses without it, so every bounce here supplies one.
  const FINDINGS = 'the change is not right yet';
  let findingsPath;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-label-order-'));
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
    findingsPath = join(dir, 'findings.md');
    writeFileSync(findingsPath, FINDINGS);
  });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  const reset = () => {
    for (const f of ['gh-calls.log', 'edited']) {
      try { rmSync(join(dir, f), { force: true }); } catch { /* first run */ }
    }
    try { rmSync(join(dir, 'comments'), { recursive: true, force: true }); } catch { /* first run */ }
  };
  beforeEach(reset);

  /** The fake `gh`'s whole world: which labels `pr view` reports before/after the swap, the live head, and which
   *  call (if any) blips. `before`/`after` are label-name arrays. */
  const envFor = ({ before, after, headSha, failOn = '' }) => ({
    PATH: `${dir}:${process.env.PATH}`,
    GH_CALL_LOG: join(dir, 'gh-calls.log'),
    GH_COMMENT_DIR: join(dir, 'comments'),
    GH_EDIT_FLAG: join(dir, 'edited'),
    GH_LABELS_BEFORE: JSON.stringify(before.map((name) => ({ name }))),
    GH_LABELS_AFTER: JSON.stringify(after.map((name) => ({ name }))),
    GH_HEAD_SHA: headSha,
    GH_FAIL_ON: failOn,
  });
  const argvFor = (opts) => ['1099', '--repo=o/n', `--to=${opts.to || 'accepted'}`, `--actor=${ACTOR}`,
    ...(opts.to === 'changes' ? [`--body-file=${findingsPath}`] : [])];

  /** Drive the REAL CLI entrypoint in a child process. Reserved for the two headline pins — each spawn re-imports
   *  this CLI's whole module graph (seconds), so the rest run in-process below. */
  const runCli = (opts) => spawnSync('node', [script, ...argvFor(opts)],
    { encoding: 'utf8', env: { ...process.env, ...envFor(opts) } });

  /** Drive the SAME harness IN-PROCESS against the same fake `gh`. The ordering rule lives inside
   *  `runReviewLabelCli`, not in the CLI block's argv handling, so this exercises the code under test exactly —
   *  and it supplies the REAL `buildVerdictComment` (as the CLI block does), so the marker is the real one.
   *  Mirrors the stdout/exit stubbing the size-guard suite above already uses. */
  const runHarness = (opts) => {
    const chunks = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit.bind(process);
    const overrides = envFor(opts);
    const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
    Object.assign(process.env, overrides);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let status = null;
    try {
      runReviewLabelCli({
        argv: argvFor(opts),
        defaultActor: 'test',
        usage: 'usage: test',
        // The harness does not read `--body-file` (only the CLI shell does), so the findings are handed over
        // directly — same text either way.
        verdictBody: opts.to === 'changes' ? FINDINGS : '',
        buildComment: ({ to, actor, headSha, reason, reviewedDiff }) => buildVerdictComment({
          to, actor, headSha, reason, reviewedDiff,
        }),
        successResult: ({ pr, to, labels }) => ({ ok: true, pr, to, labels }),
        refusalResult: ({ decision }) => ({ error: decision.reason }),
        // #3061 — collect through the INJECTED emitter, not the `process.stdout.write` patch above. The CLI's
        // default emitter drains synchronously (`fs.writeSync(1, …)`) so its payload survives a capturing
        // parent, and a patch on the stream object cannot observe that. The patch stays for anything else in
        // the call that still reaches the stream.
        emit: (line) => { chunks.push(String(line)); },
      });
    } catch (e) {
      if (typeof e.exitCode === 'number') status = e.exitCode; else throw e;
    } finally {
      process.stdout.write = realWrite;
      process.exit = realExit;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    const line = chunks.join('').trim().split('\n').filter(Boolean).pop();
    return { status, payload: line ? JSON.parse(line) : null };
  };

  /** The verb pair of every recorded gh call, in order. */
  const verbs = () => (existsSync(join(dir, 'gh-calls.log'))
    ? readFileSync(join(dir, 'gh-calls.log'), 'utf8').split('\n').filter(Boolean)
    : []);
  /** Every comment body that actually reached `gh pr comment`, oldest first — the PR's durable record, in the
   *  `[{ body }]` shape `gh pr view --json comments` returns and `parseReviewedSha` consumes. */
  const posted = () => (existsSync(join(dir, 'comments'))
    ? readdirSync(join(dir, 'comments')).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
      .map((f) => ({ body: readFileSync(join(dir, 'comments', f), 'utf8') }))
    : []);
  /** What the drain would decide, reading the PR exactly as `merge-ai-prs.mjs` does. */
  const drainVerdict = ({ labels, comments, headSha }) => decideReviewGate({
    escalate: true, labels, headSha, acceptedSha: parseReviewedSha(comments),
  });

  const NOT_YET_ACCEPTED = {
    before: [REVIEW_LABELS.pending, 'ready-to-merge'],
    after: [REVIEW_LABELS.accepted, 'ready-to-merge'],
    headSha: NEW_SHA,
  };
  const ALREADY_ACCEPTED = {
    before: [REVIEW_LABELS.accepted, 'ready-to-merge'],
    after: [REVIEW_LABELS.accepted, 'ready-to-merge'],
    headSha: NEW_SHA,
  };

  // ── Case 1: the PR is NOT already accepted — the first accept, and the hole this item was filed for. ──────────

  // THE REGRESSION PIN, driven through the REAL entrypoint. Under the old swap-first order `gh pr edit` had
  // already landed by the time the comment failed, leaving `review:accepted` + no marker → `acceptanceCoversHead`
  // fails OPEN → the drain merges with the #2409 gate disarmed. Comment-first makes that state unreachable: the
  // failure happens before the swap exists.
  it('a failed comment on a not-yet-accepted PR reaches NO pr edit — the label swap never happens', () => {
    const r = runCli({ ...NOT_YET_ACCEPTED, failOn: 'pr comment' });
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()).error).toMatch(/502|Bad gateway/);
    // The whole assertion: the unsafe half never ran. Under the pre-#2964 order this list contains 'pr edit'.
    expect(verbs()).not.toContain('pr edit');
    expect(verbs()).toEqual(['pr view', 'pr comment']);
    expect(existsSync(join(dir, 'edited'))).toBe(false);
  }, 120000);

  // The ordering itself, on the happy path — "both calls happened" is exactly what the defective order satisfies,
  // so the assertion has to be positional.
  it('the comment is issued BEFORE the label swap on a not-yet-accepted PR', () => {
    const r = runHarness(NOT_YET_ACCEPTED);
    expect(r.status).toBe(0);
    expect(r.payload).toMatchObject({ ok: true, to: 'accepted' });
    expect(verbs()).toEqual(['pr view', 'pr comment', 'pr edit', 'pr view']);
    expect(verbs().indexOf('pr comment')).toBeLessThan(verbs().indexOf('pr edit'));
    // And the acceptance it records is the one the drain will honour: marker at the live head, label live.
    expect(parseReviewedSha(posted())).toBe(NEW_SHA);
    expect(drainVerdict({ labels: [REVIEW_LABELS.accepted], comments: posted(), headSha: NEW_SHA }).action)
      .toBe('merge');
  });

  // THE RE-RUNNABILITY QUALIFIER the item calls load-bearing: "a comment with no swap is inert and the command is
  // re-runnable". Both halves are driven here, because the reorder is only justified if BOTH hold — an orphan
  // record that were readable, or a first run that poisoned the second, would make comment-first the worse trade.
  it('an orphan comment is inert AND the command is re-runnable — the qualifier the reorder rests on', () => {
    // Run 1: the swap blips. The record is already durable — under the pre-#2964 order it would not exist at all.
    const first = runHarness({ ...NOT_YET_ACCEPTED, failOn: 'pr edit' });
    expect(first.status).not.toBe(0);
    const orphan = posted();
    expect(orphan).toHaveLength(1);
    expect(parseReviewedSha(orphan)).toBe(NEW_SHA); // a real marker, naming the live head…
    expect(existsSync(join(dir, 'edited'))).toBe(false); // …with NO review:accepted behind it.

    // INERT: the drain reads the PR as it now stands — pending, plus that orphan marker — and does NOT merge.
    // `parseReviewedSha` is only ever consulted behind a live `review:accepted` check, so the marker is not even
    // read; this pins the outcome that fact produces rather than restating the fact.
    const gate = drainVerdict({ labels: [REVIEW_LABELS.pending], comments: orphan, headSha: NEW_SHA });
    expect(gate.action).not.toBe('merge');
    expect(gate.action).toBe('park');

    // RE-RUNNABLE: the identical command, run again against the same PR, succeeds and lands the swap. No
    // "nothing to clear" dead end, no manual `gh` repair.
    reset();
    const second = runHarness(NOT_YET_ACCEPTED);
    expect(second.status).toBe(0);
    expect(second.payload.ok).toBe(true);
    expect(verbs()).toContain('pr edit');
    expect(existsSync(join(dir, 'edited'))).toBe(true);
  });

  // ── Case 2: the PR ALREADY carries review:accepted — the hazard the reorder INTRODUCES, and its closure. ──────

  // THE HAZARD TEST the item demands, driven through the REAL entrypoint: already accepted + head advanced +
  // `gh pr edit` fails must NOT leave a marker naming the live head. This is the test an UNCONDITIONAL
  // comment-first implementation fails — there the comment is already durable when the swap blips,
  // `parseReviewedSha` takes the latest marker, and the still-live `review:accepted` sends the drain straight to
  // merge, a failed run having freshened the coverage of an acceptance it never applied. Keeping the swap first
  // HERE is what closes it.
  it('already accepted + head advanced + a failed pr edit does NOT advance the reviewed-sha marker', () => {
    const r = runCli({ ...ALREADY_ACCEPTED, failOn: 'pr edit' });
    expect(r.status).not.toBe(0);
    // The swap was attempted FIRST and failed, so the run exited before writing anything durable.
    expect(verbs()).toEqual(['pr view', 'pr edit']);
    expect(verbs()).not.toContain('pr comment');
    expect(posted()).toEqual([]);

    // The consequence, read the way the drain reads it: the newest marker is still the PRIOR one, naming the OLD
    // head, so the #2409 staleness gate re-parks instead of merging. This is the assertion that fails if the
    // marker is ever allowed ahead of the swap on an already-accepted PR.
    const comments = [PRIOR_ACCEPT_COMMENT, ...posted()];
    expect(parseReviewedSha(comments)).toBe(OLD_SHA);
    const gate = drainVerdict({ labels: [REVIEW_LABELS.accepted], comments, headSha: NEW_SHA });
    expect(gate.action).toBe('park');
    expect(gate.staleAcceptance).toBe(true);
  }, 120000);

  // The NEGATIVE CONTROL for the test above — a rule that simply never stamped anything would pass it. A
  // SUCCESSFUL re-accept must still advance the marker, because that is how the #2409 gate un-sticks a re-parked
  // PR after the fix; removing that path is the shape this implementation deliberately did not pick.
  it('a SUCCESSFUL re-accept on an already-accepted PR does advance the marker (swap first, then the record)', () => {
    const r = runHarness(ALREADY_ACCEPTED);
    expect(r.status).toBe(0);
    // Swap first HERE — the inverse of the not-yet-accepted case above, and deliberately so.
    expect(verbs()).toEqual(['pr view', 'pr edit', 'pr comment', 'pr view']);
    expect(verbs().indexOf('pr edit')).toBeLessThan(verbs().indexOf('pr comment'));
    const comments = [PRIOR_ACCEPT_COMMENT, ...posted()];
    expect(parseReviewedSha(comments)).toBe(NEW_SHA);
    expect(drainVerdict({ labels: [REVIEW_LABELS.accepted], comments, headSha: NEW_SHA }).action).toBe('merge');
  });

  // A bounce carries no marker, so the ordering rule keys on the LABEL rather than on `to` — `buildComment` is
  // caller-supplied, so the harness cannot know whether a given body stamps one, and assuming it might is the
  // conservative direction. A `changes` verdict on a not-yet-accepted PR therefore comments first too.
  it('a changes bounce on a pending PR comments first too — the rule keys on the label, not the verdict', () => {
    const r = runHarness({
      before: [REVIEW_LABELS.pending, 'ready-to-merge'],
      after: [REVIEW_LABELS.changes, 'ready-to-merge'],
      headSha: NEW_SHA,
      to: 'changes',
    });
    expect(r.status).toBe(0);
    expect(verbs()).toEqual(['pr view', 'pr comment', 'pr edit', 'pr view']);
    expect(parseReviewedSha(posted())).toBe(null); // a bounce stamps nothing
  });
});

// #xmnl36p — the clearance a `--to=clear-human` ceremony writes must be READABLE BACK, or an automated re-score
// cannot know it is overriding one. The pin is a ROUND TRIP through the real reader (never a substring assert):
// producer and consumer verified independently is exactly how the #2882 marker inversion hid.
describe('#xmnl36p — clear-human stamps a clearance the re-score reader can find', () => {
  it('round-trips the actor through parseOperatorClearance', () => {
    const body = buildVerdictComment({
      to: 'clear-human', actor: 'Nicolas Gilbert', headSha: 'a'.repeat(40),
      reason: 'operator approved in session', reviewedDiff: 'f'.repeat(64),
    });
    expect(parseOperatorClearance([{ body }])).toEqual({ actor: 'Nicolas Gilbert' });
  });

  it('an ORDINARY accept records no clearance — only clear-human does', () => {
    const body = buildVerdictComment({ to: 'accepted', actor: 'Nicolas Gilbert', headSha: 'a'.repeat(40) });
    expect(parseOperatorClearance([{ body }])).toBe(null);
    const bounce = buildVerdictComment({ to: 'changes', actor: 'Nicolas Gilbert', headSha: 'a'.repeat(40) });
    expect(parseOperatorClearance([{ body: bounce }])).toBe(null);
  });

  it('the size pre-flight counts the new marker (the #1056-M2 under-count class)', () => {
    // `projectVerdictCommentLength` maxes over REVIEW_LABEL_TARGETS, so the longest-rendering target must be
    // >= what clear-human actually posts, marker included.
    const actual = buildVerdictComment({
      to: 'clear-human', actor: 'Nicolas Gilbert', headSha: 'f'.repeat(40),
      reason: 'r', reviewedDiff: 'f'.repeat(64),
    }).length;
    expect(projectVerdictCommentLength({ body: '', actor: 'Nicolas Gilbert', reason: 'r' }))
      .toBeGreaterThanOrEqual(actual);
  });
});

// ── #2844 · the CLI REFUSES a self-cleared verdict ──────────────────────────────────────────────────────────────
// The autonomous seam (`we:scripts/lib/auto-land-seam.mjs`) has its own adversarial proof; this is the OTHER
// clearance path — the CLI an operator's `/review` or a conveyor agent invokes. It is driven END-TO-END against a
// recording fake `gh`, and the assertion that carries the weight is that NO `pr edit` / `pr comment` reached gh:
// a pure-predicate assertion would pass just as happily against a CLI that decided "self-clear" and then wrote
// the label anyway. It also pins the negative control — a DIFFERENT clearer must go through — because a guard
// that refuses everything passes every refusal test ever written.
describe('#2844 — the review-set-label CLI refuses a self-cleared verdict (end-to-end)', () => {
  const AUTHOR = 'session-author-3f9c';
  const REVIEWER = 'session-reviewer-a71b';
  const SHA = 'abf7d85700a3336a0ec77d94ab455162d4b8e00d';
  // A PR body exactly as `pr-land.mjs` leaves it: the human summary plus the author stamp.
  const BODY = `Resolve #1: something real.\n\n<!-- authored-by-actor: ${AUTHOR} -->\n`;

  const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({
    labels: JSON.parse(process.env.GH_PR_LABELS).map((name) => ({ name })),
    headRefOid: process.env.GH_HEAD_SHA,
    headRefName: 'lane/x',
    state: 'OPEN',
    body: process.env.GH_PR_BODY,
    // #3067 — the fake must return what the REAL read now returns, or the wiring under test is unexercised.
    createdAt: process.env.GH_PR_CREATED_AT || '',
  }));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'comment') {
  fs.writeFileSync(process.env.GH_COMMENT_BODY, fs.readFileSync(a[a.indexOf('--body-file') + 1], 'utf8'));
  process.exit(0);
}
process.exit(0);
`;

  const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-set-label.mjs');
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-label-independence-'));
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
  });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });
  beforeEach(() => {
    for (const f of ['gh-calls.log', 'comment.md']) {
      try { rmSync(join(dir, f), { force: true }); } catch { /* first run */ }
    }
  });

  // Drive the REAL CLI with the recording fake `gh`. `labels` is what the fake PR carries, so the same harness
  // covers the ordinary parked PR AND the `review:human` gate-self one the clear-human ceremony needs.
  const runCli = (args, { sessionId, prBody = BODY, labels = ['review:pending', 'ready-to-merge'], createdAt = '' }) => spawnSync(
    'node', [script, '1099', '--repo=o/n', ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_CALL_LOG: join(dir, 'gh-calls.log'),
        GH_COMMENT_BODY: join(dir, 'comment.md'),
        GH_HEAD_SHA: SHA,
        GH_PR_BODY: prBody,
        GH_PR_LABELS: JSON.stringify(labels),
        GH_PR_CREATED_AT: createdAt,
        CLAUDE_CODE_SESSION_ID: sessionId,
      },
    },
  );
  const run = (sessionId, prBody = BODY) => runCli(['--to=accepted', '--actor=an agent'], { sessionId, prBody });
  const ghCalls = () => (existsSync(join(dir, 'gh-calls.log'))
    ? readFileSync(join(dir, 'gh-calls.log'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).slice(0, 2).join(' '))
    : []);

  // ── #3067: the stamp's ABSENCE is now a checkable comparison, not an assumption ──────────────────────────
  // The pure decider grew `prCreatedAt`/`stampLostMarked` as OPT-IN inputs and NO live caller passed them, so
  // every real clearance recorded `unknown-author` whether the PR predated the stamp regime or had one
  // stripped an hour ago. These drive the REAL CLI end to end and assert the recorded status differs.
  const STAMPLESS = 'Resolve #1: something real.\n';

  it('records STAMP-LOST for a post-regime PR whose stamp is missing (#3067)', () => {
    const r = runCli(['--to=accepted', '--actor=an agent'],
      { sessionId: 'clearer-x', prBody: STAMPLESS, createdAt: '2026-08-20T00:00:00Z' });
    expect(r.status).toBe(0); // it still CLEARS — only self-clear refuses here; the RECORD is what changed
    // Asserted on the durable comment, which is where the operator actually reads this.
    const note = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(note).toMatch(/STAMP LOST/);
    expect(note).toMatch(/at\/after the #2844 stamp regime began/);
  });

  it('still records UNKNOWN-AUTHOR for a PR that predates the regime (#3067 — the tolerance is kept)', () => {
    // The other half. Without it, "call everything stamp-lost" passes the case above and strands every PR
    // opened before the stamp existed — the exact failure #2844's tolerance was written to avoid.
    const r = runCli(['--to=accepted', '--actor=an agent'],
      { sessionId: 'clearer-x', prBody: STAMPLESS, createdAt: '2026-07-01T00:00:00Z' });
    expect(r.status).toBe(0);
    const note = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(note).not.toMatch(/STAMP LOST/);
    expect(note).toMatch(/no authored-by-actor stamp/);
  });

  it('a caller that supplies no createdAt sees the OLD behaviour exactly (#3067 opt-in)', () => {
    const r = runCli(['--to=accepted', '--actor=an agent'],
      { sessionId: 'clearer-x', prBody: STAMPLESS, createdAt: '' });
    expect(r.status).toBe(0);
    const note = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(note).not.toMatch(/STAMP LOST/);
    expect(note).toMatch(/no authored-by-actor stamp/);
  });

  it('ADVERSARIAL: the PR\'s own author clearing it to accepted is REFUSED, and nothing is written', () => {
    const r = run(AUTHOR);
    expect(r.status).not.toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(payload.error).toMatch(/SELF-CLEAR REFUSED/);
    expect(payload.error).toMatch(/#2844/);
    expect(payload.ok).not.toBe(true);
    // THE LOAD-BEARING ASSERTION: it observed the PR and STOPPED. No label swap, no comment.
    expect(ghCalls()).toEqual(['pr view']);
    expect(existsSync(join(dir, 'comment.md'))).toBe(false);
  });

  it('a DIFFERENT session clearing the same PR goes through — the refusal is not a blanket one', () => {
    const r = run(REVIEWER);
    expect(r.status).toBe(0);
    expect(ghCalls()).toContain('pr edit');
    expect(ghCalls()).toContain('pr comment');
    // The durable record NAMES the clearer, and says nothing about unproven independence — it was proven.
    const comment = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(comment).toContain(`<!-- cleared-by-actor: ${REVIEWER} -->`);
    expect(comment).not.toMatch(/Independence NOT established/);
  });

  it('an UNSTAMPED PR (opened before #2844) still clears, but the record SAYS independence is unproven', () => {
    // Refusing here would strand every pre-#2844 PR with no way for a human to clear it. The mitigation is that
    // the record cannot stay silent — a reader must not infer independence from the absence of a note.
    const r = run(REVIEWER, 'Resolve #1: an older PR with no author stamp.\n');
    expect(r.status).toBe(0);
    const comment = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(comment).toMatch(/Independence NOT established/);
    expect(comment).toMatch(/authored-by-actor/);
    expect(comment).toContain(`<!-- cleared-by-actor: ${REVIEWER} -->`);
  });

  it('a `changes` BOUNCE is never blocked by the independence bar — a bounce lands nothing', () => {
    // the author, bouncing its own PR — allowed, it clears nothing
    const findings = join(dir, 'findings.md');
    writeFileSync(findings, 'the isolation claim does not hold');
    const r = runCli(['--to=changes', '--actor=an agent', `--body-file=${findings}`], { sessionId: AUTHOR });
    expect(r.status).toBe(0);
    expect(ghCalls()).toContain('pr edit');
    // And a bounce carries NO clearer stamp — there is no clearance to attribute.
    expect(readFileSync(join(dir, 'comment.md'), 'utf8')).not.toContain('cleared-by-actor');
  });

  // ── PR #1100 review, THE BLOCKER · the HUMAN CEREMONY is exempt ────────────────────────────────────────────
  // A subagent INHERITS its parent's CLAUDE_CODE_SESSION_ID, so the comparison above is SESSION-level and the
  // operator's own `/review` ceremony — which shells this CLI from inside the session that opened the PR — reads
  // as a self-clear. The first cut refused `clear-human` on that basis too (`stampsAcceptance` gated the refusal),
  // which meant NOTHING could be cleared through the sanctioned path, including the PR that introduced the guard.
  // These drive the REAL CLI on a REAL `review:human` PR and pin the exemption, its record, and its limits.
  const HUMAN_LABELS = ['review:human', 'review:pending', 'ready-to-merge'];
  const clearHuman = (sessionId, labels = HUMAN_LABELS) => runCli(
    ['--to=clear-human', '--actor=Nicolas', '--reason=clear it, I have reviewed it'],
    { sessionId, labels },
  );

  it('THE BLOCKER: the author\'s OWN session may run --to=clear-human on a review:human PR — ALLOWED', () => {
    const r = clearHuman(AUTHOR);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(payload.ok).toBe(true);
    // It actually swapped the label and posted the record — not a silent no-op dressed as success.
    expect(ghCalls()).toContain('pr edit');
    expect(ghCalls()).toContain('pr comment');
  });

  it('…and the durable comment records it as a HUMAN CEREMONY, not as an established-independent clearance', () => {
    clearHuman(AUTHOR);
    const comment = readFileSync(join(dir, 'comment.md'), 'utf8');
    expect(comment).toMatch(/Cleared by the HUMAN CEREMONY/);
    expect(comment).toMatch(/NOT as "an independent reviewer cleared it"/);
    // It names the actor whose session cleared it, and quotes the operator instruction verbatim (#2895).
    expect(comment).toContain(`<!-- cleared-by-actor: ${AUTHOR} -->`);
    expect(comment).toContain('clear it, I have reviewed it');
    // The WRONG record — the generic "could not be checked" warning — must NOT be what a reader sees here: this
    // clearance's independence was not unknown, it was known-absent and deliberately exempted.
    expect(comment).not.toMatch(/Independence NOT established/);
  });

  it('clear-human is STILL refused when the PR does not carry review:human — the exemption is narrow', () => {
    const r = clearHuman(AUTHOR, ['review:pending', 'ready-to-merge']);
    expect(r.status).not.toBe(0);
    const payload = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());
    expect(payload.error).toMatch(/no review:human label/);
    // Refused by the PURE decider, so nothing was written.
    expect(ghCalls()).toEqual(['pr view']);
    expect(existsSync(join(dir, 'comment.md'))).toBe(false);
  });

  it('--to=accepted on that SAME review:human PR from the SAME session is still refused (#2439 intact)', () => {
    const r = runCli(['--to=accepted', '--actor=Nicolas'], { sessionId: AUTHOR, labels: HUMAN_LABELS });
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()).error).toMatch(/SELF-CLEAR REFUSED/);
    expect(ghCalls()).toEqual(['pr view']);
  });

  it('the refusal message names ONLY routes that work, and promises no escape that does not exist', () => {
    // The first cut said "hand the verdict to a different session, or let a human clear it" — and the human WAS
    // in that session, so the second half pointed at a shut door. The message must name the two live routes…
    const err = JSON.parse(run(AUTHOR).stdout.trim().split('\n').filter(Boolean).pop()).error;
    expect(err).toMatch(/--to=clear-human/);
    expect(err).toMatch(/review:human/);
    expect(err).toMatch(/DIFFERENT SESSION/);
    // …say plainly that no flag lifts it (there is no --force, and none is being invented)…
    expect(err).toMatch(/no --force/);
    // …and never advertise an env-var escape as sanctioned: unsetting the session id does not buy independence,
    // it only downgrades the record to "not established", so the message must not offer it as a way through.
    expect(err).not.toMatch(/env -u|unset|CLAUDE_CODE_SESSION_ID=/);
  });
});

/**
 * A BOUNCE WITH NO FINDINGS IS UNACTIONABLE (#xd6moh1). `review:changes` tells the author to fix something and
 * the findings are the only place that says what; without them the drain parks the PR behind a hold nobody can
 * clear. Observed live on PR #1178, twice in one afternoon.
 *
 * Every refusal here lands through the `{"error":…}` JSON contract BEFORE the first `gh` call, so no network
 * and no mocking — the same in-process harness the clear-human preconditions use.
 */
describe('runReviewLabelCli — a changes verdict must carry its findings (#xd6moh1)', () => {
  const CFG = {
    defaultActor: 'test',
    usage: 'usage: test',
    buildComment: () => 'unused',
    successResult: (o) => ({ ok: true, ...o }),
    refusalResult: ({ decision }) => ({ error: decision.reason }),
  };

  // PATH points at an EMPTY directory, so `gh` cannot be found and no network is touched. That is enough for
  // every assertion here: the findings guard runs BEFORE the first gh call, so "the error is not the findings
  // error" proves the guard did not fire, whatever the run failed on afterwards.
  let noGhDir;
  beforeAll(() => { noGhDir = mkdtempSync(join(tmpdir(), 'review-label-nogh-')); });
  afterAll(() => { try { rmSync(noGhDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  function run(cfg) {
    const chunks = [];
    const realExit = process.exit.bind(process);
    const savedPath = process.env.PATH;
    process.env.PATH = noGhDir;
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = null;
    let threw = null;
    try { runReviewLabelCli({ ...CFG, emit: (line) => { chunks.push(String(line)); }, ...cfg }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else threw = e; }
    finally { process.exit = realExit; process.env.PATH = savedPath; }
    if (threw) throw threw;
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  const bounce = (extra = {}) => run({ argv: ['1178', '--repo=o/n', '--to=changes'], ...extra });

  it('REFUSES a changes verdict with no findings at all', () => {
    const { exitCode, payload } = bounce();
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/--to=changes requires the findings/);
    expect(payload.error).toMatch(/--body-file/);
  });

  // Whitespace-only is the same dead end as absent — the author still learns nothing.
  it('REFUSES a whitespace-only findings body', () => {
    const { exitCode, payload } = bounce({ verdictBody: '   \n\t\n  ' });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/requires the findings/);
  });

  it('lets a changes verdict WITH findings past the guard', () => {
    const { payload } = bounce({ verdictBody: 'the isolation claim is false: nothing sets cwd to a lane' });
    expect(payload.error ?? '').not.toMatch(/requires the findings/);
  });

  // THE ASYMMETRY IS THE POINT. An accept with no body is merely TERSE — the label already carries the whole
  // meaning, "nothing to do". Requiring one there would be a different, unasked-for change.
  it('does NOT touch --to=accepted — a terse accept still gets past this guard', () => {
    const { payload } = run({ argv: ['1178', '--repo=o/n', '--to=accepted'] });
    expect(payload.error ?? '').not.toMatch(/requires the findings/);
  });

  // `rearm` is the conveyor's hand-back to the fix agent, not a reviewer verdict, and carries no findings by
  // design — it re-arms a review rather than asking for a repair.
  it('does NOT touch the rearm target', () => {
    const { payload } = run({ argv: ['1178', '--repo=o/n'], fixedTo: 'rearm' });
    expect(payload.error ?? '').not.toMatch(/requires the findings/);
  });
});

/**
 * THE WRITE ARC, through the real `runReviewLabelCli` with a stub provider (#x8xf5rl).
 *
 * Everything above pins a PURE helper. Nothing before this reached `applySwap` / `postComment` or the branch
 * that chooses between them — there was no seam, so the #2964 ordering, which that file calls "the safety
 * property", had no test at all. It is the most consequential line in the review path: an orphan
 * `review:accepted` with no marker makes `acceptanceCoversHead` fail OPEN and the drain merges with the #2409
 * staleness gate disarmed.
 */
describe('the write arc and its #2964 ordering', () => {
  const CFG = {
    // Memory-store tests must never commit/push the running checkout. Real git tests override this.
    publishTrialFn: vi.fn(() => ({ committed: true, pushed: true })),
    defaultActor: 'test',
    usage: 'usage: test',
    buildComment: () => '# verdict body',
    successResult: (o) => ({ ok: true, ...o }),
    refusalResult: ({ decision }) => ({ error: decision.reason }),
  };

  /** Records the ORDER of port calls. Reads answer from `labels`, so a test picks the branch by state. */
  function stubProvider({ labels = [], body = '', title = '' } = {}) {
    const calls = [];
    return {
      calls,
      name: 'stub',
      currentRepo: () => 'o/n',
      readPrState: () => {
        calls.push('readPrState');
        return { labels: labels.map((name) => ({ name })), headRefOid: 'a'.repeat(40), headRefName: 'lane/x', state: 'OPEN', body, title };
      },
      readLabels: () => { calls.push('readLabels'); return labels.map((name) => ({ name })); },
      setLabels: (_r, _p, spec) => { calls.push('setLabels'); calls.push(spec); },
      postComment: () => { calls.push('postComment'); },
    };
  }

  const run = (provider, argv, config = {}) => {
    const chunks = [];
    const realExit = process.exit.bind(process);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = 0;
    try { runReviewLabelCli({ ...CFG, emit: (l) => chunks.push(String(l)), provider, argv, ...config }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally { process.exit = realExit; }
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  };

  it('COMMENT FIRST when review:accepted is not already live — an orphan label would disarm #2409', () => {
    const p = stubProvider({ labels: ['review:pending'] });
    run(p, ['1048', '--repo=o/n', '--to=accepted', '--actor=op']);
    const order = p.calls.filter((c) => c === 'postComment' || c === 'setLabels');
    expect(order).toEqual(['postComment', 'setLabels']);
  });

  it('SWAP FIRST when it is already live — comment-first would freshen coverage of an unapplied accept', () => {
    const p = stubProvider({ labels: ['review:accepted'] });
    run(p, ['1048', '--repo=o/n', '--to=accepted', '--actor=op']);
    const order = p.calls.filter((c) => c === 'postComment' || c === 'setLabels');
    expect(order).toEqual(['setLabels', 'postComment']);
  });

  it('never hands the swap a label the PR does not carry', () => {
    const p = stubProvider({ labels: ['review:pending'] });
    run(p, ['1048', '--repo=o/n', '--to=accepted', '--actor=op']);
    const spec = p.calls.find((c) => c && typeof c === 'object' && 'add' in c);
    expect(spec.add).toBe('review:accepted');
    for (const rm of spec.remove) { expect(['review:pending']).toContain(rm); }
  });

  it('a REFUSED run performs no write at all — the refusal precedes the port', () => {
    const p = stubProvider({ labels: ['review:human'] });
    const { exitCode } = run(p, ['1048', '--repo=o/n', '--to=accepted', '--actor=op']);
    expect(exitCode).not.toBe(0);
    expect(p.calls).not.toContain('setLabels');
    expect(p.calls).not.toContain('postComment');
  });

  describe('automatic session-delegation trials (#3690)', () => {
    const triple = { provider: 'codex', model: 'gpt-6-astra', taskType: 'bugfix' };
    const author = '<!-- authored-by-actor: delegation-author -->';
    const body = `${author}\n${buildDelegationMarker(triple)}`;
    const argv = ['1048', '--repo=o/n', '--to=accepted', `--channel=${REVIEW_PR_CHANNEL}`];
    const seeded = () => Array.from({ length: 6 }, (_, i) => ({
      ...triple, dispatchKind: 'session-delegation', verifiedBy: 'independent-claude',
      outcome: 'landed', findings: i === 0 ? 'Caught a quoting error' : null,
      scoredAt: `2026-09-0${i + 1}T00:00:00.000Z`,
    }));
    function memIo(records = []) {
      let store = { version: 1, records };
      return {
        read: () => JSON.stringify(store),
        write: (_p, s) => { store = JSON.parse(s); },
        exists: () => true,
      };
    }
    beforeEach(() => {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'independent-reviewer');
      CFG.publishTrialFn.mockClear();
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('records a real trial only after both acceptance writes, using the fetched title', () => {
      const p = stubProvider({ labels: ['review:pending'], body, title: 'Fix launch wrapper' });
      const io = memIo();
      const readTrialStore = vi.fn((passedIo) => {
        expect(passedIo).toBe(io);
        expect(p.calls).toContain('postComment');
        expect(p.calls).toContain('setLabels');
        expect(p.calls).not.toContain('readLabels');
        return readStore(passedIo);
      });
      const result = run(p, argv, { trialLogIo: io, readTrialStore });
      expect(result.exitCode).toBe(0);
      expect(result.payload.ok).toBe(true);
      expect(readTrialStore).toHaveBeenCalledTimes(1);
      expect(CFG.publishTrialFn).toHaveBeenCalledTimes(1);
      expect(CFG.publishTrialFn).toHaveBeenCalledWith({ ...triple, pr: 1048 });
      expect(readStore(io).records).toHaveLength(1);
      expect(readStore(io).records[0]).toMatchObject({
        ...triple, dispatchKind: 'session-delegation', pr: 1048,
        verifiedBy: 'independent-claude', outcome: 'landed', findings: null,
        taskDescription: 'Fix launch wrapper',
      });
    });

    it('does not append to an already-graduated triple', () => {
      const records = seeded();
      const io = memIo(records);
      const logTrialFn = vi.fn(logDelegationTrial);
      expect(run(stubProvider({ body }), argv, { trialLogIo: io, logTrialFn }).exitCode).toBe(0);
      expect(readStore(io).records).toEqual(records);
      expect(readStore(io).records).toHaveLength(6);
      expect(logTrialFn).not.toHaveBeenCalled();
      expect(CFG.publishTrialFn).not.toHaveBeenCalled();
    });

    it('does not append a second session-delegation trial when the same PR is re-accepted', () => {
      const io = memIo();
      const readTrialStore = vi.fn(readStore);
      const logTrialFn = vi.fn(logDelegationTrial);
      expect(run(stubProvider({ body }), argv, { trialLogIo: io, readTrialStore, logTrialFn }).exitCode).toBe(0);
      const records = readStore(io).records;
      expect(records).toHaveLength(1);
      readTrialStore.mockClear();
      logTrialFn.mockClear();
      CFG.publishTrialFn.mockClear();
      const write = vi.spyOn(io, 'write');
      expect(run(stubProvider({ body, labels: ['review:accepted'] }), argv,
        { trialLogIo: io, readTrialStore, logTrialFn }).exitCode).toBe(0);
      expect(readStore(io).records).toEqual(records);
      expect(readTrialStore).toHaveBeenCalledTimes(1);
      expect(logTrialFn).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(CFG.publishTrialFn).not.toHaveBeenCalled();
    });

    it.each([
      { pr: 1049, dispatchKind: 'session-delegation' },
      { pr: 1048, dispatchKind: 'conflict-resolution' },
    ])('still logs with a prior trial for $pr / $dispatchKind', (prior) => {
      const records = [{ ...seeded()[0], ...prior }];
      const io = memIo(records);
      const readTrialStore = vi.fn(readStore);
      const logTrialFn = vi.fn(logDelegationTrial);
      expect(run(stubProvider({ body }), argv, { trialLogIo: io, readTrialStore, logTrialFn }).exitCode).toBe(0);
      expect(readTrialStore).toHaveBeenCalledTimes(1);
      expect(logTrialFn).toHaveBeenCalledTimes(1);
      expect(readStore(io).records).toHaveLength(2);
      expect(readStore(io).records[0]).toEqual(records[0]);
      expect(readStore(io).records[1]).toMatchObject({ ...triple, pr: 1048, dispatchKind: 'session-delegation' });
    });

    it.each([{ records: [] }, { records: seeded() }])('does not read or log trials for Claude-native work', ({ records }) => {
      const io = memIo(records);
      const readTrialStore = vi.fn(readStore);
      const logTrialFn = vi.fn(logDelegationTrial);
      expect(run(stubProvider({ body: author }), argv, { trialLogIo: io, readTrialStore, logTrialFn }).exitCode).toBe(0);
      expect(readStore(io).records).toEqual(records);
      expect(readTrialStore).not.toHaveBeenCalled();
      expect(logTrialFn).not.toHaveBeenCalled();
    });

    it.each([null, 'manual /review', 'rearm-review', 'reconcile-finding', 'fake-review-pr-thing'])('does not log through channel %j', (channel) => {
      const io = memIo();
      const readTrialStore = vi.fn(readStore);
      const logTrialFn = vi.fn(logDelegationTrial);
      const args = argv.slice(0, 3).concat(channel === null ? [] : [`--channel=${channel}`]);
      expect(run(stubProvider({ body }), args, { trialLogIo: io, readTrialStore, logTrialFn }).exitCode).toBe(0);
      expect(readStore(io).records).toEqual([]);
      expect(readTrialStore).not.toHaveBeenCalled();
      expect(logTrialFn).not.toHaveBeenCalled();
    });

    it.each([
      '<!-- delegation: provider=codex model=gpt-6-astra taskType=invalid -->',
      '<!-- delegation: provider=codex taskType=bugfix -->',
      `${buildDelegationMarker(triple)}\n${buildDelegationMarker({ ...triple, model: 'other' })}`,
    ])('completes acceptance without logging malformed/ambiguous metadata: %s', (marker) => {
      const p = stubProvider({ labels: ['review:pending'], body: `${author}\n${marker}` });
      const io = memIo();
      expect(run(p, argv, { trialLogIo: io }).exitCode).toBe(0);
      expect(p.calls).toContain('postComment');
      expect(p.calls).toContainEqual({ add: 'review:accepted', remove: ['review:pending'] });
      expect(readStore(io).records).toEqual([]);
    });

    it.each(['changes', 'clear-human', 'rearm', 'restamp'])('does not log target %s even on the review-pr channel', (to) => {
      const io = memIo();
      const labels = to === 'clear-human' ? ['review:human'] : to === 'restamp' ? ['review:accepted'] : ['review:changes'];
      const args = ['1048', '--repo=o/n', `--channel=${REVIEW_PR_CHANNEL}`, '--actor=operator', '--reason=Repair needed'];
      const config = { fixedTo: to, allowClearHuman: true, verdictBody: 'Repair needed', trialLogIo: io };
      expect(run(stubProvider({ labels, body }), args, config).exitCode).toBe(0);
      expect(readStore(io).records).toEqual([]);
    });

    it('uses the PR number when the title is missing', () => {
      const io = memIo();
      expect(run(stubProvider({ body }), argv, { trialLogIo: io }).exitCode).toBe(0);
      expect(readStore(io).records[0].taskDescription).toBe('PR #1048');
    });

    it.each(['read', 'log', 'write'])('keeps acceptance successful on a trial %s failure', (failure) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const io = memIo();
      const fail = () => { throw new Error('trial storage unavailable'); };
      const config = { trialLogIo: io };
      if (failure === 'read') config.readTrialStore = fail;
      if (failure === 'log') config.logTrialFn = fail;
      if (failure === 'write') io.write = fail;
      const p = stubProvider({ body });
      expect(run(p, argv, config).exitCode).toBe(0);
      expect(p.calls).toContain('postComment');
      expect(p.calls).toContain('setLabels');
      expect(readStore(io).records).toEqual([]);
      expect(stderr.mock.calls.flat().join('')).toContain('delegation trial append failed (#3690, non-fatal)');
    });

    it.each(['postComment', 'setLabels'])('does not log when acceptance write %s fails', (method) => {
      const io = memIo();
      const p = stubProvider({ body });
      p[method] = () => { throw new Error('forge unavailable'); };
      const logTrialFn = vi.fn(logDelegationTrial);
      expect(run(p, argv, { trialLogIo: io, logTrialFn }).exitCode).not.toBe(0);
      expect(logTrialFn).not.toHaveBeenCalled();
      expect(readStore(io).records).toEqual([]);
    });

    it.each([false, true])('warns distinctly and preserves acceptance when publishing fails (committed=%s)', (committed) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const io = memIo();
      const publishTrialFn = vi.fn(() => ({ committed, pushed: false, reason: 'publication unavailable' }));
      const p = stubProvider({ body });
      const result = run(p, argv, { trialLogIo: io, publishTrialFn });
      expect(result.exitCode).toBe(0);
      expect(result.payload.ok).toBe(true);
      expect(p.calls).toContain('postComment');
      expect(p.calls).toContain('setLabels');
      expect(readStore(io).records).toHaveLength(1);
      expect(publishTrialFn).toHaveBeenCalledTimes(1);
      expect(publishTrialFn).toHaveBeenCalledWith({ ...triple, pr: 1048 });
      const warning = stderr.mock.calls.flat().join('');
      expect(warning).toContain('WRITTEN LOCALLY BUT NOT ON SHARED HISTORY');
      expect(warning).toContain('publication unavailable');
      expect(warning).toContain(committed ? 'a local commit' : "this checkout's working tree");
      expect(warning).toContain('commit+push scripts/conveyor/run-scorecards.json by hand');
      expect(warning).not.toContain('delegation trial append failed');
    });

    describe('against real local and bare remote git fixtures', () => {
      let repo, remote;
      const path = 'scripts/conveyor/run-scorecards.json';
      const pushIfGreenPath = join(dirname(fileURLToPath(import.meta.url)), '../push-if-green.mjs');
      const gateTests = [
        'scripts/__tests__/review-set-label.test.mjs',
        'scripts/conveyor/__tests__/run-scorecard-store.test.mjs',
        'scripts/conveyor/__tests__/log-delegation-trial.test.mjs',
      ];
      const git = (...args) => execFileSync('git', args, {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const publish = () => publishDelegationTrialCommit({ ...triple, pr: 1048, cwd: repo });
      const append = () => logDelegationTrial({
        ...triple, pr: 1048, taskDescription: 'Fix launch wrapper', outcome: 'landed',
        verifiedBy: 'independent-claude', findings: null,
      }, { path: join(repo, path) });

      beforeEach(() => {
        repo = mkdtempSync(join(tmpdir(), 'delegation-trial-local-'));
        remote = mkdtempSync(join(tmpdir(), 'delegation-trial-remote-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 'test@test');
        git('config', 'user.name', 'Test');
        git('config', 'commit.gpgsign', 'false');
        const sourceRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8',
        }).trim();
        // Exercise the real hook and its complete dependency graph from the fixture's own cwd.
        // No POC registry is copied: the real prototype guard reads an empty registry and allows.
        const hookFiles = [
          '.githooks/pre-push',
          'scripts/guard-git-push.mjs',
          'scripts/guard-prototype-tracker.mjs',
          'scripts/lib/poc-branches.mjs',
          'scripts/lib/prototype-tracker-data.mjs',
          'scripts/lib/local-date.mjs',
        ];
        for (const file of hookFiles) {
          mkdirSync(dirname(join(repo, file)), { recursive: true });
          copyFileSync(join(sourceRoot, file), join(repo, file));
        }
        chmodSync(join(repo, '.githooks/pre-push'), 0o755);
        git('config', 'core.hooksPath', join(repo, '.githooks'));
        mkdirSync(join(repo, 'scripts/conveyor'), { recursive: true });
        writeFileSync(join(repo, path), '{"version":1,"records":[]}\n');
        // A real npm subprocess exercises the gate transport without recursively running this suite.
        // Keep evidence under .git so neither the commit pathspec nor clean-tree assertions hide it.
        writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'node fixture-gate.mjs' } }));
        writeFileSync(join(repo, 'fixture-gate.mjs'), `
          import { writeFileSync, existsSync } from 'node:fs';
          import { deepStrictEqual } from 'node:assert';
          deepStrictEqual(process.argv.slice(2), ${JSON.stringify(gateTests)});
          writeFileSync('.git/gate-args.json', JSON.stringify(process.argv.slice(2)));
          console.log('fixture gate stdout: must not contaminate the JSON result');
          process.exit(existsSync('.git/gate-red') ? 1 : 0);
        `);
        git('add', '--', path, ...hookFiles, 'package.json', 'fixture-gate.mjs');
        git('commit', '-qm', 'seed scorecard store');
        git('init', '-q', '--bare', remote);
        git('remote', 'add', 'origin', remote);
        execFileSync('git', ['push', 'origin', 'main'], {
          cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MAIN_PUSH_OK: '1' },
        });
      });
      afterEach(() => {
        rmSync(repo, { recursive: true, force: true });
        rmSync(remote, { recursive: true, force: true });
      });

      it('the REAL pre-push hook rejects an unauthorized main push and allows MAIN_PUSH_OK=1 (#2313 review bounce #3 regression guard)', () => {
        const remoteHead = git(`--git-dir=${remote}`, 'rev-parse', 'main');
        append();
        git('commit', '-qm', 'add trial for hook regression', '--', path);
        const localHead = git('rev-parse', 'HEAD');
        expect(localHead).not.toBe(remoteHead);
        const env = { ...process.env };
        delete env.MAIN_PUSH_OK;
        delete env.PROTOTYPE_TRACKER_PUSH_OK;
        const options = { cwd: repo, encoding: 'utf8', env };
        const rejected = spawnSync('git', ['push', 'origin', 'main'], options);
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toContain('pre-push BLOCKED: a push targets `main`');
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(remoteHead);

        const allowed = spawnSync('git', ['push', 'origin', 'main'], {
          ...options, env: { ...env, MAIN_PUSH_OK: '1' },
        });
        expect(allowed.error).toBeUndefined();
        expect(allowed.status).toBe(0);
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(localHead);
      });

      it('accepts, appends, commits, and publishes the actual row to shared history', () => {
        const p = stubProvider({ labels: ['review:pending'], body, title: 'Fix launch wrapper' });
        const result = run(p, argv, {
          trialLogIo: { path: join(repo, path) },
          publishTrialFn: (args) => publishDelegationTrialCommit({ ...args, cwd: repo }),
        });
        expect(result.exitCode).toBe(0);
        expect(result.payload.ok).toBe(true);
        expect(JSON.parse(readFileSync(join(repo, '.git/gate-args.json'), 'utf8'))).toEqual(gateTests);
        const log = git('log', '--oneline', '--', path).split('\n');
        expect(log).toHaveLength(2);
        expect(log[0]).toContain('conveyor: log codex/gpt-6-astra bugfix trial for PR #1048 (#3690)');
        expect(git('status', '--porcelain')).toBe('');
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
        const store = JSON.parse(readFileSync(join(repo, path), 'utf8'));
        expect(store.records).toHaveLength(1);
        expect(store.records[0]).toMatchObject({ ...triple, pr: 1048, outcome: 'landed', findings: null });
        expect(JSON.parse(git(`--git-dir=${remote}`, 'show', `main:${path}`))).toEqual(store);
      });

      it('commits only the scorecard even with an unrelated staged change', () => {
        writeFileSync(join(repo, 'unrelated.txt'), 'leave staged\n');
        git('add', '--', 'unrelated.txt');
        append();
        expect(publish()).toMatchObject({ committed: true, pushed: true });
        expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(path);
        expect(git('status', '--porcelain')).toBe('A  unrelated.txt');
      });

      it('refuses diverged local main without committing or shipping another process\'s stray commit', () => {
        const remoteHead = git(`--git-dir=${remote}`, 'rev-parse', 'main');
        writeFileSync(join(repo, 'stray-from-another-process.txt'), 'unrelated\n');
        git('add', '--', 'stray-from-another-process.txt');
        git('commit', '-qm', 'stray unrelated commit');
        const straySha = git('rev-parse', 'HEAD');
        append();
        const result = publish();
        expect(result).toEqual({ committed: false, pushed: false, reason: expect.stringContaining('diverged history') });
        expect(result.reason).toContain(straySha.slice(0, 8));
        expect(result.reason).toContain(remoteHead.slice(0, 8));
        expect(git('rev-parse', 'HEAD')).toBe(straySha);
        expect(git('status', '--porcelain')).toBe(`M ${path}`);
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(remoteHead);
        expect(() => git(`--git-dir=${remote}`, 'show', 'main:stray-from-another-process.txt')).toThrow();
      });

      it('pushes exactly --sha even when a later unrelated commit has advanced local main', () => {
        append();
        git('commit', '-qm', 'trial commit (the ONE we intend to publish)', '--', path);
        const intendedSha = git('rev-parse', 'HEAD');
        writeFileSync(join(repo, 'later-unrelated.txt'), 'later\n');
        git('add', '--', 'later-unrelated.txt');
        git('commit', '-qm', 'a LATER unrelated commit that must NOT be published');
        const laterSha = git('rev-parse', 'HEAD');
        const out = execFileSync(process.execPath, [
          pushIfGreenPath, `--repo=${repo}`, `--sha=${intendedSha}`,
          `--gate=npm run test:unit -- ${gateTests.join(' ')}`, '--json',
        ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAIN_PUSH_OK: '1' } });
        expect(JSON.parse(out)).toMatchObject({ pushed: true, gate: 'green' });
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(intendedSha);
        expect(git('rev-parse', 'main')).toBe(laterSha);
        expect(() => git(`--git-dir=${remote}`, 'show', 'main:later-unrelated.txt')).toThrow();
        const store = JSON.parse(git(`--git-dir=${remote}`, 'show', `main:${path}`));
        expect(store.records).toHaveLength(1);
        expect(store.records[0]).toMatchObject({ ...triple, pr: 1048, outcome: 'landed' });
      });

      it.each(['missing', 'unrelated'])('refuses a %s --sha before gating or pushing', (kind) => {
        const remoteHead = git(`--git-dir=${remote}`, 'rev-parse', 'main');
        const sha = kind === 'missing' ? 'not-a-commit' : git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated root');
        const result = spawnSync(process.execPath, [
          pushIfGreenPath, `--repo=${repo}`, `--sha=${sha}`,
          `--gate=npm run test:unit -- ${gateTests.join(' ')}`, '--json',
        ], { cwd: repo, encoding: 'utf8', env: { ...process.env, MAIN_PUSH_OK: '1' } });
        expect(result.status).toBe(3);
        expect(JSON.parse(result.stdout)).toMatchObject({
          pushed: false, gate: 'skipped', reason: kind === 'missing' ? 'no-such-sha' : 'sha-not-on-branch',
        });
        expect(existsSync(join(repo, '.git/gate-args.json'))).toBe(false);
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(remoteHead);
      });

      it('leaves the committed trial local when the scoped gate is red', () => {
        const remoteHead = git(`--git-dir=${remote}`, 'rev-parse', 'main');
        writeFileSync(join(repo, '.git/gate-red'), 'red');
        append();
        expect(publish()).toMatchObject({ committed: true, pushed: false, reason: expect.stringContaining('is RED') });
        expect(JSON.parse(readFileSync(join(repo, '.git/gate-args.json'), 'utf8'))).toEqual(gateTests);
        expect(git('rev-parse', 'HEAD')).not.toBe(remoteHead);
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(remoteHead);
      });

      it.each(['lane/test', 'detached'])('refuses to commit or push on %s before changing history', (branch) => {
        if (branch === 'detached') git('checkout', '--detach');
        else git('checkout', '-b', branch);
        const head = git('rev-parse', 'HEAD');
        append();
        const result = publish();
        expect(result).toMatchObject({ committed: false, pushed: false });
        expect(result.reason).toContain('commit skipped');
        expect(git('rev-parse', 'HEAD')).toBe(head);
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(head);
        expect(git('status', '--porcelain')).toBe(`M ${path}`);
      });

      it('reports a commit failure without throwing', () => {
        expect(publish()).toMatchObject({ committed: false, pushed: false, reason: expect.stringContaining('git commit failed') });
      });

      it('recovers the real push helper JSON on a non-zero exit', () => {
        // Fetch succeeds; the remote rejects only the final push, after the commit and green gate.
        writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n');
        chmodSync(join(remote, 'hooks/pre-receive'), 0o755);
        append();
        const result = publish();
        expect(result).toMatchObject({ committed: true, pushed: false });
        expect(result.reason).toContain('origin unchanged');
        expect(git('status', '--porcelain')).toBe('');
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).not.toBe(git('rev-parse', 'HEAD'));
      });

      it('refuses to commit when fetching origin/main fails', () => {
        const head = git('rev-parse', 'HEAD');
        git('remote', 'set-url', 'origin', join(repo, 'missing-remote'));
        append();
        expect(publish()).toMatchObject({ committed: false, pushed: false, reason: expect.stringContaining('could not fetch origin/main') });
        expect(git('rev-parse', 'HEAD')).toBe(head);
        expect(git(`--git-dir=${remote}`, 'rev-parse', 'main')).toBe(head);
      });
    });
  });

});

/**
 * `restamp` (#x5e2ldj) — CARRY an acceptance across a head the drain itself moved.
 *
 * THE LOOP IT ENDS, measured on PR #1445 on 2026-08-19: a clearance landed at 13:06:48 and the drain rebased
 * that lane onto the newly-merged main a minute later. The rebase is content-preserving, but a rebase onto a
 * moved base can change the context-RUN LENGTHS the contribution digest keeps, so the markers went stale and
 * `review:human` was re-parked — on the PR the drain was itself about to land. Clear, rebase, re-park, repeat.
 *
 * `we:scripts/lib/review-escalation.mjs` names this fix in its POSITION section: the drain KNOWS it produced
 * the rebase, so it can re-stamp rather than leave a gate to re-derive what it already knew.
 *
 * WHAT MAKES IT SAFE IS EVERY WAY IT REFUSES. It moves no label; it can only ever carry an acceptance that is
 * already live. The tests below are mostly refusals for that reason — a `restamp` that could CREATE an
 * acceptance would be a strictly worse `accepted`: one that skips INVARIANT 2, skips #2844's independence
 * check, and claims a review nobody ran.
 */
describe('decideSetLabel — restamp carries an acceptance, and can do nothing else', () => {
  const decide = (currentLabels) => decideSetLabel({ to: 'restamp', currentLabels });

  it('ALLOWS the one case it exists for: a live review:accepted, nothing contradicting it', () => {
    const d = decide(['review:accepted']);
    expect(d.allowed).toBe(true);
    expect(d.reason).toMatch(/no review was re-run/);
  });

  it('moves NO label — the label set was already right; only the markers went stale', () => {
    const d = decide(['review:accepted', 'ready-to-merge']);
    expect(d.removeLabels).toEqual([]);
    expect(d.addLabel).toBe('review:accepted');   // already present: the swap is a no-op by construction
  });

  it('REFUSES with no acceptance to carry — it may never manufacture one', () => {
    for (const labels of [[], ['review:pending'], ['review:changes'], ['ready-to-merge']]) {
      const d = decide(labels);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/no acceptance to carry/);
    }
  });

  it('REFUSES on an uncleared review:human — a rebase must not complete a gate-self acceptance', () => {
    const d = decide(['review:accepted', 'review:human']);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/gate-self/);
  });

  it('REFUSES the contradictory accepted+changes pair rather than resolving it (#2974)', () => {
    // `accepted` strips a stale `changes` because a reviewer just decided. A re-stamp decides nothing, so
    // resolving the contradiction in the acceptance's favour would be this target inventing a verdict.
    const d = decide(['review:accepted', 'review:changes']);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/re-review the PR/);
  });

  it('is in the closed target set, so every totality sweep covers it', () => {
    expect(REVIEW_LABEL_TARGETS).toContain('restamp');
  });
});

/**
 * The RE-STAMP heading (#x5e2ldj, caught by the review of PR #1482 as a blocker).
 *
 * The heading ternary was not extended for the new target, so a re-stamped ACCEPTANCE fell through to the
 * BOUNCE arm and announced itself as "🔁 review — changes requested". A durable comment that states the
 * opposite of what happened is worse than no comment: the label said accepted, the comment said bounced, and a
 * reader would have believed the prose.
 */
describe('buildVerdictComment — a re-stamp says what it is', () => {
  const build = (to) => buildVerdictComment({ to, actor: 'drain', headSha: 'f5bc7940', reason: 'r', body: '' });

  it('does NOT render a re-stamp as a bounce', () => {
    expect(build('restamp')).not.toContain('changes requested');
  });

  it('does NOT render a re-stamp as a fresh accept either — no review was run', () => {
    const out = build('restamp');
    expect(out).toContain('re-stamped');
    expect(out).toMatch(/no new review/i);
  });

  it('leaves the three headings it already had exactly as they were', () => {
    expect(build('accepted')).toContain('✅ review — accepted');
    expect(build('changes')).toContain('🔁 review — changes requested');
    expect(build('clear-human')).toContain('cleared via the sanctioned path');
  });
});

/**
 * #x9krtkb — THE LOOP: a human clears `review:human`, the drain rebases (content-preserving), the restamp
 * carries `reviewed-sha`/`reviewed-diff`/`reviewed-contribution` forward but not `cleared-human`, and the next
 * drain pass's anti-test-gaming gate sees no human coverage for the new head and re-parks `review:human` — on a
 * PR a human had JUST cleared. Measured live on PR #2572 (chalbert/web-everything), 2026-09-24.
 *
 * `buildVerdictComment`'s half of the fix: given the caller's own proof (`humanClearance`, computed by
 * `decideRestampHumanClearance` below), does the RENDERED restamp comment actually carry the marker forward,
 * bound to the NEW head — and does a PLAIN restamp (no `humanClearance`) stay exactly as it was before this
 * item, i.e. render nothing human-shaped at all.
 */
describe('buildVerdictComment — a restamp carries a human clearance forward (#x9krtkb)', () => {
  const NEW_HEAD = '1f27fd19f6841d9df5c9f8ce7b4b4f3b8319bc54';
  const OLD_SHA = 'f1dbbc3170b7dcbabf6c3ea19c469e3c636231b6';

  it('a PLAIN restamp (no humanClearance) renders no cleared-human marker — unchanged from before this item', () => {
    const out = buildVerdictComment({ to: 'restamp', actor: 'drain', headSha: NEW_HEAD, reviewedDiff: 'd'.repeat(64) });
    expect(out).not.toContain('cleared-human');
    expect(parseOperatorClearance([{ body: out }])).toBe(null);
  });

  it('a restamp WITH a proven humanClearance stamps cleared-human, bound to the NEW head', () => {
    const out = buildVerdictComment({
      to: 'restamp', actor: 'drain', headSha: NEW_HEAD, reviewedDiff: 'd'.repeat(64),
      humanClearance: { actor: 'chalbert', sha: OLD_SHA },
    });
    // The marker names the ORIGINAL clearer, not the restamping actor ("drain").
    expect(out).toContain(buildClearedHumanMarker('chalbert'));
    expect(parseOperatorClearance([{ body: out }])).toEqual({ actor: 'chalbert' });
    // The SHA marker it stamps is the NEW head — this comment vouches for THIS tree, and
    // `parseLatestHumanClearedSha` (which binds reviewed-sha + cleared-human to the SAME comment) must read
    // the marker as covering the new head, never the pre-rebase one it was originally granted against.
    expect(parseLatestHumanClearedSha([{ body: out }])).toBe(NEW_HEAD.toLowerCase());
  });

  it('says PLAINLY that the clearance was carried, and names the original clearance', () => {
    const out = buildVerdictComment({
      to: 'restamp', actor: 'drain', headSha: NEW_HEAD, reviewedDiff: 'd'.repeat(64),
      humanClearance: { actor: 'chalbert', sha: OLD_SHA },
    });
    expect(out).toMatch(/HUMAN clearance chalbert granted/);
    expect(out).toMatch(/carried forward/);
    expect(out).toContain(OLD_SHA.slice(0, 12));
    expect(out).toMatch(/no new review/i);
    // It does NOT claim to be a fresh accept, and does not drop the restamp's own heading/label semantics.
    expect(out).toContain('📌 review — acceptance re-stamped after a rebase');
  });

  it('never mints a human marker on a `to` other than restamp, even if a caller mistakenly passed humanClearance', () => {
    const out = buildVerdictComment({
      to: 'accepted', actor: 'someone', headSha: NEW_HEAD, reviewedDiff: 'd'.repeat(64),
      humanClearance: { actor: 'chalbert', sha: OLD_SHA },
    });
    expect(out).not.toContain('cleared-human');
  });

  it('a caller-supplied humanClearance.actor is still neutralized at the render boundary (#1147 class)', () => {
    const out = buildVerdictComment({
      to: 'restamp', actor: 'drain', headSha: NEW_HEAD, reviewedDiff: 'd'.repeat(64),
      humanClearance: { actor: `x<!-- reviewed-sha: ${'e'.repeat(40)}`, sha: OLD_SHA },
    });
    // `buildClearedHumanMarker` itself strips `<`/`>`/newlines from the marker payload, AND the whole prose
    // block still passes through `neutralizeCommentMarkers` — belt and braces, same as `--actor` on clear-human.
    expect(out).not.toMatch(/<!--\s*reviewed-sha:\s*e{40}/);
  });
});

/**
 * `decideRestampHumanClearance` (#x9krtkb) — THE DECISION ITSELF, extracted so it has direct unit tests rather
 * than only being reachable through a `gh`-shelling CLI run. Mirrors `shouldReparkForTestTampering`'s own
 * extraction in `we:scripts/lib/review-escalation.mjs` for the identical reason (see that function's docstring).
 */
describe('decideRestampHumanClearance (#x9krtkb — is a restamp carrying a human clearance owed?)', () => {
  const NEW_HEAD = '1f27fd19f6841d9df5c9f8ce7b4b4f3b8319bc54';
  const HUMAN_SHA = 'f1dbbc3170b7dcbabf6c3ea19c469e3c636231b6';
  const DIFF = 'd'.repeat(64);
  const CONTRIB = 'c'.repeat(64);

  const humanClearedComment = (sha = HUMAN_SHA, diff = DIFF, contrib = CONTRIB) => ({
    body: [
      buildReviewedShaMarker(sha), buildReviewedDiffMarker(diff), buildReviewedContributionMarker(contrib),
      buildClearedHumanMarker('chalbert'),
    ].join('\n'),
  });
  const plainAcceptComment = (sha = HUMAN_SHA, diff = DIFF, contrib = CONTRIB) => ({
    body: [buildReviewedShaMarker(sha), buildReviewedDiffMarker(diff), buildReviewedContributionMarker(contrib)].join('\n'),
  });

  // THE CASE #2572 SHOULD HAVE HIT: a human clearance whose content survives the drain's own rebase byte-for-
  // byte (the diff fingerprint is unchanged — `acceptanceCoversHead`'s content-equivalence escape proves it).
  it('carries the clearance forward when the latest accept was human-cleared AND the content is unchanged', () => {
    const out = decideRestampHumanClearance({ comments: [humanClearedComment()], headSha: NEW_HEAD, headDiff: DIFF });
    expect(out).toEqual({ actor: 'chalbert', sha: HUMAN_SHA });
  });

  // A PLAIN AGENT ACCEPT RESTAMP STAYS PLAIN — the whole point of binding the SHA and the marker to the SAME
  // comment in `parseLatestHumanClearedSha`. No human marker exists to carry.
  it('returns null for a restamp of a PLAIN agent accept — never mints a clearance that never existed', () => {
    const out = decideRestampHumanClearance({ comments: [plainAcceptComment()], headSha: NEW_HEAD, headDiff: DIFF });
    expect(out).toBe(null);
  });

  // CONTRIBUTION CHANGED → NO CARRY. The content actually differs at the new head (a real commit rode in, not
  // just a rebase), so `acceptanceCoversHead` cannot prove equivalence and the carry must fail CLOSED.
  it('returns null when the reviewed content changed — the equivalence check cannot be skipped', () => {
    const out = decideRestampHumanClearance({
      comments: [humanClearedComment()], headSha: NEW_HEAD, headDiff: 'DIFFERENT-CONTENT-DIFF-TEXT',
    });
    expect(out).toBe(null);
  });

  it('returns null with no comments at all', () => {
    expect(decideRestampHumanClearance({ comments: [], headSha: NEW_HEAD, headDiff: DIFF })).toBe(null);
    expect(decideRestampHumanClearance({ comments: undefined, headSha: NEW_HEAD, headDiff: DIFF })).toBe(null);
  });

  it('an OLDER human clearance superseded by a later PLAIN accept does not count (the binding #xuboo0q proves)', () => {
    const out = decideRestampHumanClearance({
      comments: [humanClearedComment(), plainAcceptComment('a'.repeat(40), 'e'.repeat(64), 'e'.repeat(64))],
      headSha: NEW_HEAD, headDiff: 'e'.repeat(64),
    });
    expect(out).toBe(null);
  });

  // THE ROUND TRIP TO THE ANTI-TEST-GAMING GATE — the whole point of the fix. Once `decideRestampHumanClearance`
  // says a carry is owed and `buildVerdictComment` renders it, `parseLatestHumanClearedSha` reading that SAME
  // rendered comment back must report the NEW head as human-covered, and `shouldReparkForTestTampering` must
  // therefore NOT re-park — closing the exact loop that repeated on PR #2572.
  it('round-trips through buildVerdictComment + parseLatestHumanClearedSha into shouldReparkForTestTampering:false', () => {
    const carried = decideRestampHumanClearance({ comments: [humanClearedComment()], headSha: NEW_HEAD, headDiff: DIFF });
    expect(carried).not.toBe(null);
    const restampComment = buildVerdictComment({
      to: 'restamp', actor: 'drain', headSha: NEW_HEAD, reviewedDiff: DIFF, humanClearance: carried,
    });
    const humanClearedSha = parseLatestHumanClearedSha([humanClearedComment(), { body: restampComment }]);
    expect(humanClearedSha).toBe(NEW_HEAD.toLowerCase());
    expect(shouldReparkForTestTampering({
      tampered: true, netDiffScored: true, humanClearedSha, headSha: NEW_HEAD,
    })).toBe(false);
  });

  // THE NEGATIVE OF THAT SAME ROUND TRIP — a PLAIN restamp (no carry) leaves the gate exactly as re-park-prone
  // as it was before this item, proving the fix is additive rather than accidentally loosening the gate.
  it('a PLAIN restamp (no carried clearance) still re-parks — the fix never weakens the gate', () => {
    const restampComment = buildVerdictComment({ to: 'restamp', actor: 'drain', headSha: NEW_HEAD, reviewedDiff: DIFF });
    const humanClearedSha = parseLatestHumanClearedSha([plainAcceptComment(), { body: restampComment }]);
    expect(humanClearedSha).toBe(null);
    expect(shouldReparkForTestTampering({
      tampered: true, netDiffScored: true, humanClearedSha, headSha: NEW_HEAD,
    })).toBe(true);
  });
});

/**
 * #x9krtkb (bug 2) — `restamp` STAMPS THE NEW HEAD, through `runReviewLabelCli`'s own `--new-head` override,
 * exercised end to end with a stub provider (no real `gh`/git). Before this fix the CLI always trusted its own
 * fresh `readPrState().headRefOid` — which raced GitHub's propagation of the very push that produced the value
 * it was meant to confirm, and stamped the STALE pre-rebase head on PR #2572.
 */
describe('runReviewLabelCli — restamp stamps the CALLER-asserted --new-head, not a racy re-read (#x9krtkb bug 2)', () => {
  const STALE_HEAD = 'f1dbbc3170b7dcbabf6c3ea19c469e3c636231b6';
  const NEW_HEAD = '1f27fd19f6841d9df5c9f8ce7b4b4f3b8319bc54';

  function stubProvider({ labels = ['review:accepted'], comments = [] } = {}) {
    const calls = [];
    return {
      calls,
      name: 'stub',
      currentRepo: () => 'o/n',
      // `gh` still (racily) reports the STALE head — the whole point of the test: the override must win.
      readPrState: () => ({
        labels: labels.map((name) => ({ name })), headRefOid: STALE_HEAD, headRefName: 'lane/x', state: 'OPEN',
        body: '', comments,
      }),
      readLabels: () => labels.map((name) => ({ name })),
      setLabels: () => { calls.push('setLabels'); },
      postComment: () => { calls.push('postComment'); },
    };
  }

  function run({ provider, argv, captured }) {
    const CFG = {
      defaultActor: 'drain',
      usage: 'usage: test',
      buildComment: (o) => { captured.push(o); return '# body'; },
      successResult: (o) => ({ ok: true, ...o }),
      refusalResult: ({ decision }) => ({ error: decision.reason }),
    };
    const chunks = [];
    const realExit = process.exit.bind(process);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = 0;
    try { runReviewLabelCli({ ...CFG, emit: (l) => chunks.push(String(l)), provider, argv }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally { process.exit = realExit; }
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  it('stamps --new-head over the re-read headRefOid when both are present', () => {
    const captured = [];
    const { exitCode } = run({
      provider: stubProvider(), captured,
      argv: ['2572', '--repo=o/n', '--to=restamp', '--actor=drain', `--new-head=${NEW_HEAD}`],
    });
    expect(exitCode).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].headSha).toBe(NEW_HEAD);
    expect(captured[0].headSha).not.toBe(STALE_HEAD);
  });

  it('falls back to the re-read headRefOid when no --new-head is supplied (pre-#x9krtkb behaviour)', () => {
    const captured = [];
    const { exitCode } = run({
      provider: stubProvider(), captured, argv: ['2572', '--repo=o/n', '--to=restamp', '--actor=drain'],
    });
    expect(exitCode).toBe(0);
    expect(captured[0].headSha).toBe(STALE_HEAD);
  });

  it('REFUSES a malformed --new-head before any gh write', () => {
    const captured = [];
    const p = stubProvider();
    const { exitCode, payload } = run({
      provider: p, captured, argv: ['2572', '--repo=o/n', '--to=restamp', '--actor=drain', '--new-head=not-a-sha'],
    });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toMatch(/invalid --new-head/);
    expect(p.calls).toEqual([]);
  });

  // END TO END: the caller passes BOTH the new head and the PR's own comments (a prior clear-human whose
  // content is unchanged at that head) — the restamp must carry the clearance forward, bound to --new-head,
  // through the REAL `runReviewLabelCli` wiring, not just the pure decider in isolation.
  it('carries a human clearance forward to --new-head end to end through runReviewLabelCli', () => {
    const DIFF = 'd'.repeat(64);
    const humanClearedComment = {
      body: [
        buildReviewedShaMarker(STALE_HEAD), buildReviewedDiffMarker(DIFF), buildReviewedContributionMarker(DIFF),
        buildClearedHumanMarker('chalbert'),
      ].join('\n'),
    };
    const captured = [];
    // `reviewedDiff` inside `runReviewLabelCli` comes from `computeNetDiffText`, a REAL git call this stub
    // provider does not intercept; against a ref that cannot resolve it fails soft to `''` (documented at the
    // call site: "miss → no marker → SHA-identity fallback"). So this asserts the WIRING (comments reach
    // `decideRestampHumanClearance`, its result reaches `buildComment`), not the git-backed fingerprint match —
    // that half is covered without any subprocess by the `decideRestampHumanClearance` suite above.
    const { exitCode } = run({
      provider: stubProvider({ comments: [humanClearedComment] }), captured,
      argv: ['2572', '--repo=o/n', '--to=restamp', '--actor=drain', `--new-head=${NEW_HEAD}`],
    });
    expect(exitCode).toBe(0);
    expect(captured[0].headSha).toBe(NEW_HEAD);
    // humanClearance is present in the call iff decideRestampHumanClearance found coverage; assert the shape
    // contract (present or null), never a truthiness guess, so a silent signature drift fails loudly here.
    expect(captured[0]).toHaveProperty('humanClearance');
  });
});

/**
 * #2897 — WHERE A `--body-file` MAY LIVE.
 *
 * The guard exists because the file's contents are published to a PUBLIC PR and cannot be unpublished, so an
 * unconstrained path turns a review CLI into an exfiltration primitive. This widens the allowlist and never
 * removes the check.
 *
 * What was wrong: the roots were `process.cwd()` and `tmpdir()` compared AS WRITTEN. On macOS `tmpdir()` is a
 * per-user folder under `/var/folders/…`, so the conventional shared `/tmp` was refused — and `/tmp` is itself
 * a symlink to `/private/tmp` there, so even naming the real temp dir could be refused on spelling. A caller
 * who cannot use the sanctioned flag hand-rolls a comment instead, which is the exact bypass #2882 closed. A
 * usability defect that pushes people off the safe path is a safety defect one step removed.
 */
describe('checkBodyFileLocation (#2897)', () => {
  const TMP = realpathSync(tmpdir());

  it('accepts the OS temp dir', () => {
    expect(checkBodyFileLocation(join(TMP, 'verdict.md'), bodyFileRoots()).ok).toBe(true);
  });

  /**
   * THE macOS CASE, tested by SHAPE because it cannot be reproduced here. On Linux `tmpdir()` IS `/tmp`, so a
   * host-dependent assertion passes either way — dropping `/tmp` from the roots reddened nothing until this
   * was written. On macOS `tmpdir()` is a per-user folder under `/var/folders/…` and `/tmp` is neither it nor
   * a prefix of it, which is the whole reason the shared path is listed explicitly.
   */
  it('lists the conventional shared /tmp explicitly, not merely via tmpdir()', () => {
    expect(bodyFileRoots('/repo', '/var/folders/ab/T')).toContain('/tmp');
  });

  it('accepts /tmp on a host whose OS temp dir is somewhere else entirely', () => {
    // THE PATH UNDER TEST IS THE LITERAL `/tmp`, not `join(TMP, …)` — and that is the whole point of the case.
    // The claim is "`/tmp` is accepted EVEN WHEN the OS temp dir is somewhere else", so the roots are a
    // synthetic macOS-ish pair and the path must be the one the shared root is supposed to rescue.
    //
    // Using `join(TMP, …)` made this pass on Linux for the wrong reason and fail on every Mac for the right
    // one: there `TMP` IS `/tmp`, so it matched the shared root by coincidence; on macOS `TMP` resolves to
    // `/private/var/folders/<hash>/T`, which matches none of the three roots, so the assertion inverted. It
    // reddened for every macOS developer, on `main`, unattributable to any change — and three separate agents
    // each spent time ruling it out of their own work before reporting it (#3327). A test that fails for
    // everyone and belongs to no one teaches readers to discount a red suite, which costs more than the test
    // was ever worth.
    const macOsish = bodyFileRoots('/repo', '/var/folders/ab/T');
    expect(checkBodyFileLocation('/tmp/verdict.md', macOsish).ok).toBe(true);
    // …and without the shared root it would be refused, which is the defect this closes.
    expect(checkBodyFileLocation('/tmp/verdict.md', ['/repo', '/var/folders/ab/T']).ok).toBe(false);
  });

  it('accepts a scratch path nested under a temp root — an agent session scratchpad is not special', () => {
    expect(checkBodyFileLocation(join(TMP, 'claude-0', 'session', 'verdict.md'), bodyFileRoots()).ok).toBe(true);
  });

  it('accepts a file under the repo root', () => {
    expect(checkBodyFileLocation(join(realpathSync(process.cwd()), '.operations', 'v.md'), bodyFileRoots()).ok).toBe(true);
  });

  // THE GUARD IS INTACT. This is the direction that matters: the check exists to stop the CLI publishing
  // whatever a stale shell variable happened to point at.
  it('still refuses a path outside every root', () => {
    for (const p of [join(homedir(), '.ssh', 'config'), '/etc/passwd', join(homedir(), 'notes.md')]) {
      expect(checkBodyFileLocation(p, bodyFileRoots()).ok).toBe(false);
    }
  });

  // Resolved on BOTH sides, so a root reached by a different spelling is not refused for it.
  it('compares resolved paths, so a symlinked temp dir is not refused on spelling', () => {
    const dir = mkdtempSync(join(TMP, 'bodyfile-'));
    const link = join(TMP, `bodyfile-link-${process.pid}`);
    try {
      symlinkSync(dir, link);
      expect(checkBodyFileLocation(join(link, 'v.md'), bodyFileRoots()).ok).toBe(true);
      // …and a symlink pointing OUT of the allowlist is still refused, which is the half that matters.
      const escape = join(TMP, `bodyfile-escape-${process.pid}`);
      symlinkSync(homedir(), escape);
      expect(checkBodyFileLocation(join(escape, '.ssh', 'config'), bodyFileRoots()).ok).toBe(false);
      rmSync(escape, { force: true });
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A path whose PARENTS do not exist yet must still be compared in resolved form. Resolving only the
   * immediate parent left the literal path when an intermediate directory was absent, and a literal path
   * compared against resolved roots is the very spelling mismatch this widening exists to end: on macOS
   * `/tmp/scratch/verdict.md` under a not-yet-created `scratch/` was refused against a root resolved to
   * `/private/tmp`. Writing to a fresh scratch directory is the ordinary case.
   */
  it('accepts a path under a temp root whose intermediate directories do not exist yet', () => {
    const fresh = join(TMP, `no-such-dir-${process.pid}`, 'deeper', 'verdict.md');
    expect(existsSync(dirname(fresh))).toBe(false);
    expect(checkBodyFileLocation(fresh, bodyFileRoots()).ok).toBe(true);
  });

  /**
   * THE macOS SHAPE, built here because it cannot be reproduced by host: `/tmp` is not a symlink on Linux, so
   * an assertion that merely uses a missing directory under `/tmp` passes with or without the fix. What
   * matters is a root that IS a symlink AND a target whose parents do not exist — resolving only the
   * immediate parent then leaves a LITERAL path compared against a RESOLVED root, and refuses it.
   */
  it('resolves through a SYMLINKED root even when the path below it does not exist yet', () => {
    const realRoot = mkdtempSync(join(TMP, 'allow-real-'));
    const linkRoot = join(TMP, `allow-link-${process.pid}`);
    try {
      symlinkSync(realRoot, linkRoot);
      const target = join(linkRoot, 'not-created-yet', 'verdict.md');
      expect(existsSync(dirname(target))).toBe(false);
      expect(checkBodyFileLocation(target, [linkRoot]).ok).toBe(true);
    } finally {
      rmSync(linkRoot, { force: true });
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('still refuses a nonexistent path OUTSIDE every root — resolving the ancestor is not a loophole', () => {
    expect(checkBodyFileLocation('/nowhere/at/all/verdict.md', bodyFileRoots()).ok).toBe(false);
    expect(checkBodyFileLocation(join(homedir(), 'no-such-dir', 'v.md'), bodyFileRoots()).ok).toBe(false);
  });

  // A root that does not resolve is dropped rather than compared as written, so a platform without `/tmp`
  // simply has one fewer root instead of a phantom that matches nothing.
  it('drops a root that does not exist, and reports the ones that do', () => {
    const out = checkBodyFileLocation('/nowhere/v.md', [TMP, '/definitely-not-here']);
    expect(out.ok).toBe(false);
    expect(out.roots).toEqual([TMP]);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * #3334 — THE REASONLESS-BOUNCE REFUSAL, IN THE SINGLE HOME AND REACHABLE ON EVERY ROUTE.
 *
 * WHAT WENT WRONG. #1572's refusal — a `changes` verdict with zero juror findings and no stated reason is
 * unpublishable — was implemented in ONE caller, `we:scripts/operations/review-pr.mjs`'s `record` step. Two other
 * sanctioned write paths carried no such check, and a real reasonless bounce landed on PR #1593: "✅ pass — no
 * blocking findings … Findings (0) … _No findings._" directly above "Decision: `changes`", no reason anywhere.
 *
 * WHY THE ASSERTIONS ARE PER ROUTE, NOT ONE CORE TEST. A shared helper that one caller forgets to invoke is
 * EXACTLY the defect being fixed, so "the core refuses it" proves nothing about the route that never asks the
 * core. Each of the three sanctioned paths is exercised through its own entry point below.
 *
 * AND WHY HALF OF THEM ASSERT THE NEGATIVE DIRECTION. A guard that also blocks legitimate bounces is worse than
 * the hole it closes: it makes the sanctioned path unusable and pushes reviewers back to a raw `gh` label edit,
 * which is the attribution loss the single home exists to prevent.
 * ────────────────────────────────────────────────────────────────────────────────────────────────────────────
 */

/** A write-up in the exact shape `renderVerdictWriteUp` emits for a PASSING panel with N findings. */
const writeUp = ({ findings = 0, reason = '' } = {}) => [
  '## Human review verdict — o/n#1593',
  '',
  findings ? '**Verdict:** ⚠️ changes requested' : '**Verdict:** ✅ pass — no blocking findings',
  '',
  '### Panel verdicts',
  '',
  '| lens | required | verdict |',
  '| --- | --- | --- |',
  '| correctness | mandatory | accept |',
  '',
  `### Findings (${findings})`,
  '',
  ...(findings
    ? ['**correctness** (1)', '- the isolation claim is false: nothing sets cwd to a lane']
    : ['_No findings._']),
  '',
  '---',
  '',
  '**Decision:** `changes` — recorded by operator.',
  ...(reason ? ['', '**Why this was overridden.** The operator gave this reason:', '', `> ${reason}`, ''] : []),
  '**Lenses:** `correctness` — 1 juror(s).',
  'Net basis: `a..b` — 3 net changed file(s) vs current main (#2450).',
].join('\n');

describe('#3334 — the pure core refuses a reasonless bounce, and NOTHING else', () => {
  const decide = (o) => decideSetLabel({ to: 'changes', currentLabels: pending, ...o });

  it('REFUSES `changes` with zero findings and no reason — the PR #1593 case, in the home beside INVARIANT 2', () => {
    const d = decide({ findingCount: 0, reason: '' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(REASONLESS_BOUNCE_REFUSAL);
    // A refusal that still named a swap would be worse than none — a caller reading `addLabel` would apply it.
    expect(d.addLabel).toBe('');
    expect(d.removeLabels).toEqual([]);
  });

  // ── THE NEGATIVE DIRECTION ────────────────────────────────────────────────────────────────────────────────
  it('ALLOWS a bounce carrying findings — the findings ARE the reason, and they are already rendered', () => {
    const d = decide({ findingCount: 1, reason: '' });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.changes);
    expect(d.removeLabels).toEqual([REVIEW_LABELS.pending, REVIEW_LABELS.accepted, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL]);
  });

  it('ALLOWS a bounce carrying a stated reason over zero findings — the operator override the guard is FOR', () => {
    const d = decide({ findingCount: 0, reason: 'the lane guard is asserted on the wrong process' });
    expect(d.allowed).toBe(true);
    expect(d.addLabel).toBe(REVIEW_LABELS.changes);
  });

  it('ALLOWS an UNKNOWN finding count — absence of a count is not evidence of an empty one', () => {
    expect(decide({}).allowed).toBe(true);
    expect(decide({ findingCount: null }).allowed).toBe(true);
    expect(decide({ findingCount: undefined, reason: '' }).allowed).toBe(true);
    expect(decide({ findingCount: 'not a number' }).allowed).toBe(true);
  });

  it('treats a whitespace-only reason as no reason — the author still learns nothing', () => {
    expect(decide({ findingCount: 0, reason: '  \n\t ' }).allowed).toBe(false);
  });

  it('leaves review:human standing on a refusal, exactly as an allowed bounce does', () => {
    expect(decideSetLabel({ to: 'changes', currentLabels: human, findingCount: 0 }).keepsHuman).toBe(true);
  });

  // TOTALITY: the guard binds ONE target. Every other member of the closed set is untouched by the new inputs,
  // asserted here rather than assumed, because the inputs now reach every branch of the decider.
  it('touches NO target but `changes`, over the whole closed set and every starting label', () => {
    for (const to of REVIEW_LABEL_TARGETS) {
      if (to === 'changes') continue;
      for (const currentLabels of [human, pending, accepted, neither, []]) {
        const withInputs = decideSetLabel({ to, currentLabels, findingCount: 0, reason: '' });
        const without = decideSetLabel({ to, currentLabels });
        expect(withInputs).toEqual(without);
        expect(withInputs.reason).not.toBe(REASONLESS_BOUNCE_REFUSAL);
      }
    }
  });

  it('the predicate itself is exported and answers only about `changes` (#3334)', () => {
    expect(isReasonlessBounce({ to: 'changes', findingCount: 0, reason: '' })).toBe(true);
    expect(isReasonlessBounce({ to: 'changes', findingCount: 0, reason: 'x' })).toBe(false);
    expect(isReasonlessBounce({ to: 'changes', findingCount: 2, reason: '' })).toBe(false);
    expect(isReasonlessBounce({ to: 'changes' })).toBe(false);
    expect(isReasonlessBounce({ to: 'accepted', findingCount: 0, reason: '' })).toBe(false);
    expect(isReasonlessBounce()).toBe(false);
  });
});

describe('#3334 — bounceEvidenceFromWriteUp reads both inputs off the body that will be published', () => {
  it('reads the rendered finding count', () => {
    expect(bounceEvidenceFromWriteUp(writeUp({ findings: 0 })).findingCount).toBe(0);
    expect(bounceEvidenceFromWriteUp(writeUp({ findings: 1 })).findingCount).toBe(1);
  });

  it('reads the operator reason out of the write-up — the label sink passes NO --reason flag', () => {
    const ev = bounceEvidenceFromWriteUp(writeUp({ findings: 0, reason: 'the lane guard is asserted wrong' }));
    expect(ev.findingCount).toBe(0);
    expect(ev.reason).toMatch(/the lane guard is asserted wrong/);
  });

  // A HAND-WRITTEN BODY IS UNKNOWN, NEVER ZERO. Only a rendered write-up can assert "zero findings"; prose IS
  // the statement of what to fix, and #xd6moh1 already refuses an empty one.
  it('reports an UNKNOWN count for a body with no rendered heading', () => {
    expect(bounceEvidenceFromWriteUp('fix the guard: it asserts on the wrong process').findingCount).toBe(null);
    expect(bounceEvidenceFromWriteUp('').findingCount).toBe(null);
    expect(bounceEvidenceFromWriteUp(undefined).findingCount).toBe(null);
  });

  it('does not mistake the panel table or a finding bullet for a reason', () => {
    expect(bounceEvidenceFromWriteUp(writeUp({ findings: 1 })).reason).toBe('');
    expect(bounceEvidenceFromWriteUp(writeUp({ findings: 0 })).reason).toBe('');
  });
});

/**
 * ROUTE 1 of 3 — THE DIRECT CLI (`we:scripts/review-set-label.mjs`), through the real `runReviewLabelCli` with a
 * stub provider. The refusal has to precede the provider entirely: a bounce that posted its comment and then
 * refused the swap would leave a durable "Decision: `changes`" on a PR carrying no `review:changes`.
 */
describe('#3334 route 1/3 — the direct CLI refuses a reasonless bounce and writes NOTHING', () => {
  const CFG = {
    defaultActor: 'test',
    usage: 'usage: test',
    buildComment: () => '# verdict body',
    successResult: (o) => ({ ok: true, ...o }),
    refusalResult: ({ decision }) => ({ error: decision.reason }),
  };

  function stubProvider({ labels = ['review:pending'] } = {}) {
    const calls = [];
    return {
      calls,
      name: 'stub',
      currentRepo: () => 'o/n',
      readPrState: () => {
        calls.push('readPrState');
        return { labels: labels.map((name) => ({ name })), headRefOid: 'a'.repeat(40), headRefName: 'lane/x', state: 'OPEN', body: '' };
      },
      readLabels: () => labels.map((name) => ({ name })),
      setLabels: () => { calls.push('setLabels'); },
      postComment: () => { calls.push('postComment'); },
    };
  }

  function run({ provider, argv, verdictBody }) {
    const chunks = [];
    const realExit = process.exit.bind(process);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = 0;
    try { runReviewLabelCli({ ...CFG, emit: (l) => chunks.push(String(l)), provider, argv, verdictBody }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally { process.exit = realExit; }
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  const ARGV = ['1593', '--repo=o/n', '--to=changes', '--actor=op'];

  it('REFUSES the PR #1593 body — 0 findings, no reason — before the provider is touched', () => {
    const p = stubProvider();
    const { exitCode, payload } = run({ provider: p, argv: ARGV, verdictBody: writeUp({ findings: 0 }) });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toBe(REASONLESS_BOUNCE_REFUSAL);
    expect(p.calls).not.toContain('setLabels');
    expect(p.calls).not.toContain('postComment');
  });

  it('ALLOWS the same bounce once --reason states one — and the swap actually lands', () => {
    const p = stubProvider();
    const { exitCode, payload } = run({
      provider: p,
      argv: [...ARGV, '--reason=the lane guard is asserted on the wrong process'],
      verdictBody: writeUp({ findings: 0 }),
    });
    expect(exitCode).toBe(0);
    expect(payload.ok).toBe(true);
    expect(p.calls).toContain('setLabels');
  });

  it('ALLOWS a bounce whose write-up carries findings, with no --reason at all', () => {
    const p = stubProvider();
    const { exitCode } = run({ provider: p, argv: ARGV, verdictBody: writeUp({ findings: 1 }) });
    expect(exitCode).toBe(0);
    expect(p.calls).toContain('setLabels');
  });

  it('ALLOWS a hand-written prose bounce — an unknown count is not an empty one', () => {
    const p = stubProvider();
    const { exitCode } = run({ provider: p, argv: ARGV, verdictBody: 'the guard asserts on the wrong process' });
    expect(exitCode).toBe(0);
    expect(p.calls).toContain('setLabels');
  });

  it('does not touch --to=accepted, whose write-up also renders `Findings (0)` on a clean pass', () => {
    const p = stubProvider();
    const { exitCode } = run({
      provider: p, argv: ['1593', '--repo=o/n', '--to=accepted', '--actor=op'], verdictBody: writeUp({ findings: 0 }),
    });
    expect(exitCode).toBe(0);
    expect(p.calls).toContain('setLabels');
  });

  it('does not touch the conveyor rearm target, which carries no findings by design', () => {
    const p = stubProvider({ labels: ['review:changes'] });
    const chunks = [];
    const realExit = process.exit.bind(process);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = 0;
    try {
      runReviewLabelCli({
        ...CFG, emit: (l) => chunks.push(String(l)), provider: p, argv: ['1593', '--repo=o/n'], fixedTo: 'rearm',
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally { process.exit = realExit; }
    expect(exitCode).toBe(0);
    expect(p.calls).toContain('setLabels');
  });
});

/**
 * ROUTE 2 of 3 — `we:scripts/operations/review-pr.mjs`'s `record` step. That step SHELLS this CLI
 * (`we:scripts/operations/review-pr-io.mjs`'s label sink builds the argv), so its enforcement point is the CLI
 * above — but with one property that route alone has: the sink passes `--body-file=` and NO `--reason`, because
 * `renderVerdictWriteUp` renders the operator's reason INTO the body. A guard reading only the flag would refuse
 * every reasoned bounce recorded through the declared operation. That is asserted here, on this route's own argv.
 *
 * The sink's other half is `isPreWriteRefusal`: a refusal it recognises marks the effect entry `failed` (retried),
 * and one it does not is INDETERMINATE and costs a person. The refusal is decided by the pure core before the
 * provider exists, so it is provably pre-write and must be on that list.
 */
describe('#3334 route 2/3 — review-pr\'s record step, whose argv carries the reason in the BODY', () => {
  const CFG = {
    defaultActor: 'test',
    usage: 'usage: test',
    buildComment: () => '# verdict body',
    successResult: (o) => ({ ok: true, ...o }),
    refusalResult: ({ decision }) => ({ error: decision.reason }),
  };

  function runSinkArgv({ verdictBody, labels = ['review:pending'] }) {
    const calls = [];
    const provider = {
      name: 'stub',
      currentRepo: () => 'o/n',
      readPrState: () => ({ labels: labels.map((name) => ({ name })), headRefOid: 'a'.repeat(40), headRefName: 'lane/x', state: 'OPEN', body: '' }),
      readLabels: () => labels.map((name) => ({ name })),
      setLabels: () => { calls.push('setLabels'); },
      postComment: () => { calls.push('postComment'); },
    };
    // The EXACT flag set `createReviewPrSinks`'s LABEL sink builds: pr, --repo, --to, --actor, --body-file.
    // There is deliberately no `--reason` — that is the property under test.
    const argv = ['1593', '--repo=o/n', '--to=changes', '--actor=claude-review-pr', '--body-file=/tmp/x.md'];
    const chunks = [];
    const realExit = process.exit.bind(process);
    process.exit = (code) => { const e = new Error('process.exit'); e.exitCode = code; throw e; };
    let exitCode = 0;
    try { runReviewLabelCli({ ...CFG, emit: (l) => chunks.push(String(l)), provider, argv, verdictBody }); }
    catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    finally { process.exit = realExit; }
    return { exitCode, payload: JSON.parse(chunks.join('') || '{}'), calls };
  }

  it('REFUSES the reasonless write-up the record step would post', () => {
    const { exitCode, payload, calls } = runSinkArgv({ verdictBody: writeUp({ findings: 0 }) });
    expect(exitCode).not.toBe(0);
    expect(payload.error).toBe(REASONLESS_BOUNCE_REFUSAL);
    expect(calls).toEqual([]);
  });

  // THE NEGATIVE DIRECTION, AND THE ONE THIS ROUTE COULD HAVE GOT WRONG: a reasoned override arrives with the
  // reason inside the body and no `--reason` flag anywhere in the argv.
  it('ALLOWS an operator override whose reason rides the BODY, with no --reason flag in the argv', () => {
    const body = writeUp({ findings: 0, reason: 'the isolation claim is unproven; assert the juror cwd' });
    const { exitCode, calls } = runSinkArgv({ verdictBody: body });
    expect(exitCode).toBe(0);
    expect(calls).toContain('setLabels');
  });

  it('ALLOWS a juror-findings bounce recorded through the same argv', () => {
    const { exitCode, calls } = runSinkArgv({ verdictBody: writeUp({ findings: 1 }) });
    expect(exitCode).toBe(0);
    expect(calls).toContain('setLabels');
  });

  it('the refusal is classified PRE-WRITE, so the sink marks the effect failed rather than indeterminate', () => {
    expect(isPreWriteRefusal(REASONLESS_BOUNCE_REFUSAL)).toBe(true);
  });
});

/**
 * ROUTE 3 of 3 — `we:scripts/operations/record-verdict.mjs`, the transport for a host that cannot authenticate to
 * GitHub (on a cloud runner, every host). It never calls `decideSetLabel`: it stages a request FILE that a CI job
 * later applies by running the single home. The applier's run would refuse — minutes later, in a workflow log
 * nobody is watching, with the operator's context gone. So the refusal has to be reachable on this route, at the
 * moment of the decision, and it is asserted here through the operation's own pure builder.
 */
describe('#3334 route 3/3 — the credential-less transport refuses before a request file exists', () => {
  const facts = (over = {}) => ({
    pr: 1593, repo: 'chalbert/web-everything', sessionId: 'sess-1', reduced: 'accept', findingCount: 0, ...over,
  });

  it('REFUSES staging a reasonless `changes` request', () => {
    expect(() => buildRequest(
      { facts: facts(), to: 'changes', body: writeUp({ findings: 0 }), actor: 'op' }, validateRequest,
    )).toThrow(/reasonless bounce:/);
  });

  it('reads the finding count out of the RUN RECORD, never retyped — and null when the verdict has none', () => {
    const record = (verdict) => ({
      id: 'r', op: 'review-pr', input: { pr: 1593, repo: 'o/n' }, verdict, telemetry: [],
    });
    expect(factsFromRun(record({ verdict: 'accept', findings: [] })).findingCount).toBe(0);
    expect(factsFromRun(record({ verdict: 'changes', findings: [{ summary: 'x' }] })).findingCount).toBe(1);
    // UNKNOWN, not zero: fabricating a 0 from an absent array turns "we did not look" into "the juror found
    // nothing", which is the one direction this guard must not get wrong.
    expect(factsFromRun(record({ verdict: 'accept' })).findingCount).toBe(null);
  });

  // ── THE NEGATIVE DIRECTION ────────────────────────────────────────────────────────────────────────────────
  it('ALLOWS a bounce whose staged write-up carries the operator reason', () => {
    const out = buildRequest(
      { facts: facts(), to: 'changes', body: writeUp({ findings: 0, reason: 'assert the juror cwd' }), actor: 'op' },
      validateRequest,
    );
    expect(out.request.to).toBe('changes');
    expect(out.path).toBe('ops/review-requests/1593-changes.json');
  });

  it('ALLOWS a bounce carrying juror findings', () => {
    expect(buildRequest(
      { facts: facts({ findingCount: 2 }), to: 'changes', body: writeUp({ findings: 2 }), actor: 'op' }, validateRequest,
    ).request.to).toBe('changes');
  });

  it('ALLOWS a run whose finding count is unknown', () => {
    expect(buildRequest(
      { facts: facts({ findingCount: null }), to: 'changes', body: 'fix the guard', actor: 'op' }, validateRequest,
    ).request.to).toBe('changes');
  });

  it('does not touch an `accepted` request over a zero-finding write-up', () => {
    expect(buildRequest(
      { facts: facts(), to: 'accepted', body: writeUp({ findings: 0 }), actor: 'op' }, validateRequest,
    ).request.to).toBe('accepted');
  });

  // The capability guarantee the split module exists to preserve: this declaration must not be able to act.
  it('still imports nothing that can act — the rule came in through a LEAF, not through the single home', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(importGraph(resolve(here, '..', 'operations', 'record-verdict.mjs')).external).toEqual([]);
    expect(importGraph(resolve(here, '..', 'lib', 'reasonless-bounce.mjs')).external).toEqual([]);
  });
});
