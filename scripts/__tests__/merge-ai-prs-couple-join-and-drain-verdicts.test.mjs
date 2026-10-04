/**
 * @file scripts/__tests__/merge-ai-prs-couple-join-and-drain-verdicts.test.mjs
 * @description Part of the merge-ai-prs.test.mjs split (originally one 4650-line file — see git history for the
 *   full-file description). This file covers: #xc7p3q9 (couple-join decoupled from the ready-to-merge/candidate
 *   scope — carrierDeferDecision, buildCarrierHealth, deferralsAllHeldCouple, planDrainPass,
 *   resolveContextRepos, reduceOpenPrContext, collectOpenPrContext, readRemoteManifestViaApi, isPassIdle,
 *   isConfirmSweepSettled, coupleImplOpen, liveOpenHeadRefs) and #3004 (deriveCoupleIncomplete — a half-landed
 *   couple no longer clears a dependent's edge) — all exported from `scripts/merge-ai-prs.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyPr, planLabelDrain, joinImplToCouples, decideBatchesIdleExit, resolveRepos, OPEN_PR_LIST_LIMIT, carrierDeferDecision, buildCarrierHealth, deferralsAllHeldCouple, planDrainPass, resolveContextRepos, reduceOpenPrContext, collectOpenPrContext, isContentsNotFound, readRemoteManifestViaApi, isPassIdle, isConfirmSweepSettled, coupleImplOpen, liveOpenHeadRefs, deriveCoupleIncomplete, reviewCoverageGaps, buildDrainVerdicts } from '../merge-ai-prs.mjs';
import { REVIEW_LABELS } from '../lib/review-escalation.mjs';
import { buildManifest, asItemId } from '../readiness/lane-manifest.mjs';


describe('merge-ai-prs — #xc7p3q9: couple-join decoupled from the ready-to-merge / candidate scope', () => {
  // Sibling of PR #2880/xq985wu (which decoupled merge-ORDERING). This decouples the COUPLE-JOIN gate: a coupled
  // impl half must defer/land off its carrier's HEALTH read from the label/only/repo-BLIND, constellation-wide
  // open-PR context — NOT off the carrier's presence in the `--only`/`--repos`-NARROWED candidate list. Every
  // case drives the REAL runCli sequence through the SHARED `planDrainPass` (narrowPrsByRepo → buildDrainVerdicts
  // (classifyPr + attach) → buildCarrierHealth → joinImplToCouples → planLabelDrain). No hand-built verdicts, no
  // re-typed composition (B12) — a future edit that drops `truncated`/`contextComplete` from the join breaks here.
  const WE = null;                                   // the local WE clone (repo=null, key 'cwd') — runCli's convention
  const FUI = 'frontier-ui/frontierui';
  const localSlug = 'web-everything/web-everything';
  const isLocalRepo = (repo) => repo == null || repo === localSlug;
  const claude = { authors: [{ name: 'Claude Opus 4.8', email: 'noreply@anthropic.com' }] };
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  // a landable AI PR object shaped exactly as `gh pr list --json …` returns it (classifyPr rules it 'merge')
  const ghPr = (number, headRefName, { labels = [] } = {}) =>
    ({ number, title: 't', body: 'what changed and why', headRefName, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', labels });

  // The label/only-BLIND openPrContext (constellation-wide, as collectOpenPrContext produces over CONTEXT_REPOS)
  // holding ONE WE carrier — present here regardless of how the candidate sweep was narrowed. It is built through
  // the SHARED, exported `reduceOpenPrContext` (the ONE place `contextComplete` is computed), so the tests drive
  // the real relationship, never a re-typed formula (R4 — the round-1 hole was a hand-computed `contextComplete`).
  //   - `degradedRead:true`  → the REAL thrown-read shape `{manifest:null, degraded:true}` (readPrManifest threw).
  //   - `degraded:true`      → the commits-only failure (valid manifest + degraded flag) — the harmless half.
  //   - `listingFailed:true` → a swallowed `gh pr list` error (B2): the carrier is ABSENT from the context maps.
  //   - `truncated:true`     → the listing hit the `--limit` cap (the REAL trigger: a padded, over-cap page).
  //   - `extraOpenPrs`       → additional open PRs the blind context shows (e.g. the impl half, for R7).
  const contextWithCarrier = ({ carrierNum = 77, carrierRepo = null, item = 'xcarr01', refs = ['lane/xcarr01-fui', 'lane/xcarr01-we'], labels = ['ready-to-merge'], manifest = null, degraded = false, degradedRead = false, truncated = false, listingFailed = false, extraOpenPrs = [] } = {}) => {
    const m = degradedRead ? null : (manifest ?? { item, repos: refs.map((ref) => ({ repo: ref.endsWith('-we') ? 'we' : 'fui', ref })), blockedBy: [], stackParents: [] });
    const key = `${carrierRepo || 'cwd'}::${carrierNum}`;
    const isDeg = degraded || degradedRead;
    const carrierRef = (m && m.repos.find((r) => r.repo === 'we')?.ref) || refs.find((r) => r.endsWith('-we')) || refs[0];
    // build the per-repo listing + per-PR reads the way collectOpenPrContext does, then REDUCE via the ONE shared
    // fn — so `truncated` is derived from a REAL over-cap page and `contextComplete` from the shared formula.
    const carrierPr = ghPr(carrierNum, carrierRef, { labels });
    const pad = truncated ? Array.from({ length: OPEN_PR_LIST_LIMIT }, (_, i) => ghPr(900000 + i, `lane/pad-${i}`, {})) : [];
    const listings = [{ repo: carrierRepo, prs: listingFailed ? [] : [carrierPr, ...extraOpenPrs, ...pad], ...(listingFailed ? { failed: true } : {}) }];
    const reads = new Map();
    if (!listingFailed) reads.set(key, { manifest: m, commits: [], degraded: isDeg });
    for (const p of extraOpenPrs) reads.set(`${carrierRepo || 'cwd'}::${p.number}`, { manifest: null, commits: [], degraded: false });
    return reduceOpenPrContext({ listings, reads, reconcileRan: true });
  };

  // Faithful reproduction of runCli's post-listing sequence via the SHARED `planDrainPass` — the ONE wiring runCli
  // itself calls (B12). Returns { verdicts, plan } so a test can assert the DISCRIMINATING per-verdict fields
  // (coupleDeferReason / joinedToCouple / coupleCarrier), not just the ready/deferred number arrays.
  const drivePlan = ({ listings, REPOS, onlyPr = null, onlyRepo = null, openPrContext, reads, escalationRelief = { prs: [], passWide: false }, label = 'ready-to-merge' }) =>
    planDrainPass({
      listings,
      openPrContext,
      repos: REPOS,
      onlyPr,
      onlyRepo,
      readOf: (repo, num) => reads.get(`${repo || 'cwd'}::${num}`),
      requiredCheck: 'test',
      escalationRelief,
      label,
      isLocalRepo,
      localSlug,
    });

  // #xc7p3q9 (B7 invariant) — for a plan built from >1-repo manifests, no carrier may be in `ready` while a verdict
  // JOINED to it is in `deferred` (the couple would land WE-first with its impl still open).
  const noWeFirstSplit = ({ verdicts, plan }) => {
    const readyNums = new Set(plan.ready.map((c) => c.num));
    const deferredNums = new Set(plan.deferred.map((d) => d.num));
    return verdicts
      .filter((v) => v.joinedToCouple != null && v.coupleCarrier && deferredNums.has(v.num))
      .every((v) => !readyNums.has(v.coupleCarrier.num));
  };

  // `--only <impl half>` narrows the candidate list to the ONE frontierui PR; the WE carrier is absent from it
  // (stripped / narrowed) but present in the blind context.
  const implOnly = (openPrContext, { implNum = 55, headRef = 'lane/xcarr01-fui' } = {}) => ({
    REPOS: [WE, FUI],
    listings: [{ repo: WE, prs: [] }, { repo: FUI, prs: [ghPr(implNum, headRef)] }],
    reads: new Map([[`${FUI}::${implNum}`, { commits: [claude, claude], manifest: null }]]),
    onlyPr: String(implNum),
    onlyRepo: FUI,
    openPrContext,
  });

  it('carrierDeferDecision — the pure fail-closed table (truncated → absent×completeness → degraded → unnameable → held)', () => {
    expect(carrierDeferDecision({ health: { held: false, nameable: true, degraded: false }, truncated: true })).toEqual({ defer: true, reason: 'truncated', humanTerminal: false });
    // B1/B2/B3 — absence in an INCOMPLETE context is UNKNOWN → fail closed; only a COMPLETE context proves "landed".
    expect(carrierDeferDecision({ health: null, contextComplete: false })).toEqual({ defer: true, reason: 'incomplete-context', humanTerminal: false });
    expect(carrierDeferDecision({ health: null })).toEqual({ defer: true, reason: 'incomplete-context', humanTerminal: false });   // default: not proven complete
    expect(carrierDeferDecision({ health: null, contextComplete: true })).toEqual({ defer: false, reason: 'absent-landed', humanTerminal: false });
    expect(carrierDeferDecision({ health: { held: false, nameable: true, degraded: true }, contextComplete: true })).toEqual({ defer: true, reason: 'degraded', humanTerminal: false });
    expect(carrierDeferDecision({ health: { held: false, nameable: false, degraded: false }, contextComplete: true })).toEqual({ defer: true, reason: 'unnameable', humanTerminal: false });
    expect(carrierDeferDecision({ health: { held: true, nameable: true, degraded: false }, contextComplete: true })).toEqual({ defer: true, reason: 'held', humanTerminal: true });
    expect(carrierDeferDecision({ health: { held: false, nameable: true, degraded: false }, contextComplete: true })).toEqual({ defer: false, reason: 'healthy', humanTerminal: false });
    // #xc7p3q9 (R9) — a HELD carrier with read noise defers on the noisier reason, but `humanTerminal` still flags
    // the hold (it won't clear by polling) so idle accounting treats the couple as settled.
    expect(carrierDeferDecision({ health: { held: true, nameable: true, degraded: true }, contextComplete: true })).toEqual({ defer: true, reason: 'degraded', humanTerminal: true });
    expect(carrierDeferDecision({ health: { held: true, nameable: true, degraded: false }, truncated: true })).toEqual({ defer: true, reason: 'truncated', humanTerminal: true });
  });

  it('AC1 (Fix 1) — `--only <impl>` with a HEALTHY open labelled carrier in a COMPLETE context → impl LANDS', () => {
    const { verdicts, plan } = drivePlan(implOnly(contextWithCarrier({ labels: ['ready-to-merge'] })));
    expect(plan.ready.map((c) => c.num)).toEqual([55]);
    expect(plan.deferred).toEqual([]);
    // B11 — DISCRIMINATING assertion so this fails on a diff-revert (not a baseline-guard): the impl was JOINED to
    // the healthy carrier and cleared by its HEALTH read, not merely treated as an orphan.
    const impl = verdicts.find((v) => v.num === 55);
    expect(impl.joinedToCouple).toBe('xcarr01');
    expect(impl.coupleDeferReason).toBe('healthy');
  });

  it('AC1-mirror (B3) — a FULL sweep with an EMPTY/INCOMPLETE context (RECONCILE false) → the impl DEFERS', () => {
    // The old mirror asserted "empty context → impl ready" — that WAS the B3 fail-open. An incomplete context can
    // never prove the carrier landed, so the coupled impl must fail closed. The carrier is a live candidate here
    // (a full sweep), so the impl joins it and defers; the two-sided defer (B7) holds the carrier back too.
    const emptyCtx = { prsByRepo: new Map(), manifestByPr: new Map(), degradedByPr: new Map(), openItems: new Set(), truncated: false, contextComplete: false };
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const res = drivePlan({
      REPOS: [WE, FUI],
      listings: [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }],
      onlyPr: null,
      onlyRepo: null,
      openPrContext: emptyCtx,
      reads: new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]),
    });
    expect(res.plan.ready).toEqual([]);                                   // neither half lands
    expect(res.plan.deferred.map((d) => d.num).sort((a, b) => a - b)).toEqual([55, 77]);
    expect(res.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('incomplete-context');
    expect(noWeFirstSplit(res)).toBe(true);
  });

  it('AC2 — `--only <impl>` with a HELD carrier → impl DEFERS (the gate still fires when it should)', () => {
    const { plan } = drivePlan(implOnly(contextWithCarrier({ labels: [REVIEW_LABELS.changes] })));
    expect(plan.ready).toEqual([]);
    expect(plan.deferred.map((d) => d.num)).toEqual([55]);
    expect(plan.deferred[0].heldCoupleOnly).toBe(true);
  });

  it('AC3 (Fix 1/2) — `--repos=<implSlug>` scope where WE is NOT a candidate → fail CLOSED past a held carrier', () => {
    // The candidate scope is frontierui ALONE (WE excluded), but the constellation-wide blind context still holds
    // the held WE carrier — so the impl joins it and defers rather than orphan-landing.
    const { plan } = drivePlan({
      REPOS: [FUI],
      listings: [{ repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }],
      onlyPr: null,
      onlyRepo: null,
      openPrContext: contextWithCarrier({ labels: [REVIEW_LABELS.human] }),
      reads: new Map([[`${FUI}::55`, { commits: [claude, claude], manifest: null }]]),
    });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred.map((d) => d.num)).toEqual([55]);
  });

  it('AC4 (B4) — UNNAMEABLE carrier via the REAL NaN→JSON→"item":null→0 round-trip → fail CLOSED', () => {
    // Reproduce the PRODUCTION shape end-to-end: buildManifest stamps `item: NaN`, JSON.stringify prints it as
    // `"item": null`, and the drain RE-READS that off the PR body — so the manifest the gate sees carries
    // `item: null`, which the OLD `isItemId` re-normalized to `0` (nameable:true → healthy → land). The fix reads
    // it unnameable. Driving the full round-trip (not an in-memory NaN) is what the review required.
    const built = buildManifest({ item: undefined, repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }] });
    expect(Number.isNaN(built.item)).toBe(true);
    const m = JSON.parse(JSON.stringify(built));        // the re-read shape the drain actually consumes
    expect(m.item).toBe(null);                          // NaN serialized to null (NOT preserved as NaN)
    // sanity: the health map derives `nameable` from the SAME item expression, and reads this shape unnameable.
    const ctx = contextWithCarrier({ manifest: m, labels: ['ready-to-merge'] });
    expect([...buildCarrierHealth(ctx).values()][0].nameable).toBe(false);
    const { verdicts, plan } = drivePlan(implOnly(ctx));
    expect(plan.ready).toEqual([]);
    expect(plan.deferred.map((d) => d.num)).toEqual([55]);
    expect(verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('unnameable');
    // NOT a held-couple defer (fail-closed on a bad id, not a human hold) → does NOT count as idle.
    expect(plan.deferred[0].heldCoupleOnly).toBeUndefined();
  });

  it('AC5 (Fix 2) — a TRUNCATED listing → fail CLOSED (and NOT idle)', () => {
    const t = drivePlan(implOnly(contextWithCarrier({ labels: ['ready-to-merge'], truncated: true })));
    expect(t.plan.deferred.map((d) => d.num)).toEqual([55]);
    expect(t.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('truncated');
    expect(deferralsAllHeldCouple(t.plan.deferred)).toBe(false);
  });

  it('AC5b (B1) — the REAL degraded read `{manifest:null, degraded:true}` (readPrManifest THREW) → fail CLOSED', () => {
    // The old `buildCarrierHealth` did `if (!manifest || !Array.isArray(manifest.repos)) continue;` — dropping the
    // EXACT shape a thrown read emits BEFORE the `degraded` branch could fire, so the degraded branch was
    // unreachable in the case it exists for. Drive that real shape through a FULL sweep (the carrier is a live
    // candidate so its refs come from the sweep read; only the CONTEXT read threw). Both halves must fail closed.
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const ctx = contextWithCarrier({ carrierNum: 77, degradedRead: true });   // manifestByPr → null + degradedByPr → true
    expect(ctx.manifestByPr.get('cwd::77')).toBe(null);                        // the thrown-read shape (not a valid manifest)
    expect([...buildCarrierHealth(ctx).values()][0]).toMatchObject({ degraded: true, unreadable: true, nameable: false });
    const res = drivePlan({
      REPOS: [WE, FUI],
      listings: [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }],
      onlyPr: null,
      onlyRepo: null,
      openPrContext: ctx,
      reads: new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]),
    });
    expect(res.plan.ready).toEqual([]);
    expect(res.plan.deferred.map((d) => d.num).sort((a, b) => a - b)).toEqual([55, 77]);
    expect(res.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('degraded');
    expect(deferralsAllHeldCouple(res.plan.deferred)).toBe(false);            // an error may clear on re-fetch → keep polling
    expect(noWeFirstSplit(res)).toBe(true);
  });

  it('AC6 (Fix 3) — a pass whose ONLY deferral is a human-held couple counts as IDLE; a fail-closed defer does not', () => {
    const held = drivePlan(implOnly(contextWithCarrier({ labels: [REVIEW_LABELS.human] }))).plan;
    expect(deferralsAllHeldCouple(held.deferred)).toBe(true);   // human hold won't clear by polling → idle
    const trunc = drivePlan(implOnly(contextWithCarrier({ labels: ['ready-to-merge'], truncated: true }))).plan;
    expect(deferralsAllHeldCouple(trunc.deferred)).toBe(false); // may clear on a re-fetch → keep polling
    expect(deferralsAllHeldCouple([])).toBe(false);             // an empty deferred set is not "held-couple idle"
  });

  it('AC6b (B5/R6) — decideBatchesIdleExit SUBTRACTS the held couple\'s members from `considered` (not a wholesale waiver)', () => {
    // The production launcher (drain-push-at-close) runs `--watch --until-batches-idle` with NO `--max-idle`, so it
    // exits via `decideBatchesIdleExit` — where `considered = verdicts.length` counts BOTH held-couple halves. R6:
    // subtract those members rather than waiving the queue-empty check wholesale (which exited with in-flight,
    // still-running-CI candidates in the count).
    const heldDeferred = drivePlan(implOnly(contextWithCarrier({ labels: [REVIEW_LABELS.human] }))).plan.deferred;
    const truncDeferred = drivePlan(implOnly(contextWithCarrier({ labels: ['ready-to-merge'], truncated: true }))).plan.deferred;
    // the whole queue IS the held couple (both members) → EXIT (was blocked forever on `considered>0`).
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 2, deferred: heldDeferred, heldCoupleMembers: 2, batchNonRunningStreak: 2, debounce: 2 })).toBe(true);
    // R6 REGRESSION — in-flight NON-held candidates (running CI) ALONGSIDE the held couple → NO exit (the wholesale
    // waiver wrongly exited here, dropping the in-flight PRs).
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 9, deferred: heldDeferred, heldCoupleMembers: 1, batchNonRunningStreak: 2, debounce: 2 })).toBe(false);
    // a truncated fail-closed defer is NOT a held member (heldCoupleMembers 0) → keep polling.
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 2, deferred: truncDeferred, heldCoupleMembers: 0, batchNonRunningStreak: 2, debounce: 2 })).toBe(false);
    // an empty queue still exits (the pre-existing behaviour is preserved).
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 0, heldCoupleMembers: 0, batchNonRunningStreak: 2, debounce: 2 })).toBe(true);
    // a queue of non-held work (red PRs churning, nothing deferred) still keeps polling.
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 3, heldCoupleMembers: 0, batchNonRunningStreak: 2, debounce: 2 })).toBe(false);
  });

  it('AC7 — no regression: FULL sweep, all couples healthy → same ready/deferred partition as the merge base', () => {
    const item = 'xcarr01';
    const carrierManifest = { item, repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const { verdicts, plan } = drivePlan({
      REPOS: [WE, FUI],
      listings: [
        { repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] },
        { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] },
      ],
      onlyPr: null,
      onlyRepo: null,
      openPrContext: contextWithCarrier({ carrierNum: 77, item, manifest: carrierManifest, labels: ['ready-to-merge'] }),
      reads: new Map([
        [`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }],
        [`${FUI}::55`, { commits: [claude, claude], manifest: null }],
      ]),
    });
    expect(plan.ready.map((c) => c.num).sort((a, b) => a - b)).toEqual([55, 77]);   // carrier + impl both land
    expect(plan.deferred).toEqual([]);
    // B11 — DISCRIMINATING assertion (fails on a diff-revert): the impl actually JOINED the couple and cleared on
    // its carrier's HEALTH, rather than passing merely because it read as an unjoined orphan.
    const impl = verdicts.find((v) => v.num === 55);
    expect(impl.joinedToCouple).toBe('xcarr01');
    expect(impl.coupleDeferReason).toBe('healthy');
  });

  it('B2 — a SWALLOWED `gh pr list` failure (carrier ABSENT from an incomplete context) → fail CLOSED, not orphan-land', () => {
    // `collectOpenPrContext`'s `catch { return [repo, [], true] }` now marks the context INCOMPLETE. The carrier is
    // a live candidate in the SWEEP (so the impl joins it), but ABSENT from the CONTEXT maps (its listing threw).
    // Absence in an incomplete context is UNKNOWN → defer. Contrast: the SAME absence in a COMPLETE context is a
    // real land → the impl proceeds.
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const listings = [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }];
    const reads = new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]);
    const failed = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: contextWithCarrier({ listingFailed: true }) });
    expect(failed.plan.ready).toEqual([]);
    expect(failed.plan.deferred.map((d) => d.num).sort((a, b) => a - b)).toEqual([55, 77]);
    expect(failed.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('incomplete-context');
    // the discriminating contrast: the SAME sweep with a COMPLETE context (listing succeeded, carrier present +
    // healthy) → the impl reads its carrier's real HEALTH and lands (it is the FAILED-listing flag, not the
    // absence itself, that fails the case closed).
    const complete = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifest, labels: ['ready-to-merge'] }) });
    expect(complete.plan.ready.map((c) => c.num).sort((a, b) => a - b)).toEqual([55, 77]);
    expect(complete.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('healthy');
  });

  it('B6 — the couple gate\'s `held` agrees with classifyPr\'s under the `--no-review-escalation` waiver', () => {
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const listings = [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge', REVIEW_LABELS.pending] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }];
    const reads = new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]);
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifest, labels: ['ready-to-merge', REVIEW_LABELS.pending] });
    // WITHOUT the waiver: the carrier is review:pending → classifyPr skips it AND the gate reads it held → impl defers.
    const noWaiver = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: ctx });
    expect(noWaiver.plan.ready).toEqual([]);
    expect(noWaiver.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('held');
    // WITH the pass-wide waiver + a label: classifyPr lands the carrier AND the gate must read it NOT held (else the
    // couple lands WE-first — the B6 inversion). Both halves land; the two `held` notions agree.
    const waiver = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: ctx, escalationRelief: { prs: [], passWide: true }, label: 'ready-to-merge' });
    expect(waiver.plan.ready.map((c) => c.num).sort((a, b) => a - b)).toEqual([55, 77]);
    expect(waiver.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('healthy');
  });

  // #3308 (round-2 correctness fix) — THE REGRESSION TEST THE ROUND-1 REVIEW OWED, and it is deliberately
  // DRIVEN, not hand-stamped. Every other `reliefWaived` assertion in this file sets the flag by hand and so
  // could not see the actual bug: `v.reliefWaived` is written ONLY inside the escalation loop, which
  // `REVIEW_ESCALATION = label && !escalationRelief.passWide` switches OFF for the bare/pass-wide form of
  // `--no-review-escalation` — so a PR merged past its review hold by that form reached the coverage reader
  // with NO relief flag set at all and was announced as if nothing had been waived. These cases drive the same
  // `drivePlan` (→ `planDrainPass` → `buildDrainVerdicts` → `classifyPr`) harness B6 uses, so the flag is
  // DERIVED from the real wiring; hand-setting it could not have reddened.
  it('B6b — the PASS-WIDE waiver is recorded on the verdict it waived (#3308), not only the scoped one', () => {
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const listings = [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge', REVIEW_LABELS.pending] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }];
    const reads = new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]);
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifest, labels: ['ready-to-merge', REVIEW_LABELS.pending] });
    const waiver = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: ctx, escalationRelief: { prs: [], passWide: true }, label: 'ready-to-merge' });
    const carrier = waiver.verdicts.find((v) => v.num === 77);
    expect(carrier.decision).toBe('merge');           // it really does land past its review:pending hold
    expect(carrier.reliefPassWide).toBe(true);        // ...and the verdict now says a waiver is why
    // and the coverage reader, fed from THAT verdict exactly as the land path feeds it, announces the gap.
    const gaps = reviewCoverageGaps({ comments: [], headSha: null, reliefWaived: carrier.reliefWaived === true, reliefPassWide: carrier.reliefPassWide === true });
    expect(gaps.map((g) => g.code)).toContain('relief-waived-pass-wide');
  });

  // The other side of the same wiring: a SCOPED `=<pr#>` run must NOT be tagged pass-wide, or every scoped
  // relief would be announced as "the rubric was off for the whole pass" — a strictly false statement.
  it('B6c — a SCOPED --no-review-escalation=<pr#> is NOT recorded as a pass-wide waiver (#3308)', () => {
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const listings = [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge', REVIEW_LABELS.pending] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }];
    const reads = new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]);
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifest, labels: ['ready-to-merge', REVIEW_LABELS.pending] });
    const scoped = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: ctx, escalationRelief: { prs: [77], passWide: false }, label: 'ready-to-merge' });
    const carrier = scoped.verdicts.find((v) => v.num === 77);
    expect(carrier.decision).toBe('merge');
    expect(carrier.reliefPassWide).toBeUndefined();
  });

  // A bare `--no-review-escalation` with NO `--label` waived nothing: `REVIEW_ESCALATION = label && ...` is
  // already falsy on the missing label, so the rubric was never going to run and the flag changed no outcome.
  // Announcing a waiver there would be this item's own error pointed the other way — a false record.
  it('B6d — a pass-wide flag with NO --label records no waiver, because none happened (#3308)', () => {
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const listings = [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }];
    const reads = new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]);
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifest, labels: ['ready-to-merge'] });
    const unlabelled = drivePlan({ REPOS: [WE, FUI], listings, onlyPr: null, onlyRepo: null, reads, openPrContext: ctx, escalationRelief: { prs: [], passWide: true }, label: null });
    expect(unlabelled.verdicts.find((v) => v.num === 77).reliefPassWide).toBeUndefined();
  });

  it('B7 — a healthy carrier whose impl fails closed (truncated) DEFERS BOTH halves (never lands WE-first)', () => {
    const carrierManifest = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };
    const res = drivePlan({
      REPOS: [WE, FUI],
      listings: [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] }, { repo: FUI, prs: [ghPr(55, 'lane/xcarr01-fui')] }],
      onlyPr: null,
      onlyRepo: null,
      openPrContext: contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifest, labels: ['ready-to-merge'], truncated: true }),
      reads: new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifest }], [`${FUI}::55`, { commits: [claude, claude], manifest: null }]]),
    });
    // the carrier is HEALTHY (green, labelled, not held) — without the two-sided defer it would land alone.
    expect(res.plan.ready).toEqual([]);
    expect(res.plan.deferred.map((d) => d.num).sort((a, b) => a - b)).toEqual([55, 77]);
    expect(noWeFirstSplit(res)).toBe(true);
  });

  it('B8 — resolveContextRepos never holds BOTH `null` and the local slug (no double-listing of the local repo)', () => {
    const hasBoth = (arr) => arr.includes(null) && arr.includes(localSlug);
    // `--this-repo` (REPOS=[null]) + the constellation self-slug: the local repo must appear ONCE (as null).
    expect(hasBoth(resolveContextRepos([null], localSlug))).toBe(false);
    // the default full constellation (REPOS carries the self slug): once, as the slug.
    expect(hasBoth(resolveContextRepos([localSlug, FUI, 'plateauapp/plateau-app'], localSlug))).toBe(false);
    // `--repos=<implSlug>` (WE narrowed out): the constellation still adds WE once, never doubled.
    expect(hasBoth(resolveContextRepos([FUI], localSlug))).toBe(false);
    // and the widened context DOES still include the frontierui + plateau-app carriers for the blind health read.
    expect(resolveContextRepos([null], localSlug)).toEqual(expect.arrayContaining([FUI, 'plateauapp/plateau-app']));
    // R10 — a short-name `--repos=frontierui` normalizes to `frontier-ui/frontierui`, so the context never holds a
    // bogus short-name whose listing throws (which pre-R3 latched contextComplete:false permanently).
    expect(resolveRepos({ repos: 'frontierui', self: localSlug })).toEqual([FUI]);
    expect(resolveRepos({ repos: 'frontierui,plateauapp/plateau-app', self: localSlug })).toEqual([FUI, 'plateauapp/plateau-app']);
  });

  const carrierManifestFull = { item: 'xcarr01', repos: [{ repo: 'we', ref: 'lane/xcarr01-we' }, { repo: 'fui', ref: 'lane/xcarr01-fui' }], blockedBy: [], stackParents: [] };

  it('R4 structural — reduceOpenPrContext is the ONE place contextComplete is computed (binds mutations 2/3/4)', () => {
    const carrierPr = ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] });
    const okReads = new Map([['cwd::77', { manifest: carrierManifestFull, commits: [1], degraded: false }]]);
    // healthy + reconcile ran + no failure/truncation/degrade → COMPLETE
    expect(reduceOpenPrContext({ listings: [{ repo: null, prs: [carrierPr] }], reads: okReads, reconcileRan: true }).contextComplete).toBe(true);
    // mutation 3 — reconcile never ran (a bare /merge sweep / --no-reconcile-labels) → INCOMPLETE by construction
    expect(reduceOpenPrContext({ listings: [{ repo: null, prs: [carrierPr] }], reads: okReads, reconcileRan: false }).contextComplete).toBe(false);
    // mutation 2 — a swallowed `gh pr list` (failed) → INCOMPLETE
    expect(reduceOpenPrContext({ listings: [{ repo: null, prs: [], failed: true }], reads: new Map(), reconcileRan: true }).contextComplete).toBe(false);
    // mutation 4 — a degraded per-PR read → INCOMPLETE, and degradedByPr records the truth
    const deg = reduceOpenPrContext({ listings: [{ repo: null, prs: [carrierPr] }], reads: new Map([['cwd::77', { manifest: carrierManifestFull, commits: [1], degraded: true }]]), reconcileRan: true });
    expect(deg.contextComplete).toBe(false);
    expect(deg.degradedByPr.get('cwd::77')).toBe(true);
  });

  it('R4 structural — collectOpenPrContext (injectable) fails a THROWING listing CLOSED (binds the swallowed-listing catch)', async () => {
    const good = await collectOpenPrContext({ contextRepos: [null, FUI], listOpenPrs: async () => [], fetchReads: async () => new Map() });
    expect(good.contextComplete).toBe(true);
    const failed = await collectOpenPrContext({
      contextRepos: [null, FUI],
      listOpenPrs: async (repo) => { if (repo === FUI) throw new Error('gh: server error (HTTP 500)'); return []; },
      fetchReads: async () => new Map(),
    });
    expect(failed.contextComplete).toBe(false);   // a swallowed throw → INCOMPLETE (fail closed)
  });

  it('R3 — isContentsNotFound: a 404 is definitive-absent (degraded:false); other throws degrade', () => {
    expect(isContentsNotFound({ stderr: 'gh: Not Found (HTTP 404)' })).toBe(true);
    expect(isContentsNotFound({ message: 'HTTP 404' })).toBe(true);
    expect(isContentsNotFound({ stderr: 'HTTP 500 Internal Server Error' })).toBe(false);
    expect(isContentsNotFound({ stderr: 'could not connect to github.com' })).toBe(false);
    expect(isContentsNotFound(null)).toBe(false);
  });

  it('R3 — readRemoteManifestViaApi error taxonomy: 404 → degraded:false; 5xx → degraded:true (stubbed exec)', async () => {
    const throwing = (err) => async () => { throw err; };
    const notFound = await readRemoteManifestViaApi({ exec: throwing(Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' })), repo: FUI, headRef: 'lane/x-fui', apiArgs: () => [] });
    expect(notFound).toEqual({ manifest: null, degraded: false });   // confirmed absent — NOT degraded (R3 root fix)
    const serverErr = await readRemoteManifestViaApi({ exec: throwing(Object.assign(new Error('x'), { stderr: 'HTTP 502 Bad Gateway' })), repo: FUI, headRef: 'lane/x-fui', apiArgs: () => [] });
    expect(serverErr).toEqual({ manifest: null, degraded: true });   // transport failure — fail closed
    // a realistic constellation (WE carrier + a manifest-less impl half whose contents 404s) is NOT degraded → COMPLETE
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifestFull, extraOpenPrs: [ghPr(55, 'lane/xcarr01-fui')] });
    expect(ctx.contextComplete).toBe(true);   // a flag whose production value is a constant is not a gate
  });

  it('R1 — the PLAN-WIDE invariant: an UN-joined manifest-less non-WE verdict in an INCOMPLETE context DEFERS', () => {
    // The un-joined orphan the per-carrier gate structurally misses (no carrier readable → no couple key to join).
    const orphanImpl = { num: 55, repo: FUI, headRef: 'lane/x-fui', hasManifest: false, item: null, blockedBy: [], stackParents: [], decision: 'merge' };
    const inc = planLabelDrain([orphanImpl], { contextComplete: false, isWeRepo: isLocalRepo });
    expect(inc.ready).toEqual([]);                                   // fail closed — MIGHT be a coupled impl
    expect(inc.deferred.map((d) => d.num)).toEqual([55]);
    const comp = planLabelDrain([orphanImpl], { contextComplete: true, isWeRepo: isLocalRepo });
    expect(comp.ready.map((c) => c.num)).toEqual([55]);             // a COMPLETE context proves absence → lands
    // a WE-repo orphan is NOT force-deferred (only non-WE manifest-less verdicts might be a coupled impl half)
    const weOrphan = { num: 7, repo: WE, headRef: 'lane/x-we', hasManifest: false, item: null, blockedBy: [], stackParents: [], decision: 'merge' };
    expect(planLabelDrain([weOrphan], { contextComplete: false, isWeRepo: isLocalRepo }).ready.map((c) => c.num)).toEqual([7]);
  });

  it('R2 — a verdict never waitOn its OWN item (no self-referential livelock)', () => {
    const selfBlock = { num: 9, repo: WE, item: 2200, blockedBy: [2200], stackParents: [], decision: 'merge', hasManifest: true };
    // the self-edge is stripped — WITHOUT the strip this defers forever (structurally unsatisfiable, the livelock)
    expect(planLabelDrain([selfBlock]).ready.map((c) => c.num)).toEqual([9]);
    expect(planLabelDrain([selfBlock]).deferred).toEqual([]);
  });

  it('R2 — the --assume-complete-context escape hatch (forcing contextComplete) lands a couple stuck on an incomplete context', () => {
    const ctx = contextWithCarrier({ listingFailed: true });   // carrier ABSENT from an incomplete context
    const stuck = drivePlan(implOnly(ctx));
    expect(stuck.plan.ready).toEqual([]);                       // normally fails closed (livelock territory)
    const forced = drivePlan(implOnly({ ...ctx, contextComplete: true }));   // what --assume-complete-context does
    expect(forced.plan.ready.map((c) => c.num)).toEqual([55]);  // absent-landed → the impl lands
  });

  it('R5 — the couple gate reads the carrier\'s FINAL decision (candidateHeldByKey), not the pre-escalation label', () => {
    const refs = ['lane/xcarr01-we', 'lane/xcarr01-fui'];
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifestFull, labels: ['ready-to-merge'] });
    const mkVerdicts = () => ([
      { num: 55, repo: FUI, headRef: 'lane/xcarr01-fui', hasManifest: false, item: null, blockedBy: [], stackParents: [], decision: 'merge', prLabels: [] },
      { num: 77, repo: WE, headRef: 'lane/xcarr01-we', hasManifest: true, item: 'xcarr01', manifestRefs: refs, blockedBy: [], stackParents: [], decision: 'skip', prLabels: ['ready-to-merge'] },
    ]);
    // the carrier's LABELS read healthy (only ready-to-merge), but the escalation pass PARKED it → decision skip.
    const held = new Map([['cwd::77', true], [`${FUI}::55`, false]]);
    const withHeld = planDrainPass({ verdicts: mkVerdicts(), openPrContext: ctx, candidateHeldByKey: held, isLocalRepo, localSlug, label: 'ready-to-merge' });
    expect(withHeld.plan.ready).toEqual([]);                                              // impl defers with its PARKED carrier
    expect(withHeld.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('held');
    // WITHOUT the final-decision override, the label read (healthy) would let the impl land while the carrier sits parked (the R5 bug).
    const noOverride = planDrainPass({ verdicts: mkVerdicts(), openPrContext: ctx, isLocalRepo, localSlug, label: 'ready-to-merge' });
    expect(noOverride.verdicts.find((v) => v.num === 55).coupleDeferReason).toBe('healthy');
  });

  it('R7 — a carrier must not enter ready while its impl half is OPEN in the blind context (carrier-only narrow)', () => {
    const implPr = ghPr(55, 'lane/xcarr01-fui');
    const ctx = contextWithCarrier({ carrierNum: 77, item: 'xcarr01', manifest: carrierManifestFull, labels: ['ready-to-merge'], extraOpenPrs: [implPr] });
    const res = drivePlan({
      REPOS: [WE, FUI],
      listings: [{ repo: WE, prs: [ghPr(77, 'lane/xcarr01-we', { labels: ['ready-to-merge'] })] }, { repo: FUI, prs: [] }],
      onlyPr: '77', onlyRepo: WE,
      openPrContext: ctx,
      reads: new Map([[`cwd::77`, { commits: [claude, claude], manifest: carrierManifestFull }]]),
    });
    expect(res.plan.ready).toEqual([]);                                                  // carrier defers — impl still open
    expect(res.verdicts.find((v) => v.num === 77).coupleDeferReason).toBe('impl-open');
  });

  it('R4 structural — isPassIdle / isConfirmSweepSettled: the held-couple allowance both watch-exit paths consult (binds mutations 5/6)', () => {
    const held = [{ num: 55, heldCoupleOnly: true }];
    const real = [{ num: 55, waitOn: ['x'] }];   // a truncated/degraded fail-closed defer — may clear on re-fetch
    expect(isPassIdle({ merged: 0, pendingRebased: 0, deferred: held })).toBe(true);    // human hold → idle
    expect(isPassIdle({ merged: 0, pendingRebased: 0, deferred: real })).toBe(false);   // real defer → keep polling
    expect(isPassIdle({ merged: 1, pendingRebased: 0, deferred: [] })).toBe(false);     // merged → not idle
    expect(isPassIdle({ merged: 0, pendingRebased: 0, deferred: [] })).toBe(true);      // nothing → idle
    expect(isConfirmSweepSettled({ merged: 0, pendingRebased: 0, considered: 2, deferred: held })).toBe(true);
    expect(isConfirmSweepSettled({ merged: 0, pendingRebased: 0, considered: 2, deferred: real })).toBe(false);
    expect(isConfirmSweepSettled({ merged: 0, pendingRebased: 0, considered: 0, deferred: [] })).toBe(true);
  });
});

// #3004 — `blockWait` could clear a dependent's edge on a blocker whose WE carrier landed while its impl half was
// still OPEN. `landedThisPass` is stamped on the WE-CARRIER merge, but a couple is impl-first/WE-last ACROSS repos,
// so that set proves only half a couple. The fix adds NEGATIVE counter-evidence (`coupleIncomplete`) subtracted from
// BOTH `provenLanded` and `stackProven`'s proof (1), derived IN THE CASCADE against refs that ACTUALLY merged.
//
// The load-bearing tests in here are the last three: the DISJOINTNESS/REACHABILITY case (which proves a plan-time
// derivation would be inert, so this fix is not decorative), the REAL-WINDOW case (the impl's merge throws), and the
// MERGED-SIBLING no-regression case (which pins the `\ mergedRefs` subtraction).
describe('merge-ai-prs — #3004 coupleIncomplete: a half-landed couple no longer clears a dependent\'s edge', () => {
  const WE = null;                                    // the local WE clone (repo=null, key 'cwd') — runCli's convention
  const FUI = 'frontier-ui/frontierui';
  const localSlug = 'web-everything/web-everything';
  const isLocalRepo = (repo) => repo == null || repo === localSlug;
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  const ghPr = (number, headRefName, labels = []) =>
    ({ number, title: 't', body: 'what changed and why', headRefName, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', labels });

  // ── the couple under test ──────────────────────────────────────────────────────────────────────────────────
  // item 100 is a cross-repo couple: impl #55 (frontierui, manifest-less, joined) + WE carrier #77 (the resolve
  // carrier, where `bornAs` — and therefore `landedThisPass` — is stamped). item 101 (#88) is `blockedBy: [100]`.
  const REFS_A = ['lane/a-fui', 'lane/a-we'];
  const mkVerdicts = ({ implDecision = 'merge' } = {}) => ([
    { num: 55, repo: FUI, headRef: 'lane/a-fui', hasManifest: false, item: 100, blockedBy: [], stackParents: [], decision: implDecision },
    { num: 77, repo: WE, headRef: 'lane/a-we', hasManifest: true, manifestRefs: REFS_A, item: 100, blockedBy: [], stackParents: [], decision: 'merge' },
    { num: 88, repo: WE, headRef: 'lane/b-we', hasManifest: true, manifestRefs: ['lane/b-we'], item: 101, blockedBy: [100], stackParents: [], decision: 'merge' },
  ]);
  // the PASS-START open-PR snapshot (`openPrContext.prsByRepo`) — frozen before any merge, exactly as the real pass
  // holds it. All three PRs are open here; the cascade's job is to subtract what it actually merged.
  const mkPrsByRepo = () => new Map([
    [WE, [ghPr(77, 'lane/a-we'), ghPr(88, 'lane/b-we')]],
    [FUI, [ghPr(55, 'lane/a-fui')]],
  ]);
  const extraOpenItems = new Set([100, 101]);

  // A FAITHFUL MINI of runCli's cascade loop (scripts/merge-ai-prs.mjs, the `for (;;)` at the `replan` call site):
  // same `remaining` copy, same `sameCand` bookkeeping, same per-iteration re-derivation, same `landedThisPass`
  // stamp keyed on `hasManifest`, same failed-merge `decision = 'skip'` flip, same `!progressed` break. The ONLY
  // stubbed thing is the `gh pr merge` write itself — every plan/derivation call below is the REAL production
  // function. `deriveCoupleIncomplete: false` reproduces TODAY's code (no counter-evidence reaches `replan`).
  const runCascade = ({ verdicts, prsByRepo, failRefs = new Set(), deriveIncomplete = true }) => {
    const landedThisPass = new Set();
    const merged = [];
    const sameCand = (a, b) => a.num === b.num && a.repo === b.repo;
    let remaining = verdicts.map((v) => ({ ...v }));
    const replan = (cands, coupleIncomplete = new Set()) => planLabelDrain(cands, { landedThisPass, coupleIncomplete, extraOpenItems });
    const seenIncomplete = [];
    let deferred = [];
    for (let guard = 0; guard < 20; guard++) {
      const coupleIncomplete = deriveIncomplete ? deriveCoupleIncomplete({ verdicts, merged, prsByRepo }) : new Set();
      seenIncomplete.push(new Set(coupleIncomplete));
      const plan = replan(remaining, coupleIncomplete);
      deferred = plan.deferred;
      if (!plan.ready.length) break;
      let progressed = false;
      for (const c of plan.ready) {
        if (failRefs.has(c.headRef)) {                                   // the `gh pr merge` THROW
          const cc = remaining.find((x) => sameCand(x, c)); if (cc) cc.decision = 'skip';
          continue;
        }
        merged.push({ num: c.num, repo: c.repo });
        remaining = remaining.filter((x) => !sameCand(x, c));
        if (c.hasManifest && c.item != null) landedThisPass.add(asItemId(c.item));
        progressed = true;
      }
      if (!progressed) break;
    }
    return { merged: merged.map((m) => m.num), deferred, landedThisPass, seenIncomplete };
  };

  // ── 1. the reproduction from the card, both directions ─────────────────────────────────────────────────────
  const repro = (proof) => planLabelDrain(
    [{ num: 20, item: 100, decision: 'skip', hasManifest: true },
      { num: 30, item: 101, blockedBy: [100], decision: 'merge', hasManifest: true }],
    proof);

  it('the reproduction UNCHANGED still yields ready [30] — the default is a pure no-op on #999\'s liveness fix', () => {
    const plan = repro({ landedThisPass: new Set([100]) });
    expect(plan.ready.map((c) => c.num)).toEqual([30]);
    expect(plan.deferred).toEqual([]);
  });

  it('the reproduction WITH coupleIncomplete yields deferred [30] waiting on item 100', () => {
    const plan = repro({ landedThisPass: new Set([100]), coupleIncomplete: new Set([100]) });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred).toEqual([{ num: 30, item: 101, waitOn: [100], headSha: null }]);
  });

  // ── 2. the SIBLING predicate — stackProven proof (1) makes the same subtraction ─────────────────────────────
  const stackCand = (num, item, stackParents) => ({ num, item, blockedBy: [], stackParents, decision: 'merge' });

  it('stackProven: a stackParent in BOTH landedThisPass and coupleIncomplete is NOT proven → descendant defers', () => {
    const proven = planLabelDrain([stackCand(30, 101, [100])], { landedThisPass: new Set([100]) });
    expect(proven.ready.map((c) => c.num)).toEqual([30]);                 // control: proof (1) alone frees it
    const withCounter = planLabelDrain([stackCand(30, 101, [100])], { landedThisPass: new Set([100]), coupleIncomplete: new Set([100]) });
    expect(withCounter.ready).toEqual([]);
    expect(withCounter.deferred).toEqual([{ num: 30, item: 101, waitOn: [100], headSha: null }]);
  });

  it('stackProven: the subtraction SHORT-CIRCUITS — a weaker later arm cannot undo the counter-evidence', () => {
    // proof (3) `provenOnMain` and proof (4) `numeric-and-absent` both read "landed" for item 100. Neither may
    // resurrect a couple the cascade has positively shown to be half-landed.
    const plan = planLabelDrain([stackCand(30, 101, [100])], {
      landedThisPass: new Set([100]), provenOnMain: new Set([100]), coupleIncomplete: new Set([100]),
    });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred.map((d) => d.waitOn)).toEqual([[100]]);
  });

  it('provenLanded: the subtraction applies to the provenOnMain arm too (counter-evidence beats positive proof)', () => {
    const plan = planLabelDrain([{ num: 30, item: 101, blockedBy: [100], decision: 'merge' }], {
      provenOnMain: new Set([100]), extraOpenItems: new Set([100, 101]), coupleIncomplete: new Set([100]),
    });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred).toEqual([{ num: 30, item: 101, waitOn: [100], headSha: null }]);
  });

  it('an empty coupleIncomplete leaves #999 F1/F2 byte-identical (explicit no-op control)', () => {
    const bare = planLabelDrain([{ num: 2, item: 200, blockedBy: [100], decision: 'merge' }], { landedThisPass: new Set([100]), extraOpenItems: new Set([100, 200]) });
    const seeded = planLabelDrain([{ num: 2, item: 200, blockedBy: [100], decision: 'merge' }], { landedThisPass: new Set([100]), extraOpenItems: new Set([100, 200]), coupleIncomplete: new Set() });
    expect(seeded).toEqual(bare);
    expect(seeded.ready.map((c) => c.num)).toEqual([2]);
  });

  // ── 3. ONE exported predicate — neither call site may re-inline its own copy ────────────────────────────────
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');

  it('single-source: coupleImplOpen is the ONLY couple-completeness test — joinImplToCouples does not re-inline it', () => {
    // definition + the joinImplToCouples call site + the deriveCoupleIncomplete call site (docblock @link
    // references are excluded by requiring the call parenthesis).
    const calls = SRC.match(/coupleImplOpen\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // the retired inline loop's own identifiers — a re-inline reintroduces one of these
    expect(SRC).not.toContain('const implOpenNotLanding');
    expect(SRC).not.toContain('openRefs.has(ref)');
    // and the shared open-ref construction is single-sourced too (definition + cascade + resolve-on-land gate)
    expect((SRC.match(/liveOpenHeadRefs\(/g) || []).length).toBeGreaterThanOrEqual(3);
    // the pass-start-minus-merged subtraction exists EXACTLY once — in `liveOpenHeadRefs` itself. A second
    // occurrence means a call site re-inlined it (the drift that produced #3004).
    expect((SRC.match(/!mergedRefs\.has\(p\.headRefName\)/g) || []).length).toBe(1);
  });

  it('single-source, behavioural: joinImplToCouples stamps impl-open EXACTLY when coupleImplOpen says so', () => {
    const openHeadRefs = new Set(['lane/a-fui', 'lane/a-we']);
    const both = (implDecision) => {
      const vs = mkVerdicts({ implDecision });
      joinImplToCouples(vs, { contextComplete: true, openHeadRefs });
      const carrier = vs.find((v) => v.num === 77);
      const readyImplRefs = new Set(vs.filter((v) => v && !v.hasManifest && v.decision === 'merge' && v.coupleDefer !== true).map((v) => v.headRef).filter(Boolean));
      return { stamped: carrier.coupleDeferReason === 'impl-open', predicate: coupleImplOpen(carrier, { openHeadRefs, landingRefs: readyImplRefs }) };
    };
    const landing = both('merge');                 // impl planned to merge → the couple reads whole
    expect(landing.stamped).toBe(false);
    expect(landing.predicate).toBe(false);
    const notLanding = both('skip');               // impl red/held → the couple is NOT whole
    expect(notLanding.stamped).toBe(true);
    expect(notLanding.predicate).toBe(true);
  });

  it('coupleImplOpen: a manifest-less verdict is never a carrier, and a carrier never blocks on its OWN ref', () => {
    expect(coupleImplOpen({ hasManifest: false, headRef: 'lane/a-fui', manifestRefs: REFS_A }, { openHeadRefs: new Set(REFS_A) })).toBe(false);
    expect(coupleImplOpen({ hasManifest: true, headRef: 'lane/a-we', manifestRefs: ['lane/a-we'] }, { openHeadRefs: new Set(['lane/a-we']) })).toBe(false);
    expect(coupleImplOpen({ hasManifest: true, headRef: 'lane/a-we', manifestRefs: REFS_A }, { openHeadRefs: new Set(REFS_A) })).toBe(true);
    expect(coupleImplOpen({ hasManifest: true, headRef: 'lane/a-we', manifestRefs: REFS_A }, { openHeadRefs: new Set(REFS_A), landingRefs: new Set(['lane/a-fui']) })).toBe(false);
  });

  // ── 4. THE REACHABILITY / DISJOINTNESS TEST ────────────────────────────────────────────────────────────────
  // This is the one that proves the fix is not decorative. A `coupleIncomplete` derived at PLAN time, from the SAME
  // helper and the SAME plan-time inputs as the R7 `impl-open` gate, is DISJOINT from anything that can reach
  // `landedThisPass`: every carrier the helper flags is already `coupleDefer:'impl-open'`, therefore absent from
  // `plan.ready`, therefore never merged, therefore never in `landedThisPass`. Subtracting it could not change one
  // answer. A future refactor that moves the derivation back to plan time fails HERE instead of going quietly inert.
  describe('reachability — a PLAN-TIME derivation is provably inert (do not move it back)', () => {
    const manifestFor = (item, refs) => ({ item, repos: refs.map((ref) => ({ repo: ref.endsWith('-we') ? 'we' : 'fui', ref })), blockedBy: [], stackParents: [] });
    const ctxFor = () => reduceOpenPrContext({
      listings: [
        { repo: WE, prs: [ghPr(77, 'lane/a-we', ['ready-to-merge']), ghPr(88, 'lane/b-we', ['ready-to-merge'])] },
        { repo: FUI, prs: [ghPr(55, 'lane/a-fui')] },
      ],
      reads: new Map([
        ['cwd::77', { manifest: manifestFor(100, REFS_A), commits: [], degraded: false }],
        ['cwd::88', { manifest: manifestFor(101, ['lane/b-we']), commits: [], degraded: false }],
        [`${FUI}::55`, { manifest: null, commits: [], degraded: false }],
      ]),
      reconcileRan: true,
    });

    // the plan-time inputs, rebuilt exactly as planDrainPass / joinImplToCouples build them
    const planTimeFlagged = (ctx, verdicts) => {
      const openHeadRefs = new Set();
      for (const prs of ctx.prsByRepo.values()) for (const p of prs) if (p && p.headRefName) openHeadRefs.add(p.headRefName);
      const readyImplRefs = new Set(verdicts.filter((v) => v && !v.hasManifest && v.decision === 'merge' && v.coupleDefer !== true).map((v) => v.headRef).filter(Boolean));
      return new Set(verdicts.filter((v) => v && v.hasManifest && v.item != null && coupleImplOpen(v, { openHeadRefs, landingRefs: readyImplRefs })).map((v) => asItemId(v.item)));
    };

    it('every carrier a plan-time coupleIncomplete would flag is ALREADY impl-open-deferred and absent from plan.ready', () => {
      let sawNonEmpty = false;
      for (const implDecision of ['merge', 'skip']) {                    // both shapes, so the assertion is not vacuous
        const ctx = ctxFor();
        const res = planDrainPass({ verdicts: mkVerdicts({ implDecision }), openPrContext: ctx, isLocalRepo, localSlug, label: 'ready-to-merge' });
        const flagged = planTimeFlagged(ctx, res.verdicts);
        if (flagged.size) sawNonEmpty = true;
        for (const v of res.verdicts) {
          if (!flagged.has(v.item == null ? null : asItemId(v.item)) || !v.hasManifest) continue;
          expect(v.coupleDeferReason).toBe('impl-open');                 // the R7 gate already caught it
        }
        // DISJOINTNESS: nothing flagged can reach `ready` → can never reach `landedThisPass` → nothing to subtract
        const readyItems = new Set(res.plan.ready.map((c) => (c.item == null ? null : asItemId(c.item))));
        for (const id of flagged) expect(readyItems.has(id)).toBe(false);
      }
      expect(sawNonEmpty).toBe(true);                                    // the `skip` shape really does flag one
    });

    it('and the CASCADE derivation is NOT disjoint — it flags an item that DID reach landedThisPass', () => {
      // Same pass, `implDecision: 'merge'` (the R7 gate clears the carrier, plan-time flagged set is EMPTY), but the
      // impl's merge then throws. This is the exact gap a plan-time set structurally cannot see.
      const ctx = ctxFor();
      const verdicts = mkVerdicts({ implDecision: 'merge' });
      planDrainPass({ verdicts, openPrContext: ctx, isLocalRepo, localSlug, label: 'ready-to-merge' });
      expect(planTimeFlagged(ctx, verdicts).size).toBe(0);               // plan time sees NOTHING
      const run = runCascade({ verdicts: mkVerdicts({ implDecision: 'merge' }), prsByRepo: mkPrsByRepo(), failRefs: new Set(['lane/a-fui']) });
      expect(run.landedThisPass.has(100)).toBe(true);                    // the carrier landed anyway
      expect([...run.seenIncomplete.at(-1)]).toContain(100);             // and the cascade DID flag it
    });
  });

  // ── 5. THE REAL-WINDOW TEST — the impl's `gh pr merge` throws mid-cascade ───────────────────────────────────
  it('real window: the impl merge THROWS, the carrier lands anyway, and the dependent DEFERS on the next replan', () => {
    const run = runCascade({ verdicts: mkVerdicts(), prsByRepo: mkPrsByRepo(), failRefs: new Set(['lane/a-fui']) });
    expect(run.merged).toEqual([77]);                                    // only the WE carrier landed
    expect(run.landedThisPass.has(100)).toBe(true);                      // …and it stamped item 100 as landed
    expect(run.deferred).toEqual([{ num: 88, item: 101, waitOn: [100], headSha: null }]);  // the dependent held back
  });

  it('real window CONTROL: on today\'s wiring (no re-derived set reaching replan) the dependent wrongly LANDS', () => {
    const run = runCascade({ verdicts: mkVerdicts(), prsByRepo: mkPrsByRepo(), failRefs: new Set(['lane/a-fui']), deriveIncomplete: false });
    expect(run.merged).toEqual([77, 88]);                                // #88 merged past a half-landed blocker
    expect(run.deferred).toEqual([]);
  });

  // ── 6. THE MERGED-SIBLING NO-REGRESSION TEST — pins the `\ mergedRefs` subtraction ──────────────────────────
  it('merged sibling: an ordinary impl-first/WE-last couple stays whole — its dependent still lands the same pass', () => {
    const run = runCascade({ verdicts: mkVerdicts(), prsByRepo: mkPrsByRepo() });
    expect(run.merged).toEqual([55, 77, 88]);                            // impl → carrier → dependent, all in one pass
    expect(run.deferred).toEqual([]);
    expect([...run.seenIncomplete.at(-1)]).toEqual([]);                  // nothing incomplete once both halves merged
  });

  it('the \\ mergedRefs subtraction is load-bearing: WITHOUT it the healthy couple reads incomplete', () => {
    const verdicts = mkVerdicts();
    const prsByRepo = mkPrsByRepo();
    const merged = [{ num: 55, repo: FUI }, { num: 77, repo: WE }];
    expect([...deriveCoupleIncomplete({ verdicts, merged, prsByRepo })]).toEqual([]);          // with the subtraction
    expect([...deriveCoupleIncomplete({ verdicts, merged: [], prsByRepo })]).toEqual([100]);   // without it → every healthy couple defers
  });

  it('liveOpenHeadRefs: a merged entry matching no verdict is REPORTED and fails the couple closed (#2899 J5)', () => {
    const out = liveOpenHeadRefs({ verdicts: mkVerdicts(), merged: [{ num: 999, repo: FUI }], prsByRepo: mkPrsByRepo() });
    expect(out.unmatchedMerges).toEqual([`${FUI}#999`]);
    expect(out.mergedRefs.size).toBe(0);
    expect(out.openHeadRefs.sort()).toEqual(['lane/a-fui', 'lane/a-we', 'lane/b-we']);
  });

  // ── 7. the residual is documented with the CORRECTED reason ────────────────────────────────────────────────
  it('the provenOnMain carve-out is documented as a COST call, not "unrecoverable"', () => {
    // unwrap the jsdoc line prefixes so an assertion is about the PROSE, not where the comment happens to wrap
    const doc = SRC.slice(SRC.indexOf('#3004 residual'), SRC.indexOf('#3004 residual') + 1400).replace(/\n\s*\*\s?/g, ' ');
    expect(doc).toContain('provenOnMain');
    expect(doc).toContain('#2411');                        // the manifest lives in the PR BODY and survives the merge
    expect(doc).toMatch(/JOIN KEY|join key/);              // what is actually missing
    expect(doc).toMatch(/COST call, not an impossibility/); // the corrected framing, not "unrecoverable"
    expect(doc).toMatch(/gh pr view <num> --json body/);    // the concrete read that makes it recoverable
  });
});

describe('merge-ai-prs — #2502 headSha real-value wiring (buildDrainVerdicts -> planLabelDrain)', () => {
  // The prior gate-entrypoint-integration test proves toMerge/parked/skipped carry a REAL (non-null) headSha,
  // but that harness only ever runs --dry-run, so it never exercises the `deferred` bucket's headSha with a
  // real value either (every existing planLabelDrain unit test builds candidates by hand and never sets
  // `.headSha`, so their `deferred` assertions are all trivially `null`). This proves the REAL data path —
  // buildDrainVerdicts attaching `v.headSha` off the PR's real commits, surviving the `{...v}` spread
  // planLabelDrain's `remaining`/`plan.ready`/`plan.deferred` all copy through — carries a genuine SHA, not
  // just the always-null shape every other deferred assertion in this file happens to exercise.
  const green = [{ name: 'test', conclusion: 'SUCCESS' }];
  const ghPr = (number, headRefName, labels = []) =>
    ({ number, title: 't', body: 'a real summary', headRefName, statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: labels.map((name) => ({ name })) });

  it('a blockedBy defer carries the REAL tip SHA (not null) through the production buildDrainVerdicts -> planLabelDrain path', () => {
    const pr = ghPr(30, 'lane/b-we', ['ready-to-merge']);
    const prsByRepo = new Map([[null, [pr]]]);
    const manifest = { item: 101, blockedBy: [100], repos: [], stackParents: [] };
    const readOf = () => ({ commits: [{ oid: 'sha-real-30' }], manifest });
    const verdicts = buildDrainVerdicts({ prsByRepo, readOf, repos: [null] });
    expect(verdicts[0].headSha).toBe('sha-real-30'); // buildDrainVerdicts itself attaches the real value
    const plan = planLabelDrain(verdicts, { extraOpenItems: new Set([100]) });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred).toEqual([{ num: 30, item: 101, waitOn: [100], headSha: 'sha-real-30' }]);
  });

  it('a landable candidate with NO commits reports headSha: null, never a garbage value', () => {
    const pr = ghPr(31, 'lane/c-we', ['ready-to-merge']);
    const prsByRepo = new Map([[null, [pr]]]);
    const readOf = () => ({ commits: [], manifest: null });
    const verdicts = buildDrainVerdicts({ prsByRepo, readOf, repos: [null] });
    expect(verdicts[0].headSha).toBeNull();
  });

  it('a candidate whose tip commit carries a NON-STRING oid (missing / null / number) reports headSha: null too', () => {
    const cases = [
      [{ oid: undefined }],
      [{ oid: null }],
      [{ oid: 12345 }],
      [{}], // no oid key at all
    ];
    for (const commits of cases) {
      const pr = ghPr(31, 'lane/c-we', ['ready-to-merge']);
      const verdicts = buildDrainVerdicts({ prsByRepo: new Map([[null, [pr]]]), readOf: () => ({ commits, manifest: null }), repos: [null] });
      expect(verdicts[0].headSha, `commits=${JSON.stringify(commits)}`).toBeNull();
    }
  });

  it('picks the LAST commit as the tip — `gh pr view --json commits` orders oldest-first, never the first', () => {
    const pr = ghPr(32, 'lane/d-we', ['ready-to-merge']);
    const prsByRepo = new Map([[null, [pr]]]);
    // three commits, oldest-first (the real gh ordering) — the tip is the LAST one, sha-c, never sha-a.
    const readOf = () => ({ commits: [{ oid: 'sha-a' }, { oid: 'sha-b' }, { oid: 'sha-c' }], manifest: null });
    const verdicts = buildDrainVerdicts({ prsByRepo, readOf, repos: [null] });
    expect(verdicts[0].headSha).toBe('sha-c');
  });
});
