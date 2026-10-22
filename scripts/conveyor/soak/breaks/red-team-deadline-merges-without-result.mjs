/**
 * Replay the drain's never-scheduled red-team deadline with and without a request
 * hook. A request is not a result: neither elapsed wait may authorize enqueue.
 * Production modules come from sourceRoot; all command and state IO is injected.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const HEAD = 'b'.repeat(40), BASE = 'e'.repeat(40);
const PR = 5283;
const WAIT = 45 * 60_000;
// The merge-queue mutation, recognized by shape (a GraphQL `mutation { <field>(...) }`), never by name: only
// merge-queue-enqueue.mjs may name it (merge-queue-enqueue.test.mjs scans scripts/ for that).
const MUTATION_FIELD = /\bmutation\b[^{]*\{\s*(\w+)/;
const isMutation = a => MUTATION_FIELD.test(String(a));

export default {
  id: 'red-team-deadline-merges-without-result',
  title: 'an owed red team without a result holds past the deadline and one re-request',
  card: '#5283 / red-team deadline enqueue barrier',
  fixedBy: {
    sha: '57a751334', where: 'lane/redteam-no-merge-without-result',
    paths: ['scripts/lib/drain-merge-strategy.mjs', 'scripts/lib/drain-queue-safety.mjs',
      'scripts/lib/red-team-gate.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/drain-merge-strategy.mjs'), 'utf8').includes('readRedTeamDeadlineAction')
        && /export function readRedTeamDeadlineAction\b/.test(readFileSync(join(root, 'scripts/lib/red-team-gate.mjs'), 'utf8'));
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
    let REPO;
    try {
      ({ CONSTELLATION_REPOS: { we: { slug: REPO } } } = await load('scripts/lib/constellation-repos.mjs'));
      const { createDrainMergeStrategy } = await load('scripts/lib/drain-merge-strategy.mjs');
      const { resolveMergeDeliveryPolicy } = await load('scripts/lib/merge-delivery-policy.mjs');
      const gate = await load('scripts/lib/red-team-gate.mjs');
      // Pin the actual cascade, not the redTeamDeadline test seam: the pre-fix
      // tree must retain its default timed bypass so this replay exposes it.
      const env = { WE_UNDER_TEST: '1', WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: '45',
        WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: 'true', WE_RED_TEAM_DEADLINE_ACTION: 'requeue-then-hold' };

      // A request hook that refuses or throws is still a request attempt: tried once per head, never a result.
      const hooks = {
        'no request hook': null,
        'request hook': () => ({ requested: true }),
        'refused request hook': () => ({ requested: false }),
        'throwing request hook': () => { throw new Error('review dispatch unavailable'); },
      };
      // The operator override (merge-without-result + a named operator) never waives a live or recorded run.
      const OVERRIDE = { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: 'soak-operator' };
      const scenarios = [
        ...Object.keys(hooks).map(mode => ({ mode, hook: hooks[mode], env, run: {} })),
        ...['inFlight', 'queued', 'recorded'].map(field => ({ mode: `operator override with a ${field} run`, hook: null,
          env: { ...env, ...OVERRIDE }, run: { [field]: true } })),
      ];
      for (const { mode, hook, env: scenarioEnv, run } of scenarios) {
        const withRequest = typeof hook === 'function';
        let clock = 1000, queued = false;
        let stored = { pending: [], followedUp: [] };
        const calls = [], requests = [], notes = [];
        const labels = ['review:accepted', 'ready-to-merge'];
        // scheduled means a pass was owed by the producer's head-bound policy;
        // no job was actually queued, started, recorded, or given a result.
        const evidence = { loopPayload: { verdict: { verdict: 'accept' } },
          scheduled: true, inFlight: false, queued: false, recorded: false, ...run };
        const exec = (cmd, args) => {
          calls.push([cmd, ...args]);
          if (cmd === 'git') {
            if (args[0] === 'rev-parse') return `${BASE}\n`;
            if (args[0] === 'diff') return 'scripts/x.mjs\0';
            if (['fetch', 'cat-file'].includes(args[0])) return '';
          }
          if (cmd === 'gh') {
            if (args.includes('--slurp')) return '[[]]'; // no result, ever
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
          env: scenarioEnv, cwd: sourceRoot, now: () => clock, exec,
          resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }), note: null },
          isLocalRepo: () => true, localSlug: REPO, statePath: '/injected/queue-state.json',
          readFile: () => JSON.stringify(stored), writeState: (_path, state) => { stored = structuredClone(state); },
          readRedTeamEvidence: () => evidence, readGrantScope: () => null,
          requestRedTeam: withRequest ? input => { requests.push(input); return hook(input); } : null,
          publishNeedsYou: item => notes.push(item),
          cancelObsoleteRuns: () => {}, batching: { gate: () => ({ admit: true }), observe: () => ({}) },
          log: { write: line => log?.(line) },
        });
        const tick = label => {
          const start = calls.length;
          const result = s.enqueue({ num: PR }, HEAD, { comments: [] });
          check(!calls.slice(start).some(c => c.some(isMutation)),
            `${mode}, ${label}: the merge-queue enqueue mutation was sent without a red-team result on the head`);
          check(result.enqueued !== true, `${mode}, ${label}: enqueued: true without a red-team result on the head`);
          return result;
        };
        const initial = tick('initial wait');
        check(initial.kind === 'red-team-pending' && initial.reason?.includes('no recorded result'),
          `${mode}: fixture did not enter the owed missing-result wait`);
        check(requests.length === 0, `${mode}: requested before the wait deadline`);
        clock += WAIT + 1;
        let held = tick('past 45 min');
        if (withRequest) {
          check(requests.length === 1 && requests[0].repo === REPO && requests[0].pr === PR && requests[0].head === HEAD,
            `${mode}: overdue head did not get one head-bound re-request`);
          tick('immediately after re-request');
          // Every backoff recheck reaches the deadline path again: the hook must not be called a second time.
          for (let i = 0; i < 3; i++) { clock += 301_000; tick(`backoff recheck ${i + 1}`); }
          clock += WAIT + 1;
          held = tick('past another 45 min without a result');
          check(requests.length === 1, `${mode}: re-request repeated for the same head (${requests.length} calls)`);
        }
        // Check observed hold behavior independently of fixPresent; also require
        // the note on trees exposing the deadline API if the hold flag regresses.
        if (held.deadlineHeld || typeof gate.readRedTeamDeadlineAction === 'function') {
          check(notes.some(n => n.repo === REPO && n.pr === PR && n.head === HEAD
            && n.kind === 'red-team-deadline-held' && n.reason?.includes('no red-team result')),
          `${mode}: no needs-you note published for the held head`);
        }
      }
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: r => r.violations,
};
