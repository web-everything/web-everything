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
    const headRefOid = 'a'.repeat(40);
    const now = Date.now();
    const advisory = { author: { login: 'chalbert' }, createdAt: new Date(now - 180_000).toISOString(),
      body: `<!-- we:red-team-advisory pr=7099 rev=${headRefOid} -->` };
    const gate = { author: advisory.author,
      body: `<!-- we:red-team-gate pr=7099 rev=${headRefOid} outcome=clear -->` };
    const comments = [gate, advisory];
    for (const [verdict, expectedReview, expectedStatus, prFields = {}, agentFields = {}] of [
      [accepted, null, 'ready-to-merge'],
      [accepted, null, 'ready-to-merge', { comments: [
        { ...gate, body: gate.body.replace('outcome=clear', 'outcome=card-queued') }, advisory] }],
      ...[gate, advisory].flatMap(target => [
        [accepted, 'reviewing', 'red-team', { comments: comments.map(c => c === target ? { ...c, body: `quoted\n${c.body}` } : c) }],
        [accepted, 'reviewing', 'red-team', { comments: comments.map(c => c === target ? { ...c, body: c.body.replace('pr=7099', 'pr=7105') } : c) }],
      ]),
      ...['sent-back', 'round-cap'].map(outcome => [accepted, 'reviewing', 'red-team',
        { comments: [...comments, { ...gate, body: gate.body.replace('outcome=clear', `outcome=${outcome}`) }] }]),
      [accepted, 'reviewing', 'red-team', {}, { startedAt: now - 150_000 }],
      [accepted, 'reviewing', 'red-team', {}, { startedAt: undefined, updatedAt: now - 600_000 }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, createdAt: undefined }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, createdAt: new Date(now - 60_000).toISOString() }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, author: { login: 'stranger' } }] }],
      [accepted, 'reviewing', 'red-team', { comments: [gate, { ...advisory, body: advisory.body.replace(headRefOid, 'b'.repeat(40)) }] }],
      [accepted, 'reviewing', 'red-team', { headRefOid: 'b'.repeat(40) }],
      [accepted, 'reviewing', 'red-team', { headRefOid: undefined }],
      [accepted, 'reviewing', 'red-team', { comments: undefined }],
      [accepted, 'reviewing', 'red-team', {}, { startedAt: undefined }],
      [accepted, 'review-stalled', 'red-team', { comments: [] }, { state: 'blocked' }],
      [accepted, 'review-stalled', 'red-team', {}, { state: 'blocked', startedAt: undefined }],
      [['review:accepted'], 'reviewing', 'red-team'],
      [[...accepted, 'review:pending'], 'reviewing', 'red-team'],
      [[...accepted, 'review:human'], 'reviewing', 'red-team'],
      [['review:pending'], 'reviewing', 'awaiting-review'],
      [['review:human'], 'reviewing', 'awaiting-review'],
    ]) {
      let labels = [...verdict, `review-status:${agentFields.state === 'blocked' ? 'review-stalled' : 'reviewing'}`, 'status:awaiting-review'];
      const provider = {
        readLabels: () => labels.map(name => ({ name })), ensureLabel: () => {},
        setLabels: (_repo, _pr, { add, remove }) => {
          labels = labels.filter(name => !remove.includes(name));
          if (add && !labels.includes(add)) labels.push(add);
        },
      };
      const result = tagReviewStatus({ pr: 7099, repo: 'we', provider,
        agents: [{ name: 'review-7099', state: 'working', pid: 7099,
          startedAt: now - 600_000, ...agentFields }],
        prState: { number: 7099, state: 'OPEN', isDraft: false, baseRefName: 'main',
          headRefOid, mergeable: 'MERGEABLE', comments,
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...prFields },
        readFixClaim: () => null, planRows: [], requiredChecks: ['test'],
        prStatusSettings: { acceptedRedTeamStatus: 'red-team' }, signalFix: () => {},
      });
      const name = `${verdict.join(',')} head=${prFields.headRefOid ?? headRefOid} evidence=${JSON.stringify([prFields, agentFields])}`;
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
