/**
 * @file scripts/lib/native-github-review.mjs
 * @description Native GitHub reviews mirroring the label verdict under the REVIEWER App identity.
 *
 *   `review.nativeGithubReview` cascades from standard (`off`) to platform, tool, then
 *   WE_REVIEW_NATIVE_GITHUB_REVIEW. Only valid values answer a layer.
 *   `off`           — no native review or comparison log.
 *   `mirror`        — post the native review in addition to today's label verdict; change no gates.
 *   `authoritative` — RESERVED: documented, but behaves exactly like mirror in this module.
 *                     Promotion to GitHub's required approval replacing the custom review-gate
 *                     check is the operator's ruleset step after mirror proves out.
 *
 *   Pure policy, identity and review planning helpers; a small synchronous IO shell that never
 *   throws or writes stdout. All writes require a live, open PR at the reviewed SHA, proven
 *   reviewer identity (distinct from worker and author), and readable review history.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readSettings } from './settings-files.mjs';
import { platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { readDeliveryIdentity, LEGACY_BOT_LOGINS } from './github-app-identity.mjs';
import { isUnderTest } from './under-test.mjs';
import { runGhSync } from './gh-throttle.mjs';

export const NATIVE_REVIEW_MODES = Object.freeze(['off', 'mirror', 'authoritative']);
export const NATIVE_REVIEW_ENV = 'WE_REVIEW_NATIVE_GITHUB_REVIEW';
export const STANDARD_NATIVE_REVIEW_MODE = 'off';
export const EVENT_STATE = Object.freeze({ APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' });

/** A recognised mode, or null when the layer does not answer. Pure. */
export function parseNativeReviewMode(v) {
  if (typeof v !== 'string') return null;
  const value = v.trim().toLowerCase();
  return NATIVE_REVIEW_MODES.includes(value) ? value : null;
}

/** Resolve review blocks through the policy cascade. Pure. */
export function resolveNativeReviewMode({ platform = null, tool = null, env = {} } = {}) {
  let mode = STANDARD_NATIVE_REVIEW_MODE;
  let source = 'standard';
  const invalid = [];
  // The block is `{mode, promotion}`; a bare string is the mode (the first shape this setting shipped with).
  const modeOf = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v.mode : v);
  const layers = [['platform', modeOf(platform?.nativeGithubReview)], ['tool', modeOf(tool?.nativeGithubReview)], ['env', env?.[NATIVE_REVIEW_ENV]]];
  for (const [name, raw] of layers) {
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) continue;
    const parsed = parseNativeReviewMode(raw);
    if (parsed === null) { invalid.push(`${name}.nativeGithubReview=${JSON.stringify(raw)}`); continue; }
    mode = parsed;
    source = name;
  }
  return { mode, source, invalid };
}

/** Read the review blocks independently. A failed reader leaves that layer unset. Never throws. */
export function loadNativeReviewMode({ env = process.env, readTool = () => readSettings()?.review, readPlatform = () => platformPreference('review', { env }) } = {}) {
  let platform = null;
  let tool = null;
  try { platform = readPlatform(); } catch { /* Unset layer. */ }
  try { tool = readTool(); } catch { /* Unset layer. */ }
  try { return resolveNativeReviewMode({ platform, tool, env }); }
  catch { return { mode: STANDARD_NATIVE_REVIEW_MODE, source: 'standard', invalid: [] }; }
}

// ── review.nativeGithubReview.promotion (operator decision 2026-10-13 ~13:55 ET: measure the trial by COUNT) ──────
// `{ minMirroredVerdicts, maxMismatches }` — the bar the mirror trial must clear before the operator MAY switch the mode
// to `authoritative` together with the ruleset change. READ-ONLY: nothing here ever changes the mode; reaching the bar
// only prints `ready=yes`. Cascade per leaf: standard {50, 0} → platform preference (`review.nativeGithubReview.promotion`)
// → tool (`we:scripts/settings/native-github-review.json`). Each leaf answers only with a valid integer
// (minMirroredVerdicts ≥ 1, maxMismatches ≥ 0); an invalid one is named in `invalid` and the lower layer stands.
export const STANDARD_PROMOTION = Object.freeze({ minMirroredVerdicts: 50, maxMismatches: 0 });
const PROMOTION_MIN = Object.freeze({ minMirroredVerdicts: 1, maxMismatches: 0 });

