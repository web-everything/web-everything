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

/** Has a clearance for `headSha` already been posted (any author)? Pure; used only to avoid duplicate stamps. */
export function hasClearanceFor(comments, headSha) {
  return (Array.isArray(comments) ? comments : []).some((c) => {
    CLEARANCE_RE.lastIndex = 0;
    let m;
    while ((m = CLEARANCE_RE.exec(String(c?.body ?? ''))) !== null) if (m[1].toLowerCase() === String(headSha).toLowerCase()) return true;
    return false;
  });
}

export function readQueueState(path, readFile = readFileSync) {
  try {
    const s = JSON.parse(readFile(path, 'utf8'));
    return { pending: Array.isArray(s?.pending) ? s.pending : [], followedUp: Array.isArray(s?.followedUp) ? s.followedUp : [], exists: true };
  } catch { return { pending: [], followedUp: [], exists: false }; }
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
 *   readFile?:Function, writeState?:Function}} o
 */
export function createDrainMergeStrategy({
  dryRun = false, quiet = false, isLocalRepo = () => true, localSlug = null, exec = execFileSync,
  statePath = queueStatePath(), resolved = resolveDrainMergePolicy({ dryRun }), log = process.stderr,
  readFile = readFileSync, writeState = writeQueueState,
} = {}) {
  const { policy, note } = resolved;
  const say = (line) => { if (!quiet) log.write(`${line}\n`); };
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
      if (!Array.isArray(comments) || !hasClearanceFor(comments, headSha)) {
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
     * Each pass: PRs GitHub's queue merged since the last follow-up join `merged` / `landedThisPass` exactly once.
     * No state file → no `gh` call (drain-direct stays byte-identical).
     * @param {{merged:Array, landedThisPass:Set, landedIdsFor:Function}} o
     */
    collectQueueMerged({ merged, landedThisPass, landedIdsFor = () => [] }) {
      const state = readQueueState(statePath, readFile);
      if (!state.exists || !state.pending.length) return [];
      const facts = [];
      const keep = [];
      for (const p of state.pending) {
        let v;
        try { v = JSON.parse(exec('gh', ['pr', 'view', String(p.num), '--repo', slugOf(p.repo), '--json', 'number,state,mergedAt,mergeCommit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}'); }
        catch (e) { say(`  ⚠ ${keyOf(p.repo, p.num)} queue follow-up read failed (${firstLine(e)}) — retried next pass`); keep.push(p); continue; }
        if (v?.state === 'MERGED') facts.push({ p, v });
        else if (v?.state === 'CLOSED') say(`  · ${keyOf(p.repo, p.num)} left the merge queue CLOSED without merging — dropped from the follow-up list`);
        else keep.push(p);
      }
      const followedUpKeys = new Set(state.followedUp);
      const plan = planQueueFollowUps({ merged: facts.filter((f) => !followedUpKeys.has(keyOf(f.p.repo, f.p.num))).map((f) => ({ number: f.p.num, mergedAt: f.v.mergedAt, mergeCommit: f.v.mergeCommit })) });
      const done = [];
      for (const fu of plan) {
        const p = facts.find((f) => Number(f.p.num) === fu.num).p;
        if (dryRun) { say(`  github-merge-queue: would run the post-land follow-up for ${keyOf(p.repo, p.num)} (merged by GitHub at ${fu.mergedAt})`); keep.push(p); continue; }
        merged.push({ num: p.num, repo: p.repo, headSha: p.headSha ?? null, mergedBy: 'github-merge-queue' });
        for (const id of landedIdsFor(p)) landedThisPass.add(id);
        state.followedUp.push(keyOf(p.repo, p.num));
        done.push(p);
        say(`  ✓ ${keyOf(p.repo, p.num)} merged by GitHub's merge queue${fu.mergeSha ? ` (${String(fu.mergeSha).slice(0, 9)})` : ''} — running its numbering/resolve/regen follow-up this pass`);
      }
      // A merged PR already followed up (a crash between the write and the follow-up) just leaves the pending list.
      if (!dryRun) writeState(statePath, { pending: keep, followedUp: state.followedUp });
      return done;
    },
  };
}
