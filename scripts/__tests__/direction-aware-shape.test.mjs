import { describe, expect, it, vi } from 'vitest';
import { isBlastRadiusPath, scoreEscalation } from '../lib/review-escalation.mjs';
import { buildShapePlan, runShape } from '../review-core-cli.mjs';
import { buildShapePlan as sharedShapePlan } from '../lib/review-shape.mjs';
import { resolveDirectionAwareMode } from '../lib/direction-aware-human.mjs';
import { loadReadOnlyOps } from '../lib/read-only-ops.mjs';
import * as importClosure from '../lib/import-closure.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { op, isReadOnlyOperation } from '../operations/registry.mjs';
import { compute, effect } from '../operations/step-kinds.mjs';
import { verifyOperation } from '../operations/verify.mjs';
import { createChecksRunner, VERIFY_LANE_CLI } from '../operations/verify-io.mjs';
import { execFileSync } from 'node:child_process';

const runner = 'scripts/operations/run.mjs';
// Self-contained registration is provable without stored-array consumer evidence.
const diffHunks = `diff --git a/${runner} b/${runner}
--- a/${runner}
+++ b/${runner}
@@ -1,0 +1 @@
+  [PR_TRACE_OP]: () => ({ declaration: prTraceOperation({ readFacts: createPrTraceReader() }), sinks: {}, finish: finishPrTrace }),
`;
// Keep the historical #5961 array shape as an explicit conservative regression.
const listHunk = `@@ -10,4 +11,5 @@
 const zeroWrites = [
   HEALTH_OP,
+  PR_TRACE_OP,
   EVENTS_OP,
 ];
`;
const evidence = { changedFiles: [runner], diffHunks, readOnlyOps: new Set(['pr-trace']) };

// Isolate byte-comparison evidence from the live runner's conservative dependency checks.
async function withCompleteClosure(check) {
  const closure = vi.spyOn(importClosure, 'collectImportClosure').mockImplementation(({ entries }) => ({
    files: new Set(entries), complete: true, jsonNames: new Set(),
  }));
  try { await check(closure); } finally { closure.mockRestore(); }
}

function readOnlyProofOptions() {
  return {
    importModule: vi.fn(async () => ({ OPERATIONS: { 'heavy-queue': 1 },
      resolveOperation: () => ({ declaration: op('heavy-queue', { read: compute({ fn: () => null }) }) }) })),
    lstat: () => ({ isFile: () => true, size: 9 }),
    readFile: () => Buffer.from('unchanged'),
  };
}

