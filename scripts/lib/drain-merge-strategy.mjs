import { listAgentsWithReviewJobs } from '../operations/review-job-store.mjs';
import { resolveRunsDirReadOnly } from '../operations/run-store.mjs';
import { mintSessionSlug } from '../conveyor/session-slug.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';
import { redTeamPanelSeatOwed, redTeamOwedOnHead, redTeamOwedFor, redTeamOwedForAcceptedPr } from './review-red-team-policy.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
/**
 * @file scripts/lib/drain-merge-strategy.mjs
 * @description Card xtpxusq — the drain's side of the merge-delivery strategy (`./merge-delivery-policy.mjs`).
 *   `we:scripts/merge-ai-prs.mjs` keeps only small hooks; every decision about HOW a ready PR reaches main lives here.
 *
 *   - `drain-direct` (the standard default): `enqueues()` is false for every repo, so the drain's own `gh pr merge`
 *     path runs exactly as before. The only visible change is ONE log line per pass naming the strategy and the
 *     layer that set it. No state file exists → the queue follow-up makes no `gh` call.
 *   - `github-merge-queue`: for a PR of the drain's LOCAL repo that passed every drain gate this pass, the drain
 *     enqueues through GraphQL `enqueuePullRequest` pinned to the judged head, confirms membership, then
 *     stamps clearance so `merge-gate` can pass couple-whole / blockedBy. It never calls the merge API. GitHub's queue owns freshness, so the
 *     drain's merge-queue freshness refresh is skipped for it. An enqueue failure THROWS: the drain reports it as a
 *     failed land, loudly, and never falls back to merging directly.
 *     Other repos (impl halves in sibling repos) keep `drain-direct`: the policy's tool layer is this repo's
 *     settings, and a sibling repo may not have a merge queue at all.
 *   - Queue follow-up: every enqueued PR is recorded in a state file. Each pass, PRs GitHub has since merged are
 *     added to the pass's `merged` list and `landedThisPass` ONCE (`planQueueFollowUps` against the recorded
 *     followed-up set), so the drain's existing post-land path (local sync, JIT numbering, resolve-on-land, derived
 *     regen) runs for them. A queued PR closed without merging is dropped from the pending list with a log line.
 *     A merged PR leaves `pending` only when `confirmQueueFollowUps` is called after that post-land work SUCCEEDED, so a
 *     crash or failed step in between retries it next pass (the post-land steps are idempotent). Every write of the
 *     state file re-reads it under the land lock (the one `enqueue` already runs inside), so no process's entry is lost.
 *   - The enqueue-clearance stamp is skipped only when the DRAIN's own login already posted the marker for the head;
 *     a marker from any other author never suppresses it (the reader trusts only listed authors).
 *
 *   Manifest strip before land (`needsManifestStripBeforeMerge`) needs no hook: the drain's rebase-drop step runs it
 *   for every landable manifest PR BEFORE the land cascade, whatever the strategy.
 *
 *   Dry run: `WE_DRAIN_MERGE_STRATEGY` overrides the strategy ONLY when the drain runs with `--dry-run`, so the
 *   operator can preview which PRs `github-merge-queue` would enqueue without flipping the live policy. A live
 *   (non-dry-run) pass ignores the variable and says so.
 */
import { labelSignature } from './drain-prestage.mjs';
import { readDrainRedTeamEvidence } from './drain-red-team-evidence.mjs';
import { redTeamEnabled } from './review-red-team-policy.mjs';
import { readDrainQueueSafety, postAcceptRedTeamOwed, redTeamEnqueueHold as redTeamEnqueueHoldAtHead, dequeueSentBack, sendBackReason } from './drain-queue-safety.mjs';
import { readRedTeamDeadlineAction, RED_TEAM_DEADLINE_OVERRIDE } from './red-team-gate.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { isUnderTest } from './under-test.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';
import { numberingProvenAncestors, hasRedTeamEvidence } from './numbering-red-team-alias.mjs';
import { resolveNumberingRedTeamSetting } from './numbering-carry.mjs';
import { defaultPostConflictFinding } from './conflict-finding.mjs';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadMergeDeliveryPolicy, formatMergeDeliverySourcesLine, MERGE_DELIVERY_STRATEGIES } from './merge-delivery-policy.mjs';
import { mergeActionFor, enqueuePr, planQueueFollowUps, REQUIRED_WORKFLOWS_UNSATISFIED, readPinnedChangedFiles, workflowEditHold } from './merge-queue-enqueue.mjs';
import { getRequiredStatusChecks } from './required-status-checks.mjs';
import { readSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { queueFileOverlap, readQueueEntryFiles, completeListedFiles } from './queue-file-overlap.mjs';
import { cardOverlapRelief, readCardOverlapCleanMerge, readQueueTip as defaultReadQueueTip } from './card-overlap-clean-merge.mjs';
import { gitRealFiles, resolveRealFiles as defaultResolveRealFiles } from './pr-real-files.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { createAdaptiveBatching, readQueueFacts } from './merge-queue-adaptive-batching.mjs';
import { activeReserveBlockers, isPriorityLabels, readReserves, writeReserves } from './priority-reserve.mjs';
import { cancelObsoleteQueueRuns } from './merge-queue-obsolete-runs.mjs';
import { cardGroupHold as pureCardGroupHold, readGroupState, resolveCardGroupStatePath } from './card-group.mjs';
import { existsSync } from 'node:fs';

/** #5742: a renumbered head waits on its numbering ancestor's live red team: never requested again, never escaped. */
export const NUMBERING_ALIAS_WAIT = 'post-accept red team pending on the numbering ancestor';
/** Pure request recovery for historical rows that left no usable exact-head result. Never grants admission. */
export function staleRedTeamRequestEligibility({ evidence = {}, repo, pr, head, labels = [], enabled = false, panelSeat = false, skipCardOnly = true,
  reviewAgents = null, reason = '', pending, now = 0, cooldownMin = 5, dryRun = false } = {}) {
  const refuse = reason => ({ eligible: false, reason });
  if (dryRun) return refuse('dry run');
  if (reason?.includes('requiring send-back') || reason?.includes('saved red-team re-check incomplete') || reason?.includes(NUMBERING_ALIAS_WAIT))
    return refuse(reason);
  if (evidence.inFlight || evidence.queued) return refuse('red team in flight or queued');
  if (evidence.noUsableResult !== true) return refuse('no missing usable result proven');
  if (!evidence.recorded && !evidence.attempted && !evidence.untrustedSavedResult) return refuse('no stale row to recover');
  if (!enabled) return refuse('red team disabled');
  if (!labels.some(l => (typeof l === 'string' ? l : l.name) === 'review:accepted')) return refuse('PR not accepted');
  if (evidence.loopPayload?.findings?.read?.netBasis?.rev?.toLowerCase() !== head?.toLowerCase())
    return refuse('review payload does not match head');
  // The label check above verified a live accept: an operator-accepted needs-human head owes the red team too,
  // the same head the hold counts as owed (live gap #5549: held 1680 min with no request ever filed).
  if (!redTeamOwedForAcceptedPr(evidence.loopPayload)
    || !redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read,
      evidence: { scheduled: true, skipCardOnly: evidence.skipCardOnly }, skipCardOnly }))
    return refuse('red team not owed');
  if (panelSeat) {
    const repoKey = repoKeyForSlug(repo);
    const name = repoKey && mintSessionSlug({ kind: 'review', id: pr, repo: repoKey });
    if (!name || !Array.isArray(reviewAgents) || reviewAgents.incomplete?.length)
      return refuse('review job discovery incomplete');
    if (reviewAgents.some(a => !['stopped', 'completed', 'failed'].includes(a.state)
      && (a.name === name || (Number(a.pr) === Number(pr) && a.repo?.toLowerCase() === repo.toLowerCase()))))
      return refuse('review work still active');
  }
  if (pending?.headSha === head) {
    if (pending.requestedAt != null) return refuse('already requested on this head');
    if (pending.requestAttemptedAt != null && now - pending.requestAttemptedAt < cooldownMin * 60_000)
      return refuse('red-team request cooldown');
  }
  return { eligible: true, reason: 'stale rows with no usable result' };
}

export const DRY_RUN_STRATEGY_ENV = 'WE_DRAIN_MERGE_STRATEGY';
/** Env: a JSON settings file read INSTEAD of the declared files for the `mergeDelivery` tool layer (always honoured — how a
 *  test that spawns the real drain arms or pins the strategy). Same shape as `WE_MERGE_QUEUE_SETTINGS_FILE`. */
export const MERGE_DELIVERY_SETTINGS_FILE_ENV = 'WE_MERGE_DELIVERY_SETTINGS_FILE';
export const CLEARANCE_MARKER = 'we-drain-enqueue-clearance';
const CLEARANCE_RE = new RegExp(`<!--\\s*${CLEARANCE_MARKER}\\s+head=([0-9a-f]{7,40})\\s*-->`, 'gi');
const FOLLOWED_UP_CAP = 500;
const COMMENTS_MAX_BUFFER = 256 * 1024 * 1024; // = merge-ai-prs PR_COMMENTS_MAX_BUFFER (that CLI imports this module)
export const FOLLOW_UP_MAX_ATTEMPTS = 5;

export function queueStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'drain-merge-queue-followups.json'); }

export { requestDrainRedTeam, readDrainRedTeamRequests, finishDrainRedTeamRequest } from './drain-red-team-requests.mjs';

/**
 * The settings object the tool layer reads. Hermetic by default, like `merge-queue-hook.mjs#resolveMergeQueueSettings`:
 * inside a test run (`VITEST` / `WE_UNDER_TEST`) the live `scripts/settings/*.json` are NOT read, so flipping the repo's
 * real strategy never changes what a test that spawns the real drain CLI sees. `WE_MERGE_DELIVERY_SETTINGS_FILE` replaces
 * the declared files (and works outside a test run too). An unreadable override reads as "layer not set".
 */
export function readMergeDeliveryToolSettings(env = process.env, warn = (m) => process.stderr.write(`${m}\n`)) {
  const override = String(env?.[MERGE_DELIVERY_SETTINGS_FILE_ENV] ?? '').trim();
  if (override) {
    try { return JSON.parse(readFileSync(override, 'utf8')); }
    catch (e) { warn(`  ⚠ ${MERGE_DELIVERY_SETTINGS_FILE_ENV}=${override} unreadable (${String(e?.message ?? e).split('\n')[0]}) — merge-delivery tool layer treated as not set`); return {}; }
  }
  if (env?.VITEST || env?.WE_UNDER_TEST) return {};
  return readSettings();
}

/**
 * Resolve the drain's policy for this pass. The dry-run override applies only when `dryRun` is true.
 * @returns {{policy:object, note:(string|null)}}
 */
