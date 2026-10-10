/**
 * @file scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs
 * @description Part of the merge-ai-prs.test.mjs split (originally one 4650-line file — see git history for the
 *   full-file description). This file covers: needsAcceptanceRestamp/restampAcceptance (#x5e2ldj/#3202 —
 *   carrying an acceptance across the drain's own rebase), the #3308 review-coverage announcement surface
 *   (reviewRecordKind, recordedReviewRecords, readReviewRecord, reviewCoverageGaps,
 *   buildReviewCoverageReason), the #3184 fingerprint read-miss, and computeNetDiffSignals's basis-trust
 *   question (#3343) — all exported from `scripts/merge-ai-prs.mjs` (plus one from
 *   `scripts/lib/review-escalation.mjs`).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readDrainAcceptance, decideDrainReviewGate, reconcileDrainReviewPending, classifyPr, needsAcceptanceRestamp, restampAcceptance, computeNetDiffSignals, drainReasonMarker, buildDrainReasonComment, hasDrainReasonComment, LAND_REASON, applyEscalationRelief, REVIEW_COVERAGE_KIND, REVIEW_COVERAGE_GAP_META, reviewRecordKind, recordedReviewRecords, readReviewRecord, reviewCoverageGaps, buildReviewCoverageReason } from '../merge-ai-prs.mjs';
import { drainGateInputs, permissionChangeForCandidate } from '../merge-ai-prs.mjs';
import { normalizeDiffFingerprint, normalizeContributionFingerprint, decideReviewGate, scoreEscalation, REVIEW_LABELS } from '../lib/review-escalation.mjs';


/**
 * `needsAcceptanceRestamp` (#x5e2ldj) — the drain re-stamping the acceptance its OWN rebase invalidated.
 *
 * THE MEASURED LOOP, PR #1445 on 2026-08-19: a clearance landed at 13:06:48; the drain rebased that lane onto
 * the newly-merged main a minute later; `review:human` came back. The rebase preserves the contribution, but a
 * rebase onto a moved base can change the context-run lengths the contribution digest keeps — so the markers
 * went stale on the PR the drain was itself about to land. Clear, rebase, re-park, repeat.
 *
 * The fix is the one `review-escalation.mjs` already named in its POSITION section — attribute the move to its
 * actor. These tests pin that the escape stays NARROW, because a re-stamp that fired too widely would carry an
 * acceptance across a head change the drain did NOT make, which is the staleness gate's whole reason to exist.
 */
describe('needsAcceptanceRestamp (#x5e2ldj — carrying an acceptance across the drain\'s own rebase)', () => {
  const accepted = { humanCleared: true, reviewHeld: false };
  const rebased = { action: 'rebased', newCommit: 'f5bc7940' };

  it('fires for the one case it exists for: THIS drain rebased an accepted, unheld PR', () => {
    expect(needsAcceptanceRestamp(accepted, rebased)).toBe(true);
  });

  it('does NOT fire without a live acceptance — there is nothing to carry', () => {
    expect(needsAcceptanceRestamp({ humanCleared: false, reviewHeld: false }, rebased)).toBe(false);
  });

  // DEFENCE IN DEPTH, and labelled as such because the review of PR #1482 was right that it is not a scenario
  // `classifyPr` can currently produce: `reviewHeld` is only set when the review hold is the SOLE blocker, which
  // requires no live `review:accepted` — so `humanCleared && reviewHeld` is unreachable through the real drain
  // today. The guard stays because the cost is one `&&` and the failure it prevents is carrying an acceptance
  // onto a held PR; but a reader must not mistake this for a case that happens.
  it('does NOT fire on an uncleared hold — unreachable via classifyPr today, kept as depth', () => {
    expect(needsAcceptanceRestamp({ humanCleared: true, reviewHeld: true }, rebased)).toBe(false);
  });

  it('does NOT fire when no new head was minted — `current` rebuilt nothing', () => {
    // The idempotency path: the tip was already on main and manifest-free, so no SHA moved and no marker went
    // stale. Re-stamping there would post a comment for a rebase that never happened.
    expect(needsAcceptanceRestamp(accepted, { action: 'current' })).toBe(false);
    expect(needsAcceptanceRestamp(accepted, { action: 'skip', reason: 'real conflict beyond manifest' })).toBe(false);
  });

  it('does NOT fire without a rebase result at all — an author push is not this', () => {
    expect(needsAcceptanceRestamp(accepted, undefined)).toBe(false);
    expect(needsAcceptanceRestamp(accepted, null)).toBe(false);
    expect(needsAcceptanceRestamp(undefined, rebased)).toBe(false);
  });
});

/**
 * `restampAcceptance` (#3202) — WHICH TREE the re-stamp fingerprints.
 *
 * The single home computes its `reviewed-diff` fingerprint from a git read with NO explicit `cwd`, and says so:
 * the CLI was single-PR and operator-invoked, so it ran from the PR's own repo, and the condition that would
 * break that is a caller passing a `--repo` naming a different one. The #3200 re-stamp became that caller and
 * spawned the child with no `cwd`, while the drain sweeps three repos in one process and never `chdir`s.
 *
 * It failed SOFT most of the time — the head ref does not resolve in the wrong tree, the read throws, no marker
 * is stamped, and the gate falls back to SHA identity, which is stricter. The case that did not is a branch of
 * the same name existing there, which `lane/<NNN>-<slug>` makes possible across the constellation. Then an
 * unrelated repo's diff is stamped as this PR's, and a wrong fingerprint never matches — so the PR re-parks on
 * every pass, which is the loop #3200 exists to end.
 *
 * So these assert the `cwd` that REACHES the spawn, not merely that a spawn happened. A test that only checked
 * the argv would have passed throughout the defect.
 */
