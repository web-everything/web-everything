/**
 * @file scripts/conveyor/queue-prune.mjs
 * @description Queue hygiene for the session conveyor queue (`.conveyor/queue.json`): a PURE planner
 *   ({@link planPrune}) + a thin io shell ({@link applyPlan}, {@link bulkRemovePlan}). Used by
 *   `queue.mjs prune|remove --ids-file` and by the build daemon's automatic prune each N ticks.
 *
 *   AUTOMATIC classes (safe, derivable from main): `resolved` (card is status:resolved), `duplicate` (a JIT
 *   hash row whose landed number is also queued; a hash whose number is NOT queued is renamed, not dropped),
 *   `missing-card` (no card on main under either spelling, older than a grace period so a card still in an
 *   open lane PR is not dropped; the caller passes `confirmMissing` so origin/main, not a possibly-lagging
 *   working tree, is the evidence).  NEVER dropped: an entry with an open PR, an active build/fix claim or an
 *   in-flight run — protection is compared by CANONICAL id, so a hash and its landed number protect each other.
 *   Fail-closed: an empty backlog load plans nothing (a loader failure must not read as "every card missing").
 *   Operator-approved bulk removal is separate: {@link bulkRemovePlan} (dry-run receipt required to apply).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normNum, bornAsIndexFromItems, readQueueFile, writeQueueFile, removeFromQueue, resolveBornAsRefs } from './queue-store.mjs';
import { idFromName } from '../backlog/id.mjs';

export const AUTO_CLASSES = Object.freeze(['resolved', 'duplicate', 'missing-card']);
/** A cleared id with no card yet is kept this long (its card may still be in an open lane PR). */
export const MISSING_CARD_GRACE_MS = 6 * 3600 * 1000;

/** A hash's landed number, else the id itself — the ONE spelling both a hash row and its landed row share. */
const canonicalId = (id, bornAsIdx) => bornAsIdx.get(normNum(id)) ?? normNum(id);
const canonicalSet = (ids, bornAsIdx) => new Set([...ids].map((id) => canonicalId(id, bornAsIdx)).filter(Boolean));

/**
 * PURE. Plan a prune.
 * @param {{queue:Array<{num:string,addedAt?:string|null}>, items:Array<{num:*,status?:string,bornAs?:*}>,
 *   protectedNums?:Iterable<string>, nowMs?:number, graceMs?:number, classes?:Iterable<string>,
 *   confirmMissing?:((num:string)=>boolean)|null}} o  `confirmMissing`: when given, a `missing-card` drop also needs it to return true
 * @returns {{ok:boolean, reason?:string, drop:Array<{num:string,reason:string,detail?:string}>,
 *   rename:Array<{from:string,to:string}>, protectedKept:Array<{num:string}>, keep:number}}
 */
