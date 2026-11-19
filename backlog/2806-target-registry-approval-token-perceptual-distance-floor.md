---
bornAs: x8fptpl
kind: story
size: 8
parent: "2804"
status: resolved
dateOpened: "2026-08-01"
blockedBy: []
dateStarted: "2026-09-07"
dateResolved: "2026-09-07"
graduatedTo: none
scope:
  - we:scripts/lib/target-registry.mjs
  - we:scripts/__tests__/target-registry.test.mjs
  - we:scripts/design-refs.mjs
  - we:scripts/design-refs/__tests__/perceptual.test.mjs
tags: [plateau-loop, conveyor, ui-fidelity, we, slice-uifg]
---

# Target registry + approval token + perceptual-distance floor

An independent ratified-mock target registry; an approval token signed over the mock content hash; a perceptual-distance floor that rejects any target too close to a build screenshot and escalates a target authored in the same lane/commit as the render code. Enforces the target-is-not-the-subject invariant.

## Security requirements (owned here — the design-source statute #2801 defers the mechanics to this slice)

The #2801 statute (`we:docs/agent/platform-decisions.md#design-source-locked-in-code-target`) rules the
*direction* of the target registry (in-code artifact = sole content-hashed canon; normalize+archive sources;
minter-agnostic WE contract; interactions cut on assertability). It deliberately does **not** codify the
trust-model mechanics — those are design constraints on this slice, because it (not the statute) closes RRFC
INVARIANT A's circular oracle. Any registry/token design landed under this slice **must** satisfy these seven,
listed as first-class security requirements:

1. **Authorization predicate on mint (not self-issuable).** "Any client mints" needs an authorization check, or a
   build lane can rewrite the target to match what it built, hash it, mint `@vN`, and issue its own token in the
   same commit — re-opening the circular oracle INVARIANT A added the token to close.
2. **Integrity digest, not authenticity — align with #2809.** The token is an *integrity digest* (anti-replay),
   not a signature: an unkeyed `sha256` over public inputs proves neither authenticity nor authorship. Use
   #2809's corrected wording (`integrityDigest`, "NOT authenticity"); do not ship an unkeyed hash described as a
   "signature".
3. **Context binding.** The token must bind `registryId` + `@vN` + `authoredInCommit`, not the bare
   `contentHash` — otherwise two byte-identical artifacts cross-validate and approval for surface A authorizes
   surface B. (Commit dates are attacker-settable, so pre-dating needs cryptographic support, not a timestamp.)
4. **Ledger tamper-evidence.** The append-only ledger needs prev-entry chaining / a signed head / an external
   anchor. Without it an in-place rewrite of `@v3` is undetectable — the drift INVARIANT A forbids.
5. **"Frozen" forbids live/expiring subresources.** The canonical in-code target must not fetch live or expiring
   subresources (a remote script/stylesheet, or an imported Figma CDN image URL that expires in ~30 days while
   `contentHash` still validates against a now-blank render). Freeze must inline/pin every subresource.
6. **Canonicalization rule for `sha256`.** Define the exact canonical-bytes rule the hash is taken over
   (single-file vs file-set, newline normalization) — otherwise a sibling file changes the target with the hash
   unchanged, or a CRLF checkout false-blocks every story.
7. **Raw-payload redaction/PII + `sourceHash` binding.** The archived raw import payload is re-parsed by the
   normalizer (untrusted parser input) and Figma node JSON routinely carries signed image URLs and user
   name/email. Require redaction/PII handling and bind the payload with a `sourceHash` so provenance is not
   self-declared and unverifiable.

## Prepared 2026-08-15 — grounded against the live tree

**`blockedBy` cleared.** [#2805](/backlog/2805-ui-fidelity-contract-schema-validator/) (the `fidelity:` schema +
validator) is `status: resolved`, shipped as `we:scripts/lib/fidelity-contract.mjs` — its `target` block
(`registryId`/`contentHash`/`authoredInCommit`) is the consumer of the mechanism this story builds, not a
prerequisite that still blocks. Verified against the live tree, not the card's stale claim.

