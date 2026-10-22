/**
 * @file scripts/lib/verdict-ledger-ref.mjs
 * @description WHICH REF THE VERDICT LEDGER LIVES ON — the cutover from `ops/review-requests` (a full 7,122-file repo
 *   tree from August plus `verdict-ledger/*.jsonl`) to a LEDGER-ONLY orphan ref (`ops/verdict-ledger`, whose tree is
 *   `verdict-ledger/` and nothing else). Card context: #6679 (the ledger loses push races), git review §1.3 item 2.
 *
 * WHY. Every ledger write builds its commit from a temp index of the tip (`read-tree <tip>`), so it copies the whole
 *   7k-entry tree; every fetch of the tip carries a 97-entry root tree; a fresh fetch of the ref drags 25k commits of
 *   repo history. Only `verdict-ledger/` is ever read off that ref by the ledger readers (inventory below).
 *
 * INVENTORY (what readers need from the old ref, 2026-10-21):
 *   · `verdict-ledger/<owner>-<repo>.jsonl` — read by `readLedgerFromGit` (merge-gate CI, drain, store readers) and
 *     appended by `appendLedgerRows` (CI applier, local writers via the outbox). THE ONLY THING THAT MOVES.
 *   · `ops/review-requests/*.json` — the REQUEST channel. Stays: the applier workflow triggers on pushes of these paths
 *     to `ops/review-requests`, and a push-triggered workflow is read from the pushed tree, which is why that branch
 *     must keep a full repo tree. An orphan ledger ref has no `.github/`, so a push to it triggers nothing.
 *   · `review-precedents/*.jsonl` — a separate store (`review-precedents-io.mjs`), 3 writes ever. Stays.
 *
 * SETTINGS (cascade standard -> repo `verdictLedger.*` -> env; each value logged with its source):
 *   · `verdictLedger.ref`      (env WE_VERDICT_LEDGER_REF)       the ledger-only ref. Allow-listed, never free text.
 *   · `verdictLedger.cutover`  (env WE_VERDICT_LEDGER_CUTOVER)   'off' (DEFAULT: today) | 'on' | 'rollback'.
 *   · `verdictLedger.dualRead` (env WE_VERDICT_LEDGER_DUAL_READ) false (DEFAULT) | true — see the plan below.
 *   · `verdictLedger.retiredOldTree` (env WE_VERDICT_LEDGER_RETIRED_OLD_TREE) the old ref's `verdict-ledger/` tree id,
 *     pinned once the migration report shows zero rows on one ref only. The ONLY way to stop reading the old ref.
 *
 * PLAN (pure: {@link ledgerReadPlan}; audit 2026-10-21: no setting combination may hide a ref that can hold rows):
 *   off                          writes old · reads old only                                    (today, byte for byte)
 *   off + dualRead               writes old · reads UNION   (readiness stage, before the migration runs)
 *   on                           writes new · reads UNION   (dualRead=false is ignored here unless the pin is set)
 *   on + dualRead=false + pin    writes new · reads new + FENCE: the old ref's ledger tree must still equal the pin,
 *                                else unreadable (a straggler wrote the old ref after it was retired)
 *   rollback                     writes old · reads UNION always (the kill switch; dualRead=false is ignored)
 *   In the union an ABSENT ref adds nothing, except the write ref with cutover on/rollback, whose absence is unreadable;
 *   both absent is unreadable. FAIL CLOSED: a ref that exists but cannot be read makes the whole read unreadable.
 *   "Absent" is only ever a definitive empty `ls-remote`.
 *
 * WRITE RULE: writers write exactly ONE ref. Writers NEVER create the new ref: only the migration
 *   (`we:scripts/verdict-ledger-migrate.mjs`) does, from a snapshot of the old ref, so the new ref always starts as a
 *   superset of everything written before it existed. With cutover on/rollback a writer also dedupes against the OTHER
 *   ref ({@link ledgerWritePlan}), so a replay (an outbox entry that landed on one ref, then is flushed after a switch)
 *   is never appended a second time on the other ref, where it would land after newer rows and supersede them.
 *
 * KILL SWITCH: cutover 'rollback' (NOT 'off'): writers return to the old ref, readers keep the union, nothing written
 *   to the new ref disappears. The old ref is never deleted or rewritten by any of this.
 */

