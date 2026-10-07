// A borrowed (codex) fix that "launches and dies silently" (live 2026-10-07, PR #4231/#4233).
// Root cause: the codex sandbox has no network, the brief tells the agent to `gh pr view` the reviewer's finding, and the
// launcher never supplied it -> codex answered "the finding was omitted", committed nothing, exit 0 "no-change". The claim
// was never released, the dead runner kept a fixer-cap slot, and the gate kept borrowing for the same PR forever.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixCli, renderPrContext, SANDBOX_PREAMBLE, parseFixRunArgv } from '../fix-run.mjs';
import { fixDetachedProvider } from '../dispatch-providers/fix.mjs';
import { createFixBorrowGate, recordBorrowOutcome, recentBorrowFailures } from '../../lib/fix-slot-borrow.mjs';
import { countLiveFixSessions, createDispatchThrottle, isBorrowedRunnerDead } from '../../lib/dispatch-throttle.mjs';
import {
  acquireFixDispatchClaim, readFixDispatchClaim, refreshLiveFixDispatchClaims, releaseSessionFixDispatchClaims, stampBorrowedRunnerPid,
} from '../../conveyor/fix-dispatch-claim.mjs';

const PR = { title: 'T', body: 'B', comments: [
  { createdAt: '2026-01-01T00:00:00Z', body: '🔁 review — changes requested\nOLD ask' },
  { createdAt: '2026-01-02T00:00:00Z', body: '🔁 human review — changes requested\nNEW ask' },
  { createdAt: '2026-01-03T00:00:00Z', body: 'thanks!' },
] };

describe('(4) the launch bug: the agent is given the reviewer finding', () => {
  it('renders the LATEST changes-requested comment into the prompt', () => {
    const t = renderPrContext(PR);
    expect(t).toContain('NEW ask');
    expect(t).not.toContain('OLD ask');
    expect(SANDBOX_PREAMBLE).toMatch(/PR CONTEXT/);
  });
  it('a PR with no finding is a failure, not a silent no-change', () => {
    expect(() => renderPrContext({ title: 'T', body: 'B', comments: [{ body: 'hi' }] })).toThrow(/no-finding/);
  });
  it('runFixCli hands the finding to the provider and fails (no lane taken) when there is none', async () => {
    const argv = ['--pr=7', '--session=fix-7', '--ref=lane/7-x', '--prompt-file=/p.md', '--repo=o/r', '--claim-repo=we'];
    const spawn = vi.fn(async () => {});
    const calls = [];
    const mkIo = (json) => ({
      run: (c, a) => { calls.push([c, ...a]); return c === 'gh' ? '{}' : 'x'; }, readComments: async () => json.comments,
      readPrompt: () => 'BRIEF', removePrompt: () => {}, resolveProvider: () => ({ spawn }), write: () => {}, writeErr: () => {},
      pendingRearm: { read: () => null, write: () => {}, clear: () => {} }, releaseClaim: async () => ({}), recordOutcome: () => {},
    });
    const out = await runFixCli(argv, mkIo({ title: 'T', body: 'B', comments: [{ body: 'nothing' }] }));
    expect(out.code).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(calls.some((c) => c.join(' ').includes('lane-pool.mjs acquire'))).toBe(false);
  });
});

