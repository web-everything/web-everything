/**
 * @file Evidence-based PR state. Claims survive workers: only an observed live session earns FIXING.
 * Pure: callers supply the clock and observations; missing observations never prove a stall.
 */
export const PR_STATE_PHASES = Object.freeze(['WAITING-CI', 'IN-REVIEW', 'FIXING', 'HANDED-OFF',
  'NEEDS-RULING', 'NEEDS-OPERATOR', 'READY-TO-MERGE', 'STUCK', 'MERGED', 'CLOSED']);
export const DEFAULTS = Object.freeze({ dispatchGraceMin: 10, reviewStaleMin: 45, handoffStaleMin: 60 });
export function settingsFromEnv(env = {}) {
  return Object.fromEntries(Object.entries({ dispatchGraceMin: 'WE_STATE_DISPATCH_GRACE_MIN',
    reviewStaleMin: 'WE_STATE_REVIEW_STALE_MIN', handoffStaleMin: 'WE_STATE_HANDOFF_STALE_MIN' })
    .map(([key, name]) => [key, env[name] !== undefined && String(env[name]).trim() !== ''
      && Number.isFinite(Number(env[name])) && Number(env[name]) >= 0 ? Number(env[name]) : DEFAULTS[key]]));
}
const time = v => typeof v === 'number' ? v : Date.parse(v);
const count = v => Array.isArray(v) ? v.length : Number(v) || 0;
/**
 * @param {object} facts
 * @param {number} facts.pr
 * @param {string|number} facts.now Injected ISO time or epoch milliseconds.
 * @param {'OPEN'|'MERGED'|'CLOSED'} facts.state Unknown IO state may be null.
 * @param {boolean} facts.isDraft
 * @param {string} facts.mergeState
 * @param {string[]} facts.labels
 * @param {{sha:string,committedAt:string}} facts.head
 * @param {Array<{name:string,state:'green'|'red'|'pending'|'missing'|'cancelled'|'unknown'}>} facts.requiredChecks Current head only; 'unknown' = the probe failed.
 * @param {{coveredHead:string,text:string}|null} facts.advisory
 * @param {{pending:number|Array,ruled:number|Array}} facts.referrals
 * @param {boolean} facts.roundCapNote
 * @param {boolean} facts.needsDecisionNote
 * @param {number} facts.roundExtensions
 * @param {Array<{name:string,kind:'fix'|'ci-heal'|'review',live:boolean,state:string,startedAt:string,endedAt:string,outcome:string,detail:string,headAtStart?:string}>} facts.sessions
 * @param {{held:boolean,owner:string,kind:string,meta:object}|null} facts.claim
 * @param {Array<{at:string,text:string}>} facts.refusals
 * @param {Array<{kind:'load-flake'|'infra'|'permission',at:string,detail:string}>} facts.handoffs
 * @param {string|null} facts.drainDeferral
 * @param {object} [settings] DEFAULTS overrides. Optional facts.labelChangedAt provides a more recent label event;
 * optional facts.probeErrors records unavailable/truncated probes and prevents absence-based STUCK claims.
 * @returns {{phase:string,headline:string,next:string,evidence:string[]}}
 */
