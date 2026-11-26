import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import * as scope from '../../lib/fast-drain-scope.mjs';
import { buildEnqueueArgs } from '../merge-queue-enqueue.mjs';
import { provisionMissingSiblingClones } from '../sibling-clone-provision.mjs';
import { sendBackBlockedGates } from '../drain-blocked-reason.mjs';
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
      assert.throws(() => exec('gh', ['pr', 'edit', '7', '--repo', REPO, '--add-label', 'review:changes', ...extra]), /write-boundary:(pr-edit|retarget)/);
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

test('implicit foreign GH_REPO identity reads are refused without binding an enqueue node id', () => {
  const calls = [];
  const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  const exec = b.exec((file, args) => {
    calls.push(args);
    return JSON.stringify({ id: 'FOREIGN_PR7', headRefOid: HEAD, baseRefName: 'main' });
  });
  b.authorizeEnqueue(REPO, 7, HEAD);
  assert.throws(() => exec('gh', ['pr', 'view', '7', '--json', 'id,headRefOid,baseRefName'],
    { env: { GH_REPO: 'fixture/other' } }), /write-boundary:other-pr/);
  assert.throws(() => exec('gh', buildEnqueueArgs({ nodeId: 'FOREIGN_PR7', headSha: HEAD })), /write-boundary:graphql/);
  assert.deepEqual(calls, []);
  assert.deepEqual(b.violations, ['defer-to-pass:write-boundary:other-pr', 'defer-to-pass:write-boundary:graphql']);
});

test('implicit same-repo GH_REPO identity reads still authorize the pinned enqueue', () => {
  const calls = [];
  const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
  const exec = b.exec((file, args) => {
    calls.push(args);
    return JSON.stringify({ id: 'PR7', headRefOid: HEAD, baseRefName: 'main' });
  });
  b.authorizeEnqueue(REPO, 7, HEAD);
  const view = ['pr', 'view', '7', '--json', 'id,headRefOid,baseRefName'];
  const enqueue = buildEnqueueArgs({ nodeId: 'PR7', headSha: HEAD });
  exec('gh', view, { env: { GH_REPO: REPO } });
  exec('gh', enqueue);
  assert.deepEqual(calls, [view, enqueue]);
  assert.deepEqual(b.violations, []);
});

