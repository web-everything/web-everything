/**
 * @file scripts/lib/drain-merge-strategy.mjs
 * @description Card xtpxusq — the drain's side of the merge-delivery strategy (`./merge-delivery-policy.mjs`).
 *   `we:scripts/merge-ai-prs.mjs` keeps only small hooks; every decision about HOW a ready PR reaches main lives here.
 *
 *   - `drain-direct` (the standard default): `enqueues()` is false for every repo, so the drain's own `gh pr merge`
 *     path runs exactly as before. The only visible change is ONE log line per pass naming the strategy and the
 *     layer that set it. No state file exists → the queue follow-up makes no `gh` call.
 *   - `github-merge-queue`: for a PR of the drain's LOCAL repo that passed every drain gate this pass, the drain
 *     (1) stamps a drain enqueue-clearance comment for the judged head (so the `merge-gate` check can pass manifest
 *     couples / blockedBy — those gates fail closed without it), (2) ENQUEUES the PR through GraphQL
 *     `enqueuePullRequest` pinned to that head, and never calls the merge API. GitHub's queue owns freshness, so the
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
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadMergeDeliveryPolicy, formatMergeDeliverySourcesLine, MERGE_DELIVERY_STRATEGIES } from './merge-delivery-policy.mjs';
import { mergeActionFor, enqueuePr, planQueueFollowUps } from './merge-queue-enqueue.mjs';
import { readSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const DRY_RUN_STRATEGY_ENV = 'WE_DRAIN_MERGE_STRATEGY';
export const CLEARANCE_MARKER = 'we-drain-enqueue-clearance';
const CLEARANCE_RE = new RegExp(`<!--\\s*${CLEARANCE_MARKER}\\s+head=([0-9a-f]{7,40})\\s*-->`, 'gi');
const FOLLOWED_UP_CAP = 500;
export const FOLLOW_UP_MAX_ATTEMPTS = 5;

export function queueStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'drain-merge-queue-followups.json'); }

/**
 * Resolve the drain's policy for this pass. The dry-run override applies only when `dryRun` is true.
 * @returns {{policy:object, note:(string|null)}}
 */
export function resolveDrainMergePolicy({ dryRun = false, env = process.env, load = () => loadMergeDeliveryPolicy({ toolSettings: readSettings() }) } = {}) {
  const policy = load();
  const raw = env?.[DRY_RUN_STRATEGY_ENV];
  if (raw === undefined || raw === '') return { policy, note: null };
  if (!dryRun) return { policy, note: `${DRY_RUN_STRATEGY_ENV}=${raw} ignored (honoured only with --dry-run)` };
  if (!MERGE_DELIVERY_STRATEGIES.includes(raw)) return { policy, note: `${DRY_RUN_STRATEGY_ENV}=${raw} ignored (not one of ${MERGE_DELIVERY_STRATEGIES.join(', ')})` };
  return { policy: { ...policy, strategy: raw, sources: { ...policy.sources, strategy: `dry-run ${DRY_RUN_STRATEGY_ENV}` } }, note: null };
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
    return { pending: Array.isArray(s?.pending) ? s.pending.filter(isEntry) : [], followedUp: Array.isArray(s?.followedUp) ? s.followedUp.filter((k) => typeof k === 'string') : [], exists: true, unreadable: false };
  } catch (e) { return { pending: [], followedUp: [], exists: false, unreadable: e?.code !== 'ENOENT' }; }
}

