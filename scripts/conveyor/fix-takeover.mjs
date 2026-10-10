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
 * built-in. `roundCapAction` person|takeover (built-in takeover), `roundHistory` on|off (built-in on),
 * `takeoverMaxPerPr` (built-in 1), and (card xrbu1bp, `we:scripts/conveyor/fix-resume.mjs`) `resumeAcrossRounds`
 * on|off (built-in on) and `strongerModelFromRound` (built-in 3, 0 = off).
 *
 * The planner half ({@link planTakeover}) is PURE; the marker post and the settings read are the only IO.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

export const FIX_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'fix.json');
export const FIX_SETTINGS_DEFAULTS = Object.freeze({
  roundCapAction: 'takeover', roundHistory: 'on', takeoverMaxPerPr: 1,
  // Card xrbu1bp — see `we:scripts/conveyor/fix-resume.mjs`.
  resumeAcrossRounds: 'on', strongerModelFromRound: 3,
});
export const FIX_TAKEOVER_MARKER = '<!-- conveyor-fix-takeover';

const ACTIONS = ['person', 'takeover'];
const ONOFF = ['on', 'off'];

/**
 * env (`WE_FIX_ROUND_CAP_ACTION`, `WE_FIX_ROUND_HISTORY`, `WE_FIX_TAKEOVER_MAX_PER_PR`) > settings file > built-in.
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
  const max = pick(env.WE_FIX_TAKEOVER_MAX_PER_PR, fromFile.takeoverMaxPerPr, (v) => /^\d{1,2}$/.test(v), String(FIX_SETTINGS_DEFAULTS.takeoverMaxPerPr));
  // Card xrbu1bp — resume the previous round's session (on|off) and the round the stronger-model rung starts at (0 = off).
  const resume = pick(env.WE_FIX_RESUME_ACROSS_ROUNDS, fromFile.resumeAcrossRounds, (v) => ONOFF.includes(v), FIX_SETTINGS_DEFAULTS.resumeAcrossRounds);
  const from = pick(env.WE_FIX_STRONGER_MODEL_FROM_ROUND, fromFile.strongerModelFromRound, (v) => /^\d{1,2}$/.test(v), String(FIX_SETTINGS_DEFAULTS.strongerModelFromRound));
  return {
    roundCapAction: action.value, roundHistory: history.value, takeoverMaxPerPr: Number(max.value),
    resumeAcrossRounds: resume.value, strongerModelFromRound: Number(from.value),
    sources: {
      roundCapAction: action.source, roundHistory: history.source, takeoverMaxPerPr: max.source,
      resumeAcrossRounds: resume.source, strongerModelFromRound: from.source,
    },
  };
}

/** Takeovers already started on this PR, read off TRUSTED marker comments only: `[{ head }]`. */
export function takeoverMarkers(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((c) => typeof c?.body === 'string' && c.body.includes(FIX_TAKEOVER_MARKER) && isTrustedMarkerAuthor(c))
    .map((c) => ({ head: c.body.match(/<!-- conveyor-fix-takeover head=([0-9a-f]{7,40})/)?.[1] ?? null, at: c.createdAt ?? null }));
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
 * Reasons: `setting-person`, `ruling-dispute`, `takeover-spent` (a takeover already ran for this PR/head).
 */
export function planTakeover({ pr, roundCapAction = 'person', takeoverMaxPerPr = 1, fixerLadder } = {}) {
  if (roundCapAction !== 'takeover') return { ok: false, reason: 'setting-person' };
  if (pr?.ignoredRulings?.matches?.length) return { ok: false, reason: 'ruling-dispute' };
  const markers = takeoverMarkers(pr?.comments);
  const head = pr?.headRefOid ?? null;
  const sameHead = markers.some((m) => m.head && head && (head.startsWith(m.head) || m.head.startsWith(head)));
  if (sameHead || markers.length >= Math.max(0, takeoverMaxPerPr)) {
    return { ok: false, reason: 'takeover-spent', heads: markers.map((m) => m.head).filter(Boolean) };
  }
  return { ok: true, ...takeoverRung(fixerLadder) };
}

/** The durable marker comment, posted before the takeover session starts (the one-per-PR/head bound). */
export function takeoverMarkerBody({ pr, head, attempts, cap, rung }) {
  return `${FIX_TAKEOVER_MARKER} head=${head ?? 'unknown'} -->\n`
    + `🛟 conveyor fix takeover — PR #${pr} spent its fix rounds (${attempts}/${cap})\n\n`
    + `One takeover session was dispatched on head \`${String(head ?? '').slice(0, 9)}\` with the full round history, `
    + `on the \`${rung?.id ?? 'resend'}\` route${rung?.model ? ` (${rung.model})` : ''}. If it does not clear this PR, `
    + 'the operator is asked next. Ruling disputes always go to the operator.';
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
