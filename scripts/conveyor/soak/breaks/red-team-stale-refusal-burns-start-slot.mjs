/**
 * A pre-start stale-main refusal burned recovery capacity and silently stranded an owed red team.
 * Replay the production skip runner twice with the same head, capacity and cooldown history.
 * Only dispatch and evidence IO are injected; no processes, network or persisted run state.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const RECOVERY = 'scripts/lib/review-red-team-on-skip.mjs';
const STALENESS = 'scripts/lib/main-staleness.mjs';

export default {
  id: 'red-team-stale-refusal-burns-start-slot',
  title: 'a pre-start stale-main refusal refunds red-team capacity and retries the same head next tick',
  card: 'red-team pre-start stale-main dispatch refusal (996925f68d)',
  fixedBy: { sha: '996925f68d', where: 'main', paths: [RECOVERY, STALENESS] },
  // This committed regression must stay green; reverting the fix must fail the test, not mark it expected-fail.
  fixPresent: () => true,
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      const { runRedTeamOnSkip } = await load(RECOVERY);
      const { PreStartDispatchRefusalError } = await load(STALENESS);
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      if (typeof runRedTeamOnSkip !== 'function' || typeof PreStartDispatchRefusalError !== 'function') {
        return { violations: ['recovery replay exports missing: cannot exercise a typed pre-start refusal'] };
      }
      const repo = CONSTELLATION_REPOS.we.slug, pr = 5759, head = 'a'.repeat(40);
      const message = 'behind origin/main — refusing to dispatch before spawn';
      const lastDispatch = new Map(), logs = [], attempts = [];
      let at = 2_000_000, takes = 0;
      const capacity = { lanes: 1, budget: { left: 1 }, remainingStarts: 1, take: () => { takes++; } };
      const raw = { number: pr, headRefOid: head, state: 'OPEN',
        labels: ['review:accepted', 'red-team:pending'], reviews: [],
        comments: [{ author: { login: 'web-everything' },
          body: `✅ review — accepted\n<!-- reviewed-sha: ${head} -->` }] };
      const tick = () => runRedTeamOnSkip({ repo, env: {},
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] },
        rawPrs: [raw], setting: { enabled: true, retryCooldownMin: 30 },
        capacity, lastDispatch, now: () => at,
        readEvidence: () => ({ recorded: false, loopPayload: { verdict: { verdict: 'accept' },
          findings: { read: { netBasis: { rev: head }, netChangedFiles: ['scripts/example.mjs'], diffText: '+code' } } } }),
        readStatus: () => null, readWitness: null, readCarry: () => null,
        readReviews: () => [], readComments: () => raw.comments,
        provider: { readPrState: () => raw }, headNeverReviewed: () => false,
        proveMove: () => ({ ok: false }),
        settlePending: () => { throw Error('unexpected pending-label settlement'); },
        settle: () => { throw Error('unexpected policy settlement'); },
        syncLabels: () => { throw Error('unexpected label sync'); },
        escalate: () => { throw Error('unexpected escalation'); },
        dispatch: args => {
          attempts.push({ ...args, head: raw.headRefOid });
          if (attempts.length === 1) throw new PreStartDispatchRefusalError(message);
          return { jobPid: 42 };
        },
        log: line => logs.push(line),
      });

      const first = tick();
      check(attempts.length === 1, 'first tick did not attempt exactly one dispatch');
      check(first.rows.length === 1 && first.rows[0].action === 'skip'
        && first.rows[0].why === `dispatch refused before start: ${message}`,
      'first tick did not report the pre-start refusal');
      check(first.dispatched.length === 0, 'pre-start refusal was reported as dispatched');
      check(capacity.lanes === 1 && capacity.remainingStarts === 1 && takes === 0,
        'pre-start refusal consumed a lane or host start slot');
      check(capacity.budget.left === 1, 'pre-start refusal did not refund the live-review budget');
      check(lastDispatch.size === 0, 'pre-start refusal installed a retry cooldown');
      check(logs.includes(`review-daemon: ${repo}#${pr} red-team dispatch threw: ${message}`),
        'pre-start refusal did not log red-team dispatch threw with its cause');

      at += 1_000; // Next tick is still inside the 30-minute cooldown; do not reset any capacity.
      const second = tick();
      check(attempts.length === 2 && attempts.every(args => args.repo === repo && args.pr === pr
        && args.head === head && args.redTeamOnly === true && args.redTeamMode === 'fresh'),
      'next tick did not retry red-team-only dispatch for the same head');
      check(second.rows.length === 1 && second.rows[0].action === 'dispatch'
        && second.rows[0].head === head && second.dispatched.length === 1
        && second.dispatched[0].prNumber === pr && second.dispatched[0].jobPid === 42,
      'successful second tick was not reported as dispatched');
      check(capacity.lanes === 0 && capacity.budget.left === 0 && capacity.remainingStarts === 0 && takes === 1,
        'successful retry did not consume exactly one start reservation');
      check(lastDispatch.size === 1 && lastDispatch.get(`${repo}#${pr}@${head}`) === at,
        'successful retry did not record cooldown for the same head');
    } catch (error) {
      violations.push(`scenario failed: ${error.stack ?? error}`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
