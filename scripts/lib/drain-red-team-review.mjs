import { redTeamCardOnly, redTeamOwedFor } from './review-red-team-policy.mjs';

/** Internal review-job branch: use a completed review's pinned read, never manufacture a verdict. */
export function runDrainRedTeamJob({ pr, repo, drainRedTeamRequest: request, preferLane = null }, io, plan) {
  if (Number(pr) !== request.pr || repo?.toLowerCase() !== request.repo?.toLowerCase()
    || !/^[a-f0-9]{40}$/i.test(request.head ?? '')) throw Error('drain red-team request identity mismatch');
  const planned = plan({ pr, repo });
  const slug = planned.sessionSlug;
  const result = fields => ({ pr: planned.pr, repo: planned.repo, sessionSlug: slug, ...fields });
  const record = { slug, pr: planned.pr, repo: planned.repo, pid: process.pid,
    startedAt: new Date(io.now()).toISOString(), cwd: io.root };
  const claim = io.claim(slug, record);
  if (!claim.ok) return result({ refused: true, outcome: 'refused-live-job' });
  let lanePath;
  const ready = () => {
    const state = io.readDrainRedTeamState(request);
    if (state?.headRefOid && state.headRefOid.toLowerCase() !== request.head.toLowerCase()) {
      io.finishDrainRedTeamRequest(request, { status: 'stale' });
      return false;
    }
    const ci = io.readDrainRedTeamCi?.(request);
    if (ci && (!ci.allowed || ci.headSha?.toLowerCase() !== request.head.toLowerCase())) return false;
    const labels = (state?.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
    return state?.headRefOid?.toLowerCase() === request.head.toLowerCase() && state.state === 'OPEN' && !state.isDraft
      && labels.includes('review:accepted') && labels.includes('ready-to-merge')
      && !labels.some(l => ['review:human', 'review:changes', 'review:pending', 'review:held-mechanical'].includes(l));
  };
  try {
    if (!ready() || io.redTeamEnabled?.() === false) return result({ outcome: 'deferred' });
    const loopPayload = io.readDrainRedTeamReview(request);
    if (loopPayload?.findings?.read?.netBasis?.rev?.toLowerCase() !== request.head.toLowerCase()
      || !redTeamOwedFor(loopPayload)) return result({ outcome: 'deferred-no-review-evidence' });
    if (io.skipCardOnly?.() && redTeamCardOnly(loopPayload.findings.read)) return result({ outcome: 'card-only' });
    const actorId = io.newActorId?.();
    const acquired = io.acquireLane({ laneRepo: planned.laneRepo, slug, actorId,
      lane: preferLane, waitMs: 0 });
    lanePath = acquired?.lanePath;
    if (!lanePath) return result({ outcome: 'deferred-no-lane' });
    io.updateRecord?.({ ...record, cwd: lanePath, actorId });
    if (!ready()) return result({ outcome: 'deferred' });
    const input = { pr: planned.pr, repo: planned.repo, lanePath, loopPayload, slug };
    io.redTeamStatus?.({ ...input, status: 'running' });
    const redTeam = io.runRedTeam(input);
    if (['ran', 'resumed', 'already-ran'].includes(redTeam?.status) && redTeam.callId) {
      // The existing writer checks the persisted seat and run identity before minting provenance.
      const saved = io.recordSavedRedTeamResult({ runId: loopPayload.runId, repo: planned.repo,
        pr: planned.pr, head: request.head, redTeam });
      if (saved === true) {
        io.finishDrainRedTeamRequest(request);
        io.runRedTeamGate?.({ pr: planned.pr, repo: planned.repo });
      }
    }
    io.redTeamStatus?.({ ...input, status: 'finished', result: redTeam });
    return result({ outcome: redTeam?.status ?? 'error', redTeam });
  } finally {
    try { if (lanePath) io.releaseLane(slug); }
    finally { io.unclaim(slug, process.pid); }
  }
}
