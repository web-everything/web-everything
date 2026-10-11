/**
 * we:scripts/conveyor/fix-takeover.mjs — automatic takeover at the fix round cap (card xx0055i).
 *
 * Before: when a PR spent its fix rounds (`round-cap-exhausted`, capKind `fix`), the planner refused it and
 * posted "a person must take it over" (live: #4708 at 5/5). Most such PRs only needed what a focused takeover
 * worker does — read every round, the card and the rulings, then fix the whole defect class at once, on a
 * stronger model. Now, with `fix.roundCapAction: takeover` (the default), the planner dispatches ONE takeover
 * fix instead. The operator is still asked when:
 *   - a takeover already ran for this PR (it did not clear the PR: the takeover failed), or for this head;
 *   - a ruling dispute exists (fixer vs reviewer on a block ruling) — a ruling is never auto-resolved;
 *   - the setting is `person`.
 *
 * Settings (policy cascade, like `we:scripts/lib/red-main-hold.mjs`): env > `we:scripts/settings/fix.json` >
 * built-in. `fix.roundCapAction` person|takeover (built-in takeover), `fix.roundHistory` on|off (built-in on),
 * `fix.takeoverMaxPerPr` (built-in 1; 0 turns the takeover off). The file keeps them under a `fix` object, so the
 * merged settings view (`we:scripts/lib/settings-files.mjs`) carries the same `fix.*` paths the docs name.
 *
 * The planner half ({@link planTakeover}) is PURE; the marker post and the settings read are the only IO.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

export const FIX_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'fix.json');
export const FIX_SETTINGS_DEFAULTS = Object.freeze({ roundCapAction: 'takeover', roundHistory: 'on', takeoverMaxPerPr: 1 });
export const FIX_TAKEOVER_MARKER = '<!-- conveyor-fix-takeover';

const ACTIONS = ['person', 'takeover'];
const ONOFF = ['on', 'off'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stands in for every leaf of a file layer that is present but malformed (see {@link resolveFixSettings}). */
const INVALID_LAYER = Symbol('invalid fix settings layer');

/**
 * The file layer: its `fix` object, `{}` when there is none (no file, no `fix` key, `fix: null`), or
 * {@link INVALID_LAYER} when the file is there but malformed — not JSON, not an object at the top, or a `fix` that is
 * not an object (`false`, `"off"`, `[]`). A malformed layer must not read as an absent one: absent falls to the
 * built-in `takeover`, so an operator's `"fix": false` would turn the takeover ON.
 */
function readFileLayer(file, read) {
  let raw;
  // Only a MISSING file is no layer. Any other read error (EACCES, EISDIR, EIO) is a file that is there but unusable.
  try { raw = read(file); } catch (e) { return e?.code === 'ENOENT' ? {} : INVALID_LAYER; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return INVALID_LAYER; }
  if (parsed === null) return {};
  if (!isPlainObject(parsed)) return INVALID_LAYER;
  if (parsed.fix === undefined || parsed.fix === null) return {};
  return isPlainObject(parsed.fix) ? parsed.fix : INVALID_LAYER;
}

/**
 * env (`WE_FIX_ROUND_CAP_ACTION`, `WE_FIX_ROUND_HISTORY`, `WE_FIX_TAKEOVER_MAX_PER_PR`) > settings file > built-in.
 * The file layer is its `fix` object (a flat top-level key is not a setting). Unknown values fall through to the
 * next layer, except `roundCapAction` and the takeover limit, which fail closed to `person` / 0 (see below) — for a
 * bad leaf and for a malformed file or `fix` container alike. Never throws.
 */