export const LEGACY_LEDGER_BRANCH = 'ops/review-requests';
export const DEFAULT_LEDGER_ONLY_BRANCH = 'ops/verdict-ledger';
/** The ONLY refs a ledger push may ever name. A setting can choose between them; it can never point a push elsewhere. */
export const ALLOWED_LEDGER_BRANCHES = Object.freeze([LEGACY_LEDGER_BRANCH, DEFAULT_LEDGER_ONLY_BRANCH]);
export const LEDGER_REF_ENV = 'WE_VERDICT_LEDGER_REF';
export const LEDGER_CUTOVER_ENV = 'WE_VERDICT_LEDGER_CUTOVER';
export const LEDGER_DUAL_READ_ENV = 'WE_VERDICT_LEDGER_DUAL_READ';
export const LEDGER_RETIRED_OLD_TREE_ENV = 'WE_VERDICT_LEDGER_RETIRED_OLD_TREE';
const CUTOVER_MODES = Object.freeze(['off', 'on', 'rollback']);
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parseBool = (raw) => (/^(1|true|on|yes)$/i.test(raw) ? true : /^(0|false|off|no)$/i.test(raw) ? false : null);
const validRef = (v) => typeof v === 'string' && v !== LEGACY_LEDGER_BRANCH && ALLOWED_LEDGER_BRANCHES.includes(v);

/** The full push ref for an allow-listed ledger branch. THROWS on anything else (no ref is ever pushed unchecked). */
export function ledgerPushRefFor(branch) {
  if (!ALLOWED_LEDGER_BRANCHES.includes(branch)) {
    throw new Error(`verdict-ledger-ref: "${branch}" is not a ledger ref (allowed: ${ALLOWED_LEDGER_BRANCHES.join(', ')})`);
  }
  return `refs/heads/${branch}`;
}

/**
 * PURE settings cascade. Invalid layers are ignored and named in `invalid` (the layer below answers). A combination
 * that would hide a ref that can hold rows is not an error but is overridden, and named in `overridden`.
 * @returns {{ref: string, cutover: 'off'|'on'|'rollback', dualRead: boolean, retiredOldTree: string|null,
 *   writeBranch: string, sources: object, invalid: string[], overridden: string[]}}
 */
export function resolveLedgerRefSettings({ repo, env } = {}) {
  const out = { ref: DEFAULT_LEDGER_ONLY_BRANCH, cutover: 'off', dualRead: false, retiredOldTree: null };
  const sources = { ref: 'standard', cutover: 'standard', dualRead: 'standard', retiredOldTree: 'standard' };
  const invalid = [];
  const layer = isPlainObject(repo?.verdictLedger) ? repo.verdictLedger : {};
  if (Object.hasOwn(layer, 'ref')) { if (validRef(layer.ref)) { out.ref = layer.ref; sources.ref = 'repo'; } else invalid.push('repo.verdictLedger.ref'); }
  if (Object.hasOwn(layer, 'cutover')) { if (CUTOVER_MODES.includes(layer.cutover)) { out.cutover = layer.cutover; sources.cutover = 'repo'; } else invalid.push('repo.verdictLedger.cutover'); }
  if (Object.hasOwn(layer, 'dualRead')) { if (typeof layer.dualRead === 'boolean') { out.dualRead = layer.dualRead; sources.dualRead = 'repo'; } else invalid.push('repo.verdictLedger.dualRead'); }
  if (Object.hasOwn(layer, 'retiredOldTree')) {
    if (typeof layer.retiredOldTree === 'string' && OID_RE.test(layer.retiredOldTree)) { out.retiredOldTree = layer.retiredOldTree; sources.retiredOldTree = 'repo'; } else invalid.push('repo.verdictLedger.retiredOldTree');
  }
  const e = isPlainObject(env) ? env : {};
  const raw = (name) => (e[name] === undefined || e[name] === '' ? undefined : String(e[name]).trim());
  if (raw(LEDGER_REF_ENV) !== undefined) { if (validRef(raw(LEDGER_REF_ENV))) { out.ref = raw(LEDGER_REF_ENV); sources.ref = 'env'; } else invalid.push(`env.${LEDGER_REF_ENV}`); }
  if (raw(LEDGER_CUTOVER_ENV) !== undefined) {
    const v = raw(LEDGER_CUTOVER_ENV).toLowerCase();
    if (CUTOVER_MODES.includes(v)) { out.cutover = v; sources.cutover = 'env'; } else invalid.push(`env.${LEDGER_CUTOVER_ENV}`);
  }
  if (raw(LEDGER_DUAL_READ_ENV) !== undefined) {
    const b = parseBool(raw(LEDGER_DUAL_READ_ENV));
    if (b === null) invalid.push(`env.${LEDGER_DUAL_READ_ENV}`); else { out.dualRead = b; sources.dualRead = 'env'; }
  }
  if (raw(LEDGER_RETIRED_OLD_TREE_ENV) !== undefined) {
    const v = raw(LEDGER_RETIRED_OLD_TREE_ENV).toLowerCase();
    if (OID_RE.test(v)) { out.retiredOldTree = v; sources.retiredOldTree = 'env'; } else invalid.push(`env.${LEDGER_RETIRED_OLD_TREE_ENV}`);
  }
  // No combination may hide a ref that can hold rows (audit 2026-10-21, finding 1).
  const overridden = [];
  if (out.cutover === 'rollback' && !out.dualRead) { out.dualRead = true; overridden.push('dualRead=true (rollback always reads both refs)'); }
  if (out.cutover === 'on' && !out.dualRead && !out.retiredOldTree) { out.dualRead = true; overridden.push('dualRead=true (cutover on without verdictLedger.retiredOldTree reads both refs)'); }
  if (out.cutover !== 'on' && out.retiredOldTree) overridden.push(`retiredOldTree ignored (cutover ${out.cutover})`);
  return { ...out, writeBranch: out.cutover === 'on' ? out.ref : LEGACY_LEDGER_BRANCH, sources, invalid, overridden };
}

