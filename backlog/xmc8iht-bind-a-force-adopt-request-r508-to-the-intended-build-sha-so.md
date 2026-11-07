---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6360"
dateScaffolded: "2026-11-04"
scope: ["we:scripts/lib/daemon-force-adopt.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/operations/prototype-load-io.mjs"]
dateOpened: "2026-11-04"
tags: []
---

# Bind a force-adopt request (R508) to the intended build sha so another failing smoke within the 2h TTL cannot consume it

A force-adopt request (R508) was not bound to a build: any failing rebuild smoke within its 2h TTL consumed it, so the operator's ruling and quote could vouch for a build they never meant. The request now records the target sha at arm time (`requestForceAdopt` refuses `no-sha` / `bad-sha`), and `forceRequestFor` is the one matcher the rebuild uses: a build is force-adopted only when the plan's final sha equals the request's sha. Found by the PR #6360 security review as a hardening gap; the rollback watch limits the harm today.

The binding has four consequences, each covered by a test in `we:scripts/lib/__tests__/daemon-rebuild-force-adopt.test.mjs`:

- A request for another build never applies to a build that fails smoke; that build takes the ordinary failed-smoke ladder (sticky rejection, fallback) and the request stays pending for its own build.
- A request for the held candidate reaches a fresh smoke even through a sticky rejection or the harness-broken backoff, and is consumed there.
- A forced ready record is pinned to its sha: a same-tree or newer build is never adopted off it, because only the exact sha has the rollback watch. A discarded forced record closes its watch and is logged as not adopted.
- A sibling that adopts the forced build first leaves the watch in place; only a real failure to adopt clears the watch and the ready candidate.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- force-adopt` fails before this item lands (a request for build X force-adopts or blocks build Y) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not bind a request to a registered-build ref (only a full sha), does not support more than one pending request per clone, and does not clear a request when its build passes smoke normally (it lapses at the 2h TTL).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the daemon name and smoke check names are stripped of control characters and bounded before they reach the one-line handoff file; a discard reason (it can carry a ref name) is sanitized the same way.
2. **Truncated reads** — `n/a: the request, watch and ready record are small JSON files written by atomic rename; an unreadable one reads as absent and fails closed.`
3. **Shared state files** — one request slot, one watch slot and one ready record per clone; a second force while a watch is open is refused (`watch-already-open`).
4. **Fail closed** — a missing, malformed, other or expired sha never matches (`forceRequestFor`); any audit sink failure refuses the adoption; a forced record never substitutes another sha.
5. **Identity scoping** — the sha is compared lower-cased in the one matcher; a forced ready record is adopted only for its exact sha.
6. **State over time** — the request expires after the TTL; a watch that never saw its build as head expires, and a discarded forced record closes its watch at once.
7. **Who wrote it** — the request needs an operator ruling id and a quote verbatim in that ruling's own section.
