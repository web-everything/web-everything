## Canonical audit admission regression fixtures

Keep the default canonical checker in producer integration tests and replace only filesystem and
Git effects. Exercise both `open-pr` and direct `pr-land`, including dry runs, with a docs-only
changed-file list and missing evidence; refusal must precede publication. First-open fixtures need
an unpublished local head, an exact-head pass, and another head's fingerprinted history: fingerprint
the resolved local SHA without fetching the unpublished lane ref. A failed diff or main fetch still
refuses. Include valid JSON negative records with invalid timestamps or contradictory findings next
to an older pass, plus carried and waived paths; malformed records require repair before re-auditing.

