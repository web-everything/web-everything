/** Refresh drain-numbered cards when main gains their CI rule, and root scratch-only conflicts.
 * Log verdicts and successful refreshes are durable, head-scoped facts; read failures never become facts.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from './constellation-repos.mjs';
import { readSettings } from './settings-files.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { BRANCH_NUMBERING_CI_CONTRACT, mainAcceptsBranchNumbering, trustedDrainAuthors, trustedDrainSubject } from './queue-branch-numbering.mjs';
import { parseMergeTree } from './rebase-drop-manifest.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
// The watcher imports reconcile-pass, which imports this module. Load it only when refreshing.
async function refreshOntoMain(...args) {
  const watcher = await import('../conveyor/ci-red-recovery-watch.mjs');
  return watcher.refreshOntoMain(...args);
}

const SETTING = 'scripts/settings/merge-queue-refresh.json';
const KEYS = {
  refreshWhenMainAcceptsDrainNumbers: 'WE_MQ_REFRESH_WHEN_MAIN_ACCEPTS_DRAIN_NUMBERS',
  refreshEvidenceOnlyConflicts: 'WE_MQ_REFRESH_EVIDENCE_ONLY_CONFLICTS',
};
const enabled = setting => (setting?.value ?? setting) === true;
const emit = (log, message) => typeof log === 'function' ? log(message) : log.write(`${message}\n`);
const stateFile = () => join(resolveCoordinationRoot(), 'renamed-pr-refresh.json');
const headKey = pr => `${pr.number}@${pr.headRefOid}`;
const eligible = pr => !pr.isCrossRepository && /^lane\/.+/.test(pr.headRefName ?? '') && !!pr.headRefOid;
// Latest run per name only: a superseded red `test` row must never prove a hold over a newer run's failure.
const redTest = pr => collapseRollupToLatestPerName(pr.statusCheckRollup ?? []).find(c => c.name === 'test' && String(c.conclusion).toLowerCase() === 'failure');

export function resolveRefreshSettings({ env = process.env, read = readSettings } = {}) {
  const result = { invalid: [] };
  let file = {};
  try { file = read(); } catch (e) { result.invalid.push(`${SETTING} unreadable: ${e.message}`); }
  for (const [key, variable] of Object.entries(KEYS)) {
    result[key] = { value: true, source: 'default' };
    for (const [raw, source] of [[file?.mergeQueue?.[key], SETTING], [env[variable], variable]]) {
      if (raw === undefined) continue;
      const text = String(raw).toLowerCase();
      if (!/^(on|off|true|false|1|0)$/.test(text)) result.invalid.push(`${source}: ${key}=${String(raw)} ignored (expected on/off/true/false/1/0)`);
      else result[key] = { value: /^(on|true|1)$/.test(text), source };
    }
  }
  return result;
}

export function logRefreshSettings(s = resolveRefreshSettings(), log = process.stderr) {
  emit(log, `merge-queue: ${Object.keys(KEYS).map(key => `${key}=${s[key].value ? 'on' : 'off'} (${s[key].source})`).join(', ')}`);
  for (const invalid of s.invalid) emit(log, `  ⚠ ${invalid}`);
}

export function parseHandPickedOnlyFailure(logText) {
  const lines = String(logText ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
    .map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s*/, ''));
  const errors = lines.filter(line => /^\s*error\s/.test(line));
  const nums = [];
  const fail = reason => ({ only: false, nums: [...new Set(nums)], reason });
  if (!errors.length) return fail('no standards error lines');
  for (const line of errors) {
    const match = line.match(/^\s*error\s+Backlog item "[^"\r\n]+" carries a hand-picked NNN id \(#(\d+)\) that is not on origin\/main(?:\s|$)/);
    if (!match) return fail('non-hand-picked standards error');
    nums.push(Number(match[1]));
  }
  const summaries = lines.map(line => line.match(/^\s*(\d+) error\(s\)(?:,|\s|$)/)).filter(Boolean);
  if (summaries.length !== 1 || Number(summaries[0][1]) !== errors.length) return fail('standards error summary count mismatch or missing');
  if (lines.some(line => /^\s*##\[error\]/.test(line) && !/^\s*##\[error\]Process completed with exit code 1\.\s*$/.test(line))) return fail('other workflow error');
  return { only: true, nums: [...new Set(nums)], reason: 'only the hand-picked-NNN rule failed' };
}

export function drainAssignedNumbers(commits, authors = new Set()) {
  const nums = new Set();
  for (const commit of Array.isArray(commits) ? commits : []) {
    const subject = trustedDrainSubject(commit, authors);
    if (!subject) continue;
    const match = subject.match(/^drain: JIT-number (.*) at land \(#2288\)$/);
    if (match) for (const assignment of match[1].matchAll(/x[0-9a-z]{6}→#(\d+)/g)) nums.add(Number(assignment[1]));
  }
  return nums;
}

export function classifyOwedMainRule({ logText, commits, authors }) {
  const { only, nums, reason } = parseHandPickedOnlyFailure(logText);
  if (!only) return { owed: false, nums, reason };
  const assigned = drainAssignedNumbers(commits, authors);
  return nums.every(n => assigned.has(n))
    ? { owed: true, nums, reason: 'hand-picked rule rejects only drain-assigned numbers' }
    : { owed: false, nums, reason: 'hand-picked number was not assigned by the drain' };
}

// Mirrors PR #5075's isFixEvidencePath until scripts/lib/transient-paths.mjs is available here.
const isFixEvidencePath = path => /^\.fix-(?:[^/]*-)?evidence[^/]*\.md$/.test(path);
export function isEvidenceOnlyConflict(parsedMergeTree) {
  return parsedMergeTree?.clean === false && (parsedMergeTree.conflictPaths?.length ?? 0) > 0 && parsedMergeTree.conflictPaths.every(isFixEvidencePath);
}

function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid state');
    return state;
  } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function record(path, section, key, value) {
  const state = readState(path);
  const entries = { ...state[section] };
  delete entries[key]; entries[key] = value;
  // Verdict reads are bounded like the queue hook. Refresh receipts stay durable for every head.
  if (section === 'verdicts') for (const old of Object.keys(entries).slice(0, -500)) delete entries[old];
  state[section] = entries;
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, state);
}

export function readOwedMainRule(pr, { slug, exec = execFileSyncThrottled, cache = stateFile(), readOnly = false, authors = trustedDrainAuthors() } = {}) {
  try {
    const check = redTest(pr);
    if (!check) return { owed: false, nums: [], reason: 'required test is not red' };
    if (!slug || !pr.headRefOid) throw new Error('missing repo or head');
    const job = check.detailsUrl?.match(/\/job\/(\d+)(?:[/?#]|$)/)?.[1];
    if (!job) throw new Error('required test has no job id');
    const key = `${slug}#${pr.number}@${pr.headRefOid}/job/${job}/authors/${JSON.stringify([...authors].sort())}`;
    const cached = readState(cache).verdicts?.[key];
    if (cached) return cached;
    const options = { encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 };
    const logText = String(exec('gh', ['api', `repos/${slug}/actions/jobs/${job}/logs`], options));
    const parsed = parseHandPickedOnlyFailure(logText);
    // Project each commit to its subject in jq: a commit BODY must never masquerade as a drain commit.
    const commits = parsed.only ? String(exec('gh', ['api', `repos/${slug}/pulls/${pr.number}/commits`, '--paginate', '--jq', '.[] | {subject: (.commit.message | split("\\n")[0]), author: .commit.author} | @json'], options)).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
    const verdict = classifyOwedMainRule({ logText, commits, authors });
    if (!readOnly) record(cache, 'verdicts', key, verdict);
    return verdict;
  } catch (e) { return { owed: false, nums: [], reason: `unreadable: ${e.message}` }; }
}

/** Mutates the supplied PR facts, like the reconcile enrichers; no IO for sibling repos or green checks. */
export function enrichPrsWithOwedMainRule(prs, { repo, read = readOwedMainRule, settings = resolveRefreshSettings(), mainAccepts = mainAcceptsBranchNumbering } = {}) {
  if (repoKeyForSlug(repo) !== 'we') return prs;
  // Refresh owns repair only while waiting for the old main rule. Once main accepts,
  // ci-heal/rebase must remain available even if refreshing returns current or fails.
  // Read lazily, once, and only for a PR that actually needs it: a pass with no red lane PR must not shell out to git.
  let accepts;
  const waitingForMain = () => !(accepts ??= { value: typeof mainAccepts === 'function' ? mainAccepts() : mainAccepts }).value;
  for (const pr of prs) {
    delete pr.owedMainRule;
    if (!redTest(pr) || !eligible(pr) || !enabled(settings.refreshWhenMainAcceptsDrainNumbers)) continue;
    try { pr.owedMainRule = { ...read(pr, { slug: CONSTELLATION_REPOS.we.slug }), head: pr.headRefOid, ownsRepair: pr.mergeStateStatus !== 'DIRTY' && waitingForMain() }; }
    catch (e) { pr.owedMainRule = { head: pr.headRefOid, owed: false, nums: [], reason: `unreadable: ${e.message}` }; }
  }
  return prs;
}

export function planRenamedPrRefresh({ prs, mainAccepts, settings, state = {}, evidenceVerdicts = {} }) {
  const refresh = [], waiting = [], skipped = [];
  for (const pr of prs) {
    const num = pr.number, head = pr.headRefOid, key = headKey(pr);
    if (!eligible(pr)) { skipped.push({ num, reason: 'not a same-repo lane head' }); continue; }
    if (state.refreshed?.[key]) { skipped.push({ num, reason: 'already refreshed this head' }); continue; }
    const owed = pr.owedMainRule?.owed && pr.owedMainRule.head === head && enabled(settings.refreshWhenMainAcceptsDrainNumbers);
    const evidence = evidenceVerdicts[key] === true && enabled(settings.refreshEvidenceOnlyConflicts);
    if (owed && mainAccepts) refresh.push({ num, headRefName: pr.headRefName, head, trigger: 'main-rule' });
    else if (evidence) refresh.push({ num, headRefName: pr.headRefName, head, trigger: 'evidence-only' });
    else if (owed) waiting.push({ num, nums: pr.owedMainRule.nums });
    else skipped.push({ num, reason: 'no enabled refresh trigger' });
  }
  return { refresh, waiting, skipped };
}

/** run follows the house subprocess contract: (command, argv, options) → {status, stdout, stderr}. */
export async function runRenamedPrRefresh({ prs, slug, root = process.cwd(), settings = resolveRefreshSettings(),
  exec = execFileSyncThrottled, run = spawnSync, refresh = refreshOntoMain, mainAccepts = mainAcceptsBranchNumbering,
  statePath, log = process.stderr, dryRun = false, authors = trustedDrainAuthors({ cwd: root }) } = {}) {
  const result = { refreshed: [], waiting: [], owedMainRule: [], evidenceOnly: [], errors: [] };
  // Diagnostics must never make this best-effort pass throw (including a broken output pipe).
  const say = message => { try { emit(log, message); } catch { /* caller owns logging */ } };
  const fail = (num, error) => { const reason = String(error?.message ?? error); result.errors.push({ num, reason }); say(`renamed-pr-refresh: ${num ? `#${num} ` : ''}${reason}`); };
  try {
    statePath ??= stateFile();
    const enriched = prs.map(pr => redTest(pr) && eligible(pr) && enabled(settings.refreshWhenMainAcceptsDrainNumbers) ? { ...pr, owedMainRule: { ...readOwedMainRule(pr, { slug, exec, cache: statePath, authors }), head: pr.headRefOid } } : { ...pr, owedMainRule: undefined });
    for (const pr of enriched) if (pr.owedMainRule?.reason?.startsWith('unreadable:')) fail(pr.number, pr.owedMainRule.reason);
    const state = readState(statePath), evidenceVerdicts = {};
    const lanes = enriched.filter(eligible);
    const git = args => {
      const out = run('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      if (out.error) throw out.error;
      return out;
    };
    const successful = args => {
      const out = git(args);
      if (out.status !== 0) throw new Error(`git ${args[0]} failed: ${out.stderr || out.status}`);
      return String(out.stdout ?? '').trim();
    };
    let accepts = false;
    if (lanes.length) {
      // A failed fetch cannot establish either the current main contract or a current conflict verdict.
      successful(['fetch', 'origin', 'main']);
      accepts = typeof mainAccepts === 'function' ? mainAccepts({ cwd: root }) : mainAccepts;
      if (enabled(settings.refreshEvidenceOnlyConflicts)) {
        const missing = lanes.filter(pr => { try { return successful(['rev-parse', `origin/${pr.headRefName}`]) !== pr.headRefOid; } catch { return true; } });
        if (missing.length) successful(['fetch', 'origin', ...new Set(missing.map(pr => `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`))]);
        for (const pr of lanes) {
          try {
            if (successful(['rev-parse', `origin/${pr.headRefName}`]) !== pr.headRefOid) throw new Error('remote head moved; conflict verdict deferred');
            const out = git(['merge-tree', '--write-tree', 'origin/main', `origin/${pr.headRefName}`]);
            if (out.status !== 0 && out.status !== 1) throw new Error(`merge-tree failed: ${out.stderr || out.status}`);
            evidenceVerdicts[headKey(pr)] = isEvidenceOnlyConflict(parseMergeTree(out.stdout, out.status));
          } catch (e) { fail(pr.number, e); }
        }
      }
    }
    const planned = planRenamedPrRefresh({ prs: enriched, mainAccepts: accepts, settings, state, evidenceVerdicts });
    result.waiting = planned.waiting;
    result.owedMainRule = enriched.filter(pr => eligible(pr) && pr.owedMainRule?.owed && pr.owedMainRule.head === pr.headRefOid).map(pr => pr.number);
    result.evidenceOnly = lanes.filter(pr => evidenceVerdicts[headKey(pr)]).map(pr => pr.number);
    for (const entry of planned.refresh) {
      try {
        if (dryRun) { say(`renamed-pr-refresh: #${entry.num} would refresh (${entry.trigger})`); continue; }
        const out = await refresh(entry.headRefName, { root, base: 'origin/main', prNumber: entry.num, repo: slug });
        if (!out?.ok) throw new Error(out?.error || out?.reason || 'refresh refused');
        if (out.action === 'rebased') {
          record(statePath, 'refreshed', `${entry.num}@${entry.head}`, { trigger: entry.trigger, at: new Date().toISOString() });
          result.refreshed.push(entry);
        }
        say(`renamed-pr-refresh: #${entry.num} refresh result (${entry.trigger}, ${out.action})`);
      } catch (e) { fail(entry.num, e); }
    }
    const evidenceRefreshed = result.refreshed.filter(entry => result.evidenceOnly.includes(entry.num));
    say(`renamed-pr-refresh: ${result.owedMainRule.length} owed-main-rule (${accepts ? 'main accepts drain numbers — refreshing' : `waiting for main to accept drain numbers: ${BRANCH_NUMBERING_CI_CONTRACT} absent`}) [${result.owedMainRule.map(n => `#${n}`).join(', ')}], ${evidenceRefreshed.length} evidence-only conflict(s) refreshed [${evidenceRefreshed.map(entry => `#${entry.num}`).join(', ')}]`);
  } catch (e) { fail(null, e); }
  return result;
}