/** Resolve the promotion bar per leaf, with each leaf's source layer. Pure. */
export function resolvePromotionCriteria({ platform = null, tool = null } = {}) {
  const criteria = { ...STANDARD_PROMOTION };
  const sources = { minMirroredVerdicts: 'standard', maxMismatches: 'standard' };
  const invalid = [];
  for (const [name, block] of [['platform', platform?.nativeGithubReview?.promotion], ['tool', tool?.nativeGithubReview?.promotion]]) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const leaf of Object.keys(STANDARD_PROMOTION)) {
      const v = block[leaf];
      if (v === undefined || v === null) continue;
      if (!Number.isInteger(v) || v < PROMOTION_MIN[leaf]) { invalid.push(`${name}.promotion.${leaf}=${JSON.stringify(v)}`); continue; }
      criteria[leaf] = v;
      sources[leaf] = name;
    }
  }
  return { ...criteria, sources, invalid };
}

/** Read the promotion bar (never throws). */
export function loadPromotionCriteria({ env = process.env, readTool = () => readSettings()?.review, readPlatform = () => platformPreference('review', { env }) } = {}) {
  let platform = null;
  let tool = null;
  try { platform = readPlatform(); } catch { /* Unset layer. */ }
  try { tool = readTool(); } catch { /* Unset layer. */ }
  const c = resolvePromotionCriteria({ platform, tool });
  logCascadeSources('review.nativeGithubReview.promotion', { value: { minMirroredVerdicts: c.minMirroredVerdicts, maxMismatches: c.maxMismatches }, sources: c.sources, invalid: c.invalid }, { env });
  return c;
}

/** Skips that say nothing about agreement: the mirror never got to compare (no reviewer yet, the head moved on, closed PR). */
export const NEUTRAL_SKIP_REASONS = Object.freeze(['reviewer-role-unconfigured', 'head-moved', 'pr-not-open', 'under-test']);

/** One `native-review:` line → its fields, or null. Pure. */
export function parseComparisonLine(line) {
  const m = /^native-review: (.*)$/.exec(String(line ?? '').trim());
  if (!m) return null;
  const fields = {};
  const [head, reason] = m[1].split(/ reason=/, 2);
  for (const part of head.split(' ')) { const i = part.indexOf('='); if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1); }
  if (reason !== undefined) fields.reason = reason;
  return fields.repo && fields.pr && fields.label ? fields : null;
}

/**
 * Count the trial. Pure. The LATEST line per (repo, PR, head, label verdict) wins, so a retry that posted clears an
 * earlier failure and a repeat does not count twice. Mirrored = `posted` or `already-posted`. Mismatch = a planned
 * native review that did not land (`agree=no`), except a neutral skip ({@link NEUTRAL_SKIP_REASONS}), which counts as
 * neither. `ready` is a report, never an action.
 */
export function summarizeReadiness(lines, criteria = STANDARD_PROMOTION) {
  const latest = new Map();
  for (const raw of lines ?? []) {
    const f = parseComparisonLine(raw);
    if (!f) continue;
    latest.set(`${f.repo}#${f.pr}@${f.head}:${f.label}`, f);
  }
  let mirrored = 0;
  let mismatches = 0;
  for (const f of latest.values()) {
    if (f.outcome === 'posted' || f.outcome === 'already-posted') mirrored++;
    else if (f.agree === 'no' && !NEUTRAL_SKIP_REASONS.some((r) => String(f.reason ?? '').startsWith(r))) mismatches++;
  }
  const ready = mirrored >= criteria.minMirroredVerdicts && mismatches <= criteria.maxMismatches;
  return { mirrored, mismatches, ready, min: criteria.minMirroredVerdicts, maxMismatches: criteria.maxMismatches };
}

