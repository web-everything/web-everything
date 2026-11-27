/**
 * @file scripts/lib/fix-run-infra-patterns.mjs
 * @description Leaf module (no imports) holding the launcher-infrastructure failure patterns, so light callers such as
 * fix-slot-borrow can classify a failure without loading the heavy fix-loop-ledger import graph.
 */
/** PRs #4992/#4993/#4965, 2026-10-12: failures before an agent runs are infrastructure, never repair evidence.
 * Card 5947 (live #5045, 2026-10-13) also classifies an absent CI failure. */
export const FIX_RUN_INFRA_PATTERNS = Object.freeze([
  /^no-finding:/i, /^no-ci-failure:/i, /^fix-run:/i, /^error:/i, /missing required flag/i, /has no fix launcher/i,
  /launch did not complete/i, /lane-pool/i, /Operation not permitted/i, /EPERM/i, /EACCES/i,
  /read-only file system/i, /index\.lock/i, /\.git\b/i, /sandbox/i, /could not (commit|push|stage)/i,
]);
