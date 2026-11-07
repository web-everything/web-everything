import { describe, it, expect, vi } from 'vitest';
import { assertOperatorCliFresh } from '../main-staleness.mjs';

const root = '/operator-code';
const candidate = '/operator-data';
const script = 'scripts/review-set-label.mjs';
const refusal = 'review-set-label: this checkout is 14 commit(s) behind origin/main in code it runs '
  + '(STALE code from this checkout) — its verdict could be wrong on a bug main already fixed, so it refuses: '
  + 'run from an up-to-date lane (a fresh lane on origin/main: `node scripts/lane-pool.mjs acquire`). Nothing was changed.';

function fixture({ rootBehind = 14, candidateBehind = 0, candidateFiles = ['scripts/current.mjs'],
  top = candidate, dirty = '', failure = '', ...overrides } = {}) {
  const run = vi.fn((args, opts) => {
    const key = args[0];
    if (opts.cwd !== root && key === failure) return { status: 1, stdout: '' };
    if (key === 'fetch') return { status: 0, stdout: '' };
    if (key === 'rev-list') return { status: 0, stdout: String(opts.cwd === root ? rootBehind : candidateBehind) };
    if (key === 'rev-parse' && args[1] === '--show-toplevel') return { status: 0, stdout: top };
    if (key === 'status') return { status: 0, stdout: dirty };
    throw new Error(`Unexpected git command: ${args}`);
  });
  const o = {
    label: 'review-set-label', skipUnderVitest: false, run,
    listBehindFiles: vi.fn((r) => r === root ? ['scripts/old.mjs'] : candidateFiles),
    laneSpawn: vi.fn(() => ({ status: 1 })),
    spawn: vi.fn(() => ({ status: 7 })), exit: vi.fn(), write: vi.fn(),
    env: { KEEP: 'yes' }, cwd: `${candidate}/nested`,
    argv: [process.execPath, `${root}/${script}`, '--pr=4880', '--to=restamp'],
    execArgv: ['--no-warnings'], exists: vi.fn(() => true), readSettings: vi.fn(() => ({})),
    ...overrides,
  };
  return { o, call: () => assertOperatorCliFresh(root, o) };
}

function refuses(overrides) {
  const { o, call } = fixture(overrides);
  expect(call).toThrow(refusal);
  expect(o.spawn).not.toHaveBeenCalled();
  expect(o.exit).not.toHaveBeenCalled();
}

describe('operator CLI fresh-checkout fallback (drain re-stamp, PR #4880)', () => {
  it('runs the fresh script with original arguments, cwd, environment and child status', () => {
    const { o, call } = fixture();
    expect(call()).toEqual({ reexecedFrom: candidate, status: 7 });
    expect(o.run).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], expect.objectContaining({ cwd: o.cwd }));
    expect(o.exists).toHaveBeenCalledWith(`${candidate}/${script}`);
    expect(o.spawn).toHaveBeenCalledTimes(1);
    expect(o.exit).toHaveBeenCalledTimes(1);
    expect(o.write).toHaveBeenCalledTimes(1);
    expect(o.spawn).toHaveBeenCalledWith(process.execPath,
      ['--no-warnings', `${candidate}/${script}`, '--pr=4880', '--to=restamp'],
      { stdio: 'inherit', cwd: o.cwd, env: { KEEP: 'yes', WE_OPERATOR_CLI_FRESH_REEXEC: '1' } });
    expect(o.env).toEqual({ KEEP: 'yes' });
    expect(o.exit).toHaveBeenCalledWith(7);
    expect(o.write).toHaveBeenCalledWith('review-set-label: this checkout is 14 commit(s) behind origin/main in code it runs'
      + ` — re-running from the fresh checkout ${candidate} (operator-cli fresh fallback, knob source: default).\n`);
  });

  it.each([
    ['stale candidate', { candidateBehind: 2 }],
    ['unknown diff', { candidateBehind: 2, candidateFiles: null }],
    ['same checkout', { top: root }],
    ['missing candidate', { top: '' }],
    ['already re-executed', { env: { WE_OPERATOR_CLI_FRESH_REEXEC: '1' } }],
    ['env off', { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } }],
    ['settings off', { readSettings: () => ({ operatorCli: { freshFallback: 'off' } }) }],
    ['tracked dirty', { dirty: ' M scripts/current.mjs\n' }],
    ['untracked code', { dirty: '?? scripts/new.mjs\n' }],
    ['missing script', { exists: () => false }],
    ['outside script', { argv: [process.execPath, '/operator-code-other/cli.mjs'] }],
    ['missing argv', { argv: [process.execPath] }],
    ...['fetch', 'rev-list', 'rev-parse', 'status'].map((failure) => [`failed ${failure}`, { failure }]),
  ])('preserves the original refusal for %s', (_, overrides) => refuses(overrides));

  it.each([
    ['env', { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'on' }, readSettings: () => ({ operatorCli: { freshFallback: 'off' } }) }],
    ['settings', { readSettings: () => ({ operatorCli: { freshFallback: 'on' } }) }],
    ['default', { readSettings: () => { throw new Error('unavailable'); } }],
    ['default', { readSettings: () => ({ operatorCli: { freshFallback: 'invalid' } }) }],
    ['default', { env: { WE_OPERATOR_CLI_FRESH_FALLBACK: 'invalid' }, readSettings: () => ({ operatorCli: { freshFallback: 'off' } }) }],
  ])('resolves knob source %s', (source, overrides) => {
    const { o, call } = fixture(overrides);
    expect(call()).toEqual({ reexecedFrom: candidate, status: 7 });
    expect(o.write.mock.calls[0][0]).toContain(`knob source: ${source}`);
  });

  it('accepts non-code lag and untracked non-code files', () => {
    const { call } = fixture({ candidateBehind: 5, candidateFiles: ['backlog/card.md'], dirty: '?? notes.md\n' });
    expect(call()).toEqual({ reexecedFrom: candidate, status: 7 });
  });

  it.each([
    () => ({ error: new Error('ENOENT') }),
    () => { throw new Error('spawn failed'); },
  ])('preserves the refusal on spawn errors', (spawn) => {
    const { o, call } = fixture({ spawn: vi.fn(spawn) });
    expect(call).toThrow(refusal);
    expect(o.exit).not.toHaveBeenCalled();
  });

  it('maps a signalled child to failure', () => {
    const { o, call } = fixture({ spawn: vi.fn(() => ({ status: null, signal: 'SIGTERM' })) });
    expect(call()).toEqual({ reexecedFrom: candidate, status: 1 });
    expect(o.exit).toHaveBeenCalledWith(1);
  });

  it('leaves a fresh root unchanged', () => {
    const { o, call } = fixture({ rootBehind: 0 });
    expect(call()).toEqual({ fresh: true, behind: 0 });
    expect(o.spawn).not.toHaveBeenCalled();
    expect(o.readSettings).not.toHaveBeenCalled();
  });
});


