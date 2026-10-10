/**
 * @file scripts/lib/drain-followup-job.mjs
 * @description #4124 slice 1 — the drain's post-merge follow-up as a durable job kind on the #4125 job model.
 *
 * Today `merge-ai-prs.mjs` runs the follow-up INLINE after its merges: JIT numbering, resolve-on-land, the push,
 * then the derived regen. The pass cannot end, and the next pass cannot merge, until all of it finishes, and a
 * kill mid-way loses the local numbering commit. This module defines that follow-up as a `drain-followup` job
 * (decision 4120, statute #daemon-jobs) so the pass can record one job and return. Wiring it into
 * `merge-ai-prs.mjs` is the NEXT slice; this slice is the kind, its input, its steps and the child entry
 * (`we:scripts/drain-followup-job.mjs`).
 *
 * The shape 4120 rules for this kind:
 *  - **mutates-tree.** It changes a git tree and pushes `main`, so it never runs from a code snapshot and never
 *    in the daemon clone (the next pass refreshes that with `reset --hard`). It runs in its OWN linked worktree
 *    of `main` ({@link makeFollowupWorktreePreparer}). Every step refuses to reset any tree that is not a
 *    linked worktree ({@link assertLinkedWorktree}).
 *  - **serial.** One follow-up at a time per daemon — it is a writer to `main`.
 *  - **numbering lock, no unlocked fallback.** Each step that writes `main` holds `NUMBERING_LOCK_PATH` with
 *    `runUnlockedOnContention: false` (card 4134) and heartbeats it between sub-steps. A refused lock throws,
 *    so the job retries under the runtime's attempt cap instead of writing unserialised.
 *  - **the record carries what main cannot re-derive.** Resolve-on-land needs the pass's landed ids, the couple
 *    carriers and the still-open head refs; those ride `record.input` ({@link buildFollowupInput}).
 *  - **every step is idempotent.** Each step starts by resetting its own worktree to the fresh `origin/main`,
 *    so a relaunch after a crash (even one that left an unpushed local commit) re-derives everything from
 *    main: numbering re-reads pending hashes, resolve checks status first, regen is deterministic. A push the
 *    remote rejects throws, and the retry rebuilds on the new tip.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineJobKind, kindRegistry } from './daemon-jobs.mjs';
import { createJobStore, enqueueJob, reattachTick } from './daemon-jobs-runtime.mjs';
import { daemonJobsDir, daemonJobsRoot } from '../operations/run-store.mjs';

export const DRAIN_FOLLOWUP_KIND = 'drain-followup';
/** Repo-relative entry, run inside the kind's own worktree (so it runs the code on `main`). */
export const DRAIN_FOLLOWUP_ENTRY = 'scripts/drain-followup-job.mjs';

const firstLine = (e) => String((e && e.message) || e).split('\n')[0];
const strList = (v) => (Array.isArray(v) ? v : []).filter((x) => x != null && x !== '').map(String);

/**
 * Declare the `drain-followup` kind. `prepareWorktree(record)` must return the job's own linked worktree —
 * normally {@link makeFollowupWorktreePreparer}.
 * @param {{prepareWorktree: Function, maxAttempts?: number}} o
 */
export function defineDrainFollowupKind({ prepareWorktree, maxAttempts } = {}) {
  return defineJobKind({
    kind: DRAIN_FOLLOWUP_KIND,
    entry: DRAIN_FOLLOWUP_ENTRY,
    codeMode: 'mutates-tree',
    serial: true,
    resumable: true,
    ...(maxAttempts ? { maxAttempts } : {}),
    prepareWorktree,
  });
}

/**
 * The job input: exactly what the pass knows and `main` cannot tell a later process. Normalised to plain JSON
 * (strings and arrays of strings) so the record round-trips. `landedLocal: false` means nothing local landed,
 * and the pass should not record a job at all — callers check {@link followupNeeded}.
 * @param {{passId?: string, landedLocal?: boolean, merged?: Array, landedItems?: Array, carriers?: Array,
 *   openHeadRefs?: Iterable}} o
 */