test.each([
  ['command env overrides process env and cwd', { GH_REPO: REPO }, 'fixture/other', 'fixture/other', [], true],
  ['foreign command env overrides process env and cwd', { GH_REPO: 'fixture/other' }, REPO, REPO, [], false],
  ['missing command env uses process env', undefined, REPO, 'fixture/other', [], true],
  ['foreign process env overrides cwd', undefined, 'fixture/other', REPO, [], false],
  ['empty command env uses cwd rather than process env', {}, 'fixture/other', REPO, [], true],
  ['foreign cwd is refused', {}, REPO, 'fixture/other', [], false],
  ['unresolved repo is refused', {}, REPO, null, [], false],
  ['explicit long selector overrides env', { GH_REPO: 'fixture/other' }, REPO, null, ['--repo', REPO], true],
  ['explicit short selector overrides cwd', {}, REPO, 'fixture/other', ['-R', REPO], true],
  ['explicit equals selector overrides env', { GH_REPO: 'fixture/other' }, REPO, null, [`--repo=${REPO}`], true],
  ['explicit short equals selector overrides env', { GH_REPO: 'fixture/other' }, REPO, null, [`-R=${REPO}`], true],
  ['explicit compact selector overrides env', { GH_REPO: 'fixture/other' }, REPO, null, [`-R${REPO}`], true],
  ['foreign explicit selector overrides same-repo env', { GH_REPO: REPO }, REPO, REPO, ['--repo', 'fixture/other'], false],
  ['repeated selectors cannot hide a foreign repo', { GH_REPO: REPO }, REPO, REPO, ['-R', 'fixture/other', '--repo', REPO], false],
])('writes and identity reads share repo resolution: %s', (name, env, processRepo, origin, selector, allowed) => {
  const priorRepo = process.env.GH_REPO;
  process.env.GH_REPO = processRepo;
  try {
    for (const verb of ['edit', 'view']) {
      const calls = [];
      const b = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 });
      const exec = b.exec((file, args, options) => {
        if (file === 'git') {
          assert.equal(options.cwd, '/fixture/checkout');
          if (!origin) throw new Error('no origin');
          return 'https://github.com/' + origin + '.git';
        }
        calls.push(args);
        return JSON.stringify({ id: 'PR7', headRefOid: HEAD, baseRefName: 'main' });
      });
      b.authorizeEnqueue(REPO, 7, HEAD);
      const args = ['pr', verb, '7', ...selector,
        ...(verb === 'edit' ? ['--add-label', 'review:changes'] : ['--json', 'id,headRefOid,baseRefName'])];
      const run = () => exec('gh', args, { cwd: '/fixture/checkout', ...(env === undefined ? {} : { env }) });
      if (allowed) {
        run();
        if (verb === 'view') exec('gh', buildEnqueueArgs({ nodeId: 'PR7', headSha: HEAD }));
      } else {
        assert.throws(run, /write-boundary:other-pr/);
        if (verb === 'view') assert.throws(() => exec('gh', buildEnqueueArgs({ nodeId: 'PR7', headSha: HEAD })), /write-boundary:graphql/);
      }
      assert.equal(calls.length, allowed ? verb === 'view' ? 2 : 1 : 0);
    }
  } finally {
    if (priorRepo === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = priorRepo;
  }
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

// Execute the production call sites with recording ports: these helpers own executors
// outside the boundary, so checking the boundary helper alone misses the bypasses.
const drainSource = readFileSync(resolve(process.cwd(), 'scripts/merge-ai-prs.mjs'), 'utf8');
const strategySource = readFileSync(resolve(process.cwd(), 'scripts/lib/drain-merge-strategy.mjs'), 'utf8');
function drainSection(start, end, source = drainSource) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing drain section: ${start}`);
  return source.slice(from, to);
}

function productionGuardedHelper(boundary) {
  const source = drainSection('const guardedHelper =', 'const mergePr =');
  return Function('drainWriteContext', `${source} return guardedHelper;`)({ getStore: () => ({ boundary }) });
}

test('enqueue-only defers send-back without calling its private writer; full pass still calls it', () => {
  const source = drainSection('  if (!DRY_RUN) {\n    try {\n      const sendBacks =', "  __t.add('classifyGateReads'");
  for (const writeScope of ['enqueue-only', 'full']) {
    for (const failedChecks of [true, false]) {
      const calls = [];
      const boundary = scope.createFastDrainWriteBoundary({ writeScope, repo: REPO, num: 7 });
      const ports = { DRY_RUN: false, guardedHelper: productionGuardedHelper(boundary), sendBackBlockedGates,
        sendBackBlockedGate: () => { calls.push('send-back'); return { sent: true }; },
        prsByRepo: new Map([[null, [{ number: 7 }]]]),
        verdicts: failedChecks ? [{ repo: null, num: 7, decision: 'skip', reason: 'required check "test" FAILURE' }] : [],
        queueRequiredChecksOf: () => ['test'], localSlug: REPO, repoTag: () => '',
        isLocalRepo: () => true, siblingCloneDir() {}, join: (...parts) => parts.join('/'), dirname: () => 'fixture',
        refreshedStatePath: () => 'fixture/state.json', process: { stderr: { write() {} } } };
      Function(...Object.keys(ports), source)(...Object.values(ports));
      assert.deepEqual(calls, writeScope === 'full' && failedChecks ? ['send-back'] : []);
      assert.deepEqual(boundary.violations, writeScope === 'enqueue-only' && failedChecks ? ['defer-to-pass:write-boundary:send-back'] : []);
      for (const kind of boundary.violations) assert.equal(scope.requireFastDrainDeferKind(kind), kind);
    }
  }
});

test('enqueue-only defers collision repair without calling its private writer; full pass still calls it', () => {
  const source = drainSection('  const mergeStrategy = createDrainMergeStrategy(', '  const prestageCache =');
  for (const writeScope of ['enqueue-only', 'full']) {
    const calls = [];
    const boundary = scope.createFastDrainWriteBoundary({ writeScope, repo: REPO, num: 7 });
    const healLaneRefs = () => { calls.push('lane-repair'); return { actions: [] }; };
    const ports = { guardedHelper: productionGuardedHelper(boundary), healLaneRefs,
      createDrainMergeStrategy: options => {
        const source = drainSection('      const poison = guardEnqueue(', '      if (poison)', strategySource);
        const ports = { c: { num: 7 }, headSha: HEAD, slugOf: () => REPO, exec() {}, cwd: 'fixture', primary: 'primary',
          heal: options.heal, log: { write() {} }, env: {},
          guardEnqueue: options => (options.heal ?? healLaneRefs)('fixture', {}) };
        return Function(...Object.keys(ports), source)(...Object.values(ports));
      },
      resolvedMergePolicy: {}, DRY_RUN: false, AS_JSON: false, isLocalRepo: () => true, localSlug: REPO, isMainFix() {},
      writeScope, enqueueOnly: writeScope === 'enqueue-only', onlyPr: 7, writeBoundary: boundary, fastDrainValidatedBase: 'main',
      withLandWriteLock() {}, resolvePrimaryPath: () => 'primary', process: { cwd: () => 'fixture' }, flags: {}, env: {} };
    const run = () => Function(...Object.keys(ports), source)(...Object.values(ports));
    if (writeScope === 'enqueue-only') assert.throws(run, /defer-to-pass:write-boundary:lane-repair/);
    else run();
    assert.deepEqual(calls, writeScope === 'full' ? ['lane-repair'] : []);
    assert.deepEqual(boundary.violations, writeScope === 'full' ? [] : ['defer-to-pass:write-boundary:lane-repair']);
    for (const kind of boundary.violations) assert.equal(scope.requireFastDrainDeferKind(kind), kind);
  }
});

test('enqueue-only skips hash repair on main even when the queue probe finds hash cards', () => {
  const source = drainSection('  let numbered = { assigned: [], committed: false };', '  if (landedLocal && !DRY_RUN) {');
  for (const writeScope of ['enqueue-only', 'full']) {
    const calls = [];
    const ports = { writeBoundary: scope.createFastDrainWriteBoundary({ writeScope, repo: REPO, num: 7 }),
      mergeStrategy: { enqueues: () => true }, DRY_RUN: false, localWriteRefusal: null, landedLocal: false,
      process: { cwd: () => 'fixture' }, probeQueuedLand: () => ({ assigned: [], files: ['backlog/xhash.md'] }),
      repairHashOnMain: () => { calls.push('repair'); return { assigned: [], committed: true }; } };
    Function(...Object.keys(ports), source)(...Object.values(ports));
    assert.deepEqual(calls, writeScope === 'full' ? ['repair'] : []);
  }
});

test('enqueue-only skipped detached follow-up cannot enable inline work for an already merged target', async () => {
  const source = drainSection('  const followup = await writeBoundary.fullPassDuty(', "  // The pass's OWN checkout");
  for (const writeScope of ['enqueue-only', 'full']) {
    const calls = [];
    const ports = { writeBoundary: scope.createFastDrainWriteBoundary({ writeScope, repo: REPO, num: 7 }),
      enqueueOnly: writeScope === 'enqueue-only', DRY_RUN: false, localWriteRefusal: null,
      merged: [{ num: 7, repo: REPO }], isLocalRepo: repo => repo === REPO,
      __t: { mark: () => 0 }, process: { stderr: { write() {} } },
      handOffDrainFollowup: () => { calls.push('handoff'); return { handedOff: false }; } };
    const state = await Function(...Object.keys(ports), `return (async () => {${source}
      return { landedLocal, landedLocalAny }; })();`)(...Object.values(ports));
    assert.equal(state.landedLocal, writeScope === 'full');
    assert.equal(state.landedLocalAny, writeScope === 'full');
    assert.deepEqual(calls, writeScope === 'full' ? ['handoff'] : []);
  }
});

test('a later boundary refusal preserves confirmed enqueues and defers only an unconfirmed target', () => {
  const source = drainSection('  if (enqueueOutcomes.length) result.enqueueOutcomes = enqueueOutcomes;', '  if (localWriteRefusal) result.localWriteRefusal');
  const admitted = { num: 7, repo: REPO, outcome: 'enqueued', already: false };
  const peer = { num: 7, repo: 'fixture/peer', outcome: 'enqueued' };
  const violation = { num: 7, repo: REPO, outcome: 'not-enqueued', enqueued: false, deferred: true,
    kind: 'defer-to-pass:write-boundary:refresh' };
  for (const [outcomes, expected] of [
    [[admitted], [admitted]],
    [[admitted, peer], [admitted, peer]],
    [[peer], [peer, violation]],
    [[], [violation]],
  ]) {
    const ports = { result: {}, enqueueOutcomes: [...outcomes], onlyPr: 7, onlyRepo: REPO, localSlug: REPO,
      writeBoundary: { violations: [violation.kind] }, requireFastDrainDeferKind: scope.requireFastDrainDeferKind };
    Function(...Object.keys(ports), source)(...Object.values(ports));
    assert.deepEqual(ports.result.enqueueOutcomes, expected);
  }
});

test('implicit PR writes resolve GH_REPO before cwd and refuse unknown repositories', () => {
  for (const [envRepo, origin, allowed] of [
    ['fixture/other', REPO, false], [REPO, 'fixture/other', true],
    [undefined, 'fixture/other', false], [undefined, REPO, true], [undefined, null, false],
  ]) {
    const writes = [], reads = [];
    const exec = scope.createFastDrainWriteBoundary({ writeScope: 'enqueue-only', repo: REPO, num: 7 }).exec((file, args, options) => {
      if (file === 'git') {
        reads.push(options.cwd);
        if (!origin) throw new Error('no origin');
        return 'https://github.com/' + origin + '.git';
      }
      writes.push(args);
    });
    const run = () => exec('gh', ['pr', 'edit', '7', '--add-label', 'review:changes'],
      { cwd: '/fixture/checkout', env: { GH_REPO: envRepo } });
    if (allowed) run();
    else assert.throws(run, /write-boundary:other-pr/);
    assert.equal(writes.length, allowed ? 1 : 0);
    if (!envRepo) assert.deepEqual(reads, ['/fixture/checkout']);
  }
});

test('startup sibling provisioning defers through the boundary before reserving or populating a checkout', () => {
  const source = drainSection('  if (!siblingClonesChecked) {', '  // ── RED-MAIN');
  const dir = mkdtempSync(resolve(process.env.TMPDIR, 'sibling-boundary-'));
  try {
    for (const writeScope of ['enqueue-only', 'full']) {
      const boundary = scope.createFastDrainWriteBoundary({ writeScope, repo: REPO, num: 7 });
      const writes = [];
      const ports = { siblingClonesChecked: false, siblingProvisionFailures: [],
        writeBoundary: boundary, guardedHelper: productionGuardedHelper(boundary),
        DRY_RUN: false, env: {}, process: { cwd: () => resolve(dir, 'web-everything'), stderr: { write() {} } },
        execFileSync: boundary.exec(() => writes.push('exec')),
        provisionMissingSiblingClones: options => {
          if (writeScope === 'full') { writes.push('provision'); return { failed: [] }; }
          return provisionMissingSiblingClones({ ...options, run: options.run ?? (() => writes.push('populate')), exists: () => false, home: dir });
        } };
      Function(...Object.keys(ports), source)(...Object.values(ports));
      assert.deepEqual(writes, writeScope === 'full' ? ['provision'] : []);
      assert.equal(existsSync(resolve(dir, 'frontierui')), false);
      assert.equal(existsSync(resolve(dir, 'plateau-app')), false);
      assert.ok(writeScope === 'full' || boundary.violations.every(k => k === 'defer-to-pass:write-boundary:git'));
      assert.equal(boundary.violations.length > 0, writeScope === 'enqueue-only');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
