/** Replay label-only red-team holds with injected IO and a clear-label enqueue control. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'b'.repeat(40), BASE = 'e'.repeat(40);
const PR = 5877;
// Recognize the enqueue mutation by shape, never by its production-only field name.
const MUTATION_FIELD = /\bmutation\b[^{]*\{\s*(\w+)/;
const isMutation = a => MUTATION_FIELD.test(String(a));

export default {
  id: 'ready-red-team-blocked-pr-enqueued',
  title: 'the drain enqueues a PR labelled ready-to-merge that is also red-team:blocked or red-team:pending',
  card: 'PR #5877 (lane/no-merge-red-team-blocked-v2); live PRs #5838/#5839',
  fixedBy: {
    sha: '23ae996c76', where: 'lane/no-merge-red-team-blocked-v2',
    paths: ['scripts/lib/drain-queue-safety.mjs'],
  },
  fixPresent(root) {
    try {
      const source = readFileSync(join(root, 'scripts/lib/drain-queue-safety.mjs'), 'utf8');
      const hold = /export function sendBackReason\b[^}]*?const hold\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
      return /['"]red-team:blocked['"]/.test(hold) && /['"]red-team:pending['"]/.test(hold);
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
      for (const status of ['red-team:blocked', 'red-team:pending', 'red-team:clear']) {
        const labels = ['review:accepted', 'ready-to-merge', status];
        let queued = false, stored = { pending: [], followedUp: [] };
        const calls = [];
        // No pass is owed: only the live label can hold this otherwise accepted head.
        const evidence = { loopPayload: { verdict: { verdict: 'accept' } },
          scheduled: false, inFlight: false, queued: false, recorded: false };
        const exec = (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === 'git') {
            if (args[0] === 'rev-parse') return `${BASE}\n`;
            if (args[0] === 'diff') return 'scripts/x.mjs\0';
            if (['fetch', 'cat-file'].includes(args[0])) return '';
          }
          if (cmd === 'gh') {
            if (args.includes('--slurp')) return '[[]]';
            if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({
              id: 'PR_NODE', state: 'OPEN', headRefOid: HEAD, baseRefName: 'main', labels });
            if (args[0] === 'pr' && ['comment', 'edit'].includes(args[1])) return '';
            if (args[0] === 'label' && args[1] === 'create') return '';
            if (args[0] === 'api' && args[1] === 'graphql') {
              if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({
                data: { repository: { pullRequest: { isInMergeQueue: queued, headRefOid: HEAD } } } });
              const mutation = args.find(isMutation);
              if (mutation) {
                queued = true;
                return JSON.stringify({ data: { [MUTATION_FIELD.exec(mutation)[1]]: {
                  mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } });
              }
            }
          }
          throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        };
        const s = createDrainMergeStrategy({
          env: { WE_UNDER_TEST: '1', WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: 'true' },
          cwd: sourceRoot, now: () => 1000, exec,
          resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
          isLocalRepo: () => true, localSlug: REPO, statePath: '/injected/queue-state.json',
          readFile: () => JSON.stringify(stored), writeState: (_path, state) => { stored = structuredClone(state); },
          readRedTeamEvidence: () => evidence, readGrantScope: () => null,
          requestRedTeam: null, publishNeedsYou: () => {}, cancelObsoleteRuns: () => {},
          batching: { gate: () => ({ admit: true }), observe: () => ({}) },
          log: { write: line => log?.(line) },
        });
        const result = s.enqueue({ num: PR }, HEAD, { comments: [] });
        const sent = calls.some(c => c.some(isMutation));
        if (status === 'red-team:clear') {
          check(sent, `${status}: control did not send the merge-queue enqueue mutation`);
        } else {
          check(!sent, `${status}: merge-queue enqueue mutation was sent despite the hold label`);
          check(result.enqueued !== true, `${status}: returned enqueued: true despite the hold label`);
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: r => r.violations,
};
