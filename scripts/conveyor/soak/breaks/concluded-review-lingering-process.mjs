/** Concluded head reviews must not stay busy because their process lingers. */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATH = 'scripts/conveyor/review-status-tag.mjs';

export default {
  id: 'concluded-review-lingering-process',
  title: 'accepted and red-team-clear review with a lingering pid clears reviewing',
  card: 'soak-declaration: PRs 7099/7092/7105 lingering review processes',
  fixedBy: { sha: 'HEAD', where: 'review-status-tag.mjs', paths: [PATH] },
  // Behaviour-decided: run/judge must pass even if the implementation is reverted.
  fixPresent() { return true; },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { tagReviewStatus } = await import(pathToFileURL(join(sourceRoot, PATH)).href);
    const violations = [];
    const check = (ok, name) => {
      if (!ok) violations.push(name);
      log?.(`${name}: ${ok ? 'pass' : 'FAIL'}`);
    };
    const accepted = ['review:accepted', 'red-team:clear'];
    for (const [verdict, expectedReview, expectedStatus] of [
      [accepted, null, 'ready-to-merge'],
      [['review:accepted'], 'reviewing', 'red-team'],
      [[...accepted, 'review:pending'], 'reviewing', 'red-team'],
      [[...accepted, 'review:human'], 'reviewing', 'red-team'],
      [['review:pending'], 'reviewing', 'awaiting-review'],
      [['review:human'], 'reviewing', 'awaiting-review'],
    ]) {
      let labels = [...verdict, 'review-status:reviewing', 'status:awaiting-review'];
      const provider = {
        readLabels: () => labels.map(name => ({ name })), ensureLabel: () => {},
        setLabels: (_repo, _pr, { add, remove }) => {
          labels = labels.filter(name => !remove.includes(name));
          if (add && !labels.includes(add)) labels.push(add);
        },
      };
      const result = tagReviewStatus({ pr: 7099, repo: 'we', provider,
        agents: [{ name: 'review-7099', state: 'working', pid: 7099,
          startedAt: Date.now() - 600_000 }],
        prState: { number: 7099, state: 'OPEN', isDraft: false, baseRefName: 'main',
          headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', comments: [],
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
        readFixClaim: () => null, planRows: [], requiredChecks: ['test'],
        prStatusSettings: { acceptedRedTeamStatus: 'red-team' }, signalFix: () => {},
      });
      const name = verdict.join(',');
      check(result.label === (expectedReview ? `review-status:${expectedReview}` : null), `${name}: review result`);
      check(JSON.stringify(labels.filter(label => label.startsWith('review-status:')))
        === JSON.stringify(expectedReview ? [`review-status:${expectedReview}`] : []), `${name}: review labels`);
      check(result.prStatus === `status:${expectedStatus}`, `${name}: status result`);
      check(JSON.stringify(labels.filter(label => label.startsWith('status:')))
        === JSON.stringify([`status:${expectedStatus}`]), `${name}: status labels`);
    }
    return { violations };
  },
  judge: report => report.violations,
};
