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

function directMerge(repo) {
  expect(callbacks).toHaveLength(1);
  const mergePr = vi.fn();
  const enqueue = vi.fn();
  const wiring = {
    c: { repo, num: 42 }, localSlug: 'we', traceHeadSha: 'a'.repeat(40),
    isPrAlreadyMerged: () => false, cardGrouping: { holdFor: () => null },
    mergeStrategy: { enqueues: () => false }, enqueueWithSameHeadGuard: enqueue,
    assertCapability, mergePr, __t: { time: (_name, run) => run() },
  };
  const run = new Function(...Object.keys(wiring), `return (${callbacks[0].getText(file)})();`);
  return { run: () => run(...Object.values(wiring)), mergePr, enqueue };
}

describe('direct land dispatch capability admission', () => {
  it.each(['longshore', 'unknown/repo'])('refuses %s before mergePr or successful land bookkeeping', repo => {
    const f = directMerge(repo);
    expect(f.run).toThrow(expect.objectContaining({
      enqueueFailure: expect.objectContaining({ kind: 'unsupported-repo', repo }),
    }));
    expect(f.mergePr).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it.each(['we', 'frontierui', 'plateau-app', undefined])('keeps supported direct merge unchanged: %s', repo => {
    const f = directMerge(repo);
    expect(f.run()).toEqual({ merged: true });
    expect(f.mergePr).toHaveBeenCalledTimes(1);
    expect(f.mergePr).toHaveBeenCalledWith({
      pr: 42, repo, method: 'merge', matchHeadCommit: 'a'.repeat(40), caller: 'drain',
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
