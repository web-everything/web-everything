/**
 * @file scripts/conveyor/pr-sweep-core.mjs
 * @description Card 335 — pure PR movement ownership and episode planning; no IO or implicit clock.
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
 * Future timestamps are not evidence. Unknown lasts only `unknownForMinutes` after the start.
 */
export function sessionActivity(a, now, activeWithinMinutes = 30, unknownForMinutes = 90) {
  if (!isRunningSession(a)) return 'no';
  const valid = (v) => { const t = ms(v); return Number.isFinite(t) && t <= now + 60000 ? t : NaN; };
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
  const daemon = [...daemons].filter((d) => d.kind !== 'refusal' && d.kind !== 'diagnostic' && d.reason === undefined && Number.isFinite(ms(d.at)))
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
export function planSweep({ idle, owners, prevState = {}, needsYou, now, settings, ownerReadsOk = true, prsReadOk = true }) {
  const alerts = []; const diagnose = new Set();
  if (Array.isArray(needsYou)) needsYou = [...new Map(needsYou.map((p) => [prKey(p), p])).values()];
  const episodes = ownerReadsOk && prsReadOk ? {} : { ...prevState.episodes };
  const report = { idle: idle.map((p) => ({ ...p, ...owners[prKey(p)] })), needsYou: needsYou ?? null, needsYouAdded: [] };
  for (const p of idle) {
    const key = prKey(p); const owner = owners[key];
    if (!ownerReadsOk || !prsReadOk || !['none', 'stuck', 'unknown'].includes(owner?.state)) continue;
    const old = prevState.episodes?.[key];
    const episode = old?.head === p.headRefOid && old?.updatedAt === p.updatedAt ? { ...old } : { head: p.headRefOid, updatedAt: p.updatedAt, firstUnownedAt: now, alerted: false };
    // An unreadable owner keeps the episode clock running but waits twice as long,
    // so a brief unreadable tick never alerts and a permanent one still does.
    const alertAfter = settings.stuckAlertMinutes * (owner.state === 'unknown' ? 2 : 1);
    if (!episode.alerted && now - episode.firstUnownedAt > alertAfter * 60000) {
      alerts.push({ kind: 'pr-stuck', title: 'PR movement stalled', body: `${key} ${p.title}: ${owner.why}`, key }); episode.alerted = true;
    }
    episodes[key] = episode;
    if (settings.dispatchDiagnosis && (owner.state === 'stuck' || episode.alerted)) diagnose.add(p.repo);
  }
  const nextState = { episodes, ...(prevState.needsYou !== undefined ? { needsYou: prevState.needsYou } : {}) };
  if (needsYou !== null && needsYou !== undefined) {
    const keys = [...new Set(needsYou.map(prKey))];
    if (Array.isArray(prevState.needsYou)) report.needsYouAdded = needsYou.filter((p) => !prevState.needsYou.includes(prKey(p)));
    nextState.needsYou = keys;
    if (report.needsYouAdded.length) alerts.push({ kind: 'needs-you', title: 'PR queue NEEDS YOU', body: report.needsYouAdded.map((p) => `${prKey(p)} ${p.title ?? ''}`).join(' | ') });
  }
  return { report, alerts, nextState, diagnose: [...diagnose] };
}
