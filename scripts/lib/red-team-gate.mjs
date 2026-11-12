import { FINDING_CLASSES, allClasses, classAction, readFindingClassPolicy, validAlsoClasses } from './finding-class-policy.mjs';
import { scrubPublish } from './secret-scrub.mjs';
import { readSealedStatus } from './red-team-sealed-status.mjs';
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
import { resolveDisposition } from './red-team-disposition.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { isHumanOperatorComment, isRulingComment, judgePolicyOnce } from './operator-identity.mjs';

import { parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
import { parseLatestHumanClearedSha, REVIEWED_SHA_MARKER } from './review-escalation.mjs';
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
// Any line that LOOKS like a finding (leading whitespace, any case, loose punctuation). Used only to key the result
// digest, never to decide what blocks: a line the strict FINDING_RE skips still changes the digest.
// Include repeated/mixed Markdown emphasis; a closing underscore is a word character, so also allow it at the boundary.
const FINDING_SHAPED_RE = /^\s*\d+\s*[.)]\s*\[\s*[*_]*\s*(?:confirmed|not confirmed|unverifiable)(?:\b|_)/i;
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
  const shapedLines = [];
  for (const line of text.split('\n')) {
    if (FINDING_SHAPED_RE.test(line) && !FINDING_RE.test(line)) shapedLines.push(line.trim());
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
    if (line === '   - Security class: security-reachable-today' && findings.length)
      findings.at(-1).securityReachableToday = true;
    const also = /^ {3}- Also class: ([a-z-]+(?:, [a-z-]+)*)$/.exec(line);
    if (also && findings.length) findings.at(-1).alsoClasses = also[1].split(', ').filter(c => FINDING_CLASSES.includes(c));
    const classification = /^ {3}- Class: (.*?) → (?:fix-now|defer-card)(?: \(basis: (.*)\))?$/.exec(line);
    if (classification && findings.length) {
      findings.at(-1).findingClass = classification[1].trim();
      if (classification[2] !== undefined) findings.at(-1).classBasis = classification[2].trim();
    }
    const s = SUB_RE.exec(line);
    if (s && findings.length) findings.at(-1)[s[1] === 'Scenario' ? 'scenario' : 'recheck'] = s[2].trim();
  }
  const parsed = { pr: Number(m[1]), rev: m[2].toLowerCase(), findings };
  // Non-enumerable: it only keys the digest and must not change the parsed shape callers compare or serialise.
  Object.defineProperty(parsed, 'shapedLines', { value: shapedLines, enumerable: false });
  return parsed;
}

/**
 * The id a gate record names its result by: a digest of the parsed findings, not of the head, so a result carried
 * across an identical contribution keeps its id. Two results with identical findings share one decision. It hashes a
 * fixed, versioned list of fields, so adding a parser field never silently re-keys every recorded decision. PURE.
 */
