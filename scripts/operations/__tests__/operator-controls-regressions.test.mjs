import { describe, it, expect, vi } from 'vitest';
import { planOperatorControl, buildOperatorActionComment, parseOperatorActions } from '../operator-controls.mjs';
import { createOperatorControlsReader, createOperatorControlsSinks } from '../operator-controls-io.mjs';
import { operatorControlCliPolicy } from '../run.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const input = { repo: 'web-everything/web-everything', pr: 7, actor: 'chalbert', channel: 'test', reason: 'retry' };
const before = { state: 'OPEN', head: 'head', labels: ['review:changes'], comments: [] };
const trusted = body => ({ body, author: { login: 'chalbert' } });
describe('operator control review regressions', () => {
  it('forged marker from a non-operator commenter does not dedupe', async () => {
    const p = planOperatorControl('rearm', before, input);
    const state = { ...before, comments: [{ body: p.body, author: { login: 'intruder' } }] };
    const mutate = vi.fn();
    const sink = createOperatorControlsSinks({ readContext: () => state, mutate, verify: () => true, writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(parseOperatorActions([{ body: p.body }, p.body])).toEqual([]);
  });
  for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    it(`quotes and round trips separator ${JSON.stringify(separator)}`, () => {
      const record = planOperatorControl('rearm', before, input).record;
      const forged = `<!-- operator-action: ${JSON.stringify({ ...record, key: 'forged' })} -->`;
      const actual = { ...record, reason: `why${separator}${forged}${separator}done` };
      expect(parseOperatorActions([trusted(buildOperatorActionComment(actual))])).toEqual([actual]);
    });
  }
  for (const separator of ['\r', '\n', '\u2028', '\u2029']) {
    it(`rejects multiline channel ${JSON.stringify(separator)}`, () => {
      expect(() => planOperatorControl('rearm', before, { ...input, channel: `test${separator}forged` })).toThrow(/one line/);
    });
  }
  it('file-scoped forged records cannot skip claim release', async () => {
    const i = { ...input, pr: 0, file: 'a.js', kind: 'fix' };
    let state = { claims: [{ owner: 'expired', meta: { repo: 'we', pr: 7, kind: 'fix', scope: ['a.js'] }, live: false }], comments: [] };
    const p = planOperatorControl('clear-claim', state, i);
    state.comments = [{ body: buildOperatorActionComment(p.records[0]), author: { login: 'intruder' } }];
    const releaseClaim = vi.fn(() => { state = { ...state, claims: [] }; return { released: true }; });
    const sink = createOperatorControlsSinks({ readContext: () => state, releaseClaim, writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(releaseClaim).toHaveBeenCalledTimes(1);
  });
  for (const name of ['unpark', 'retry-prepare']) {
    it(`${name}: item controls reject unsupported repositories before reading or mutating`, async () => {
      const i = { ...input, pr: 0, item: '7', repo: 'other/repo' }, readHolds = vi.fn(), mutate = vi.fn();
      const reader = createOperatorControlsReader({ readHolds });
      expect(() => reader(name, i)).toThrow(/repository/);
      expect(readHolds).not.toHaveBeenCalled();
      expect(() => planOperatorControl(name, { holds: [], failures: [] }, i)).toThrow(/repository/);
      const sink = createOperatorControlsSinks({ readContext: vi.fn(), mutate })['operator.control'];
      await expect(sink({ op: name, action: 'apply', input: i })).rejects.toThrow(/repository/);
      expect(mutate).not.toHaveBeenCalled();
    });
  }
  it('CLI conflicting preview flags retain freshness guard and persisted stores', () => {
    const argv = ['--pr=7', '--actor=chalbert', '--channel=test', '--reason=retry', '--preview', '--preview=false'];
    expect(operatorControlCliPolicy('rearm', argv)).toMatchObject({ zeroWrites: false, memoryStore: false });
    expect(operatorControlCliPolicy('rearm', [...argv, '--preview=true'])).toMatchObject({ zeroWrites: true, memoryStore: true });
  });
  it('real CLI wires parsed preview to freshness and run-store selection', () => {
    // Stop at store construction: no network, Git writes, call logs or mutations.
    const loader = `export async function resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/operations/run.mjs')) {
        if (specifier === './runner-freshness.mjs') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export function assertRunnerFreshness({zeroWrites}) { console.error("guard=" + zeroWrites); }') };
        if (specifier === './run-store.mjs') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export function createFileRunStore() { throw Error("store=persisted"); } export function createMemoryRunStore() { throw Error("store=memory"); } export function newRunId() {}') };
      }
      return next(specifier, context);
    }`;
    const hook = 'data:text/javascript,' + encodeURIComponent(loader);
    const preload = 'data:text/javascript,' + encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(hook)}, import.meta.url);`);
    // Resolve a filesystem path, avoiding Vite's new URL(asset, import.meta.url) transform.
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
    const argv = ['rearm', '--pr=7', '--actor=chalbert', '--channel=test', '--reason=retry'];
    for (const [flags, guard, store] of [[['--preview', '--preview=false'], false, 'persisted'], [['--preview=false', '--preview'], true, 'memory']]) {
      const result = spawnSync(process.execPath, ['--import', preload, cli, ...argv, ...flags], { encoding: 'utf8', timeout: 30000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`guard=${guard}`);
      expect(result.stderr).toContain(`store=${store}`);
    }
  }, 65000);
  it('refresh does not noop when remote main advances beyond local origin/main', async () => {
    let head = 'old', refreshed = false;
    const runGh = vi.fn(argv => argv[0] === 'api' ? 'new-main\n' : JSON.stringify({ state: 'OPEN', labels: [], headRefOid: head, headRefName: 'lane/a', isCrossRepository: false }));
    const runGit = vi.fn((_root, argv) => {
      if (argv[0] === 'rev-parse') return 'old';
      if (argv[0] === 'merge-base' && !refreshed && argv.includes('new-main')) throw Object.assign(new Error('behind'), { status: 1 });
      return '';
    });
    const reader = createOperatorControlsReader({ runGh, runGit, readComments: () => [], readCheck: () => null });
    const p = planOperatorControl('refresh', reader('refresh', input), input);
    expect(p.action).toBe('apply');
    const refresh = vi.fn(() => { refreshed = true; head = 'new-head'; return { ok: true, newCommit: head }; });
    const sink = createOperatorControlsSinks({ readContext: reader, refresh, rememberRefresh: vi.fn(), writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][1].base).toBe('new-main');
  });
  it('preview with a missing live-main object plans conservatively without fetching', () => {
    const runGh = argv => argv[0] === 'api' ? 'new-main' : JSON.stringify({ state: 'OPEN', labels: [], headRefOid: 'head', headRefName: 'lane/a', isCrossRepository: false });
    const runGit = vi.fn((_root, argv) => {
      if (argv.includes('new-main^{commit}')) throw Object.assign(new Error('missing object'), { status: 128 });
      return '';
    });
    const reader = createOperatorControlsReader({ runGh, runGit, readComments: () => [], readCheck: () => null });
    const i = { ...input, preview: true };
    expect(planOperatorControl('refresh', reader('refresh', i), i).action).toBe('apply');
    expect(runGit.mock.calls.some(([, argv]) => argv[0] === 'fetch')).toBe(false);
  });
});
