/**
 * Card 272 part 2 (live #5045, 2026-10-13).
 * A PR red only on tests main passes gets one cheap base refresh before any fixer.
 * Unknown evidence fails closed: leave the repair with ci-heal rather than push a
 * branch on a guess. Trusted PR comments spend the budget once per base, including
 * failed refreshes, so another failure cannot keep requesting the same refresh.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { execFileSyncThrottled, isGhDeferred } from '../lib/gh-throttle.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { collapseRollupToLatestPerName } from '../merge-ai-prs.mjs';
import { isMainLatestCheckGreen, mainLatestGreenShaForCheck, collapseMainCheckRunsToLatestPerName } from './main-red-recovery.mjs';
import { defaultReadMainRuns, defaultReadMainLatestCheckRuns } from './reconcile-pass.mjs';
import { refreshOntoMain, reconcileAcceptanceAfterRebase } from './ci-red-recovery-watch.mjs';
import { pushRefusal } from './fix-procedure.mjs';
import { resolveLanePoolRepoPath } from './lane-pool-health-watch.mjs';
import { REPO_ROOT } from '../operations/dispatch-lane-io.mjs';

export const STALE_BASE_REFRESH_MARKER = '🔁 conveyor stale-base refresh';
export const AGGREGATOR_PATTERNS = [/One or more test shards did not succeed/];
/** Only the test workflow's jobs are judged. Other workflows (e.g. the `review-gate` check, red until a review
 *  lands) are not CI failures a refresh or a ci-heal could clear, so they neither block nor justify a refresh. */
export const CI_WORKFLOW_NAME = 'CI';
/** Rollup conclusions that mean a job really went red. CANCELLED / SKIPPED / NEUTRAL / pending are not failures. */
export const FAILING_CONCLUSIONS = Object.freeze(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR']);
const TEST_FILE_RE = /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s|$)/;
const KNOWN_MERGE_STATES = ['DIRTY', 'BLOCKED', 'BEHIND', 'CLEAN', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE'];
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

export function resolveStaleBaseSetting({ env = process.env, settings = readSettings() } = {}) {
  const resolved = cascadePolicy('ciHeal', settings?.ciHeal, {
    standard: { staleBaseRefreshFirst: 'off' },
    envValues: { staleBaseRefreshFirst: env.WE_CI_HEAL_STALE_BASE_REFRESH_FIRST || undefined },
    valid: v => v === 'on' || v === 'off', env,
  });
  return { value: resolved.value.staleBaseRefreshFirst, source: resolved.sources.staleBaseRefreshFirst };
}

/** PURE: Vitest failure rows, with GitHub timestamps and terminal colours removed. */
export function extractFailingTestFiles(log) {
  if (typeof log !== 'string') return [];
  const clean = log.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const files = [];
  for (const line of clean.split(/\r?\n/)) {
    const row = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, '');
    const match = row.match(TEST_FILE_RE);
    if (match) files.push(match[1]);
  }
  return [...new Set(files)];
}

