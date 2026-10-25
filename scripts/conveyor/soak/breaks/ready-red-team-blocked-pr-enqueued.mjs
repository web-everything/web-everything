/** Replay label-only red-team holds with injected IO and a clear-label enqueue control. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'b'.repeat(40), BASE = 'e'.repeat(40);
const PR = 5877;
// Recognize mutations by shape; the queue-removal pin also distinguishes dequeue from enqueue.
const MUTATION_FIELD = /\bmutation\b[^{]*\{\s*(\w+)/;
const isMutation = a => MUTATION_FIELD.test(String(a));

export default {
  id: 'ready-red-team-blocked-pr-enqueued',
  title: 'the drain enqueues a PR labelled ready-to-merge that is also red-team:blocked or red-team:pending',
  card: 'PR #5877 (lane/no-merge-red-team-blocked-v2); live PRs #5838/#5839',
  fixedBy: {
    sha: 'HEAD', where: 'lane/no-merge-red-team-blocked-v2',
    paths: ['scripts/lib/drain-queue-safety.mjs', 'scripts/lib/drain-merge-strategy.mjs', 'scripts/lib/red-team-status-labels.mjs'],
  },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/drain-queue-safety.mjs'), 'utf8');
      const hold = /export function redTeamLabelHoldReason\b[^}]*?const hold\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
      const labels = readFileSync(join(root, 'scripts/lib/red-team-status-labels.mjs'), 'utf8');
      return /['"]red-team:blocked['"]/.test(hold) && /['"]red-team:pending['"]/.test(hold)
        && /l === 'red-team:pending' && desired === null/.test(labels);
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    try {
      const { CONSTELLATION_REPOS: { we: { slug: REPO } } } = await load('scripts/lib/constellation-repos.mjs');
      const { createDrainMergeStrategy } = await load('scripts/lib/drain-merge-strategy.mjs');
      const { resolveMergeDeliveryPolicy } = await load('scripts/lib/merge-delivery-policy.mjs');
      const cases = [undefined, 'true', 'false'].flatMap(wait => [
        ['red-team:blocked', false], ['red-team:pending', false], ['red-team:clear', false],
        ...(wait === 'false' ? [] : [['red-team:pending', true]]),
      ].map(([status, overdue]) => ({ wait, status, overdue })));
      cases.push(
        { wait: 'true', status: 'red-team:pending', overdue: true, override: true },
        { wait: 'true', status: 'red-team:blocked', overdue: true, override: true },
        { wait: 'true', status: 'red-team:pending', overdue: true, resultArrived: true },
      );
      for (const { wait, status, overdue, override, resultArrived } of cases) {
        let labels = ['review:accepted', 'ready-to-merge', status];
        const comments = resultArrived ? [{ user: { login: 'web-everything[bot]' },
          body: `<!-- we:red-team-advisory pr=${PR} rev=${HEAD} -->\n### Post-accept red team — no break found` }] : [];
        let clock = 45 * 60_000;
        let queued = false, requests = 0, notes = 0;
        let stored = { pending: [], followedUp: [], ...(overdue ? { redTeamPending: { [`cwd#${PR}`]: {
          headSha: HEAD, firstPendingAt: 0, retryAt: 0, checkedAt: 0,
          reason: 'post-accept red team has no recorded result on the live head',
        } } } : {}) };
        const calls = [];
        // Fresh cases owe no pass: only the label can hold admission. Overdue cases must still escalate.
        const evidence = { loopPayload: { verdict: { verdict: 'accept' } },
          scheduled: overdue, inFlight: false, queued: false, recorded: false };
        const exec = (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === 'git') {
            if (args[0] === 'rev-parse') return `${BASE}\n`;
            if (args[0] === 'diff') return 'scripts/x.mjs\0';
            if (['fetch', 'cat-file'].includes(args[0])) return '';
          }
          if (cmd === 'gh') {
            if (args.includes('--slurp')) return JSON.stringify([comments]);
            if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
              id: 'PR_NODE', state: 'OPEN', headRefOid: HEAD, baseRefName: 'main', labels });
            if (args[0] === 'pr' && ['comment', 'edit'].includes(args[1])) return '';
            if (args[0] === 'label' && args[1] === 'create') return '';
            if (args[0] === 'api' && args[1] === 'graphql') {
              if (args.some(a => a.includes('mergeQueue(branch:'))) return JSON.stringify({
                data: { repository: { mergeQueue: { entries: {
                  nodes: queued ? [{ pullRequest: { id: 'PR_NODE', number: PR } }] : [],
                  pageInfo: { hasNextPage: false },
                } } } } });
              if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({
                data: { repository: { pullRequest: { isInMergeQueue: queued, headRefOid: HEAD } } } });
              const mutation = args.find(isMutation);
              if (mutation) {
                if (mutation.includes('dequeuePullRequest')) {
                  queued = false;
                  return JSON.stringify({ data: { dequeuePullRequest: { clientMutationId: null } } });
                }
                queued = true;
                return JSON.stringify({ data: { [MUTATION_FIELD.exec(mutation)[1]]: {
                  mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } });
              }
            }
          }
          throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        };
        const s = createDrainMergeStrategy({
          env: { WE_UNDER_TEST: '1', ...(wait === undefined ? {} : { WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: wait }),
            ...(override ? { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: 'soak-operator' } : {}) },
          cwd: sourceRoot, now: () => clock, exec,
          resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
          isLocalRepo: () => true, localSlug: REPO, statePath: '/injected/queue-state.json',
          readFile: () => JSON.stringify(stored), writeState: (_path, state) => { stored = structuredClone(state); },
          readRedTeamEvidence: () => evidence, readGrantScope: () => null,
          labelProvider: {
            ensureLabel: () => {},
            setLabels: (_repo, _pr, { add, remove }) => {
              labels = labels.filter(label => !remove.includes(label));
              if (add) labels.push(add);
            },
          },
          requestRedTeam: () => { requests++; return { requested: true }; },
          publishNeedsYou: () => { notes++; }, cancelObsoleteRuns: () => {},
          batching: { gate: () => ({ admit: true }), observe: () => ({}) },
          log: { write: line => log?.(line) },
        });
        const result = s.enqueue({ num: PR }, HEAD, { comments });
        if (overdue && !override && !resultArrived) {
          check(result.kind === 'red-team-pending' && result.healthSmell && result.redTeamRequested,
            `wait=${wait ?? 'default'}: pending label bypassed the deadline path`);
          check(requests === 1, `wait=${wait ?? 'default'}: overdue pending head was not re-requested once`);
          clock += 45 * 60_000;
          const later = s.enqueue({ num: PR }, HEAD, { comments: [] });
          check(later.kind === 'red-team-pending' && later.deadlineHeld && notes === 1,
            `wait=${wait ?? 'default'}: pending label bypassed the operator notification`);
        }
        const sent = calls.some(c => c.some(isMutation));
        const allowed = status === 'red-team:clear' || resultArrived || (override && status === 'red-team:pending');
        if (allowed) {
          check(sent && result.enqueued === true,
            `wait=${wait ?? 'default'} / ${status} / override=${!!override} / result=${!!resultArrived}: did not enqueue`);
          check(!stored.redTeamPending?.[`cwd#${PR}`], 'successful admission retained the pending backoff');
          if (resultArrived) check(labels.includes('red-team:clear') && !labels.includes('red-team:pending'),
            'same-call result did not synchronize pending to clear');
        } else {
          check(!sent, `wait=${wait ?? 'default'} / ${status}: merge-queue enqueue mutation was sent despite the hold label`);
          check(result.enqueued !== true, `wait=${wait ?? 'default'} / ${status}: returned enqueued: true despite the hold label`);
        }
        if (!overdue && status === 'red-team:pending') {
          check(labels.includes(status), `wait=${wait ?? 'default'}: first refused admission removed the pending label`);
          const retry = s.enqueue({ num: PR }, HEAD, { comments });
          check(retry.enqueued === false && retry.kind === 'red-team-pending',
            `wait=${wait ?? 'default'}: second attempt lost the label-only pending hold`);
          check(!calls.some(c => c.some(isMutation)),
            `wait=${wait ?? 'default'}: repeated admission sent an enqueue mutation without a result`);
        }
        // Existing queue membership is independent of admission: pending is normal there; blocked is sent back.
        labels = ['review:accepted', 'ready-to-merge', status];
        queued = true;
        stored.pending = [{ num: PR, headSha: HEAD }];
        calls.length = 0;
        s.dequeueSendBacks([{ number: PR, labels }]);
        s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
        const dequeues = calls.filter(c => c.some(a => String(a).includes('dequeuePullRequest'))).length;
        check(dequeues === (status === 'red-team:blocked' ? 1 : 0),
          `wait=${wait ?? 'default'} / ${status}: queue sweep/followup sent ${dequeues} dequeue mutations`);
      }
      // The runner's label sweep must not publish a bare removal of a label-only pending hold (no result owed).
      const { sweepAdvisoryLabels } = await load('scripts/conveyor/advisory-label-sweep.mjs');
      const sweepLabels = ['review:accepted', 'ready-to-merge', 'red-team:pending'];
      const removals = [];
      sweepAdvisoryLabels({
        repo: REPO,
        provider: { ensureLabel: () => {}, currentRepo: () => REPO, readComments: () => [], postComment: () => {},
          setLabels: (_repo, _pr, { remove = [] }) => { removals.push(...remove); } },
        listPrs: () => [{ number: PR, headRefOid: HEAD, labels: sweepLabels.map(name => ({ name })) }],
        readPr: () => ({ state: 'OPEN', headRefOid: HEAD, labels: sweepLabels.map(name => ({ name })), comments: [] }),
        readStatusEvidence: () => ({ scheduled: false, inFlight: false, queued: false, recorded: false }),
        listUnpublishedStatuses: () => [], log: () => {},
      });
      check(!removals.includes('red-team:pending'), 'runner label sweep removed a label-only red-team:pending hold with no result');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: r => r.violations,
};
