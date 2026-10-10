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
 * built-in. `roundCapAction` person|takeover (built-in takeover), `roundHistory` on|off (built-in on), and (card xrbu1bp, `we:scripts/conveyor/fix-resume.mjs`) `resumeAcrossRounds`
 * on|off (built-in on) and `strongerModelFromRound` (built-in 3, 0 = off).
 *
 * How MANY takeovers a PR gets, and when a further one is owed (the budget, the progress guard, gate holds), lives in
 * `we:scripts/conveyor/takeover-budget.mjs` (`fix.takeoverBudget`, default 2) — this module holds the marker, the
 * rung and the brief section. The marker post and the settings read are the only IO.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

export const FIX_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'fix.json');
export const FIX_SETTINGS_DEFAULTS = Object.freeze({
  roundCapAction: 'takeover', roundHistory: 'on',
  // Card xrbu1bp — see `we:scripts/conveyor/fix-resume.mjs`.
  resumeAcrossRounds: 'on', strongerModelFromRound: 3,
});
export const FIX_TAKEOVER_MARKER = '<!-- conveyor-fix-takeover';

const ACTIONS = ['person', 'takeover'];
const ONOFF = ['on', 'off'];

/**
 * env (`WE_FIX_ROUND_CAP_ACTION`, `WE_FIX_ROUND_HISTORY`, …) > settings file > built-in. (`fix.takeoverBudget` has its
 * own four-layer cascade: `takeover-budget.mjs#resolveTakeoverBudget`.)
 * Unknown values fall through to the next layer. Never throws.
 */