describe('restampAcceptance (#3202 — the re-stamp reads the PR\'s OWN tree)', () => {
  const spy = (status = 0) => {
    const calls = [];
    const spawn = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { status, stdout: '', stderr: '' }; };
    return { calls, spawn };
  };

  it('restampAcceptance omits --repo when repo is falsy', () => {
    for (const repo of [null, undefined, '']) {
      const { calls, spawn } = spy();
      restampAcceptance({ pr: 42, repo, newHead: 'f5bc7940', spawn });
      expect(calls[0].argv.some((a) => String(a).startsWith('--repo'))).toBe(false);
      expect(calls[0].argv).not.toContain('--repo=null');
    }
  });

  it('pins the child to the sibling repo\'s clone — the wrong-tree fingerprint this exists to prevent', () => {
    const { calls, spawn } = spy();
    const out = restampAcceptance({ pr: 42, repo: 'plateau-app', newHead: 'f5bc7940', cwd: '/ws/plateau-app', spawn });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.cwd).toBe('/ws/plateau-app');
  });

  // `undefined` means "inherit", which for a WE PR is already the right tree — so a local-repo re-stamp must
  // NOT acquire a pinned cwd it never needed.
  it('inherits the drain\'s cwd for a local-repo PR', () => {
    const { calls, spawn } = spy();
    restampAcceptance({ pr: 7, repo: 'web-everything/web-everything', newHead: 'abc1234', spawn });
    expect(calls[0].opts.cwd).toBeUndefined();
  });

  // The SCRIPT is this checkout's; only the working directory moves. Resolving the CLI relative to cwd would
  // run a sibling repo's copy of the label arc — a second implementation of the thing #2644 made singular.
  it('still runs THIS checkout\'s review-set-label.mjs, not the pinned repo\'s', () => {
    const { calls, spawn } = spy();
    restampAcceptance({ pr: 42, repo: 'frontierui', newHead: 'f5bc7940', cwd: '/ws/frontierui', spawn });
    expect(calls[0].argv[0]).toMatch(/scripts\/review-set-label\.mjs$/);
    expect(calls[0].argv[0].startsWith('/ws/frontierui')).toBe(false);
    expect(calls[0].argv).toContain('--to=restamp');
    expect(calls[0].argv).toContain('--repo=frontierui');
  });

  // The allowlist for `--body-file` is rooted at `process.cwd()`, so a body staged under THIS checkout would be
  // refused by a child pinned elsewhere. The re-stamp passes none; this pins that it stays that way.
  it('passes no --body-file, which a pinned cwd would make unreadable', () => {
    const { calls, spawn } = spy();
    restampAcceptance({ pr: 42, repo: 'plateau-app', newHead: 'f5bc7940', cwd: '/ws/plateau-app', spawn });
    expect(calls[0].argv.some((a) => String(a).startsWith('--body-file='))).toBe(false);
  });

  /**
   * #x9krtkb (bug 2) — THE NEW HEAD REACHES THE CHILD AS A FLAG, not only inside `--reason`'s free text.
   *
   * Before this, `newHead` was interpolated into `--reason` alone, and `review-set-label.mjs` had no flag to
   * parse it back out of — it re-derived the head from its own fresh `gh pr view`, which can race GitHub's own
   * propagation of the push THIS process just made. Observed live on PR #2572 (2026-09-24): a restamp six
   * seconds after the push still stamped the PRE-rebase head. The fix is this exact flag; pin that it is sent,
   * with the real value, not a stringified reason.
   */
  it('passes --new-head=<the new commit>, so the child stamps THIS process\'s own authoritative head', () => {
    const { calls, spawn } = spy();
    restampAcceptance({ pr: 42, repo: 'plateau-app', newHead: '1f27fd19f6841d9df5c9f8ce7b4b4f3b8319bc54', cwd: '/ws/plateau-app', spawn });
    expect(calls[0].argv).toContain('--new-head=1f27fd19f6841d9df5c9f8ce7b4b4f3b8319bc54');
  });

  it('never throws, and reports a non-zero exit as a failed re-stamp', () => {
    const { spawn } = spy(1);
    expect(restampAcceptance({ pr: 42, repo: 'plateau-app', newHead: 'f5bc7940', cwd: '/ws/plateau-app', spawn }).ok).toBe(false);
    const thrower = () => { throw new Error('spawn ENOENT'); };
    expect(restampAcceptance({ pr: 42, repo: 'plateau-app', newHead: 'f', spawn: thrower }))
      .toEqual({ ok: false, reason: 'spawn ENOENT' });
  });
});

/* ------------------------------------------------------------------ #3308 review-coverage announcement */

// #3308 — a skipped or degraded review must SAY SO on the PR. These pin the two halves that make that true:
// the gap READER (which conditions count as degraded, and — just as load-bearing — which do not), and the
// RENDERER + its marker, which is the surface a review that never ran gets when there is no verdict comment
// to host the announcement of its own absence.
//
// The record bodies below are trimmed from real recorded verdicts (see
// `scripts/review-corpus/__tests__/fixtures/comments/1561.json`), so the parser is pinned against the bytes
// `buildVerdictComment` actually writes rather than against a shape invented here.
const HEAD_SHA = 'eaa1bc906bd2fc088789a2c9b87a54ac9d2faa33';
const BASE_SHA = 'e9aa38f6eacb7ed0341cdcb4a191c5f9e56f0b15';
const panelTable = (rows) => ['### Panel verdicts', '', '| lens | weight | verdict |', '| --- | --- | --- |',
  ...rows.map(([lens, weight, verdict]) => `| ${lens} | ${weight} | ${verdict} |`)].join('\n');
