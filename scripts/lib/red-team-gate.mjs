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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

// ── The comment the producer writes ─────────────────────────────────────────────────────────────────────────────

/** The red-team comment's leading marker (the producer imports it from here). */
export const RED_TEAM_COMMENT_MARKER = '<!-- we:red-team-advisory';
/** The tag a finding line carries, by re-check outcome (the producer renders with these). */
export const RED_TEAM_CONFIRMED_TAG = '**confirmed**';
export const RED_TEAM_UNCONFIRMED_TAG = 'not confirmed';

/** The dedup marker line for one reviewed head. PURE. */
export function redTeamMarker(pr, rev) {
  return `${RED_TEAM_COMMENT_MARKER} pr=${Number(pr)} rev=${String(rev)} -->`;
}

const MARKER_RE = /^<!-- we:red-team-advisory pr=(\d+) rev=([0-9a-f]{7,64}) -->/i;
const FINDING_RE = /^(\d+)\. \[(\*\*confirmed\*\*|not confirmed)\] \(([^,()]+), ([^()]+?)\)(?: `([^`]+)`)? — (.*)$/;
const SUB_RE = /^ {3}- (Scenario|Re-check): (.*)$/;

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
 * The red-team comment for the LIVE head: the newest one a TRUSTED principal wrote whose marker names this PR and
 * exactly this head. A comment on another head is stale (the fixer already pushed) and is ignored. PURE.
 */
export function redTeamForHead(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(live)) return null;
  const hits = (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, parsed: isTrustedMarkerAuthor(c) ? parseRedTeamComment(typeof c === 'string' ? c : c?.body) : null }))
    .filter((x) => x.parsed && x.parsed.pr === Number(pr) && x.parsed.rev === live)
    .sort((a, b) => (Date.parse(a.c?.createdAt) || 0) - (Date.parse(b.c?.createdAt) || 0) || a.i - b.i);
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
/** Outcomes the gate records per head. `round-cap` = the round cap is reached; the operator rules instead. */
export const GATE_OUTCOMES = Object.freeze({ SENT_BACK: 'sent-back', ROUND_CAP: 'round-cap', NOTHING_TO_SEND: 'no-send-back' });

export function redTeamGateMarker(pr, rev, outcome) {
  return `${RED_TEAM_GATE_MARKER} pr=${Number(pr)} rev=${String(rev).toLowerCase()} outcome=${outcome} -->`;
}

/** The gate's recorded outcome for this head (trusted authors only), or null when it has not acted. PURE. */
export function gateOutcomeForHead(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  const re = /^<!-- we:red-team-gate pr=(\d+) rev=([0-9a-f]{40}) outcome=([a-z-]+) -->/;
  let found = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    const m = re.exec(String((typeof c === 'string' ? c : c?.body) ?? '').trimStart());
    if (m && Number(m[1]) === Number(pr) && m[2] === live && isTrustedMarkerAuthor(c)) found = m[3];
  }
  return found;
}

/**
 * The operator-queue reason: why this PR is NOT READY because of the red team, or null. PURE. A PR whose live head
 * carries confirmed findings the setting sends back is the FIXER's until a new head clears them — unless the gate
 * recorded that the round cap stopped it, in which case it is the operator's (no reason added).
 */
export function redTeamQueueReason(pr, setting = CONFIRMED_BREAKS_DEFAULTS) {
  const parsed = redTeamForHead(pr?.comments, pr?.number, pr?.headRefOid);
  if (!parsed) return null;
  const { sendBack } = planRedTeamActions(parsed, setting);
  if (!sendBack.length) return null;
  if (gateOutcomeForHead(pr.comments, pr.number, pr.headRefOid) === GATE_OUTCOMES.ROUND_CAP) return null;
  return `red team: ${sendBack.length} confirmed break(s) on this head (${sendBack.map((f) => `#${f.index}`).join(', ')}) — the fixer owns them`;
}
