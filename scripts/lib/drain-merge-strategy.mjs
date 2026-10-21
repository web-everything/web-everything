import { listAgentsWithReviewJobs } from '../operations/review-job-store.mjs';
import { mintSessionSlug } from '../conveyor/session-slug.mjs';
import { repoKeyForSlug } from './constellation-repos.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';
import { redTeamPanelSeatOwed, redTeamOwedOnHead, redTeamOwedFor } from './review-red-team-policy.mjs';
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
import { readDrainQueueSafety, postAcceptRedTeamOwed, redTeamEnqueueHold, dequeueSentBack, sendBackReason } from './drain-queue-safety.mjs';
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
import { createAdaptiveBatching, readQueueFacts } from './merge-queue-adaptive-batching.mjs';
import { cancelObsoleteQueueRuns } from './merge-queue-obsolete-runs.mjs';

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
  statePath = queueStatePath(), resolved = resolveDrainMergePolicy({ dryRun }), log = process.stderr,
  readFile = readFileSync, writeState = writeQueueState, withLock = (fn) => ({ ran: true, result: fn() }),
  postConflictFinding = defaultPostConflictFinding, now = () => Date.now(),
  cancelObsoleteRuns = cancelObsoleteQueueRuns, batching,
  env = process.env, queueSafety, labelProvider, readRedTeamEvidence = readDrainRedTeamEvidence, requestRedTeam = null, readReviewAgents = listAgentsWithReviewJobs,
  cwd = process.cwd(), // a clone of the local repo: enqueuePr reads the judged commit's change list from it
} = {}) {
  const { policy, note } = resolved;
  const statusProvider = labelProvider ?? createGhProvider({ exec: (args, opts) => exec('gh', args, opts) });
  const say = (line) => { if (!quiet) log.write(`${line}\n`); };
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
  const pendingOutcome = (c, pending, quiet = false) => {
    const maxMin = safety.value.redTeamPendingMaxMin ?? 45;
    const healthSmell = now() - pending.firstPendingAt >= maxMin * 60_000;
    if (healthSmell && !quiet) log.write(`  health smell: ${slugOf(c.repo)}#${c.num} red-team-pending on ${pending.headSha} for ${Math.floor((now() - pending.firstPendingAt) / 60_000)} min (redTeamPendingMaxMin=${maxMin}, ${safety.sources?.redTeamPendingMaxMin ?? 'standard'})\n`);
    if (!quiet) say(`  merge-queue: defer #${c.num}: ${pending.reason}`);
    return { enqueued: false, deferred: true, kind: 'red-team-pending', reason: pending.reason, healthSmell };
  };
  const readLive = (repo, num) => JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', slugOf(repo), '--json', 'headRefOid,labels,reviews'], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  // The complete thread as pages. The drain's own comment reader allows 256 MiB: a long thread must not hit the 1 MiB default.
  const readThreadPages = (repo, num) => JSON.parse(exec('gh', ['api', '--paginate', '--slurp', `repos/${slugOf(repo)}/issues/${num}/comments`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: COMMENTS_MAX_BUFFER, timeout: 120_000 }));
  const removeSentBack = (repo, num, labels) => {
    if (dryRun || !safety.value.dequeueOnSendBack || !Array.isArray(labels)) return;
    const reason = sendBackReason(labels);
    if (reason) dequeueSentBack({ repo: slugOf(repo), pr: num, reason, exec, log: say });
  };
  const enqueueMode = mergeActionFor(policy) === 'enqueue';
  const adaptiveBatching = () => batching ??= createAdaptiveBatching({ repo: localSlug, exec, dryRun, log: say });
  const enqueues = (repo) => enqueueMode && !!isLocalRepo(repo);
  const slugOf = (repo) => repo || localSlug;

  return {
    policy,
    strategy: policy.strategy,
    enqueues,
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
        const reason = redTeamEnqueueHold({ ...evidence, comments: pages.flat(), pr: c.num, head: headSha, repo: slugOf(c.repo), env });
        return { allowed: !reason, reason, safety: safety.value, labels: labelSignature(live.labels), comments, preparedSurface };
      } catch { return { allowed: false, reason: 'red-team evidence unreadable' }; }
    },
    enqueue(c, headSha, { comments = null, prepared = null } = {}) {
      if (!enqueues(c.repo)) throw new Error('enqueue called for a repo outside github-merge-queue');
      if (dryRun) throw new Error('enqueue refused in dry run');
      if (!headSha) throw new Error('github-merge-queue: no pinned head — refusing to enqueue (and NOT merging directly)');
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
        removeSentBack(c.repo, c.num, live.labels);
        return { enqueued: false, deferred: true, kind: 'sent-back', reason: held };
      }
      // Head-bound file preparation is reusable; authorization evidence is always live.
      if (safety.value.waitForRedTeamBeforeEnqueue) {
        const evidence = readRedTeamEvidence({ repo: slugOf(c.repo), pr: c.num, head: headSha, env });
        const pending = before.redTeamPending?.[key];
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
        const requestDue = neverScheduled && !(sameHead && pending.requestedAt != null)
          && (!sameHead || pending.requestAttemptedAt == null || now() - pending.requestAttemptedAt >= cooldownMin * 60_000);
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
          return pendingOutcome(c, pending, true);
        }
        const pages = readThreadPages(c.repo, c.num);
        if (!Array.isArray(pages) || pages.some(p => !Array.isArray(p))) throw new Error('red-team admission: unreadable complete comments');
        const reason = redTeamEnqueueHold({ ...evidence, requestPending: neverScheduled || (sameHead && pending.requestedAt != null), comments: pages.flat(), repo: slugOf(c.repo), pr: c.num, head: headSha, env });
        try { syncRedTeamStatusLabels({ repo: slugOf(c.repo), pr: c.num, head: headSha, evidence, env,
          live, comments: pages.flat(), provider: statusProvider, dryRun, log: say }); }
        catch (e) { say(`red-team status labels #${c.num}: ${firstLine(e)}`); }
        if (reason) {
          before.redTeamPending ??= {};
          const wait = { headSha, firstPendingAt: sameHead ? pending.firstPendingAt : now(),
            retryAt: now() + (safety.value.redTeamPendingBackoffSec ?? 300) * 1000,
            commentCount: pages.flat().length, observation, checkedAt: now(), reason,
            ...(sameHead && pending.requestedAt != null ? { requestedAt: pending.requestedAt } : {}),
            ...(sameHead && pending.requestAttemptedAt != null ? { requestAttemptedAt: pending.requestAttemptedAt } : {}) };
          before.redTeamPending[key] = wait;
          writeState(statePath, before);
          const outcome = pendingOutcome(c, wait);
          // Never waive a recorded break or an active/recorded run. Only the scheduling gap has this escape: a run that
          // errored or left no usable result stays held until a usable result exists.
          if (evidence.untrustedSavedResult || (panelSeat && !neverScheduled) || (!neverScheduled && !outcome.healthSmell) || evidence.inFlight || evidence.queued || evidence.recorded || evidence.attempted || reason.includes('requiring send-back')
            || reason.includes('saved red-team re-check incomplete')) return outcome;
          let requested = false;
          if (wait.requestedAt != null) return outcome;
          if (wait.requestedAt == null && typeof requestRedTeam === 'function') {
            if (wait.requestAttemptedAt != null && now() - wait.requestAttemptedAt < cooldownMin * 60_000) return outcome;
            wait.requestAttemptedAt = now();
            writeState(statePath, before);
            log.write(`  merge-queue: requesting red team for #${c.num} on ${headSha}: redTeamRequestCooldownMin=${cooldownMin} (${cooldownSource})\n`);
            try { requested = requestRedTeam({ repo: slugOf(c.repo), pr: c.num, head: headSha, loopPayload: evidence.loopPayload })?.requested === true; }
            catch (e) { log.write(`  red-team request failed #${c.num}: ${firstLine(e)}\n`); }
          }
          if (requested) {
            wait.requestedAt = now();
            writeState(statePath, before);
            log.write(`  merge-queue: requested red team for #${c.num} on ${headSha} through review dispatch\n`);
            return { ...outcome, redTeamRequested: true };
          }
          if (neverScheduled || evidence.recorded || evidence.attempted) return outcome;
          const fallback = safety.value.enqueueWhenRedTeamNeverScheduled ?? true;
          log.write(`  merge-queue: #${c.num} red team never scheduled — enqueueWhenRedTeamNeverScheduled=${fallback} (${safety.sources?.enqueueWhenRedTeamNeverScheduled ?? 'standard'}); no successful red-team request path\n`);
          if (!fallback) return outcome;
        }
      }
      if (before.redTeamPending?.[key]) {
        delete before.redTeamPending[key];
        writeState(statePath, before);
      }
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
      try { adaptiveBatching().confirm?.(c.num, batchingGroupId, { already: !!r.already }); } catch { /* batching bookkeeping never blocks an enqueue */ }
      const state = readQueueState(statePath, readFile);
      // The file can break between the pre-check above and here. Writing over it would erase every other pending
      // follow-up, so throw instead: the PR is already queued, and the next pass (file fixed) sees `already` and records it.
      if (state.unreadable) throw new Error(`github-merge-queue: ${keyOf(c.repo, c.num)} is ENQUEUED but follow-up state ${statePath} became unreadable — not recorded (file left untouched), retried next pass; fix or remove the file`);
      if (state.enqueueFailures) delete state.enqueueFailures[key];
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
      if (!state.pending.some((p) => keyOf(p.repo, p.num) === keyOf(c.repo, c.num))) {
        state.pending.push({ num: c.num, repo: c.repo ?? null, headSha, item: c.item ?? null, hasManifest: !!c.hasManifest, headRef: c.headRef ?? null, title: c.title ?? null, enqueuedAt: new Date().toISOString() });
      }
      const pending = state.pending.find(p => keyOf(p.repo, p.num) === key);
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
      for (const p of state.pending) {
        let v;
        try { v = JSON.parse(exec('gh', ['pr', 'view', String(p.num), '--repo', slugOf(p.repo), '--json', 'number,state,mergedAt,mergeCommit,labels'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}'); }
        catch (e) { say(`  ⚠ ${keyOf(p.repo, p.num)} queue follow-up read failed (${firstLine(e)}) — retried next pass`); continue; }
        if (v?.state === 'OPEN') {
          try { removeSentBack(p.repo, p.num, v.labels); }
          catch (e) { say(`  ⚠ ${keyOf(p.repo, p.num)} dequeue failed (${firstLine(e)}) — retried next pass`); }
        }
        if (v?.state === 'MERGED') { if (followedUpKeys.has(keyOf(p.repo, p.num))) drop.add(keyOf(p.repo, p.num)); else facts.push({ p, v }); }
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
        merged.push({ num: p.num, repo: p.repo, headSha: p.headSha ?? null, mergedBy: 'github-merge-queue' });
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
