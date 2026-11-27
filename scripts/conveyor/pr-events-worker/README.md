# SD4: shadow occurrence receipts

`OCC_DEDUPE` accepts `off` or `shadow` (default `shadow`, declared in
`wrangler.toml`). `on` and unknown values refuse startup. This isolated Worker
uses its deployment binding, not the host daemon settings cascade. Effective
mode comes from the binding or the core default; no consumer setting changes.

`occurrenceId(kind, payloadOrRestObject)` defines the shared identity contract:

| Kind | Occurrence |
| --- | --- |
| check_run.completed | `gh/check_run/<id>/completed` |
| pull_request_review.submitted or dismissed | `gh/review/<id>/<action>` |
| issue_comment.created (classified only) | `gh/comment/<id>/created` |
| pull_request.opened | `gh/pr/<id>/opened` |
| pull_request.synchronize | `gh/pr/<id>/sync/<before>..<after>` |

REST objects default to completed/submitted/created/opened respectively. A
dismissal must supply its action. Synchronize requires both before and after;
a poll that sees only the head is an observation, never this occurrence.
Only positive safe integer native IDs count as evidence. The parser keeps
`native: {id, type}` and `occ` for edge events; missing evidence stays null.
It keeps the legacy level parser shape; the log adds level diagnostics.

PR labeled/unlabeled/closed/reopened/ready_for_review/converted_to_draft,
check_suite.completed, and merge_group events are level observations. Their
stored `occ` is null and `level` is true. Their receipt key is
`gh/delivery/<delivery GUID>`; separate observations never become one native
occurrence. Missing delivery IDs leave level identity unknown.

Shadow adds `occ`, `native` (edges), `level`, `occMissing`, and `occDuplicate`
to stored GitHub rows. These are diagnostics only. Receipt matches neither
suppress rows nor authorize actions. Existing retained delivery-ID dedupe stays
in place in both modes, as does runtime cause-keyed dedupe. Replaying after row
pruning allocates a new sequence, with the same occurrence and a duplicate
annotation. `off` strips these fields and does no receipt IO. Bootstrap remains
an observation import, not an occurrence producer.

Receipt lookup, write, pruning, row insertion, projection and sequence changes
share one storage transaction. Failure rolls everything back and signed intake
returns 503 so the delivery can be retried. Unsigned input reaches no storage.
Receipts use a separate indexed SQL table, retained for 14 days and at most
250,000 keys. Expiry precedes lookup; overflow evicts oldest first by original
sequence, even if the clock moves backwards. Replays do not refresh receipts.
`occDuplicates`, `occMissing`, and `occReceiptEvictions` are durable meta counters.
Beyond the receipt window identity is unknown again: the operator fallback is
replay/reconcile against current authoritative state, never treating a missing
receipt as permission to act. Receipt eviction does not change feed gap rules.

Runtime audit: repository callers of `appendRuntimeEvent` are currently tests;
there is no production caller to repair. The client forwards the supplied
`cause` unchanged. Its existing key remains
`rt:[repo, number, head, action, cause, type]`; a genuine repeat requires a new
cause. Runtime retention/receipts remain separate and unchanged.

## Later move slices (not implemented here)

| Step | Authority and writers | Crash / abort |
| --- | --- | --- |
| Statute | A at epoch N; writers use A | Name kind, A/B, and pre-authorized abort/rollback commands |
| Registry sealing | A at N; conditional stable → sealing with move ID | Same ID resumes; other ID refuses; abort restores stable |
| Source seal | No authority; all writers refuse; durable producers buffer, ephemeral producers fail loudly | Read A's own seal and seal sequence S; abort unseals A at N |
| Staged copy through S | No authority; B accepts only staged copy writes | Resume from staged high sequence; abort drops staging and unseals A |
| Digest verify | No authority; per-key snapshot digests must match | Reverify on restart; mismatch retries copy once, then aborts |
| Epoch grant | Conditional verified → granted B at N+1; B opens only after registry read inside blockConcurrencyWhile | Restart reads registry; A can no longer unseal N |
| Replay | B at N+1; producers replay outboxes using occurrence receipts | Repeat safely after crash |
| Stable | B at N+1; registry marks stable | Normal operation |
| Rollback | New B → A move at N+1 → N+2 | Never unseal A at N |

Restore below the registry's last acknowledged sequence starts a new random
generation and stays closed until the registry grants the current epoch.
Verdict-ledger judgments require their own statute before moving.

Deployment and live GitHub redelivery are operator work after this slice. Local
signed-request replay with an isolated store verifies the receipt path without
deploying or contacting GitHub.