export function resolveFixSettings({ env = process.env, file = FIX_SETTINGS_FILE, read = (f) => readFileSync(f, 'utf8') } = {}) {
  const layer = readFileLayer(file, read);
  const fromFile = layer === INVALID_LAYER
    ? { roundCapAction: INVALID_LAYER, roundHistory: undefined, takeoverMaxPerPr: INVALID_LAYER }
    : layer;
  const pick = (envVal, fileVal, ok, dflt) => {
    const e = String(envVal ?? '').trim().toLowerCase();
    if (ok(e)) return { value: e, source: 'env' };
    const f = typeof fileVal === 'string' ? fileVal.trim().toLowerCase() : '';
    if (ok(f)) return { value: f, source: 'settings' };
    return { value: dflt, source: 'built-in' };
  };
  // The two settings that can START a takeover fail CLOSED: the first layer that is present (a non-blank env var, or
  // a file key that is not null) decides, and a present value that does not parse turns the takeover off (`person`,
  // limit 0) instead of falling through to the built-in `takeover` / 1 — so a typo meant to stop it never enables it.
  // Types are checked, not stringified: `[3]`, `""` or `false` in the file is invalid, not 3 / absent / "false".
  const failClosed = (envVal, fileVal, parse, closed, dflt) => {
    if (typeof envVal === 'string' && envVal.trim() !== '') {
      const v = parse(envVal);
      return v === undefined ? { value: closed, source: 'env-invalid' } : { value: v, source: 'env' };
    }
    if (fileVal !== undefined && fileVal !== null) {
      const v = parse(fileVal);
      return v === undefined ? { value: closed, source: 'settings-invalid' } : { value: v, source: 'settings' };
    }
    return { value: dflt, source: 'built-in' };
  };
  const parseAction = (v) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : null;
    return ACTIONS.includes(s) ? s : undefined;
  };
  const parseMax = (v) => {
    if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 99 ? v : undefined;
    return typeof v === 'string' && /^\d{1,2}$/.test(v.trim()) ? Number(v.trim()) : undefined;
  };
  const action = failClosed(env.WE_FIX_ROUND_CAP_ACTION, fromFile.roundCapAction, parseAction, 'person', FIX_SETTINGS_DEFAULTS.roundCapAction);
  const history = pick(env.WE_FIX_ROUND_HISTORY, fromFile.roundHistory, (v) => ONOFF.includes(v), FIX_SETTINGS_DEFAULTS.roundHistory);
  const max = failClosed(env.WE_FIX_TAKEOVER_MAX_PER_PR, fromFile.takeoverMaxPerPr, parseMax, 0, FIX_SETTINGS_DEFAULTS.takeoverMaxPerPr);
  return {
    roundCapAction: action.value, roundHistory: history.value, takeoverMaxPerPr: max.value,
    sources: { roundCapAction: action.source, roundHistory: history.source, takeoverMaxPerPr: max.source },
  };
}

/** Posted when a takeover's session never started after its marker went up (a spawn fault): it voids ONE marker for
 *  that head, so a fault in the launch does not burn the only takeover. */
export const FIX_TAKEOVER_VOID_MARKER = '<!-- conveyor-fix-takeover-void';

// Anchored at the start of the body (like the sibling counters): a trusted comment that merely QUOTES a marker
// (a fixer's summary, say) is not one.
const markerHead = (body, prefix) => {
  const m = body.trimStart().match(new RegExp(`^${prefix} head=([0-9a-f]{7,40}|unknown)`));
  return m ? (m[1] === 'unknown' ? null : m[1]) : undefined; // undefined = not this kind of marker
};

/** The fix-round count the takeover launched at (`attempts=N` in the start marker's first line), or null when the
 *  marker carries none or a malformed one. Anchored like {@link markerHead}: only the header line counts. */
const markerAttempts = (body) => {
  const m = body.trimStart().match(/^<!-- conveyor-fix-takeover head=(?:[0-9a-f]{7,40}|unknown) attempts=(\d{1,6}) -->/);
  return m ? Number(m[1]) : null;
};

/**
 * PURE: does a launch failure PROVE no agent session started? Only then may the takeover marker be voided. A launch
 * that exited non-zero on its own, or never ran (`ENOENT`/`EACCES`), cannot have started a session. A timeout or a
 * kill signal is indeterminate (the session may be live: `dispatch-lane-io.mjs#SPAWN_TIMEOUT_MS`), and so is an error
 * with no exit information at all; for both the marker stands and the one-takeover bound holds.
 */
export function launchProvedNotStarted(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.signal || error.killed || error.code === 'ETIMEDOUT') return false;
  if (error.code === 'ENOENT' || error.code === 'EACCES') return true;
  return Number.isInteger(error.status) && error.status !== 0;
}

/** How many voids one PR may be given back: a launch fault that outlasts this many retries stops posting comments and
 *  the operator is asked (otherwise a persistent fault would post two comments per tick, forever). */
export const TAKEOVER_MAX_VOIDS = 2;

const trustedBodies = (comments) => (Array.isArray(comments) ? comments : [])
  .filter((c) => typeof c?.body === 'string' && isTrustedMarkerAuthor(c));

/** Trusted comments in thread order: by `createdAt` when every one carries a parseable time (ties keep the read
 *  order), else the read order as given (gh lists a thread oldest first). */
const inThreadOrder = (comments) => {
  const times = comments.map((c) => Date.parse(c.createdAt ?? ''));
  if (times.some((t) => !Number.isFinite(t))) return comments;
  return comments.map((c, i) => ({ c, t: times[i], i })).sort((a, b) => a.t - b.t || a.i - b.i).map(({ c }) => c);
};

