/**
 * @file deliver-item-run.test.mjs — the restartable per-dispatch CLI entry point
 * (`we:scripts/operations/deliver-item-run.mjs`): argv/CLI tests plus isolated real-process
 * preflight regressions. The mixed-locus child must terminate before any agent can spawn.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROUTING_POLICY } from '../../lib/dispatch-routing-policy.mjs';
import { createFileRunStore, newRunRecord } from '../run-store.mjs';
import {
  parseDeliverItemRunArgv, selectDeliveryAgentProvider, runDeliverItemCli,
} from '../deliver-item-run.mjs';

describe('parseDeliverItemRunArgv', () => {
  it('parses the required flags plus optional scope/attempt/provider/run-id/effect-key', () => {
    const launch = parseDeliverItemRunArgv([
      '--num=3645', '--lane=2', '--session=conveyor-3645', '--scope=we:scripts/foo.mjs', '--attempt=b',
      '--provider=codex', '--run-id=dispatch-lane-abc', '--effect-key=dispatch',
    ]);
    expect(launch).toEqual({
      item: '3645', lane: '2', sessionSlug: 'conveyor-3645', scope: 'we:scripts/foo.mjs', attemptTag: 'b',
      provider: 'codex', runId: 'dispatch-lane-abc', effectKey: 'dispatch', resume: false,
    });
  });

  // #4349 — `--run-id=`/`--effect-key=` let `deliverItem` settle its own run-store effect on exit
  // (`deliver-item-settle.mjs`); both are optional so an older/hand-run dispatch still parses cleanly.
  it('defaults scope/attempt/provider/run-id/effect-key to empty strings, resume to false, when absent', () => {
    const launch = parseDeliverItemRunArgv(['--num=1', '--lane=2', '--session=s']);
    expect(launch).toEqual({
      item: '1', lane: '2', sessionSlug: 's', scope: '', attemptTag: '', provider: '', runId: '', effectKey: '',
      resume: false,
    });
  });

  // build-orphan-adopt (#4131/#4382) — a bare `--resume` parses true; `deliverItem`'s own `launch.resume`
  // rides this straight through to `runAgentToCompletion`'s resume branch (see that function's own docblock).
  it('parses a bare `--resume` flag to `resume: true`', () => {
    const launch = parseDeliverItemRunArgv(['--num=4131', '--lane=9', '--session=conveyor-4131', '--resume']);
    expect(launch.resume).toBe(true);
  });

  it('refuses a missing `--num=`, by name', () => {
    expect(() => parseDeliverItemRunArgv(['--lane=2', '--session=s']))
      .toThrow(/--num=/);
  });

  it('refuses a missing `--lane=`, by name', () => {
    expect(() => parseDeliverItemRunArgv(['--num=1', '--session=s']))
      .toThrow(/--lane=/);
  });

  it('refuses a missing `--session=`, by name', () => {
    expect(() => parseDeliverItemRunArgv(['--num=1', '--lane=2']))
      .toThrow(/--session=/);
  });

  it('refuses all missing required flags at once, naming every one', () => {
    expect(() => parseDeliverItemRunArgv([])).toThrow(/--num=.*--lane=.*--session=/s);
  });
});

describe('selectDeliveryAgentProvider', () => {
  it('defaults to claude-restricted when no flag value is given', () => {
    const selected = selectDeliveryAgentProvider('');
    expect(selected.name).toBe('claude-restricted');
    expect(selected.provider).toBeTruthy();
  });

  it('accepts `codex` by name and resolves to a provider whose `.vendor` is `codex`', () => {
    const selected = selectDeliveryAgentProvider('codex');
    expect(selected.name).toBe('codex');
    expect(selected.provider.vendor).toBe('codex');
  });

  it('throws on an unknown provider name', () => {
    expect(() => selectDeliveryAgentProvider('gpt-5')).toThrow(/--provider must be one of/);
  });
});

describe('runDeliverItemCli (injected `deliver` fake — no real process spawn)', () => {
  const baseArgv = ['--num=42', '--lane=3', '--session=conveyor-42'];

  it('leaves unpinned Codex effort to the build task route', async () => {
    const spawn = vi.fn();
    await runDeliverItemCli([...baseArgv, '--provider=codex'], {
      selectProvider: () => ({ name: 'codex', provider: { vendor: 'codex', spawn } }),
      deliver: async (launch, provider) => { await provider.spawn({}); return { result: 'done' }; },
      write: () => {}, writeErr: () => {},
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ taskKind: 'build' }));
    expect(spawn.mock.calls[0][0].effort).toBeUndefined();
    expect(spawn.mock.calls[0][0].model).toBeUndefined();
  });

  it('preserves an explicit new catalogue model and effort without the old policy catalogue rejecting it', async () => {
    const spawn = vi.fn();
    const result = await runDeliverItemCli([...baseArgv, '--provider=codex', '--model=gpt-6.1-sol', '--effort=high'], {
      selectProvider: () => ({ name: 'codex', provider: { vendor: 'codex', spawn } }),
      deliver: async (_launch, provider) => { await provider.spawn({}); return { result: 'done' }; },
      write: () => {}, writeErr: () => {},
    });
    expect(result.code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ taskKind: 'build', model: 'gpt-6.1-sol', effort: 'high' }));
  });

  it.each([undefined, 'high'])('only forwards an actually configured Codex effort (%s)', async effort => {
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.criticalWorkGate.kinds = [];
    policy.operations.build = { provider: 'codex', model: 'astra', fallback: [], ...(effort ? { effort } : {}) };
    const spawn = vi.fn();
    const result = await runDeliverItemCli(baseArgv, {
      readPolicy: () => policy,
      selectProvider: () => ({ name: 'codex', provider: { vendor: 'codex', spawn } }),
      deliver: async (_launch, provider) => { await provider.spawn({}); return { result: 'done' }; },
      write: () => {}, writeErr: () => {},
    });
    expect(result.code).toBe(0);
    expect(spawn.mock.calls[0][0].effort).toBe(effort);
    expect(spawn.mock.calls[0][0].model).toBe('gpt-6-astra');
  });

  it('#4357 prints the refusal reason supplied by delivery', async () => {
    const write = vi.fn();
    await runDeliverItemCli(baseArgv, {
      deliver: async () => ({ result: 'open-refused (unverified): stale verification' }), write,
    });
    expect(write).toHaveBeenCalledWith('deliver-item-run: #42 finished — open-refused (unverified): stale verification\n');
    expect(write.mock.calls.flat().join('')).not.toContain('PR #null');
  });

  it('exits 0 and returns the result on success', async () => {
    const deliver = vi.fn(async () => ({ item: '42', result: 'PR #99 (soft)' }));
    const write = vi.fn();
    const writeErr = vi.fn();
    const { code, result } = await runDeliverItemCli(baseArgv, { deliver, write, writeErr });
    expect(code).toBe(0);
    expect(result).toEqual({ item: '42', result: 'PR #99 (soft)' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(writeErr).not.toHaveBeenCalled();
  });

  it('#4649 exits 1 and settles the original error when deliver throws', async () => {
    const deliver = vi.fn(async () => { throw new Error('acquire refused'); });
    const write = vi.fn();
    const writeErr = vi.fn();
    const settle = vi.fn();
    const { code, result } = await runDeliverItemCli([...baseArgv, '--run-id=run-42', '--effect-key=dispatch'], { deliver, write, writeErr, settle });
    expect(code).toBe(1);
    expect(result).toBeNull();
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining('acquire refused'));
    expect(writeErr.mock.calls.flat().join('')).not.toContain('released');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({ runId: 'run-42', key: 'dispatch', status: 'failed', error: 'acquire refused', result: { outcome: 'wrapper-threw' } });
  });

  it('exits 1 on a bad `--provider=`, BEFORE `deliver` is ever called', async () => {
    const settle = vi.fn();
    const deliver = vi.fn(async () => ({ item: '42', result: 'should never run' }));
    const write = vi.fn();
    const writeErr = vi.fn();
    const { code, result } = await runDeliverItemCli([...baseArgv, '--provider=not-a-real-provider'], {
      deliver, write, writeErr, settle,
    });
    expect(code).toBe(1);
    expect(result).toBeNull();
    expect(deliver).not.toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining('--provider must be one of'));
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toMatchObject({ status: 'failed', error: expect.stringContaining('--provider must be one of') });
  });
});


describe('#4649 real process preflight boundaries', () => {
  // The incident scope, before #4289 split #4620, preserved independently of the live card.
  const scope = ['we:contracts/plateau-progress-view.schema.json', 'we:contracts/plateau-progress-view.examples.json',
    ...['types.ts', 'wip-read.ts', 'wip-model.ts', 'wip-view.ts', 'wip-view.css', 'wip-source.ts', 'wip-live.ts',
      'progress-read.ts', 'progress-read.test.ts', 'wip-model.test.ts', 'wip-view.test.ts', 'wip-source.test.ts',
      'wip-publish.ts', 'wip-publish.test.ts', 'wip-api.ts', 'wip-read.test.ts', 'wip-view.hostile.test.ts']
      .map((path) => `plateau-app:src/wip/${path}`),
    'plateau-app:tools/drain-daemon/cli.mjs', 'plateau-app:src/wip/wip-relay-contract.test.ts',
    'plateau-app:scripts/wip-publish.ts', 'plateau-app:wip-relay.js'];

  function isolated() {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-4649-'));
    const pool = join(dir, 'pool');
    const lease = join(pool, 'lane-15', '.git', '.lane-lease');
    mkdirSync(join(pool, 'lane-15', '.git'), { recursive: true });
    const before = JSON.stringify({ session: 'foreign-holder', holder: 'foreign-holder', reserved: true, acquiredAt: new Date().toISOString(), pid: process.pid });
    writeFileSync(lease, before);
    return { dir, pool, lease, before, env: { ...process.env, LANE_POOL_ROOT: pool,
      OPERATION_RUNS_DIR: join(dir, 'runs'), WE_COORDINATION_ROOT: join(dir, 'coord'),
      OPERATION_TELEMETRY_DIR: join(dir, 'telemetry'), WE_BACKLOG_DIR: join(dir, 'backlog') } };
  }

  it('the actual child settles failed, releases its claim and leaves the foreign lease byte-identical', () => {
    const f = isolated();
    try {
      const store = createFileRunStore(f.env.OPERATION_RUNS_DIR);
      store.write({ ...newRunRecord({ id: 'mixed-child', op: 'dispatch-lane' }),
        effects: [{ key: 'dispatch', type: 'conveyor.dispatch-delivery-agent', stepIndex: 0, index: 0,
          status: 'in-flight', payload: { num: '4620', launchKind: 'build' }, result: null, error: null }] });
      const claimModule = pathToFileURL(resolve('scripts/conveyor/build-dispatch-claim.mjs')).href;
      const seed = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { acquireBuildDispatchClaim } from ${JSON.stringify(claimModule)}; acquireBuildDispatchClaim({ num: '4620', scope: [] });`], { env: f.env, encoding: 'utf8' });
      expect(seed.status, seed.stderr).toBe(0);
      const child = spawnSync(process.execPath, ['scripts/operations/deliver-item-run.mjs', '--num=4620', '--lane=15',
        '--session=conveyor-4620', '--provider=claude-restricted', `--scope=${scope.join(',')}`, '--run-id=mixed-child', '--effect-key=dispatch'],
      { env: f.env, encoding: 'utf8', timeout: 15000 });
      console.log(JSON.stringify({ probe: '4649-child-state', exit: child.status, effect: store.read('mixed-child').effects[0] }));
      expect(child.status, child.stderr).toBe(1);
      expect(child.stderr).toContain('more than one repo (we, plateau-app)');
      expect(child.stderr).not.toContain('released');
      const entry = store.read('mixed-child').effects[0];
      expect(entry).toMatchObject({ status: 'failed', result: { outcome: 'unsupported-locus' }, error: expect.stringContaining('#4289') });
      const claims = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { listBuildDispatchClaims } from ${JSON.stringify(claimModule)}; console.log(JSON.stringify(listBuildDispatchClaims()));`], { env: f.env, encoding: 'utf8' });
      expect(claims.status, claims.stderr).toBe(0);
      expect(JSON.parse(claims.stdout)).toEqual([]);
      expect(readFileSync(f.lease, 'utf8')).toBe(f.before);
      expect(readdirSync(f.pool)).toEqual(['lane-15']);
      console.log(JSON.stringify({ probe: '4649-child', exit: child.status, status: entry.status, outcome: entry.result.outcome, error: entry.error, claims: [], foreignLeaseUnchanged: true }));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  it('actual operation CLI reads mixed scope from the temporary backlog and declares zero effects', () => {
    const f = isolated();
    try {
      mkdirSync(f.env.WE_BACKLOG_DIR, { recursive: true });
      mkdirSync(join(f.dir, '.git'));
      writeFileSync(join(f.env.WE_BACKLOG_DIR, '4620-mixed-locus.md'), `---\nkind: story\nsize: 5\nstatus: open\nscope: ${JSON.stringify(scope)}\n---\n# Mixed locus\n`);
      // The operation/reader/loader/store are real. External planner/GitHub/Git reads are supplied;
      // freshness observes a current checkout and writes its cache only in the temporary Git directory.
      // every unexpected subprocess fails, and every async spawn is fatal (no detached child can exist).
      const preload = `import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        const gitSubcommandArgs = (args) => {
          let offset = 0;
          while (args[offset] === '-c' && typeof args[offset + 1] === 'string' && args[offset + 1].includes('=')) offset += 2;
          return args.slice(offset);
        };
        cp.execFileSync = (cmd, args = []) => {
          if (String(args[0]).endsWith('/conveyor/tick-core.mjs')) return JSON.stringify({ decisions: { spawnBuilds: [{ num: '4620', lane: 15 }] }, nextState: {} });
          if (cmd === 'git') {
            args = gitSubcommandArgs(args);
            if (args.join(' ') === 'rev-parse --show-toplevel') return ${JSON.stringify(f.dir)};
            if (args.join(' ') === 'rev-parse --absolute-git-dir') return ${JSON.stringify(join(f.dir, '.git'))};
            if (args.join(' ') === 'remote get-url origin') return 'fixture-origin';
            if (args[0] === 'rev-parse' && args[1] === '--verify') return 'a'.repeat(40);
            if (args[0] === 'rev-list') return '0';
            if (args[0] === 'fetch') return '';
          }
          throw new Error('unexpected subprocess: ' + cmd + ' ' + args.join(' '));
        };
        cp.spawnSync = (cmd, args, opts) => { if (cmd === 'git') { args = gitSubcommandArgs(args); return { status: 0, stdout: args[0] === 'symbolic-ref' ? 'main' : args[0] === 'rev-list' ? '0' : '', stderr: '' }; } if (cmd === 'gh') return { status: 0, stdout: '[]', stderr: '' }; throw new Error('unexpected sync spawn: ' + cmd); };
        cp.spawn = () => { process.stderr.write('UNEXPECTED_DETACHED_SPAWN'); process.exit(91); };
        syncBuiltinESMExports();`;
      const cli = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        'scripts/operations/run.mjs', 'dispatch-lane', '--num=4620', '--json'],
      { env: { ...f.env, WE_OPERATION_ALLOW_STALE: '', WE_DAEMON_MANAGED_CLONE: '' }, encoding: 'utf8', timeout: 20000 });
      expect(cli.status, cli.stderr).toBe(0);
      const observed = JSON.parse(cli.stdout);
      console.log(JSON.stringify({ probe: '4649-cli-state', exit: cli.status, dispatching: observed.verdict?.dispatching, inFlight: observed.inFlight, stopped: observed.stopped }));
      const output = JSON.parse(cli.stdout);
      expect(output.verdict.dispatching).toBe(false);
      expect(output.findings.read.gates).toContainEqual({ name: 'locus', pass: false, observed: { kind: 'unsupported-locus', keys: ['we', 'plateau-app'] } });
      expect(JSON.stringify(output)).toContain('#4289');
      const store = createFileRunStore(f.env.OPERATION_RUNS_DIR);
      const records = readdirSync(f.env.OPERATION_RUNS_DIR).filter((name) => name.endsWith('.json')).map((name) => store.read(name.slice(0, -5)));
      expect(records.length).toBeGreaterThan(0);
      expect(records.flatMap((run) => run.effects)).toEqual([]);
      expect(readFileSync(f.lease, 'utf8')).toBe(f.before);
      expect(readdirSync(f.pool)).toEqual(['lane-15']);
      expect(cli.stderr).not.toContain('UNEXPECTED_DETACHED_SPAWN');
      console.log(JSON.stringify({ probe: '4649-dispatch-cli', stopped: output.stopped, verdict: output.verdict, locus: output.findings.read.gates.find((gate) => gate.name === 'locus'), effects: [], foreignLeaseUnchanged: true }));
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});

describe('group member argv', () => {
  it('passes numeric and JIT member ids through to delivery', () => {
    expect(parseDeliverItemRunArgv(['--num=1', '--lane=2', '--session=s', '--group-members=2,xabc123']).groupMembers)
      .toEqual(['2', 'xabc123']);
  });
  it('refuses malformed member ids before a lane is acquired', () => {
    expect(() => parseDeliverItemRunArgv(['--num=1', '--lane=2', '--session=s', '--group-members=2,../bad']))
      .toThrow(/group.*member/i);
  });
});
