/**
 * @file scripts/conveyor/queue-prune.mjs
 * @description Queue hygiene for the session conveyor queue (`.conveyor/queue.json`): a PURE planner
 *   ({@link planPrune}) + a thin io shell ({@link applyPlan}, {@link bulkRemovePlan}). Used by
 *   `queue.mjs prune|remove --ids-file` and by the build daemon's automatic prune each N ticks.
 *
 *   AUTOMATIC classes (safe, derivable from main): `resolved` (card is status:resolved), `duplicate` (a JIT
 *   hash row whose landed number is also queued; a hash whose number is NOT queued is renamed, not dropped),
 *   `missing-card` (no card on main under either spelling, older than a grace period so a card still in an
 *   open lane PR is not dropped).  NEVER dropped: an entry with an open PR or an active claim/run.
 *   Fail-closed: an empty backlog load plans nothing (a loader failure must not read as "every card missing").
 *   Operator-approved bulk removal is separate: {@link bulkRemovePlan} (dry-run receipt required to apply).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normNum, bornAsIndexFromItems, readQueueFile, writeQueueFile, removeFromQueue, addToQueue } from './queue-store.mjs';

export const AUTO_CLASSES = Object.freeze(['resolved', 'duplicate', 'missing-card']);
/** A cleared id with no card yet is kept this long (its card may still be in an open lane PR). */
export const MISSING_CARD_GRACE_MS = 6 * 3600 * 1000;

/**
 * PURE. Plan a prune.
 * @param {{queue:Array<{num:string,addedAt?:string|null}>, items:Array<{num:*,status?:string,bornAs?:*}>,
 *   protectedNums?:Iterable<string>, nowMs?:number, graceMs?:number, classes?:Iterable<string>}} o
 * @returns {{ok:boolean, reason?:string, drop:Array<{num:string,reason:string,detail?:string}>,
 *   rename:Array<{from:string,to:string}>, protectedKept:Array<{num:string}>, keep:number}}
 */
export function planPrune({ queue, items, protectedNums = [], nowMs = Date.now(), graceMs = MISSING_CARD_GRACE_MS, classes = AUTO_CLASSES }) {
  const q = Array.isArray(queue) ? queue : [];
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { ok: false, reason: 'backlog-not-loaded', drop: [], rename: [], protectedKept: [], keep: q.length };
  const want = new Set(classes);
  const prot = new Set([...protectedNums].map(normNum));
  const byNum = new Map(list.map((it) => [normNum(it.num), it]));
  const bornAsIdx = bornAsIndexFromItems(list);
  const queued = new Set(q.map((e) => normNum(e.num)));
  const drop = [];
  const rename = [];
  const protectedKept = [];
  const dropped = new Set();
  for (const e of q) {
    const key = normNum(e.num);
    const landed = bornAsIdx.get(key) ?? null; // this hash's landed number, if it landed
    const card = byNum.get(key) ?? (landed ? byNum.get(landed) : null) ?? null;
    const isProtected = prot.has(key) || (landed != null && prot.has(landed));
    const why = (() => {
      if (card && String(card.status).toLowerCase() === 'resolved') return { reason: 'resolved', detail: landed ? `landed as #${landed}` : undefined };
      if (landed && queued.has(landed) && landed !== key) return { reason: 'duplicate', detail: `alias of queued #${landed}` };
      if (!card) {
        const age = e.addedAt ? nowMs - Date.parse(e.addedAt) : Infinity;
        if (age >= graceMs) return { reason: 'missing-card', detail: 'no card on main' };
      }
      return null;
    })();
    if (why && want.has(why.reason)) {
      if (isProtected) { protectedKept.push({ num: e.num }); continue; }
      drop.push({ num: e.num, ...why });
      dropped.add(key);
    } else if (landed && landed !== key && !queued.has(landed) && !(card && String(card.status).toLowerCase() === 'resolved')) {
      rename.push({ from: e.num, to: landed });
    }
  }
  const keep = q.length - drop.length;
  return { ok: true, drop, rename, protectedKept, keep };
}

/**
 * IO. Apply a plan to the sidecar, re-reading it fresh so an `add` that raced the plan is never lost: only the
 * planned ids are removed from the FRESH read. Returns the new queue.
 */
export function applyPlan(plan, path) {
  let fresh = readQueueFile(path);
  for (const d of plan.drop) fresh = removeFromQueue(fresh, d.num);
  for (const r of plan.rename) {
    const had = fresh.find((e) => normNum(e.num) === normNum(r.from));
    if (!had) continue;
    fresh = removeFromQueue(fresh, r.from);
    fresh = addToQueue(fresh, r.to, had.addedAt ?? null);
  }
  writeQueueFile(fresh, path);
  return fresh;
}

/** The ids that must never be pruned: open-PR deliveries, active claims, in-flight runs. PURE over arrays. */
export function protectedFrom({ prNums = [], claimNums = [], runNums = [] }) {
  return new Set([...prNums, ...claimNums, ...runNums].map(normNum).filter(Boolean));
}

// ── operator-approved bulk removal ────────────────────────────────────────────────────────────────

/** Parse an ids file: whitespace/comma separated, `#` comments (only a `# ` or line-start `#` followed by space). Pure. */
export function parseIdsFile(text) {
  const ids = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const body = line.replace(/(^|\s)#\s.*$/, '').replace(/^#\s.*$/, '');
    for (const tok of body.split(/[\s,]+/)) {
      const n = tok.trim().replace(/^#+/, '');
      if (n) ids.push(n);
    }
  }
  return [...new Set(ids.map(normNum))];
}

/** PURE. Plan a bulk remove: ids present in the queue, minus those protected (claim/run/open PR). */
export function bulkRemovePlan({ queue, ids, protectedNums = [], dropClass = 'operator' }) {
  const prot = new Set([...protectedNums].map(normNum));
  const inQueue = new Map((queue || []).map((e) => [normNum(e.num), e]));
  const drop = [];
  const protectedKept = [];
  const absent = [];
  for (const id of ids) {
    const e = inQueue.get(id);
    if (!e) { absent.push(id); continue; }
    if (prot.has(id)) { protectedKept.push({ num: e.num }); continue; }
    drop.push({ num: e.num, reason: dropClass });
  }
  return { ok: true, drop, rename: [], protectedKept, absent, keep: (queue || []).length - drop.length };
}

/** Digest of a bulk plan — the dry-run receipt the apply run must match. */
export function planDigest(plan, dropClass) {
  return createHash('sha256').update(JSON.stringify([dropClass, plan.drop.map((d) => normNum(d.num)).sort()])).digest('hex');
}
export const receiptPath = (queuePath) => `${queuePath}.bulk-dryrun.json`;
export function writeReceipt(queuePath, digest) {
  mkdirSync(dirname(receiptPath(queuePath)), { recursive: true });
  writeFileSync(receiptPath(queuePath), JSON.stringify({ digest, at: new Date().toISOString() }) + '\n');
}
export function receiptMatches(queuePath, digest) {
  try { return existsSync(receiptPath(queuePath)) && JSON.parse(readFileSync(receiptPath(queuePath), 'utf8')).digest === digest; }
  catch { return false; }
}
