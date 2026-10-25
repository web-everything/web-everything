// Live IO uses injected children; the argument-error script probe performs no git/network IO.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parseArgs, buildDispatchArgs, runRemoteTest, runRemoteCLI, remoteIO } from '../remote-test.mjs';

const REF = 'lane/remote-tests';
const SHA = 'a'.repeat(40);
const CREATED_AFTER = '2026-10-24T12:00:00.000Z';
const tests = ['scripts/__tests__/remote-route.test.mjs', 'blocks/example.test.ts'];
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('live IO construction with injected children', () => {
  function readinessFixture({ dirty = '', pushed = `${SHA}\trefs/heads/${REF}`, authenticated = true,
    origin = 'https://github.com/web-everything/web-everything.git',
    head = { sha: SHA, commit: { tree: { sha: 'c'.repeat(40) } } },
    base = { sha: 'b'.repeat(40), commit: { tree: { sha: 'c'.repeat(40) } } }, unavailable = false } = {}) {
    const execFile = vi.fn((file, args) => {
      if (file !== 'git') throw new Error('unexpected child');
      if (args.includes('get-url')) return origin;
      if (args.includes('status')) return dirty;
      if (args.includes('rev-parse')) return SHA;
      if (args.includes('ls-remote')) return pushed;
      throw new Error(`unexpected git args: ${args}`);
    });
    const execGh = vi.fn((file, args) => {
      if (args[0] === 'api') {
        if (unavailable) throw new Error('definition unavailable');
        if (args.at(-1) === `repos/web-everything/web-everything/commits/${SHA}`) return JSON.stringify(head);
        if (args.at(-1) === 'repos/web-everything/web-everything/commits/main') return JSON.stringify(base);
      }
      if (args[0] !== 'auth') throw new Error('unexpected dispatch or API call');
      if (!authenticated) throw new Error('authentication unavailable');
      return '';
    });
    return { live: remoteIO('.', { env: {}, execFile, execGh }), execFile, execGh };
  }
  it.each([
    ['dirty worktree', { dirty: ' M scripts/example.mjs' }, /dirty/],
    ['untracked worktree', { dirty: '?? example.txt' }, /dirty/],
    ['HEAD absent from origin branches', { pushed: `${'b'.repeat(40)}\trefs/heads/main` }, /not pushed/],
    ['HEAD present only as a tag', { pushed: `${SHA}\trefs/tags/v1` }, /not pushed/],
    ['unavailable authentication', { authenticated: false }, /authentication/],
  ])('ready rejects %s before dispatch', async (_name, changes, reason) => {
    const io = readinessFixture(changes);
    expect(() => io.live.ready()).toThrow(reason);
    const importer = vi.fn();
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { live: io.live, execFile: importer, quietFailure: true })).toBe(2);
    expect(io.execGh.mock.calls.every(([, args]) => args[0] === 'auth')).toBe(true);
    expect(importer).not.toHaveBeenCalled();
  });
  it('ready returns the authenticated clean HEAD and its pushed branch', () => {
    const io = readinessFixture();
    expect(io.live.ready()).toEqual({ sha: SHA, ref: REF });
    expect(io.execGh).toHaveBeenCalledWith('gh', ['auth', 'status', '--hostname', 'github.com'], expect.any(Object));
    expect(io.execFile.mock.calls.find(([, args]) => args.includes('status'))[1]).toContain('--untracked-files=all');
    expect(io.execGh).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', 'repos/web-everything/web-everything/commits/main'], expect.any(Object));
  });
  it.each([
    ['different tree', { base: { sha: 'b'.repeat(40), commit: { tree: { sha: 'd'.repeat(40) } } } }],
    ['unreadable main', { unavailable: true }],
    ['missing main', { base: null }],
    ['missing HEAD tree', { head: { sha: SHA } }],
    ['wrong HEAD', { head: { sha: 'e'.repeat(40), commit: { tree: { sha: 'c'.repeat(40) } } } }],
    ['malformed main SHA', { base: { sha: 'bad', commit: { tree: { sha: 'c'.repeat(40) } } } }],
    ['noncanonical origin', { origin: 'https://github.com/example/fork.git' }],
  ])('preflights %s before any lane/full dispatch', async (_name, changes) => {
    for (const mode of ['lane-check', 'full']) {
      const io = readinessFixture(changes);
      const importer = vi.fn();
      expect(() => io.live.ready()).toThrow();
      expect(await runRemoteCLI({ ref: REF, mode }, { live: io.live, execFile: importer, quietFailure: true })).toBe(2);
      expect(io.execGh.mock.calls.some(([, args]) => args[0] === 'workflow')).toBe(false);
      expect(importer).not.toHaveBeenCalled();
    }
  });
  it('pins GitHub host, bypasses both caches, and bounds argv-only children', () => {
    const execFile = vi.fn().mockReturnValue('https://github.com/example/repo.git\n');
    const execGh = vi.fn().mockReturnValue('{}');
    const live = remoteIO('.', { env: { GH_HOST: 'foreign.example', WE_GH_READ_MEMO_DIR: '/unused', WE_FINISHED_CI_CACHE: '1' }, execFile, execGh });
    live.api('actions/runs/123');
    expect(execGh).toHaveBeenCalledTimes(1);
    expect(execGh).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', 'repos/example/repo/actions/runs/123'],
      expect.objectContaining({ timeout: 15000, maxBuffer: 2 * 1024 * 1024 }));
    const options = execGh.mock.calls[0][2];
    for (const env of [options.env, options.throttle.env]) {
      expect(env.GH_HOST).toBe('github.com');
      expect(env.WE_FINISHED_CI_CACHE).toBe('0');
      expect(env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
    }
    expect(execFile.mock.calls[0][1]).toEqual(expect.any(Array));
    expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    expect(options.shell).toBeUndefined();
  });
});

