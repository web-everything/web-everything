## R986 I1 probation core (production wiring pending)

`scripts/lib/daemon-rebuild/probation.mjs` is a pure transition core, not a running
probation service. At adoption, `freezeProbation` takes the complete registered roster
for one clone and `readClosure(daemon, sha)` snapshots at proven-good and adopted heads.
A snapshot is `{ complete: true, files: { repoRelativePath: gitBlobId } }`; include
all imported files. Unknown, incomplete, empty or unreadable snapshots owe proof.
The core copies and validates each closure's files before the next `readClosure` call;
readers may reuse their result object or files map without changing earlier evidence.
An unknown or ambiguous roster refuses adoption: the operator must recover the roster.
`owed` stays fixed for this adoption. `recordProof` stores independent daemon records;
boot and completed tick evidence must name that daemon, agree on its PID and adopted
head, and show process start at/after adoption with a later completed tick. Callers
must obtain boot evidence from that daemon's process record, not from a sibling or
from the wrapper's first tick time. `evaluateProbation` passes only with all owed
records, or immediately for a known empty owed set. Non-owed evidence is a no-op.
Each entry uses the same sanitizing boundary to recursively capture enumerable data
properties and reject accessor descriptors without invoking getters or setters, including
when `records` precedes `owed` in key order. Validation and decisions use only the frozen
plain copy. State and evidence restored from JSON contain no accessors.
The boundary catches read/copy errors, rejects cycles and functions (except the separately
captured injected closure reader), memoizes aliases, and does not execute `toJSON`.
Copying is limited to 100,000 properties/array slots per entry.
Oversized input follows the same closed path; recover a bounded roster or state
before retrying, and treat an identity return from adoption as a refused adoption.
It preserves invalid values such as `undefined` and `NaN` for the validator rather than
silently dropping unknown fields or coercing values through JSON serialization.
Unreadable adoption options return the original options; readable but invalid rosters
still throw the operator recovery error. Unreadable proof/state input is a no-op for
`recordProof`; validation reports invalid state and evaluation stays pending.
A recorded proof returns a fresh frozen copy, so
mutating restored (for example JSON-parsed) state, a getter or a hidden key cannot
discharge another daemon. A no-op still returns the caller's own input object.
Legacy single-record state cannot promote; it requires operator recovery.

The probation tests adapt the WIP adoption clock/heads and invalid-tick cases. The
self-sync test uses the WIP injected rebuild/lock/closure fixture as a core consumer;
it does not establish production probation integration. Remaining wiring: enumerate
clone registrations, read both import closures by SHA, persist adoption and daemon
boot/tick records under a shared mutation lock, and advance proven-good only on pass.
No rollback, boot counting or probation deadline policy ships in this I1 core.

`scripts/conveyor/soak/breaks/probation-accessor-snapshot.mjs` replays the operator's
shared-files-map, records-getter-popping-owed, interacting-getters and throwing-boot probes against the real
core. Its soak wrapper is automatically registered by the breaks directory discovery.
The shared-map case pins an earlier repair; the records getter and top-level boot getter
reproduce the failure at `41aaa588c39397fc7ad7eca7f63e9bf5fa041483`. All accessor cases now
also require zero getter calls, including nested evidence.
At `a19d094c84a838c161105da3296c3558467fc319`, interacting `records` and `owed` getters
remove `review` and return `pass`. Rejecting accessors returns the original state untouched,
keeps both daemons owed, calls no getters, and returns `pending`.
These pure-core probes do not establish live daemon integration or merge compatibility.
