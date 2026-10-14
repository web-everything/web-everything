/** Drain-side cancellation of merge_group runs made obsolete by queue rebuilds (card 258). */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readDeclaredSettings } from './settings-files.mjs';
import { PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';

const queueRun = run => run.event === 'merge_group' && run.status !== 'completed' && run.head_branch?.startsWith('gh-readonly-queue/');

/** Pure: only missing/rebuilt refs justify cancellation; age guards ref-creation races. */
export function planObsoleteRunCancels({ runs, liveRefs, nowMs, settings }) {
  const cancel = [], keep = [];
  const refs = liveRefs instanceof Map ? liveRefs : new Map(Object.entries(liveRefs));
  for (const run of runs) {
    if (!queueRun(run)) continue;
    const ageMs = nowMs - Date.parse(run.created_at);
    if (!Number.isFinite(ageMs)) { keep.push({ id: run.id, reason: 'invalid-created-at' }); continue; }
    if (ageMs < settings.minAgeSeconds * 1000) { keep.push({ id: run.id, reason: 'too-young' }); continue; }
    const reason = !refs.has(run.head_branch) ? 'ref-deleted' : refs.get(run.head_branch) !== run.head_sha ? 'ref-rebuilt' : null;
    if (reason) cancel.push({ id: run.id, name: run.name, headBranch: run.head_branch, reason });
    else keep.push({ id: run.id, reason: 'live-ref' });
  }
  return { cancel: cancel.sort((a, b) => a.id - b.id), keep };
}

/** Resolve each key independently; injected settings/platform objects bypass disk reads. */
export function resolveCancelObsoleteRunsSettings({ env = process.env, settings, platform } = {}) {
  const invalid = [];
  const repoSettings = () => settings ??= (env?.VITEST || env?.WE_UNDER_TEST) ? {} : readDeclaredSettings().settings;
  const platformSettings = () => {
    if (platform === undefined) {
      try { platform = JSON.parse(readFileSync(PLATFORM_PREFERENCES_PATH, 'utf8')); }
      catch { platform = {}; }
    }
    return platform;
  };
  const resolve = (key, envKey, standard, validate) => {
    const layers = [
      ['env', () => env?.[envKey]],
      ['repo', () => repoSettings()?.mergeQueue?.[key]],
      ['platform', () => platformSettings()?.mergeQueue?.[key]],
    ];
    for (const [source, read] of layers) {
      const raw = read();
      if (raw === undefined) continue;
      const value = source === 'env' && typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
      if (validate(value)) return { value, source };
      invalid.push(`${source}.mergeQueue.${key}`);
    }
    return { value: standard, source: 'standard' };
  };
  const on = resolve('cancelObsoleteRuns', 'WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS', 'on', v => v === 'on' || v === 'off');
  const age = resolve('cancelObsoleteRunsMinAgeSeconds', 'WE_MERGE_QUEUE_CANCEL_OBSOLETE_RUNS_MIN_AGE_SECONDS', 30, v => Number.isSafeInteger(v) && v >= 0);
  return { cancelObsoleteRuns: on.value, minAgeSeconds: age.value, sources: { cancelObsoleteRuns: on.source, minAgeSeconds: age.source }, invalid };
}

export function formatCancelObsoleteRunsSettings(s) {
  return `merge-queue: cancelObsoleteRuns=${s.cancelObsoleteRuns} (${s.sources.cancelObsoleteRuns}), minAgeSeconds=${s.minAgeSeconds} (${s.sources.minAgeSeconds})${s.invalid.length ? `; ignored invalid: ${s.invalid.join(', ')}` : ''}`;
}

const errorLine = error => String(error?.stderr || error?.message || error).trim().split('\n')[0];

/** Thin synchronous IO shell. All reads finish before the first cancellation; failures never escape. */
export function cancelObsoleteQueueRuns({ repo, exec = execFileSync, nowMs = Date.now(), settings = resolveCancelObsoleteRunsSettings(), dryRun = false, log = process.stderr }) {
  const say = line => typeof log === 'function' ? log(line) : log.write(`${line}\n`);
  say(formatCancelObsoleteRunsSettings(settings));
  if (settings.cancelObsoleteRuns === 'off') { say('merge-queue: obsolete run cancellation is off'); return { off: true }; }
  const api = args => exec('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  let plan;
  try {
    // --slurp makes paginated JSON a single parseable array of pages, including empty refs.
    const runs = [];
    for (const status of ['in_progress', 'queued']) {
      const response = JSON.parse(api([`repos/${repo}/actions/runs?event=merge_group&status=${status}&per_page=100`, '--paginate', '--slurp']));
      const pages = Array.isArray(response) ? response : [response];
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page?.workflow_runs))) throw new Error('invalid workflow runs response');
      runs.push(...pages.flatMap(page => page.workflow_runs));
    }
    // Read refs LAST: a missing ref for a previously listed run is evidence of deletion.
    const response = JSON.parse(api([`repos/${repo}/git/matching-refs/heads/gh-readonly-queue/`, '--paginate', '--slurp']));
    const pages = Array.isArray(response) && response.length && !Array.isArray(response[0]) ? [response] : response;
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('invalid queue refs response');
    const refs = pages.flat();
    if (refs.some(ref => typeof ref?.ref !== 'string' || !ref.ref.startsWith('refs/heads/gh-readonly-queue/') || typeof ref?.object?.sha !== 'string' || !ref.object.sha)) throw new Error('invalid queue ref');
    const liveRefs = new Map(refs.map(ref => [ref.ref.slice('refs/heads/'.length), ref.object.sha]));
    // A run can move from queued to in_progress between paginated reads; cancel each id only once.
    plan = planObsoleteRunCancels({ runs: [...new Map(runs.map(run => [run.id, run])).values()], liveRefs, nowMs, settings });
  } catch (e) {
    const error = errorLine(e);
    say(`⚠ merge-queue: obsolete run read failed (${error}); no runs cancelled`);
    return { error };
  }
  const cancelled = [], failed = [];
  for (const run of plan.cancel) {
    const detail = `merge_group run ${run.id} ${JSON.stringify(run.name)} on ${run.headBranch} (${run.reason})`;
    if (dryRun) { say(`✂ would cancel ${detail}`); continue; }
    try {
      api(['-X', 'POST', `repos/${repo}/actions/runs/${run.id}/cancel`]);
      cancelled.push(run);
      say(`✂ cancelled ${detail}`);
    } catch (e) {
      const error = errorLine(e);
      failed.push({ ...run, error });
      say(`⚠ failed to cancel ${detail}: ${error}`);
    }
  }
  return { considered: plan.cancel.length + plan.keep.length, cancelled, failed, kept: plan.keep.length, dryRun };
}
