/**
 * @file scripts/lib/red-team-gate.mjs
 * @description CONFIRMED POST-ACCEPT RED-TEAM BREAKS GO BACK TO THE FIXER (card x1b8hlo, operator go 2026-10-10).
 *
 *   The post-accept red team (`we:scripts/operations/review-extra-seats.mjs#runRedTeam`) posts ONE advisory comment
 *   per reviewed head. Before this card that comment was the end of it: a PR with a break Claude's re-check CONFIRMED
 *   reached the operator queue as NEEDS YOU (live PR #4722, 2026-10-10 02:04Z; the operator sent it back by hand).
 *
 *   This module is the LIGHT, PURE half (no gh, no fs except the settings read, no heavy imports — the operator
 *   queue loads it):
 *     - the comment's marker, single-sourced here and re-exported by the producer, and its PARSER (the exact inverse
 *       of `renderRedTeamComment`, pinned by a round-trip test against the real renderer);
 *     - the setting `redTeam.confirmedBreaks` under the policy cascade: built-in default → platform preference
 *       (`we:scripts/settings/red-team.json`) → tool override (env {@link CONFIRMED_BREAKS_ENV});
 *     - the decision: which findings of the LIVE head's comment are sent back, carded, or left advisory;
 *     - the operator-queue reason ({@link redTeamQueueReason}).
 *   The impure half (the send-back through `review-set-label.mjs`, the card through the shared landing job, the
 *   dedup marker comment) is `we:scripts/operations/red-team-gate-apply.mjs`.
 *
 *   What this never does: weaken a gate, accept anything, or touch `review:human`. A send-back only ever adds a hold.
 *   Fail closed: a confirmed finding with no stated impact counts as `broken`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { isHumanOperatorComment } from './operator-identity.mjs';

import { parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
import { parseLatestHumanClearedSha, REVIEWED_SHA_MARKER } from './review-escalation.mjs';
import { scrubPublish } from './secret-scrub.mjs';
import { commentCreatedAt, roundExtensionGrants } from '../conveyor/round-extension-mark.mjs';

// ── The comment the producer writes ─────────────────────────────────────────────────────────────────────────────

/** The red-team comment's leading marker (the producer imports it from here). */
export const RED_TEAM_COMMENT_MARKER = '<!-- we:red-team-advisory';
/** The tag a finding line carries, by re-check outcome (the producer renders with these). */
export const RED_TEAM_CONFIRMED_TAG = '**confirmed**';
export const RED_TEAM_UNCONFIRMED_TAG = 'not confirmed';
export const RED_TEAM_UNVERIFIABLE_TAG = 'unverifiable';

/** The dedup marker line for one reviewed head. PURE. */
export function redTeamMarker(pr, rev) {
  return `${RED_TEAM_COMMENT_MARKER} pr=${Number(pr)} rev=${String(rev)} -->`;
}

