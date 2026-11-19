import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { resolveCascade, readPlatformPreferences } from './policy-cascade.mjs';
import { readSettingsChecked } from './settings-files.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 2000);
const key = ({ repo, num, head }) => createHash('sha256').update(`${repo.toLowerCase()}#${num}\n${head}`).digest('hex');
const holds = ['review:pending', 'review:changes', 'review:human', 'review:held-mechanical'];

/** Invalid bounds disable repair; operators can inspect and update the branch manually. */
export function resolveStaleGateUpdateBranchMax({ platform, tool, env = {} } = {}) {
  const raw = env.WE_DRAIN_STALE_GATE_UPDATE_BRANCH_MAX;
  const r = resolveCascade({ standard: 2, platform: platform?.staleGateUpdateBranchMax,
    tool: tool?.staleGateUpdateBranchMax,
    envValues: { '': raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : NaN },
    valid: value => Number.isSafeInteger(value) && value >= 0 && value <= 100 });
  return r.invalid.length ? { value: 0, source: 'invalid setting; disabled — inspect and update branch manually' }
    : { value: r.value, source: r.sources[''] };
}

export function readStaleGateUpdateBranchMax({ env = process.env, readTool = readSettingsChecked,
  readPlatform = readPlatformPreferences } = {}) {
  try {
    const tool = readTool({ namespace: 'drain.staleGateUpdateBranchMax' });
    const platform = readPlatform({ env });
    if (tool.taint.length || platform.errors.length) throw new Error('unreadable settings');
    return resolveStaleGateUpdateBranchMax({ platform: platform.prefs.drain,
      tool: { staleGateUpdateBranchMax: tool.value }, env });
  } catch {
    return { value: 0, source: 'unreadable settings; disabled — inspect and update branch manually' };
  }
}

/** Pure. Evidence must describe the judged head, including a complete gate history. */
export function planStaleGateUpdateBranch({ pr, head, defaultBranch, checkRuns, requiredChecks,
  isRequiredCheckGreen, fixClaimHeld, attempted = false } = {}) {
  if (!pr || !sha(head) || pr.headRefOid !== head || attempted !== false || fixClaimHeld !== false
    || pr.requiredCheckReadError || pr.isCrossRepository !== false || pr.mergeable !== 'MERGEABLE'
    || pr.mergeStateStatus !== 'BLOCKED' || typeof defaultBranch !== 'string' || !defaultBranch.trim() || pr.baseRefName !== defaultBranch
    || !Array.isArray(pr.labels) || pr.labels.some(l => typeof l?.name !== 'string')
    || !Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length >= 100
    || !Array.isArray(requiredChecks) || !requiredChecks.length
    || requiredChecks.some(n => typeof n !== 'string' || !n.trim())
    || typeof isRequiredCheckGreen !== 'function' || !Array.isArray(checkRuns)) return null;
  const labels = new Set(pr.labels.map(l => l.name));
  if (!['ready-to-merge', 'review:accepted', 'red-team:clear'].every(l => labels.has(l))
    || holds.some(l => labels.has(l))) return null;
  const gates = checkRuns.filter(c => c?.name === 'merge-gate');
  if (!gates.length || gates.some(c => !Number.isSafeInteger(c.id) || c.id <= 0 || c.head_sha !== head)) return null;
  const latest = [...gates].sort((a, b) => b.id - a.id)[0];
  if (latest.status !== 'completed' || latest.conclusion !== 'failure') return null;
  try {
    if (!requiredChecks.filter(n => n !== 'merge-gate').every(n => isRequiredCheckGreen(pr, n) === true)) return null;
  } catch { return null; }
  return { head };
}

function attempted(path, head) {
  try {
    if (statSync(path).size > 4096) throw new Error('oversized attempt state; inspect and update branch manually');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved?.head !== head || saved?.attempted !== true) throw new Error('unreadable attempt state');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Best effort only; reserve before PUT so errors/crashes never retry the same head. No merge decisions change.
 * The caller supplies only BLOCKED skip verdicts and memoizes the live required-check roster per repo.
 */
export function updateStaleGateBranches({ candidates = [], max = 2, defaultBranchOf, requiredChecksOf,
  isRequiredCheckGreen, fixClaimHeld, gh = execFileSyncThrottled, log = message => process.stderr.write(`${message}\n`),
  stateRoot = join(resolveCoordinationRoot(), 'stale-gate-update-branch') } = {}) {
  const results = [];
  if (!Number.isSafeInteger(max) || max < 1 || max > 100 || !Array.isArray(candidates)) return results;
  let attempts = 0;
  // At most 100 fresh PR reads + 100 gate reads per pass, apart from the memoized roster read.
  if (candidates.length > 100) log('stale-gate-update-branch: candidate scan capped at 100; inspect remaining PRs and update branches manually');
  const options = { encoding: 'utf8', stdio: 'pipe', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
  for (const c of candidates.slice(0, 100)) {
    if (attempts >= max) break;
    let didAttempt = false;
    try {
      if (!/^[\w.-]+\/[\w.-]+$/.test(c?.repo ?? '') || !Number.isSafeInteger(c.num) || c.num <= 0 || !sha(c.head)) continue;
      const path = join(stateRoot, key(c));
      if (attempted(path, c.head)) continue;
      const defaultBranch = defaultBranchOf(c.repo);
      const requiredChecks = requiredChecksOf(c.repo);
      if (!defaultBranch || !Array.isArray(requiredChecks) || !requiredChecks.length) continue;
      const pr = JSON.parse(gh('gh', ['pr', 'view', String(c.num), '--repo', c.repo, '--json',
        'number,headRefOid,baseRefName,isCrossRepository,mergeable,mergeStateStatus,labels,statusCheckRollup'], options));
      if (pr?.number !== c.num || pr.headRefOid !== c.head) continue;
      if (!Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length >= 100) {
        throw new Error('unreadable or capped check rollup');
      }
      const checks = JSON.parse(gh('gh', ['api', `repos/${c.repo}/commits/${c.head}/check-runs?per_page=100&filter=all&check_name=merge-gate`], options));
      if (!Array.isArray(checks?.check_runs) || !Number.isSafeInteger(checks.total_count)
        || checks.total_count !== checks.check_runs.length || checks.total_count > 100) {
        throw new Error('incomplete or oversized gate evidence; inspect and update branch manually');
      }
      const plan = planStaleGateUpdateBranch({ pr, head: c.head, defaultBranch, checkRuns: checks.check_runs,
        requiredChecks, isRequiredCheckGreen, fixClaimHeld: fixClaimHeld(c.repo, c.num) });
      if (!plan) continue;
      mkdirSync(stateRoot, { recursive: true });
      withFileLock(`${path}.lock`, () => {
        if (attempted(path, c.head) || fixClaimHeld(c.repo, c.num) !== false) return;
        writeJsonAtomic(path, { head: c.head, attempted: true });
        attempts++; didAttempt = true;
        gh('gh', ['api', '-X', 'PUT', `repos/${c.repo}/pulls/${c.num}/update-branch`, '-f', `expected_head_sha=${c.head}`], options);
      }, { timeoutMs: 0, staleMs: 10 * 60_000 });
      if (didAttempt) {
        results.push({ ...c, ok: true });
        log(`stale-gate-update-branch ${c.repo}#${c.num}@${c.head}: attempted`);
      }
    } catch (error) {
      results.push({ ...c, ok: false, attempted: didAttempt });
      log(`stale-gate-update-branch failed: ${clean(c?.repo)}#${clean(c?.num)}: ${clean(error?.message ?? error)} — skipped; inspect and update branch manually`);
    }
  }
  return results;
}
