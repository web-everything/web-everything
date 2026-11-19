/** Observe-only expectation model. No filesystem, network, clock or logging IO.
 * Evidence: { eventsReadable: true, prs: { [pr]: { sha, complete: true,
 * reactions: [{ pr, sha, action, at, source }] } } }. Completeness is an explicit
 * assertion by the reader; missing/invalid inputs never prove a miss or success.
 */
import { resolveCascade } from '../../lib/policy-cascade.mjs';

export const REACTIONS = Object.freeze({
  'merge-gate-started': [['merge-gate-started']],
  merged: [['merged', 'pr-merged']],
  'review-started': [['review-started']],
  'ci-and-review-restarted': [['ci-started'], ['review-started', 'red-team-started']],
  'red-team-verdict': [['red-team-verdict']],
  'fixer-started': [['fixer-started']],
  'ci-heal-or-fixer-started': [['ci-heal-started', 'fixer-started']],
  'build-adopted': [['build-adopted']],
  'next-heartbeat': [['change-lead-heartbeat']],
  'merge-queue-enqueued': [['merge-queue-enqueued']],
  'publication-hold-cleared': [['publication-hold-cleared']],
});
export const ACTIONS = new Set(['clear-human', 'ready-to-merge', 'merge-gate-pass',
  'worker-push', 'update-branch', 'red-team:pending', 'send-back', 'ci-red',
  'hot-patch-load', 'change-lead-heartbeat', 'enqueue-eligible', 'publication-hold-set',
  ...Object.values(REACTIONS).flat(2)]);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const validSha = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
export const validObservation = v => object(v) && Number.isSafeInteger(v.pr) && v.pr > 0
  && validSha(v.sha) && ACTIONS.has(v.action) && date(v.at)
  && typeof v.source === 'string' && v.source.length > 0;
const validTable = rows => Array.isArray(rows) && rows.length > 0 && rows.length <= 100
  && new Set(rows.map(r => r?.id)).size === rows.length && rows.every(r => object(r)
    && typeof r.id === 'string' && /^[a-z][a-z0-9-]*$/.test(r.id) && Array.isArray(r.after) && r.after.length > 0
    && r.after.every(a => ACTIONS.has(a)) && Object.hasOwn(REACTIONS, r.expect)
    && Number.isFinite(r.deadlineMinutes) && r.deadlineMinutes > 0 && r.deadlineMinutes <= 10080
    && typeof r.wouldBeResponse === 'string' && r.wouldBeResponse.trim());

/** Caller supplies already-read layers. An invalid mode closes to off, never a lower layer. */
export function resolveExpectationSettings({ standard = { mode: 'observe' }, platform, tool,
  envValues, readable = true } = {}) {
  const result = resolveCascade({ standard, platform, tool, envValues,
    valid: { mode: v => ['off', 'observe'].includes(v), expectations: validTable } });
  const badMode = [['standard', standard], ['platform', platform], ['tool', tool], ['env', envValues]]
    .filter(([, v]) => v?.mode !== undefined && !['off', 'observe'].includes(v.mode)).at(-1);
  return { ...result.value, mode: badMode ? 'off' : result.value.mode,
    valid: readable && !result.invalid.length && validTable(result.value.expectations),
    sources: { ...result.sources, ...(badMode ? { mode: `${badMode[0]} (invalid; fail-closed)` } : {}) } };
}

/** Normalized timeline observations and action events share one explicit head-bound shape.
 * Unknown kinds are ignored; a malformed known observation taints the entire read.
 */
