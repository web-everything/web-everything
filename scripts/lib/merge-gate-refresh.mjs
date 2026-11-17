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
 * Three bounded reads, then at most three attempts for each label call (including
 * a pre-removal if the label is already present),
 * plus one final removal attempt after the gate has already been triggered.
 * Each failed add gets one label read before retrying; present or unreadable
 * evidence consumes the trigger and gets just one cleanup attempt.
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
    return { ok: true, refreshed: true, ...(result.note ? { note: result.note } : {}) };
  } catch (error) {
    const message = `${errorText(error)}; acceptance restamp retained — retry restamp or ask an operator to toggle ${LABEL}`;
    process.stderr.write(`merge-gate refresh FAILED for ${repo}#${pr}: ${message}\n`);
    return { ok: false, error: message };
  }
}

/** Shared bounded trigger; callers must verify the PR head before toggling. */
export function toggleMergeGateRefresh({ repo, pr, gh = execFileSyncThrottled, sleep = sleepSync }) {
  const options = { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
  const labelCall = (args, alreadyExistsOk = false, onError = null) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        gh('gh', args, options);
        return;
      } catch (error) {
        if (alreadyExistsOk && /already exists/i.test(errorText(error))) return;
        const recovered = onError?.(error);
        if (recovered) return recovered;
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
  const labels = readLabels();
  const removeArgs = ['pr', 'edit', String(pr), '--repo', repo, '--remove-label', LABEL];
  // A successful add only triggers the gate when the label was absent.
  if (labels.some(label => label.name === LABEL)) labelCall(removeArgs);
  labelCall(['label', 'create', LABEL, '--repo', repo, '--color', 'ededed',
    '--description', 'Refresh merge-gate after acceptance restamp'], true);
  const recovered = labelCall(['pr', 'edit', String(pr), '--repo', repo, '--add-label', LABEL], false, error => {
    let evidence;
    try {
      if (!readLabels().some(label => label.name === LABEL)) return null;
      evidence = `${LABEL} is present`;
    } catch (readError) {
      evidence = `label read failed: ${errorText(readError)}`;
    }
    // GitHub may have dispatched before the add failed locally. Never re-arm
    // the caller's once-per-head claim without confirmed absence.
    return { note: `merge-gate treated as triggered after add error: ${errorText(error)}; ${evidence}; ask an operator to inspect the gate if it remains held` };
  });
  if (recovered) {
    try { gh('gh', removeArgs, options); }
    catch (error) { recovered.note += `; ${LABEL} removal failed: ${errorText(error)}; ask an operator to remove ${LABEL}`; }
    return { ok: true, note: recovered.note };
  }
  // The add has dispatched the gate. Cleanup failure must not re-arm its once-per-head claim.
  try { labelCall(removeArgs); }
  catch {
    try { gh('gh', removeArgs, options); }
    catch (error) {
      return { ok: true, note: `merge-gate triggered; ${LABEL} removal failed: ${errorText(error)}; ask an operator to remove ${LABEL}` };
    }
    return { ok: true, note: `merge-gate triggered; ${LABEL} cleanup succeeded on the final removal attempt` };
  }
  return { ok: true };
}
