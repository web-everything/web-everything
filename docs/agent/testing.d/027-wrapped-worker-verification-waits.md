## Wrapped worker verification waits

For the 117 S3b regression (2026-10-08), replay the saved StructuredOutput fixtures against both
reader caps and the Claude launch schema. Keep the checked-in Codex schema unchanged. A wrapped
Claude turn may end while verification runs: the wrapper publishes its own live pid and idle status,
then consumes a resume request for the same session. Use temporary await/spec/completion stores,
a fake child, and an injected clock to cover expiry, the overall deadline, foreign requests, and the
six-resume limit. Only the last turn supplies the final result, including when it omits StructuredOutput.
A wait that ends with no verdict delivered (expired or cleared record, deadline, foreign request, or the
cap spent while the last turn still awaited) is not a completion: the awaiting turn's `done` becomes a
retryable `infra-transient` block (`verify-wait`), so nothing reads an unverified, unpushed run as done.
The await-verify pass treats a session missing from an incomplete listing (either population failed to
list, or a wrapped record was unreadable) as unknown, not gone: cover it with a listing that throws.

