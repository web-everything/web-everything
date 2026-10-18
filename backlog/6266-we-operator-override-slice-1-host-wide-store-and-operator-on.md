---
bornAs: xkwhvyg
kind: story
size: 8
parent: "6268"
status: open
scope: ["we:scripts/lib/operator-override-store.mjs", "we:scripts/lib/operator-override-attestation.mjs", "we:scripts/operations/operator-override.mjs", "we:scripts/lib/__tests__/operator-override-store.test.mjs", "we:scripts/lib/__tests__/operator-override-attestation.test.mjs", "we:.github/workflows/operator-override-approve.yml", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/http-adapter.test.mjs", "we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 1 - host-wide store and operator-only write CLI with audit log and expiry

Build the store of decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): a host-wide path outside any lane clone, one readOperatorOverrides read interface, and an operator-only write that appends a change log and supports expiry. Operator authority comes only from a channel an agent on this host cannot forge (below).

The store module, the attestation module, the operation module, the approval workflow and both tests are new files. The two operations, `operator-override-request` and `operator-override-apply`, are registered in `OPERATIONS` in we:scripts/operations/run.mjs, the way existing operations are, and get their module-map entries in we:scripts/operations/__tests__/http-adapter.test.mjs. Every input is a `--flag` (the CLI adapter rejects positional arguments): `node we:scripts/operations/run.mjs operator-override-request --key=<key> --value=<value> --instruction=… --reason=… [--expires=…] [--confirm-loosen]`, then `node we:scripts/operations/run.mjs operator-override-apply --pr=<n>`.

**Authority: a non-forgeable channel, never a local check.** No local signal is evidence of the operator: not an interactive terminal (`operatorTerminalPresent`), not the local `gh` login (`resolveOperatorCredential`), not `attemptedBy`, an environment variable, a flag, the request body or a commit author. An agent on this host can open a pseudo-terminal, clear agent environment markers and run `gh` with the credentials the host already holds, so every one of those checks can be passed by an agent. The authority instead reuses the protected-CI trust root of slice 2 A10, now carried by `#6246` (`forged-settings-operator`, with its A15 gate self-protection): the identity is the authenticated GitHub review actor, fetched by protected CI with credentials unavailable to PR jobs and agent sessions, checked against the protected operator allowlist.

1. **Request (anyone may run it; writes nothing to the store).** `operator-override-request` opens a request PR whose only change is one canonical request file, `operator-overrides/requests/<requestId>.json`, holding `key`, `value`, `expiresAt`, `confirmLoosen`, `instruction`, `reason`, a fresh `requestId` nonce, the target host id and the repository. The key is checked against `SETTABLE_OVERRIDE_KEYS` here and again at apply.
2. **Approval (only the operator).** The operator approves the request PR with a GitHub review. The protected workflow we:.github/workflows/operator-override-approve.yml runs the default branch's definition and code, never the PR's, in a GitHub environment whose secret is limited to default-branch runs. It fetches the review through the API with its own token, and accepts it only when: the review author is a human account on the operator allowlist (read from the default branch, CODEOWNERS-protected; App and bot reviews never count); the review's `commit_id` equals the PR head; and the PR diff against its base is exactly that one request file. It then signs an attestation `{ repository, pr, head, requestHash, requestId, actor, reviewId, approvedAt }` with the environment's private key. PR jobs and agent sessions never receive that key or any privileged token.
3. **Apply.** `operator-override-apply` fetches the attestation and verifies it with the public key pinned at host setup, outside any lane clone. It checks the signature, the request hash, repository, host id, PR head, freshness (`approvedAt` at most 15 minutes old and before `expiresAt`) and that the `requestId` was never applied before. Only then does it append the log record, which carries the attestation. Any caller may run apply, over the CLI or a `POST …/runs` HTTP route alike, because it can only apply exactly what the operator approved, once. Missing, unsigned, wrongly-signed, stale, replayed, wrong-repository, wrong-host, wrong-head or non-allowlisted approvals refuse the write, and nothing is written. The HTTP adapter itself is not changed.
4. **Read.** Readers re-verify every log record's attestation against the pinned key. A record without a valid one (for example an agent that wrote the log file directly) is never applied. The actor is the review author from the attestation, and the channel is `github-review`.

