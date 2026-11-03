/**
 * @file scripts/conveyor/pr-sweep-core.mjs
 * @description Card 335 — pure PR movement ownership and per-PR read-gated episode planning; no IO or implicit clock.
 */
import { findFixerSession } from './health-smells/pr-no-owner.mjs';
import { parseSessionSlug } from './session-slug.mjs';
import { repoKeyForSlug, ghRepoSlug } from '../lib/constellation-repos.mjs';
export const prKey = (pr) => `${ghRepoSlug(pr.repo)}#${pr.number}`;
// Epoch numbers may arrive as numeric strings; everything else is an ISO date.
const ms = (v) => typeof v === 'number' ? v : /^\d+$/.test(String(v ?? '')) ? Number(v) : Date.parse(v);
export function classifyIdlePrs({ prs, now, idleMinutes }) {
  return prs.filter((p) => (!p.state || p.state.toUpperCase() === 'OPEN') && now - ms(p.updatedAt) > idleMinutes * 60000)
    .map((p) => ({ ...p, ageMin: (now - ms(p.updatedAt)) / 60000 }));
}
// Finished sessions stay listed as idle, offline, blocked or waiting, so only an
// explicit running value counts. Every present field (`state`, `status`) must
// be one; an absent or unknown value never grants ownership.
const RUNNING = new Set(['working', 'running', 'busy']);
const DONE_FLAGS = ['hung', 'idleFinished', 'authExpired', 'selfReportedDone'];
/** Running state and a live pid; the IO shell reads activity only for these rows. */
export function isRunningSession(a) {
  const vals = [a?.state, a?.status].filter((v) => v !== undefined && v !== null && v !== '').map((v) => String(v).toLowerCase());
  return vals.length > 0 && vals.every((v) => RUNNING.has(v)) && a.pidAlive === true && !DONE_FLAGS.some((f) => a[f] === true);
}
/**
 * 'yes' when running, alive and active within the window (a recent start counts);
 * 'unknown' when running and alive but its activity could not be read; else 'no'.
 * Timestamps beyond the one-minute clock-skew tolerance are not evidence. Unknown lasts only `unknownForMinutes` after the start.
 */
