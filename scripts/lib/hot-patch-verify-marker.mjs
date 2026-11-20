import { spawnSync } from 'node:child_process';
import { runGhSync } from './gh-throttle.mjs';
import { resolveHotPatchSettings, hotPatchDefaults } from './hot-patch-settings.mjs';
import { repoSlugFromRemote } from './lane-verify.mjs';

// Same-uid signing cannot establish an independent producer. GitHub is the single source.
export function verifyUrgentMarker(sha) {
  return { ok: false, reason: 'forge-signed marker not accepted yet' };
}

/** Read the exact commit's newest Actions test check, ordered solely by numeric run id. */
function readVerifyResult({ sha, root = process.cwd(), env = process.env, runGh = runGhSync, settings } = {}) {
  const foreign = [];
  const refuse = () => ({ ok: false, result: 'unknown', foreign,
    reason: 'CI verify unavailable; repair GitHub access/repository or wait for the exact-sha test check and retry verify-result' });
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) return refuse();
  sha = sha.toLowerCase();
  try {
    settings ??= resolveHotPatchSettings({ env });
    let repo = settings.verifyRepo;
    if (!repo) {
      const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'],
        { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
      if (remote.error || remote.status !== 0) return refuse();
      repo = repoSlugFromRemote(remote.stdout);
    }
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return refuse();
    const maxBuffer = settings.maxOutputBytes ?? hotPatchDefaults.maxOutputBytes;
    const output = runGh(['api', `repos/${repo}/commits/${sha}/check-runs`, '--paginate', '--slurp', '--jq', '[.[].check_runs[]]'],
      { cwd: root, env, encoding: 'utf8', timeout: settings.ioTimeoutMs ?? hotPatchDefaults.ioTimeoutMs, maxBuffer });
    if (typeof output !== 'string' || Buffer.byteLength(output) > maxBuffer) return refuse();
    const runs = JSON.parse(output);
    if (!Array.isArray(runs)) return refuse();
    const candidates = [];
    for (const run of runs) {
      if (run?.name !== 'test') continue;
      if (run.app?.id !== hotPatchDefaults.verifyAppId || run.app?.slug !== hotPatchDefaults.verifyAppSlug) {
        foreign.push(run); continue;
      }
      if (typeof run.head_sha !== 'string' || run.head_sha.toLowerCase() !== sha
        || !/^[1-9][0-9]*$/.test(String(run.id)) || !['string', 'number'].includes(typeof run.id)
        || (typeof run.id === 'number' && !Number.isSafeInteger(run.id))) return refuse();
      candidates.push(run);
    }
    candidates.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0);
    const newest = candidates[0];
    if (!newest || (candidates[1] && BigInt(newest.id) === BigInt(candidates[1].id))) return refuse();
    let result;
    if (['queued', 'in_progress'].includes(newest.status)) result = 'pending';
    else if (newest.status === 'completed') {
      if (newest.conclusion === 'success') result = 'green';
      else if (['failure', 'cancelled', 'timed_out', 'neutral', 'action_required', 'stale', 'startup_failure'].includes(newest.conclusion)) result = 'red';
    }
    return result ? { ok: true, result, run: newest, foreign } : refuse();
  } catch { return refuse(); }
}

/** The sole CI verdict entry point; local verification is never evidence. */
export function ciVerdict({ sha, root, env, runGh, settings } = {}) {
  const evidence = readVerifyResult({ sha, root, env, runGh, settings });
  return {
    state: evidence.ok ? evidence.result : 'unknown',
    reason: evidence.reason ?? `GitHub Actions test check is ${evidence.result}`,
    runId: evidence.run?.id ?? null,
  };
}
