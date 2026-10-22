/**
 * @file scripts/lib/red-team-timing.mjs
 * @description Card 6212 — THE RED TEAM IN ROUND 1, BESIDE THE PANEL (`redTeam.timing`).
 *
 *   Before this card the red team's result counted only when the review ACCEPTED. Every accept then opened a fresh
 *   round with 1–3 new breaks (coroner 2026-10-21: ~85 extra rounds since 10-17), and the speculative pass that ran
 *   beside a `changes` review was thrown away, real breaks included. Under `redTeam.timing=round1`:
 *     - the review job always starts the red team beside the panel (the speculative path,
 *       `we:scripts/lib/review-speculative-red-team.mjs`), whatever `review.speculativeRedTeam` says;
 *     - a `changes` review FINISHES that pass on the same head: its comment is posted and the red-team gate runs, so
 *       the confirmed breaks join the panel's fix list in the SAME round (the gate's send-back on a PR already under
 *       `review:changes` costs no extra round). The fixer dispatch waits for that pass (bounded,
 *       {@link round1FixHold}) so the fixer gets both lists together;
 *     - an accept reuses the pass on the accepted head even when the jurors raised findings (the brief is
 *       independent of them, card 6209), instead of re-running post-accept;
 *     - the gate does not re-raise a confirmed break that was already ruled on an earlier head when the lines it
 *       cites are unchanged ({@link suppressPreviouslyRuled}).
 *   `post-accept` (the kill switch) restores the old order exactly. `panel-seat` (the card's name) is an alias.
 *
 *   NEVER WEAKER: nothing here changes what merge needs. An accepted head still needs a red-team result on THAT head
 *   (or a proven-identical carry); a red team that fails to run is still an error that holds, never a clear. The
 *   card-review class is unchanged: a card-only net diff never schedules a pass (`redTeam.skipCardOnly`).
 *
 *   THE SETTING, under the policy cascade (standard → platform `redTeam` → tool `we:scripts/settings/red-team.json`
 *   `redTeam` → env), each value logged with the layer that set it:
 *     - `timing` round1|post-accept           standard `post-accept` (card 6212: trial, default unchanged)
 *                                             env WE_RED_TEAM_TIMING
 *     - `round1FixHoldMinutes` 0..120         standard 30: the longest the fixer waits for an in-flight round-1 pass
 *                                             env WE_RED_TEAM_ROUND1_FIX_HOLD_MINUTES
 *
 *   PURE except the settings-file read, the status read in {@link round1FixHold}, and nothing else.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { VERDICTS } from './jury-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RED_TEAM_TIMING_SETTINGS_FILE = join(HERE, '..', 'settings', 'red-team.json');

export const RED_TEAM_TIMINGS = Object.freeze({ ROUND1: 'round1', POST_ACCEPT: 'post-accept' });
const TIMING_ALIASES = Object.freeze({ round1: 'round1', 'round-1': 'round1', 'panel-seat': 'round1', 'post-accept': 'post-accept' });
export const RED_TEAM_TIMING_DEFAULTS = Object.freeze({ timing: RED_TEAM_TIMINGS.POST_ACCEPT, round1FixHoldMinutes: 30 });
export const RED_TEAM_TIMING_ENV = Object.freeze({ timing: 'WE_RED_TEAM_TIMING', round1FixHoldMinutes: 'WE_RED_TEAM_ROUND1_FIX_HOLD_MINUTES' });

/** One layer's timing value, normalised (aliases folded), or null when unusable. PURE. */
export function normTiming(v) {
  return TIMING_ALIASES[String(v ?? '').trim().toLowerCase()] ?? null;
}

const VALID = {
  timing: (v) => normTiming(v) !== null,
  round1FixHoldMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 120,
};

/**
 * Resolve the timing settings. PURE over its inputs.
 * @param {{file?:object, platform?:object, env?:object}} o  `file` = red-team.json's content, `platform` = the
 *   platform `redTeam` preference
 * @returns {{value:{timing:string, round1FixHoldMinutes:number}, sources:object, invalid:string[], round1:boolean}}
 */