/** Common prerequisites are required for either evidence path; the paths are alternatives. */
export function decideStaleBaseRefresh(f = {}) {
  let failingTestFiles = [];
  const no = why => ({ owed: false, via: null, why, failingTestFiles });
  if (f.readFailure) return no(f.readFailure);
  if (!f.setting?.source || !['on', 'off'].includes(f.setting?.value)) return no('missing setting value or source');
  if (f.setting.value === 'off') return no(`ciHeal.staleBaseRefreshFirst=off (source ${f.setting.source})`);
  if (!f.baseRefName || !f.defaultBranch) return no('missing baseRefName or defaultBranch');
  if (f.baseRefName !== f.defaultBranch) return no('baseRefName is not the default branch');
  if (f.isCrossRepository === true) return no('cross-repository PR');
  if (!KNOWN_MERGE_STATES.includes(f.mergeStateStatus)) return no('missing or unknown mergeStateStatus');
  if (f.mergeStateStatus === 'DIRTY') return no('mergeStateStatus DIRTY needs a conflict repair');
  if (!Array.isArray(f.failingChecks)) return no('missing failingChecks');
  if (!f.failingChecks.length) return no('no failingChecks');
  for (const check of f.failingChecks) {
    if (check?.conclusion !== 'FAILURE') return no(`failingChecks ${check?.name ?? 'unknown'} conclusion ${check?.conclusion ?? 'missing'} is not FAILURE`);
    if (!check.name) return no('missing failing check name');
    const files = extractFailingTestFiles(check.log);
    if (!files.length && !(typeof check.log === 'string' && AGGREGATOR_PATTERNS.some(p => p.test(check.log)))) {
      return no(`failing check ${check.name} has no failing test files or aggregator log (non-test or unreadable log)`);
    }
    failingTestFiles = [...new Set([...failingTestFiles, ...files])];
  }
  if (!failingTestFiles.length) return no('no failing test files overall');
  if (!Number.isFinite(f.behindBy) || f.behindBy <= 0) return no('behindBy missing or not greater than zero');
  if (!isSha(f.mergeBase)) return no('missing or invalid mergeBase');
  if (typeof f.budgetSpent !== 'boolean') return no('missing budgetSpent');
  if (f.budgetSpent) return no('already refreshed once for this base');
  const green = f.failingChecks.every(c => isMainLatestCheckGreen({ failingCheckName: c.name, mainLatestCheckRuns: f.mainLatestCheckRuns }));
  const untouched = Array.isArray(f.prFiles) && !f.prFiles.some(p => failingTestFiles.includes(p));
  if (green && f.headContainsMainGreenSha === false && untouched) {
    return { owed: true, via: 'main-green', why: 'all failing checks pass on main; head lacks that commit and PR leaves failing tests untouched', failingTestFiles };
  }
  if (Array.isArray(f.mainChangedFailingFiles) && f.mainChangedFailingFiles.some(p => failingTestFiles.includes(p))) {
    return { owed: true, via: 'test-changed-on-main', why: 'main changed a failing test since the merge base', failingTestFiles };
  }
  return no(`main-green conditions failed: mainLatestCheckRuns green=${green}, headContainsMainGreenSha=${f.headContainsMainGreenSha ?? 'missing'}, prFiles=${Array.isArray(f.prFiles) ? (untouched ? 'untouched' : 'touch failing tests') : 'missing'}; mainChangedFailingFiles=${Array.isArray(f.mainChangedFailingFiles) ? 'no failing tests changed' : 'missing'}`);
}

export function buildStaleBaseComment({ head, mergeBase, onto, via, failingTestFiles = [], outcome }) {
  return `${STALE_BASE_REFRESH_MARKER}\nhead: ${head}\nbase: ${mergeBase}\nonto: ${onto ?? 'none'}\nvia: ${via}\nfailing-tests: ${failingTestFiles.join(', ')}\noutcome: ${outcome}\nOne base refresh was attempted before a ci-heal fixer (card 272 part 2, live #5045, 2026-10-13).`;
}

export function staleBaseBudgetSpent({ comments, mergeBase } = {}) {
  if (!isSha(mergeBase) || !Array.isArray(comments)) return false;
  return comments.some(c => {
    if (!isTrustedMarkerAuthor(c) || typeof c?.body !== 'string') return false;
    const lines = c.body.split(/\r?\n/);
    return lines[0] === STALE_BASE_REFRESH_MARKER && (lines.includes(`base: ${mergeBase}`) || lines.includes(`onto: ${mergeBase}`));
  });
}

