/**
 * @file secret-scrub.mjs — the PURE secret/credential/PII detector core (#3015, under #2978 Fork 3).
 *
 * The regex + entropy core used to live inline in we:scripts/conveyor/learnings-drop.mjs, where it gated the
 * APPEND seam of the learnings drop-box. That seam guards a machine-local, untracked JSONL pool; the seam
 * that actually matters — where content becomes a COMMITTED, PUSHED artifact (a `backlog/*.md` card, a
 * memory topic file) — had no scrub at all. #2978 Fork 3 ratified moving the gate "from the append seam to
 * the publish seam". This module is the shared pure home (mirrors we:scripts/lib/write-all-sync.mjs) that
 * every seam's callers import; nothing re-implements it (we:docs/agent/platform-decisions.md
 * #deterministic-core-thin-judgment).
 *
 * TWO exported detectors, deliberately different in width:
 *
 *   • `scrubReasons(value)` — the FULL append-seam set (secrets + paths + code + PII + repo-identifying
 *     names). Its width is a TENANT-READY-BY-CONSTRUCTION requirement of the drop-box schema (#2610): a
 *     learnings entry must carry no raw code and no repo-identifying path, because that pool later feeds a
 *     multi-tenant product feedback channel. Kept exported + unit-tested; no longer wired into
 *     `validateEntry` (#3015 moved the gate).
 *   • `scrubPublish(value)` — the PUBLISH-seam detector. STRICTLY NARROWER, and every omission below is a
 *     measured decision, not an oversight. See "WHAT scrubPublish DOES NOT CATCH".
 *
 * Both are pure (string → string[] of human reasons; empty ⇒ clean), so every caller composes them the same
 * way: `if (reasons.length) deny/die(...)`, always BEFORE the write executes.
 *
 * ── WHAT `scrubPublish` CATCHES ────────────────────────────────────────────────────────────────────
 *   1. Known-prefix credentials — PEM blocks, `sk-/pk-/rk-`, `ghp_/gho_/…`, `github_pat_`, `xox…`, `AKIA…`,
 *      `AIza…`, JWTs, and a URL with inline `user:pass@host` credentials.
 *   2. A LABELED credential whose value is secret-shaped (`password: …`, `api_key=…`).
 *   3. Two entropy detectors, CALIBRATED against the whole committed corpus (3,319 `backlog/*.md` +
 *      memory files) so the gate has ZERO false positives on content this repo already considers correct:
 *        • long opaque blob — a ≥40-char run over the base64/base64url alphabet with Shannon entropy
 *          ≥ 4.8 bits/char. Measured: the corpus's most-random 40-char run scores 4.55 (a long
 *          `/backlog/NNN-slug` route), while random 32/45-byte base64 secrets score ~5.3–5.9. Detection on
 *          synthetic secrets: 79% (32-byte base64), 100% (45-byte base64), 65% (32-byte base64url).
 *        • opaque token — a 20–256 char whitespace/slash-delimited segment over `[A-Za-z0-9+=_]`, not pure
 *          hex, entropy ≥ 3.0, vowel ratio < 0.20. Measured: the corpus's least-pronounceable such segment
 *          is `REGISTRY_SCRIPT_TYPE` at 0.222, so 0.20 leaves real margin under real identifiers.
 *   4. PII — ONLY public IPv4/IPv6 addresses and personal-mailbox-shaped email addresses. Phone numbers and
 *      street addresses are NOT covered (see "DOES NOT CATCH" below).
 *
 * ── WHAT `scrubPublish` DOES NOT CATCH (named, so the gap is a decision) ───────────────────────────
 *   • LENGTH FLOORS — the blob rule requires ≥40 chars, the token rule ≥20 chars. So ANY opaque credential
 *     under 20 characters is undetected, regardless of alphabet: a 16-char random alnum key, a 12-char
 *     unlabeled password. This is the single most common leak shape not covered by anything below.
 *   • CODE, repo paths, and the repo's own name (`CODE_PATTERNS`, `CODE_EXT`/`DOC_EXT`, `REPO_NAMES`).
 *     Ratified out in #3015: the destination here is the repo's OWN corpus, where citing a `we:`-prefixed
 *     repo path is REQUIRED (#883, we:docs/agent/conventions.md) and quoting an identifier is ordinary
 *     authorship.
 *   • ABSOLUTE FILESYSTEM PATHS (`/a/b/…`, `~/…`, `C:\…`, `file://`). The card for #3015 expected to keep
 *     these; MEASUREMENT retired them. The append-seam path rules fire on 1,077 of the 3,319 committed
 *     corpus files, and every sampled hit is legitimate: site-relative routes (`/backlog/NNN-slug`,
 *     `/blocks/component`, `/api/backlog`) and the repo's own documented machine conventions
 *     (`~/.claude/settings.json`, `~/workspace/.lanes/<repo>/lane-N` — a path this very repo prints in its
 *     own error messages). A rule that fires on a third of the corpus and never on a credential is not a
 *     control; it is noise that trains authors to route around the gate. A real `/Users/<name>/…` paste is
 *     therefore NOT blocked here — the #883 locus-prefix gate remains the rule that governs path hygiene.
 *   • BARE HEX TOKENS (the append seam's "≥20 hex chars" rule). A 40-char lowercase-hex git SHA and a
 *     40-char hex session token are the same string by shape, and citing a commit SHA is recurring,
 *     legitimate backlog content (5 such citations in the corpus today). Pure-hex runs are explicitly
 *     EXEMPTED from the opaque-token rule for the same reason. So a raw hex secret pasted with no label and
 *     no prefix passes this gate.
 *   • ~20–35% of random base64/base64url blobs, and most base64url tokens containing `-` (that character
 *     also spells ordinary hyphenated prose and UUIDs, which the corpus is full of). The blob rule is a
 *     probabilistic entropy test, not a proof.
 *   • A secret SPLIT across two writes, or one added by a write path that calls neither `writeBacklogMd`
 *     nor the `Edit`/`Write` tools — the `check:standards` corpus sweep is the later backstop for that, and
 *     a sweep is a catch, not a same-turn deny.
 *   • PII other than email/IPv4/IPv6 — phone numbers (E.164 or otherwise) and street addresses are NOT
 *     covered. Catch-item 4 above is narrower than the word "PII" alone would suggest.
 */