describe('R131 direction-aware shape wiring', () => {
  it('shares the pure shape function without pulling CLI evidence loading into operations', () => {
    expect(buildShapePlan).toBe(sharedShapePlan);
    expect(isBlastRadiusPath('scripts/lib/review-shape.mjs')).toBe(true);
    const closure = importClosure.collectImportClosure({ root: resolve('.'), entries: ['scripts/operations/review-pr.mjs'] });
    expect(closure?.complete).toBe(true);
    expect(closure.files.has('scripts/lib/review-shape.mjs')).toBe(true);
    for (const file of ['scripts/review-core-cli.mjs', 'scripts/lib/read-only-ops.mjs',
      'scripts/operations/run.mjs', 'scripts/operations/cli-adapter.mjs']) {
      expect(closure.files.has(file)).toBe(false);
    }
  });
  it('keeps the entire current no-hunks shape for a readable harmless runner edit', () => {
    const harmless = `diff --git a/${runner} b/${runner}\n--- a/${runner}\n+++ b/${runner}\n@@ -1 +1 @@\n-// old note\n+// new note\n`;
    const base = scoreEscalation({ changedFiles: [runner] });
    expect(base.humanRequired).toBe(true);
    expect(scoreEscalation({ changedFiles: [runner], diffHunks: harmless }).humanRequired).toBe(false);
    const { humanRequiredProposed, humanRequiredProposedReason, ...current } = buildShapePlan({ ...evidence, diffHunks: harmless });
    const { humanRequiredProposed: ignored, humanRequiredProposedReason: ignoredReason, ...before } = buildShapePlan({ changedFiles: [runner] });
    expect(current).toEqual(before);
    expect(current.humanRequired).toBe(base.humanRequired);
    expect(humanRequiredProposed).toBe(true);
    expect(humanRequiredProposedReason).toBe('no new op reference');
  });
  it('keeps a complete stored read-only list human even when hunks clear the current hold', () => {
    const listOnly = diffHunks.slice(0, diffHunks.indexOf('@@')) + listHunk;
    expect(scoreEscalation({ ...evidence, diffHunks: listOnly }).humanRequired).toBe(false);
    const { humanRequiredProposed, humanRequiredProposedReason, ...current } = buildShapePlan({ ...evidence, diffHunks: listOnly });
    const { humanRequiredProposed: ignored, humanRequiredProposedReason: ignoredReason, ...before } = buildShapePlan({ changedFiles: [runner] });
    expect(current).toEqual(before);
    expect(humanRequiredProposed).toBe(true);
    expect(humanRequiredProposedReason).toBe('unprovable list membership: human review required');
    expect(scoreEscalation({ changedFiles: [runner], readOnlyOps: evidence.readOnlyOps,
      proposalDiffHunks: listOnly, directionAwareLive: true }))
      .toMatchObject({ humanRequired: true, humanRequiredProposed: true });
  });
  it('#5961 keeps stored-array edits human beside provable read-only wiring', async () => {
    const diff = diffHunks + listHunk;
    const expected = { humanRequired: true, humanRequiredProposed: true,
      humanRequiredProposedReason: 'unprovable list membership: human review required' };
    expect(scoreEscalation({ ...evidence, diffHunks: diff })).toMatchObject(expected);
    expect(scoreEscalation({ ...evidence, diffHunks: diff, directionAwareLive: true })).toMatchObject(expected);
    expect(buildShapePlan({ ...evidence, diffHunks: diff })).toMatchObject(expected);
    for (const mode of ['shadow', 'live']) {
      const appendEvent = vi.fn();
      const write = vi.fn();
      await runShape({ files: runner, 'diff-file': 'fixture.diff', pr: '5961' }, true, {
        readFile: () => diff, loadOps: async () => evidence.readOnlyOps,
        resolveMode: () => mode, appendEvent, write, exit: vi.fn(),
      });
      expect(JSON.parse(write.mock.calls[0][1])).toMatchObject(expected);
      expect(appendEvent).not.toHaveBeenCalled();
    }
  });
  it('keeps the proposal false when the no-hunks decision never required a human', () => {
    expect(buildShapePlan({ changedFiles: ['scripts/example.mjs'], diffHunks }))
      .toMatchObject({ humanRequired: false, humanRequiredProposed: false,
        humanRequiredProposedReason: 'not human-required today' });
  });
  it('keeps the current hold in shadow and publishes the self-contained read-only proposal', () => {
    expect(scoreEscalation(evidence)).toMatchObject({ humanRequired: true,
      humanRequiredProposed: false, humanRequiredProposedReason: 'adds only read-only ops: pr-trace' });
  });
  it('uses the proposal only with explicit live mode, preserving reasons', () => {
    const shadow = scoreEscalation(evidence);
    expect(scoreEscalation({ ...evidence, directionAwareLive: true })).toMatchObject({
      humanRequired: false, humanRequiredProposed: false, reasons: shadow.reasons });
  });
  it.each(['  PR_TRACE_OP, LAND_PR_OP,', 'const zeroWrites = [PR_TRACE_OP, LAND_PR_OP, EVENTS_OP];'])
    ('keeps moving an imported write-capable operation into zeroWrites human-required in live mode: %s', addition => {
      const rows = [" import { LAND_PR_OP } from './land-pr.mjs';",
        ...(addition.startsWith('const') ? ['-const zeroWrites = [EVENTS_OP];'] : []),
        `+${addition}`, ...(addition.startsWith('const') ? ['+  PR_TRACE_OP,'] : []), '   EVENTS_OP,'];
      const before = rows.filter(row => row[0] !== '+').length;
      const after = rows.filter(row => row[0] !== '-').length;
      const crafted = `diff --git a/${runner} b/${runner}\n--- a/${runner}\n+++ b/${runner}\n`
        + `@@ -1,${before} +1,${after} @@\n${rows.join('\n')}\n`;
      expect(scoreEscalation({ ...evidence, diffHunks: crafted }).humanRequired).toBe(true);
      expect(scoreEscalation({ ...evidence, diffHunks: crafted, directionAwareLive: true }))
        .toMatchObject({ humanRequired: true, humanRequiredProposed: true,
          humanRequiredProposedReason: 'write-capable or unproven op: land-pr' });
    });
  it('keeps classifier self-changes human-required', () => {
    expect(scoreEscalation({ ...evidence, changedFiles: [runner, 'scripts/lib/permission-change.mjs'] }))
      .toMatchObject({ humanRequired: true, humanRequiredProposed: true });
  });
  it.each(['scripts/operations/registry.mjs', 'scripts/operations/step-kinds.mjs',
    'scripts/lib/review-shape.mjs'])
    ('keeps a classifier-only %s change human in live shape output', async path => {
      const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-// before\n+// after\n`;
      const input = { changedFiles: [path], diffHunks: diff };
      expect(scoreEscalation(input)).toMatchObject({ humanRequired: false, humanRequiredProposed: true });
      expect(scoreEscalation({ ...input, directionAwareLive: true }))
        .toMatchObject({ humanRequired: true, humanRequiredProposed: true });
      for (const hunks of [null, diff]) {
        expect(sharedShapePlan({ ...input, diffHunks: hunks }))
          .toMatchObject({ humanRequired: false, humanRequiredProposed: true,
            humanRequiredProposedReason: `classifier self-change: ${path}` });
      }
      for (const mode of ['shadow', 'live']) {
        const expected = { humanRequired: mode === 'live', humanRequiredProposed: true,
          humanRequiredProposedReason: `classifier self-change: ${path}` };
        const write = vi.fn();
        await runShape({ files: path, 'diff-file': 'fixture.diff' }, true, {
          readFile: () => diff, loadOps: async () => new Set(), resolveMode: () => mode, write, exit: vi.fn(),
        });
        expect(JSON.parse(write.mock.calls[0][1])).toMatchObject(expected);
      }
    });
  it('keeps humanRequired true in live mode for guard relocation across scopes', () => {
    const rows = [' function authorize(op) {', '-  if (!allowed.includes(op)) return false;',
      '   if (optional) {', '+    if (!allowed.includes(op)) return false;', '   }',
      ' }'];
    const before = rows.filter(row => row[0] !== '+').length;
    const after = rows.filter(row => row[0] !== '-').length;
    const crafted = `diff --git a/${runner} b/${runner}\n--- a/${runner}\n+++ b/${runner}\n`
      + `@@ -1,${before} +1,${after} @@\n${rows.join('\n')}\n`
      + '@@ -20 +20,2 @@\n+PR_TRACE_OP,\n EVENTS_OP,\n';
    expect(scoreEscalation({ ...evidence, diffHunks: crafted }).humanRequired).toBe(true);
    expect(scoreEscalation({ ...evidence, diffHunks: crafted, directionAwareLive: true }))
      .toMatchObject({ humanRequired: true, humanRequiredProposed: true });
  });
  it('preserves other human forcing and missing or oversized evidence', () => {
    for (const override of [{ deviation: 'operator call needed' }, { diffHunks: null },
      { readOnlyOps: new Set() }, { diffHunks: diffHunks + ' '.repeat(500001) }]) {
      expect(scoreEscalation({ ...evidence, ...override })).toMatchObject({ humanRequired: true, humanRequiredProposed: true });
    }
  });
  it('defaults to shadow with shipped settings and an empty environment', () => {
    expect(resolveDirectionAwareMode({ env: {} })).toBe('shadow');
  });
  it('defaults to shadow, honours live env, and fails closed on invalid values', () => {
    const readFile = () => { throw new Error('missing'); };
    expect(resolveDirectionAwareMode({ env: {}, readFile })).toBe('shadow');
    expect(resolveDirectionAwareMode({ env: { WE_DIRECTION_AWARE_HUMAN: 'live' }, readFile })).toBe('live');
    expect(resolveDirectionAwareMode({ env: { WE_DIRECTION_AWARE_HUMAN: 'invalid' }, readFile })).toBe('shadow');
    expect(resolveDirectionAwareMode({ env: {}, readFile: () => '{"directionAwareHuman":"live"}' })).toBe('live');
    expect(resolveDirectionAwareMode({ env: {}, readFile: () => '{"directionAwareHuman":{"unexpected":"live"}}' })).toBe('shadow');
  });
  it.each([undefined, 'invalid', 'Live', null, { unexpected: 'live' }])
    ('never inherits platform live with missing or invalid tool mode: %j', tool => {
      const readFile = path => {
        if (String(path).endsWith('/settings/direction-aware-human.json')) {
          if (tool === undefined) throw new Error('missing tool');
          return JSON.stringify({ directionAwareHuman: tool });
        }
        return '{"directionAwareHuman":"live"}';
      };
      expect(resolveDirectionAwareMode({ env: {}, readFile })).toBe('shadow');
      expect(resolveDirectionAwareMode({ env: { WE_DIRECTION_AWARE_HUMAN: 'Live' }, readFile })).toBe('shadow');
      expect(resolveDirectionAwareMode({ env: { WE_DIRECTION_AWARE_HUMAN: 'live' }, readFile })).toBe('live');
    });
  it('buildShapePlan carries both proposal fields', () => {
    expect(buildShapePlan(evidence)).toMatchObject({ humanRequired: true,
      humanRequiredProposed: false, humanRequiredProposedReason: 'adds only read-only ops: pr-trace' });
  });
  it('prints the proposal reason and keeps the hold when the diff cannot be read', async () => {
    const write = vi.fn();
    const appendEvent = vi.fn();
    await runShape({ files: runner, 'diff-file': 'missing', pr: '5961' }, false, {
      readFile: () => { throw new Error('missing'); }, loadOps: async () => evidence.readOnlyOps,
      resolveMode: () => 'shadow', appendEvent, write, exit: vi.fn(),
    });
    expect(write.mock.calls[0][1]).toContain('humanRequiredProposed: true (null hunks)');
    expect(appendEvent).not.toHaveBeenCalled();
  });
  it('retains human review for verify despite an unchanged compute-only declaration and complete dependency proof', async () => withCompleteClosure(async () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '{"status":"green","sha":"fixture"}' }));
    const declaration = verifyOperation({ runChecks: createChecksRunner({ spawn, env: {} }) });
    // Exercise the real injected IO without executing any command on the host.
    expect(isReadOnlyOperation(declaration)).toBe(true);
    declaration.steps.find(({ name }) => name === 'run').step.fn({
      input: { checkout: '/head', mode: 'run', gate: 'printf compromised' },
    });
    expect(spawn).toHaveBeenCalledWith(process.execPath,
      [VERIFY_LANE_CLI, '--repo=/head', '--json', '--gate=printf compromised'], expect.any(Object));
    const readOnlyOps = await loadReadOnlyOps('/head', { ...readOnlyProofOptions(),
      importModule: async () => ({ OPERATIONS: { verify: 1, 'heavy-queue': 1 },
        resolveOperation: name => ({ declaration: name === 'verify' ? declaration
          : op(name, { read: compute({ fn: () => null }) }) }),
      }),
    });
    expect(readOnlyOps).toEqual(new Set(['heavy-queue']));
    const verifyDiff = diffHunks.replaceAll('PR_TRACE_OP', 'VERIFY_OP')
      .replace('prTraceOperation({ readFacts: createPrTraceReader() })', 'verifyOperation({ runChecks: createChecksRunner() })')
      .replace('finishPrTrace', 'finishVerify');
    expect(scoreEscalation({ changedFiles: [runner], diffHunks: verifyDiff, readOnlyOps, directionAwareLive: true }))
      .toMatchObject({ humanRequired: true, humanRequiredProposed: true,
        humanRequiredProposedReason: 'write-capable or unproven op: verify' });
  }));
  it('rejects other unaudited trusted compute-only operations with identical complete dependencies', async () => withCompleteClosure(async () => {
    const options = readOnlyProofOptions();
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['heavy-queue']));
    expect(await loadReadOnlyOps('/head', { ...options,
      importModule: async () => ({ OPERATIONS: { 'health-respond': 1 },
        resolveOperation: () => ({ declaration: op('health-respond', { read: compute({ fn: () => null }) }) }) }),
    })).toEqual(new Set());
  }));
  it('classifies with trusted declarations only and rejects changed dependencies', async () => withCompleteClosure(async () => {
    const resolveOperation = vi.fn(name => {
      if (name === 'broken') throw new Error('cannot build');
      return { declaration: op(name, { read: name === 'pr-reconcile' ? compute({ fn: () => null })
        : effect({ effects: () => [] }) }) };
    });
    const importModule = vi.fn(async url => {
      expect(url).not.toContain('/head%20with%20spaces/');
      return { OPERATIONS: { 'pr-reconcile': 1, write: 1, broken: 1 }, resolveOperation };
    });
    const readFile = () => Buffer.from('unchanged');
    const lstat = () => ({ isFile: () => true, size: 9 });
    expect(await loadReadOnlyOps('/head with spaces', { importModule, readFile, lstat })).toEqual(new Set(['pr-reconcile']));
    expect(await loadReadOnlyOps('/head with spaces', { importModule, lstat,
      readFile: path => Buffer.from(String(path).startsWith('/head with spaces/') ? 'tampered' : 'unchanged') })).toEqual(new Set());
    expect(await loadReadOnlyOps('/head with spaces', { importModule, lstat,
      readFile: () => Buffer.alloc(8000001) })).toEqual(new Set());
    expect(resolveOperation).toHaveBeenCalledTimes(9);
    expect(await loadReadOnlyOps('/missing', { importModule: async () => { throw new Error('missing'); } })).toEqual(new Set());
  }));
  it('rejects operations without trusted declarations', async () => withCompleteClosure(async closure => {
    const options = readOnlyProofOptions();
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['heavy-queue']));
    closure.mockClear();
    // Even a resolved compute declaration cannot prove an operation absent from the trusted checkout.
    const name = 'direction-aware-new-operation-fixture';
    const resolveOperation = vi.fn(() => ({ declaration: op(name, { read: compute({ fn: () => null }) }) }));
    expect(await loadReadOnlyOps('/head', { ...options,
      importModule: async () => ({ OPERATIONS: { [name]: 1 }, resolveOperation }),
    })).toEqual(new Set());
    expect(resolveOperation).toHaveBeenCalledWith(name);
    expect(closure).not.toHaveBeenCalled();
  }));
  it.each([undefined, null, {}])('rejects missing or malformed resolved declarations: %j', declaration => withCompleteClosure(async () => {
    const options = readOnlyProofOptions();
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['heavy-queue']));
    expect(await loadReadOnlyOps('/head', { ...options,
      importModule: async () => ({ OPERATIONS: { 'heavy-queue': 1 }, resolveOperation: () => ({ declaration }) }),
    })).toEqual(new Set());
  }));
  it('rejects incomplete dependency graphs', async () => withCompleteClosure(async closure => {
    const options = readOnlyProofOptions();
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['heavy-queue']));
    const graph = closure.mock.results[0].value;
    closure.mockReturnValue({ ...graph, complete: false });
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set());
  }));
  it('rejects dependency graphs above 512 files', async () => withCompleteClosure(async closure => {
    const options = readOnlyProofOptions();
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['heavy-queue']));
    const graph = closure.mock.results[0].value;
    const files = new Set(graph.files);
    for (let i = files.size; i < 512; i += 1) files.add(`scripts/lib/proof-fixture-${i}.mjs`);
    closure.mockReturnValue({ ...graph, files });
    expect(files.size).toBe(512);
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['heavy-queue']));
    files.add('scripts/lib/proof-fixture-over-limit.mjs');
    expect(files.size).toBe(513);
    expect(await loadReadOnlyOps('/head', options)).toEqual(new Set());
  }));
  it('rejects pr-reconcile when the non-name-prefixed pr-status IO differs in the head', async () => {
    await withCompleteClosure(async closure => {
      const options = {
        importModule: async () => ({ OPERATIONS: { 'pr-reconcile': 1, 'heavy-queue': 1 },
          resolveOperation: name => ({ declaration: op(name, { read: compute({ fn: () => null }) }) }) }),
        lstat: () => ({ isFile: () => true, size: 9 }),
        readFile: () => Buffer.from('unchanged'),
      };
      expect(await loadReadOnlyOps('/head', options)).toEqual(new Set(['pr-reconcile', 'heavy-queue']));
      const names = await loadReadOnlyOps('/head', { ...options,
        readFile: path => Buffer.from(String(path) === '/head/scripts/operations/pr-status-io.mjs'
          ? 'tampered!' : 'unchanged'),
      });
      expect(names.has('pr-reconcile')).toBe(false);
      expect(names.size).toBe(0);
      for (const [{ entries }] of closure.mock.calls) {
        expect(entries).toEqual(expect.arrayContaining([
          'scripts/operations/pr-status-io.mjs', 'scripts/operations/heavy-queue-io.mjs',
        ]));
      }
    });
  });
  it('rejects an unchanged operation when its injected IO module differs in the head', async () => {
    const names = await loadReadOnlyOps('/head', {
      importModule: async () => ({ OPERATIONS: { 'heavy-queue': 1 },
        resolveOperation: () => ({ declaration: op('heavy-queue', { read: compute({ fn: () => null }) }) }) }),
      lstat: () => ({ isFile: () => true, size: 9 }),
      readFile: path => Buffer.from(String(path) === '/head/scripts/operations/heavy-queue-io.mjs'
        ? 'tampered!' : 'unchanged'),
    });
    expect(names.has('heavy-queue')).toBe(false);
  });
  it('rejects an unchanged operation when an op-prefixed runner import differs in the head', async () => {
    const names = await loadReadOnlyOps('/head', {
      importModule: async () => ({ OPERATIONS: { 'health-respond': 1 },
        resolveOperation: () => ({ declaration: op('health-respond', { read: compute({ fn: () => null }) }) }) }),
      lstat: () => ({ isFile: () => true, size: 9 }),
      readFile: path => Buffer.from(String(path) === '/head/scripts/conveyor/health-responder-state.mjs'
        ? 'tampered!' : 'unchanged'),
    });
    expect(names.has('health-respond')).toBe(false);
  });
  it.each(['oversized', 'symlink', 'fifo'])('skips %s head dependencies before any read', async kind => {
    const readFile = vi.fn(() => Buffer.from('unchanged'));
    const names = await loadReadOnlyOps('/head', {
      importModule: async () => ({ OPERATIONS: { 'heavy-queue': 1 },
        resolveOperation: () => ({ declaration: op('heavy-queue', { read: compute({ fn: () => null }) }) }) }),
      lstat: path => ({ size: String(path).startsWith('/head/') && kind === 'oversized' ? 16000001 : 9,
        isFile: () => !String(path).startsWith('/head/') || kind === 'oversized' }), readFile,
    });
    expect(names.size).toBe(0);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('finishes shape after two seconds when shadow event append stalls', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn();
      const pending = runShape({ files: runner, 'diff-file': 'fixture.diff', pr: '5961' }, true, {
        readFile: () => diffHunks, loadOps: async () => evidence.readOnlyOps,
        resolveMode: () => 'shadow', appendEvent: () => new Promise(() => {}), write, exit: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(write).toHaveBeenCalled();
      await pending;
    } finally { vi.useRealTimers(); }
  });
  it('never executes a head module with a top-level host-write attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'direction-aware-head-'));
    try {
      mkdirSync(join(root, 'scripts/operations'), { recursive: true });
      const target = join(root, 'reviewer-secret');
      writeFileSync(target, 'preserved');
      writeFileSync(join(root, runner), `import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(target)}, 'compromised');
        export const OPERATIONS = {};`);
      // Native Node proves the boundary without Vitest's dynamic-import transform.
      execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { loadReadOnlyOps } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/read-only-ops.mjs')).href)};
         await loadReadOnlyOps(${JSON.stringify(root)});`], { timeout: 30000, maxBuffer: 65536 });
      expect(readFileSync(target, 'utf8')).toBe('preserved');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['registry.mjs', 'step-kinds.mjs'])('keeps a modified head classifier %s human-required in live mode', async file => {
    const root = mkdtempSync(join(tmpdir(), 'direction-aware-classifier-'));
    try {
      mkdirSync(join(root, 'scripts/operations'), { recursive: true });
      writeFileSync(join(root, 'scripts/operations', file), 'export const isReadOnlyOperation = () => true;');
      const readOnlyOps = await loadReadOnlyOps(root, {
        importModule: async () => ({ OPERATIONS: { 'heavy-queue': 1 },
          resolveOperation: () => ({ declaration: op('heavy-queue', { read: compute({ fn: () => null }) }) }) }),
        readFile: path => readFileSync(String(path).startsWith(`${root}/`)
          ? String(path).endsWith(`/operations/${file}`) ? path : resolve(relative(root, path)) : path),
      });
      expect(readOnlyOps.size).toBe(0);
      const score = scoreEscalation({ ...evidence, readOnlyOps: new Set(['pr-trace']),
        changedFiles: [runner, `scripts/operations/${file}`], directionAwareLive: true });
      expect(score).toMatchObject({ humanRequired: true, humanRequiredProposed: true });
      expect(score.humanRequiredProposedReason).toContain('classifier self-change');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('awaits a shadow event only for a difference with a PR, and tolerates event failure', async () => {
    for (const [live, pr, expected] of [[false, '5961', 1], [false, undefined, 0], [true, '5961', 0]]) {
      const appendEvent = vi.fn(async () => { throw new Error('unavailable'); });
      const write = vi.fn();
      await runShape({ files: runner, 'diff-file': 'fixture.diff', 'ops-root': '/head', pr }, true, {
        readFile: () => diffHunks, loadOps: async () => evidence.readOnlyOps,
        resolveMode: () => live ? 'live' : 'shadow', appendEvent, write, exit: vi.fn(),
      });
      expect(appendEvent).toHaveBeenCalledTimes(expected);
      if (expected) expect(appendEvent).toHaveBeenCalledWith({ kind: 'shape-shadow-diff', pr: 5961,
        daemon: 'review-core-cli', detail: { pr: 5961, current: true, proposed: false, reason: 'adds only read-only ops: pr-trace' } });
      expect(JSON.parse(write.mock.calls[0][1])).toMatchObject({ humanRequired: !live, humanRequiredProposed: false });
    }
  });
});
