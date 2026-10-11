---
kind: story
size: 2
parent: "4135"
status: active
scaffoldedBy: "fix-4764"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/lib/daemon-jobs-runtime.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Job handle probes compare ps start times as local-time strings: a TZ difference reads a live process as dead

Found by PR 4764's round-8 self-review (outside its scope). readProcStart in we:scripts/lib/daemon-jobs-runtime.mjs runs ps -o lstart with LC_ALL=C but no TZ, and probeHandle compares that local-time string to the one recorded in the handle. A TZ change, or a release-lane or daemon run from a shell with another TZ, makes a LIVE supervisor or gate read dead; gateState's start-time-mismatch branch then proves a running gate gone and claimHolderGone releases its lane claim. Same class as the operator's PR 4764 ruling (only positive proof says gone).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs`: a new case records
  a handle under `TZ=America/New_York` and probes it under `TZ=UTC` — `alive` after the fix, `dead` before it.
- [A2] Handles already recorded in local time (jobs running at deploy) still probe `alive`: a dual comparison or a
  migration, never "every running job reads dead on deploy".
- [A3] A start time that cannot be parsed or compared answers "cannot tell" (a throw the callers already treat as
  unknown), never `dead`.

## Non-goals

- [N1] Changing how a handle from another host is judged (`foreign` stays `foreign`).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: `ps` output is parsed into a date, never executed or interpolated.
2. **Truncated reads** — an empty or unparseable `ps` answer for a pid that exists is "cannot tell", never `dead`.
3. **Shared state files** — n/a: the probe writes nothing.
4. **Fail closed** — any comparison that cannot be made answers unknown (held), never `dead` (released).
5. **Identity scoping** — the comparison stays per host + pid + start instant, as today.
6. **State over time** — a DST switch or a `TZ` change between recording and probing does not change the answer.
7. **Who wrote it** — n/a: the handle is written by the supervisor process itself.