const MARKER_RE = /^<!-- we:red-team-advisory pr=(\d+) rev=([0-9a-f]{7,64}) -->/i;
const FINDING_RE = /^(\d+)\. \[(\*\*confirmed\*\*|not confirmed|unverifiable)\] \(([^,()]+), ([^()]+?)\)(?: `([^`]+)`)? — (.*)$/;
const SUB_RE = /^ {3}- (Scenario|Re-check): (.*)$/;
// Any reviewed-sha marker the shared parser reads (full or abbreviated, any case), and a case variant of the marker
// name too: only used to SUPERSEDE a ruling, where reading more holds more.
const REVIEWED_SHA_ANY_RE = new RegExp(`<!--\\s*${REVIEWED_SHA_MARKER}:\\s*([0-9a-f]{7,40})\\s*-->`, 'gi');
const REVIEWED_SHA_FULL_RE = new RegExp(`<!--\\s*${REVIEWED_SHA_MARKER}:\\s*([0-9a-fA-F]{40})\\s*-->`, 'g');

/**
 * Parse ONE red-team comment body. PURE. Returns null for anything that is not one (no leading marker).
 * @returns {{pr:number, rev:string, findings:Array<{index:number, confirmed:boolean, category:string,
 *   impact:(string|null), file:(string|null), line:(number|null), summary:string, scenario:(string|null),
 *   recheck:(string|null)}>}|null}
 */
export function parseRedTeamComment(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trimStart();
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const findings = [];
  for (const line of text.split('\n')) {
    const f = FINDING_RE.exec(line);
    if (f) {
      const [path, ln] = f[5] ? (/^(.*?):(\d+)$/.exec(f[5])?.slice(1) ?? [f[5], null]) : [null, null];
      const impact = f[4].trim();
      findings.push({
        ...(f[2] === RED_TEAM_UNVERIFIABLE_TAG ? { recheckOutcome: 'unverifiable' } : {}),
        index: Number(f[1]), confirmed: f[2] === RED_TEAM_CONFIRMED_TAG, category: f[3].trim(),
        impact: impact === 'impact?' ? null : impact, file: path, line: ln == null ? null : Number(ln),
        summary: f[6].trim(), scenario: null, recheck: null,
      });
      continue;
    }
    const s = SUB_RE.exec(line);
    if (s && findings.length) findings.at(-1)[s[1] === 'Scenario' ? 'scenario' : 'recheck'] = s[2].trim();
  }
  return { pr: Number(m[1]), rev: m[2].toLowerCase(), findings };
}

/**
 * The id a gate record names its result by: a digest of the parsed findings, not of the head, so a result carried
 * across an identical contribution keeps its id. Two results with identical findings share one decision. It hashes a
 * fixed, versioned list of fields, so adding a parser field never silently re-keys every recorded decision. PURE.
 */
const RESULT_ID_FIELDS = ['index', 'confirmed', 'recheckOutcome', 'category', 'impact', 'file', 'line', 'summary', 'scenario', 'recheck'];
export function redTeamResultId(parsed) {
  if (!parsed) return null;
  const findings = (parsed.findings ?? []).map(f => RESULT_ID_FIELDS.map(k => f?.[k] ?? null));
  return createHash('sha256').update(JSON.stringify(['v1', findings])).digest('hex').slice(0, 16);
}

/**
 * The red-team comment for the LIVE head: the newest one a TRUSTED principal wrote whose marker names this PR and
 * exactly this head. A comment on another head is stale (the fixer already pushed) and is ignored. PURE.
 */
export function redTeamForHead(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(live)) return null;
  const hits = (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, parsed: isTrustedMarkerAuthor(c) ? parseRedTeamComment(typeof c === 'string' ? c : c?.body) : null }))
    .filter((x) => x.parsed && x.parsed.pr === Number(pr) && x.parsed.rev === live)
    .sort((a, b) => (Date.parse(commentCreatedAt(a.c)) || 0) - (Date.parse(commentCreatedAt(b.c)) || 0) || a.i - b.i);
  return hits.at(-1)?.parsed ?? null;
}

// ── The setting ─────────────────────────────────────────────────────────────────────────────────────────────────

export const CONFIRMED_BREAK_ACTIONS = Object.freeze({ SEND_BACK: 'send-back', CARD: 'card', ADVISORY: 'advisory' });
const ACTIONS = Object.values(CONFIRMED_BREAK_ACTIONS);
/** The three classes a red-team finding falls into. */
export const BREAK_CLASSES = Object.freeze(['broken', 'degraded', 'unconfirmed']);
/** Built-in default (operator go 2026-10-10). */
export const CONFIRMED_BREAKS_DEFAULTS = Object.freeze({ broken: 'send-back', degraded: 'card', unconfirmed: 'advisory' });
/** Tool override: `broken=send-back,degraded=card,unconfirmed=advisory` (any subset). */
export const CONFIRMED_BREAKS_ENV = 'WE_RED_TEAM_CONFIRMED_BREAKS';
export const RED_TEAM_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'red-team.json');

/** The cascade, PURE: default → platform file (`redTeam.confirmedBreaks`) → env. Each key alone; a bad value keeps the lower layer. */
export function resolveConfirmedBreaks({ file = {}, env = {} } = {}) {
  const value = { ...CONFIRMED_BREAKS_DEFAULTS };
  const source = Object.fromEntries(BREAK_CLASSES.map((k) => [k, 'default']));
  const fromFile = file?.redTeam?.confirmedBreaks;
  for (const k of BREAK_CLASSES) {
    if (ACTIONS.includes(fromFile?.[k])) { value[k] = fromFile[k]; source[k] = 'settings'; }
  }
  for (const pair of String(env?.[CONFIRMED_BREAKS_ENV] ?? '').split(',')) {
    const [k, v] = pair.split('=').map((x) => String(x ?? '').trim().toLowerCase());
    if (BREAK_CLASSES.includes(k) && ACTIONS.includes(v)) { value[k] = v; source[k] = 'env'; }
  }
  return { value, source };
}

/** Read the live setting. Never throws: an unreadable file is the built-in default. */
export function readConfirmedBreaks({ env = process.env, path = RED_TEAM_SETTINGS_FILE } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { file = {}; }
  return resolveConfirmedBreaks({ file, env });
}

/**
 * redTeam.timing: panel-seat (standard prototype default) runs on every reviewed head
 * beside the jurors; post-accept restores the sequential accept-only path.
 * carriedAcceptTriggersReview defaults true: a carried accept lacking head-bound review evidence
 * owes a fresh capped review before the drain red-team job can run.
 * Standard < platform < tool < env (WE_RED_TEAM_TIMING / WE_RED_TEAM_CARRIED_ACCEPT_TRIGGERS_REVIEW);
 * invalid values keep the lower layer.
 */
export function resolveRedTeamTiming({ file = {}, platform, env = {} } = {}) {
  const pick = o => Object.fromEntries(['timing', 'carriedAcceptTriggersReview']
    .filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
  const raw = env.WE_RED_TEAM_CARRIED_ACCEPT_TRIGGERS_REVIEW;
  const normalized = String(raw ?? '').trim().toLowerCase();
  const carried = raw === undefined || raw === '' ? undefined
    : ['true', 'on', '1'].includes(normalized) ? true : ['false', 'off', '0'].includes(normalized) ? false : raw;
  return resolveCascade({ standard: { timing: 'panel-seat', carriedAcceptTriggersReview: true }, platform: pick(platform),
    tool: pick(file?.redTeam), envValues: { timing: env.WE_RED_TEAM_TIMING, carriedAcceptTriggersReview: carried },
    valid: { timing: v => ['panel-seat', 'post-accept'].includes(v), carriedAcceptTriggersReview: v => typeof v === 'boolean' } });
}
export function readRedTeamTiming({ env = process.env, path = RED_TEAM_SETTINGS_FILE, log = () => {} } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* defaults */ }
  const resolved = resolveRedTeamTiming({ file, platform: platformPreference('redTeam', { env }), env });
  log(formatCascadeSourcesLine('redTeam', resolved));
  return resolved;
}

/** Repo-reading and card-only controls share the standard/platform/tool/env cascade. */
export const RED_TEAM_PROBE_DEFAULTS = Object.freeze({ recheckReadsRepo: true, skipCardOnly: true, statusLabels: true });
export const RED_TEAM_PROBE_ENV = Object.freeze({
  recheckReadsRepo: 'WE_RED_TEAM_RECHECK_READS_REPO', skipCardOnly: 'WE_RED_TEAM_SKIP_CARD_ONLY', statusLabels: 'WE_RED_TEAM_STATUS_LABELS',
});
export function resolveRedTeamProbes({ file = {}, platform, env = {} } = {}) {
  const envValues = {};
  for (const [key, name] of Object.entries(RED_TEAM_PROBE_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const v = String(raw).trim().toLowerCase();
    envValues[key] = ['true', 'on', '1'].includes(v) ? true : ['false', 'off', '0'].includes(v) ? false : raw;
  }
  const pick = (o) => Object.fromEntries(Object.keys(RED_TEAM_PROBE_DEFAULTS).filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
  return resolveCascade({ standard: RED_TEAM_PROBE_DEFAULTS, platform: pick(platform), tool: pick(file?.redTeam),
    envValues, valid: v => typeof v === 'boolean' });
}
export function readRedTeamProbes({ env = process.env, path = RED_TEAM_SETTINGS_FILE, log = () => {} } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* defaults */ }
  const resolved = resolveRedTeamProbes({ file, platform: platformPreference('redTeam', { env }), env });
  log(formatCascadeSourcesLine('redTeam', resolved));
  return resolved;
}

/**
 * What the drain does when an owed post-accept red team has no result on the live head at its wait deadline
 * (`drain.redTeamPendingMaxMin`). Every value HOLDS the PR: `hold` publishes the operator note; `requeue-then-hold`
 * (standard) first re-requests the red team once for that head, and holds with the note if that also produces no
 * result. No file or platform value can restore merge-without-result: `merge-without-result` is accepted ONLY from the
 * operator's own env (`WE_RED_TEAM_DEADLINE_ACTION`) together with a named `WE_RED_TEAM_DEADLINE_OVERRIDE_BY`, and the
 * drain logs it as an operator override on every use. Anywhere else it is invalid and the lower layer stands.
 */
export const RED_TEAM_DEADLINE_ACTIONS = Object.freeze(['hold', 'requeue-then-hold']);
export const RED_TEAM_DEADLINE_OVERRIDE = 'merge-without-result';
export const RED_TEAM_DEADLINE_ENV = 'WE_RED_TEAM_DEADLINE_ACTION';
export const RED_TEAM_DEADLINE_OVERRIDE_BY_ENV = 'WE_RED_TEAM_DEADLINE_OVERRIDE_BY';
export function resolveRedTeamDeadlineAction({ file = {}, platform, env = {} } = {}) {
  const raw = env[RED_TEAM_DEADLINE_ENV];
  const envAction = raw === undefined || raw === '' ? undefined : String(raw).trim().toLowerCase();
  const overrideBy = String(env[RED_TEAM_DEADLINE_OVERRIDE_BY_ENV] ?? '').trim().slice(0, 100);
  const operatorOverride = envAction === RED_TEAM_DEADLINE_OVERRIDE && overrideBy !== '';
  const pick = o => (o?.deadlineAction === undefined ? {} : { deadlineAction: o.deadlineAction });
  const resolved = resolveCascade({ standard: { deadlineAction: 'requeue-then-hold' }, platform: pick(platform), tool: pick(file?.redTeam),
    envValues: { deadlineAction: operatorOverride ? undefined : envAction }, valid: v => RED_TEAM_DEADLINE_ACTIONS.includes(v) });
  if (!operatorOverride) return { ...resolved, operatorOverride: null };
  return { ...resolved, value: { deadlineAction: RED_TEAM_DEADLINE_OVERRIDE }, sources: { deadlineAction: 'env' },
    leafValues: { deadlineAction: RED_TEAM_DEADLINE_OVERRIDE }, operatorOverride: { by: overrideBy } };
}
export function readRedTeamDeadlineAction({ env = process.env, path = RED_TEAM_SETTINGS_FILE, log = () => {} } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* defaults */ }
  const resolved = resolveRedTeamDeadlineAction({ file, platform: platformPreference('redTeam', { env }), env });
  log(formatCascadeSourcesLine('redTeam', resolved));
  return resolved;
}

/**
 * `redTeam.operatorRulings.anyState` (default true; kill switch env {@link OPERATOR_RULINGS_ENV}=false): may an
 * OPERATOR ruling (`record-red-team-ruling`, a human operator account) rule on a confirmed break in ANY state of the
 * live result (at the round cap, sent back, or carded)? Off restores the round-cap-only rule: the CLI refuses a
 * result not parked at the cap, and this reader lets an operator release override only what the gate handed over,
 * never a recorded send-back. Automation never gets this: an operator release counts only from a human operator. */
/* `redTeam.operatorRulings.carryAcrossRebase` (default true; kill switch env {@link OPERATOR_RULINGS_CARRY_ENV}=false):
 * an operator RELEASE (card / not-real) made on head A still counts on head B only across a trusted verdict carry
 * (identical net patch, review-job carryAcrossRebase) AND a trusted `we:red-team-carry-lines` record proving the
 * break's cited line is byte-identical on A and B ({@link redTeamCarryLinesMarker}). Off: no operator release ever
 * carries; the new head is re-ruled. Restrictive records (send-back, held, operator-block) always carry. */
export const OPERATOR_RULINGS_DEFAULTS = Object.freeze({ anyState: true, carryAcrossRebase: true });
export const OPERATOR_RULINGS_ENV = 'WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE';
export const OPERATOR_RULINGS_CARRY_ENV = 'WE_RED_TEAM_OPERATOR_RULINGS_CARRY';
const envBool = (raw) => {
  const v = raw === undefined || raw === '' ? undefined : String(raw).trim().toLowerCase();
  return v === undefined ? undefined : ['true', 'on', '1'].includes(v) ? true : ['false', 'off', '0'].includes(v) ? false : raw;
};
export function resolveOperatorRulings({ file = {}, platform, env = {} } = {}) {
  const pick = (o) => Object.fromEntries(Object.keys(OPERATOR_RULINGS_DEFAULTS)
    .filter((k) => o?.operatorRulings?.[k] !== undefined).map((k) => [k, o.operatorRulings[k]]));
  return resolveCascade({ standard: OPERATOR_RULINGS_DEFAULTS, platform: pick(platform), tool: pick(file?.redTeam),
    envValues: { anyState: envBool(env[OPERATOR_RULINGS_ENV]), carryAcrossRebase: envBool(env[OPERATOR_RULINGS_CARRY_ENV]) },
    valid: (x) => typeof x === 'boolean' });
}
export function readOperatorRulings({ env = process.env, path = RED_TEAM_SETTINGS_FILE, log = () => {} } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* defaults */ }
  let platform;
  try { platform = platformPreference('redTeam', { env }); } catch { platform = undefined; }
  const resolved = resolveOperatorRulings({ file, platform, env });
  log(formatCascadeSourcesLine('redTeam.operatorRulings', resolved));
  return resolved;
}

// ── The decision ────────────────────────────────────────────────────────────────────────────────────────────────

/** A finding's class. Fail closed: confirmed with no stated (or an unknown) impact is `broken`. PURE. */
export function breakClass(f) {
  if (!f?.confirmed) return 'unconfirmed';
  if (f.impact === 'degraded' || f.impact === 'cosmetic') return 'degraded';
  return 'broken';
}

/**
 * What to do with one parsed comment under the setting. PURE.
 * @returns {{sendBack:object[], card:object[], advisory:object[]}}
 */
export function planRedTeamActions(parsed, setting = CONFIRMED_BREAKS_DEFAULTS) {
  const out = { sendBack: [], card: [], advisory: [] };
  for (const f of parsed?.findings ?? []) {
    const action = setting[breakClass(f)] ?? CONFIRMED_BREAK_ACTIONS.ADVISORY;
    if (action === CONFIRMED_BREAK_ACTIONS.SEND_BACK) out.sendBack.push(f);
    else if (action === CONFIRMED_BREAK_ACTIONS.CARD) out.card.push(f);
    else out.advisory.push(f);
  }
  return out;
}

// ── The gate's own record (dedup + operator-queue state) ───────────────────────────────────────────────────────

export const RED_TEAM_GATE_MARKER = '<!-- we:red-team-gate';
/**
 * What the gate records per head, one comment per ACTION so a failed action stays retryable on its own:
 * the send-back step records `sent-back`, or `round-cap` (the cap is reached or the round could not be read; the
 * operator rules instead); the card step records `card-queued` after a durable owed filing or a spawned landing job
 * (for a spawn, the shared seam reports only that it started; the detached job owns the later landing).
 * `no-send-back` is only ever a RESULT label (nothing to send back); it is never recorded.
 */
export const GATE_OUTCOMES = Object.freeze({ SENT_BACK: 'sent-back', ROUND_CAP: 'round-cap', NOTHING_TO_SEND: 'no-send-back', CARD_QUEUED: 'card-queued' });

/** `result` names the decided result ({@link redTeamResultId}). `grantIds` records the send-back step's grant
 * snapshot, not its POST time. Older records omit these fields. */
export function redTeamGateMarker(pr, rev, outcome, result = null, grantIds = null) {
  return `${RED_TEAM_GATE_MARKER} pr=${Number(pr)} rev=${String(rev).toLowerCase()} outcome=${outcome}${result ? ` result=${result}` : ''}${grantIds ? ` grants=${grantIds.join(',') || 'none'}` : ''} -->`;
}

/** PURE: parse the anchored gate marker, shared by gate reads and verdict carry. `grants=` takes any number of ids:
 * the writer records every grant it read, so a count bound here would make a valid record unreadable (fail-open). */
export function parseRedTeamGateMarker(body) {
  const m = /^<!-- we:red-team-gate pr=(\d+) rev=([0-9a-f]{40}) outcome=([a-z-]+)(?: result=([0-9a-f]{16}))?(?: grants=(none|[0-9a-f]{16}(?:,[0-9a-f]{16})*))? -->/.exec(String(body ?? '').trimStart());
  return m ? { pr: Number(m[1]), rev: m[2], outcome: m[3], ...(m[4] ? { result: m[4] } : {}),
    ...(m[5] ? { grantIds: m[5] === 'none' ? [] : m[5].split(',') } : {}) } : null;
}

/** Every outcome the gate recorded for this head (trusted authors only). PURE. */
export function gateOutcomesForHead(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  const found = new Set();
  for (const c of Array.isArray(comments) ? comments : []) {
    const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
    if (m && m.pr === Number(pr) && m.rev === live && isTrustedMarkerAuthor(c)) found.add(m.outcome);
  }
  return found;
}

/**
 * The SEND-BACK step's recorded outcome for this head (`sent-back` or `round-cap`), or null when that step has not
 * run. The card step's `card-queued` record is a different action and never answers this. PURE.
 */
export function gateOutcomeForHead(comments, pr, head) {
  return sendBackStepOutcome(gateOutcomesForHead(comments, pr, head));
}

/** The send-back step's outcome among a set of recorded outcomes. PURE. */
export function sendBackStepOutcome(found) {
  // A head can carry both only if two gate runs raced; the cap record wins (it hands the PR to the operator).
  if (found.has(GATE_OUTCOMES.ROUND_CAP)) return GATE_OUTCOMES.ROUND_CAP;
  return found.has(GATE_OUTCOMES.SENT_BACK) ? GATE_OUTCOMES.SENT_BACK : null;
}

/**
 * The operator's audited round grants on this PR (`extend-rounds`), scoped to the PR's own repo, with stable identities.
 * No repo means no grant credit: a reader that cannot name the repo keeps the cap (fail closed). `standingRuling` is
 * the read-time verified scope (`we:scripts/conveyor/standing-ruling-io.mjs#standingRulingScope`) that lets an
 * automatic standing-ruling grant count, exactly as fix dispatch counts it; without it only operator grants count. PURE.
 */