/**
 * PURE: replay the takeover markers in thread order. A trusted void cancels the latest EARLIER start for its head that
 * is still standing (the launch it reports on came before it); a void with no such start cancels nothing. At most
 * {@link TAKEOVER_MAX_VOIDS} voids are honoured per PR: a matching void past that allowance is REFUSED, and its start
 * stands. `{ starts: [{ head, at, attempts }], refusedVoid }` — `refusedVoid` is true when the LATEST standing start
 * (the most recent takeover) is one a launch fault was reported for, so "the takeover ran" is not known for it. An
 * older refused start on another head does not mislabel a later takeover that launched cleanly.
 */
function takeoverLedger(comments) {
  const starts = [];
  let honoured = 0;
  // a void with an `unknown` head matches only an `unknown` start
  const matches = (m, h) => (h === null || m.head === null ? m.head === h : sameHeadSha(m.head, h));
  for (const c of inThreadOrder(trustedBodies(comments))) {
    const voidHead = markerHead(c.body, FIX_TAKEOVER_VOID_MARKER);
    if (voidHead !== undefined) {
      const i = starts.findLastIndex((m) => !m.voidRefused && matches(m, voidHead));
      if (i < 0) continue;
      if (honoured < TAKEOVER_MAX_VOIDS) { starts.splice(i, 1); honoured += 1; } else starts[i].voidRefused = true;
      continue;
    }
    const head = markerHead(c.body, FIX_TAKEOVER_MARKER);
    if (head !== undefined) starts.push({ head, at: c.createdAt ?? null, attempts: markerAttempts(c.body), voidRefused: false });
  }
  return { starts: starts.map(({ head, at, attempts }) => ({ head, at, attempts })), refusedVoid: Boolean(starts.at(-1)?.voidRefused) };
}

/**
 * Takeovers that actually started on this PR, read off TRUSTED marker comments only: `[{ head, at, attempts }]`.
 * See {@link takeoverLedger}: voids apply in thread order, each to the latest earlier start for its head.
 */
export function takeoverMarkers(comments) {
  return takeoverLedger(comments).starts;
}

/**
 * The highest attempt count a REVIEW may still be owed at: every takeover that actually started is a round beyond the
 * cap, so its own re-arm (launch count + 1) is reviewed like the last ordinary fix. Measured from the count the takeover
 * LAUNCHED at, not from the cap: the planner takes over at `attempts >= cap`, and the count can already be above the cap
 * then. A marker with no launch count (older shape) falls back to one extra round per started takeover. Reads
 * {@link takeoverMarkers}, so only trusted, un-voided markers grant anything. Only the fix path's own cap refusal stays
 * at `roundCap`: another fixer is never dispatched past it.
 */
export function takeoverReviewCap(comments, roundCap) {
  const started = takeoverMarkers(comments);
  return started.reduce((cap, m) => Math.max(cap, Number.isInteger(m.attempts) ? m.attempts + 1 : 0), roundCap + started.length);
}

