# CKLST-B frozen evidence

The rules source, rule vectors, schema dependencies and both #7236 seat sets are copied from the core/verdict v0.1.2 and CKLST rubric handoffs. The rules source SHA-256 is pinned in the adapter and checked alongside every v0.1.2 rule vector.

`vectors/live-7236.tree.json` retains the union of lines cited by the Core and organization #7236 assessments. Every retained line keeps its original number and exact text; unrelated source lines are omitted, including synthetic App-id setup that trips the repository privacy screen. The reader fixture reconstructs line offsets for this sparse snapshot. This is offline citation replay, not a new live review or a proof of the claims cited.

The wrapper tests supply their net-diff context explicitly. The original #7236 answers contain MP n/a entries; the WE residual check independently refuses such entries when the supplied diff touches merge-path machinery.

The published `security.rubric.json` (2026-11-22.2) and `policy.company.json` are byte-identical snapshots of the refreshed handoff. Their MP `naWhen` digest is explicitly a placeholder in the handoff builder. The adapter publishes the real `MERGE_PATH_CHECK_DEFINITION` and returns its canonical digest from `mergePathNaCheck`; the placeholder fails closed until Standards/plateau-settings repins it. Conditional test inputs deliberately repin a clone of this fixture to that real definition. Historical live sets retain their PR-era rubric/policy digests.

The production settings reader supplements the frozen v0.1.2 cascade with an effective per-item minimum check. This closes a vendor gap where a newly introduced child override could weaken the parent global minimum without confirmation; the exact vendored source and its parity vectors remain unchanged. New, changed and removed overrides are covered through `readSeatSettings`, including confirmations bound to the child policy digest.
