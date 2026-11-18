// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { assertCapability } from '../lib/repo-profile.mjs';

const source = readFileSync(new URL('../merge-ai-prs.mjs', import.meta.url), 'utf8');
const file = ts.createSourceFile('merge-ai-prs.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const callbacks = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === 'withLandWriteLock'
    && node.arguments[0]?.getText(file).includes("__t.time('mergeCall'")) callbacks.push(node.arguments[0]);
  ts.forEachChild(node, visit);
}
visit(file);

function landDispatch(repo, enqueues = false) {
  expect(callbacks).toHaveLength(1);
  const mergePr = vi.fn();
  const enqueue = vi.fn(() => ({ enqueued: true }));
  const branchPush = vi.fn(() => ({ ok: true }));
  const wiring = {
    c: { repo, num: 42 }, localSlug: 'we', traceHeadSha: 'a'.repeat(40),
    isPrAlreadyMerged: () => false, cardGrouping: { holdFor: () => null, mayHold: () => false },
    mergeStrategy: { enqueues: () => enqueues }, enqueueWithSameHeadGuard: enqueue,
    shouldPrepareBranchBeforeEnqueue: () => enqueues, branchPreparationRequired: () => true,
    prepareBranchBeforeEnqueue: branchPush, finishBranchPreparation: () => true,
    resolveCardNumbering: () => ({ value: { shadow: false } }), isLocalRepo: () => true,
    openReservationPr: () => true, openPrContext: {}, revalidationAborted: [],
    needsAcceptanceRestamp: new Set(), restampAcceptance: vi.fn(), approvedHeadHold: null,
    preread: { read: true, comments: [] }, withLandWriteLock: run => ({ result: run() }),
    assertCapability, mergePr, __t: { time: (_name, run) => run() },
  };
  const lockStatement = callbacks[0].parent.parent.parent.parent;
  const statements = [...lockStatement.parent.statements];
  const preparation = statements.findIndex(node => ts.isIfStatement(node)
    && node.expression.getText(file).startsWith('shouldPrepareBranchBeforeEnqueue('));
  expect(preparation).toBeGreaterThan(1);
  const admission = statements.findIndex(node => node.getText(file).startsWith('const refusal = assertCapability('));
  const freshness = statements.findIndex(node => node.getText(file).startsWith('if (!(await mergeQueueGate('));
  expect(admission).toBeLessThan(freshness);
  expect(freshness).toBeLessThan(preparation);
  const dispatchSource = [...statements.slice(admission, admission + 2), ...statements.slice(preparation, statements.indexOf(lockStatement) + 1)]
    .map(node => node.getText(file)).join('\n');
  const run = new Function(...Object.keys(wiring), `for (const candidate of [null]) { ${dispatchSource} return landLock.result; }`);
  return { run: () => run(...Object.values(wiring)), mergePr, enqueue, branchPush };
}

