import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixBorrowGate } from '../../lib/fix-slot-borrow.mjs';
import { dispatchFix, writePrivateBorrowedPrompt } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { resolveFixBorrowSettings } from '../../lib/dispatch-throttle.mjs';
import { fixDetachedProvider, fixLauncherAvailable, FIX_RUN_SCRIPT } from '../dispatch-providers/fix.mjs';
import { parseFixRunArgv, renderPrContext, runFixCli, SANDBOX_PREAMBLE, HARDENED_GIT_ARGS, defaultPendingRearm, removePromptFile, riskyLaneConfig, changedPaths } from '../fix-run.mjs';

// x6nuodj — these tests pin the LEGACY gate's verdicts, so the shared decision only observes here (`shadow`); the
// cut-over itself (admit() deciding) is covered in we:scripts/lib/__tests__/resource-gate.test.mjs.
beforeEach(() => { vi.stubEnv('WE_RESOURCE_CUTOVER', 'shadow'); vi.stubEnv('WE_RESOURCE_SHADOW', 'off'); });
afterEach(() => vi.unstubAllEnvs());


const MIN = 60_000;
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
    return { calls, envs, run, spawn, owed, pendingRearm, io: { run, pendingRearm, readComments: async () => [{ createdAt: '2026-01-01', body: '🔁 review — changes requested\nFIX THE THING' }], releaseClaim: async () => ({ released: [] }), recordOutcome: () => {}, recordRouted: () => ({}), removePrompt: () => {}, readPrompt: () => 'BRIEF', resolveProvider: () => ({ spawn }), weRoot: '/we', write: () => {}, writeErr: () => {} } };
  };
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
  it('commits uncommitted edits using explicit paths and excludes scratch', async () => {
    const m = mk(['aaa', 'bbb']);
    m.spawn.mockResolvedValue({ finalMessage: 'Repair finding' });
    const run = (cmd, args, opts) => {
      if (args.includes('status')) return ' M file.txt\0?? .fix-commit-msg.txt\0';
      return m.run(cmd, args, opts);
    };
    expect((await runFixCli(argv, { ...m.io, run })).code).toBe(0);
    expect(m.calls).toContainEqual(['git', ...HARDENED_GIT_ARGS, 'add', '--', 'file.txt']);
    expect(m.calls.find(c => c.includes('commit'))?.slice(-2)).toEqual(['--', 'file.txt']);
    expect(m.calls.some(c => c.includes('push'))).toBe(true);
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
  it.each([false, true])('launcher merges conflicts (unresolved=%s)', async (unresolved) => {
    const m = mk(['aaa', 'bbb']);
    let merging = false;
    m.spawn.mockResolvedValue({ finalMessage: 'Agent final diagnosis' });
    const run = (cmd, args, opts) => {
      m.calls.push([cmd, ...args]);
      if (args.includes('--git-path')) return 'MERGE_HEAD';
      if (args.includes('merge') && args.includes('--no-commit')) { merging = true; throw new Error('conflicts'); }
      if (args.includes('diff')) return 'file.txt\0';
      if (args.includes('commit') || args.includes('--abort')) merging = false;
      return m.run(cmd, args, opts);
    };
    const recordOutcome = vi.fn();
    const out = await runFixCli([...argv, '--merge-onto=main'], { ...m.io, run, recordOutcome,
      fileExists: p => p.endsWith('MERGE_HEAD') ? merging : true,
      readFile: () => unresolved ? '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> origin/main\n' : 'resolved',
    });
    expect(m.spawn.mock.calls[0][0].prompt).toContain('ALREADY started git merge origin/main');
    expect(out.code).toBe(unresolved ? 1 : 0);
    if (unresolved) {
      expect(m.calls.some(c => c.includes('--abort'))).toBe(true);
      expect(m.calls.some(c => c.includes('push'))).toBe(false);
      expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'conflict unresolved in file.txt: Agent final diagnosis' }));
    } else {
      expect(m.calls.some(c => c.includes('commit') && c.includes('--no-edit') && c.includes('--trailer'))).toBe(true);
      expect(m.calls.some(c => c.includes('push'))).toBe(true);
    }
  });
  it('posts escalation only at the threshold and logs a failed post without throwing', async () => {
    for (const n of [1, 2, 3]) {
      const m = mk(['aaa', 'aaa']);
      const table = { 'we#7': Array.from({ length: n }, () => ({ head: 'aaa', outcome: 'no-change', reason: 'no edits' })) };
      const writeErr = vi.fn();
      const run = (cmd, args, opts) => {
        if (args.includes('comment')) {
          expect(readFileSync(args.at(-1), 'utf8')).toContain('**fix-run: codex repair unproductive on aaa**');
          throw new Error('comment unavailable');
        }
        return m.run(cmd, args, opts);
      };
      expect((await runFixCli(argv, { ...m.io, run, writeErr, recordRouted: () => table })).code).toBe(0);
      expect(writeErr.mock.calls.length).toBe(n === 2 ? 1 : 0);
    }
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
  it('refuses a lane whose config ALREADY defines a credential/proxy/rewrite key, before running the agent', async () => {
    const m = mk(['aaa', 'aaa']);
    const run = vi.fn((cmd, args) => (args[0] === 'config' ? 'local\0credential.helper\n!evil\0' : m.run(cmd, args)));
    const out = await runFixCli(argv, { ...m.io, run });
    expect(out.code).toBe(1);
    expect(m.spawn).not.toHaveBeenCalled();
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
  it('an unrelated stale marker (a different tip) does not re-arm a no-change run', async () => {
    const m = mk(['aaa', 'aaa']);
    m.owed.sha = 'zzz';
    expect((await runFixCli(argv, m.io)).result).toMatch(/no-change/);
    expect(m.calls.some((c) => c.join(' ').includes('rearm-review'))).toBe(false);
  });
});

describe('riskyLaneConfig', () => {
  const list = (...kv) => kv.map(([scope, k, v]) => `${scope}\0${k}\n${v}\0`).join('');
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
