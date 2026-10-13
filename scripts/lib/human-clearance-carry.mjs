/**
 * @file scripts/lib/human-clearance-carry.mjs
 * @description #xnqxtdy — carry a RECORDED human clearance across a MECHANICAL head move (the drain's own
 *   merge-queue freshness refresh / rebase-drop: a merge of main into the lane) when the PR's net diff is
 *   BYTE-IDENTICAL to the one the human cleared.
 *
 *   THE LIVE CASE (WE PR #4722, 2026-10-10). The operator ran `--to=clear-human` on head e125ac999. The drain's
 *   freshness refresh merged main in twice (1e48ae9, then de961efb5); the net diff vs the merge-base stayed
 *   byte-identical (reviewed-diff 67148bcd… at all three heads). The first move was re-stamped; the second was
 *   not, so `parseLatestHumanClearedSha` still named 1e48ae9 and the permission-change hold in
 *   `we:scripts/lib/review-escalation.mjs#decideReviewGate` (which needs the clearance bound to the LIVE head)
 *   re-parked `review:human` + `review:awaiting-advisory`. The operator had to approve identical code again.
 *
 *   This module is the drain-side second line, independent of whichever writer moved the head:
 *     1. {@link latestHumanClearance} — the latest trusted accept-shaped comment, ONLY if it is a human
 *        clearance (same binding as `parseLatestHumanClearedSha`), with that SAME comment's reviewed-diff and
 *        actor. `readDrainAcceptance` calls it, so the drain has no second, looser reader of the clearance.
 *     2. {@link proveMechanicalMove} (IO, git) — descendants of the cleared head must pass the merge-of-main
 *        proof: every new off-main commit is a MERGE with a parent on main; author pushes never qualify.
 *        Rewritten history must pass replay equivalence; contribution matches additionally require replay
 *        even after a successful merge proof. Any git error refuses the carry.
 *     3. {@link decideHumanClearanceCarry} (pure) — setting on, clearance present and not already bound to the
 *        head, matching strict fingerprints or (when enabled) matching contribution fingerprints, and the move
 *        mechanical. The contribution tier requires replay proof. Anything else → today's behaviour.
 *     4. {@link buildCarryRecordBody} — the DURABLE record the drain posts before honouring the carry: the
 *        standard `reviewed-sha` / `reviewed-diff` / `reviewed-contribution` / `cleared-human` markers for the
 *        new head (so every reader of `parseLatestHumanClearedSha` — the drain, the review-hold reconcile, the
 *        operator queue — agrees), plus a `human-clearance-carried` marker naming old head, new head, fingerprint.
 *
 *   Setting: `review.humanClearanceCarryForward` (default true). Same layered shape as the policy cascade
 *   (#4772, not on main yet): built-in default → `we:scripts/settings/human-clearance-carry.json` → env
 *   `WE_REVIEW_HUMAN_CLEARANCE_CARRY` (on|off|true|false|1|0). The resolved source is logged once per process.
 *
 *   THE LIVE CASE (WE PR #4715, 2026-10-11). The drain's rebase-drop moved 96f420b3f → d2068d69f; every
 *   `+`/`-` line was identical, but main changed a context line / hunk offset in .github/workflows/merge-gate.yml,
 *   so the strict reviewed-diff moved (168e9503810b → c3e14eec440a) and the clearance was refused.
 *   `git patch-id --stable` also differs (it hashes context), so carry compares the contribution fingerprint
 *   (reviewed-contribution, identical 4b8019dbed02) and proves the move by replay: `git merge-tree` of the cleared
 *   change onto the new main base reproduces the head tree, .lane-manifest.json ignored.
 *   Live #5025: drain card-numbering changes fingerprints; a separate numbering-only proof carries the original clearance.
 *   Setting: `review.carryEquivalence` (contribution|strict), env `WE_REVIEW_CARRY_EQUIVALENCE`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLatestHumanClearedSha, parseReviewedSha, parseReviewedDiff, parseOperatorClearance, parseReviewedContribution,
  buildReviewedShaMarker, buildReviewedDiffMarker, buildReviewedContributionMarker, buildClearedHumanMarker,
} from './review-escalation.mjs';
import { compareCarryFingerprints, ensureCommitReadable, liveCarryFingerprints, proveReplayEquivalent, resolveCarryEquivalenceSetting } from './carry-equivalence.mjs';
import { proveNumberingOnlyMove } from './numbering-carry.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export const HUMAN_CLEARANCE_CARRY_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'human-clearance-carry.json');
export const HUMAN_CLEARANCE_CARRY_ENV = 'WE_REVIEW_HUMAN_CLEARANCE_CARRY';
export const HUMAN_CLEARANCE_CARRIED_MARKER = 'human-clearance-carried';
/** A mechanical refresh adds one merge per refresh; more than this many new off-main commits is not a refresh. */
export const MAX_MECHANICAL_COMMITS = 50;