const lane = '/fresh-lane';
const sha = 'a'.repeat(40);
function sameCheckout({ acquire = { status: 0, stdout: JSON.stringify({ lane: 8, path: lane, holder: 'restamp-holder' }) },
  head = sha, main = sha, fetchStatus = 0, revStatus = 0, releaseStatus = 0, dirtyState = '', dirtyStatus = 0, ...overrides } = {}) {
  const laneSpawn = vi.fn((_cmd, args) => {
    if (args[1] === 'acquire') return acquire;
    if (args[1] === 'release') return { status: releaseStatus };
    throw new Error(`Unexpected lane command: ${args}`);
  });
  const f = fixture({ top: root, cwd: root, laneSpawn, ...overrides });
  const originalRun = f.o.run.getMockImplementation();
  f.o.run.mockImplementation((args, opts) => {
    if (opts.cwd !== lane) return originalRun(args, opts);
    if (args[0] === 'fetch') return { status: fetchStatus };
    if (args[0] === 'rev-parse') return { status: revStatus, stdout: args[1] === 'HEAD' ? head : main };
    if (args[0] === 'status') return { status: dirtyStatus, stdout: dirtyState };
    throw new Error(`Unexpected fresh lane git command: ${args}`);
  });
  return f;
}
function expectReleased(o) {
  expect(o.laneSpawn).toHaveBeenLastCalledWith(process.execPath,
    [`${root}/scripts/lane-pool.mjs`, 'release', '--lane=8', '--session=restamp-holder', `--repo=${root}`],
    expect.objectContaining({ cwd: root }));
}

