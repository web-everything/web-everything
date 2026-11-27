/** Live producer tables are proofs only when every required check has one determinate row. */
import { SMOKE_CHECKS, classifySmokeFailure } from '../../daemon-live-smoke.mjs';

export function smokeEvidenceProblem(result) {
  if (!result || typeof result !== 'object' || typeof result.verdict !== 'string') return 'incomplete-evidence';
  const smoke = result.smoke;
  // The injected runner API also supports verdict summaries (without the live producer's `pass` field).
  // Preserve that API; proving rate-limit-only failure additionally requires a full producer table.
  if (smoke && !Object.hasOwn(smoke, 'pass')) {
    if (!Array.isArray(smoke.results)) return 'incomplete-evidence';
    if (smoke.results.length > SMOKE_CHECKS.length) return 'indeterminate-evidence';
    return smoke.results.every(row => row && typeof row.name === 'string' && typeof row.ok === 'boolean')
      ? null : 'indeterminate-evidence';
  }
  if (!smoke || !Array.isArray(smoke.results)) return 'incomplete-evidence';
  if (smoke.results.length > SMOKE_CHECKS.length) return 'indeterminate-evidence';
  if (smoke.results.length < SMOKE_CHECKS.length) return 'incomplete-evidence';
  if (typeof smoke.pass !== 'boolean') return 'indeterminate-evidence';
  const invalidDiagnostics = row => ['detail', 'stderrTail'].some(key => row[key] !== undefined
    && (typeof row[key] !== 'string' || row[key].length > 4000));
  const failed = smoke.results.filter(row => row?.ok === false);
  // Passing rows' diagnostics are optional when every failure independently
  // proves code rejection. They still cannot authorize adoption or an environment
  // exemption: mixed/uncertain failures require the complete diagnostic table.
  const definiteRejection = result.verdict === 'code' && failed.length > 0
    && failed.every(row => !invalidDiagnostics(row) && classifySmokeFailure([row]) === 'code');
  for (const { name } of SMOKE_CHECKS) {
    const rows = smoke.results.filter(row => row?.name === name);
    if (rows.length !== 1 || typeof rows[0].ok !== 'boolean') return 'indeterminate-evidence';
    if (invalidDiagnostics(rows[0]) && !(rows[0].ok === true && definiteRejection)) return 'incomplete-evidence';
  }
  if (smoke.pass !== smoke.results.every(row => row.ok === true)
    || (result.verdict === 'pass') !== smoke.pass) return 'indeterminate-evidence';
  return null;
}