// ── entropy / character-class helpers ─────────────────────────────────────────────────────────────
/** Shannon entropy in bits/char — high for opaque keys, low for repetitive/dictionary text. */
export function shannonEntropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
/** How many of {lowercase, uppercase, digit} a string uses (0–3). ≥3 ⇒ mixed like a random secret. */
function charClasses(s) {
  return (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0);
}
/**
 * Vowel ratio over the ALPHABETIC chars — the cheap discriminator between a random opaque token and a
 * word-concatenation identifier. Random secrets (base32/hex/keys) run ~0–15% vowels; English-derived
 * identifiers run ~25–55% (measured: `item2614dropbox` 0.36, `lane5poolacquire` 0.53, a base32 TOTP 0.05).
 * Returns 1 (treated as "pronounceable, don't flag") when there are too few letters to judge.
 */
function vowelRatio(s) {
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < 8) return 1;
  const vowels = (s.match(/[AEIOU]/gi) || []).length;
  return vowels / letters;
}
/**
 * A whitespace-delimited token that reads as an OPAQUE secret/key rather than prose. TWO shapes:
 *   (a) MIXED — ≥3 character classes (lower+upper+digit) + high entropy: unknown-format keys and long
 *       tokens the prefix/blob rules skip (e.g. a Google AIza… key, a github_pat_… PAT with internal `_`).
 *   (b) NON-PRONOUNCEABLE — a long run of token chars with a very low vowel ratio + real entropy: catches
 *       2-class base32/random secrets (e.g. a TOTP `jbswy3d…`) that entropy-alone can't separate from a
 *       word-concatenation identifier (which stays pronounceable, so its vowel ratio spares it).
 * The upper length bound is generous (a real field is length-capped anyway) so ~88-char PATs are not skipped.
 *
 * APPEND-SEAM detector — deliberately trigger-happy for a schema whose fields are 60–400 chars of
 * generalized prose. It is NOT reused at the publish seam: measured against the committed corpus it fires
 * on ordinary hyphenated prose (`UTF-16-code-unit`, `JS-first-vs-CSS-first`) and on the UUIDs that cards
 * legitimately quote. `isOpaquePublishToken` below is the calibrated publish-seam twin.
 */
export function isHighEntropyToken(tok) {
  if (tok.length < 16 || tok.length > 256) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(tok)) return false; // a single opaque run, not a phrase with punctuation
  const entropy = shannonEntropy(tok);
  if (charClasses(tok) >= 3 && entropy >= 3.0) return true;              // (a) mixed-class key
  if (vowelRatio(tok) < 0.15 && entropy >= 3.0) return true;            // (b) non-pronounceable random token
  return false;
}

