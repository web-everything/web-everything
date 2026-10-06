/**
 * @file scripts/operations/completion-record.mjs
 * @description THE COMPLETION RECORD — the pure half of the completion store (#3436).
 *
 * WHAT A COMPLETION RECORD IS. `{ v, session, kind, pr, item, status, outcome, verdict, label, runId,
 * startedAt, updatedAt }` — the one structured fact "what did this dispatched review/fix agent conclude",
 * greppable with no `claude logs` call and no ANSI parsing (`we:backlog/3436-*.md`). It mirrors
 * `we:scripts/operations/run-record.mjs`'s own pure-core / io-shell split (the sibling {@link
 * ./completion-store.mjs} is the fs shell) rather than inventing a second on-disk shape for adjacent state.
 *
 * WRITTEN TWICE, ON PURPOSE — `started` THEN `done`. The done-when this file exists to satisfy
 * (`we:backlog/3436-*.md`, criterion 3) requires the record to exist even when the dispatched agent's own
 * work fails partway — a crash, a refused effect. A record written only at the happy-path exit cannot do
 * that: a crash never reaches its own exit. So `we:skills-src/review/review-agent-brief.md` and
 * `we:skills-src/conveyor/fix-agent-brief.md` are instructed to report `status: started` as close to their
 * first action as possible, then update the SAME record to `status: done` at whichever exit they actually
 * reach. A session that crashes between the two leaves a `started` record on disk — not nothing, not a
 * happy-path-only artifact — which is exactly the shape a reader needs to tell "still working" apart from
 * "never dispatched at all".
 *
 * PURE. No fs, no clock (injectable), no process, no network.
 */

/** Schema version stamped on every record. A reader refuses a version it does not know. */
export const COMPLETION_RECORD_VERSION = 1;

/** The two states a record moves through — see the file header. */
export const COMPLETION_STATUSES = Object.freeze(['started', 'done']);

/** The dispatched-agent kinds this record shape serves (`we:backlog/3436-*.md`'s own two briefs, plus
 *  `inspect` — the diagnosis-only stuck-PR inspection agent, epic #3383 — added the same way this file's own
 *  header already anticipated a third kind: no shape change, just one more name in the enum; plus `ci-heal` —
 *  the CI-heal fix agent (`fix-agent-ci-brief.md`) — added #4075/xg7m2wq after a LIVE incident (PR #2724,
 *  2026-09-26) proved a `ci-heal` session that had genuinely finished still counted as a live holder of its PR
 *  forever, because this enum had no entry for it at all and the brief itself never reported completion. No
 *  shape change here either — one more name in the same closed enum). */
export const COMPLETION_KINDS = Object.freeze(['review', 'fix', 'inspect', 'ci-heal']);

/** Session slugs are used as filenames, so the character set is closed — no separators, no traversal. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @param {*} v @returns {boolean} */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Is `session` usable as a completion-record session slug (and therefore as a filename)? */
export function isValidSessionSlug(session) {
  // `.`/`..` need no separate check — SESSION_RE already requires an alphanumeric FIRST character.
  return typeof session === 'string' && SESSION_RE.test(session);
}

/** A short optional string field, or `null`. Anything else is rejected by {@link validateCompletionRecord}. */
function isOptionalString(v) {
  return v === null || v === undefined || typeof v === 'string';
}

/**
 * A fresh, `status: 'started'` completion record. `session` is the dispatcher-minted slug
 * (`review-<pr>` / `fix-<pr>`, per `we:scripts/conveyor/session-reaper.mjs#sessionTarget`'s own grammar) —
 * injected, never derived here, so this file never has to know the naming convention of a THIRD future kind.
 *
 * @param {object} spec
 * @param {string} spec.session
 * @param {'review'|'fix'} spec.kind
 * @param {number|string|null} [spec.pr]
 * @param {number|string|null} [spec.item]
 * @param {string|null} [spec.sessionId] - #4306 (epic #3383/#4075) — the WRITER's own `sessionId` (a
 *   `claude agents --json` UUID), when known. `null` (the default) mints a LEGACY record, byte-identical to
 *   before this field existed — every existing caller that never passes this is unaffected. See this file's
 *   own `validateCompletionRecord` and `we:scripts/conveyor/session-reaper.mjs#planBackstopCompletion` /
 *   `we:scripts/conveyor/reconcile-core.mjs#markSelfReportedDone` for why this exists: "a completion record
 *   only ever speaks for the session that wrote it" (`we:backlog/4306-*.md`).
 * @param {() => string} [spec.now] - injectable clock, ISO-8601 string.
 * @returns {object} a new completion record.
 */
