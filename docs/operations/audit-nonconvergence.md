# Audit nonconvergence

## Diagnostic v1

This explicitly invoked, read-only diagnostic recommends human design review when
class novelty persists across two consecutive unique-head WEAKENED rounds in one
complete repository/PR/question episode. It is not an admission gate. Exit 0 gives
no permission to merge or continue repairs; existing production behavior continues.
Class novelty is deliberately coarse: NO_RECOMMENDATION is no convergence proof.

Invoke from the repository root:

```sh
node scripts/operations/audit-nonconvergence.mjs --manifest scripts/operations/__tests__/fixtures/audit-nonconvergence/two-new-classes.json
```

Only `--manifest <path>` is accepted, exactly once. There is no ledger discovery,
legacy conversion, network access, subprocess, retry, agent input, or persistent
write. The only adapters read the manifest and write stdout/stderr.

### Manifest and provenance

All objects have closed schemas: every listed field is required and additional
fields are rejected. The root fields are:

- `schemaVersion: 1`, `kind: "audit-nonconvergence-input"`, `synthetic` boolean.
- `repo`: canonical lowercase owner/name; `pr`: positive safe integer.
- `ref`: exact fully qualified branch ref beginning `refs/heads/`.
- `questionHash`: lowercase 64-hex; `completeFromStart: true`.
- `provenance`: `{source, sourceSha256, selection, verifiedBy}`.
- `rounds`: nonempty ordered array, at most 100 rounds.

`source` and `verifiedBy` are nonempty strings; `sourceSha256` is lowercase
64-hex. `selection` contains exactly one `{sequence, recordIndex, recordSha256}`
per round, in sequence order. Record indices are distinct positive safe integers;
record hashes are lowercase 64-hex. For real evidence, source identifies an
immutable export, selection pins exact records, and verifiedBy identifies the
human who checked completeness and classification. The operator obtains PR
identity independently: baseRef is not lineage evidence. Same-head retries must
be reconciled by the author into one successful record; record all selection
decisions in source/verifiedBy text. Duplicate heads are rejected.

Synthetic fixtures hash compact JSON source records (JSON.stringify in property
order), and hash the compact ordered record array for sourceSha256. Fixture names
and prose identify these as synthetic, never historical replay evidence.

The diagnostic checks structure and selection coverage. It does not fetch or
authenticate the export, recompute real export hashes, verify classification, or
prove completeness. Output labels the evidence `operator-attested; not authenticated`.
If a complete, classified manifest cannot be attested, request human review of
the full audit history rather than selecting a flattering subset.

Each round is exactly `{sequence, repo, pr, ref, questionHash, head, base, verdict,
findings}`. Sequences are contiguous integers starting at 1 in array order; no
sorting by time occurs. Identity fields must match the root. Heads are unique
lowercase 40-hex; bases are lowercase 40-hex. Verdict is exactly WEAKENED (one or
more findings) or NOT WEAKENED (no findings).

Each finding is exactly `{id, text, file, line, class}`. IDs are nonempty and
row-local unique, original text is nonempty, line is a positive safe integer,
and file is normalized repo-relative spelling validated by shared `findingKey`
with controls rejected. Class is explicitly operator supplied from the shared
closed FINDING_CLASSES vocabulary (B1–B7, E1–E2, D1–D3, X1–X2). No classification
is inferred from prose. All findings survive output, including B1 and multiple
IDs with the same class/file. Keys, symbols, renames and fingerprints do not
establish novelty.

### Reduction and output

Validate the entire manifest before reducing, including any tail after a trigger.
Start seenClasses empty and streak 0. For each round compute current classes minus
all previously seen classes, sort that `newClasses` array, and union current
classes into history. WEAKENED with nonempty newClasses increments streak; every
other round resets it. The first WEAKENED round counts as 1. A clean round resets
the streak without erasing class history. The earliest sequence reaching 2 is
sticky `recommendationAt`, even if later rounds reset the streak. No third head
is necessary. Rebased heads with unchanged classes reset the streak. A new PR or
question requires a separate complete episode; mixed lineage is rejected.

Success emits one JSON object with exactly `schemaVersion: 1`,
`kind: "audit-nonconvergence-diagnostic"`, `enforcement: false`, `synthetic`,
repo/pr/ref/questionHash, `evidenceBasis`, `status`, `recommendationAt` (sequence
or null), final `streak`, `rounds`, and original `provenance`. Each output round
retains every input field and adds `newClasses` and `streak`.
RECOMMEND_DESIGN exits 10; NO_RECOMMENDATION exits 0. Neither is a canonical audit
verdict or a trusted workflow marker. Findings, verdicts and waivers are not
rewritten. Evidence remains JSON data, with terminal controls escaped, never
shell commands or agent instructions.

Failure emits only `{schemaVersion: 1, kind: "audit-nonconvergence-diagnostic",
enforcement: false, status: "INCOMPLETE", reason, action: "Human review of full
audit history required"}` and exits 2, without fabricated identity or partial
recommendation. Stable reason codes are INVALID_ARGUMENTS, READ_FAILED,
INVALID_JSON, INVALID_MANIFEST, and LIMIT_EXCEEDED. A failed stdout write exits 2
and attempts a sanitized OUTPUT_WRITE_FAILED stderr explanation; it never
reports successful delivery after EPIPE. Stderr failure cannot restore success.

Reads consume at most 1 MiB plus one overflow byte before parsing. Input exceeding
1 MiB, 100 rounds, 100 findings per round, or 4 KiB UTF-8 per string is INCOMPLETE
with the same full-history human-review fallback. Limits are fixed v1 constants,
not settings. Oversize data is never truncated into apparently complete evidence.
Unreadable/malformed input, legacy JSONL, unknown fields/versions, missing
classification, conflicting verdicts, gaps and duplicate heads fail closed.

## Deferred production escalation

V1 has no automatic dispatch stop, durable hold, card payload, owner assignment,
resume token, persistence or production consumer. These are one deferred feature,
not additive markers. A future integrated design must specify actual dispatcher
and admission consumers, hold precedence over waivers/head changes/fingerprint
carry, authorized resume, and no endless redispatch. It must jointly prove those
properties through real adapters.

Concurrent card creation requires durable episode identity, atomic claims,
reconciliation, deduplication and crash recovery across each partial write. An
append-only audit export is not an escalation transaction. Historical/production
replay requires pinned records, hashes and real command/hold/card/owner evidence;
synthetic local CLI tests prove none of those external effects. Automatic lineage
capture and structured classification require writer changes, legacy isolation
and completeness proof before enabling an automatic counter.