export function gateRoundGrants(comments, pr, repo = null, standingRuling = null) {
  if (!repo) return [];
  const copies = new Map();
  return roundExtensionGrants(comments, { repo, pr, standingRuling }).map(g => {
    const c = comments[g.index];
    // All readers retain the body, but ids/timestamps vary (node id, REST numeric id, or omitted metadata).
    // Authenticate first, then identify by exact content and copy number: edits invalidate snapshots, duplicate
    // grants remain distinct, and unrelated comments cannot shift an identity.
    const key = c.body;
    const copy = (copies.get(key) ?? 0) + 1;
    copies.set(key, copy);
    return { ...g, id: createHash('sha256').update(JSON.stringify([key, copy])).digest('hex').slice(0, 16) };
  });
}

/**
 * The send-back step's outcome from ONE result's gate records, in thread order. Without a grant this is exactly
 * {@link sendBackStepOutcome} (raced records: the cap wins). A grant the cap decision did not see reopens the step,
 * even if the cap's POST landed after the grant. A send-back after that grant supersedes the stale cap in either
 * posting order. Legacy cap records use their thread position as the snapshot. PURE.
 */
export function sendBackStepState(gates, grants = []) {
  const { outcome, reopened } = resolveSendBackStep(gates, grants);
  return { outcome, reopened };
}

