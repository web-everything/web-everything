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
 *
 *   Identity is EXACT (operator send-back 2026-10-13, #4): the live token's GraphQL viewer must be a `Bot` with the
 *   reviewer App's slug, and "our" reviews are those whose REST user is type `Bot` with login `<slug>[bot]`. A human
 *   account whose login merely normalises to the App's slug never matches.
 *
 *   A clearing verdict (rearm/restamp/clear-human, or an accept lifting our stale change request) can run under a
 *   token that is not the reviewer App, e.g. the operator's clear-human. Its dismissal then runs with the reviewer
 *   App's own installation token (the shared cache, else minted now); with no token it is queued
 *   ({@link nativeReviewQueuePath}) and the next run as the reviewer App dismisses it before its own work.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readSettings } from './settings-files.mjs';
import { platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { readDeliveryIdentity, roleCachePath, LEGACY_BOT_LOGINS, ROLE_ENV } from './github-app-identity.mjs';
import { defaultCachePath, isCacheFresh } from './github-app-auth-env.mjs';
import { installationCachePath } from './github-app-installations.mjs';
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
    if ((f.outcome === 'posted' || f.outcome === 'already-posted') && f.agree !== 'no') mirrored++;
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

const DECISIVE = Object.freeze(['APPROVED', 'CHANGES_REQUESTED']);
/** The decisive event whose landing supersedes our earlier opposite review on GitHub (no dismissal needed). */
const SUPERSEDING = Object.freeze({ APPROVE: true, REQUEST_CHANGES: true });

/**
 * Map a reviewed, pinned verdict to a native review and the states of our own standing reviews it must dismiss. Pure.
 * A verdict that returns the PR to pending (`rearm`, `restamp`) leaves no bot verdict of ours standing (operator
 * send-back #2): a pending label never sits beside a bot APPROVE or REQUEST_CHANGES.
 */
export function planNativeReview({ verdict, labels = [], headSha }) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return { event: null, dismiss: [], reason: 'no-reviewed-head' };
  if (verdict === 'accepted') {
    const human = labels.some(label => (typeof label === 'string' ? label : label?.name) === 'review:human');
    if (human) return { event: 'COMMENT', dismiss: [...DECISIVE], reason: 'human-review: the approval must come from the operator' };
    return { event: 'APPROVE', dismiss: ['CHANGES_REQUESTED'], reason: '' };
  }
  if (verdict === 'changes') return { event: 'REQUEST_CHANGES', dismiss: ['APPROVED'], reason: '' };
  if (verdict === 'advisory') return { event: 'COMMENT', dismiss: [], reason: '' };
  if (verdict === 'clear-human') return { event: null, dismiss: ['CHANGES_REQUESTED'], reason: "human-cleared: the operator's own approval is the native one" };
  if (verdict === 'rearm' || verdict === 'restamp') return { event: null, dismiss: [...DECISIVE], reason: 'returned-to-pending: no verdict of ours stands' };
  return { event: null, dismiss: [], reason: 'not-a-review-verdict' };
}

/** Compare CONFIGURED GitHub App spellings consistently (settings only — never a live identity). Pure. */
export function normaliseLogin(login) {
  return String(login ?? '').trim().toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '');
}

/** The configured reviewer App's exact REST login, `<slug>[bot]`, or null when the setting is not an App slug. Pure. */
export function reviewerBotLogin(botLogin) {
  const m = /^(?:app\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\[bot\])?$/.exec(String(botLogin ?? '').trim().toLowerCase());
  return m ? `${m[1]}[bot]` : null;
}

/** Exactly the reviewer App as a REST user: type `Bot` and login `<slug>[bot]`. A human never matches. Pure. */
export function isReviewerBotUser(user, botLogin) {
  return !!botLogin && user?.type === 'Bot' && user?.login === botLogin;
}

