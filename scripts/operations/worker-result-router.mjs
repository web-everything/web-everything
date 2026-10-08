/**
 * @file scripts/operations/worker-result-router.mjs
 * @description The reader half of the worker contract's envelope and the ACTION ROUTER (item 117, slice S2;
 * decisions D1, D2, D3, D6 settled 2026-10-08; spec `prepare-117.md` sections 4, 5, 7).
 *
 * THREE JOBS, ALL PURE (the draft sink at the bottom is the one io function, and it takes its directory):
 *  1. {@link settleWorkerResult} — launcher output text -> the envelope's `{result, parse, reroute}`. Valid output
 *     is run through the D1 reroute guard; anything else fails closed to the `unparseable` / `contract-violation`
 *     outcome of S1 (never success).
 *  2. {@link routeWorkerResult} — `blocker.kind` -> the daemon ACTION (section 4 table). The only route to the
 *     operator is `needs-ruling`. `tooling-defect`, `permission-wall` and `contract-violation` make a draft card in
 *     the shared 114 drafts store, governed by `postmortem.mode` (D3). Prose is never read.
 *  3. {@link envelopeFromLegacy} — folds the three old stores (completion v1, delivery-report, fix-report) into the
 *     v2 envelope shape (D2), so every reader sees one shape and the coroner/114 read one place.
 *
 * {@link legacyOutcomeWord} is the way back: the v2 record still carries the old free outcome word so the readers
 * that have not migrated yet (`markSelfReportedDone`, the session reaper) keep working unchanged.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { COMPLETION_RECORD_V2, ENVELOPE_ROLES, ENVELOPE_SOURCES, redactFreeText, sanitizeDeniedCommand } from './completion-record.mjs';
import {
  BLOCKER_KINDS, CONTRACT_VIOLATION_KIND, abortedOutcome, guardBlockerKind, mapLegacyOutcome, parseWorkerResult, unparseableOutcome,
  validateWorkerResult,
} from './worker-result.mjs';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';

/**
 * The envelope writer's redaction pass: EVERY free-text field in the schema (S1 stored them as data after the length
 * caps; the card makes the envelope writer own redaction at the single write point). One line each, token-like text
 * removed, HTML comment delimiters and backticks gone, @mentions defanged. Returns a copy; nothing routes on it.
 * `deniedCommand` was already redacted by the S1 reader; it goes through the same pass again here.
 */
export function redactResultText(result) {
  const r = structuredClone(result);
  const clean = redactFreeText;
  r.summary = clean(r.summary, 280);
  r.findingsAddressed = (r.findingsAddressed ?? []).map((f) => ({ ...f, ref: clean(f.ref, 300), note: clean(f.note, 300) }));
  r.filesTouched = (r.filesTouched ?? []).map((x) => clean(x, 300));
  if (r.learning) r.learning = { ...r.learning, summary: clean(r.learning.summary, 600), area: clean(r.learning.area, 200), suggestion: clean(r.learning.suggestion, 600) };
  if (r.blocker) {
    const b = r.blocker;
    b.component = clean(b.component, 120);
    b.evidence = { text: clean(b.evidence.text, 2000), refs: b.evidence.refs.map((x) => clean(x, 300)) };
    if (b.proposedFix) b.proposedFix = { ...b.proposedFix, summary: clean(b.proposedFix.summary, 400), scope: b.proposedFix.scope.map((x) => clean(x, 300)) };
    if (b.ruling) b.ruling = { question: clean(b.ruling.question, 600), options: b.ruling.options.map((o) => clean(o, 400)), recommendation: clean(b.ruling.recommendation, 600) };
    if (b.deniedCommand != null) b.deniedCommand = sanitizeDeniedCommand(b.deniedCommand);
  }
  return r;
}

// ── 1. launcher output -> envelope result ───────────────────────────────────────────────────────────────────────

