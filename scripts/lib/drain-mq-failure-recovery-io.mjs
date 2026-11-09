/** Production adapter for a drain's held same-head MQ failure. No work runs at import time. */
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { createMqLiveReader, readMqTimeline, decideMqSameHead } from './drain-queue-safety.mjs';
import { collectMqFailureEvidence } from './mq-failure-evidence.mjs';
import { createMqFailureLedger } from './mq-failure-ledger.mjs';
import { drainMqFailureRecovery } from './drain-mq-failure-recovery.mjs';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/.test(value);
const validIdentity = ({ repo, pr, head }) => typeof repo === 'string'
  && /^[\w.-]+\/[\w.-]+(?![\s\S])/.test(repo) && Number.isSafeInteger(pr) && pr > 0 && oid(head);
const safe = text => String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

/** All requests, including timeline reads and publication, share a fresh bounded budget per route.
 * Inject exec and ledger for hermetic fixtures. Limits are hard ceilings, not policy settings.
 */
export function createDrainMqFailureRecoveryIo({ exec = execFileSyncThrottled,
  ledger = createMqFailureLedger(), maxCalls = 128 } = {}) {
  const limit = Number.isSafeInteger(maxCalls) && maxCalls > 0 ? Math.min(maxCalls, 128) : 128;
  const liveExec = createMqLiveReader(exec);
  let calls = 0;
  const request = (file, args, options = {}) => {
    if (++calls > limit) throw new Error('MQ evidence call bound reached; operator inspection required');
    return liveExec(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], ...options, throttle: { maxAttempts: 1 } });
  };
  const json = args => JSON.parse(request('gh', args));
  const pageStates = new Map();
  const countPage = (endpoint, field, page) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10) throw new Error('Invalid MQ evidence page');
    const data = json(['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`]);
    const total = data?.total_count, rows = data?.[field];
    if (!Number.isSafeInteger(total) || total < 0 || total > 1000 || !Array.isArray(rows)
      || rows.length !== Math.min(100, Math.max(0, total - (page - 1) * 100))) throw new Error('Incomplete MQ evidence page');
    const state = page === 1 ? { total, page: 0, ids: new Set() } : pageStates.get(endpoint);
    if (!state || state.total !== total || state.page !== page - 1) throw new Error('Unstable MQ evidence pagination');
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.id) || row.id <= 0 || state.ids.has(row.id)) throw new Error('Unknown or duplicate MQ evidence identity');
      state.ids.add(row.id);
    }
    state.page = page;
    pageStates.set(endpoint, state);
    return { [field]: rows, complete: true, nextPage: state.ids.size < total ? page + 1 : null };
  };
  const write = (endpoint, body) => JSON.parse(request('gh', ['api', '--method', 'POST', endpoint, '--input', '-'],
    { input: JSON.stringify(body) }));
  return {
    ledger,
    forRoute: () => createDrainMqFailureRecoveryIo({ exec, ledger, maxCalls: limit }),
    readTimeline: ({ repo, pr }) => readMqTimeline({ repo, pr, exec: request }),
    readPr: ({ repo, pr }) => json(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,mergeStateStatus,baseRefName']),
    readLabels({ repo, pr }) {
      const data = json(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']);
      const complete = oid(data?.headRefOid) && Array.isArray(data?.labels) && data.labels.length < 100
        && data.labels.every(label => typeof label?.name === 'string' && label.name.length > 0);
      return { labels: complete ? data.labels.map(label => label.name) : [], complete, head: data?.headRefOid };
    },
    collectEvidence({ removal }) {
      return collectMqFailureEvidence({ removal, io: {
        listRuns({ repo, page }) {
          const result = countPage(`repos/${repo}/actions/runs?event=merge_group&head_sha=${removal.mergeGroupHead}&branch=${encodeURIComponent(removal.mergeGroupBranch)}`, 'workflow_runs', page);
          const valid = result.workflow_runs.every(run => oid(run.head_sha) && typeof run.event === 'string'
            && typeof run.head_branch === 'string' && typeof run.conclusion === 'string');
          return { runs: result.workflow_runs.filter(run => run.head_sha === removal.mergeGroupHead),
            complete: valid, nextPage: result.nextPage };
        },
        listJobs({ repo, runId, page }) {
          const result = countPage(`repos/${repo}/actions/runs/${runId}/jobs`, 'jobs', page);
          return { ...result, complete: result.jobs.every(job => job.status === 'completed'
            && ['success', 'skipped', 'neutral', 'failure'].includes(job.conclusion)) };
        },
        readJobLog({ repo, jobId }) {
          const text = request('gh', ['api', `repos/${repo}/actions/jobs/${jobId}/logs`], { maxBuffer: 256 * 1024 });
          return { text, complete: typeof text === 'string' && Buffer.byteLength(text) <= 256 * 1024 };
        },
      } });
    },
    postComment: ({ repo, pr, body }) => { request('gh', ['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'], { input: body }); return { ok: true }; },
    addLabel: ({ repo, pr, label }) => write(`repos/${repo}/issues/${pr}/labels`, { labels: [label] }),
  };
}

export const productionIo = createDrainMqFailureRecoveryIo();

/** Called by a drain when mqSameHeadGuard holds. Always retain the guard; routing is best-effort. */
export async function routeMqFailureOnHold({ repo, pr, head, guard, dryRun = false,
  log = () => {}, io = productionIo } = {}) {
  const finish = (routed, reason) => {
    try { log(safe(`mq-failure-recovery: #${pr} ${reason}`)); } catch { /* Logging cannot interrupt the drain. */ }
    return { routed, reason };
  };
  try {
    if (dryRun) return finish(false, 'Dry-run: no route reads, claim or publication');
    const identity = { repo, pr, head };
    if (!validIdentity(identity) || guard?.hold !== true || typeof guard.line !== 'string'
      || !guard.line.startsWith('mq-same-head-failed:')) return finish(false, 'No eligible same-head MQ hold');
    const active = io.forRoute ? io.forRoute() : io;
    const timeline = await active.readTimeline({ repo, pr });
    if (timeline?.error || timeline?.hasPreviousPage !== false || !Array.isArray(timeline?.nodes)
      || timeline.nodes.length > 100) return finish(false, 'Incomplete timeline; operator inspection required');
    // Reuse the drain's second-parent binding and retry exhaustion decision. Unknown events/reasons,
    // repeated failures and a queue re-entry after failure cannot authorize a recovery route.
    const decision = decideMqSameHead({ ...identity, timeline });
    if (!decision.hold || !decision.line?.endsWith(' — failed_checks'))
      return finish(false, 'No single eligible failed_checks removal; operator inspection required');
    const removals = timeline.nodes.filter(event => event?.__typename === 'RemovedFromMergeQueueEvent'
      && event.reason?.trim().toLowerCase() === 'failed_checks'
      && event.beforeCommit?.parents?.nodes?.[1]?.oid === head);
    const event = removals[0];
    if (removals.length !== 1 || !oid(event?.beforeCommit?.oid)
      || !Number.isFinite(Date.parse(event?.createdAt))) return finish(false, 'Unbound removal evidence; operator inspection required');
    const live = await active.readPr({ repo, pr });
    if (live?.headRefOid !== head || live.mergeStateStatus !== 'CLEAN' || live.baseRefName !== 'main')
      return finish(false, 'Live head or CLEAN main-base evidence unavailable; operator inspection required');
    const removal = { ...identity, mergeGroupHead: event.beforeCommit.oid,
      mergeGroupBranch: `gh-readonly-queue/main/pr-${pr}-${head}` };
    const currentHead = async () => {
      const current = await active.readPr({ repo, pr });
      if (current?.headRefOid !== head || current.mergeStateStatus !== 'CLEAN' || current.baseRefName !== 'main')
        throw new Error('Head or merge state changed; operator inspection required');
    };
    const result = await drainMqFailureRecovery({ removal,
      hold: { reason: 'mq-same-head-failed', historyComplete: true, mergeState: 'CLEAN', retriesExhausted: false },
      dryRun: false, ledger: active.ledger,
      io: {
        collectEvidence: args => active.collectEvidence(args),
        async readLabels(args) {
          const labels = await active.readLabels(args);
          return { ...labels, complete: labels?.complete === true && labels.head === head };
        },
        async postComment(args) { await currentHead(); return active.postComment(args); },
        async addLabel(args) { await currentHead(); return active.addLabel(args); },
      },
    });
    return finish(result.action === 'routed', result.note ?? (result.action === 'routed'
      ? 'Real MQ failure routed for recovery' : 'MQ hold retained; operator inspection required'));
  } catch { return finish(false, 'MQ recovery evidence or IO unavailable; operator inspection required'); }
}
