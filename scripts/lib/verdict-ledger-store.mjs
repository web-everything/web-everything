/**
 * @file scripts/lib/verdict-ledger-store.mjs
 * @description THE LEDGER STORE CONTRACT AND REGISTRY (card xsij7u6). PURE: no I/O, no import of the ledger.
 *   The delivery system splits into a protocol/standard (event schema, fold, THIS contract), a core
 *   implementation with pluggable stores, and a product store (Plateau). This file is the seam between them.
 *
 * ONE CONTRACT. A store is an object:
 *   - `name`          string, the registry key (what `verdictLedger.store` selects).
 *   - `capabilities`  `{durable, shared, ordering, singleWriter}` (see {@link validateLedgerStore}).
 *   - `append(rows, ctx)` -> Promise of `{ok: true, appended: n, duplicates: d}` | `{ok: false, appended: k, error}`.
 *        Resolves, never throws or rejects. Append is idempotent by event id, including repeats within a batch.
 *        An all-duplicate batch writes nothing. Each newly written row carries its event id.
 *        `rows` are a non-empty array of ledger events of ONE repo; `ctx.repo` names it. An invalid row refuses
 *        the whole call (`appended: 0`, nothing written), and a row is never repaired: one whose own `repo` is
 *        missing, malformed or different from `ctx.repo` is invalid. On an I/O failure `appended` is the count really
 *        written, so a caller never has to guess.
 *   - `read(range)`   -> Promise of `{status: 'ok', rows}` | `{status: 'unreadable', reason, error}`.
 *        Resolves, never throws or rejects.
 *        `range` is `{repo, from?}`; `from` skips that many leading rows (default 0).
 *        A read that FAILS is `unreadable`, NEVER an empty `ok`. Only a store that was really read and has no
 *        rows for the repo answers `{status: 'ok', rows: []}`.
 *
 * Capabilities explicitly declare whether rows are shared across machines (local stores say shared:false),
 * and how concurrent writers avoid losing rows (singleWriter).
 *
 * Callers select a store by name through {@link getLedgerStore}; a future store (Plateau) calls
 * {@link registerLedgerStore} and no caller changes.
 */

export const LEDGER_SINGLE_WRITER = Object.freeze(['file-lock', 'push-race-retry', 'single-object', 'none']);

/** Stable descriptor for reports; no I/O. */
export function describeLedgerStore(store) {
  const { durable, shared, ordering, singleWriter } = store.capabilities;
  return { name: store.name, durable, shared, ordering, singleWriter };
}

export const LEDGER_ORDERINGS = Object.freeze(['none', 'append', 'total']);

/**
 * Check a store against the contract's static shape. Behaviour is checked by the conformance suite.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateLedgerStore(store) {
  const errors = [];
  if (!store || typeof store !== 'object') return { ok: false, errors: ['store must be an object'] };
  if (typeof store.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(store.name)) errors.push('name must be a lowercase slug');
  if (typeof store.append !== 'function') errors.push('append must be a function');
  if (typeof store.read !== 'function') errors.push('read must be a function');
  const c = store.capabilities;
  if (!c || typeof c !== 'object') errors.push('capabilities must be an object');
  else {
    if (typeof c.durable !== 'boolean') errors.push('capabilities.durable must be a boolean (survives the writing process)');
    if (typeof c.shared !== 'boolean') errors.push('capabilities.shared must be a boolean (visible to other machines)');
    if (!LEDGER_SINGLE_WRITER.includes(c.singleWriter)) errors.push(`capabilities.singleWriter must be one of ${LEDGER_SINGLE_WRITER.join('|')}`);
    if (!LEDGER_ORDERINGS.includes(c.ordering)) errors.push(`capabilities.ordering must be one of ${LEDGER_ORDERINGS.join('|')}`);
  }
  return { ok: errors.length === 0, errors };
}

const registry = new Map();

/** Register (or replace) a store by name. Refuses a store that fails {@link validateLedgerStore}. */
export function registerLedgerStore(store) {
  const v = validateLedgerStore(store);
  if (!v.ok) throw new TypeError(`verdict-ledger-store: invalid store: ${v.errors.join('; ')}`);
  registry.set(store.name, store);
  return store;
}

/** The registered store named `name`, or null. */
export function getLedgerStore(name) {
  return registry.get(String(name ?? '').trim().toLowerCase()) ?? null;
}

/** Registered store names, in registration order. */
export function ledgerStoreNames() {
  return [...registry.keys()];
}