/** The readiness line. Pure. */
export function formatReadinessLine(s, criteria) {
  const src = criteria?.sources ? ` (bar: min ${criteria.sources.minMirroredVerdicts}, max ${criteria.sources.maxMismatches})` : '';
  return `native-review readiness: ${s.mirrored} of ${s.min} mirrored verdicts, ${s.mismatches} mismatches against our label verdict `
    + `(max ${s.maxMismatches}), ready ${s.ready ? 'yes' : 'no'}${src} — switching to authoritative stays the operator's call, with the ruleset change`;
}

/** The comparison log's path (shared by the writer and the readiness reader). */
export function nativeReviewLogPath(env = process.env) {
  return env.WE_NATIVE_REVIEW_LOG || join(homedir(), '.claude', 'conveyor', 'native-review.log');
}

/** Map a reviewed, pinned verdict to a native review and any hold cleanup. Pure. */
export function planNativeReview({ verdict, labels = [], headSha }) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return { event: null, dismissOwnChanges: false, reason: 'no-reviewed-head' };
  if (verdict === 'accepted') {
    const human = labels.some(label => (typeof label === 'string' ? label : label?.name) === 'review:human');
    return { event: human ? 'COMMENT' : 'APPROVE', dismissOwnChanges: true, reason: human ? 'human-review: the approval must come from the operator' : '' };
  }
  if (verdict === 'changes') return { event: 'REQUEST_CHANGES', dismissOwnChanges: false, reason: '' };
  if (verdict === 'advisory') return { event: 'COMMENT', dismissOwnChanges: false, reason: '' };
  if (verdict === 'clear-human') return { event: null, dismissOwnChanges: true, reason: "human-cleared: the operator's own approval is the native one" };
  return { event: null, dismissOwnChanges: false, reason: 'not-a-review-verdict' };
}

