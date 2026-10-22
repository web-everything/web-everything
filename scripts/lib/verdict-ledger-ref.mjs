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
 *   · soak-replay-gate.yml only lists a merge group's PRs (`merge-gate-check --list-group`): it never reads the ledger.
 *
 * THE LIFECYCLE LIVES IN GIT, NOT IN A SETTING (audit 2026-10-21: any setting that can turn the union off can hide rows
 *   the other ref holds). The NEW REF EXISTING is the switch for readers: every read fetches the old ref and, in the
 *   SAME fetch, the new ref through a glob refspec (a glob that matches nothing is not an error, so before the
 *   migration the read is today's read). Once the migration created the new ref, every reader reads the UNION of both,
 *   whatever the settings say — so no mode, rollback included, can hide a row.
 *
 * SETTINGS (cascade standard -> repo `verdictLedger.*` -> env; each value logged with its source):
 *   · `verdictLedger.ref`      (env WE_VERDICT_LEDGER_REF)      the ledger-only ref. Allow-listed, never free text.
 *   · `verdictLedger.cutover`  (env WE_VERDICT_LEDGER_CUTOVER)  WRITER switch: 'off' (DEFAULT: write the old ref, as
 *     today) | 'on' (write the new ref). 'off' is also the kill switch: readers keep the union, nothing is hidden.
 *   · `verdictLedger.retiredOldTree` (env WE_VERDICT_LEDGER_RETIRED_OLD_TREE) — with cutover 'on' only: the old ref's
 *     `verdict-ledger/` tree id, pinned once the migration report says the old ref adds nothing to the union. Readers then
 *     read the new ref alone, FENCED: if the old ref's ledger tree is not exactly the pin, the read is unreadable.
 *   (There is deliberately no `dualRead` switch: union reading is automatic and cannot be turned off; see above.)
 *
 * FAIL CLOSED: a ref that exists but cannot be read, a missing new ref while writers write it, a union that cannot be
 *   formed without guessing an order ({@link unionLedgerTexts}), or a moved fence: all `unreadable`, never partial.
 *
 * WRITE RULE: writers write exactly ONE ref and NEVER create the new ref (only the migration does, from a snapshot of
 *   the old ref, so the new ref starts as a superset of everything written before it existed). While both refs exist a
 *   writer also dedupes against the OTHER ref, so a replay (an outbox entry that landed on one ref, flushed again after
 *   a switch) is never appended to the other ref. The old ref is never deleted or rewritten by any of this.
 */

export const LEGACY_LEDGER_BRANCH = 'ops/review-requests';
export const DEFAULT_LEDGER_ONLY_BRANCH = 'ops/verdict-ledger';
/** The ONLY refs a ledger push may ever name. A setting can choose between them; it can never point a push elsewhere. */
export const ALLOWED_LEDGER_BRANCHES = Object.freeze([LEGACY_LEDGER_BRANCH, DEFAULT_LEDGER_ONLY_BRANCH]);
export const LEDGER_REF_ENV = 'WE_VERDICT_LEDGER_REF';
export const LEDGER_CUTOVER_ENV = 'WE_VERDICT_LEDGER_CUTOVER';
export const LEDGER_RETIRED_OLD_TREE_ENV = 'WE_VERDICT_LEDGER_RETIRED_OLD_TREE';
const CUTOVER_MODES = Object.freeze(['off', 'on']);
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validRef = (v) => typeof v === 'string' && v !== LEGACY_LEDGER_BRANCH && ALLOWED_LEDGER_BRANCHES.includes(v);

/** The full push ref for an allow-listed ledger branch. THROWS on anything else (no ref is ever pushed unchecked). */
export function ledgerPushRefFor(branch) {
  if (!ALLOWED_LEDGER_BRANCHES.includes(branch)) {
    throw new Error(`verdict-ledger-ref: refusing to push "${branch}": not a ledger ref (allowed: ${ALLOWED_LEDGER_BRANCHES.join(', ')})`);
  }
  return `refs/heads/${branch}`;
}

/**
 * The refspec that fetches `branch` into its remote-tracking ref. For the LEDGER-ONLY ref it is a GLOB on purpose: a
 * glob that matches nothing is not a fetch error, so one fetch learns both "the new ref's tip" and "there is no new
 * ref" without failing today's read. The old ref keeps its exact refspec (its absence stays a read failure, as today).
 */
export function ledgerFetchRefspec(branch) {
  if (branch === LEGACY_LEDGER_BRANCH) return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
  ledgerPushRefFor(branch);
  return `+refs/heads/${branch}*:refs/remotes/origin/${branch}*`;
}

/**
 * PURE settings cascade. Invalid layers are ignored and named in `invalid` (the layer below answers).
 * @returns {{ref: string, cutover: 'off'|'on', retiredOldTree: string|null, writeBranch: string,
 *   sources: object, invalid: string[], overridden: string[]}}
 */
export function resolveLedgerRefSettings({ repo, env } = {}) {
  const out = { ref: DEFAULT_LEDGER_ONLY_BRANCH, cutover: 'off', retiredOldTree: null };
  const sources = { ref: 'standard', cutover: 'standard', retiredOldTree: 'standard' };
  const invalid = [];
  const layer = isPlainObject(repo?.verdictLedger) ? repo.verdictLedger : {};
  if (Object.hasOwn(layer, 'ref')) { if (validRef(layer.ref)) { out.ref = layer.ref; sources.ref = 'repo'; } else invalid.push('repo.verdictLedger.ref'); }
  if (Object.hasOwn(layer, 'cutover')) { if (CUTOVER_MODES.includes(layer.cutover)) { out.cutover = layer.cutover; sources.cutover = 'repo'; } else invalid.push('repo.verdictLedger.cutover'); }
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
  if (raw(LEDGER_RETIRED_OLD_TREE_ENV) !== undefined) {
    const v = raw(LEDGER_RETIRED_OLD_TREE_ENV).toLowerCase();
    if (OID_RE.test(v)) { out.retiredOldTree = v; sources.retiredOldTree = 'env'; } else invalid.push(`env.${LEDGER_RETIRED_OLD_TREE_ENV}`);
  }
  const overridden = [];
  if (out.cutover !== 'on' && out.retiredOldTree) { overridden.push(`retiredOldTree ignored (cutover ${out.cutover}: the old ref is being written)`); out.retiredOldTree = null; }
  return { ...out, writeBranch: out.cutover === 'on' ? out.ref : LEGACY_LEDGER_BRANCH, sources, invalid, overridden };
}

export function formatLedgerRefSettings(s) {
  const tail = [s.invalid?.length ? `ignored invalid: ${s.invalid.join(', ')}` : '', s.overridden?.length ? `overridden: ${s.overridden.join(', ')}` : '']
    .filter(Boolean).map((t) => `, ${t}`).join('');
  const plan = ledgerReadPlan(s);
  return `verdict-ledger-ref: verdictLedger.ref=${s.ref} (${s.sources.ref}), verdictLedger.cutover=${s.cutover} (${s.sources.cutover}), `
    + `verdictLedger.retiredOldTree=${s.retiredOldTree ?? 'none'} (${s.sources.retiredOldTree}); writes -> ${s.writeBranch}; `
    + `reads -> ${plan.fence ? `${s.ref} only (fence ${LEGACY_LEDGER_BRANCH}:${s.retiredOldTree.slice(0, 12)})` : `${LEGACY_LEDGER_BRANCH}, plus ${s.ref} whenever it exists`}${tail}`;
}

/**
 * PURE: what a read does. Both refs are always fetched (one fetch). `requireNew`: a missing new ref is unreadable
 * (writers write it). `fence`: read the new ref alone and require the old ref's ledger tree to equal the pin.
 * @returns {{newRef: string, requireNew: boolean, fence: {branch: string, tree: string}|null}}
 */
export function ledgerReadPlan(s) {
  const fence = s.cutover === 'on' && s.retiredOldTree ? { branch: LEGACY_LEDGER_BRANCH, tree: s.retiredOldTree } : null;
  return { newRef: s.ref, requireNew: s.cutover === 'on', fence };
}

/**
 * PURE: where a write goes, and which OTHER ref its rows are deduped against WHEN THAT REF EXISTS (the writer learns
 * that from the same fetch). Retired old ref: every old row is on the new ref (the pin's precondition), so the new
 * ref's own ids suffice.
 * @returns {{branch: string, dedupeAlso: string|null}}
 */
export function ledgerWritePlan(s) {
  if (s.cutover === 'on') return { branch: s.ref, dedupeAlso: s.retiredOldTree ? null : LEGACY_LEDGER_BRANCH };
  return { branch: LEGACY_LEDGER_BRANCH, dedupeAlso: s.ref };
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

function rowsOf(text, idOf) {
  return String(text ?? '').split('\n').filter((l) => l.trim()).map((line) => {
    let pr = null;
    try { const row = JSON.parse(line); if (Number.isInteger(row?.pr)) pr = row.pr; } catch { /* no PR: its own group */ }
    return { line, key: rowKey(line, idOf), group: pr == null ? 'no-pr' : `pr:${pr}` };
  });
}

/**
 * PURE UNION of two ledger texts, or a refusal. NO TIMESTAMPS ARE TRUSTED (audit 2026-10-21: any time-based merge of
 * two append orders can put an older verdict after a newer one). The fold is per PR (last bearing verdict wins), so:
 *   · CONTENT: every occurrence of a row id, on either ref, must be byte-identical; else `conflicting-row`.
 *   · OWNERSHIP: for each PR, the rows only one ref holds must all be on the SAME ref (that ref "owns" the PR); a PR
 *     written on both refs since they diverged has no knowable order: `ambiguous-order`.
 *   · ORDER: for each PR, the rows both refs hold must be in the same relative order on both; else `order-conflict`.
 *   · OUTPUT: each PR's rows are EXACTLY its owning ref's own sequence for that PR (the other ref holds a subset of it).
 *     Old-owned PRs in old-ref order, then new-owned PRs in new-ref order. Order ACROSS PRs is not meaningful to the
 *     fold and is not preserved.
 * Malformed lines are grouped as one pseudo-PR under the same rules and pass through for the strict reader to reject.
 * @returns {{ok: true, text: string, oldRows: number, newOnly: number, oldOnly: number, shared: number, newOwned: number}
 *   | {ok: false, reason: 'conflicting-row'|'ambiguous-order'|'order-conflict', error: string}}
 */
export function unionLedgerTexts(oldText = '', newText = '', { idOf = null } = {}) {
  const A = rowsOf(oldText, idOf);
  const B = rowsOf(newText, idOf);
  const bytes = new Map();
  for (const r of [...A, ...B]) {
    const b = r.line.trim();
    if (!bytes.has(r.key)) bytes.set(r.key, b);
    else if (bytes.get(r.key) !== b) return { ok: false, reason: 'conflicting-row', error: `row ${r.key} has different content in two places` };
  }
  const keysA = new Set(A.map((r) => r.key));
  const keysB = new Set(B.map((r) => r.key));
  const groups = new Map(); // group -> {oldOnly, newOnly}
  const g = (name) => { if (!groups.has(name)) groups.set(name, { oldOnly: 0, newOnly: 0 }); return groups.get(name); };
  let oldOnly = 0;
  let newOnly = 0;
  for (const r of A) if (!keysB.has(r.key)) { g(r.group).oldOnly += 1; oldOnly += 1; }
  for (const r of B) if (!keysA.has(r.key)) { g(r.group).newOnly += 1; newOnly += 1; }
  for (const [name, c] of groups) {
    if (c.oldOnly && c.newOnly) return { ok: false, reason: 'ambiguous-order', error: `${name} has rows only on the old ref AND rows only on the new ref` };
  }
  // Shared rows: same relative order per group on both refs (first occurrences).
  const sharedSeq = (rows, other) => {
    const seq = new Map();
    const seen = new Set();
    for (const r of rows) {
      if (!other.has(r.key) || seen.has(r.key)) continue;
      seen.add(r.key);
      if (!seq.has(r.group)) seq.set(r.group, []);
      seq.get(r.group).push(r.key);
    }
    return seq;
  };
  const sa = sharedSeq(A, keysB);
  const sb = sharedSeq(B, keysA);
  let shared = 0;
  for (const [name, seqA] of sa) {
    shared += seqA.length;
    if (seqA.join('\n') !== (sb.get(name) ?? []).join('\n')) return { ok: false, reason: 'order-conflict', error: `${name}: rows on both refs are in a different order` };
  }
  const newOwned = new Set([...groups].filter(([, c]) => c.newOnly).map(([name]) => name));
  const out = [...A.filter((r) => !newOwned.has(r.group)), ...B.filter((r) => newOwned.has(r.group))].map((r) => r.line);
  return { ok: true, text: out.length ? `${out.join('\n')}\n` : '', oldRows: A.length, newOnly, oldOnly, shared, newOwned: newOwned.size };
}

/**
 * PURE: rows present on only one side (by row key) — what the migration report looks at.
 * @returns {{oldOnly: number, newOnly: number, both: number}}
 */
export function compareLedgerTexts(oldText = '', newText = '', { idOf = null } = {}) {
  const keys = (t) => new Set(rowsOf(t, idOf).map((r) => r.key));
  const a = keys(oldText);
  const b = keys(newText);
  let both = 0;
  for (const k of a) if (b.has(k)) both += 1;
  return { oldOnly: a.size - both, newOnly: b.size - both, both };
}
