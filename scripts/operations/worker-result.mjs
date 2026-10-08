/**
 * @file scripts/operations/worker-result.mjs
 * @description `we.worker-result` v1 — the pure validator, the legacy outcome mapper and the D1 reroute guard
 * (item 117, slice S1; spec `prepare-117.md` sections 3-5, decisions D1/D4/D8 settled 2026-10-08).
 *
 * WHAT THIS IS. Every dispatched worker ends with ONE JSON object shaped by `we:schemas/worker-result.v1.json`
 * (one base schema for every role, D4). This module is the READER of that object: it checks the shape, then the
 * checks a JSON schema cannot express, then hands back either the cleaned result or a `contract-violation`
 * (fail closed, section 5: `ok:false` here, then the caller builds {@link unparseableOutcome}). Nothing here routes on prose: `summary` and `evidence.text` are for humans only.
 *
 * FREE TEXT. Only `blocker.deniedCommand` and the `unparseable` prose tail are redacted here (through
 * `sanitizeDeniedCommand`). `summary`, `evidence.text`, `evidence.refs` and the ruling text are stored as data after
 * the length caps; the envelope writer (S2) owns redacting them at the single write point, and nothing may route on them.
 *
 * WHAT IT DOES NOT DO. It spawns nothing and reads no launcher output (the launcher slices S3-S5 do), writes no
 * envelope (S2: completion record v2 and the action router) and switches no launcher. PURE: no fs after the
 * schema file is read once at import, no clock, no process, no network.
 *
 * THE FOUR THINGS EXPORTED:
 *  - {@link validateWorkerResult} — shape (a small JSON-schema interpreter over the checked-in schema file, so the
 *    file is the single source and cannot drift from the code) + length caps + the reader checks.
 *  - {@link mapLegacyOutcome} — TOTAL mapping from today's 20+ free outcome words (completion records, delivery
 *    reports, fix reports, ci-heal marks) to `{outcome, kind}` in the section-4 vocabulary.
 *  - {@link guardBlockerKind} — the D1 deterministic reroute: a `needs-ruling` that names code paths, or whose
 *    options are only "fix X / don't", is a product bug, so it becomes `tooling-defect` and never reaches the operator.
 *  - {@link unparseableOutcome} / {@link abortedOutcome} — the envelope-only outcomes (D6): a reaper or timeout
 *    kill is `contract-violation`, an operator stop is `aborted` (no product-fix job).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeDeniedCommand } from './completion-record.mjs';

/** The single schema file (D4). Read once; frozen. */
export const WORKER_RESULT_SCHEMA = Object.freeze(
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas', 'worker-result.v1.json'), 'utf8')));

export const WORKER_RESULT_VERSION = 1;

/** Blocker kinds a WORKER may declare (section 4, minus the launcher-only `contract-violation`). */
export const BLOCKER_KINDS = Object.freeze([...WORKER_RESULT_SCHEMA.properties.blocker.properties.kind.enum]);
/** The launcher-only kind (section 5). A worker may never claim it. */
export const CONTRACT_VIOLATION_KIND = 'contract-violation';

/** Reader-enforced length caps (kept out of the schema: OpenAI strict mode is narrower than draft-07). */
export const CAPS = Object.freeze({
  summary: 280, component: 120, evidenceText: 2000, evidenceRefs: 50, ref: 300, proposedFixSummary: 400, scope: 50,
  question: 600, option: 400, recommendation: 600, deniedCommand: 400, findingNote: 300, findings: 200,
  filesTouched: 500, learningSummary: 600, learningArea: 200, learningSuggestion: 600,
});

/** Roles the role rules apply to. Other roles (review, inspect, prepare, investigate) have no extra rule. */
export const ROLES = Object.freeze(['review', 'fix', 'ci-heal', 'inspect', 'build', 'prepare', 'investigate']);

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

/**
 * A minimal draft-07 interpreter covering exactly the keywords the schema uses (`type` incl. arrays, `enum`,
 * `required`, `properties`, `additionalProperties:false`, `items`). Returns problems as `path: message`.
 * Exported for the strict-mode test and so S3-S5 launchers can pre-check output without a second validator.
 */
export function validateAgainstSchema(schema, value, path = '$') {
  const problems = [];
  const types = [].concat(schema.type ?? []);
  const t = typeOf(value);
  if (types.length && !types.includes(t) && !(t === 'integer' && types.includes('number'))) {
    return [`${path}: expected ${types.join('|')}, got ${t}`];
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) problems.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  if (t === 'object' && isPlain(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) problems.push(`${path}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(props, key)) problems.push(...validateAgainstSchema(props[key], value[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: unexpected key`);
    }
  } else if (t === 'array' && schema.items) {
    value.forEach((item, i) => problems.push(...validateAgainstSchema(schema.items, item, `${path}[${i}]`)));
  }
  return problems;
}

