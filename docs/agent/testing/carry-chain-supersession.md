## Carry-chain supersession evidence

Multi-hop acceptance proofs must inspect the complete thread before the rebase
path filters informational provenance. A standalone destination advisory or
card-queued gate before the final restamp can invalidate the chain even when
the provenance filter would otherwise remove it. Preserve the rebase path's
existing informational handling only after the full-thread proof succeeds.

An origin anchor requires a trusted acceptance heading and its reviewed SHA;
a checkmark-prefixed conveyor completion note cannot reset the hold window.
The hermetic regressions in `scripts/lib/__tests__/rebase-verdict-carry.test.mjs`
cover both boundaries alongside the existing plain and gate-prefixed chains.
