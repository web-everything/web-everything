import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isRealHead } from './red-team-skip-outcome.mjs';
import { readBacklogOnlyNetFiles } from './red-team-backlog-only.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { isUnderTest } from './under-test.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';

const transactions = new WeakMap();
const cardOnlyHeads = new Map();
const MAX_CARD_ONLY_HEADS = 256;
// Holds where the runner cannot start a review for this head at all (no job, no capacity spent). Such an entry is
// still probed every tick, but it must not occupy one of the capacity-bound admissions.
const NON_RUNNABLE_REASONS = new Set(['review-unfinished', 'planner-skip']);
// At most this many probes ride along per repo per tick; attempts rotation (maxAttempts) moves a probe that stays
// blocked to the tail, so every blocked entry is re-checked in turn.
const MAX_PROBES = 2;
const copy = entries => entries.map(entry => ({ ...entry }));
const note = (log, message) => {
  try { log(`review-daemon: red-team queue ${message}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); }
  catch { /* Diagnostics must not interrupt recovery. */ }
};

export const RED_TEAM_QUEUE_MIN_CONCURRENT_CAP = 6;
export const RED_TEAM_QUEUE_REVIEW_STARTS_CAP = 6;

/** Invalid or missing minimums disable the floor; an invalid threshold falls back to 10%. */
export function loadRedTeamQueueFloor({ env = process.env,
  file = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'red-team-queue.json'), readFile = readFileSync,
  log = () => {} } = {}) {
  let settings;
  try { settings = JSON.parse(readFile(file, 'utf8'))?.redTeam?.queue; }
  catch { /* Unavailable settings never create extra capacity. */ }
  const minimumEnv = env.WE_RED_TEAM_QUEUE_MIN_CONCURRENT;
  const idleEnv = env.WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT;
  const reviewStartsEnv = env.WE_RED_TEAM_QUEUE_REVIEW_STARTS_WHILE_IDLE;
  const parseEnv = value => typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const reviewStarts = reviewStartsEnv === undefined ? settings?.reviewStartsPerTickWhileIdle : parseEnv(reviewStartsEnv);
  const minimum = minimumEnv === undefined ? settings?.minConcurrent : parseEnv(minimumEnv);
  const validIdle = value => Number.isInteger(value) && value >= 0 && value <= 100;
  // An invalid override never replaces a valid file threshold with a looser one: it is ignored.
  const idle = idleEnv !== undefined && validIdle(parseEnv(idleEnv)) ? parseEnv(idleEnv) : settings?.minConcurrentIdlePct;
  const floor = {
    // A missing threshold means the default 10; a present but invalid one disables the floor (never a looser guess).
    minConcurrent: (idle === undefined || validIdle(idle)) && Number.isInteger(minimum) && minimum >= 0
      ? Math.min(minimum, RED_TEAM_QUEUE_MIN_CONCURRENT_CAP) : 0,
    idlePct: validIdle(idle) ? idle : 10,
    reviewStartsPerTick: Number.isInteger(reviewStarts) && reviewStarts >= 0 ? Math.min(reviewStarts, RED_TEAM_QUEUE_REVIEW_STARTS_CAP) : 0,
  };
  note(log, `floor minConcurrent=${floor.minConcurrent} (source: ${minimumEnv === undefined ? 'scripts/settings/red-team-queue.json; invalid/missing disables' : 'env WE_RED_TEAM_QUEUE_MIN_CONCURRENT'}), idlePct=${floor.idlePct} (source: ${idleEnv === undefined ? 'scripts/settings/red-team-queue.json; invalid/missing defaults to 10' : 'env WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT'}), reviewStartsPerTick=${floor.reviewStartsPerTick} (source: ${reviewStartsEnv === undefined ? 'scripts/settings/red-team-queue.json; invalid/missing disables' : 'env WE_RED_TEAM_QUEUE_REVIEW_STARTS_WHILE_IDLE'})`);
  return floor;
}

/** Idle capacity may raise a finite admitted allowance; disabled/unknown evidence never raises it. */
export function raiseReviewStartsPerTick(maxPerTick, { floor, cpuIdlePct } = {}) {
  if (!Number.isFinite(maxPerTick) || maxPerTick < 2
    || !(floor?.minConcurrent > 0)
    || !Number.isFinite(cpuIdlePct) || cpuIdlePct > 100 || !(cpuIdlePct >= floor.idlePct)
    || !Number.isInteger(floor.reviewStartsPerTick) || floor.reviewStartsPerTick < 0) return maxPerTick;
  // One extra start at most, and never past the configured cap; a configured limit of 1 stays 1.
  return Math.max(maxPerTick, Math.min(maxPerTick + 1, floor.reviewStartsPerTick));
}

/** Raise the per-tick start allowance only within the caller's host ceiling; other bounds stay independent. */
export function applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct, log = () => {} } = {}) {
  if (!capacity || !Number.isFinite(capacity.remainingStarts)
    || typeof capacity.startsCeiling !== 'number' || !(capacity.startsCeiling >= 0)
    || !Number.isInteger(floor?.minConcurrent) || floor.minConcurrent <= 0
    || !Number.isInteger(floor.idlePct) || floor.idlePct < 0 || floor.idlePct > 100
    || !Number.isFinite(cpuIdlePct) || cpuIdlePct < floor.idlePct || cpuIdlePct > 100) return;
  const minimum = Math.min(floor.minConcurrent, RED_TEAM_QUEUE_MIN_CONCURRENT_CAP, capacity.startsCeiling);
  if (capacity.remainingStarts >= minimum) return;
  const before = capacity.remainingStarts;
  capacity.remainingStarts = minimum;
  note(log, `floor raises remainingStarts ${before} -> ${minimum}: CPU idle ${cpuIdlePct}% >= ${floor.idlePct}%`);
}

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
        || (entry.blocked !== undefined && !NON_RUNNABLE_REASONS.has(entry.blocked))
        || !Number.isFinite(entry.enqueuedAt) || (entry.rotatedAt !== undefined && !Number.isFinite(entry.rotatedAt)) || !Number.isInteger(entry.attempts) || entry.attempts < 0) return false;
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
    admit(repo, count, { allowProbes = true } = {}) {
      const validCount = typeof count === 'number' && !Number.isNaN(count); // invalid count fails closed: no probes either
      const bound = typeof count === 'number' && !Number.isNaN(count) ? Math.max(0, Math.floor(count)) : 0;
      // Non-runnable heads ride along as probes (re-checked each tick, never starved) without using a slot.
      const mine = entries.filter(entry => entry.repo === repo);
      // Zero admission (unreadable capacity, fail closed) admits no probe either.
      const probes = new Set(mine.filter(entry => NON_RUNNABLE_REASONS.has(entry.blocked) && allowProbes && validCount).slice(0, MAX_PROBES).map(entry => entry.key));
      // Aged FIFO: capacity waits keep the original age, so a PR rotated to the tail by earlier skips is still served
      // before newer arrivals. Only a slot-consuming start failure sets rotatedAt (see settle) and moves a PR back.
      const age = entry => entry.rotatedAt ?? entry.enqueuedAt;
      const runnable = mine.filter(entry => !NON_RUNNABLE_REASONS.has(entry.blocked))
        .map((entry, index) => ({ entry, index })).sort((a, b) => age(a.entry) - age(b.entry) || a.index - b.index)
        .map(({ entry }) => entry).slice(0, bound);
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
        const failure = notStarted.find(matches) ?? (row?.action === 'skip' ? { reason: row.why ?? 'planner skip', skipped: true } : undefined);
        // A planner skip (e.g. later verdict supersedes acceptance) starts nothing, so it must not keep a capacity slot.
        const nonRunnable = f => !!f && f.reason !== 'no review capacity left' && (f.skipped === true || NON_RUNNABLE_REASONS.has(f.reason));
        if (entry.blocked && (dispatched.some(matches) || !nonRunnable(failure))) { delete entry.blocked; changed(`unblocked ${entry.key}`); }
        if (dispatched.some(matches)) remove(entry, 'dispatch started');
        else if (row?.action === 'clear' || row?.action === 'carry') remove(entry, row.action);
        else if (failure) {
          if (failure.reason === 'no review capacity left') continue;
          if (nonRunnable(failure)) {
            // The slot is released (see admit); the normal attempts rotation still bounds how long it stays in front.
            entry.blocked = failure.skipped ? 'planner-skip' : failure.reason;
          }
          entry.attempts++;
          if (entry.attempts >= limit) {
            // A genuine start failure rotates behind everyone; a non-runnable skip used no slot, so it keeps its age.
            if (!nonRunnable(failure)) {
              // Strictly after every queued age, even if the clock stepped backward, so rotation never loses to wall time.
              entry.rotatedAt = Math.max(now(), ...entries.map(other => other.rotatedAt ?? other.enqueuedAt)) + 1;
            }
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
  queue.admit = (repo, count, options) => {
    const result = admit(repo, count, options);
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

// Capacity is normalized once at intake to max(0, floor(raw)) for every finite figure, so the admission bound and the
// runner (whose own check is only "> 0") agree: 0.5 is 0, 1.7 is 1, counters never go negative. The shared budget
// object is floored in place (copying it would disconnect the runner's reservations from the live balance).
const whole = value => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : value);
function normalizeCapacity(capacity) {
  if (!capacity || typeof capacity !== 'object') return capacity;
  if (capacity.budget && typeof capacity.budget === 'object' && whole(capacity.budget.left) !== capacity.budget.left) {
    capacity.budget.left = whole(capacity.budget.left);
  }
  // Floored in place as well: the runner decrements the caller's own object, so a copy would replenish it per call.
  for (const key of ['lanes', 'remainingStarts']) if (whole(capacity[key]) !== capacity[key]) capacity[key] = whole(capacity[key]);
  return capacity;
}
const readableCapacity = capacity => !!capacity && typeof capacity.lanes === 'number' && !Number.isNaN(capacity.lanes)
  && (capacity.remainingStarts == null || (typeof capacity.remainingStarts === 'number' && !Number.isNaN(capacity.remainingStarts)))
  && (capacity.budget == null || (typeof capacity.budget.left === 'number' && !Number.isNaN(capacity.budget.left)));

export function runWithRedTeamQueue({ queue, repo, plan, rawPrs, capacity: rawCapacity, run, log = () => {},
  floor, readCpuIdlePct, readSkipCardOnly = () => readRedTeamProbes().value.skipCardOnly, readNetFiles = args => isUnderTest() ? { ok: false } : readBacklogOnlyNetFiles(args), ...rest }) {
  const candidates = [], cardOnlyCandidates = [];
  for (const row of plan?.refusals ?? []) {
    if (row.kind !== 'already-reviewed-head') continue;
    const head = row.headSha ?? rawPrs?.find(pr => Number(pr.number) === Number(row.prNumber))?.headRefOid;
    if (!isRealHead(head)) continue;
    const number = Number(row.prNumber), key = `${repo}#${number}@${head}`;
    let cardOnly = cardOnlyHeads.get(key) === true;
    if (!cardOnlyHeads.has(key)) {
      try {
        const net = readNetFiles({ repo, number, headRefOid: head });
        cardOnly = net?.ok === true && isCardOnlyDiff(net.files);
        // Only readable evidence is cached; an unreadable read retries next tick.
        if (net?.ok === true) {
          cardOnlyHeads.set(key, cardOnly);
          // Oldest evidence is re-read on demand after eviction.
          if (cardOnlyHeads.size > MAX_CARD_ONLY_HEADS) cardOnlyHeads.delete(cardOnlyHeads.keys().next().value);
        }
      } catch { /* Unreadable evidence retains normal queue admission. */ }
    }
    if (cardOnly) cardOnlyCandidates.push({ pr: number, head });
    else candidates.push({ pr: number, head });
  }
  const capacity = normalizeCapacity(rawCapacity);
  // Unreadable capacity admits nothing (fail closed), so a card-only PR queues like any other then.
  // The bypass also needs the live card-only skip policy on (the one the red-team pass itself follows).
  let skipCardOnly = false;
  if (cardOnlyCandidates.length) { try { skipCardOnly = readSkipCardOnly() === true; } catch { /* fail closed */ } }
  const bypassed = new Set();
  for (const entry of cardOnlyCandidates) {
    if (skipCardOnly && readableCapacity(capacity)) { bypassed.add(entry.pr); note(log, `card-only ${repo}#${entry.pr} bypasses red-team queue`); }
    else candidates.push(entry);
  }
  if (floor?.minConcurrent > 0 && typeof readCpuIdlePct === 'function') {
    let cpuIdlePct;
    try { cpuIdlePct = readCpuIdlePct(); } catch { /* An unreadable sample leaves capacity unchanged. */ }
    applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct, log });
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
    const admitted = queue.admit(repo, exhausted ? Infinity : bound, { allowProbes: readableCapacity(capacity) });
    const allowed = new Set(admitted.map(entry => entry.pr));
    const held = new Set(candidates.filter(candidate => !allowed.has(candidate.pr)).map(candidate => candidate.pr));
    for (const pr of held) note(log, `hold ${repo}#${pr}: capacity; waiting for a later tick`);
    // Bypassed card-only rows go last so queued code PRs claim the runner's capacity first.
    const kept = (plan?.refusals ?? []).filter(row => !held.has(Number(row.prNumber)));
    const refusals = [...kept.filter(row => !bypassed.has(Number(row.prNumber))), ...kept.filter(row => bypassed.has(Number(row.prNumber)))];
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
