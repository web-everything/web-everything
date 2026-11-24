## Post-accept advisory production ratings

The CLI records later verdict ratings after the loop recorder has established the run marker.
`advisory-rating` rows name an earlier would-card accept and reuse its repository/PR/head identity.
Match cited findings with `roundCardsFindingsFingerprint`; without a valid path, require a stable
finding ID rather than the fingerprint's prose fallback. Replay and the writer share this identity
helper and the recorded-order boundary. Deduplicate by accepted head, finding identity, impact,
and verdict across runs. Both confirmed and plausible broken ratings have production writers;
only confirmed ratings increase `laterBroken`, while plausible ratings feed `unconfirmedBroken`.
The CLI regression compares all live effects with mode off and exercises replay and writer/logger
failures. Policy and persisted-IO probes cover refusal, lock ownership, and concurrent deduplication.

The auto-discovered `post-accept-advisory-shadow-replay` soak scenario drives the production
review loop with in-memory runs, ledger IO and effect sinks. It replays an accepted head and
a later reviewed head, compares off/shadow/on live effects, distinguishes confirmed from plausible
broken ratings, and injects writer and logger failures without contacting GitHub or changing Git.

