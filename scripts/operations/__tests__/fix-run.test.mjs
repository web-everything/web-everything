import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, linkSync, truncateSync } from 'node:fs';
import * as realFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixBorrowGate, recordRoutedOutcome, consecutiveUnproductiveOnHead, chooseFixExecutor } from '../../lib/fix-slot-borrow.mjs';
import { LANE_GIT_CONFIG_PINS, laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';
import { dispatchFix, writePrivateBorrowedPrompt } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { buildFixEndComment } from '../../conveyor/fix-procedure.mjs';
import { resolveFixBorrowSettings } from '../../lib/dispatch-throttle.mjs';
import * as directLaunchSettings from '../../lib/direct-launch-settings.mjs';
import { fixDetachedProvider, fixLauncherAvailable, FIX_RUN_SCRIPT, FIX_RUN_EXECUTORS, FIX_RUN_CONFINEMENT } from '../dispatch-providers/fix.mjs';
import { resolveDeliveryAgentProvider } from '../deliver-item-wrapper.mjs';
import { childFailureReason, resolveAcquireWaitPolicy, parseFixRunArgv, readCiHealInputs, renderCiHealContext, renderPrContext, runFixCli, SANDBOX_PREAMBLE, HARDENED_GIT_ARGS, defaultPendingRearm, removePromptFile, riskyLaneConfig, changedPaths, escalationComment, readLaneFileSafe, laneStageEntry, unmergedPaths, MAX_CONFLICTED_PATHS, BLOB_MAX_BYTES, STAGE_MAX_BYTES } from '../fix-run.mjs';

// x6nuodj — these tests pin the LEGACY gate's verdicts, so the shared decision only observes here (`shadow`); the
// cut-over itself (admit() deciding) is covered in we:scripts/lib/__tests__/resource-gate.test.mjs.
beforeEach(() => { vi.stubEnv('WE_RESOURCE_CUTOVER', 'shadow'); vi.stubEnv('WE_RESOURCE_SHADOW', 'off'); });
afterEach(() => vi.unstubAllEnvs());


const MIN = 60_000;
/** Whether a recorded command staged anything (`git add` against the private copy, or a direct index write). */
const staged = (c) => c.includes('add') || c.includes('update-index');
let clock = 1_000_000;
const ledger = () => { let v = {}; return { read: () => v, write: (x) => { v = x; } }; };
const codexGate = () => createFixBorrowGate({ sample: () => ({ ok: false }),
  env: {}, settings: { enabled: true, afterMinutes: 15, executor: 'codex' }, ledger: ledger(), now: () => clock,
  loadavg: () => 1, cpuCount: () => 12, caps: { claude: 1, external: 4 },
  launcherAvailable: (e) => fixLauncherAvailable(e),
});

describe('a codex borrow is accepted once fix-run exists (red before: "no codex fix launcher in this checkout")', () => {
  it('the run script exists and the gate borrows codex', () => {
    expect(existsSync(FIX_RUN_SCRIPT)).toBe(true);
    clock = 1_000_000;
    const g = codexGate();
    g.consider({ pr: 7 });
    clock += 16 * MIN;
    expect(g.consider({ pr: 7 })).toMatchObject({ borrow: true, executor: 'codex' });
  });
  it('agy has no delivery provider, so it stays refused; claude never needs the script', () => {
    expect(fixLauncherAvailable('agy-claude')).toBe(false);
    expect(fixLauncherAvailable('claude')).toBe(true);
  });
  it('our shipped config borrows with codex', () => {
    expect(resolveFixBorrowSettings({ env: {} })).toMatchObject({ enabled: true, executor: 'codex' });
  });
});

describe('a codex borrow launches through fix-run with the filled brief', () => {
  it.each([{ isConflict: true, baseRefName: 'develop', mergeOnto: 'develop' }, { restack: { onto: 'lane/base' }, mergeOnto: 'lane/base' }])('dispatchFix forwards the merge target with the filled brief (%j)', (entry) => {
    const spawnBorrowed = vi.fn(() => 'pid:4242');
    const spawnAgent = vi.fn();
    const writeBorrowedPrompt = vi.fn(() => '/tmp/p.md');
    const out = dispatchFix({
      ...entry, pr: 7, itemNum: '7', lane: 2, laneRef: 'lane/7-x', scope: ['we:a.mjs'], overlapScope: ['we:a.mjs'], headRefOid: 'abc',
    }, {
      root: '/repo', repo: 'we', borrowed: { executor: 'codex', reason: 'borrowed-build-slot' },
      assertNotALaneCheckout: undefined,
      readFixClaim: () => null,
      acquireClaim: vi.fn(() => ({ ok: true })), releaseClaim: vi.fn(),
      postNotice: () => {}, readBrief: () => 'brief {{PR_NUM}} {{LANE_REF}}', spawnBorrowed, spawnAgent, writeBorrowedPrompt,
      checkoutExists: () => true, readPackageJson: () => ({ scripts: {} }),
    });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(writeBorrowedPrompt).toHaveBeenCalledTimes(1);
    expect(writeBorrowedPrompt.mock.calls[0][1]).toContain('brief 7 lane/7-x');
    expect(spawnBorrowed).toHaveBeenCalledWith(expect.objectContaining({
      pr: 7, ref: 'lane/7-x', mergeOnto: entry.mergeOnto, promptFile: '/tmp/p.md', policyRoute: { provider: 'codex' },
    }));
    expect(out.agentId).toBe('pid:4242');
  });
  it('fixDetachedProvider forwards the prompt file, ref and --provider=codex to fix-run', () => {
    const spawnDetached = vi.fn(() => ({ pid: 99 }));
    const h = fixDetachedProvider({
      pr: 7, sessionSlug: 'fix-7', ref: 'lane/7-x', mergeOnto: 'main', promptFile: '/tmp/p.md', repo: 'o/r', laneRepo: '/w', scope: 'we:a.mjs',
      policyRoute: { provider: 'codex' },
    }, { spawnDetached, logPathFor: () => '/tmp/l', readDeliveryAgentMarker: () => null });
    expect(h).toBe('pid:99');
    const argv = spawnDetached.mock.calls[0][0];
    expect(argv[0]).toBe(FIX_RUN_SCRIPT);
    expect(parseFixRunArgv(argv.slice(1))).toMatchObject({ pr: '7', provider: 'codex', ref: 'lane/7-x', mergeOnto: 'main', promptFile: '/tmp/p.md', repo: 'o/r' });
  });
});

describe('runFixCli', () => {
  const argv = ['--pr=7', '--session=fix-7', '--ref=lane/7-x', '--prompt-file=/p.md', '--provider=codex', '--repo=o/r', '--lane-repo=/w'];
  const mk = (heads) => {
    const calls = [];
    const envs = [];
    const run = vi.fn((cmd, args, opts) => {
      calls.push([cmd, ...args]);
      envs.push(opts?.env);
      if (cmd === 'gh') return JSON.stringify({ title: 'T', body: 'B' });
      if (args.includes('acquire')) return 'noise\n/lanes/lane-5\n';
      if (args.includes('--absolute-git-dir')) return tmpdir(); // the staging copy is made (and removed) under it
      if (args[0] === 'rev-parse') return heads.shift();
      return '';
    });
    const spawn = vi.fn(async () => {});
    const owed = { sha: null };
    const pendingRearm = {
      read: vi.fn(() => (owed.sha ? { sha: owed.sha, at: 0 } : null)),
      write: vi.fn((_r, _p, sha) => { owed.sha = sha; }),
      clear: vi.fn(() => { owed.sha = null; }),
    };
    return { calls, envs, run, spawn, owed, pendingRearm, io: { recordPush: () => {}, run, pendingRearm, readComments: async () => [{ createdAt: '2026-01-01', body: '🔁 review — changes requested\nFIX THE THING' }], releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}), appendLoopRow: () => {}, removePrompt: () => {}, readPrompt: () => 'BRIEF', resolveProvider: () => ({ spawn }), weRoot: '/we', write: () => {}, writeErr: () => {} } };
  };
  it('continues repair when directLaunchLogLine throws', async () => {
    const m = mk(['aaa', 'aaa']);
    const logLine = vi.spyOn(directLaunchSettings, 'directLaunchLogLine').mockImplementationOnce(() => {
      throw new Error('settings unavailable');
    });
    try {
      const { code, result } = await runFixCli(argv, m.io);
      expect(logLine).toHaveBeenCalledWith({ kind: 'fix' });
      expect(code).toBe(0);
      expect(result).toMatch(/no-change/);
      expect(m.spawn).toHaveBeenCalledTimes(1);
      expect(m.calls.at(-1)).toContain('release');
    } finally {
      logLine.mockRestore();
    }
  });
  it.each([undefined, '42', '0'])('passes the acquire wait policy (%s)', async value => {
    if (value === undefined) vi.stubEnv('WE_FIX_RUN_ACQUIRE_WAIT_MS', '');
    else vi.stubEnv('WE_FIX_RUN_ACQUIRE_WAIT_MS', value);
    try {
      const m = mk(['aaa', 'aaa']);
      const write = vi.fn();
      await runFixCli(argv, { ...m.io, write });
      const ms = value === undefined ? 120000 : Number(value);
      expect(m.calls.find(c => c.includes('acquire'))).toContain(`--wait-ms=${ms}`);
      expect(write).toHaveBeenCalledWith(`fix-run: lane acquire wait ${ms}ms (${value === undefined ? 'standard' : 'env'})\n`);
    } finally { vi.unstubAllEnvs(); }
  });
  it('records the child diagnostic while logging the complete acquire error', async () => {
    const m = mk([]);
    const recordOutcome = vi.fn(), writeErr = vi.fn();
    const error = Object.assign(new Error('Command failed: node scripts/lane-pool.mjs acquire --session=long'), {
      stderr: 'noise\n✗ lock contention: retry\n',
    });
    const run = (cmd, args, opts) => {
      if (args.includes('acquire')) throw error;
      return m.run(cmd, args, opts);
    };
    expect((await runFixCli(argv, { ...m.io, run, recordOutcome, writeErr })).code).toBe(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      reason: '✗ lock contention: retry (lane-pool.mjs acquire)',
    }));
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining(error.message));
  });
  it('records a no-change Argon outcome and resolves its provider', async () => {
    const m = mk(['aaa','aaa']), recordRouted = vi.fn(()=>({}));
    const resolveProvider = vi.fn(m.io.resolveProvider);
    expect((await runFixCli(argv.map(a=>a==='--provider=codex'?'--provider=antigravity':a), {...m.io,resolveProvider,recordRouted})).code).toBe(0);
    expect(resolveProvider).toHaveBeenCalledWith('antigravity');
    expect(recordRouted).toHaveBeenCalledWith(expect.objectContaining({head:'aaa',outcome:'no-change'}));
  });
  it.each(['codex', 'antigravity'])('retains the failed %s worker diagnosis in its ledger and escalation', async provider => {
    const m = mk(['aaa']);
    const diagnosis = `${provider}: worker diagnosis`;
    m.spawn.mockRejectedValue(Object.assign(new Error('worker failed'), { finalMessage: diagnosis }));
    const comments = [];
    const run = (cmd, args, opts) => {
      if (args.includes('comment')) { comments.push(readFileSync(args.at(-1), 'utf8')); return ''; }
      return m.run(cmd, args, opts);
    };
    const recordRouted = vi.fn(entry => ({ 'we#7': [entry, entry] }));
    const out = await runFixCli(argv.map(a => a === '--provider=codex' ? `--provider=${provider}` : a), { ...m.io, run, recordRouted });
    expect(out.code).toBe(1);
    expect(recordRouted).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', note: diagnosis, reason: expect.stringContaining(diagnosis) }));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(diagnosis);
  });
  // card 5947 (live #5045, 2026-10-13): CI context and durable outcomes precede lane acquisition.
  it('launches a ci-heal without a finding and records no-change as real repair evidence', async () => {
    const m = mk(['aaa', 'aaa']);
    const readComments = vi.fn(async () => []), appendLoopRow = vi.fn();
    const readCiHeal = vi.fn(() => ({ title: 'CI red', body: 'B', checks: [{ name: 'unit', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/42' }],
      jobs: [{ name: 'unit', log: '2026-10-13T13:19:27.2719622Z FAIL  scripts/conveyor/soak/__tests__/shard-files.test.mjs > coverage\nAssertionError: expected 0.796875 to be greater than 0.8' }] }));
    expect((await runFixCli([...argv, '--repair-kind=ci-heal'], { ...m.io, readComments, readCiHeal, appendLoopRow })).code).toBe(0);
    expect(readComments).not.toHaveBeenCalled();
    const prompt = m.spawn.mock.calls[0][0].prompt;
    for (const text of ['## CI FAILURE CONTEXT (fetched by the launcher)', 'scripts/conveyor/soak/__tests__/shard-files.test.mjs', 'AssertionError: expected 0.796875 to be greater than 0.8']) expect(prompt).toContain(text);
    expect(appendLoopRow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'outcome', head: 'aaa', outcome: 'no-change', infra: false }));
  });
  it.each(['ci-heal', 'fix'])('records a pre-lane %s refusal against the PR head', async repairKind => {
    const m = mk([]), recordRouted = vi.fn(() => ({})), appendLoopRow = vi.fn(), writeErr = vi.fn();
    const head = 'a'.repeat(40);
    const run = (cmd, args, opts) => cmd === 'gh' ? JSON.stringify({ title: 'T', headRefOid: head }) : m.run(cmd, args, opts);
    expect((await runFixCli([...argv, `--repair-kind=${repairKind}`], { ...m.io, run, readComments: async () => [],
      readCiHeal: () => ({ checks: [], jobs: [] }), recordRouted, appendLoopRow, writeErr })).code).toBe(1);
    const reason = repairKind === 'ci-heal' ? 'no-ci-failure:' : 'no-finding:';
    expect(recordRouted).toHaveBeenCalledWith(expect.objectContaining({ head, outcome: 'failed', reason: expect.stringContaining(reason) }));
    expect(appendLoopRow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'outcome', session: 'fix-7', head, infra: true }));
    expect(m.calls.some(c => c.includes('acquire'))).toBe(false);
    expect(writeErr.mock.calls.flat().join('')).toContain(reason);
  });
  it('two pre-lane CI refusals make the next routed repair choose Claude', async () => {
    const m = mk([]), head = 'a'.repeat(40), store = ledger(), rows = [];
    const run = (cmd, args, opts) => cmd === 'gh' ? JSON.stringify({ headRefOid: head }) : m.run(cmd, args, opts);
    const io = { recordPush: () => {}, ...m.io, run, readCiHeal: () => ({ checks: [] }), appendLoopRow: row => rows.push(row),
      recordRouted: entry => recordRoutedOutcome({ ...entry, store, readClaim: () => null }) };
    const routed = () => chooseFixExecutor({ launcherAvailable: true,
      codexUnproductive: consecutiveUnproductiveOnHead(store.read(), { repo: 'we', pr: 7, head }) });
    expect(routed().executor).toBe('codex');
    await runFixCli([...argv, '--repair-kind=ci-heal'], io);
    expect(routed().executor).toBe('codex');
    await runFixCli([...argv, '--repair-kind=ci-heal'], io);
    expect(routed().executor).toBe('claude');
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.infra && row.head === head)).toBe(true);
    expect(m.spawn).not.toHaveBeenCalled();
  });
  it('launches with empty job logs and treats ledger write errors as best effort', async () => {
    const m = mk(['aaa', 'aaa']), writeErr = vi.fn(), releaseClaim = vi.fn(async () => ({ released: [] }));
    const run = (cmd, args, opts) => {
      if (cmd === 'gh' && args.includes('title,body,statusCheckRollup')) return JSON.stringify({ title: 'T', statusCheckRollup: [
        { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/42' },
      ] });
      if (cmd === 'gh' && args[0] === 'api') throw new Error('404');
      return m.run(cmd, args, opts);
    };
    expect((await runFixCli([...argv, '--repair-kind=ci-heal'], { ...m.io, run, releaseClaim, writeErr,
      readComments: async () => [], appendLoopRow: () => { throw new Error('disk full'); } })).code).toBe(0);
    expect(m.spawn.mock.calls[0][0].prompt).toContain('https://github.com/o/r/actions/runs/1/job/42');
    expect(releaseClaim).toHaveBeenCalled();
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
  it('refuses an invalid repair-kind', async () => {
    const m = mk([]), writeErr = vi.fn();
    expect(() => parseFixRunArgv([...argv, '--repair-kind=x'])).toThrow(/--repair-kind/);
    expect((await runFixCli([...argv, '--repair-kind=x'], { ...m.io, writeErr })).code).toBe(1);
    expect(m.spawn).not.toHaveBeenCalled();
    expect(writeErr.mock.calls.flat().join('')).toContain('--repair-kind');
  });
  it.each([[[]], [['--task-kind=takeover', '--model=x', '--effort=high']]])('forwards fix task routing and explicit pins %j', async flags => {
    const m = mk(['aaa', 'bbb']);
    await runFixCli([...argv, ...flags], m.io);
    expect(m.spawn.mock.calls[0][0]).toMatchObject(flags.length
      ? { taskKind: 'takeover', model: 'x', effort: 'high' } : { taskKind: 'fix' });
  });
  it.each([[[]], [['--task-kind=takeover', '--model=x', '--effort=high']]])('keeps ci-heal accounting separate from task routing %j', async flags => {
    const m = mk(['aaa', 'aaa']);
    await runFixCli([...argv, '--repair-kind=ci-heal', ...flags], {
      ...m.io, readCiHeal: () => ({ checks: [{ name: 'unit' }], jobs: [] }),
    });
    expect(m.spawn.mock.calls[0][0]).toMatchObject({
      taskKind: flags.length ? 'takeover' : 'fix', usageTaskKind: 'ci-heal',
      ...(flags.length ? { model: 'x', effort: 'high' } : {}),
    });
  });
  it('routes ci-heal through the real Codex provider using fix overrides while recording ci-heal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fix-accounting-'));
    try {
      vi.stubEnv('WE_CODEX_USAGE_LEDGER', join(root, 'ledger'));
      vi.stubEnv('CODEX_HOME', join(root, 'missing'));
      vi.stubEnv('WE_CODEX_MODEL_BY_TASK', JSON.stringify({
        fix: { model: 'gpt-6-astra', effort: 'high' },
        'ci-heal': { model: 'gpt-6.1-sol', effort: 'medium' },
      }));
      const m = mk(['aaa', 'aaa']);
      const spawnCodex = vi.fn(async () => ({ stdout: '', code: 0 }));
      const provider = resolveDeliveryAgentProvider('codex');
      const result = await runFixCli([...argv, '--repair-kind=ci-heal'], {
        ...m.io, spawnCodex, readCiHeal: () => ({ checks: [{ name: 'unit' }], jobs: [] }),
        resolveProvider: () => ({ spawn: (request, io) => provider.spawn(request, {
          ...io, resolveReportsDir: () => join(root, 'reports'), denyPaths: [join(root, 'primary', '**')],
          recordCpu: () => {}, recordScorecard: () => {}, writeThreadId: () => {},
        }) }),
      });
      expect(result.code).toBe(0);
      const [args] = spawnCodex.mock.calls[0];
      expect(args[args.indexOf('-m') + 1]).toBe('gpt-6-astra');
      expect(args).toContain('model_reasoning_effort=high');
      expect(JSON.parse(readFileSync(join(root, 'ledger'), 'utf8'))).toMatchObject({
        taskKind: 'ci-heal', model: 'gpt-6-astra', effort: 'high', caller: 'fix-run.mjs',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('captures JSONL through the real provider spawn seam even when the provider returns nothing', async () => {
    const m = mk(['aaa', 'aaa']);
    m.spawn.mockImplementation(async (_request, io) => { await io.spawnAgent([], {}); });
    const recordOutcome = vi.fn();
    await runFixCli(argv, { ...m.io, recordOutcome, spawnCodex: async () => ({ stdout: [
      'diagnostic line', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First note' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Final diagnosis\n' + 'x'.repeat(400) } }),
    ].join('\n') }) });
    const reason = recordOutcome.mock.calls[0][0].reason;
    expect(reason).toMatch(/^Final diagnosis x/);
    expect(reason).not.toContain('\n');
    expect(reason).toHaveLength(300);
  });
  it('records numeric PRs and the final agent message', async () => {
    const m = mk(['aaa', 'aaa']);
    m.spawn.mockResolvedValue({ stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Unable to repair this finding' } }) });
    const recordOutcome = vi.fn();
    const recordRouted = vi.fn(() => ({}));
    await runFixCli(argv, { ...m.io, recordOutcome, recordRouted });
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ pr: 7, reason: 'Unable to repair this finding' }));
    expect(recordRouted).toHaveBeenCalledWith(expect.objectContaining({ pr: 7, head: 'aaa' }));
  });
  it('commits uncommitted edits using explicit paths and excludes scratch, staging bytes the launcher read', async () => {
    const lane = mkdtempSync(join(tmpdir(), 'fix-run-plain-'));
    try {
      writeFileSync(join(lane, 'file.txt'), 'edited\n');
      const m = mk(['aaa', 'bbb']);
      m.spawn.mockResolvedValue({ finalMessage: 'Repair finding' });
      const inputs = [];
      let copied = null;
      const run = (cmd, args, opts) => {
        if (args.includes('status')) return ' M file.txt\0?? .fix-commit-msg.txt\0 D gone.txt\0';
        if (args.includes('acquire')) return lane;
        if (opts?.input !== undefined) inputs.push(String(opts.input));
        if (args.includes('add')) copied = { cwd: opts.cwd, text: readFileSync(join(opts.cwd, 'file.txt'), 'utf8') };
        return m.run(cmd, args, opts);
      };
      expect((await runFixCli(argv, { ...m.io, run })).code).toBe(0);
      // `git add` runs only against the launcher's private copy (under the git dir), never the lane, and the copy is removed.
      const add = m.calls.find(c => c.includes('add'));
      expect(add.slice(-4)).toEqual(['add', '-f', '--', 'file.txt']);
      expect(add).toContain(`--work-tree=${copied.cwd}`);
      expect(copied.cwd.startsWith(join(realFs.realpathSync(tmpdir()), 'fix-run-stage-'))).toBe(true);
      expect(copied.text).toBe('edited\n');
      expect(existsSync(copied.cwd)).toBe(false);
      expect(inputs).toContain(`0 ${'0'.repeat(3)}\tgone.txt\x00`); // a deletion is a direct index write: nothing to read
      expect(m.calls.find(c => c.includes('commit'))).not.toContain('--'); // `commit -- paths` re-reads the worktree
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
    } finally { rmSync(lane, { recursive: true, force: true }); }
  });
  it('commits a clean merge before the agent and accepts a merge-only brief', async () => {
    const m = mk(['aaa', 'bbb']);
    let merging = false;
    const run = (cmd, args, opts) => {
      if (args.includes('--git-path')) return merging ? 'MERGE_HEAD' : '';
      if (args.includes('merge')) merging = true;
      if (args.includes('commit')) merging = false;
      return m.run(cmd, args, opts);
    };
    m.spawn.mockImplementation(async () => {
      expect(m.calls.some(c => c.includes('commit') && c.includes('--no-edit'))).toBe(true);
    });
    expect((await runFixCli([...argv, '--merge-onto=lane/base'], { ...m.io, run, fileExists: () => true, readComments: async () => [] })).code).toBe(0);
    expect(m.calls.some(c => c.includes('push'))).toBe(true);
  });
  it.each([
    ['CONFLICTING', true], ['CONFLICTING', false], ['MERGEABLE', true], ['UNKNOWN', true],
  ])('uses live mergeability as a merge backstop (%s, finding=%s)', async (mergeable, hasFinding) => {
    const m = mk(['aaa', 'bbb']);
    const write = vi.fn();
    const run = (cmd, args, opts) => {
      if (cmd === 'gh' && args.includes('view')) {
        m.calls.push([cmd, ...args]);
        return JSON.stringify({ title: 'T', body: 'B', baseRefName: 'develop', mergeable });
      }
      return m.run(cmd, args, opts);
    };
    let callsBeforeSpawn;
    m.spawn.mockImplementation(async () => { callsBeforeSpawn = [...m.calls]; });
    const out = await runFixCli(argv, {
      ...m.io, run, write, fileExists: () => false,
      ...(!hasFinding ? { readComments: async () => [] } : {}),
    });
    expect(out.code).toBe(0);
    expect(m.spawn).toHaveBeenCalledTimes(1);
    if (mergeable === 'CONFLICTING') {
      const fetch = callsBeforeSpawn.findIndex(c => c.includes('fetch'));
      const merge = callsBeforeSpawn.findIndex(c => c.includes('merge'));
      expect(fetch).toBeGreaterThanOrEqual(0);
      expect(merge).toBeGreaterThan(fetch);
      expect(callsBeforeSpawn[fetch]).toEqual(['git', ...HARDENED_GIT_ARGS, 'fetch', 'origin', 'develop']);
      expect(callsBeforeSpawn[merge]).toEqual(['git', ...HARDENED_GIT_ARGS, 'merge', '--no-commit', '--no-ff', 'origin/develop']);
      expect(write).toHaveBeenCalledWith('fix-run: PR #7 conflicts with develop; launcher merges origin/develop first\n');
    } else {
      expect(m.calls.some(c => c.includes('fetch') || c.includes('merge'))).toBe(false);
    }
    expect(m.calls).toContainEqual(['gh', 'pr', 'view', '7', '--json', 'title,body,baseRefName,mergeable,headRefOid', '--repo=o/r']);
  });
  it('uses the supplied commit message with the shared provider trailer outside the lane', async () => {
    const m = mk(['aaa', 'bbb']);
    const run = (cmd, args, opts) => {
      if (args.includes('status')) return ' M file.txt\0?? .fix-commit-msg.txt\0';
      if (args.includes('commit')) {
        const file = args[args.indexOf('-F') + 1];
        expect(file).not.toContain('/lanes/');
        expect(readFileSync(file, 'utf8')).toBe('Chosen subject\n\nCo-Authored-By: Codex <noreply@openai.com>\n');
      }
      return m.run(cmd, args, opts);
    };
    expect((await runFixCli(argv, { ...m.io, run, fileExists: p => p.endsWith('.fix-commit-msg.txt'), readFile: () => 'Chosen subject' })).code).toBe(0);
  });
  it('keeps rename endpoints and unusual filenames but excludes launcher scratch', () => {
    expect(changedPaths('R  new name\0old name\0 D deleted\0?? line\nbreak\0?? .converge-1\0?? .delivery-commit-msg-7\0?? .fix-x-commit-message.txt\0')).toEqual(['new name', 'old name', 'deleted', 'line\nbreak']);
  });
  it.each([false, true, 1, 32, 'symlink', 'deleted'])('launcher merges conflicts (unresolved=%s)', async (unresolved) => {
    const m = mk(['aaa', 'bbb']);
    let merging = false;
    let added = false;
    m.spawn.mockResolvedValue({ finalMessage: 'Agent final diagnosis' });
    const run = (cmd, args, opts) => {
      m.calls.push([cmd, ...args]);
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging = true; throw new Error('conflicts'); }
      if (args.includes('status')) return 'UU file.txt\0';
      if (args.includes('--numstat')) return '1\t1\tfile.txt\0';
      if (args.includes('add')) added = true;
      if (args.includes('ls-files') && added) return `100644 ${'c'.repeat(40)} 0\tfile.txt\0`;
      if (args.includes('cat-file')) return '> resolved blockquote\n< comparison\n';
      if (args.includes('commit') || args.includes('--abort')) merging = false;
      return m.run(cmd, args, opts);
    };
    const recordOutcome = vi.fn();
    const out = await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run, recordOutcome, stageEntry: () => ({ mode: '100644', data: Buffer.from('resolved\n') }),
      fileExists: p => p.endsWith('MERGE_HEAD') ? merging : unresolved !== 'deleted',
      readFile: () => unresolved === 'symlink' && m.spawn.mock.calls.length ? null : unresolved && unresolved !== 'symlink' ? `${'<'.repeat(typeof unresolved === 'number' ? unresolved : 7)} HEAD\nleft\n=======\nright\n${'>'.repeat(typeof unresolved === 'number' ? unresolved : 7)} origin/main\n` : '> resolved blockquote\n< comparison\n',
    });
    expect(m.spawn.mock.calls[0][0].prompt).toContain('ALREADY started git merge origin/main');
    expect(out.code).toBe(unresolved ? 1 : 0);
    if (unresolved) {
      expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
      expect(m.calls.some(c => c.includes('commit') || staged(c))).toBe(false);
      expect(m.calls.some(c => c.includes('push'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'conflict unresolved in file.txt: Agent final diagnosis' }));
    } else {
      expect(m.calls.some(c => c.includes('commit') && c.includes('--no-edit') && c.includes('--trailer'))).toBe(true);
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
    }
  });
  // A mocked conflicted merge for the resource bounds: `paths` UU files, each with three index stages whose blobs claim
  // `blobSize` bytes; `cat-file` enforces the caller's maxBuffer the way execFileSync does (ENOBUFS, 1 MiB default).
  const boundedConflict = async ({ paths = ['file.txt'], blobSize = 5, readFile = () => 'resolved\n' } = {}) => {
    const m = mk(['aaa', 'bbb']);
    let merging = false;
    let added = false;
    const blobBuffers = [];
    m.spawn.mockResolvedValue({ finalMessage: 'resolved' });
    const run = (cmd, args, opts) => {
      m.calls.push([cmd, ...args]);
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging = true; throw new Error('conflicts'); }
      if (args.includes('status')) return paths.map(p => `UU ${p}\0`).join('');
      if (args.includes('--numstat')) return '1\t1\tx\0';
      if (args.includes('add')) added = true;
      if (args.includes('ls-files')) {
        const path = args[args.length - 1];
        return added ? `100644 ${'c'.repeat(40)} 0\t${path}\0` : ['a', 'b', 'd'].map((x, i) => `100644 ${x.repeat(40)} ${i + 1}\t${path}\0`).join('');
      }
      if (args.includes('cat-file')) {
        blobBuffers.push(opts?.maxBuffer);
        if (blobSize > (opts?.maxBuffer ?? 1024 * 1024)) throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
        return 'ours\n';
      }
      if (args.includes('commit') || args.includes('--abort')) merging = false;
      return m.run(cmd, args, opts);
    };
    const recordOutcome = vi.fn();
    const out = await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run, recordOutcome, stageEntry: () => ({ mode: '100644', data: Buffer.from('resolved\n') }),
      fileExists: p => (p.endsWith('MERGE_HEAD') ? merging : true), readFile });
    return { out, m, recordOutcome, blobBuffers };
  };
  it('refuses before the agent runs when a conflicted file cannot be read (over 64 MiB, not regular), instead of scanning nothing', async () => {
    const { out, m, recordOutcome } = await boundedConflict({ readFile: () => null });
    expect(out.code).toBe(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining('cannot read conflicted file file.txt') }));
    expect(m.spawn).not.toHaveBeenCalled();
    expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
    expect(m.calls.some(c => staged(c) || c.includes('commit') || c.includes('push'))).toBe(false);
  });
  it.each([[MAX_CONFLICTED_PATHS + 1, true], [MAX_CONFLICTED_PATHS, false]])('rejects more than 100 conflicted paths before reading blobs (paths=%i, refused=%s)', async (n, refused) => {
    expect(MAX_CONFLICTED_PATHS).toBe(100);
    const { out, m, recordOutcome } = await boundedConflict({ paths: Array.from({ length: n }, (_, i) => `f${i}.txt`) });
    const reason = recordOutcome.mock.calls[0]?.[0]?.reason ?? '';
    if (refused) {
      expect(out.code).toBe(1);
      expect(reason).toContain(`too many conflicted files to classify (${n} > 100)`);
      expect(m.spawn).not.toHaveBeenCalled();
      expect(m.calls.some(c => c.includes('cat-file') || c.includes('check-attr') || c.includes('ls-files'))).toBe(false);
      expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
      expect(m.calls.some(c => staged(c) || c.includes('commit') || c.includes('push'))).toBe(false);
    } else {
      expect(m.spawn).toHaveBeenCalled();
      expect(reason).not.toContain('too many conflicted files');
    }
  });
  it.each([[BLOB_MAX_BYTES + 1, true], [BLOB_MAX_BYTES, false]])('rejects conflict blobs exceeding 64 MiB (size=%i, refused=%s)', async (size, refused) => {
    expect(BLOB_MAX_BYTES).toBe(64 * 1024 * 1024);
    const { out, m, recordOutcome, blobBuffers } = await boundedConflict({ blobSize: size });
    expect(blobBuffers.length).toBeGreaterThan(0);
    expect(blobBuffers.every(b => b === BLOB_MAX_BYTES)).toBe(true);
    if (refused) {
      expect(out.code).toBe(1);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining('ENOBUFS') }));
      expect(m.spawn).not.toHaveBeenCalled();
      expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
      expect(m.calls.some(c => staged(c) || c.includes('commit') || c.includes('push'))).toBe(false);
    } else {
      expect(out.code).toBe(0);
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
    }
  });
  it('aborts a real conflict with conflict-marker-size=32 without committing or pushing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-marker-size-'));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const git = (...args) => execFileSync('git', [...HARDENED_GIT_ARGS, ...args], { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
    try {
      git('init', '--initial-branch=main');
      writeFileSync(join(dir, '.gitattributes'), 'file.txt conflict-marker-size=32\n');
      writeFileSync(join(dir, 'file.txt'), 'base\n');
      git('add', '.gitattributes', 'file.txt');
      git('commit', '-m', 'base');
      git('checkout', '-b', 'target');
      writeFileSync(join(dir, 'file.txt'), 'theirs\n');
      git('commit', '-am', 'theirs');
      git('update-ref', 'refs/remotes/origin/target', git('rev-parse', 'HEAD').trim());
      git('checkout', 'main');
      writeFileSync(join(dir, 'file.txt'), 'ours\n');
      git('commit', '-am', 'ours');
      const head = git('rev-parse', 'HEAD');
      const m = mk([]);
      m.spawn.mockImplementation(async () => {
        expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toContain(`${'<'.repeat(32)} HEAD`);
        return { finalMessage: 'Left conflict untouched' };
      });
      const run = (cmd, args, opts) => {
        if (cmd === 'git') {
          m.calls.push([cmd, ...args]);
          // The remote-tracking ref above stands in for the network fetch; all merge/abort IO is real.
          if (args.includes('fetch') || args.includes('push')) return '';
          return execFileSync(cmd, args, { cwd: dir, env: { ...env, ...opts?.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: 'pipe', input: opts?.input });
        }
        if (args.includes('acquire')) return dir;
        return m.run(cmd, args, opts);
      };
      const out = await runFixCli([...argv, '--merge-onto=target'], { ...m.io, run });
      expect(m.spawn).toHaveBeenCalledOnce();
      expect(out.code).toBe(1);
      expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
      expect(m.calls.some(c => c.includes('commit') || staged(c) || c.includes('push'))).toBe(false);
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('ours\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([['lane/x', 0], ['', 1]])('@pr-base resolves to the live gh baseRefName (%j) before validation', async (base, code) => {
    const m = mk(['aaa', 'bbb']);
    const run = (cmd, args, opts) => {
      if (cmd === 'gh' && args.includes('view')) {
        expect(['title,body,baseRefName,mergeable,headRefOid', 'headRefOid,labels,statusCheckRollup']).toContain(args[args.indexOf('--json') + 1]);
        m.calls.push([cmd, ...args]);
        return JSON.stringify({ title: 'T', body: 'B', baseRefName: base });
      }
      return m.run(cmd, args, opts);
    };
    const recordOutcome = vi.fn();
    const out = await runFixCli([...argv, '--merge-onto=@pr-base'], { ...m.io, run, recordOutcome, fileExists: () => false, readComments: async () => [] });
    expect(out.code).toBe(code);
    if (code === 0) {
      expect(m.calls).toContainEqual(['git', ...HARDENED_GIT_ARGS, 'fetch', 'origin', 'lane/x']);
      expect(m.calls).toContainEqual(['git', ...HARDENED_GIT_ARGS, 'merge', '--no-commit', '--no-ff', 'origin/lane/x']);
    } else {
      expect(m.spawn).not.toHaveBeenCalled();
      expect(m.calls.some(c => c.includes('fetch'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'cannot resolve PR base for conflict merge' }));
    }
  });
  it('aborts binary and modify/delete conflicts before the agent runs', async () => {
    const m = mk(['aaa', 'aaa']);
    let merging = false;
    const run = (cmd, args, opts) => {
      m.calls.push([cmd, ...args]);
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging = true; throw new Error('conflicts'); }
      if (args.includes('status')) return 'UD gone.txt\0UU img.png\0UU ok.txt\0';
      if (args.includes('check-attr')) return '';
      if (args.includes('ls-files')) return [['a', 2, 'img.png'], ['b', 3, 'img.png'], ['c', 2, 'ok.txt'], ['d', 3, 'ok.txt']].map(([o, s, p]) => `100644 ${o.repeat(40)} ${s}\t${p}\0`).join('');
      if (args.includes('--numstat')) return args.includes('a'.repeat(40)) ? '-\t-\timg.png\0' : '2\t1\tok.txt\0';
      if (args.includes('--abort')) merging = false;
      return m.run(cmd, args, opts);
    };
    const recordOutcome = vi.fn();
    const out = await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run, recordOutcome, fileExists: p => (p.endsWith('MERGE_HEAD') ? merging : true) });
    expect(out.code).toBe(1);
    expect(m.spawn).not.toHaveBeenCalled();
    expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed',
      reason: 'conflict not resolvable by editing files: gone.txt(UD), img.png(UU binary)' }));
  });
  // Real-git harness: `main` = the PR head, `target` = the base it conflicts with. Fetch/push are stubbed; all merge IO is real.
  // `onGit(args, dir)` runs before each launcher git call: a process the agent left running, acting mid-staging.
  const withRealMerge = async (setup, { agent, extra = [], onGit, io = {} }, check) => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-real-merge-'));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
    const git = (...args) => execFileSync('git', [...HARDENED_GIT_ARGS, ...args], { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
    try {
      git('init', '--initial-branch=main');
      setup.base({ dir, git });
      git('add', '-A'); setup.baseIndex?.({ dir, git }); git('commit', '-m', 'base');
      git('checkout', '-b', 'target');
      setup.theirs({ dir, git });
      git('add', '-A'); setup.theirsIndex?.({ dir, git }); git('commit', '-m', 'theirs');
      git('update-ref', 'refs/remotes/origin/target', git('rev-parse', 'HEAD').trim());
      git('checkout', 'main');
      setup.ours({ dir, git });
      git('add', '-A'); setup.oursIndex?.({ dir, git }); git('commit', '-m', 'ours');
      const m = mk([]);
      m.spawn.mockImplementation(async () => { agent({ dir }); return { finalMessage: 'resolved' }; });
      const run = (cmd, args, opts) => {
        if (cmd === 'git') {
          m.calls.push([cmd, ...args]);
          onGit?.(args, dir);
          if (args.includes('fetch') || args.includes('push')) return '';
          return execFileSync(cmd, args, { cwd: dir, env: { ...env, ...opts?.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: 'pipe', input: opts?.input });
        }
        if (args.includes('acquire')) return dir;
        return m.run(cmd, args, opts);
      };
      const recordOutcome = vi.fn();
      const out = await runFixCli([...argv, '--merge-onto=target', ...extra], { ...m.io, run, recordOutcome, ...io });
      await check({ out, m, git, dir, recordOutcome });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('aborts a real binary UU conflict before the agent runs (git prints 0/0 numstat for unmerged binaries)', async () => {
    const bin = (...bytes) => Buffer.from(bytes);
    await withRealMerge({
      base: ({ dir }) => writeFileSync(join(dir, 'img.bin'), bin(0, 1, 2)),
      theirs: ({ dir }) => writeFileSync(join(dir, 'img.bin'), bin(0, 3, 4)),
      ours: ({ dir }) => writeFileSync(join(dir, 'img.bin'), bin(0, 5, 6)),
    }, { agent: () => {} }, async ({ out, m, git, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.spawn).not.toHaveBeenCalled();
      expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
      expect(m.calls.some(c => c.includes('commit') || c.includes('push'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed',
        reason: 'conflict not resolvable by editing files: img.bin(UU binary)' }));
      expect(git('status', '--porcelain')).toBe('');
    });
  });
  it('aborts a real conflict whose binary side is only the other stage, and one marked -merge', async () => {
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'a.dat'), 'one\n'); writeFileSync(join(dir, 'b.txt'), 'one\n'); writeFileSync(join(dir, '.gitattributes'), 'b.txt -merge\n'); },
      theirs: ({ dir }) => { writeFileSync(join(dir, 'a.dat'), Buffer.from([0, 9, 9])); writeFileSync(join(dir, 'b.txt'), 'theirs\n'); },
      ours: ({ dir }) => { writeFileSync(join(dir, 'a.dat'), 'text ours\n'); writeFileSync(join(dir, 'b.txt'), 'ours\n'); },
    }, { agent: () => {} }, async ({ out, m, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.spawn).not.toHaveBeenCalled();
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('a.dat(UU binary)') }));
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('b.txt(UU binary)') }));
    });
  });
  it('judges the merge driver by the attributes HEAD had, not the ones the merge itself rewrote', async () => {
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'x.txt'), 'a\nb\nc\n'); writeFileSync(join(dir, '.gitattributes'), 'x.txt -merge\n'); },
      theirs: ({ dir }) => { writeFileSync(join(dir, 'x.txt'), 'a\nb-theirs\nc\n'); writeFileSync(join(dir, '.gitattributes'), ''); },
      ours: ({ dir }) => writeFileSync(join(dir, 'x.txt'), 'a\nb-ours\nc\n'),
    }, { agent: () => {} }, async ({ out, m, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.spawn).not.toHaveBeenCalled();
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: 'conflict not resolvable by editing files: x.txt(UU binary)' }));
    });
  });
  it('refuses symlink and gitlink (submodule) conflicts up front without throwing on the other paths', async () => {
    const sha = (n) => String(n).repeat(40);
    await withRealMerge({
      base: ({ dir, git }) => { symlinkSync('one', join(dir, 'link')); writeFileSync(join(dir, 'file.txt'), 'base\n'); },
      baseIndex: ({ git }) => git('update-index', '--add', '--cacheinfo', `160000,${sha(1)},sub`),
      theirs: ({ dir, git }) => { rmSync(join(dir, 'link')); symlinkSync('theirs', join(dir, 'link')); writeFileSync(join(dir, 'file.txt'), 'theirs\n'); },
      theirsIndex: ({ git }) => git('update-index', '--add', '--cacheinfo', `160000,${sha(2)},sub`),
      ours: ({ dir, git }) => { rmSync(join(dir, 'link')); symlinkSync('ours', join(dir, 'link')); writeFileSync(join(dir, 'file.txt'), 'ours\n'); },
      oursIndex: ({ git }) => git('update-index', '--add', '--cacheinfo', `160000,${sha(3)},sub`),
    }, { agent: () => {} }, async ({ out, m, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.spawn).not.toHaveBeenCalled();
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(/link\(UU non-regular\).*sub\(UU non-regular\)|sub\(UU non-regular\).*link\(UU non-regular\)/) }));
    });
  });
  it('commits a resolved text conflict alongside a clean base deletion and rename', async () => {
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'base\n'); writeFileSync(join(dir, 'gone.txt'), 'gone\n'); writeFileSync(join(dir, 'old.txt'), 'rename me please, enough content to detect\n'.repeat(5)); },
      theirs: ({ dir, git }) => { writeFileSync(join(dir, 'file.txt'), 'theirs\n'); git('rm', 'gone.txt'); git('mv', 'old.txt', 'new.txt'); },
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n'),
    }, { agent: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'resolved\n') }, async ({ out, m, git, dir }) => {
      expect(out.code).toBe(0);
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
      expect(git('status', '--porcelain')).toBe('');
      expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
      expect(existsSync(join(dir, 'new.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('resolved\n');
      expect(git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    });
  });
  it('still stages files the agent changed or created beyond the conflicted ones when merging', async () => {
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'base\n'); writeFileSync(join(dir, 'other.txt'), 'x\n'); },
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'theirs\n'),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n'),
    }, { agent: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'resolved\n'); writeFileSync(join(dir, 'other.txt'), 'y\n'); writeFileSync(join(dir, 'added.txt'), 'z\n'); } },
    async ({ out, git }) => {
      expect(out.code).toBe(0);
      expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(['added.txt', 'file.txt', 'other.txt']);
    });
  });
  // A file the sandbox may hardlink but not read (a credential under ~/.config): staging runs OUTSIDE the sandbox with
  // full read access, so the launcher must never stage one. Both commit paths: the plain commit after a clean merge, and
  // the conflict-resolution merge commit.
  const withSecret = async (fn) => {
    const d = mkdtempSync(join(tmpdir(), 'fix-run-secret-'));
    try { const f = join(d, 'hosts.yml'); writeFileSync(f, 'oauth_token: SECRET\n'); await fn(f); } finally { rmSync(d, { recursive: true, force: true }); }
  };
  const stagingCases = {
    'clean merge': { base: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'base\n'); writeFileSync(join(dir, 'other.txt'), 'x\n'); },
      theirs: ({ dir }) => writeFileSync(join(dir, 'other.txt'), 'theirs\n'), ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n') },
    conflict: { base: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'base\n'),
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'theirs\n'), ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n') },
  };
  it.each(Object.keys(stagingCases))('refuses to stage a lane file hardlinked to a file outside the lane (%s): nothing added, nothing pushed', async (kind) => {
    await withSecret(async (secret) => {
      await withRealMerge(stagingCases[kind], { agent: ({ dir }) => {
        writeFileSync(join(dir, 'file.txt'), 'resolved\n');
        linkSync(secret, join(dir, 'leak.txt'));
      } }, async ({ out, m, git, recordOutcome }) => {
        expect(out.code).toBe(1);
        expect(m.calls.some(c => staged(c) || c.includes('push'))).toBe(false);
        expect(() => git('cat-file', '-e', git('hash-object', secret).trim())).toThrow(); // the secret never entered the object store
        expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringMatching(/^refusing to stage .*leak\.txt/) }));
      });
    });
  });
  // A process the agent left running swaps a hardlink in while the launcher stages, then puts the original back when the
  // launcher commits, so nothing looks changed afterwards:
  //   file        — `a.txt` itself, at `git add` (after every path was read): the commit holds the bytes read, not the link;
  //   parent      — `sub/` renamed away and recreated holding a hardlink at `sub/f.txt`, just before that path is read;
  //   parent-read — the same swap AFTER `sub/f.txt` was opened and its link count checked (the descriptor still holds the
  //                 original, single-link file, but the path no longer names it): refused, never "read the old one".
  // Either way the secret never enters the object store (a later reader of the lane's .git cannot recover it).
  it.each(Object.keys(stagingCases).flatMap(kind => ['file', 'parent', 'parent-read'].map(swap => [kind, swap])))('never stages a hardlink swapped in during staging (%s, %s swap)', async (kind, swap) => {
    await withSecret(async (secret) => {
      let state = 'armed';
      let lane;
      const moved = () => (swap === 'file' ? join(lane, 'a.txt') : join(lane, 'sub'));
      const doSwap = () => {
        realFs.renameSync(moved(), `${moved()}.orig`);
        if (swap !== 'file') mkdirSync(moved());
        linkSync(secret, swap === 'file' ? moved() : join(moved(), 'f.txt'));
        state = 'swapped';
      };
      const racingFs = new Proxy(realFs, { get: (fs, key) => typeof fs[key] !== 'function' ? fs[key] : (...args) => {
        if (state === 'armed' && swap === 'parent-read' && key === 'realpathSync' && String(args[0]).endsWith('f.txt')) doSwap();
        return fs[key](...args);
      } });
      await withRealMerge({ ...stagingCases[kind], base: (o) => { stagingCases[kind].base(o); mkdirSync(join(o.dir, 'sub')); writeFileSync(join(o.dir, 'sub', 'f.txt'), 'f\n'); } }, {
        agent: ({ dir }) => { lane = dir; writeFileSync(join(dir, 'file.txt'), 'resolved\n'); writeFileSync(join(dir, 'a.txt'), 'a\n'); writeFileSync(join(dir, 'sub', 'f.txt'), 'g\n'); },
        onGit: (args) => {
          if (state === 'armed' && swap === 'file' && args.includes('add')) doSwap();
          else if (state === 'swapped' && args.includes('commit')) { rmSync(moved(), { recursive: true }); realFs.renameSync(`${moved()}.orig`, moved()); state = 'restored'; }
        },
        io: { stageEntry: (l, path) => {
          if (state === 'armed' && swap === 'parent' && path === 'sub/f.txt') doSwap();
          return laneStageEntry(l, path, racingFs);
        } },
      }, async ({ out, m, git, recordOutcome }) => {
        expect(state).not.toBe('armed');
        expect(() => git('cat-file', '-e', git('hash-object', secret).trim())).toThrow();
        if (swap === 'file') {
          expect(out.code).toBe(0);
          expect(git('show', 'HEAD:a.txt')).toBe('a\n');
          expect(m.calls.some(c => c.includes('push'))).toBe(true);
        } else {
          expect(out.code).toBe(1);
          expect(m.calls.some(c => staged(c) || c.includes('push'))).toBe(false);
          expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringMatching(/^refusing to stage sub\/f\.txt/) }));
        }
      });
    });
  });
  it('stages an executable bit, a symlink as its link text, a deletion and a rename like git add would', async () => {
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'base\n'); writeFileSync(join(dir, 'old.txt'), 'move me\n'); writeFileSync(join(dir, 'gone.txt'), 'x\n'); writeFileSync(join(dir, 'run.sh'), 'echo\n'); },
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'theirs\n'),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n'),
    }, { agent: ({ dir }) => {
      writeFileSync(join(dir, 'file.txt'), 'resolved\n');
      realFs.renameSync(join(dir, 'old.txt'), join(dir, 'new name.txt'));
      rmSync(join(dir, 'gone.txt'));
      realFs.chmodSync(join(dir, 'run.sh'), 0o755);
      symlinkSync('/etc/hosts', join(dir, 'link'));
    } }, async ({ out, git }) => {
      expect(out.code).toBe(0);
      expect(git('status', '--porcelain')).toBe('');
      const tree = git('ls-tree', 'HEAD');
      expect(tree).toMatch(/^100755 blob \S+\trun\.sh$/m);
      expect(tree).toMatch(/^120000 blob \S+\tlink$/m);
      expect(git('cat-file', '-p', 'HEAD:link')).toBe('/etc/hosts');
      expect(tree).toMatch(/\tnew name\.txt$/m);
      expect(tree).not.toMatch(/\t(old|gone)\.txt$/m);
    });
  });
  // git's own normalization still applies to the launcher's copy: under `text=auto` a file whose index blob already has
  // CRLF keeps it (a bare `hash-object --path` would rewrite it to LF), and core.fileMode=false keeps the index mode.
  it('keeps CRLF a file already has in the index under text=auto, and the index mode under core.fileMode=false', async () => {
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'base\n'); writeFileSync(join(dir, 'crlf.txt'), 'a\r\nb\r\n'); writeFileSync(join(dir, 'run.sh'), 'echo\n'); },
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'theirs\n'),
      ours: ({ dir, git }) => { writeFileSync(join(dir, 'file.txt'), 'ours\n'); writeFileSync(join(dir, '.gitattributes'), '* text=auto\n'); git('config', 'core.fileMode', 'false'); },
    }, { agent: ({ dir }) => {
      writeFileSync(join(dir, 'file.txt'), 'resolved\n');
      writeFileSync(join(dir, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
      writeFileSync(join(dir, 'run.sh'), 'echo hi\n'); realFs.chmodSync(join(dir, 'run.sh'), 0o755);
    } }, async ({ out, git }) => {
      expect(out.code).toBe(0);
      expect(git('cat-file', '-p', 'HEAD:crlf.txt')).toBe('a\r\nb\r\nc\r\n');
      expect(git('ls-tree', 'HEAD', 'run.sh')).toMatch(/^100644 /);
    });
  });
  // The copy lacks the lane's unchanged .gitignore files, so without `-f` a negation there (`!keep.tmp` against an
  // `info/exclude` of `*.tmp`) would be lost and `git add` would refuse a path the lane's own status listed.
  it('stages a path the lane un-ignores in an unchanged .gitignore', async () => {
    await withRealMerge({ ...stagingCases.conflict, base: (o) => { stagingCases.conflict.base(o); writeFileSync(join(o.dir, '.gitignore'), '!keep.tmp\n'); writeFileSync(join(o.dir, '.git', 'info', 'exclude'), '*.tmp\n'); } }, {
      agent: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'resolved\n'); writeFileSync(join(dir, 'keep.tmp'), 'k\n'); },
    }, async ({ out, git }) => {
      expect(out.code).toBe(0);
      expect(git('show', 'HEAD:keep.tmp')).toBe('k\n');
    });
  });
  // `X -> <outside>` then `x/y`: one directory entry on a case-insensitive filesystem. Writing the copy through the link it
  // just made would put launcher-written bytes outside the copy; regular files go first and every parent is checked.
  it('never writes the staging copy through a symlink it created (X -> outside, then x/y)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fix-run-outside-'));
    const gitDir = mkdtempSync(join(tmpdir(), 'fix-run-gitdir-'));
    try {
      const m = mk(['aaa', 'bbb']);
      m.spawn.mockResolvedValue({ finalMessage: 'x' });
      const run = (cmd, args, opts) => {
        if (args.includes('status')) return '?? X\0?? x/y\0';
        if (args.includes('--absolute-git-dir')) return gitDir;
        return m.run(cmd, args, opts);
      };
      const stageEntry = (_lane, path) => (path === 'X' ? { mode: '120000', data: Buffer.from(outside) } : { mode: '100644', data: Buffer.from('y\n') });
      await runFixCli(argv, { ...m.io, run, stageEntry });
      expect(realFs.readdirSync(outside)).toEqual([]);
      expect(realFs.readdirSync(gitDir)).toEqual([]); // the copy is removed either way
    } finally { rmSync(outside, { recursive: true, force: true }); rmSync(gitDir, { recursive: true, force: true }); }
  });
  // Capped as each file is read, not after all are: sparse files cost the agent no disk but each read costs a buffer, so
  // reading stops at the file that crosses the cap and the files after it are never read.
  it(`refuses to stage more than STAGE_MAX_BYTES in total before git sees any of it, reading no file past the cap`, async () => {
    const m = mk(['aaa', 'bbb']);
    m.spawn.mockResolvedValue({ finalMessage: 'big' });
    const files = Array.from({ length: STAGE_MAX_BYTES / BLOB_MAX_BYTES + 3 }, (_, i) => `f${i}.bin`);
    const run = (cmd, args, opts) => (args.includes('status') ? files.map(f => `?? ${f}\0`).join('') : m.run(cmd, args, opts));
    const big = () => Object.defineProperty(Buffer.from('x'), 'length', { value: BLOB_MAX_BYTES }); // no 64 MiB allocations
    const recordOutcome = vi.fn();
    const stageEntry = vi.fn(() => ({ mode: '100644', data: big() }));
    expect((await runFixCli(argv, { ...m.io, run, recordOutcome, stageEntry })).code).toBe(1);
    expect(stageEntry).toHaveBeenCalledTimes(STAGE_MAX_BYTES / BLOB_MAX_BYTES + 1);
    expect(m.calls.some(c => staged(c) || c.includes('commit') || c.includes('push'))).toBe(false);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reason: `refusing to stage over ${STAGE_MAX_BYTES} bytes of agent-written files: big` }));
  });
  it('laneStageEntry: a single-link regular file or a symlink stages; a hardlink, directory or path through an escaping parent does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-stage-'));
    try {
      const lane = join(dir, 'lane'); mkdirSync(lane);
      const outside = join(dir, 'outside'); mkdirSync(outside);
      writeFileSync(join(outside, 'secret'), 'TOKEN');
      writeFileSync(join(outside, 'single'), 'TOKEN2');
      writeFileSync(join(lane, 'ok.txt'), 'fine');
      writeFileSync(join(lane, 'run.sh'), 'echo'); realFs.chmodSync(join(lane, 'run.sh'), 0o755);
      writeFileSync(join(lane, 'group-x.sh'), 'gx'); realFs.chmodSync(join(lane, 'group-x.sh'), 0o611); // git tests owner x only
      symlinkSync(join(outside, 'secret'), join(lane, 'link'));
      linkSync(join(outside, 'secret'), join(lane, 'hard.txt'));
      mkdirSync(join(lane, 'nested'));
      symlinkSync(outside, join(lane, 'out'));
      const show = (e) => e && (e.missing ? 'missing' : `${e.mode}:${e.data.toString()}`);
      expect(show(laneStageEntry(lane, 'ok.txt'))).toBe('100644:fine');
      expect(show(laneStageEntry(lane, 'run.sh'))).toBe('100755:echo');
      expect(show(laneStageEntry(lane, 'group-x.sh'))).toBe('100644:gx');
      expect(show(laneStageEntry(lane, 'link'))).toBe(`120000:${join(outside, 'secret')}`); // the link text, never the target
      expect(show(laneStageEntry(lane, 'missing.txt'))).toBe('missing'); // a deletion: nothing is read
      expect(laneStageEntry(lane, 'hard.txt')).toBeNull();
      expect(laneStageEntry(lane, 'nested')).toBeNull(); // `git add dir` would read every file under it
      expect(laneStageEntry(lane, 'out/single')).toBeNull(); // a single-link file through a parent that leaves the lane
      expect(laneStageEntry(lane, '../outside/single')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // Each marker git can emit (`<` ours, `|` diff3 base, `=` separator, `>` theirs), left behind ALONE, at the default
  // width and at a captured conflict-marker-size; with a label, bare, and CRLF.
  const leftovers = [7, 32].flatMap(n => [
    ['<', n, `${'<'.repeat(n)} HEAD`], ['|', n, `${'|'.repeat(n)} merged common ancestors`], ['|', n, '|'.repeat(n)],
    ['=', n, '='.repeat(n)], ['=', n, `${'='.repeat(n)}\r`], ['>', n, `${'>'.repeat(n)} origin/target`], ['>', n, '>'.repeat(n)],
  ]);
  it.each(leftovers)('rejects an isolated leftover %s marker (width %i) after resolution: %j', async (_kind, width, line) => {
    const attrs = width === 7 ? '' : `file.txt conflict-marker-size=${width}\n`;
    await withRealMerge({
      base: ({ dir }) => { writeFileSync(join(dir, 'file.txt'), 'base\n'); writeFileSync(join(dir, '.gitattributes'), attrs); },
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'theirs\n'),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n'),
    }, { agent: ({ dir }) => writeFileSync(join(dir, 'file.txt'), `ours\n${line}\ntheirs\n`) }, async ({ out, m, git, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.calls.some(c => c.includes('commit') || staged(c) || c.includes('push'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'conflict unresolved in file.txt: resolved' }));
      expect(git('status', '--porcelain')).toBe('');
    });
  });
  it('accepts marker-shaped lines a side already had (a setext heading, a fixture) and other widths', async () => {
    const fixture = 'Title\n=======\n\n<<<<<<< HEAD\n';
    await withRealMerge({
      base: ({ dir }) => writeFileSync(join(dir, 'file.txt'), `${fixture}base\n`),
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), `${fixture}theirs\n`),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), `${fixture}ours\n`),
    }, { agent: ({ dir }) => writeFileSync(join(dir, 'file.txt'), `${fixture}resolved\n========\n|| or\n> quote\n`) }, async ({ out, m }) => {
      expect(out.code).toBe(0);
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
    });
  });
  it('accepts a resolution keeping a marker-shaped line each side added (more than either side alone has)', async () => {
    const lines = (...xs) => `${xs.join('\n')}\n`;
    await withRealMerge({
      base: ({ dir }) => writeFileSync(join(dir, 'file.txt'), lines('A', '=======', 'B', 'x', 'C', 'D')),
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), lines('A', '=======', 'B', 'theirs', 'C', 'D', 'T', '=======')),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), lines('O', '=======', 'A', '=======', 'B', 'ours', 'C', 'D')),
    }, { agent: ({ dir }) => writeFileSync(join(dir, 'file.txt'), lines('O', '=======', 'A', '=======', 'B', 'both', 'C', 'D', 'T', '=======')) },
    async ({ out, m }) => {
      expect(out.code).toBe(0);
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
    });
  });
  it('rejects a leftover separator matching a marker-shaped line only the base had', async () => {
    await withRealMerge({
      base: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'Title\n=======\nbase\n'),
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'Title\ntheirs\n'),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'Title\nours\n'),
    }, { agent: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'Title\nours\n=======\ntheirs\n') }, async ({ out, m }) => {
      expect(out.code).toBe(1);
      expect(m.calls.some(c => c.includes('commit') || c.includes('push'))).toBe(false);
    });
  });
  it('scans the staged blob: markers hidden by an agent-written working-tree-encoding are still rejected', async () => {
    await withRealMerge({
      base: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'base\n'),
      theirs: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'theirs\n'),
      ours: ({ dir }) => writeFileSync(join(dir, 'file.txt'), 'ours\n'),
    }, { agent: ({ dir }) => {
      writeFileSync(join(dir, '.gitattributes'), 'file.txt working-tree-encoding=UTF-16LE\n');
      writeFileSync(join(dir, 'file.txt'), Buffer.from('ours\n=======\ntheirs\n', 'utf16le'));
    } }, async ({ out, m, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.calls.some(c => staged(c))).toBe(true);
      expect(m.calls.some(c => c.includes('commit') || c.includes('push'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'conflict unresolved in file.txt: resolved' }));
    });
  });
  // The attribute value as git parses it: a plain number, a `+`-signed one, and one too large for git (which then uses 7).
  it.each([['32', 32], ['+10', 10], ['99999999999', 7]])('takes the width from conflict-marker-size=%s when the file is not UTF-8 (no HEAD line to read it from)', async (size, width) => {
    const utf16 = (dir, text) => writeFileSync(join(dir, 'file.txt'), Buffer.from(text, 'utf16le'));
    await withRealMerge({
      base: ({ dir }) => {
        writeFileSync(join(dir, '.gitattributes'), `file.txt working-tree-encoding=UTF-16LE conflict-marker-size=${size}\n`);
        utf16(dir, 'base\n');
      },
      theirs: ({ dir }) => utf16(dir, 'theirs\n'),
      ours: ({ dir }) => utf16(dir, 'ours\n'),
    }, { agent: ({ dir }) => utf16(dir, `ours\n${'='.repeat(width)}\ntheirs\n`) }, async ({ out, m, recordOutcome }) => {
      expect(out.code).toBe(1);
      expect(m.calls.some(c => c.includes('commit') || c.includes('push'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'conflict unresolved in file.txt: resolved' }));
    });
  });
  it('never runs merge --abort in the agent-writable lane after its git config changed', async () => {
    const m = mk(['aaa', 'aaa']);
    let merging = false;
    let listed = 0;
    const run = (cmd, args, opts) => {
      m.calls.push([cmd, ...args]);
      if (args.includes('--show-scope')) return listed++ === 0 ? 'local\0user.name=x\0' : 'local\0filter.x.smudge=evil\0';
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging = true; throw new Error('conflicts'); }
      if (args.includes('status')) return 'UU file.txt\0';
      if (args.includes('--abort')) merging = false;
      return m.run(cmd, args, opts);
    };
    const out = await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run, fileExists: p => (p.endsWith('MERGE_HEAD') ? merging : true), readFile: () => '<<<<<<< HEAD\n' });
    expect(out.code).toBe(1);
    expect(m.spawn).toHaveBeenCalledOnce();
    expect(m.calls.some(c => c.includes('--abort'))).toBe(false);
    // The same guard covers the crash path: the agent throws after rewriting the config.
    const m2 = mk(['aaa', 'aaa']);
    let merging2 = false;
    let listed2 = 0;
    m2.spawn.mockImplementation(async () => { throw new Error('agent crashed'); });
    const run2 = (cmd, args, opts) => {
      m2.calls.push([cmd, ...args]);
      if (args.includes('--show-scope')) return listed2++ === 0 ? 'local\0user.name=x\0' : 'local\0filter.x.smudge=evil\0';
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging2 = true; throw new Error('conflicts'); }
      if (args.includes('status')) return 'UU file.txt\0';
      return m2.run(cmd, args, opts);
    };
    expect((await runFixCli([...argv, '--merge-onto=main'], { ...m2.io, run: run2, fileExists: p => (p.endsWith('MERGE_HEAD') ? merging2 : true), readFile: () => '<<<<<<< HEAD\n' })).code).toBe(1);
    expect(m2.calls.some(c => c.includes('--abort'))).toBe(false);
  });
  it('still aborts the merge after a crash when the lane git config is unchanged', async () => {
    const m = mk(['aaa', 'aaa']);
    let merging = false;
    m.spawn.mockImplementation(async () => { throw new Error('agent crashed'); });
    const run = (cmd, args, opts) => {
      m.calls.push([cmd, ...args]);
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging = true; throw new Error('conflicts'); }
      if (args.includes('status')) return 'UU file.txt\0';
      if (args.includes('--abort')) merging = false;
      return m.run(cmd, args, opts);
    };
    expect((await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run, fileExists: p => (p.endsWith('MERGE_HEAD') ? merging : true), readFile: () => '<<<<<<< HEAD\n' })).code).toBe(1);
    expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
  });
  it('does not post an fs or parse error message to the PR (only launcher-authored refusals)', async () => {
    const m = mk(['aaa']);
    const comments = [];
    const fsError = Object.assign(new Error("ENOENT: no such file, mkdtemp '/Users/someone/private/we-fix-x'"), { code: 'ENOENT', errno: -2, syscall: 'mkdtemp' });
    const run = (cmd, args, opts) => {
      if (args[0] === 'config') throw fsError;
      if (args.includes('comment')) { comments.push(readFileSync(args.at(-1), 'utf8')); return ''; }
      return m.run(cmd, args, opts);
    };
    const recordRouted = entry => ({ 'we#7': [entry, entry] });
    expect((await runFixCli(argv, { ...m.io, run, recordRouted })).code).toBe(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]).not.toContain('/Users/someone');
    expect(comments[0]).not.toContain('ENOENT');
  });
  it('unmergedPaths keeps only unmerged rows and skips rename sources', () => {
    expect(unmergedPaths('R  new\0old\0UU a b\0 M c\0DD d\0AA e\0')).toEqual([
      { path: 'a b', code: 'UU' }, { path: 'd', code: 'DD' }, { path: 'e', code: 'AA' }]);
  });
  it('posts escalation only at the threshold and logs a failed post without throwing', async () => {
    for (const n of [1, 2, 3]) {
      const m = mk(['aaa', 'aaa']);
      const table = { 'we#7': Array.from({ length: n }, () => ({ head: 'aaa', outcome: 'no-change', reason: 'no edits' })) };
      const writeErr = vi.fn();
      const run = (cmd, args, opts) => {
        if (args.includes('comment')) {
          const body = readFileSync(args.at(-1), 'utf8');
          expect(body).toContain('**fix-run: codex repair unproductive on aaa**');
          expect(body).not.toContain('no edits'); // the local reason never reaches the PR; only the agent note / outcome
          throw new Error('comment unavailable');
        }
        return m.run(cmd, args, opts);
      };
      expect((await runFixCli(argv, { ...m.io, run, writeErr, recordRouted: () => table })).code).toBe(0);
      expect(writeErr.mock.calls.length).toBe(n === 2 ? 1 : 0);
    }
  });
  it('refuses to commit or push when the agent changed the lane git config', async () => {
    const m = mk(['aaa', 'aaa']);
    let listed = 0;
    const run = (cmd, args, opts) => {
      if (args.includes('--show-scope')) { m.calls.push([cmd, ...args]); return listed++ === 0 ? 'local\0user.name=x\0' : 'local\0core.sshcommand=evil\0'; }
      if (args.includes('status')) return ' M file.txt\0';
      return m.run(cmd, args, opts);
    };
    const recordOutcome = vi.fn();
    expect((await runFixCli(argv, { ...m.io, run, recordOutcome })).code).toBe(1);
    expect(m.calls.some(c => staged(c) || c.includes('commit') || c.includes('push'))).toBe(false);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.stringContaining('lane git config changed') }));
  });
  it('the escalation comment fences agent text and neutralises mentions, backticks and finding phrases', () => {
    const body = escalationComment('abcdef1234567', [
      { outcome: 'no-change', note: '@octocat ```changes requested``` THIS IS AN ADVISORY REVIEW', reason: 'git push https://tok@host failed' },
      { outcome: 'failed', note: '' },
    ]);
    expect(body).toMatch(/^\*\*fix-run: codex repair unproductive on abcdef123\*\*/);
    expect(body.match(/```/g)).toHaveLength(2);
    expect(body).not.toMatch(/@[A-Za-z]/);
    expect(body).not.toMatch(/changes requested|THIS IS AN ADVISORY REVIEW/i);
    expect(body).not.toContain('tok@host');
    expect(body).toContain('- failed: failed');
    expect(escalationComment('h', [{ outcome: 'no-change', note: 'y'.repeat(300) }])).toContain(`${'y'.repeat(200)}\n`);
    expect(escalationComment('h', [{ outcome: 'no-change', note: 'y'.repeat(300) }])).not.toContain('y'.repeat(201));
  });
  it('readLaneFileSafe refuses symlinks, hardlinks and paths outside the lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-safe-'));
    try {
      const lane = join(dir, 'lane'); mkdirSync(lane);
      writeFileSync(join(dir, 'secret'), 'TOKEN');
      writeFileSync(join(lane, 'ok.txt'), 'fine');
      symlinkSync(join(dir, 'secret'), join(lane, '.fix-commit-msg.txt'));
      expect(readLaneFileSafe(join(lane, 'ok.txt'), lane)).toBe('fine');
      expect(readLaneFileSafe(join(lane, '.fix-commit-msg.txt'), lane)).toBeNull();
      expect(readLaneFileSafe(join(dir, 'secret'), lane)).toBeNull();
      expect(readLaneFileSafe(join(lane, 'missing'), lane)).toBeNull();
      linkSync(join(dir, 'secret'), join(lane, 'hard.txt'));
      expect(readLaneFileSafe(join(lane, 'hard.txt'), lane)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('readLaneFileSafe refuses a lane file over BLOB_MAX_BYTES and reads one exactly at it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-size-'));
    try {
      writeFileSync(join(dir, 'at.txt'), ''); truncateSync(join(dir, 'at.txt'), BLOB_MAX_BYTES); // sparse: no 64 MiB write
      writeFileSync(join(dir, 'over.txt'), ''); truncateSync(join(dir, 'over.txt'), BLOB_MAX_BYTES + 1);
      expect(readLaneFileSafe(join(dir, 'at.txt'), dir)?.length).toBe(BLOB_MAX_BYTES);
      expect(readLaneFileSafe(join(dir, 'over.txt'), dir) === null).toBe(true); // a boolean: a failure diff of 64 MiB would crash the reporter
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // A process the agent left running swaps the path while the launcher reads it: `swap` runs once, just BEFORE the first
  // fs call named in `before` (so it lands after every check that precedes that call).
  const swappingFs = (before, swap) => {
    const state = { fired: false };
    state.fs = new Proxy(realFs, { get: (fs, key) => typeof fs[key] !== 'function' ? fs[key] : (...args) => {
      if (!state.fired && before.includes(key)) { state.fired = true; swap(); }
      return fs[key](...args);
    } });
    return state;
  };
  it.each(['symlink-out', 'giant-file'])('readLaneFileSafe reads the file it checked, not one swapped in just before the read (%s)', (swap) => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-race-'));
    try {
      const lane = join(dir, 'lane'); mkdirSync(lane);
      const target = join(lane, 'ok.txt');
      writeFileSync(join(dir, 'secret'), 'TOKEN');
      writeFileSync(target, 'fine');
      writeFileSync(join(lane, 'big.txt'), ''); truncateSync(join(lane, 'big.txt'), BLOB_MAX_BYTES + 1);
      const racing = swappingFs(['readSync', 'readFileSync'], () => {
        rmSync(target);
        if (swap === 'symlink-out') symlinkSync(join(dir, 'secret'), target); else realFs.renameSync(join(lane, 'big.txt'), target);
      });
      const text = readLaneFileSafe(target, lane, racing.fs);
      expect(racing.fired).toBe(true);
      expect(text === 'fine').toBe(true); // a boolean: never TOKEN, never the 64 MiB file
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('readLaneFileSafe refuses a file opened through a symlinked parent and hardlinked into the lane after the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-link-'));
    try {
      const lane = join(dir, 'lane'); mkdirSync(lane);
      const outside = join(dir, 'outside'); mkdirSync(outside);
      writeFileSync(join(outside, 'ok.txt'), 'TOKEN');
      symlinkSync(outside, join(lane, 'sub'));
      // After the open/link-count check, the parent becomes a real lane directory holding a hardlink to the outside file.
      const racing = swappingFs(['realpathSync'], () => {
        rmSync(join(lane, 'sub'));
        mkdirSync(join(lane, 'sub'));
        linkSync(join(outside, 'ok.txt'), join(lane, 'sub', 'ok.txt'));
      });
      const text = readLaneFileSafe(join(lane, 'sub', 'ok.txt'), lane, racing.fs);
      expect(racing.fired).toBe(true);
      expect(text).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  // A process the agent left running appends to the SAME inode after the size was taken (no path swap): the read must
  // refuse it, and never ask for or take more than the captured size plus one byte.
  it.each([1, 1 << 20])('readLaneFileSafe rejects in-place growth after fstat (+%i bytes) and bounds bytes read', (grow) => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-grow-'));
    try {
      const target = join(dir, 'ok.txt');
      writeFileSync(target, 'fine');
      const seen = { grown: false, requested: 0, read: 0 };
      const fs = new Proxy(realFs, { get: (real, key) => key !== 'readSync' ? real[key] : (fd, buf, off, len, pos) => {
        if (!seen.grown) { seen.grown = true; realFs.appendFileSync(target, 'x'.repeat(grow)); }
        seen.requested += len;
        const r = real.readSync(fd, buf, off, len, pos);
        seen.read += r;
        return r;
      } });
      expect(readLaneFileSafe(target, dir, fs)).toBeNull();
      expect(seen.grown).toBe(true);
      expect(seen.requested).toBeLessThanOrEqual('fine'.length + 1);
      expect(seen.read).toBe('fine'.length + 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('readLaneFileSafe returns null for a FIFO without blocking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-run-fifo-'));
    try {
      execFileSync('mkfifo', [join(dir, 'pipe')]);
      expect(readLaneFileSafe(join(dir, 'pipe'), dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a refused (symlinked) commit-message file falls back to the default message', async () => {
    const m = mk(['aaa', 'bbb']);
    const run = (cmd, args, opts) => {
      if (args.includes('status')) return ' M file.txt\0';
      if (args.includes('commit')) expect(readFileSync(args[args.indexOf('-F') + 1], 'utf8')).toMatch(/^fix\(PR #7\): Repair/);
      return m.run(cmd, args, opts);
    };
    m.spawn.mockResolvedValue({ finalMessage: 'Repair' });
    expect((await runFixCli(argv, { ...m.io, run, fileExists: () => true, readFile: () => null })).code).toBe(0);
    expect(m.calls.some(c => c.includes('push'))).toBe(true);
  });
  it('rejects option injection as a merge ref before fetch or spawn', async () => {
    const m = mk(['aaa']);
    expect((await runFixCli([...argv, '--merge-onto=--evil'], m.io)).code).toBe(1);
    expect(m.spawn).not.toHaveBeenCalled();
    expect(m.calls.some(c => c.includes('fetch'))).toBe(false);
  });
  it('runs codex in the acquired lane with the brief, pushes (no force), re-arms, releases', async () => {
    const m = mk(['aaa', 'bbb']);
    const { code, result } = await runFixCli(argv, m.io);
    expect(code).toBe(0);
    expect(result).toMatch(/re-armed/);
    expect(m.spawn.mock.calls[0][0].prompt).toBe(SANDBOX_PREAMBLE + renderPrContext(JSON.stringify({ title: 'T', body: 'B', comments: [{ createdAt: '2026-01-01', body: '🔁 review — changes requested\nFIX THE THING' }] })) + 'BRIEF');
    expect(m.spawn.mock.calls[0][1].resolveLane()).toBe('/lanes/lane-5');
    const flat = m.calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes(`git ${HARDENED_GIT_ARGS.join(' ')} push --no-verify origin HEAD:refs/heads/lane/7-x`) && !c.includes('force'))).toBe(true);
    expect(flat.some((c) => c.includes('rearm-review.mjs 7 --repo=o/r'))).toBe(true);
    expect(flat.at(-1)).toContain('lane-pool.mjs release');
  });
  it('still re-arms after the push when the CI label step fails (best-effort hand-off)', async () => {
    const m = mk(['aaa', 'bbb']);
    const base = m.run.getMockImplementation();
    const writeErr = vi.fn();
    const run = vi.fn((cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === 'label') { m.calls.push([cmd, ...args]); throw new Error('HTTP 403: rate limit'); }
      if (cmd === 'gh' && args.includes('headRefOid,labels,statusCheckRollup')) { m.calls.push([cmd, ...args]); return JSON.stringify({ headRefOid: 'bbb', labels: [] }); }
      return base(cmd, args, opts);
    });
    const { code, result } = await runFixCli(argv, { ...m.io, run, writeErr });
    expect(code).toBe(0);
    expect(result).toMatch(/re-armed/);
    const flat = m.calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.startsWith('gh label create'))).toBe(true);
    expect(flat.some((c) => c.includes('rearm-review.mjs 7 --repo=o/r'))).toBe(true);
    expect(m.owed.sha).toBe(null);
    expect(writeErr).toHaveBeenCalledWith(expect.stringContaining('CI hand-off failed, re-arming anyway: HTTP 403: rate limit'));
  });
  it('no commit: no push, no re-arm, lane still released', async () => {
    const m = mk(['aaa', 'aaa']);
    const { code, result } = await runFixCli(argv, m.io);
    expect(code).toBe(0);
    expect(result).toMatch(/no-change/);
    const flat = m.calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('git push') || c.includes('rearm-review'))).toBe(false);
    expect(flat.at(-1)).toContain('release');
  });
  it('refuses an executor with no launcher before taking a lane; releases the lane on agent failure', async () => {
    const m = mk([]);
    expect((await runFixCli([...argv.slice(0, 4), '--provider=agy-claude'], m.io)).code).toBe(1);
    expect(m.run).not.toHaveBeenCalled();
    const f = mk(['aaa']); f.spawn.mockRejectedValue(new Error('boom'));
    expect((await runFixCli(argv, f.io)).code).toBe(1);
    expect(f.calls.at(-1).join(' ')).toContain('release');
  });
  it('a push with hooks off: the argv carries the hardening flags and --no-verify', async () => {
    const m = mk(['aaa', 'bbb']);
    await runFixCli(argv, m.io);
    const push = m.calls.find((c) => c.includes('push'));
    expect(push.slice(0, 1 + HARDENED_GIT_ARGS.length)).toEqual(['git', ...HARDENED_GIT_ARGS]);
    expect(push).toContain('--no-verify');
    const env = m.envs[m.calls.indexOf(push)];
    expect(env.GIT_CONFIG_COUNT).toBeDefined();                              // pins also ride git's own env, not only argv
    expect(Object.values(env)).toContain('core.sshCommand');
  });
  it.each(['credential.helper', 'merge.custom.driver', 'merge.custom.recursive', 'gpg.program', 'gpg.ssh.program', 'core.editor', 'trailer.custom.cmd', 'trailer.custom.command'])('refuses pre-poisoned lane config %s before merge or agent execution', async (key) => {
    const m = mk(['aaa', 'aaa']);
    const run = vi.fn((cmd, args) => (args[0] === 'config' ? `local\0${key}\n!evil\0` : m.run(cmd, args)));
    const out = await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run });
    expect(out.code).toBe(1);
    expect(m.spawn).not.toHaveBeenCalled();
    expect(m.calls.some(c => c.includes('merge') || c.includes('commit') || c.includes('push'))).toBe(false);
  });
  it('posts the launcher refusal reason when risky lane config prevents the agent from running', async () => {
    const m = mk(['aaa']);
    const comments = [];
    const run = (cmd, args, opts) => {
      if (args[0] === 'config') return 'local\0remote.primary.url\next::sh -c secret-command\0';
      if (args.includes('comment')) { comments.push(readFileSync(args.at(-1), 'utf8')); return ''; }
      return m.run(cmd, args, opts);
    };
    const recordRouted = entry => ({ 'we#7': [entry, entry] });
    expect((await runFixCli(argv, { ...m.io, run, recordRouted })).code).toBe(1);
    expect(m.spawn).not.toHaveBeenCalled();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('lane git config defines command/credential/remote-rewrite keys (remote.primary.url); refusing to run in it');
    expect(comments[0]).not.toContain('secret-command');
  });
  it.each(['status', 'signal', 'stderr', 'stdout', 'pid', 'status/stderr', 'non-Error'])(
    'does not post raw command errors (%s)', async marker => {
      const m = mk(['aaa']);
      const message = 'Command failed: git fetch https://secret@example.com/repo.git';
      const error = marker === 'non-Error' ? { message } : Object.assign(new Error(message),
        marker === 'status/stderr' ? { status: 1, stderr: Buffer.from(message) } : { [marker]: undefined });
      const comments = [];
      const run = (cmd, args, opts) => {
        if (args[0] === 'config') throw error;
        if (args.includes('comment')) { comments.push(readFileSync(args.at(-1), 'utf8')); return ''; }
        return m.run(cmd, args, opts);
      };
      const recordRouted = entry => ({ 'we#7': [entry, entry] });
      expect((await runFixCli(argv, { ...m.io, run, recordRouted })).code).toBe(1);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain('- failed: failed');
      expect(comments[0]).not.toContain(message);
      expect(comments[0]).not.toContain('secret');
    });
  it('a failed pending-marker write is not fatal: the repair is still pushed and re-armed', async () => {
    const m = mk(['aaa', 'bbb']);
    m.pendingRearm.write.mockImplementation(() => { throw new Error('disk full'); });
    const out = await runFixCli(argv, m.io);
    expect(out.code).toBe(0);
    expect(m.calls.some((c) => c.includes('push'))).toBe(true);
    expect(m.calls.some((c) => c.join(' ').includes('rearm-review'))).toBe(true);
  });
  it('the marker is written BEFORE the push', async () => {
    const m = mk(['aaa', 'bbb']);
    const order = [];
    m.pendingRearm.write.mockImplementation(() => { order.push('marker'); });
    const base = m.run.getMockImplementation();
    const run = vi.fn((cmd, args, o) => { if (args.includes('push')) order.push('push'); return base(cmd, args, o); });
    await runFixCli(argv, { ...m.io, run });
    expect(order).toEqual(['marker', 'push']);
  });
  it('removes the brief file on every exit: success, agent failure, refused executor/args', async () => {
    const ok = mk(['aaa', 'aaa']); const rm1 = vi.fn();
    await runFixCli(argv, { ...ok.io, removePrompt: rm1 });
    expect(rm1).toHaveBeenCalledWith('/p.md');
    const bad = mk(['aaa']); bad.spawn.mockRejectedValue(new Error('boom')); const rm2 = vi.fn();
    await runFixCli(argv, { ...bad.io, removePrompt: rm2 });
    expect(rm2).toHaveBeenCalledWith('/p.md');
    const rm3 = vi.fn();
    await runFixCli(['--pr=7', '--prompt-file=/q.md'], { ...ok.io, removePrompt: rm3 });   // missing required flags
    expect(rm3).toHaveBeenCalledWith('/q.md');
  });
  it('refuses to push when the agent changed the lane repo-local git config (remote url, sshCommand, insteadOf...)', async () => {
    const calls = [];
    let cfg = 0;
    const run = vi.fn((cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'gh') return '{}';
      if (args.includes('acquire')) return '/lanes/lane-5';
      if (args[0] === 'rev-parse') return cfg++ ? 'bbb' : 'aaa';
      if (args[0] === 'config') return calls.filter((c) => c[1] === 'config').length === 1 ? 'remote.origin.url=https://x/r' : 'remote.origin.url=https://evil/r';
      return '';
    });
    const m = mk([]);
    const out = await runFixCli(argv, { ...m.io, run });
    expect(out.code).toBe(1);
    expect(calls.some((c) => c.includes('push') || c.some((a) => String(a).includes('rearm-review')))).toBe(false);
    expect(calls.at(-1).join(' ')).toContain('release');
  });
  it('re-arms an already-pushed repair after a prior re-arm failure (no-change retry)', async () => {
    const m = mk(['aaa', 'bbb']);
    let n = 0;
    const base = m.run.getMockImplementation();
    const run = vi.fn((cmd, args) => {
      if (args.some((a) => String(a).includes('rearm-review')) && n++ === 0) throw new Error('gh down');
      return base(cmd, args);
    });
    expect((await runFixCli(argv, { ...m.io, run })).code).toBe(1);        // pushed, re-arm failed
    expect(m.owed.sha).toBe('bbb');                                          // ... and recorded as owed
    // retry: the new lane opens AT the pushed tip (bbb): re-arm right away, no agent run
    const m2 = mk(['bbb', 'bbb']);
    m2.owed.sha = 'bbb';
    const r = await runFixCli(argv, m2.io);
    expect(r.code).toBe(0);
    expect(r.result).toMatch(/re-armed/);
    expect(m2.spawn).not.toHaveBeenCalled();
    expect(m2.calls.some((c) => c.join(' ').includes('rearm-review.mjs 7 --repo=o/r'))).toBe(true);
    expect(m2.calls.some((c) => c.includes('push'))).toBe(false);
    expect(m2.owed.sha).toBe(null);
  });
  it('clears a pending re-arm refusal as pushed without running another agent', async () => {
    vi.stubEnv('WE_FIX_REARM_NOTHING_TO_REARM', 'noop');
    const m = mk(['bbb']);
    m.owed.sha = 'bbb';
    const base = m.run.getMockImplementation();
    const run = vi.fn((cmd, args, opts) => {
      if (args.some((a) => String(a).includes('rearm-review'))) {
        throw Object.assign(new Error('Command failed'), { stderr: 'neither review:changes nor review:accepted is live — nothing to re-arm' });
      }
      return base(cmd, args, opts);
    });
    const write = vi.fn(), appendLoopRow = vi.fn();
    const out = await runFixCli(argv, { ...m.io, run, write, appendLoopRow });
    expect(out.code).toBe(0);
    expect(m.owed.sha).toBe(null);
    expect(m.pendingRearm.clear).toHaveBeenCalledOnce();
    expect(m.spawn).not.toHaveBeenCalled();
    expect(appendLoopRow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'outcome', outcome: 'pushed' }));
    expect(write).toHaveBeenCalledWith('fix-run: PR #7 re-arm skipped — nothing to re-arm (review label not changes/accepted); policy fixRearmNothingToRearm=noop (source env)\n');
  });
  it('an unrelated stale marker (a different tip) does not re-arm a no-change run', async () => {
    const m = mk(['aaa', 'aaa']);
    m.owed.sha = 'zzz';
    expect((await runFixCli(argv, m.io)).result).toMatch(/no-change/);
    expect(m.calls.some((c) => c.join(' ').includes('rearm-review'))).toBe(false);
  });
});

describe('riskyLaneConfig', () => {
  const list = (...kv) => kv.map(([scope, k, v]) => `${scope}\0${k}\n${v}\0`).join('');
  // Inventory of launcher commands, including recovery. Read-only plumbing has no command-running keys.
  it.each([
    ['config', ['include.path', 'includeIf.gitdir:x.path']],
    ['rev-parse', []], ['check-ref-format', []],
    ['fetch', ['core.hooksPath', 'core.sshCommand', 'credential.helper', 'remote.origin.uploadpack']],
    ['merge', ['core.hooksPath', 'core.fsmonitor', 'merge.custom.driver', 'merge.custom.recursive', 'core.editor', 'commit.gpgsign', 'gpg.program', 'gpg.ssh.program']],
    ['merge --abort', ['core.hooksPath', 'core.fsmonitor', 'filter.custom.smudge', 'filter.custom.process']],
    ['status', ['core.fsmonitor', 'filter.custom.clean']],
    ['diff --numstat', ['core.fsmonitor', 'filter.custom.clean']],
    ['add', ['core.fsmonitor', 'filter.custom.clean', 'filter.custom.process']],
    ['commit', ['core.hooksPath', 'core.fsmonitor', 'core.editor', 'commit.gpgsign', 'gpg.program', 'gpg.ssh.program', 'trailer.custom.cmd', 'trailer.custom.command']],
    ['push', ['core.hooksPath', 'core.sshCommand', 'credential.helper', 'remote.origin.receivepack']],
  ])('pins or refuses command-running config for %s', (_command, keys) => {
    const pins = new Map(LANE_GIT_CONFIG_PINS.map(([k, v]) => [k.toLowerCase(), v]));
    for (const key of keys) {
      if (pins.has(key.toLowerCase())) {
        expect(HARDENED_GIT_ARGS).toContain(`${key}=${pins.get(key.toLowerCase())}`);
      } else {
        for (const scope of ['local', 'worktree']) {
          expect(riskyLaneConfig(list([scope, key, 'evil']))).toEqual([key]);
        }
      }
    }
  });
  it('disables signing in both argv and inherited environment pins', () => {
    expect(HARDENED_GIT_ARGS).toContain('commit.gpgsign=false');
    const env = laneGitHardeningEnv({});
    const pins = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pins).toContainEqual(['commit.gpgsign', 'false']);
  });
  it('flags unpinned command/credential/rewrite keys in the lane scope, not host scope', () => {
    expect(riskyLaneConfig(list(['local', 'credential.helper', '!x'], ['local', 'url.https://e/.insteadOf', 'https://github.com/'],
      ['worktree', 'core.gitProxy', 'p'], ['local', 'include.path', '../x'], ['local', 'remote.origin.pushurl', 'u'], ['local', 'alias.push', '!x'])))
      .toHaveLength(6);
    expect(riskyLaneConfig(list(['global', 'credential.helper', 'osxkeychain'], ['local', 'core.hooksPath', '.hooks'], ['local', 'remote.origin.url', 'https://github.com/o/r.git']))).toEqual([]);
    expect(riskyLaneConfig(list(['local', 'remote.origin.url', 'ext::sh -c evil']))).toEqual(['remote.origin.url']);
  });
});

describe('the pending re-arm store', () => {
  it('round-trips, expires after a week, and clears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pend-'));
    try {
      const s = defaultPendingRearm(dir);
      expect(s.read('o/r', 7)).toBeNull();
      s.write('o/r', 7, 'abc', 1000);
      expect(s.read('o/r', 7, 2000)).toMatchObject({ sha: 'abc' });
      expect(s.read('o/r', 7, 1000 + 8 * 24 * 3_600_000)).toBeNull();
      s.clear('o/r', 7);
      expect(s.read('o/r', 7, 2000)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the borrowed-brief file', () => {
  it('lands in a fresh private (0700) directory as a 0600 file, never a shared predictable path, and is removed after reading', () => {
    const base = mkdtempSync(join(tmpdir(), 'base-'));
    try {
      const a = writePrivateBorrowedPrompt('fix-7', 'secret brief', base);
      const b = writePrivateBorrowedPrompt('fix-7', 'secret brief', base);
      expect(a).not.toBe(b);
      expect(statSync(dirname(a)).mode & 0o777).toBe(0o700);
      expect(statSync(a).mode & 0o777).toBe(0o600);
      expect(readFileSync(a, 'utf8')).toBe('secret brief');
      expect(writePrivateBorrowedPrompt('../../etc/x', 't', base)).toContain(base);   // slug cannot escape the directory
      removePromptFile(a);
      expect(existsSync(a)).toBe(false);
      expect(existsSync(dirname(a))).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('fix-run as a CLI entry (red before: exit 13, unsettled top-level await)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  it('dispatch-providers/fix.mjs never reaches fix-run.mjs through its local import graph', () => {
    const seen = new Set();
    const follow = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      let src;
      try { src = readFileSync(file, 'utf8'); } catch { return; }
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)) follow(resolve(dirname(file), m[1]));
    };
    follow(resolve(here, '..', 'dispatch-providers', 'fix.mjs'));
    expect([...seen].filter((f) => f.endsWith('operations/fix-run.mjs'))).toEqual([]);
  });
  it('fix-run.mjs static (non-lazy) imports never reach the wrapper chain it imports lazily', () => {
    const seen = new Set();
    const follow = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      let src;
      try { src = readFileSync(file, 'utf8'); } catch { return; }
      for (const m of src.matchAll(/^(?:import|export)\b[^;]*?from\s*['"](\.{1,2}\/[^'"]+\.mjs)['"]/gm)) follow(resolve(dirname(file), m[1]));
    };
    follow(resolve(here, '..', 'fix-run.mjs'));
    expect([...seen].filter((f) => /deliver-item-wrapper|dispatch-provider-registry|dispatch-lane-io/.test(f))).toEqual([]);
  });
  it('runs as a real process and fails fast on bad args instead of hanging', () => {
    let code = 0; let stderr = '';
    try { execFileSync(process.execPath, [resolve(here, '..', 'fix-run.mjs')], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }); }
    catch (e) { code = e.status; stderr = String(e.stderr); }
    expect(code).toBe(1);
    expect(stderr).toMatch(/missing required flag/);
  });
});

describe('launcher CI inputs, card 5947 (live #5045, 2026-10-13)', () => {
  it('collapses stale checks, reads at most four job APIs and tolerates individual failures', async () => {
    const checks = [{ name: 'stale', conclusion: 'FAILURE' }, { name: 'stale', conclusion: 'SUCCESS' },
      ...Array.from({ length: 6 }, (_, i) => ({ name: `check-${i}`, conclusion: i === 1 ? 'timed_out' : 'failure', detailsUrl: `https://github.com/o/r/actions/runs/1/job/${i + 1}` }))];
    const run = vi.fn((cmd, args) => {
      if (args.includes('view')) return JSON.stringify({ title: 'T', body: 'B', statusCheckRollup: checks });
      if (args[1].endsWith('/1/logs')) throw new Error('404');
      return '\u001b[31m2026-10-13T13:19:27.2719622Z FAIL  a.test.mjs > test\u001b[0m\n2026-10-13T13:19:28Z Error: broken';
    });
    const inputs = await readCiHealInputs({ repo: 'o/r', pr: 7, run });
    expect(inputs.checks).toHaveLength(6);
    expect(inputs.jobs).toHaveLength(4);
    expect(inputs.jobs[0].log).toBe('');
    expect(inputs.jobs[1].log).toBe('FAIL  a.test.mjs > test\nError: broken');
    expect(run.mock.calls.filter(([, args]) => args[0] === 'api').map(([, args]) => args[1]))
      .toEqual([1, 2, 3, 4].map(id => `repos/o/r/actions/jobs/${id}/logs`));
    expect(run.mock.calls[0][1]).toContain('title,body,statusCheckRollup');
    const context = renderCiHealContext(inputs);
    expect(context).toContain('a.test.mjs');
    expect(context).toContain('Error: broken');
    expect(context.indexOf('### Failed log\ncheck-1')).toBeGreaterThan(0);
  });
  it('bounds context and still supplies check links with empty logs', () => {
    const inputs = { title: 'T', body: 'b'.repeat(8000), checks: [{ name: 'unit', detailsUrl: 'https://github.com/o/r/job/1' }], jobs: [] };
    expect(renderCiHealContext(inputs)).toContain('https://github.com/o/r/job/1');
    expect(renderCiHealContext(inputs)).not.toContain('b'.repeat(4001));
    expect(renderCiHealContext({ ...inputs, jobs: [{ name: 'unit', log: 'line'.repeat(10000) }] }).length).toBeLessThanOrEqual(16020);
  });
});

