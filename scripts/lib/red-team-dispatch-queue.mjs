import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isRealHead } from './red-team-skip-outcome.mjs';

const transactions = new WeakMap();
// Holds where the runner cannot start a review for this head at all (no job, no capacity spent). Such an entry is
// still probed every tick, but it must not occupy one of the capacity-bound admissions.
const NON_RUNNABLE_REASONS = new Set(['review-unfinished']);
const copy = entries => entries.map(entry => ({ ...entry }));
const note = (log, message) => {
  try { log(`review-daemon: red-team queue ${message}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); }
  catch { /* Diagnostics must not interrupt recovery. */ }
};

export function defaultQueueFile(env = process.env, home = homedir()) {
  return env.WE_RED_TEAM_QUEUE_FILE || join(home, 'workspace', '.operations', 'red-team-dispatch-queue.json');
}

/** Synchronous IO matches the daemon's tick; admission never dequeues a PR. */
export function createRedTeamDispatchQueue({ file = defaultQueueFile(), readFile = readFileSync,
  writeFile = writeFileSync, rename = renameSync, unlink = unlinkSync, now = Date.now, log = () => {}, maxAttempts = 3 } = {}) {
  let entries = [];
  let pending = null;
  let stale = false; // true after a failed persist, until a later write succeeds
  const limit = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 3;
  try {
    const restored = JSON.parse(readFile(file, 'utf8'));
    const keys = new Set();
    if (!Array.isArray(restored) || !restored.every(entry => {
      if (!entry || typeof entry.repo !== 'string' || !entry.repo
        || !Number.isSafeInteger(entry.pr) || entry.pr < 1 || !isRealHead(entry.head)
        || entry.key !== `${entry.repo}#${entry.pr}` || keys.has(entry.key)
        || !Number.isFinite(entry.enqueuedAt) || !Number.isInteger(entry.attempts) || entry.attempts < 0) return false;
      keys.add(entry.key);
      return true;
    })) throw new Error('invalid persisted entries');
    entries = copy(restored);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Keep the bad file for inspection instead of silently overwriting its ordering/attempt history.
      let kept = 'not preserved';
      try { rename(file, `${file}.corrupt-${now()}`); kept = 'preserved as .corrupt-<time>'; } catch { /* best effort */ }
      note(log, `load unreadable or corrupt (${kept}); starting empty: ${error.message}`);
    }
  }
  const persist = data => {
    if (writeFile === writeFileSync) mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFile(temp, data, 'utf8');
      rename(temp, file);
      stale = false;
    } catch (error) {
      // The file no longer matches memory: remember it so the next commit rewrites it even with no new change.
      stale = true;
      try { unlink(temp); } catch { /* the temp file may never have been created */ }
      throw error;
    }
  };
  const changed = message => {
    const data = JSON.stringify(entries);
    if (pending) pending.push({ data, message });
    else { persist(data); note(log, message); }
  };
  const remove = (entry, reason) => {
    entries.splice(entries.indexOf(entry), 1);
    changed(`remove ${entry.key}: ${reason}`);
  };
  const queue = {
    entries: () => copy(entries),
    sync(repo, candidates) {
      const heads = new Map(candidates.map(candidate => [Number(candidate.pr), candidate.head]));
      for (const entry of [...entries]) {
        if (entry.repo !== repo) continue;
        if (!heads.has(entry.pr)) remove(entry, 'absent from candidates (closed/merged or no longer eligible)');
        else if (heads.get(entry.pr) !== entry.head) remove(entry, 'head changed; re-enqueue at tail');
      }
      for (const candidate of candidates) {
        const pr = Number(candidate.pr), key = `${repo}#${pr}`;
        if (!Number.isSafeInteger(pr) || pr < 1 || !isRealHead(candidate.head)
          || entries.some(entry => entry.key === key)) continue;
        entries.push({ key, repo, pr, head: candidate.head, enqueuedAt: now(), attempts: 0 });
        changed(`enqueue ${key}`);
      }
    },
    admit(repo, count) {
      const bound = typeof count === 'number' && !Number.isNaN(count) ? Math.max(0, Math.floor(count)) : 0;
      // Non-runnable heads ride along as probes (re-checked each tick, never starved) without using a slot.
      const mine = entries.filter(entry => entry.repo === repo);
      // Zero admission (unreadable capacity, fail closed) admits no probe either.
      const probes = new Set(mine.filter(entry => entry.blocked && bound > 0).map(entry => entry.key));
      const runnable = mine.filter(entry => !probes.has(entry.key)).slice(0, bound);
      const keys = new Set(runnable.map(entry => entry.key));
      const admitted = mine.filter(entry => probes.has(entry.key) || keys.has(entry.key));
      for (const entry of mine) {
        note(log, `${probes.has(entry.key) ? 'probe' : keys.has(entry.key) ? 'admit' : 'hold'} ${entry.key}: capacity ${bound}`);
      }
      return copy(admitted);
    },
    settle(repo, { dispatched = [], rows = [], notStarted = [] } = {}) {
      // Only admitted rows may settle: held-out PRs are deliberately absent from planner output.
      for (const admitted of admissions.get(repo) ?? []) {
        const entry = entries.find(entry => entry.key === admitted.key && entry.head === admitted.head);
        if (!entry) continue;
        const matches = row => Number(row.prNumber) === entry.pr;
        const row = rows.find(matches);
        const failure = notStarted.find(matches) ?? (row?.action === 'skip' ? { reason: row.why ?? 'planner skip' } : undefined);
        if (entry.blocked && (dispatched.some(matches) || !failure)) { delete entry.blocked; changed(`unblocked ${entry.key}`); }
        if (dispatched.some(matches)) remove(entry, 'dispatch started');
        else if (row?.action === 'clear' || row?.action === 'carry') remove(entry, row.action);
        else if (failure) {
          if (failure.reason === 'no review capacity left') continue;
          if (NON_RUNNABLE_REASONS.has(failure.reason)) {
            // No retry is spent and the slot is released: the entry stays queued, flagged, and is re-probed.
            if (entry.blocked !== failure.reason) { entry.blocked = failure.reason; changed(`blocked ${entry.key}: ${failure.reason}`); }
            continue;
          }
          entry.attempts++;
          if (entry.attempts >= limit) {
            entries.splice(entries.indexOf(entry), 1);
            entry.attempts = 0;
            entries.push(entry);
            changed(`requeue ${entry.key}: ${failure.reason}`);
          } else changed(`hold ${entry.key}: attempt ${entry.attempts}/${limit}: ${failure.reason}`);
        } else if (!row) remove(entry, 'absent from rows (not owed)');
      }
      admissions.delete(repo);
    },
  };
  const admissions = new Map();
  const admit = queue.admit;
  queue.admit = (repo, count) => {
    const result = admit(repo, count);
    admissions.set(repo, result);
    return result;
  };
  // Stage mutations around the runner so both sync and settlement are rolled back on a thrown run.
  transactions.set(queue, () => {
    const before = copy(entries), previousAdmissions = new Map(admissions);
    pending = [];
    return {
      commit() {
        // A previous failed write leaves the file behind memory; repair it even when this tick changed nothing,
        // so a restart cannot re-offer a PR whose job already started.
        const mutations = pending.length || !stale ? pending
          : [{ data: JSON.stringify(entries), message: 'rewrite stale queue file' }];
        pending = null;
        // The runner has already started its jobs: a failed write must never discard its result or roll
        // memory back (the settled entries stay in memory, so the next tick does not re-offer a started PR).
        // Each staged item is a full snapshot, so a later successful write repairs an earlier failed one.
        for (const { data, message } of mutations) {
          try { persist(data); note(log, message); }
          catch (error) { note(log, `persist failed (queue file left stale, in-memory state kept): ${error?.message ?? error}`); }
        }
      },
      abort() {
        entries = before;
        admissions.clear();
        for (const [repo, admitted] of previousAdmissions) admissions.set(repo, admitted);
        pending = null;
      },
    };
  });
  return queue;
}

