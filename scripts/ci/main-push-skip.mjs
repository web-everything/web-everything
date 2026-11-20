#!/usr/bin/env node
/** Exact-commit queue reuse. Any missing proof runs full CI; no tree/time heuristics. */
import { execFileSyncThrottled as exec } from '../lib/gh-throttle.mjs';
import { pathToFileURL } from 'node:url';
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) && value.length === 40
  && !/^0+$/.test(value) ? value.toLowerCase() : null;
const id = value => Number.isSafeInteger(value) && value > 0;
const full = reason => ({ skip: false, reason: `${reason}; running full CI` });
const success = run => run.status === 'completed' && run.conclusion === 'success';
const queueRun = runs => runs.filter(r => r.path === '.github/workflows/ci.yml'
  && r.event === 'merge_group' && success(r)).sort((a, b) => b.id - a.id)[0];

export function decideMainPushSkip(input = {}) {
  try {
    const { sha, before, runs, queueFuiSha, fuiTip, event, ref, currentRunId, beforeIsAncestor } = input;
    if (event !== 'push' || ref !== 'refs/heads/main') return full('not a main push');
    if (!oid(sha) || !oid(before) || !id(currentRunId) || beforeIsAncestor !== true) return full('unproven fast-forward');
    const rows = runs?.workflow_runs;
    if (!Array.isArray(rows) || !Number.isSafeInteger(runs.total_count) || runs.total_count < 1
      || runs.total_count > 1000 || rows.length !== runs.total_count || new Set(rows.map(r => r?.id)).size !== rows.length
      || rows.some(r => !id(r?.id) || oid(r.head_sha) !== oid(sha) || typeof r.event !== 'string'
        || typeof r.path !== 'string' || typeof r.head_branch !== 'string'
        || !['completed', 'queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(r.status)
        || (r.status === 'completed' ? !['success', 'failure', 'cancelled', 'neutral', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'].includes(r.conclusion) : r.conclusion !== null))) return full('incomplete run evidence');
    const queue = queueRun(rows);
    if (!queue || !queue.head_branch.startsWith('gh-readonly-queue/main/')
      || queue.check_suite?.app?.id !== 15368) return full('no trusted successful queue run');
    const newer = rows.filter(r => r.id > queue.id && r.id !== currentRunId);
    if (newer.some(r => !success(r) || r.check_suite?.app?.id !== 15368)) return full('newer run invalidates queue success');
    if (!oid(queueFuiSha) || !oid(fuiTip) || oid(queueFuiSha) !== oid(fuiTip)) return full('FUI sibling proof missing or changed');
    return { skip: true, reason: `exact SHA passed queue run ${queue.id}; FUI sibling unchanged` };
  } catch { return full('unreadable input'); }
}

const options = { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } };
function resolveFuiTip() {
  if (!process.env.FUI_TOKEN) throw Error('missing FUI App token');
  const auth = Buffer.from(`x-access-token:${process.env.FUI_TOKEN}`).toString('base64');
  const output = exec('git', ['ls-remote', 'https://github.com/frontier-ui/frontierui.git', 'HEAD'], {
    ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` } });
  const match = /^([a-f0-9]{40})\tHEAD\n?$/.exec(output);
  if (!match || !oid(match[1])) throw Error('unreadable FUI tip');
  return match[1];
}

/** At most 30 API calls, ten pages per inventory; exhaustion falls back to full CI. */
export function main(argv) {
  try {
    if (argv.length === 1 && argv[0] === '--record-fui') return `tip=${resolveFuiTip()}\n`;
    const args = {};
    for (const arg of argv) {
      const m = /^--(sha|before|run-id|event|ref|repo)=(.+)$/.exec(arg);
      if (!m || Object.hasOwn(args, m[1])) throw Error('bad arguments');
      args[m[1]] = m[2];
    }
    if (Object.keys(args).length !== 6 || !oid(args.sha) || !oid(args.before)
      || !/^[1-9][0-9]*$/.test(args['run-id']) || !id(Number(args['run-id']))
      || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) throw Error('bad arguments');
    if (args.event !== 'push' || args.ref !== 'refs/heads/main') return full('not a main push');
    exec('git', ['merge-base', '--is-ancestor', args.before, args.sha], options);
    let budget = 30;
    const api = endpoint => {
      if (--budget < 0) throw Error('API budget exhausted');
      return JSON.parse(exec('gh', ['api', `repos/${args.repo}/${endpoint}`], options));
    };
    const pages = (endpoint, key) => {
      const rows = []; let total;
      for (let page = 1; page <= 10; page++) {
        const result = api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0 || result.total_count > 1000
          || (total !== undefined && total !== result.total_count) || !Array.isArray(result[key])
          || result[key].length !== Math.min(100, result.total_count - rows.length)) throw Error('incomplete API page');
        total = result.total_count; rows.push(...result[key]);
        if (rows.length === total) return { total_count: total, [key]: rows };
      }
      throw Error('page bound exceeded');
    };
    const runs = pages(`actions/runs?head_sha=${args.sha}`, 'workflow_runs');
    const queue = queueRun(runs.workflow_runs);
    if (!queue || !id(queue.id)) return full('no successful queue run');
    for (const run of runs.workflow_runs.filter(r => r.id >= queue.id && r.id !== Number(args['run-id']))) {
      if (!id(run.check_suite_id)) throw Error('unreadable check suite identity');
      run.check_suite = api(`check-suites/${run.check_suite_id}`);
    }
    const artifacts = pages(`actions/runs/${queue.id}/artifacts`, 'artifacts').artifacts;
    if (artifacts.some(a => typeof a?.name !== 'string')) throw Error('unreadable artifact record');
    const records = artifacts.filter(a => typeof a?.name === 'string' && a.name.startsWith('fui-sibling-'));
    const queueFuiSha = records.length === 1 ? records[0].name.slice('fui-sibling-'.length) : null;
    return decideMainPushSkip({ sha: args.sha, before: args.before, runs, queueFuiSha, fuiTip: resolveFuiTip(),
      event: args.event, ref: args.ref, currentRunId: Number(args['run-id']), beforeIsAncestor: true });
  } catch { return full('unreadable input, API, or ancestry'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = main(process.argv.slice(2));
  process.stdout.write(typeof result === 'string' ? result : `skip=${result.skip}\nreason=${result.reason}\n`);
}