export function newCompletionRecord({
  session, kind, pr = null, item = null, sessionId = null, now = () => new Date().toISOString(),
} = {}) {
  if (!isValidSessionSlug(session)) throw new TypeError(`operations: invalid completion session slug ${JSON.stringify(session)}`);
  if (!COMPLETION_KINDS.includes(kind)) throw new TypeError(`operations: completion record kind must be one of ${COMPLETION_KINDS.join('/')}, got ${JSON.stringify(kind)}`);
  const ts = now();
  return {
    v: COMPLETION_RECORD_VERSION,
    session,
    kind,
    pr: pr === null || pr === undefined ? null : String(pr),
    item: item === null || item === undefined ? null : String(item),
    status: 'started',
    outcome: null,
    verdict: null,
    label: null,
    runId: null,
    sessionId: sessionId === undefined ? null : sessionId,
    startedAt: ts,
    updatedAt: ts,
  };
}

/** Longest `denied` value kept (one line; it is rendered into a PR comment by the reconcile note path). */
export const DENIED_MAX_LENGTH = 200;
/** Input bound applied before any regex runs (the final cap is {@link DENIED_MAX_LENGTH}). */
const DENIED_SCAN_LIMIT = 2000;
/**
 * One secret VALUE as it can appear in a shell command: a double-quoted or single-quoted string (the closing quote
 * is optional so a truncated/unterminated command still redacts to its end) or a bare run. The earlier bare-only
 * `[^\s"']+` could not match a value that STARTS with a quote, so `--token="x"` / `K='x'` / `--password "x"` kept
 * the secret (PR #3990 review). A backslash escapes the next character in all three forms, so an escaped quote
 * (`--password="a\"b"`) does not end the value early and leave its tail visible (round 4). Every alternative
 * starts on a different character, so matching never backtracks; the input is also bounded by
 * {@link DENIED_SCAN_LIMIT}.
 *
 * A shell WORD is a concatenation of such segments (`--password="pre"'mid'tail` is ONE argument), so the value is
 * one-or-more segments back to back, up to the next unquoted whitespace (round 6). The bare segment is a SINGLE
 * character (or backslash pair) under the outer `+`, never a nested `(?:…+)+` run, so every position has exactly
 * one way to match and the scan stays linear.
 */
const SECRET_VALUE = `(?:"(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\\\\.|[^\\s"'\\\\])+`;

/**
 * we:scripts/operations/completion-record.mjs#sanitizeDeniedCommand — `denied` is agent-supplied free text (a
 * fixer that read untrusted PR content echoes the command it was refused) that the reconciler later interpolates
 * into a bot-authored PR comment (PR #3990 review). So it is made safe at the single write point AND again where
 * the note is built: ONE line, capped at {@link DENIED_MAX_LENGTH}, HTML-comment delimiters and backticks removed
 * (so it cannot forge a `conveyor-note-key` marker or break out of a code fence), token-like substrings redacted,
 * `@mentions` defanged. Pure; a non-string yields `null`.
 * @param {*} value
 * @returns {string|null}
 */
