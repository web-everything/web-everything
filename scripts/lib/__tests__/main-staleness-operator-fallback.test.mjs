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
