/**
 * @file scripts/lib/merge-queue-enqueue.mjs
 * @description Strategy `github-merge-queue` (`./merge-delivery-policy.mjs`): instead of `gh pr merge`, the drain
 *   ENQUEUES a ready PR on GitHub's native merge queue (GraphQL `enqueuePullRequest`), and GitHub re-tests and
 *   merges it. The drain's merge-time gates run in the required `merge-gate` check (`./merge-gate-ci.mjs`), so
 *   moving the merge off the drain never drops a gate. `drain-direct` (the default) is untouched: for it
 *   `mergeActionFor` says `merge` and nothing here runs.
 *
 *   Pure helpers + one IO function with an injectable `exec`. Post-merge follow-up (numbering, regen,
 *   resolve-on-land) still belongs to the drain: `planQueueFollowUps` names the PRs GitHub merged since the
 *   drain last followed up, so the drain's existing post-land path runs for them.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';
import { latestFailingMergeGate, readMergeGateVerdict } from './merge-gate-hold-class.mjs';
import { readSharedFreeze } from './red-main-freeze-shared.mjs';
import { clearanceBindsHead } from './review-escalation.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

export const REQUIRED_WORKFLOWS_UNSATISFIED = 'required-workflows-unsatisfied';

/** Pure: required-workflows refusal (ruleset 24930207), never a status-check-only refusal. */
export function isRequiredWorkflowsUnsatisfiedError(text) {
  return /Required workflows? '.*?' (?:is|are) not satisfied/.test(String(text || ''));
}

/** Standard behaviour: refresh a green PR refused by the queue so fresh required workflows can count. */
export const REFRESH_ON_UNSATISFIED_WORKFLOWS_DEFAULT = 'on';

/**
 * mergeQueue.refreshOnUnsatisfiedWorkflows: first valid env > settings > platform > standard value.
 * Inject settings/platform objects to avoid filesystem reads. Settings discovery and test isolation match
 * loadMergeQueueSettings; this key resolves independently of the other queue settings.
 * @returns {{value: 'on'|'off', source: string, invalid: string[]}}
 */
export const resolveRefreshOnUnsatisfiedWorkflows = options => resolveRefreshSetting('refreshOnUnsatisfiedWorkflows', 'WE_MERGE_QUEUE_REFRESH_ON_UNSATISFIED_WORKFLOWS', options);
export const resolveRefreshOnStaleMergeGate = options => resolveRefreshSetting('refreshOnStaleMergeGate', 'WE_MERGE_QUEUE_REFRESH_ON_STALE_MERGE_GATE', options);

function resolveRefreshSetting(key, envKey, { env = process.env, settings, platform } = {}) {
  const invalid = [];
  const readJson = (path, source) => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) {
      if (e?.code !== 'ENOENT') invalid.push(`${source}: ${String(e?.message ?? e).split('\n')[0]}`);
      return {};
    }
  };
  const layers = [
    ['env', () => env?.[envKey]],
    ['settings', () => {
      let src = settings;
      const override = String(env?.WE_MERGE_QUEUE_SETTINGS_FILE ?? '').trim();
      if (src === undefined && override) src = readJson(override, 'settings');
      if (src === undefined && (env?.VITEST || env?.WE_UNDER_TEST)) src = {};
      if (src === undefined) {
        const read = readDeclaredSettings();
        src = read.settings;
        invalid.push(...read.errors.map((e) => `settings: ${e.source}: ${e.error}`));
      }
      return src?.mergeQueue?.[key];
    }],
    ['platform', () => (platform === undefined ? readJson(PLATFORM_PREFERENCES_PATH, 'platform') : platform)?.mergeQueue?.[key]],
  ];
  for (const [source, read] of layers) {
    const value = read();
    if (value === 'on' || value === 'off') return { value, source, invalid };
    if (value !== undefined) invalid.push(`${source}: mergeQueue.${key}=${JSON.stringify(value)} (expected on|off)`);
  }
  return { value: REFRESH_ON_UNSATISFIED_WORKFLOWS_DEFAULT, source: 'standard', invalid };
}