**What already exists (so this slice is not greenfield crypto).** Grepped `we:scripts/`, `we:docs/agent/` for
`registryId|contentHash|canonicalArtifact|integrityDigest|perceptual|prevHash|chainHash|sourceHash` — the only
real hits are: the shape-only validator in `we:scripts/lib/fidelity-contract.mjs` (validates the `target` block
is *present*, never mints or verifies it); the `#2801` statute prose (`we:docs/agent/platform-decisions.md:2578-2622`)
that names these seven requirements but explicitly defers the mechanics here; and `plateau:scripts/dev/fidelity-render.mjs:227-245`,
whose `integrityDigest({commit, route, baselineHash, contractHash, results, verdict})` already ships the
naming convention (`integrityDigest`, not `signature`) and a sorted-key-JSON canonicalization (`canonicalReplacer`,
`:240-245`) this slice should mirror, not reinvent. No ledger, mint, token, or perceptual-floor code exists
anywhere in either repo today (verified: `grep -rn -E "prevHash|previousHash|chainHash|merkle" scripts/` → no
matches, run inside `we:`). This is the first real implementation of RRFC INVARIANT A's registry.

### Scope + consumers

**Files (WE-only — no product-repo change; `plateau` builds its own conforming client later, the same way
it already built its own `integrityDigest` off WE's #2809 wording rather than importing WE code — the two
repos are not npm-linked. Corrected claim: `grep -rn "webeverything" plateau:package.json plateau:scripts`
does NOT return zero hits — `plateau:scripts/gen-branding.mjs:14,25` and `plateau:scripts/gen-skills-catalog.mjs:9,22`
both reference `webeverything` as a **sibling checkout path/label** for asset/catalog generation, not an
npm dependency; `plateau:package.json` itself carries no `webeverything`/`web-everything` entry. The
no-npm-link conclusion holds, the earlier "no hits" grep result cited for it was wrong and is corrected here
rather than left standing):**
- `we:scripts/lib/target-registry.mjs` — **new.** The registry contract: canonicalization, content-hash,
  integrity/chain digest, the append-only ledger (pure fold + IO shell), the mint-authorization predicate, the
  frozen-artifact scan, and the perceptual-floor comparator.
- `we:scripts/__tests__/target-registry.test.mjs` — **new.** Full coverage per Done-when below.
- `we:scripts/design-refs.mjs` — **extend, additive only.** Export `imageFileToWebp` (currently module-private,
  `:110-118`) and add an exported `fileDHash(imagePath)` that generalizes the existing private `shotDHash`
  (`:829-841`, currently `dwebp`-only / webp-input-only) to accept any raster path Playwright emits (PNG),
  routing through `imageFileToWebp` first when the input isn't already `.webp`. No existing export's signature
  changes.
- `we:scripts/design-refs/__tests__/perceptual.test.mjs` — **extend.** Cover the new `fileDHash` export.

**Consumers checked both ways (checklist item 1):**
- *Importers* of `we:scripts/design-refs.mjs`: `we:scripts/design-refs/__tests__/perceptual.test.mjs`,
  `we:scripts/design-refs/__tests__/export-corpus.test.mjs`, `we:scripts/design-refs/__tests__/harvest.test.mjs`,
  `we:scripts/design-refs/__tests__/archive-quarantine.test.mjs` (import pure exports only — unaffected by an
  additive export).
- *Subprocess callers*: `we:package.json` line 74 defines the `design-refs` npm script running
  `we:scripts/design-refs.mjs` (the `collect` / `dedup` / `harvest` / `report` CLI). Unaffected — no existing
  subcommand's behavior changes.
- No caller of `we:scripts/lib/target-registry.mjs` exists yet (new file) — this slice is foundation, consumed
  later by `#2812` (WE floor: record consumption + warn→error) and `#2803` (resolve-time reconciliation),
  matching the epic's own build-wave order (`#2804`: `{scaffold/readiness, harness, **registry**}` precedes
  `{…, WE-floor, scope-reconcile}`). Shipping it unwired is the same shape `#2805` shipped in (a pure,
  independently-tested library) before `#2812`/`#2803` call it.

**De-risking probe run (checklist item 8).** The riskiest assumption was reusing `we:scripts/design-refs.mjs`'s
perceptual primitives (`hammingHex`/`dHash`) despite the file's top-level `import { chromium } from 'playwright'`
— importing anything from it could be slow or fail where `playwright`/`cwebp`/`dwebp` aren't installed.
Measured, not assumed: `npx vitest run` against `we:scripts/design-refs/__tests__/perceptual.test.mjs` →
**10/10 pass in 511ms**, and `which cwebp dwebp` both resolve locally (`/opt/homebrew/bin/cwebp`,
`/opt/homebrew/bin/dwebp`) — this repo already pays that cost today (that suite already imports the same
file), so reusing it is free, not a new dependency.