describe('(1) a borrowed fix that ends releases its claim and records a reason', () => {
  const argv = ['--pr=7', '--session=fix-7', '--ref=lane/7-x', '--prompt-file=/p.md', '--repo=o/r', '--claim-repo=we'];
  const io = (over = {}) => {
    const heads = ['aaa', 'aaa'];
    return {
      readComments: async () => PR.comments,
      run: (c, a) => (c === 'gh' ? JSON.stringify({ title: 'T', body: 'B' }) : a.includes('acquire') ? '/lanes/lane-5\n' : a[0] === 'rev-parse' ? heads.shift() : ''),
      readPrompt: () => 'BRIEF', removePrompt: () => {}, resolveProvider: () => ({ spawn: async () => {} }),
      write: () => {}, writeErr: () => {}, pendingRearm: { read: () => null, write: () => {}, clear: () => {} }, ...over,
    };
  };
  it('no-change: releases the claim for the right repo/PR/session and records the outcome', async () => {
    const releaseClaim = vi.fn(async () => ({ released: [{}] }));
    const recordOutcome = vi.fn();
    expect((await runFixCli(argv, io({ releaseClaim, recordOutcome }))).code).toBe(0);
    expect(releaseClaim).toHaveBeenCalledWith({ repo: 'we', pr: 7, who: 'fix-7' });
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ repo: 'we', pr: '7', outcome: 'no-change', reason: expect.any(String) }));
  });
  it('agent crash: still releases the claim and records "failed" with the error', async () => {
    const releaseClaim = vi.fn(async () => ({}));
    const recordOutcome = vi.fn();
    const out = await runFixCli(argv, io({ releaseClaim, recordOutcome, resolveProvider: () => ({ spawn: async () => { throw new Error('codex exploded'); } }) }));
    expect(out.code).toBe(1);
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: 'codex exploded' }));
  });
  it('a refused executor (no lane taken) also releases', async () => {
    const releaseClaim = vi.fn(async () => ({}));
    await runFixCli([...argv, '--provider=agy-claude'], io({ releaseClaim, recordOutcome: vi.fn() }));
    expect(releaseClaim).toHaveBeenCalledTimes(1);
  });
  it('the launcher is told the claim repo', () => {
    const spawnDetached = vi.fn(() => ({ pid: 9 }));
    fixDetachedProvider({ pr: 7, sessionSlug: 'fix-7', ref: 'r', promptFile: '/p', claimRepo: 'we', policyRoute: { provider: 'codex' } }, { spawnDetached, logPathFor: () => '/l', readDeliveryAgentMarker: () => null });
    expect(parseFixRunArgv(spawnDetached.mock.calls[0][0].slice(1)).claimRepo).toBe('we');
  });
});

describe('claims on disk: release by session, stamp, sweep dead runners', () => {
  const withRoot = (fn) => { const d = mkdtempSync(join(tmpdir(), 'borrow-dies-')); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
  it('releaseSessionFixDispatchClaims frees a borrowed claim held by a (dead) daemon owner', () => withRoot((lockRoot) => {
    acquireFixDispatchClaim({ repo: 'we', pr: 4231, owner: 'Mac:44634', lockRoot, borrowed: { executor: 'codex' } });
    expect(readFixDispatchClaim({ repo: 'we', pr: 4231, lockRoot })).toBeTruthy();
    const r = releaseSessionFixDispatchClaims({ repo: 'we', pr: 4231, who: 'fix-4231', lockRoot });
    expect(r.released).toHaveLength(1);
    expect(readFixDispatchClaim({ repo: 'we', pr: 4231, lockRoot })).toBeNull();
  }));
  it('stamp + sweep: a dead runner pid releases the claim with a reason; a live one is refreshed', () => withRoot((lockRoot) => {
    acquireFixDispatchClaim({ repo: 'we', pr: 1, owner: 'Mac:1', lockRoot, borrowed: { executor: 'codex' } });
    acquireFixDispatchClaim({ repo: 'we', pr: 2, owner: 'Mac:1', lockRoot, borrowed: { executor: 'codex' } });
    expect(stampBorrowedRunnerPid({ repo: 'we', pr: 1, owner: 'Mac:1', pid: 111, lockRoot })).toBe(true);
    expect(stampBorrowedRunnerPid({ repo: 'we', pr: 2, owner: 'Mac:1', pid: 222, lockRoot })).toBe(true);
    expect(stampBorrowedRunnerPid({ repo: 'we', pr: 2, owner: 'someone-else', pid: 5, lockRoot })).toBe(false);
    const out = refreshLiveFixDispatchClaims({ lockRoot, listAgentsAll: () => [], awaitingVerifyFor: null, alive: (p) => p === 222 });
    expect(out.released).toEqual([expect.objectContaining({ pr: 1, reason: expect.stringContaining('borrowed-runner-dead') })]);
    expect(out.refreshed.map((r) => r.pr)).toEqual([2]);
    expect(readFixDispatchClaim({ repo: 'we', pr: 1, lockRoot })).toBeNull();
    expect(readFixDispatchClaim({ repo: 'we', pr: 2, lockRoot })).toBeTruthy();
  }));
});

describe('(2) the fixer cap counts only live sessions', () => {
  const claim = (kind, extra = {}) => ({ meta: { kind, ...extra } });
  it('a borrowed claim whose runner pid is dead does not count; unstamped and live ones do', () => {
    const alive = (p) => p === 2;
    const claims = [claim('fix', { borrowed: { executor: 'codex' }, runnerPid: 1 }), claim('fix', { borrowed: { executor: 'codex' }, runnerPid: 2 }),
      claim('fix', { borrowed: { executor: 'codex' } }), claim('ci-heal'), claim('fixing')];
    expect(isBorrowedRunnerDead(claims[0], alive)).toBe(true);
    expect(countLiveFixSessions(claims, { alive })).toBe(3);
  });
  it('the throttle admits when the only claims at the cap are dead borrows', () => {
    const dead = claim('fix', { borrowed: { executor: 'codex' }, runnerPid: 1 });
    const t = createDispatchThrottle({ listClaims: () => [dead, dead, dead], env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '2' }, sample: () => ({ ok: false }), loadavg: () => 0, cpuCount: () => 8, alive: () => false });
    expect(t.tryAdmit('fix')).toEqual({ admit: true });
  });
  it('dead borrows do not occupy builder slots in the borrow gate', () => {
    const dead = claim('fix', { borrowed: { executor: 'codex' }, runnerPid: 1 });
    const g = createFixBorrowGate({ sample: () => ({ ok: false }),
      env: {}, settings: { enabled: true, afterMinutes: 0, executor: 'codex' }, ledger: { read: () => ({}), write: () => {} },
      outcomes: { read: () => ({}), write: () => {} }, loadavg: () => 0, cpuCount: () => 8, caps: { claude: 1, external: 1 },
      listFixClaims: () => [dead], alive: () => false, launcherAvailable: () => true,
    });
    expect(g.consider({ repo: 'we', pr: 9 })).toMatchObject({ borrow: true });
  });
});