export function resolveDrainMergePolicy({ dryRun = false, env = process.env, load = () => loadMergeDeliveryPolicy({ toolSettings: readMergeDeliveryToolSettings(env) }) } = {}) {
  const policy = load();
  const raw = env?.[DRY_RUN_STRATEGY_ENV];
  if (raw === undefined || raw === '') return { policy, note: null };
  if (!dryRun) return { policy, note: `${DRY_RUN_STRATEGY_ENV}=${raw} ignored (honoured only with --dry-run)` };
  if (!MERGE_DELIVERY_STRATEGIES.includes(raw)) return { policy, note: `${DRY_RUN_STRATEGY_ENV}=${raw} ignored (not one of ${MERGE_DELIVERY_STRATEGIES.join(', ')})` };
  return { policy: { ...policy, strategy: raw, sources: { ...policy.sources, strategy: `dry-run ${DRY_RUN_STRATEGY_ENV}` } }, note: null };
}

/** Whether this resolved pass policy sends local candidates to GitHub's required queue. */
export function queueEnqueueModeFromPolicy(resolved) { return mergeActionFor(resolved.policy) === 'enqueue'; }

/**
 * The queue's required set, through the ONE shared reader (`getRequiredStatusChecks`): its paginated ruleset read
 * unioned with classic protection. Only a `live` read is known to be that full union: a cache entry carries no
 * version, so one written by an older reader (first rules page only, or classic only) or dated in the future would
 * pass as `cache`. `ttlMs: 0` forces the live read (memoized once per pass by the caller); every other source —
 * `cache`, `declared`, `fallback`, `stale-cache`, `unavailable` — and any failure grants no relief.
 */
export function readQueueRequiredChecks({ repo, branch, readRequired = getRequiredStatusChecks } = {}) {
  if (typeof repo !== 'string' || !repo.trim()) return null;
  if (typeof branch !== 'string' || !branch.trim()) return null;
  try {
    const { checks, source } = readRequired({ repo, branch, ttlMs: 0 }) ?? {};
    if (source !== 'live' || !Array.isArray(checks)) return null;
    const unique = [...new Set(checks)];
    if (!unique.length || unique.some(name => typeof name !== 'string' || !name.trim())) return null;
    return unique.sort();
  } catch { return null; }
}

/** Per-pass requirements lookup, confined to local enqueue candidates and their resolved default branch. */
export function createQueueRequiredChecksOf({ queueEnqueueMode, isLocalRepo, localSlug, defaultBranchOf, readChecks = readQueueRequiredChecks, onRead = () => {} }) {
  const memo = new Map();
  return (repo) => {
    if (!queueEnqueueMode || !isLocalRepo(repo)) return null;
    const slug = repo || localSlug;
    const branch = defaultBranchOf(repo);
    if (typeof slug !== 'string' || !slug.trim() || typeof branch !== 'string' || !branch.trim()) return null;
    const key = JSON.stringify([slug, branch]);
    if (!memo.has(key)) {
      const checks = readChecks({ repo: slug, branch });
      memo.set(key, checks);
      onRead(checks);
    }
    return memo.get(key);
  };
}

/** The clearance comment body for one judged head. Pure. */
export function buildClearanceComment(headSha) {
  return `<!-- ${CLEARANCE_MARKER} head=${headSha} -->\n**Drain enqueue clearance** — the drain judged head \`${String(headSha).slice(0, 12)}\` ready (every drain gate passed: couple whole, blockedBy landed) and enqueued it on GitHub's merge queue (xtpxusq). The \`merge-gate\` check reads this for its couple-whole / blocked-by gates.`;
}

/**
 * Does a TRUSTED clearance comment cover `headSha`? Pure. Only comments whose author login is in
 * `trustedAuthors` count; an empty trust list covers nothing (fail closed). For `we:scripts/merge-gate-check.mjs`.
 * @returns {{coversHead:boolean, reason:string}}
 */
export function readEnqueueClearance({ comments = [], headSha, trustedAuthors = [] } = {}) {
  const trusted = new Set((trustedAuthors || []).map((a) => String(a).toLowerCase()).filter(Boolean));
  if (!headSha) return { coversHead: false, reason: 'no head sha to match' };
  if (!trusted.size) return { coversHead: false, reason: 'no trusted clearance authors configured' };
  for (const c of Array.isArray(comments) ? comments : []) {
    const login = String(c?.author?.login ?? c?.user?.login ?? '').toLowerCase();
    if (!trusted.has(login)) continue;
    CLEARANCE_RE.lastIndex = 0;
    let m;
    while ((m = CLEARANCE_RE.exec(String(c?.body ?? ''))) !== null) {
      if (String(headSha).toLowerCase() === m[1].toLowerCase()) return { coversHead: true, reason: `clearance by ${login}` };
    }
  }
  return { coversHead: false, reason: 'no trusted clearance for this head' };
}

/**
 * Has a TRUSTED clearance for `headSha` already been posted? Pure; used only to avoid duplicate stamps. It shares
 * `readEnqueueClearance`'s trust rule on purpose: a marker from anyone else (a PR author planting the string first)
 * must not make the drain skip its own stamp, or the reader would never find a trusted one for that head.
 */
export function hasClearanceFor(comments, headSha, trustedAuthors = []) {
  return readEnqueueClearance({ comments, headSha, trustedAuthors }).coversHead;
}

/** Does ANY comment (any author) carry a clearance marker for `headSha`? Pure; only gates the drain-identity lookup. */
function anyClearanceMarkerFor(comments, headSha) {
  return (Array.isArray(comments) ? comments : []).some((c) => {
    CLEARANCE_RE.lastIndex = 0;
    let m;
    while ((m = CLEARANCE_RE.exec(String(c?.body ?? ''))) !== null) if (m[1].toLowerCase() === String(headSha).toLowerCase()) return true;
    return false;
  });
}

const isEntry = (p) => !!p && typeof p === 'object' && p.num != null;

/**
 * Read the follow-up state. A MISSING file (ENOENT) is a normal empty state; any other read/parse failure is
 * `unreadable:true` — callers must NOT write over it (an empty write would erase every pending follow-up).
 */
export function readQueueState(path, readFile = readFileSync) {
  try {
    const s = JSON.parse(readFile(path, 'utf8'));
    return { pending: Array.isArray(s?.pending) ? s.pending.filter(isEntry) : [], ...(s?.enqueueFailures ? { enqueueFailures: s.enqueueFailures } : {}), ...(s?.redTeamPending ? { redTeamPending: s.redTeamPending } : {}), followedUp: Array.isArray(s?.followedUp) ? s.followedUp.filter((k) => typeof k === 'string') : [], exists: true, unreadable: false };
  } catch (e) { return { pending: [], followedUp: [], exists: false, unreadable: e?.code !== 'ENOENT' }; }
}

function writeQueueState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...(state.enqueueFailures ? { enqueueFailures: state.enqueueFailures } : {}), ...(state.redTeamPending ? { redTeamPending: state.redTeamPending } : {}), pending: state.pending, followedUp: state.followedUp.slice(-FOLLOWED_UP_CAP) }, null, 2)}\n`);
  renameSync(tmp, path);
}

const keyOf = (repo, num) => `${repo || 'cwd'}#${num}`;
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);

/**
 * The per-pass strategy object the drain's hooks call.
 * @param {{dryRun?:boolean, quiet?:boolean, isLocalRepo?:Function, localSlug?:string, exec?:Function,
 *   statePath?:string, resolved?:{policy:object, note:(string|null)}, log?:{write:Function},
 *   readFile?:Function, writeState?:Function, withLock?:Function}} o
 *   `withLock(fn)` runs `fn` under the drain's land-write mutex and returns `{ran, result}` (`ran:false` = refused).
 *   `enqueue()` is itself called INSIDE that mutex by the drain, so it never takes it again; `collectQueueMerged` and
 *   `confirmQueueFollowUps` run outside it and take it for their state write.
 */