/**
 * Strict-mode lint of a schema (OpenAI rules the three CLIs share): every object schema has
 * `additionalProperties:false` and `required` equal to ALL its property keys. Returns problems; [] = strict.
 */
export function strictModeProblems(schema, path = '$') {
  const problems = [];
  const types = [].concat(schema.type ?? []);
  if (types.includes('object')) {
    const keys = Object.keys(schema.properties ?? {}).sort();
    const required = [...(schema.required ?? [])].sort();
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    if (JSON.stringify(keys) !== JSON.stringify(required)) problems.push(`${path}: required must list every property (${keys.join(',')})`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) problems.push(...strictModeProblems(sub, `${path}.${k}`));
  }
  if (schema.items) problems.push(...strictModeProblems(schema.items, `${path}[]`));
  return problems;
}

function overCap(problems, label, value, cap) {
  if (typeof value === 'string' && value.length > cap) problems.push(`${label}: ${value.length} chars exceeds ${cap}`);
}
function overCount(problems, label, arr, cap) {
  if (Array.isArray(arr) && arr.length > cap) problems.push(`${label}: ${arr.length} items exceeds ${cap}`);
}

/**
 * Validate a parsed worker result. `role` enables the role rules (fix: `done` needs >=1 `fixed` finding;
 * build: `done` needs `filesTouched`). A failed check means the caller must treat the result as UNPARSEABLE
 * (section 5): this function never repairs a result, except that `blocker.deniedCommand` is passed through
 * {@link sanitizeDeniedCommand} on the returned copy.
 * @param {*} value
 * @param {{role?: string}} [opts]
 * @returns {{ok: true, result: object, problems: []} | {ok: false, result: null, problems: string[]}}
 */