describe('direct land dispatch capability admission', () => {
  it.each(['longshore', 'unknown/repo'])('refuses %s before mergePr or successful land bookkeeping', repo => {
    const f = landDispatch(repo);
    expect(f.run).toThrow(expect.objectContaining({
      enqueueFailure: expect.objectContaining({ kind: 'unsupported-repo', repo }),
    }));
    expect(f.mergePr).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each(['we', 'frontierui', 'plateau-app', undefined])('keeps supported direct merge unchanged: %s', repo => {
    const f = landDispatch(repo);
    expect(f.run()).toEqual({ merged: true });
    expect(f.mergePr).toHaveBeenCalledTimes(1);
    expect(f.mergePr).toHaveBeenCalledWith({
      pr: 42, repo, method: 'merge', matchHeadCommit: 'a'.repeat(40), caller: 'drain',
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe('enqueue branch preparation capability admission', () => {
  it.each(['longshore', 'unknown/repo'])('refuses %s before any branch preparation push or enqueue', repo => {
    const f = landDispatch(repo, true);
    expect(f.run).toThrow(expect.objectContaining({
      enqueueFailure: expect.objectContaining({ kind: 'unsupported-repo', repo }),
    }));
    expect(f.branchPush).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.mergePr).not.toHaveBeenCalled();
  });

  it('prepares and enqueues a supported repo', () => {
    const f = landDispatch('we', true);
    expect(f.run()).toEqual({ enqueued: true });
    expect(f.branchPush).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.mergePr).not.toHaveBeenCalled();
  });
});

// Execute the shipped boundary statements with injected effects; no Git/GitHub/model IO.
const nodes = [];
function collect(node) { nodes.push(node); ts.forEachChild(node, collect); }
collect(file);
const declaration = name => nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(file) === name);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function compile(body, wiring, async = false) {
  const run = new (async ? AsyncFunction : Function)(...Object.keys(wiring), body);
  return () => run(...Object.values(wiring));
}
function guardedStatements(action) {
  const node = nodes.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.length === 1
    && n.declarationList.declarations[0].name.getText(file) !== 'probe'
    && n.declarationList.declarations[0].initializer?.getText(file).startsWith(action));
  expect(node, action).toBeTruthy();
  const statements = [...node.parent.statements];
  const at = statements.indexOf(node);
  expect(statements[at - 2].getText(file)).toContain('assertCapability');
  return statements.slice(at - 2, at + 1).map(n => n.getText(file)).join('\n');
}

describe('lander write path inventory', () => {
  it.each(['healNnnCollision({ laneRef: v.headRef', 'rebaseDropManifest({'])('%s refuses capability-off before branch push / CI restart', action => {
    const push = vi.fn(() => ({ action: 'rebased' }));
    const run = compile(`for (const v of [{repo: 'longshore', headRef: 'lane/x'}]) { ${guardedStatements(action)} }`, {
      assertCapability, localSlug: 'we', healNnnCollision: push, rebaseDropManifest: push,
      laneRef: 'lane/x', HEAL_COLLISION: true, gitRunner: vi.fn(), cloneDir: undefined,
    });
    run();
    expect(push).not.toHaveBeenCalled();
  });

  it('shared freshness/workflow/stale-merge refresh refuses capability-off before push or CI rerun', () => {
    const push = vi.fn(), rerun = vi.fn();
    const checked = vi.fn(() => { push(); rerun(); });
    const run = compile(`return (${declaration('refreshApprovedHead').initializer.getText(file)})({repo: 'longshore', num: 42}, {});`, {
      assertCapability, localSlug: 'we', refreshApprovedHeadChecked: checked,
    });
    expect(run()).toMatchObject({ ok: false, action: 'unsupported-repo' });
    expect(checked).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
  });

  it.each([true, false])('merge-queue freshness (couple precheck=%s) reaches admission before refresh push / CI rerun', async precheck => {
    const push = vi.fn(), rerun = vi.fn(), aborts = [];
    const refresh = compile(`return (${declaration('refreshApprovedHead').initializer.getText(file)})({repo: 'longshore', num: 42}, {});`, {
      assertCapability, localSlug: 'we', refreshApprovedHeadChecked: () => { push(); rerun(); },
    });
    const run = compile(`return (${declaration('mergeQueueGate').initializer.getText(file)})({repo: 'longshore', num: 42}, 'a', {precheck: ${precheck}});`, {
      mergeQueueHookEnabled: () => true, MERGE_QUEUE: {freshness: {maxAgeMinutes: 60}}, mergeStrategy: {queueOwnsFreshness: () => false},
      localSlug: 'we', couplePins: new Map(), readMergeFreshnessFacts: () => ({errors: [], pr: {}, main: {}}),
      REQUIRED: 'test', defaultBranchOf: () => 'main', decideMergeQueueAction: () => ({action: 'refresh', reasons: []}),
      readRefreshed: () => ({}), MERGE_QUEUE_STATE: {}, AS_JSON: true, couplePinExcuses: () => false,
      isLocalRepo: () => true, DRY_RUN: false, refreshApprovedHead: refresh,
      revalidationAborted: aborts,
    }, true);
    expect(await run()).toBe(false);
    expect(aborts[0].reason).toContain('unsupported-repo');
    expect(push).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
  });

  it.each(['handleRequiredWorkflowsRefusal', 'handleStaleMergeGate'])('%s wires recovery to admission before any refresh push or rerun', route => {
    const call = nodes.find(n => ts.isCallExpression(n) && n.expression.getText(file) === route);
    const callback = call.arguments[0].properties.find(n => n.name?.getText(file) === 'refreshStalePr').initializer;
    const push = vi.fn(), rerun = vi.fn();
    const refreshApprovedHead = (v, options) => compile(`return (${declaration('refreshApprovedHead').initializer.getText(file)})(v, options);`, {
      v, options, assertCapability, localSlug: 'we', refreshApprovedHeadChecked: () => {push(); rerun();},
    })();
    const result = compile(`return (${callback.getText(file)})({});`, {c: {repo: 'longshore'}, refreshApprovedHead})();
    expect(result).toMatchObject({ok: false, action: 'unsupported-repo'});
    expect(push).not.toHaveBeenCalled();
    expect(rerun).not.toHaveBeenCalled();
  });

  it('renamed-card refresh refuses capability-off before branch refresh / CI restart', async () => {
    const refresh = vi.fn();
    const node = nodes.find(n => ts.isIfStatement(n) && n.getText(file).includes('await runRenamedPrRefresh('));
    const statements = [...node.parent.statements], at = statements.indexOf(node);
    const run = compile(statements.slice(at - 2, at + 1).map(n => n.getText(file)).join('\n'), {
      assertCapability, localSlug: 'longshore', log: { write: vi.fn() }, REPOS: [null], isLocalRepo: () => true,
      runRenamedPrRefresh: refresh,
    }, true);
    await run();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('green-event pre-stage refuses capability-off before publishing coverage or retargeting branches', () => {
    const publish = vi.fn(), retarget = vi.fn();
    const run = compile(`return (${declaration('announceAndRetargetBeforeLand').initializer.getText(file)})({repo: 'longshore'}, {preread: {read: true, comments: []}});`, {
      assertCapability, localSlug: 'we', postDrainReasonComment: publish, retargetStackedPrs: retarget,
    });
    expect(run()).toMatchObject({ skipped: 'unsupported-repo' });
    expect(publish).not.toHaveBeenCalled();
    expect(retarget).not.toHaveBeenCalled();
  });

  it('queued-hash sweep refuses capability-off branch numbering after leaving dequeue available', () => {
    const prepare = nodes.find(n => ts.isPropertyAssignment(n) && n.name.getText(file) === 'prepare'
      && ts.isArrowFunction(n.initializer));
    const push = vi.fn();
    const run = compile(`return (${prepare.initializer.getText(file)})({});`, {
      assertCapability, localSlug: 'longshore', prepareBranchBeforeEnqueue: push,
    });
    expect(run()).toMatchObject({action: 'skip', reason: expect.stringContaining('capability unavailable')});
    expect(push).not.toHaveBeenCalled();
  });

  it('card grouping refuses capability-off before group branch push or PR publication', () => {
    const form = nodes.find(n => ts.isPropertyAssignment(n) && n.name.getText(file) === 'form'
      && ts.isArrowFunction(n.initializer));
    const push = vi.fn(), publish = vi.fn();
    const run = compile(`return (${form.initializer.getText(file)})({});`, {
      assertCapability, localSlug: 'longshore', cardGrouping: { form: () => { push(); publish(); } },
    });
    expect(run()).toMatchObject({ reason: expect.stringContaining('capability unavailable') });
    expect(push).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('post-land follow-up refuses capability-off before job launch, main push or repair publication', async () => {
    const launch = vi.fn(), push = vi.fn();
    const start = declaration('localWriteRefusal').parent.parent;
    const end = declaration('landedLocal').parent.parent;
    const statements = [...start.parent.statements];
    const run = compile(statements.slice(statements.indexOf(start), statements.indexOf(end) + 1).map(n => n.getText(file)).join('\n') + '\nreturn {landedLocal, localWriteRefusal};', {
      assertCapability, localSlug: 'longshore', AS_JSON: true, DRY_RUN: false,
      merged: [{repo: 'longshore'}], isLocalRepo: () => true,
      handOffDrainFollowup: async opts => { if (opts.landed && !opts.dryRun) { launch(); push(); } return { handedOff: false }; },
      __t: {mark: () => 0},
    }, true);
    expect(await run()).toMatchObject({ landedLocal: false, localWriteRefusal: {kind: 'unsupported-repo'} });
    expect(launch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const repair = nodes.find(n => ts.isIfStatement(n) && n.thenStatement.getText(file).startsWith('numbered = repairHashOnMain('));
    const repairRun = compile(repair.getText(file), { localWriteRefusal: {}, queuedHashOnMain: true, landedLocal: false, DRY_RUN: false, repairHashOnMain: push });
    repairRun();
    const sweep = vi.fn();
    compile(declaration('strandedSweep').parent.parent.getText(file), { runStrandedSweepStep: opts => { if (!opts.dryRun) sweep(); }, DRY_RUN: false, localWriteRefusal: {}, AS_JSON: true, redMainHeld: false })();
    expect(push).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });
});
