#!/usr/bin/env node
/**
 * @file scripts/lib/target-registry.mjs
 * @description THE TARGET REGISTRY (#2806, epic #2804) — an independent, content-hashed registry of
 *   ratified UI-fidelity mock TARGETS, an approval token (`integrityDigest`) signed over the mock's
 *   content, and a perceptual-distance floor that rejects a target too close to a build screenshot.
 *   Supplies the trust-model MECHANICS that close RRFC INVARIANT A's circular oracle once a live gate
 *   consumes them (SHIPPED UNWIRED — see the "SHIPPED UNWIRED" notes below): without a caller enforcing
 *   this, a build lane could rewrite its own target to match what it built and pass its own gate.
 *
 * The `#2801` statute (`docs/agent/platform-decisions.md#design-source-locked-in-code-target`) rules the
 * DIRECTION (in-code artifact = sole canon) but explicitly defers the trust-model MECHANICS here. Every
 * mechanic below maps 1:1 to one of the statute's seven security requirements:
 *
 *   1. Authorization predicate on mint (not self-issuable)  → {@link mintAuthorizationVerdict}
 *   2. Integrity digest, not authenticity                   → {@link computeIntegrityDigest} (see its doc)
 *   3. Context binding (registryId + @vN + authoredInCommit) → {@link computeIntegrityDigest}
 *   4. Ledger tamper-evidence (prev-entry chaining)          → {@link verifyChain} / {@link appendRegistryEntry}
 *   5. "Frozen" forbids live/expiring subresources           → {@link frozenArtifactScan}
 *   6. Canonicalization rule for sha256                      → {@link canonicalizeBytes} / {@link computeContentHash}
 *   7. Raw-payload redaction/PII + sourceHash binding        → {@link buildRegistryEntry} (`source` block)
 *   8. Perceptual-distance floor (not itself a #2801 requirement, but the card's other half) → {@link verifyPerceptualFloor}
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors `verdict-ledger.mjs`). Everything above the "IO SHELL" banner is
 * pure — no fs, no clock, no process — and unit-tested in `__tests__/target-registry.test.mjs`. Every
 * builder throws `TypeError` (prefixed `target-registry:`) on a caller's programming error; every
 * validator/parser is tolerant and never throws on bad DATA, mirroring `validateVerdictRecord`/
 * `parseVerdictLog`'s never-throw-on-read contract.
 */