/** Pure once-per-head decision; a refusal of the produced head needs human inspection, not another refresh. */
export function decideRequiredWorkflowsRefresh({ key, headSha, state = {}, setting }) {
  if ((setting?.value ?? setting) === 'off') return { action: 'off', reason: 'required-workflows refresh is off' };
  const short = String(headSha || '').slice(0, 9), previous = state[key];
  if (headSha && previous?.newHead === headSha) return { action: 'skip', reason: `ruleset still refuses head ${short} after a refresh from ${String(previous.fromHead).slice(0, 9)} — a person should look` };
  if (headSha && previous?.fromHead === headSha) return { action: 'skip', reason: `head ${short} was already refreshed once to ${String(previous.newHead || '').slice(0, 9)} for required workflows — waiting for the fresh head` };
  return { action: 'refresh', reason: `head ${short} has never been refreshed for required workflows` };
}

export function requiredWorkflowsRefreshStatePath(env = process.env) { return join(resolveCoordinationRoot({ env }), 'drain-required-workflows-refresh.json'); }

/** Missing, malformed or unreadable state is empty; callers can inject filesystem reads. */
export function readRequiredWorkflowsRefreshState(path, readFile = readFileSync) {
  try { const s = JSON.parse(readFile(path, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; }
}

/** Atomic writer, matching the drain's other coordination state writers. */
function writeRequiredWorkflowsRefreshState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Re-read before recording; retain the newest 500 PRs. Injected writeFile accepts (path, state). */
export function recordRequiredWorkflowsRefresh(path, key, { fromHead, newHead, action, at }, { readFile = readFileSync, writeFile = writeRequiredWorkflowsRefreshState } = {}) {
  const state = { ...readRequiredWorkflowsRefreshState(path, readFile), [key]: { fromHead, newHead, action, at } };
  const entries = Object.entries(state).sort((a, b) => String(a[1]?.at || '').localeCompare(String(b[1]?.at || ''))).slice(-500);
  writeFile(path, Object.fromEntries(entries));
}

/**
 * Handle required-workflows refusal (ruleset 24930207) through the existing freshness path. IO is injected:
 * refreshStalePr, needsAcceptanceRestamp and restampAcceptance are the drain's existing implementations.
 * Returns a skip reason for JSON and a stderr line; off falls through to the original enqueue failure path.
 * runId is deliberately null: re-running a pre-ruleset run cannot satisfy required workflows.
 */
export function handleRequiredWorkflowsRefusal(options) { return handleQueueRefresh(options); }

async function handleQueueRefresh({ c, key, headSha, setting, statePath = requiredWorkflowsRefreshStatePath(), cloneDir, cwd, tag = '#',
  readState = readRequiredWorkflowsRefreshState, record = recordRequiredWorkflowsRefresh,
  decide = decideRequiredWorkflowsRefresh, runId = null, label = 'required-workflows', wording = 'required workflows unsatisfied', dryRun = false,
  refreshStalePr, needsAcceptanceRestamp, restampAcceptance, warn = () => {}, now = () => new Date().toISOString() }) {
  if (dryRun) return { handled: false };
  const decision = decide({ key, headSha, setting, state: readState(statePath) });
  if (decision.action === 'off') return { handled: false };
  if (decision.action === 'skip') return { handled: true, reason: `merge-queue: ${decision.reason}`, line: `  ⏸ ${label}: PR ${tag}${c.num} — ${decision.reason}` };
  let out;
  try {
    out = !cloneDir ? { ok: false, error: `no ${c.repo} clone provisioned` }
      : await refreshStalePr({ laneRef: c.headRef, root: cloneDir, repo: c.repo, runId, expectedHead: headSha });
  } catch (e) { out = { ok: false, error: errText(e) }; }
  if (!out.ok) {
    const reason = `merge-queue: ${wording} → refresh FAILED: ${out.error}`;
    return { handled: true, reason, line: `  ↻ ${label}: refresh PR ${tag}${c.num} (${decision.reason}) → refresh FAILED: ${out.error}` };
  }
  let note = '';
  // Record before restamping: a successful refresh must not loop even if acceptance IO fails.
  try { record(statePath, key, { fromHead: headSha, newHead: out.newCommit, action: out.action, at: now() }); }
  catch (e) { note = `; refresh state record failed: ${errText(e)}`; }
  if (out.action === 'rebased' && needsAcceptanceRestamp(c, { action: 'rebased' })) {
    let rs;
    try { rs = await restampAcceptance({ pr: c.num, repo: c.repo, newHead: out.newCommit, cwd }); }
    catch (e) { rs = { ok: false, reason: errText(e) }; }
    if (!rs.ok) {
      note += `; acceptance re-stamp failed: ${String(rs.reason).slice(0, 200)}`;
      warn(`  ⚠ ${tag}${c.num} acceptance re-stamp failed (${rs.reason}) — it may re-park`);
    }
  }
  const sha = String(out.newCommit || '').slice(0, 9);
  return { handled: true, reason: `merge-queue: ${wording} → refresh ${out.action} ${sha}${note}`,
    line: `  ↻ ${label}: refresh PR ${tag}${c.num} (${decision.reason}) → ${out.action} ${sha} — enqueue retried once the new runs are green${note}` };
}


export const ENQUEUE_MUTATION = 'mutation($id:ID!,$sha:GitObjectID){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){mergeQueueEntry{id position state}}}';

/** What the drain does with a PR that passed every drain gate this pass. Pure. */
export function mergeActionFor(policy) {
  return policy?.strategy === 'github-merge-queue' ? 'enqueue' : 'merge';
}

/** `gh api graphql` argv for the enqueue. `expectedHeadOid` pins the queue entry to the head the drain judged. */
export function buildEnqueueArgs({ nodeId, headSha }) {
  if (!nodeId) throw new Error('enqueue: PR node id required');
  if (!headSha) throw new Error('enqueue: expected head SHA required (never enqueue an unpinned head)');
  return ['api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`, '-f', `id=${nodeId}`, '-f', `sha=${headSha}`];
}

/**
 * Transport for the explicitly instructed operator operation. Keep mutation dispatch in this module;
 * the caller owns its operator gates, credential environment, response handling and queue verification.
 * This does not call the drain's `enqueuePr` or alter its workflow-edit refusal.
 */
export function requestOperatorQueueEntry({ nodeId, headSha, bin, env, exec = execFileSync }) {
  return JSON.parse(String(exec(bin, buildEnqueueArgs({ nodeId, headSha }), {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  }) || '{}'));
}

/** Read queue membership and its head together; missing or malformed membership is never `false`. */
export function readMergeQueueState({ repo, pr, readJson }) {
  const [o, n] = String(repo).split('/');
  const query = 'query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){isInMergeQueue headRefOid}}}';
  try {
    const d = readJson(['api', 'graphql', '-f', `query=${query}`, '-f', `o=${o}`, '-f', `n=${n}`, '-F', `pr=${pr}`]);
    const p = d?.data?.repository?.pullRequest;
    if (d?.errors?.length || typeof p?.isInMergeQueue !== 'boolean') return { error: 'merge queue state unreadable' };
    return { inQueue: p.isInMergeQueue, head: p.headRefOid ?? null };
  } catch (e) {
    return { error: String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300) };
  }
}

/** Is a gh error the "already in the merge queue" case (idempotent success)? Pure. */
export function isAlreadyQueuedError(text) {
  return /already (?:in|queued in) the (?:merge )?queue|is already queued/i.test(String(text || '')); // GitHub also says "already in the queue" (card 257)
}

/**
 * Paths a queued PR may never touch. The required `merge-gate` check is a workflow, and GitHub reads a workflow's
 * YAML from the PR merge ref (`pull_request`) or the group commit (`merge_group`), so a PR can edit one to
 * `exit 0` (or add a new workflow with a job named like a required check) and turn the check green from inside its
 * own diff. No check a PR can edit can defend against that, so the defence sits where the PR cannot reach: the
 * drain, running from the daemon's own `main` checkout, refuses to enqueue such a PR at all. A human merges it.
 */
export const GATE_PATH_PREFIXES = ['.github/workflows/', '.github/actions/'];

/** A repo path reduced to the form the prefix test uses (separators, case, `./`, NFKC). Pure. */
export function normalizeGatePath(p) {
  return String(p ?? '').normalize('NFKC').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/').replace(/^(?:\.?\/)+/, '');
}

/**
 * Does this PR's change list let it be enqueued? Pure. A PR is held for a HUMAN (`humanOnly: true`, not an
 * escalation an AI reviewer can accept) when any changed path, or any renamed-from path, is a workflow or action
 * file; and it is held fail-closed but RETRYABLE (`humanOnly: false`) when the list cannot be trusted to be
 * complete (a read error or a count mismatch is transient, not a decision).
 * @param {{files:Array<string|{filename:string, previous_filename?:string}>, expectedCount:number}} o
 * @returns {{hold:false}|{hold:true, humanOnly:boolean, retryable?:boolean, reason:'workflow-edit'|'unreadable', paths:string[], error:string}}
 */
export function workflowEditHold({ files, expectedCount } = {}) {
  const unreadable = (why) => ({ hold: true, humanOnly: false, retryable: true, reason: 'unreadable', paths: [], error: `changed files unreadable (${why}) — a PR is only enqueued when its whole change list is known not to touch workflow files` });
  if (!Array.isArray(files)) return unreadable('no list');
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return unreadable('no file count');
  if (files.length !== expectedCount) return unreadable(`listed ${files.length} of ${expectedCount}`);
  const hit = [];
  for (const f of files) {
    for (const raw of typeof f === 'string' ? [f] : [f?.filename, f?.previous_filename]) {
      if (raw === undefined || raw === null || raw === '') continue;
      const p = normalizeGatePath(raw);
      if (p.split('/').includes('..') || GATE_PATH_PREFIXES.some((pre) => p.startsWith(pre))) hit.push(String(raw));
    }
    if (typeof f !== 'string' && !f?.filename) return unreadable('entry without a filename');
  }
  return hit.length
    ? { hold: true, humanOnly: true, reason: 'workflow-edit', paths: [...new Set(hit)], error: `held for a human: the diff touches ${[...new Set(hit)].join(', ')} — workflow files decide the required checks, so only a person may land a change to them` }
    : { hold: false };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * The change list OF THE EXACT COMMIT being enqueued (`headSha`), read from git — never a listing of whatever the
 * PR's branch points at now (PR #4708 round 6: the REST `pulls/{n}/files` list is not pinned to a sha, so a head
 * that moved between the read and the enqueue could be judged on another commit's files). The diff is
 * `origin/<base>...<headSha>` (merge-base to head, what the queue lands) with `--no-renames`, so a rename shows
 * BOTH its old and new path. Every path is listed (no 3000-file REST cap). `{files}` or `{error}`. Never throws.
 * `withBaseSha`: also return `baseSha`, the base commit the diff was read against (null when unknown).
 */
export function readPinnedChangedFiles({ headSha, base = 'main', cwd, exec = execFileSync, withBaseSha = false } = {}) {
  if (!SHA_RE.test(String(headSha))) return { error: 'head sha is not a 40-hex commit id' };
  if (!SAFE_BRANCH_RE.test(String(base)) || String(base).startsWith('-')) return { error: 'base branch name unusable' };
  if (!cwd) return { error: 'no checkout to read the pinned diff from' };
  const git = (args) => String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) ?? '');
  try {
    git(['fetch', '--quiet', '--end-of-options', 'origin', headSha, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    git(['cat-file', '-e', `${headSha}^{commit}`]);
    // Pin the base tip BEFORE the diff and diff against that sha: another drain sharing this checkout can move the
    // remote-tracking ref at any moment, and `baseSha` must be the commit this list was actually read against.
    // Unknown → diff the ref and report no `baseSha` (the list is then never reused).
    let baseSha = null;
    try { baseSha = git(['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${base}^{commit}`]).trim(); } catch { /* unknown */ }
    if (!SHA_RE.test(baseSha)) baseSha = null;
    const out = git(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', `${baseSha ?? `refs/remotes/origin/${base}`}...${headSha}`]);
    const files = out.split('\0').filter(Boolean);
    return withBaseSha ? { files, baseSha } : { files };
  } catch (e) { return { error: errText(e) }; }
}

/** The base branch's current tip on `origin`, read live (no fetch). A 40-hex sha, or null. Never throws. */
function readBaseTip({ base, cwd, exec }) {
  if (!cwd || !SAFE_BRANCH_RE.test(String(base)) || String(base).startsWith('-')) return null;
  try {
    const out = String(exec('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${base}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }) ?? '');
    const rows = out.split('\n').filter(Boolean).map(l => l.split('\t'));
    return rows.length === 1 && rows[0][1] === `refs/heads/${base}` && SHA_RE.test(rows[0][0]) ? rows[0][0] : null;
  } catch { return null; }
}

/**
 * Enqueue one PR. Never throws. `{ok:true, entry}` / `{ok:true, already:true}` / `{ok:false, error}`; a PR whose
 * diff touches a workflow file (or whose change list cannot be fully read) comes back `{ok:false, held:true,
 * humanOnly, error}` and is never enqueued.
 * PINNED TO ONE COMMIT: the PR's live head must equal `headSha` (else it moved since the drain judged it — held,
 * retryable), the workflow-edit refusal reads the change list OF `headSha` (`readPinnedChangedFiles`), and the
 * mutation carries `expectedHeadOid: headSha`, so GitHub refuses the entry if the head moves after the read. The
 * refusal and the queue entry therefore always describe the same commit.
 * @param {{repo:string, num:number, headSha:string, cwd:string, exec?:Function}} o  `cwd`: a clone of `repo`.
 */
export function enqueuePr({ repo, num, headSha, cwd, exec = execFileSync, preparedSurface = null }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo)) || !Number.isInteger(Number(num))) {
    return { ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable', paths: [], error: 'changed files unreadable (repo or PR number is malformed)' };
  }
  let pr;
  try {
    pr = JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'id,headRefOid,baseRefName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}');
  } catch (e) { return { ok: false, error: `node id read failed: ${errText(e)}` }; }
  const nodeId = pr?.id;
  if (!nodeId) return { ok: false, error: 'node id missing' };
  if (pr?.headRefOid !== headSha) {
    return { ok: false, held: true, humanOnly: false, retryable: true, reason: 'head-moved', paths: [], error: `PR head is ${String(pr?.headRefOid).slice(0, 9)}, not the judged ${String(headSha).slice(0, 9)} — re-judge the new head before enqueueing` };
  }
  const liveBase = pr?.baseRefName;
  if (typeof liveBase !== 'string' || liveBase === '') {
    return { ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable', paths: [], error: 'changed files unreadable (the PR base branch is unreadable)' };
  }
  // A prepared list describes `base...head` at one base commit: reuse it only while the head, the base branch AND
  // that branch's tip all still match (a retargeted PR, or a base that moved, can show a workflow edit the prepared
  // list hid). Anything else re-reads git.
  const reusable = preparedSurface?.headSha === headSha && preparedSurface.base === liveBase && SHA_RE.test(String(preparedSurface.baseSha))
    && Array.isArray(preparedSurface.files) && preparedSurface.files.every(p => typeof p === 'string')
    && readBaseTip({ base: liveBase, cwd, exec }) === preparedSurface.baseSha;
  const read = reusable ? { files: preparedSurface.files } : readPinnedChangedFiles({ headSha, base: liveBase, cwd, exec });
  const hold = workflowEditHold({ files: read.files, expectedCount: read.files?.length });
  if (hold.hold) return { ok: false, held: true, humanOnly: hold.humanOnly, retryable: hold.retryable === true, reason: hold.reason, paths: hold.paths, error: read.error ? `${hold.error}: ${read.error}` : hold.error };
  const queueState = () => readMergeQueueState({ repo, pr: num, readJson: args => JSON.parse(exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}') });
  const existing = queueState();
  if (existing.inQueue === true && existing.head === headSha) return { ok: true, already: true };
  try {
    const out = JSON.parse(exec('gh', buildEnqueueArgs({ nodeId, headSha }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}');
    const errs = out?.errors;
    if (Array.isArray(errs) && errs.length) {
      const msg = errs.map((x) => x?.message).join('; ');
      const refusal = errs.find((x) => isRequiredWorkflowsUnsatisfiedError(x?.message));
      if (refusal) return { ok: false, reason: REQUIRED_WORKFLOWS_UNSATISFIED, error: msg, ...(refusal.type != null ? { type: refusal.type } : {}), ...(refusal.code != null ? { code: refusal.code } : {}) };
      return { ok: false, error: msg };
    }
    const entry = out?.data?.enqueuePullRequest?.mergeQueueEntry ?? null;
    if (!entry?.id) return { ok: false, error: 'no merge queue entry returned' };
    const queue = queueState();
    if (queue.inQueue !== true || queue.head !== headSha) return { ok: false, unconfirmed: true, error: `enqueue unconfirmed: ${queue.error || (queue.inQueue === false ? 'isInMergeQueue is false' : 'queue head does not match judged head')}` };
    return { ok: true, entry };
  } catch (e) {
    const t = String(e?.stderr || e?.message || e).trim();
    if (isRequiredWorkflowsUnsatisfiedError(String(e?.stderr || e?.message || e))) return { ok: false, reason: REQUIRED_WORKFLOWS_UNSATISFIED, error: t };
    return { ok: false, error: t };
  }
}

/**
 * PRs the merge queue merged that the drain has not followed up yet. Pure.
 * @param {{merged:Array<{number:number, mergedAt?:string, mergeCommit?:{oid?:string}}>, followedUp:Iterable<number>}} o
 */
export function planQueueFollowUps({ merged = [], followedUp = [] } = {}) {
  const done = new Set([...followedUp].map(Number));
  return merged.filter((p) => Number.isInteger(Number(p?.number)) && !done.has(Number(p.number)))
    .sort((a, b) => String(a.mergedAt || '').localeCompare(String(b.mergedAt || '')))
    .map((p) => ({ num: Number(p.number), mergeSha: p.mergeCommit?.oid ?? null, mergedAt: p.mergedAt ?? null }));
}

/** The GitHub Actions app: a required check is only accepted when this app posted it (a status from anyone else cannot satisfy it). */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

/**
 * Every workflow file that defines a required check. GitHub reads a workflow's YAML from the PR merge ref
 * (`pull_request`) or the group commit (`merge_group`), so a PR could edit one to `exit 0`, or add a new workflow
 * whose job carries a required check's name. The ruleset's `workflows` rule runs each of these from `main`
 * instead; a test fails when a workflow defining a required check is missing here.
 */
export const REQUIRED_WORKFLOW_PATHS = ['.github/workflows/ci.yml', '.github/workflows/merge-gate.yml', '.github/workflows/soak-replay-gate.yml'];

/** The ruleset the operator enables for a policy (GitHub reads the ruleset, never this file). Pure. */
export function rulesetSuggestion(policy, requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate']) {
  return {
    target: 'branch main',
    mergeQueue: {
      mergeMethod: String(policy?.mergeMethod || 'merge').toUpperCase(),
      maxEntriesToBuild: policy?.batchSize ?? 1,
      minEntriesToMerge: 1,
      maxEntriesToMerge: policy?.batchSize ?? 1,
      minEntriesToMergeWaitMinutes: policy?.maxGroupWaitMinutes ?? 5,
      groupingStrategy: 'ALLGREEN',
      checkResponseTimeoutMinutes: 60,
    },
    requiredStatusChecks: requiredChecks,
    requiredStatusCheckIntegrationId: GITHUB_ACTIONS_INTEGRATION_ID,
    requiredWorkflows: REQUIRED_WORKFLOW_PATHS.map((path) => ({ path, ref: 'refs/heads/main' })),
  };
}

function errText(e) {
  return String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
}

// Separate coordination ledger; the atomic bounded storage and refresh/restamp path are shared.
export const staleMergeGateRefreshStatePath = (env = process.env) => join(resolveCoordinationRoot({ env }), 'drain-stale-merge-gate-refresh.json');
export function decideStaleMergeGateRefresh({ key, headSha, state = {}, setting } = {}) {
  if ((setting?.value ?? setting) === 'off') return { action: 'skip', reason: 'stale merge-gate refresh is off' };
  if (!headSha) return { action: 'skip', reason: 'missing head' };
  const previous = state[key];
  if (previous?.fromHead === headSha || previous?.newHead === headSha) return { action: 'skip', reason: 'merge-gate head already refreshed once — waiting for fresh verdict; a person should look if it remains held' };
  return { action: 'refresh', reason: 'merge-gate holds now satisfied' };
}

/** Pure: this authorizes a new run, never excusal or enqueue on the old verdict. */
export function classifyStaleMergeGate({ verdict, headSha, landableApartFromMergeState, humanClearedSha, freeze, clearanceCoverage = null } = {}) {
  const no = reason => ({ stale: false, reason: `merge-gate ${reason}` });
  if (!headSha || verdict?.head_sha !== headSha) return no('verdict head mismatch');
  if (verdict.error || verdict.ok !== false || !Array.isArray(verdict.results) || !verdict.results.length) return no('verdict unreadable or not HOLD');
  if (!landableApartFromMergeState) return no('PR is not otherwise landable');
  const satisfied = new Set();
  for (const row of verdict.results) {
    if (row.status === 'fail-closed') return no(`fail-closed row ${row.id}`);
    if (row.status !== 'hold') {
      if (!['pass', 'queue', 'enqueue', 'skipped-by-policy'].includes(row.status)) return no('verdict row unreadable');
      continue;
    }
    if (row.id === 'test-gaming' || (row.id === 'review-acceptance' && row.reason?.startsWith('human-only:'))) {
      // approval-binding: test-gaming honours a git-proven clearance coverage; the human-only workflow-edit hold keeps
      // its exact-head ceremony (that classification is unchanged).
      const cleared = row.id === 'test-gaming'
        ? clearanceBindsHead({ humanClearedSha, headSha, coverage: clearanceCoverage })
        : humanClearedSha === headSha;
      if (!cleared) return no(`hold ${row.id} not cleared on this head`);
      satisfied.add('human clearance');
    } else if (['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance'].includes(row.id)
      || (row.id === 'ledger' && row.reason?.startsWith('labels:'))) {
      satisfied.add('candidacy');
    } else if (row.id === 'red-main-freeze' && /^main is RED \(freeze: manual freeze: .+\)$/.test(row.reason ?? '')) {
      if (freeze?.error || freeze?.frozen !== false || !Number.isFinite(Date.parse(verdict.completed_at))
        || !(Date.parse(freeze.publishedAt) > Date.parse(verdict.completed_at))) return no('hold red-main-freeze not proven lifted after verdict');
      satisfied.add('red-main-freeze lifted');
    } else return no(`hold ${row.id} remains real`);
  }
  return satisfied.size ? { stale: true, reason: `holds now satisfied: ${[...satisfied].join(', ')}` } : no('no hold rows');
}

/** Post-cascade recovery. All IO is injectable; the original skip remains unless a refresh is handled. */
export async function handleStaleMergeGate({ c, pr, requiredChecks, classifyPr, classifyOptions = {}, setting, dryRun = false,
  readVerdict = readMergeGateVerdict, readFreeze = readSharedFreeze, readAcceptance, acceptance,
  statePath = staleMergeGateRefreshStatePath(), ...refreshOptions } = {}) {
  const unchanged = { handled: false };
  if (dryRun || (setting?.value ?? setting) !== 'on' || c?.decision !== 'skip' || c.state !== 'BLOCKED'
    || !c.reason?.startsWith('merge state BLOCKED') || !pr?.headRefOid) return unchanged;
  if (['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(String(pr.reviewDecision || '').toUpperCase())) return unchanged;
  // The real classifier must also pass its gates AFTER the merge-state arm (body and review holds).
  if (classifyPr({ ...pr, mergeStateStatus: 'CLEAN' }, classifyOptions).decision !== 'merge') return unchanged;
  const headSha = pr.headRefOid;
  const gate = reviewCiGate({ headSha, requiredChecks, checks: pr.statusCheckRollup });
  if (gate.affected.length !== 1 || gate.affected[0].name !== 'merge-gate' || gate.affected[0].reason !== 'failure') return unchanged;
  const run = latestFailingMergeGate(pr.statusCheckRollup);
  if (!run || String(run.conclusion).toLowerCase() !== 'failure') return unchanged;
  const ids = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(run.detailsUrl ?? run.details_url ?? '');
  const runId = Number(ids?.[1]), jobId = Number(ids?.[2]);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(jobId) || jobId <= 0) return { ...unchanged, reason: 'merge-gate run/job URL unreadable' };
  let classification;
  try {
    const verdict = await readVerdict({ repo: c.repo, jobId, prNumber: c.num });
    if (verdict?.num !== c.num) return { ...unchanged, reason: 'merge-gate PR verdict unreadable' };
    let evidence = acceptance;
    if (verdict.results?.some(r => r.status === 'hold' && (r.id === 'test-gaming' || (r.id === 'review-acceptance' && r.reason?.startsWith('human-only:'))))) {
      evidence ??= await readAcceptance({ pr: c.num, repo: c.repo, cwd: refreshOptions.cwd });
      if (evidence?.headSha !== headSha) return { ...unchanged, reason: 'merge-gate acceptance head mismatch' };
    }
    const freeze = verdict.results?.some(r => r.status === 'hold' && r.id === 'red-main-freeze')
      ? await readFreeze({ board: refreshOptions.cloneDir }) : undefined;
    classification = classifyStaleMergeGate({ verdict, headSha, landableApartFromMergeState: true, humanClearedSha: evidence?.humanClearedSha, freeze, clearanceCoverage: evidence?.clearanceCoverage ?? null });
  } catch (e) { return { ...unchanged, reason: `merge-gate evidence unreadable: ${errText(e)}` }; }
  if (!classification.stale) return { ...unchanged, reason: classification.reason };
  return handleQueueRefresh({ ...refreshOptions, c, key: `${c.repo}#${c.num}`, headSha, setting, statePath,
    decide: decideStaleMergeGateRefresh, runId, label: 'stale merge-gate', wording: `stale merge-gate (${classification.reason})` });
}
