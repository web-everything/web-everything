import { accessSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';

// Watched by merge-gate's review: prefix; exact-name review holds ignore this sentinel.
export const RETRIGGER_LABEL = 'review:merge-gate-retrigger';
const text = value => typeof value === 'string' && value.trim().length > 0;
export { decideRequiredContextRetrigger } from './recovery-preflight.mjs';
import { recoveryPreflight } from './recovery-preflight.mjs';
import { pushRefusal } from './fix-procedure.mjs';
export const mergeGateRetriggerStatePath = () => join(homedir(), '.claude', 'conveyor', 'merge-gate-retrigger-state.json');

/** Append-only, locked claims. Errors and failed attempts never release a spent key. */
export function createMergeGateRetriggerStore({ path = mergeGateRetriggerStatePath() } = {}) {
  return { claim({ repo, pr, head, context }) {
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      let keys;
      try { keys = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; keys = []; }
      if (!Array.isArray(keys) || !keys.every(key => typeof key === 'string')) throw new Error('unreadable retrigger ledger');
      const key = JSON.stringify([repo, pr, head, context]);
      if (keys.includes(key)) return false;
      writeJsonAtomic(path, [...keys, key], { mode: 0o600 });
      return true;
    }, { timeoutMs: 0 });
  } };
}

function api(args, exec) {
  const out = exec('gh', ['api', ...args], { encoding: 'utf8', timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (isGhDeferred(out)) throw new Error('GitHub call deferred');
  return out;
}

/** A skipped preflight is not a workflow-run read; preserve ordinary missing-run recovery. */
export function canReadHeadWorkflowRuns({ pr, head, exec = execFileSyncThrottled }) {
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/i.test(head ?? '')) return false;
  return exec !== execFileSyncThrottled || String(process.env.PATH ?? '').split(delimiter).some(dir => {
    if (!dir) return false;
    try {
      const file = join(dir, 'gh');
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch { return false; }
  });
}

/** Two bounded pages: target runs use the base SHA, so head-only evidence is insufficient. */
export function readHeadWorkflowRuns({ repo, pr, head, exec = execFileSyncThrottled }) {
  try {
    if (!canReadHeadWorkflowRuns({ pr, head, exec })) return null;
    const readPage = endpoint => {
      const result = JSON.parse(api([endpoint], exec));
      if (!Array.isArray(result.workflow_runs) || !Number.isSafeInteger(result.total_count)
        || result.total_count !== result.workflow_runs.length) throw new Error('incomplete workflow evidence');
      return result.workflow_runs;
    };
    const headRuns = readPage(`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(head)}`);
    const targetRuns = readPage(`repos/${repo}/actions/workflows/merge-gate.yml/runs?event=pull_request_target&per_page=100`);
    const associated = new Map();
    for (const run of [...headRuns, ...targetRuns]) {
      if (!run || typeof run.name !== 'string' || typeof run.event !== 'string') return null;
      if (run.name !== 'Merge gate' || run.event !== 'pull_request_target') continue;
      // GitHub can omit pull_requests. Neither a base SHA nor an empty association proves absence.
      if (!Array.isArray(run.pull_requests) || !run.pull_requests.length
        || run.pull_requests.some(pull => !Number.isSafeInteger(pull?.number)
          || typeof pull?.head?.sha !== 'string')) return null;
      if (run.pull_requests.some(pull => pull.number === pr && pull.head.sha === head)) associated.set(run.id, run);
    }
    return [...associated.values()];
  } catch { return null; }
}

export function createRetriggerIo({ repo, pr, exec = execFileSyncThrottled }) {
  return {
    readHead: () => JSON.parse(api([`repos/${repo}/pulls/${pr}`], exec))?.head?.sha,
    readPr: () => {
      const live = JSON.parse(api([`repos/${repo}/pulls/${pr}`], exec));
      return {
        state: typeof live?.state === 'string' ? live.state.toUpperCase() : null,
        headRefName: live?.head?.ref, baseRefName: live?.base?.ref, headRefOid: live?.head?.sha,
        isCrossRepository: text(live?.head?.repo?.full_name) && text(live?.base?.repo?.full_name)
          ? live.head.repo.full_name !== live.base.repo.full_name : null,
        mergeable: live?.mergeable === true ? 'MERGEABLE' : live?.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
      };
    },
    readLabels: () => {
      const labels = JSON.parse(api([`repos/${repo}/issues/${pr}/labels?per_page=100`], exec));
      if (!Array.isArray(labels) || labels.length >= 100 || !labels.every(row => text(row?.name)))
        throw new Error('unreadable or incomplete PR labels; operator inspection required');
      return labels.map(row => row.name);
    },
    addLabel: label => {
      const labels = JSON.parse(api(['-X', 'POST', `repos/${repo}/issues/${pr}/labels`, '-f', `labels[]=${label}`], exec));
      if (!Array.isArray(labels) || !labels.some(row => row?.name === label)) throw new Error('label addition unconfirmed');
      return { ok: true };
    },
    removeLabel: label => { api(['-X', 'DELETE', `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(label)}`], exec); return { ok: true }; },
  };
}

/** Synchronous so the synchronous sweep observes completion; also usable with await. */
export function retriggerRequiredContext({ repo, pr, head, context, defaultBranch = 'main', io, ledger = createMergeGateRetriggerStore(),
  headRefName, runs, rollup, token, env = process.env, checkClaim = pushRefusal, ...evidence }) {
  const defer = error => ({ ok: false, deferred: true, action: 'label-retrigger', error });
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(pr) || pr <= 0
    || !/^[a-f0-9]{40}$/i.test(head ?? '') || context !== 'merge-gate') return defer('invalid retrigger key');
  try {
    if (ledger.claim({ repo, pr, head, context }) !== true) return defer('retrigger already spent or claim unavailable');
    io ??= createRetriggerIo({ repo, pr });
    if (io.readHead() !== head) return defer('live head moved or is unreadable; operator inspection required');
    const labels = io.readLabels();
    if (!Array.isArray(labels) || !labels.every(text))
      throw new Error('unreadable PR labels; operator inspection required');
    // Revalidate all eligibility on live evidence before even removing a stale sentinel.
    let live;
    try { live = io.readPr(); }
    catch { return defer('live PR unreadable; operator inspection required'); }
    const decision = recoveryPreflight({ ...evidence, pr: live, head, headRefName, context,
      runs, rollup, token: token ?? env.GH_TOKEN ?? env.GITHUB_TOKEN, env,
      claimed: evidence.claimed === true || checkClaim({ repo, branch: headRefName }) !== null,
      defaultBranch, kind: 'label', labels });
    if (!decision.allow) return defer(decision.reason);
    if (io.addLabel(RETRIGGER_LABEL)?.ok !== true) throw new Error('label addition unconfirmed');
  } catch (error) { return defer(String(error.message ?? error)); }
  const result = { ok: true, action: 'label-retrigger' };
  try {
    if (io.removeLabel(RETRIGGER_LABEL)?.ok !== true) throw new Error('label removal unconfirmed');
  } catch { result.warning = 'label event submitted, but cleanup failed; operator must remove review:merge-gate-retrigger'; }
  return result;
}