export function sanitizeDeniedCommand(value) {
  if (typeof value !== 'string') return null;
  // Bound the input BEFORE any regex: the redaction patterns are quadratic on pathological runs of `-`.
  let s = value.slice(0, DENIED_SCAN_LIMIT).replace(/\s+/g, ' ').trim();
  s = s
    .replace(/\/\/[^\s/@:"']+:[^\s/@"']+@/g, '//[redacted]@')
    .replace(new RegExp(`\\b(password|passwd|secret|token)\\s*:\\s*${SECRET_VALUE}`, 'gi'), '$1: [redacted]')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, '[redacted]')
    .replace(/\b(?:sk|xox[abprs]|AKIA)[-A-Za-z0-9_]{12,}/g, '[redacted]')
    .replace(new RegExp(`\\b(Bearer|token|Basic)\\s+${SECRET_VALUE}`, 'gi'), '$1 [redacted]')
    .replace(new RegExp(`(--?[\\w-]*(?:token|secret|password|passwd|api[-_]?key|authorization)[\\w-]*[= ])${SECRET_VALUE}`, 'gi'), '$1[redacted]')
    .replace(new RegExp(`\\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY)[A-Za-z0-9_]*=)${SECRET_VALUE}`, 'gi'), '$1[redacted]')
    // `Name: value` headers and JSON-ish `"name":"value"` fields: `X-Api-Key: v`, `Authorization: v`, `"token":"v"`.
    // Runs AFTER the Bearer/token/Basic pass so an already-redacted scheme word is consumed with its value.
    .replace(
      new RegExp(`\\b([\\w-]*(?:token|secret|password|passwd|api[-_]?key|auth(?:orization)?)[\\w-]*\\\\?["']?\\s*:\\s*\\\\?["']?)(?:(?:Bearer|Basic|token)\\s+)?${SECRET_VALUE}`, 'gi'),
      '$1[redacted]',
    );
  // Replace (never delete) the delimiters: deleting can splice a NEW `<!--` together (`<!<!----` → `<!--`).
  s = s.replace(/<!--|--!?>|`/g, ' ').replace(/@(?=[\w-])/g, '@\u200b').replace(/\s+/g, ' ').trim();
  if (/<!--|--!?>/.test(s)) s = s.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > DENIED_MAX_LENGTH) s = `${s.slice(0, DENIED_MAX_LENGTH - 1)}…`;
  return s;
}

/**
 * PURE merge of a `patch` onto an existing record — bumps `updatedAt`, never touches `session`/`kind`/`pr`/
 * `item`/`startedAt`/`v`. Used by the io shell's "report done" path so a caller need only name what changed.
 * @param {object} record
 * @param {{status?:string, outcome?:string|null, verdict?:string|null, label?:string|null, runId?:string|null, sessionId?:string|null, denied?:string|null}} patch
 * @param {() => string} [now]
 * @returns {object}
 */
export function applyCompletionUpdate(record, patch = {}, now = () => new Date().toISOString()) {
  const next = { ...record, updatedAt: now() };
  for (const key of ['status', 'outcome', 'verdict', 'label', 'runId', 'sessionId', 'denied']) {
    if (Object.hasOwn(patch, key)) next[key] = key === 'denied' && patch[key] != null ? sanitizeDeniedCommand(patch[key]) : patch[key];
  }
  return next;
}

/**
 * Validate a completion record's SHAPE. Returns every problem found, not just the first (mirrors
 * `we:scripts/operations/run-record.mjs#validateRunRecord`).
 * @param {*} record
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateCompletionRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { ok: false, errors: ['completion record must be an object'] };
  if (record.v !== COMPLETION_RECORD_VERSION) errors.push(`unsupported completion record version ${JSON.stringify(record.v)}`);
  if (!isValidSessionSlug(record.session)) errors.push('missing or invalid `session`');
  if (!COMPLETION_KINDS.includes(record.kind)) errors.push(`\`kind\` must be one of ${COMPLETION_KINDS.join('/')}`);
  if (!isOptionalString(record.pr)) errors.push('`pr` must be a string or null');
  if (!isOptionalString(record.item)) errors.push('`item` must be a string or null');
  if (!COMPLETION_STATUSES.includes(record.status)) errors.push(`\`status\` must be one of ${COMPLETION_STATUSES.join('/')}`);
  for (const key of ['outcome', 'verdict', 'label', 'runId', 'sessionId', 'denied']) {
    if (!isOptionalString(record[key])) errors.push(`\`${key}\` must be a string or null`);
  }
  if (typeof record.startedAt !== 'string' || Number.isNaN(Date.parse(record.startedAt))) errors.push('missing or unparseable `startedAt`');
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) errors.push('missing or unparseable `updatedAt`');
  return { ok: errors.length === 0, errors };
}

/**
 * we:scripts/operations/completion-record.mjs#isForeignCompletionSessionId — #4306 (independent panel review,
 * correctness lens): THE ONE shared predicate every reader of a completion record's `sessionId` binds through,
 * so `reconcile-core.mjs#markSelfReportedDone`, `session-reaper.mjs#makeCompletionResolver` and
 * `session-verdicts.mjs#finishedEvidence` can never silently diverge on what "foreign" means — the exact gap
 * the review found: two of the three readers only flagged a record foreign when BOTH sides carried a
 * `sessionId`, so a row reaching them with no `sessionId` of its own (unknown, not "no session identity by
 * design") would still accept a DIFFERENT session's record as its own, reopening this card's own headline hole
 * behind a narrower precondition.
 *
 * A record speaks for `rowSessionId` UNLESS `recordSessionId` is set and differs from it. The row itself
 * having no id (`rowSessionId == null`) is never treated as an excuse to accept a record that names someone
 * else — only a record with NO id at all (`recordSessionId == null`, genuinely legacy or written by a caller
 * with no session identity) is unconditionally legacy-compatible, per every reader's own existing rule for
 * that case.
 * @param {string|null|undefined} rowSessionId
 * @param {string|null|undefined} recordSessionId
 * @returns {boolean}
 */
export function isForeignCompletionSessionId(rowSessionId, recordSessionId) {
  return recordSessionId != null && recordSessionId !== (rowSessionId ?? null);
}

/** Throws (carrying every error) unless `record` validates. @param {*} record @param {string} [label] */
export function assertCompletionRecord(record, label = 'completion record') {
  const { ok, errors } = validateCompletionRecord(record);
  if (!ok) throw new Error(`operations: ${label} is invalid — ${errors.join('; ')}`);
}

/** `JSON.stringify` with a trailing newline — the on-disk form. */
export function serializeCompletionRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Parse on-disk text into a completion record. Never throws — a corrupt/empty/wrong-shape file is reported
 * as `{ok:false, corrupt:true, reason}`, mirroring `we:scripts/operations/run-record.mjs#parseRunRecord`'s
 * own refuse-don't-silently-drop discipline (a completion record's whole purpose is to be read back, so a
 * torn file must never be mistaken for "nothing was ever reported").
 * @param {string} text
 * @returns {{ok:true, record:object}|{ok:false, corrupt:true, reason:string}}
 */
export function parseCompletionRecord(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, corrupt: true, reason: 'completion record is empty' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, corrupt: true, reason: `completion record is not parseable JSON — ${String(e?.message || e)}` };
  }
  const { ok, errors } = validateCompletionRecord(parsed);
  if (!ok) return { ok: false, corrupt: true, reason: errors.join('; ') };
  return { ok: true, record: parsed };
}