it('remote-test script rejects invalid arguments with usage and exit 3', () => {
  const result = spawnSync(process.execPath, [join(REPO, 'scripts/remote-test.mjs'), '--mode=invalid'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  expect(result.status).toBe(3);
  expect(result.stderr).toContain('Usage: remote-test');
  expect(result.stdout).toBe('');
});

describe('CLI marker delegation', () => {
  const title = (options = {}) => `remote-verify ${JSON.stringify({ ref: '', mode: 'lane-check', tests: '', operation: '', ...options })}`;
  function workflowTitle(options) {
    const workflow = yaml.load(readFileSync(join(REPO, '.github/workflows/remote-verify.yml'), 'utf8'));
    const inputs = Object.fromEntries(Object.entries(workflow.on.workflow_dispatch.inputs)
      .map(([key, definition]) => [key, definition.default ?? '']));
    const argv = buildDispatchArgs(options);
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] !== '-f') continue;
      const field = argv[++index];
      const separator = field.indexOf('=');
      inputs[field.slice(0, separator)] = field.slice(separator + 1);
    }
    // Evaluate only the expressions this workflow uses; unknown syntax fails the contract test.
    return workflow['run-name'].replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_match, expression) => {
      if (expression === 'toJSON(inputs)') return JSON.stringify(inputs, null, 2);
      if (expression === "inputs.mode || 'lane-check'") return inputs.mode || 'lane-check';
      throw new Error(`Unsupported workflow title expression: ${expression}`);
    });
  }
  function fixture({ preExisting = [], postDispatch, mode = 'lane-check', inputs = {} } = {}) {
    const run = { id: 123, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF,
      created_at: CREATED_AFTER, status: 'completed', conclusion: 'success', display_title: title({ mode, ...inputs }) };
    let dispatched = false;
    let clock = Date.parse('2026-10-24T12:00:00.750Z');
    return { live: { ready: vi.fn().mockReturnValue({ sha: SHA }), gh: vi.fn(() => { dispatched = true; }),
      api: vi.fn(path => path.startsWith('commits/') ? { sha: SHA }
        : path.includes('workflows/') ? (() => {
          const runs = dispatched ? postDispatch ?? [...preExisting, run] : preExisting;
          return { total_count: runs.length, workflow_runs: runs };
        })() : run) }, execFile: vi.fn(), now: () => clock,
      pause: vi.fn(async ms => { clock += ms; }) };
  }
  it.each([
    { mode: 'lane-check' },
    { mode: 'full' },
    { mode: 'targeted', tests },
    { mode: 'targeted', operation: 'check-standards' },
  ])('discovers and waits for the rendered checked-in workflow title: %j', async request => {
    const options = { ref: REF, ...request };
    const display_title = workflowTitle(options);
    const run = { id: 123, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF, created_at: CREATED_AFTER,
      status: 'completed', conclusion: 'success', display_title };
    const io = fixture({ postDispatch: [run] });
    const api = io.live.api.getMockImplementation();
    io.live.api.mockImplementation(path => path === 'actions/runs/123' ? run : api(path));
    expect(await runRemoteCLI(options, { ...io, quietFailure: true })).toBe(0);
    expect(io.live.api).toHaveBeenCalledWith('actions/runs/123');
    expect(io.pause).not.toHaveBeenCalled();
    expect(io.execFile).toHaveBeenCalledTimes(request.mode === 'targeted' ? 0 : 1);
  });
  it.each(['lane-check', 'full'])('imports green %s through verify-lane remote with argv', async mode => {
    const io = fixture({ mode });
    expect(await runRemoteCLI({ ref: REF, mode }, io)).toBe(0);
    expect(io.live.gh).toHaveBeenCalledTimes(1);
    expect(io.live.gh).toHaveBeenCalledWith(buildDispatchArgs({ ref: REF, mode }));
    expect(io.execFile).toHaveBeenCalledTimes(1);
    expect(io.execFile).toHaveBeenCalledWith(process.execPath, ['scripts/verify-lane.mjs', 'remote'],
      expect.objectContaining({ timeout: 60000, maxBuffer: 2 * 1024 * 1024 }));
  });
  it.each(['pretty', 'whitespace-normalized'])('matches toJSON dispatch inputs with %s whitespace', async format => {
    const io = fixture();
    const api = io.live.api.getMockImplementation();
    io.live.api.mockImplementation(path => {
      const data = api(path);
      const changeTitle = run => {
        const pretty = JSON.stringify(JSON.parse(run.display_title.slice('remote-verify '.length)), null, 2);
        return { ...run, display_title: `remote-verify ${format === 'pretty' ? pretty : pretty.replace(/\s+/g, ' ')}` };
      };
      return data.workflow_runs ? { ...data, workflow_runs: data.workflow_runs.map(changeTitle) }
        : data.display_title ? changeTitle(data) : data;
    });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, io)).toBe(0);
    expect(io.execFile).toHaveBeenCalledOnce();
  });
  it('returns failure when the marker importer refuses, allowing auto-route local fallback', async () => {
    const io = fixture();
    io.execFile.mockImplementation(() => { throw new Error('import refused'); });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, io)).toBe(2);
  });
  it('refuses a moved ref before dispatch or marker import', async () => {
    const io = fixture();
    io.live.api.mockReturnValue({ sha: 'b'.repeat(40) });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
    expect(io.live.gh).not.toHaveBeenCalled();
    expect(io.execFile).not.toHaveBeenCalled();
  });

  it('accepts a newly dispatched same-second run while rejecting pre-existing same-second runs', async () => {
    const preExisting = [{ id: 999, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF,
      created_at: CREATED_AFTER, status: 'completed', conclusion: 'success' }];
    const io = fixture({ preExisting });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, io)).toBe(0);
    expect(io.live.api).toHaveBeenCalledWith('actions/runs/123');
    expect(io.live.api).not.toHaveBeenCalledWith('actions/runs/999');
    expect(io.execFile).toHaveBeenCalledOnce();
    expect(io.pause).not.toHaveBeenCalled();
    // Baseline evidence must be read before dispatch, not inferred from a later listing.
    expect(io.live.api.mock.invocationCallOrder[1]).toBeLessThan(io.live.gh.mock.invocationCallOrder[0]);
  });

  it('times out and falls back when only pre-existing same-second runs are available', async () => {
    const preExisting = [{ id: 123, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF,
      created_at: CREATED_AFTER, status: 'completed', conclusion: 'success' }];
    const io = fixture({ preExisting, postDispatch: preExisting });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
    expect(io.live.api).not.toHaveBeenCalledWith('actions/runs/123');
    expect(io.execFile).not.toHaveBeenCalled();
    expect(io.pause).toHaveBeenCalledTimes(12);
  });

  it.each(['incomplete', 'oversized'])('refuses an %s pre-dispatch snapshot before dispatch', async kind => {
    const io = fixture();
    const runs = Array.from({ length: kind === 'oversized' ? 101 : 1 }, (_, index) => ({
      id: index + 1, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF, created_at: CREATED_AFTER,
    }));
    io.live.api.mockImplementation(path => path.startsWith('commits/') ? { sha: SHA }
      : { total_count: kind === 'incomplete' ? 2 : runs.length, workflow_runs: runs });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
    expect(io.live.gh).not.toHaveBeenCalled();
    expect(io.execFile).not.toHaveBeenCalled();
  });

  it.each([
    [{ tests: ['blocks/failing.test.ts'] }, { mode: 'full' }],
    [{ tests: ['blocks/failing.test.ts'] }, { mode: 'targeted', tests: 'blocks/other.test.ts' }],
    [{ operation: 'check-standards' }, { mode: 'targeted', operation: 'test-unit' }],
    [{ operation: 'check-standards' }, { mode: 'targeted', operation: 'check-standards', ref: 'other/ref' }],
  ])('rejects successful concurrent same-SHA dispatches with different inputs and preserves the requested failure: %j', async (request, unrelated) => {
    const options = { ref: REF, mode: 'targeted', ...request };
    const requested = { id: 123, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF, created_at: CREATED_AFTER,
      status: 'completed', conclusion: 'failure', display_title: title({ mode: 'targeted',
        tests: (request.tests ?? []).join(' '), operation: request.operation ?? '' }) };
    const foreign = { ...requested, id: 999, conclusion: 'success', display_title: title(unrelated) };
    const io = fixture({ postDispatch: [requested, foreign] });
    const api = io.live.api.getMockImplementation();
    io.live.api.mockImplementation(path => path === 'actions/runs/123' ? requested
      : path === 'actions/runs/999' ? foreign : api(path));
    expect(await runRemoteCLI(options, { ...io, quietFailure: true })).toBe(2);
    expect(io.live.api).toHaveBeenCalledWith('actions/runs/123');
    expect(io.live.api).not.toHaveBeenCalledWith('actions/runs/999');
    expect(io.execFile).not.toHaveBeenCalled();
    expect(io.pause).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Remote verify', 'remote-verify {bad', title({ tests: 'unexpected.test.ts' })])
    ('fails closed when fresh run input evidence is missing, malformed or mismatched: %j', async display_title => {
      const run = { id: 123, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF, created_at: CREATED_AFTER,
        status: 'completed', conclusion: 'success', display_title };
      const io = fixture({ postDispatch: [run] });
      expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
      expect(io.live.api).not.toHaveBeenCalledWith('actions/runs/123');
      expect(io.execFile).not.toHaveBeenCalled();
    });

  it.each(['lane-check', 'full', 'targeted'])('ignores a successful same-SHA run on another branch in %s discovery', async mode => {
    const inputs = mode === 'targeted' ? { tests: tests.join(' ') } : {};
    const requested = { id: 123, event: 'workflow_dispatch', head_sha: SHA, head_branch: REF,
      created_at: CREATED_AFTER, status: 'completed', conclusion: 'failure', display_title: title({ mode, ...inputs }) };
    const foreign = { ...requested, id: 999, head_branch: 'lane/other', conclusion: 'success' };
    const io = fixture({ postDispatch: [requested, foreign] });
    const api = io.live.api.getMockImplementation();
    io.live.api.mockImplementation(path => path === 'actions/runs/123' ? requested
      : path === 'actions/runs/999' ? foreign : api(path));
    expect(await runRemoteCLI({ ref: REF, mode, ...(mode === 'targeted' ? { tests } : {}) },
      { ...io, quietFailure: true })).toBe(2);
    expect(io.live.api).toHaveBeenCalledWith('actions/runs/123');
    expect(io.live.api).not.toHaveBeenCalledWith('actions/runs/999');
    expect(io.execFile).not.toHaveBeenCalled();
    expect(io.pause).not.toHaveBeenCalled();
  });

  it.each(['lane/other', undefined, null, ''])('never selects same-SHA discovery evidence with branch %j', async head_branch => {
    const run = { id: 999, event: 'workflow_dispatch', head_sha: SHA, head_branch,
      created_at: CREATED_AFTER, status: 'completed', conclusion: 'success', display_title: title() };
    const io = fixture({ postDispatch: [run] });
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
    expect(io.live.api).not.toHaveBeenCalledWith('actions/runs/999');
    expect(io.execFile).not.toHaveBeenCalled();
    expect(io.pause).toHaveBeenCalledTimes(12);
  });

  it('scopes the pre-dispatch snapshot and subsequent listings to the encoded dispatched branch', async () => {
    const io = fixture();
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, io)).toBe(0);
    const listings = io.live.api.mock.calls.filter(([path]) => path.includes('workflows/'));
    expect(listings).toHaveLength(2);
    for (const [path] of listings) {
      expect(new URL(path, 'https://example.test/').searchParams.get('branch')).toBe(REF);
      expect(path).toContain(`branch=${encodeURIComponent(REF)}`);
    }
    expect(io.live.api.mock.invocationCallOrder[1]).toBeLessThan(io.live.gh.mock.invocationCallOrder[0]);
  });

  it.each(['lane/other', undefined])('rejects branch evidence changing to %j while waiting', async head_branch => {
    const io = fixture();
    const api = io.live.api.getMockImplementation();
    io.live.api.mockImplementation(path => path === 'actions/runs/123' ? { ...api(path), head_branch } : api(path));
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
    expect(io.live.api).toHaveBeenCalledWith('actions/runs/123');
    expect(io.execFile).not.toHaveBeenCalled();
  });

  it('rechecks dispatch inputs when waiting instead of accepting changed run evidence', async () => {
    const io = fixture();
    const api = io.live.api.getMockImplementation();
    io.live.api.mockImplementation(path => path === 'actions/runs/123'
      ? { ...api(path), display_title: title({ mode: 'targeted', tests: 'other.test.ts' }) } : api(path));
    expect(await runRemoteCLI({ ref: REF, mode: 'lane-check' }, { ...io, quietFailure: true })).toBe(2);
    expect(io.execFile).not.toHaveBeenCalled();
  });

  it.each([{ tests }, { operation: 'check-standards' }])
    ('accepts green targeted verification only with the matching normalized inputs: %j', async request => {
      const io = fixture({ mode: 'targeted', inputs: { tests: (request.tests ?? []).join(' '), operation: request.operation ?? '' } });
      expect(await runRemoteCLI({ ref: REF, mode: 'targeted', ...request }, io)).toBe(0);
      expect(io.live.ready).not.toHaveBeenCalled();
      expect(io.live.api).toHaveBeenCalledWith('actions/runs/123');
      expect(io.execFile).not.toHaveBeenCalled();
    });
});

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

  it('accepts a hyphenated operation instead of tests in targeted mode (formerly accepted check:standards)', () => {
    expect(parseArgs(['--ref', REF, '--mode', 'targeted', '--operation', 'check-standards']))
      .toMatchObject({ ref: REF, mode: 'targeted', operation: 'check-standards' });
  });

  it('pins CLI and workflow dispatcher operation regex equality', () => {
    const pattern = source => {
      const match = /const operationNamePattern = (\/[^\n]+\/);/.exec(source);
      expect(match).not.toBeNull();
      return match[1];
    };
    const cli = readFileSync(join(REPO, 'scripts/remote-test.mjs'), 'utf8');
    const dispatcher = readFileSync(join(REPO, 'scripts/lib/remote-verify-dispatch.mjs'), 'utf8');
    const workflow = readFileSync(join(REPO, '.github/workflows/remote-verify.yml'), 'utf8');
    expect(workflow).toContain("import { remoteVerifyCommands } from '../remote-verify-source/scripts/lib/remote-verify-dispatch.mjs'");
    expect(workflow).toContain('const commands = remoteVerifyCommands(');
    expect(pattern(cli)).toBe(pattern(dispatcher));
    expect(pattern(dispatcher)).toBe('/^[a-z][a-z0-9-]*$/');
    expect(dispatcher).toContain('operationNamePattern.test(name)');
  });

  it.each(['check:standards', 'Check', '1check', 'check_unit', 'check/unit', 'check.unit',
    'check@unit', 'check+unit', 'check unit'])
    ('rejects operation %j outside the workflow character set before dispatch', async operation => {
      usage(['--ref', REF, '--mode', 'targeted', '--operation', operation]);
      expect(() => buildDispatchArgs({ ref: REF, mode: 'targeted', operation })).toThrow(/usage/i);
      const { io } = fixture({ mode: 'targeted', operation });
      expect(await runRemoteTest(io)).toBe(3);
      expect(io.dispatch).not.toHaveBeenCalled();
    });

  it('accepts a commit SHA as a ref', () => {
    expect(parseArgs(['--ref', SHA, '--mode', 'full']).ref).toBe(SHA);
  });

  it.each([
    ['--mode', 'targeted', '--ref', REF],
    ['--mode', 'targeted', '--ref', REF, '--tests=a.test.ts', '--operation', 'test-unit'],
    ['--mode', 'targeted', '--ref', REF, '--tests= ,  '],
    ['--mode', 'targeted', '--ref', REF, '--operation', ''],
    ['--mode', 'unknown'], ['--mode'], ['--ref'], ['--operation'], ['--unknown'],
  ].map(argv => [argv]))('rejects invalid or incomplete usage %j', usage);

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
    expect(buildDispatchArgs({ ref: REF, mode: 'targeted', operation: 'check-standards' })).toEqual([
      'workflow', 'run', 'remote-verify.yml', '--ref', REF,
      '-f', 'mode=targeted', '-f', 'tests=', '-f', 'operation=check-standards',
    ]);
  });
});