Agent sessions authenticate to GitHub as the role App, so their reviews are bot reviews that never count. Binding every agent credential to the role-App identity is tracked by we:backlog/6161-operator-controls-tie-actor-to-the-authenticated-identity.md; this slice does not depend on any local identity check either way.

**Read interface.** `readOperatorOverrides()` returns `{ readable, entries }`. `readable` is false when the store or snapshot cannot be read or parsed, so a caller can tell "unreadable" from "no overrides". Each entry carries `key`, `value`, `entryId` (the log line it came from), `actor`, `channel`, `at`, `instruction`, `reason`, `expiresAt`, the verified attestation and the recorded confirmation, if any. Slices 2, 3 and 4 build on exactly this shape.

**History read.** `readOperatorOverrideHistory({ after })` returns `{ readable, records, cursor }`: every committed, attestation-verified log record after the log position `after`, in append order, each with the entry fields above plus `endedAt` and `endedBy` (`expired`, `superseded` or `null` while still effective). `cursor` is the log position of the last committed record read. A position past the end of the log (the log was truncated or rewritten) returns `readable: false`. Slice 4 uses it to show overrides that started and ended between two feed polls.

**Current view and identity.** `entries` contains at most one effective entry per key. Append order, not a caller-supplied timestamp, decides the latest write. Select the latest write before checking expiry or the slice 3 floor: an expired, invalid or unconfirmed latest write never revives an older entry. Re-setting to a safe value supersedes a loosening value; expiry removes the override from the current view and lower code/env layers resume. The historical log keeps every write. Generate a fresh, unique `entryId` matching `^[A-Za-z0-9-]{1,128}$` for every write, including a re-set with the same value; the snapshot cannot rebind an id to a different key, value or expiry.