export function createDrainMergeStrategy({
  dryRun = false, quiet = false, isLocalRepo = () => true, localSlug = null, exec = execFileSync,
  statePath = queueStatePath(), reservePath = join(dirname(statePath), 'drain-priority-reserve.json'),
  priorityReserve = () => ({ enabled: false, source: 'default' }), resolved = resolveDrainMergePolicy({ dryRun }), log = process.stderr,
  readFile = readFileSync, writeState = writeQueueState, withLock = (fn) => ({ ran: true, result: fn() }),
  postConflictFinding = defaultPostConflictFinding, now = () => Date.now(),
  cancelObsoleteRuns = cancelObsoleteQueueRuns, batching, resolveRealFiles = defaultResolveRealFiles,
  env = process.env, queueSafety, labelProvider, readRedTeamEvidence = readDrainRedTeamEvidence, numberingRedTeamSetting = () => resolveNumberingRedTeamSetting({ env }), requestRedTeam = null, readReviewAgents = listAgentsWithReviewJobs,
  cwd = process.cwd(), // a clone of the local repo: enqueuePr reads the judged commit's change list from it
  cardOverlapCleanMerge, readQueueTip = defaultReadQueueTip, cardMergeRun,
  // xym8nt4 — a source PR of a post-approval card group never enqueues on its own (the combined PR carries it).
  // The SAME path resolver grouping writes through (`resolveCardGroupStatePath`), so an override never splits them.
  cardGroupHold = (c) => {
    const path = resolveCardGroupStatePath(env);
    if (!path || !existsSync(path)) return null;
    return pureCardGroupHold(readGroupState(path), { num: c?.num, repo: c?.repo || localSlug, localSlug,
      files: c?.listedFilesComplete === true ? c.listedFiles : null });
  },
  readGrantScope = standingRulingScope, // PR #5758: the verified standing-ruling scope the red-team gate also reads
  redTeamDeadline, // resolved redTeam.deadlineAction (test seam); read from the cascade when absent
  publishNeedsYou, // operator note publisher; the real needs-you feed outside a test run
} = {}) {
  const { policy, note } = resolved;
  // The red-team readers credit an automatic round grant exactly as the gate does; unreadable = no automatic credit.
  const grantScopeFor = (c, headSha, comments) => {
    try { return readGrantScope({ repo: slugOf(c.repo), pr: { number: c.num, headRefOid: headSha, comments } }) ?? null; } catch { return null; }
  };
  const statusProvider = labelProvider ?? createGhProvider({ exec: (args, opts) => exec('gh', args, opts) });
  const say = (line) => { if (!quiet) log.write(`${line}\n`); };
  // #5742: when the exact head's red-team hold would hold or request, the exact head carries NO red-team trace at
  // all (no run/status/saved evidence, no thread record naming it), and the head moved only by the drain's own
  // numbering commit(s) over an ancestor with red-team evidence (numbering-red-team-alias.mjs), that ancestor's
  // evidence and gate records decide, so a pure renumber never requests a red team or a fresh review. Anything on
  // the exact head (a break, a send-back, a pending recheck) always decides first. Only the git proof is cached;
  // evidence and the thread are re-read on every decision. A failed proof keeps today's exact-head behavior.
  const readRedTeamEvidenceAtHead = readRedTeamEvidence;
  let numberingRedTeam = { value: false, source: 'unresolved' };
  try { numberingRedTeam = numberingRedTeamSetting(); } catch (e) { say(`  ⚠ review.carryRedTeamAcrossNumbering unreadable (${firstLine(e)}) — exact-head red-team evidence only`); }
  let numberingRedTeamLogged = false;
  const numberingProofs = new Map(); // repo#pr@head → proven ancestors, nearest first (git proof only)
  // Read-only probes (recordedHold, yieldTargetHold) never run git; they reuse a proof this pass already made.
  // Unproven: recordedHold falls through (null) to the ordinary enqueue, whose clear answer is the only authority;
  // yieldTargetHold throws, which its caller reads as "cannot tell" and keeps today's yield.
  let redTeamAliasReadOnly = false;
  const ALIAS_UNPROVEN = Symbol('numbering alias unproven in a read-only probe');
  const readOnlyRedTeam = (fn, { fallThrough = false } = {}) => {
    const was = redTeamAliasReadOnly; redTeamAliasReadOnly = fallThrough ? 'fall-through' : true;
    try { return fn(); } catch (e) { if (e === ALIAS_UNPROVEN) return null; throw e; } finally { redTeamAliasReadOnly = was; }
  };
  const threadNamesHead = (comments, head) => (Array.isArray(comments) ? comments : []).some((c) => {
    const body = String(c?.body ?? '');
    return body.toLowerCase().includes(String(head).toLowerCase()) && /red-team|review-verdict-carried/i.test(body);
  });
  const redTeamAliasFor = ({ repo, pr, head, comments, env: e = env, ...exactEvidence }) => {
    const key = `${repo}#${pr}@${head}`;
    if (!numberingRedTeamLogged) { numberingRedTeamLogged = true; say(`  policy · review.carryRedTeamAcrossNumbering=${numberingRedTeam.value} (${numberingRedTeam.source})`); }
    if (!numberingRedTeam.value || !/^[0-9a-f]{40}$/.test(String(head))) return null;
    // The hold's own input carries the exact head's evidence (every call site spreads it); never re-read it here.
    if (hasRedTeamEvidence(exactEvidence) || threadNamesHead(comments, head)) return null;
    let ancestors = numberingProofs.get(key);
    if (!ancestors) {
      if (redTeamAliasReadOnly === 'fall-through') throw ALIAS_UNPROVEN;
      if (redTeamAliasReadOnly) throw new Error(`#${pr} head ${String(head).slice(0, 9)}: numbering alias not yet proven this pass`);
      ancestors = numberingProvenAncestors({ exec, cwd, head });
      numberingProofs.set(key, ancestors);
    }
    for (const { head: ancestor, reason } of ancestors) {
      const evidence = readRedTeamEvidenceAtHead({ repo, pr, head: ancestor, env: e });
      if (!hasRedTeamEvidence(evidence)) continue;
      say(`  merge-queue: #${pr} head ${String(head).slice(0, 9)} moved only by drain numbering over ${ancestor.slice(0, 9)} (${reason}); red-team evidence read from ${ancestor.slice(0, 9)} — no new red team or review`);
      return { head: ancestor, evidence };
    }
    return null;
  };
  // Only the exact head's plain scheduling gap is ever bridged: a break, a send-back or an incomplete re-check on the
  // exact head always decides. Over the ancestor: clear → admit; held while the ancestor's red team is verified
  // queued/running → NUMBERING_ALIAS_WAIT (no request, no escape); anything else → the exact-head reason, so the
  // ordinary request/recovery path runs for the exact head exactly as today.
  const EXACT_GAP = 'post-accept red team has no recorded result on the live head';
  const redTeamEnqueueHold = (o) => {
    const reason = redTeamEnqueueHoldAtHead(o);
    if (reason !== EXACT_GAP) return reason;
    const alias = redTeamAliasFor(o);
    if (!alias) return reason;
    const aliased = redTeamEnqueueHoldAtHead({ ...o, requestPending: false, scheduled: false, inFlight: false, recorded: false, attempted: false,
      queued: false, loopPayload: undefined, skipCardOnly: undefined, ...alias.evidence, head: alias.head });
    if (!aliased) return null;
    // The ancestor's own disposition on identical content (a break, an incomplete re-check) stands as is.
    if (aliased.includes('requiring send-back') || aliased.includes('saved red-team re-check incomplete')) return aliased;
    if (alias.evidence.inFlight || alias.evidence.queued) return `${NUMBERING_ALIAS_WAIT} ${alias.head.slice(0, 9)} (${aliased})`;
    return reason;
  };
  /**
   * Read-modify-write of the shared follow-up state file: under the land lock, RE-READ the file (so an enqueue by
   * another drain process that landed since this pass first read it is kept), apply `fn`, write. A refused lock
   * writes nothing — the next pass redoes it, which every state change here tolerates.
   */
  const mutateState = (what, fn) => {
    let unreadable = false;
    const lock = withLock(() => {
      const st = readQueueState(statePath, readFile);
      if (st.unreadable) { unreadable = true; return false; }
      fn(st); writeState(statePath, { pending: st.pending, followedUp: st.followedUp, ...(st.enqueueFailures ? { enqueueFailures: st.enqueueFailures } : {}), ...(st.redTeamPending ? { redTeamPending: st.redTeamPending } : {}) }); return true;
    });
    if (lock?.ran === false) { say(`  ⚠ merge-queue follow-up state lock not acquired — ${what} not recorded this pass; retried next pass`); return false; }
    if (unreadable) { say(`  ⚠ merge-queue follow-up state ${statePath} is unreadable — ${what} not recorded (file left untouched); fix or remove it`); return false; }
    return true;
  };
  let drainLoginMemo; // undefined = not looked up yet; null = the lookup failed (stay on the stamp-again side)
  const drainLogin = () => {
    if (drainLoginMemo !== undefined) return drainLoginMemo;
    try { drainLoginMemo = String(exec('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim() || null; }
    catch { drainLoginMemo = null; }
    return drainLoginMemo;
  };
  log.write(`  ${formatMergeDeliverySourcesLine(policy)}${dryRun ? ' [dry run]' : ''}\n`);
  if (note) log.write(`  ⚠ merge-delivery: ${note}\n`);
  const safety = queueSafety ?? readDrainQueueSafety({ env, log: line => log.write(`  ${line}\n`) });
  let cardMergeSetting = cardOverlapCleanMerge;
  if (!cardMergeSetting) {
    try { cardMergeSetting = readCardOverlapCleanMerge({ env, log: line => log.write(`  ${line}\n`) }); }
    catch { cardMergeSetting = { enabled: false, source: 'unreadable' }; }
  }
  /** A card-only overlap that dry-merges cleanly onto the queue tip is not a hold; anything else keeps it. */
  const cardOverlapEnqueues = (c, headSha, overlap, queue) => {
    if (!cardMergeSetting.enabled || !overlap.overlap) return false;
    const r = cardOverlapRelief({ num: c.num, headSha, overlap, queued: queue.entries.map(entry => ({ num: entry.num, headSha: entry.headSha ?? null })), repo: slugOf(c.repo), setting: cardMergeSetting,
      exec, cwd, readTip: readQueueTip, ...(cardMergeRun ? { run: cardMergeRun } : {}) });
    if (r.line) say(`  ${r.line}`);
    return r.relieve === true;
  };
  const deadline = redTeamDeadline ?? readRedTeamDeadlineAction({ env, log: line => log.write(`  ${line}\n`) });
  const deadlineAction = deadline.value?.deadlineAction ?? 'requeue-then-hold';
  // The real operator feed is never written from a test run unless the test injects its own publisher.
  const publishNote = publishNeedsYou ?? (isUnderTest(env) ? null : item => publishAttention(item));
  const pendingOutcome = (c, pending, quiet = false) => {
    const maxMin = safety.value.redTeamPendingMaxMin ?? 45;
    const healthSmell = now() - pending.firstPendingAt >= maxMin * 60_000;
    if (healthSmell && !quiet) log.write(`  health smell: ${slugOf(c.repo)}#${c.num} red-team-pending on ${pending.headSha} for ${Math.floor((now() - pending.firstPendingAt) / 60_000)} min (redTeamPendingMaxMin=${maxMin}, ${safety.sources?.redTeamPendingMaxMin ?? 'standard'})\n`);
    if (!quiet) say(`  merge-queue: defer #${c.num}: ${pending.reason}`);
    return { enqueued: false, deferred: true, kind: 'red-team-pending', reason: pending.reason, healthSmell,
      ...(pending.deadlineHeldAt != null ? { deadlineHeld: true } : {}) };
  };
  const readLive = (repo, num) => JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', slugOf(repo), '--json', 'headRefOid,labels,reviews'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  // The complete thread as pages. The drain's own comment reader allows 256 MiB: a long thread must not hit the 1 MiB default.
  const readThreadPages = (repo, num) => JSON.parse(exec('gh', ['api', '--paginate', '--slurp', `repos/${slugOf(repo)}/issues/${num}/comments`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: COMMENTS_MAX_BUFFER, timeout: 120_000 }));
  const removeSentBack = (repo, num, labels) => {
    if (dryRun || !safety.value.dequeueOnSendBack || !Array.isArray(labels)) return;
    const reason = sendBackReason(labels);
    if (reason) dequeueSentBack({ repo: slugOf(repo), pr: num, reason, exec, log: say });
  };
  // Shared request eligibility: deferred requests must obey the same recovery and cooldown rules as enqueue.
  const redTeamRequestEligibility = (c, headSha, live, evidence, pending) => {
    const sameHead = pending?.headSha === headSha;
    // No scheduler artifact exists on this head. Ask the ordinary review dispatcher promptly;
    // preserve card-only exemptions and the scheduler kill switches.
    const panelSeat = redTeamPanelSeatOwed(evidence.loopPayload, env);
    let orphanedPanelSeat = false;
    if (panelSeat && redTeamOwedFor(evidence.loopPayload) && redTeamEnabled(env) && !evidence.recorded && !evidence.attempted
      && !evidence.inFlight && !evidence.queued && !evidence.untrustedSavedResult
      && evidence.loopPayload?.findings?.read?.netBasis?.rev?.toLowerCase() === headSha.toLowerCase()
      && live.labels.some(l => (typeof l === 'string' ? l : l.name) === 'review:accepted')
      && redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read,
        evidence: { ...evidence, scheduled: true }, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly })) {
      // Owed is policy, not a queue entry. An older accepted head has no job left to seat it.
      // Unknown job discovery stays held; the consumer repeats the ordinary dispatch guards.
      try {
        const repoKey = repoKeyForSlug(slugOf(c.repo));
        const name = repoKey && mintSessionSlug({ kind: 'review', id: c.num, repo: repoKey });
        const agents = readReviewAgents();
        orphanedPanelSeat = !!name && Array.isArray(agents) && !agents.incomplete?.length
          && !agents.some(a => !['stopped', 'completed', 'failed'].includes(a.state)
            && (a.name === name || (Number(a.pr) === c.num && a.repo?.toLowerCase() === slugOf(c.repo).toLowerCase())));
      } catch { /* cannot prove no review work will seat this head */ }
    }
    const neverScheduled = (panelSeat ? orphanedPanelSeat : evidence.scheduled === false) && !evidence.recorded && !evidence.attempted
      && !evidence.inFlight && !evidence.queued && redTeamEnabled(env)
      && live.labels.some(l => (typeof l === 'string' ? l : l.name) === 'review:accepted')
      && postAcceptRedTeamOwed(evidence.loopPayload, env, { scheduled: true, skipCardOnly: evidence.skipCardOnly })
      && typeof requestRedTeam === 'function';
    const cooldownMin = safety.value.redTeamRequestCooldownMin ?? 5;
    const cooldownSource = safety.sources?.redTeamRequestCooldownMin ?? 'standard';
    let reviewAgents = null;
    if (panelSeat && evidence.noUsableResult && (evidence.recorded || evidence.attempted || evidence.untrustedSavedResult)) {
      try { reviewAgents = readReviewAgents(); } catch { /* unknown jobs remain held */ }
    }
    const staleRequest = staleRedTeamRequestEligibility({ evidence, repo: slugOf(c.repo), pr: c.num,
      head: headSha, labels: live.labels, enabled: redTeamEnabled(env), panelSeat,
      skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly, reviewAgents, pending, now: now(), cooldownMin, dryRun });
    const requestDue = (neverScheduled || (staleRequest.eligible && typeof requestRedTeam === 'function')) && !(sameHead && pending.requestedAt != null)
      && (!sameHead || pending.requestAttemptedAt == null || now() - pending.requestAttemptedAt >= cooldownMin * 60_000);
    return { sameHead, panelSeat, neverScheduled, staleRequest, requestDue, cooldownMin, cooldownSource };
  };
  const enqueueMode = mergeActionFor(policy) === 'enqueue';
  const adaptiveBatching = () => batching ??= createAdaptiveBatching({ repo: localSlug, exec, dryRun, log: say });
  const enqueues = (repo) => enqueueMode && !!isLocalRepo(repo);
  const slugOf = (repo) => repo || localSlug;
  const canonKey = (repo, num) => keyOf(slugOf(repo), num);

  // Use the strategy's executor so injected GitHub/git IO stays hermetic too.
  const realFilesRun = (cmd, args, options) => {
    try {
      return { status: 0, stdout: exec(cmd, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) { return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }; }
  };
  const restampCardOnly = (c, headSha, evidence) => {
    if (evidence.recorded || evidence.attempted || evidence.inFlight || evidence.queued
      || evidence.loopPayload?.findings?.read?.netBasis?.rev?.toLowerCase() === headSha.toLowerCase()) return false;
    try {
      const files = gitRealFiles({ pr: { headRefName: c.headRef, baseRefName: c.baseRefName || 'main', headRefOid: headSha },
        repo: slugOf(c.repo), cwd, run: realFilesRun });
      return Array.isArray(files) && files.length > 0 && isCardOnlyDiff(files);
    } catch { return false; }
  };
  // One log budget covers candidate and queue resolutions for an admission decision.
  const realFilesOf = ({ num, repo, view }, decision) => {
    const ghFiles = view.files;
    try {
      const result = resolveRealFiles({ pr: view, repo: slugOf(repo), ghFiles, cwd, run: realFilesRun });
      if (result.source === 'git' && result.disagreed && !decision.logged) {
        decision.logged = true;
        say(`  merge-queue file-overlap: real files for #${num} (git net diff: ${result.files.length} files vs GitHub ${Array.isArray(ghFiles) ? ghFiles.length : 'unknown'})`);
      }
      // Retain the strict completeness/shape checks for conservative GitHub fallback.
      return result.source === 'github' && completeListedFiles(ghFiles) === null ? null : result.files ?? null;
    } catch { return completeListedFiles(ghFiles); }
  };
  const candidateFilesOf = (c, headSha, decision) => realFilesOf({ num: c.num, repo: c.repo,
    view: { headRefName: c.headRef, baseRefName: c.baseRefName || 'main', headRefOid: headSha,
      files: c.listedFilesComplete === true ? c.listedFiles : null } }, decision);
  const queueResolver = decision => entry => realFilesOf(entry, decision);

  const overlapCache = new Map();
  const cachedQueue = (repo, decision) => {
    const cached = overlapCache.get(repo);
    const at = now();
    const queue = cached && at >= cached.at && at - cached.at < 30_000
      ? cached.queue : readQueueEntryFiles({ repo, exec, resolveFiles: queueResolver(decision) });
    if (!queue.error && queue !== cached?.queue) overlapCache.set(repo, { at, queue });
    return queue;
  };
  const mutateReserves = (fn, locked = false) => {
    try {
      const write = () => {
        const reserves = readReserves(reservePath);
        if (fn(reserves)) writeReserves(reservePath, reserves);
      };
      if (locked) write(); else withLock(write);
    } catch { /* Reservations are best effort; failed IO never wedges the drain. */ }
  };
  const stampReserve = (c, headSha, files, locked = false) => {
    if (dryRun || !priorityReserve().enabled || !isPriorityLabels(c.prLabels) || !headSha) return;
    mutateReserves(reserves => {
      const key = keyOf(c.repo, c.num);
      const previous = reserves[key];
      const retainRt = previous?.rt && previous.headSha === headSha && !rtExpired(previous);
      reserves[key] = { num: c.num, repo: c.repo ?? null, headSha, files, at: now(),
        ...(retainRt ? { rt: true, rtSince: previous.rtSince, maxMs: previous.maxMs } : {}) };
      return true;
    }, locked);
  };
  const dropReserve = c => {
    if (dryRun || !priorityReserve().enabled || !isPriorityLabels(c.prLabels)) return;
    mutateReserves(reserves => {
      const key = keyOf(c.repo, c.num);
      if (!reserves[key]) return false;
      delete reserves[key]; return true;
    }, true);
  };
  const rtSendBack = reason => reason?.includes('requiring send-back') || reason?.includes('saved red-team re-check incomplete');
  const rtExpired = stamp => {
    const maxMs = Math.min(stamp.maxMs, (priorityReserve().maxMin ?? 90) * 60_000);
    return !Number.isFinite(stamp.rtSince) || !Number.isFinite(maxMs) || maxMs <= 0
      || now() < stamp.rtSince || now() - stamp.rtSince >= maxMs;
  };
  // Preserve producer evidence (including skipCardOnly) and request state for every admission reason.
  // PR #5758: every red-team hold read credits the verified standing-ruling scope, exactly as the gate does.
  const enqueueRedTeamReason = (c, headSha, evidence, comments, requestPending, standingRuling = grantScopeFor(c, headSha, comments)) => redTeamEnqueueHold({
    ...evidence, realFilesCardOnly: restampCardOnly(c, headSha, evidence), requestPending, comments, repo: slugOf(c.repo), pr: c.num, head: headSha, env, standingRuling,
  });
  const reserveRedTeamReason = (c, headSha, live) => {
    const evidence = readRedTeamEvidence({ repo: slugOf(c.repo), pr: c.num, head: headSha, env });
    const pages = readThreadPages(c.repo, c.num);
    if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw new Error('red-team comments unreadable');
    const pending = readQueueState(statePath, readFile).redTeamPending?.[keyOf(c.repo, c.num)];
    const { sameHead, neverScheduled } = redTeamRequestEligibility(c, headSha, live, evidence, pending);
    return enqueueRedTeamReason(c, headSha, evidence, pages.flat(), neverScheduled || (sameHead && pending.requestedAt != null));
  };
  // Scheduling only: this stamp grants no enqueue authority and never clears a hold.
  const priorityReserveStamp = (c, headSha, locked = false) => {
    const setting = priorityReserve();
    if (dryRun || !setting.enabled || !enqueues(c.repo) || !isPriorityLabels(c.prLabels) || !headSha) return;
    mutateReserves(reserves => {
      const key = keyOf(c.repo, c.num);
      const previous = reserves[key];
      const drop = () => { if (!previous?.rt) return false; delete reserves[key]; return true; };
      const live = JSON.parse(exec('gh', ['pr', 'view', String(c.num), '--repo', slugOf(c.repo), '--json', 'state,headRefOid,labels,reviews'],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
      const labels = live.labels?.map(l => typeof l === 'string' ? l : l?.name) ?? [];
      if (live.state !== 'OPEN' || live.headRefOid !== headSha || !labels.includes('ready-to-merge')
        || !labels.includes('review:accepted') || !isPriorityLabels(labels) || sendBackReason(labels)
        || (previous?.rt && (previous.headSha !== headSha || rtExpired(previous)))) return drop();
      const reason = reserveRedTeamReason(c, headSha, live);
      if (rtSendBack(reason) || (setting.maxMin ?? 90) <= 0) return drop();
      if (!safety.value.waitForRedTeamBeforeEnqueue || !reason) return false;
      const files = candidateFilesOf(c, headSha, {});
      if (files === null) return false;
      reserves[key] = { num: c.num, repo: c.repo ?? null, headSha, files, at: now(), rt: true,
        rtSince: previous?.rt ? previous.rtSince : now(), maxMs: (setting.maxMin ?? 90) * 60_000 };
      return true;
    }, locked);
  };
  const reserveLiveCache = new Map();
  const priorityReserveHold = (c, headSha, locked = false, decision = {}) => {
    const setting = priorityReserve();
    if (!setting.enabled || dryRun || !enqueues(c.repo) || isPriorityLabels(c.prLabels)) return null;
    const files = candidateFilesOf(c, headSha, decision);
    if (files === null) return null;
    const reserves = readReserves(reservePath);
    const invalid = new Set();
    const includeCards = safety.value.queueFileOverlapIncludesCards ?? true;
    const blockers = activeReserveBlockers({ candidate: { num: c.num, key: keyOf(c.repo, c.num), files },
      reserves, now: now(), includeCards, isValid: stamp => {
        if (slugOf(stamp.repo) !== slugOf(c.repo)) return false;
        const key = keyOf(stamp.repo, stamp.num);
        if (stamp.rt && rtExpired(stamp)) { invalid.add(key); return false; }
        let live;
        const cached = reserveLiveCache.get(key);
        try {
          if (!stamp.rt && cached && now() >= cached.at && now() - cached.at < 30_000) live = cached.live;
          else {
            live = JSON.parse(exec('gh', ['pr', 'view', String(stamp.num), '--repo', slugOf(stamp.repo), '--json', 'state,headRefOid,labels'],
              { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
            if (!live?.state || !live.headRefOid || !Array.isArray(live.labels)) return false;
            reserveLiveCache.set(key, { at: now(), live });
          }
          const labels = live.labels.map(l => typeof l === 'string' ? l : l?.name);
          if (live.state !== 'OPEN' || live.headRefOid !== stamp.headSha || !labels.includes('ready-to-merge')
            || !isPriorityLabels(live.labels) || sendBackReason(live.labels)
            || (stamp.rt && (!labels.includes('review:accepted') || rtSendBack(reserveRedTeamReason({ repo: stamp.repo, num: stamp.num }, stamp.headSha, live))))) { invalid.add(key); return false; }
          const queue = cachedQueue(slugOf(stamp.repo), decision);
          if (queue.error) return false;
          if (queue.entries.some(e => e.num === stamp.num)) { invalid.add(key); return false; }
          return true;
        } catch { return false; }
      } });
    if (invalid.size) mutateReserves(current => {
      let changed = false;
      for (const key of invalid) if (JSON.stringify(current[key]) === JSON.stringify(reserves[key])) {
        delete current[key]; changed = true;
      }
      return changed;
    }, locked);
    if (!blockers.length) return null;
    const first = blockers[0];
    const shared = queueFileOverlap({ candidateFiles: files, queuedEntries: [first], includeCards }).with[0].files[0];
    say(`reserved files for priority #${first.num}: blocks #${c.num} - drain.priorityReservesFiles=on (${setting.source})${first.rt ? `; priorityReserveMaxMin=${setting.maxMin ?? 90} (${setting.maxMinSource ?? 'standard'})` : ''}`);
    return { kind: 'priority-reserve', reason: `priority #${first.num} reserves ${shared}`, deferred: true };
  };
  const pickQueueOverlap = (c, candidateFiles, queue) => {
    const overlap = queueFileOverlap({ candidateFiles,
      queuedEntries: queue.entries.filter(entry => entry.num !== c.num),
      includeCards: safety.value.queueFileOverlapIncludesCards ?? true });
    const files = [...new Set(overlap.with.flatMap(entry => entry.files))].slice(0, 3);
    return { ...overlap, reason: `${overlap.with.map(entry => `#${entry.num}`).join(',')} share ${files.join(', ')}` };
  };

  return {
    policy,
    strategy: policy.strategy,
    enqueues,
    priorityReserveHold,
    priorityReserveStamp,
    /** GitHub's queue re-tests every entry against the queue tip, so the drain's freshness refresh is skipped. */
    queueOwnsFreshness: (repo) => enqueues(repo),

    /** Live open rows are unfiltered by ready-to-merge; also covers entries not in our follow-up file. */
    dequeueSendBacks(rows = [], repo = null) {
      if (dryRun || !enqueueMode || !safety.value.dequeueOnSendBack || !isLocalRepo(repo)) return;
      const candidates = rows.filter(row => Array.isArray(row.labels) && sendBackReason(row.labels));
      if (!candidates.length) return;
      // Discover membership once, before any per-PR read. An incomplete discovery retries next pass;
      // never replace it with an API sweep of every non-ready open PR.
      const queue = readQueueFacts({ repo: slugOf(repo), exec: (cmd, args, opts) => exec(cmd, args, { ...opts, timeout: 60_000 }) });
      if (queue.error) { say(`  ⚠ merge-queue discovery failed (${queue.error}) — dequeue sweep retried next pass`); return; }
      for (const row of candidates) {
        if (!queue.inQueue.has(Number(row.number))) continue;
        try { removeSentBack(repo, row.number, readLive(repo, row.number).labels); }
        catch (e) { say(`  ⚠ merge-queue dequeue #${row.number} failed (${firstLine(e)}) — retried next pass`); }
      }
    },

    /** Dry run: name exactly what this strategy would do with the ordered ready set. Calls no GitHub API. */
    reportDryRun(ordered = []) {
      if (!enqueueMode) return { enqueue: [], direct: [] };
      const enqueue = ordered.filter((c) => enqueues(c.repo));
      const direct = ordered.filter((c) => !enqueues(c.repo));
      const tag = (c) => `${c.repo ? `${c.repo}#` : '#'}${c.num}`;
      say(`  github-merge-queue: would ENQUEUE ${enqueue.length ? enqueue.map(tag).join(', ') : '(none)'} — merge API not called`);
      if (direct.length) say(`  github-merge-queue: would merge directly (repo outside this policy) ${direct.map(tag).join(', ')}`);
      const pending = readQueueState(statePath, readFile).pending;
      if (pending.length) say(`  github-merge-queue: ${pending.length} enqueued PR(s) awaiting GitHub's merge: ${pending.map((p) => keyOf(p.repo, p.num)).join(', ')}`);
      return { enqueue, direct };
    },

    /**
     * Enqueue one candidate at its judged head. Never merges. Throws on failure (the caller's catch reports it as a
     * failed land). `comments` = the PR's comments already read this turn (for the clearance dedupe).
     */
    prestage(c, headSha) {
      try {
        const live = readLive(c.repo, c.num);
        if (live.headRefOid !== headSha || !Array.isArray(live.labels)) return { allowed: false, reason: 'live state unreadable' };
        const held = sendBackReason(live.labels);
        if (held) return { allowed: false, reason: held };
        const base = c.baseRefName || 'main';
        const pinned = readPinnedChangedFiles({ headSha, base, cwd, exec, withBaseSha: true });
        const surface = workflowEditHold({ files: pinned.files, expectedCount: pinned.files?.length });
        if (surface.hold) return { allowed: false, reason: surface.reason, humanOnlySurface: surface };
        // Bound to the base branch and tip it was read against: enqueuePr re-reads the diff if either differs live.
        const preparedSurface = { headSha, base, baseSha: pinned.baseSha ?? null, files: pinned.files };
        const pages = readThreadPages(c.repo, c.num);
        if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) return { allowed: false, reason: 'red-team comments unreadable' };
        const comments = pages.flat();
        if (!safety.value.waitForRedTeamBeforeEnqueue) return { allowed: true, safety: safety.value, labels: labelSignature(live.labels), comments, preparedSurface };
        const evidence = readRedTeamEvidence({ repo: slugOf(c.repo), pr: c.num, head: headSha, env });
        const reason = redTeamEnqueueHold({ ...evidence, realFilesCardOnly: restampCardOnly(c, headSha, evidence), comments: pages.flat(), pr: c.num, head: headSha, repo: slugOf(c.repo), env,
          standingRuling: grantScopeFor(c, headSha, pages.flat()) });
        return { allowed: !reason, reason, safety: safety.value, labels: labelSignature(live.labels), comments, preparedSurface };
      } catch { return { allowed: false, reason: 'red-team evidence unreadable' }; }
    },
    /** Overlap hint; reserve writes take the land mutex, and enqueue re-reads the queue under it. */
    queueOverlapHold(c, headSha) {
      if (!enqueues(c.repo)) return null;
      const decision = {};
      const candidateFiles = candidateFilesOf(c, headSha, decision);
      if (candidateFiles === null) return null;
      const repo = slugOf(c.repo);
      const queue = cachedQueue(repo, decision);
      if (queue.error) return null;
      const overlap = pickQueueOverlap(c, candidateFiles, queue);
      if (overlap.overlap && cardOverlapEnqueues(c, headSha, overlap, queue)) return null;
      if (overlap.overlap) stampReserve(c, headSha, candidateFiles);
      return overlap.overlap ? { kind: 'queue-file-overlap', reason: overlap.reason, deferred: true } : null;
    },
    /** Request only: the queue-file-overlap hold and every enqueue gate remain in force. */
    requestRedTeamWhileDeferred(c, headSha) {
      if (!enqueueMode || dryRun || typeof requestRedTeam !== 'function'
        || !safety.value.waitForRedTeamBeforeEnqueue || !headSha) return null;
      try {
        const lock = withLock(() => {
          const before = readQueueState(statePath, readFile);
          if (before.unreadable) return null;
          const live = readLive(c.repo, c.num);
          if (live.headRefOid !== headSha || !Array.isArray(live.labels)
            || !live.labels.some(l => (typeof l === 'string' ? l : l.name) === 'review:accepted')) return null;
          if (sendBackReason(live.labels)) return { requested: false };
          const evidence = readRedTeamEvidence({ repo: slugOf(c.repo), pr: c.num, head: headSha, env });
          const key = keyOf(c.repo, c.num);
          const pending = before.redTeamPending?.[key];
          const { sameHead, neverScheduled, requestDue, cooldownMin, cooldownSource }
            = redTeamRequestEligibility(c, headSha, live, evidence, pending);
          const pages = readThreadPages(c.repo, c.num);
          if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) return null;
          const reason = enqueueRedTeamReason(c, headSha, evidence, pages.flat(), neverScheduled || (sameHead && pending.requestedAt != null));
          if (!reason || reason.includes('requiring send-back') || reason.includes('saved red-team re-check incomplete') || reason.includes(NUMBERING_ALIAS_WAIT)) return { requested: false };
          if (!requestDue) {
            if (neverScheduled && sameHead && pending.requestedAt == null)
              log.write(`  merge-queue: #${c.num} red-team request cooldown: redTeamRequestCooldownMin=${cooldownMin} (${cooldownSource})\n`);
            return { requested: false };
          }
          const at = now();
          const wait = sameHead ? { ...pending, requestAttemptedAt: at } : {
            headSha, firstPendingAt: at, retryAt: at, commentCount: 0, checkedAt: at,
            reason: 'red team requested while queue-file-overlap deferred', requestAttemptedAt: at,
          };
          before.redTeamPending ??= {};
          before.redTeamPending[key] = wait;
          writeState(statePath, before);
          log.write(`  merge-queue: requesting red team for #${c.num} on ${headSha}: redTeamRequestCooldownMin=${cooldownMin} (${cooldownSource})\n`);
          let requested = false;
          try { requested = requestRedTeam({ repo: slugOf(c.repo), pr: c.num, head: headSha, loopPayload: evidence.loopPayload })?.requested === true; }
          catch (e) { log.write(`  red-team request failed #${c.num}: ${firstLine(e)}\n`); }
          if (requested) {
            wait.requestedAt = now();
            writeState(statePath, before);
            log.write(`  merge-queue: requested red team for #${c.num} on ${headSha} through review dispatch\n`);
          }
          return { requested };
        });
        return lock?.ran === false ? null : lock?.result ?? null;
      } catch (e) {
        say(`  red-team deferred request failed #${c.num}: ${firstLine(e)}`);
        return null;
      }
    },
    /** Read-only pre-check outside the land mutex, only for a recorded wait on this exact head.
     * A clear result is NOT authorization; enqueue re-reads state and runs every live gate under the mutex.
     * A hold needing refresh or any side effect falls through to that ordinary enqueue path. */
    recordedHold(c, headSha) {
      if (!enqueues(c.repo) || !headSha) return null;
      const state = readQueueState(statePath, readFile);
      if (state.redTeamPending?.[keyOf(c.repo, c.num)]?.headSha !== headSha) return null;
      return readOnlyRedTeam(() => this.enqueue(c, headSha, { holdOnly: true }), { fallThrough: true });
    },
    /** Read-only: is a would-be overlap-yield TARGET held by the post-accept red-team gate on this exact head?
     * `{kind, reason}` = held; `null` = no recorded red-team hold on this head (it may still enqueue, so waiters
     * keep yielding). Throws when it cannot tell; the caller then keeps today's yield (fail closed).
     * Never writes state, labels, refs or requests: it runs enqueue's own red-team rule on GitHub reads only.
     * Card-only relief and request state are tried both ways; a split answer throws (keeps the yield). */
    yieldTargetHold(c, headSha) { return readOnlyRedTeam(() => this.yieldTargetHoldAtHead(c, headSha)); },
    yieldTargetHoldAtHead(c, headSha) {
      if (!enqueues(c.repo) || !safety.value.waitForRedTeamBeforeEnqueue) return null;
      if (!headSha) throw new Error('yield target has no head sha');
      const state = readQueueState(statePath, readFile);
      if (state.unreadable) throw new Error(`follow-up state ${statePath} is unreadable`);
      const rows = state.redTeamPending || {};
      const keys = [keyOf(c.repo, c.num), keyOf(null, c.num), keyOf(localSlug, c.num)];
      // Enqueue reads ONE key, and which one (cwd# or owner/name#) depends on how the pass named the repo. So every
      // key it could read must hold a record on this head before the probe answers; a partial set is unknown.
      const records = [...new Set(isLocalRepo(c.repo) ? keys : [keyOf(c.repo, c.num)])].map(k => rows[k]);
      const onHead = records.filter(p => p?.headSha === headSha);
      if (!onHead.length) return null;
      if (onHead.length !== records.length) throw new Error('red-team wait is recorded under only some of the keys enqueue may read');
      const live = readLive(c.repo, c.num);
      if (live.headRefOid !== headSha || !Array.isArray(live.labels)) throw new Error('live head or labels do not match the listed state');
      const sent = sendBackReason(live.labels);
      if (sent) return { kind: 'sent-back', reason: sent };
      // runsDir resolved without the first-use legacy migration (which moves files); it throws when that is owed.
      const evidence = readRedTeamEvidence({ repo: slugOf(c.repo), pr: c.num, head: headSha, env, runsDir: resolveRunsDirReadOnly() });
      const pages = readThreadPages(c.repo, c.num);
      if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw new Error('red-team comments unreadable');
      // No agent/job listing here: those readers prune records and write caches. Instead every input the probe
      // cannot read for free is tried both ways, and the target counts as blocked only when EVERY variant holds.
      // A split answer is unknown and throws, so the caller keeps the yield (fail closed).
      // Every record enqueue might read (cwd# or owner/name#) must agree before the request state counts as settled.
      const requestFixed = onHead.every(p => p.requestedAt != null);
      const settled = evidence.recorded || evidence.attempted || evidence.inFlight || evidence.queued
        || evidence.loopPayload?.findings?.read?.netBasis?.rev?.toLowerCase() === headSha.toLowerCase();
      const variants = [];
      for (const requestPending of requestFixed ? [true] : [false, true]) {
        for (const realFilesCardOnly of settled ? [false] : [false, true]) {
          variants.push(redTeamEnqueueHold({ ...evidence, realFilesCardOnly, requestPending,
            comments: pages.flat(), repo: slugOf(c.repo), pr: c.num, head: headSha, env }));
        }
      }
      const held = variants.filter(Boolean).length;
      if (held && held !== variants.length) throw new Error('red-team hold depends on state this read-only probe cannot settle');
      const reason = held ? variants[0] : null;
      if (!reason) return null;
      // Blocked only where enqueue's own path certainly stops: a send-back class reason, a request already made,
      // a saved/attempted/untrusted result, or no operator merge-without-result override. Only with that override can a
      // held reason still enqueue, so it is unknown (keep the yield).
      const stops = reason.includes('requiring send-back') || reason.includes('saved red-team re-check incomplete') || reason.includes(NUMBERING_ALIAS_WAIT)
        || requestFixed || evidence.untrustedSavedResult || evidence.recorded || evidence.attempted
        // drain.enqueueWhenRedTeamNeverScheduled is retired: only the named operator env override can still enqueue.
        || !(deadlineAction === RED_TEAM_DEADLINE_OVERRIDE && deadline.operatorOverride?.by);
      if (!stops) throw new Error('red-team hold may still take the operator merge-without-result override');
      return { kind: 'red-team-pending', reason };
    },
    enqueue(c, headSha, { comments = null, prepared = null, holdOnly = false } = {}) {
      if (!enqueues(c.repo)) throw new Error('enqueue called for a repo outside github-merge-queue');
      if (dryRun) throw new Error('enqueue refused in dry run');
      if (!headSha) throw new Error('github-merge-queue: no pinned head — refusing to enqueue (and NOT merging directly)');
      const grouped = cardGroupHold(c);
      if (grouped) { say(`  merge-queue: defer #${c.num}: ${grouped.reason}`); return { enqueued: false, deferred: true, ...grouped }; }
      const preparedAdmission = prepared?.allowed === true && JSON.stringify(prepared.safety) === JSON.stringify(safety.value);
      if (prepared != null && !preparedAdmission) return { fallback: true };
      // An unreadable state file would be overwritten with just this PR once enqueued, erasing every other pending follow-up.
      const before = readQueueState(statePath, readFile);
      if (before.unreadable) throw new Error(`github-merge-queue: follow-up state ${statePath} is unreadable — refusing to enqueue (and NOT merging directly); fix or remove it`);
      const key = keyOf(c.repo, c.num);
      const previous = before.enqueueFailures?.[key];
      if (previous?.headSha === headSha && previous.retryAt > now()) {
        return { enqueued: false, deferred: true, kind: 'enqueue-backoff', reason: previous.error, healthSmell: !!previous.healthSmell };
      }
      const live = readLive(c.repo, c.num);
      if (live.headRefOid !== headSha || !Array.isArray(live.labels)) return { enqueued: false, deferred: true, kind: 'live-state-unreadable', reason: 'live head or labels do not match the judged state' };
      if (preparedAdmission && prepared.labels !== labelSignature(live.labels)) return { fallback: true };
      const held = sendBackReason(live.labels);
      if (held) {
        if (holdOnly && safety.value.dequeueOnSendBack) return null; // dequeue belongs to locked enqueue too
        if (!holdOnly) removeSentBack(c.repo, c.num, live.labels);
        return { enqueued: false, deferred: true, kind: 'sent-back', reason: held };
      }
      // Head-bound file preparation is reusable; authorization evidence is always live.
      let syncLabelsAfterEnqueue = null;
      if (safety.value.waitForRedTeamBeforeEnqueue) {
        const evidence = readRedTeamEvidence({ repo: slugOf(c.repo), pr: c.num, head: headSha, env });
        const pending = before.redTeamPending?.[key];
        const { sameHead, panelSeat, neverScheduled, staleRequest, requestDue, cooldownMin, cooldownSource }
          = redTeamRequestEligibility(c, headSha, live, evidence, pending);
        if (neverScheduled && sameHead && pending.requestedAt == null && !requestDue)
          log.write(`  merge-queue: #${c.num} red-team request cooldown: redTeamRequestCooldownMin=${cooldownMin} (${cooldownSource})\n`);
        const overdue = sameHead && now() - pending.firstPendingAt >= (safety.value.redTeamPendingMaxMin ?? 45) * 60_000;
        const observation = createHash('sha256').update(JSON.stringify({ comments, reviews: live.reviews ?? [], scheduled: !!evidence.scheduled, inFlight: !!evidence.inFlight, queued: !!evidence.queued, recorded: !!evidence.recorded, attempted: !!evidence.attempted })).digest('hex');
        const newComment = pending?.observation ? observation !== pending.observation
          : Array.isArray(comments) && comments.length > (pending?.commentCount ?? 0);
        // At the deadline recheck evidence and comments even if the normal retry backoff is longer.
        if (!preparedAdmission && sameHead && pending.retryAt > now() && !newComment && !requestDue
          && !(overdue && pending.reason.includes('no recorded result')
            && (pending.checkedAt ?? pending.firstPendingAt) < pending.firstPendingAt + (safety.value.redTeamPendingMaxMin ?? 45) * 60_000)) {
          log.write(`  merge-queue: #${c.num} red-team-pending backoff until ${new Date(pending.retryAt).toISOString()} (head and review/comment evidence unchanged)\n`);
          if (!holdOnly) priorityReserveStamp(c, headSha, true);
          return pendingOutcome(c, pending, true);
        }
        // Refreshing the hold can update labels, dispatch work, or write shared state. Leave all of that
        // to ordinary enqueue under withLandWriteLock, including its fresh state/head reads.
        if (holdOnly) return null;
        const pages = readThreadPages(c.repo, c.num);
        if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw new Error('red-team admission: unreadable complete comments');
        const standingRuling = grantScopeFor(c, headSha, pages.flat());
        const reason = enqueueRedTeamReason(c, headSha, evidence, pages.flat(), neverScheduled || (sameHead && pending.requestedAt != null), standingRuling);
        const syncLabels = () => {
          try { syncRedTeamStatusLabels({ repo: slugOf(c.repo), pr: c.num, head: headSha, evidence, env, standingRuling,
            live, comments: pages.flat(), provider: statusProvider, dryRun, log: say }); }
          catch (e) { say(`red-team status labels #${c.num}: ${firstLine(e)}`); }
        };
        // A clear red team may drop `red-team:pending`; do that only once the enqueue succeeds, so a later refusal leaves it.
        if (reason) syncLabels(); else syncLabelsAfterEnqueue = syncLabels;
        if (reason) {
          before.redTeamPending ??= {};
          const wait = { headSha, firstPendingAt: sameHead ? pending.firstPendingAt : now(),
            retryAt: now() + (safety.value.redTeamPendingBackoffSec ?? 300) * 1000,
            commentCount: pages.flat().length, observation, checkedAt: now(), reason,
            ...(sameHead && pending.requestedAt != null ? { requestedAt: pending.requestedAt } : {}),
            ...(sameHead && pending.requestAttemptedAt != null ? { requestAttemptedAt: pending.requestAttemptedAt } : {}),
            ...(sameHead && pending.deadlineHeldAt != null ? { deadlineHeldAt: pending.deadlineHeldAt } : {}),
            ...(sameHead && pending.notifiedAt != null ? { notifiedAt: pending.notifiedAt } : {}) };
          before.redTeamPending[key] = wait;
          writeState(statePath, before);
          priorityReserveStamp(c, headSha, true);
          const outcome = pendingOutcome(c, wait);
          // Historical rows can request recovery, but never waive the hold or use the enqueue escape. A confirmed break
          // (its own send-back routing) and the other held-by-construction reasons: the hold is the whole answer.
          if (reason.includes('requiring send-back') || reason.includes('saved red-team re-check incomplete') || reason.includes(NUMBERING_ALIAS_WAIT)) return outcome;
          // Past the deadline with NO red-team result on this exact head the PR stays HELD: it may move only on a
          // result for this head, a proven-identical carry of one, an operator ruling through the red-team ruling path
          // (all read by redTeamEnqueueHold above), or a card-only diff that owes no pass. Never a timed bypass.
          const maxMin = safety.value.redTeamPendingMaxMin ?? 45;
          const source = deadline.sources?.deadlineAction ?? 'standard';
          const missing = !evidence.inFlight && !evidence.queued && !evidence.recorded;
          const deadlineHold = () => {
            // Before the deadline, or inside the one re-request's own full wait, the plain hold is the whole answer.
            if (!outcome.healthSmell || (wait.requestedAt != null && now() - wait.requestedAt < maxMin * 60_000)) return outcome;
            const why = missing ? (wait.requestedAt != null ? 'still none after one re-request'
              : evidence.attempted || evidence.untrustedSavedResult ? 'run left no usable result'
                : deadlineAction === 'hold' ? 'redTeam.deadlineAction=hold' : 'no red-team request path')
              : evidence.inFlight ? 'run still in flight' : evidence.queued ? 'run still queued' : 'run left no usable result';
            const heldReason = `held: no red-team result on this head after ${Math.floor((now() - wait.firstPendingAt) / 60_000)} min (${why})`;
            if (wait.deadlineHeldAt == null) {
              wait.deadlineHeldAt = now();
              log.write(`  merge-queue: HOLD ${slugOf(c.repo)}#${c.num} on ${headSha}: ${heldReason}; redTeamPendingMaxMin=${maxMin} (${safety.sources?.redTeamPendingMaxMin ?? 'standard'}), redTeam.deadlineAction=${deadlineAction} (${source}); never enqueued without a result\n`);
            }
            if (wait.notifiedAt == null && publishNote) {
              try {
                publishNote({ repo: slugOf(c.repo), pr: Number(c.num), head: headSha, kind: 'red-team-deadline-held', reason: heldReason,
                  pick: `https://github.com/${slugOf(c.repo)}/pull/${c.num}` });
                wait.notifiedAt = now();
              } catch (e) { log.write(`  ⚠ red-team deadline note for #${c.num} not published (${firstLine(e)}) — PR stays held; retried at the next recheck\n`); }
            }
            writeState(statePath, before);
            return { ...outcome, deadlineHeld: true, reason: heldReason };
          };
          if (!staleRequest.eligible && (evidence.untrustedSavedResult || (panelSeat && !neverScheduled) || (!neverScheduled && !outcome.healthSmell) || evidence.inFlight || evidence.queued || evidence.recorded || evidence.attempted)) return deadlineHold();
          // The one re-request for this head gets its own full wait before the operator is asked.
          if (wait.requestedAt != null) return deadlineHold();
          // redTeam.deadlineAction=hold: past the deadline ask the operator without another request.
          if (outcome.healthSmell && deadlineAction === 'hold') return deadlineHold();
          let requested = false;
          if (typeof requestRedTeam === 'function') {
            if (wait.requestAttemptedAt != null && now() - wait.requestAttemptedAt < cooldownMin * 60_000) return deadlineHold();
            wait.requestAttemptedAt = now();
            writeState(statePath, before);
            log.write(`  merge-queue: requesting red team for #${c.num} on ${headSha}: redTeamRequestCooldownMin=${cooldownMin} (${cooldownSource})\n`);
            try { requested = requestRedTeam({ repo: slugOf(c.repo), pr: c.num, head: headSha, loopPayload: evidence.loopPayload })?.requested === true; }
            catch (e) { log.write(`  red-team request failed #${c.num}: ${firstLine(e)}\n`); }
          }
          if (requested) {
            wait.requestedAt = now();
            writeState(statePath, before);
            log.write(`  merge-queue: requested red team for #${c.num} on ${headSha} through review dispatch (redTeam.deadlineAction=${deadlineAction}, ${source})\n`);
            return { ...outcome, redTeamRequested: true };
          }
          // drain.enqueueWhenRedTeamNeverScheduled is retired: no setting enqueues an owed head without a result. The
          // only path to merge-without-result is the operator's own env override, named and logged on every use, and
          // only where the retired escape applied (no run recorded, attempted, in flight or queued).
          if (!(outcome.healthSmell && missing && !neverScheduled && !evidence.untrustedSavedResult && !evidence.attempted
            && deadlineAction === RED_TEAM_DEADLINE_OVERRIDE && deadline.operatorOverride?.by)) return deadlineHold();
          log.write(`  ⚠ OPERATOR OVERRIDE: enqueuing ${slugOf(c.repo)}#${c.num} on ${headSha} with NO red-team result after ${maxMin} min (redTeam.deadlineAction=${RED_TEAM_DEADLINE_OVERRIDE}, env, by ${deadline.operatorOverride.by})\n`);
        }
      }
      if (holdOnly) return null;
      // The red-team pending record is retired only after a successful enqueue (below), so any refusal keeps it.
      const decision = {};
      const queueReadFailed = detail => {
        say(`  merge-queue file-overlap: live queue read failed (${detail}) — holding #${c.num} (queue-read-failed), retried next pass`);
        return { enqueued: false, deferred: true, kind: 'queue-read-failed', reason: `live merge-queue read failed: ${detail}` };
      };
      try {
        const candidateFiles = candidateFilesOf(c, headSha, decision);
        const queue = candidateFiles === null ? null : readQueueEntryFiles({ repo: slugOf(c.repo), exec, resolveFiles: queueResolver(decision) });
        if (candidateFiles === null) {
          say('  merge-queue file-overlap: candidate files unknown — continuing enqueue');
        } else if (!queue || queue.error != null || !Array.isArray(queue.entries)) {
          return queueReadFailed(queue?.error || (queue?.error != null ? 'queue read error' : 'malformed queue response'));
        } else {
          const includeCards = safety.value.queueFileOverlapIncludesCards ?? true;
          const source = safety.sources?.queueFileOverlapIncludesCards ?? 'standard';
          const overlap = pickQueueOverlap(c, candidateFiles, queue);
          if (overlap.unknown.length) say(`  merge-queue file-overlap: unknown files for ${overlap.unknown.map(num => `#${num}`).join(',')} — continuing without those entries`);
          if (overlap.overlap && !cardOverlapEnqueues(c, headSha, overlap, queue)) {
            stampReserve(c, headSha, candidateFiles, true);
            const first = overlap.with[0];
            say(`  merge-queue file-overlap: defer #${c.num} (shares ${first.files[0]} with queued #${first.num}) — includeCards=${includeCards} (${source})`);
            return { enqueued: false, deferred: true, kind: 'queue-file-overlap',
              reason: overlap.reason };
          }
          dropReserve(c);
        }
      } catch (e) { return queueReadFailed(firstLine(e)); }
      const reserve = priorityReserveHold(c, headSha, true, decision);
      if (reserve) return { enqueued: false, ...reserve };
      let batchingGroupId;
      try {
        const g = adaptiveBatching().gate(c.num);
        batchingGroupId = g.groupId;
        if (!g.admit) {
          say(`  merge-queue batching: defer #${c.num} (${g.reason})`);
          return { enqueued: false, deferred: true, reason: g.reason };
        }
      } catch (e) { say(`  ⚠ merge-queue batching admission failed (${firstLine(e)}) — continuing enqueue`); }
      const r = enqueuePr({ repo: slugOf(c.repo), num: c.num, headSha, cwd, exec, ...(preparedAdmission ? { preparedSurface: prepared.preparedSurface } : {}) });
      if (!r.ok) {
        // A shortcut refusal delegates to the full cascade in this pass. Do not install
        // retry backoff here: it would hide the refusal from that cascade's recovery catch.
        if (preparedAdmission) throw Object.assign(new Error(`github-merge-queue prepared enqueue FAILED (${r.error})`), {
          githubMessage: r.error,
          ...(r.reason === REQUIRED_WORKFLOWS_UNSATISFIED ? { code: REQUIRED_WORKFLOWS_UNSATISFIED, headSha } : {}),
        });
        log.write(`  enqueue FAILED ${key}: ${r.error}\n`);
        const conflict = /merge conflicts?|not (?:in )?(?:a )?mergeable state|not mergeable/i.test(r.error);
        const state = readQueueState(statePath, readFile);
        if (state.unreadable) throw Object.assign(new Error(`enqueue FAILED: ${r.error}; failure state unreadable`), { githubMessage: r.error });
        const count = (previous?.headSha === headSha ? previous.count : 0) + 1;
        const healthSmell = !conflict && count >= policy.enqueueFailureSmellAfter;
        state.enqueueFailures ??= {};
        const failure = { headSha, count, error: r.error, smellAfter: policy.enqueueFailureSmellAfter, smellSource: policy.sources?.enqueueFailureSmellAfter || 'standard', kind: conflict ? 'conflict' : r.unconfirmed ? 'unconfirmed' : 'enqueue-error', healthSmell,
          retryAt: now() + Math.min(3600, policy.enqueueRetrySeconds * 2 ** Math.min(count - 1, 10)) * 1000 };
        if (conflict && previous?.headSha === headSha && previous.conflictRouted) failure.conflictRouted = true;
        state.enqueueFailures[key] = failure;
        try { writeState(statePath, state); }
        catch (e) { log.write(`  enqueue failure state write failed ${key}: ${firstLine(e)}\n`); }
        if (healthSmell && !quiet) log.write(`  health smell: ${key} enqueue failed ${count} times (enqueueFailureSmellAfter=${policy.enqueueFailureSmellAfter}, ${policy.sources?.enqueueFailureSmellAfter || 'standard'})\n`);
        if (conflict && !failure.conflictRouted) {
          try {
            postConflictFinding({ pr: { number: c.num, headRefName: c.headRef }, enqueueRefusal: r.error, repo: slugOf(c.repo), exec });
            failure.conflictRouted = true;
            writeState(statePath, state);
          } catch (e) { log.write(`  conflict handoff failed ${key}: ${firstLine(e)}\n`); }
        }
        const err = new Error(`github-merge-queue enqueue FAILED (${r.error}) — NOT merged directly; retried next pass`);
        err.githubMessage = r.error;
        err.enqueueFailure = failure;
        // required-workflows refusal (ruleset 24930207): carry the exact enqueue pin into the cascade catch.
        if (r.reason === REQUIRED_WORKFLOWS_UNSATISFIED) { err.code = REQUIRED_WORKFLOWS_UNSATISFIED; err.headSha = headSha; }
        throw err;
      }
      dropReserve(c);
      syncLabelsAfterEnqueue?.();
      try { adaptiveBatching().confirm?.(c.num, batchingGroupId, { already: !!r.already }); } catch { /* batching bookkeeping never blocks an enqueue */ }
      const state = readQueueState(statePath, readFile);
      // The file can break between the pre-check above and here. Writing over it would erase every other pending
      // follow-up, so throw instead: the PR is already queued, and the next pass (file fixed) sees `already` and records it.
      if (state.unreadable) throw new Error(`github-merge-queue: ${keyOf(c.repo, c.num)} is ENQUEUED but follow-up state ${statePath} became unreadable — not recorded (file left untouched), retried next pass; fix or remove the file`);
      if (state.enqueueFailures) delete state.enqueueFailures[key];
      if (state.redTeamPending?.[key]) delete state.redTeamPending[key];
      const savedStamp = state.pending.some(p => keyOf(p.repo, p.num) === key && p.clearanceHead === headSha);
      // Skip the stamp only for a marker the DRAIN itself posted: a lookup of the drain's identity (made at most once
      // per pass, and only when some marker for this head exists) that fails or finds no match stamps again.
      if (!savedStamp) {
        try {
          const pages = readThreadPages(c.repo, c.num);
          if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('malformed comments response');
          comments = [...(comments || []), ...pages.flat()];
        } catch (e) {
          say(`  ⚠ ${key} clearance dedupe read failed (${firstLine(e)}) — stamp deferred until next pass`);
          comments = null;
        }
      }
      const alreadyStamped = savedStamp || Array.isArray(comments) && anyClearanceMarkerFor(comments, headSha) && (() => { const me = drainLogin(); return !!me && hasClearanceFor(comments, headSha, [me]); })();
      let stamped = alreadyStamped;
      if (!alreadyStamped && comments !== null) {
        try { exec('gh', ['pr', 'comment', String(c.num), '--repo', slugOf(c.repo), '--body', buildClearanceComment(headSha)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); stamped = true; }
        catch (e) { say(`  ⚠ ${keyOf(c.repo, c.num)} enqueue clearance stamp failed (${firstLine(e)}) — merge-gate's couple/blockedBy gates will fail closed for it`); }
      }
      // Live 2026-10-21 — `repo: null` and the local slug are one PR: never record it pending twice (it was counted twice).
      if (!state.pending.some((p) => keyOf(p.repo, p.num) === keyOf(c.repo, c.num) || canonKey(p.repo, p.num) === canonKey(c.repo, c.num))) {
        state.pending.push({ num: c.num, repo: c.repo ?? null, headSha, item: c.item ?? null, hasManifest: !!c.hasManifest, headRef: c.headRef ?? null, title: c.title ?? null, enqueuedAt: new Date().toISOString() });
      }
      const pending = state.pending.find(p => keyOf(p.repo, p.num) === key) || state.pending.find(p => canonKey(p.repo, p.num) === canonKey(c.repo, c.num));
      Object.assign(pending, { headSha, ...(stamped ? { clearanceHead: headSha } : {}) });
      writeState(statePath, state);
      say(`  ⇢ ${keyOf(c.repo, c.num)} ${r.already ? 'already in' : 'ENQUEUED on'} GitHub's merge queue at ${String(headSha).slice(0, 9)}${r.entry?.position != null ? ` (position ${r.entry.position})` : ''} — GitHub merges it; the drain follows up after`);
      return { enqueued: true, already: !!r.already };
    },

    /**
     * Each pass: PRs GitHub's queue merged and not yet confirmed join `merged` / `landedThisPass`, and are RETURNED.
     * They STAY in the pending list: the caller runs the post-land work (numbering / resolve-on-land / regen) and
     * then calls `confirmQueueFollowUps`, which is the only thing that retires them. A crash or a failed post-land
     * step in between leaves them pending, so the next pass runs the (idempotent) follow-up again.
     * Only a PR that left the queue CLOSED, or one already confirmed, is dropped here.
     * Queue mode first sweeps obsolete workflow runs, even without a follow-up state file.
     * @param {{merged:Array, landedThisPass:Set, landedIdsFor:Function}} o
     * @returns {Array} the pending entries whose follow-up this pass must confirm
     */
    collectQueueMerged({ merged, landedThisPass, landedIdsFor = () => [] }) {
      if (enqueueMode) {
        try { cancelObsoleteRuns({ repo: localSlug, exec, dryRun, log }); }
        catch (e) { say(`  ⚠ merge-queue: obsolete run cancellation failed (${firstLine(e)}) — continuing drain pass`); }
        try { adaptiveBatching().observe({}); }
        catch (e) { say(`  ⚠ merge-queue batching observation failed (${firstLine(e)}) — continuing drain pass`); }
      }
      const state = readQueueState(statePath, readFile);
      if (state.unreadable) { say(`  ⚠ merge-queue follow-up state ${statePath} is unreadable — no queue follow-up this pass (file left untouched); fix or remove it`); return []; }
      if (!state.exists || !state.pending.length) return [];
      const facts = [];
      const drop = new Set(); // keys to retire from `pending`; everything else (open, read failure) stays
      const followedUpKeys = new Set(state.followedUp);
      const followedUpCanon = new Set(state.followedUp.map((k) => (String(k).startsWith('cwd#') ? canonKey(null, String(k).slice(4)) : String(k))));
      const seenCanon = new Set(); // Live 2026-10-21 — a PR pending under both `cwd#N` and `<slug>#N` is ONE follow-up
      for (const p of state.pending) {
        const ck = canonKey(p.repo, p.num);
        if (seenCanon.has(ck)) { drop.add(keyOf(p.repo, p.num)); continue; }
        seenCanon.add(ck);
        let v;
        try { v = JSON.parse(exec('gh', ['pr', 'view', String(p.num), '--repo', slugOf(p.repo), '--json', 'number,state,mergedAt,mergeCommit,labels'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}'); }
        catch (e) { say(`  ⚠ ${keyOf(p.repo, p.num)} queue follow-up read failed (${firstLine(e)}) — retried next pass`); continue; }
        if (v?.state === 'OPEN') {
          try { removeSentBack(p.repo, p.num, v.labels); }
          catch (e) { say(`  ⚠ ${keyOf(p.repo, p.num)} dequeue failed (${firstLine(e)}) — retried next pass`); }
        }
        if (v?.state === 'MERGED') { if (followedUpKeys.has(keyOf(p.repo, p.num)) || followedUpCanon.has(ck)) drop.add(keyOf(p.repo, p.num)); else facts.push({ p, v }); }
        else if (v?.state === 'CLOSED') { drop.add(keyOf(p.repo, p.num)); say(`  · ${keyOf(p.repo, p.num)} left the merge queue CLOSED without merging — dropped from the follow-up list`); }
      }
      const plan = planQueueFollowUps({ merged: facts.map((f) => ({ number: f.p.num, mergedAt: f.v.mergedAt, mergeCommit: f.v.mergeCommit })) });
      const done = [];
      const attempted = new Set(); // keys whose follow-up this pass starts: counted, so a persistent failure stops being retried
      for (const fu of plan) {
        const p = facts.find((f) => Number(f.p.num) === fu.num).p;
        if (dryRun) { say(`  github-merge-queue: would run the post-land follow-up for ${keyOf(p.repo, p.num)} (merged by GitHub at ${fu.mergedAt})`); continue; }
        if ((Number(p.followUpAttempts) || 0) >= FOLLOW_UP_MAX_ATTEMPTS) {
          say(`  ✗ ${keyOf(p.repo, p.num)} merged by GitHub's merge queue but its post-land follow-up failed ${FOLLOW_UP_MAX_ATTEMPTS} passes in a row — STOPPED retrying (kept in ${statePath}); run its numbering/resolve/regen by hand, then remove it`);
          continue;
        }
        attempted.add(keyOf(p.repo, p.num));
        if (!merged.some((m) => canonKey(m.repo, m.num) === canonKey(p.repo, p.num))) merged.push({ num: p.num, repo: p.repo, headSha: p.headSha ?? null, mergedBy: 'github-merge-queue' });
        for (const id of landedIdsFor(p)) landedThisPass.add(id);
        done.push(p);
        say(`  ✓ ${keyOf(p.repo, p.num)} merged by GitHub's merge queue${fu.mergeSha ? ` (${String(fu.mergeSha).slice(0, 9)})` : ''} — running its numbering/resolve/regen follow-up this pass`);
      }
      if (!dryRun && (drop.size || attempted.size)) {
        mutateState('the closed/already-followed-up drop and attempt count', (st) => {
          st.pending = st.pending.filter((p) => !drop.has(keyOf(p.repo, p.num)));
          for (const p of st.pending) if (attempted.has(keyOf(p.repo, p.num))) p.followUpAttempts = (Number(p.followUpAttempts) || 0) + 1;
        });
      }
      return done;
    },

    /**
     * Retire the follow-ups `collectQueueMerged` returned, once the post-land work for them is DONE: they leave
     * `pending` and join `followedUp`. `complete:false` (a post-land step failed) keeps them pending so the next
     * pass retries. Re-reads the state under the lock, so entries other processes added meanwhile survive.
     * @param {Array} done the array `collectQueueMerged` returned
     * @param {{complete?:boolean}} o
     */
    confirmQueueFollowUps(done = [], { complete = true } = {}) {
      if (dryRun || !done.length) return { confirmed: 0 };
      if (!complete) { say(`  ⚠ ${done.length} merge-queue follow-up(s) NOT confirmed (a post-land step failed): ${done.map((p) => keyOf(p.repo, p.num)).join(', ')} — they stay pending and rerun next pass`); return { confirmed: 0 }; }
      const keys = new Set(done.map((p) => keyOf(p.repo, p.num)));
      const ok = mutateState('the follow-up confirmation', (st) => {
        st.pending = st.pending.filter((p) => !keys.has(keyOf(p.repo, p.num)));
        for (const k of keys) if (!st.followedUp.includes(k)) st.followedUp.push(k);
      });
      return { confirmed: ok ? keys.size : 0 };
    },
  };
}
