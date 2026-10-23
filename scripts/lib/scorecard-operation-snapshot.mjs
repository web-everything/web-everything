/**
 * Card xwu9oxh slice S2 (operation-scoped design, operator 2026-10-20): ONE read of the scorecard store shared
 * by the readers inside ONE top-level operation, passed down explicitly. There is no module-level cache: every
 * operation makes its own snapshot, and its first read is a fresh read of the file. A caller that is handed no
 * snapshot makes its own, so a standalone call reads exactly as it did before.
 *
 * The snapshot records the outcome of that one read as it happened: the read error (with its `code`), or the
 * text's parse result (the value, or the SyntaxError). Each reader then applies its OWN rules to that outcome,
 * so `readStore`'s "degrade to empty" and the saved red-team reader's fail-closed refusals are both unchanged.
 * Readers must not mutate what they get: the parsed value is shared within the operation.
 */
import { readFileSync } from 'node:fs';

/** @param {string} path - the store path this operation reads (callers compare it before reusing a snapshot). */
export function scorecardOperationSnapshot(path) {
  let outcome = null;
  return {
    path,
    /** @returns {{ok: false, error: Error} | {ok: true, value?: any, parseError?: Error}} */
    read() {
      if (outcome) return outcome;
      let text;
      try { text = readFileSync(path, 'utf8'); } catch (error) { return (outcome = { ok: false, error }); }
      try { outcome = { ok: true, value: JSON.parse(text) }; } catch (parseError) { outcome = { ok: true, parseError }; }
      return outcome;
    },
  };
}

/**
 * `readStore({ path }).records` from a snapshot: any read or parse failure, or a value without a `records`
 * array, is an empty history, as `readStore` degrades.
 */
export function snapshotStoreRecords(snapshot) {
  const r = snapshot.read();
  if (!r.ok || 'parseError' in r) return [];
  return r.value && Array.isArray(r.value.records) ? r.value.records : [];
}