export function resolveFixSettings({ env = process.env, file = FIX_SETTINGS_FILE, read = (f) => readFileSync(f, 'utf8') } = {}) {
  let fromFile = {};
  try { fromFile = JSON.parse(read(file)) ?? {}; } catch { fromFile = {}; }
  const pick = (envVal, fileVal, ok, dflt) => {
    const e = String(envVal ?? '').trim().toLowerCase();
    if (ok(e)) return { value: e, source: 'env' };
    const f = String(fileVal ?? '').trim().toLowerCase();
    if (ok(f)) return { value: f, source: 'settings' };
    return { value: dflt, source: 'built-in' };
  };
  const action = pick(env.WE_FIX_ROUND_CAP_ACTION, fromFile.roundCapAction, (v) => ACTIONS.includes(v), FIX_SETTINGS_DEFAULTS.roundCapAction);
  const history = pick(env.WE_FIX_ROUND_HISTORY, fromFile.roundHistory, (v) => ONOFF.includes(v), FIX_SETTINGS_DEFAULTS.roundHistory);
  // Card xrbu1bp — resume the previous round's session (on|off) and the round the stronger-model rung starts at (0 = off).
  const resume = pick(env.WE_FIX_RESUME_ACROSS_ROUNDS, fromFile.resumeAcrossRounds, (v) => ONOFF.includes(v), FIX_SETTINGS_DEFAULTS.resumeAcrossRounds);
  const from = pick(env.WE_FIX_STRONGER_MODEL_FROM_ROUND, fromFile.strongerModelFromRound, (v) => /^\d{1,2}$/.test(v), String(FIX_SETTINGS_DEFAULTS.strongerModelFromRound));
  return {
    roundCapAction: action.value, roundHistory: history.value,
    resumeAcrossRounds: resume.value, strongerModelFromRound: Number(from.value),
    sources: {
      roundCapAction: action.source, roundHistory: history.source,
      resumeAcrossRounds: resume.source, strongerModelFromRound: from.source,
    },
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

/** Trusted void markers on the thread (each one a takeover that never launched). */
export function takeoverVoidCount(comments) {
  return trustedBodies(comments).filter((c) => markerHead(c.body, FIX_TAKEOVER_VOID_MARKER) !== undefined).length;
}

/**
 * Takeovers that actually started on this PR, read off TRUSTED marker comments only: `[{ head }]`. A trusted void
 * marker for the same head cancels one start marker (the session never launched); an unmatched void cancels nothing,
 * and only the first {@link TAKEOVER_MAX_VOIDS} voids on a PR are honoured.
 */
export function takeoverMarkers(comments) {
  const trusted = trustedBodies(comments);
  const starts = trusted
    .map((c) => ({ head: markerHead(c.body, FIX_TAKEOVER_MARKER), at: c.createdAt ?? null }))
    .filter((m) => m.head !== undefined);
  const voids = trusted.map((c) => markerHead(c.body, FIX_TAKEOVER_VOID_MARKER)).filter((h) => h !== undefined)
    .slice(0, TAKEOVER_MAX_VOIDS);
  for (const h of voids) {
    // Cancel the latest start for this head (a void with an `unknown` head cancels only an `unknown` start).
    const at = starts.map((m, i) => ({ m, i })).reverse().find(({ m }) => (h === null || m.head === null ? m.head === h : sameHeadSha(m.head, h)));
    if (at) starts.splice(at.i, 1);
  }
  return starts;
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

/** The durable marker comment, posted before the takeover session starts (the per-head bound; each one is one
 *  takeover of the PR's `fix.takeoverBudget`). `n`/`budget` are optional: absent, the text names no count. */
export function takeoverMarkerBody({ pr, head, attempts, cap, rung, n = null, budget = null }) {
  const which = Number.isInteger(n) && Number.isInteger(budget) ? `Takeover ${n} of ${budget}` : 'One takeover session';
  return `${FIX_TAKEOVER_MARKER} head=${head ?? 'unknown'} -->\n`
    + `🛟 conveyor fix takeover — PR #${pr} spent its fix rounds (${attempts}/${cap})\n\n`
    + `${which} was dispatched on head \`${String(head ?? '').slice(0, 9)}\` with the full round history, `
    + `on the \`${rung?.id ?? 'resend'}\` route${rung?.model ? ` (${rung.model})` : ''}. Its head earns one review; `
    + 'another takeover runs only if that review shows fewer or lighter open findings and the budget allows, '
    + 'otherwise the operator is asked. Ruling disputes always go to the operator.';
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
 * just the previous ones — the takeover owns the whole PR), then — for takeover 2+ — what the previous takeover
 * changed and the review that rejected it, then the brief.
 */
export function withTakeover(prompt, takeover, { allRoundsSection = '', previousTakeoverSection = '', baseRefName = null, headRefName = null } = {}) {
  if (!takeover) return prompt;
  const stacked = baseRefName && baseRefName !== 'main' ? `This PR is stacked on \`${baseRefName}\`: read that PR too.` : 'This PR targets `main` directly.';
  const which = Number.isInteger(takeover.n) && Number.isInteger(takeover.budget) && takeover.n > 1
    ? `You are takeover ${takeover.n} of ${takeover.budget} for this PR. Takeover ${takeover.n - 1} reduced the open findings but the review still asked for changes: start from its work, do not redo it. `
    : 'You are the takeover session for this head. ';
  return '# Takeover — this PR spent its automatic fix rounds, read this first\n\n'
    + `The ordinary fixer ran ${takeover.attempts ?? '?'} of ${takeover.cap ?? '?'} rounds and the reviewer kept finding problems. `
    + which + 'Work like a focused worker who owns the whole PR:\n\n'
    + '1. Read the card and every design doc it links, end to end, before touching code.\n'
    + `2. Read related PRs. ${stacked} List PRs stacked above this one with \`gh pr list --base ${headRefName ?? '<this branch>'}\`.\n`
    + '3. Read every round below. For each finding that was raised again, find the defect CLASS, not the one line, and fix every site of it.\n'
    + '4. Respect the current rulings exactly: `block` must be fixed, `not-real` must not be re-litigated, `card` is out of scope. '
    + 'If you believe a block ruling is wrong, do not work around it — say so on the PR and stop; the operator rules on disputes.\n'
    + '5. Then follow the ordinary fix brief below (reproduce, fix, verify, evidence, re-arm). Never touch review:human.\n\n'
    + (allRoundsSection || '(no round history could be read for this PR — read the PR thread yourself first)\n\n')
    + (previousTakeoverSection ? `${previousTakeoverSection}\n` : '')
    + prompt;
}