const verdictRecord = ({ rows = [['correctness', 'mandatory', 'accept'], ['security', 'mandatory', 'accept']], head = HEAD_SHA, basis = true, single = false } = {}) => ({
  body: ['✅ review — accepted', '', 'Recorded by operator via the declared `review-pr` operation (#3035).', '',
    panelTable(rows), '',
    single ? '**Lens:** `correctness` — a SINGLE-LENS run. One `judge` step, one juror, one lens.' : '',
    basis ? `Net basis: \`${BASE_SHA}..${head}\` (rev \`origin/lane/x\` at review time)` : ''].join('\n') });
const cleanPr = { comments: [verdictRecord()] };

describe('#3308 — reviewRecordKind / recordedReviewRecords', () => {
  it('recognizes each of the four durable review-record headlines', () => {
    expect(reviewRecordKind('✅ review — accepted\n\nbody')).toBe('accepted');
    expect(reviewRecordKind('🔁 review — changes requested\n\nbody')).toBe('changes');
    expect(reviewRecordKind('✅ review — `review:human` cleared via the sanctioned path')).toBe('clear-human');
    expect(reviewRecordKind('📌 review — acceptance re-stamped after a rebase (no new review)')).toBe('restamp');
  });
  // A re-stamp's heading is the one that must win: it is a DIFFERENT record from the accept it carries
  // forward, and reading it as that accept would report a fresh review where none happened.
  it('reads a re-stamp as a re-stamp even when the accept headline is quoted alongside it', () => {
    expect(reviewRecordKind('📌 review — acceptance re-stamped after a rebase (no new review)\n\nre-stamping ✅ review — accepted from #1')).toBe('restamp');
  });
  it('is null for a non-record comment — including the drain\'s own stamps', () => {
    expect(reviewRecordKind(buildDrainReasonComment('land', LAND_REASON))).toBe(null);
    expect(reviewRecordKind(buildDrainReasonComment(REVIEW_COVERAGE_KIND, 'x'))).toBe(null);
    expect(reviewRecordKind('')).toBe(null);
    expect(reviewRecordKind(undefined)).toBe(null);
  });
  it('collects records in recorded order and tolerates an odd comments shape', () => {
    const recs = recordedReviewRecords([{ body: 'noise' }, null, 42, verdictRecord(), { body: '📌 review — acceptance re-stamped after a rebase (no new review)' }]);
    expect(recs.map((r) => r.kind)).toEqual(['accepted', 'restamp']);
    expect(recordedReviewRecords(null)).toEqual([]);
  });
});

describe('#3308 — readReviewRecord', () => {
  it('pulls the examined revision range and the panel rows', () => {
    const r = readReviewRecord(verdictRecord({ rows: [['correctness', 'mandatory', 'accept']] }).body);
    expect(r.basis).toEqual({ base: BASE_SHA, head: HEAD_SHA });
    expect(r.lensRows).toEqual([{ lens: 'correctness', weight: 'mandatory', verdict: 'accept' }]);
  });
  // `renderPanelVerdictTable` renders an unjudged seat as the literal `(no verdict)`. A tight verdict-cell
  // pattern skips that row, and the skip is not neutral: a run whose only MANDATORY seat rendered
  // `(no verdict)` would read as having no mandatory row at all — the right alarm for the wrong reason.
  it('captures a seat rendered `(no verdict)`, so the weight column is what decides', () => {
    expect(readReviewRecord(verdictRecord({ rows: [['security', 'mandatory', '(no verdict)']] }).body).lensRows)
      .toEqual([{ lens: 'security', weight: 'mandatory', verdict: '(no verdict)' }]);
    expect(reviewCoverageGaps({ comments: [verdictRecord({ rows: [['security', 'mandatory', '(no verdict)'], ['simplicity', 'advisory', 'accept']] })] })).toEqual([]);
  });
  // The corpus miner's `parseVerdict` returns null here (corpus policy: no range ⇒ not replayable ⇒ exclude).
  // Excluding is exactly wrong for this reader — a record naming no range is the thing being announced, so it
  // must survive parsing to be reported.
  it('survives a record with no Net basis instead of discarding it', () => {
    const r = readReviewRecord(verdictRecord({ basis: false }).body);
    expect(r.basis).toBe(null);
    expect(r.lensRows).toHaveLength(2);
  });
});