export function derivePrState(facts, settings = {}) {
  const s = { ...DEFAULTS, ...settings }, f = facts;
  const labels = f.labels ?? [], sessions = f.sessions ?? [], checks = f.requiredChecks ?? [];
  const sha = f.head?.sha?.slice(0, 8) || 'unknown';
  const evidence = [`PR #${f.pr}: ${f.state ?? 'unknown'}; head ${sha} committed ${f.head?.committedAt ?? 'unknown'}`,
    `labels: ${labels.join(', ') || '(none)'}`];
  if (f.claim?.held) evidence.push(`claim held by ${f.claim.owner}; kind ${f.claim.kind}`);
  if (checks.length) evidence.push(`required checks on ${sha}: ${checks.map(c => `${c.name}=${c.state}`).join(', ')}`);
  if (f.roundExtensions) evidence.push(`round extensions: +${f.roundExtensions}`);
  for (const r of (f.refusals ?? []).slice(-3)) evidence.push(`refusal ${r.at ?? 'unknown time'}: ${r.text}`);
  for (const error of f.probeErrors ?? []) evidence.push(`probe: ${error}`);
  if (f.drainDeferral) evidence.push(`drain deferral: ${f.drainDeferral}`);
  const result = (phase, headline, next, why) => ({ phase, headline, next, evidence: why ? [...evidence, why] : [...evidence] });
  const age = at => (time(f.now) - time(at)) / 60_000;
  const since = [f.head?.committedAt, f.labelChangedAt].filter(v => Number.isFinite(time(v))).sort((a,b) => time(b)-time(a))[0];
  if (['MERGED', 'CLOSED'].includes(f.state)) return result(f.state, `PR ${f.state.toLowerCase()}`, 'none');
  const live = sessions.filter(x => x.live).sort((a,b) => time(b.startedAt)-time(a.startedAt))[0];
  if (live) return result(live.kind === 'review' ? 'IN-REVIEW' : 'FIXING',
    `live ${live.name} since ${live.startedAt ?? 'unknown'}`, `${live.name} reports its outcome`,
    `session ${live.name}: live ${live.state}; started ${live.startedAt ?? 'unknown'}`);
  const unverified = !!f.probeErrors?.length; // an unavailable probe never proves absence, and never proves readiness
  const readyShape = labels.some(l => ['ready-to-merge', 'review:accepted'].includes(l)) && f.head?.sha
    && checks.length && checks.every(c => c.state === 'green') && !f.isDraft && !labels.includes('review:human');
  if (readyShape && unverified) return result('NEEDS-OPERATOR', 'readiness unverified — a probe failed', 'retry unavailable probes before trusting ready');
  if (readyShape) return result('READY-TO-MERGE', `required checks green on ${sha}`, f.drainDeferral || 'drain merges the PR');
  if (count(f.referrals?.pending)) return result('NEEDS-RULING', 'pending referral', 'mandatory reviewer records a ruling',
    `referrals: ${count(f.referrals.pending)} pending; ${count(f.referrals.ruled)} ruled`);
  // A refusal is history once a newer head exists. An undated one cannot be shown stale, so it still gates (toward the operator).
  const headAt = time(f.head?.committedAt);
  const currentRefusal = r => !Number.isFinite(time(r.at)) || !Number.isFinite(headAt) || time(r.at) >= headAt;
  if (labels.includes('review:human') || f.roundCapNote
    || (f.needsDecisionNote && !checks.some(c => ['pending', 'missing'].includes(c.state))) // a transient note never outranks CI still running
    || (f.refusals ?? []).some(r => /cap[- ]exhausted/i.test(r.text) && currentRefusal(r))) {
    const advisory = f.advisory;
    const old = advisory?.coveredHead && f.head?.sha && !f.head.sha.startsWith(advisory.coveredHead);
    return result('NEEDS-OPERATOR', `operator decision required${old ? ' — advisory covers an OLDER head' : ''}`,
      'operator rules on the advisory / round budget',
      `human gate=${labels.includes('review:human')}; round-cap=${!!f.roundCapNote}; needs-your-decision=${!!f.needsDecisionNote}; advisory ${advisory?.coveredHead?.slice(0, 8) ?? 'unknown head'}: ${String(advisory?.text ?? 'none observed').replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  const latest = [...sessions].sort((a,b) => (time(b.endedAt || b.startedAt)||0)-(time(a.endedAt || a.startedAt)||0))[0];
  // A fixer commits DURING its session, so "new head" means the head differs from the one the session started on
  // (sha when recorded, else a commit made after the session began) — not a commit after the session ended.
  const sameSha = (a, b) => !!a && !!b && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));
  const movedSince = x => !!x?.endedAt && (x.headAtStart && f.head?.sha ? !sameSha(f.head.sha, x.headAtStart)
    : time(f.head?.committedAt) > time(x.startedAt || x.endedAt));
  const pushed = movedSince(latest);
  if (latest) evidence.push(`session ${latest.name}: ${latest.state}; ended ${latest.endedAt ?? 'unknown'}; outcome ${latest.outcome || 'unknown'}${pushed ? '; new head pushed after session ended' : ''}`);
  const waiting = checks.filter(c => ['pending', 'missing'].includes(c.state));
  if (checks.some(c => c.state === 'unknown')) return result('NEEDS-OPERATOR', 'required-check state unknown — a probe failed',
    'retry unavailable probes', `unknown checks: ${checks.filter(c => c.state === 'unknown').map(c => c.name).join(', ')}`);
  if (waiting.length) return result('WAITING-CI', `waiting on ${waiting.map(c => c.name).join(', ')}`, 'CI finishes on this head');
  // A hand-off log line older than the current head describes a head that no longer exists.
  const handoff = [...(f.handoffs ?? [])].filter(h => !Number.isFinite(headAt) || time(h.at) >= headAt).sort((a,b) => time(b.at)-time(a.at))[0];
  const handed = latest?.endedAt && /blocked-on-(load-flake|infra|permission)|handed[ -]off/i.test(latest.outcome || '');
  // A session that ended with a hand-off owns the next event unless a head landed AFTER it ended: its own mid-session push is what it handed off.
  if (pushed && (!handed || time(f.head?.committedAt) > time(latest.endedAt))) return result('IN-REVIEW', 'new head pushed after owner ended', 'review daemon tick');
  if (handed || (handoff && (!latest || time(handoff.at) >= time(latest.endedAt || latest.startedAt)))) {
    const kind = handed ? latest.outcome : handoff.kind;
    const to = /load-flake/.test(kind) ? 'load-flake-reverify' : /infra/.test(kind) ? 'ci-heal' : /permission/.test(kind) ? 'operator (permission)' : 'next owner';
    const at = handed ? latest.endedAt : handoff.at;
    const stale = age(at) > s.handoffStaleMin;
    if (stale && unverified) return result('NEEDS-OPERATOR', `to ${to} — hand-off stale, owner probes unavailable`, 'retry unavailable probes; inspect owner state');
    return result(stale ? 'STUCK' : 'HANDED-OFF', `to ${to}${stale ? ' — hand-off stale' : ''}`,
      `${to} takes over`, `hand-off at ${at}: ${kind}; ${handoff?.detail || latest?.detail || ''}`);
  }
  const owner = f.claim?.held && sessions.find(x => x.name === f.claim.owner || (f.claim.meta?.sessionId ? x.sessionId === f.claim.meta.sessionId
    : x.kind === f.claim.kind && x === latest));
  if (owner && !owner.live && /done|stopped|completed|failed|ended|cancelled/.test(owner.state || '')
    && owner.endedAt && Number.isFinite(time(f.head?.committedAt)) && !movedSince(owner))
    return unverified ? result('NEEDS-OPERATOR', 'ownership could not be established', 'retry unavailable probes; inspect owner state')
      : result('STUCK', `claim held, session ended ${owner.outcome || owner.state}, no new head`, 'operator reconciles the ended owner and claim');
  if (labels.includes('review:pending')) return result(age(since) > s.reviewStaleMin && !f.probeErrors?.length ? 'STUCK' : 'IN-REVIEW',
    'no live reviewer observed', 'review daemon tick', `review age from ${since ?? 'unknown'}; stale threshold ${s.reviewStaleMin}m`);
  if (age(since) <= s.dispatchGraceMin) return result('HANDED-OFF', 'to fix-dispatch', 'fix-dispatch next tick', `dispatch grace ${s.dispatchGraceMin}m since ${since}`);
  if (f.probeErrors?.length || !Number.isFinite(age(since))) return result('NEEDS-OPERATOR', 'ownership could not be established', 'retry unavailable probes; inspect owner state');
  return result('STUCK', f.claim?.held ? 'claim held, no live owner observed' : 'no owner', 'operator dispatches an owner',
    `no live session; dispatch grace ${s.dispatchGraceMin}m elapsed since ${since}`);
}