/**
 * Settle ONE launcher output into the envelope's result. `input.value` (already-parsed JSON, e.g. claude's
 * `structured_output`) or `input.text` (a Codex `-o` file) is validated; a missing / bad one is the unparseable
 * outcome. An operator stop is `aborted` (D6): recorded, no job. Never throws.
 * @param {{role: string, launcher: string, value?: *, text?: string, reason?: string, aborted?: boolean, transcriptPath?: string|null, prose?: string}} input
 * @returns {{result: object, parse: {ok: boolean, reason: string|null}, reroute: object|null}}
 */
export function settleWorkerResult({ role, launcher, value, text, reason, aborted = false, transcriptPath = null, prose = '' }) {
  if (aborted) return { result: abortedOutcome({ role, launcher }), parse: { ok: false, reason: 'aborted' }, reroute: null };
  const missing = value === undefined && (typeof text !== 'string' || text.trim() === '');
  if (missing) {
    return {
      result: unparseableOutcome({ role, launcher, reason: reason || 'no-structured-output', transcriptPath, prose }),
      parse: { ok: false, reason: reason || 'no-structured-output' }, reroute: null,
    };
  }
  const checked = value !== undefined ? validateWorkerResult(value, { role }) : parseWorkerResult(text, { role });
  if (!checked.ok) {
    const why = value === undefined && checked.problems?.[0]?.includes('not valid JSON') ? 'invalid-json' : 'schema-violation';
    return {
      result: unparseableOutcome({ role, launcher, reason: why, transcriptPath, prose, problems: checked.problems }),
      parse: { ok: false, reason: why }, reroute: null,
    };
  }
  const { result: guarded, reroute } = guardBlockerKind(redactResultText(checked.result));
  return { result: guarded, parse: { ok: true, reason: null }, reroute };
}

// ── 2. blocker.kind -> action ───────────────────────────────────────────────────────────────────────────────────

/** The operator's operations directory (114: `~/workspace/.operations`). `WE_OPERATIONS_DIR` overrides it. */
export function defaultOperationsDir(env = process.env) {
  return env.WE_OPERATIONS_DIR && env.WE_OPERATIONS_DIR.trim() ? env.WE_OPERATIONS_DIR.trim() : join(homedir(), 'workspace', '.operations');
}
/** The shared 114 drafts store: `<operations>/drafts` (one `cards/<signatureKey>.json` per signature; 117 S6 shares it). */
export function defaultDraftsDir(env = process.env) {
  return join(defaultOperationsDir(env), 'drafts');
}

/** Where a product-fix draft goes. D3: a draft in the shared 114 store, under `postmortem.mode`. */
export const POSTMORTEM_MODES = Object.freeze(['off', 'draft', 'file']);
/** Blocker kinds that make a product-fix draft (D3). `infra-transient` joins them only past its cap. */
export const DRAFT_KINDS = Object.freeze(['tooling-defect', 'permission-wall', CONTRACT_VIOLATION_KIND]);
/** Every action type the router can return. */
export const ACTION_TYPES = Object.freeze([
  'done', 'no-change', 'not-applicable', 'aborted', 'retry-after-cooloff', 'quiet-host-reverify', 'product-fix-draft',
  're-prepare', 'hold-until-ref', 'resolve-conflict', 'redispatch-with-output', 'operator',
]);

/** Stable draft key for a signature: one file per signature, one dedupe key for 117 and 114 (D3). */
export function draftKeyFor(signature) {
  return createHash('sha1').update(String(signature)).digest('hex').slice(0, 16);
}

/** The signature a blocker dedupes on. `kind|component` (117 section 7); the launcher's `role|launcher|reason` for a contract violation. */
export function blockerSignature(result) {
  if (!result) return null;
  if (typeof result.signature === 'string' && result.signature) return result.signature;
  const b = result.blocker;
  return b ? `${b.kind}|${b.component}` : null;
}

function draftAction(result, ctx, kind, extra = {}) {
  const b = result.blocker;
  const mode = POSTMORTEM_MODES.includes(ctx.postmortemMode) ? ctx.postmortemMode : 'off';
  const signature = blockerSignature(result);
  const draft = {
    key: draftKeyFor(signature),
    signature,
    kind,
    component: b.component,
    title: b.proposedFix?.summary || `${kind}: ${b.component}`,
    scope: b.proposedFix?.scope ?? [],
    size: b.proposedFix?.size ?? null,
    evidenceText: b.evidence?.text ?? '',
    evidenceRefs: b.evidence?.refs ?? [],
    deniedCommand: b.deniedCommand ?? null,
    origin: { session: ctx.session ?? null, role: ctx.role ?? null, launcher: ctx.launcher ?? null, pr: ctx.pr ?? null, item: ctx.item ?? null },
  };
  return { type: 'product-fix-draft', via: 'drafts-store', mode, signature, draft, ...extra };
}