/** The live token's GraphQL viewer is the reviewer App: `__typename` Bot and the exact slug (GraphQL omits `[bot]`). Pure. */
function viewerIsReviewer(viewer, botLogin) {
  return viewer?.type === 'Bot' && typeof viewer.login === 'string' && (viewer.login === botLogin || `${viewer.login}[bot]` === botLogin);
}

/**
 * Fail closed unless the live token belongs to the dedicated, non-author reviewer App. Pure. `viewer` and `prAuthor`
 * are `{login, type}`. A refusal past the configuration checks still names the expected `reviewerLogin`.
 */
export function checkReviewerIdentity({ identity, viewer, prAuthor }) {
  const reviewer = identity?.roles?.reviewer;
  if (!reviewer) return { ok: false, reason: 'reviewer-role-unconfigured' };
  const reviewerLogin = reviewerBotLogin(reviewer.botLogin);
  if (!reviewerLogin) return { ok: false, reason: 'reviewer-bot-login-unknown' };
  const slug = normaliseLogin(reviewerLogin);
  const worker = identity?.roles?.worker;
  if (LEGACY_BOT_LOGINS.some(login => normaliseLogin(login) === slug)
    || (normaliseLogin(worker?.botLogin) && normaliseLogin(worker.botLogin) === slug)
    || (reviewer.appId != null && worker?.appId != null && String(reviewer.appId) === String(worker.appId))) {
    return { ok: false, reason: 'reviewer-is-shared-app' };
  }
  if (!viewer?.login) return { ok: false, reason: 'viewer-unreadable', reviewerLogin };
  if (!viewerIsReviewer(viewer, reviewerLogin)) return { ok: false, reason: `token-is-not-reviewer (viewer=${viewer.login}${viewer.type ? ` ${viewer.type}` : ''})`, reviewerLogin };
  if (isReviewerBotUser(prAuthor, reviewerLogin)) return { ok: false, reason: 'reviewer-is-pr-author', reviewerLogin };
  return { ok: true, reviewerLogin };
}

/**
 * Decisive events deduplicate only against the reviewer's LATEST opinionated review (operator send-back #1): the
 * newest of its APPROVED, CHANGES_REQUESTED and DISMISSED reviews by id. An earlier matching review that a later
 * verdict or a dismissal superseded never counts. Pure.
 */
export function findExistingNativeReview({ reviews, head, event, reviewerLogin }) {
  if (!reviewerLogin || !EVENT_STATE[event]) return null;
  const own = (reviews ?? []).filter(review => isReviewerBotUser(review?.user, reviewerLogin));
  // Comments do not replace a decisive verdict; retain their per-head idempotency.
  if (event === 'COMMENT') return own.find(review => review.commit_id === head && review.state === 'COMMENTED') ?? null;
  const latest = own.reduce((last, review) => {
    if (!DECISIVE.includes(review.state) && review.state !== 'DISMISSED') return last;
    return !last || review.id > last.id ? review : last;
  }, null);
  return latest?.commit_id === head && latest.state === EVENT_STATE[event] ? latest : null;
}

/** Ids of this reviewer App's own still-standing reviews in `states` (any head). Pure. */
export function ownStandingReviews({ reviews, reviewerLogin, states }) {
  if (!reviewerLogin) return [];
  return (reviews ?? []).filter(review => isReviewerBotUser(review?.user, reviewerLogin)
    && (states ?? []).includes(review.state) && typeof review.id === 'number').map(review => review.id);
}

/** Fixed text and a machine marker; no PR title, body or findings are interpolated. Pure. */
export function nativeReviewBody({ verdict, event, head }) {
  const sha12 = head.slice(0, 12);
  let text = "Advisory only (review:human): the operator's own approval is required to merge.";
  if (event === 'APPROVE') text = `Mirror of our review verdict \`review:accepted\` on \`${sha12}\`.`;
  if (event === 'REQUEST_CHANGES') text = `Mirror of our review verdict \`review:changes\` on \`${sha12}\`; the findings are in the verdict comment on this PR.`;
  return `${text}\n\n<!-- native-review: ${JSON.stringify({ head, verdict, event })} -->`;
}