it('fix provider runs an injected Antigravity worker in the existing lane', async () => {
  const {resolveFixProvider} = await import('../fix-run.mjs');
  const provider = await resolveFixProvider('antigravity');
  const runTask = vi.fn(async ()=>({events:{agentMessages:['earlier response'],finalResponse:'done'}}));
  expect(await provider.spawn({prompt:'edit',model:'gemini-4-argon-high',effort:'high',sessionSlug:'fix-7'}, {resolveLane:()=>'/lane',runTask})).toMatchObject({finalMessage:'done'});
  expect(runTask).toHaveBeenCalledWith(expect.objectContaining({task:'edit',dir:'/lane',gate:'none',model:'gemini-4-argon-high',effort:'high'}));
});

it('every fix executor declares confinement or is unavailable for dispatch', () => {
  for (const executor of FIX_RUN_EXECUTORS) {
    const contract = FIX_RUN_CONFINEMENT[executor];
    expect(contract).toBeDefined();
    if (contract.mode === 'sandboxed') expect(contract.boundary).toBe('workspace');
    else {
      expect(contract.mode).toBe('unavailable');
      expect(contract.reason).toBeTruthy();
      expect(fixLauncherAvailable(executor)).toBe(false);
    }
  }
  expect(fixLauncherAvailable('codex')).toBe(true);
  expect(fixLauncherAvailable('antigravity')).toBe(false);
});

