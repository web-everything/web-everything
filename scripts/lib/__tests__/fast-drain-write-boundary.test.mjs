import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as scope from '../../lib/fast-drain-scope.mjs';
import { buildEnqueueArgs } from '../merge-queue-enqueue.mjs';
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
test('Git allowlist refuses mutating subverbs and flags before executing', () => {
  const calls = [];
  const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
  for (const args of [
    ['config', 'core.hooksPath', 'unsafe'], ['config', '--get', 'x', '--unset'],
    ['remote', 'set-url', 'origin', 'unsafe'], ['remote', 'get-url', '--add', 'origin'],
    ['config', 'set', 'core.hooksPath', 'unsafe'], ['commit-graph', 'write'],
    ['diff', '--output=unsafe'], ['show', '--output', 'unsafe'], ['log', '--output=unsafe'],
    ['rev-parse', '--sq-quote', '--output=unsafe'], ['fetch', '--upload-pack=unsafe', 'origin'],
  ]) assert.throws(() => exec('git', args), /write-boundary:git/);
  assert.deepEqual(calls, []);
  exec('git', ['remote', 'get-url', 'origin']);
  exec('git', ['config', '--get', 'remote.origin.url']);
  assert.equal(calls.length, 2);
});

test('net-diff fetch accepts branch shorthand only with origin tracking destinations', () => {
  const calls = [];
  const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
  exec('git', ['fetch', '--quiet', '--end-of-options', 'origin', '+main:refs/remotes/origin/main', 'lane/readme']);
  assert.equal(calls.length, 1);
  for (const ref of ['+main:refs/heads/main', '+main:refs/remotes/origin/other', '+main:refs/tags/main',
    'lane/readme:refs/heads/main', '--upload-pack=unsafe', '+refs/heads/main:refs/remotes/origin/other']) {
    assert.throws(() => exec('git', ['fetch', '--quiet', '--end-of-options', 'origin', ref]), /write-boundary:git/);
  }
  assert.equal(calls.length, 1);
});

test('net-diff isolation accepts the producer directory and inert output flags', () => {
  const calls = [];
  const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
  exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir']);
  exec('git', ['diff', '--no-textconv', '--no-ext-diff', '--no-color', '--numstat', '--end-of-options', HEAD, 'origin/lane/readme']);
  exec('git', ['log', '--no-textconv', '--no-ext-diff', '--no-color', '--numstat', '--diff-merges=first-parent', '--pretty=format:', '--end-of-options', `origin/main..${HEAD}`, '--']);
  assert.equal(calls.length, 3);
});

test('all repository selector forms bind label edits to the authorized repository', () => {
  for (const selector of [['-R', 'fixture/other'], ['--repo', 'fixture/other'], ['-R=fixture/other'], ['--repo=fixture/other']]) {
    const calls = [];
    const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
    assert.throws(() => exec('gh', ['pr', 'edit', '7', ...selector, '--add-label', 'review:changes']), /write-boundary:other-pr/);
    assert.deepEqual(calls, []);
  }
});

test('PR edits allow only label membership flags, including equals forms', () => {
  for (const flag of ['-B', '-b', '-F', '-t', '--base', '--body', '--body-file', '--title']) {
    for (const extra of [[flag, 'unsafe'], [`${flag}=unsafe`]]) {
      const calls = [];
      const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
      assert.throws(() => exec('gh', ['pr', 'edit', '7', '--add-label', 'review:changes', ...extra]), /write-boundary:(pr-edit|retarget)/);
      assert.deepEqual(calls, []);
    }
  }
  const calls = [];
  const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
  exec('gh', ['pr', 'edit', '7', `-R=${REPO}`, '--add-label=red-team:clear', '--remove-label=red-team:pending']);
  assert.equal(calls.length, 1);
});

test('API compact method, field and input flags cannot hide a mutation', () => {
  for (const args of [
    ['repos/fixture/repo/actions/runs/1', '--method=DELETE'],
    ['repos/fixture/repo/actions/runs/1', '-XPOST'],
    ['graphql', '-fquery=mutation { deleteIssue(input:{id:"other"}) { clientMutationId } }'],
    ['graphql', '-Fquery=mutation { deleteIssue(input:{id:"other"}) { clientMutationId } }'],
    ['graphql', '--field=query=mutation { deleteIssue(input:{id:"other"}) { clientMutationId } }'],
    ['graphql', '--raw-field=query=mutation { deleteIssue(input:{id:"other"}) { clientMutationId } }'],
    ['graphql', '--input=payload.json'], ['repos/fixture/repo', '-fkey=value'],
    ['graphql', '-f', 'query=query { viewer { login } }', '--method=DELETE'],
  ]) {
    const calls = [];
    const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((...a) => calls.push(a));
    assert.throws(() => exec('gh', ['api', ...args]), /write-boundary:(api|graphql)/);
    assert.deepEqual(calls, []);
  }
});

test('enqueue command is bound to the live authorized node id and judged head', () => {
  for (const patch of [{ nodeId: 'UNRELATED_PR' }, { headSha: 'b'.repeat(40) }, {}]) {
    const writes = [];
    const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
    const exec = b.exec((file, args) => {
      if (args[0] === 'pr') return JSON.stringify({ id: 'PR7', headRefOid: HEAD, baseRefName: 'main' });
      writes.push(args);
    });
    // An unbound command refuses even when its shape is correct.
    if (!Object.keys(patch).length) {
      assert.throws(() => exec('gh', buildEnqueueArgs({ nodeId: 'PR7', headSha: HEAD })), /write-boundary:graphql/);
    } else {
      b.authorizeEnqueue(REPO, 7, HEAD);
      exec('gh', ['pr', 'view', '7', '--repo', REPO, '--json', 'id,headRefOid,baseRefName']);
      assert.throws(() => exec('gh', buildEnqueueArgs({ nodeId: 'PR7', headSha: HEAD, ...patch })), /write-boundary:graphql/);
    }
    assert.deepEqual(writes, []);
  }
  const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  const writes = [];
  const exec = b.exec((file, args) => args[0] === 'pr' ? JSON.stringify({ id: 'PR7', headRefOid: HEAD, baseRefName: 'main' }) : writes.push(args));
  b.authorizeEnqueue(REPO, 7, HEAD);
  exec('gh', ['pr', 'view', '7', '--repo', REPO, '--json', 'id,headRefOid,baseRefName']);
  exec('gh', buildEnqueueArgs({ nodeId: 'PR7', headSha: HEAD }));
  assert.equal(writes.length, 1);
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
