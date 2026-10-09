/**
 * @file scripts/conveyor/draft-promotion-rule.mjs — "is a draft owed promotion?" (draft-first PRs, operator-approved
 * 2026-09-27). PURE except {@link resolveDraftPromotionSettings}, which reads the settings file and fails to the default.
 *
 * Live 2026-10-09 (~06:00–07:00Z): drafts #4567, #4563, #4535 had every required check green and stayed draft for
 * 1 h+. The review daemon logged "owed a promote-draft, not a review" on every tick; health-watch raised
 * `draft-not-promoted`. The ONLY promoter was the fix daemon's tick (`reconcile-fix-dispatch-daemon.mjs` →
 * `promote-draft-pr-dispatch.mjs`), and that tick did not run at all from 05:53Z: each tick first runs the gated
 * self-sync rebuild (a 10–19 min smoke), and an adopted rebuild restarts the process INSTEAD of ticking. With `main`
 * moving faster than the smoke, the tick starved — and the cheapest owed action (one `gh pr ready`) starved with it.
 *
 * The fix moves the decision to a fast edge that does not wait on the tick (the fix daemon's own await-verify child,
 * see `draft-promotion-loop.mjs`). This rule is the decision; the caller re-reads the head's checks and labels
 * immediately before the one write (the #2811 stale-green guard), exactly like the tick's promote half.
 *
 * Owed promotion = open + draft + an agent lane branch (`lane/*`, what `pr-land --park` opens) + every required check
 * green FOR THE CURRENT HEAD + not withdrawn (`review-status:draft-withdrawn`). It never decides a review, a merge or
 * a label: un-drafting only lets the review daemon's own gates run (it still refuses fix-claimed, live-process, …).
 *
 * Declared setting `draft-promotion-settings.json` (`{ "draftPromotion": { "loop": "on", "intervalSeconds": 60 } }`).
 * Env `WE_DRAFT_PROMOTION_LOOP` / `WE_DRAFT_PROMOTION_INTERVAL_SECONDS` beat the file. A missing or malformed switch
 * is `off` (the behaviour before this file: only the fix daemon's tick promotes).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRAFT_PROMOTION_ENV = Object.freeze({ loop: 'WE_DRAFT_PROMOTION_LOOP', intervalSeconds: 'WE_DRAFT_PROMOTION_INTERVAL_SECONDS' });
export const DRAFT_PROMOTION_DEFAULTS = Object.freeze({ loop: false, intervalSeconds: 60 });
export const WITHDRAWN_LABEL = 'review-status:draft-withdrawn';
export const AGENT_HEAD_PREFIX = 'lane/';
const MIN_INTERVAL_SECONDS = 15;

export const draftPromotionSettingsPath = () => join(dirname(fileURLToPath(import.meta.url)), 'draft-promotion-settings.json');

const parseSwitch = (raw) => {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(on|true|1|yes)$/.test(s)) return true;
  if (/^(off|false|0|no)$/.test(s)) return false;
  return null;
};
const parseSeconds = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_INTERVAL_SECONDS ? Math.floor(n) : null;
};

/** The settings in force. Env beats the file; a set-but-unparseable switch override fails `off`. */
export function resolveDraftPromotionSettings(env = process.env, { path = draftPromotionSettingsPath(), read = readFileSync } = {}) {
  let file = {};
  try { file = JSON.parse(read(path, 'utf8'))?.draftPromotion ?? {}; } catch { file = {}; }
  if (!file || typeof file !== 'object') file = {};
  const loopEnv = env?.[DRAFT_PROMOTION_ENV.loop];
  const loop = loopEnv == null ? (parseSwitch(file.loop) ?? DRAFT_PROMOTION_DEFAULTS.loop) : (parseSwitch(loopEnv) ?? false);
  const intervalSeconds = parseSeconds(env?.[DRAFT_PROMOTION_ENV.intervalSeconds])
    ?? parseSeconds(file.intervalSeconds) ?? DRAFT_PROMOTION_DEFAULTS.intervalSeconds;
  return { loop, intervalSeconds };
}

const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/**
 * PURE. Is this PR owed `gh pr ready` right now?
 * @param {{pr?:{state?:string, isDraft?:boolean, headRefName?:string, headRefOid?:string, labels?:Array},
 *   checks?:{state?:string, sha?:string}|null}} o — `checks`: the required-check verdict read for `checks.sha`
 *   (`reduceCheckState`'s `green`/`pending`/`red`/`unchecked`); `null` = not read yet.
 * @returns {{owed:boolean, why:string}}
 */
export function isDraftOwedPromotion({ pr = {}, checks = null } = {}) {
  if (String(pr?.state ?? 'OPEN').toUpperCase() !== 'OPEN') return { owed: false, why: 'not open' };
  if (pr?.isDraft !== true) return { owed: false, why: 'not a draft' };
  if (!String(pr?.headRefName ?? '').startsWith(AGENT_HEAD_PREFIX)) return { owed: false, why: 'not an agent lane branch (draft-first covers lane/* only)' };
  if (labelNames(pr?.labels).includes(WITHDRAWN_LABEL)) return { owed: false, why: 'draft is withdrawn — explicit release is required before promotion' };
  if (!checks) return { owed: false, why: 'required checks not read yet' };
  if (!pr?.headRefOid || checks.sha !== pr.headRefOid) return { owed: false, why: 'check verdict is for a different head' };
  if (checks.state !== 'green') return { owed: false, why: `required checks read ${checks.state ?? 'unknown'}, not green` };
  return { owed: true, why: 'draft lane PR — every required check is green on its head; promote it to ready for review (draft-first PRs)' };
}

/** PURE. Cheap pre-filter on a PR-list row (no check read needed): could this draft be owed promotion at all? */
export function isPromotionCandidate(pr) {
  const r = isDraftOwedPromotion({ pr, checks: { state: 'green', sha: pr?.headRefOid } });
  return r.owed;
}

/** PURE. Is the promotion step due, given when it last ran? */
export function promotionStepDue({ settings, lastRunAtMs = null, nowMs }) {
  if (!settings?.loop) return false;
  if (lastRunAtMs == null) return true;
  return nowMs - lastRunAtMs >= settings.intervalSeconds * 1000;
}
