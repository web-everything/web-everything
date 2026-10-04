/**
 * @file scripts/lib/__tests__/couple-cascade.test.mjs
 * @description fix-couple-split — a cross-repo couple lands WHOLE in one pass or not at all.
 *   Replays the 2026-09-26T20:32:20Z drain pass (plateau-app#185 impl + web-everything#2751 carrier +
 *   web-everything#2746 unrelated) through the REAL planner (`planDrainPass`) and a faithful mini of runCli's
 *   cascade, then pins the pure gate and its wiring into `scripts/merge-ai-prs.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planDrainPass, reduceOpenPrContext } from '../../merge-ai-prs.mjs';
import { repoKeyFromSlug } from '../../readiness/lane-manifest.mjs';
import { planCoupleCascadeStep, carrierPreflight, openSiblingRefSet, candKey, isImplHalf, isCoupleCarrier } from '../couple-cascade.mjs';

const WE = null;                                   // the local WE clone — runCli's convention (repo=null, key 'cwd')
const PA = 'plateauapp/plateau-app';
const localSlug = 'web-everything/web-everything';
const isLocalRepo = (repo) => repo == null || repo === localSlug;
const repoKeyOfSlug = (slug) => (isLocalRepo(slug) ? 'we' : repoKeyFromSlug(slug));
const repoKeyOf = (v) => repoKeyOfSlug(v.repo);
const claude = { authors: [{ name: 'Claude Opus 4.8', email: 'noreply@anthropic.com' }] };
const green = [{ name: 'test', conclusion: 'SUCCESS' }];
const LABELS = [{ name: 'ready-to-merge' }, { name: 'review:accepted' }];
const REF = 'lane/x5h527v-drain-daemon-bounds';    // the SAME lane ref name in both repos (the common case)
const ghPr = (number, headRefName, headOid) => ({
  number, title: 't', body: 'what changed and why', headRefName, headRefOid: headOid,
  statusCheckRollup: green, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels: LABELS,
  commits: [{ oid: headOid, ...claude }],
});
const MANIFEST_2751 = { item: 'x5h527v', repos: [{ repo: 'plateau-app', ref: REF, carriesResolve: false }, { repo: 'we', ref: REF, carriesResolve: true }], stackParents: ['xr05jjl'], blockedBy: ['xr05jjl'], mergeRiskFiles: [], dismissedFindings: 0 };

/** The 20:32:20Z pass inputs (history.jsonl line: consideredPrs [185,2746,2751], same head SHAs). */
function incidentPass() {
  const listings = [
    { repo: WE, prs: [ghPr(2746, 'lane/x3vjug7-prepare-workflow-manager', '456a00e51c21449f278a54c4c146ac4b5eb81648'), ghPr(2751, REF, '3c3fe4fb2dfd57458ec9ef5eb25fbb7f24a4ff94')] },
    { repo: PA, prs: [ghPr(185, REF, 'deee8117f75fe65c78d3ac35ad89f1ad2b0364db')] },
  ];
  const reads = new Map([
    ['cwd::2746', { manifest: null, commits: [claude], degraded: false }],
    ['cwd::2751', { manifest: MANIFEST_2751, commits: [claude], degraded: false }],
    [`${PA}::185`, { manifest: null, commits: [claude], degraded: false }],
  ]);
  const openPrContext = reduceOpenPrContext({ listings, reads, reconcileRan: true });
  const res = planDrainPass({
    listings, openPrContext, repos: [WE, PA], readOf: (repo, num) => reads.get(`${repo || 'cwd'}::${num}`),
    requiredCheck: 'test', label: 'ready-to-merge', isLocalRepo, localSlug,
    provenOnMain: new Set(['xr05jjl']),            // #2744 (xr05jjl) merged 18:59Z — the stack parent is proven
  });
  return { ...res, openPrContext };
}

/**
 * A faithful mini of runCli's cascade. `fresh(c, mergedSoFar)` is the pre-merge re-read (revalidateForMerge):
 * GitHub's WE branch protection reads a PR BEHIND once another WE PR merged this pass (what #2751 hit).
 * `gate: false` is the pre-fix loop (iterate `plan.ready` as-is).
 */
