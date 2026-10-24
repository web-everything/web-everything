// Test-first contract: no subprocesses, network, live git state, or implementation mocks.
import { describe, expect, it, vi } from 'vitest';
import { parseArgs, buildDispatchArgs, runRemoteTest } from '../remote-test.mjs';

const REF = 'lane/remote-tests';
const SHA = 'a'.repeat(40);
const CREATED_AFTER = '2026-10-24T12:00:00.000Z';
const tests = ['scripts/__tests__/remote-route.test.mjs', 'blocks/example.test.ts'];

function usage(argv) {
  expect(() => parseArgs(argv)).toThrow(/usage/i);
}

describe('parseArgs', () => {
  it.each(['lane-check', 'full'])('accepts --ref and --mode %s', (mode) => {
    expect(parseArgs(['--ref', REF, '--mode', mode])).toMatchObject({ ref: REF, mode });
  });

  it.each([tests.join(','), tests.join(' '), ` ${tests[0]},  ${tests[1]} `])
    ('normalizes comma/space tests into an array: %s', (list) => {
      expect(parseArgs(['--ref', REF, '--mode', 'targeted', `--tests=${list}`]))
        .toMatchObject({ ref: REF, mode: 'targeted', tests });
    });

  it('accepts an operation instead of tests in targeted mode', () => {
    expect(parseArgs(['--ref', REF, '--mode', 'targeted', '--operation', 'check:standards']))
      .toMatchObject({ ref: REF, mode: 'targeted', operation: 'check:standards' });
  });

  it('accepts a commit SHA as a ref', () => {
    expect(parseArgs(['--ref', SHA, '--mode', 'full']).ref).toBe(SHA);
  });

  it.each([
    ['--mode', 'targeted', '--ref', REF],
    ['--mode', 'targeted', '--ref', REF, '--tests=a.test.ts', '--operation', 'test:unit'],
    ['--mode', 'targeted', '--ref', REF, '--tests= ,  '],
    ['--mode', 'targeted', '--ref', REF, '--operation', ''],
    ['--mode', 'unknown'], ['--mode'], ['--ref'], ['--operation'], ['--unknown'],
  ])('rejects invalid or incomplete usage %j', usage);

  // Strings remain inert fixture data; none are sent to a shell.
  for (const field of ['ref', 'tests', 'operation']) {
    it.each(['x;echo bad', 'x&&echo bad', 'x|cat', '$(id)', '`id`', 'x>out', 'x<input',
      'x&', 'x\ny', 'x\ry', 'x\u0000y', 'x"y', "x'y", 'x\\y', 'x*y', 'x?y'])
      (`rejects shell metacharacters in ${field}: %j with a usage error`, (value) => {
        const argv = ['--mode', 'targeted', '--ref', REF, '--tests=a.test.ts'];
        if (field === 'ref') argv[3] = value;
        if (field === 'tests') argv[4] = `--tests=${value}`;
        if (field === 'operation') argv.splice(4, 1, '--operation', value);
        usage(argv);
      });
  }
});

describe('buildDispatchArgs', () => {
  it.each(['lane-check', 'full'])('builds gh argv for %s without a shell string', (mode) => {
    expect(buildDispatchArgs({ ref: REF, mode })).toEqual([
      'workflow', 'run', 'remote-verify.yml', '--ref', REF,
      '-f', `mode=${mode}`, '-f', 'tests=', '-f', 'operation=',
    ]);
  });

  it('keeps a targeted test list in one workflow input argv element', () => {
    const args = buildDispatchArgs(parseArgs(['--ref', REF, '--mode', 'targeted', `--tests=${tests.join(',')}`]));
    expect(args).toEqual(['workflow', 'run', 'remote-verify.yml', '--ref', REF,
      '-f', 'mode=targeted', '-f', `tests=${tests.join(' ')}`, '-f', 'operation=']);
    expect(args.every((arg) => typeof arg === 'string')).toBe(true);
  });

  it('builds a targeted operation dispatch', () => {
    expect(buildDispatchArgs({ ref: REF, mode: 'targeted', operation: 'check:standards' })).toEqual([
      'workflow', 'run', 'remote-verify.yml', '--ref', REF,
      '-f', 'mode=targeted', '-f', 'tests=', '-f', 'operation=check:standards',
    ]);
  });
});