const RESULT_ID_FIELDS = ['index', 'confirmed', 'recheckOutcome', 'category', 'impact', 'file', 'line', 'summary', 'scenario', 'recheck'];
export function redTeamResultId(parsed) {
  if (!parsed) return null;
  const security = (parsed.findings ?? []).some(f => f?.securityReachableToday === true);
  const classified = security || (parsed.findings ?? []).some(f => f?.findingClass != null);
  const also = (parsed.findings ?? []).some(f => f?.alsoClasses?.length);
  const fields = classified ? [...RESULT_ID_FIELDS, 'findingClass', 'classBasis', ...(security ? ['securityReachableToday'] : []), ...(also ? ['alsoClasses'] : [])] : RESULT_ID_FIELDS;
  const findings = (parsed.findings ?? []).map(f => fields.map(k => f?.[k] ?? null));
  // A finding-shaped line the strict parser skipped (indented, other case, malformed) also keys the result, so adding
  // one re-keys it and voids every record for the old id (fail closed). A result with none keeps its v1 id, so existing
  // records, operator rulings included, keep applying to results nobody has tampered with.
  const extra = Array.isArray(parsed.shapedLines) ? parsed.shapedLines : [];
  return createHash('sha256').update(JSON.stringify(classified ? ['v3', findings, extra] : extra.length ? ['v2', findings, extra] : ['v1', findings])).digest('hex').slice(0, 16);
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

/** Read the live setting. By default unreadable files use defaults; strict reads only tolerate ENOENT. */
export function readConfirmedBreaks({ env = process.env, path = RED_TEAM_SETTINGS_FILE, strict = false } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    file = {};
  }
  const resolved = resolveConfirmedBreaks({ file, env });
  return { ...resolved, value: { ...resolved.value, findingClasses: readFindingClassPolicy({ env }) } };
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
 * `redTeam.operatorRulings.anyState` (default false; opt in via setting or env {@link OPERATOR_RULINGS_ENV}=true): may an
 * OPERATOR ruling (`record-red-team-ruling`, a human operator account) rule on a confirmed break in ANY state of the
 * live result (at the round cap, sent back, or carded)? By default the CLI refuses a result not parked at the cap,
 * and this reader requires that handover for every operator release while retaining legacy card/advisory
 * record semantics. Automation never gets this: an operator release counts only from a human operator. */
export const OPERATOR_RULINGS_DEFAULTS = Object.freeze({ anyState: false });
export const OPERATOR_RULINGS_ENV = 'WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE';
const envBool = (raw) => {
  const v = raw === undefined || raw === '' ? undefined : String(raw).trim().toLowerCase();
  return v === undefined ? undefined : ['true', 'on', '1'].includes(v) ? true : ['false', 'off', '0'].includes(v) ? false : raw;
};
export function resolveOperatorRulings({ file = {}, platform, env = {} } = {}) {
  const pick = (o) => Object.fromEntries(Object.keys(OPERATOR_RULINGS_DEFAULTS)
    .filter((k) => o?.operatorRulings?.[k] !== undefined).map((k) => [k, o.operatorRulings[k]]));
  return resolveCascade({ standard: OPERATOR_RULINGS_DEFAULTS, platform: pick(platform), tool: pick(file?.redTeam),
    envValues: { anyState: envBool(env[OPERATOR_RULINGS_ENV]) },
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

// ── The decision ────────────────────────────────────────────────────────────────────────────────────────────────

/** A finding's class. Fail closed: confirmed with no stated (or an unknown) impact is `broken`. PURE. */
export function breakClass(f) {
  if (!f?.confirmed) return 'unconfirmed';
  if (f.impact === 'degraded' || f.impact === 'cosmetic') return 'degraded';
  return 'broken';
}

/**
 * The carded findings that ONLY class deferral authorized: ordinary confirmedBreaks policy (every class fix-now)
 * would not have carded them. The gate records these indices (`class=` on its marker) so a later read revokes
 * exactly those cards when the deferral is revoked, and never an ordinary-policy card. PURE.
 */
export function classOnlyCards(cards, setting = CONFIRMED_BREAKS_DEFAULTS) {
  return (cards ?? []).filter(f => (f.findingClass || f.securityReachableToday)
    && !planRedTeamActions({ findings: [f] }, { ...setting,
      findingClasses: Object.fromEntries((allClasses(f).length ? allClasses(f) : [f.findingClass]).map(c => [c, 'fix-now'])) }).card.includes(f));
}

/**
 * What to do with one parsed comment under the setting. PURE.
 * @returns {{sendBack:object[], card:object[], advisory:object[]}}
 */
export function planRedTeamActions(parsed, setting = CONFIRMED_BREAKS_DEFAULTS) {
  const out = { sendBack: [], card: [], advisory: [] };
  const findingClasses = setting.findingClasses ?? readFindingClassPolicy();
  for (const f of parsed?.findings ?? []) {
    const base = setting[breakClass(f)] ?? CONFIRMED_BREAK_ACTIONS.ADVISORY;
    const deferred = classAction(f, findingClasses) === 'defer-card';
    // Class deferral cards only what the re-check confirmed; an unconfirmed finding is never carded by class, and
    // deferral can only soften its send-back to advisory.
    const action = !deferred ? base
      : breakClass(f) !== 'unconfirmed' ? CONFIRMED_BREAK_ACTIONS.CARD
        : base === CONFIRMED_BREAK_ACTIONS.SEND_BACK ? CONFIRMED_BREAK_ACTIONS.ADVISORY : base;
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
 * operator rules instead); the card step records `card-queued`, and only after the landing job was really spawned
 * (a spawn is all the shared seam reports: whether the detached job later lands the card is that job's own concern).
 * `no-send-back` is only ever a RESULT label (nothing to send back); it is never recorded.
 */
export const GATE_OUTCOMES = Object.freeze({ SENT_BACK: 'sent-back', ROUND_CAP: 'round-cap', NOTHING_TO_SEND: 'no-send-back', CARD_QUEUED: 'card-queued' });

/** `result` names the decided result ({@link redTeamResultId}). `grantIds` records the send-back step's grant
 * snapshot, not its POST time. Older records omit these fields. */
export function redTeamGateMarker(pr, rev, outcome, result = null, grantIds = null, classCards = null) {
  const cls = [...new Set((classCards ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return `${RED_TEAM_GATE_MARKER} pr=${Number(pr)} rev=${String(rev).toLowerCase()} outcome=${outcome}${result ? ` result=${result}` : ''}${grantIds ? ` grants=${grantIds.join(',') || 'none'}` : ''}${cls.length ? ` class=${cls.join(',')}` : ''} -->`;
}

/** PURE: parse the anchored gate marker, shared by gate reads and verdict carry. `grants=` takes any number of ids:
 * the writer records every grant it read, so a count bound here would make a valid record unreadable (fail-open). */
export function parseRedTeamGateMarker(body) {
  const m = /^<!-- we:red-team-gate pr=(\d+) rev=([0-9a-f]{40}) outcome=([a-z-]+)(?: result=([0-9a-f]{16}))?(?: grants=(none|[0-9a-f]{16}(?:,[0-9a-f]{16})*))?(?: class=([1-9]\d*(?:,[1-9]\d*)*))?(?: actor=([^\s]+))? -->/.exec(String(body ?? '').trimStart());
  return m ? { pr: Number(m[1]), rev: m[2], outcome: m[3], ...(m[4] ? { result: m[4] } : {}), ...(m[7] ? { actor: m[7] } : {}),
    ...(m[5] ? { grantIds: m[5] === 'none' ? [] : m[5].split(',') } : {}),
    ...(m[6] ? { classCards: m[6].split(',').map(Number) } : {}) } : null;
}

/** Every outcome the gate recorded for this head (trusted authors only). PURE. */
export function gateOutcomesForHead(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  const found = new Set();
  const policy = judgePolicyOnce();
  for (const c of Array.isArray(comments) ? comments : []) {
    const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
    if (m && m.pr === Number(pr) && m.rev === live && isTrustedMarkerAuthor(c) && (m.actor === undefined || isRulingComment(c, policy))) found.add(m.outcome);
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


/** Confirmed send-back findings parked at the round cap on the live head, awaiting an operator ruling. PURE. */
export function redTeamRulingNeeded(pr, setting = CONFIRMED_BREAKS_DEFAULTS, { repo = pr?.repo ?? null, standingRuling = pr?.standingRuling ?? null } = {}) {
  const disposition = readRedTeamDisposition({ comments: pr?.comments, pr: pr?.number, head: pr?.headRefOid, setting, repo, standingRuling });
  // A hold that is only "publication pending" (PR #6622: stored evidence not sealed yet, no conflict found) is no break
  // and asks no ruling; like every other caller ({@link redTeamHoldPendingOnly}) it is never reported as one. It still
  // holds every merge path (the drain enqueue hold, the operator queue, red-team:pending). A real conflict is reported.
  const held = disposition.held.filter(f => f.unsealed !== true);
  if (!held.length) return null;
  const labels = (pr?.labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
  if (labels.includes('review:changes')) return null;
  return { head: disposition.result?.rev ?? String(pr?.headRefOid ?? '').toLowerCase(), since: disposition.since, findings: held.map(({ index, file, line, summary, category, impact }) => ({ index, file, line, summary, category, impact })) };
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
  // `ruling` (is this record a ruling a gate reader honours) is decided ONCE per record, with one judge-policy read
  // for the whole pass (#6494 F2); every reader below uses it instead of re-deciding per comment.
  const policy = judgePolicyOnce();
  const rec = (c, at, from) => ({ c, at, ...(from !== undefined ? { from } : {}), ruling: isRulingComment(c, policy) });
  return (Array.isArray(comments) ? comments : []).flatMap((c, at) => {
    if (!isTrustedMarkerAuthor(c)) return [];
    const gate = parseRedTeamGateMarker(c?.body);
    if (gate?.actor !== undefined && !isRulingComment(c, policy)) return [];
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
    })) return [rec(c, at)];
    const parts = [...lines.slice(0, k), advisoryBody];
    return [rec(c, at), ...parts.map(part => rec({ ...c, body: part }, at, carried.fromSha))];
  });
}

const recordBody = r => String((typeof r.c === 'string' ? r.c : r.c?.body) ?? '');
/** Thread order: creation time, then thread position. A record without a time takes the time of the record before it,
 * so the key is total (a sort never meets a contradiction). PURE. */
const threadOrder = (a, b) => a.ts - b.ts || a.i - b.i;
const indexedRecords = comments => {
  let ts = 0;
  return threadRecords(comments).map((r, i) => {
    const t = Date.parse(commentCreatedAt(r.c)); // GraphQL `createdAt` or raw REST `created_at` (the drain's read)
    if (Number.isFinite(t)) ts = t;
    return { ...r, i, ts };
  });
};

/** The newest trusted red-team result for this PR and head among the records, or null. PURE. */
function latestResult(records, pr, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  return records.map(r => ({ ...r, parsed: parseRedTeamComment(recordBody(r)) }))
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
    if (gate?.pr !== Number(pr) || gate.rev !== sha || (gate.actor !== undefined && !r.ruling)) return [];
    if (gate.actor !== undefined && gateActionLines(recordBody(r)).some(line => !['send-back', 'held'].includes(line.action))) return [];
    const decides = gate.result ? gate.result === id
      : threadOrder(r, hit) > 0 || (r.from != null && hit.from != null && r.at === hit.at);
    return decides ? [{ ...r, gate }] : [];
  });
}

/**
 * The live head's latest red-team result (carried ones included) and the outcomes the gate recorded for THAT result.
 * The gate dedups on this, so a record for an earlier same-head result never stops it deciding a newer one. PURE.
 */
export function liveResultGateState(comments, pr, head, repo = null, standingRuling = null) {
  const live = String(head ?? '').toLowerCase();
  const records = indexedRecords(comments);
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

/** Gate decisions that (re)hold a break; operator-block records from any author only add a hold. */
const HOLDING_OUTCOMES = Object.freeze([GATE_OUTCOMES.ROUND_CAP, GATE_OUTCOMES.SENT_BACK, 'operator-block']);
/**
 * Did the operator rule on the head's confirmed breaks? The gate handed THIS result over (a `round-cap` record that
 * decides it), and a trusted clear-human ceremony for that head came after the result and every send-back/cap record.
 * Only the ceremony's own comment counts: a restamp repeats the cleared-human marker for a ruling made on another
 * head. A carried result defers to the ruling on the head it was carried from, read from the thread before the carry.
 * Returns the validated ceremony record, or false. PURE.
 */
const reviewedShaOf = body => [...body.matchAll(REVIEWED_SHA_ANY_RE)].map(m => m[1].toLowerCase()).at(-1) ?? null;
function operatorRuled(records, pr, head, index) {
  const trusted = records.filter(r => isTrustedMarkerAuthor(r.c));
  if (parseLatestHumanClearedSha(trusted.filter(r => !r.from).map(r => r.c)) !== head) return false;
  const lastAt = (rs, test) => rs.reduce((found, r) => (test(r) ? r : found), null);
  // A per-finding block supersedes the standing clearance only for its named holds.
  const holds = r => HOLDING_OUTCOMES.includes(r.gate.outcome) && (r.gate.outcome !== 'operator-block'
    || gateActionLines(recordBody(r)).some(({ action, indices }) => (action === 'send-back' || action === 'held') && (!indices.length || indices.includes(index))));
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
    // Only a human operator's own clear-human comment is a ruling; an automation-posted copy (even by a trusted bot) is not.
    const cleared = lastAt(rs, r => !r.from && isHumanOperatorComment(r.c) && CLEAR_HUMAN_RULING_RE.test(recordBody(r).replace(/\r\n/g, '\n').trimStart())
      && parseLatestHumanClearedSha([r.c]) === sha);
    // A clearance cannot approve a later send-back, even if an older/unknown grant snapshot leaves the cap winning.
    // This also keeps existing send-backs held while persisted grant identities migrate to a reader-independent key.
    // A plain accept of ANY head in this proven carry chain after the ceremony supersedes it. (One of an unrelated
    // head already ended the clearance in the shared parser, so this function returned false above.)
    // Scan the whole thread: accepts before or after a carry must survive its historical truncation.
    // The marker may name a head abbreviated (7–40 hex, any case), as its builder and parser allow: a prefix match supersedes.
    const reviewed = body => [...body.matchAll(REVIEWED_SHA_ANY_RE)]
      .some(([, s]) => [...rulingHeads].some(h => h.startsWith(s.toLowerCase())));
    const reaccepted = cleared && trusted.some(r => !r.from && r.at > cleared.at && reviewed(recordBody(r))
      // R706: a restamp is a plain accept unless it is a PROVEN carrier, which only the thread up to it can show
      // (it cites the original human comment); a single comment alone never proves it.
      && !(parseLatestHumanClearedSha([r.c]) !== null
        || (r.c && parseLatestHumanClearedSha(trusted.filter(x => !x.from && x.at <= r.at).map(x => x.c)) === reviewedShaOf(recordBody(r)))));
    if (cap && cleared && !reaccepted && cleared.at > result.at && gates.every(r =>
      !holds(r) || cleared.at > r.at)) return cleared;
    // A ruling inherited through a carry cannot approve this head's own later gate decisions.
    if (gates.some(r => !r.from && holds(r))) return false;
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
  let start = 1;
  const attribution = /^Ruled by acting judge \(R10\), not the operator(?: \(judge:r10\))?$/;
  if (attribution.test(lines[start] ?? '')) start++;
  if (lines[start]?.startsWith('**Red-team gate** ')) start++;
  if (attribution.test(lines[start] ?? '')) start++;
  for (let i = start; i < lines.length && lines[i].startsWith('- '); i++) {
    const hit = GATE_ACTION_LINES.map(([action, re]) => [action, re.exec(lines[i])]).find(([, m]) => m);
    if (hit) found.push({ action: hit[0], indices: hit[1][1] ? hit[1][1].split(', ').map(s => Number(s.slice(1))) : [] });
  }
  return found;
}

// ── One hold decision (PR #6622): the sealed stored evidence is the authority, a posted comment only adds holds ──

const flatText = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const WITHHELD_TEXT = '[withheld: failed the secret scrub]';
/** The text the comment renderer would publish for a model field: scrubbed, clipped to 600, one line. */
const publishedText = v => v == null ? null : flatText(scrubPublish(String(v)).length ? WITHHELD_TEXT : String(v).slice(0, 600));
const breakKey = b => JSON.stringify([b.category, b.impact, b.file, b.line, b.summary, b.scenario || null,
  b.findingClass ?? null, b.classBasis ?? null, [...(b.alsoClasses ?? [])].sort(), b.security === true]);

/**
 * THE projection mask for a seat-posted result (PR #6622): its stored findings keep only category, file, line, summary
 * and the confirmed flag (review-job's status projection), so both sides are compared on exactly those fields: impact,
 * scenario, class, basis, extra classes and the security flag are masked out. Applied to BOTH sides after the shared
 * normalizers, never to a seal (a seal compares whole bodies). PURE.
 */
export function projectedBreakKeys(keys) {
  return (keys ?? []).map(k => { const [category, , file, line, summary] = JSON.parse(k);
    return JSON.stringify([category, file, line, summary]); }).sort();
}

/**
 * SHARED NORMALIZER, stored side: the confirmed breaks of stored findings (seat row or result), each reduced to the
 * fields a posted comment shows (category, impact, file, line, summary, scenario, class, classBasis, extra classes,
 * security flag) exactly as the renderer would write them. Order-free. PURE.
 */
export function sealedBreakKeys(findings) {
  const cls = v => flatText(publishedText(v)).replace(/[(),]/g, ' ').trim();
  return (Array.isArray(findings) ? findings : []).filter(f => f && (f.confirmedByRecheck === true || f.confirmed === true))
    .map(f => {
      // Exactly the fields the full renderer reads (`impactIfUnfixed`, `failure_scenario`), never an alias it ignores:
      // an alias would make the publisher's own faithful comment disagree with its seal forever.
      const impact = cls(f.impactIfUnfixed) || 'impact?';
      return breakKey({ category: flatText(cls(f.category) || 'uncategorised'), impact: impact === 'impact?' ? null : flatText(impact),
        file: f.file ? flatText(publishedText(f.file)).replaceAll('`', "'") : null,
        line: f.file && Number.isInteger(f.line) ? f.line : null, summary: flatText(publishedText(f.summary)),
        scenario: f.failure_scenario ? flatText(publishedText(f.failure_scenario)) : null,
        findingClass: FINDING_CLASSES.includes(f.findingClass) ? f.findingClass : null,
        classBasis: FINDING_CLASSES.includes(f.findingClass) && typeof f.classBasis === 'string' ? flatText(publishedText(f.classBasis)) : null,
        alsoClasses: f.findingClass ? validAlsoClasses(f.alsoClasses, f.findingClass) : [],
        security: f.securityReachableToday === true });
    }).sort();
}

/** SHARED NORMALIZER, posted side: the same keys read back from a PARSED red-team comment. PURE. */
export function postedBreakKeys(parsed) {
  return (parsed?.findings ?? []).filter(f => f.confirmed).map(f => breakKey({ category: flatText(f.category),
    impact: f.impact == null ? null : flatText(f.impact), file: f.file ?? null, line: f.line ?? null, summary: flatText(f.summary),
    scenario: f.scenario ? flatText(f.scenario) : null, findingClass: f.findingClass ?? null, classBasis: f.classBasis ?? null,
    alsoClasses: f.alsoClasses ?? [], security: f.securityReachableToday === true })).sort();
}

/**
 * THE hold decision. `sealed` is the stored evidence for this exact head ({@link readSealedStatus}). When it holds a
 * confirmed break the head is held unless the posted comment shows the SAME whole normalized list (not a count, not a
 * marker, not a summary): a missing comment, an unreadable seal or any difference holds. A comment can only add holds.
 * Every caller reaches this through {@link readRedTeamDisposition}. PURE.
 * @returns {{held:boolean, reason:(string|null)}}
 */
export function redTeamHoldDecision({ comments, pr, head, sealed } = {}) {
  if (!sealed) return { held: false, reason: null };
  if (sealed.unreadable) return { held: true, reason: 'sealed red-team evidence is unreadable' };
  if (sealed.unsealed) return { held: true, reason: 'stored red-team evidence is not sealed yet (publication pending)' };
  if (sealed.legacyHold === true) return { held: true, reason: 'legacy red-team evidence is unreadable or conflicts with the posted comment' };
  // An unsealed result the seat posted itself: its stored (projected) findings, through the SAME normalizer the publisher
  // seals with, then compared with the posted comment under the projection mask (the fields the projection keeps).
  if (sealed.findings !== undefined) {
    if (!Array.isArray(sealed.findings)) return { held: true, reason: 'stored red-team evidence is unreadable' };
    const stored = projectedBreakKeys(sealedBreakKeys(sealed.findings));
    if (!stored.length) return { held: false, reason: null };
    const { posted, keys } = redTeamBreaksAgree({ comments, pr, head, breaks: [] });
    if (posted && JSON.stringify(projectedBreakKeys(keys)) === JSON.stringify(stored)) return { held: false, reason: null };
    return { held: true, reason: posted ? 'the posted comment differs from the stored confirmed breaks'
      : 'stored evidence holds a confirmed break and no red-team comment shows it' };
  }
  const breaks = sealed.breaks;
  if (!Array.isArray(breaks) || !breaks.length) return { held: false, reason: null };
  const { posted, agree, keys } = redTeamBreaksAgree({ comments, pr, head, breaks });
  if (agree) return { held: false, reason: null };
  // The publisher's OWN scrub-fallback body (sealed with the breaks when it posted one): an exact whole-body match that
  // still shows every stored break as confirmed (an unknown impact reads as broken), so it never lifts a break.
  if (posted && Array.isArray(sealed.posted) && sealed.posted.length === sealed.breaks.length
    && JSON.stringify([...sealed.posted].sort()) === JSON.stringify(keys)) return { held: false, reason: null };
  return { held: true, reason: posted ? 'the posted comment differs from the stored confirmed breaks'
    : 'stored evidence holds a confirmed break and no red-team comment shows it' };
}

/**
 * Is every hold in this disposition only "publication pending" (stored evidence not sealed yet, no conflict found)?
 * Such a head is held, but it is no confirmed break: callers report it as pending, never as a send-back. PURE.
 */
export function redTeamHoldPendingOnly(disposition) {
  const held = disposition?.held ?? [];
  return !(disposition?.sendBack ?? []).length && held.length > 0 && held.every(f => f.unsealed === true);
}

/**
 * The heads the live head's red-team result was carried from, nearest first: the WHOLE chain, never a hop cap (a cap
 * dropped the original head's seal on the ninth carry, PR #6622). The disposition reads their seal for a carried result,
 * and the sweep seals them, from this one list. Each hop keeps only records earlier in the thread than the carry it
 * followed (`at` is the thread position), so the chain is bounded by the thread length and a cycle terminates. PURE.
 */
export function redTeamCarrySources({ comments, pr, head } = {}) {
  const out = [];
  let rs = indexedRecords(comments), hit = latestResult(rs, pr, String(head ?? '').toLowerCase());
  while (hit?.from) {
    out.push(hit.from);
    const at = hit.at;
    rs = rs.filter(r => r.at < at);
    hit = latestResult(rs, pr, hit.from);
  }
  return out;
}

/** Does the live head's posted red-team comment show EXACTLY these confirmed breaks (whole normalized lists)? PURE. */
export function redTeamBreaksAgree({ comments, pr, head, breaks } = {}) {
  const parsed = latestResult(indexedRecords(comments), pr, String(head ?? '').toLowerCase())?.parsed ?? null;
  const keys = parsed === null ? null : postedBreakKeys(parsed);
  return { posted: parsed !== null, keys, agree: parsed !== null
    && JSON.stringify([...(breaks ?? [])].sort()) === JSON.stringify(keys) };
}

/** Shared live-head disposition reader. Recorded per-finding actions override today's policy,
 * except automatic class-only cards whose live class deferral has been revoked.
 * Without a recorded action, policy send-back candidates still block admission while the gate acts: a missing gate
 * record keeps holding. Older round-cap records omit indices: all remaining send-back candidates belong to the operator.
 * Every gate decision (per-finding actions, the send-back outcome, the round-cap hand-over) applies only to the result
 * it decides ({@link gateRecordsFor}), so a record for an earlier same-head result never releases a newer one's
 * finding. A carried result also keeps the actions bound to the result it was carried from (the same findings,
 * re-keyed); the newer head's own records win. Human operator blocks retain gateRecordsFor's binding, including
 * legacy records and carries. Operator card actions never carry: only a direct record on the live head releases
 * its named result. With anyState off, legacy card/advisory records keep their existing binding.
 * `sealed` (PR #6622): the stored evidence for this exact head ({@link readSealedStatus}); left undefined it is read from
 * the head's persisted status, so no caller reads the flag or the thread on its own. {@link redTeamHoldDecision} turns it
 * into ONE held finding (index 0, which no real finding uses) whenever the stored evidence holds a confirmed break that the
 * posted comment does not show in full: the result is never read as clear while it stands. `legacyHold` forces the same hold.
 */
export function readRedTeamDisposition({ comments, pr, head, setting, env = process.env, repo = null, standingRuling = null, operatorRulings, legacyHold = false, sealed } = {}) {
  const live = String(head ?? '').toLowerCase();
  const records = indexedRecords(comments);
  const result = latestResult(records, pr, live)?.parsed ?? null;
  const effectiveSetting = setting ?? readConfirmedBreaks({ env }).value;
  const findingClasses = effectiveSetting.findingClasses ?? readFindingClassPolicy({ env });
  const plan = planRedTeamActions(result, { ...effectiveSetting, findingClasses });
  const anyState = (operatorRulings ?? readOperatorRulings({ env }).value).anyState === true;
  const actions = new Map();
  const classCarded = new Set(); // indices whose recorded automatic card was authorized by class deferral alone
  const rulings = [];
  const ordinaryHolds = new Map();
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
    const own = new Map(), ownClass = new Set();
    for (const r of gates) {
      for (const line of gateActionLines(recordBody(r))) {
        const { indices } = line;
        const block = r.gate.outcome === 'operator-block';
        let { action } = line;
        if (block && (RELEASING_ACTIONS.has(action) || action === 'operator-card')) continue;
        if (action === 'operator-card') {
          // Operator card releases bind to the exact head/result; verdict carries cannot inherit them.
          if (!first || r.from || r.gate.result !== want) continue;
          if (!r.gate.outcome.startsWith('operator-') || !isHumanOperatorComment(r.c)) continue;
          action = 'card';
        }
        // Only a human operator may release a break held at the round cap; automation lines release only what the gate itself decided.
        // This is applied per action line (not by dropping the forged comment, which would also drop its restrictive `held` lines).
        const operatorRelease = RELEASING_ACTIONS.has(action) && !AUTOMATION_RELEASE_OUTCOMES.has(r.gate.outcome);
        if (operatorRelease) {
          if (!isHumanOperatorComment(r.c) || r.at <= hit.at) continue;
          // Validate ownership for every release spelling, including automatic card filing and advisory.
          // Use ownership at posting time: later handovers/grants cannot change a ruling's validity.
          // Match the writer's grant-aware decision: a pending extension belongs to automation.
          const prior = sendBackStepState(gates.filter(g => g.at < r.at), grants.filter(g => g.index < r.at));
          if (prior.reopened || (!anyState && prior.outcome !== GATE_OUTCOMES.ROUND_CAP)) continue;
        }
        if (action === 'held' && !indices.length) legacyHeld = true;
        for (const index of indices) {
          // Operator releases never carry. Any-state releases also require an explicit result binding;
          // the default lets gateRecordsFor bind legacy card/advisory records without result=.
          if (operatorRelease && (!first || r.from || (anyState && r.gate.result !== want))) continue;
          // A stale cap POST cannot overwrite the per-finding send-back that superseded its decision.
          if (action === 'held' && own.get(index) === 'send-back' && supersededCaps.has(r)) continue;
          if ((action === 'held' || action === 'send-back') && !(block && action === 'send-back' && r.ruling)) {
            ordinaryHolds.set(index, Math.max(ordinaryHolds.get(index) ?? -1, r.at));
          }
          if (RELEASING_ACTIONS.has(action) || (block && action === 'send-back' && r.ruling)) {
            rulings.push({ kind: action === 'send-back' ? 'block' : action === 'card' ? 'card' : 'not-real',
              source: operatorRelease || (block && r.ruling) ? 'operator' : 'automatic',
              keys: [index], at: r.at, action });
          }
          own.set(index, action);
          // Only the gate's own automatic card record can name a class-only card; an operator card never does.
          if (action === 'card' && !operatorRelease && r.gate.classCards?.includes(index)) ownClass.add(index);
          else ownClass.delete(index);
        }
      }
    }
    for (const [index, action] of own) if (!actions.has(index)) { actions.set(index, action); if (ownClass.has(index)) classCarded.add(index); }
    if (!hit.from) break;
    rs = rs.filter(r => r.at < hit.at);
    sha = hit.from;
  }
  const capRecord = liveGates.filter(r => r.gate.outcome === GATE_OUTCOMES.ROUND_CAP).sort(threadOrder).at(-1)?.c ?? null;
  // Audited grants unseen by the cap decision let a later send-back stand, even if the cap POST arrives last.
  // Without a repo there is no grant credit and the cap keeps winning.
  const outcome = sendBackStepState(liveGates, grants).outcome;
  const dispositions = new Map(), findingRulings = new Map();
  const sendBack = [], held = [];
  for (const f of result?.findings ?? []) {
    const classDeferred = classAction(f, findingClasses) === 'defer-card';
    // Only a card the gate recorded as class-authorized (`class=` on its marker) is revoked with the deferral;
    // an ordinary-policy card keeps its recorded action even if confirmedBreaks later changes.
    const revokedClassCard = !classDeferred && classCarded.has(f.index);
    const recorded = revokedClassCard && actions.get(f.index) === 'card' ? null : actions.get(f.index);
    // Two raced gate runs can record both send-back and round-cap for one result; the cap wins (sendBackStepOutcome).
    const action = (recorded === 'send-back' && outcome === GATE_OUTCOMES.ROUND_CAP ? 'held' : recorded)
      ?? (legacyHeld && f.confirmed ? 'held' : null) ?? (plan.sendBack.includes(f)
        ? outcome === GATE_OUTCOMES.ROUND_CAP ? 'held' : 'send-back' : null);
    // Indexed gate holds retire older releases; legacy unindexed holds are only
    // fallback evidence. Operator blocks remain live across ordinary gate holds.
    const evidence = rulings.filter(r => !(revokedClassCard && r.kind === 'card' && r.source === 'automatic'))
      .filter(r => r.kind === 'block' || r.at > (ordinaryHolds.get(f.index) ?? -1));
    // operatorRuled validates the ceremony, carry chain, cap handover and later
    // accept/hold invalidations. A ceremony clears only held actions; a standing
    // send-back still belongs to the fixer even when the ceremony is live.
    const clearance = operatorRuled(records, pr, live, f.index);
    if (clearance && action === 'held') evidence.push({
      kind: 'clear-human', source: 'operator', keys: [f.index], at: clearance.at,
    });
    const disposition = resolveDisposition(f.index, evidence);
    dispositions.set(f.index, disposition);
    findingRulings.set(f.index, evidence);
    // Class deferral exempts automatic holds, but cannot release an explicit operator block.
    if (classDeferred && disposition.state !== 'held') continue;
    const effectiveAction = disposition.state === 'held'
      ? outcome === GATE_OUTCOMES.ROUND_CAP ? 'held' : 'send-back'
      : disposition.state === 'open' ? action : null;
    if (effectiveAction === 'held') held.push(f);
    if (effectiveAction === 'send-back') sendBack.push(f);
  }
  // The sealed stored evidence decides the hold (undefined = read this head's persisted seal; no caller reads it itself).
  // A carried result keeps the seal of the head it was carried from (the carry re-keys the comment, not the stored evidence).
  // Seals are per head, not per result: the live head or an intermediate head can hold an older seal of its own (a
  // force-push back to an already-reviewed sha). So EVERY seal on the chain is checked and any one that holds, holds;
  // a nearer clean seal never masks the carry origin's sealed break (PR #6622 round 9 self-review).
  let seals = [sealed];
  if (sealed === undefined) {
    // The publisher writes the seal under ITS process env; a caller's partial env (`{}`) must not move the lookup to a
    // directory with no seal (a missing file reads as "nothing sealed", which would clear). Explicit keys still win.
    const sealEnv = { ...process.env, ...(env ?? {}) };
    // The sweep seals these source heads too (seal only), so an unsealed source cannot hold a carried head forever.
    seals = [live, ...redTeamCarrySources({ comments, pr, head: live })]
      .map(h => readSealedStatus({ repo, pr, head: h, env: sealEnv }));
  }
  const holds = seals.map(s => ({ seal: s, ...redTeamHoldDecision({ comments, pr, head: live, sealed: s }) })).filter(h => h.held);
  // A conflict outranks "publication pending": report the pending-only hold only when no seal holds for a stronger reason.
  const hold = holds.find(h => h.seal?.unsealed !== true) ?? holds[0] ?? { held: false, reason: null, seal: null };
  const seal = hold.seal;
  // `unsealed`: the hold is only "publication pending" (no conflict found yet), so alert surfaces can say so.
  const unsealed = hold.held && seal?.unsealed === true && seal.legacyHold !== true && legacyHold !== true;
  if (legacyHold === true || hold.held) held.push({ index: 0, confirmed: true, category: 'legacy-conflict', file: null, line: null,
    summary: hold.reason ?? 'Legacy red-team evidence conflicts with the posted comment; operator review required.', legacyHold: true,
    ...(unsealed ? { unsealed: true } : {}) });
  return { result, sendBack, held, dispositions, rulings: findingRulings, since: commentCreatedAt(capRecord) ?? null, outcome };
}

/**
 * The live head's latest result; per finding the actions a HUMAN OPERATOR's named gate record (`operator-*`,
 * `result=` this result) took on it, in thread order; and every finding ANY trusted record already carded for this
 * result (the gate's own card filing too). `record-red-team-ruling` dedups on this (no second card). PURE.
 * @returns {{resultId:(string|null), ruled:Map<number, string[]>, carded:Set<number>, blocked:Set<number>}}
 */
export function operatorRulingsOnLiveResult(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  const records = indexedRecords(comments);
  const hit = latestResult(records, pr, live);
  const ruled = new Map();
  const carded = new Set(), blocked = new Set();
  if (!hit) return { resultId: null, ruled, carded, blocked };
  const id = redTeamResultId(hit.parsed);
  for (const r of gateRecordsFor(records, pr, live, hit).sort(threadOrder)) {
    // Identical reposts keep their result id, but earlier operator rulings do not apply to them.
    // Match the release reader's binding to the latest result's thread position.
    if (r.gate.outcome.startsWith('operator-') && r.at <= hit.at) continue;
    const human = isHumanOperatorComment(r.c);
    const operator = r.gate.outcome.startsWith('operator-') && human && r.gate.result === id;
    for (const { action, indices } of gateActionLines(recordBody(r))) {
      const card = action === 'card' || action === 'operator-card';
      if (card && (AUTOMATION_RELEASE_OUTCOMES.has(r.gate.outcome) || operator)) for (const index of indices) carded.add(index);
      if (!operator || (r.gate.outcome === 'operator-block' && r.from)) continue;
      const a = action === 'operator-card' ? 'card' : action;
      for (const index of indices) ruled.set(index, [...(ruled.get(index) ?? []), a]);
    }
  }
  const disposition = readRedTeamDisposition({ comments, pr, head, operatorRulings: { anyState: true } });
  for (const [index, resolved] of disposition.dispositions) if (resolved.by?.kind === 'block') blocked.add(index);
  return { resultId: id, ruled, carded, blocked };
}