const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(s)) return true;
  if (['off', 'false', '0', 'no'].includes(s)) return false;
  return null;
};

/**
 * IO: env > settings file `review.humanClearanceCarryForward` > built-in `true`. Invalid values fall through. Never throws.
 * @returns {{value:boolean, source:'env'|'settings'|'default'}}
 */
export function resolveHumanClearanceCarrySetting({ env = process.env, file = HUMAN_CLEARANCE_CARRY_SETTINGS_FILE, readFile = readFileSync } = {}) {
  const e = toBool(env?.[HUMAN_CLEARANCE_CARRY_ENV]);
  if (e !== null) return { value: e, source: 'env' };
  try {
    const f = toBool(JSON.parse(String(readFile(file, 'utf8')))?.review?.humanClearanceCarryForward);
    if (f !== null) return { value: f, source: 'settings' };
  } catch { /* missing/unreadable → built-in */ }
  return { value: true, source: 'default' };
}

/**
 * PURE: the latest trusted accept-shaped comment, ONLY when it was a human clearance (or a carried one).
 * The sha and the diff come from the SAME comment, so an older clearance can never lend its fingerprint to a
 * later plain accept (the `parseLatestHumanClearedSha` binding, #xuboo0q).
 * @returns {{sha:string, diff:string|null, contribution:string|null, actor:string}|null}
 */
export function latestHumanClearance(comments) {
  const list = Array.isArray(comments) ? comments : [];
  const sha = parseLatestHumanClearedSha(list);
  if (!sha) return null;
  const trusted = list.filter(isTrustedMarkerAuthor);
  const latest = trusted.findLast((c) => parseReviewedSha([c]));
  if (!latest || parseReviewedSha([latest]) !== sha) return null;
  // Only a full 40-hex sha can be compared to the live head and fed to git; an attributed clearance needs a named actor
  // (`parseOperatorClearance` refuses an empty `cleared-human:` where `parseLatestHumanClearedSha` does not).
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const clearance = parseOperatorClearance([latest]);
  if (!clearance) return null;
  return { sha, diff: parseReviewedDiff([latest]), contribution: parseReviewedContribution([latest]), actor: sanitizeActor(clearance.actor) };
}

/**
 * PURE: an actor name made safe to print in a bot comment's prose. An allow-list, not a deny-list: only letters,
 * digits, `.`, `_`, `-` and single spaces survive, so no line break, markup, mention, link, URL, cross-reference,
 * code span or invisible/bidi character can reach the record.
 */
export function sanitizeActor(actor) {
  const name = String(actor ?? '').replace(/[^\p{L}\p{N}._-]+/gu, ' ').trim();
  return name.slice(0, 64) || 'the operator';
}

/**
 * IO (git, read-only): is the move fromSha → toSha MECHANICAL? True only when fromSha is an ancestor of toSha AND
 * every commit in `toSha ^fromSha ^mainRef` is a merge commit with at least one parent already on mainRef.
 * Fails closed on any git error.
 * @param {{exec:Function, fromSha:string, toSha:string, mainRef?:string}} o - exec is execFileSync-shaped.
 * @returns {{ok:boolean, reason:string, commits?:string[]}}
 */
function proveMergeOfMain({ exec, fromSha, toSha, mainRef = 'origin/main' } = {}) {
  if (typeof exec !== 'function' || !fromSha || !toSha) return { ok: false, reason: 'no git reader or head' };
  const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '');
  const isAncestor = (a, b) => gitIsAncestor(exec, a, b);
  let lines;
  try {
    lines = git(['rev-list', '--parents', toSha, `^${fromSha}`, `^${mainRef}`]).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) { return { ok: false, reason: `rev-list failed: ${String(e?.message ?? e).split('\n')[0]}` }; }
  if (!lines.length) return { ok: false, reason: 'no new off-main commits between the cleared head and the live head' };
  if (lines.length > MAX_MECHANICAL_COMMITS) return { ok: false, reason: `${lines.length} new commits — not a refresh` };
  const commits = [];
  for (const line of lines) {
    const [sha, ...parents] = line.split(/\s+/);
    commits.push(sha);
    if (parents.length < 2) return { ok: false, reason: `commit ${sha.slice(0, 9)} is not a merge — a non-mechanical push` };
    if (!parents.some((p) => isAncestor(p, mainRef))) {
      return { ok: false, reason: `merge ${sha.slice(0, 9)} has no parent on ${mainRef} — not a merge of main` };
    }
  }
  return { ok: true, kind: 'merge', reason: `${commits.length} merge(s) of ${mainRef}`, commits };
}