const childOptions = () => ({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 16 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
// A dispatcher's root is the WE checkout, even when dispatching a sibling repo.
// Use the same lane-pool resolver as ci-red-recovery-watch; WE has no fixed path.
const repoRoot = (slug, root) => resolveLanePoolRepoPath(slug) ?? root ?? REPO_ROOT;

/** IO: stop before the expensive reads whenever a common prerequisite rules out refresh. */
export function readStaleBaseFacts({ repo, pr, defaultBranch = 'main', exec = execFileSyncThrottled, root,
  readMainRuns = defaultReadMainRuns, readMainLatestCheckRuns = defaultReadMainLatestCheckRuns,
  readComments, setting = resolveStaleBaseSetting(), head = null } = {}) {
  const facts = { setting, defaultBranch };
  const finish = () => ({ facts, decision: decideStaleBaseRefresh(facts) });
  if (setting?.value !== 'on') return finish();
  const run = (cmd, args) => {
    const output = exec(cmd, args, childOptions());
    if (isGhDeferred(output)) throw new Error('GitHub read deferred; evidence is unknown');
    return String(output).trim();
  };
  let view;
  try {
    view = JSON.parse(run('gh', ['pr', 'view', String(pr), '--repo', repo, '--json',
      'headRefOid,headRefName,baseRefName,mergeStateStatus,isCrossRepository,statusCheckRollup,comments']));
  } catch { return finish(); }
  if (!view || typeof view !== 'object' || Array.isArray(view)) return finish();
  for (const key of ['headRefOid', 'headRefName', 'baseRefName', 'mergeStateStatus', 'isCrossRepository']) facts[key] = view[key];
  if (facts.isCrossRepository !== false || !isSha(facts.headRefOid) || !facts.headRefName) {
    facts.readFailure = 'missing same-repository head facts or cross-repository PR';
    return finish();
  }
  if (facts.baseRefName !== defaultBranch || !KNOWN_MERGE_STATES.includes(facts.mergeStateStatus) || facts.mergeStateStatus === 'DIRTY') return finish();
  // Dry run only (CLI `--head=<sha>`): judge a RECORDED head's CI jobs instead of the PR's current rollup, so the
  // decision can be replayed on a case the conveyor has since moved past (live #5045 head 63a7c1d).
  if (head) {
    if (!isSha(head)) { facts.readFailure = 'invalid --head sha'; return finish(); }
    try {
      const runs = JSON.parse(run('gh', ['api', `repos/${repo}/actions/runs?head_sha=${head}&per_page=100`, '--jq', '.workflow_runs']));
      const ci = (Array.isArray(runs) ? runs : []).filter(w => w?.name === CI_WORKFLOW_NAME)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
      const jobs = ci ? JSON.parse(run('gh', ['api', `repos/${repo}/actions/runs/${ci.id}/jobs?per_page=100`, '--jq', '.jobs'])) : [];
      view.statusCheckRollup = (Array.isArray(jobs) ? jobs : []).map(j => ({ name: j.name, workflowName: CI_WORKFLOW_NAME,
        conclusion: String(j.conclusion ?? '').toUpperCase(), completedAt: j.completed_at, detailsUrl: j.html_url }));
    } catch { return finish(); }
    facts.headRefOid = head;
  }
  if (!Array.isArray(view.statusCheckRollup)) return finish();
  if (view.statusCheckRollup.some(c => !c || typeof c !== 'object')) {
    facts.readFailure = 'missing or malformed failingChecks rollup entry';
    return finish();
  }
  facts.failingChecks = collapseRollupToLatestPerName(view.statusCheckRollup)
    .filter(c => c.workflowName === CI_WORKFLOW_NAME && FAILING_CONCLUSIONS.includes(String(c.conclusion ?? c.state ?? '').toUpperCase()))
    .map(c => ({ name: c.name ?? c.context, conclusion: String(c.conclusion ?? c.state ?? '').toUpperCase(),
      jobId: c.detailsUrl?.match(/\/job\/(\d+)/)?.[1] ?? null, log: '' }));
  if (!facts.failingChecks.length || facts.failingChecks.some(c => c.conclusion !== 'FAILURE')) return finish();
  for (const c of facts.failingChecks) {
    try { if (c.jobId) c.log = run('gh', ['api', `repos/${repo}/actions/jobs/${c.jobId}/logs`]); } catch { c.log = ''; }
    if (!extractFailingTestFiles(c.log).length && !AGGREGATOR_PATTERNS.some(p => p.test(c.log))) return finish();
  }
  const failingFiles = [...new Set(facts.failingChecks.flatMap(c => extractFailingTestFiles(c.log)))];
  if (!failingFiles.length) return finish();
  try {
    const compare = JSON.parse(run('gh', ['api', `repos/${repo}/compare/${defaultBranch}...${facts.headRefOid}`,
      '--jq', '{behind_by: .behind_by, merge_base: .merge_base_commit.sha}']));
    facts.behindBy = compare.behind_by; facts.mergeBase = compare.merge_base;
  } catch { return finish(); }
  if (!Number.isFinite(facts.behindBy) || facts.behindBy <= 0 || !isSha(facts.mergeBase)) return finish();
  let comments;
  try { comments = readComments ? readComments({ repo, pr, exec }) : view.comments; } catch { comments = null; }
  facts.budgetSpent = Array.isArray(comments) ? staleBaseBudgetSpent({ comments, mergeBase: facts.mergeBase }) : null;
  if (facts.budgetSpent !== false) return finish();
  try {
    const mainRuns = readMainRuns({ repo, branch: defaultBranch, exec });
    if (!Array.isArray(mainRuns)) throw new Error('main runs are unknown');
    facts.mainLatestCheckRuns = readMainLatestCheckRuns({ repo, branch: defaultBranch, exec, mainRuns });
  } catch { facts.mainLatestCheckRuns = null; }
  const entries = collapseMainCheckRunsToLatestPerName(facts.mainLatestCheckRuns);
  const greenShas = facts.failingChecks.map(c => mainLatestGreenShaForCheck({ failingCheckName: c.name, mainLatestCheckRuns: facts.mainLatestCheckRuns }));
  facts.headContainsMainGreenSha = null;
  if (greenShas.every(isSha) && facts.failingChecks.every(c => Number.isFinite(Date.parse(entries.get(c.name)?.completed_at)))) {
    const newest = facts.failingChecks.map(c => entries.get(c.name)).sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
    facts.mainGreenSha = newest.head_sha;
    try {
      const output = run('gh', ['api', `repos/${repo}/compare/${facts.mainGreenSha}...${facts.headRefOid}`, '--jq', '.behind_by']);
      const behind = /^\d+$/.test(output) ? Number(output) : NaN;
      if (Number.isFinite(behind) && behind >= 0) facts.headContainsMainGreenSha = behind === 0;
    } catch { /* unknown containment cannot justify path A */ }
  }
  try {
    facts.prFiles = run('gh', ['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '--jq', '.[].filename']).split(/\r?\n/).filter(Boolean);
  } catch { facts.prFiles = null; }
  try {
    facts.mainChangedFailingFiles = run('git', ['--literal-pathspecs', '-C', repoRoot(repo, root), 'diff', '--name-only',
      facts.mergeBase, `origin/${defaultBranch}`, '--', ...failingFiles]).split(/\r?\n/).filter(Boolean);
  } catch { facts.mainChangedFailingFiles = null; }
  return finish();
}

function defaultPostComment(pr, { repo, body }) {
  const dir = mkdtempSync(join(tmpdir(), 'stale-base-refresh-'));
  try {
    const path = join(dir, 'comment.md');
    writeFileSync(path, body, { mode: 0o600 });
    const output = execFileSyncThrottled('gh', ['pr', 'comment', String(pr), '--repo', repo, '--body-file', path], childOptions());
    if (isGhDeferred(output)) throw new Error('GitHub deferred the stale-base budget comment');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const defaultReadOriginTip = ({ root }) => String(execFileSyncThrottled('git', ['-C', root, 'rev-parse', 'origin/main'], childOptions())).trim();

export function createStaleBaseGate({ env = process.env, readFacts = readStaleBaseFacts, refresh = refreshOntoMain,
  checkClaim = pushRefusal, postComment = defaultPostComment, reconcileAcceptance = reconcileAcceptanceAfterRebase,
  log = console.error, readOriginTip = defaultReadOriginTip } = {}) {
  return async ({ planned, repo, root }) => {
    const slug = CONSTELLATION_REPOS[repo]?.slug;
    if (!slug) return null;
    const setting = resolveStaleBaseSetting({ env });
    if (setting.value === 'off') return null;
    root = repoRoot(slug, root);
    const { facts, decision } = await readFacts({ repo: slug, pr: planned.pr, root, setting });
    if (!decision.owed) { log(`stale-base-refresh: PR #${planned.pr} not owed — ${decision.why}`); return null; }
    const claim = await checkClaim({ repo: slug, branch: facts.headRefName });
    if (claim) return { held: true, reason: `stale-base refresh deferred: ${claim.message ?? claim.reason ?? 'live claim'}` };
    let result;
    try { result = await refresh(facts.headRefName, { base: 'origin/main', root, prNumber: planned.pr, repo: slug }); }
    catch (e) { result = { action: 'error', error: String(e?.message ?? e) }; }
    let onto = null;
    try { const tip = await readOriginTip({ root, repo: slug }); if (isSha(tip)) onto = tip; } catch { /* marker names unknown tip as none */ }
    try {
      await postComment(planned.pr, { repo: slug, body: buildStaleBaseComment({ head: facts.headRefOid,
        mergeBase: facts.mergeBase, onto, via: decision.via, failingTestFiles: decision.failingTestFiles,
        outcome: result?.action ?? 'error' }) });
    } catch (e) {
      log(`stale-base-refresh: PR #${planned.pr} budget comment failed: ${String(e?.message ?? e)}`);
    }
    if (result?.action === 'rebased' && result.newCommit) {
      // The branch has already moved. Ancillary failures must never let the
      // dispatch wrapper fail open and launch a fixer before the new CI runs.
      try { await reconcileAcceptance({ prNumber: planned.pr, newHead: result.newCommit, repo: slug, root }); }
      catch (e) { log(`stale-base-refresh: PR #${planned.pr} acceptance reconciliation failed: ${String(e?.message ?? e)}`); }
      log(`stale-base-refresh: PR #${planned.pr} refreshed onto main instead of a ci-heal (via ${decision.via}; failing tests ${decision.failingTestFiles.join(', ')} pass on main); ciHeal.staleBaseRefreshFirst=on (source ${setting.source})`);
      return { held: true, reason: 'stale-base refresh first: refreshed onto main, CI re-runs before any fixer' };
    }
    log(`stale-base-refresh: PR #${planned.pr} ${result?.action ?? 'error'} — ${result?.error ?? 'budget spent; ci-heal proceeds'}`);
    return null;
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  const pr = Number(arg('pr'));
  if (!Number.isInteger(pr) || pr <= 0) { console.error('Usage: stale-base-refresh.mjs --pr=<n> [--repo=owner/name] [--head=<recorded head sha>] [--json]'); process.exitCode = 1; }
  else {
    const setting = resolveStaleBaseSetting();
    const { facts, decision } = readStaleBaseFacts({ repo: arg('repo') ?? CONSTELLATION_REPOS.we.slug, pr, setting, head: arg('head') ?? null });
    const summary = { setting, head: facts.headRefOid ?? null, failingChecks: facts.failingChecks?.map(c => ({ name: c.name, conclusion: c.conclusion,
      mainGreen: isMainLatestCheckGreen({ failingCheckName: c.name, mainLatestCheckRuns: facts.mainLatestCheckRuns }) })) ?? null,
    failingTestFiles: decision.failingTestFiles, behindBy: facts.behindBy ?? null, mergeBase: facts.mergeBase ?? null,
    headContainsMainGreenSha: facts.headContainsMainGreenSha ?? null,
    prTouchesFailingFiles: Array.isArray(facts.prFiles) ? facts.prFiles.some(p => decision.failingTestFiles.includes(p)) : null,
    mainChangedFailingFiles: facts.mainChangedFailingFiles ?? null, budgetSpent: facts.budgetSpent ?? null, decision };
    console.log(process.argv.includes('--json') ? JSON.stringify(summary, null, 2) : `ciHeal.staleBaseRefreshFirst=${setting.value} (source ${setting.source})\n${JSON.stringify(summary, null, 2)}`);
  }
}