function resolveSendBackStep(gates, grants) {
  const step = [...gates].filter(r => r.gate.outcome === GATE_OUTCOMES.ROUND_CAP || r.gate.outcome === GATE_OUTCOMES.SENT_BACK)
    .sort((a, b) => a.at - b.at || threadOrder(a, b));
  const position = g => typeof g === 'number' ? g : g.index;
  const identity = g => typeof g === 'number' ? String(g) : g.id;
  const eligible = new Set(grants.map(identity));
  let outcome = null, sentGrants = [], sentSnapshot = false, capSnapshot = false;
  const capGrants = new Set();
  const supersededCaps = new Set();
  for (const r of step) {
    const before = grants.filter(g => position(g) < r.at).map(identity);
    if (r.gate.outcome === GATE_OUTCOMES.ROUND_CAP) {
      const seen = new Set(r.gate.grantIds ?? before);
      if (outcome === GATE_OUTCOMES.SENT_BACK && (sentSnapshot || r.gate.grantIds == null)
        && sentGrants.some(id => !seen.has(id))) { supersededCaps.add(r); continue; }
      outcome = GATE_OUTCOMES.ROUND_CAP;
      capSnapshot ||= r.gate.grantIds != null;
      // A slower, older cap decision must not undo a newer cap's consumption of a grant either.
      for (const id of seen) capGrants.add(id);
      continue;
    }
    // Snapshot both decisions: a later grant edit must not be attributed to a historical sender. Without a repo,
    // even recorded identities receive no credit. Legacy senders cannot veto a newer, explicit cap snapshot.
    const used = (r.gate.grantIds ?? before).filter(id => eligible.has(id));
    if (outcome !== GATE_OUTCOMES.ROUND_CAP || ((!capSnapshot || r.gate.grantIds != null)
      && used.some(id => !capGrants.has(id)))) {
      // A duplicate or slower sender must not erase already-proven grant usage. Do not add inferred legacy
      // identities once an explicit sender snapshot exists, or carry inferred identities into a proven snapshot.
      const explicit = r.gate.grantIds != null;
      if (outcome !== GATE_OUTCOMES.SENT_BACK || (explicit && !sentSnapshot)) sentGrants = used;
      else if (explicit || !sentSnapshot) sentGrants = [...new Set([...sentGrants, ...used])];
      sentSnapshot = outcome === GATE_OUTCOMES.SENT_BACK ? sentSnapshot || explicit : explicit;
      outcome = GATE_OUTCOMES.SENT_BACK;
    }
  }
  const reopened = outcome === GATE_OUTCOMES.ROUND_CAP && grants.some(g => !capGrants.has(identity(g)));
  return { outcome, reopened, supersededCaps };
}

/**
 * The round cap the gate sends back under, after the operator's audited grants. The SAME anchor fix dispatch uses
 * (`we:scripts/conveyor/reconcile-core.mjs#resolveRoundExtensionAnchor`, default `grant`): a grant of `by` rounds
 * means `by` more rounds from the round the PR was on when it was granted, so `--by=1` on a PR already past the cap
 * still buys exactly one more round. The additive floor (`cap` + every grant) never lowers the cap. A grant whose
 * round cannot be read (`roundAt` returns null) counts only additively. PURE.
 * @param {{cap:number, grants:Array<{by:number, at:string, index?:number}>, roundAt?:(at:string, grant:object)=>number|null}} o
 */
export function gateRoundCap({ cap, grants = [], roundAt = () => null }) {
  const total = grants.reduce((sum, g) => sum + g.by, 0);
  return Math.max(cap + total, ...grants.map(g => {
    const r = roundAt(g.at, g);
    return Number.isInteger(r) && r > 0 ? r + g.by : 0;
  }));
}

