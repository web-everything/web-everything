import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { resolveCascade, readPlatformPreferences } from './policy-cascade.mjs';
import { readRequiredStatusChecksDetailed } from './required-status-checks.mjs';
import { readSettingsChecked } from './settings-files.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 2000);
const key = ({ repo, num, head }) => createHash('sha256').update(`${repo.toLowerCase()}#${num}\n${head}`).digest('hex');
const holds = ['review:pending', 'review:changes', 'review:human', 'review:held-mechanical'];

/** Invalid bounds disable repair; operators can inspect and update the branch manually. */
export function resolveStaleGateUpdateBranchMax({ platform, tool, env = {} } = {}) {
  const invalid = [platform?.staleGateUpdateBranchMax, tool?.staleGateUpdateBranchMax]
    .some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 100));
  if (invalid) return { value: 0, source: 'invalid setting; disabled — inspect and update branch manually' };
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
    || ![null, '', 'APPROVED'].includes(pr.reviewDecision)
    || pr.mergeStateStatus !== 'BLOCKED' || typeof defaultBranch !== 'string' || !defaultBranch.trim() || pr.baseRefName !== defaultBranch
    || !Array.isArray(pr.labels) || pr.labels.some(l => typeof l?.name !== 'string')
    || !Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length >= 100
    || !Array.isArray(requiredChecks) || !requiredChecks.length
    || requiredChecks.some(c => typeof c?.context !== 'string' || !c.context.trim())
    || typeof isRequiredCheckGreen !== 'function' || !Array.isArray(checkRuns)) return null;
  const labels = new Set(pr.labels.map(l => l.name));
  if (!['ready-to-merge', 'review:accepted', 'red-team:clear'].every(l => labels.has(l))
    || holds.some(l => labels.has(l))) return null;
  const gates = checkRuns.filter(c => c?.name === 'merge-gate');
  if (!gates.length || gates.some(c => !Number.isSafeInteger(c.id) || c.id <= 0 || c.head_sha !== head)) return null;
  const latest = [...gates].sort((a, b) => b.id - a.id)[0];
  if (latest.status !== 'completed' || latest.conclusion !== 'failure') return null;
  try {
    if (!requiredChecks.filter(c => c.context !== 'merge-gate').every(({ context, appId }) => {
      if (!Number.isSafeInteger(appId) || appId <= 0) return false;
      const rows = checkRuns.filter(c => c?.name === context && c?.app?.id === appId);
      if (!rows.length || rows.some(c => c.head_sha !== head || !Number.isSafeInteger(c.id) || c.id <= 0)) return false;
      const statusCheckRollup = rows.map(c => ({ __typename: 'CheckRun', name: c.name, databaseId: c.id,
        status: c.status?.toUpperCase(), conclusion: c.conclusion?.toUpperCase() }));
      return isRequiredCheckGreen({ ...pr, statusCheckRollup }, context) === true;
    })) return null;
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
  isRequiredCheckGreen, fixClaimHeld, humanSurfaceGuardAllows, gh = execFileSyncThrottled, log = message => process.stderr.write(`${message}\n`),
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
        'number,headRefOid,baseRefName,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,labels,statusCheckRollup'], options));
      if (pr?.number !== c.num || pr.headRefOid !== c.head) continue;
      if (!Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.length >= 100) {
        throw new Error('unreadable or capped check rollup');
      }
      const checks = JSON.parse(gh('gh', ['api', `repos/${c.repo}/commits/${c.head}/check-runs?per_page=100&filter=all`], options));
      if (!Array.isArray(checks?.check_runs) || !Number.isSafeInteger(checks.total_count)
        || checks.total_count !== checks.check_runs.length || checks.total_count > 100) {
        throw new Error('incomplete or oversized check evidence; inspect and update branch manually');
      }
      const plan = planStaleGateUpdateBranch({ pr, head: c.head, defaultBranch, checkRuns: checks.check_runs,
        requiredChecks, isRequiredCheckGreen, fixClaimHeld: fixClaimHeld(c.repo, c.num) });
      if (!plan) continue;
      mkdirSync(stateRoot, { recursive: true });
      withFileLock(`${path}.lock`, () => {
        if (attempted(path, c.head) || fixClaimHeld(c.repo, c.num) !== false) return;
        if (humanSurfaceGuardAllows?.(c.repo, c.num, c.head) !== true) {
          throw new Error('approved human-surface head held or approval proof unknown');
        }
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

/** Live union only: older names-only caches cannot prove a required app's identity. */
export function readStaleGateRequiredChecks({ repo, branch, readRequired = readRequiredStatusChecksDetailed } = {}) {
  if (typeof repo !== 'string' || !repo.trim() || typeof branch !== 'string' || !branch.trim()) return null;
  try {
    const { checks, requiredCheckApps } = readRequired({ repo, branch, includeAppIds: true });
    if (!Array.isArray(checks) || !checks.length || !Array.isArray(requiredCheckApps)
      || checks.some(context => !requiredCheckApps.some(c => c.context === context))) return null;
    return requiredCheckApps;
  } catch { return null; }
}