export function formatLedgerRefSettings(s) {
  const tail = [s.invalid?.length ? `ignored invalid: ${s.invalid.join(', ')}` : '', s.overridden?.length ? `overridden: ${s.overridden.join(', ')}` : '']
    .filter(Boolean).map((t) => `, ${t}`).join('');
  const plan = ledgerReadPlan(s);
  return `verdict-ledger-ref: verdictLedger.ref=${s.ref} (${s.sources.ref}), verdictLedger.cutover=${s.cutover} (${s.sources.cutover}), `
    + `verdictLedger.dualRead=${s.dualRead} (${s.sources.dualRead}), verdictLedger.retiredOldTree=${s.retiredOldTree ?? 'none'} (${s.sources.retiredOldTree ?? 'standard'}); `
    + `writes -> ${s.writeBranch}; reads -> ${plan.branches.join(' + ')}${plan.fence ? ` (fence ${plan.fence.branch}:${plan.fence.tree.slice(0, 12)})` : ''}${tail}`;
}

/**
 * PURE: which refs a read consults.
 * @returns {{branches: string[], union: boolean, required: string[], fence: {branch: string, tree: string}|null}}
 *   `union` = read every listed ref that exists and merge them. `required` = refs whose ABSENCE is itself unreadable
 *   (the write ref once writers have left the old ref). `fence` = the retired old ref, whose ledger tree must still
 *   equal the pin.
 */
export function ledgerReadPlan(s) {
  const required = s.cutover === 'on' ? [s.ref] : s.cutover === 'rollback' ? [s.ref, LEGACY_LEDGER_BRANCH] : [];
  if (s.dualRead || s.cutover === 'rollback') return { branches: [s.ref, LEGACY_LEDGER_BRANCH], union: true, required, fence: null };
  if (s.cutover === 'on') return { branches: [s.ref], union: false, required, fence: s.retiredOldTree ? { branch: LEGACY_LEDGER_BRANCH, tree: s.retiredOldTree } : null };
  return { branches: [LEGACY_LEDGER_BRANCH], union: false, required, fence: null };
}

/**
 * PURE: where a write goes, and which OTHER ref its rows must be deduped against before they are appended.
 * @returns {{branch: string, dedupeAlso: string|null}}
 */
export function ledgerWritePlan(s) {
  if (s.cutover === 'on') return { branch: s.ref, dedupeAlso: s.retiredOldTree ? null : LEGACY_LEDGER_BRANCH };
  if (s.cutover === 'rollback') return { branch: LEGACY_LEDGER_BRANCH, dedupeAlso: s.ref };
  return { branch: LEGACY_LEDGER_BRANCH, dedupeAlso: null };
}

/** A row's identity: its event id when it carries one, else its exact (trimmed) line. */
function rowKey(line, idOf) {
  try {
    const row = JSON.parse(line);
    if (isPlainObject(row)) {
      if (typeof row.id === 'string' && row.id) return `id:${row.id}`;
      if (idOf) { try { return `id:${idOf(row)}`; } catch { /* fall through to the line */ } }
    }
  } catch { /* not JSON: the line itself is the key, and the strict reader still rejects it */ }
  return `line:${line.trim()}`;
}