describe('#3308 — reviewCoverageGaps: the degraded set', () => {
  // THE NOISE GUARD, and the most important assertion in this block. A normally-reviewed PR must produce an
  // EMPTY list, because an announcement on every PR trains readers to skip it — which recreates the problem
  // this item exists to fix.
  it('reports NOTHING for a panel-reviewed PR merging the tree that was reviewed', () => {
    expect(reviewCoverageGaps(cleanPr)).toEqual([]);
  });
  it('announces a PR landing with no recorded review at all — the 22.5% case', () => {
    expect(reviewCoverageGaps({ comments: [{ body: 'looks good to me' }] }).map((g) => g.code))
      .toEqual(['no-recorded-review']);
  });
  // The `--lens=<advisory>` unseating: the run completes, the table renders, and every seat in it is advisory,
  // so nothing in the panel could have blocked the accept.
  it('announces a verdict whose panel seats NO mandatory lens', () => {
    const gaps = reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ rows: [['simplicity', 'advisory', 'accept']] })] });
    expect(gaps.map((g) => g.code)).toEqual(['unseated-mandatory-lens']);
  });
  // MEASURED 21/60 (35%) of recent merges, and such a record already says so IN BOLD in its own body. At that
  // rate it is the operating norm, not a departure — announcing it is how this channel gets tuned out. #3319
  // has since retired the sentence from the renderer, settling it twice over. What survives is the sharp
  // half: a single-lens run seating an ADVISORY lens still fires `unseated-mandatory-lens`.
  it('does NOT announce a single-lens run that still seated a mandatory lens', () => {
    const gaps = reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ single: true, rows: [['correctness', 'mandatory', 'accept']] })] });
    expect(gaps).toEqual([]);
  });
  it('DOES announce a single-lens run that seated only an advisory lens — no blocking floor', () => {
    const gaps = reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ single: true, rows: [['simplicity', 'advisory', 'accept']] })] });
    expect(gaps.map((g) => g.code)).toEqual(['unseated-mandatory-lens']);
  });
  // MEASURED 12/60 (20%) of recent merges — and every one a FALSE positive. The drain already refuses to
  // merge a PR whose acceptance does not cover its head (#2409), and reviewed-diff/reviewed-contribution
  // deliberately keep an acceptance valid across a content-preserving rebase — which the drain's own
  // manifest-drop pass causes on nearly every lane. A sha difference that survives to the merge cascade is
  // therefore PROOF the staleness gate ran and cleared it, not evidence of a skipped review.
  it('does NOT announce a moved head — a stale acceptance never reaches the merge cascade (#2409)', () => {
    const gaps = reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ head: '1111111111111111111111111111111111111111' })] });
    expect(gaps).toEqual([]);
  });
  it('announces a verdict that names no revision range — unknown coverage, not clean coverage', () => {
    const gaps = reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ basis: false })] });
    expect(gaps.map((g) => g.code)).toEqual(['unstated-basis']);
  });
  // MEASURED 31/60 (52%) of recent merges. The re-stamp is the drain's OWN rebase mechanism, granted only
  // after the reviewed-contribution markers show the contribution unchanged — evidence the staleness gate
  // RAN. Announcing it would put a notice on half of all merges.
  it('does NOT announce a re-stamped acceptance — the drain\'s own routine rebase path', () => {
    const gaps = reviewCoverageGaps({ comments: [verdictRecord(), { body: '📌 review — acceptance re-stamped after a rebase (no new review)' }] });
    expect(gaps).toEqual([]);
  });
  // ...and a terminal record must STOP the analysis, not fall through. Neither a re-stamp nor a clearance
  // carries a panel table or a `Net basis`, so reading either as an accept would manufacture
  // `unstated-basis` on that same 53% — the identical noise, arriving by a different door.
  it('a terminal record does not fall through into basis checks it structurally cannot satisfy', () => {
    for (const body of ['📌 review — acceptance re-stamped after a rebase (no new review)', '✅ review — `review:human` cleared via the sanctioned path']) {
      expect(reviewCoverageGaps({ comments: [{ body }] })).toEqual([]);
    }
  });
  it('announces an operator relief that waived this PR\'s review park', () => {
    expect(reviewCoverageGaps({ ...cleanPr, reliefWaived: true }).map((g) => g.code)).toEqual(['relief-waived']);
  });
  // #3308 (round-2 correctness fix) — the DEPRECATED bare form gets its OWN code, because it is a wider
  // statement than the scoped one: the rubric was off for every candidate in the pass, not waived for one
  // named PR. Collapsing the two would under-report the bare form on exactly the PRs that were never scored.
  it('announces the DEPRECATED pass-wide waiver as its own gap, distinct from the scoped one', () => {
    expect(reviewCoverageGaps({ ...cleanPr, reliefPassWide: true }).map((g) => g.code)).toEqual(['relief-waived-pass-wide']);
    expect(REVIEW_COVERAGE_GAP_META['relief-waived-pass-wide']).not.toBe(REVIEW_COVERAGE_GAP_META['relief-waived']);
  });
  it('reports BOTH relief codes rather than silently collapsing them if a caller passes both', () => {
    expect(reviewCoverageGaps({ ...cleanPr, reliefWaived: true, reliefPassWide: true }).map((g) => g.code).sort())
      .toEqual(['relief-waived', 'relief-waived-pass-wide']);
  });
  // Two expected states that already carry their own durable record. Re-announcing them here would be volume
  // without information, which is how an announcement channel gets tuned out.
  it('does NOT announce a human-ceremony clearance (its own comment states what it proves)', () => {
    expect(reviewCoverageGaps({ comments: [{ body: '✅ review — `review:human` cleared via the sanctioned path\n\nCleared by nic.' }] })).toEqual([]);
  });
  it('judges the LATEST record, so a bounce-then-re-review is not reported on its history', () => {
    const gaps = reviewCoverageGaps({ comments: [{ body: '🔁 review — changes requested\n\nno panel table, no basis' }, verdictRecord()] });
    expect(gaps).toEqual([]);
  });
  it('tolerates an abbreviated sha in the record rather than calling it stale', () => {
    const gaps = reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ head: HEAD_SHA.slice(0, 12) })] });
    expect(gaps).toEqual([]);
  });
  // "We could not read the head" is a different statement from "the review is stale". The reader must not
  // manufacture a finding out of an unknown any more than it may manufacture a pass out of one.
  it('leaves staleness unreported when the landing head sha is unknown', () => {
    expect(reviewCoverageGaps({ comments: [verdictRecord({ head: '1111111111111111111111111111111111111111' })], headSha: null })).toEqual([]);
  });
  it('accumulates independent gaps rather than reporting only the first', () => {
    const gaps = reviewCoverageGaps({ reliefWaived: true, comments: [verdictRecord({ rows: [['simplicity', 'advisory', 'accept']], basis: false })] });
    expect(gaps.map((g) => g.code).sort()).toEqual(['relief-waived', 'unseated-mandatory-lens', 'unstated-basis']);
  });
  it('every emitted gap carries the explanatory line from the meta table', () => {
    for (const code of Object.keys(REVIEW_COVERAGE_GAP_META)) expect(REVIEW_COVERAGE_GAP_META[code]).toBeTruthy();
    expect(reviewCoverageGaps({ comments: [] })[0]).toEqual({ code: 'no-recorded-review', line: REVIEW_COVERAGE_GAP_META['no-recorded-review'] });
  });
  it('defaults to announcing the absence when called with nothing at all', () => {
    expect(reviewCoverageGaps().map((g) => g.code)).toEqual(['no-recorded-review']);
  });
});

