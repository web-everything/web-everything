import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createFixBorrowGate } from '../../lib/fix-slot-borrow.mjs';
import { dispatchFix } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { resolveFixBorrowSettings } from '../../lib/dispatch-throttle.mjs';
import { fixDetachedProvider, fixLauncherAvailable, FIX_RUN_SCRIPT } from '../dispatch-providers/fix.mjs';
import { parseFixRunArgv, runFixCli, SANDBOX_PREAMBLE } from '../fix-run.mjs';

const MIN = 60_000;
let clock = 1_000_000;
const ledger = () => { let v = {}; return { read: () => v, write: (x) => { v = x; } }; };
const codexGate = () => createFixBorrowGate({
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
  it('dispatchFix on a borrowed codex slot writes the brief and calls the fix launcher, not claude --bg', () => {
    const spawnBorrowed = vi.fn(() => 'pid:4242');
    const spawnAgent = vi.fn();
    const writeBorrowedPrompt = vi.fn(() => '/tmp/p.md');
    const out = dispatchFix({
      pr: 7, itemNum: '7', lane: 2, laneRef: 'lane/7-x', scope: ['we:a.mjs'], overlapScope: ['we:a.mjs'], headRefOid: 'abc',
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
      pr: 7, ref: 'lane/7-x', promptFile: '/tmp/p.md', policyRoute: { provider: 'codex' },
    }));
    expect(out.agentId).toBe('pid:4242');
  });
  it('fixDetachedProvider forwards the prompt file, ref and --provider=codex to fix-run', () => {
    const spawnDetached = vi.fn(() => ({ pid: 99 }));
    const h = fixDetachedProvider({
      pr: 7, sessionSlug: 'fix-7', ref: 'lane/7-x', promptFile: '/tmp/p.md', repo: 'o/r', laneRepo: '/w', scope: 'we:a.mjs',
      policyRoute: { provider: 'codex' },
    }, { spawnDetached, logPathFor: () => '/tmp/l', readDeliveryAgentMarker: () => null });
    expect(h).toBe('pid:99');
    const argv = spawnDetached.mock.calls[0][0];
    expect(argv[0]).toBe(FIX_RUN_SCRIPT);
    expect(parseFixRunArgv(argv.slice(1))).toMatchObject({ pr: '7', provider: 'codex', ref: 'lane/7-x', promptFile: '/tmp/p.md', repo: 'o/r' });
  });
});

describe('runFixCli', () => {
  const argv = ['--pr=7', '--session=fix-7', '--ref=lane/7-x', '--prompt-file=/p.md', '--provider=codex', '--repo=o/r', '--lane-repo=/w'];
  const mk = (heads) => {
    const calls = [];
    const run = vi.fn((cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('acquire')) return 'noise\n/lanes/lane-5\n';
      if (args[0] === 'rev-parse') return heads.shift();
      return '';
    });
    const spawn = vi.fn(async () => {});
    return { calls, run, spawn, io: { run, readPrompt: () => 'BRIEF', resolveProvider: () => ({ spawn }), weRoot: '/we', write: () => {}, writeErr: () => {} } };
  };
  it('runs codex in the acquired lane with the brief, pushes (no force), re-arms, releases', async () => {
    const m = mk(['aaa', 'bbb']);
    const { code, result } = await runFixCli(argv, m.io);
    expect(code).toBe(0);
    expect(result).toMatch(/re-armed/);
    expect(m.spawn.mock.calls[0][0].prompt).toBe(SANDBOX_PREAMBLE + 'BRIEF');
    expect(m.spawn.mock.calls[0][1].resolveLane()).toBe('/lanes/lane-5');
    const flat = m.calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.includes('git push origin HEAD:refs/heads/lane/7-x') && !c.includes('force'))).toBe(true);
    expect(flat.some((c) => c.includes('rearm-review.mjs 7 --repo=o/r'))).toBe(true);
    expect(flat.at(-1)).toContain('lane-pool.mjs release');
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
});