/**
 * PURE UNION of two ledger texts, or a refusal. A row on both refs appears ONCE; no row on either ref is dropped;
 * malformed lines pass through untouched so a strict reader still rejects them.
 *
 * ORDER (the fold is last-bearing-verdict-wins), audit 2026-10-21 findings 2 and 4:
 *   · Each ref's own append order is kept exactly.
 *   · Rows on BOTH refs are ANCHORS: they must appear in the same relative order on both, else `order-conflict`. Between
 *     two anchors, the rows only one ref holds are merged by their `at` time (a merge of the two runs, never a sort, so
 *     neither run is reordered); a line with no readable `at` takes the time of the line before it on its own side.
 *   · Two rows for the SAME PR, one per ref, with the SAME time inside one gap have no knowable order: `ambiguous-order`.
 *   · A row id on both refs with DIFFERENT bytes is `conflicting-row` (a corrupt copy must never be deduped away).
 * @returns {{ok: true, text: string, oldRows: number, newOnly: number, duplicates: number}
 *   | {ok: false, reason: 'order-conflict'|'ambiguous-order'|'conflicting-row', error: string}}
 */
export function unionLedgerTexts(oldText = '', newText = '', { idOf = null } = {}) {
  const lines = (t) => String(t ?? '').split('\n').filter((l) => l.trim());
  const A = timed(lines(oldText), idOf);
  const B = timed(lines(newText), idOf);
  const firstInA = new Map();
  A.forEach((r, i) => { if (!firstInA.has(r.key)) firstInA.set(r.key, i); });
  // Anchors: B rows already on A. Their A positions must strictly increase.
  const anchors = [];
  let lastA = -1;
  const seenB = new Set();
  let duplicates = 0;
  for (let j = 0; j < B.length; j += 1) {
    const r = B[j];
    if (seenB.has(r.key)) { duplicates += 1; B[j] = { ...r, drop: true }; continue; } // a repeat within the new ref itself
    seenB.add(r.key);
    if (!firstInA.has(r.key)) continue;
    const i = firstInA.get(r.key);
    if (A[i].line.trim() !== r.line.trim()) return { ok: false, reason: 'conflicting-row', error: `row ${r.key} differs between the two refs` };
    if (i <= lastA) return { ok: false, reason: 'order-conflict', error: `row ${r.key} is in a different order on the two refs` };
    lastA = i;
    anchors.push({ i, j });
    duplicates += 1;
  }
  const out = [];
  let ai = 0;
  let bj = 0;
  const gap = (aEnd, bEnd) => {
    const a = A.slice(ai, aEnd);
    const b = B.slice(bj, bEnd).filter((r) => !r.drop && !firstInA.has(r.key));
    let x = 0;
    let y = 0;
    while (x < a.length || y < b.length) {
      if (x < a.length && y < b.length && a[x].t === b[y].t && a[x].pr != null && a[x].pr === b[y].pr) {
        return `two rows for PR ${a[x].pr} (one per ref) carry the same time ${new Date(a[x].t).toISOString()}`;
      }
      if (y >= b.length || (x < a.length && a[x].t <= b[y].t)) out.push(a[x++].line);
      else out.push(b[y++].line);
    }
    return null;
  };
  let newOnly = 0;
  for (const { i, j } of anchors) {
    newOnly += B.slice(bj, j).filter((r) => !r.drop && !firstInA.has(r.key)).length;
    const amb = gap(i, j);
    if (amb) return { ok: false, reason: 'ambiguous-order', error: amb };
    out.push(A[i].line);
    ai = i + 1;
    bj = j + 1;
  }
  newOnly += B.slice(bj).filter((r) => !r.drop && !firstInA.has(r.key)).length;
  const amb = gap(A.length, B.length);
  if (amb) return { ok: false, reason: 'ambiguous-order', error: amb };
  return { ok: true, text: out.length ? `${out.join('\n')}\n` : '', oldRows: A.length, newOnly, duplicates };
}

/** Each line with its key, its PR (when readable) and its row time (ms), carrying the previous line's time when it has none. */
function timed(lines, idOf) {
  let t = -Infinity;
  return lines.map((line) => {
    let pr = null;
    try {
      const row = JSON.parse(line);
      const at = Date.parse(row?.at);
      if (Number.isFinite(at)) t = at;
      if (Number.isInteger(row?.pr)) pr = row.pr;
    } catch { /* keep the carried time */ }
    return { line, key: rowKey(line, idOf), t, pr };
  });
}

/**
 * PURE: rows present on only one side (by row key) — what the migration report and the kill-switch rule look at.
 * @returns {{oldOnly: number, newOnly: number, both: number}}
 */
export function compareLedgerTexts(oldText = '', newText = '', { idOf = null } = {}) {
  const keys = (t) => new Set(String(t ?? '').split('\n').filter((l) => l.trim()).map((l) => rowKey(l, idOf)));
  const a = keys(oldText);
  const b = keys(newText);
  let both = 0;
  for (const k of a) if (b.has(k)) both += 1;
  return { oldOnly: a.size - both, newOnly: b.size - both, both };
}
