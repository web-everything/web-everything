/**
 * @file scripts/lib/merge-gate-ci.mjs
 * @description PURE evaluator behind the required `merge-gate` CI check (`we:scripts/merge-gate-check.mjs`,
 *   `.github/workflows/merge-gate.yml`). Facts in, per-gate verdicts out. It REUSES the drain's own decision
 *   functions (classifyPr, buildDrainVerdicts, drainGateInputs, decideReviewGate, scoreEscalation, diffBaseline,
 *   scanTestTampering, shouldReparkForTestTampering, decideLedgerGate) — it never re-implements a rule. The IO
 *   side (the CLI) only gathers facts.
 *
 *   One result per inventory gate (`./merge-gate-inventory.mjs`):
 *     pass | hold (the drain would not merge) | fail-closed (an input is unreadable or has no shared source yet)
 *     | queue (GitHub's merge queue guarantees it) | enqueue (drain scheduling, not a merge-safety gate)
 *     | skipped-by-policy (a `pull_request` run under drain-direct with gatePlacement 'drain': the drain, the
 *       merger, keeps it; never on a `merge_group` run, where the queue merges).
 *   A PR passes only with no `hold` and no `fail-closed`. A merge group passes only when every PR in it passes.
 *
 *   NEVER WEAKER THAN THE DRAIN: the operator relief valve (`--no-review-escalation`) is never applied; every
 *   unreadable input is a fail-closed, never a pass; the ledger mode is the drain's own default.
 *
 *   MODE (`mergeGate.mode`, shadow | enforce — bottom of this file): shadow reports every verdict exactly as
 *   enforce but exits 0 on a HOLD. The only IO in this file is `loadMergeGateMode` and the `--run-gate` CLI the
 *   workflow calls around merge-gate-check.mjs; everything else stays pure.
 */