function runCascade({ ready, verdicts, prsByRepo, fresh, gate }) {
  const merged = [];
  const refused = [];
  const held = [];
  let order = ready;
  if (gate) {
    const mk = new Set();
    const step = planCoupleCascadeStep(ready, { candidates: verdicts, mergedKeys: mk, openSiblingRefs: openSiblingRefSet(prsByRepo, mk, repoKeyOfSlug), repoKeyOf });
    held.push(...step.held.map((h) => h.num));
    order = step.ordered;
  }
  const heldNow = new Set();
  for (const c of order) {
    if (heldNow.has(candKey(c))) continue;
    if (gate && isImplHalf(c)) {
      const ck = `${c.coupleCarrier.repo || 'cwd'}::${c.coupleCarrier.num}`;
      const carrier = order.find((x) => candKey(x) === ck);
      const pf = carrierPreflight({ carrierMergedThisPass: merged.some((m) => candKey(m) === ck), freshCarrierVerdict: carrier ? fresh(carrier, merged) : null });
      if (!pf.ok) { heldNow.add(candKey(c)); if (carrier) heldNow.add(ck); held.push(c.num, ...(carrier ? [carrier.num] : [])); continue; }
    }
    if (gate && isCoupleCarrier(c)) {
      const missing = order.filter((x) => isImplHalf(x) && `${x.coupleCarrier.repo || 'cwd'}::${x.coupleCarrier.num}` === candKey(c) && !merged.some((m) => candKey(m) === candKey(x)));
      if (missing.length) { held.push(c.num); continue; }
    }
    if (fresh(c, merged).decision !== 'merge') { refused.push(c.num); continue; }
    merged.push(c);
  }
  const mergedNums = merged.map((m) => m.num);
  const split = mergedNums.includes(185) !== mergedNums.includes(2751);
  return { order: order.map((c) => c.num), merged: mergedNums, refused, held, split };
}

// WE PRs read BEHIND once another WE PR merged earlier in the pass; plateau-app is unaffected by WE merges.
const behindAfterWeMerge = (c, mergedSoFar) => (c.repo == null && mergedSoFar.some((m) => m.repo == null))
  ? { decision: 'skip', reason: 'merge state BLOCKED (BEHIND⇒needs rebase)' }
  : { decision: 'merge' };

describe('fix-couple-split — the 2026-09-26T20:32Z replay', () => {
  it('the planner reads the incident exactly as the daemon did: all three ready, impl joined to #2751', () => {
    const { plan, verdicts } = incidentPass();
    expect(plan.ready.map((c) => c.num)).toEqual([185, 2746, 2751]);        // hash items tie → PR# order across repos
    const impl = verdicts.find((v) => v.num === 185);
    expect(impl.joinedToCouple).toBe('x5h527v');
    expect(impl.coupleCarrier.num).toBe(2751);
  });

  it('RED (pre-fix loop): #185 lands, #2746 moves WE main, #2751 reads BEHIND → the couple SPLITS', () => {
    const { plan, verdicts, openPrContext } = incidentPass();
    const run = runCascade({ ready: plan.ready, verdicts, prsByRepo: openPrContext.prsByRepo, fresh: behindAfterWeMerge, gate: false });
    expect(run.merged).toEqual([185, 2746]);                                // matches the log: "merged 2 (#185, #2746)"
    expect(run.refused).toEqual([2751]);
    expect(run.split).toBe(true);
  });

  it('GREEN: the couple is ordered contiguously (#185 → #2751 → #2746) and lands whole', () => {
    const { plan, verdicts, openPrContext } = incidentPass();
    const run = runCascade({ ready: plan.ready, verdicts, prsByRepo: openPrContext.prsByRepo, fresh: behindAfterWeMerge, gate: true });
    expect(run.order).toEqual([185, 2751, 2746]);
    expect(run.merged).toEqual([185, 2751]);
    expect(run.split).toBe(false);
  });

  it('GREEN: a carrier that is NOT landable at the impl\'s turn holds #185 (fail closed, nothing splits)', () => {
    const { plan, verdicts, openPrContext } = incidentPass();
    const carrierStale = (c) => (c.num === 2751 ? { decision: 'skip', reason: 'merge state BLOCKED (BEHIND⇒needs rebase)' } : { decision: 'merge' });
    const run = runCascade({ ready: plan.ready, verdicts, prsByRepo: openPrContext.prsByRepo, fresh: carrierStale, gate: true });
    expect(run.merged).toEqual([2746]);
    expect(run.held).toEqual(expect.arrayContaining([185, 2751]));
    expect(run.split).toBe(false);
  });

  it('GREEN: a carrier the drain rebuilt this pass (checks re-running) holds its impl at plan time', () => {
    const { plan } = incidentPass();
    const ready = plan.ready.map((c) => (c.num === 2751 ? { ...c, rebaseDrop: 'rebased' } : c));
    const step = planCoupleCascadeStep(ready, { candidates: ready });
    // the impl is held for the rebuilt carrier, and the carrier is held back in turn (the fixpoint), so neither
    // half can land alone later in this pass
    expect(step.held.map((h) => h.num)).toEqual([185, 2751]);
    expect(step.held[0].reason).toMatch(/rebuilt onto main this pass/);
  });
});

