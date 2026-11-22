/**
 * @file scripts/operations/check-scope-operation.mjs
 * @description READ-ONLY declaration of `check-scope`: which open PRs / agent claims share these files?
 * Both steps are `compute` and the evidence reader (`check-scope.mjs#checkScope`, with its gh/registry/git reads) is
 * injected by `./run.mjs`, so this module imports only `registry.mjs` and `step-kinds.mjs`.
 *
 * WHY it may be declared read-only: the injected reader asks the collector for `readOnly: true`, so its git reads create
 * no ref and no FETCH_HEAD, and whatever they fetch lands in a throwaway object directory removed afterwards (see
 * `free-scope-io.mjs#gitExecQuarantined`). The import graph here cannot prove that, so
 * `__tests__/free-scope-io-real.test.mjs` runs the real reader against a real checkout and asserts it is unchanged.
 *
 * WHY no `effect` step: an effect is stored as `applied` on the run record, and a resumed completed run reuses it
 * without reading anything again, so a stale "clear" could outlive the evidence it came from. A `compute` step is
 * re-run on every invocation, so each verdict is built from evidence read right then.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const CHECK_SCOPE_OP = 'check-scope';

export function checkScopeOperation({ check } = {}) {
  if (typeof check !== 'function') throw new TypeError('check-scope needs a check reader');
  return op(CHECK_SCOPE_OP, {
    input: { files: { type: 'string' } }, verdictFrom: 'assess',
    verify: compute({ reads: ['input.files'], fn: ({ input }) => check({ declaredFiles: String(input.files ?? '') }) }),
    assess: compute({ reads: ['findings.verify'], fn: ({ findings }) => findings.verify ?? { ok: false, overlaps: [], reason: 'scope check did not run' } }),
  });
}