describe('#3308 — the announcement surface', () => {
  // A review that never ran produces no verdict comment, so it cannot host the announcement of its own
  // absence. This fourth `drainReasonMarker` kind IS that surface — its own marker, so it dedupes
  // independently of the park/skip/land stamps rather than colliding with them.
  it('is its own marker kind, distinct from park/skip/land', () => {
    expect(drainReasonMarker(REVIEW_COVERAGE_KIND)).toBe('<!-- drain-review-coverage-reason -->');
    for (const k of ['park', 'skip', 'land']) expect(drainReasonMarker(k)).not.toBe(drainReasonMarker(REVIEW_COVERAGE_KIND));
  });
  it('renders a heading that says a review is MISSING, never that the drain approved something', () => {
    const body = buildDrainReasonComment(REVIEW_COVERAGE_KIND, buildReviewCoverageReason(reviewCoverageGaps({ comments: [] })));
    expect(body.startsWith('<!-- drain-review-coverage-reason -->')).toBe(true);
    expect(body).toContain('Incomplete review — what was not examined');
    expect(body).not.toContain('Landed by the drain');
    expect(body).toContain('`no-recorded-review`');
    expect(body).toContain(REVIEW_COVERAGE_GAP_META['no-recorded-review']);
  });
  it('states that nothing on the list blocked the merge — it is a record, not a gate', () => {
    expect(buildReviewCoverageReason(reviewCoverageGaps({ comments: [] }))).toContain('None of the above blocked the merge');
  });
  // The `--watch` loop re-scores the same PR every pass. An unchanged notice must dedupe against the one
  // already on the PR; a CHANGED set of gaps must post fresh.
  it('dedupes an unchanged notice and posts a fresh one when the gaps change', () => {
    const reason = buildReviewCoverageReason(reviewCoverageGaps({ comments: [] }));
    const posted = [{ body: buildDrainReasonComment(REVIEW_COVERAGE_KIND, reason) }];
    expect(hasDrainReasonComment(posted, REVIEW_COVERAGE_KIND, reason)).toBe(true);
    const other = buildReviewCoverageReason(reviewCoverageGaps({ ...cleanPr, comments: [verdictRecord({ basis: false })] }));
    expect(hasDrainReasonComment(posted, REVIEW_COVERAGE_KIND, other)).toBe(false);
  });
});