const OWNER_CLOCK_SKEW_MS = 60000;
export function sessionActivity(a, now, activeWithinMinutes = 30, unknownForMinutes = 90) {
  if (!isRunningSession(a)) return 'no';
  const valid = (v) => { const t = ms(v); return Number.isFinite(t) && t <= now + OWNER_CLOCK_SKEW_MS ? t : NaN; };
  const seen = Math.max(...[a.lastActivityAt, a.startedAt].map(valid).filter(Number.isFinite));
  if (Number.isFinite(seen) && now - seen <= activeWithinMinutes * 60000) return 'yes';
  const started = valid(a.startedAt);
  return a.activityUnknown === true && Number.isFinite(started) && now - started <= unknownForMinutes * 60000 ? 'unknown' : 'no';
}
// Only a PR-kind slug names its PR; item slugs (conveyor-N, prepare-N) and
// unnamed rows must not make a PR unreadable.
function namesPr(name, pr) {
  const slug = parseSessionSlug(name);
  if (slug) return !slug.itemKind && slug.repo === repoKeyForSlug(pr.repo) && Number(slug.id) === Number(pr.number);
  return repoKeyForSlug(pr.repo) === 'we' && Boolean(findFixerSession([{ name }], pr.number));
}
/** A bound session read failure freezes its PR even after the ownership budget expires. */
export function ownerSignalsReadable(pr, signals = {}) {
  return signals.readsOk !== false
    && !(signals.unreadSessions ?? []).some(name => namesPr(name, pr))
    && !(signals.sessions ?? []).some(a => namesPr(a.name, pr) && a.activityUnknown === true);
}
export function resolveOwner(pr, signals = {}) {
  const { now, stuckAfterMinutes = 90, sessionActiveWithinMinutes = 30, operator, smell, daemons = [], sessions = [], unreadSessions = [] } = signals;
  const base = { owner: null, state: 'none', why: 'No owner signal', ownerLastSeenAt: null };
  if (operator) return { ...base, owner: 'operator', state: 'waiting-operator', why: 'NEEDS YOU / RULING NEEDED' };
  const bound = sessions.filter((a) => {
    const slug = parseSessionSlug(a.name);
    return slug ? slug.repo === repoKeyForSlug(pr.repo) && Number(slug.id) === Number(pr.number)
      : (a.repo ? repoKeyForSlug(a.repo) === repoKeyForSlug(pr.repo) : repoKeyForSlug(pr.repo) === 'we');
  });
  const live = bound.filter((a) => sessionActivity(a, now, sessionActiveWithinMinutes) === 'yes');
  // A session naming this PR that we could not read (activity or listing record) is unknown, not absent.
  const unread = bound.some((a) => namesPr(a.name, pr) && sessionActivity(a, now, sessionActiveWithinMinutes, stuckAfterMinutes) === 'unknown')
    || unreadSessions.some((name) => namesPr(name, pr));
  const session = findFixerSession(live, pr.number) ?? live.find((a) => ['review', 'inspect'].includes(parseSessionSlug(a.name)?.kind));
  // Refusals and diagnostics never acquired ownership. Keep them out of the
  // progress clock, including legacy refusal signals carrying only `reason`.
  const daemon = [...daemons].filter((d) => d.kind !== 'refusal' && d.kind !== 'diagnostic' && d.reason === undefined && Number.isFinite(ms(d.at)) && ms(d.at) <= now + OWNER_CLOCK_SKEW_MS)
    .sort((a, b) => ms(b.at) - ms(a.at))[0];
  const owner = session ? `session:${session.name}` : daemon ? `daemon:${daemon.name}` : null;
  // A healthy live session is current evidence even when its creation timestamp is old.
  const at = session ? now : daemon ? ms(daemon.at) : null;
  const stuck = Boolean(smell) || (at !== null && now - at > stuckAfterMinutes * 60000);
  if (unread && !smell && (stuck || !owner)) return { ...base, state: 'unknown', why: 'Bound session could not be read' };
  return { ...base, owner, ownerLastSeenAt: at === null ? null : new Date(at).toISOString(),
    state: stuck ? 'stuck' : owner ? 'active' : 'none', why: smell ? `Open health episode: ${smell}` : stuck ? 'Owner signal is stale' : owner ? 'Live owner signal' : base.why,
    ...(smell ? { smell } : {}) };
}
export const DEADLINE_MINUTES = { label: 45, 'await-review': 90, 'await-red-team': 60, fix: 120, rebase: 90, 'wait-on': 120, 'close into card': 45 };
export const labelNames = pr => Array.isArray(pr.labels) ? [...new Set(pr.labels.map(l => typeof l === 'string' ? l : l?.name))].sort() : null;
export const stateFingerprint = pr => JSON.stringify([pr.headRefOid, labelNames(pr), pr.state ?? 'OPEN']);
/** Same-head state time only: updatedAt is not a label event and never renews this clock. */
export function stateSince(pr, fallback, now) {
  const real = ms(pr.stateSince ?? pr.labelStateSince ?? pr.headStateSince);
  return Number.isFinite(real) && real <= now ? real : fallback;
}
/** An omitted backoff preserves once-per-head consumers. Legacy alerted episodes start a repeat clock on migration. */
export function repeatDue(record, now, backoff) {
  return Array.isArray(backoff) && backoff.length > 0 && Number.isFinite(record?.lastAlertAt)
    && now - record.lastAlertAt >= backoff[Math.min(Math.max(0, (record.alertCount ?? 1) - 1), backoff.length - 1)] * 60000;
}
/** Shared evidence gate for tooling classification and refusal-derived dependency annotations. */
export function currentToolingRefusals(daemons, pr, owner, now, settings = {}) {
  const headAt = ms(pr.headPushedAt ?? pr.pushedAt ?? pr.updatedAt);
  const recent = daemons.filter(entry => {
    const at = ms(entry.at), head = entry.head ?? entry.headRefOid;
    return entry.kind === 'refusal' && ['fix-dispatch-daemon', 'reconcile-fix-dispatch-daemon'].includes(entry.name)
      && typeof entry.reason === 'string' && Number.isFinite(at) && at <= now
      && now - at <= (settings.toolingRefusalWindowMinutes ?? 360) * 60000
      && (head != null ? head === pr.headRefOid : Number.isFinite(headAt) && at > headAt);
  });
  const latest = Math.max(...recent.map(entry => ms(entry.at)));
  const progress = ms(owner.ownerLastSeenAt);
  if (owner.state === 'active' && Number.isFinite(progress) && progress <= now && progress > latest) return [];
  return recent;
}
/** Compare full reasons before shortening for display: different long failures stay distinct. */
function repeatedToolingRefusal(daemons, pr, owner, now, settings) {
  const recent = currentToolingRefusals(daemons, pr, owner, now, settings);
  const counts = new Map();
  for (const entry of recent) {
    const reason = entry.reason
      .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?\b/g, '')
      .replace(/^.*?\brefused\b[^\n]*?\s[—–]\s/, '')
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’|`[^`]*`/g, '')
      .replace(/\d+/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    if (!/[a-z]/i.test(reason)) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    if (counts.get(reason) >= 2) return reason.length > 80 ? `${reason.slice(0, 79)}…` : reason;
  }
  return null;
}
/** PURE: one owner, action, deadline and violation for every open PR. */
export function evaluateInvariant(pr, owner = {}, { now, since = now, settings = {}, daemons = [] } = {}) {
  const toolingReason = pr.changedFiles !== 0 ? repeatedToolingRefusal(daemons, pr, owner, now, settings) : null;
  if (toolingReason) {
    const state = `blocked-by-tooling (${toolingReason})`;
    return { owner: 'tooling', state, violation: state, nextAction: `fix tooling: ${toolingReason}`,
      deadline: new Date(stateSince(pr, since, now) + (settings.toolingDeadlineMinutes ?? 240) * 60000).toISOString() };
  }
  const labels = labelNames(pr);
  const unreadable = !labels || labels.some(l => typeof l !== 'string');
  let nextAction = unreadable ? 'inspect unreadable labels' : !labels.length ? 'restore-review-label'
    : labels.includes('red-team:pending') ? 'await-red-team'
    : labels.some(l => /^(review:changes|status:fixing)$/.test(l)) ? 'fix'
    : labels.some(l => /rebase|conflict/.test(l)) ? 'rebase' : 'await-review';
  const emptyDiff = pr.changedFiles === 0;
  if (emptyDiff) nextAction = 'close into card';
  // Preserve existing per-label budgets and persisted state clocks for restoration.
  const budget = nextAction === 'restore-review-label' ? 'label' : nextAction;
  const configured = settings.deadlineMinutes;
  // The settings cascade accepts a global scalar as well as per-action budgets.
  const minutes = (Number.isFinite(configured) && configured > 0 ? configured : configured?.[budget]) ?? DEADLINE_MINUTES[budget] ?? 45;
  const deadline = new Date(stateSince(pr, since, now) + minutes * 60000).toISOString();
  const lastSignal = ms(owner.ownerLastSeenAt);
  const stale = owner.state === 'unknown' || owner.state === 'stuck' || lastSignal > now + OWNER_CLOCK_SKEW_MS
    || (Number.isFinite(lastSignal) ? now - lastSignal > (settings.idleMinutes ?? 45) * 60000 : !['active', 'waiting-operator'].includes(owner.state) && now - stateSince(pr, since, now) > (settings.idleMinutes ?? 45) * 60000);
  const violation = emptyDiff ? 'empty-diff' : unreadable ? 'owner-stale' : !labels.length ? 'no-labels'
    : now > Date.parse(deadline) ? 'deadline-passed' : stale ? 'owner-stale' : null;
  const implied = nextAction === 'fix' || nextAction === 'rebase' ? 'daemon:fix-dispatch-daemon' : nextAction.startsWith('await-') ? 'daemon:review-daemon' : 'operator';
  const assigned = nextAction === 'restore-review-label'
    ? now > Date.parse(deadline) ? 'operator' : 'daemon:fix-daemon'
    : owner.owner ?? implied;
  return { owner: assigned, nextAction, deadline, violation };
}
export function planSweep({ idle, owners, prevState = {}, needsYou, now, settings, readsOk = {} }) {
  const alerts = []; const diagnose = new Set();
  if (Array.isArray(needsYou)) needsYou = [...new Map(needsYou.map((p) => [prKey(p), p])).values()];
  const episodes = Object.fromEntries(Object.entries(prevState.episodes ?? {}).filter(([key]) => readsOk[key] === false));
  const report = { idle: idle.map((p) => ({ ...p, ...owners[prKey(p)] })), needsYou: needsYou ?? null, needsYouAdded: [] };
  for (const p of idle) {
    const key = prKey(p); const owner = owners[key];
    if (readsOk[key] === false) continue;
    const old = prevState.episodes?.[key];
    if (!['none', 'stuck', 'unknown'].includes(owner?.state)) continue;
    const fingerprint = stateFingerprint(p);
    const same = settings.alertBackoffMinutes ? (old?.fingerprint === fingerprint || (!old?.fingerprint && old?.head === p.headRefOid && old?.updatedAt === p.updatedAt)) : old?.head === p.headRefOid && old?.updatedAt === p.updatedAt;
    const episode = same ? { ...old } : { head: p.headRefOid, updatedAt: p.updatedAt, fingerprint, firstUnownedAt: now, alerted: false };
    episode.fingerprint = fingerprint;
    if (episode.alerted && settings.alertBackoffMinutes && !Number.isFinite(episode.lastAlertAt)) {
      episode.lastAlertAt = now; episode.alertCount = episode.alertCount ?? 1;
    }
    // Unknown ownership without a failed read uses a doubled ownership budget.
    const alertAfter = settings.stuckAlertMinutes * (owner.state === 'unknown' ? 2 : 1);
    if ((!episode.alerted && now - episode.firstUnownedAt > alertAfter * 60000) || repeatDue(episode, now, settings.alertBackoffMinutes)) {
      alerts.push({ kind: 'pr-stuck', title: 'PR movement stalled', body: `${key} ${p.title}: ${owner.why}${[...(p.blockedBy ?? []).map(n => `blocked-by #${n}`), ...(p.unblocks ?? []).map(n => `unblocks #${n}`)].map(label => '; ' + label).join('')}`, key }); episode.alerted = true; episode.lastAlertAt = now; episode.alertCount = (episode.alertCount ?? 0) + 1;
    }
    delete episode.blockedExpiryAlerted; // discard obsolete persisted wait bookkeeping
    episodes[key] = episode;
    if (settings.dispatchDiagnosis && (owner.state === 'stuck' || episode.alerted)) diagnose.add(p.repo);
  }
  const nextState = { episodes, ...(prevState.needsYou !== undefined ? { needsYou: prevState.needsYou } : {}) };
  if (needsYou !== null && needsYou !== undefined) {
    needsYou = needsYou.filter(p => readsOk[prKey(p)] !== false);
    const keys = [...new Set([...needsYou.map(prKey), ...(prevState.needsYou ?? []).filter(key => readsOk[key] === false)])];
    if (Array.isArray(prevState.needsYou)) report.needsYouAdded = needsYou.filter((p) => !prevState.needsYou.includes(prKey(p)));
    nextState.needsYou = keys;
    if (report.needsYouAdded.length) alerts.push({ kind: 'needs-you', title: 'PR queue NEEDS YOU', body: report.needsYouAdded.map((p) => `${prKey(p)} ${p.title ?? ''}`).join(' | ') });
  }
  return { report, alerts, nextState, diagnose: [...diagnose] };
}