// ── scrub: reject a VALUE that carries a secret / path / code / PII string ──────────────────────────
// Deny-at-the-write-seam (the #883 write-time-gate precedent). Each matcher returns a human reason.
export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/, 'PEM key/cert block'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/, 'api-key-shaped token (sk-/pk-/rk-)'],
  [/\bgh[posru]_[A-Za-z0-9]{16,}/, 'GitHub token (ghp_/gho_/…)'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'GitHub fine-grained PAT (github_pat_…)'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token (xox…)'],
  [/\bAKIA[0-9A-Z]{12,}/, 'AWS access key id (AKIA…)'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'Google API key (AIza…)'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, 'JWT (eyJ….….…)'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/, 'long base64/secret-looking blob (≥40 chars)'],
  // Lowered 32→20: a 20-char lowercase-hex session id / short-lived token is a real leak class. Pure-hex
  // runs of ≥20 chars are ~never prose (git SHORT shas are ≤12 → pass; hex colors are 6 → pass).
  [/\b[0-9a-fA-F]{20,}\b/, 'long hex string (≥20 hex chars — token/hash/session id)'],
];
export const PATH_PATTERNS = [
  // Leading boundary is any NON-path char (not just whitespace), so an absolute path glued to `=`, a quote,
  // or a paren — `path=/Users/nic/…`, `"/Users/…"`, `(/Users/…)` — is caught, not only the space-separated form.
  [/(?:^|[^A-Za-z0-9._/-])(?:\/[A-Za-z0-9._-]+){2,}/, 'absolute POSIX path (/a/b/…)'],
  [/(?:^|[^A-Za-z0-9._/-])~\/[A-Za-z0-9._/-]+/, 'home-relative absolute path (~/…)'],
  [/\b[A-Za-z]:\\[A-Za-z0-9._\\-]+/, 'absolute Windows path (C:\\…)'],
  [/\bfile:\/\//, 'file:// URL (filesystem path)'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/, 'URL with inline credentials (user:pass@host)'],
];
/** The ONE path rule that survives to the publish seam: inline credentials are a credential, not a path. */
const INLINE_CRED_URL = [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/, 'URL with inline credentials (user:pass@host)'];
// Single-line code smells too (not just fenced/multi-line): a one-liner `const x = fetch(…)` or inline SQL
// must not slip through. Kept narrow to spare domain prose — see the should-pass fixtures in the tests.
export const CODE_PATTERNS = [
  [/```/, 'fenced code block (```)'],
  [/[{};]\s*[\r\n]/, 'multi-line code (brace/semicolon + newline)'],
  [/=>/, 'arrow function (=>)'],
  [/===|!==/, 'strict comparison operator (===/!==)'],
  [/\b[A-Za-z_]\w*\([^)]*\)/, 'call-syntax (name(...))'],
  [/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/, 'JS declaration (const/let/var x =)'],
  [/\bimport\s+.+\bfrom\b/, 'ES import statement'],
  [/\bSELECT\b[\s\S]*\bFROM\b/, 'SQL SELECT … FROM'],
  [/\bDELETE\s+FROM\b/, 'SQL DELETE FROM'],
  [/\bINSERT\s+INTO\b/, 'SQL INSERT INTO'],
  [/\bUPDATE\s+\S+\s+SET\b/, 'SQL UPDATE … SET'],
  // Markup: only a tag WITH attributes, or a CLOSING tag — so domain vocabulary like a bare `<select>`,
  // `<dialog>`, `<slot>` still passes (this is a web-components repo; those ARE the content).
  [/<[a-z][\w-]*\s+[^>]*>/i, 'HTML tag with attributes'],
  [/<\/[a-z][\w-]*>/i, 'HTML closing tag'],
];
// PII the downstream product/telemetry seam (#2610) must never carry: author emails, internal IPs.
export const PII_PATTERNS = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, 'email address'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'IPv4 address'],
  [/\b(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{1,4}\b/, 'IPv6 address'],
];
// Source-code file extensions: a filename/path with one is repo-identifying (the ratified "no
// repo-identifying paths"). EXTENSION-based, not slash-based, so `check:standards` / `scope: []` pass.
export const CODE_EXT = /\.(?:ts|tsx|mjs|cjs|js|jsx|py|go|rs|sh|css|scss|less)\b/i;
// Doc/data extensions are repo-identifying only inside a PATH (has a slash) — a bare `AGENTS.md` mention passes.
export const DOC_EXT = /\.(?:md|json|njk|html?|ya?ml)\b/i;
export const REPO_NAMES = /\bweb-?everything\b/i;
// Labeled credential — reject only when the VALUE is secret-shaped, so `the session token: often expires`
// (a plain word value) passes but `password: hunter2Trombone` does not. `matchAll` (global) → each hit.
export const CRED_LABEL = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?key|token|credential)s?\b\s*[:=]\s*(['"]?)([^\s'"]+)\1/gi;

/** Labeled-credential hits whose VALUE is secret-shaped (≥8 chars, ≥2 character classes). */
function credLabelReasons(value) {
  for (const m of value.matchAll(CRED_LABEL)) {
    const v = m[2] || '';
    if (v.length >= 8 && charClasses(v) >= 2) return ['inline credential (secret-shaped value)'];
  }
  return [];
}

/**
 * scrubReasons(value) → string[] of reasons this string value is unsafe to store. Empty ⇒ clean.
 * Pure; the single source the validator + tests share. NOTE: field-LOCAL — it scans one value, so a secret
 * SPLIT across two fields (e.g. the word "password" in `summary` and the value in `suggestion`) cannot be
 * caught here by construction; the length caps + entropy + labeled-value check narrow that gap but the
 * composition limit is inherent to per-field scrubbing (documented; see the split-secret test).
 */
export function scrubReasons(value) {
  if (typeof value !== 'string') return ['not a string'];
  const reasons = [];
  for (const [re, why] of [...SECRET_PATTERNS, ...PATH_PATTERNS, ...CODE_PATTERNS, ...PII_PATTERNS]) {
    if (re.test(value)) reasons.push(why);
  }
  reasons.push(...credLabelReasons(value));
  // Per-token: repo-identifying paths/names + opaque high-entropy secrets.
  for (const tok of value.split(/\s+/)) {
    if (!tok) continue;
    if (tok.includes('../')) reasons.push('relative path traversal (../ — repo-identifying)');
    else if (CODE_EXT.test(tok)) reasons.push('source file path/name (code extension — repo-identifying)');
    else if (DOC_EXT.test(tok) && tok.includes('/')) reasons.push('repo-relative doc path');
    if (REPO_NAMES.test(tok)) reasons.push('repo-identifying name (webeverything)');
    if (isHighEntropyToken(tok)) reasons.push('high-entropy token (opaque key/secret)');
  }
  return [...new Set(reasons)];
}

// ── publish-seam detectors (calibrated; see the header for the measurements) ────────────────────────

/** Prefix/shape rules that carry over verbatim — a credential is a credential wherever it is written. */
const PUBLISH_SECRET_PATTERNS = SECRET_PATTERNS.filter(
  ([, why]) => !why.startsWith('long base64') && !why.startsWith('long hex'),
).concat([INLINE_CRED_URL]);

/** A ≥40-char run over the base64/base64url alphabet. Judged by ENTROPY, not by length alone. */
const BLOB_RUN = /[A-Za-z0-9+/=_-]{40,}/g;
/** Corpus-calibrated: the most random 40-char run in the committed corpus scores 4.55 bits/char. */
const BLOB_ENTROPY_MIN = 4.8;
/** Corpus-calibrated: the least pronounceable ≥20-char identifier in the corpus scores 0.222. */
const TOKEN_VOWEL_MAX = 0.20;

/**
 * isOpaquePublishToken(tok) → true when a single whitespace/slash-delimited segment reads as an opaque
 * secret rather than an identifier. The publish-seam twin of `isHighEntropyToken`, tightened on three axes
 * that measurement showed were pure noise on committed prose:
 *   • `-` is EXCLUDED from the charset — hyphens spell hyphenated prose (`UTF-16-code-unit`) and UUIDs,
 *     both of which cards legitimately carry. Cost: any 20–39 char opaque secret containing a hyphen or a
 *     dot (e.g. a UUIDv4 used as an API key) is invisible to BOTH rules — the blob rule's own ≥40-char floor
 *     means anything shorter than that never reaches it either, so there is no fallback catch here.
 *   • PURE HEX is exempt — a 40-char hex git SHA and a hex session token are indistinguishable by shape,
 *     and SHA citations are recurring, correct backlog content.
 *   • minimum length 20 (not 16) and a vowel-ratio ceiling on BOTH branches — `Tier2VlmJudgeModel` and
 *     `REGISTRY_SCRIPT_TYPE` are real identifiers that the append-seam detector flags.
 */
export function isOpaquePublishToken(tok) {
  if (tok.length < 20 || tok.length > 256) return false;
  if (!/^[A-Za-z0-9+=_]+$/.test(tok)) return false;
  if (/^[0-9a-fA-F]+$/.test(tok)) return false; // git SHA / hash citation — see the header's named gap
  if (shannonEntropy(tok) < 3.0) return false;
  return vowelRatio(tok) < TOKEN_VOWEL_MAX;
}

/** Segments of `value` on whitespace AND `/`, trimmed of surrounding markdown/prose punctuation. */
function publishSegments(value) {
  const out = [];
  for (const raw of value.split(/[\s/]+/)) {
    const t = raw.replace(/^[^A-Za-z0-9+=_]+|[^A-Za-z0-9+=_]+$/g, '');
    if (t) out.push(t);
  }
  return out;
}

/**
 * A personal-mailbox-shaped email. Narrowed past the raw `PII_PATTERNS` regex by three measured exclusions,
 * each of which is a shape that is NOT a mailbox and that the committed corpus legitimately contains:
 *   • a SERVICE account local part (`git@github.com` — the repo's own SSH remote, quoted in cards);
 *   • a domain containing `..` (`date-picker@sha256-Ab3x...9Qk.js` — an elided SRI module id, not a host);
 *   • a single-character local part or first domain label (`a@b.com` — a JSON test-vector placeholder).
 */
const SERVICE_LOCALS = /^(?:git|noreply|no-reply|postmaster|hostmaster|webmaster|mailer-daemon|abuse)$/i;
const EMAIL_RE = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
function emailReasons(value) {
  for (const m of value.matchAll(EMAIL_RE)) {
    const [, local, domain] = m;
    if (SERVICE_LOCALS.test(local)) continue;
    if (domain.includes('..')) continue;
    if (local.length < 2 || (domain.split('.')[0] || '').length < 2) continue;
    return ['email address (personal mailbox)'];
  }
  return [];
}

/**
 * A NON-private IPv4. Loopback / RFC1918 / link-local / broadcast addresses identify nobody and are
 * ordinary technical content (`127.0.0.1:<port>` appears in a card describing a localhost dev bridge).
 */
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
function ipv4Reasons(value) {
  for (const m of value.matchAll(IPV4_RE)) {
    const o = m.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) continue;                                  // a version string, not an address
    if (o[0] === 127 || o[0] === 10 || o[0] === 0 || o[0] === 255) continue;
    if (o[0] === 192 && o[1] === 168) continue;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) continue;
    if (o[0] === 169 && o[1] === 254) continue;
    return ['IPv4 address (public)'];
  }
  return [];
}

