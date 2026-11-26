import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createUpdateBranchSinks } from '../update-branch-io.mjs';
import { updateBranchOperation, UPDATE_BRANCH_OP, finishUpdateBranch } from '../update-branch.mjs';
import { parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
// Collect the operation registry before the per-test deadline, like the other CLI wiring suites.
import { resolveOperation } from '../run.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40), base = 'b'.repeat(40), newHead = 'c'.repeat(40);
const pull = { state: 'open', head: { sha: head }, base: { sha: base, ref: 'main' }, mergeable: true, mergeable_state: 'behind' };
const next = { ...pull, head: { sha: newHead } };
const input = { pr: 42, reason: 'fix already on main' };
const accepted = 'HTTP/2.0 202 Accepted\r\n\r\n{"message":"Updating pull request branch."}';

function fixture(replies, options = {}) {
  const pending = [...replies];
  const gh = vi.fn(async () => {
    if (!pending.length) throw new Error('unexpected gh call');
    const value = pending.shift();
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  const sleep = vi.fn(async () => {}), append = vi.fn(async () => true);
  const sinks = createUpdateBranchSinks({ gh, sleep, append, actor: () => 'operator', ...options });
  return { gh, sleep, append, sinks, run: value => sinks[UPDATE_BRANCH_OP](value ?? input) };
}

function writes(f) { return f.gh.mock.calls.filter(([args]) => args.includes('PUT')); }

describe('update-branch', () => {
  it('refuses a closed PR without comparing or writing and logs the refusal', async () => {
    const f = fixture([{ ...pull, state: 'closed' }]);
    const result = await f.run();
    expect(result).toMatchObject({ ok: false, refused: true, status: 'not-open', pr: 42, actor: 'operator', reason: input.reason });
    expect(f.gh).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledWith({ kind: 'update-branch', repo, pr: 42, detail: result });
  });

  it('reports already-up-to-date without a write', async () => {
    const f = fixture([pull, { behind_by: 0 }]);
    expect(await f.run()).toMatchObject({ ok: true, status: 'already-up-to-date', beforeHead: head, afterHead: head, behindBefore: 0, behindAfter: 0 });
    expect(writes(f)).toHaveLength(0);
    expect(f.gh.mock.calls[1][0]).toEqual(['api', `repos/${repo}/compare/main...${head}`]);
  });

  it.each([{ mergeable: false }, { mergeable_state: 'dirty' }])('refuses conflicts and reports candidate PR files (%j)', async flag => {
    const f = fixture([{ ...pull, ...flag }, { behind_by: 3 }, [{ filename: 'src/shared.ts' }]]);
    expect(await f.run()).toMatchObject({ ok: false, refused: true, status: 'conflict', conflicts: ['src/shared.ts'], detail: expect.stringMatching(/candidate PR files.*inspect/i) });
    expect(writes(f)).toHaveLength(0);
  });

  it('retains conflict refusal and manual fallback when file listing fails', async () => {
    const f = fixture([{ ...pull, mergeable: false }, { behind_by: 1 }, new Error('unreadable')]);
    expect(await f.run()).toMatchObject({ status: 'conflict', conflicts: [], detail: expect.stringMatching(/inspect the full PR diff/) });
    expect(writes(f)).toHaveLength(0);
  });

  it('bounds an oversized candidate list to 100 and tells the operator to inspect the full diff', async () => {
    const f = fixture([{ ...pull, mergeable: false }, { behind_by: 1 }, Array.from({ length: 101 }, (_, i) => ({ filename: `file-${i}` }))]);
    const result = await f.run();
    expect(result.conflicts).toHaveLength(100);
    expect(result.detail).toMatch(/first 100.*inspect the full PR diff/);
    expect(f.gh.mock.calls[2][0][1]).toMatch(/per_page=100$/);
    expect(f.gh).toHaveBeenCalledTimes(3);
  });

  it('uses exactly one merge-update PUT with the expected head and observes the new head', async () => {
    const f = fixture([pull, { behind_by: 2 }, accepted, next, { behind_by: 0 }]);
    const result = await f.run();
    expect(result).toEqual({ ok: true, pr: 42, actor: 'operator', reason: input.reason, beforeHead: head, afterHead: newHead, behindBefore: 2, behindAfter: 0, status: 'updated' });
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0][0]).toEqual(['api', '--include', '--method', 'PUT', `repos/${repo}/pulls/42/update-branch`, '-f', `expected_head_sha=${head}`]);
    expect(f.sleep).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.append.mock.calls[0][0].detail).toEqual(result);
    for (const [, options] of f.gh.mock.calls) expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 4 * 1024 * 1024, throttle: { maxAttempts: 1, env: { WE_GH_READ_MEMO_DIR: '' } } });
  });

  it('does not report updated when the new head is still behind', async () => {
    const f = fixture([pull, { behind_by: 2 }, accepted, next, { behind_by: 2 }]);
    expect(await f.run()).toMatchObject({ ok: false, refused: true, status: 'partially-updated', behindAfter: 2 });
  });

  it('observes a new head on the second read', async () => {
    const f = fixture([pull, { behind_by: 1 }, accepted, pull, next, { behind_by: 0 }]);
    expect(await f.run()).toMatchObject({ status: 'updated', afterHead: newHead });
    expect(f.sleep).toHaveBeenCalledTimes(2);
    expect(f.gh).toHaveBeenCalledTimes(6);
  });

  it('stops after two unchanged reads with an explicit inspect-before-retry fallback', async () => {
    const f = fixture([pull, { behind_by: 1 }, accepted, pull, pull]);
    expect(await f.run()).toMatchObject({ ok: false, status: 'unconfirmed', afterHead: null, behindAfter: null, detail: expect.stringMatching(/inspect the PR before retrying/) });
    expect(f.gh).toHaveBeenCalledTimes(5);
    expect(f.sleep).toHaveBeenCalledTimes(2);
    expect(writes(f)).toHaveLength(1);
  });

  it('reports an accepted update when observation fails, without retrying the write', async () => {
    const f = fixture([pull, { behind_by: 1 }, accepted, new Error('read failed')]);
    expect(await f.run()).toMatchObject({ ok: false, status: 'unconfirmed', afterHead: null, behindAfter: null });
    expect(writes(f)).toHaveLength(1);
  });

  it.each([null, {}, { behind_by: -1 }, { behind_by: '2' }])('fails closed on unreadable compare evidence (%j)', async compare => {
    const f = fixture([pull, compare]);
    expect(await f.run()).toMatchObject({ ok: false, refused: true, detail: expect.stringMatching(/behind count/) });
    expect(writes(f)).toHaveLength(0);
  });

  it('fails closed on an unreadable PR', async () => {
    const f = fixture([new Error('PR unavailable')]);
    expect(await f.run()).toMatchObject({ ok: false, refused: true, detail: expect.stringMatching(/PR unavailable/) });
    expect(f.append).toHaveBeenCalledTimes(1);
  });

  it.each([{ mergeable: null }, { mergeable_state: 'unknown' }, { mergeable_state: undefined }])('refuses unknown mergeability (%j)', async flag => {
    const f = fixture([{ ...pull, ...flag }, { behind_by: 2 }]);
    expect(await f.run()).toMatchObject({ ok: false, refused: true, status: 'mergeability-unknown', detail: expect.stringMatching(/Retry/) });
    expect(writes(f)).toHaveLength(0);
  });

  it.each(['HTTP/2.0 200 OK', new Error('HTTP 422: head changed')])('never retries an unaccepted or failed write (%s)', async response => {
    const f = fixture([pull, { behind_by: 1 }, response]);
    expect(await f.run()).toMatchObject({ ok: false, refused: true, detail: expect.stringMatching(/inspect the PR before retrying/) });
    expect(writes(f)).toHaveLength(1);
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it('refuses head-moved with no PUT when the head differs', async () => {
    const f = fixture([pull]);
    const result = await f.run({ ...input, 'expected-head': 'd'.repeat(40) });
    expect(result).toMatchObject({ ok: false, refused: true, status: 'head-moved', beforeHead: head, afterHead: head });
    expect(writes(f)).toHaveLength(0);
    expect(f.gh).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledTimes(1);
  });

  it('PUT carries expected_head_sha equal to the given head', async () => {
    const f = fixture([pull, { behind_by: 2 }, accepted, next, { behind_by: 0 }]);
    expect(await f.run({ ...input, 'expected-head': head })).toMatchObject({ ok: true, status: 'updated' });
    expect(writes(f)[0][0]).toContain(`expected_head_sha=${head}`);
  });

  it('omitted flag keeps today\'s behaviour', async () => {
    const f = fixture([pull, { behind_by: 2 }, accepted, next, { behind_by: 0 }]);
    expect(await f.run()).toMatchObject({ ok: true, status: 'updated' });
    expect(writes(f)[0][0]).toContain(`expected_head_sha=${head}`);
  });

  it.each(['abc', 'A'.repeat(40), 42])('rejects a malformed expected head before any IO (%j)', async value => {
    const f = fixture([]);
    await expect(f.run({ ...input, 'expected-head': value })).rejects.toThrow(/expected-head/);
    expect(f.gh).not.toHaveBeenCalled();
  });

  it.each(['', '   ', [], [''], ['  '], undefined, [undefined], [, ], new Array(1)])('empty --expected-head refuses, no PUT (%j)', async value => {
    const f = fixture([]);
    await expect(f.run({ ...input, 'expected-head': value })).rejects.toThrow(/expected-head/);
    expect(f.gh).not.toHaveBeenCalled();
    expect(writes(f)).toHaveLength(0);
  });

  it('CLI: the head lock reaches the op (head-moved, no PUT), empty and repeated flags refuse, absent keeps behaviour', async () => {
    const { declaration, registry } = resolveOperation(UPDATE_BRANCH_OP);
    const cli = async (extra, replies) => {
      const f = fixture(replies);
      const outcome = await runOperationCli({ declaration, registry, sinks: f.sinks, argv: ['--pr=42', '--reason=sync', ...extra], store: createMemoryRunStore(), newRunId: () => 'cli-lock' });
      return { f, finished: finishUpdateBranch(outcome), outcome };
    };
    const moved = await cli([`--expected-head=${'d'.repeat(40)}`], [pull]);
    expect(JSON.parse(moved.finished.lines[0])).toMatchObject({ status: 'head-moved', refused: true });
    expect(writes(moved.f)).toHaveLength(0);
    for (const extra of [['--expected-head='], ['--expected-head=   '], [`--expected-head=${head}`, `--expected-head=${head}`]]) {
      const bad = await cli(extra, [pull]);
      expect(bad.f.gh).not.toHaveBeenCalled();
      expect(JSON.stringify(bad.outcome)).toMatch(/expected-head/);
    }
    const ok = await cli([], [pull, { behind_by: 0 }]);
    expect(JSON.parse(ok.finished.lines[0])).toMatchObject({ status: 'already-up-to-date' });
    const match = await cli([`--expected-head=${head}`], [pull, { behind_by: 0 }]);
    expect(JSON.parse(match.finished.lines[0])).toMatchObject({ status: 'already-up-to-date' });
  });

  it.each([null, [head, 'd'.repeat(40)], [head, head]])('refuses an explicit null or repeated expected head before any IO (%j)', async value => {
    const f = fixture([]);
    await expect(f.run({ ...input, 'expected-head': value })).rejects.toThrow(/expected-head/);
    expect(f.gh).not.toHaveBeenCalled();
  });

  it('accepts a single-element array from the repeatable CLI flag and runs the head lock', async () => {
    const f = fixture([pull]);
    expect(await f.run({ ...input, 'expected-head': ['d'.repeat(40)] })).toMatchObject({ status: 'head-moved' });
    expect(writes(f)).toHaveLength(0);
  });

  it('declares --expected-head in the CLI usage', async () => {
    const { declaration } = resolveOperation(UPDATE_BRANCH_OP);
    expect(parseOperationArgv(declaration, ['--pr=42', '--reason=x', `--expected-head=${head}`]).ok).toBe(true);
  });

  it.each([undefined, '', '   '])('refuses a missing/empty reason before any IO (%j)', async reason => {
    const f = fixture([]);
    await expect(f.run({ pr: 42, reason })).rejects.toThrow(/reason/);
    expect(f.gh).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5])('requires a positive integer PR (%j)', async pr => {
    const f = fixture([]);
    await expect(f.run({ ...input, pr })).rejects.toThrow(/--pr/);
    expect(f.gh).not.toHaveBeenCalled();
  });

  it('reports event-log failure to the operator', async () => {
    const f = fixture([pull, { behind_by: 0 }], { append: async () => false });
    expect(await f.run()).toMatchObject({ logWarning: expect.stringMatching(/preserve this result/) });
  });

  it('writes a real JSONL event through the shared logger in an isolated repository', async () => {
    await withRealRepo(async ({ root }) => {
      const path = join(root, '.operations', 'daemon-events.jsonl');
      const f = fixture([pull, { behind_by: 0 }]);
      const sinks = createUpdateBranchSinks({ gh: f.gh, actor: () => 'filesystem-operator', env: { WE_DAEMON_EVENTS: path } });
      const result = await sinks[UPDATE_BRANCH_OP](input);
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ kind: 'update-branch', repo, pr: 42, detail: result });
      expect(result.actor).toBe('filesystem-operator');
    });
  });

  // Cold import of run.mjs loads the whole operations registry; keep it out of the test body's 5000 ms budget.
  let resolveOperation;
  beforeAll(async () => {
    ({ resolveOperation } = await import('../run.mjs'));
  }, 60000);

  it('declares required CLI inputs and prints exactly one JSON line through the engine', async () => {
    const { declaration, registry, finish, sinks } = resolveOperation(UPDATE_BRANCH_OP);
    expect(declaration.name).toBe(updateBranchOperation().name);
    expect(typeof sinks[UPDATE_BRANCH_OP]).toBe('function');
    expect(finish).toBe(finishUpdateBranch);
    expect(parseOperationArgv(declaration, ['--pr=42']).ok).toBe(false);
    expect(parseOperationArgv(declaration, ['--reason=sync']).ok).toBe(false);
    const f = fixture([pull, { behind_by: 0 }]);
    const outcome = await runOperationCli({ declaration, registry, sinks: f.sinks, argv: ['--pr=42', '--reason=sync'], store: createMemoryRunStore(), newRunId: () => 'update-test' });
    const finished = finishUpdateBranch(outcome);
    expect(finished.code).toBe(0);
    expect(finished.lines).toHaveLength(1);
    expect(JSON.parse(finished.lines[0])).toMatchObject({ pr: 42, reason: 'sync', status: 'already-up-to-date' });
    expect(finishUpdateBranch({ run: { verdict: { ok: false, refused: true } } }).code).toBe(1);
  });

  it('keeps shell-looking reason and filenames inert in the JSON result', async () => {
    const reason = '$(touch never-run)\n\u001b[31m';
    const f = fixture([{ ...pull, mergeable: false }, { behind_by: 1 }, [{ filename: '`touch never-run`' }]]);
    const result = await f.run({ ...input, reason });
    const printed = finishUpdateBranch({ run: { verdict: result } }).lines[0];
    expect(printed).not.toContain('\u001b');
    expect(printed.split('\n')).toHaveLength(1);
    expect(JSON.parse(printed).reason).toBe(reason);
    expect(f.gh.mock.calls.flatMap(([args]) => args)).not.toContain(reason);
  });
});
