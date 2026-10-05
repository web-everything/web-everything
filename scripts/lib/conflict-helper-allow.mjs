/**
 * Narrow pre-grant for unattended fix/ci-heal conflict resolution (PR #3964).
 * The helper enforces lane, active-merge and unmerged-file boundaries; granting git
 * or arbitrary node would lose those boundaries. Keep both script quoting forms,
 * because dispatch briefs and human invocations use both. PURE, with no settings IO.
 */
export function conflictHelperAllowRules(weRoot) {
  if (!weRoot) return [];
  return [
    `Bash(node ${weRoot}/scripts/conveyor/resolve-conflict.mjs:*)`,
    `Bash(node "${weRoot}/scripts/conveyor/resolve-conflict.mjs":*)`,
  ];
}
