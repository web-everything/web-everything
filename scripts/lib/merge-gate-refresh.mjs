import { execFileSyncThrottled } from './gh-throttle.mjs';

const LABEL = 'gate:refresh';
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const errorText = error => [error?.message ?? String(error), error?.stderr ?? '']
  .join(' ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 2000).trim();

/** Never fall back past a newer gate. A failed gate, or one still running that began before the restamp (it may have read the
 * pre-restamp thread), needs a fresh run; a successful gate or one started after the restamp does not. */
export function planGateRefresh({ checkRuns, head, restampedAtMs } = {}) {
  if (!/^[0-9a-f]{40}$/.test(head || '') || !Array.isArray(checkRuns)
    || !Number.isFinite(restampedAtMs)) return null;
  const gates = checkRuns.filter(check => check?.name === 'merge-gate');
  if (!gates.length || gates.some(check => !Number.isSafeInteger(check.id) || check.id <= 0)) return null;
  const newest = [...gates].sort((a, b) => b.id - a.id)[0];
  const startedAtMs = Date.parse(newest.started_at);
  if (newest.head_sha !== head
    || (newest.status === 'completed' && newest.conclusion !== 'failure')
    || !Number.isFinite(startedAtMs) || startedAtMs >= restampedAtMs) return null;
  return { checkRunId: newest.id };
}

/**
 * Best effort after a durable restamp; failure never undoes the acceptance.
 * No attempt markers: later restamps consult live checks and can retry naturally.
 * Label creation and stale-label clearing are bounded. The add is attempted once;
 * only a readable post-add label confirms dispatch. Unknown outcomes require a
 * read-only reconciliation on a later pass, never another add.
 * restampedAtMs is captured before posting, conservatively excluding racing runs.
 */
export function refreshMergeGateAfterRestamp({ repo, pr, head, gh = execFileSyncThrottled,
  sleep = sleepSync, restampedAtMs = Date.now() } = {}) {
  try {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[1-9][0-9]*$/.test(String(pr))
      || !/^[0-9a-f]{40}$/.test(head || '') || !Number.isFinite(restampedAtMs)) {
      throw new Error('invalid repo, PR, head or restamp timestamp');
    }
    const options = { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
    // Scope the bounded page to gate history; unrelated CI jobs must not exhaust it.
    const checks = JSON.parse(gh('gh', ['api', `repos/${repo}/commits/${head}/check-runs?per_page=100&filter=all&check_name=merge-gate`], options));
    if (!Array.isArray(checks?.check_runs) || !Number.isSafeInteger(checks.total_count)
      || checks.total_count !== checks.check_runs.length || checks.total_count > 100) {
      throw new Error('incomplete or oversized check-run evidence');
    }
    if (!planGateRefresh({ checkRuns: checks.check_runs, head, restampedAtMs })) return { ok: true, refreshed: false };
    // The drain's explicit new head can outpace GitHub's PR read. Do not label
    // a different live head from the one covered by the acceptance comment.
    const live = JSON.parse(gh('gh', ['api', `repos/${repo}/pulls/${pr}`], options));
    if (live?.head?.sha !== head) throw new Error('live PR head differs from restamped head');

    const result = toggleMergeGateRefresh({ repo, pr, gh, sleep });
    return result.ok ? { ok: true, refreshed: true } : { ...result, refreshed: false };
  } catch (error) {
    const message = `${errorText(error)}; acceptance restamp retained — retry restamp or ask an operator to toggle ${LABEL}`;
    process.stderr.write(`merge-gate refresh FAILED for ${repo}#${pr}: ${message}\n`);
    return { ok: false, error: message };
  }
}

/** Shared bounded trigger; callers must verify the PR head before toggling. */
export function toggleMergeGateRefresh({ repo, pr, gh = execFileSyncThrottled, sleep = sleepSync, pending = null }) {
  const options = { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
  const labelCall = (args, alreadyExistsOk = false) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        gh('gh', args, options);
        return;
      } catch (error) {
        if (alreadyExistsOk && /already exists/i.test(errorText(error))) return;
        if (attempt === 2) throw error;
        sleep(1000 * (attempt + 1));
      }
    }
  };
  const readLabels = () => {
    const live = JSON.parse(gh('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'labels'], options));
    if (!Array.isArray(live?.labels) || live.labels.some(label => typeof label?.name !== 'string' || !label.name)) {
      throw new Error('incomplete PR label evidence');
    }
    return live.labels;
  };
  const pendingResult = (error, confirmed = false) => ({ ok: false, state: 'pending-unknown', confirmed,
    error: `${error}; re-read labels next pass; ask an operator to inspect ${LABEL}` });
  const removeArgs = ['pr', 'edit', String(pr), '--repo', repo, '--remove-label', LABEL];
  const reconcile = () => {
    let present;
    try { present = readLabels().some(label => label.name === LABEL); }
    catch (error) { return pendingResult(`label read failed: ${errorText(error)}`, pending?.confirmed ?? false); }
    if (!present) return pending?.confirmed ? { ok: true, state: 'confirmed' }
      : pendingResult('trigger not confirmed by label read');
    try { gh('gh', removeArgs, options); }
    catch (error) { return pendingResult(`${LABEL} removal failed: ${errorText(error)}; ask an operator to remove ${LABEL}`, true); }
    return { ok: true, state: 'confirmed' };
  };
  // A pending trigger may already have dispatched. Never clear and re-add it.
  if (pending) return reconcile();
  const labels = readLabels();
  if (labels.some(label => label.name === LABEL)) labelCall(removeArgs);
  labelCall(['label', 'create', LABEL, '--repo', repo, '--color', 'ededed',
    '--description', 'Refresh merge-gate after acceptance restamp'], true);
  try { gh('gh', ['pr', 'edit', String(pr), '--repo', repo, '--add-label', LABEL], options); }
  catch (error) {
    if (/\bHTTP(?:\/[^ ]+)?\s+4\d\d\b/i.test(errorText(error)) || (error?.status >= 400 && error?.status < 500)) {
      return { ok: false, state: 'denied', error: errorText(error) };
    }
    // The write may have reached GitHub. Read once, without retrying the add.
  }
  return reconcile();
}