it('refuses the production Antigravity worker before running untrusted review input', async () => {
  const { resolveFixProvider } = await import('../fix-run.mjs');
  const provider = await resolveFixProvider('antigravity');
  await expect(provider.spawn({ prompt: 'untrusted PR review', sessionSlug: 'fix-7' }, { resolveLane: () => '/missing/lane' }))
    .rejects.toThrow('confined Antigravity fix adapter is unavailable');
});

it.each([{exitCode:1}, {exitCode:null}, {exitCode:0,timedOut:true}])('reports failed Gemini task %j with its final message', async failure => {
  const {resolveFixProvider} = await import('../fix-run.mjs');
  const provider = await resolveFixProvider('antigravity');
  await expect(provider.spawn({prompt:'edit',sessionSlug:'fix-7'}, {resolveLane:()=>'/lane',runTask:async()=>({...failure,events:{agentMessages:['diagnosis']}})}))
    .rejects.toMatchObject({finalMessage:'diagnosis'});
});

describe('acquire launcher diagnostics', () => {
  it('retains the last error line and short command', () => {
    const err = Object.assign(new Error('Command failed: node scripts/lane-pool.mjs acquire --session=long'), {
      stderr: Buffer.from('noise\n✗ first\n✗ lock contention: retry\ntrailing context\n'),
    });
    expect(childFailureReason(err)).toBe('✗ lock contention: retry (lane-pool.mjs acquire)');
    expect(childFailureReason(Object.assign(err, { stderr: 'noise\nlast diagnostic\n' }))).toBe('last diagnostic (lane-pool.mjs acquire)');
    expect(childFailureReason(new Error('plain refusal'))).toBe('plain refusal');
  });
  it.each(['-1', '1.5', 'garbage', ''])('rejects invalid env wait %s', value => {
    expect(resolveAcquireWaitPolicy({ WE_FIX_RUN_ACQUIRE_WAIT_MS: value })).toEqual({ ms: 120000, source: 'standard' });
  });
});

