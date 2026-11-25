/** Bounded Actions attempt matching. Check-run IDs are never Actions job IDs. */
const claims = new WeakMap();
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const completed = check => check.status === 'completed' && Number.isFinite(stamp(check.completed_at));

export function mqActionsJob(check, repo) {
  try {
    const url = new URL(check.details_url);
    const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(url.pathname);
    if (url.origin !== 'https://github.com' || url.search || url.hash || !match
      || `${match[1]}/${match[2]}` !== repo || !Number.isSafeInteger(Number(match[4]))) return null;
    return { run: match[3], id: Number(match[4]) };
  } catch { return null; }
}

/**
 * maxFailures > 1: validate the whole attempt chain (same Actions run, same check name, same commit).
 * Returns null (unavailable) on any ambiguity, else { failures, state, candidate }.
 * Order is by Actions job id; timestamps are a strict cross-check, so any disagreement refuses.
 */
function mqChain(checks, repo, commit, original, removedAt) {
  const originalJob = mqActionsJob(original, repo);
  const members = [];
  for (const check of checks) {
    if (check.name !== original.name || check.head_sha !== commit) continue;
    const job = mqActionsJob(check, repo);
    if (!job || job.run !== originalJob.run || check.app?.slug !== 'github-actions' || check.app?.id !== 15368
      || !Number.isFinite(stamp(check.started_at))) return null;
    members.push({ check, id: job.id });
  }
  members.sort((a, b) => a.id - b.id);
  if (members.some((m, i) => i && m.id === members[i - 1].id) || members[0]?.check !== original) return null;
  if (stamp(original.completed_at) >= removedAt) return null;
  for (let i = 0; i < members.length; i++) {
    const { check } = members[i], last = i === members.length - 1;
    if (!last && (!completed(check) || check.conclusion !== 'failure')) return null;
    if (completed(check) && stamp(check.completed_at) < stamp(check.started_at)) return null;
    if (i && stamp(check.started_at) <= stamp(members[i - 1].check.completed_at)) return null;
  }
  const tail = members.at(-1), failures = members.filter(m => m.check.conclusion === 'failure' && completed(m.check)).length;
  const done = completed(tail.check);
  const state = done && tail.check.conclusion === 'success' ? 'confirmed'
    : done && tail.check.conclusion === 'failure' ? 'candidate'
    : !done && ['queued', 'in_progress'].includes(tail.check.status) ? 'pending' : 'incomplete';
  return { failures, state, candidate: tail.id };
}

/** Only complete, commit-bound history can establish a flake or authorize a rerun. */
export function inspectMqReruns({ checks, repo, commit, removedAt, maxFailures = 1 }) {
  const failed = checks.filter(check => check.conclusion === 'failure');
  // Beyond the single-rerun default, refused evidence must hold: a reason keeps the main-red fallback from retrying.
  const refusal = maxFailures === 1 ? undefined : 'rerun chain evidence invalid or ambiguous; operator must inspect failed jobs and enqueue manually';
  const unavailable = { checks, confirmed: false, candidates: [], reason: refusal };
  if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 3) return unavailable;
  if (!failed.length) return { checks, confirmed: false, candidates: [] };
  const groups = new Map();
  for (const check of failed) {
    const job = mqActionsJob(check, repo);
    if (!job || check.head_sha !== commit || typeof check.name !== 'string' || !check.name.trim()
      || !completed(check) || !Number.isFinite(stamp(check.started_at))
      || stamp(check.started_at) > stamp(check.completed_at)) return unavailable;
    const key = JSON.stringify([job.run, check.name]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(check);
  }
  const originals = [], candidates = [];
  let confirmed = true, retryFailed = false, worst = 0;
  for (const failures of groups.values()) {
    failures.sort((a, b) => stamp(a.completed_at) - stamp(b.completed_at));
    const original = failures[0], originalJob = mqActionsJob(original, repo);
    originals.push(original);
    if (stamp(original.completed_at) >= removedAt) return unavailable;
    if (maxFailures > 1) {
      const chain = mqChain(checks, repo, commit, original, removedAt);
      if (!chain) return unavailable;
      worst = Math.max(worst, chain.failures);
      if (chain.failures >= maxFailures) retryFailed = true;
      if (chain.state !== 'confirmed') confirmed = false;
      if (chain.state === 'candidate') candidates.push(chain.candidate);
      continue;
    }
    const attempts = checks.filter(check => check.id !== original.id && check.name === original.name
      && check.head_sha === commit && mqActionsJob(check, repo)?.run === originalJob.run
      && mqActionsJob(check, repo)?.id !== originalJob.id
      && stamp(check.started_at) > stamp(original.completed_at));
    // A second failure is head-failure evidence, even if a third attempt goes green.
    if (failures.length > 1) retryFailed = true;
    if (attempts.length !== 1 || !completed(attempts[0]) || attempts[0].conclusion !== 'success'
      || stamp(attempts[0].completed_at) < stamp(attempts[0].started_at)) confirmed = false;
    if (!attempts.length && failures.length === 1) candidates.push(originalJob.id);
  }
  const originalIds = new Set(originals.map(check => check.id));
  // Leave unrelated unknown/in-progress checks visible to the caller's fail-closed validation.
  const selected = checks.filter(check => originalIds.has(check.id) || ![...groups.values()].some(group => {
    const original = group[0];
    return check.name === original.name && check.head_sha === commit
      && mqActionsJob(check, repo)?.run === mqActionsJob(original, repo).run
      && stamp(check.started_at) > stamp(original.completed_at);
  }));
  return { checks: selected, confirmed: confirmed && !retryFailed, failures: worst || undefined,
    candidates: retryFailed ? [] : [...new Set(candidates)],
    reason: retryFailed ? `rerun failed${maxFailures > 1 ? ` ${worst}/${maxFailures}` : ''}; operator must inspect failed jobs and enqueue manually`
      : !confirmed && !candidates.length ? 'rerun pending or incomplete; operator must inspect failed jobs before retrying' : null };
}

/** Injected, argv-only IO; claim before POST so ambiguous failures cannot cause repeated requests. */
export function requestMqReruns({ attempts, repo, exec, scope = exec, eligible, dryRun = false, spend = () => {} }) {
  if (!eligible || attempts.confirmed) return { reason: attempts.reason ?? null };
  if (attempts.reason) return { reason: attempts.reason };
  if (dryRun && attempts.candidates.length) return { reason: 'dry-run: rerun not requested; operator must inspect failed jobs' };
  if (attempts.candidates.length > 10)
    return { reason: 'failed jobs exceed 10-job limit; operator must inspect failed jobs and enqueue manually' };
  if (!attempts.candidates.length) return { reason: null };
  let spent = claims.get(scope);
  if (!spent) { spent = new Set(); claims.set(scope, spent); }
  if (spent.size + attempts.candidates.filter(id => !spent.has(`${repo}#${id}`)).length > 10000)
    return { reason: 'rerun claim limit reached; operator must inspect Actions and enqueue manually' };
  try {
    for (const id of attempts.candidates) {
      const key = `${repo}#${id}`;
      if (spent.has(key)) continue;
      spend();
      spent.add(key);
      exec('gh', ['api', '-X', 'POST', `repos/${repo}/actions/jobs/${id}/rerun`], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 },
      });
    }
    return { reason: 'rerun requested; wait for successful rerun evidence before enqueueing' };
  } catch {
    return { reason: 'rerun request refused or unreadable; operator must inspect Actions before retrying' };
  }
}
