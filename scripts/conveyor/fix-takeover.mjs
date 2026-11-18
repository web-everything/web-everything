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
 * built-in. `fix.roundCapAction` person|takeover (built-in takeover), `fix.roundHistory` on|off (built-in on), and
 * (card xrbu1bp, `we:scripts/conveyor/fix-resume.mjs`) `fix.resumeAcrossRounds` on|off (built-in on) and
 * `fix.strongerModelFromRound` (built-in 3, 0 = off). The file keeps them under a `fix` object, so the merged settings
 * view (`we:scripts/lib/settings-files.mjs`) carries the same `fix.*` paths the docs name.
 * `fix.capacityStarvationHours` (built-in 6, integer 1..999) alerts on host capacity via
 * standard → platform preference → tool settings → env;
 * `WE_FIX_CAPACITY_STARVATION_HOURS` overrides it. Refusals never use repair attempts.
 *
 * How MANY takeovers a PR gets, and when a further one is owed (the budget, the progress guard, gate holds), lives in
 * `we:scripts/conveyor/takeover-budget.mjs` (`fix.takeoverBudget`, default 2) — this module holds the marker, the
 * rung and the brief section. The marker post and the settings read are the only IO.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';

/** R242: an invalid switch keeps the historical steps running; an absent switch inherits. Sources are logged by the cascade. */
export function resolveFixDispatchSettings({ env = process.env, file = readSettings(), platform } = {}) {
  const parse = value => value === undefined ? undefined : value === true;
  const result = cascadePolicy('fixDispatch', {
    skipEmptySteps: parse(file?.fixDispatch?.skipEmptySteps),
  }, {
    standard: { skipEmptySteps: true },
    platform: { skipEmptySteps: parse((platform ?? platformPreference('fixDispatch', { env }))?.skipEmptySteps) },
    env,
    envValues: { skipEmptySteps: env.WE_FIX_SKIP_EMPTY_STEPS === undefined ? undefined
      : ['true', '1', 'on'].includes(String(env.WE_FIX_SKIP_EMPTY_STEPS).trim().toLowerCase()) },
    valid: { skipEmptySteps: value => typeof value === 'boolean' },
  });
  return { skipEmptySteps: result.value.skipEmptySteps, sources: result.sources };
}

export const FIX_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'fix.json');
export const FIX_SETTINGS_DEFAULTS = Object.freeze({
  roundCapAction: 'takeover', roundHistory: 'on',
  // Card xrbu1bp — see `we:scripts/conveyor/fix-resume.mjs`.
  resumeAcrossRounds: 'on', strongerModelFromRound: 3,
  capacityStarvationHours: 6,
});
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
 * env (`WE_FIX_ROUND_CAP_ACTION`, `WE_FIX_ROUND_HISTORY`, …) > settings file > built-in. (`fix.takeoverBudget` has its
 * own four-layer cascade: `takeover-budget.mjs#resolveTakeoverBudget`.)
 * The file layer is its `fix` object (a flat top-level key is not a setting). Unknown values fall through to the
 * next layer, except `roundCapAction`, which fails closed to `person` (see below) — for a bad leaf and for a
 * malformed file or `fix` container alike. Never throws.
 */
