## Persisted pending and queue retention

Every new persisted pending/queue file needs a documented TTL or maximum entry count and a named test
that exercises expiry or capacity. Bound consumer work on historical files too, before expensive probes.
Test terminal cleanup separately from successful delivery, preserve concurrent replacement identities,
and reach throwing emitters before asserting retry retention. Overlay adoption uses a seven-day TTL and
128 entries per clone; terminal loader outcomes remove their own registration nonce.
An adoption-during-wait cleanup test must observe a persisted pending record during at least one
polling sleep, then adoption and cleanup; immediate adoption alone does not exercise the wait path.

For new operation refusal branches, use table-driven cases for every bad-input detail and invalid numeric
shape, and assert the operator-facing fallback text. Pair state producers with a consumer integration test;
test failed persistence warnings explicitly so callers cannot promise an event that was never tracked.