export function buildFollowupInput({ passId = null, landedLocal = false, merged = [], landedItems = [], carriers = [], openHeadRefs = [], primary = null, primaryHinted = false, passCwd = null } = {}) {
  return {
    // The operator's primary checkout to ff-sync once main has the follow-up commits (absent = nothing to sync).
    // `passCwd`: the pass's own checkout, which the pass already fast-forwards inline — the job must never pull it too.
    ...(primary ? { primary: String(primary), primaryHinted: !!primaryHinted, ...(passCwd ? { passCwd: String(passCwd) } : {}) } : {}),
    passId: passId == null ? null : String(passId),
    landedLocal: !!landedLocal,
    merged: (Array.isArray(merged) ? merged : []).filter((m) => m && m.num != null)
      .map((m) => ({ num: Number(m.num), repo: m.repo == null ? null : String(m.repo) })),
    landedItems: strList(landedItems),
    carriers: (Array.isArray(carriers) ? carriers : []).filter((c) => c && c.item != null).map((c) => ({
      item: String(c.item),
      repo: c.repo == null ? null : String(c.repo),
      isWe: !!c.isWe,
      headRef: c.headRef == null ? null : String(c.headRef),
      manifestRefs: strList(c.manifestRefs),
    })),
    openHeadRefs: strList([...(openHeadRefs || [])]),
  };
}

/** A pass needs a follow-up job only when a local (WE) PR landed. */
export function followupNeeded(input) {
  return !!(input && input.landedLocal);
}

/**
 * Refuse to touch any tree that is not a LINKED worktree (`git-dir` differs from `git-common-dir`). The daemon
 * clone and every lane clone are primary worktrees, so a misconfigured `cwd` can never get `reset --hard`.
 */