export function redTeamQueueAdmitCount(capacity) {
  const valid = value => typeof value === 'number' && !Number.isNaN(value);
  if (!capacity || !valid(capacity.lanes)) return 0;
  const bounds = [capacity.lanes];
  if (capacity.remainingStarts != null) {
    if (!valid(capacity.remainingStarts)) return 0;
    bounds.push(capacity.remainingStarts);
  }
  if (capacity.budget != null) {
    const left = capacity.budget.left;
    if (!valid(left)) return 0;
    if (Number.isFinite(left) || left === -Infinity) bounds.push(left);
  }
  return Math.max(0, Math.floor(Math.min(...bounds)));
}

export function runWithRedTeamQueue({ queue, repo, plan, rawPrs, capacity, run, log = () => {}, ...rest }) {
  const candidates = [];
  for (const row of plan?.refusals ?? []) {
    if (row.kind !== 'already-reviewed-head') continue;
    const head = row.headSha ?? rawPrs?.find(pr => Number(pr.number) === Number(row.prNumber))?.headRefOid;
    if (isRealHead(head)) candidates.push({ pr: Number(row.prNumber), head });
  }
  const transaction = transactions.get(queue)?.();
  try {
    queue.sync(repo, candidates);
    // Exhausted but readable capacity: the runner refuses ("no review capacity left") before any retry is spent,
    // so everything passes through and worker-free settlement (clear/carry/label) is not delayed. Unreadable
    // capacity still admits nothing (fail closed).
    const bound = redTeamQueueAdmitCount(capacity);
    const finite = value => typeof value === 'number' && !Number.isNaN(value);
    const exhausted = bound === 0 && capacity && finite(capacity.lanes)
      && (capacity.remainingStarts == null || finite(capacity.remainingStarts))
      && (capacity.budget == null || finite(capacity.budget.left));
    const admitted = queue.admit(repo, exhausted ? Infinity : bound);
    const allowed = new Set(admitted.map(entry => entry.pr));
    const held = new Set(candidates.filter(candidate => !allowed.has(candidate.pr)).map(candidate => candidate.pr));
    for (const pr of held) note(log, `hold ${repo}#${pr}: capacity; waiting for a later tick`);
    const refusals = (plan?.refusals ?? []).filter(row => !held.has(Number(row.prNumber)));
    // Replace admitted candidate slots in FIFO order while preserving unrelated rows and metadata.
    const queuedRows = admitted.flatMap(entry => refusals.filter(row =>
      row.kind === 'already-reviewed-head' && Number(row.prNumber) === entry.pr));
    let index = 0;
    const options = { repo, plan: { ...plan, refusals: refusals.map(row =>
      row.kind === 'already-reviewed-head' && allowed.has(Number(row.prNumber)) ? queuedRows[index++] : row) },
    rawPrs: held.size ? rawPrs?.filter(pr => !held.has(Number(pr.number))) : rawPrs, capacity, log, ...rest };
    const finish = result => {
      queue.settle(repo, result);
      transaction?.commit();
      return result;
    };
    const result = run(options);
    if (result && typeof result.then === 'function') {
      return result.then(finish).catch(error => { transaction?.abort(); throw error; });
    }
    return finish(result);
  } catch (error) {
    transaction?.abort();
    throw error;
  }
}