/**
 * scrubPublish(value) → string[] of reasons this content is unsafe to COMMIT. Empty ⇒ clean. Same contract
 * as `scrubReasons`; a strictly NARROWER, corpus-calibrated matcher set. Read the file header before
 * widening or relying on it: what it does NOT catch is enumerated there, deliberately.
 */
export function scrubPublish(value) {
  if (typeof value !== 'string') return ['not a string'];
  const reasons = [];
  for (const [re, why] of PUBLISH_SECRET_PATTERNS) {
    if (re.test(value)) reasons.push(why);
  }
  reasons.push(...credLabelReasons(value));
  for (const m of value.matchAll(BLOB_RUN)) {
    if (shannonEntropy(m[0]) >= BLOB_ENTROPY_MIN) { reasons.push('long opaque blob (≥40 chars, secret-level entropy)'); break; }
  }
  // Narrow exemption: only hex metadata on an exact red-team marker line.
  const segmentValue = value.split('\n').map((line) => {
    if (!/^(?!.* ([a-z]+)=.* \1=)<!-- we:red-team-(gate|advisory) pr=\d+ rev=[0-9a-f]{40}( [a-z]+=[0-9a-z,_-]+)* -->$/.test(line)) return line;
    // The leading lookahead rejects any line repeating a key, so each key's hex is unambiguous.
    return line.replace(/( rev=)[0-9a-f]{40}(?= )/, '$1')
      .replace(/( result=)[0-9a-f]{16}(?= )/, '$1')
      .replace(/( grants=)[0-9a-f]+(?:,[0-9a-f]+)*(?= )/, '$1');
  }).join('\n');
  for (const tok of publishSegments(segmentValue)) {
    if (isOpaquePublishToken(tok)) { reasons.push('opaque token (unpronounceable ≥20-char key/secret)'); break; }
  }
  reasons.push(...emailReasons(value));
  reasons.push(...ipv4Reasons(value));
  if (PII_PATTERNS[2][0].test(value)) reasons.push(PII_PATTERNS[2][1]);
  return [...new Set(reasons)];
}