export function validateWorkerResult(value, { role } = {}) {
  if (!isPlain(value)) return { ok: false, result: null, problems: ['$: expected an object'] };
  if (value.v !== undefined && value.v !== WORKER_RESULT_VERSION) {
    return { ok: false, result: null, problems: [`$.v: unknown version ${JSON.stringify(value.v)} (this reader knows ${WORKER_RESULT_VERSION})`] };
  }
  const problems = validateAgainstSchema(WORKER_RESULT_SCHEMA, value);
  if (problems.length) return { ok: false, result: null, problems };

  const r = value;
  // Fail closed on a role we do not know: the role rules below would otherwise silently not run.
  if (role !== undefined && !ROLES.includes(role)) problems.push(`role: unknown role ${JSON.stringify(role)} (known: ${ROLES.join(', ')})`);
  overCap(problems, 'summary', r.summary, CAPS.summary);
  overCount(problems, 'findingsAddressed', r.findingsAddressed, CAPS.findings);
  overCount(problems, 'filesTouched', r.filesTouched, CAPS.filesTouched);
  r.findingsAddressed.forEach((f, i) => {
    overCap(problems, `findingsAddressed[${i}].note`, f.note, CAPS.findingNote);
    if (!f.ref.trim() || f.ref.length > CAPS.ref) problems.push(`findingsAddressed[${i}].ref: must be a non-empty finding id (D8: the stable id the review renderer prints; opaque here, max ${CAPS.ref} chars)`);
  });
  r.filesTouched.forEach((p, i) => { if (!p.trim() || p.startsWith('/') || p.split('/').includes('..')) problems.push(`filesTouched[${i}]: must be a repo-relative path`); });
  if (r.learning) {
    overCap(problems, 'learning.summary', r.learning.summary, CAPS.learningSummary);
    overCap(problems, 'learning.area', r.learning.area, CAPS.learningArea);
    overCap(problems, 'learning.suggestion', r.learning.suggestion, CAPS.learningSuggestion);
  }

  // blocked <=> blocker non-null
  if (r.outcome === 'blocked' && r.blocker === null) problems.push('blocker: required when outcome is blocked');
  if (r.outcome !== 'blocked' && r.blocker !== null) problems.push('blocker: must be null unless outcome is blocked');

  const b = r.blocker;
  if (b) {
    overCap(problems, 'blocker.component', b.component, CAPS.component);
    if (!b.component.trim()) problems.push('blocker.component: required (a short stable name of the broken thing)');
    overCap(problems, 'blocker.evidence.text', b.evidence.text, CAPS.evidenceText);
    overCount(problems, 'blocker.evidence.refs', b.evidence.refs, CAPS.evidenceRefs);
    if (!b.evidence.text.trim()) problems.push('blocker.evidence.text: required');
    if (b.proposedFix) {
      overCap(problems, 'blocker.proposedFix.summary', b.proposedFix.summary, CAPS.proposedFixSummary);
      overCount(problems, 'blocker.proposedFix.scope', b.proposedFix.scope, CAPS.scope);
    }
    // needs-ruling <=> ruling with >=2 options
    if (b.kind === 'needs-ruling') {
      if (!b.ruling) problems.push('blocker.ruling: required when kind is needs-ruling');
      else if (b.ruling.options.length < 2) problems.push('blocker.ruling.options: needs at least 2 options');
    } else if (b.ruling !== null) problems.push('blocker.ruling: must be null unless kind is needs-ruling');
    if (b.ruling) {
      overCap(problems, 'blocker.ruling.question', b.ruling.question, CAPS.question);
      overCap(problems, 'blocker.ruling.recommendation', b.ruling.recommendation, CAPS.recommendation);
      b.ruling.options.forEach((o, i) => overCap(problems, `blocker.ruling.options[${i}]`, o, CAPS.option));
    }
    if (b.deniedCommand !== null) {
      if (b.kind !== 'permission-wall') problems.push('blocker.deniedCommand: only valid when kind is permission-wall');
      overCap(problems, 'blocker.deniedCommand', b.deniedCommand, CAPS.deniedCommand);
    }
  }

  // role rules
  if (role === 'fix' && r.outcome === 'done' && !r.findingsAddressed.some((f) => f.disposition === 'fixed')) {
    problems.push('findingsAddressed: a fix that is done needs at least one fixed finding');
  }
  if (role === 'build' && r.outcome === 'done' && r.filesTouched.length === 0) {
    problems.push('filesTouched: a build that is done needs at least one file');
  }

  if (problems.length) return { ok: false, result: null, problems };
  const result = structuredClone(r);
  if (result.blocker?.deniedCommand != null) result.blocker.deniedCommand = sanitizeDeniedCommand(result.blocker.deniedCommand);
  return { ok: true, result, problems: [] };
}

/** Parse launcher text as JSON and validate it in one step (fail closed on bad JSON). */
export function parseWorkerResult(text, opts) {
  let value;
  try { value = JSON.parse(text); } catch (e) { return { ok: false, result: null, problems: [`$: not valid JSON (${e.message})`] }; }
  return validateWorkerResult(value, opts);
}

// ── Legacy outcome words → section-4 vocabulary ─────────────────────────────────────────────────────────────────

/**
 * Every outcome word the briefs and stores use today. `outcome` is the worker-result outcome; `kind` is the blocker
 * kind when that outcome is `blocked`. `retryable` seeds `blocker.retryable` for a mapped legacy record.
 * `blocked` alone is context-dependent (delivery report): see {@link mapLegacyOutcome}.
 */