export function resolveFixSettings({ env = process.env, file = FIX_SETTINGS_FILE, read = (f) => readFileSync(f, 'utf8'), platform } = {}) {
  const layer = readFileLayer(file, read);
  const fromFile = layer === INVALID_LAYER
    ? { roundCapAction: INVALID_LAYER, roundHistory: undefined }
    : layer;
  const pick = (envVal, fileVal, ok, dflt) => {
    const e = String(envVal ?? '').trim().toLowerCase();
    if (ok(e)) return { value: e, source: 'env' };
    // A number is a typed value too (`strongerModelFromRound: 4`); arrays, objects and booleans are not stringified.
    const f = typeof fileVal === 'string' ? fileVal.trim().toLowerCase() : Number.isInteger(fileVal) ? String(fileVal) : '';
    if (ok(f)) return { value: f, source: 'settings' };
    return { value: dflt, source: 'built-in' };
  };
  // The setting that can START a takeover fails CLOSED: the first layer that is present (a non-blank env var, or a
  // file key that is not null) decides, and a present value that does not parse turns the takeover off (`person`)
  // instead of falling through to the built-in `takeover` — so a typo meant to stop it never enables it. (The per-PR
  // count, `fix.takeoverBudget`, fails closed the same way: `takeover-budget.mjs#resolveTakeoverBudget`.)
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
  const action = failClosed(env.WE_FIX_ROUND_CAP_ACTION, fromFile.roundCapAction, parseAction, 'person', FIX_SETTINGS_DEFAULTS.roundCapAction);
  const history = pick(env.WE_FIX_ROUND_HISTORY, fromFile.roundHistory, (v) => ONOFF.includes(v), FIX_SETTINGS_DEFAULTS.roundHistory);
  // Card xrbu1bp — resume the previous round's session (on|off) and the round the stronger-model rung starts at (0 = off).
  const resume = pick(env.WE_FIX_RESUME_ACROSS_ROUNDS, fromFile.resumeAcrossRounds, (v) => ONOFF.includes(v), FIX_SETTINGS_DEFAULTS.resumeAcrossRounds);
  const from = pick(env.WE_FIX_STRONGER_MODEL_FROM_ROUND, fromFile.strongerModelFromRound, (v) => /^\d{1,2}$/.test(v), String(FIX_SETTINGS_DEFAULTS.strongerModelFromRound));
  // Keep malformed containers as invalid leaves, rather than letting the cascade traverse their children.
  const capacityLeaf = value => value === undefined || typeof value === 'string' || Number.isInteger(value) ? value : null;
  // R123 is ruled on: automatic answers are enabled at the standard layer. A present malformed
  // switch fails closed; a missing layer inherits. Explicit dispatch arguments still take precedence.
  const autoProceed = value => value === undefined ? undefined : value === true;
  const platformLayer = platform === undefined ? platformPreference('fix', { env }) : platform;
  const envAutoProceed = env.WE_FIX_STAND_DOWN_AUTO_PROCEED;
  // Standard → platform → tool → env. Opus is reachable only through the critical-work verdict.
  const model = cascadePolicy('fix', {
    claudeEscalationModel: fromFile.claudeEscalationModel,
    capacityStarvationHours: capacityLeaf(fromFile.capacityStarvationHours),
    standDownAutoProceed: autoProceed(layer === INVALID_LAYER ? false : fromFile.standDownAutoProceed),
  }, {
    standard: { claudeEscalationModel: 'sonnet', standDownAutoProceed: true,
      capacityStarvationHours: FIX_SETTINGS_DEFAULTS.capacityStarvationHours },
    platform: { ...platformLayer, standDownAutoProceed: autoProceed(platformLayer?.standDownAutoProceed),
      capacityStarvationHours: capacityLeaf(platformLayer?.capacityStarvationHours) }, env,
    envValues: {
      claudeEscalationModel: env.WE_FIX_CLAUDE_ESCALATION_MODEL,
      capacityStarvationHours: capacityLeaf(env.WE_FIX_CAPACITY_STARVATION_HOURS),
      standDownAutoProceed: envAutoProceed === undefined ? undefined
        : ['true', '1', 'on'].includes(String(envAutoProceed).trim().toLowerCase()),
    },
    valid: { claudeEscalationModel: value => ['haiku', 'sonnet'].includes(value),
      capacityStarvationHours: value => /^\d{1,3}$/.test(String(value).trim()) && Number(value) >= 1,
      standDownAutoProceed: value => typeof value === 'boolean' },
  });
  return {
    roundCapAction: action.value, roundHistory: history.value,
    resumeAcrossRounds: resume.value, strongerModelFromRound: Number(from.value),
    capacityStarvationHours: Number(model.value.capacityStarvationHours),
    claudeEscalationModel: model.value.claudeEscalationModel,
    standDownAutoProceed: model.value.standDownAutoProceed,
    sources: {
      roundCapAction: action.source, roundHistory: history.source,
      resumeAcrossRounds: resume.source, strongerModelFromRound: from.source,
      // Preserve the public provenance labels used before this leaf joined the shared cascade.
      capacityStarvationHours: ({ standard: 'built-in', tool: 'settings' })[model.sources.capacityStarvationHours]
        ?? model.sources.capacityStarvationHours,
      claudeEscalationModel: model.sources.claudeEscalationModel,
      standDownAutoProceed: model.sources.standDownAutoProceed,
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

/** True when a launch fault was reported for the latest standing start but the void allowance was already used. */
export function takeoverVoidRefused(comments) {
  return takeoverLedger(comments).refusedVoid;
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

/** The durable marker comment, posted before the takeover session starts (the per-head bound; each one is one
 *  takeover of the PR's `fix.takeoverBudget`). `n`/`budget` are optional: absent, the text names no count. */
export function takeoverMarkerBody({ pr, head, attempts, cap, rung, n = null, budget = null }) {
  const which = Number.isInteger(n) && Number.isInteger(budget) ? `Takeover ${n} of ${budget}` : 'One takeover session';
  // `attempts=N` is the count the takeover launched at: its own re-arm lands at N+1, and that is what the review
  // allowance is measured from (a takeover can start above the cap when several counts ran ahead of the rearm count).
  const launchCount = Number.isSafeInteger(attempts) && attempts >= 0 ? ` attempts=${attempts}` : '';
  return `${FIX_TAKEOVER_MARKER} head=${head ?? 'unknown'}${launchCount} -->\n`
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