function writeQueueState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ pending: state.pending, followedUp: state.followedUp.slice(-FOLLOWED_UP_CAP) }, null, 2)}\n`);
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
} = {}) {
  const { policy, note } = resolved;
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
      fn(st); writeState(statePath, { pending: st.pending, followedUp: st.followedUp }); return true;
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
  const enqueueMode = mergeActionFor(policy) === 'enqueue';
  const enqueues = (repo) => enqueueMode && !!isLocalRepo(repo);
  const slugOf = (repo) => repo || localSlug;

  return {
    policy,
    strategy: policy.strategy,
    enqueues,
    /** GitHub's queue re-tests every entry against the queue tip, so the drain's freshness refresh is skipped. */
    queueOwnsFreshness: (repo) => enqueues(repo),

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
    enqueue(c, headSha, { comments = null } = {}) {
      if (!enqueues(c.repo)) throw new Error('enqueue called for a repo outside github-merge-queue');
      if (dryRun) throw new Error('enqueue refused in dry run');
      if (!headSha) throw new Error('github-merge-queue: no pinned head — refusing to enqueue (and NOT merging directly)');
      // An unreadable state file would be overwritten with just this PR once enqueued, erasing every other pending follow-up.
      if (readQueueState(statePath, readFile).unreadable) throw new Error(`github-merge-queue: follow-up state ${statePath} is unreadable — refusing to enqueue (and NOT merging directly); fix or remove it`);
      // Skip the stamp only for a marker the DRAIN itself posted: a lookup of the drain's identity (made at most once
      // per pass, and only when some marker for this head exists) that fails or finds no match stamps again.
      const alreadyStamped = Array.isArray(comments) && anyClearanceMarkerFor(comments, headSha) && (() => { const me = drainLogin(); return !!me && hasClearanceFor(comments, headSha, [me]); })();
      if (!alreadyStamped) {
        try { exec('gh', ['pr', 'comment', String(c.num), '--repo', slugOf(c.repo), '--body', buildClearanceComment(headSha)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { say(`  ⚠ ${keyOf(c.repo, c.num)} enqueue clearance stamp failed (${firstLine(e)}) — merge-gate's couple/blockedBy gates will fail closed for it`); }
      }
      const r = enqueuePr({ repo: slugOf(c.repo), num: c.num, headSha, exec });
      if (!r.ok) throw new Error(`github-merge-queue enqueue FAILED (${r.error}) — NOT merged directly; retried next pass`);
      const state = readQueueState(statePath, readFile);
      if (!state.pending.some((p) => keyOf(p.repo, p.num) === keyOf(c.repo, c.num))) {
        state.pending.push({ num: c.num, repo: c.repo ?? null, headSha, item: c.item ?? null, hasManifest: !!c.hasManifest, headRef: c.headRef ?? null, title: c.title ?? null, enqueuedAt: new Date().toISOString() });
        writeState(statePath, state);
      }
      say(`  ⇢ ${keyOf(c.repo, c.num)} ${r.already ? 'already in' : 'ENQUEUED on'} GitHub's merge queue at ${String(headSha).slice(0, 9)}${r.entry?.position != null ? ` (position ${r.entry.position})` : ''} — GitHub merges it; the drain follows up after`);
      return { enqueued: true, already: !!r.already };
    },

    /**
     * Each pass: PRs GitHub's queue merged and not yet confirmed join `merged` / `landedThisPass`, and are RETURNED.
     * They STAY in the pending list: the caller runs the post-land work (numbering / resolve-on-land / regen) and
     * then calls `confirmQueueFollowUps`, which is the only thing that retires them. A crash or a failed post-land
     * step in between leaves them pending, so the next pass runs the (idempotent) follow-up again.
     * Only a PR that left the queue CLOSED, or one already confirmed, is dropped here.
     * No state file → no `gh` call (drain-direct stays byte-identical).
     * @param {{merged:Array, landedThisPass:Set, landedIdsFor:Function}} o
     * @returns {Array} the pending entries whose follow-up this pass must confirm
     */
    collectQueueMerged({ merged, landedThisPass, landedIdsFor = () => [] }) {
      const state = readQueueState(statePath, readFile);
      if (state.unreadable) { say(`  ⚠ merge-queue follow-up state ${statePath} is unreadable — no queue follow-up this pass (file left untouched); fix or remove it`); return []; }
      if (!state.exists || !state.pending.length) return [];
      const facts = [];
      const drop = new Set(); // keys to retire from `pending`; everything else (open, read failure) stays
      const followedUpKeys = new Set(state.followedUp);
      for (const p of state.pending) {
        let v;
        try { v = JSON.parse(exec('gh', ['pr', 'view', String(p.num), '--repo', slugOf(p.repo), '--json', 'number,state,mergedAt,mergeCommit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}'); }
        catch (e) { say(`  ⚠ ${keyOf(p.repo, p.num)} queue follow-up read failed (${firstLine(e)}) — retried next pass`); continue; }
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
