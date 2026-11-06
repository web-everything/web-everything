/**
 * @file breaks/fixing-tag-unverified-launch.mjs — dispatch-time fixing tags require a verified launch.
 * Dispatch arrays can contain ci-heal requests with no spawn handle or an explicitly unverified launch.
 * A no-findings refusal from either half must also veto a tag, even alongside a spawn handle.
 *
 * SCENARIO: drive the real runTickAllRepos statusTags loop with injected, hermetic dispatch results in
 * the soak world. Five PRs cover a missing handle, null/unverified, a handle/unverified, no-findings,
 * and a verified agentId. Four ticks cover both halves' direct and reconcile refusals.
 * RED = any rejected launch gets review-status:fixing, or the verified launch loses its tag.
 * GREEN = only the verified launch is tagged on every tick.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';
import { runSoak } from '../soak.mjs';

const ROUNDS = 4;
const WE_SLUG = CONSTELLATION_REPOS.we.slug;
const FIXING = 'review-status:fixing';
const INVARIANT = 'fixing-tag-unverified-launch';
const DAEMON = 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

function labelNames(w, pr) {
  return (w.gh.pr('we', pr)?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name));
}

export default {
  id: 'fixing-tag-unverified-launch',
  title: 'unverified ci-heal launches and no-findings refusals never get review-status:fixing; verified launches do',
  card: 'HEAD fix — dispatch-time review-status:fixing requires a confirmed launch',
  fixedBy: {
    sha: '03742c863d650997441d4203ce0bdc9eb622cfc4',
    where: 'HEAD',
    paths: [DAEMON],
  },
  fixPresent(root) {
    try {
      const daemon = readFileSync(join(root, DAEMON), 'utf8');
      return daemon.includes("d.launched !== 'unverified'")
        && daemon.includes('!refused.has(key(d))') && daemon.includes('if (!launched(d)) continue;');
    } catch { return false; }
  },
  async run({ log, sourceRoot } = {}) {
    const root = sourceRoot ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { runTickAllRepos } = await import(pathToFileURL(join(root, DAEMON)).href);
    const empty = () => ({ dispatched: [], refusals: [], reconcileRefusalDetails: [], applied: [], notes: [] });
    return runSoak({
      name: 'break:fixing-tag-unverified-launch',
      rounds: ROUNDS,
      daemons: [], // perRound drives the real daemon tick with injected dispatch IO.
      mainEvery: 0,
      scorecards: false,
      fleet: false,
      setup(w) {
        execFileSync('gh', ['label', 'create', FIXING, '--repo', WE_SLUG], { env: { ...process.env, ...w.env }, stdio: 'ignore' });
        const prs = {};
        for (const name of ['missing-handle', 'null-unverified', 'handle-unverified', 'no-findings', 'verified']) {
          const head = `lane/soak-fixing-tag-${name}`;
          w.git.createBranch('we', head, { from: 'main', files: { [`soak/${name}.txt`]: `${name}\n` } });
          prs[name] = w.gh.openPr({ repo: 'we', head, base: 'main', title: `soak: fixing tag ${name}`, labels: ['review:pending'], body: 'No backlog item.' });
        }
        return { prs };
      },
      async perRound(w, round, ctx, api) {
        const prs = ctx.prs;
        const dispatched = [
          { pr: prs['missing-handle'], agentId: null },
          { pr: prs['null-unverified'], agentId: null, launched: 'unverified' },
          { pr: prs['handle-unverified'], agentId: 'bg-unverified', launched: 'unverified' },
          { pr: prs['no-findings'], agentId: 'bg-refused' },
          { pr: prs.verified, agentId: 'bg-verified' },
        ];
        const field = round < 2 ? 'refusals' : 'reconcileRefusalDetails';
        const refused = { [field]: [{ [field === 'refusals' ? 'pr' : 'prNumber']: prs['no-findings'], kind: 'no-findings' }] };
        const calls = [];
        const result = await runTickAllRepos({
          repos: [WE_SLUG], allowStandDownAutoProceed: false,
          fixTick: () => ({ ...empty(), ...(round % 2 === 0 ? refused : {}) }),
          ciHealTick: async () => ({ ...empty(), dispatched, ...(round % 2 === 1 ? refused : {}) }),
          hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty,
          promoteDraftTick: empty, notesTick: empty,
          tagDispatchStatus({ pr, repo }) {
            calls.push({ pr, repo });
            w.gh.addLabels('we', pr, [FIXING]);
            return { changed: true };
          },
        });
        for (const [name, pr] of Object.entries(prs)) {
          const labels = labelNames(w, pr);
          api.say(`r${String(round).padStart(2, '0')} ${name} PR #${pr}: labels ${labels.join(',')}`);
          if (!w.gh.pr('we', pr) || labels.includes(FIXING) !== (name === 'verified')) {
            api.violation(INVARIANT, `${name} PR #${pr}: expected fixing=${name === 'verified'}, got ${labels.join(',')}`);
          }
        }
        if (calls.length !== 1 || calls[0]?.pr !== prs.verified || calls[0]?.repo !== WE_SLUG
          || result.statusTags.length !== 1 || result.statusTags[0]?.pr !== prs.verified
          || result.statusTags[0]?.changed !== true || result.repos.some((r) => r.error)
          || result.ciHeal.repos.some((r) => r.error)) {
          api.violation(INVARIANT, `tick ${round}: expected exactly one successful verified-launch tag; calls=${JSON.stringify(calls)}, statusTags=${JSON.stringify(result.statusTags)}`);
        }
      },
      log,
    });
  },
  judge(report) {
    return report.violations
      .filter((v) => v.invariant === INVARIANT || v.invariant === 'crash' || v.invariant === 'isolation')
      .map((v) => `${v.daemon ?? '-'} tick ${v.tick ?? '-'}: [${v.invariant}] ${v.detail}`);
  },
};