describe('operator CLI same-checkout fresh lane fallback', () => {
  it('leases an exact origin/main lane, reexecutes the relative CLI and releases before exiting', () => {
    const { o, call } = sameCheckout();
    o.exit.mockImplementation(() => expectReleased(o));
    expect(call()).toEqual({ reexecedFrom: lane, status: 7 });
    expect(o.laneSpawn.mock.calls[0][1]).toEqual([
      `${root}/scripts/lane-pool.mjs`, 'acquire', '--purpose=operator-cli-fresh', '--json', '--wait-ms=300000', `--repo=${root}`,
    ]);
    expect(o.run).toHaveBeenCalledWith(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      expect.objectContaining({ cwd: lane }));
    expect(o.spawn).toHaveBeenCalledWith(process.execPath,
      ['--no-warnings', `${lane}/${script}`, '--pr=4880', '--to=restamp'],
      { stdio: 'inherit', cwd: lane, env: { KEEP: 'yes', WE_OPERATOR_CLI_FRESH_REEXEC: '1' } });
    expect(o.exit).toHaveBeenCalledWith(7);
    expectReleased(o);
  });

  it.each([
    ['acquire fails', { status: 1 }],
    ['acquire unreadable', { status: 0, stdout: '{}' }],
  ])('preserves refusal when %s', (_, acquire) => {
    const { o, call } = sameCheckout({ acquire });
    expect(call).toThrow(refusal);
    expect(o.spawn).not.toHaveBeenCalled();
    expect(o.laneSpawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HEAD differs', { head: 'b'.repeat(40) }],
    ['HEAD unreadable', { head: '' }],
    ['rev-parse fails', { revStatus: 1 }],
    ['fetch fails', { fetchStatus: 1 }],
    ['entry missing', { exists: () => false }],
    ['lane code dirty', { dirtyState: ' M scripts/current.mjs' }],
    ['lane status unreadable', { dirtyStatus: 1 }],
    ['child has no exit code', { spawn: vi.fn(() => ({ status: null, signal: 'SIGTERM' })) }],
    ['child spawn fails', { spawn: vi.fn(() => { throw new Error('spawn failed'); }) }],
    ['child reports error', { spawn: vi.fn(() => ({ error: new Error('ENOENT') })) }],
  ])('preserves refusal and releases when %s', (_, options) => {
    const { o, call } = sameCheckout(options);
    expect(call).toThrow(refusal);
    expectReleased(o);
    expect(o.exit).not.toHaveBeenCalled();
  });

  it('preserves refusal when acquisition throws', () => {
    const { o, call } = sameCheckout({ laneSpawn: vi.fn(() => { throw new Error('pool unavailable'); }) });
    expect(call).toThrow(refusal);
    expect(o.spawn).not.toHaveBeenCalled();
    expect(o.exit).not.toHaveBeenCalled();
  });

  it.each([
    ['nonzero release', () => ({ status: 1 })],
    ['release error', () => ({ error: new Error('ENOENT') })],
    ['thrown release', () => { throw new Error('release failed'); }],
  ])('preserves successful mutation and reports cleanup failure for %s', (_, release) => {
    let mutations = 0;
    const { o, call } = sameCheckout({ spawn: vi.fn(() => { mutations++; return { status: 0 }; }) });
    o.laneSpawn.mockImplementationOnce(() => ({ status: 0,
      stdout: JSON.stringify({ lane: 8, path: lane, holder: 'restamp-holder' }) }))
      .mockImplementationOnce(release);
    expect(call()).toEqual({ reexecedFrom: lane, status: 0 });
    expect(mutations).toBe(1);
    expectReleased(o);
    expect(o.exit).toHaveBeenCalledWith(0);
    expect(o.write).toHaveBeenLastCalledWith(expect.stringContaining(
      'could not release lane-8; release it: node scripts/lane-pool.mjs release --lane=8 --session=restamp-holder'));
  });

  it('preserves a nonzero child result when release fails', () => {
    const { o, call } = sameCheckout({ releaseStatus: 1 });
    expect(call()).toEqual({ reexecedFrom: lane, status: 7 });
    expectReleased(o);
    expect(o.exit).toHaveBeenCalledWith(7);
  });

  it('preserves the pre-execution refusal when release also fails', () => {
    const { o, call } = sameCheckout({ head: 'b'.repeat(40), releaseStatus: 1 });
    expect(call).toThrow(refusal);
    expectReleased(o);
    expect(o.spawn).not.toHaveBeenCalled();
    expect(o.exit).not.toHaveBeenCalled();
  });

  it('preserves successful execution if the cleanup diagnostic cannot be written', () => {
    const write = vi.fn().mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error('stderr closed'); });
    const { o, call } = sameCheckout({ releaseStatus: 1, write, spawn: vi.fn(() => ({ status: 0 })) });
    expect(call()).toEqual({ reexecedFrom: lane, status: 0 });
    expect(o.exit).toHaveBeenCalledWith(0);
  });

  it.each([
    { WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' },
    { WE_OPERATOR_CLI_FRESH_REEXEC: '1' },
  ])('refuses before leasing with guard environment %j', (env) => {
    const { o, call } = sameCheckout({ env });
    expect(call).toThrow(refusal);
    expect(o.laneSpawn).not.toHaveBeenCalled();
    expect(o.spawn).not.toHaveBeenCalled();
  });
});


describe('drain restamp soak with real git', () => {
  it('covers separate and same-checkout stale CODE/DATA clones', async () => {
    const { default: scenario } = await import('../../conveyor/soak/breaks/drain-restamp-stale-code-clone.mjs');
    const report = await scenario.run();
    expect(scenario.judge(report)).toEqual([]);
  }, 60_000);
});