describe('#3184 — the drain records a fingerprint READ MISS instead of collapsing it into a marker-less null', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');

  it.each(['throw', 'unscored', 'missing clone', 'missing ref'])('records an owed diff read miss: %s', (mode) => {
    const netDiff = vi.fn(() => {
      if (mode === 'throw') throw new Error('git unavailable');
      return { scored: false };
    });
    const view = acceptanceView();
    if (mode === 'missing ref') delete view.headRefName;
    const evidence = readDrainAcceptance({
      ...acceptanceOptions(view), local: mode !== 'missing clone', netDiff,
    });
    expect(evidence.headReadFailed).toBe(true);
    expect(evidence.headDiff).toBe(null);
    if (mode === 'missing clone' || mode === 'missing ref') expect(netDiff).not.toHaveBeenCalled();
    // The explicit signal reaches the gate: an unread fingerprint is never proven staleness.
    const gate = decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true }, {
      ...acceptanceOptions(view), local: mode !== 'missing clone', netDiff,
    });
    expect(gate.action).toBe('park');
    expect(gate.reason).toContain('could not be read');
  });

  it('a marker-less accept never reports an owed fingerprint read', () => {
    const view = acceptanceView();
    view.comments = [{ viewerDidAuthor: true, body: `<!-- reviewed-sha: ${REVIEWED} -->` }];
    const netDiff = vi.fn();
    expect(readDrainAcceptance({ ...acceptanceOptions(view), netDiff, carrySetting: 'off' }).headReadFailed).toBe(false);
    expect(netDiff).not.toHaveBeenCalled();
    // card xu7kxtt — with carry-forward on, the accepted commit's own net diff is derived first; an unreadable
    // derivation still owes no live read and reports no read miss (SHA identity, as before).
    const derive = vi.fn(() => ({ scored: false }));
    expect(readDrainAcceptance({ ...acceptanceOptions(view), netDiff: derive, carrySetting: 'on' }).headReadFailed).toBe(false);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive.mock.calls[0][0].rev).toBe(REVIEWED);
  });

  it('pins diff reads to the sibling clone', () => {
    const exec = vi.fn((cmd) => cmd === 'gh' ? JSON.stringify(acceptanceView()) : 'git result');
    readDrainAcceptance({ pr: 3432, repo: 'frontier-ui/frontierui', cwd: '/ws/frontierui', exec,
      netDiff: ({ exec: git, rev, fetchExtraRefs }) => {
        // PR #4631 round 7: the live read is AT the head SHA; the branch is only fetched for its objects.
        expect(rev).toBe(REBASED);
        expect(fetchExtraRefs).toEqual(['lane/3432']);
        git('git', ['diff'], { encoding: 'utf8' });
        return { scored: true, text: REVIEWED_DIFF, rev };
      },
    });
    expect(exec.mock.calls[1][2].cwd).toBe('/ws/frontierui');
  });

  it('PR #4631 round 7: a diff that was not read at the head SHA is a read miss, never coverage', () => {
    const view = acceptanceView();
    const netDiff = () => ({ scored: true, text: REVIEWED_DIFF, rev: 'origin/lane/3432' });
    const evidence = readDrainAcceptance({ ...acceptanceOptions(view), netDiff });
    expect(evidence.headDiff).toBe(null);
    expect(evidence.headReadFailed).toBe(true);
    expect(decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true }, { ...acceptanceOptions(view), netDiff }).action).toBe('park');
  });

  it('a suppressed re-park is STILL not waivable by the relief valve — staleAcceptance carries it', () => {
    // The one behavioural risk of returning `applyLabel: null`: `applyEscalationRelief`'s later checks key on
    // the label, and a null would fall past the `review:human` refusal. It never gets there — the
    // `staleAcceptance` refusal is checked FIRST. This test is why that ordering is not free to change.
    const suppressed = decideReviewGate({
      escalate: true,
      humanRequired: true,
      labels: [{ name: REVIEW_LABELS.accepted }],
      acceptedSha: '2d4cc065',
      headSha: 'ed32bba83fee',
      acceptedDiff: 'a'.repeat(64),
      acceptedContribution: 'b'.repeat(64),
      headDiff: null,
      headContribution: null,
      headReadFailed: true,
      operatorClearance: { actor: 'Nicolas Gilbert' },
    });
    expect(suppressed.action).toBe('park');
    expect(suppressed.applyLabel).toBe(null);       // the #3184 suppression
    expect(suppressed.staleAcceptance).toBe(true);
    expect(applyEscalationRelief(suppressed, { relieved: true }).waive).toBe(false);
    expect(applyEscalationRelief(suppressed, { relieved: true }).reason).toContain('stale acceptance');
  });

  // ── PRE-EXISTING STRUCTURE THAT SUPPRESSION NOW DEPENDS ON ───────────────────────────────────────────────
  // BOTH OF THE TWO TESTS BELOW WERE GREEN BEFORE #3184 AND PROVE NOTHING ABOUT IT. They are stated plainly as
  // what they are, because a green-before assertion sitting unlabelled inside a change's describe block reads
  // as evidence for that change and is not. What they DO buy: `applyLabel: null` is a new caller of two
  // guards whose shape was previously incidental, and if either is later re-keyed the failure is silent and
  // in the operator's least-recoverable direction. They are regression pins on someone else's code.
  it('[green before #3184 — pinned, not proven] the revocation notice hangs off `gate.applyLabel`', () => {
    // A null label skips the notice structurally, and `revokesClearance` is false as well, so the structural
    // and the flag guard agree. Announcing a revocation that did not happen would send the operator to
    // re-clear a clearance that is still live.
    expect(src).toMatch(/if \(gate\.applyLabel && !DRY_RUN\) \{/);
    expect(src.indexOf('if (gate.revokesClearance) {'))
      .toBeGreaterThan(src.indexOf('if (gate.applyLabel && !DRY_RUN) {'));
  });

  it('[green before #3184 — pinned, not proven] the #2324 body block keys on humanRequired, not the label', () => {
    // Suppression removes the label write, and in the drain the park COMMENT hangs off that write. The durable
    // record survives only because the human-park body block is a separate branch keyed on `gate.humanRequired`
    // — which suppression deliberately leaves true. Re-key that guard to the label and a suppressed park
    // becomes a silent one, which is the #xmnl36p defect coming back by another door.
    expect(src).toMatch(/if \(gate\.humanRequired && !DRY_RUN\) \{/);
  });
});

// ── #3343 — the basis's trust question has to REACH the scorer. `computeNetDiffSignals` is the one derivation
//    both production callers use (pr-land's `applyReviewEscalationLabel` and the drain's scoring loop), so the
//    `basisKind` / `basisNarrowed` the basis resolved must ride out of it — otherwise the distinction exists
//    only inside a function nobody in production calls directly. ────────────────────────────────────────────
describe('computeNetDiffSignals carries the basis trust question (#3343)', () => {
  const fakeExec = (script = {}) => {
    const exec = (cmd, args) => {
      const intent = args.filter((a) => a !== '--end-of-options' && a !== '--verify' && a !== '--no-ext-diff');
      const h = script[`${cmd} ${intent.join(' ')}`];
      if (h && h.throw) throw new Error(h.throw);
      if (h && 'stdout' in h) return h.stdout;
      if (args[0] === 'diff') throw new Error('unknown revision (unstubbed)');
      if (args[0] === 'log') throw new Error('unknown revision range (unstubbed)');
      return '';
    };
    return { exec };
  };

  it("a merge-base basis reports `basisKind:'merge-base'` and `basisNarrowed:true`", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main origin/lane/x': { stdout: 'forkpoint\n' },
      'git diff --numstat forkpoint origin/lane/x': { stdout: '3\t1\tREADME.md\n' },
      'git diff forkpoint origin/lane/x': { stdout: 'diff --git a/README.md b/README.md\n' },
    });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.scored).toBe(true);
    expect(sig.basisKind).toBe('merge-base');
    expect(sig.basisNarrowed).toBe(true);
  });

  it("an ancestry basis reports `basisKind:'ancestry'` and is still NARROWED — it is the PR's own file set", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main origin/lane/x': { throw: 'no common ancestors' },
      'git diff --numstat origin/main origin/lane/x': { stdout: '2\t0\tbacklog/a.md\n4\t4\tdocs/agent/platform-decisions.md\n' },
      'git log --numstat --diff-merges=first-parent --pretty=format: origin/main..origin/lane/x --': { stdout: '2\t0\tbacklog/a.md\n' },
      'git diff origin/main origin/lane/x': { stdout: 'diff --git a/backlog/a.md b/backlog/a.md\n' },
    });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.basisKind).toBe('ancestry');
    expect(sig.basisNarrowed).toBe(true);
    expect(sig.humanBasisFiles).toEqual(['backlog/a.md']);
  });

  it("a base-tip basis reports `basisNarrowed:false` — the signal the producer threads into the human gate", () => {
    const { exec } = fakeExec({
      'git merge-base origin/main origin/lane/x': { throw: 'no common ancestors' },
      'git diff --numstat origin/main origin/lane/x': { stdout: '2\t0\tbacklog/a.md\n4\t4\tdocs/agent/platform-decisions.md\n' },
      'git diff origin/main origin/lane/x': { stdout: 'diff --git a/backlog/a.md b/backlog/a.md\n' },
    });
    const sig = computeNetDiffSignals({ exec, rev: 'lane/x', fetchExtraRefs: ['lane/x'] });
    expect(sig.basisKind).toBe('base-tip');
    expect(sig.basisNarrowed).toBe(false);
  });

  it('an UNRESOLVED basis is not reported as un-narrowed — nothing was measured, which is a different fact', () => {
    const { exec } = fakeExec({});
    const sig = computeNetDiffSignals({ exec, rev: 'lane/gone' });
    expect(sig.scored).toBe(false);
    expect(sig.basisKind).toBe(null);
  });
});