**Write consistency.** Hold one lock across re-reading current state, appending the complete JSON log record and atomically replacing the snapshot. Readers verify the snapshot against the authoritative log; a crash between append and rename must recover the newest committed log view or return `{ readable: false, entries: [] }`, never a stale snapshot. An unreadable or partial log/snapshot invalidates the whole read, with no partial entries applied.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/operator-override-store.test.mjs and we:scripts/lib/__tests__/operator-override-attestation.test.mjs (both new files), we:scripts/operations/__tests__/http-adapter.test.mjs and we:scripts/__tests__/guard-bash.test.mjs. The store and attestation tests fail before their modules exist and pass after. Named tests, one per guarantee:
  - `forged-override-operator` (in we:scripts/lib/__tests__/operator-override-attestation.test.mjs; the authority test, mirroring `#6246` slice 2 A10's `forged-settings-operator`) — drives the production request, approval-verifier and apply path. A claimed operator grants no authority and writes nothing when it comes from: an interactive terminal or pseudo-terminal, cleared agent environment markers, the local `gh` login, an `--actor` flag, `attemptedBy: 'human'`, the request body, a commit author, a PR comment, or a review by an App or bot account. Missing, unsigned, wrongly-signed, stale (over 15 minutes), replayed (same `requestId` applied twice), wrong-repository, wrong-host, wrong-head, multi-file-diff and non-allowlisted-reviewer approvals refuse the write. A verified allowlisted operator review bound to the exact repository, PR head and request hash applies exactly that one entry, once, over the CLI and over `POST …/runs` alike.
  - `override-approval-self-protection` (in we:scripts/lib/__tests__/operator-override-attestation.test.mjs; reuses `#6246` slice 2 A15's root test shape) — a request PR that also edits the operator allowlist, the approval workflow, the verifier or the pinned public key, separately or together, cannot authorize itself: the workflow runs default-branch code, refuses any diff beyond the one request file, and the PR job receives no signing key or privileged token.
  - `a log record without a valid attestation is never applied, even when written directly to the store`
  - `set then readOperatorOverrides returns the value with source operator-db`
  - `the store path is host-wide and never inside a lane clone`
  - `operator-override-request writes nothing to the store`
  - `the actor is the attested review author and the channel is github-review, never a flag or local login`
  - `each write records instruction, actor, channel, time, reason, optional expiry and its attestation`
  - `readOperatorOverrideHistory returns committed records after a cursor with endedAt and endedBy, and a cursor past the end of the log is unreadable`
  - `readOperatorOverrides returns each entry with entryId, actor, at, instruction, expiresAt and confirmation`
  - `a later write for the same key supersedes the earlier entry on read`
  - `expiry of the latest entry removes the override without reviving an older write`
  - `generated entryIds match [A-Za-z0-9-]{1,128} and remain unique across writes and re-sets`
  - `a hostile instruction round-trips verbatim as a quoted JSON string and is never executed` (newline, CR, U+2028, quotes, backticks and command substitution)
  - `a key outside SETTABLE_OVERRIDE_KEYS is refused and nothing is written`
  - `an agent shell write to the operator-override store is denied` (in we:scripts/__tests__/guard-bash.test.mjs)
  - `an unreadable store returns readable false, which differs from an empty store`
  - `the change log is append-only and a write never edits earlier lines`
  - `two writers serialize under the log lock and re-read state after acquiring it without losing either write`
  - `snapshot replacement is atomic and a crash after log append recovers the latest entry or reports the whole layer unreadable`
  - `a stale lock is recovered without allowing an expired holder to append or replace the snapshot`
  - `an expired override is ignored on read and logged once; the log keeps it`
  - `a snapshot that fails to parse is skipped whole and logged`
  - `a truncated log line makes the whole layer unreadable and returns no partial entries`
  - `the module map covers every operation the repo declares` (the existing http-adapter test, green with the new entry)

## Non-goals

- [N1] Does not wire the layer into the cascade (slice 2), the guard floor (slice 3), the needs-you flag (slice 4) or any plateau DB work.
- [N2] The store module exports `SETTABLE_OVERRIDE_KEYS`: the referral safety keys, the merge-queue switches `refreshOnUnsatisfiedWorkflows` and `refreshOnStaleMergeGate`, and the cascade keys whose reader uses `cascadePolicy(...).value` (never a `.layered` reader that applies env itself). Any other key is refused by the write (named test: `a key outside SETTABLE_OVERRIDE_KEYS is refused and nothing is written`), so an override that no resolver reads is never stored. Slice 2 proves every listed key is read.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the verbatim instruction is stored as a quoted JSON string, never executed or interpolated.
2. **Truncated reads** — a snapshot or log line that fails to parse invalidates the whole layer and is logged, never half-applied, and the read reports `{ readable: false, entries: [] }`.
3. **Shared state files** — the log is append-only under a lock; the snapshot is replaced atomically.
4. **Fail closed** — an unreadable store, a missing or unverifiable attestation, or an unreadable pinned key means no write and no applied override.
5. **Identity scoping** — actor and channel come only from the protected-CI attestation of an allowlisted human GitHub review; no local signal (terminal, `gh` login, environment, flag, `attemptedBy`) is evidence. Test: `forged-override-operator`.
6. **State over time** — latest write per key wins before filtering; supersession and expiry remove earlier values from the derived view without deleting history or reviving an older override.
7. **Who wrote it** — every entry carries actor, channel, time, instruction and reason.
8. **Trust boundary** — authority is checked by protected CI with a signing key that PR jobs and agent sessions never receive, and verified on the host with a public key pinned outside any lane clone; tests `forged-override-operator` and `override-approval-self-protection`. The store sits outside any lane clone, so a lane's Edit/Write grant does not cover it. we:scripts/guard-bash.mjs denies agent shell writes to the store path, tested in we:scripts/__tests__/guard-bash.test.mjs as `an agent shell write to the operator-override store is denied`. A record that still gets past this has no valid attestation and is never applied (`a log record without a valid attestation is never applied, even when written directly to the store`).