it('routes a repeated finding from the Claude fixer to the mechanical launcher', () => {
  const finding = { author: { login: 'web-everything' }, body: '🔁 review — changes requested\n### Findings (1)\n**correctness/bug** (1)\n- `a.mjs:10` — repeated bug' };
  const comments = [finding, { author: { login: 'web-everything' }, body: '🔓 conveyor fix-end' }, finding];
  const spawnBorrowed = vi.fn(() => 'pid:4242'), spawnAgent = vi.fn();
  const out = dispatchFix({ pr: 7, itemNum: '7', lane: 2, laneRef: 'lane/7-x', scope: ['we:a.mjs'], headRefOid: 'a'.repeat(40) }, {
    root: '/repo', repo: 'we', executorDecision: { executor: 'claude', source: 'test' },
    readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, stampExecutor: () => {},
    readHistoryInputs: () => ({ comments, commits: [] }), postNotice: () => {}, readBrief: () => 'brief {{PR_NUM}}',
    spawnBorrowed, spawnAgent, writeBorrowedPrompt: () => '/tmp/p.md',
    checkoutExists: () => true, readPackageJson: () => ({ scripts: {} }),
  });
  expect(spawnAgent).not.toHaveBeenCalled();
  expect(spawnBorrowed).toHaveBeenCalledOnce();
  expect(out.agentId).toBe('pid:4242');
});

