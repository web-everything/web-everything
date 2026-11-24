## Author-stamp repair daemon wiring

PR author logins from `gh pr view` can carry `app/`, while GraphQL edit editor logins do not.
Normalize only the PR author by removing one leading `app/` and comparing case-insensitively.
The review daemon must explicitly pass `restoreStamps: sweepAuthorStamps` to hold reconciliation,
including with shared PR reads: an injected listing otherwise suppresses the default stamp sweep.
Keep daemon wiring tests hermetic by inspecting the passed function without invoking it;
the stamp and hold-reconcile suites exercise the repair through injected IO.
Every default restoration read (listing, live body, history, pre-write body) goes through
`createMqLiveReader`, so the smoke read memo (`WE_GH_READ_MEMO_DIR`) can never serve the pre-write
comparison a cached body. The regression drives the real `gh-throttle` memo with a fake `gh`.
Hold reconciliation's default PR state, review and comment readers (`createLiveHoldReaders`) strip
the memo too, because `readLiveState` is re-read right before each label write.

### Author-stamp restoration evidence

`author-stamp-restore` fixtures must preserve GraphQL editor `__typename` alongside
`login`: `app/X` PR authors match only `Bot` editors, and plain `X` authors match only
`User` editors. Missing or unknown types refuse. Historical bodies must be plain
snapshots; a hunk header, word-diff token (`[-`, `-]`, `{+`, `+}`), or HTML in any snapshot
refuses the whole history without writing. Every occurrence of `authored-by-actor:`
must belong to a complete marker occupying an entire unindented line outside a code
fence, with only optional trailing whitespace. Exercise malformed markers in an
otherwise eligible oldest author snapshot, without an earlier forgery masking the
refusal; keep the pr-land final standalone marker as a positive case. Refusal directs operators to inspect
the complete GitHub history manually; never turn ambiguous delta text into a stamp.