### Size — 8, basis stated

Kept at the card's declared 8 (not raised, not split). Basis: this is genuinely **one cohesive deliverable** —
a single new pure-core/IO-shell library file plus an additive extension of one existing file, no cross-repo
dependency, no network I/O, no browser automation (unlike its size-8 sibling `#2809`, which needed a real
Chromium render harness and still shipped as one PR). What makes it an 8 rather than a 5 (like `#2805`'s
single-purpose shape validator) is that it carries **seven independent security mechanics**, each needing its
own pure function, its own red/green test pair, and its own docstring justification — comparable in shape to
`we:scripts/lib/verdict-ledger.mjs` (append-only ledger + locked IO shell + CLI, ~820 lines) plus a chain-hash
addition verdict-ledger doesn't have.

**Not `> 8`, but the seam is named rather than denied (checklist guidance: "name the slices and the seam
rather than forcing a number").** An earlier draft of this section claimed "nothing here has an independent
seam" — **independent review found that false** and it is corrected here: `verifyPerceptualFloor` plus the two
`we:scripts/design-refs.mjs` exports (`imageFileToWebp`, `fileDHash`) have **no interface dependency** on the
ledger/mint/digest core — `verifyPerceptualFloor` takes two precomputed pHash strings and a threshold, nothing
from `buildRegistryEntry`/`computeIntegrityDigest`/`verifyChain` flows into or out of it. That IS a real,
independently-shippable seam. This story bundles it anyway, for a stated reason rather than an unexamined
default: both pieces are small (one wrapper function + two additive exports), they ship in the same file
family as the rest of this task list, and a real consumer (`#2812`) needs the mint/digest/ledger core AND the
perceptual floor together to gate a build — splitting would buy a second review round without reducing risk on
either half. A builder or reviewer who disagrees can ship `we:scripts/design-refs.mjs`'s two exports +
`verifyPerceptualFloor` as its own smaller PR first with zero redesign; nothing above depends on that choice.

### The decided design — seven requirements, seven grounded answers

Each answer below is a real design call this story is making, not a menu; the reasoning and the excluded
alternative are stated so a reviewer can override a specific one without re-deriving all seven.

**1. Authorization predicate on mint — structural provenance, not identity.** WE has no user-identity or
credential system to check against — `we:scripts/lib/verdict-ledger.mjs:196-214` states this plainly for the
adjacent review-verdict ledger ("Nothing in this repo distinguishes the operator from an agent... everything
runs under one token and one session id"), and `we:scripts/lib/review-independence.mjs:193` (`decideClearerIndependence`)
already solves an analogous problem the same way: not by authenticating who acted, but by comparing two
**declared identifiers** (author session vs. clearer session) for equality. This story mirrors that pattern
with commit/lane identifiers instead of session ids: `mintAuthorizationVerdict({ authoredInCommit, buildCommit,
authoredInLane, buildLane })` is a PURE structural check — if the target's `authoredInCommit` (or its
authoring lane) equals the build's commit/lane, mint is **not self-issuable clean**: `authorized: false,
escalate: true`. This is exactly the design the card's own one-line summary already commits to ("escalates a
target authored in the same lane/commit as the render code") — it is not a new call, it is naming that
sentence as the mechanism. **Honesty, stated once, like `ACTOR_PROVES`:** this predicate proves *provenance*
(the target did not originate from the same commit/lane as the render it's being checked against), never
*authorization by a credentialed party* — no such party exists in this repo today. A cryptographic ACL is
excluded because it would need a keying/identity infrastructure this repo doesn't have and would be dishonest
to imply.

**2. Integrity digest, not authenticity — reuse #2809's wording verbatim.** `integrityDigest` (field name),
unkeyed `sha256`, docstring stating "NOT authenticity" — already the shipped convention at
`plateau:scripts/dev/fidelity-render.mjs:227-238`. This story's `computeIntegrityDigest` uses the identical
field name and the identical honesty framing so a future reader sees ONE convention across both repos, not two.

**3. Context binding — sorted-key canonical JSON over the four bound fields.** `computeIntegrityDigest({
registryId, version, contentHash, authoredInCommit, prevDigest })` hashes a sorted-key JSON body (the exact
`canonicalReplacer` recipe already shipped at `plateau:scripts/dev/fidelity-render.mjs:240-245` — sort
object keys recursively, leave arrays as-is) over all five fields, so two byte-identical artifacts under
different `registryId`/`@vN`/`authoredInCommit` never collide (the requirement's literal example — "surface A
authorizes surface B" — is exactly what binding `registryId` into the hash forecloses).

**4. Ledger tamper-evidence — prev-entry chaining, folded into the SAME digest as #3, not a second field,
chained GLOBALLY across the whole ledger file, not per-`registryId`.** Requirement 3's context-binding digest
already needs a canonical-JSON-over-fields function; adding `prevDigest` (the previous ledger entry's own
`integrityDigest`, or a fixed genesis constant for the very first entry) to that same input set makes each
entry's digest depend on its own fields **and** the full history before it — the standard hash-chain
construction, at zero extra mechanism cost. **Chain scope, made explicit** (independent review flagged the
first draft left this ambiguous): the ledger is **ONE file holding every `registryId`'s entries in a single
append-order stream** — mirroring `we:scripts/lib/verdict-ledger.mjs`'s one-file-per-repo model (not one file
per PR) — and `prevDigest` links to the immediately-preceding entry **in that file's append order, regardless
of which `registryId` it belongs to**. This is the stronger of the two readings: it catches a dropped,
reordered, or inserted entry for **any** target, not only tampering within one target's own version history.
The cost is that `foldTargetRegistry`'s per-`registryId` projection and `verifyChain`'s whole-file walk are two
different, separately-tested functions over the same stream — `foldTargetRegistry` groups for "what's the
latest `@vN`", `verifyChain` never groups and only walks append order. `verifyChain(entries)` walks the ledger
recomputing each digest from its stored fields + the prior entry's stored digest; a mismatch at index *i* means
entry *i* (or anything before it) was altered after the fact without re-minting, and is reported at that exact
index. Chosen
over the two named alternatives: a **signed head** needs a private-key WE has no infrastructure to hold or
rotate (and would misrepresent authenticity, contradicting #2); an **external anchor** (timestamp service)
needs network access, breaking the offline/deterministic posture every other WE gate holds to. Grep confirms
this repo has never built prev-entry chaining before (`grep -rn -E "prevHash|previousHash|chainHash|merkle"
scripts/`, run inside `we:`, → no matches) — this is new, not a reuse, and is called out as such rather than
presented as established practice.

**5. "Frozen" forbids live/expiring subresources — a deterministic, attribute-scoped regex scan, same shape as
the existing fixture-route check.** `frozenArtifactScan(bytes)` rejects an `http://`/`https://` reference found
in a **live-fetch attribute context** — `<script src="…">`, `<link rel="stylesheet" href="…">`, `<img src="…">`,
CSS `url(…)` — unless it is inside a documented provenance/comment block. **Scoped by attribute context, not a
bare scheme match** (a correction made during independent review): a bare-scheme scan would false-positive on
an ordinary SVG's namespace declaration (`xmlns="http://www.w3.org/2000/svg"`) or an XHTML doctype, both static
identifiers a browser never fetches, and SVG/XHTML mock content is exactly what this registry canonicalizes.
`xmlns`/`xmlns:*` attributes and `<!DOCTYPE …>` declarations are explicit exemptions, tested as their own
Done-when case (a well-formed SVG target with an `xmlns` URI must NOT be flagged). This is the same
deterministic-regex-over-content shape `FIXTURE_ROUTE_RE` already uses in
`we:scripts/lib/fidelity-contract.mjs:51` (line corrected — an earlier draft misquoted `:44`, which is a
comment above the unrelated `SERVED_ROUTE_RE`) to reject a `?demo=` fixture route — reusing an established
pattern rather than inventing image/network inspection this module has no business doing.

**6. Canonicalization rule for `sha256` — CRLF-normalize TEXT, pass BINARY through unmodified; a directory
hashes its sorted manifest.** `canonicalizeBytes(buf)`: attempt a UTF-8 decode; if it round-trips cleanly (no
replacement-character corruption — the buffer IS valid UTF-8 text), normalize `\r\n` → `\n` and re-encode; if
it does NOT decode cleanly (a binary artifact — an embedded font, a raster image, a `manifest` entry that
isn't source text), hash the **raw bytes unmodified**, since CRLF-normalization is meaningless for binary data
and a naive decode-then-reencode risks silently corrupting it (a gap the first draft of this design left
unaddressed — flagged in independent review, fixed here rather than left implicit). `sha256` the result either
way. When `canonicalArtifact` names a directory rather than a single file (a target with sibling DTCG token
files or embedded binary assets), `computeContentHash` hashes a sorted-by-relative-path manifest of
`{path, sha256(canonicalizeBytes(file))}` pairs rather than walking the directory in filesystem order —
directory iteration order is not guaranteed portable, and hashing it directly would make the identity
host-dependent. A binary-artifact canonicalization case (hash stable, bytes untouched) is its own Done-when
test, not folded into the text CRLF case.

**7. Raw-payload redaction/PII + `sourceHash` binding — WE validates the CLAIM shape, never reads the payload.**
`sourceHash` appears nowhere else in the repo today (`grep -rn "sourceHash" scripts/ docs/agent/`, run inside
`we:`, → the single hit is the statute prose naming this requirement) — there is no existing consumer to break.
The registry entry's optional `source` block requires `sourceHash` (a `sha256:`-prefixed hex string binding the
archived raw payload) and a boolean `redacted: true` claim. WE's validator checks the **shape** only — it never
opens or parses the raw payload itself (Figma node JSON, potentially carrying PII, is normalized and archived
product-side, and WE holds zero implementation, MEMORY #6). This is the identical honesty pattern
`we:scripts/lib/verdict-ledger.mjs:196-229` already documents for its own `actor` block ("IT CAN PROVE... IT
CANNOT PROVE"), applied to `source` instead of `actor`: WE can prove a `sourceHash` and a `redacted` claim are
*present and well-formed*; it cannot prove redaction actually happened. Stated in the module docstring, not
left implicit.

**8. Perceptual-distance floor — reuse `hammingHex`, don't reinvent an image metric.** `verifyPerceptualFloor({
targetPHash, buildPHash, threshold = 5 })` is a thin wrapper over `hammingHex` (`we:scripts/design-refs.mjs:800`),
importing it directly rather than re-deriving a distance metric — `tooClose: hammingHex(targetPHash, buildPHash)
<= threshold`. The default threshold (5 of 64 bits) matches `we:scripts/design-refs.mjs`'s own existing near-dup
default (`:851`) rather than inventing a new number with no empirical basis — **but it is reused as a starting
point, not re-validated for this use** (flagged in independent review): the dedup default was tuned to catch
accidental duplicate *screenshots*, a different cost tradeoff than a *security* floor rejecting a
suspiciously-close-to-the-build target. Ship it as the documented default with `threshold` a caller-overridable
parameter (already in the signature), and treat the number itself as an open tuning question for whoever wires
this into a live gate (`#2812`), not a validated security constant this story is asserting. `targetPHash`/`buildPHash`
are precomputed hex strings (via the new `fileDHash` export) — the comparator itself takes no image bytes,
keeping the security-bearing pure core free of the `cwebp`/`dwebp` shell-out.

### Interfaces (`we:scripts/lib/target-registry.mjs`, all pure unless marked IO)

```js
// constants
export const TARGET_REGISTRY_VERSION = 1;
export const TARGET_REGISTRY_KIND = 'we.target-registry-entry';

// canonicalization + hashing — pure
export function canonicalizeBytes(buf) // Buffer -> Buffer
export function computeContentHash(input) // { bytes } | { manifest: [{ path, bytes }] } -> "sha256:<hex>"

// context-bound, chain-linked digest — pure
export function computeIntegrityDigest({
  registryId, version, contentHash, authoredInCommit, prevDigest, // prevDigest is null only for @v1
}) // -> "sha256:<hex>"

// mint-time checks — pure
export function mintAuthorizationVerdict({
  authoredInCommit, buildCommit, authoredInLane, buildLane,
}) // -> { authorized, escalate, reason }

export function frozenArtifactScan(bytes) // -> { frozen, violations: [] }

// registry entry — pure builder/validator/serializer, mirrors buildVerdictRecord/validateVerdictRecord
export function buildRegistryEntry({
  registryId, version, contentHash, authoredInCommit, prevDigest,
  source, // optional: { kind, sourceHash, redacted: true, ...provenance }
  mintedBy, mintedAt, // ISO-8601, injected — never read from a clock
}) // -> RegistryEntry, throws TypeError on a bad shape
export function validateRegistryEntry(raw) // -> { valid, errors, record }
export function serializeRegistryEntry(raw) // -> { ok, line, record, errors }
export function parseRegistryLog(text) // -> RegistryEntry[], tolerant — bad lines skipped, never throws

// the fold + the chain verifier — pure
export function foldTargetRegistry(entries) // -> Map<registryId, FoldedRegistryId> (latest @vN per id)
export function verifyChain(entries) // -> { valid, brokenAt, reason }

// perceptual floor — pure, imports hammingHex from ./design-refs.mjs
export function verifyPerceptualFloor({ targetPHash, buildPHash, threshold }) // -> { tooClose, distance }

// IO shell — mirrors verdict-ledger.mjs's IO section
export function targetRegistryPath(root)
export function appendRegistryEntry(entry) // -> { ok, path, errors }
export function readTargetRegistry(root) // -> RegistryEntry[]
```

```js
// we:scripts/design-refs.mjs — additive exports only, no signature change to anything existing
export function imageFileToWebp(inputPath) // was private (:110-118); now exported as-is
export function fileDHash(imagePath) // new — generalizes private shotDHash (:829-841) to any raster path,
                                       // routing PNG/etc. through imageFileToWebp first when not already .webp
```

**Errors.** Every builder throws `TypeError` with a `target-registry:` prefix on a caller's programming error
(mirrors `buildVerdictRecord`'s convention); every validator/parser is tolerant (never throws on bad *data*,
only skips or reports `{valid:false}`) — the same never-throw-on-read contract `parseVerdictLog`/`validateJuryEvent`
already establish, so a partially-written or hand-mangled ledger degrades rather than crashes a caller.

**Migration.** None — no registry entries exist anywhere today (verified above); there is nothing to migrate.

### Tasks (ordered)

1. `we:scripts/design-refs.mjs` — export `imageFileToWebp` (drop the `function` → `export function`, no body
   change); add exported `fileDHash(imagePath)` generalizing `shotDHash` (`:829-841`) to route non-webp input
   through `imageFileToWebp` first. Extend `we:scripts/design-refs/__tests__/perceptual.test.mjs` to cover it.
2. `we:scripts/lib/target-registry.mjs` — `canonicalizeBytes`, `computeContentHash` (single-file + manifest
   cases).
3. `computeIntegrityDigest` (sorted-key canonical JSON, mirroring `plateau:scripts/dev/fidelity-render.mjs:240-245`,
   plus the `prevDigest` chain input).
4. `mintAuthorizationVerdict`, `frozenArtifactScan`.
5. `buildRegistryEntry` / `validateRegistryEntry` / `serializeRegistryEntry` / `parseRegistryLog` (mirror
   `we:scripts/lib/verdict-ledger.mjs:291-428`'s builder/validator/parse triad).
6. `foldTargetRegistry`, `verifyChain`.
7. `verifyPerceptualFloor` (imports `hammingHex` from `we:scripts/design-refs.mjs`).
8. IO shell: `targetRegistryPath`, `appendRegistryEntry` (locked append via `reserve`/`releaseLockDir`,
   `we:scripts/readiness/file-locks.mjs:237` / `:225`, mirroring `we:scripts/lib/verdict-ledger.mjs:722-745`),
   `readTargetRegistry`.
9. `we:scripts/__tests__/target-registry.test.mjs` — full coverage per Done-when.
10. Module-header docstring mapping each of the seven security requirements to the function that resolves it
    (so a future auditor checks coverage 1:1 rather than re-deriving it).

### Done when

- `npx vitest run` against `we:scripts/__tests__/target-registry.test.mjs` is green, and the suite demonstrates, per
  requirement (not just "the guard works"):
  - **Tamper detection (#4):** build a 3-entry chain that includes entries for **two different `registryId`s**
    (proving the chain is global append order, not per-target), mutate one field of a historical (non-latest)
    entry, refold, `verifyChain` returns `{valid: false, brokenAt: <that index>}`; an unmutated chain returns
    `{valid: true}`.
  - **Self-mint escalation (#1):** `authoredInCommit === buildCommit` (or same lane) →
    `{authorized: false, escalate: true}`; a distinct commit/lane → `{authorized: true, escalate: false}`.
  - **Frozen-artifact rejection (#5):** artifact bytes containing a live external reference in a fetch-context
    attribute (e.g. a `<script src="https://…">` tag) → `{frozen: false}` with a violation naming the offending
    reference; artifact bytes with no external reference → `{frozen: true}`; **and** a well-formed SVG whose
    only `http://`/`https://` occurrence is an `xmlns="http://www.w3.org/2000/svg"` namespace declaration →
    `{frozen: true}` (the false-positive class named above must NOT flag).
  - **Canonicalization stability (#6):** the same TEXT content saved with `\n` vs `\r\n` line endings hashes
    identically; a directory manifest's hash is independent of the order files are listed in; **and** a BINARY
    buffer (non-UTF8, e.g. arbitrary bytes including `0xFF`) hashes stably and byte-for-byte unmodified across
    two calls, never thrown on.
  - **Context binding (#3):** two entries with identical `contentHash` but different `registryId` (or different
    `@vN`) produce different `integrityDigest`s.
  - **Perceptual floor (#8):** two pHashes within the default Hamming threshold (5) → `{tooClose: true}`; two
    pHashes far apart → `{tooClose: false}`.
  - **Source-shape validation (#7):** a `source` block missing `sourceHash` or with `redacted !== true` fails
    `validateRegistryEntry`; a well-formed one passes.
- `npx vitest run` against `we:scripts/design-refs/__tests__/perceptual.test.mjs` stays green (no existing
  export's behavior changed) and gains coverage for the new `fileDHash` export.
- `node we:scripts/check-standards.mjs` — 0 errors (this gate; the full `npm run test:unit` run is the drain's
  job, not this preparation's).
- The module docstring lists all seven security requirements with a named function resolving each — reviewable
  as a checklist, not prose.

### Delivery shape

**One PR, landed whole — not incremental (though not indivisible; see the Size section's named seam).** Every
file is either brand-new (`we:scripts/lib/target-registry.mjs` and its test) or an additive-only extension of
an existing file (`we:scripts/design-refs.mjs` gains two exports, no existing signature changes) with no live
caller anywhere in either repo yet. There is no flag to hide it behind and nothing to stage across a boundary:
the eventual consumers (`#2812`, `#2803`) are separate, later slices in the epic's own build-wave order, so
this lands as a complete, independently-tested, currently-unwired library — the same shape `#2805` shipped in.
If a builder or reviewer prefers a smaller diff, the perceptual-floor seam named in the Size section can peel
off as its own PR first with no redesign of the rest; that is a delivery-sequencing choice, not a design
dependency.

### Independent review (checklist item 9) — confidence Medium, findings folded in

A fresh-context reviewer with no authorship stake in the first draft checked every citation and design claim
against the live tree (both `we:` and `plateau:`) before this card was finalized. Verdict: **confidence
Medium** — citations were almost entirely accurate and the reasoning was grounded, but real defects were found
and are fixed above, not merely noted:

- **Two factual errors, corrected:** the `FIXTURE_ROUTE_RE` citation was `:44` (a comment above a different
  regex) — corrected to the true `:51`. The claim "`grep -rn "webeverything" plateau:package.json
  plateau:scripts` → no hits" was false — two files DO reference `webeverything` as a sibling-checkout path;
  the underlying no-npm-link conclusion still holds, but the evidence cited for it was wrong and is replaced
  above with the accurate grep result.
- **Three design gaps, fixed:** (a) the ledger's chain scope (global append-order vs. per-`registryId`) was
  unspecified — now explicit (global, mirroring `we:scripts/lib/verdict-ledger.mjs`'s one-file-per-repo model)
  with a Done-when test that exercises a mixed-`registryId` chain. (b) `frozenArtifactScan`'s bare-scheme match
  would have flagged an SVG's `xmlns` namespace URI as a live-fetch violation — now scoped to fetch-context
  attributes with an explicit `xmlns`/`DOCTYPE` exemption and its own Done-when case. (c) `canonicalizeBytes`'s
  UTF-8-decode-then-reencode was unsafe for binary artifacts — now branches to raw-byte hashing for content
  that doesn't round-trip as UTF-8, with its own Done-when case.
- **One honesty correction:** the size-8/one-PR justification claimed no independent seam existed; review found
  `verifyPerceptualFloor` + the `we:scripts/design-refs.mjs` exports genuinely are separable from the
  ledger/mint/digest core. The Size and Delivery-shape sections now name that seam explicitly instead of
  denying it, while stating the reason it's still bundled.
- **One flagged-not-blocking note carried into the design:** the perceptual-floor's reused Hamming threshold
  (5 of 64 bits) is a dedup default, not a validated security constant — called out as a tuning question for
  the eventual live-gate wiring (`#2812`), not asserted as settled here.