import { hasLabel, isAiGeneratedPr } from './ai-pr-authorship.mjs';
import {
  hasNonEmptyBody, scanTestTampering, decideLedgerGate, DEFAULT_REVIEW_AUTHORITY,
} from './pr-merge-gate.mjs';
import {
  REVIEW_LABELS, hasReviewLabel, hasUnclearedReviewLabel, decideReviewGate, scoreEscalation,
  shouldReparkForTestTampering,
} from './review-escalation.mjs';
import { emptyBaselineState, recordBaseline, getBaseline, diffBaseline } from './review-baseline-state.mjs';
import { extractManifestFromBody } from '../readiness/lane-manifest.mjs';
import { classifyPr, buildDrainVerdicts, drainGateInputs, isCodeQLFailed } from '../merge-ai-prs.mjs';
import { DRAIN_GATES } from './merge-gate-inventory.mjs';
import { placementOf, PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';
import { workflowEditHold } from './merge-queue-enqueue.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAllSync } from './write-all-sync.mjs';

export const TRUST_LABEL = 'ready-to-merge';
export const REQUIRED_CHECK = 'test';
const BLOCKING = new Set(['hold', 'fail-closed']);

/**
 * The PR as the merge queue presents it: the required check green and the PR mergeable/clean. Those facts are
 * guaranteed by the queue + ruleset (`where: 'queue'`), so they are fixed here and every OTHER classifyPr clause
 * still decides. Pure.
 */
export function asQueuedPr(pr, requiredCheck = REQUIRED_CHECK) {
  const rollup = (Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [])
    .filter((c) => (c?.name || c?.context) !== requiredCheck);
  return {
    ...pr,
    statusCheckRollup: [...rollup, { name: requiredCheck, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '9999-12-31T00:00:00Z' }],
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', requiredCheckReadError: undefined,
  };
}

/** The four escalation-sensitive manifest values, exactly as attachManifestToVerdict derives them. Pure. */
export function manifestValues(m) {
  return {
    hasManifest: m != null,
    dismissedFindings: m && Number.isFinite(Number(m.dismissedFindings)) ? Number(m.dismissedFindings) : 0,
    crossRepo: m && Array.isArray(m.repos) ? m.repos.length > 1 : false,
    blockedBy: m && Array.isArray(m.blockedBy) ? m.blockedBy.map(String) : [],
  };
}

/** Did ANY earlier version of the PR body carry a manifest the live one weakens? Pure. */
export function manifestHistoryTamper({ repo, num, bodies = [], live }) {
  const reasons = [];
  for (const body of bodies) {
    const key = { repo: repo || 'cwd', num };
    const baseline = getBaseline(recordBaseline(emptyBaselineState(), key, manifestValues(extractManifestFromBody(body))), key);
    const d = diffBaseline(baseline, live);
    if (d.tampered) reasons.push(...d.reasons);
  }
  return { tampered: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** One duplicate-id entry as text: findDuplicateIds' `{num, names}`, or a legacy `{id}` / string. Pure. */
export function duplicateIdText(d) {
  if (d && typeof d === 'object' && d.num != null) return `#${d.num} (${(Array.isArray(d.names) ? d.names : []).join(' + ')})`;
  if (d && typeof d === 'object' && d.id != null) return String(d.id);
  return typeof d === 'string' ? d : JSON.stringify(d);
}

const r = (id, status, reason) => ({ id, status, reason });

/**
 * Evaluate every inventory gate for one PR. Pure.
 * @param {object} facts  gathered by the CLI — see merge-gate-check.mjs `gatherPrFacts` for the shape.
 * `mergeEvent` is the event this run is actually evaluating for: `'pull_request'` or `'merge_group'`. Only
 * `'pull_request'` may hand a gate to the drain (`skipped-by-policy`); the queue merges on `'merge_group'`, so
 * nothing is skipped there, and an omitted / unrecognised value evaluates every gate (fail closed).
 * @param {{policy?:object, requiredCheck?:string, trustLabel?:string, blockOnCodeQL?:boolean, mergeEvent?:string}} [o]
 * @returns {{num:number, ok:boolean, results:Array<{id,status,reason}>, blocking:Array}}
 */
export function evaluatePrGates(facts, { policy = null, requiredCheck = REQUIRED_CHECK, trustLabel = TRUST_LABEL, blockOnCodeQL = true, mergeEvent = null } = {}) {
  const num = Number(facts?.pr?.number ?? facts?.num);
  const out = new Map();
  const set = (id, status, reason) => out.set(id, r(id, status, reason));
  for (const g of DRAIN_GATES) if (g.where !== 'merge-gate') set(g.id, g.where, g.note || `${g.where}-owned`);

  const mergeGateIds = DRAIN_GATES.filter((g) => g.where === 'merge-gate').map((g) => g.id);
  if (!facts?.pr || facts.prReadError) {
    for (const id of mergeGateIds) set(id, 'fail-closed', `PR read failed: ${facts?.prReadError || 'no PR facts'}`);
    return finish(num, out, policy, mergeEvent);
  }
  const pr = facts.pr;
  const labels = pr.labels || [];
  const queued = asQueuedPr(pr, requiredCheck);

  // candidate-label — the drain's candidate set is --label=ready-to-merge.
  set('candidate-label', hasLabel(pr, trustLabel) ? 'pass' : 'hold', hasLabel(pr, trustLabel) ? `${trustLabel} present` : `no "${trustLabel}" label — the drain never considers it`);

  // classifyPr clauses, one result each, plus classifyPr itself as a cross-check below.
  const certified = hasLabel(pr, trustLabel) || isAiGeneratedPr(pr) || hasLabel(pr, REVIEW_LABELS.accepted);
  set('producer-certified', certified ? 'pass' : 'hold', certified ? 'certified' : 'not AI-generated, no ready-to-merge label, not human-cleared');
  if (!facts.defaultBranch) set('default-base', 'fail-closed', 'default branch unreadable');
  else set('default-base', pr.baseRefName === facts.defaultBranch ? 'pass' : 'hold', `base ${pr.baseRefName} vs ${facts.defaultBranch}`);
  const codeql = blockOnCodeQL && isCodeQLFailed(pr);
  set('codeql', codeql ? 'hold' : 'pass', codeql ? 'CodeQL check failed' : 'no failed CodeQL run');
  set('non-empty-body', hasNonEmptyBody(pr.body) ? 'pass' : 'hold', hasNonEmptyBody(pr.body) ? 'body present' : 'empty/whitespace description');
  const uncleared = hasUnclearedReviewLabel(labels, { allowPending: false });
  set('review-hold-labels', uncleared ? 'hold' : 'pass', uncleared ? 'unsatisfied review hold label without review:accepted' : 'no uncleared review hold');
  const cls = classifyPr(queued, { requiredCheck, allowPendingReview: false, defaultBranch: facts.defaultBranch || null, blockOnCodeQL });
  if (cls.decision !== 'merge') {
    const blocked = [...out.values()].some((x) => BLOCKING.has(x.status));
    if (!blocked) set('producer-certified', 'hold', `classifyPr: ${cls.reason}`);
  }

  // The drain's verdict build (manifest attach, deviation) off the same queued PR.
  const [v] = buildDrainVerdicts({
    prsByRepo: new Map([[facts.repo, [{ ...queued }]]]), repos: [facts.repo], requiredCheck,
    readOf: () => ({ commits: pr.commits || [], manifest: facts.manifest?.live ?? null }),
    defaultBranchOf: () => facts.defaultBranch || null,
  });

  // review-acceptance — scoreEscalation + decideReviewGate on the drain's own inputs. FIRST, the human-only
  // workflow-edit rule (PR #4708 round 6): a PR whose change list AT THE PINNED HEAD (`facts.gatePaths`, git
  // `--no-renames` so both sides of a rename count) touches .github/workflows/** or .github/actions/** changes
  // the checks that judge it. An AI-reviewable escalation cannot clear that; only a `clear-human` ceremony whose
  // reviewed sha IS the pinned head can. An unread or missing change list fails closed.
  const sig = facts.netSignals;
  const wf = workflowEditFact(facts);
  if (wf) set('review-acceptance', wf.status, wf.reason);
  else if (facts.manifest?.error) set('review-acceptance', 'fail-closed', `manifest read failed: ${facts.manifest.error}`);
  else if (!sig || (!sig.scored && !sig.fallbackFiles)) set('review-acceptance', 'fail-closed', `net diff unreadable: ${sig?.error || 'not computed'}`);
  else {
    const score = scoreEscalation({
      changedFiles: sig.changedFiles, diffLines: sig.diffLines, humanBasisFiles: sig.humanBasisFiles,
      cumulativeDiffLines: sig.cumulativeDiffLines, dismissedFindings: v.dismissedFindings, crossRepo: v.crossRepo,
      diffHunks: sig.diffHunks ?? null, basisNarrowed: sig.basisNarrowed, deviation: v.deviation,
    });
    const inputs = drainGateInputs({ score, labels, deviation: v.deviation });
    if (hasReviewLabel(labels, REVIEW_LABELS.accepted) && facts.acceptance?.error) {
      set('review-acceptance', 'fail-closed', `review acceptance verification unreadable: ${facts.acceptance.error}`);
    } else {
      const gate = decideReviewGate({ ...inputs, labels, ...(facts.acceptance && !facts.acceptance.error ? facts.acceptance : {}) });
      set('review-acceptance', gate.action === 'merge' ? 'pass' : 'hold', `${gate.action}: ${gate.reason || ''}${score.reasons?.length ? ` [${score.reasons.join('; ')}]` : ''}`);
    }
  }

  // manifest-baseline — every historical body is a candidate baseline (≥ the drain's first sighting).
  const live = { hasManifest: !!v.hasManifest, dismissedFindings: v.dismissedFindings, crossRepo: v.crossRepo, blockedBy: v.blockedBy };
  const hist = facts.bodyHistory;
  if (facts.manifest?.fromTree) set('manifest-baseline', 'fail-closed', 'legacy tree-committed manifest: its history is not analysed');
  else if (!hist || hist.error || !hist.complete) set('manifest-baseline', 'fail-closed', `PR body history unreadable or truncated: ${hist?.error || 'incomplete'}`);
  else {
    const t = manifestHistoryTamper({ repo: facts.repo, num, bodies: hist.bodies, live });
    set('manifest-baseline', t.tampered ? 'hold' : 'pass', t.tampered ? `manifest weakened vs an earlier body: ${t.reasons.join('; ')}` : `no weakening across ${hist.bodies.length} historical bodies`);
  }

  // test-gaming — the drain no-ops without a clone; CI has one, so an unscored diff fails closed.
  if (!sig?.scored || typeof sig.netDiffText?.text !== 'string') set('test-gaming', 'fail-closed', 'net diff text not computed');
  else {
    const gaming = scanTestTampering({ diffText: sig.netDiffText.text });
    const accepted = hasReviewLabel(labels, REVIEW_LABELS.accepted) && facts.acceptance && !facts.acceptance.error;
    const repark = shouldReparkForTestTampering({
      tampered: gaming.tampered, netDiffScored: true,
      humanClearedSha: accepted && gaming.tampered ? facts.acceptance.humanClearedSha ?? null : null,
      headSha: accepted && gaming.tampered ? facts.acceptance.headSha ?? null : null,
    });
    set('test-gaming', repark ? 'hold' : 'pass', repark ? `test-gaming suspected: ${gaming.reasons.join('; ')}` : (gaming.tampered ? 'tampering human-cleared at this head' : 'no test tampering'));
  }

  // red-main-freeze — needs a shared source.
  const rm = facts.redMain;
  if (!rm || !rm.source) set('red-main-freeze', 'fail-closed', `no shared red-main freeze source yet (${gateCard('red-main-freeze')})`);
  else if (rm.error) set('red-main-freeze', 'fail-closed', `red-main freeze unreadable: ${rm.error}`);
  else set('red-main-freeze', rm.frozen ? 'hold' : 'pass', rm.frozen ? `main is RED (freeze: ${rm.reason || 'active'})` : `no freeze (${rm.source})`);

  // duplicate-id-on-main
  const dup = facts.duplicateIds;
  if (!dup || dup.error) set('duplicate-id-on-main', 'fail-closed', `duplicate-id scan failed: ${dup?.error || 'not run'}`);
  else if (mergeEvent === 'merge_group' && !Array.isArray(dup.group)) {
    // The queue merges the group tree, so a merge_group run without the group scan has only checked main.
    set('duplicate-id-on-main', 'fail-closed', 'merge_group run without the group-tree duplicate-id scan (--group-tree missing)');
  } else {
    const ids = [...(dup.main || []), ...(dup.group || [])];
    set('duplicate-id-on-main', ids.length ? 'hold' : 'pass', ids.length ? `duplicate backlog ids: ${ids.map(duplicateIdText).join(', ')}` : 'no duplicate ids');
  }

  // couple-whole / blocked-by — vacuous without a manifest (the drain's "no manifest, always ready").
  const ordered = v.hasManifest && (v.crossRepo || (v.blockedBy || []).length || (v.stackParents || []).length);
  const clearance = facts.enqueueClearance?.coversHead === true;
  for (const id of ['couple-whole', 'blocked-by']) {
    if (!ordered) set(id, 'pass', 'no manifest couple / blockedBy');
    else set(id, clearance ? 'pass' : 'fail-closed', clearance ? 'drain enqueue clearance covers this head' : `manifest couple/blockedBy needs the drain's enqueue clearance (${gateCard(id)})`);
  }

  // ledger — mergeGate.reviewAuthority, default `labels` (the drain does not consult the ledger). The CLI MUST
  // gather `facts.ledger` (the configured authority, or an error reading the settings): a missing fact is a
  // fail-closed, never a silent `labels` default — that default is what let a configured `ledger`/`both`
  // authority go unread. `ledger`/`both` with no ledger evidence defer (fail closed) inside decideLedgerGate.
  if (!facts.ledger) set('ledger', 'fail-closed', 'ledger facts not gathered (mergeGate.reviewAuthority unread)');
  else if (facts.ledger.error) set('ledger', 'fail-closed', `mergeGate.reviewAuthority unreadable: ${facts.ledger.error}`);
  else {
    const ledger = decideLedgerGate({ folded: facts.ledger.folded ?? null, derived: facts.ledger.derived ?? null, head: pr.headRefOid, labelsClear: !uncleared, authority: facts.ledger.authority ?? DEFAULT_REVIEW_AUTHORITY });
    set('ledger', ledger.clear ? 'pass' : ledger.defer ? 'fail-closed' : 'hold', `${ledger.authority}: ${ledger.reason}`);
  }

  return finish(num, out, policy, mergeEvent);
}

/**
 * The human-only workflow-edit verdict for `review-acceptance`, or null when the PR touches no gate path and may
 * proceed to the ordinary review decision. Pure.
 * @returns {null|{status:'hold'|'fail-closed', reason:string}}
 */
export function workflowEditFact(facts) {
  const pinned = facts?.pinnedHead?.sha;
  const gp = facts?.gatePaths;
  if (!pinned) return { status: 'fail-closed', reason: `workflow-edit check: head not pinned (${facts?.pinnedHead?.error || 'no pinned head'})` };
  if (!gp || gp.error || !Array.isArray(gp.files)) return { status: 'fail-closed', reason: `workflow-edit check: pinned change list unreadable (${gp?.error || 'not read'})` };
  const hold = workflowEditHold({ files: gp.files, expectedCount: gp.files.length });
  if (!hold.hold) return null;
  if (!hold.humanOnly) return { status: 'fail-closed', reason: `workflow-edit check: ${hold.error}` };
  const cleared = String(facts?.acceptance && !facts.acceptance.error ? facts.acceptance.humanClearedSha || '' : '').toLowerCase();
  if (cleared && cleared === String(pinned).toLowerCase()) return null;
  return { status: 'hold', reason: `human-only: the diff at ${String(pinned).slice(0, 9)} touches ${hold.paths.join(', ')} — workflow files decide the required checks, so only a clear-human ceremony at this exact head can accept it${cleared ? ` (human clearance is for ${cleared.slice(0, 9)})` : ''}` };
}

function gateCard(id) {
  const g = DRAIN_GATES.find((x) => x.id === id);
  return g?.card ? `card ${g.card}` : 'no card';
}

function finish(num, out, policy, mergeEvent) {
  // A gate is handed to the drain only on a `pull_request` run, where the drain really is the merger and
  // re-checks it. On a `merge_group` run GitHub's queue merges, whatever `strategy` is configured, so no
  // drain re-check follows: evaluate everything. Anything but the exact string 'pull_request' (omitted,
  // unknown, wrong case) fails closed to evaluating.
  const drainMerges = mergeEvent === 'pull_request' && policy?.strategy === 'drain-direct';
  const results = DRAIN_GATES.map((g) => {
    const res = out.get(g.id) || r(g.id, 'fail-closed', 'not evaluated');
    if (g.where === 'merge-gate' && drainMerges && placementOf(policy, g.id) === 'drain') {
      return r(g.id, 'skipped-by-policy', `placement drain (drain-direct merges): ${res.reason}`);
    }
    return res;
  });
  const blocking = results.filter((x) => BLOCKING.has(x.status));
  return { num, ok: blocking.length === 0, results, blocking };
}

/**
 * A merge group passes only when it names at least one PR, its membership is COMPLETE, and every PR passes.
 * `membership` is `groupMembership(...)`'s verdict; a partial list (only the head ref's PR, a commit that maps to
 * no PR) must never read as the whole group — the unlisted PRs would merge unevaluated. Pure.
 */
export function evaluateGroup(prResults, membership) {
  const prs = Array.isArray(prResults) ? prResults : [];
  if (!prs.length) return { ok: false, reason: 'merge group: no PR could be identified — fail closed', prs };
  // Proven complete or nothing: an omitted / malformed membership verdict is NOT "complete".
  if (membership?.complete !== true) {
    return { ok: false, reason: `merge group membership incomplete — fail closed: ${(membership?.reasons || []).join('; ') || 'completeness not proven'}`, prs };
  }
  const bad = prs.filter((p) => !p.ok);
  return { ok: bad.length === 0, reason: bad.length ? `held: ${bad.map((p) => `#${p.num}`).join(', ')}` : `all ${prs.length} PR(s) pass`, prs };
}

/**
 * The PR numbers in a merge group. Strictest union of every source: the queue entries at or ahead of this
 * group's head commit, the `pr-<N>` in the group ref, and `Merge pull request #N` subjects in base..head. Pure.
 */
export function groupPrNumbers({ headRef = '', headSha = '', entries = [], commitSubjects = [] } = {}) {
  const nums = new Set();
  const m = String(headRef).match(/\/pr-(\d+)-[0-9a-f]+$/);
  if (m) nums.add(Number(m[1]));
  const mine = (entries || []).find((e) => e?.headCommit?.oid === headSha);
  if (mine) for (const e of entries) if (Number(e?.position) <= Number(mine.position) && e?.pullRequest?.number) nums.add(Number(e.pullRequest.number));
  for (const s of commitSubjects || []) {
    const n = prNumberOfSubject(s);
    if (n) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

/** The PR number a first-parent queue commit's subject names (`Merge pull request #N` / `… (#N)`), or null. Pure. */
export function prNumberOfSubject(subject) {
  const mm = String(subject).match(/^Merge pull request #(\d+)\b/) || String(subject).match(/\(#(\d+)\)\s*$/);
  return mm ? Number(mm[1]) : null;
}

/**
 * The merge group's PR numbers AND whether that list is provably the whole group. `groupPrNumbers` is a union of
 * best-effort sources; this cross-checks it against the one source that enumerates the group completely: every
 * first-parent commit in base..head must map to a PR (by its subject, else by `resolved[sha]` — the commit→PR
 * API's answer). Incomplete (fail closed) when the history was unreadable, there is no commit to check, or any
 * commit maps to no PR (squash/rebase subjects without a `(#N)`, a hand-made commit). Pure.
 * @param {{headRef?:string, headSha?:string, entries?:object[], commits?:Array<{sha:string,subject:string}>,
 *   commitsRead?:boolean, resolved?:Record<string, number[]>}} o
 * @returns {{nums:number[], complete:boolean, reasons:string[]}}
 */
export function groupMembership({ headRef = '', headSha = '', entries = [], commits = [], commitsRead = true, resolved = {} } = {}) {
  const reasons = [];
  const extra = new Set();
  if (!commitsRead) reasons.push('first-parent history unreadable (git log failed)');
  else if (!commits.length) reasons.push('no first-parent commits between the group base and head to cross-check');
  const subjects = [];
  for (const c of commits || []) {
    const n = prNumberOfSubject(c?.subject);
    if (n) { subjects.push(c.subject); continue; }
    const viaApi = (resolved?.[c?.sha] || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    if (viaApi.length) for (const x of viaApi) extra.add(x);
    else reasons.push(`commit ${String(c?.sha).slice(0, 7)} maps to no PR`);
  }
  const nums = [...new Set([...groupPrNumbers({ headRef, headSha, entries, commitSubjects: subjects }), ...extra])].sort((a, b) => a - b);
  if (!nums.length) reasons.push('no PR could be identified');
  return { nums, complete: reasons.length === 0, reasons };
}

/** Human-readable check summary. */
export function formatPrResult(p) {
  const lines = [`#${p.num}: ${p.ok ? 'PASS' : 'HOLD'}`];
  for (const x of p.results) lines.push(`  ${x.status.padEnd(17)} ${x.id.padEnd(22)} ${x.reason}`);
  return lines.join('\n');
}

// ── mergeGate.mode: shadow | enforce ───────────────────────────────────────────────────────────────────────────
// Operator-approved 2026-10-10: the check runs in SHADOW until a shared red-main freeze source exists (#4715,
// card 5805). Shadow evaluates every rule exactly as enforce and reports the same table; it changes ONLY the exit
// code of a HOLD verdict (0 instead of 1). It never changes a rule's verdict, and it never masks a run that
// produced no verdict (a crash, a usage error, unparsable output). The ruleset step (making `merge-gate`
// required) needs enforce.
//
// Resolved through the policy cascade, each layer overriding the one below (agent-memory 151):
//   1. standard default            STANDARD_MERGE_GATE_MODE ('shadow' for now)
//   2. platform preference         we:scripts/lib/delivery-platform-preferences.json  `mergeGate.mode`
//   3. repo setting                declared settings (we:scripts/settings/*.json)    `mergeGate.mode`
//   4. env                         MERGE_GATE_MODE (the workflow passes the `MERGE_GATE_MODE` repository variable)
// FAIL CLOSED: an invalid value at any layer, or a layer that cannot be read, resolves to `enforce` — a skipped or
// typo'd layer could be the one that said enforce, so it must never fall through to shadow.

export const MERGE_GATE_MODES = Object.freeze(['shadow', 'enforce']);
export const STANDARD_MERGE_GATE_MODE = 'shadow';
export const MERGE_GATE_MODE_ENV = 'MERGE_GATE_MODE';

/**
 * Resolve the mode from raw layer values. `undefined`, `null` and `''` mean "layer not set". Pure.
 * @returns {{mode:'shadow'|'enforce', source:string, invalid:string[]}}
 */
export function resolveMergeGateMode({ platform, repo, env, readErrors = [] } = {}) {
  let mode = STANDARD_MERGE_GATE_MODE;
  let source = 'standard';
  const invalid = [...readErrors];
  for (const [name, v] of [['platform', platform], ['repo', repo], ['env', env]]) {
    if (v === undefined || v === null || v === '') continue;
    if (!MERGE_GATE_MODES.includes(v)) { invalid.push(`${name}=${JSON.stringify(v)}`); continue; }
    mode = v;
    source = name;
  }
  if (invalid.length) return { mode: 'enforce', source: `fail-closed (${invalid.join('; ')})`, invalid };
  return { mode, source, invalid };
}

/** IO: read the three configurable layers and resolve. Never throws. */
export function loadMergeGateMode({ env = process.env, platformPath = PLATFORM_PREFERENCES_PATH, readFile = readFileSync, readDeclared = readDeclaredSettings } = {}) {
  const readErrors = [];
  const modeOf = (block, name) => {
    if (block === undefined) return undefined;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) { readErrors.push(`${name} mergeGate block is not an object`); return undefined; }
    return block.mode;
  };
  let platform;
  try { platform = modeOf(JSON.parse(readFile(platformPath, 'utf8'))?.mergeGate, 'platform'); }
  catch (e) { if (e?.code !== 'ENOENT') readErrors.push(`platform file unreadable: ${String(e?.message ?? e).split('\n')[0]}`); }
  let repo;
  try {
    const { settings, errors, duplicates } = readDeclared();
    if (errors?.length) readErrors.push(`repo settings unreadable: ${errors.map((x) => `${x.source}: ${x.error}`).join('; ')}`);
    const dup = (duplicates || []).find((d) => /^mergeGate(\.|$)/.test(String(d?.path)));
    if (dup) readErrors.push(`mergeGate set by more than one settings file (${(dup.sources || []).join(', ')})`);
    repo = modeOf(settings?.mergeGate, 'repo');
  } catch (e) { readErrors.push(`repo settings unreadable: ${String(e?.message ?? e).split('\n')[0]}`); }
  return resolveMergeGateMode({ platform, repo, env: env?.[MERGE_GATE_MODE_ENV], readErrors });
}

/**
 * Apply the mode to one merge-gate-check.mjs run. `report` is its parsed `--json` output (or null), `childStatus`
 * its exit code. A verdict is trusted only when the report is well-formed AND agrees with the exit code (ok ↔ 0,
 * hold ↔ 1); anything else is "no verdict" and its non-zero exit passes through in both modes. Pure.
 * @returns {{exitCode:number, text:string, summary:string, holds:string[]}}
 */
export function applyGateMode({ mode, source, childStatus, report }) {
  const head = `merge-gate mode: ${mode} (source: ${source})`;
  const wellFormed = report && typeof report.ok === 'boolean' && Array.isArray(report.prs);
  const consistent = wellFormed && ((report.ok && childStatus === 0) || (!report.ok && childStatus === 1));
  if (!consistent) {
    const exitCode = childStatus === 0 ? 1 : (Number.isInteger(childStatus) ? childStatus : 1);
    const line = `merge-gate: no verdict (exit ${childStatus}, ${wellFormed ? 'verdict disagrees with exit code' : 'no parsable --json report'}) — not masked in any mode; failing closed`;
    return { exitCode, holds: [], text: `${head}\n${line}\n`, summary: `### merge-gate\n\n${head}\n\n**${line}**\n` };
  }
  const table = [...report.prs.map(formatPrResult), `merge-gate: ${report.ok ? 'PASS' : 'HOLD'} — ${report.reason ?? ''}`].join('\n');
  const holds = [...new Set(report.prs.flatMap((p) => (p.results || []).filter((x) => BLOCKING.has(x.status)).map((x) => x.id)))];
  const shadowLine = !report.ok && mode === 'shadow' ? `SHADOW: would HOLD on ${holds.length ? holds.join(', ') : report.reason}` : null;
  const exitCode = report.ok || shadowLine ? 0 : 1;
  const text = `${head}\n${table}\n${shadowLine ? `${shadowLine}\n` : ''}`;
  const summary = `### merge-gate\n\n${head}\n\n${shadowLine ? `**${shadowLine}** (shadow mode: exit 0; enforce would fail this check)\n\n` : ''}\`\`\`\n${table}\n\`\`\`\n`;
  return { exitCode, holds, text, summary };
}

const GATE_SCRIPT = fileURLToPath(new URL('../merge-gate-check.mjs', import.meta.url));

/**
 * The workflow wrapper: `node scripts/lib/merge-gate-ci.mjs --run-gate -- scripts/merge-gate-check.mjs <args>`.
 * Runs exactly merge-gate-check.mjs (anything else is a usage error, exit 3) with `--json` appended, then applies
 * the resolved mode. Returns the exit code; IO is injected.
 */
export function runGate({ argv = [], modeInfo, spawn = spawnSync, write = (s) => writeAllSync(1, s), warn = (s) => writeAllSync(2, s), appendSummary = null, cwd = process.cwd() } = {}) {
  const i = argv.indexOf('--');
  const [target, ...args] = i === -1 ? [] : argv.slice(i + 1);
  if (!target || (resolve(cwd, target) !== GATE_SCRIPT && resolve(target) !== GATE_SCRIPT)) {
    warn('merge-gate-ci --run-gate: usage: --run-gate -- scripts/merge-gate-check.mjs <args>\n');
    return 3;
  }
  const child = spawn(process.execPath, [GATE_SCRIPT, ...args, '--json'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report = null;
  try { report = JSON.parse(String(child?.stdout ?? '')); } catch { if (child?.stdout) write(String(child.stdout)); }
  const status = Number.isInteger(child?.status) ? child.status : 1;
  const out = applyGateMode({ mode: modeInfo.mode, source: modeInfo.source, childStatus: status, report });
  write(out.text);
  if (appendSummary) { try { appendSummary(out.summary); } catch (e) { warn(`merge-gate: step summary not written: ${e?.message ?? e}\n`); } }
  return out.exitCode;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI && process.argv.includes('--run-gate')) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = runGate({
    argv: process.argv.slice(2), modeInfo: loadMergeGateMode(),
    appendSummary: summaryPath ? (s) => appendFileSync(summaryPath, s) : null,
  });
}
