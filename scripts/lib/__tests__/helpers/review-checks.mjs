import { readReviewCiGate as readGate } from '../../review-ci-gate-io.mjs';

/** Attest a hermetic feed as an exhaustive read of the requested head.
 * Explicit provenance (including incomplete or partial metadata) is preserved verbatim.
 * Row contents are never repaired: missing, malformed and foreign-head rows stay invalid.
 */
export const exhaustiveReadChecks = readChecks => args => {
  const rows = readChecks(args);
  if (!Array.isArray(rows) || 'rowsHead' in rows || 'rowsComplete' in rows) return rows;
  return Object.defineProperties([...rows], {
    rowsHead: { value: args.headSha ?? args.sha }, rowsComplete: { value: true },
  });
};

export const readReviewCiGate = options => readGate({ ...options,
  ...(options.readChecks ? { readChecks: exhaustiveReadChecks(options.readChecks) } : {}),
});
