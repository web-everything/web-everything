---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-rebuild/quick-machine.mjs", "we:scripts/lib/daemon-rebuild/quick-record.mjs", "we:scripts/lib/daemon-rebuild/__tests__/"]
dateOpened: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "06649b999eb6a4ddceadd53808ed09b5d9ee6cf6"
tags: []
---

# Quick-soak state machine: pure transition table + CAS record (no runtime effect)

Pure step(record,event,ctx) transition table plus a CAS-guarded per-clone quick-soak record for the daemon-rebuild quick soak; nothing wired, no runtime effect. Redo of the design after PR 6084 was rejected.

## Acceptance

- [A1] **Executable** — running the two new test files `we:scripts/lib/daemon-rebuild/__tests__/quick-machine.test.mjs` and `we:scripts/lib/daemon-rebuild/__tests__/quick-record.test.mjs` with `node --test` fails before this lands (modules absent) and passes after.
- [A2] **Executable** — the generated refusal matrix test covers every (state x event) pair not in the legal table and asserts a byte-identical refusal plus a logged line.
- [A3] **Executable** — scripted mutation: dropping each guard in `we:scripts/lib/daemon-rebuild/quick-machine.mjs` makes at least one test row fail.

## Non-goals

- [N1] No wiring into the daemon, no setting, no runtime effect (that is the follow-on card "Wire quick-soak state machine into daemon-rebuild").
- [N2] No migration: PR 6084 never landed, so no old record format exists.

## Design

Source: the Plan agent's design for PR 6084 (2026-10-31 12:06 ET), redone as a pure core first.

One record per clone, in the state dir, named by the cloneKey plus a quick-soak JSON suffix, with fields `{v, rev, id (= lease.token), state, base{head,tree}, lastGood, adoptedSha, target{sha,tree,inputsKey,kind,...}, passedAt, adoptedAt, deadline, attempt{n,token,jobId,pid,host,procStart}, result, cause, projectedRev, history[20]}`.

- `we:scripts/lib/daemon-rebuild/quick-record.mjs`: read, validate and compare-and-set (CAS) write under `withFileLock` from `we:scripts/lib/atomic-json-file.mjs`. A write names the `rev` it read; a mismatch is a CAS-lost result, never an overwrite. An unreadable or invalid file returns `quick-record-unreadable` (fail closed), never "no record".
- `we:scripts/lib/daemon-rebuild/quick-machine.mjs`: pure `step(record, event, ctx)` returning `{next, effects[]}` or `{refused, why}`. No I/O, no clock reads (time arrives in `ctx`).
- Identity is `(id, target.tree)`. SHAs are recorded for humans and never compared.
- States: `smoked, adopting, soak-due, soaking, settle-pending, rolling-back`; terminal: `verified, rejected, quarantined, abandoned`.
- Git rule, expressed as effects with guards: reset to target only from `adopting` when HEAD tree equals `base.tree`; reset to base only from `rolling-back` when HEAD tree equals `target.tree`; any other HEAD becomes `quarantined{foreign-head}`.
- Every (state x event) pair not in the legal table returns the same refusal shape, byte-identical, plus a log entry.
- Crash recovery: an exported `recover(record, observed)` giving the event to apply per state at tick start (observed = HEAD tree, attempt liveness).
- Page effects are keyed `(id, rev)` so a repeat tick pages once.

## MVP

Musts: the two modules; the full legal-row table; the refusal matrix; the CAS record; recovery per state; `history` capped at 20; tests below. Out: any call site, setting, or daemon change.

## Test plan

- Legal rows table, including fallback under the original lease and same-tree adoption (fails RED: module missing).
- Generated refusal matrix: every pair not in the table refuses byte-identically and logs.
- Stale variants: stale `id`, stale `attempt.token`, stale `rev` each refused.
- Same-tree-different-SHA variants: treated as same identity, no refusal and no quarantine.
- Earlier breaks as rows: launcher after replaced adoption; recovery versus a foreign HEAD; stale finalizer; result from a retired token; the two 5b8f9977 breaks.
- Crash rows between write-intermediate, git-effect and write-next, each recovering to a legal state.
- Real-Git integration for the four git effects (reset to target, reset to base, and the two guard-refusals) in a temp repo.
- CAS: two concurrent writers, one wins, the other gets CAS-lost.
- Quick-off controls: no existing module imports these files, so existing outputs are byte-identical.

## Proof plan

Run the red-team's two 5b8f9977 probes as table rows (they must fail by refusal here; the live before/after happens on the wire-in card). Run the scripted mutation (drop each guard, at least one row fails). Port the cases from the existing quick-soak break fixtures under `we:soak/breaks/`. Codex audit of the diff. PR body is generated from the diff.

## Edge cases this change must handle

1. **Untrusted text** — `cause` and history strings are folded (`foldUntrusted`, `we:scripts/lib/jury-core.mjs`) before write; no record text reaches argv.
2. **Truncated reads** — a short or partial JSON read is `quick-record-unreadable`, not an empty record; git reads use full buffers (`maxBuffer`).
3. **Shared state files** — `withFileLock` plus CAS on `rev`; sibling daemons use one fixed lock order.
4. **Fail closed** — unreadable record, unknown state, unknown event, version mismatch all refuse with a named reason.
5. **Identity scoping** — keyed by cloneKey; identity `(id, target.tree)`; SHAs never compared.
6. **State over time** — `deadline` and `passedAt` come from `ctx` time; crash recovery per state; history capped at 20; repeat pages keyed `(id, rev)`.
7. **Who wrote it** — `attempt{pid,host,procStart}` checked for liveness before an attempt is considered dead; a result carrying a retired token is refused.

## Follow-ups

- Wire the machine into daemon-rebuild (card xis8290, blockedBy this).
- Lint that every setting named in a PR body exists in the diff and has a test.