/**
 * One comparison line for the mirror observation ledger. Pure. `dismissal` (ok|queued|failed) reports the cleanup of
 * our own standing reviews; a queued or failed one leaves a bot verdict standing against the label, so it never agrees.
 */
export function formatComparisonLine({ repo, pr, head, labelVerdict, event, outcome, reason = '', mode, source, dismissal }) {
  let agree = ['posted', 'already-posted'].includes(outcome) ? 'yes' : event && ['skipped', 'failed'].includes(outcome) ? 'no' : 'n/a';
  if (dismissal === 'queued' || dismissal === 'failed') agree = 'no';
  const detail = String(reason).replace(/\s+/g, ' ').trim();
  return `native-review: repo=${repo} pr=${pr} head=${head?.slice(0, 12) || '-'} label=${labelVerdict} native=${event || 'none'} outcome=${outcome} agree=${agree}${dismissal ? ` dismissal=${dismissal}` : ''} mode=${mode}(${source})${detail ? ` reason=${detail}` : ''}`;
}

/** The pending-dismissal queue (one JSON entry per line), drained by the next run as the reviewer App. */
export function nativeReviewQueuePath(env = process.env) {
  return env.WE_NATIVE_REVIEW_DISMISSAL_QUEUE || join(homedir(), '.claude', 'conveyor', 'native-review-dismissals.jsonl');
}

/** A claim file older than this is taken over even if its owner pid is (or was reused as) alive. */
export const QUEUE_CLAIM_STALE_MS = 10 * 60 * 1000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * The file-backed queue. `claim()` renames the queue to a claim file named for this process, and takes over another
 * drainer's claim only when its pid is gone or the claim is stale ({@link QUEUE_CLAIM_STALE_MS}), so two live
 * drainers never process the same entries. An append whose open raced the rename lands in the claim file after it
 * was read; `done()` re-reads each claim and re-queues any such late line before deleting it.
 */
