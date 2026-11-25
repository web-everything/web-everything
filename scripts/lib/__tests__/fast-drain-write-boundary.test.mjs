import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as scope from '../../lib/fast-drain-scope.mjs';
import { strategyFixture, HEAD, REPO } from './fixtures/fast-drain-strategy.mjs';

test('skipped sweeps never run', () => {
  const h = strategyFixture();
  h.strategy.dequeueSendBacks([{ number: 8, labels: ['review:changes'] }]);
  assert.deepEqual(h.strategy.collectQueueMerged({ merged: [], landedThisPass: new Set() }), []);
  assert.deepEqual(h.writes, []);
  const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  for (const duty of ['renamed-refresh', 'queued-numbering-sweep', 'dequeue-sweep', 'land-followup'])
    b.fullPassDuty(() => h.writes.push(duty));
  assert.deepEqual(h.writes, []);
});
test('each forbidden path gives write-boundary:<kind> with no call', () => {
  const calls = [];
  const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  const exec = b.exec((...args) => calls.push(args));
  for (const [kind, file, args] of [
    ['merge', 'gh', ['pr', 'merge', '7', '--repo', REPO]],
    ['refresh', 'gh', ['pr', 'update-branch', '7', '--repo', REPO]],
    ['numbering-push', 'git', ['push', 'origin', 'HEAD']],
    ['retarget', 'gh', ['pr', 'edit', '7', '--repo', REPO, '--base', 'main']],
    ['label-removal', 'gh', ['pr', 'edit', '7', '--repo', REPO, '--remove-label', 'review:changes']],
    ['other-pr', 'gh', ['pr', 'comment', '8', '--repo', REPO, '--body', 'hold']],
    ['other-pr', 'gh', ['pr', 'comment', '7', '--repo', 'fixture/peer', '--body', 'hold']],
    ['dequeue', 'gh', ['api', 'graphql', '-f', 'query=mutation { dequeuePullRequest(input:{pullRequestId:"PR7"}) { clientMutationId } }']],
    ['workflow-run', 'gh', ['run', 'cancel', '42', '--repo', REPO]],
    ['graphql', 'gh', ['api', 'graphql', '-f', 'query=mutation { deleteIssue(input:{id:"other"}) { clientMutationId } } # enqueuePullRequest expectedHeadOid']],
  ]) assert.throws(() => exec(file, args), new RegExp(`defer-to-pass:write-boundary:${kind}`));
  for (const kind of ['refresh', 'numbering-push', 'retarget', 'dequeue', 'post-conflict-finding'])
    assert.throws(() => b.helper(kind, () => calls.push(kind))(), new RegExp(`write-boundary:${kind}`));
  assert.deepEqual(calls, []);
});
test('the only label removal is red-team:pending alongside a red-team:clear publish', () => {
  const calls = [], b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  const provider = b.labelProvider({ ensureLabel() {}, setLabels: (...args) => calls.push(args) });
  provider.setLabels(REPO, 7, { add: 'red-team:clear', remove: ['red-team:pending'] });
  for (const plan of [{ add: 'red-team:blocked', remove: ['red-team:pending'] }, { add: null, remove: ['red-team:pending'] },
    { add: 'red-team:clear', remove: ['red-team:blocked'] }, { add: 'review:accepted', remove: [] }])
    assert.throws(() => provider.setLabels(REPO, 7, plan), /write-boundary:label/);
  assert.equal(calls.length, 1);
});
test('net-diff Git configuration permits reads without hiding a forbidden verb or config', () => {
  const calls = [], b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  const exec = b.exec((...args) => calls.push(args));
  exec('git', ['-c', 'core.quotepath=false', '-c', 'diff.external=', 'diff', '--no-ext-diff', HEAD]);
  assert.equal(calls.length, 1);
  assert.throws(() => exec('git', ['-c', 'core.quotepath=false', 'push', 'origin', HEAD]), /write-boundary:numbering-push/);
  assert.throws(() => exec('git', ['-c', 'alias.diff=!touch unsafe', 'diff']), /write-boundary:git/);
  assert.throws(() => exec('git', ['-c', 'core.sshCommand=unsafe', 'fetch', 'origin']), /write-boundary:git/);
  assert.equal(calls.length, 1);
});
test('clearance stamp only after a confirmed enqueue', () => {
  const h = strategyFixture();
  assert.equal(h.strategy.enqueue({ num: 7 }, HEAD).enqueued, true);
  assert.deepEqual(h.writes, ['enqueue', 'stamp']);
  const no = strategyFixture({ membership: () => JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: HEAD } } } }) });
  assert.throws(() => no.strategy.enqueue({ num: 7 }, HEAD), /unconfirmed/);
  assert.deepEqual(no.writes, ['enqueue']);
});
test('validator fails after a hold write: no non-hold write recorded', () => {
  const h = strategyFixture({ wait: true, comments: [], labels: ['ready-to-merge', 'review:accepted'],
    evidence: { scheduled: true, inFlight: true, loopPayload: { verdict: { verdict: 'accept' } } }, onLive: () => ({ headRefOid: HEAD, labels: ['ready-to-merge', 'review:accepted'] }) });
  assert.equal(h.strategy.enqueue({ num: 7 }, HEAD).enqueued, false);
  assert.ok(h.writes.some(w => w?.add === 'red-team:pending'));
  assert.ok(h.writes.every(w => w === 'ensure-label' || w?.add === 'red-team:pending'));
});
test('child killed before confirmation leaves no stamp', () => {
  const h = strategyFixture({ membership: mutated => {
    if (mutated) throw new Error('child killed before confirmation');
    return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: HEAD } } } });
  } });
  assert.throws(() => h.strategy.enqueue({ num: 7 }, HEAD));
  assert.deepEqual(h.writes, ['enqueue']);
  assert.ok(!h.state()?.pending?.some(p => p.clearanceHead));
});