/**
 * The operator-queue reason: why this PR is NOT READY because of the red team, or null. PURE. The hold exists only
 * while the fixer demonstrably owns the break: a TRUSTED gate record says it SENT the break back on this head and the
 * PR still carries `review:changes`. Every other state releases it, so a gate that never acted (crashed, timed out,
 * `send-back-failed`, a red-team comment posted by hand) or an operator who returned the PR to `review:human` on the
 * same head is never held behind an actor that is not there. A new head, or the `round-cap` record, releases it too.
 */
export function redTeamQueueReason(pr, setting = CONFIRMED_BREAKS_DEFAULTS, { repo = pr?.repo ?? null, standingRuling = pr?.standingRuling ?? null } = {}) {
  const disposition = readRedTeamDisposition({ comments: pr?.comments, pr: pr?.number, head: pr?.headRefOid, setting, repo, standingRuling });
  const sendBack = disposition.sendBack;
  if (!sendBack.length || disposition.outcome !== GATE_OUTCOMES.SENT_BACK) return null;
  const labels = (Array.isArray(pr?.labels) ? pr.labels : []).map((l) => (typeof l === 'string' ? l : l?.name));
  if (!labels.includes('review:changes')) return null;
  return `red team: ${sendBack.length} confirmed break(s) on this head (${sendBack.map((f) => `#${f.index}`).join(', ')}) — the fixer owns them`;
}


/**
 * Saved (never-posted) findings publish only if every raw field, the extra composed outputs, and their NFKC forms pass
 * the secret scrub; otherwise ALL their text is withheld, keeping index, confirmation and class. PURE.
 */
export const WITHHELD_FINDING_SUMMARY = '[finding text withheld: failed the secret scrub]';
export function withholdUnpublishableFindings(findings, composed = []) {
  const texts = [findings.flatMap(f => Object.values(f)).join('\n'), ...composed].map(String);
  if (!texts.some(t => scrubPublish(t).length || scrubPublish(t.normalize('NFKC')).length)) return findings;
  return findings.map(f => ({ index: f.index, confirmed: f.confirmed, impact: breakClass(f), category: 'withheld',
    file: null, line: null, summary: WITHHELD_FINDING_SUMMARY }));
}

/**
 * Confirmed send-back findings parked at the round cap on the live head, awaiting an operator ruling. PURE apart from
 * `readSaved`: when the thread holds no live-head result, the gate may have decided on saved evidence (its comment was
 * withheld), so the caller's lazy saved-result reader is asked, exactly as the gate and the drain hold ask it.
 */