/**
 * Section 4 as code. `result` is the envelope's `result` (a valid worker result, or the unparseable / aborted
 * outcome). `ctx` carries what only the caller knows. An unknown outcome or kind FAILS CLOSED to a
 * contract-violation draft, never to success.
 * @param {object|null} result
 * @param {{role?: string, launcher?: string, session?: string, pr?: string|null, item?: string|null, postmortemMode?: string, infraStreak?: number, infraCap?: number, priorConflicts?: number}} [ctx]
 * @returns {{type: string, [k: string]: *}}
 */
export function routeWorkerResult(result, ctx = {}) {
  if (!result || typeof result !== 'object') {
    return routeWorkerResult(unparseableOutcome({ role: ctx.role, launcher: ctx.launcher, reason: 'ended-without-result' }), ctx);
  }
  switch (result.outcome) {
    case 'done': return { type: 'done' };
    case 'no-change': return { type: 'no-change' };
    case 'not-applicable': return { type: 'not-applicable' };
    case 'aborted': return { type: 'aborted', via: 'none' };
    case 'unparseable': return draftAction(result, ctx, CONTRACT_VIOLATION_KIND, { hold: 'cool-off', releaseClaim: true });
    case 'blocked': break;
    default:
      return routeWorkerResult(unparseableOutcome({ role: ctx.role, launcher: ctx.launcher, reason: 'schema-violation', problems: [`unknown outcome ${JSON.stringify(result.outcome)}`] }), ctx);
  }
  const b = result.blocker;
  if (!b || !BLOCKER_KINDS.includes(b.kind)) {
    return routeWorkerResult(unparseableOutcome({ role: ctx.role, launcher: ctx.launcher, reason: 'reader-check-failed', problems: ['blocked without a known blocker kind'] }), ctx);
  }
  switch (b.kind) {
    case 'infra-transient': {
      const capped = Number.isInteger(ctx.infraCap) && (ctx.infraStreak ?? 0) >= ctx.infraCap;
      return capped ? draftAction(result, ctx, 'infra-transient', { hold: 'cool-off' }) : { type: 'retry-after-cooloff', via: 'existing-streak' };
    }
    case 'host-load': return { type: 'quiet-host-reverify', via: 'existing' };
    case 'permission-wall': return draftAction(result, ctx, 'permission-wall', { alsoSlowRetry: true });
    case 'tooling-defect': return draftAction(result, ctx, 'tooling-defect', { hold: 'waiting-on-product-fix' });
    case 'spec-defect': return { type: 're-prepare', hold: 'spec-defect' };
    case 'dependency': return { type: 'hold-until-ref', ref: b.evidence?.refs?.[0] ?? null };
    case 'conflict':
      // First conflict goes to the existing resolve-conflict path; the second is a real call (section 4).
      return (ctx.priorConflicts ?? 0) >= 1 ? operatorAction(result, ctx) : { type: 'resolve-conflict', via: 'existing' };
    case 'gate-red': return { type: 'redispatch-with-output', via: 'existing-ladder' };
    case 'needs-ruling': return operatorAction(result, ctx);
    default: return draftAction(result, ctx, b.kind);
  }
}

/** The ONLY route to the operator: question + options + recommendation, nothing from prose. */
function operatorAction(result, ctx) {
  const r = result.blocker.ruling;
  return {
    type: 'operator', via: 'needs-you',
    ruling: r ? { question: r.question, options: r.options, recommendation: r.recommendation } : { question: result.blocker.evidence?.text ?? '', options: [], recommendation: '' },
    origin: { session: ctx.session ?? null, pr: ctx.pr ?? null, item: ctx.item ?? null },
  };
}