describe('fix-couple-split — planCoupleCascadeStep (pure)', () => {
  const impl = (num, carrierNum, extra = {}) => ({ num, repo: PA, headRef: REF, hasManifest: false, coupleCarrier: { num: carrierNum, repo: null, item: 'x' }, decision: 'merge', ...extra });
  const carrier = (num, extra = {}) => ({ num, repo: WE, headRef: REF, hasManifest: true, crossRepo: true, manifestRepoRefs: [{ repo: 'plateau-app', ref: REF }, { repo: 'we', ref: REF }], decision: 'merge', ...extra });
  const orphan = (num) => ({ num, repo: WE, headRef: `lane/o-${num}`, hasManifest: false, decision: 'merge' });

  it('holds an impl whose carrier is not in ready (deferred / skip / not a candidate)', () => {
    const step = planCoupleCascadeStep([impl(185, 2751), orphan(10)], { candidates: [carrier(2751, { decision: 'skip' })] });
    expect(step.held.map((h) => [h.num, h.role])).toEqual([[185, 'impl']]);
    expect(step.ordered.map((c) => c.num)).toEqual([10]);
  });

  it('holds a carrier whose impl candidate is not ready, and the hold propagates (fixpoint)', () => {
    const step = planCoupleCascadeStep([carrier(2751), orphan(10)], { candidates: [impl(185, 2751, { decision: 'skip' })] });
    expect(step.held.map((h) => [h.num, h.role])).toEqual([[2751, 'carrier']]);
  });

  it('repo-aware: a carrier whose SAME-NAMED impl ref is open but not a candidate is held', () => {
    const open = new Set([`plateau-app::${REF}`, `we::${REF}`]);
    const step = planCoupleCascadeStep([carrier(2751)], { candidates: [], openSiblingRefs: open, repoKeyOf });
    expect(step.held.map((h) => h.num)).toEqual([2751]);
    // once the impl is no longer open (landed earlier), the carrier may go
    const later = planCoupleCascadeStep([carrier(2751)], { candidates: [], openSiblingRefs: new Set([`we::${REF}`]), repoKeyOf });
    expect(later.held).toEqual([]);
  });

  it('orders a couple contiguously: impl halves then the carrier, at the first member\'s slot', () => {
    const step = planCoupleCascadeStep([impl(185, 2751), orphan(2746), carrier(2751), orphan(3000)], { candidates: [] });
    expect(step.ordered.map((c) => c.num)).toEqual([185, 2751, 2746, 3000]);
    expect(step.held).toEqual([]);
  });

  it('an impl whose carrier already merged this pass is free to land (it completes the couple)', () => {
    const step = planCoupleCascadeStep([impl(185, 2751)], { candidates: [], mergedKeys: new Set(['cwd::2751']) });
    expect(step.held).toEqual([]);
    expect(step.ordered.map((c) => c.num)).toEqual([185]);
  });

  it('non-couple candidates are untouched (same order, nothing held)', () => {
    const step = planCoupleCascadeStep([orphan(1), orphan(2)], { candidates: [] });
    expect(step.ordered.map((c) => c.num)).toEqual([1, 2]);
    expect(step.held).toEqual([]);
  });

  it('carrierPreflight fails closed on a missing or refused fresh read', () => {
    expect(carrierPreflight({ freshCarrierVerdict: null }).ok).toBe(false);
    expect(carrierPreflight({ freshCarrierVerdict: { decision: 'skip', reason: 'BEHIND' } }).ok).toBe(false);
    expect(carrierPreflight({ freshCarrierVerdict: { decision: 'merge' } }).ok).toBe(true);
    expect(carrierPreflight({ carrierMergedThisPass: true }).ok).toBe(true);
  });
});

describe('fix-couple-split — wiring into runCli\'s live cascade', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs'), 'utf8');
  it('the live cascade iterates the couple-gated order, not raw plan.ready', () => {
    expect(SRC).toMatch(/const coupleStep = planCoupleCascadeStep\(plan\.ready,/);
    expect(SRC).toContain('for (const c of coupleStep.ordered) {');
    expect(SRC).not.toContain('for (const c of plan.ready) {');
  });
  it('an impl half pre-flights its carrier fresh, and a split is reported in the JSON result', () => {
    expect(SRC).toMatch(/carrierPreflight\(\{ carrierMergedThisPass: carrierMerged, freshCarrierVerdict: fresh \}\)/);
    expect(SRC).toContain('...(coupleSplit.length ? { coupleSplit } : {})');
    expect(SRC).toContain('...(coupleHeld.length ? { coupleHeld } : {})');
  });
  it('verdicts carry the repo-aware manifest sibling list', () => {
    expect(SRC).toContain('v.manifestRepoRefs =');
  });
});