/** Compare GitHub App spellings consistently. Pure. */
export function normaliseLogin(login) {
  return String(login ?? '').trim().toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/** Fail closed unless the live token belongs to the dedicated, non-author reviewer. Pure. */
export function checkReviewerIdentity({ identity, viewerLogin, prAuthorLogin }) {
  const reviewer = identity?.roles?.reviewer;
  if (!reviewer) return { ok: false, reason: 'reviewer-role-unconfigured' };
  const reviewerLogin = normaliseLogin(reviewer.botLogin);
  if (!reviewerLogin) return { ok: false, reason: 'reviewer-bot-login-unknown' };
  const worker = identity?.roles?.worker;
  if (LEGACY_BOT_LOGINS.some(login => normaliseLogin(login) === reviewerLogin)
    || (normaliseLogin(worker?.botLogin) && normaliseLogin(worker.botLogin) === reviewerLogin)
    || (reviewer.appId != null && worker?.appId != null && String(reviewer.appId) === String(worker.appId))) {
    return { ok: false, reason: 'reviewer-is-shared-app' };
  }
  const viewer = normaliseLogin(viewerLogin);
  if (!viewer) return { ok: false, reason: 'viewer-unreadable' };
  if (viewer !== reviewerLogin) return { ok: false, reason: `token-is-not-reviewer (viewer=${String(viewerLogin).trim()})` };
  if (normaliseLogin(prAuthorLogin) === viewer) return { ok: false, reason: 'reviewer-is-pr-author' };
  return { ok: true, reviewerLogin };
}

/** Idempotency is scoped to reviewer, head and event. Pure. */
export function findExistingNativeReview({ reviews, head, event, reviewerLogin }) {
  if (!reviewerLogin || !EVENT_STATE[event]) return null;
  return (reviews ?? []).find(review => normaliseLogin(review?.user?.login) === normaliseLogin(reviewerLogin)
    && review.commit_id === head && review.state === EVENT_STATE[event]) ?? null;
}

/** Only this reviewer's still-standing change requests can be dismissed. Pure. */
export function ownStandingChangeRequests({ reviews, reviewerLogin }) {
  if (!reviewerLogin) return [];
  return (reviews ?? []).filter(review => normaliseLogin(review?.user?.login) === normaliseLogin(reviewerLogin)
    && review.state === 'CHANGES_REQUESTED' && typeof review.id === 'number').map(review => review.id);
}

/** Fixed text and a machine marker; no PR title, body or findings are interpolated. Pure. */
export function nativeReviewBody({ verdict, event, head }) {
  const sha12 = head.slice(0, 12);
  let text = "Advisory only (review:human): the operator's own approval is required to merge.";
  if (event === 'APPROVE') text = `Mirror of our review verdict \`review:accepted\` on \`${sha12}\`.`;
  if (event === 'REQUEST_CHANGES') text = `Mirror of our review verdict \`review:changes\` on \`${sha12}\`; the findings are in the verdict comment on this PR.`;
  return `${text}\n\n<!-- native-review: ${JSON.stringify({ head, verdict, event })} -->`;
}

/** One comparison line for the mirror observation ledger. Pure. */
export function formatComparisonLine({ repo, pr, head, labelVerdict, event, outcome, reason = '', mode, source }) {
  const agree = ['posted', 'already-posted'].includes(outcome) ? 'yes' : event && ['skipped', 'failed'].includes(outcome) ? 'no' : 'n/a';
  const detail = String(reason).replace(/\s+/g, ' ').trim();
  return `native-review: repo=${repo} pr=${pr} head=${head?.slice(0, 12) || '-'} label=${labelVerdict} native=${event || 'none'} outcome=${outcome} agree=${agree} mode=${mode}(${source})${detail ? ` reason=${detail}` : ''}`;
}

/** Preserve the actionable last stderr line on gh failures. */
function failureReason(error) {
  const lines = String(error?.stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.at(-1) || String(error?.message ?? error ?? 'unexpected-error');
}

/** Post the native mirror and clean up only our own holds. Synchronous; never throws. */
export function mirrorNativeReview({ repo, pr, verdict, labels = [], headSha, env = process.env, exec, identity, mode: modeOpt, log = line => process.stderr.write(line + '\n'), appendLog } = {}) {
  let event = null;
  let mode = { mode: STANDARD_NATIVE_REVIEW_MODE, source: 'standard' };
  let underTest = true;
  const finish = (outcome, reason = '', extra = {}) => {
    const result = { outcome, event, reason, line: '', ...extra };
    if (['off', 'not-applicable'].includes(outcome)) return result;
    result.line = formatComparisonLine({ repo, pr, head: headSha, labelVerdict: verdict, event, outcome, reason, ...mode });
    try { log(result.line); }
    catch (error) {
      result.outcome = 'failed';
      result.reason = [reason, failureReason(error)].filter(Boolean).join('; ');
      result.line = formatComparisonLine({ repo, pr, head: headSha, labelVerdict: verdict, event, outcome: result.outcome, reason: result.reason, ...mode });
    }
    try {
      if (appendLog) appendLog(result.line);
      else if (!underTest) {
        const path = nativeReviewLogPath(env);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, result.line + '\n');
      }
    } catch { /* The comparison ledger is best effort. */ }
    return result;
  };
  try {
    underTest = isUnderTest(env);
    if (!exec && underTest) return { outcome: 'skipped', reason: 'under-test', event: null, line: '' };
    const run = exec ?? (argv => runGhSync(argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    mode = modeOpt ?? loadNativeReviewMode({ env });
    if (mode.mode === 'off') return finish('off');
    const plan = planNativeReview({ verdict, labels, headSha });
    event = plan.event;
    if (!event && !plan.dismissOwnChanges) return finish('not-applicable', plan.reason);
    const endpoint = `repos/${repo}/pulls/${pr}`;
    let live;
    try {
      live = JSON.parse(run(['api', endpoint, '--jq', '{head: .head.sha, author: .user.login, state: .state}']));
      if (!live || typeof live.head !== 'string' || typeof live.author !== 'string' || !live.author.trim() || typeof live.state !== 'string') return finish('skipped', 'pr-unreadable');
    } catch { return finish('skipped', 'pr-unreadable'); }
    if (live.state !== 'open') return finish('skipped', 'pr-not-open');
    if (live.head !== headSha) return finish('skipped', `head-moved (live=${live.head.slice(0, 12)})`);
    let viewerLogin = '';
    try { viewerLogin = String(run(['api', 'graphql', '-f', 'query=query{viewer{login}}', '--jq', '.data.viewer.login'])).trim(); }
    catch { /* Unreadable viewer fails the identity check. */ }
    const checked = checkReviewerIdentity({ identity: identity ?? readDeliveryIdentity({ env }), viewerLogin, prAuthorLogin: live.author });
    if (!checked.ok) return finish('skipped', checked.reason);
    let reviews;
    try {
      const raw = run(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', `${endpoint}/reviews`, '--jq', '.[] | {id, state, commit_id, user: {login: .user.login}}']);
      reviews = String(raw).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      if (reviews.some(review => !review || typeof review.id !== 'number' || typeof review.state !== 'string'
        || typeof review.commit_id !== 'string' || typeof review.user?.login !== 'string')) return finish('skipped', 'reviews-unreadable');
    } catch { return finish('skipped', 'reviews-unreadable'); }
    let outcome = 'not-applicable';
    let reason = plan.reason;
    if (event) {
      if (findExistingNativeReview({ reviews, head: headSha, event, reviewerLogin: checked.reviewerLogin })) outcome = 'already-posted';
      else {
        try {
          run(['api', '--method', 'POST', `${endpoint}/reviews`, '-f', `commit_id=${headSha}`, '-f', `event=${event}`, '-f', `body=${nativeReviewBody({ verdict, event, head: headSha })}`]);
          outcome = 'posted';
        } catch (error) { outcome = 'failed'; reason = failureReason(error); }
      }
    }
    let dismissed = 0;
    const dismissalErrors = [];
    if (plan.dismissOwnChanges && !(event === 'APPROVE' && ['posted', 'already-posted'].includes(outcome))) {
      for (const id of ownStandingChangeRequests({ reviews, reviewerLogin: checked.reviewerLogin })) {
        try {
          run(['api', '--method', 'PUT', `${endpoint}/reviews/${id}/dismissals`, '-f', 'event=DISMISS', '-f', `message=Superseded: our review verdict is now ${verdict} on ${headSha.slice(0, 12)}.`]);
          dismissed++;
        } catch (error) { dismissalErrors.push(`dismissal ${id}: ${failureReason(error)}`); }
      }
    }
    if (dismissalErrors.length) reason = [reason, ...dismissalErrors].filter(Boolean).join('; ');
    if (!event) outcome = dismissed ? 'dismissed' : dismissalErrors.length ? 'failed' : 'not-applicable';
    return finish(outcome, reason, plan.dismissOwnChanges ? { dismissed } : {});
  } catch (error) {
    try { return finish('failed', failureReason(error)); }
    catch { return { outcome: 'failed', event, reason: 'unexpected-error', line: '' }; }
  }
}

// ── READ-ONLY CLI: `node scripts/lib/native-github-review.mjs readiness [--log=<path>]` ─────────────────────────────
// Prints one readiness line. Never changes the mode, a setting or a ruleset. Exit 0 whatever the answer.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'readiness') {
  const logArg = process.argv.find((a) => a.startsWith('--log='));
  const path = logArg ? logArg.slice('--log='.length) : nativeReviewLogPath();
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { text = ''; }
  const criteria = loadPromotionCriteria({ env: { ...process.env, WE_POLICY_CASCADE_LOG: '0' } });
  process.stdout.write(`${formatReadinessLine(summarizeReadiness(text.split(/\r?\n/), criteria), criteria)}\n`);
}