describe('(3) repeated unproductive borrowed launches fall back to the normal fixer queue', () => {
  const mkStore = () => { let v = {}; return { read: () => v, write: (x) => { v = x; } }; };
  const gate = (outcomes, now) => createFixBorrowGate({ sample: () => ({ ok: false }),
    env: {}, settings: { enabled: true, afterMinutes: 0, executor: 'codex' }, ledger: mkStore(), outcomes, now: () => now,
    loadavg: () => 0, cpuCount: () => 8, caps: { claude: 1, external: 4 }, launcherAvailable: () => true,
  });
  it('after 2 failures the gate refuses with a logged reason; a push clears the history; old failures age out', () => {
    const outcomes = mkStore();
    const now = 10_000_000;
    expect(gate(outcomes, now).consider({ repo: 'we', pr: 5 })).toMatchObject({ borrow: true });
    recordBorrowOutcome({ repo: 'we', pr: 5, outcome: 'no-change', reason: 'agent committed nothing', now: now - 1000, store: outcomes });
    expect(gate(outcomes, now).consider({ repo: 'we', pr: 5 })).toMatchObject({ borrow: true });
    recordBorrowOutcome({ repo: 'we', pr: 5, outcome: 'failed', reason: 'boom', now: now - 500, store: outcomes });
    const d = gate(outcomes, now).consider({ repo: 'we', pr: 5 });
    expect(d.borrow).toBe(false);
    expect(d.why).toMatch(/2x for this PR.*last: failed - boom.*normal fixer queue/);
    expect(gate(outcomes, now).consider({ repo: 'we', pr: 6 })).toMatchObject({ borrow: true });
    expect(gate(outcomes, now + 2 * 3_600_000).consider({ repo: 'we', pr: 5 })).toMatchObject({ borrow: true });
    recordBorrowOutcome({ repo: 'we', pr: 5, outcome: 'pushed', store: outcomes });
    expect(recentBorrowFailures(outcomes.read(), { repo: 'we', pr: 5, now })).toEqual([]);
  });
});

describe('dispatchFix stamps the borrowed runner pid on the claim', () => {
  it('passes the claim repo to the launcher and stamps the returned pid', async () => {
    const { dispatchFix } = await import('../../conveyor/reconcile-fix-dispatch.mjs');
    const spawnBorrowed = vi.fn(() => 'pid:4242');
    const stampRunner = vi.fn();
    dispatchFix({ pr: 7, itemNum: '7', lane: 2, laneRef: 'lane/7-x', scope: ['we:a.mjs'], overlapScope: ['we:a.mjs'], headRefOid: 'abc' }, {
      root: '/repo', repo: 'we', borrowed: { executor: 'codex', reason: 'borrowed-build-slot' }, claimOwner: 'Mac:1',
      readFixClaim: () => null, acquireClaim: vi.fn(() => ({ ok: true })), releaseClaim: vi.fn(), postNotice: () => {},
      readBrief: () => 'brief', spawnBorrowed, stampRunner, writeBorrowedPrompt: () => '/tmp/p.md',
      checkoutExists: () => true, readPackageJson: () => ({ scripts: {} }),
    });
    expect(spawnBorrowed).toHaveBeenCalledWith(expect.objectContaining({ claimRepo: 'we' }));
    expect(stampRunner).toHaveBeenCalledWith(expect.objectContaining({ repo: 'we', pr: 7, owner: 'Mac:1', pid: 4242 }));
  });
});