/** Exit 1 means non-ancestry; every other git failure must propagate to the fail-closed boundary. */
function gitIsAncestor(exec, fromSha, toSha) {
  try {
    exec('git', ['merge-base', '--is-ancestor', fromSha, toSha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (e) {
    if (e?.status === 1) return false;
    throw e;
  }
}

/** IO: descendants require merge-of-main proof; rewritten history requires replay; contribution requires both on descendants. */
export function proveMechanicalMove({ exec, fromSha, toSha, mainRef = 'origin/main', requireReplay = false } = {}) {
  try {
    if (typeof exec !== 'function' || !fromSha || !toSha) return { ok: false, reason: 'no git reader or head' };
    for (const sha of [fromSha, toSha]) {
      const readable = ensureCommitReadable({ exec, sha });
      if (!readable.ok) return readable;
    }
    const ancestor = gitIsAncestor(exec, fromSha, toSha);
    if (ancestor) {
      const merge = proveMergeOfMain({ exec, fromSha, toSha, mainRef });
      if (!merge.ok || !requireReplay) return merge;
    }
    const replay = proveReplayEquivalent({ exec, fromSha, toSha, mainRef });
    if (replay.ok) return { ...replay, kind: 'replay' };
    return { ok: false, reason: (ancestor ? '' : `cleared head ${fromSha.slice(0, 9)} is not an ancestor of ${toSha.slice(0, 9)} — `) + replay.reason };
  } catch (e) {
    return { ok: false, reason: `mechanical proof failed: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/**
 * PURE: does the recorded human clearance carry to the live head?
 * @param {{enabled:boolean, clearance:{sha:string,diff:string|null,contribution?:string|null,actor:string}|null, headSha:string,
 *   headDiff:string|null, mechanical:{ok:boolean,reason:string,kind?:string}|null, equivalence?:'contribution'|'strict'}} o
 * @returns {{carry:true, fromSha:string, toSha:string, fingerprint:string, actor:string, tier:'strict'|'contribution'}|{carry:false, reason:string}}
 */
export function decideHumanClearanceCarry({ enabled = true, clearance = null, headSha = '', headDiff = null, mechanical = null, equivalence = 'contribution' } = {}) {
  if (!enabled) return { carry: false, reason: 'review.humanClearanceCarryForward is off' };
  if (!clearance?.sha) return { carry: false, reason: 'no recorded human clearance is the latest accept' };
  const h = String(headSha || '').toLowerCase();
  if (!h) return { carry: false, reason: 'live head unknown' };
  if (h === clearance.sha.toLowerCase()) return { carry: false, reason: 'clearance already bound to the live head' };
  const match = compareCarryFingerprints({ mode: equivalence,
    cleared: { diff: clearance.diff, contribution: clearance.contribution }, live: liveCarryFingerprints(headDiff) });
  if (!match.same) return { carry: false, reason: match.reason };
  if (!mechanical?.ok) return { carry: false, reason: `not a mechanical move: ${mechanical?.reason || 'unproven'}` };
  if (match.tier === 'contribution' && mechanical.kind !== 'replay') {
    return { carry: false, reason: `not a mechanical move: a context-only match needs the replay proof (${mechanical.reason || 'unproven'})` };
  }
  return { carry: true, fromSha: clearance.sha.toLowerCase(), toSha: h, fingerprint: match.fingerprint, actor: clearance.actor, tier: match.tier };
}

/**
 * IO: shared carry proof for the drain and CI. Check the pinned diff before touching git;
 * unreadable evidence or history never grants a carry. No record is posted and nothing is logged.
 * @returns {{carry:boolean, applicable:boolean, reason:string, fromSha?:string, toSha?:string,
 *   fingerprint?:string, actor?:string, tier?:string, mechanicalReason?:string}}
 */
export function proveHumanClearanceCarry({ evidence, enabled = true, exec, cwd, mainRef = 'origin/main',
  equivalence = resolveCarryEquivalenceSetting().value, proveNumbering = proveNumberingOnlyMove } = {}) {
  try {
    const clearance = evidence?.humanClearance;
    if (!clearance || !evidence?.headSha) return { carry: false, applicable: false, reason: 'no recorded human clearance or live head' };
    if (String(evidence.headSha).toLowerCase() === String(clearance.sha).toLowerCase()) {
      return { carry: false, applicable: false, reason: 'clearance already bound to the live head' };
    }
    if (String(evidence.headDiffSha || '').toLowerCase() !== String(evidence.headSha).toLowerCase()) {
      return { carry: false, applicable: true,
        reason: `the live net diff was read from ${evidence.headDiffSha ? String(evidence.headDiffSha).slice(0, 9) : 'an unresolved tip'}, not the live head` };
    }
    const inputs = { enabled, equivalence, clearance, headSha: evidence.headSha, headDiff: evidence.headDiff };
    const pre = decideHumanClearanceCarry({ ...inputs, mechanical: { ok: true, kind: 'replay', reason: '(not yet checked)' } });
    const gitExec = (cmd, args, opts) => exec(cmd, args, { cwd, ...opts });
    if (!pre.carry) {
      // Only a PROVEN fingerprint mismatch (both sides read) earns the git proof: absent or unread fingerprints keep
      // refusing before git is touched, as they always did.
      if (!enabled || !clearance.diff || !liveCarryFingerprints(evidence.headDiff).diff) return { ...pre, applicable: true };
      const proof = proveNumbering({ exec: gitExec, fromSha: clearance.sha, toSha: evidence.headSha, mainRef });
      if (proof.ok) return { carry: true, applicable: true, fromSha: clearance.sha, toSha: evidence.headSha,
        fingerprint: liveCarryFingerprints(evidence.headDiff).diff || 'unscored', actor: clearance.actor,
        tier: 'numbering', mechanicalReason: proof.reason, reason: proof.reason };
      return { ...pre, applicable: true, reason: `${pre.reason}; numbering tier: ${proof.reason}` };
    }
    const mechanical = proveMechanicalMove({ exec: gitExec, fromSha: clearance.sha, toSha: evidence.headSha, mainRef, requireReplay: pre.tier === 'contribution' });
    const decision = decideHumanClearanceCarry({ ...inputs, mechanical });
    return { ...decision, applicable: true, ...(decision.carry ? { mechanicalReason: mechanical.reason, reason: mechanical.reason } : {}) };
  } catch (e) {
    return { carry: false, applicable: true, reason: `carry proof failed: ${String(e?.message ?? e).split('\n')[0]}` };
  }
}

/** PURE: the carry marker line. */
export function buildCarryMarker({ fromSha, toSha, fingerprint }) {
  return `<!-- ${HUMAN_CLEARANCE_CARRIED_MARKER}: from=${fromSha} to=${toSha} diff=${fingerprint} -->`;
}

/**
 * PURE: the durable record the drain posts. Binds `reviewed-sha` + `cleared-human` to the new head in ONE comment
 * (what `parseLatestHumanClearedSha` requires), with the reviewed diff/contribution of the live net diff text.
 * @param {{fromSha:string, toSha:string, fingerprint:string, actor:string, headDiffText:string, mechanicalReason?:string, tier?:'strict'|'contribution'}} o
 */
export function buildCarryRecordBody({ fromSha, toSha, fingerprint, actor: rawActor, headDiffText, mechanicalReason = '', tier = 'strict' }) {
  const actor = sanitizeActor(rawActor);
  return [
    '📌 review — human clearance carried forward (equivalent change after a mechanical refresh, no new review)',
    '',
    `Recorded by drain via human-clearance-carry (#xnqxtdy). The HUMAN clearance ${actor} granted on `
      + `\`${fromSha.slice(0, 12)}\` is carried to \`${toSha.slice(0, 12)}\`: `
      + (tier === 'numbering'
        ? `the head moved only by the drain's own card-numbering commit(s), verified mechanically (${mechanicalReason})`
        : tier === 'contribution'
        ? "the PR's own added/removed lines are identical and the cleared change replayed onto main reproduces the new head's tree"
        : `the PR's net diff vs its merge-base is byte-identical (\`${fingerprint.slice(0, 12)}\`) and the move is mechanical`)
      + `${mechanicalReason && tier !== 'numbering' ? ` (${mechanicalReason})` : ''}. Any substantive change still needs a fresh human approval.`,
    '',
    buildReviewedShaMarker(toSha),
    buildReviewedDiffMarker(headDiffText),
    buildReviewedContributionMarker(headDiffText),
    buildClearedHumanMarker(actor),
    buildCarryMarker({ fromSha, toSha, fingerprint }),
  ].filter((l) => l !== undefined).join('\n');
}

let loggedSetting = null;
let loggedEquivalence = null;
/** IO: log the effective equivalence policy alongside the carry switch. */
function logEquivalenceSettingOnce(value, write) {
  const resolved = resolveCarryEquivalenceSetting();
  const source = resolved.value === value ? resolved.source : 'option';
  const key = `${value}:${source}`;
  if (loggedEquivalence === key) return;
  loggedEquivalence = key;
  write(`policy · review.carryEquivalence=${value} (${source})\n`);
}

/** IO: log the setting's effective value + source once per process per distinct value (stderr → the daemon log). */
export function logCarrySettingOnce(setting, write = (s) => process.stderr.write(s)) {
  const key = `${setting.value}:${setting.source}`;
  if (loggedSetting === key) return;
  loggedSetting = key;
  write(`policy · review.humanClearanceCarryForward=${setting.value} (${setting.source})\n`);
}

/**
 * IO: the drain's carry step, run once per gate decision on an ACCEPTED PR. Given the drain's acceptance evidence
 * (`readDrainAcceptance`, which carries `humanClearance` from {@link latestHumanClearance}, `headSha`, `headDiff`), decide the carry and — when it
 * holds — post the durable record BEFORE the caller honours it. Returns:
 *   null                                  — nothing to carry (today's behaviour, the gate decides as before);
 *   {action:'defer', applyLabel:null, reason} — carry proven but the record could not be written: skip this pass,
 *                                           write no label (never re-park a clearance we could not record);
 *   {carried:{fromSha,toSha,fingerprint,actor,recorded}} — carried; the caller binds the clearance to the head.
 * Every carry and every refused carry of a real clearance is logged to stderr (the daemon log).
 */
export function applyHumanClearanceCarry({
  evidence, pr, repo = null, cwd, exec, dryRun = false, mainRef = 'origin/main',
  equivalence = resolveCarryEquivalenceSetting().value,
  setting = resolveHumanClearanceCarrySetting(), log = (s) => process.stderr.write(s),
} = {}) {
  const d = proveHumanClearanceCarry({ evidence, enabled: setting.value, exec, cwd, mainRef, equivalence });
  if (!d.applicable) return null;
  logCarrySettingOnce(setting, log);
  logEquivalenceSettingOnce(equivalence, log);
  const tag = `${repo ? `${repo}` : ''}#${pr}`;
  if (!d.carry) {
    log(`  human-clearance-carry ${tag}: NOT carried ${String(evidence?.humanClearance?.sha || '').slice(0, 9)}→${String(evidence?.headSha || '').slice(0, 9)} — ${d.reason}\n`);
    return null;
  }
  const carried = { fromSha: d.fromSha, toSha: d.toSha, fingerprint: d.fingerprint, actor: d.actor, tier: d.tier, mechanicalReason: d.mechanicalReason, recorded: false };
  if (dryRun) {
    log(`  human-clearance-carry ${tag}: WOULD carry ${d.fromSha.slice(0, 9)}→${d.toSha.slice(0, 9)} (diff ${d.fingerprint.slice(0, 12)}; tier ${d.tier}; dry run, no record)\n`);
    return { carried };
  }
  const body = buildCarryRecordBody({ ...d, headDiffText: evidence.headDiff, mechanicalReason: d.mechanicalReason });
  try {
    exec('gh', ['pr', 'comment', String(pr), ...(repo ? ['--repo', repo] : []), '--body', body],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const why = String(e?.stderr || e?.message || e).trim().split('\n').pop();
    log(`  human-clearance-carry ${tag}: carry proven but the record write FAILED (${why}) — deferring, no label change\n`);
    return { action: 'defer', applyLabel: null,
      reason: `human clearance carry proven (${d.fromSha.slice(0, 9)}→${d.toSha.slice(0, 9)}) but its durable record could not be written — merge deferred this pass` };
  }
  log(`  human-clearance-carry ${tag}: CARRIED ${d.actor}'s clearance ${d.fromSha.slice(0, 9)}→${d.toSha.slice(0, 9)} (diff ${d.fingerprint.slice(0, 12)}; tier ${d.tier}; ${d.mechanicalReason}) — record posted\n`);
  return { carried: { ...carried, recorded: true } };
}
