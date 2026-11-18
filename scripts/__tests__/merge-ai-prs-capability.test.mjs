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
  const dispatchSource = statements.slice(preparation - 2, statements.indexOf(lockStatement) + 1)
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