export const LEGACY_OUTCOME_MAP = Object.freeze({
  // completion record: success shapes
  healed: { outcome: 'done', kind: null },
  done: { outcome: 'done', kind: null },
  fixed: { outcome: 'done', kind: null },
  pushed: { outcome: 'done', kind: null },
  diagnosed: { outcome: 'done', kind: null },
  're-armed': { outcome: 'done', kind: null },
  'no-change': { outcome: 'no-change', kind: null },
  'not-applicable': { outcome: 'not-applicable', kind: null },
  'not-a-ci-break': { outcome: 'not-applicable', kind: null },
  // blocked shapes → section-4 kinds
  'blocked-on-infra': { outcome: 'blocked', kind: 'infra-transient', retryable: true },
  'blocked-on-load-flake': { outcome: 'blocked', kind: 'host-load', retryable: true },
  'blocked-on-permission': { outcome: 'blocked', kind: 'permission-wall', retryable: true },
  'waiting-on-system-fix': { outcome: 'blocked', kind: 'tooling-defect', retryable: false },
  'escalated-rearm-refused': { outcome: 'blocked', kind: 'tooling-defect', retryable: false },
  're-blocked': { outcome: 'blocked', kind: 'dependency', retryable: false },
  'escalated-conflict': { outcome: 'blocked', kind: 'conflict', retryable: false },
  'gate-red': { outcome: 'blocked', kind: 'gate-red', retryable: true },
  'escalated-needs-judgment': { outcome: 'blocked', kind: 'needs-ruling', retryable: false },
  'escalated-needs-human': { outcome: 'blocked', kind: 'needs-ruling', retryable: false },
  'needs-human': { outcome: 'blocked', kind: 'needs-ruling', retryable: false },
  'needs-human-judgment': { outcome: 'blocked', kind: 'needs-ruling', retryable: false },
});

/** A bare `blocked` (delivery report / fix report): no files touched = the card was not ready; files touched = the gate. */
const BLOCKED_NO_FILES = Object.freeze({ outcome: 'blocked', kind: 'spec-defect', retryable: false });
const BLOCKED_WITH_FILES = Object.freeze({ outcome: 'blocked', kind: 'gate-red', retryable: true });

/**
 * Map ONE legacy outcome word to `{outcome, kind, retryable}`. TOTAL over every word the briefs and the three
 * stores use: an unknown word returns `null` (the caller then treats the record as unparseable, section 5, never as
 * success), and a missing word / `unreported` is the launcher's contract-violation, not a mapping.
 * @param {string} word
 * @param {{filesTouched?: string[]}} [ctx] only used to split a bare `blocked`.
 * @returns {{outcome: string, kind: string|null, retryable: boolean}|null}
 */
export function mapLegacyOutcome(word, { filesTouched = [] } = {}) {
  if (typeof word !== 'string') return null;
  const key = word.trim().toLowerCase();
  if (key === 'blocked') {
    const m = filesTouched.length ? BLOCKED_WITH_FILES : BLOCKED_NO_FILES;
    return { outcome: m.outcome, kind: m.kind, retryable: m.retryable };
  }
  const m = Object.hasOwn(LEGACY_OUTCOME_MAP, key) ? LEGACY_OUTCOME_MAP[key] : null;
  return m ? { outcome: m.outcome, kind: m.kind, retryable: m.retryable ?? false } : null;
}

// ── D1: deterministic reroute guard ─────────────────────────────────────────────────────────────────────────────

