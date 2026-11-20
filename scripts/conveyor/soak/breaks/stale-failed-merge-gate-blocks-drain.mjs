/** A cleared failed merge-gate needs a new head through the production drain refresh. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const SOURCE = 'scripts/lib/merge-queue-enqueue.mjs';
export default {
  id: 'stale-failed-merge-gate-blocks-drain',
  title: 'cleared failed merge-gate enters the guarded drain refresh with cross-head and pass bounds',
  card: 'PR #7106 / #7117 (2026-11-19)',
  fixedBy: { sha: 'HEAD', where: 'HEAD', paths: [SOURCE, 'scripts/merge-ai-prs.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, SOURCE), 'utf8').includes('failedRequiredGateRefresh');
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { createPrestageWorld } = await import(pathToFileURL(join(sourceRoot, 'scripts/__tests__/fixtures/merge-ai-prs-prestage-world.mjs')).href);
    const { CONSTELLATION_REPOS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/constellation-repos.mjs')).href);
    const world = createPrestageWorld((argv, options) => spawnSync(process.execPath,
      [join(sourceRoot, 'scripts/merge-ai-prs.mjs'), ...argv], options));
    const report = {};
    // One merge-gate job per PR (the fake serves job 1000 + number).
    const jobUrl = number => `https://github.com/o/r/actions/runs/123/job/${1000 + number}`;
    const withJob = copy => {
      copy.statusCheckRollup = copy.statusCheckRollup.map(row => row.name === 'merge-gate' ? { ...row, detailsUrl: jobUrl(copy.number) } : row);
      return copy;
    };
    await world(async ({ pr, run, dir, slug }) => {
      pr.failedGate = true;
      pr.labels.push({ name: 'red-team:clear' });
      pr.statusCheckRollup = ['test', 'merge-gate'].map(name => ({ name, head_sha: pr.headRefOid,
        status: 'COMPLETED', conclusion: name === 'test' ? 'SUCCESS' : 'FAILURE',
        ...(name === 'merge-gate' ? { detailsUrl: jobUrl(pr.number) } : {}) }));
      const { GATE_IDS } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/merge-gate-inventory.mjs')).href);
      // The gate's own verdict log: a candidacy hold the drain has since cleared (human-only, no human clearance) vs a real hold.
      const gateLog = holds => ['#N: HOLD', ...GATE_IDS.map(id => holds[id]
        ? `  hold              ${id.padEnd(22)} ${holds[id]}` : `  pass              ${id.padEnd(22)} ok`),
      'merge-gate: HOLD — held'].join('\n');
      pr.gateLog = gateLog({ 'review-acceptance': 'human-only: workflow edit' });
      const env = { WE_MERGE_QUEUE_REFRESH_ON_STALE_MERGE_GATE: 'on',
        WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE: 'off' };
      const state = join(dir, 'groups.json');
      env.WE_DRAIN_CARD_GROUP_STATE = state;
      report.groupHolds = [];
      for (const role of ['source', 'combined', 'unreadable']) {
        writeFileSync(state, role === 'unreadable' ? '{broken' : JSON.stringify({ groups: [{
          id: 'fixture', repo: slug, pr: role === 'combined' ? 42 : 77,
          branch: role === 'combined' ? pr.headRefName : 'lane/card-group-fixture',
          sources: [{ num: role === 'source' ? 42 : 99, headSha: pr.headRefOid }], files: ['backlog/xfixture.md'],
        }], failed: {}, lastReconcileAt: Date.now() }));
        const held = await run(false, { env });
        report.groupHolds.push({ role, calls: held.calls, aborted: held.report.revalidationAborted });
      }
      writeFileSync(state, JSON.stringify({ groups: [], failed: {}, lastReconcileAt: Date.now() }));
      report.disabled = (await run(false, { env: { ...env, WE_DRAIN_STALE_GATE_UPDATE_BRANCH_MAX: '0' } })).calls;
      // A fetched-head race is a confirmed pre-push failure, so it must not consume
      // the PR's only recovery claim before the next pass can re-read the head.
      pr.fetchedHead = 'f'.repeat(40);
      report.fetchFailed = (await run(false, { env })).calls;
      delete pr.fetchedHead;
      // Two held PRs precede three eligible PRs. Holds refund the pass budget;
      // the following two refresh and the final one still hits the shared cap.
      const prs = [42, 43, 44, 45, 46].map(number => withJob({ ...structuredClone(pr), number,
        id: `PR_${number}`, headRefName: `lane/readme-${number}` }));
      writeFileSync(state, JSON.stringify({ groups: [{ id: 'held', repo: slug, pr: 77,
        branch: 'lane/card-group-fixture', sources: [42, 43].map(num => ({ num, headSha: pr.headRefOid })),
        files: ['backlog/xfixture.md'] }], failed: {}, lastReconcileAt: Date.now() }));
      report.multi = await run(false, { prs, only: null, env });
      writeFileSync(state, JSON.stringify({ groups: [], failed: {}, lastReconcileAt: Date.now() }));
      const first = await run(false, { env });
      const second = await run(false, { env });
      report.first = first.calls;
      report.second = second.calls;
      report.merged = first.report.merged;
      report.laterHeads = [];
      for (const head of ['b'.repeat(40), 'd'.repeat(40)]) {
        pr.headRefOid = head;
        pr.commits[0].oid = head;
        pr.statusCheckRollup = pr.statusCheckRollup.map(row => ({ ...row, head_sha: head }));
        pr.comments[0].body = `<!-- reviewed-sha: ${head} -->`;
        report.laterHeads.push((await run(false, { env })).calls);
      }
      // Review-coverage bypass: a fresh PR whose acceptance names an OTHER commit must be held, never rebuilt and restamped.
      const fresh = (number, reviewed) => {
        const head = 'c'.repeat(40);
        const copy = structuredClone(pr);
        Object.assign(copy, { number, id: `PR_${number}`, headRefName: `lane/readme-${number}`, headRefOid: head });
        copy.commits[0].oid = head;
        copy.statusCheckRollup = copy.statusCheckRollup.map(row => ({ ...row, head_sha: head }));
        copy.comments[0].body = `<!-- reviewed-sha: ${reviewed ?? head} -->`;
        return withJob(copy);
      };
      writeFileSync(state, JSON.stringify({ groups: [], failed: {}, lastReconcileAt: Date.now() }));
      report.uncovered = (await run(false, { prs: [fresh(47, 'a'.repeat(40))], only: null, env })).calls;
      report.covered = (await run(false, { prs: [fresh(48)], only: null, env })).calls;
      // F1: a covered head whose gate still shows a REAL hold, or whose verdict cannot be read, is never rebuilt.
      const realHold = fresh(49);
      realHold.gateLog = gateLog({ codeql: 'CodeQL: 1 open alert' });
      const unreadable = fresh(50);
      delete unreadable.gateLog;
      report.realHold = (await run(false, { prs: [realHold], only: null, env })).calls;
      report.unreadableVerdict = (await run(false, { prs: [unreadable], only: null, env })).calls;
    }, { slug: CONSTELLATION_REPOS.we.slug });
    return report;
  },
  judge(report) {
    const violations = [];
    const pushes = calls => calls.filter(a => a[0] === 'git' && a[1] === 'push');
    for (const held of report.groupHolds) {
      if (held.calls.some(a => a[0] === 'git' && ['commit-tree', 'push'].includes(a[1]) || a[0] === 'node')
        || !held.aborted.some(row => row.reason.includes('card group')))
        violations.push(`${held.role} card-group state did not hold the head before mutation`);
    }
    if (pushes(report.first).length !== 1 || !report.first.some(a => a[0] === 'git' && a[1] === 'merge-tree'))
      violations.push('failed gate did not rebuild through the production refresh path');
    if (pushes(report.second).length) violations.push('same head refreshed twice');
    if (pushes(report.disabled).length) violations.push('zero pass budget still refreshed');
    if (pushes(report.fetchFailed).length) violations.push('fetched-head race reached a push');
    if (pushes(report.multi.calls).length !== 2
      || !report.multi.report.revalidationAborted.some(row => row.reason.includes('budget exhausted')))
      violations.push('held PRs consumed the shared budget or the per-pass cap was lost');
    if (report.laterHeads.some(calls => pushes(calls).length)) violations.push('later head reset the PR refresh bound');
    if (pushes(report.uncovered).length) violations.push('failed gate rebuilt a head the acceptance does not cover');
    if (pushes(report.covered).length !== 1) violations.push('covered failed-gate head was not rebuilt (control)');
    if (pushes(report.realHold).length) violations.push('failed gate rebuilt a head with a real (non-candidacy) hold');
    if (pushes(report.unreadableVerdict).length) violations.push('failed gate rebuilt a head whose verdict was unreadable');
    if (report.merged.length) violations.push('repair changed the original skip into a merge');
    if ([...report.first, ...report.second].some(a => a.includes('PUT') || (a[0] === 'api' && a[1] === 'graphql' && a.some(x => x.startsWith('query=mutation')))))
      violations.push('repair bypassed the refresh path');
    return violations;
  },
};
