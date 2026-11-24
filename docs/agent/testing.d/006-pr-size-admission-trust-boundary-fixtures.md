## PR size admission trust-boundary fixtures

`scripts/lib/__tests__/pr-size-admission.test.mjs` exercises Git with real shadow refs and
round-trips hostile filenames through `planFileItem` and `js-yaml`. Size evidence must carry
full head/base SHAs; mock symbolic SHA strings no longer represent valid Git evidence.
Retry fixtures need a trusted card store keyed by repository and head SHA; assigning a PR
number after creation must reuse the initial card. Cover retries with and without a saved body.
Body markers are display hints; publication must be confirmed again from the store/publisher.
Size sections use exact `<!-- pr-size:begin -->` and `<!-- pr-size:end -->` markers on
their own lines. One unambiguous plain pair replaces the enclosed display text, even if
edited; no pair appends a fresh section. Malformed, partial, nested, duplicate or nonplain
markers preserve the entire body and append a fresh section. Identical retries are byte-stable,
including after a conservative append. No machine-local state is read or created (R126).
Test replacement across a fresh HOME and preserve all bytes before and after the pair,
including CRLF. PR text remains untrusted: neither delimiters nor enclosed receipts authorize
card filing or publication, which must be checked through the trusted store/publisher (R115).
The fresh-HOME child also records and rejects synchronous file open/read/write and subprocess
attempts after module loading, with diff/card effects injected. Assert no attempts on creation
or retries: an empty directory alone cannot detect a secret read whose failure was swallowed.
Without pinned evidence, the display key hashes repo, PR-or-ref, requested SHA and base; it
does not make an unresolved head eligible for trusted card lookup.
pr-land re-reads the live body after card filing and skips the note when it changed or is unreadable.
Author text is never truncated or escaped: past the forge body limit the note is skipped and the
body returned unchanged (no edit), and every fallback, including the runner's outer catch, returns
the caller's body. Reviewers are still requested in each case.
Unknown or stale evidence and unreadable/ambiguous stores file conservatively and request reviewers.

The legacy `file-item` scope flag is a comma list whose renderer supplies YAML double quotes.
Size admission JSON-escapes each scalar's contents before bounding entries; it also escapes YAML
line separators and trailing whitespace. Comma-bearing paths are omitted with an explicit count.
Every incomplete summary names human review of the full diff as its fallback. Keep these tests
in the shared suite and run it and the scoped producer/prepare suites through heavy admission.
Identity, path and published batch-ref validators use explicit absolute-end assertions
(`(?![\s\S])`). Keep the named trailing-newline regressions and the CR/CRLF/Unicode
line-separator suffix cases in that required scoped gate.