/** A path in `proposedFix.scope` that names code or tooling (a `we:`/`fui:` locus prefix is stripped first). */
const CODE_PATH_RE = /^(?:[a-z]+:)?(?:\.\/)?(?:scripts|skills-src|\.claude|\.github|hooks|tools|src|blocks|contracts|schemas|server|workers?|lib)\/|\.(?:mjs|cjs|js|jsx|ts|tsx|json|ya?ml|sh)$/i;
/** An option that is just "fix it" or "don't fix it": the question was never a taste call. */
const FIX_OPTION_RE = /^(?:[a-z][).:]\s*|option\s+[a-z][).:]?\s*)?(?:fix|patch|repair)\b/i;
const NOOP_OPTION_RE = /^(?:[a-z][).:]\s*|option\s+[a-z][).:]?\s*)?(?:(?:do\s+not|don'?t)\s+(?:fix|change|touch)|leave\b|skip\b|ignore\b|no\s+(?:fix|change)\b|defer\b)/i;

/**
 * D1 (settled 2026-10-08): the worker proposes the kind; this guard reroutes the one misroute the fix-4228 case
 * proved: a product bug called a "decision". A `needs-ruling` is rerouted to `tooling-defect` when EITHER
 *   (a) `proposedFix.scope` names code paths, OR
 *   (b) its options are only "fix X" / "don't fix X" (at least one fix option, every option fix-or-noop).
 * A ruling survives only as a genuine taste call. Deterministic, no model. Input must be a VALID result (run
 * {@link validateWorkerResult} first). Returns the possibly-rerouted copy and the reroute record for the coroner.
 * @returns {{result: object, reroute: null | {from: 'needs-ruling', to: 'tooling-defect', reason: string}}}
 */
export function guardBlockerKind(result) {
  const b = result?.blocker;
  if (!b || b.kind !== 'needs-ruling') return { result, reroute: null };
  const codePaths = (b.proposedFix?.scope ?? []).filter((p) => CODE_PATH_RE.test(String(p).trim()));
  const options = (b.ruling?.options ?? []).map((o) => String(o).trim());
  const fixOnly = options.length >= 2 && options.some((o) => FIX_OPTION_RE.test(o))
    && options.every((o) => FIX_OPTION_RE.test(o) || NOOP_OPTION_RE.test(o));
  let reason = null;
  if (codePaths.length) reason = `proposedFix.scope names code paths (${codePaths.slice(0, 3).join(', ')})`;
  else if (fixOnly) reason = 'ruling options are only fix / do-not-fix';
  if (!reason) return { result, reroute: null };
  const next = structuredClone(result);
  next.blocker.kind = 'tooling-defect';
  next.blocker.ruling = null;
  return { result: next, reroute: { from: 'needs-ruling', to: 'tooling-defect', reason } };
}

// ── Envelope-only outcomes (section 5, D6) ──────────────────────────────────────────────────────────────────────

/** Why a launcher could not produce a valid result. `reaper-kill` / `timeout` are contract violations (D6). */
export const UNPARSEABLE_REASONS = Object.freeze([
  'no-structured-output', 'structured-output-retries-exhausted', 'invalid-json', 'schema-violation', 'reader-check-failed',
  'ended-without-result', 'timeout', 'reaper-kill', 'agy-key-absent', 'unreported',
]);

/** Last <=500 chars of prose, then redacted and capped by {@link sanitizeDeniedCommand} (one line, token-like text
 *  removed, at most DENIED_MAX_LENGTH chars): kept as evidence, never routed. */
function proseTail(prose) {
  return typeof prose === 'string' ? (sanitizeDeniedCommand(prose.slice(-500)) ?? '') : '';
}

/**
 * The fail-closed envelope result (section 5): `outcome:'unparseable'`, blocker kind `contract-violation`. The
 * returned `result` is NOT a valid worker result (that is the point: `outcome` is envelope-only); the item is
 * treated as blocked, never success, and the product-fix job dedupes on `signature`.
 */
export function unparseableOutcome({ role, launcher, reason, transcriptPath = null, prose = '', problems = [] }) {
  const why = UNPARSEABLE_REASONS.includes(reason) ? reason : 'schema-violation';
  const text = [`reason: ${why}`, problems.length ? `problems: ${problems.slice(0, 5).join('; ')}` : '', transcriptPath ? `transcript: ${transcriptPath}` : '',
    proseTail(prose) ? `last prose: ${proseTail(prose)}` : ''].filter(Boolean).join('\n').slice(0, CAPS.evidenceText);
  return {
    outcome: 'unparseable',
    blocker: { kind: CONTRACT_VIOLATION_KIND, component: `${launcher || 'unknown-launcher'} worker-result contract`, evidence: { text, refs: transcriptPath ? [transcriptPath] : [] },
      proposedFix: null, ruling: null, deniedCommand: null, retryable: false },
    signature: `${role || 'unknown-role'}|${launcher || 'unknown-launcher'}|${why}`,
  };
}

/** An operator `claude stop` (D6): recorded, never a product-fix job. */
export function abortedOutcome({ role, launcher }) {
  return { outcome: 'aborted', blocker: null, signature: null, role: role || null, launcher: launcher || null };
}
