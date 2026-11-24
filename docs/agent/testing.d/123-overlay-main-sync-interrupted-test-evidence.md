## Overlay main-sync interrupted test evidence

A heavy-admission test timeout or killed process is incomplete evidence even if it left a green
report. Retry the same chunk once with a distinct report path; a second interruption fails closed
with the structured cause ahead of the cleaned diagnostic tail and asks for operator review.
Remote termination unconfirmed remains a skip, including on the retry. Ordinary test failures
retain the failed-file flake reruns and plain-main comparison. The killed-run soak proves the retry
by executing an injected killed-once, then green runner; its presence probe uses behavior, not source markers.
Stop text in stderr cannot classify an ordinary exit (0 or 1) as interrupted. Retry an interrupted
attempt only when neither stdout nor stderr (ANSI stripped) nor partial JSON contains red evidence.
TAP `not ok`, Vitest `FAIL`/`×`/`✗`, positive failed summary counts, and failed JSON rows (including
extra files and unnamed assertions) block immediately with the interruption cause, `attempts: 1`,
and failing names preserved in the diagnostic tail. A green retry cannot erase an observed failure.
Vitest's `Unhandled Errors`/`Unhandled Rejection` headers and `Errors N error(s)` summaries also
block retry in either output stream. Only ENOENT at the initial report stat is absent evidence:
an existing report that cannot be read, parsed or structurally validated, or exceeds 8 MiB, blocks
the first attempt with the report failure in the diagnostic and an operator-review escalation.
Keep ordinary flake rerun identity/count coverage checks unchanged. Run `overlay-main-sync-rerun.test.mjs`,
`daemon-rebuild-overlay-main-sync.test.mjs`, and the killed-run soak through heavy admission.