/** Two shas are the same head when one is a prefix of the other (a marker may carry an abbreviated sha). */
export function sameHeadSha(a, b) {
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

/**
 * The takeover's model: the TOP rung of the fixer-escalation ladder this dispatch path can launch (a `dispatch`
 * rung that is available and routes to Claude — the fix dispatch launches only `claude`). `null` route = the
 * ordinary fix route (no stronger rung is configured or available).
 */
export function takeoverRung(fixerLadder) {
  const rungs = fixerLadder?.policy?.rungs ?? [];
  const available = fixerLadder?.available ?? (() => true);
  const routes = fixerLadder?.routes ?? {};
  const launchable = rungs.filter((r) => r.action === 'dispatch' && available(r) && routes[r.id]?.provider === 'claude');
  const top = launchable.at(-1) ?? null;
  return top
    ? { rung: { id: top.id, at: top.at, label: top.label ?? top.id, taskType: top.taskType ?? null, model: routes[top.id]?.model ?? null }, route: routes[top.id] }
    : { rung: { id: 'resend', at: 0, label: 'ordinary fix route', taskType: null, model: null }, route: null };
}

/**
 * PURE: is a takeover owed instead of the round-cap note? `{ ok: true, rung, route }` or `{ ok: false, reason }`.
 * Reasons: `setting-person`, `setting-disabled` (`takeoverMaxPerPr` is 0, or not a number: no takeover ever runs),
 * `ruling-dispute`, `takeover-spent` (a takeover already ran for this PR/head), `takeover-void-limit`.
 */
export function planTakeover({ pr, roundCapAction = 'person', takeoverMaxPerPr = 1, fixerLadder } = {}) {
  if (roundCapAction !== 'takeover') return { ok: false, reason: 'setting-person' };
  // Checked before the markers: with a budget of 0 nothing ran, so "spent" would tell the operator a takeover ran.
  // A value that is not a number fails closed (no takeover) rather than comparing as NaN (always false = take over).
  const max = takeoverMaxPerPr === null || takeoverMaxPerPr === '' ? Number.NaN : Number(takeoverMaxPerPr);
  if (!Number.isFinite(max) || max <= 0) return { ok: false, reason: 'setting-disabled' };
  if (pr?.ignoredRulings?.matches?.length) return { ok: false, reason: 'ruling-dispute' };
  const { starts: markers, refusedVoid } = takeoverLedger(pr?.comments);
  const head = pr?.headRefOid ?? null;
  const sameHead = markers.some((m) => sameHeadSha(m.head, head));
  if (sameHead || markers.length >= max) {
    // `takeover-void-limit`: a launch fault was reported for a start that still stands, because the void allowance was
    // already used. A takeover that launched cleanly after earlier voided faults posts no void of its own, so it reads
    // as `takeover-spent` ("already ran"), which is what happened.
    return { ok: false, reason: refusedVoid ? 'takeover-void-limit' : 'takeover-spent', heads: markers.map((m) => m.head).filter(Boolean) };
  }
  return { ok: true, ...takeoverRung(fixerLadder) };
}

/** The durable marker comment, posted before the takeover session starts (the one-per-PR/head bound). */
export function takeoverMarkerBody({ pr, head, attempts, cap, rung }) {
  // `attempts=N` is the count the takeover launched at: its own re-arm lands at N+1, and that is what the review
  // allowance is measured from (a takeover can start above the cap when several counts ran ahead of the rearm count).
  const launchCount = Number.isSafeInteger(attempts) && attempts >= 0 ? ` attempts=${attempts}` : '';
  return `${FIX_TAKEOVER_MARKER} head=${head ?? 'unknown'}${launchCount} -->\n`
    + `🛟 conveyor fix takeover — PR #${pr} spent its fix rounds (${attempts}/${cap})\n\n`
    + `One takeover session was dispatched on head \`${String(head ?? '').slice(0, 9)}\` with the full round history, `
    + `on the \`${rung?.id ?? 'resend'}\` route${rung?.model ? ` (${rung.model})` : ''}. If it does not clear this PR, `
    + 'the operator is asked next. Ruling disputes always go to the operator.';
}

/** The void marker: the takeover whose marker was posted for `head` never launched, so it does not count. A fixed
 *  phrase only: the spawn error (paths, stderr) is never copied onto the PR. */
export function takeoverVoidMarkerBody({ pr, head }) {
  return `${FIX_TAKEOVER_VOID_MARKER} head=${head ?? 'unknown'} -->\n`
    + `↩️ conveyor fix takeover — the takeover session for PR #${pr} did not start; the next pass retries it `
    + `(at most ${TAKEOVER_MAX_VOIDS} such retries per PR, after which the operator is asked).`;
}

/**
 * The takeover section put in front of the fix brief: what is different about this run, then ALL rounds (not
 * just the previous ones — the takeover owns the whole PR), then the brief.
 */
export function withTakeover(prompt, takeover, { allRoundsSection = '', baseRefName = null, headRefName = null } = {}) {
  if (!takeover) return prompt;
  const stacked = baseRefName && baseRefName !== 'main' ? `This PR is stacked on \`${baseRefName}\`: read that PR too.` : 'This PR targets `main` directly.';
  return '# Takeover — this PR spent its automatic fix rounds, read this first\n\n'
    + `The ordinary fixer ran ${takeover.attempts ?? '?'} of ${takeover.cap ?? '?'} rounds and the reviewer kept finding problems. `
    + 'You are the ONE takeover session for this head. Work like a focused worker who owns the whole PR:\n\n'
    + '1. Read the card and every design doc it links, end to end, before touching code.\n'
    + `2. Read related PRs. ${stacked} List PRs stacked above this one with \`gh pr list --base ${headRefName ?? '<this branch>'}\`.\n`
    + '3. Read every round below. For each finding that was raised again, find the defect CLASS, not the one line, and fix every site of it.\n'
    + '4. Respect the current rulings exactly: `block` must be fixed, `not-real` must not be re-litigated, `card` is out of scope. '
    + 'If you believe a block ruling is wrong, do not work around it — say so on the PR and stop; the operator rules on disputes.\n'
    + '5. Then follow the ordinary fix brief below (reproduce, fix, verify, evidence, re-arm). Never touch review:human.\n\n'
    + (allRoundsSection || '(no round history could be read for this PR — read the PR thread yourself first)\n\n')
    + prompt;
}
