/** @file Pure (no IO) required-check implication table; kept apart so read-only modules may import it. */

/**
 * LIVE INCIDENT 2026-10-07 (PR #4271): the operator added `integration` as a required check (#4261 split it out of
 * `test`). Every head pushed BEFORE that job existed has no `integration` run, so each one read `missing` and no
 * review dispatched until a CI rerun. But `test` is the aggregate over it (`.github/workflows/ci.yml` `test` job fails
 * when `needs.integration` does not succeed), so a SUCCESSFUL `test` already proves the integration suite passed.
 * Map: required name -> aggregate check(s) whose success implies it. Add a row here when a job is split out of an
 * aggregate; no other list needs to learn the new required name.
 */
export const REQUIRED_CHECK_IMPLIED_BY = Object.freeze({ integration: Object.freeze(['test']) });

/**
 * The required set minus every name that is absent from `rows` but implied by a successful aggregate in `rows`.
 * PURE. Never drops a name that has its own row (that row is judged on its own), never drops one whose aggregate is
 * missing, pending or failing.
 * @param {string[]|undefined} requiredChecks
 * @param {Array<object>} rows check-run rows or rollup entries (`name`/`context`, `status`, `conclusion`)
 */
export function withoutImpliedRequiredChecks(requiredChecks, rows) {
  if (!Array.isArray(requiredChecks)) return requiredChecks;
  const list = Array.isArray(rows) ? rows : [];
  const nameOf = row => row?.name ?? row?.context;
  const green = name => {
    const mine = list.filter(row => nameOf(row) === name);
    return mine.length > 0 && mine.every(row => String(row.conclusion ?? '').toLowerCase() === 'success'
      && String(row.status ?? 'completed').toLowerCase() === 'completed');
  };
  return requiredChecks.filter(name => {
    const impliers = REQUIRED_CHECK_IMPLIED_BY[name];
    if (!impliers || list.some(row => nameOf(row) === name)) return true;
    return !impliers.some(green);
  });
}
