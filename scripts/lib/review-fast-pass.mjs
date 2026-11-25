import { reviewDispatchContext } from './review-dispatch-context.mjs';

/** IO-free orchestration. Readers throw or mark incomplete evidence; the normal tick is the fallback.
 * readPr({pending:true}) returns a bounded inventory of currently pending PRs. planOne must use the
 * same admission/planner gates as the tick. liveCap returns the total ceiling, never saved free slots.
 */
export async function runFastPass({ repo, readLastPlan, readPr, planOne, readAgents, readJobs,
  dispatch, hostAdmission, liveCap, mainSha, acquirableLanes, starts = { count: 0 }, budget, log = () => {}, now = Date.now,
  leaseHeld = () => true }) {
  const result = { dispatched: [], failed: [] };
  let leaseLost = false;
  const note = (pr, reason) => {
    result.failed.push({ prNumber: pr, reason });
    log(`review-fast-pass: ${repo}#${pr ?? '?'} ${reason}; deferred to normal tick`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '));
  };
  try {
    const saved = await readLastPlan(repo);
    if (!saved?.plan || !Array.isArray(saved.rawPrs) || !Number.isFinite(saved.savedAt)) throw Error('saved plan unavailable');
    const main = await mainSha(repo);
    if (!main || main !== saved.mainSha) throw Error('main changed or unknown');
    const pending = await readPr({ repo, pending: true, since: saved.savedAt });
    if (!Array.isArray(pending) || pending.incomplete || pending.length > 100) throw Error('pending inventory incomplete or over 100');
    const candidates = new Map();
    for (const row of saved.plan.dispatch ?? []) {
      if (row.kind !== 'review' || row.started) continue;
      const old = saved.rawPrs.find(pr => pr.number === row.prNumber);
      candidates.set(row.prNumber, row.headRefOid ?? row.headSha ?? old?.headRefOid);
    }
    const labelled = pr => Array.isArray(pr.labels) && pr.labels.some(l => (l?.name ?? l) === 'review:pending');
    const recent = new Set();
    for (const pr of pending) {
      const old = saved.rawPrs.find(old => old.number === pr.number);
      // updatedAt includes re-labelling an already pending PR; the fresh planner filters other updates.
      if (!labelled(old ?? {}) || Date.parse(pr.updatedAt) > saved.savedAt) {
        recent.add(pr.number);
        if (!candidates.has(pr.number)) candidates.set(pr.number, old?.headRefOid ?? pr.headRefOid);
      }
    }
    if (candidates.size > 100) throw Error('candidate inventory over 100');
    const occupiedLanes = new Set();
    starts.jobs ??= [];
    if (candidates.size > 8) note(null, 'fast pass limited to 8 candidates');
    const ordered = [...candidates].sort(([a], [b]) => Number(recent.has(b)) - Number(recent.has(a)));
    for (const [number, plannedHead] of ordered.slice(0, 8)) {
      if (leaseLost) break;
      try {
        if (!Number.isSafeInteger(number) || number < 1) throw Error('invalid PR number');
        const pr = await readPr({ repo, pr: number });
        if (pr?.number !== number || pr.state !== 'OPEN' || !Array.isArray(pr.labels)
          || !Array.isArray(pr.statusCheckRollup) || !Array.isArray(pr.comments)) throw Error('PR evidence incomplete');
        if (!/^[a-f0-9]{40}$/i.test(plannedHead ?? '') || pr.headRefOid !== plannedHead) throw Error('head moved or unknown');
        const agents = await readAgents({ repo });
        const jobs = await readJobs({ repo });
        if (!Array.isArray(agents) || agents.incomplete || !Array.isArray(jobs) || jobs.incomplete) throw Error('live inventory incomplete');
        const unobservedStarts = starts.jobs.filter(start => !jobs.some(job =>
          (start.pid && job.pid === start.pid) || (job.repo === start.repo && Number(job.pr) === start.pr))).length;
        const cap = await liveCap({ repo, jobs, agents, unobservedStarts });
        if (!Number.isFinite(cap) || cap <= jobs.length + unobservedStarts) throw Error('live-review cap exhausted');
        if (jobs.some(job => job.repo === repo && Number(job.pr) === number)) throw Error('live job slot');
        const plan = await planOne({ repo, pr, agents, now: now() });
        const row = plan?.dispatch?.find(r => r.kind === 'review' && r.prNumber === number);
        if (plan?.deferred || plan?.agentsIncomplete || !row || plan.refusals?.some(r => r.prNumber === number)) throw Error('fresh plan holds PR');
        if (await mainSha(repo) !== main) throw Error('main changed during plan');
        const lanes = await acquirableLanes({ repo });
        const freeLanes = Array.isArray(lanes) ? lanes.filter(lane => !occupiedLanes.has(lane)) : null;
        const available = freeLanes ? freeLanes.length : lanes - occupiedLanes.size;
        if (!(available > 0)) throw Error('lane inventory empty or unknown');
        if (budget && !(budget.left > (budget.reserve ?? 0))) throw Error('live-review reserve exhausted');
        const host = await hostAdmission();
        if (host?.admitted !== true || !(host.maxPerTick > 0) || !((host.startBudget ?? host.maxPerTick) > starts.count)) throw Error('host admission refused');
        // Heartbeat and re-check the dispatch lease right before spending capacity; a lost lease stops the pass.
        let held = false;
        try { held = (await leaseHeld()) === true; } catch { /* unknown means lost */ }
        if (!held) { leaseLost = true; throw Error('dispatch lease lost'); }
        starts.count++;
        const lane = freeLanes ? freeLanes[0] : occupiedLanes.size;
        occupiedLanes.add(lane);
        const reservation = { repo, pr: number };
        starts.jobs.push(reservation);
        if (budget) budget.left--;
        let out;
        try { out = await dispatch({ repo, pr: number, expectedHead: pr.headRefOid, leaseHeld,
          ...reviewDispatchContext(pr),
          ...(freeLanes ? { preferLane: lane } : {}),
          ...(row.advisoryReview?.ciWaived === true ? { advisoryCiWaiver: row.advisoryReview } : {}) });
        } catch (error) { host.take?.(1); throw error; }
        if (out?.refused || (out?.skipped && out.skipped !== 'live-job')) {
          starts.count--;
          starts.jobs.splice(starts.jobs.indexOf(reservation), 1);
          occupiedLanes.delete(lane);
          if (budget) budget.left++;
        } else {
          reservation.pid = out?.jobPid;
          host.take?.(1);
        }
        if (!out || out.skipped || out.refused) throw Error(out?.skipped ?? out?.reason ?? out?.outcome ?? 'dispatch refused');
        result.dispatched.push({ prNumber: number, ...out });
        log(`review-fast-pass: ${repo}#${number} dispatched`);
      } catch (error) { note(number, String(error?.message ?? error)); }
    }
  } catch (error) { note(null, String(error?.message ?? error)); }
  return result;
}