it('keeps infrastructure stalls and distinct em-dash findings on the ordinary executor route', () => {
  const review = summary => ({ author: { login: 'web-everything' }, body: `🔁 review — changes requested\n### Findings (1)\n**correctness/bug** (1)\n- \`a.mjs:10\` — ${summary}` });
  const end = infraStall => ({ author: { login: 'web-everything' }, body: buildFixEndComment({ who: 'fix-7', infraStall }) });
  for (const prefix of [[], [{ author: { login: 'chalbert' }, body: `scope-baseline: ${'b'.repeat(40)}` }]]) {
    for (const history of [[review('same bug'), end(true), review('same bug')],
      [review('ID validation is wrong — whitespace-only IDs are accepted'), end(false),
        review('ID validation is wrong — valid Unicode IDs are rejected')],
      [review('ID validation is wrong\n### Detail\nwhitespace-only IDs are accepted'), end(false),
        review('ID validation is wrong\n### Detail\nvalid Unicode IDs are rejected')]]) {
      const spawnBorrowed = vi.fn(() => 'pid:4242');
      const out = dispatchFix({ pr: 7, itemNum: '7', lane: 2, laneRef: 'lane/7-x', scope: ['we:a.mjs'], headRefOid: 'a'.repeat(40) }, {
        root: '/repo', repo: 'we', executorDecision: { executor: 'agy-claude', source: 'test' },
        readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, stampExecutor: () => {}, stampRunner: () => {},
        readHistoryInputs: () => ({ comments: [...prefix, ...history], commits: [] }), postNotice: () => {}, readBrief: () => 'brief {{PR_NUM}}',
        spawnBorrowed, writeBorrowedPrompt: () => '/tmp/p.md',
        checkoutExists: () => true, readPackageJson: () => ({ scripts: {} }),
      });
      expect(out.agentId).toBe('pid:4242');
      expect(spawnBorrowed).toHaveBeenCalledWith(expect.objectContaining({ policyRoute: { provider: 'antigravity-claude' } }));
    }
  }
});
