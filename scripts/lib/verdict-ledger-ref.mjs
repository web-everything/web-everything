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
 *   · `verdictLedger.cutover`  (env WE_VERDICT_LEDGER_CUTOVER)   'off' (DEFAULT: today) | 'on' (writers write `ref`).
 *   · `verdictLedger.dualRead` (env WE_VERDICT_LEDGER_DUAL_READ) false (DEFAULT: today) | true.
 *
 * READ PLAN (pure: {@link ledgerReadPlan}):
 *   cutover off, dualRead off  -> old ref only                          (today, byte for byte)
 *   dualRead on (either mode)  -> UNION(new, old); an ABSENT ref adds nothing (except the new ref with cutover on,
 *                                 whose absence is unreadable); both absent -> unreadable
 *   cutover on,  dualRead off  -> new ref only; absent -> unreadable
 * FAIL CLOSED: in a union, a ref that EXISTS but cannot be read makes the whole read `unreadable` (never a partial
 *   answer — a hold row on the unread side would vanish). "Absent" is only ever a definitive empty `ls-remote`.
 *
 * WRITE RULE: writers write exactly ONE ref — the old one with cutover off, `ref` with cutover on. Writers NEVER
 *   create the new ref: only the migration (`we:scripts/verdict-ledger-migrate.mjs`) does, from a snapshot of the
 *   old ref, so the new ref always starts as a superset of everything written before it existed. A cutover set before
 *   the migration ran makes every write fail loudly (no ref to fetch), never write an empty-rooted ledger.
 *
 * KILL SWITCH: set cutover back to 'off' and KEEP dualRead on. Writers return to the old ref; readers still union, so
 *   nothing written to the new ref during the cutover disappears. dualRead goes off only once the migration report
 *   shows zero rows that exist on one ref only. The old ref is never deleted or rewritten by any of this.
 */

export const LEGACY_LEDGER_BRANCH = 'ops/review-requests';
export const DEFAULT_LEDGER_ONLY_BRANCH = 'ops/verdict-ledger';
/** The ONLY refs a ledger push may ever name. A setting can choose between them; it can never point a push elsewhere. */
export const ALLOWED_LEDGER_BRANCHES = Object.freeze([LEGACY_LEDGER_BRANCH, DEFAULT_LEDGER_ONLY_BRANCH]);
export const LEDGER_REF_ENV = 'WE_VERDICT_LEDGER_REF';
export const LEDGER_CUTOVER_ENV = 'WE_VERDICT_LEDGER_CUTOVER';
export const LEDGER_DUAL_READ_ENV = 'WE_VERDICT_LEDGER_DUAL_READ';
const CUTOVER_MODES = Object.freeze(['off', 'on']);

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
 * PURE settings cascade. Invalid layers are ignored and named in `invalid` (the layer below answers).
 * @returns {{ref: string, cutover: 'off'|'on', dualRead: boolean, writeBranch: string,
 *   sources: {ref: string, cutover: string, dualRead: string}, invalid: string[]}}
 */
export function resolveLedgerRefSettings({ repo, env } = {}) {
  const out = { ref: DEFAULT_LEDGER_ONLY_BRANCH, cutover: 'off', dualRead: false };
  const sources = { ref: 'standard', cutover: 'standard', dualRead: 'standard' };
  const invalid = [];
  const layer = isPlainObject(repo?.verdictLedger) ? repo.verdictLedger : {};
  if (Object.hasOwn(layer, 'ref')) { if (validRef(layer.ref)) { out.ref = layer.ref; sources.ref = 'repo'; } else invalid.push('repo.verdictLedger.ref'); }
  if (Object.hasOwn(layer, 'cutover')) { if (CUTOVER_MODES.includes(layer.cutover)) { out.cutover = layer.cutover; sources.cutover = 'repo'; } else invalid.push('repo.verdictLedger.cutover'); }
  if (Object.hasOwn(layer, 'dualRead')) { if (typeof layer.dualRead === 'boolean') { out.dualRead = layer.dualRead; sources.dualRead = 'repo'; } else invalid.push('repo.verdictLedger.dualRead'); }
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
  return { ...out, writeBranch: out.cutover === 'on' ? out.ref : LEGACY_LEDGER_BRANCH, sources, invalid };
}

export function formatLedgerRefSettings(s) {
  const tail = s.invalid?.length ? `, ignored invalid: ${s.invalid.join(', ')}` : '';
  return `verdict-ledger-ref: verdictLedger.ref=${s.ref} (${s.sources.ref}), verdictLedger.cutover=${s.cutover} (${s.sources.cutover}), `
    + `verdictLedger.dualRead=${s.dualRead} (${s.sources.dualRead}); writes -> ${s.writeBranch}; reads -> ${ledgerReadPlan(s).branches.join(' + ')}${tail}`;
}

/**
 * PURE: which refs a read consults, and whether an absent ref may be skipped.
 * @returns {{branches: string[], union: boolean, required: string[]}} `union` true = read every listed ref that exists
 *   and merge them. `required` = refs whose ABSENCE is itself unreadable: with cutover on, writers write the new ref, so
 *   a missing new ref means rows may have gone with it (deleted or never created) and the read must hold, not fall back.
 */
export function ledgerReadPlan(s) {
  const required = s.cutover === 'on' ? [s.ref] : [];
  if (s.dualRead) return { branches: [s.ref, LEGACY_LEDGER_BRANCH], union: true, required };
  return { branches: [s.cutover === 'on' ? s.ref : LEGACY_LEDGER_BRANCH], union: false, required };
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
 * PURE UNION of two ledger texts. A row on both refs appears ONCE; no row on either ref is dropped; malformed lines
 * pass through untouched so a strict reader still rejects them.
 *
 * ORDER MATTERS (the fold is last-bearing-verdict-wins). Each ref's own order is kept exactly; the two are then
 * MERGED by each row's `at` time, comparing only the two heads (a merge, not a sort, so neither side is reordered).
 * Why not "old first, then new": after a rollback (cutover back to off) rows on the OLD ref are newer than the new-only
 * rows, and old-first would let an older accept on the new ref supersede a newer hold on the old one. A line with no
 * readable `at` takes the time of the line before it on its own side; a tie goes to the old ref.
 * @returns {{text: string, oldRows: number, newOnly: number, duplicates: number}}
 */
export function unionLedgerTexts(oldText = '', newText = '', { idOf = null } = {}) {
  const lines = (t) => String(t ?? '').split('\n').filter((l) => l.trim());
  const oldLines = lines(oldText);
  const seen = new Set(oldLines.map((l) => rowKey(l, idOf)));
  const added = [];
  let duplicates = 0;
  for (const l of lines(newText)) {
    const k = rowKey(l, idOf);
    if (seen.has(k)) { duplicates += 1; continue; }
    seen.add(k);
    added.push(l);
  }
  const a = timed(oldLines);
  const b = timed(added);
  const all = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].t <= b[j].t)) all.push(a[i++].line);
    else all.push(b[j++].line);
  }
  return { text: all.length ? `${all.join('\n')}\n` : '', oldRows: oldLines.length, newOnly: added.length, duplicates };
}

/** Each line with its row time (ms), carrying the previous line's time when it has none. */
function timed(lines) {
  let t = -Infinity;
  return lines.map((line) => {
    try {
      const at = Date.parse(JSON.parse(line)?.at);
      if (Number.isFinite(at)) t = at;
    } catch { /* keep the carried time */ }
    return { line, t };
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