export function fileDismissalQueue(path, { now = () => Date.now(), alive = pidAlive } = {}) {
  const dir = dirname(path);
  const base = basename(path);
  const claimRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.claim-(\\d+)-`);
  const takeable = (name) => {
    if (name === base) return true;
    const m = claimRe.exec(name);
    if (!m) return false;
    if (!alive(Number(m[1]))) return true;
    try { return now() - statSync(join(dir, name)).mtimeMs > QUEUE_CLAIM_STALE_MS; } catch { return false; }
  };
  const append = (text) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, text);
  };
  return {
    append(entry) { append(`${JSON.stringify(entry)}\n`); return true; },
    claim() {
      let names = [];
      try { names = readdirSync(dir).filter(takeable); } catch { names = []; }
      const claims = [];
      const entries = [];
      for (const name of names) {
        const claim = join(dir, `${base}.claim-${process.pid}-${randomUUID()}`);
        try { renameSync(join(dir, name), claim); } catch { continue; }
        let text = '';
        try { text = readFileSync(claim, 'utf8'); } catch { text = ''; }
        claims.push({ claim, length: text.length });
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try { entries.push(JSON.parse(line)); } catch { /* A torn line is dropped. */ }
        }
      }
      return {
        entries,
        done() {
          for (const { claim, length } of claims) {
            try {
              const late = readFileSync(claim, 'utf8').slice(length);
              if (late.trim()) append(late.endsWith('\n') ? late : `${late}\n`);
              unlinkSync(claim);
            } catch { /* Kept: the next drainer re-claims it once this pid is gone. */ }
          }
        },
      };
    },
  };
}

/** Mint an installation token synchronously in a child process (minting is async; this shell is not). */
function mintTokenSync({ appId, installationId, key, env }) {
  const script = [
    'const m = await import(process.env.WE_NRV_MODULE);',
    'const key = JSON.parse(process.env.WE_NRV_KEY);',
    "const r = await m.mintInstallationToken({ appId: process.env.WE_NRV_APP, installationId: process.env.WE_NRV_INSTALLATION, privateKeyPath: key.file ?? `keychain:${key.keychain.service}`, ...(key.keychain ? { readKey: () => m.readPrivateKeyRef(key) } : {}) });",
    'process.stdout.write(r.token);',
  ].join('\n');
  return String(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...env, WE_NRV_MODULE: new URL('./github-app-token.mjs', import.meta.url).href, WE_NRV_KEY: JSON.stringify(key), WE_NRV_APP: String(appId), WE_NRV_INSTALLATION: String(installationId) },
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  })).trim();
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The reviewer App's installation token for `repo`'s owner: the fleet's shared role cache when fresh, else minted
 * now. Returns `{token}` or `{reason}`. Never throws, never logs the token.
 */
export function readReviewerToken({ identity, repo, env = process.env, now = Date.now(), cachePath = defaultCachePath(), readCache = readJsonFile, mintSync = mintTokenSync }) {
  const app = identity?.roles?.reviewer;
  if (!app?.appId || !app.installations || !app.key) return { reason: 'reviewer-app-unconfigured' };
  const owner = String(repo ?? '').split('/')[0].toLowerCase();
  const installationId = app.installations[owner];
  if (!installationId) return { reason: `reviewer-app-not-installed (${owner})` };
  const base = roleCachePath(cachePath, app.appId);
  for (const path of [installationCachePath(base, installationId), base]) {
    const cached = readCache(path);
    if (isCacheFresh(cached, now) && typeof cached.token === 'string' && cached.token
      && String(cached.appId) === String(app.appId) && String(cached.installationId) === String(installationId)) return { token: cached.token };
  }
  try {
    const token = mintSync({ appId: app.appId, installationId, key: app.key, env });
    return token ? { token } : { reason: 'reviewer-token-unavailable' };
  } catch (error) { return { reason: `reviewer-token-unavailable: ${failureReason(error)}` }; }
}

/** The default reviewer-token exec: `gh` with the reviewer App's token. Never mints under test. */
function defaultReviewerExec({ repo, identity, env, underTest }) {
  if (underTest) return { reason: 'reviewer-token-unavailable: under-test' };
  const got = readReviewerToken({ identity, repo, env });
  if (!got.token) return { reason: got.reason };
  const tokenEnv = { ...env, GH_TOKEN: got.token, [ROLE_ENV]: 'reviewer' };
  return { exec: argv => runGhSync(argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: tokenEnv }) };
}

/** The live token's GraphQL viewer as `{login, type}`; empty when unreadable. */
function readViewer(run) {
  try {
    const raw = String(run(['api', 'graphql', '-f', 'query=query{viewer{__typename login}}', '--jq', '.data.viewer | "\\(.__typename) \\(.login)"'])).trim();
    const space = raw.indexOf(' ');
    return space > 0 ? { type: raw.slice(0, space), login: raw.slice(space + 1) } : { type: '', login: raw };
  } catch { return { type: '', login: '' }; }
}

/** The PR's full review history; throws when any row is unreadable. */
function readReviews(run, endpoint) {
  // A deleted account's review has `user: null`: read it as nobody's, never as an unreadable history.
  const raw = run(['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', `${endpoint}/reviews`, '--jq', '.[] | {id, state, commit_id, user: {login: (.user.login // ""), type: (.user.type // "")}}']);
  const reviews = String(raw).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (reviews.some(review => !review || typeof review.id !== 'number' || typeof review.state !== 'string'
    || typeof review.commit_id !== 'string' || typeof review.user?.login !== 'string' || typeof review.user?.type !== 'string')) throw new Error('reviews-unreadable');
  return reviews;
}

function dismiss(run, endpoint, id, verdict, head) {
  run(['api', '--method', 'PUT', `${endpoint}/reviews/${id}/dismissals`, '-f', 'event=DISMISS', '-f', `message=Superseded: our review verdict is now ${verdict} on ${head.slice(0, 12)}.`]);
}

const QUEUE_MAX_ATTEMPTS = 20;
const validQueueEntry = entry => entry && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo ?? '') && Number.isInteger(entry.pr) && entry.pr > 0
  && /^[0-9a-f]{40}$/.test(entry.head ?? '') && /^[a-z-]{1,32}$/.test(entry.verdict ?? '')
  && Array.isArray(entry.ids) && entry.ids.length > 0 && entry.ids.every(id => Number.isInteger(id) && id > 0);

/** The review states our CURRENT label verdict stands behind; a queued dismissal never removes one of them. Pure. */
export function endorsedStates(labels) {
  const names = (labels ?? []).map(label => (typeof label === 'string' ? label : label?.name));
  const endorsed = [];
  if (names.includes('review:changes')) endorsed.push('CHANGES_REQUESTED');
  if (names.includes('review:accepted') && !names.includes('review:human')) endorsed.push('APPROVED');
  return endorsed;
}

/**
 * Dismiss every queued review that is still one of ours, still standing, and not endorsed by the PR's CURRENT label
 * (a later verdict may agree with it again), running as the reviewer App. Only the ids recorded at queue time are
 * touched. Entries for another owner wait for a run there; failures re-queue up to {@link QUEUE_MAX_ATTEMPTS}, and a
 * give-up is logged as a disagreement. Never throws.
 */
function drainDismissalQueue({ queue, run, owner, reviewerLogin, record }) {
  let claimed;
  try { claimed = queue.claim(); } catch { return; }
  const retry = [];
  for (const entry of claimed?.entries ?? []) {
    if (!validQueueEntry(entry)) continue;
    // This token is the reviewer App's installation for `owner` only.
    if (entry.repo.split('/')[0].toLowerCase() !== owner) { retry.push(entry); continue; }
    const endpoint = `repos/${entry.repo}/pulls/${entry.pr}`;
    const line = { repo: entry.repo, pr: entry.pr, head: entry.head, labelVerdict: entry.verdict, event: null };
    const attempt = { ...entry, attempts: (Number(entry.attempts) || 0) + 1 };
    let reviews;
    let endorsed;
    try {
      endorsed = endorsedStates(JSON.parse(run(['api', `repos/${entry.repo}/issues/${entry.pr}`, '--jq', '[.labels[].name]'])));
      reviews = readReviews(run, endpoint);
    } catch (error) {
      retry.push(attempt);
      record({ ...line, outcome: 'failed', dismissal: 'failed', reason: `queued dismissal: ${failureReason(error)}` });
      continue;
    }
    const standing = new Set(ownStandingReviews({ reviews, reviewerLogin, states: DECISIVE.filter(state => !endorsed.includes(state)) }));
    const left = [];
    const errors = [];
    let dismissed = 0;
    for (const id of entry.ids) {
      if (!standing.has(id)) continue;
      try { dismiss(run, endpoint, id, entry.verdict, entry.head); dismissed++; }
      catch (error) { left.push(id); errors.push(`dismissal ${id}: ${failureReason(error)}`); }
    }
    if (left.length) retry.push({ ...attempt, ids: left });
    if (dismissed || left.length) record({ ...line, outcome: left.length ? 'failed' : 'dismissed', dismissal: left.length ? 'failed' : 'ok', reason: ['queued dismissal', ...errors].join('; ') });
  }
  for (const entry of retry) {
    if ((Number(entry.attempts) || 0) >= QUEUE_MAX_ATTEMPTS) {
      record({ repo: entry.repo, pr: entry.pr, head: entry.head, labelVerdict: entry.verdict, event: null, outcome: 'failed', dismissal: 'failed', reason: `queued dismissal given up after ${entry.attempts} attempts` });
      continue;
    }
    try { queue.append(entry); } catch { /* Best effort: the claim file is kept below so the next drainer retries. */ return; }
  }
  try { claimed?.done?.(); } catch { /* Best effort. */ }
}

/** Preserve the actionable last stderr line on gh failures. */
function failureReason(error) {
  const lines = String(error?.stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.at(-1) || String(error?.message ?? error ?? 'unexpected-error');
}

/**
 * Post the native mirror and clean up only our own standing reviews. Synchronous; never throws.
 * `reviewerExec({repo, identity, env, underTest})` → `{exec}` | `{reason}` supplies a `gh` running as the reviewer App
 * when the live token is someone else's (default: {@link readReviewerToken}); `queue` is the pending-dismissal queue
 * (default: {@link fileDismissalQueue} at {@link nativeReviewQueuePath}; none under test).
 */
export function mirrorNativeReview({ repo, pr, verdict, labels = [], headSha, env = process.env, exec, identity, mode: modeOpt, log = line => process.stderr.write(line + '\n'), appendLog, reviewerExec, queue } = {}) {
  let event = null;
  let mode = { mode: STANDARD_NATIVE_REVIEW_MODE, source: 'standard' };
  let underTest = true;
  const append = (line) => {
    try {
      if (appendLog) appendLog(line);
      else if (!underTest) {
        const path = nativeReviewLogPath(env);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, line + '\n');
      }
    } catch { /* The comparison ledger is best effort. */ }
  };
  // A queued dismissal drained on this run reports under its own PR, head and verdict.
  const record = (fields) => {
    const line = formatComparisonLine({ ...fields, ...mode });
    try { log(line); } catch { /* stderr is best effort here; the ledger still gets the line. */ }
    append(line);
  };
  const finish = (outcome, reason = '', extra = {}) => {
    const { dismissal, ...rest } = extra;
    const result = { outcome, event, reason, line: '', ...rest };
    if (['off', 'not-applicable'].includes(outcome)) return result;
    result.line = formatComparisonLine({ repo, pr, head: headSha, labelVerdict: verdict, event, outcome, reason, dismissal, ...mode });
    try { log(result.line); }
    catch (error) {
      result.outcome = 'failed';
      result.reason = [reason, failureReason(error)].filter(Boolean).join('; ');
      result.line = formatComparisonLine({ repo, pr, head: headSha, labelVerdict: verdict, event, outcome: result.outcome, reason: result.reason, dismissal, ...mode });
    }
    append(result.line);
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
    if (!event && !plan.dismiss.length) return finish('not-applicable', plan.reason);
    const endpoint = `repos/${repo}/pulls/${pr}`;
    let live;
    try {
      live = JSON.parse(run(['api', endpoint, '--jq', '{head: .head.sha, author: .user.login, authorType: .user.type, state: .state}']));
      if (!live || typeof live.head !== 'string' || typeof live.author !== 'string' || !live.author.trim() || typeof live.authorType !== 'string' || typeof live.state !== 'string') return finish('skipped', 'pr-unreadable');
    } catch { return finish('skipped', 'pr-unreadable'); }
    if (live.state !== 'open') return finish('skipped', 'pr-not-open');
    // A review is pinned to the reviewed head; dismissing our own review is not, so a push racing a rearm or a
    // clearance never leaves our verdict standing beside the label.
    if (live.head !== headSha && event) return finish('skipped', `head-moved (live=${live.head.slice(0, 12)})`);
    const resolvedIdentity = identity ?? readDeliveryIdentity({ env });
    const prAuthor = { login: live.author, type: live.authorType };
    const checked = checkReviewerIdentity({ identity: resolvedIdentity, viewer: readViewer(run), prAuthor });
    // Only a token that is simply not the reviewer App's may hand a dismissal to the reviewer App; a misconfigured
    // reviewer, or one that authored the PR, is refused outright.
    const otherToken = !checked.ok && /^(token-is-not-reviewer|viewer-unreadable)/.test(checked.reason);
    if (!checked.ok && !(otherToken && plan.dismiss.length)) return finish('skipped', checked.reason);
    const reviewerLogin = checked.reviewerLogin;
    const pending = queue ?? (underTest ? null : fileDismissalQueue(nativeReviewQueuePath(env)));
    // As the reviewer App, first finish any dismissal an earlier non-reviewer run queued, then read this PR fresh.
    if (checked.ok && pending) drainDismissalQueue({ queue: pending, run, owner: String(repo).split('/')[0].toLowerCase(), reviewerLogin, record });
    let reviews;
    try { reviews = readReviews(run, endpoint); }
    catch { return finish('skipped', checked.ok ? 'reviews-unreadable' : `${checked.reason}; reviews-unreadable`); }
    let outcome = 'not-applicable';
    let reason = plan.reason;
    if (event && !checked.ok) { outcome = 'skipped'; reason = checked.reason; }
    else if (event) {
      if (findExistingNativeReview({ reviews, head: headSha, event, reviewerLogin })) outcome = 'already-posted';
      else {
        try {
          run(['api', '--method', 'POST', `${endpoint}/reviews`, '-f', `commit_id=${headSha}`, '-f', `event=${event}`, '-f', `body=${nativeReviewBody({ verdict, event, head: headSha })}`]);
          outcome = 'posted';
        } catch (error) { outcome = 'failed'; reason = failureReason(error); }
      }
    }
    // A landed APPROVE or REQUEST_CHANGES supersedes our opposite review on GitHub; anything else dismisses it.
    const superseded = SUPERSEDING[event] && ['posted', 'already-posted'].includes(outcome);
    const ids = superseded ? [] : ownStandingReviews({ reviews, reviewerLogin, states: plan.dismiss });
    if (!checked.ok && !ids.length) return finish('skipped', checked.reason);
    let dismissed = 0;
    let queued = 0;
    const dismissalErrors = [];
    let writer = checked.ok ? run : null;
    if (ids.length && !writer) {
      // A clearing verdict under another token (e.g. the operator's clear-human): dismiss as the reviewer App.
      let got;
      try { got = (reviewerExec ?? defaultReviewerExec)({ repo, identity: resolvedIdentity, env, underTest }) ?? {}; }
      catch (error) { got = { reason: `reviewer-token-unavailable: ${failureReason(error)}` }; }
      let unavailable = got.reason || 'reviewer-token-unavailable';
      if (typeof got.exec === 'function') {
        const proven = checkReviewerIdentity({ identity: resolvedIdentity, viewer: readViewer(got.exec), prAuthor });
        if (proven.ok && proven.reviewerLogin === reviewerLogin) writer = got.exec;
        else unavailable = `reviewer token refused: ${proven.reason}`;
      }
      if (!writer) {
        try {
          if (!pending) throw new Error('no dismissal queue');
          pending.append({ v: 1, repo, pr: Number(pr), head: headSha, verdict, ids, at: new Date().toISOString() });
          queued = ids.length;
          reason = [reason, `dismissal queued for the reviewer App (${unavailable})`].filter(Boolean).join('; ');
        } catch (error) { dismissalErrors.push(`dismissal not queued (${unavailable}): ${failureReason(error)}`); }
      }
    }
    if (writer) {
      for (const id of ids) {
        try { dismiss(writer, endpoint, id, verdict, headSha); dismissed++; }
        catch (error) { dismissalErrors.push(`dismissal ${id}: ${failureReason(error)}`); }
      }
    }
    if (dismissalErrors.length) reason = [reason, ...dismissalErrors].filter(Boolean).join('; ');
    const dismissal = dismissalErrors.length ? 'failed' : queued ? 'queued' : ids.length ? 'ok' : undefined;
    if (!event) outcome = dismissalErrors.length ? 'failed' : queued ? 'queued' : dismissed ? 'dismissed' : 'not-applicable';
    return finish(outcome, reason, plan.dismiss.length ? { dismissed, ...(queued ? { queued } : {}), dismissal } : {});
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