export function deriveActions(events, timeline = []) {
  if (!Array.isArray(events) || !Array.isArray(timeline)) return null;
  const out = [];
  for (const [rows, prefix] of [[events, 'daemon-events'], [timeline, 'timeline']]) {
    for (const [i, row] of rows.entries()) {
      if (!object(row)) return null;
      if (row.kind === 'expectation-missed') continue; // our own output is never a trigger

      const action = row.detail?.action ?? row.action ?? row.kind;
      if (!ACTIONS.has(action)) continue;
      const item = { pr: row.pr, sha: row.sha ?? row.detail?.sha ?? row.detail?.head,
        action, at: row.at, source: row.source ?? `${prefix}:${i + 1}` };
      // An event with no head sha at all (e.g. the merger's pr-merged) cannot bind to a head: ignore it,
      // never let one ordinary event blind the whole log. A present-but-malformed sha still reads unknown.
      if (item.sha === undefined && Object.values(REACTIONS).flat(2).includes(action)) continue;
      if (!validObservation(item)) return null;
      out.push(item);
    }
  }
  return out;
}

/** Latest trigger per (PR, current head, expectation). At deadline it is still pending.
 * A later reaction is met with late:true. Future evidence is excluded for replay.
 */
export function evaluateExpectations({ settings, actions, evidence, now }) {
  if (settings?.mode === 'off') return [];
  const stamp = Date.parse(now);
  const prs = { ...evidence?.prs };
  // A failed/absent PR read must retain the known action's identity as unknown.
  for (const a of Array.isArray(actions) ? actions : []) {
    if (validObservation(a) && !prs[a.pr]) prs[a.pr] = { sha: a.sha, complete: false };
  }
  const supplied = settings?.expectations;
  if (!validTable(supplied)) return Object.entries(prs).flatMap(([pr, p]) =>
    (Array.isArray(supplied) && supplied.length ? supplied.slice(0, 100) : [null]).map(r => ({
      pr: Number(pr), sha: p?.sha ?? null, expectationId: r?.id ?? null, status: 'unknown' })));
  const rows = supplied;
  const inputsValid = settings?.valid === true && validTable(rows) && Number.isFinite(stamp)
    && Array.isArray(actions) && actions.every(validObservation) && evidence?.eventsReadable === true;
  const results = [];
  for (const [number, pr] of Object.entries(prs)) {
    if (!validSha(pr?.sha)) { results.push({ pr: Number(number), sha: null, expectationId: null, status: 'unknown' }); continue; }
    for (const row of rows) {
      const triggers = (Array.isArray(actions) ? actions : []).filter(a => a.pr === Number(number)
        && a.sha === pr.sha && row.after?.includes(a.action) && Date.parse(a.at) <= stamp)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const trigger = triggers[0];
      const base = { pr: Number(number), sha: pr.sha, expectationId: row.id,
        action: trigger?.action ?? null, actionAt: trigger?.at ?? null,
        deadline: trigger ? new Date(Date.parse(trigger.at) + row.deadlineMinutes * 60000).toISOString() : null };
      const readable = inputsValid && pr.complete === true && Array.isArray(pr.reactions)
        && pr.reactions.every(validObservation);
      if (readable && !trigger) continue;
      if (!readable || !trigger) { results.push({ ...base, status: 'unknown' }); continue; }
      const groups = REACTIONS[row.expect].map(names => pr.reactions.filter(r => r.pr === base.pr
        && r.sha === base.sha && names.includes(r.action) && Date.parse(r.at) >= Date.parse(trigger.at)
        && (row.expect !== 'next-heartbeat' || Date.parse(r.at) > Date.parse(trigger.at))
        && Date.parse(r.at) <= stamp).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
      const met = groups.every(g => g.length);
      const refs = [trigger.source, ...groups.flatMap(g => g.length ? [g[0].source] : [])];
      if (met) {
        const at = Math.max(...groups.map(g => Date.parse(g[0].at)));
        results.push({ ...base, status: 'met', late: at > Date.parse(base.deadline),
          reactionAt: new Date(at).toISOString(), evidenceRefs: refs });
      } else if (stamp <= Date.parse(base.deadline)) results.push({ ...base, status: 'pending' });
      else results.push({ ...base, status: 'missed', observedAt: new Date(stamp).toISOString(),
        minutesLate: (stamp - Date.parse(base.deadline)) / 60000,
        evidenceRefs: refs, wouldBeResponse: row.wouldBeResponse });
    }
  }
  return results;
}

export const missKey = r => JSON.stringify([r.pr, r.sha, r.expectationId, r.actionAt]);