// IO contract: dispatch receives gh argv and returns a receipt containing the
// pushed head_sha and a createdAfter timestamp captured before dispatch. findRun
// receives { createdAfter, headSha }; wait receives { runId, timeoutMs }.
// A live receipt also carries a complete existingRunIds snapshot, forwarded to
// findRun and checked again before wait to admit fresh second-precision timestamps.
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
    expect(io.dispatch).toHaveBeenCalledTimes(1);
    expect(io.dispatch).toHaveBeenCalledWith(buildDispatchArgs({ ref: REF, mode: 'lane-check' }));
    expect(io.findRun).toHaveBeenCalledTimes(1);
    expect(io.findRun).toHaveBeenCalledWith(expect.objectContaining({
      createdAfter: CREATED_AFTER, headSha: SHA,
    }));
    expect(io.wait).toHaveBeenCalledTimes(1);
    expect(io.wait).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id, timeoutMs: 540000 }));
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

  it.each([NaN, Infinity, -1, '123', null])('refuses invalid timeout %s before dispatch', async timeoutMs => {
    const { io } = fixture({ timeoutMs });
    expect(await runRemoteTest(io)).toBe(2);
    expect(io.dispatch).not.toHaveBeenCalled();
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ recordMarker: false, reason: expect.stringContaining('local verify') }));
  });

  it.each([
    { mode: 'unknown' }, { mode: 'targeted' },
    { mode: 'targeted', tests, operation: 'test-unit' },
    { mode: 'targeted', tests: ['a;echo bad'] }, { ref: '$(id)' },
    { mode: 'targeted', tests: Array(201).fill('a.test.ts') },
    { ref: 'x'.repeat(4097) },
  ])('returns usage code 3 before IO for invalid options %j', async (options) => {
    const { io } = fixture(options);
    expect(await runRemoteTest(io)).toBe(3);
    expect(io.dispatch).not.toHaveBeenCalled();
    expect(io.findRun).not.toHaveBeenCalled();
    expect(io.wait).not.toHaveBeenCalled();
    expect(io.print).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 3, recordMarker: false }));
  });
});
