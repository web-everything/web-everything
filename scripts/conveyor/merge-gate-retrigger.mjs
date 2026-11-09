import { accessSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';

// Watched by merge-gate's review: prefix; exact-name review holds ignore this sentinel.
export const RETRIGGER_LABEL = 'review:merge-gate-retrigger';
const skip = reason => ({ action: 'skip', reason });
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Only an absent merge-gate context with no run or a latest startup failure is repairable here. */
export function decideRequiredContextRetrigger(input) {
  if (!input || !Array.isArray(input.requiredContexts) || !input.requiredContexts.every(text)
    || !Array.isArray(input.rollup) || !input.rollup.every(row => row && text(row.name ?? row.context))
    || !Array.isArray(input.workflowRuns) || typeof input.alreadyRetriggered !== 'boolean'
    || !input.workflowRuns.every(run => run && text(run.name) && text(run.event)
      && text(run.status) && Number.isFinite(Date.parse(run.created_at)) && Number.isSafeInteger(run.id)
      && (run.conclusion === null || text(run.conclusion)))) return skip('unreadable retrigger evidence; operator inspection required');
  if (input.alreadyRetriggered) return skip('retrigger already spent for this head');
  if (!input.requiredContexts.includes('merge-gate')) return skip('merge-gate is not required');
  if (input.rollup.some(row => (row.name ?? row.context) === 'merge-gate')) return skip('merge-gate context is already present');
  const runs = input.workflowRuns.filter(run => run.name === 'Merge gate' && run.event === 'pull_request_target');
  if (runs.some(run => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)))
    return skip('merge-gate workflow is live');
  runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  if (runs.length && !(runs[0].status === 'completed' && runs[0].conclusion === 'startup_failure'))
    return skip('latest merge-gate run is not a startup failure; operator inspection required');
  return { action: 'retrigger', context: 'merge-gate', reason: runs.length ? 'missing context after startup failure' : 'missing context and workflow run' };
}

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

/** Two bounded pages: target runs use the base SHA, so head-only evidence is insufficient. */
export function readHeadWorkflowRuns({ repo, pr, head, exec = execFileSyncThrottled }) {
  try {
    if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/i.test(head ?? '')) return null;
    // Avoid entering the throttle/router when there is no local gh executable.
    if (exec === execFileSyncThrottled && !String(process.env.PATH ?? '').split(delimiter).some(dir => {
      if (!dir) return false;
      try {
        const file = join(dir, 'gh');
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch { return false; }
    })) return null;
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
export function retriggerRequiredContext({ repo, pr, head, context, io, ledger = createMergeGateRetriggerStore() }) {
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
    if (labels.includes(RETRIGGER_LABEL) && io.removeLabel(RETRIGGER_LABEL)?.ok !== true)
      throw new Error('stale sentinel label removal unconfirmed; operator inspection required');
    if (io.addLabel(RETRIGGER_LABEL)?.ok !== true) throw new Error('label addition unconfirmed');
  } catch (error) { return { ok: false, action: 'label-retrigger', error: String(error.message ?? error) }; }
  const result = { ok: true, action: 'label-retrigger' };
  try {
    if (io.removeLabel(RETRIGGER_LABEL)?.ok !== true) throw new Error('label removal unconfirmed');
  } catch { result.warning = 'label event submitted, but cleanup failed; operator must remove review:merge-gate-retrigger'; }
  return result;
}