export function assertLinkedWorktree({ exec = execFileSync, cwd }) {
  const rev = (flag) => resolve(cwd, String(exec('git', ['rev-parse', flag], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim());
  const gitDir = rev('--git-dir');
  const common = rev('--git-common-dir');
  if (gitDir === common) throw new Error(`drain-followup: ${cwd} is not a linked worktree — refusing to reset it (the job never runs in a daemon or lane clone)`);
}

/** Reset the job's own worktree to the fresh remote tip. Idempotent, and the first thing every step does. */
export function resetToRemoteTip({ exec = execFileSync, cwd, remote = 'origin', base = 'main' }) {
  assertLinkedWorktree({ exec, cwd });
  const git = (args) => exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['fetch', remote, base, '--quiet']);
  git(['reset', '--hard', '--quiet', `${remote}/${base}`]);
  git(['clean', '-fdq', '--', 'backlog']); // a crashed attempt's untracked renames never leak into the next one
  return String(git(['rev-parse', 'HEAD'])).trim();
}

/**
 * A `prepareWorktree` for the kind: one dedicated linked worktree at `worktreeDir`, added from `repoDir`'s
 * object store on first use, detached at `origin/main`, and reused after that.
 * @param {{repoDir: string, worktreeDir: string, exec?: Function, remote?: string, base?: string}} o
 */
export function makeFollowupWorktreePreparer({ repoDir, worktreeDir, exec = execFileSync, remote = 'origin', base = 'main' }) {
  return () => {
    if (!existsSync(resolve(worktreeDir, '.git'))) {
      mkdirSync(dirname(worktreeDir), { recursive: true });
      exec('git', ['worktree', 'prune'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
      exec('git', ['fetch', remote, base, '--quiet'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
      exec('git', ['worktree', 'add', '--detach', '--force', worktreeDir, `${remote}/${base}`], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    assertLinkedWorktree({ exec, cwd: worktreeDir });
    return worktreeDir;
  };
}

/**
 * Run `fn` under the numbering lock with NO unlocked fallback. A refused lock throws so the job retries.
 */
function underNumberingLock(withNumberingLock, label, fn) {
  const lock = withNumberingLock(fn, { runUnlockedOnContention: false });
  if (!lock.ran) throw new Error(`drain-followup: ${label} — numbering lock held by ${lock.heldBy || '?'} (${lock.reason || 'contended'}); will retry`);
  return lock.result;
}

/**
 * The job's steps. Each takes the record's `input` and returns what it did (merged into the checkpoint data,
 * so the record shows numbering and push done once). All I/O is injected so tests can count effects.
 * @param {{cwd: string, exec?: Function, numberPendingHashes: Function, resolveLandedItem: Function,
 *   planResolveOnLand: Function, pushNumberingOnLand: Function, regenDerivedOnLand: Function,
 *   withNumberingLock: Function, now?: Function}} deps
 */
export function followupSteps(deps) {
  const {
    cwd, exec = execFileSync, numberPendingHashes, resolveLandedItem, planResolveOnLand, pushNumberingOnLand,
    regenDerivedOnLand, withNumberingLock, syncPrimaryOnLand = null, now = () => new Date().toISOString(),
  } = deps;
  return [
    {
      name: 'number-resolve-push',
      run: ({ input }) => underNumberingLock(withNumberingLock, 'number-resolve-push', (heartbeat = () => {}) => {
        const baseSha = resetToRemoteTip({ exec, cwd });
        heartbeat();
        const n = numberPendingHashes(cwd);
        heartbeat();
        const plan = planResolveOnLand({ landedItems: input.landedItems, assigned: n.assigned, carriers: input.carriers, openHeadRefs: input.openHeadRefs });
        const resolved = [];
        const alreadyResolved = [];
        const failed = [];
        for (const id of plan.resolve) {
          try {
            const flip = resolveLandedItem(cwd, id, { sync: false, publish: false });
            if (flip.flipped) resolved.push(String(id));
            else if (flip.alreadyResolved) alreadyResolved.push(String(id));
            else failed.push({ id: String(id), reason: flip.reason || 'resolve-refused' });
          } catch (e) {
            failed.push({ id: String(id), reason: firstLine(e) });
          }
          heartbeat();
        }
        const shouldPush = !!n.committed || resolved.length > 0;
        const push = pushNumberingOnLand({ exec, cwd, shouldPush });
        if (shouldPush && !push.pushed) throw new Error(push.warning || 'drain-followup: numbering push failed');
        return {
          numbering: { baseSha, assigned: n.assigned || [], committed: !!n.committed, pushed: !!push.pushed, at: now() },
          resolveOnLand: { resolved, alreadyResolved, deferred: plan.deferred || [], failed },
        };
      }),
    },
    {
      name: 'derived-regen',
      run: () => underNumberingLock(withNumberingLock, 'derived-regen', (heartbeat = () => {}) => {
        const baseSha = resetToRemoteTip({ exec, cwd });
        heartbeat();
        const d = regenDerivedOnLand({ exec, cwd, landed: true });
        // A warning with some regen done means the commit/push failed — retry on the new tip. A warning with
        // nothing done means every generator failed: retrying cannot help, so it is recorded, not thrown.
        if (d.warning && d.done.length && !d.committed) throw new Error(d.warning);
        return { derived: { baseSha, done: d.done, failed: d.failed, committed: !!d.committed, pushed: !!d.pushed, ...(d.warning ? { warning: d.warning } : {}), at: now() } };
      }),
    },
    {
      // x4y74wj — the operator's primary checkout ff-sync the pass used to do inline (its `postMergeSync`). It
      // runs last, so the primary gets the numbering + regen commits too. Best-effort: a skip is recorded, never
      // thrown (a dirty or diverged primary is the operator's to reconcile; retrying cannot help).
      name: 'primary-sync',
      run: ({ input }) => {
        if (!input?.primary || typeof syncPrimaryOnLand !== 'function') return { primarySync: { synced: false, reason: 'not-located', at: now() } };
        const gitAt = (a) => exec('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        // "Is this the cwd" means the job worktree OR the pass's checkout: a primary that IS the pass's cwd was
        // already synced inline, and a second writer there would race the pass's own sweep and git index.
        // `.native` folds case on a case-insensitive volume (APFS), so `/Users/Foo/x` and `/Users/foo/x` compare equal.
        const isCwd = (p) => { try { const r = realpathSync.native(p); return r === realpathSync.native(cwd) || (!!input.passCwd && r === realpathSync.native(input.passCwd)); } catch { return false; } };
        const r = syncPrimaryOnLand({ exec: gitAt, primary: input.primary, hinted: !!input.primaryHinted, isCwd });
        return { primarySync: { synced: !!r.synced, reason: r.reason, at: now() } };
      },
    },
  ];
}

// ── wiring (x4y74wj): the pass hands its follow-up to a detached job ─────────────────────────────────────────

/** Platform preference file for the switch (policy cascade, like `red-main-hold.json`). */
export const DRAIN_FOLLOWUP_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'drain-followup-job.json');
/** Tool override. */
export const DRAIN_FOLLOWUP_ENV = 'WE_DRAIN_FOLLOWUP_JOB';

const onOff = (v) => { const x = String(v ?? '').trim().toLowerCase(); return x === 'on' || x === 'off' ? x : null; };

/**
 * Setting `drainFollowupJob` (`on` | `off`, built-in `on`). Policy cascade: built-in default → platform
 * preference (`we:scripts/settings/drain-followup-job.json`) → tool override (env `WE_DRAIN_FOLLOWUP_JOB`).
 * `off` = the pass runs numbering / resolve-on-land / push / derived regen / post-merge sync inline, as before.
 */
export function resolveDrainFollowupSetting({ env = process.env, file = DRAIN_FOLLOWUP_SETTINGS_FILE } = {}) {
  const fromEnv = onOff(env?.[DRAIN_FOLLOWUP_ENV]);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  try { const f = onOff(JSON.parse(readFileSync(file, 'utf8'))?.drainFollowupJob); if (f) return { value: f, source: 'settings' }; } catch { /* built-in */ }
  return { value: 'on', source: 'default' };
}

/** The follow-up job folder. ONE per host: the kind is serial, so every drain (daemon or a lane's fast drain) queues behind one writer to main. */
export function drainFollowupJobsDir(env = process.env) {
  return daemonJobsDir(DRAIN_FOLLOWUP_KIND, env);
}

/**
 * Where the job's worktree lives for a given launching clone: `<jobsRoot>/drain-followup-worktrees/<hash>/main`,
 * outside every git tree (a daemon clone refresh `reset --hard` + `clean -fd`s its own tree). The worktree has no
 * `node_modules`; a symlink beside it (`<hash>/node_modules` → the clone's) is found by Node's parent-directory
 * lookup, so the real entry runs unmodified and the symlink never shows up as an untracked file in the worktree.
 */
export function followupWorktreeLayout({ repoDir, env = process.env }) {
  let real = resolve(repoDir);
  try { real = realpathSync(real); } catch { /* not created yet — the resolved path still keys it */ }
  const base = join(daemonJobsRoot(env), 'drain-followup-worktrees', createHash('sha256').update(real).digest('hex').slice(0, 12));
  return { base, worktreeDir: join(base, 'main'), depsLink: join(base, 'node_modules'), depsTarget: join(real, 'node_modules') };
}

/** Point `link` at `target` (re-pointing a stale link). No-op when the target does not exist. */
export function ensureDepsLink({ link, target }) {
  if (!existsSync(target)) return false;
  let st = null;
  try { st = lstatSync(link); } catch { /* absent */ }
  if (st) {
    if (!st.isSymbolicLink()) return true; // a real directory someone installed — leave it
    if (readlinkSync(link) === target) return true;
    unlinkSync(link);
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, 'dir');
  return true;
}

const errLine = (e) => String((e && e.message) || e).split('\n')[0];

/**
 * THE HOOK merge-ai-prs calls at its follow-up point. With the setting on it records one `drain-followup` job
 * for a pass that landed a local PR, then runs one reattach tick (which launches it detached, and resumes or
 * fails a job a dead daemon left behind). It never waits on the job. Returns `handedOff: true` only when the
 * job record exists and did not fail at launch — anything else (`off`, dry run, nothing landed, a setup or
 * enqueue failure, a job the tick failed because its worktree could not be prepared) leaves the pass on its
 * inline path, so a broken job layer can never drop the numbering.
 * @param {{landed: boolean, dryRun?: boolean, buildInput: () => object, repoDir?: string, env?: object,
 *   setting?: {value: string, source: string}, store?: object, reattach?: Function, prepareWorktree?: Function,
 *   log?: Function, now?: () => number}} o
 * @returns {Promise<{handedOff: boolean, mode: 'job'|'inline', reason?: string, job?: object|null, actions?: object[]}>}
 */
export async function handOffDrainFollowup({
  landed, dryRun = false, buildInput, repoDir = process.cwd(), env = process.env,
  setting = resolveDrainFollowupSetting({ env }), store, reattach = reattachTick, prepareWorktree, log = () => {}, now = () => Date.now(),
} = {}) {
  if (setting.value !== 'on') return { handedOff: false, mode: 'inline', reason: `setting off (${setting.source})` };
  if (dryRun) return { handedOff: false, mode: 'inline', reason: 'dry-run' };
  let jobStore;
  let kinds;
  try {
    jobStore = store ?? createJobStore(drainFollowupJobsDir(env));
    mkdirSync(jobStore.dir, { recursive: true });
    const layout = followupWorktreeLayout({ repoDir, env });
    const prep = prepareWorktree ?? (() => {
      const dir = makeFollowupWorktreePreparer({ repoDir, worktreeDir: layout.worktreeDir })();
      ensureDepsLink({ link: layout.depsLink, target: layout.depsTarget });
      return dir;
    });
    kinds = kindRegistry([defineDrainFollowupKind({ prepareWorktree: prep })]);
  } catch (e) {
    log(`drain-followup: job layer unavailable (${errLine(e)}) — running the follow-up inline`);
    return { handedOff: false, mode: 'inline', reason: `setup-failed: ${errLine(e)}` };
  }
  let queued = null;
  if (landed) {
    try {
      queued = enqueueJob({ store: jobStore, kindDef: kinds.get(DRAIN_FOLLOWUP_KIND), input: buildInput(), now: now() });
    } catch (e) {
      log(`drain-followup: could not queue the job (${errLine(e)}) — running the follow-up inline`);
      return { handedOff: false, mode: 'inline', reason: `enqueue-failed: ${errLine(e)}` };
    }
  }
  let actions = [];
  try {
    actions = (await reattach({ store: jobStore, kinds, maxConcurrent: 1, log })).actions;
  } catch (e) {
    log(`drain-followup: reattach tick failed (${errLine(e)}) — the job stays queued; the next pass launches it`);
  }
  // A throwing read (a corrupt record) is the same as an unreadable one: nothing will run it, so the pass goes inline.
  let rec = null;
  if (queued) { try { rec = jobStore.read(queued.id); } catch { rec = null; } }
  // The record, not the enqueue, decides: the reattach tick fails a job outright when its code cannot be prepared
  // (a `git fetch` blip, a worktree conflict) and never retries it, so a `failed` record means nothing will run
  // the follow-up — the pass must keep its inline path, or the numbering is dropped. (A `queued` record after a
  // tick that threw is different: the next pass launches it, so that stays handed off.)
  if (queued && (!rec || rec.job.status === 'failed')) {
    const why = rec ? (rec.job.error || 'job failed at launch') : 'job record unreadable';
    log(`drain-followup: the job did not start (${errLine(why)}) — running the follow-up inline`);
    return { handedOff: false, mode: 'inline', reason: `launch-failed: ${errLine(why)}`, job: rec ? { id: rec.id, status: rec.job.status, attempts: rec.job.attempts } : null, actions };
  }
  return {
    handedOff: !!queued, mode: 'job', ...(queued ? {} : { reason: 'nothing-landed' }),
    job: rec ? { id: rec.id, status: rec.job.status, attempts: rec.job.attempts } : null, actions,
  };
}
