/**
 * @file scripts/__tests__/merge-ai-prs-review-escalation-and-rollup-dedup.test.mjs
 * @description Part of the merge-ai-prs.test.mjs split (originally one 4650-line file — see git history for the
 *   full-file description). This file covers: the drain reason comment, the #2423 per-PR
 *   --no-review-escalation relief valve, the #x9xqexm "a re-score never removes review:accepted" invariant, the
 *   #2417 per-pass read fan-out/cross-pass cache, and the required-check-rollup dedup helpers
 *   (latestRequiredCheck, collapseRollupToLatestPerName, rollupRowKind, and the #2899 landed-pass id resolution)
 *   — all exported from `scripts/merge-ai-prs.mjs` (plus a couple from `scripts/lib/review-escalation.mjs`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planResolveOnLand, resolveIdsForLandedPass, latestRequiredCheck, rollupRowKind, collapseRollupToLatestPerName, isRequiredCheckGreen, isRequiredCheckFailed, classifyPr, collectFlagOccurrences, parseNoReviewEscalation, applyEscalationRelief, mapWithConcurrency, fetchPrReadsCached, basisTouchesEngineTier, engineTierForCandidate } from '../merge-ai-prs.mjs';
import { decideReviewGate, REVIEW_LABELS, READY_TO_MERGE_LABEL, decideParkReadyStrip, scoreEscalation } from '../lib/review-escalation.mjs';
import { aiPr } from './fixtures/merge-ai-prs-fixtures.mjs';


describe('#2423 per-PR --no-review-escalation relief valve', () => {
  describe('collectFlagOccurrences — reads a REPEATABLE flag the last-write-wins flags object would drop', () => {
    it('collects every valued occurrence in order (not just the last)', () => {
      expect(collectFlagOccurrences(['--no-review-escalation=12', '--no-review-escalation=34'], 'no-review-escalation'))
        .toEqual(['12', '34']);
    });
    it('a BARE occurrence is recorded as true; a valued one as its raw string', () => {
      expect(collectFlagOccurrences(['--no-review-escalation', '--no-review-escalation=5'], 'no-review-escalation'))
        .toEqual([true, '5']);
    });
    it('ignores unrelated flags and a prefix that is not an exact match', () => {
      expect(collectFlagOccurrences(['--label=x', '--no-review-escalation-else=9'], 'no-review-escalation')).toEqual([]);
      expect(collectFlagOccurrences([], 'no-review-escalation')).toEqual([]);
      expect(collectFlagOccurrences(undefined, 'no-review-escalation')).toEqual([]);
    });
  });

  describe('parseNoReviewEscalation — repeatable + comma-separated; bare → passWide', () => {
    it('parses repeatable occurrences into { passWide:false, prs:[...] }', () => {
      expect(parseNoReviewEscalation(['--no-review-escalation=12', '--no-review-escalation=34']))
        .toEqual({ passWide: false, prs: [12, 34] });
    });
    it('parses a comma-separated value (and a mix of repeatable + comma)', () => {
      expect(parseNoReviewEscalation(['--no-review-escalation=12,34']))
        .toEqual({ passWide: false, prs: [12, 34] });
      expect(parseNoReviewEscalation(['--no-review-escalation=12,34', '--no-review-escalation=56']))
        .toEqual({ passWide: false, prs: [12, 34, 56] });
    });
    it('a BARE --no-review-escalation → passWide (the legacy pass-wide waiver), no prs', () => {
      expect(parseNoReviewEscalation(['--no-review-escalation'])).toEqual({ passWide: true, prs: [] });
      expect(parseNoReviewEscalation(['--no-review-escalation='])).toEqual({ passWide: true, prs: [] }); // empty value → bare
    });
    it('tolerates #-prefixed and padded numbers; drops non-numeric/≤0; de-dupes', () => {
      expect(parseNoReviewEscalation(['--no-review-escalation= #12 , 34 ,x, 0 ,12']))
        .toEqual({ passWide: false, prs: [12, 34] });
    });
    it('no flag at all → neither pass-wide nor any relieved PR', () => {
      expect(parseNoReviewEscalation(['--label=ready-to-merge'])).toEqual({ passWide: false, prs: [] });
    });
  });

  describe('applyEscalationRelief — waives ONLY an agent-reviewable review:pending park', () => {
    // The FRESH gate verdicts a candidate can carry this pass (from decideReviewGate).
    const pendingPark = decideReviewGate({ escalate: true, humanRequired: false, labels: [] });   // review:pending
    const humanPark = decideReviewGate({ escalate: true, humanRequired: true, labels: [] });      // review:human
    const changes = decideReviewGate({ escalate: true, labels: [{ name: REVIEW_LABELS.changes }] }); // wait-author

    it('relieved + agent-reviewable review:pending park → WAIVED to a merge', () => {
      expect(pendingPark.applyLabel).toBe(REVIEW_LABELS.pending);
      expect(applyEscalationRelief(pendingPark, { relieved: true }).waive).toBe(true);
    });
    it('the override REFUSES review:human (human-only, never waivable — #2285)', () => {
      expect(humanPark.applyLabel).toBe(REVIEW_LABELS.human);
      expect(applyEscalationRelief(humanPark, { relieved: true }).waive).toBe(false);
    });
    it('the override REFUSES review:changes (reviewer rejected → wait-author)', () => {
      expect(changes.action).toBe('wait-author');
      expect(applyEscalationRelief(changes, { relieved: true }).waive).toBe(false);
    });
    it('a NON-relieved review:pending park is untouched (still parks)', () => {
      expect(applyEscalationRelief(pendingPark, { relieved: false }).waive).toBe(false);
    });
    it('a gate that already says merge is never touched (nothing to waive)', () => {
      const mergeGate = decideReviewGate({ escalate: false, labels: [] });
      expect(applyEscalationRelief(mergeGate, { relieved: true }).waive).toBe(false);
    });
    it('#2409 — a STALE-acceptance re-park is NEVER waived, even though it carries review:pending', () => {
      // The head advanced past the reviewed SHA → decideReviewGate re-parks review:pending WITH staleAcceptance.
      // The pending-relief valve must refuse it: "review never arrived" and "head moved past review" are
      // different concerns, and only the former is waivable.
      const stalePark = decideReviewGate({ escalate: true, humanRequired: false, labels: [{ name: REVIEW_LABELS.accepted }], acceptedSha: 'aaaaaaa', headSha: 'bbbbbbb' });
      expect(stalePark.applyLabel).toBe(REVIEW_LABELS.pending); // looks like a pending park…
      expect(stalePark.staleAcceptance).toBe(true);             // …but it is the #2409 outcome
      expect(applyEscalationRelief(stalePark, { relieved: true }).waive).toBe(false);
    });
    it('#2412 review-fix — an ENGINE-tier park awaiting redteam:accepted is NEVER waived either', () => {
      // review:accepted alone, on an engine-tier PR → decideReviewGate parks review:pending with
      // awaitingIndependentValidator:true. Same applyLabel/humanRequired shape as an ordinary pending park —
      // the relief valve must key on the flag, not the shape, or it silently defeats the whole requirement.
      const engineTierPark = decideReviewGate({
        escalate: true, humanRequired: false, labels: [{ name: REVIEW_LABELS.accepted }], engineTier: true,
        // xvzc4v4: a matching accepted/head SHA so this clears the (separate) SHA-coverage gate and reaches
        // the engine-tier check this test is actually proving.
        acceptedSha: 'abc1234', headSha: 'abc1234',
      });
      expect(engineTierPark.applyLabel).toBe(REVIEW_LABELS.pending); // looks like a pending park…
      expect(engineTierPark.awaitingIndependentValidator).toBe(true); // …but it is the #2412 outcome
      expect(applyEscalationRelief(engineTierPark, { relieved: true }).waive).toBe(false);
    });
  });

  describe('a scoped =<pr#> relieves ONE PR while the rest of the pass stays gated', () => {
    // Faithful mini of runCli's per-candidate escalation loop (merge-ai-prs.mjs, the `if (REVIEW_ESCALATION)`
    // block): score → decideReviewGate → applyEscalationRelief. A waived candidate stays 'merge'; an unrelieved
    // park/wait-author skips. REVIEW_ESCALATION is ON here (a scoped =<pr#> keeps `passWide` false).
    const runPass = (candidates, argv) => {
      const { passWide, prs } = parseNoReviewEscalation(argv);
      expect(passWide).toBe(false); // a scoped run must NOT turn the rubric off pass-wide
      return candidates.map((c) => {
        const gate = decideReviewGate({ escalate: c.escalate, humanRequired: c.humanRequired, labels: c.labels || [] });
        const relief = applyEscalationRelief(gate, { relieved: prs.includes(c.num) });
        const decision = relief.waive ? 'merge' : (gate.action === 'park' || gate.action === 'wait-author' ? 'skip' : 'merge');
        return { num: c.num, decision, applyLabel: gate.applyLabel, humanRequired: gate.humanRequired, waived: relief.waive };
      });
    };

    it('the relieved review:pending PR merges while a fresh gate-self PR IN THE SAME PASS still parks review:human', () => {
      // #396 is a stuck agent-reviewable review:pending park; #401 is a fresh gate-self diff (humanRequired).
      const out = runPass(
        [
          { num: 396, escalate: true, humanRequired: false },  // agent-reviewable → review:pending
          { num: 401, escalate: true, humanRequired: true },   // gate-self → review:human
        ],
        ['--label=ready-to-merge', '--no-review-escalation=396'],
      );
      const p396 = out.find((o) => o.num === 396);
      const p401 = out.find((o) => o.num === 401);
      // the named PR is relieved → merges on allowPending semantics…
      expect(p396.decision).toBe('merge');
      expect(p396.waived).toBe(true);
      // …but the OTHER candidate's rubric stayed LIVE — the fresh gate-self PR still parks review:human.
      expect(p401.decision).toBe('skip');
      expect(p401.waived).toBe(false);
      expect(p401.applyLabel).toBe(REVIEW_LABELS.human);
    });

    it('naming a gate-self PR does NOT relieve it — review:human is never waivable', () => {
      const out = runPass(
        [{ num: 401, escalate: true, humanRequired: true }],
        ['--label=ready-to-merge', '--no-review-escalation=401'],
      );
      expect(out[0].decision).toBe('skip');
      expect(out[0].waived).toBe(false);
      expect(out[0].applyLabel).toBe(REVIEW_LABELS.human);
    });
  });
});

// #1920 round-2 review, finding 1/2 — the drain's ONE call site (`runCli`, `merge-ai-prs.mjs` ~line 4065)
// computes `engineTier` from the REAL `score.basisFiles` (the same `scoreEscalation` output the
// blast-radius/gate-self signals already score over, #3317), not a hand-supplied boolean like every other test
// in this file. Every prior engine-tier test (see `applyEscalationRelief` above, and `gate-invariants.test.mjs`
// INVARIANT 14) exercises `decideReviewGate`/`isEngineTierPath` directly — none of them ever ran
// `scoreEscalation`'s own `changedFiles → basisFiles` reduction through `basisTouchesEngineTier` first. This
// closes that gap: a real `scoreEscalation` result, run through the SAME exported function `runCli` uses.
describe('the real score.basisFiles → engineTier → decideReviewGate path (#1920 round-2 review, faithful mini of runCli)', () => {
  // Faithful mini of runCli's own sequence at the call site: score = scoreEscalation(...); engineTier =
  // basisTouchesEngineTier(score) [the real predicate `engineTierForCandidate` will delegate to once #3493
  // unblocks]; gate = decideReviewGate({ ...score, labels, engineTier }).
  const runCandidate = (changedFiles, labels) => {
    const score = scoreEscalation({ changedFiles, diffLines: 40 });
    const engineTier = basisTouchesEngineTier(score);
    const gate = decideReviewGate({ escalate: score.escalate, humanRequired: score.humanRequired, labels, engineTier, acceptedSha: 'abc1234', headSha: 'abc1234' });
    return { score, engineTier, gate };
  };

  it('a candidate whose basis includes an ENGINE_FILES member, with only review:accepted, does NOT merge — it parks awaiting redteam:accepted', () => {
    const { score, engineTier, gate } = runCandidate(['scripts/merge-ai-prs.mjs'], [{ name: REVIEW_LABELS.accepted }]);
    expect(score.basisFiles).toContain('scripts/merge-ai-prs.mjs'); // sanity: this IS the real scoreEscalation basis
    expect(engineTier).toBe(true); // the real basisFiles → engineTier reduction, not a hand-supplied boolean
    expect(gate.action).not.toBe('merge');
    expect(gate.applyLabel).toBe(REVIEW_LABELS.pending);
    expect(gate.awaitingIndependentValidator).toBe(true);
  });

  it('the SAME candidate merges once redteam:accepted is ALSO present — both independent verdicts stacked', () => {
    const { gate } = runCandidate(['scripts/merge-ai-prs.mjs'], [{ name: REVIEW_LABELS.accepted }, { name: REVIEW_LABELS.redteamAccepted }]);
    expect(gate.action).toBe('merge');
  });

  it('a candidate whose basis touches NO engine-tier file merges on review:accepted alone, exactly as before #2412', () => {
    const { score, engineTier, gate } = runCandidate(['docs/README.md', 'src/foo.ts'], [{ name: REVIEW_LABELS.accepted }]);
    expect(score.basisFiles).not.toContain('scripts/merge-ai-prs.mjs');
    expect(engineTier).toBe(false);
    expect(gate.action).toBe('merge');
  });

  // #3493 (blockedBy #2410) — the sequencing deferral surfaced at the #1920 rebase: main's own resolution of
  // #2412 deliberately did NOT wire this into production yet (no code-level/daemon-reachable redteam:accepted
  // writer exists). `engineTierForCandidate` is what `runCli`'s call site ACTUALLY uses today — always `false`,
  // regardless of what the real predicate above would say — so the drain still merges this exact candidate.
  it('…but engineTierForCandidate (what runCli ACTUALLY calls today) stays false, so the live drain still merges it (#3493 deferred)', () => {
    const score = scoreEscalation({ changedFiles: ['scripts/merge-ai-prs.mjs'], diffLines: 40 });
    const liveEngineTier = engineTierForCandidate(score);
    expect(liveEngineTier).toBe(false);
    const gate = decideReviewGate({
      escalate: score.escalate, humanRequired: score.humanRequired, labels: [{ name: REVIEW_LABELS.accepted }],
      engineTier: liveEngineTier, acceptedSha: 'abc1234', headSha: 'abc1234',
    });
    expect(gate.action).toBe('merge'); // pinned: flipping this requires deliberately updating this test too
  });
});

describe('#x9xqexm — a re-score never REMOVES review:accepted (superseding #2409\'s add-first/remove-last)', () => {
  // WHAT THIS REPLACES. #2409's re-park swap did two `gh pr edit` calls: add the re-park label, then drop the
  // now-stale `review:accepted`. Its safety property was the ORDER (add-first/remove-last), because both calls
  // are best-effort and removing first could leave a PR with NO review label. #x9xqexm removes the second call
  // entirely, which retires that ordering concern and closes a worse one: the drain was DELETING a human's
  // recorded clearance minutes after the operator granted it (WE PR #1100 at 14:41:44, PR #984 at 14:41:51 —
  // 2-3s after the matching add, exactly this swap).
  //
  // WHY THE MERGE IS STILL REFUSED WITHOUT THE REMOVAL. `decideReviewGate` checks `review:accepted` FIRST and
  // returns `action:'park'` — never `'merge'` — for as long as `acceptanceCoversHead` says the accept is stale,
  // so the land decision never depended on the label being gone. The one thing the removal did buy — keeping the
  // NON-scoring paths from reading `accepted + human` as cleared — is now `hasUnclearedReviewLabel`'s job
  // (gate-invariants INVARIANT 5). Source-level, because an inline side-effecting `gh` sequence has no other
  // observable seam.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');

  it('the re-park ADD is still there — a stale acceptance is still re-parked, it just is not un-accepted', () => {
    expect(src.indexOf("'--add-label', gate.applyLabel")).toBeGreaterThan(-1);
  });

  it('NO code path in the drain removes review:accepted, in any spelling', () => {
    for (const forbidden of [
      /--remove-label'\s*,\s*REVIEW_LABELS\.accepted/,
      /--remove-label'\s*,\s*'review:accepted'/,
      /--remove-label=review:accepted/,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });

  // ── ROUND-2 BLOCKER 1: the label pair the removal used to prevent, on the path that never scores. ─────────
  // Keeping `review:accepted` through a re-park is only safe if every reader of the raw label set understands
  // the resulting pair. `decideReviewGate` does — it re-derives `park` from the fingerprints every pass. The
  // BARE `/merge` orphan sweep does not: `node scripts/merge-ai-prs.mjs` with no `--label` sets
  // `REVIEW_ESCALATION = false` and never calls `decideReviewGate` at all, so `classifyPr` is the whole gate
  // there — and it certifies on `review:accepted` ALONE (no `ready-to-merge` required, so stripping that label
  // protects nothing). These are the two pairs a stale re-park can leave behind.
  const bare = (names) => aiPr({ labels: names.map((name) => ({ name })) });

  it('the bare sweep REFUSES a stale re-park pair [accepted, pending] — the PR #984 shape', () => {
    // The drain applies `review:pending` on re-park whenever the fresh score is not `humanRequired`, which is
    // the bulk of the queue. No sanctioned writer makes this pair: `--to=accepted` and `--to=clear-human` both
    // REMOVE `pending` as they add `accepted`. So the pair means "a re-score found this accept stale" and the
    // non-scoring path must read it that way.
    const v = classifyPr(bare([REVIEW_LABELS.accepted, REVIEW_LABELS.pending]));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(true);
    expect(v.reason).toMatch(/unsatisfied review hold/);
  });

  it('the bare sweep REFUSES a stale re-park pair [accepted, human] — the gate-self shape', () => {
    const v = classifyPr(bare([REVIEW_LABELS.accepted, REVIEW_LABELS.human]));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(true);
  });

  it('…and still MERGES a clean [accepted] — refusing the pairs costs no legitimate land', () => {
    expect(classifyPr(bare([REVIEW_LABELS.accepted])).decision).toBe('merge');
    // #2974 stays exactly as ratified: the reviewer verdict wins over a stale bounce.
    expect(classifyPr(bare([REVIEW_LABELS.accepted, REVIEW_LABELS.changes])).decision).toBe('merge');
  });

  // ── ROUND-2 MINOR 5: the #2832 interaction, resolved rather than inherited. ───────────────────────────────
  it('#2832 — a stale re-park still strips ready-to-merge, WITH or WITHOUT the staleAcceptance filter', () => {
    // `decideParkReadyStrip`'s `staleAcceptance` option shipped filtering `review:accepted` out of the effective
    // set BECAUSE "this same park is about to REMOVE it". #x9xqexm ends that removal, so the stated reason is
    // gone. The filter is kept (see its docstring) but the OUTCOME must no longer depend on it — otherwise a
    // future reader deleting the now-pointless filter silently leaves the go-ahead standing on a held PR. That
    // independence is what `hasUnclearedReviewLabel` refusing `accepted + pending` buys, and it is pinned here.
    const observed = [READY_TO_MERGE_LABEL, REVIEW_LABELS.accepted];
    for (const applyLabel of [REVIEW_LABELS.pending, REVIEW_LABELS.human]) {
      expect(decideParkReadyStrip(observed, { applyLabel, staleAcceptance: true })).toBe(true);
      expect(decideParkReadyStrip(observed, { applyLabel, staleAcceptance: false })).toBe(true);
    }
    // …and a legitimately queued PR (accepted + go-ahead, no hold) is still never un-queued, either way.
    expect(decideParkReadyStrip(observed, { applyLabel: null, staleAcceptance: false })).toBe(false);
  });
});

describe('#2417 — per-pass read fan-out (bounded pool)', () => {
  it('mapWithConcurrency preserves input order and runs with a bounded number in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fn = async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 2;
    };
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, fn);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]); // input order preserved
    expect(peak).toBeLessThanOrEqual(3);           // never more than `limit` concurrent
    expect(peak).toBeGreaterThan(1);               // and it DID run some in parallel
  });

  it('mapWithConcurrency degrades safely on an empty list and a limit below 1', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]); // clamps to ≥1 worker
  });

  it('fans out every PR through fetchOne once on a cold first pass', async () => {
    const calls = [];
    const cache = new Map();
    const prs = [{ repo: 'we', number: 1, sha: 'a' }, { repo: 'we', number: 2, sha: 'b' }, { repo: 'fui', number: 1, sha: 'c' }];
    const reads = await fetchPrReadsCached(prs, {
      cache,
      keyOf: (p) => `${p.repo}::${p.number}`,
      shaOf: (p) => p.sha,
      fetchOne: async (p) => { calls.push(`${p.repo}::${p.number}`); return { commits: [p.number] }; },
    });
    expect(calls.sort()).toEqual(['fui::1', 'we::1', 'we::2']); // all three fetched once
    expect(reads.get('we::1').value).toEqual({ commits: [1] });
    expect(reads.get('we::1').cached).toBe(false);
  });
});

describe('#2417 — cross-pass cache reuses unchanged-SHA reads under --watch', () => {
  it('does NOT re-fetch a PR whose head SHA is unchanged on a second pass, but DOES re-fetch a changed SHA', async () => {
    const cache = new Map();
    let fetches = 0;
    const run = (prs) => fetchPrReadsCached(prs, {
      cache,
      keyOf: (p) => `${p.repo}::${p.number}`,
      shaOf: (p) => p.sha,
      fetchOne: async (p) => { fetches++; return { commits: [p.sha] }; },
    });

    // Pass 1 (cold): both PRs fetched.
    await run([{ repo: 'we', number: 1, sha: 'aaa' }, { repo: 'we', number: 2, sha: 'bbb' }]);
    expect(fetches).toBe(2);

    // Pass 2: PR#1 unchanged (reused, NO fetch), PR#2 rebuilt its tip (changed SHA → re-fetched).
    const pass2 = await run([{ repo: 'we', number: 1, sha: 'aaa' }, { repo: 'we', number: 2, sha: 'ccc' }]);
    expect(fetches).toBe(3);                       // exactly ONE new fetch (PR#2), NOT two
    expect(pass2.get('we::1').cached).toBe(true);  // PR#1 served from cache
    expect(pass2.get('we::2').cached).toBe(false); // PR#2 re-fetched
    expect(pass2.get('we::2').value).toEqual({ commits: ['ccc'] });
  });

  it('evicts a PR that dropped out of the pass so the cache tracks the live open set (bounded growth)', async () => {
    const cache = new Map();
    const opts = (prs) => fetchPrReadsCached(prs, {
      cache,
      keyOf: (p) => `${p.repo}::${p.number}`,
      shaOf: (p) => p.sha,
      fetchOne: async () => ({ ok: true }),
    });
    await opts([{ repo: 'we', number: 1, sha: 'a' }, { repo: 'we', number: 2, sha: 'b' }]);
    expect(cache.size).toBe(2);
    await opts([{ repo: 'we', number: 1, sha: 'a' }]); // PR#2 landed/closed → gone from the pass
    expect(cache.size).toBe(1);
    expect(cache.has('we::2')).toBe(false);
  });

  it('a null head SHA always misses (never serves a stale read when the key is unknowable)', async () => {
    const cache = new Map();
    let fetches = 0;
    const run = (prs) => fetchPrReadsCached(prs, {
      cache,
      keyOf: (p) => `${p.repo}::${p.number}`,
      shaOf: (p) => p.sha,
      fetchOne: async () => { fetches++; return {}; },
    });
    await run([{ repo: 'we', number: 1, sha: null }]);
    await run([{ repo: 'we', number: 1, sha: null }]);
    expect(fetches).toBe(2); // no SHA ⇒ cannot prove unchanged ⇒ re-fetch each pass
  });

  it('does NOT cache an error-path (degraded) read — the next pass re-fetches and self-heals', async () => {
    // #2417 review — a swallowed gh error yields a spurious `{ commits: [], degraded: true }`. Even though the
    // head SHA is UNCHANGED, that degraded read must not latch: caching it would serve the empty/degraded read
    // for the whole head-SHA lifetime under `--watch` instead of self-healing when gh recovers next pass.
    const cache = new Map();
    let ghUp = false; // gh is DOWN on pass 1 (throws → degraded), UP from pass 2
    let fetches = 0;
    const run = (prs) => fetchPrReadsCached(prs, {
      cache,
      keyOf: (p) => `${p.repo}::${p.number}`,
      shaOf: (p) => p.sha,
      isDegraded: (v) => !!v?.degraded,
      fetchOne: async () => {
        fetches++;
        return ghUp ? { commits: ['c1'], degraded: false } : { commits: [], degraded: true };
      },
    });
    const pr = [{ repo: 'we', number: 1, sha: 'aaa' }]; // SHA is stable across all three passes

    // Pass 1 (gh down): fetched, degraded → used this pass but NOT cached.
    const p1 = await run(pr);
    expect(fetches).toBe(1);
    expect(p1.get('we::1').value).toEqual({ commits: [], degraded: true }); // best-effort value THIS pass
    expect(cache.has('we::1')).toBe(false);                                 // degraded read was NOT cached

    // Pass 2 (gh recovered): unchanged SHA still RE-FETCHES (the degraded read never latched) and self-heals.
    ghUp = true;
    const p2 = await run(pr);
    expect(fetches).toBe(2);                                                // re-fetched despite unchanged SHA
    expect(p2.get('we::1').cached).toBe(false);
    expect(p2.get('we::1').value).toEqual({ commits: ['c1'], degraded: false });
    expect(cache.has('we::1')).toBe(true);                                  // the good read IS cached now

    // Pass 3 (still up, unchanged SHA): NOW served from cache (a genuine successful read latches correctly).
    const p3 = await run(pr);
    expect(fetches).toBe(2);                                                // no new fetch — cache hit
    expect(p3.get('we::1').cached).toBe(true);
  });
});

describe('latestRequiredCheck — a superseded run must not outvote the one that finished (#xkfv491)', () => {
  // The exact PR #1042 rollup: a concurrency-cancelled run at index 0, the real SUCCESS at index 1.
  const supersededThenGreen = {
    statusCheckRollup: [
      { name: 'test', conclusion: 'CANCELLED', startedAt: '2026-08-05T18:34:02Z' },
      { name: 'test', conclusion: 'SUCCESS', startedAt: '2026-08-05T18:35:32Z' },
    ],
  };

  it('reads the LATEST run, not the first-listed one — the jam that held #1042/#1046/#1012', () => {
    expect(latestRequiredCheck(supersededThenGreen).conclusion).toBe('SUCCESS');
    expect(isRequiredCheckGreen(supersededThenGreen)).toBe(true);
  });

  it('the ci:failed twin no longer fires on the superseded cancelled run', () => {
    expect(isRequiredCheckFailed(supersededThenGreen)).toBe(false);
  });

  it('LATEST-WINS, not ignore-CANCELLED: a cancelled newest run means no current verdict', () => {
    const greenThenCancelled = {
      statusCheckRollup: [
        { name: 'test', conclusion: 'SUCCESS', startedAt: '2026-08-05T18:34:02Z' },
        { name: 'test', conclusion: 'CANCELLED', startedAt: '2026-08-05T18:35:32Z' },
      ],
    };
    expect(isRequiredCheckGreen(greenThenCancelled)).toBe(false);
    expect(isRequiredCheckFailed(greenThenCancelled)).toBe(true);
  });

  it('an in-flight run listed last suppresses the stale SUCCESS before it (live shape from PR #1046)', () => {
    // The run still executing is the newest, so it decides — the PR is neither green nor red while it runs.
    // No timestamp is consulted, so GitHub's `0001-01-01T00:00:00Z` sentinel for an unfinished run is inert.
    const staleGreenPlusQueued = {
      statusCheckRollup: [
        { name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED', startedAt: '2026-08-05T18:35:32Z', completedAt: '2026-08-05T18:36:10Z' },
        { name: 'test', conclusion: '', status: 'QUEUED', startedAt: '2026-08-05T21:04:30Z', completedAt: '0001-01-01T00:00:00Z' },
      ],
    };
    expect(latestRequiredCheck(staleGreenPlusQueued).status).toBe('QUEUED');
    expect(isRequiredCheckGreen(staleGreenPlusQueued)).toBe(false); // in flight ⇒ no current verdict
    expect(isRequiredCheckFailed(staleGreenPlusQueued)).toBe(false); // and not red either
  });

  it('ignores timestamps entirely — creation order alone decides (no clock is read)', () => {
    // A rollup whose stamps CONTRADICT its order still resolves by order. This pins the trust-GitHub's-order
    // rule: the earlier cut ranked by a timestamp and, on this shape, returned the FAILURE instead.
    const stampsContradictOrder = {
      statusCheckRollup: [
        { name: 'test', conclusion: 'FAILURE', startedAt: '2026-08-05T18:40:00Z', completedAt: '2026-08-05T18:50:00Z' },
        { name: 'test', conclusion: 'SUCCESS', startedAt: '2026-08-05T18:30:00Z', completedAt: '2026-08-05T18:31:00Z' },
      ],
    };
    expect(isRequiredCheckGreen(stampsContradictOrder)).toBe(true);
    const noTimes = { statusCheckRollup: [{ name: 'test', conclusion: 'CANCELLED' }, { name: 'test', conclusion: 'SUCCESS' }] };
    expect(isRequiredCheckGreen(noTimes)).toBe(true);
    const badTimes = {
      statusCheckRollup: [
        { name: 'test', conclusion: 'CANCELLED', startedAt: 'not-a-date' },
        { name: 'test', conclusion: 'SUCCESS', startedAt: 'also-not-a-date' },
      ],
    };
    expect(isRequiredCheckGreen(badTimes)).toBe(true);
  });

  it('a LONE StatusContext decides when the workflow produced no `test` CheckRun', () => {
    // The only reachable shape for this branch. GitHub's combined status is DEDUPLICATED per context (and
    // `StatusContext` carries no `name`), so a rollup can hold at most ONE `test` StatusContext — an earlier
    // cut of this test asserted over two of them, a shape GitHub cannot emit, and left the single-entry case
    // (the one that actually reaches the `pool = matches` fallback) uncovered.
    const withStatus = (state) => ({
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'cla', conclusion: 'SUCCESS', startedAt: '2026-08-05T18:30:00Z' },
        { __typename: 'StatusContext', context: 'test', state, createdAt: '2026-08-05T18:35:32Z' },
      ],
    });
    expect(latestRequiredCheck(withStatus('SUCCESS')).context).toBe('test');
    expect(isRequiredCheckGreen(withStatus('SUCCESS'))).toBe(true);
    expect(isRequiredCheckGreen(withStatus('FAILURE'))).toBe(false);
    expect(isRequiredCheckFailed(withStatus('FAILURE'))).toBe(true);
    // A `cla` CheckRun is not a `test` CheckRun — the preference is PER NAME, so it must not suppress the
    // `test` status above and leave the check reading as unreported.
    expect(latestRequiredCheck(withStatus('SUCCESS'))).not.toBeNull();
  });

  it('a posted commit status can NEVER override the real check run (merge-gate bypass, PR #1049 review)', () => {
    // A `StatusContext` is postable through the commit-statuses API by anyone holding `statuses:write` — a
    // collaborator, a bot, an installed App. Plain last-wins across both shapes would let one posted AFTER the
    // real run clear the gate on a red tree. CheckRuns win whenever any exists. The live rollup shape: every
    // row carries `__typename` (verified against `gh pr view 1049 --json statusCheckRollup`).
    const spoofedGreen = {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE', startedAt: '2026-08-05T18:00:00Z', completedAt: '2026-08-05T18:10:00Z' },
        { __typename: 'StatusContext', context: 'test', state: 'SUCCESS', createdAt: '2026-08-05T18:11:00Z' },
      ],
    };
    expect(latestRequiredCheck(spoofedGreen).conclusion).toBe('FAILURE');
    expect(isRequiredCheckGreen(spoofedGreen)).toBe(false);
    expect(isRequiredCheckFailed(spoofedGreen)).toBe(true);
  });

  it('single-run, missing-check and non-required cases are unchanged', () => {
    expect(latestRequiredCheck({ statusCheckRollup: [] })).toBeNull();
    expect(latestRequiredCheck({ statusCheckRollup: [{ name: 'cla', conclusion: 'SUCCESS' }] })).toBeNull();
    expect(isRequiredCheckGreen({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] })).toBe(true);
    expect(isRequiredCheckGreen({ statusCheckRollup: [{ name: 'test', conclusion: 'CANCELLED' }] })).toBe(false);
    expect(isRequiredCheckFailed({ statusCheckRollup: [] })).toBe(false);
    expect(isRequiredCheckGreen(undefined)).toBe(false);
  });

  it('a PR whose ONLY run is cancelled still reads not-green (never landed on a superseded verdict)', () => {
    const onlyCancelled = { statusCheckRollup: [{ name: 'test', conclusion: 'CANCELLED', startedAt: '2026-08-05T18:34:02Z' }] };
    expect(isRequiredCheckGreen(onlyCancelled)).toBe(false);
    expect(isRequiredCheckFailed(onlyCancelled)).toBe(true);
  });
});

describe('collapseRollupToLatestPerName — the #2925 shared seam every rollup-folding reader routes through', () => {
  // The decisive #2925 case: CANCELLED at index 0, SUCCESS at index 1 for the SAME name.
  const cancelledThenSuccess = [
    { __typename: 'CheckRun', name: 'test', conclusion: 'CANCELLED' },
    { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
  ];

  it('collapses to ONE row per name, keeping the latest tier-preferred entry (CANCELLED at index 0 loses)', () => {
    const collapsed = collapseRollupToLatestPerName(cancelledThenSuccess);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].conclusion).toBe('SUCCESS');
  });

  it('preserves EVERY distinct name — only within-name entries collapse', () => {
    const roll = [
      { __typename: 'CheckRun', name: 'test', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'cla', conclusion: 'SUCCESS' },
    ];
    const collapsed = collapseRollupToLatestPerName(roll);
    expect(collapsed).toHaveLength(2);
    expect(collapsed.find((c) => c.name === 'test').conclusion).toBe('SUCCESS');
    expect(collapsed.find((c) => c.name === 'cla').conclusion).toBe('SUCCESS');
  });

  it('is the SAME rule `latestRequiredCheck` uses — a by-name lookup over this output', () => {
    const pr = { statusCheckRollup: cancelledThenSuccess };
    expect(latestRequiredCheck(pr).conclusion)
      .toBe(collapseRollupToLatestPerName(cancelledThenSuccess).find((c) => c.name === 'test').conclusion);
  });

  it('tolerant of an absent/odd rollup', () => {
    expect(collapseRollupToLatestPerName(null)).toEqual([]);
    expect(collapseRollupToLatestPerName(undefined)).toEqual([]);
    expect(collapseRollupToLatestPerName([])).toEqual([]);
  });
});

describe('rollupRowKind — the union member comes off `__typename`, it is not guessed from `name` (#1049 r3)', () => {
  it('reads the authoritative tag when present', () => {
    expect(rollupRowKind({ __typename: 'CheckRun', name: 'test' })).toBe('CheckRun');
    expect(rollupRowKind({ __typename: 'StatusContext', context: 'test' })).toBe('StatusContext');
  });

  it('an ABSENT or unrecognised `__typename` is UNTAGGED — never promoted to CheckRun', () => {
    expect(rollupRowKind({ name: 'test', conclusion: 'SUCCESS' })).toBe('untagged');
    expect(rollupRowKind({ __typename: 'SomeFutureContext', name: 'test' })).toBe('untagged');
    expect(rollupRowKind(null)).toBe('untagged');
    expect(rollupRowKind({})).toBe('untagged');
  });

  it('falls back to shape ONLY for the unambiguous legacy case: a `context` with no `name`', () => {
    expect(rollupRowKind({ context: 'test', state: 'SUCCESS' })).toBe('StatusContext');
    // `rollupToCheckRows` (we:scripts/fetch-parked.mjs#rollupToCheckRows) normalises a StatusContext to
    // `{ name: c.name || c.context }`. Under the old `name`-presence inference that row classified as a
    // CheckRun; it must not.
    expect(rollupRowKind({ name: 'test', bucket: 'pass' })).toBe('untagged');
  });

  it('a TAGGED CheckRun outranks an untagged row listed after it', () => {
    // The tier ladder is CheckRun → untagged → StatusContext, so a row of unknown provenance cannot displace
    // the verdict of a row GitHub itself labelled a CheckRun.
    const pr = {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
        { name: 'test', conclusion: 'SUCCESS' }, // untagged — lower tier, so it never decides
      ],
    };
    expect(latestRequiredCheck(pr).conclusion).toBe('FAILURE');
    expect(isRequiredCheckGreen(pr)).toBe(false);
  });

  it('a tagged StatusContext still decides when NO CheckRun reported that name', () => {
    const pr = { statusCheckRollup: [{ __typename: 'StatusContext', context: 'test', state: 'SUCCESS' }] };
    expect(latestRequiredCheck(pr).state).toBe('SUCCESS');
    expect(isRequiredCheckGreen(pr)).toBe(true);
  });

  it('an all-untagged rollup still resolves latest-wins (fixtures / re-normalised rows keep working)', () => {
    const pr = { statusCheckRollup: [{ name: 'test', conclusion: 'CANCELLED' }, { name: 'test', conclusion: 'SUCCESS' }] };
    expect(isRequiredCheckGreen(pr)).toBe(true);
  });
});

describe('#2899 A5 — resolveIdsForLandedPass: which ids the LABEL lander resolves after JIT numbering', () => {
  // Context: this drain single-sourced lane-drain's NUMBERING but never its RESOLVING, so it assigned the NNN
  // and left `status:` untouched — delivered work kept ranking Tier-A agent-ready and got re-packed (#2880,
  // #2450). The flip now runs here, and it must target the id the card carries AFTER numbering, not before.
  it('re-keys a hash-born item to the NNN numbering just minted for it', () => {
    expect(resolveIdsForLandedPass({
      landedItems: new Set(['xdxlevu']),
      assigned: [{ hash: 'xdxlevu', nnn: '2899' }],
    })).toEqual(['2899']);
  });

  it('leaves an already-numeric item alone', () => {
    expect(resolveIdsForLandedPass({ landedItems: new Set([2880]), assigned: [] })).toEqual([2880]);
  });

  it('KEEPS a hash with no assignment rather than dropping it', () => {
    // Numbering can legitimately be a no-op (the card landed already-numbered, or a concurrent lander minted
    // it). Dropping the id here would silently re-open the stranded-item hole this closes; `resolveLandedItem`
    // is itself a safe no-op when the path does not resolve, so keeping it costs nothing.
    expect(resolveIdsForLandedPass({ landedItems: new Set(['xnomatch']), assigned: [{ hash: 'xother', nnn: '1' }] }))
      .toEqual(['xnomatch']);
  });

  it('de-duplicates when a hash and its minted NNN both appear, preserving first-seen order', () => {
    expect(resolveIdsForLandedPass({
      landedItems: ['xaaa', 'xbbb', '2900', 'xaaa'],
      assigned: [{ hash: 'xaaa', nnn: '2900' }, { hash: 'xbbb', nnn: '2901' }],
    })).toEqual(['2900', '2901']);
  });

  it('is empty for a pass that landed nothing, and tolerates junk inputs', () => {
    expect(resolveIdsForLandedPass({ landedItems: new Set(), assigned: [] })).toEqual([]);
    expect(resolveIdsForLandedPass()).toEqual([]);
    expect(resolveIdsForLandedPass({ landedItems: [null, undefined, 'x1'], assigned: null })).toEqual(['x1']);
    expect(resolveIdsForLandedPass({ landedItems: ['x1'], assigned: [{ hash: 'x1' }, null, { nnn: '5' }] })).toEqual(['x1']);
  });
});

describe('#2899 B5 — the resolve gate requires the WHOLE couple to have landed, not just the carrier', () => {
  // PR #1012 round-3 review, B5. The original gate rested on a comment claiming "WE-last ordering means the
  // carrier merges only after its impl half did". Running the cascade disproves it: the couple decision is
  // computed once at PLAN time and the in-cascade `replan` re-runs planLabelDrain WITHOUT the couple join, so an
  // impl whose `gh pr merge` throws flips to `skip` while the carrier still lands. Resolving off the carrier
  // alone then marks the card resolved on main with the implementation PR still OPEN — nothing re-dispatches it,
  // which is the forever-block this item exists to close, reappearing inside the fix.
  const carrier = { item: 'xcarr01', headRef: 'lane/xcarr01-we', manifestRefs: ['lane/xcarr01-fui', 'lane/xcarr01-we'] };

  it('DEFERS the flip when a sibling half is still open (the impl merge failed mid-cascade)', () => {
    expect(resolveIdsForLandedPass({
      landedItems: new Set(['xcarr01']),
      assigned: [{ hash: 'xcarr01', nnn: '2910' }],
      carriers: [carrier],
      openHeadRefs: ['lane/xcarr01-fui'],          // the impl PR never merged — still open after the cascade
    })).toEqual([]);
  });

  it('RESOLVES when every sibling ref has left the open set (the whole couple landed)', () => {
    expect(resolveIdsForLandedPass({
      landedItems: new Set(['xcarr01']),
      assigned: [{ hash: 'xcarr01', nnn: '2910' }],
      carriers: [carrier],
      openHeadRefs: ['lane/unrelated-other'],
    })).toEqual(['2910']);
  });

  it('ignores the carrier\'s OWN head ref — it is the half that just merged, not a blocker', () => {
    expect(resolveIdsForLandedPass({
      landedItems: new Set(['xcarr01']),
      assigned: [],
      carriers: [carrier],
      openHeadRefs: ['lane/xcarr01-we'],           // the carrier itself, stale in the pass-start snapshot
    })).toEqual(['xcarr01']);
  });

  it('is unchanged for a caller that supplies no couple shape (single-repo item, or an older caller)', () => {
    expect(resolveIdsForLandedPass({ landedItems: new Set(['xsolo01']), assigned: [{ hash: 'xsolo01', nnn: '2911' }] }))
      .toEqual(['2911']);
    // A carrier entry with no refs blocks nothing.
    expect(resolveIdsForLandedPass({
      landedItems: new Set(['xsolo01']),
      assigned: [],
      carriers: [{ item: 'xsolo01', headRef: 'lane/xsolo01-we', manifestRefs: [] }],
      openHeadRefs: ['lane/whatever'],
    })).toEqual(['xsolo01']);
  });

  it('gates per couple — one blocked couple does not suppress a healthy one', () => {
    const other = { item: 'xcarr02', headRef: 'lane/xcarr02-we', manifestRefs: ['lane/xcarr02-fui', 'lane/xcarr02-we'] };
    expect(resolveIdsForLandedPass({
      landedItems: ['xcarr01', 'xcarr02'],
      assigned: [],
      carriers: [carrier, other],
      openHeadRefs: ['lane/xcarr01-fui'],          // only couple 01 is half-landed
    })).toEqual(['xcarr02']);
  });
});

describe('#2899 jury J2/J4 — planResolveOnLand is TOTAL: nothing is silently withheld', () => {
  // The first cut returned only the ids to flip, so a couple the B5 gate withheld vanished with no log line, no
  // --json key and no retry — while the comment claimed it would "defer to a later pass". That is false:
  // `landedThisPass` is only populated when a carrier merges IN that pass, so a later pass never re-lists it.
  // The deferral is right; the silence was the defect. A silent skip inside a fix for silent skips cannot ship.
  const we = { item: 'xcarr01', repo: null, isWe: true, headRef: 'lane/xcarr01-we', manifestRefs: ['lane/xcarr01-fui', 'lane/xcarr01-we'] };

  it('every landed item lands in exactly ONE bucket — resolve or deferred, never neither', () => {
    const p = planResolveOnLand({
      landedItems: ['xcarr01', 'xsolo01'],
      assigned: [{ hash: 'xcarr01', nnn: '2910' }, { hash: 'xsolo01', nnn: '2911' }],
      carriers: [we],
      openHeadRefs: ['lane/xcarr01-fui'],
    });
    expect(p.resolve).toEqual(['2911']);
    expect(p.deferred.map((d) => d.id)).toEqual(['2910']);
    // TOTALITY: the union covers every distinct landed item, with no overlap.
    expect([...p.resolve, ...p.deferred.map((d) => d.id)].sort()).toEqual(['2910', '2911']);
  });

  it('names the blocking ref in the deferral reason, so the report is actionable', () => {
    const p = planResolveOnLand({ landedItems: ['xcarr01'], assigned: [], carriers: [we], openHeadRefs: ['lane/xcarr01-fui'] });
    expect(p.deferred[0].reason).toMatch(/lane\/xcarr01-fui/);
  });

  it('J4 — the WE carrier wins the couple key even when the impl half is seen LAST', () => {
    // Both halves carry a manifest for one item. With an item-only last-write-wins key the impl's headRef won,
    // and the gate's `r !== couple.headRef` exemption then SKIPPED the still-open impl ref — the safety check
    // disabling itself. Ordered impl-last on purpose: this is the input that used to pass.
    const impl = { item: 'xcarr01', repo: 'frontier-ui/frontierui', isWe: false, headRef: 'lane/xcarr01-fui', manifestRefs: ['lane/xcarr01-fui', 'lane/xcarr01-we'] };
    const p = planResolveOnLand({
      landedItems: ['xcarr01'],
      assigned: [],
      carriers: [we, impl],
      openHeadRefs: ['lane/xcarr01-fui'],       // the impl half never merged
    });
    expect(p.resolve).toEqual([]);
    expect(p.deferred.map((d) => d.id)).toEqual(['xcarr01']);
  });

  it('the back-compat shim still returns just the ids to flip', () => {
    expect(resolveIdsForLandedPass({ landedItems: ['xcarr01'], assigned: [], carriers: [we], openHeadRefs: ['lane/xcarr01-fui'] })).toEqual([]);
    expect(resolveIdsForLandedPass({ landedItems: ['xcarr01'], assigned: [], carriers: [we], openHeadRefs: [] })).toEqual(['xcarr01']);
  });

  it('is total for the trivial cases too', () => {
    expect(planResolveOnLand()).toEqual({ resolve: [], deferred: [] });
    expect(planResolveOnLand({ landedItems: [null, undefined] })).toEqual({ resolve: [], deferred: [] });
  });
});