// IO contract: dispatch receives gh argv and returns a receipt containing the
// pushed head_sha and a createdAfter timestamp captured before dispatch. findRun
// receives { createdAfter, headSha }; wait receives { runId, timeoutMs }.
// print receives a result object including exitCode and recordMarker, allowing
// the CLI to delegate eligible green results to verify-lane.mjs remote.
function fixture(overrides = {}) {
  const run = { id: 123, head_sha: SHA, created_at: '2026-10-24T12:00:01.000Z' };
  const io = {
    ref: REF, mode: 'lane-check',
    dispatch: vi.fn().mockResolvedValue({ head_sha: SHA, createdAfter: CREATED_AFTER }),
    findRun: vi.fn().mockResolvedValue(run),
    wait: vi.fn().mockResolvedValue({ status: 'completed', conclusion: 'success' }),
    print: vi.fn(), ...overrides,
  };
  return { io, run };
}

describe('runRemoteTest with injected IO', () => {
  it('dispatches, finds only the new matching HEAD, waits at most nine minutes, then prints', async () => {
    const { io, run } = fixture();
    expect(await runRemoteTest(io)).toBe(0);
    expect(io.dispatch).toHaveBeenCalledExactlyOnceWith(buildDispatchArgs({ ref: REF, mode: 'lane-check' }));
    expect(io.findRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      createdAfter: CREATED_AFTER, headSha: SHA,
    }));
    expect(io.wait).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: run.id, timeoutMs: 540000 }));
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0, recordMarker: true }));
    const order = [io.dispatch, io.findRun, io.wait, io.print].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each(['lane-check', 'full'])('signals recordMarker for green %s so the CLI delegates to verify-lane remote', async (mode) => {
    const { io } = fixture({ mode });
    expect(await runRemoteTest(io)).toBe(0);
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ recordMarker: true }));
  });

  it('never records a marker for green targeted verification', async () => {
    const { io } = fixture({ mode: 'targeted', tests });
    expect(await runRemoteTest(io)).toBe(0);
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ recordMarker: false }));
  });

  it.each(['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', null, 'unknown'])
    ('fails closed on conclusion %s and never signals a marker', async (conclusion) => {
      const { io } = fixture({ wait: vi.fn().mockResolvedValue({ status: 'completed', conclusion }) });
      expect(await runRemoteTest(io)).toBe(2);
      expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2, recordMarker: false }));
    });

  it('refuses a success conclusion without completed status', async () => {
    const { io } = fixture({ wait: vi.fn().mockResolvedValue({ status: 'in_progress', conclusion: 'success' }) });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ recordMarker: false }));
  });

  it.each([
    ['stale', { created_at: '2026-10-24T11:59:59.000Z' }],
    ['boundary timestamp', { created_at: CREATED_AFTER }],
    ['foreign HEAD', { head_sha: 'b'.repeat(40) }],
    ['missing HEAD', { head_sha: undefined }],
    ['unreadable timestamp', { created_at: 'bad' }],
    ['missing run id', { id: undefined }],
  ])('rejects %s run evidence before waiting', async (_label, changes) => {
    const { io, run } = fixture();
    io.findRun.mockResolvedValue({ ...run, ...changes });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.wait).not.toHaveBeenCalled();
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ recordMarker: false }));
  });

  it('reports a missing run instead of waiting on incomplete evidence', async () => {
    const { io } = fixture({ findRun: vi.fn().mockResolvedValue(null) });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.wait).not.toHaveBeenCalled();
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2, recordMarker: false }));
  });

  it.each(['dispatch', 'findRun', 'wait'])('returns 2 and prints failure if %s throws', async (stage) => {
    const { io } = fixture({ [stage]: vi.fn().mockRejectedValue(new Error('injected IO failure')) });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2, recordMarker: false }));
    if (stage === 'dispatch') expect(io.findRun).not.toHaveBeenCalled();
    if (stage !== 'wait') expect(io.wait).not.toHaveBeenCalled();
  });

  it('returns 2 for timeout and prints a result without recording a marker', async () => {
    const { io } = fixture({ wait: vi.fn().mockResolvedValue({ timedOut: true }) });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2, recordMarker: false }));
  });

  it('caps an oversized requested timeout with an operator-visible failure path', async () => {
    const { io } = fixture({ timeoutMs: 999999999, wait: vi.fn().mockResolvedValue({ timedOut: true }) });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.wait).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 540000 }));
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2, recordMarker: false }));
  });

  it.each([
    { mode: 'unknown' }, { mode: 'targeted' },
    { mode: 'targeted', tests, operation: 'test:unit' },
    { mode: 'targeted', tests: ['a;echo bad'] }, { ref: '$(id)' },
  ])('returns usage code 3 before IO for invalid options %j', async (options) => {
    const { io } = fixture(options);
    expect(await runRemoteTest(io)).toBe(3);
    expect(io.dispatch).not.toHaveBeenCalled();
    expect(io.findRun).not.toHaveBeenCalled();
    expect(io.wait).not.toHaveBeenCalled();
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 3, recordMarker: false }));
  });
});