/**
 * The old free outcome word for a result, so readers that have not migrated keep working. Every word returned is part of
 * the briefs' OWN vocabulary (`LEGACY_OUTCOME_MAP`; a test pins that), so an unmigrated reader sees exactly what it saw
 * when the agent wrote the word itself. Those readers special-case only `blocked-on-infra`, `blocked-on-permission`,
 * `blocked-on-load-flake` and the ci-heal escalation words and count the rest as done, TODAY, for agent-written words
 * too: no new hazard, and the v2 `result`/`action` are the fail-closed truth for any reader that has migrated. An
 * unparseable result is `blocked`; an operator stop is `aborted` (the operator wants it stopped, so "done" is right).
 */
export function legacyOutcomeWord(result) {
  if (!result) return null;
  switch (result.outcome) {
    case 'done': return 'done';
    case 'no-change': return 'no-change';
    case 'not-applicable': return 'not-applicable';
    case 'aborted': return 'aborted';
    case 'unparseable': return 'blocked';
    default: break;
  }
  const byKind = {
    'infra-transient': 'blocked-on-infra', 'host-load': 'blocked-on-load-flake', 'permission-wall': 'blocked-on-permission',
    'tooling-defect': 'waiting-on-system-fix', 'dependency': 're-blocked', 'conflict': 'escalated-conflict', 'gate-red': 'gate-red',
    'needs-ruling': 'escalated-needs-judgment', 'spec-defect': 'blocked',
  };
  return byKind[result.blocker?.kind] ?? 'blocked';
}

// ── 3. the three old stores, read as v2 ─────────────────────────────────────────────────────────────────────────

const WORD_CAP = 280;

function legacyResult({ outcome, kind, retryable }, record, source) {
  const files = Array.isArray(record.filesTouched) ? record.filesTouched : [];
  const reason = typeof record.reason === 'string' ? record.reason.slice(0, WORD_CAP) : '';
  const base = {
    v: 1, outcome, summary: reason || `(legacy ${source}) ${record.outcome}`, blocker: null, findingsAddressed: [], filesTouched: files, learning: record.learning ?? null,
  };
  if (outcome !== 'blocked') return base;
  return {
    ...base,
    blocker: {
      kind, component: `legacy ${source}`, evidence: { text: reason || `legacy outcome ${record.outcome}`, refs: [] }, proposedFix: null,
      ruling: kind === 'needs-ruling' ? { question: reason || 'legacy record: question not captured', options: [], recommendation: '' } : null,
      deniedCommand: sanitizeDeniedCommand(record.denied) ?? null, retryable: !!retryable,
    },
  };
}

/**
 * Read ONE legacy record as a v2 envelope (pure; D2). A v2 record is returned as is. `source` is one of
 * `legacy-completion | legacy-delivery-report | legacy-fix-report`. A `started` legacy record has no result yet; a
 * `done` one with an unknown or missing word becomes the unparseable outcome (fail closed), not success.
 * @param {object} record
 * @param {string} source
 * @param {{role?: string, launcher?: string}} [ctx]
 */
export function envelopeFromLegacy(record, source, ctx = {}) {
  if (!ENVELOPE_SOURCES.includes(source) || source === 'worker-result' || source === 'none') throw new TypeError(`operations: not a legacy source ${JSON.stringify(source)}`);
  if (record?.v === COMPLETION_RECORD_V2) return record;
  const role = ENVELOPE_ROLES.includes(record.kind) ? record.kind : (ctx.role ?? (source === 'legacy-delivery-report' ? 'build' : 'fix'));
  const launcher = ctx.launcher ?? 'claude-p';
  const env = {
    v: 2, session: record.session, kind: role, role, launcher, model: null, pr: record.pr ?? null, item: record.item ?? null, status: record.status,
    outcome: record.outcome ?? null, verdict: record.verdict ?? null, label: record.label ?? null, runId: record.runId ?? null, sessionId: record.sessionId ?? null,
    headBefore: null, headAfter: null, pid: null, timeoutMs: null, deadlineAt: null, parse: null, result: null, action: null, reroute: null, source,
    startedAt: record.startedAt, endedAt: record.status === 'done' ? record.updatedAt : null, updatedAt: record.updatedAt,
  };
  if (record.status !== 'done') return env;
  const mapped = mapLegacyOutcome(record.outcome, { filesTouched: Array.isArray(record.filesTouched) ? record.filesTouched : [] });
  if (!mapped) {
    const result = unparseableOutcome({ role, launcher, reason: 'unreported' });
    return { ...env, result, parse: { ok: false, reason: 'unreported' }, action: routeWorkerResult(result, { ...ctx, role, launcher, session: record.session }) };
  }
  const result = legacyResult(mapped, record, source);
  return { ...env, result, parse: { ok: true, reason: 'legacy-mapped' }, action: routeWorkerResult(result, { ...ctx, role, launcher, session: record.session, pr: env.pr, item: env.item }) };
}