// PR #3432 incident shape: 164 comments, >1 MiB view, mechanically moved head, identical contribution.
const REVIEWED = 'a'.repeat(40);
const REBASED = 'b'.repeat(40);
const REVIEWED_DIFF = 'diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-old\n+new\n';
function acceptanceView() {
  return { headRefOid: REBASED, headRefName: 'lane/3432', comments: [{ viewerDidAuthor: true,
    body: `✅ review — accepted\n<!-- reviewed-sha: ${REVIEWED} -->\n<!-- reviewed-diff: ${normalizeDiffFingerprint(REVIEWED_DIFF)} -->\n<!-- reviewed-contribution: ${normalizeContributionFingerprint(REVIEWED_DIFF)} -->`,
  }] };
}
function acceptanceOptions(view = acceptanceView()) {
  return { pr: 3432, repo: 'web-everything/web-everything', local: true,
    // `rev` echoes the commit asked for, as `computeNetDiffText` does: the read is bound to that SHA.
    exec: () => JSON.stringify(view), netDiff: ({ rev }) => ({ scored: true, text: REVIEWED_DIFF, rev }) };
}

describe('PR #3432 — drain acceptance verification and pending reconciliation', () => {
  const labels = [REVIEW_LABELS.accepted, REVIEW_LABELS.pending];

  it('reads a real subprocess response larger than 1 MiB and keeps the rebased PR accepted', () => {
    const view = acceptanceView();
    view.comments.unshift(...Array.from({ length: 163 }, () => ({ body: 'x'.repeat(9500) })));
    const payload = JSON.stringify(view);
    expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);
    expect(view.comments).toHaveLength(164);
    const dir = mkdtempSync(join(tmpdir(), 'we-drain-acceptance-'));
    try {
      const payloadFile = join(dir, 'response.json');
      writeFileSync(payloadFile, payload);
      const exec = (cmd, args, opts) => {
        expect(cmd).toBe('gh');
        expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
        expect(args).toEqual(['pr', 'view', '3432', '--repo', 'web-everything/web-everything', '--json', 'headRefOid,headRefName,comments']);
        // Keep real stdout pipe buffering and the production maxBuffer, without waiting for stdin EOF.
        return execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', payloadFile], {
          ...opts, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        });
      };
      const options = { ...acceptanceOptions(view), exec };
      const evidence = readDrainAcceptance(options);
      expect(evidence.acceptedSha).toBe(REVIEWED);
      expect(evidence.headSha).toBe(REBASED);
      expect(normalizeDiffFingerprint(evidence.headDiff)).toBe(evidence.acceptedDiff);
      expect(normalizeContributionFingerprint(evidence.headContribution)).toBe(evidence.acceptedContribution);
      const gate = decideDrainReviewGate({ labels, escalate: true }, options);
      expect(gate.action).toBe('merge');
      expect(gate.applyLabel).toBeUndefined();
      const spawn = vi.fn(() => ({ ok: true }));
      expect(reconcileDrainReviewPending({ currentLabels: labels, ...options }, { spawn }).ok).toBe(true);
      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0][0].to).toBe('accepted');
      expect(decideDrainReviewGate({ labels: [REVIEW_LABELS.accepted], escalate: true }, options).action).toBe('merge');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['ENOBUFS', 'network unavailable', 'invalid JSON', 'missing head', 'missing comments'])('defers an unreadable view without a label write: %s', (failure) => {
    const exec = vi.fn(() => {
      if (failure === 'invalid JSON') return '{';
      if (failure === 'missing head') return '{"comments":[]}';
      if (failure === 'missing comments') return JSON.stringify({ headRefOid: REBASED });
      throw new Error(failure);
    });
    const options = { ...acceptanceOptions(), exec };
    const gate = decideDrainReviewGate({ labels, escalate: true }, options);
    expect(gate).toMatchObject({ action: 'defer', applyLabel: null });
    expect(gate.reason).toContain('merge deferred this pass');
    if (failure === 'ENOBUFS' || failure === 'network unavailable') expect(gate.reason).toContain(failure);
    const spawn = vi.fn();
    expect(reconcileDrainReviewPending({ currentLabels: labels, ...options }, { spawn }).ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(exec.mock.calls.every(([cmd, args]) => cmd === 'gh' && args[1] === 'view')).toBe(true);
  });

  it.each(['no markers', 'changed content', 'unreadable diff'])('does not clear pending without coverage: %s', (failure) => {
    const view = acceptanceView();
    if (failure === 'no markers') view.comments = [];
    const options = { ...acceptanceOptions(view), netDiff: ({ rev }) => failure === 'unreadable diff'
      ? { scored: false } : { scored: true, text: REVIEWED_DIFF.replace('+new', '+unreviewed'), rev } };
    const spawn = vi.fn();
    expect(reconcileDrainReviewPending({ currentLabels: labels, ...options }, { spawn }).ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(decideDrainReviewGate({ labels, escalate: true }, options).action).toBe('park');
  });

  it('uses SHA coverage without a diff read and keeps dry-run free of writes', () => {
    const view = acceptanceView();
    view.headRefOid = REVIEWED;
    const netDiff = vi.fn();
    const spawn = vi.fn();
    expect(reconcileDrainReviewPending({ currentLabels: labels, dryRun: true,
      ...acceptanceOptions(view), netDiff }, { spawn }).ok).toBe(true);
    expect(netDiff).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('preserves the deviation gate and its trusted head-bound human clearance', () => {
    const view = acceptanceView();
    view.headRefOid = REVIEWED;
    const inputs = { labels: [REVIEW_LABELS.accepted], escalate: true, deviation: 'changed delivery scope' };
    expect(decideDrainReviewGate(inputs, acceptanceOptions(view)).action).toBe('park');
    view.comments[0].body += '\n<!-- cleared-human: operator -->';
    expect(decideDrainReviewGate(inputs, acceptanceOptions(view)).action).toBe('merge');
    view.comments[0].viewerDidAuthor = false;
    view.comments[0].author = { login: 'untrusted-worker' };
    expect(decideDrainReviewGate(inputs, acceptanceOptions(view)).action).toBe('park');
  });

  it('wires unreadable verification to a logged skip before the label-writing gate branches', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    expect(src).toMatch(/const gate = decideDrainReviewGate\([\s\S]*?if \(gate.action === 'defer'\) \{\s*v.decision = 'skip';\s*v.reason = gate.reason;\s*process.stderr.write\([\s\S]*?continue;\s*\}/);
    expect(src).toContain('const out = reconcileDrainReviewPending({');
  });
});

/**
 * PR #4446 review: the permission-change hold's DRAIN hand-off. The unit tests called `decideReviewGate` with a
 * hand-supplied `permissionChange: true`, so dropping the `score.signals.permissionChange` -> gate-input mapping at
 * the drain call site left every test green while the real drain went back to merging a bare accept (#4318).
 * These feed a REAL `scoreEscalation` result for the #4318 diff through the SAME mapping the call site uses
 * (`drainGateInputs`) and the SAME seam it calls (`decideDrainReviewGate`).
 */
describe('PR #4446 — permission-change hold: score -> drain gate hand-off', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const WF = '.github/workflows/apply-review-request.yml';
  const diff4318 = readFileSync(join(FIXTURES, 'pr4318-workflow-permissions.diff'), 'utf8');
  const scoreOf = (files, diffHunks) => scoreEscalation({ changedFiles: files, diffLines: 30, diffHunks });
  const drain = (score, view, extra = {}) => decideDrainReviewGate(
    drainGateInputs({ score, labels: [REVIEW_LABELS.accepted], ...extra }), acceptanceOptions(view));
  const reviewedView = () => { const view = acceptanceView(); view.headRefOid = REVIEWED; return view; };

  it('maps the #4318 score to a permissionChange gate input, and a plain score to none', () => {
    expect(drainGateInputs({ score: scoreOf([WF], diff4318), labels: [] }).permissionChange).toBe(true);
    expect(drainGateInputs({ score: scoreOf(['docs/README.md'], ''), labels: [] }).permissionChange).toBe(false);
    expect(permissionChangeForCandidate(undefined)).toBe(false);
    expect(permissionChangeForCandidate({ signals: { permissionChange: [] } })).toBe(false);
  });

  it('parks a bare or automatic accept on the #4318 replay as review:human', () => {
    const gate = drain(scoreOf([WF], diff4318), reviewedView());
    expect(gate.action).toBe('park');
    expect(gate.applyLabel).toBe(REVIEW_LABELS.human);
    expect(gate.reason).toMatch(/permission-change/);
  });

  it('merges once a trusted head-bound human clearance is recorded', () => {
    const view = reviewedView();
    view.comments[0].body += '\n<!-- cleared-human: operator -->';
    expect(drain(scoreOf([WF], diff4318), view).action).toBe('merge');
  });

  it('a PR with no permission change still merges on its accept', () => {
    expect(drain(scoreOf(['docs/README.md'], ''), reviewedView()).action).toBe('merge');
  });

  it('forwards the deviation input beside the permission input', () => {
    expect(drainGateInputs({ score: scoreOf(['docs/README.md'], ''), labels: [], deviation: 'scope' }).deviation).toBe('scope');
  });

  it('the drain call site builds its gate input through drainGateInputs (not an inline copy)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    expect(src).toMatch(/const gate = decideDrainReviewGate\(\s*drainGateInputs\(\{\s*score,\s*labels: v\.prLabels,\s*deviation: v\.deviation\s*\}\),/);
  });
});