import { isUnderTest } from './under-test.mjs';
import {
  appendFileSync, readFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';

import { reserve, releaseLockDir } from '../readiness/file-locks.mjs';
import { hammingHex } from '../design-refs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The schema version every registry entry carries. Bump ONLY on a breaking field change — the ledger is
 *  append-only, so v1 rows live forever beside v2 rows. */
export const TARGET_REGISTRY_VERSION = 1;

/** The record kind, so a registry file is self-describing if it is ever moved next to another JSONL stream. */
export const TARGET_REGISTRY_KIND = 'we.target-registry-entry';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Stable key order so a digest is deterministic across runs of the same content. Recursion into nested
 *  objects; arrays are left in their given order (the exact `canonicalReplacer` recipe already shipped at
 *  `plateau:scripts/dev/fidelity-render.mjs:257-260`, mirrored here rather than reinvented). */
function canonicalReplacer(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().reduce((o, k) => { o[k] = value[k]; return o; }, {});
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// CANONICALIZATION + HASHING — pure (requirement #6)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Canonicalize a byte buffer before hashing. TEXT is CRLF-normalized (`\r\n` → `\n`); BINARY passes
 * through unmodified. "Text" is decided by whether the buffer round-trips through a STRICT UTF-8 decode
 * (no replacement-character corruption) — a naive decode-then-reencode on a binary artifact (a font, a
 * raster image) would silently corrupt it, which this branch avoids by never re-encoding binary content.
 * Pure. Never throws.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function canonicalizeBytes(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? '');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Buffer.from(bytes); // binary — hash the raw bytes unmodified
  }
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * Content hash of either a single file's bytes or a directory's sorted manifest. A manifest hashes a
 * sorted-by-relative-path list of `{path, sha256(canonicalizeBytes(file))}` pairs — never filesystem
 * iteration order, which is not portable — so the identity is host-independent. Pure.
 * @param {{bytes: Buffer|Uint8Array}|{manifest: Array<{path: string, bytes: Buffer|Uint8Array}>}} input
 * @returns {string} "sha256:<hex>"
 */
export function computeContentHash(input) {
  if (input && Array.isArray(input.manifest)) {
    // Same `!= null` guard as the single-file branch below, applied per-entry: a manifest item with a
    // nullish `bytes` must throw, not silently hash an empty buffer.
    const entries = [...input.manifest]
      .map(({ path, bytes }) => {
        if (bytes == null) throw new TypeError(`target-registry: computeContentHash manifest entry ${JSON.stringify(path)} has nullish \`bytes\``);
        return { path: String(path), sha256: sha256Hex(canonicalizeBytes(bytes)) };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return `sha256:${sha256Hex(JSON.stringify(entries, canonicalReplacer))}`;
  }
  // `!= null` (not `!== undefined`) — a `{bytes: null}` shape must THROW, not silently hash an empty
  // buffer. `!== undefined` alone let a nullish-but-present `bytes` key slip past this guard and into
  // `canonicalizeBytes(null)`, which coerces to an empty buffer rather than signaling the caller's mistake.
  if (input && input.bytes != null) {
    return `sha256:${sha256Hex(canonicalizeBytes(input.bytes))}`;
  }
  throw new TypeError('target-registry: computeContentHash requires { bytes } or { manifest: [{path,bytes}] }');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// CONTEXT-BOUND, CHAIN-LINKED DIGEST — pure (requirements #2, #3, #4)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An INTEGRITY DIGEST binding `registryId` + `version` (`@vN`) + `contentHash` + `authoredInCommit` +
 * `prevDigest`. This is anti-replay/anti-tamper, NOT authenticity (requirement #2): an UNKEYED sha256 over
 * PUBLIC inputs proves neither authenticity nor authorship, only that the record was not silently altered
 * after minting — the identical honesty framing `plateau:scripts/dev/fidelity-render.mjs:243-250` already
 * ships under this exact field name.
 *
 * BINDING `registryId`/`version` INTO THE HASH (requirement #3) is what stops two byte-identical artifacts
 * under different targets cross-validating — "surface A authorizes surface B" is exactly what this
 * forecloses. Folding `prevDigest` into the SAME digest (requirement #4) makes each entry's digest depend
 * on its own fields AND the full history before it — the standard hash-chain construction. `prevDigest` is
 * `null` ONLY for the very first entry the whole ledger ever holds (the genesis mint, necessarily a `@v1`
 * — nothing can mint `@v2` of anything before at least one entry exists); every later entry, `@v1` of a
 * brand-new target included, chains to whatever preceded it in the ledger's GLOBAL append order (see
 * {@link verifyChain}), not to a per-`registryId` predecessor.
 *
 * NOT COVERED BY THIS DIGEST, STATED EXPLICITLY (a reader could otherwise assume the chain protects the
 * whole entry): `mintedBy`, `mintedAt`, the optional `source` block (`sourceHash` / `redacted` / `kind`),
 * and the writer-stamped `unlocked` flag are all persisted on the entry but are NOT bound into the hash, so
 * an actor with direct write access to the committed ledger file could alter those fields on a historical
 * entry WITHOUT `verifyChain` detecting it — only the five fields named above are tamper-evident. This is
 * deliberate, matching the card's own
 * design (§3: "hashes … over all five fields"), not an oversight: only those five are what requirement #3's
 * "surface A authorizes surface B" cross-validation concern actually needs bound, and requirement #7's
 * `source` block is a CLAIM the registry validates the SHAPE of (see {@link buildRegistryEntry}'s doc),
 * never a fact this module can attest to either way. Widening the bound field set is a scheme-level design
 * change belonging to a future revision, not something to expand silently here.
 *
 * @param {{registryId: string, version: number, contentHash: string, authoredInCommit: string,
 *   prevDigest?: string|null}} o
 * @returns {string} "sha256:<hex>"
 */
export function computeIntegrityDigest({ registryId, version, contentHash, authoredInCommit, prevDigest = null } = {}) {
  const body = JSON.stringify({ registryId, version, contentHash, authoredInCommit, prevDigest }, canonicalReplacer);
  return `sha256:${sha256Hex(body)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// MINT-TIME CHECKS — pure (requirements #1, #5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * STRUCTURAL provenance, never identity (requirement #1). WE has no user-identity/credential system to
 * check against ({@link ../lib/verdict-ledger.mjs}'s `ACTOR_PROVES` doc states this plainly for the
 * adjacent review-verdict ledger), so this mirrors `decideClearerIndependence`'s pattern
 * (`we:scripts/lib/review-independence.mjs`): comparing two DECLARED identifiers, never authenticating who
 * acted. If the target's `authoredInCommit` (or its authoring lane) equals the BUILD's commit/lane, the
 * mint is not self-issuable clean — a build lane rewriting its own target to match what it built, in the
 * same commit/lane, is exactly the circular oracle this predicate exists to catch.
 *
 * PROVES PROVENANCE, NEVER AUTHORIZATION BY A CREDENTIALED PARTY — no such party exists in this repo
 * today. Honesty stated once, like `ACTOR_PROVES`, rather than implied by the field name.
 *
 * SHIPPED UNWIRED, restated here for discoverability (not just in the file header and
 * {@link appendRegistryEntry}'s doc): no caller in this repo invokes this predicate yet. The future #2812
 * WE-floor gate is the intended caller — it decides whether to mint at all, before ever reaching
 * {@link buildRegistryEntry}/{@link appendRegistryEntry}.
 *
 * @param {{authoredInCommit: string, buildCommit: string, authoredInLane?: string|null, buildLane?: string|null}} o
 * @returns {{authorized: boolean, escalate: boolean, reason: string}}
 */
export function mintAuthorizationVerdict({
  authoredInCommit, buildCommit, authoredInLane = null, buildLane = null,
} = {}) {
  // FAIL CLOSED on a missing required identifier: the structural comparison this predicate makes is only
  // meaningful when BOTH sides of it are present. Skipping the comparison on an absent identifier and
  // falling through to `authorized: true` would treat an omission as "provenanced" — exactly backwards for
  // a security predicate.
  if (!isNonEmptyString(authoredInCommit) || !isNonEmptyString(buildCommit)) {
    return {
      authorized: false,
      escalate: true,
      reason: 'authoredInCommit and buildCommit are both required for a structural provenance check — '
        + 'missing either fails closed rather than authorizing on an absent comparison',
    };
  }
  const sameCommit = authoredInCommit === buildCommit;
  const sameLane = authoredInLane != null && buildLane != null && authoredInLane === buildLane;
  if (sameCommit || sameLane) {
    return {
      authorized: false,
      escalate: true,
      reason: sameCommit
        ? `target authoredInCommit "${authoredInCommit}" matches the build commit — self-mint, not structurally provenanced`
        : `target authoredInLane "${authoredInLane}" matches the build lane — self-mint, not structurally provenanced`,
    };
  }
  return { authorized: true, escalate: false, reason: 'authored in a distinct commit and lane from the build — structurally provenanced' };
}

// A live-fetch reference: absolute `http(s):` OR protocol-relative `//host/...` (a browser fetches both the
// same way — only the scheme is elided). Deliberately NOT a bare relative path (`./local.svg`), which loads
// same-origin content a self-contained mock target may legitimately reference.
const LIVE_REF = '(?:https?:)?\\/\\/[^\\s"\'<>)]+';

// A live-fetch ATTRIBUTE context, scoped by attribute NAME rather than a bare scheme match — a bare-scheme
// scan would false-positive on an ordinary SVG's `xmlns="http://www.w3.org/2000/svg"` namespace declaration
// or an XHTML `<!DOCTYPE …>`, neither of which a browser ever fetches, and SVG/XHTML mock content is exactly
// what this registry canonicalizes. Scoping to a curated attribute-name set means `xmlns`/`DOCTYPE` are
// NEVER candidate matches in the first place — no separate exemption list is needed. The set is named, not
// tag-scoped, so it covers every element that can carry one of these attributes (`<iframe src>`,
// `<object data>`, `<embed src>`, `<source src>`, `<video poster>`, `<form action>`, `<button formaction>`,
// SVG's `xlink:href`/`<use href>`), not just the original `<script src>`/`<link href>`/`<img src>` triad.
// Matches BOTH quoted (single or double) and UNQUOTED attribute values (both are legal HTML).
//
// THE BOUNDARY IS `(?<![\w-])`, NOT `\b` — deliberately, and the distinction matters. `xlink:href` needs
// its `href` to still match (the colon before it is a legitimate separator this scan wants to see through),
// but a hyphenated custom attribute that merely ENDS in a tracked name — `data-src`, `data-href`,
// `data-action`, `data-poster`, `data-background` (the common lazy-load/framework-binding convention) — must
// NOT match. A plain `\b` cannot tell these apart: `:` and `-` are both "non-word" to `\b`, so `\bsrc\b`
// matches inside BOTH `xlink:href`-shaped and `data-src`-shaped text. The negative lookbehind excludes only
// a preceding word character OR hyphen, which keeps the colon-separated case matching while excluding the
// hyphen-separated one.
const LIVE_FETCH_ATTRS = ['src', 'href', 'data', 'action', 'formaction', 'poster', 'srcset', 'background', 'ping', 'manifest'];
const ATTR_VALUE_RE = new RegExp(String.raw`(?<![\w-])ATTR\b\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))`, 'gi');
const ATTR_PATTERNS = LIVE_FETCH_ATTRS.map((attr) => ({
  attribute: `[${attr}]`,
  re: new RegExp(ATTR_VALUE_RE.source.replace('ATTR', attr), 'gi'),
}));
// A `srcset` VALUE is a comma-separated `url descriptor` list (`"https://x.png 1x, https://y.png 2x"`), so
// the attribute-value capture above intentionally grabs the FULL value (trailing descriptor included) rather
// than anchoring its end to a live-fetch reference's own end — this search then finds a reference ANYWHERE
// within that captured value. Reports only the FIRST live reference found, sufficient for a boolean
// "not frozen" verdict even though it does not enumerate every candidate in a multi-source set.
const LIVE_REF_SEARCH_RE = new RegExp(LIVE_REF, 'i');

// CSS `url(...)` (quoted, unquoted, or protocol-relative) and a bare `@import "…"` with no `url()` wrapper.
const CSS_URL_RE = new RegExp(`\\burl\\(\\s*(?:"(${LIVE_REF})"|'(${LIVE_REF})'|(${LIVE_REF}))\\s*\\)`, 'gi');
const CSS_IMPORT_RE = new RegExp(`@import\\s+(?:"(${LIVE_REF})"|'(${LIVE_REF})')`, 'gi');

// `<meta http-equiv="refresh" content="0;url=https://…">` — a live redirect target. Matched tag-at-a-time
// (attribute order in HTML is unconstrained) rather than one flat regex assuming `http-equiv` precedes
// `content`.
const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_REFRESH_RE = /http-equiv\s*=\s*["']?refresh(?!\w)["']?/i;
const META_CONTENT_RE = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i;
const META_URL_RE = new RegExp(`url\\s*=\\s*(${LIVE_REF})`, 'i');

// Decode NUMERIC HTML character references (`&#104;` / `&#x68;`) before scanning: `&#104;ttps://evil.example`
// decodes to `https://evil.example` in a real browser but never matches a raw-text scheme regex. Named
// entities (`&amp;` etc.) are deliberately NOT decoded: none of them can spell out a URL scheme or host, so
// decoding the full named-entity table would add complexity with no coverage gain.
function decodeNumericEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

/**
 * "Frozen" forbids live/expiring subresources (requirement #5) — a deterministic, attribute-scoped regex
 * scan, the same shape `FIXTURE_ROUTE_RE` already uses at `we:scripts/lib/fidelity-contract.mjs:51` to
 * reject a fixture route. Rejects a live-fetch reference ({@link LIVE_REF}) found in a live-fetch attribute
 * ({@link LIVE_FETCH_ATTRS}), a CSS `url(...)`/`@import`, or a `<meta http-equiv="refresh">` redirect — see
 * the comments above for why `xmlns`/`DOCTYPE` need no separate exemption. Pure.
 *
 * NOT DETECTED, STATED EXPLICITLY (a text-level regex scan has a real ceiling): a live network call made
 * from INLINE `<script>` BODY JavaScript (`fetch(...)`, `XMLHttpRequest`, dynamic `import(...)`) is
 * invisible to this scan, which only inspects declarative HTML/CSS attributes and `url()`/`@import` — it is
 * not a JavaScript static analyzer and does not attempt to become one. A target registry entry whose
 * canonical artifact needs to rule out script-body network calls needs a stronger mechanism than this
 * function; this scan closes the DECLARATIVE live-fetch surface, not the executable one (tracked as
 * follow-on hardening in backlog #xxrq31g).
 *
 * SHIPPED UNWIRED, restated here for discoverability: no caller in this repo invokes this predicate yet.
 * The future #2812 WE-floor gate is the intended caller — see {@link mintAuthorizationVerdict}'s matching
 * note and {@link appendRegistryEntry}'s doc.
 *
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {{frozen: boolean, violations: Array<{attribute: string, reference: string}>}}
 */
export function frozenArtifactScan(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '');
  const text = decodeNumericEntities(raw);
  const violations = [];
  const scan = (attribute, re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) violations.push({ attribute, reference: m[1] ?? m[2] ?? m[3] });
  };
  // Attribute values: extract the FULL value first (it may carry trailing content past the reference, e.g.
  // srcset's ` 1x` descriptor), then search WITHIN it for a live-fetch reference — never require the
  // reference to span the value's entire length.
  for (const { attribute, re } of ATTR_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const value = m[1] ?? m[2] ?? m[3] ?? '';
      const refMatch = value.match(LIVE_REF_SEARCH_RE);
      if (refMatch) violations.push({ attribute, reference: refMatch[0] });
    }
  }
  scan('css url()', CSS_URL_RE);
  scan('css @import', CSS_IMPORT_RE);

  META_TAG_RE.lastIndex = 0;
  let mm;
  while ((mm = META_TAG_RE.exec(text))) {
    const tag = mm[0];
    if (!META_REFRESH_RE.test(tag)) continue;
    const contentMatch = tag.match(META_CONTENT_RE);
    const contentVal = contentMatch ? (contentMatch[1] ?? contentMatch[2] ?? contentMatch[3] ?? '') : '';
    const urlMatch = contentVal.match(META_URL_RE);
    if (urlMatch) violations.push({ attribute: 'meta[http-equiv=refresh]', reference: urlMatch[1] });
  }

  return { frozen: violations.length === 0, violations };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// REGISTRY ENTRY — pure builder/validator/serializer, mirrors buildVerdictRecord/validateVerdictRecord
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RegistryEntry
 * @property {number} v - {@link TARGET_REGISTRY_VERSION}.
 * @property {string} kind - {@link TARGET_REGISTRY_KIND}.
 * @property {string} registryId
 * @property {number} version - the `@vN` this entry mints.
 * @property {string} contentHash - "sha256:<hex>", from {@link computeContentHash}.
 * @property {string} authoredInCommit
 * @property {string|null} prevDigest - null ONLY for the ledger's very first entry.
 * @property {string} integrityDigest - from {@link computeIntegrityDigest}.
 * @property {{kind: string, sourceHash: string, redacted: true}} [source] - see requirement #7's doc below.
 * @property {string} mintedBy
 * @property {string} mintedAt - ISO-8601 (INJECTED — the pure builder never reads a clock).
 */

/** Shared shape checks for `prevDigest`, used by both the throwing builder and the tolerant validator: it
 *  may be `null` ONLY when `version` is 1 (the one-directional genesis invariant — see
 *  {@link computeIntegrityDigest}'s doc: null implies v1, not the reverse), else it must be a valid digest. */
function prevDigestError(prevDigest, version) {
  if (prevDigest === null) return version === 1 ? null : '`prevDigest` may only be null when `version` is 1 (the genesis mint)';
  if (typeof prevDigest !== 'string' || !HASH_RE.test(prevDigest)) return '`prevDigest` must be null or "sha256:<hex>"';
  return null;
}

/**
 * RAW-PAYLOAD REDACTION/PII + `sourceHash` BINDING (requirement #7). WE validates the CLAIM shape only —
 * it never opens or parses the raw payload itself (Figma node JSON, potentially carrying PII, is
 * normalized and archived product-side; WE holds zero implementation). The identical honesty pattern
 * `we:scripts/lib/verdict-ledger.mjs`'s `actor` block documents ("IT CAN PROVE / IT CANNOT PROVE"),
 * applied to `source`: WE can prove a `sourceHash` and a `redacted` claim are present and well-formed; it
 * cannot prove redaction actually happened. */
function sourceBlockError(source) {
  if (source == null) return null;
  if (typeof source !== 'object' || Array.isArray(source)) return '`source` must be an object when present';
  if (typeof source.sourceHash !== 'string' || !HASH_RE.test(source.sourceHash)) return '`source.sourceHash` must be "sha256:<hex>"';
  if (source.redacted !== true) return '`source.redacted` must be `true`';
  return null;
}

/**
 * Build a schema-valid {@link RegistryEntry}. PURE — `mintedAt` is injected, never read from the wall
 * clock. THROWS `TypeError` (prefixed `target-registry:`) on a caller's programming error; a record that
 * reaches the file is validated again on the way in and the way out ({@link validateRegistryEntry}).
 * @param {{registryId: string, version: number, contentHash: string, authoredInCommit: string,
 *   prevDigest?: string|null, source?: {kind?: string, sourceHash: string, redacted: true},
 *   mintedBy: string, mintedAt: string}} o
 * @returns {RegistryEntry}
 */
export function buildRegistryEntry({
  registryId, version, contentHash, authoredInCommit, prevDigest = null, source = null, mintedBy, mintedAt,
} = {}) {
  if (!isNonEmptyString(registryId)) throw new TypeError(`target-registry: \`registryId\` must be a non-empty string, got ${JSON.stringify(registryId)}`);
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`target-registry: \`version\` must be a positive integer, got ${JSON.stringify(version)}`);
  if (typeof contentHash !== 'string' || !HASH_RE.test(contentHash)) throw new TypeError(`target-registry: \`contentHash\` must be "sha256:<hex>", got ${JSON.stringify(contentHash)}`);
  if (!isNonEmptyString(authoredInCommit)) throw new TypeError(`target-registry: \`authoredInCommit\` must be a non-empty string, got ${JSON.stringify(authoredInCommit)}`);
  const prevErr = prevDigestError(prevDigest, version);
  if (prevErr) throw new TypeError(`target-registry: ${prevErr}`);
  const srcErr = sourceBlockError(source);
  if (srcErr) throw new TypeError(`target-registry: ${srcErr}`);
  if (!isNonEmptyString(mintedBy)) throw new TypeError(`target-registry: \`mintedBy\` is required, got ${JSON.stringify(mintedBy)}`);
  if (typeof mintedAt !== 'string' || !ISO_RE.test(mintedAt)) throw new TypeError(`target-registry: \`mintedAt\` must be an ISO-8601 UTC timestamp, got ${JSON.stringify(mintedAt)}`);

  const entry = {
    v: TARGET_REGISTRY_VERSION,
    kind: TARGET_REGISTRY_KIND,
    registryId,
    version,
    contentHash,
    authoredInCommit,
    prevDigest,
    integrityDigest: computeIntegrityDigest({ registryId, version, contentHash, authoredInCommit, prevDigest }),
    mintedBy,
    mintedAt,
  };
  if (source != null) entry.source = { kind: typeof source.kind === 'string' ? source.kind : '', sourceHash: source.sourceHash, redacted: true };
  return entry;
}

/**
 * Validate + normalize a raw parsed line. NEVER throws — mirrors `validateVerdictRecord`'s contract, so
 * one bad line can never crash a reader.
 * @param {*} raw
 * @returns {{valid: boolean, errors: string[], record: RegistryEntry|null}}
 */
export function validateRegistryEntry(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, errors: ['not an object'], record: null };
  if (!Number.isInteger(raw.v) || raw.v < 1) errors.push(`bad \`v\`: ${JSON.stringify(raw.v)}`);
  if (raw.kind !== TARGET_REGISTRY_KIND) errors.push(`bad \`kind\`: ${JSON.stringify(raw.kind)}`);
  if (!isNonEmptyString(raw.registryId)) errors.push(`bad \`registryId\`: ${JSON.stringify(raw.registryId)}`);
  if (!Number.isInteger(raw.version) || raw.version < 1) errors.push(`bad \`version\`: ${JSON.stringify(raw.version)}`);
  if (typeof raw.contentHash !== 'string' || !HASH_RE.test(raw.contentHash)) errors.push(`bad \`contentHash\`: ${JSON.stringify(raw.contentHash)}`);
  if (!isNonEmptyString(raw.authoredInCommit)) errors.push(`bad \`authoredInCommit\`: ${JSON.stringify(raw.authoredInCommit)}`);
  const prevErr = Number.isInteger(raw.version) ? prevDigestError(raw.prevDigest ?? null, raw.version) : '`prevDigest` unchecked — `version` invalid';
  if (prevErr) errors.push(prevErr);
  if (typeof raw.integrityDigest !== 'string' || !HASH_RE.test(raw.integrityDigest)) errors.push(`bad \`integrityDigest\`: ${JSON.stringify(raw.integrityDigest)}`);
  const srcErr = sourceBlockError(raw.source ?? null);
  if (srcErr) errors.push(srcErr);
  if (!isNonEmptyString(raw.mintedBy)) errors.push('bad `mintedBy`');
  if (typeof raw.mintedAt !== 'string' || !ISO_RE.test(raw.mintedAt)) errors.push(`bad \`mintedAt\`: ${JSON.stringify(raw.mintedAt)}`);
  if (errors.length) return { valid: false, errors, record: null };

  const record = {
    v: raw.v,
    kind: TARGET_REGISTRY_KIND,
    registryId: raw.registryId,
    version: raw.version,
    contentHash: raw.contentHash,
    authoredInCommit: raw.authoredInCommit,
    prevDigest: raw.prevDigest ?? null,
    integrityDigest: raw.integrityDigest,
    mintedBy: raw.mintedBy,
    mintedAt: raw.mintedAt,
  };
  if (raw.source && typeof raw.source === 'object') {
    record.source = { kind: typeof raw.source.kind === 'string' ? raw.source.kind : '', sourceHash: raw.source.sourceHash, redacted: true };
  }
  // `unlocked` (see appendRegistryEntry) is the ONE writer-stamped field this schema allow-lists — carried
  // through explicitly rather than via a raw passthrough, which would let ANY extra field on `raw` survive
  // into the committed, canonical ledger.
  if (raw.unlocked === true) record.unlocked = true;
  return { valid: true, errors: [], record };
}

/**
 * Serialize ONE entry to a JSONL line, validating first. PURE. `ok:false` means NOTHING should be written.
 * Serializes the NORMALIZED `record`, never the caller's raw object — an extra/unrecognized field on `raw`
 * must not reach the committed ledger (`unlocked` is the one such field allow-listed by
 * {@link validateRegistryEntry} and so survives normalization intact).
 * @param {*} raw
 * @returns {{ok: boolean, line: string|null, record: RegistryEntry|null, errors: string[]}}
 */
export function serializeRegistryEntry(raw) {
  const { valid, errors, record } = validateRegistryEntry(raw);
  if (!valid) return { ok: false, line: null, record: null, errors };
  return { ok: true, line: JSON.stringify(record), record, errors: [] };
}

/**
 * Parse a registry log's TEXT into normalized entries. PURE + tolerant: a blank, unparseable or
 * schema-invalid line is SKIPPED, never thrown on. Append order is preserved and IS the ordering.
 * @param {string} text
 * @returns {RegistryEntry[]}
 */
export function parseRegistryLog(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const { valid, record } = validateRegistryEntry(parsed);
    if (valid) out.push(record);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE FOLD + THE CHAIN VERIFIER — pure (requirement #4)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FoldedRegistryId
 * @property {string} registryId
 * @property {RegistryEntry|null} latest - the highest `version` entry seen for this id.
 * @property {RegistryEntry[]} versions - every entry for this id, in append order.
 */

/**
 * Group entries by registryId and find the latest @vN per id. PURE. This projection groups — the
 * opposite of {@link verifyChain}, which never groups and only walks global append order (requirement #4's
 * "two different, separately-tested functions over the same stream").
 * @param {RegistryEntry[]} entries
 * @returns {Map<string, FoldedRegistryId>}
 */
export function foldTargetRegistry(entries) {
  const byId = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !isNonEmptyString(e.registryId)) continue;
    let folded = byId.get(e.registryId);
    if (!folded) { folded = { registryId: e.registryId, latest: null, versions: [] }; byId.set(e.registryId, folded); }
    folded.versions.push(e);
    if (!folded.latest || e.version > folded.latest.version) folded.latest = e;
  }
  return byId;
}

/**
 * Walk the ledger's GLOBAL append order recomputing each entry's `integrityDigest` from its own stored
 * fields and the PRIOR entry's stored digest (requirement #4 — chained across the whole file, regardless
 * of which `registryId` each entry belongs to, catching a dropped/reordered/inserted entry for ANY target,
 * not only tampering within one target's own version history). A mismatch at index *i* means entry *i*
 * (or anything before it) was altered after the fact without re-minting. PURE.
 * @param {RegistryEntry[]} entries - in append order.
 * @returns {{valid: boolean, brokenAt: number|null, reason: string}}
 */
export function verifyChain(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let prevDigest = null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const expectedPrev = i === 0 ? null : prevDigest;
    if ((e.prevDigest ?? null) !== expectedPrev) {
      return { valid: false, brokenAt: i, reason: `entry ${i}: \`prevDigest\` is ${JSON.stringify(e.prevDigest ?? null)}, expected ${JSON.stringify(expectedPrev)} (append-order break)` };
    }
    const recomputed = computeIntegrityDigest({
      registryId: e.registryId, version: e.version, contentHash: e.contentHash,
      authoredInCommit: e.authoredInCommit, prevDigest: e.prevDigest ?? null,
    });
    if (recomputed !== e.integrityDigest) {
      return { valid: false, brokenAt: i, reason: `entry ${i}: stored \`integrityDigest\` ${e.integrityDigest} does not match recomputed ${recomputed} — the entry was altered after minting` };
    }
    prevDigest = e.integrityDigest;
  }
  return { valid: true, brokenAt: null, reason: '' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PERCEPTUAL FLOOR — pure, imports hammingHex from ../design-refs.mjs (the card's other half)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Default Hamming threshold (of 64 bits) — REUSED from `design-refs.mjs`'s own near-dup default, not a
 *  re-validated security constant. Ship it as the documented default; the eventual live-gate wiring
 *  (`#2812`) should treat the number itself as an open tuning question. */
export const DEFAULT_PERCEPTUAL_THRESHOLD = 5;

/**
 * Is a candidate target's perceptual hash suspiciously close to a build screenshot's? A thin wrapper over
 * `hammingHex` (`we:scripts/design-refs.mjs`) — no re-derived distance metric. `targetPHash`/`buildPHash`
 * are precomputed hex strings (via `fileDHash`); the comparator itself takes no image bytes, keeping this
 * security-bearing pure core free of the `cwebp`/`dwebp` shell-out. Pure.
 * @param {{targetPHash: string, buildPHash: string, threshold?: number}} o
 * @returns {{tooClose: boolean, distance: number}}
 */
export function verifyPerceptualFloor({ targetPHash, buildPHash, threshold = DEFAULT_PERCEPTUAL_THRESHOLD } = {}) {
  const distance = hammingHex(targetPHash, buildPHash);
  return { tooClose: distance <= threshold, distance };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// IO SHELL — mirrors verdict-ledger.mjs's IO section. Everything above this line is pure.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `host:pid:target-registry`, matching `processWriterId` in `we:scripts/lib/verdict-ledger.mjs`. */
function processWriterId() {
  return `${hostname()}:${process.pid}:target-registry`;
}

/**
 * Where the registry file lives under a given root. `root` is injectable (never hardcoded to a global
 * home) because — unlike the verdict ledger — this registry is COMMITTED, in-repo canon (the #2801
 * statute's "in-code artifact"), one file per checkout, not a machine-global local-only log.
 * @param {string} root
 * @returns {string}
 */
export function targetRegistryPath(root) {
  return join(String(root), 'design-refs', 'target-registry.jsonl');
}

/** The repo root in effect for this process when no root is explicitly given (`appendRegistryEntry` /
 *  `readTargetRegistry`'s implicit default). `WE_TARGET_REGISTRY_ROOT` always wins (so a test names an
 *  inspectable dir); a Vitest run defaults to a scratch tmpdir so the unit suite never touches the real,
 *  committed registry. */
function defaultRegistryRoot() {
  const env = process.env.WE_TARGET_REGISTRY_ROOT;
  if (env && env.trim()) return env;
  if (isUnderTest()) return join(tmpdir(), 'we-target-registry-vitest');
  return join(__dirname, '..', '..'); // scripts/lib/.. -> scripts/.. -> repo root
}

const LOCK_KEY = '<target-registry:append>';
const LOCK_LEASE_MINUTES = 1;

/**
 * APPEND one registry entry. The only write path. Validates before writing — an invalid entry is REFUSED
 * and nothing is written. SERIALIZED via a short-TTL lock (`reserve`/`releaseLockDir`,
 * `we:scripts/readiness/file-locks.mjs`, mirroring `we:scripts/lib/verdict-ledger.mjs`'s `appendVerdict`)
 * so two processes appending to the SAME checkout at once cannot interleave a torn line.
 *
 * DOES NOT ITSELF CALL {@link mintAuthorizationVerdict} OR {@link frozenArtifactScan} — worth restating
 * prominently rather than only in the file header. This is deliberate, not an oversight: those two
 * predicates are separate, independently-callable pure functions precisely so a CALLER decides whether to
 * mint at all before ever reaching this IO shell — the exact shape `we:scripts/lib/verdict-ledger.mjs`'s
 * `appendVerdict` already uses (it does not call `decideClearerIndependence` either;
 * `we:scripts/review-set-label.mjs` does, before writing). This module ships with no such caller wired yet
 * (the card's own Delivery-shape section states this explicitly); the future #2812 WE-floor gate is where
 * `mintAuthorizationVerdict`/`frozenArtifactScan` get called, and their verdicts decide whether
 * `buildRegistryEntry`/`appendRegistryEntry` are ever reached for a given mint.
 *
 * THREE INTEGRITY CHECKS enforced HERE, at the one write path, rather than left as a prose-only claim:
 *   1. **The `unlocked` case is LEGIBLE, not silent.** A lock this call cannot get no longer costs the
 *      record — the append still proceeds — but the entry is stamped `unlocked: true` first (mirroring
 *      `appendVerdict`'s identical convention), so a reader of the ledger can see the weaker case happened
 *      instead of the docstring merely asserting it.
 *   2. **A STALE `prevDigest` is REFUSED, closing the TOCTOU window between a caller reading the registry
 *      (to learn the current last digest) and calling this function.** Two concurrent callers that both
 *      read the same "last entry" and both mint against it would, before this check, both succeed in
 *      writing — silently producing two entries with the same `prevDigest`, a chain inconsistency
 *      `verifyChain` would only surface much later, at audit time. The check re-reads the CURRENT last entry
 *      inside this call (inside the lock, when one was acquired) and refuses to write when the caller's
 *      `prevDigest` no longer matches it — fail fast with a clear reason instead of writing an entry already
 *      doomed to fail `verifyChain`. This closes the race for the common (lock-acquired) case; the
 *      lock-unavailable fallback narrows the window to immediately before this one `appendFileSync` rather
 *      than eliminating it, which is the same weaker-but-legible tradeoff (1) makes explicit.
 *   3. **A NON-SEQUENTIAL `version` for this `registryId` is REFUSED.** `buildRegistryEntry` is pure and has
 *      no ledger access, so it cannot itself check this; this IO shell can, and does, using
 *      {@link foldTargetRegistry} over the current ledger to find the target's latest minted version and
 *      requiring the new entry's `version` be exactly one more (or `1` for a brand-new `registryId`) —
 *      closing a gap a content-hash-only check would miss (two DIFFERENT contentHashes could otherwise both
 *      claim the same `@vN`, or skip a version, with nothing else in this module noticing).
 * @param {RegistryEntry} entry - from {@link buildRegistryEntry}.
 * @returns {{ok: boolean, path: string|null, errors: string[]}}
 */
export function appendRegistryEntry(entry) {
  const root = defaultRegistryRoot();
  const path = targetRegistryPath(root);
  const lockRoot = `${dirname(path)}-locks`;
  const owner = processWriterId();
  let locked = false;
  try {
    mkdirSync(lockRoot, { recursive: true });
    locked = reserve(
      lockRoot, LOCK_KEY, owner, Date.now(), new Date().toISOString(), process.pid, 'unknown', LOCK_LEASE_MINUTES,
    ).ok === true;
  } catch { locked = false; }

  try {
    const existing = readTargetRegistry(root);
    const expectedPrev = existing.length ? existing[existing.length - 1].integrityDigest : null;
    const claimedPrev = entry && entry.prevDigest !== undefined ? entry.prevDigest : null;
    if (claimedPrev !== expectedPrev) {
      return {
        ok: false, path: null,
        errors: [`stale prevDigest: expected ${JSON.stringify(expectedPrev)} (the ledger's current last entry) `
          + `but the entry claims ${JSON.stringify(claimedPrev)} — re-read the registry and re-mint against its current head`],
      };
    }
    const folded = foldTargetRegistry(existing).get(entry && entry.registryId);
    const expectedVersion = folded && folded.latest ? folded.latest.version + 1 : 1;
    if (!entry || entry.version !== expectedVersion) {
      return {
        ok: false, path: null,
        errors: [`non-sequential version: registryId ${JSON.stringify(entry && entry.registryId)} expects `
          + `@v${expectedVersion} next, but the entry claims @v${entry && entry.version}`],
      };
    }
    const raw = locked ? entry : { ...entry, unlocked: true };
    const { ok, line, errors } = serializeRegistryEntry(raw);
    if (!ok) return { ok: false, path: null, errors };
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, 'utf8');
    return { ok: true, path, errors: [] };
  } finally {
    if (locked) { try { releaseLockDir(lockRoot, LOCK_KEY); } catch { /* TTL reclaims it */ } }
  }
}

/**
 * Read + normalize the registry at `root`. A missing file → `[]`. Never throws.
 * @param {string} root
 * @returns {RegistryEntry[]}
 */
export function readTargetRegistry(root) {
  const path = targetRegistryPath(root ?? defaultRegistryRoot());
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return parseRegistryLog(text);
}