// ── draft sink (the one io function; D3) ────────────────────────────────────────────────────────────────────────

/**
 * Resolve `postmortem.mode`. Env `WE_POSTMORTEM_MODE` wins, else the committed-default-plus-local-override file
 * (`<operationsDir>/postmortem.json`, key `mode`), else `off` (the product default). A bad value is `off`
 * (fail closed, as 114's loader does). Item 114 owns the full config; this reads only the one key it needs.
 */
export function resolvePostmortemMode({ env = process.env, operationsDir = null, readFile = readFileSync } = {}) {
  const fromEnv = env.WE_POSTMORTEM_MODE;
  if (fromEnv) return POSTMORTEM_MODES.includes(fromEnv) ? fromEnv : 'off';
  if (!operationsDir) return 'off';
  try {
    const mode = JSON.parse(readFile(join(operationsDir, 'postmortem.json'), 'utf8'))?.mode;
    return POSTMORTEM_MODES.includes(mode) ? mode : 'off';
  } catch { return 'off'; }
}

/** PURE: merge a new sighting into the draft already stored under the same key (one draft per signature; evidence grows). */
export function mergeDraft(existing, action, now) {
  const origin = { ...action.draft.origin, at: now };
  if (!existing) {
    return { ...action.draft, state: 'open', mode: action.mode, firstSeen: now, lastSeen: now, count: 1, sightings: [origin] };
  }
  const seen = new Set((existing.sightings ?? []).map((s) => `${s.session}|${s.pr}|${s.item}`));
  const dup = seen.has(`${origin.session}|${origin.pr}|${origin.item}`);
  return {
    ...existing,
    mode: action.mode,
    lastSeen: now,
    count: dup ? existing.count : (existing.count ?? 1) + 1,
    sightings: dup ? existing.sightings : [...(existing.sightings ?? []), origin].slice(-50),
    evidenceRefs: [...new Set([...(existing.evidenceRefs ?? []), ...action.draft.evidenceRefs])].slice(0, 50),
  };
}

/**
 * Write (or grow) the draft for a `product-fix-draft` action. `mode: off` writes nothing. `draft` and `file` both
 * write the draft; FILING it as a card is 114's job and stays the operator's call under `draft` (D3). Returns
 * `{written, key, path, reason}`. The same file per signature is the shared dedupe key with 114: a flood is one draft.
 */
export function writeProductFixDraft(action, { dir, now = () => new Date().toISOString() } = {}) {
  if (!action || action.type !== 'product-fix-draft') return { written: false, reason: 'not-a-draft-action' };
  if (action.mode === 'off') return { written: false, reason: 'postmortem-off', key: action.draft.key };
  if (!dir) throw new TypeError('operations: writeProductFixDraft needs a drafts directory');
  const cards = join(dir, 'cards');
  mkdirSync(cards, { recursive: true });
  const path = join(cards, `${action.draft.key}.json`);
  return withFileLock(`${path}.lock`, () => {
    let existing = null;
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { existing = null; }
    writeJsonAtomic(path, mergeDraft(existing, action, now()));
    return { written: true, key: action.draft.key, path, grew: !!existing };
  });
}

/** Count the draft files in a drafts directory (a small helper for the report and the tests). */
export function listDraftKeys(dir) {
  try { return readdirSync(join(dir, 'cards')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; }
}