export function redTeamRulingNeeded(pr, setting = CONFIRMED_BREAKS_DEFAULTS, { readSaved = null, repo = pr?.repo ?? null, standingRuling = pr?.standingRuling ?? null } = {}) {
  const labels = (pr?.labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
  if (labels.includes('review:changes')) return null;
  const read = savedResult => readRedTeamDisposition({ comments: pr?.comments, pr: pr?.number, head: pr?.headRefOid, setting, savedResult, repo, standingRuling });
  let disposition = read(null);
  // A held break needs a trusted gate record on this head, so a thread without one never pays for the store read.
  const savedResult = !disposition.result && readSaved && gateOutcomesForHead(pr?.comments, pr?.number, pr?.headRefOid).size
    ? readSaved() : null;
  if (savedResult) disposition = read(savedResult);
  if (!disposition.held.length) return null;
  // Same rule as the gate: one unpublishable finding withholds every finding's text.
  const held = savedResult ? withholdUnpublishableFindings(disposition.held,
    [disposition.result.findings.flatMap(f => Object.values(f)).join('\n')]) : disposition.held;
  return { head: disposition.result.rev, since: disposition.since, findings: held.map(({ index, file, line, summary, category, impact }) => ({ index, file, line, summary, category, impact })) };
}

const CARRIED_LINE_RE = /^<!-- review-verdict-carried from=[0-9a-f]{40} to=[0-9a-f]{40} patch-id=[0-9a-f]{40} -->$/;
/** The heading only `review-set-label --to=clear-human` renders, at the very start of its comment (CLEARED_HUMAN_PROSE_RE). */
const CLEAR_HUMAN_RULING_RE = /^✅ review — `review:human` cleared via the sanctioned path\n\nCleared by .+? via `review-set-label\.mjs --to=clear-human`/;

/**
 * A verdict carry (review-job carryAcrossRebase) posts ONE comment: its gate markers, the carried marker, prose,
 * then the re-keyed red-team body, so the anchored readers see none of it. Split only that exact layout: gate lines
 * are taken only from before the carried line and must name the head carried to (a chain of carries splits at each
 * link). `at` keeps the thread position and `from` names the head the records were carried from. PURE.
 */
function threadRecords(comments) {
  // Every reader below counts trusted records only, so untrusted comments are dropped before any parse.
  // `at` is the comment's position in the WHOLE thread, so it compares directly with an operator grant's index
  // ({@link roundExtensionGrants}); grant snapshots additionally retain stable identities across thread edits.
  return (Array.isArray(comments) ? comments : []).flatMap((c, at) => {
    if (!isTrustedMarkerAuthor(c)) return [];
    const body = typeof c === 'string' ? c : c?.body;
    const lines = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trimStart().split('\n') : [];
    const k = lines.findIndex(line => CARRIED_LINE_RE.test(line));
    const carried = k < 0 ? null : parseVerdictCarriedMarker(lines[k]);
    const advisoryBody = lines.slice(k + 2).join('\n');
    const advisory = carried && lines[k + 1] === 'Review verdict carried across an identical contribution.'
      && lines[k + 2]?.startsWith(RED_TEAM_COMMENT_MARKER) ? parseRedTeamComment(advisoryBody) : null;
    if (!advisory || advisory.rev !== carried.toSha || !lines.slice(0, k).every(line => {
      const gate = parseRedTeamGateMarker(line);
      return gate?.rev === carried.toSha && gate.pr === advisory.pr;
    })) return [{ c, at }];
    const parts = [...lines.slice(0, k), advisoryBody];
    return [{ c, at }, ...parts.map(part => ({ c: { ...c, body: part }, at, from: carried.fromSha }))];
  });
}

const recordBody = r => String((typeof r.c === 'string' ? r.c : r.c?.body) ?? '');
/** Thread order: creation time, then thread position. A record without a time takes the time of the record before it,
 * so the key is total (a sort never meets a contradiction). PURE. */
const threadOrder = (a, b) => a.ts - b.ts || a.i - b.i;
/** A comment's creation time in either read shape: GraphQL/`gh pr view` (`createdAt`) or the REST thread the drain reads (`created_at`). */
export const commentTime = c => Date.parse(c?.createdAt ?? c?.created_at);
const indexedRecords = (comments, savedResult = null) => {
  let ts = 0;
  const records = threadRecords(comments).map((r, i) => {
    const t = commentTime(r.c);
    if (Number.isFinite(t)) ts = t;
    return { ...r, i, ts };
  });
  if (savedResult) {
    const savedAt = Date.parse(savedResult.scoredAt);
    const times = records.map(r => commentTime(r.c));
    const ordered = Number.isFinite(savedAt) && times.every((t, i) => Number.isFinite(t) && (!i || t >= times[i - 1]));
    // Internal evidence is not a posted comment. Unknown chronology cannot establish a later operator ruling
    // or bind a legacy marker; an explicit result id can still dedup the gate's own action.
    const at = ordered ? records.reduce((at, r, i) => times[i] <= savedAt ? r.at : at, -1) + 0.5 : Infinity;
    records.push({ c: null, at, i: at, ts: ordered ? savedAt : Infinity, parsed: savedResult, saved: true });
  }
  return records;
};

/** The newest trusted red-team result for this PR and head among the records, or null. PURE. */
function latestResult(records, pr, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  return records.map(r => ({ ...r, parsed: r.parsed ?? parseRedTeamComment(recordBody(r)) }))
    .filter(r => r.parsed?.pr === Number(pr) && r.parsed.rev === sha).sort(threadOrder).at(-1) ?? null;
}

/**
 * The gate records that decide ONE result (`hit`). A record that names a result (`result=`) decides only that one.
 * An older record without a name decides the result before it in the thread, or the result its own carry comment
 * carries. A result no record decides has no gate decision, whatever the gate recorded for another result on the
 * same head: its confirmed breaks keep holding. PURE.
 */
function gateRecordsFor(records, pr, sha, hit) {
  const id = redTeamResultId(hit.parsed);
  return records.flatMap(r => {
    const gate = parseRedTeamGateMarker(recordBody(r));
    if (gate?.pr !== Number(pr) || gate.rev !== sha) return [];
    const decides = gate.result ? gate.result === id
      : threadOrder(r, hit) > 0 || (r.from != null && hit.from != null && r.at === hit.at);
    return decides ? [{ ...r, gate }] : [];
  });
}

/**
 * The live head's latest red-team result (carried ones included) and the outcomes the gate recorded for THAT result.
 * The gate dedups on this, so a record for an earlier same-head result never stops it deciding a newer one. PURE.
 */
export function liveResultGateState(comments, pr, head, repo = null, standingRuling = null, savedResult = null) {
  const live = String(head ?? '').toLowerCase();
  const records = indexedRecords(comments, savedResult);
  const hit = latestResult(records, pr, live);
  if (!hit) return { result: null, resultId: null, headReviewIndex: null, outcomes: new Set(), sendBackOutcome: null, reopened: false };
  const gates = gateRecordsFor(records, pr, live, hit);
  const { outcome, reopened } = sendBackStepState(gates, gateRoundGrants(comments, pr, repo, standingRuling));
  return { result: hit.parsed, resultId: redTeamResultId(hit.parsed), headReviewIndex: firstReviewIndex(records, pr, live),
    outcomes: new Set(gates.map(r => r.gate.outcome)), sendBackOutcome: outcome, reopened };
}

/**
 * The thread position of the FIRST trusted sign that this head was reviewed: a red-team result on it, or a
 * `reviewed-sha` marker naming it in full. A grant after it was made on this head's round, so its anchor counts the
 * head (in thread order, as fix dispatch does; never by clocks). Null when there is none. PURE.
 */
function firstReviewIndex(records, pr, head) {
  // Only the marker name the shared parser reads counts (an earlier anchor raises the cap); an abbreviated marker
  // does not anchor, which only lowers it.
  const reviewed = body => [...body.matchAll(REVIEWED_SHA_FULL_RE)].some(([, s]) => s.toLowerCase() === head);
  const first = records.find(r => {
    const result = parseRedTeamComment(recordBody(r));
    return (result?.pr === Number(pr) && result.rev === head) || reviewed(recordBody(r));
  });
  return first ? first.at : null;
}

/**
 * Did the operator rule on the head's confirmed breaks? The gate handed THIS result over (a `round-cap` record that
 * decides it), and a trusted clear-human ceremony for that head came after the result and every send-back/cap record.
 * Only the ceremony's own comment counts: a restamp repeats the cleared-human marker for a ruling made on another
 * head. A carried result defers to the ruling on the head it was carried from, read from the thread before the carry.
 * PURE.
 */
/** Gate decisions that (re)hold a break: a clearance before any of them never approves it. An operator `block`
 *  (`operator-block`) is one, so a block after a clear-human ceremony re-holds (any author: it only adds a hold). */
const HOLDING_OUTCOMES = Object.freeze([GATE_OUTCOMES.ROUND_CAP, GATE_OUTCOMES.SENT_BACK, 'operator-block']);
function operatorRuled(records, pr, head) {
  const trusted = records.filter(r => r.saved || isTrustedMarkerAuthor(r.c));
  if (parseLatestHumanClearedSha(trusted.filter(r => !r.from).map(r => r.c)) !== head) return false;
  const lastAt = (rs, test) => rs.reduce((found, r) => (test(r) ? r : found), null);
  const rulingHeads = new Set();
  // Each carry removes its own comment and every later record, so even a cyclic head chain terminates.
  for (let sha = head, rs = trusted, want = null; sha && rs.length;) {
    const result = latestResult(rs, pr, sha);
    // A carry hop counts only when the prior head's result is the one that was carried (same id).
    if (!result || (want && redTeamResultId(result.parsed) !== want)) return false;
    rulingHeads.add(sha);
    want = redTeamResultId(result.parsed);
    const gates = gateRecordsFor(rs, pr, sha, result);
    const cap = gates.filter(r => r.gate.outcome === GATE_OUTCOMES.ROUND_CAP).sort(threadOrder).at(-1);
    // Saved-only evidence retains the legacy trusted clear-human ceremony. Posted results require the human
    // operator's own comment; neither path accepts a carried restamp or bypasses the result/hold chronology below.
    const cleared = lastAt(rs, r => !r.from && (result.saved || isHumanOperatorComment(r.c)) && CLEAR_HUMAN_RULING_RE.test(recordBody(r).replace(/\r\n/g, '\n').trimStart())
      && parseLatestHumanClearedSha([r.c]) === sha);
    // A clearance cannot approve a later send-back, even if an older/unknown grant snapshot leaves the cap winning.
    // This also keeps existing send-backs held while persisted grant identities migrate to a reader-independent key.
    // A plain accept of ANY head in this proven carry chain after the ceremony supersedes it.
    // Scan the whole thread: accepts before or after a carry must survive its historical truncation.
    // The marker may name a head abbreviated (7–40 hex, any case), as its builder and parser allow: a prefix match supersedes.
    const reviewed = body => [...body.matchAll(REVIEWED_SHA_ANY_RE)]
      .some(([, s]) => [...rulingHeads].some(h => h.startsWith(s.toLowerCase())));
    const reaccepted = cleared && trusted.some(r => !r.from && r.at > cleared.at && parseLatestHumanClearedSha([r.c]) === null
      && reviewed(recordBody(r)));
    if (cap && cleared && !reaccepted && cleared.at > result.at && gates.every(r =>
      !HOLDING_OUTCOMES.includes(r.gate.outcome) || cleared.at > r.at)) return true;
    // A ruling inherited through a carry cannot approve this head's own later gate decisions.
    if (gates.some(r => !r.from && HOLDING_OUTCOMES.includes(r.gate.outcome))) return false;
    if (!result.from) return false;
    rs = rs.filter(r => r.at < result.at);
    sha = result.from;
  }
  return false;
}


/**
 * buildGateComment's per-finding action lines, each matched as a whole line. Indices come only from the action's own
 * `(#N, …)` list, never from a landing-job or failure text. A failed card filing matches nothing. A round-cap line
 * without a list is the older record shape.
 */
const INDEX_LIST = '\\((#\\d+(?:, #\\d+)*)\\)';
const GATE_ACTION_LINES = [
  ['card', new RegExp(`^- \\d+ finding\\(s\\) filed as a follow-up card ${INDEX_LIST}(?: — landing job [^\\n]*)?\\.$`)],
  ['card', new RegExp(`^- \\d+ finding\\(s\\) recorded, owed as a follow-up card ${INDEX_LIST} — filing paused; will file on resume\\.$`)],
  // OPERATOR-ONLY (`record-red-team-ruling --card=<ref>`): it counts (as `card`) only inside an `operator-*` record a human operator authored, whatever wraps it.
  ['operator-card', new RegExp(`^- \\d+ finding\\(s\\) carded by the operator to \`[^\`\\n]+\` ${INDEX_LIST}\\.$`)],
  ['advisory', new RegExp(`^- \\d+ finding\\(s\\) left advisory ${INDEX_LIST}\\.$`)],
  ['send-back', new RegExp(`^- \\d+ confirmed break\\(s\\) sent back to the fixer ${INDEX_LIST}(?: — the PR was already under review:changes)?\\.$`)],
  ['held', new RegExp(`^- \\d+ confirmed break\\(s\\) NOT sent back: [^\\n]*?(?: ${INDEX_LIST})?\\.$`)],
];

/** Action lines that release a finding from the send-back / held set. */
const RELEASING_ACTIONS = new Set(['card', 'advisory']);
/** The outcomes automation records for decisions the gate itself made; any other release needs a human operator author. */
const AUTOMATION_RELEASE_OUTCOMES = new Set([GATE_OUTCOMES.SENT_BACK, GATE_OUTCOMES.CARD_QUEUED]);

/** PURE: the action lines of ONE gate record, read only from the block right after its marker (and heading). */
function gateActionLines(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').trimStart().split('\n');
  const found = [];
  for (let i = lines[1]?.startsWith('**Red-team gate** ') ? 2 : 1; i < lines.length && lines[i].startsWith('- '); i++) {
    const hit = GATE_ACTION_LINES.map(([action, re]) => [action, re.exec(lines[i])]).find(([, m]) => m);
    if (hit) found.push({ action: hit[0], indices: hit[1][1] ? hit[1][1].split(', ').map(s => Number(s.slice(1))) : [] });
  }
  return found;
}

/** Shared live-head disposition reader. Recorded per-finding actions override today's policy.
 * Without a recorded action, policy send-back candidates still block admission while the gate acts: a missing gate
 * record keeps holding. Older round-cap records omit indices: all remaining send-back candidates belong to the operator.
 * Every gate decision (per-finding actions, the send-back outcome, the round-cap hand-over) applies only to the result
 * it decides ({@link gateRecordsFor}), so a record for an earlier same-head result never releases a newer one's
 * finding. A carried result also keeps the actions bound to the result it was carried from (the same findings,
 * re-keyed); the newer head's own records win. Operator card actions require an explicit matching result id and
 * a direct human record; an earlier head's release carries only with the cited-line proof and carry policy below.
 * With any-state rulings disabled, an operator ruling releases only what the gate handed over (`held`).
 */
export function readRedTeamDisposition({ comments, pr, head, setting, env = process.env, savedResult = null, repo = null, standingRuling = null, operatorRulings } = {}) {
  const live = String(head ?? '').toLowerCase();
  const records = indexedRecords(comments, savedResult);
  const result = latestResult(records, pr, live)?.parsed ?? null;
  const plan = planRedTeamActions(result, setting ?? readConfirmedBreaks({ env }).value);
  const rulingScope = operatorRulings ?? readOperatorRulings({ env }).value;
  const anyState = rulingScope.anyState !== false;
  const carryRulings = rulingScope.carryAcrossRebase !== false;
  const actions = new Map();
  // The breaks whose operator release may still count on the hop being read (null on the live head = all of them).
  let carryAllowed = null;
  const grants = gateRoundGrants(comments, pr, repo, standingRuling);
  let legacyHeld = false, liveGates = [];
  // Each carry removes its own comment and every later record, so even a cyclic head chain terminates.
  for (let sha = live, rs = records, first = true, want = null; sha && rs.length; first = false) {
    const hit = latestResult(rs, pr, sha);
    // A carry hop counts only when the prior head's result is the one that was carried (same id).
    if (!hit || (want && redTeamResultId(hit.parsed) !== want)) break;
    want = redTeamResultId(hit.parsed);
    const gates = gateRecordsFor(rs, pr, sha, hit);
    if (first) liveGates = gates;
    const { supersededCaps } = resolveSendBackStep(gates, grants);
    const own = new Map();
    // Kill switch off: the gate handed this result to the operator only if its send-back step ended at the round cap.
    const handedOver = sendBackStepState(gates, grants).outcome === GATE_OUTCOMES.ROUND_CAP;
    for (const r of gates) {
      for (const line of gateActionLines(recordBody(r))) {
        const { indices } = line;
        let { action } = line;
        if (action === 'operator-card') {
          // Operator card releases bind to an exact head/result, never a synthetic carried record.
          // Historical direct rulings require the explicit carry policy and cited-line proof;
          // the per-index guard below restricts the release to the proven findings.
          if (r.from || r.gate.result !== want || (!first && !(carryRulings && carryAllowed?.size))) continue;
          if (!r.gate.outcome.startsWith('operator-') || !isHumanOperatorComment(r.c)) continue;
          // Validate ownership when the ruling was posted, not against later handovers or grants.
          // In cap-only mode, use the writer's grant-aware decision: a pending extension belongs to automation.
          const prior = sendBackStepState(gates.filter(g => g.at < r.at), grants.filter(g => g.index < r.at));
          if (r.at <= hit.at || (!anyState && (prior.outcome !== GATE_OUTCOMES.ROUND_CAP || prior.reopened))) continue;
          action = 'card';
        }
        // Only a human operator may release a break held at the round cap; automation lines release only what the gate itself decided.
        // This is applied per action line (not by dropping the forged comment, which would also drop its restrictive `held` lines).
        const operatorRelease = RELEASING_ACTIONS.has(action) && !AUTOMATION_RELEASE_OUTCOMES.has(r.gate.outcome);
        if (operatorRelease && !isHumanOperatorComment(r.c)) continue;
        if (action === 'held' && !indices.length) legacyHeld = true;
        for (const index of indices) {
          // An operator release made on an EARLIER head counts only where the carry proved this break's cited line unchanged.
          if (operatorRelease && !first && !(carryRulings && carryAllowed?.has(index))) continue;
          // Kill switch off: an operator release cannot override a recorded send-back the fixer still owns (not at the cap).
          if (operatorRelease && !anyState && own.get(index) === 'send-back' && !handedOver) continue;
          // A stale cap POST cannot overwrite the per-finding send-back that superseded its decision.
          if (action === 'held' && own.get(index) === 'send-back' && supersededCaps.has(r)) continue;
          own.set(index, action);
        }
      }
    }
    for (const [index, action] of own) if (!actions.has(index)) actions.set(index, action);
    if (!hit.from) break;
    const proven = carryLinesFor(records, pr, hit.from, sha, want);
    carryAllowed = carryAllowed === null ? proven : new Set([...carryAllowed].filter((i) => proven.has(i)));
    rs = rs.filter(r => r.at < hit.at);
    sha = hit.from;
  }
  const capRecord = liveGates.filter(r => r.gate.outcome === GATE_OUTCOMES.ROUND_CAP).sort(threadOrder).at(-1)?.c ?? null;
  // Audited grants unseen by the cap decision let a later send-back stand, even if the cap POST arrives last.
  // Without a repo there is no grant credit and the cap keeps winning.
  const outcome = sendBackStepState(liveGates, grants).outcome;
  const ruled = operatorRuled(records, pr, live);
  const sendBack = [], held = [];
  for (const f of result?.findings ?? []) {
    const recorded = actions.get(f.index);
    // Two raced gate runs can record both send-back and round-cap for one result; the cap wins (sendBackStepOutcome).
    const action = (recorded === 'send-back' && outcome === GATE_OUTCOMES.ROUND_CAP ? 'held' : recorded)
      ?? (legacyHeld && f.confirmed ? 'held' : null) ?? (plan.sendBack.includes(f)
        ? outcome === GATE_OUTCOMES.ROUND_CAP ? 'held' : 'send-back' : null);
    if (action === 'held' && !ruled) held.push(f);
    if (action === 'send-back') sendBack.push(f);
  }
  return { result, sendBack, held, since: commentCreatedAt(capRecord) ?? null, outcome };
}

/**
 * The live head's latest result; per finding the actions a HUMAN OPERATOR's named gate record (`operator-*`,
 * `result=` this result) took on it, in thread order; and every finding ANY trusted record already carded for this
 * result (the gate's own card filing too). `record-red-team-ruling` dedups on this (no second card). PURE.
 * @returns {{resultId:(string|null), ruled:Map<number, string[]>, carded:Set<number>}}
 */
export function operatorRulingsOnLiveResult(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  const records = indexedRecords(comments);
  const hit = latestResult(records, pr, live);
  const ruled = new Map();
  const carded = new Set();
  if (!hit) return { resultId: null, ruled, carded };
  const id = redTeamResultId(hit.parsed);
  for (const r of gateRecordsFor(records, pr, live, hit).sort(threadOrder)) {
    const human = isHumanOperatorComment(r.c);
    const operator = r.gate.outcome.startsWith('operator-') && human && r.gate.result === id;
    for (const { action, indices } of gateActionLines(recordBody(r))) {
      const card = action === 'card' || action === 'operator-card';
      if (card && (AUTOMATION_RELEASE_OUTCOMES.has(r.gate.outcome) || operator)) for (const index of indices) carded.add(index);
      if (!operator) continue;
      const a = action === 'operator-card' ? 'card' : action;
      for (const index of indices) ruled.set(index, [...(ruled.get(index) ?? []), a]);
    }
  }
  return { resultId: id, ruled, carded };
}

/**
 * Version guard for the derived `red-team:*` label writers (live #5502, 2026-10-21 17:07 ET: a pass daemon on an OLDER
 * clone re-derived `red-team:blocked` over an operator ruling its reader did not understand). The `operator-*` gate
 * outcomes THIS reader understands; a trusted record on the live head with any other `operator-*` outcome was written
 * by a newer reader, so a label writer on this code must not re-derive the label. PURE.
 */
export const READER_OPERATOR_OUTCOMES = Object.freeze(['operator-card', 'operator-not-real', 'operator-block']);
export function unknownOperatorOutcomes(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  const out = new Set();
  for (const c of Array.isArray(comments) ? comments : []) {
    const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
    if (m && m.pr === Number(pr) && m.rev === live && m.outcome.startsWith('operator-') && !READER_OPERATOR_OUTCOMES.includes(m.outcome)
      && isTrustedMarkerAuthor(c)) out.add(m.outcome);
  }
  return [...out];
}

/**
 * The record the verdict carry (review-job carryAcrossRebase) posts beside its carry comment: for the carried result,
 * which breaks' cited `file:line` is byte-identical on the old and new head. Only these may keep an operator release
 * across the carry. A break with no cited file/line, or a changed line, is never listed (fail closed). PURE.
 */
export const RED_TEAM_CARRY_LINES_MARKER = '<!-- we:red-team-carry-lines';
export function redTeamCarryLinesMarker({ pr, from, to, result, unchanged }) {
  const list = [...new Set(unchanged ?? [])].map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  return `${RED_TEAM_CARRY_LINES_MARKER} pr=${Number(pr)} from=${String(from).toLowerCase()} to=${String(to).toLowerCase()} result=${result} unchanged=${list.join(',') || 'none'} -->`;
}
export function parseRedTeamCarryLinesMarker(body) {
  const m = /^<!-- we:red-team-carry-lines pr=(\d+) from=([0-9a-f]{40}) to=([0-9a-f]{40}) result=([0-9a-f]{16}) unchanged=(none|\d+(?:,\d+)*) -->/.exec(String(body ?? '').trimStart());
  return m ? { pr: Number(m[1]), from: m[2], to: m[3], result: m[4], unchanged: m[5] === 'none' ? [] : m[5].split(',').map(Number) } : null;
}
/** The indices a trusted carry-lines record proves unchanged for this exact hop and result (intersection when several). PURE. */
function carryLinesFor(records, pr, from, to, result) {
  let out = null;
  for (const r of records) {
    if (r.from || r.saved) continue;
    const m = parseRedTeamCarryLinesMarker(recordBody(r));
    if (!m || m.pr !== Number(pr) || m.from !== from || m.to !== to || m.result !== result) continue;
    out = out === null ? new Set(m.unchanged) : new Set([...out].filter((i) => m.unchanged.includes(i)));
  }
  return out ?? new Set();
}

/** Which confirmed findings' cited line is byte-identical on two heads. `readLine(sha, file, line)` returns the line
 *  text or null (missing file/line); any null on either side, or no cited file/line, is "changed". PURE given the reader. */
export function unchangedCitedLines(findings, { fromSha, toSha, readLine }) {
  const out = [];
  for (const f of findings ?? []) {
    if (!f?.file || !Number.isInteger(f.line) || f.line < 1) continue;
    let a = null, b = null;
    try { a = readLine(fromSha, f.file, f.line); b = readLine(toSha, f.file, f.line); } catch { continue; }
    if (typeof a === 'string' && typeof b === 'string' && a === b) out.push(f.index);
  }
  return out;
}