export function resolveRedTeamTiming({ file = {}, platform, env = {} } = {}) {
  const pick = (o) => Object.fromEntries(Object.keys(RED_TEAM_TIMING_DEFAULTS).filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  const envValues = {};
  for (const [key, name] of Object.entries(RED_TEAM_TIMING_ENV)) {
    const raw = env?.[name];
    if (raw === undefined || raw === '') continue;
    envValues[key] = key === 'round1FixHoldMinutes' && /^\d+$/.test(String(raw).trim()) ? Number(raw) : raw;
  }
  const r = resolveCascade({ standard: RED_TEAM_TIMING_DEFAULTS, platform: pick(platform), tool: pick(file?.redTeam), envValues, valid: VALID });
  const value = { ...RED_TEAM_TIMING_DEFAULTS, ...r.value, timing: normTiming(r.value?.timing) ?? RED_TEAM_TIMING_DEFAULTS.timing };
  return { ...r, value, leafValues: { ...r.leafValues, timing: value.timing }, round1: value.timing === RED_TEAM_TIMINGS.ROUND1 };
}

/** IO: read the tool file and the platform preference, then resolve. Never throws (an unreadable file = not set). */
export function readRedTeamTiming({ env = process.env, path = RED_TEAM_TIMING_SETTINGS_FILE, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let file = {};
  try { file = JSON.parse(readFile(path)); } catch { file = {}; }
  let platform;
  try { platform = platformPreference('redTeam', { env }); } catch { platform = undefined; }
  return resolveRedTeamTiming({ file, platform, env });
}

/** The one log line: each value and the layer that set it. PURE. */
export function formatRedTeamTimingLine(resolved) {
  return formatCascadeSourcesLine('redTeam.timing', resolved);
}

/**
 * Is the round-1 red team owed on this finished review? Only a plain `changes` verdict: the panel sent the head back,
 * so the red team's confirmed breaks join that send-back. `needs-human`, `prevention-outstanding`, a stopped loop and
 * an accept are not round-1 cases (an accept is the ordinary `redTeamOwedFor`). PURE.
 */
export function round1RedTeamOwedFor(loopPayload) {
  const v = loopPayload?.verdict;
  return Boolean(v && typeof v === 'object' && v.verdict === VERDICTS.CHANGES && v.humanRequired !== true);
}

// ── Remembered breaks ───────────────────────────────────────────────────────────────────────────────────────────

/** Lines around the cited line that make up its fingerprint. */
export const CITED_CONTEXT_LINES = 3;

/**
 * The fingerprint of the code a finding cites: the file path plus the cited line and {@link CITED_CONTEXT_LINES}
 * lines either side, at one head. Content-based, so a break whose lines only MOVED still matches, and any edit to
 * the cited lines changes it. Null when the finding cites no file + line, or the line is not in the file. PURE.
 */
export function citedLinesFingerprint({ file, line, text }) {
  if (!file || !Number.isInteger(line) || line < 1 || typeof text !== 'string') return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (line > lines.length) return null;
  const start = Math.max(0, line - 1 - CITED_CONTEXT_LINES);
  const excerpt = lines.slice(start, line + CITED_CONTEXT_LINES).join('\n');
  // Anchored: the cited line's position inside the excerpt is part of it, so two different lines of a short file
  // (whose clipped excerpts are the same text) never share a fingerprint.
  return createHash('sha256').update(JSON.stringify([file, line - 1 - start, excerpt])).digest('hex');
}

/** A summary or scenario normalised for an EXACT comparison: whitespace runs folded and the ends trimmed, nothing
 *  else — case, signs, operators and punctuation all stay significant (`n < 0` vs `n > 0`, `parse(-1)` vs `parse(1)`). PURE. */
function norm(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Are two red-team findings THE SAME BREAK (beyond citing the same code)? Same file, same category, same impact class
 * (a confirmed finding with no stated impact counts as `broken`, as the gate does), AND the same normalised summary or
 * the same normalised failure scenario. Deliberately exact: a reworded report of an old break is raised again (the
 * conservative side); a NEW break at an old location — even one differing by a single identifier — never inherits an
 * old ruling. PURE.
 */
export function sameBreak(a, b) {
  if (!a || !b || !a.file || a.file !== b.file) return false;
  if (String(a.category ?? '') !== String(b.category ?? '')) return false;
  const cls = (f) => (f.impact === 'degraded' || f.impact === 'cosmetic' ? 'degraded' : 'broken');
  if (cls(a) !== cls(b)) return false;
  const sa = norm(a.summary), sc = norm(a.scenario);
  return Boolean((sa && sa === norm(b.summary)) || (sc && sc === norm(b.scenario)));
}

/**
 * Take out of `plan.sendBack` / `plan.card` every confirmed live-head finding that is THE SAME BREAK ({@link sameBreak})
 * as one already RULED on an earlier head (released by a recorded card / advisory action, or by the operator's ruling)
 * AND whose cited lines are unchanged (same {@link citedLinesFingerprint}). Those move to `advisory` and are listed in
 * `priorRuled`. `ruled` entries are `{rev, fingerprint, finding}`. PURE.
 * Fail closed: a finding with no fingerprint (no file/line, unreadable file) is never taken out.
 * @param {{plan:{sendBack:object[], card:object[], advisory:object[]}, fingerprintOf:(f:object)=>(string|null),
 *   ruled:Array<{rev:string, fingerprint:(string|null)}>}} o
 */
export function suppressPreviouslyRuled({ plan, fingerprintOf, ruled = [] }) {
  const known = ruled.filter((r) => r?.fingerprint && r.finding);
  const out = { sendBack: [], card: [], advisory: [...(plan?.advisory ?? [])], priorRuled: [] };
  for (const bucket of ['sendBack', 'card']) {
    for (const f of plan?.[bucket] ?? []) {
      let fp = null;
      try { fp = known.length ? fingerprintOf(f) : null; } catch { fp = null; }
      const hit = fp ? known.find((r) => r.fingerprint === fp && sameBreak(f, r.finding)) : null;
      if (hit) { out.advisory.push(f); out.priorRuled.push({ finding: f, rev: hit.rev }); }
      else out[bucket].push(f);
    }
  }
  return out;
}

// ── The fixer waits for an in-flight round-1 pass ──────────────────────────────────────────────────────────────

/**
 * Should fix dispatch wait for this head's round-1 red team? PURE over its inputs: `status` is the head's red-team
 * status record (`we:scripts/lib/drain-red-team-evidence.mjs`), `statusAt` its write time. Holds only while the pass
 * is `queued`/`running`, its writer is alive (another host counts as alive), and the hold is younger than
 * `round1FixHoldMinutes` — so a stuck pass delays a fix by at most that bound and never blocks it.
 * @returns {{hold:boolean, why:string}}
 */
export function decideRound1FixHold({ setting, status, statusAt, now, writerAlive = true }) {
  if (!setting?.round1) return { hold: false, why: 'redTeam.timing is not round1' };
  if (!status || !['queued', 'running'].includes(status.status)) return { hold: false, why: 'no round-1 red team in flight on this head' };
  if (!writerAlive) return { hold: false, why: 'the red-team writer is gone' };
  const capMs = (setting.value?.round1FixHoldMinutes ?? RED_TEAM_TIMING_DEFAULTS.round1FixHoldMinutes) * 60_000;
  const age = Number.isFinite(statusAt) && Number.isFinite(now) ? now - statusAt : Infinity;
  if (!(age < capMs)) return { hold: false, why: `the round-1 red team has been in flight past redTeam.round1FixHoldMinutes (${Math.round(capMs / 60_000)} min)` };
  return { hold: true, why: `round-1 red team ${status.status} on head ${String(status.head ?? '').slice(0, 12)} for ${Math.round(age / 1000)}s — the fixer waits so it gets the panel's and the red team's findings together (redTeam.timing=round1)` };
}