export function planPrune({ queue, items, protectedNums = [], nowMs = Date.now(), graceMs = MISSING_CARD_GRACE_MS, classes = AUTO_CLASSES, confirmMissing = null }) {
  const q = Array.isArray(queue) ? queue : [];
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { ok: false, reason: 'backlog-not-loaded', drop: [], rename: [], protectedKept: [], keep: q.length };
  const want = new Set(classes);
  const byNum = new Map(list.map((it) => [normNum(it.num), it]));
  const bornAsIdx = bornAsIndexFromItems(list);
  const prot = canonicalSet(protectedNums, bornAsIdx);
  const queued = new Set(q.map((e) => normNum(e.num)));
  const drop = [];
  const rename = [];
  const protectedKept = [];
  const dropped = new Set();
  for (const e of q) {
    const key = normNum(e.num);
    const landed = bornAsIdx.get(key) ?? null; // this hash's landed number, if it landed
    const card = byNum.get(key) ?? (landed ? byNum.get(landed) : null) ?? null;
    const isProtected = prot.has(canonicalId(key, bornAsIdx));
    const why = (() => {
      if (card && String(card.status).toLowerCase() === 'resolved') return { reason: 'resolved', detail: landed ? `landed as #${landed}` : undefined };
      if (landed && queued.has(landed) && landed !== key) return { reason: 'duplicate', detail: `alias of queued #${landed}` };
      if (!card) {
        const age = e.addedAt ? nowMs - Date.parse(e.addedAt) : Infinity;
        // `confirmMissing` (when given) must PROVE the card absent from origin/main: the local `items` can lag it.
        // Cheap checks first: no git fetch for a row that is protected or whose class is not wanted.
        if (age >= graceMs && want.has('missing-card') && (isProtected || !confirmMissing || confirmMissing(e.num))) return { reason: 'missing-card', detail: 'no card on main' };
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
  // Renames go through the SAME in-place path as `queue.mjs migrate-bornas`, so a renamed row keeps its queue
  // position (the order is a within-tier tie-break) and its original `addedAt`.
  if (plan.rename.length) fresh = resolveBornAsRefs(fresh, new Map(plan.rename.map((r) => [normNum(r.from), normNum(r.to)])));
  writeQueueFile(fresh, path);
  return fresh;
}

/** The ids that must never be pruned: open-PR deliveries, active claims, fix claims, in-flight runs. PURE over arrays. */
export function protectedFrom({ prNums = [], claimNums = [], fixClaimNums = [], runNums = [] }) {
  return new Set([...prNums, ...claimNums, ...fixClaimNums, ...runNums].map(normNum).filter(Boolean));
}

/**
 * PURE. The ONE protected-set builder shared by the daemon tick and the `queue.mjs` CLI, so neither can drop a
 * source the other honours. A fix claim is keyed by its PR (`{pr}` / `{meta:{pr}}`), not by an item num, so it is
 * resolved through the open-PR list (over-protecting when two repos share a PR number — the safe direction). Note
 * that path adds nothing beyond the open-PR set itself; it only matters for a claim that carries an item `num`.
 * @param {{prs?:object[], claims?:Array<{meta?:{num?:*}, num?:*}>, fixClaims?:object[], runs?:Array<{num?:*}>,
 *   prNum:(pr:object)=>*}} o  `prNum` = the PR → delivered item num reader (`prDeliveredNum`).
 */
export function collectProtectedNums({ prs = [], claims = [], fixClaims = [], runs = [], prNum }) {
  const numsByPr = new Map();
  for (const p of prs) {
    const n = prNum(p);
    if (n) numsByPr.set(Number(p?.number), [...(numsByPr.get(Number(p?.number)) ?? []), n]);
  }
  return protectedFrom({
    prNums: prs.map(prNum),
    claimNums: claims.map((c) => c?.meta?.num ?? c?.num),
    fixClaimNums: fixClaims.flatMap((c) => (c?.num ?? c?.meta?.num) != null ? [c.num ?? c.meta.num] : numsByPr.get(Number(c?.pr ?? c?.meta?.pr)) ?? []),
    runNums: runs.map((r) => r?.num),
  });
}

/** `CONVEYOR_PRUNE_PROTECTED` (hermetic-test override): a blank/whitespace value is IGNORED — it must never replace the live reads with an empty set. */
export function protectedOverride(value) {
  const ids = String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? protectedFrom({ prNums: ids }) : null;
}

/**
 * Evidence source for `missing-card`: a predicate that is true ONLY when `origin/main` provably holds no card
 * (filename id nor `bornAs:`) for the id. A fetch/git failure, or an id it cannot safely grep, reads as "present"
 * (keep) — a lagging checkout must never read as "every card missing".
 */
export function makeConfirmMissingOnMain({ exec = execFileSync, cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') } = {}) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 64 * 1024 * 1024 };
  let names = null;
  let unavailable = false; // a failed fetch/ls-tree is remembered: every later call keeps, with no further blocking git calls
  return (num) => {
    if (unavailable) return false;
    try {
      if (!names) {
        exec('git', ['fetch', '-q', 'origin', 'main'], opts);
        // `-z` + quotePath off: a non-ASCII filename must not be quoted into an unparseable token.
        names = new Set(exec('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--name-only', 'origin/main', '--', 'backlog/'], opts)
          .split('\0').map((f) => normNum(idFromName(f.replace(/^backlog\//, '')) || '')).filter(Boolean));
        // An empty listing means origin/main's backlog could not be read — unknown, never "every card is missing".
        if (names.size === 0) { names = null; unavailable = true; return false; }
      }
      const key = normNum(num);
      if (names.has(key)) return false;
      if (!/^[a-z0-9]+$/.test(key)) return false;
      try { exec('git', ['grep', '-q', '-i', '-E', `^bornAs:[[:space:]]*['"]?#?${key}['"]?[[:space:]]*$`, 'origin/main', '--', 'backlog/'], opts); return false; }
      catch (e) { return e?.status === 1; } // exit 1 = no match (provably absent); anything else = unknown → keep
    } catch { unavailable = true; return false; }
  };
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

/**
 * PURE. Plan a bulk remove: ids present in the queue, minus those protected (claim/run/open PR). A listed id
 * matches a queued row by EITHER spelling of the card (its hash or its landed NNN, via `bornAsIndex`), whichever
 * spelling the queue or the list uses; protection is compared the same way, so a hash-protected card is never
 * dropped under its number (nor the reverse). A card queued under both spellings drops both rows.
 */
export function bulkRemovePlan({ queue, ids, protectedNums = [], dropClass = 'operator', bornAsIndex = new Map() }) {
  const prot = canonicalSet(protectedNums, bornAsIndex);
  const rows = new Map();
  for (const e of queue || []) {
    const k = canonicalId(e.num, bornAsIndex);
    rows.set(k, [...(rows.get(k) ?? []), e]);
  }
  const drop = [];
  const protectedKept = [];
  const absent = [];
  const seen = new Set(); // a card listed under BOTH spellings is one removal, not two
  for (const id of ids) {
    const k = canonicalId(id, bornAsIndex);
    if (seen.has(k)) continue;
    seen.add(k);
    const matched = rows.get(k);
    if (!matched) { absent.push(id); continue; }
    for (const e of matched) {
      if (prot.has(k)) protectedKept.push({ num: e.num });
      else drop.push({ num: e.num, reason: dropClass });
    }
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
