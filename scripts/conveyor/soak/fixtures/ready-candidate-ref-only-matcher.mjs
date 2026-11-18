/** Pinned ref-only matcher from origin/main 1e31b61504410bd40c51e4286ca07cb8b5348d2f; the red-side regression fixture. */
import { revokedAppliedTips } from '../../../lib/daemon-rebuild/audited-tip.mjs';

export function matchReadyCandidate({
  ready, plan, prevHead, treeOf, stillWanted, verifyBuilt = () => false, overlayTip = () => null,
  registered = stillWanted, allowFallback = true, rejected = null, nowMs, maxAgeMs,
  liveApplied, carries = () => false, leftForMain = () => false,
  removedForMain = () => false, retiredByOperator = () => false, contentInBuild = () => false, forcedWatch = () => 'missing', auditedTip = null,
  tipInMain = () => false,
}) {
  if (!ready) return { adopt: null, reason: 'none' };
  // The live plan could not persist its audit pin. No ready/fallback path may replace that history with a build
  // lacking the pin (even a same-tree candidate or a record claiming pinnedFrom for a different sha).
  if (plan.reason === 'pinned-overlay-hold-marker-failed') return { adopt: null, reason: plan.reason };
  // unaudited-tip — a ready record was smoked against the audit evidence of its own time. Audit evidence is judged per plan,
  // so a record the live plan would NOT mint (a later red/WEAKENED record, or evidence gone) must not bypass the gate by
  // being adopted from disk. The live plan says exactly which tips it holds back (`overlay-unaudited-tip` alerts, already
  // exempting established, merged and never-adopted registrations): a record applying one of those tips at the tip itself is
  // refused. Even an exact or same-tree match needs fresh evidence: records can change after the live plan was minted.
  const heldTips = (plan.alerts ?? []).filter((x) => x?.kind === 'overlay-unaudited-tip' && x.detail?.ref && x.detail.newTip);
  // The alert only names the tip the plan sees NOW (the latest); a record built on an EARLIER tip B of the same ref is not
  // named when the branch fast-forwarded to C, so the record's OWN tips are re-judged against the evidence at adoption time
  // too (fail closed: no gate result for a tip = refused). Exempt: a head applied with `pinnedFrom` (the audited adopted head),
  // a tip the running head already carries (established) and a tip main already has (merged) — the gate's own exemptions.
  // Follow mode (`auditedTip` null) has no gate and nothing to revoke.
  const revokedAudit = (adopt) => revokedAppliedTips({
    applied: adopt?.applied, auditedTip, held: heldTips, carries, inMain: tipInMain, prevHead, mainSha: plan.mainSha,
    auditAdopted: plan.auditAdopted,
  });
  const passedMs = Date.parse(ready.passedAt || '');
  if (!Number.isFinite(passedMs) || nowMs - passedMs > maxAgeMs) return { adopt: null, reason: 'expired' };
  if (ready.prevHead !== prevHead) return { adopt: null, reason: 'other-base' };
  if (ready.adopt.finalSha === prevHead && ready.kind !== 'fallback') return { adopt: null, reason: 'already-head' };
  if (rejected && rejected.inputsKey === ready.adopt.inputsKey && Date.parse(rejected.at || '') > passedMs) {
    return { adopt: null, reason: 'rejected-since' };
  }
  // R508: a forced record vouches for exactly ONE sha (its rollback watch is keyed to it). A same-tree or superseding
  // build substituted for it would be adopted with no health watch, so only an exact match may adopt it.
  if (ready.forced === true && plan.finalSha !== ready.adopt.finalSha) return { adopt: null, reason: 'forced-sha-pinned' };
  // …and only while its rollback watch is really there: a forced build adopted with a missing, unreadable or already-owing watch would
  // run with nothing to revert it. Unknown (no `forcedWatch` supplied) is not "ok": fail closed.
  if (ready.forced === true) {
    const watch = forcedWatch(ready.adopt.finalSha);
    // Literal reasons (no template): the reason-classification test reads them statically.
    if (watch !== 'ok') return { adopt: null, reason: watch === 'unreadable' ? 'forced-watch-unreadable' : watch === 'owed' ? 'forced-watch-owed' : 'forced-watch-missing' };
  }
  const carriesOnlyWanted = (ready.adopt.applied || []).every((a) => stillWanted(a.ref));
  if (ready.kind === 'fallback') {
    if (!allowFallback) return { adopt: null, reason: 'fallback-not-allowed' };
    if (!carriesOnlyWanted) return { adopt: null, reason: 'overlay-no-longer-wanted' };
    if (!verifyBuilt(ready.adopt)) return { adopt: null, reason: 'unverified-build' };
    const revokedFallback = revokedAudit(ready.adopt);
    if (revokedFallback.length > 0) return { adopt: null, reason: 'ready-audit-revoked', omitted: revokedFallback };
    if (plan.inputsKey === ready.forInputsKey) {
      return { adopt: ready.adopt, dropRefs: ready.dropRefs || [], failed: ready.failed || '', match: 'fallback' };
    }
    // Main moved: only suspects still registered matter (one that already left needs no drop, and no alert).
    const dropRefs = (ready.dropRefs || []).filter((s) => registered(s.ref));
    const suspectMoved = dropRefs.some((s) => !s.sha || overlayTip(s.ref) !== s.sha);
    return suspectMoved
      ? { adopt: null, reason: 'fallback-inputs-moved' }
      : { adopt: ready.adopt, dropRefs, failed: ready.failed || '', match: 'fallback-main-moved' };
  }
  if (plan.finalSha === ready.adopt.finalSha) {
    const revokedExact = revokedAudit(ready.adopt);
    if (revokedExact.length > 0) return { adopt: null, reason: 'ready-audit-revoked', omitted: revokedExact };
    return { adopt: ready.adopt, dropRefs: [], match: 'exact' };
  }
  const planTree = treeOf(plan.finalSha);
  if (planTree && ready.tree && planTree === ready.tree) {
    const adopt = {
      finalSha: plan.finalSha, inputsKey: plan.inputsKey, mainSha: plan.mainSha, applied: plan.applied,
    };
    const revokedSameTree = revokedAudit(adopt);
    if (revokedSameTree.length > 0) return { adopt: null, reason: 'ready-audit-revoked', omitted: revokedSameTree };
    return { adopt, dropRefs: [], match: 'same-tree' };
  }
  if (!carriesOnlyWanted) return { adopt: null, reason: 'overlay-no-longer-wanted' };
  if (!verifyBuilt(ready.adopt)) return { adopt: null, reason: 'unverified-build' };
  const revokedSuperseded = revokedAudit(ready.adopt);
  if (revokedSuperseded.length > 0) return { adopt: null, reason: 'ready-audit-revoked', omitted: revokedSuperseded };
  // Live 2026-10-21 ~17:12 ET (review clone): a superseded build must never DROP an overlay the running build applies.
  // Each one's applied sha must be carried by ancestry or proven graduated into the record's own build.
  // Unknown live set (`liveApplied` not given) refuses: fail closed.
  if (!Array.isArray(liveApplied)) return { adopt: null, reason: 'superseded-live-set-unknown' };
  // Carried means by CONTENT: the live applied sha is inside the record's build (the same ref at an OLDER head does
  // not count — Codex audit).
  // Graduation (`leftForMain`) proves both registry history and content in this candidate's own build.
  // Separately, an overlay this tick's plan removed as `pr-merged`/`in-main` (`removedForMain`) is safe only
  // with independent content proof. Current main containing an overlay alone never satisfies either path.
  // An explicit operator retirement instead proves intentional removal of this exact live tip.
  const retired = [];
  const omitted = liveApplied.filter((a) => {
    if (!a?.ref) return false;
    if (a.sha && carries(a.sha, ready.adopt.finalSha)) return false;
    if (a.sha && leftForMain(a, ready.adopt.finalSha) === true) return false;
    if (a.sha && removedForMain(a.ref) && contentInBuild(a.sha, ready.adopt.finalSha)) { retired.push(a.ref); return false; }
    if (a.sha && retiredByOperator(a) === true) { retired.push(a.ref); return false; }
    return true;
  });
  if (omitted.length > 0) {
    return { adopt: null, reason: `superseded-omits-live-overlay: ${omitted.map((a) => a.ref).join(', ')}`, omitted: omitted.map((a) => a.ref) };
  }
  return { adopt: ready.adopt, dropRefs: [], match: 'superseded', ...(retired.length ? { retired } : {}) };
}
