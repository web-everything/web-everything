/**
 * @file scripts/conveyor/__tests__/health-watch.test.mjs
 * @description #4077 (health daemon slice 1) — the IO shell's own pure-ish probe helpers, exercised over real
 *   temp dirs (node:fs mkdtempSync), plus one end-to-end `tick()` run against a forced lane-starvation fixture.
 *   `tick()` also reads the real GitHub App status file from the home dir — read-only, harmless, left alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  probeDaemonLogs, probeLeases, probeSelfSync, probeLanePools, tick, healthSectionLines, healthDir,
  probeDaemonStatus, daemonNameForLabel, runTickWithWatchdog, probeAuthExpiredSessions, probeAgents,
  probePrs, probeStaleState, probeMergedPrs, probeProcesses, probeMachineLoad, probeGhShimLanes,
  probeBgIsolationStalls, probeUntrackedBacklogCards, persistGhSpend,
} from '../health-watch.mjs';


// Keep the shell, persistence and real detector registry intact; supply deterministic probe results
// at the core boundary and intercept the OS transport so regression runs never ping the operator.
const episodeReplay = vi.hoisted(() => ({ probes: null, send: vi.fn(() => ({ ok: true })) }));
vi.mock('../health-watch-core.mjs', async (original) => {
  const real = await original();
  return { ...real, runHealthTick: (state, probes, ...args) =>
    real.runHealthTick(state, episodeReplay.probes ?? probes, ...args) };
});
vi.mock('../branch-sync.mjs', async (original) => ({
  ...await original(), notifyDesktopChecked: episodeReplay.send,
}));

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-watch-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ── probeDaemonLogs ──────────────────────────────────────────────────────────────────────────────────────────

describe('probeDaemonLogs', () => {
  it('bootstraps on the first read, then reads only the newly appended text incrementally', () => {
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir);
    const logPath = join(logsDir, 'foo-daemon.log');
    writeFileSync(logPath, 'foo-daemon: tick (1) — dispatched 1, refused 0\n');

    const first = probeDaemonLogs(logsDir, {});
    expect(first.samples.length).toBe(1);
    expect(first.samples[0].name).toBe('foo-daemon');
    expect(first.samples[0].bootstrap).toBe(true);
    expect(first.samples[0].text).toContain('tick (1)');

    appendFileSync(logPath, 'foo-daemon: tick (2) — dispatched 1, refused 0\n');
    const second = probeDaemonLogs(logsDir, first.cursors);
    expect(second.samples[0].bootstrap).toBe(false);
    expect(second.samples[0].text).toBe('foo-daemon: tick (2) — dispatched 1, refused 0\n');
    expect(second.samples[0].text).not.toContain('tick (1)');

    // Truncation/rotation (new size smaller than the recorded cursor) forces bootstrap again.
    writeFileSync(logPath, 'foo-daemon: tick (1) — dispatched 1, refused 0\n');
    const third = probeDaemonLogs(logsDir, second.cursors);
    expect(third.samples[0].bootstrap).toBe(true);
  });

  it('returns no samples for a missing logs dir', () => {
    expect(probeDaemonLogs(join(dir, 'nope'), {})).toEqual({ samples: [], cursors: {} });
  });
});

// ── probeLeases ──────────────────────────────────────────────────────────────────────────────────────────────

describe('probeLeases', () => {
  it('maps a reconcile-* owner to its bare log name when that name is registered', () => {
    const lockRoot = join(dir, 'locks');
    mkdirSync(join(lockRoot, 'lane-1'), { recursive: true });
    writeFileSync(join(lockRoot, 'lane-1', 'lock.json'), JSON.stringify({
      owner: 'Mac:123:reconcile-fix-dispatch-daemon', pid: process.pid, heartbeatAt: new Date('2026-09-25T10:00:00Z').toISOString(),
    }));
    const out = probeLeases(lockRoot, new Set(['fix-dispatch-daemon']));
    expect(out.length).toBe(1);
    expect(out[0].log).toBe('fix-dispatch-daemon');
    expect(out[0].role).toBe('reconcile-fix-dispatch-daemon');
    expect(out[0].pidAlive).toBe(true);
    expect(out[0].heartbeatAt).toBe(Date.parse('2026-09-25T10:00:00Z'));
  });

  it('maps a pass-daemon:<name> owner to the bare name', () => {
    const lockRoot = join(dir, 'locks');
    mkdirSync(join(lockRoot, 'lane-2'), { recursive: true });
    writeFileSync(join(lockRoot, 'lane-2', 'lock.json'), JSON.stringify({
      owner: 'Mac:1:pass-daemon:lease-reaper', pid: process.pid, heartbeatAt: new Date().toISOString(),
    }));
    const out = probeLeases(lockRoot, new Set(['lease-reaper']));
    expect(out.length).toBe(1);
    expect(out[0].log).toBe('lease-reaper');
    expect(out[0].role).toBe('pass-daemon:lease-reaper');
  });

  it('returns [] for a missing lock root', () => {
    expect(probeLeases(join(dir, 'nope'), new Set())).toEqual([]);
  });
});

// ── probeSelfSync ────────────────────────────────────────────────────────────────────────────────────────────

describe('probeSelfSync', () => {
  it('parses alerts.jsonl and rebuild.json times to ms', () => {
    const syncDir = join(dir, 'self-sync');
    mkdirSync(syncDir, { recursive: true });
    writeFileSync(join(syncDir, 'clone1.alerts.jsonl'), `${JSON.stringify({ at: '2026-09-25T10:00:00Z', kind: 'smoke-rejected', detail: { failed: 'gh' } })}\n`);
    writeFileSync(join(syncDir, 'clone1.rebuild.json'), JSON.stringify({ adopted: { at: '2026-09-25T10:05:00Z' }, rejected: null, quarantine: null, inProgress: null }));

    const out = probeSelfSync(syncDir);
    expect(out.length).toBe(1);
    expect(out[0].cloneKey).toBe('clone1');
    expect(out[0].alerts[0].kind).toBe('smoke-rejected');
    expect(out[0].alerts[0].at).toBe(Date.parse('2026-09-25T10:00:00Z'));
    expect(out[0].rebuild.adopted.at).toBe(Date.parse('2026-09-25T10:05:00Z'));
  });
});

// ── probeGhShimLanes ─────────────────────────────────────────────────────────────────────────────────────────

describe('probeGhShimLanes', () => {
  function writeShim(path, { throttleCli, realGh }) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, [
      '#!/usr/bin/env node',
      `const REAL_GH = ${JSON.stringify(realGh)};`,
      `const GH_THROTTLE_CLI = ${JSON.stringify(throttleCli)};`,
      '',
    ].join('\n'));
  }

  it('flags the legacy shared shim when its GH_THROTTLE_CLI is baked into a lane clone', () => {
    const root = join(dir, '.claude', 'github-app-token');
    writeShim(join(root, 'gh-shim', 'gh'), {
      realGh: '/opt/homebrew/bin/gh',
      throttleCli: join(dir, 'workspace', '.lanes', 'web-everything', 'lane-22', 'scripts', 'lib', 'gh-throttle.mjs'),
    });
    const out = probeGhShimLanes({ home: dir });
    expect(out).toHaveLength(1);
    expect(out[0].inLane).toBe(true);
    expect(out[0].throttleCli).toContain('lane-22');
  });

  it('scans every per-checkout gh-shim.d/<hash>/gh, not just the legacy shared one', () => {
    const root = join(dir, '.claude', 'github-app-token');
    writeShim(join(root, 'gh-shim.d', 'abc123', 'gh'), {
      realGh: '/opt/homebrew/bin/gh',
      throttleCli: join(dir, 'workspace', 'webeverything', 'scripts', 'lib', 'gh-throttle.mjs'),
    });
    writeShim(join(root, 'gh-shim.d', 'def456', 'gh'), {
      realGh: '/opt/homebrew/bin/gh',
      throttleCli: join(dir, 'workspace', '.lanes', 'web-everything', 'lane-9', 'scripts', 'lib', 'gh-throttle.mjs'),
    });
    const out = probeGhShimLanes({ home: dir });
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.path.includes('abc123')).inLane).toBe(false);
    expect(out.find((s) => s.path.includes('def456')).inLane).toBe(true);
  });

  it('never flags a stable primary-checkout path', () => {
    const root = join(dir, '.claude', 'github-app-token');
    writeShim(join(root, 'gh-shim.d', 'stable', 'gh'), {
      realGh: '/opt/homebrew/bin/gh',
      throttleCli: join(dir, 'workspace', 'webeverything', 'scripts', 'lib', 'gh-throttle.mjs'),
    });
    const out = probeGhShimLanes({ home: dir });
    expect(out).toHaveLength(1);
    expect(out[0].inLane).toBe(false);
  });

  it('returns [] when no shim has ever been written', () => {
    expect(probeGhShimLanes({ home: dir })).toEqual([]);
  });
});

// ── probeUntrackedBacklogCards ───────────────────────────────────────────────────────────────────────────────

describe('probeUntrackedBacklogCards (#4317)', () => {
  const NOW = Date.parse('2026-09-28T12:00:00Z');
  const AGED_MTIME = NOW - 30 * 60_000; // 30 min ago — past the default 15-min agedMs
  const FRESH_MTIME = NOW - 2 * 60_000; // 2 min ago — still inside a normal filing pipeline's own commit window

  it('flags an aged untracked hash-id backlog card in a known clone root', () => {
    const root = join(dir, 'wev-review-daemon');
    const exec = (cmd, args) => {
      expect(args).toEqual(['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', 'backlog']);
      return '?? backlog/x3u9t41-file-the-prevention-guard.md\n';
    };
    const stat = () => ({ mtimeMs: AGED_MTIME });
    const out = probeUntrackedBacklogCards({ roots: [root], exec, stat, now: NOW });
    expect(out).toEqual([{ cloneRoot: root, rel: 'backlog/x3u9t41-file-the-prevention-guard.md', mtimeMs: AGED_MTIME }]);
  });

  it('does NOT flag a card younger than agedMs — a normal filing pipeline is still mid-commit', () => {
    const root = join(dir, 'wev-review-daemon');
    const exec = () => '?? backlog/x3u9t41-file-the-prevention-guard.md\n';
    const stat = () => ({ mtimeMs: FRESH_MTIME });
    expect(probeUntrackedBacklogCards({ roots: [root], exec, stat, now: NOW })).toEqual([]);
  });

  it('ignores a TRACKED or MODIFIED backlog entry — only an untracked (`??`) hash-id card counts', () => {
    const root = join(dir, 'wev-review-daemon');
    const exec = () => ' M backlog/0100-something.md\n?? backlog/not-a-hash-id.md\n';
    const stat = () => ({ mtimeMs: AGED_MTIME });
    expect(probeUntrackedBacklogCards({ roots: [root], exec, stat, now: NOW })).toEqual([]);
  });

  it('skips a clone root that is gone or not a real git checkout, never throwing', () => {
    const exec = () => { throw new Error('fatal: not a git repository'); };
    expect(probeUntrackedBacklogCards({ roots: [join(dir, 'gone')], exec, now: NOW })).toEqual([]);
  });

  it('scans every known clone root independently', () => {
    const rootA = join(dir, 'wev-review-daemon');
    const rootB = join(dir, 'wev-merge-daemon');
    const exec = (cmd, args) => (args[1] === rootA ? '?? backlog/x1111a1-a.md\n' : '?? backlog/x2222b2-b.md\n');
    const stat = () => ({ mtimeMs: AGED_MTIME });
    const out = probeUntrackedBacklogCards({ roots: [rootA, rootB], exec, stat, now: NOW });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.cloneRoot).sort()).toEqual([rootA, rootB].sort());
  });
});

// ── probeLanePools ───────────────────────────────────────────────────────────────────────────────────────────

describe('probeLanePools', () => {
  it('picks the LAST checked/health line even when trailing content after it is truncated', () => {
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const lines = [
      `${JSON.stringify({ checked: true, health: { total: 2, leased: 1, acquirable: 1, dirtyUnleased: 0 } })}`,
      `${JSON.stringify({ checked: true, health: { total: 2, leased: 2, acquirable: 0, dirtyUnleased: 0 } })}`,
      '{"plan":[{"lane":1,"acti', // truncated trailing garbage — must not match or confuse the regex
    ].join('\n');
    writeFileSync(join(logsDir, 'lane-pool-health-watch-we.log'), lines);

    const out = probeLanePools(logsDir);
    expect(out.length).toBe(1);
    expect(out[0].repo).toBe('we');
    expect(out[0].health.acquirable).toBe(0); // the LAST line's value, not the first
    expect(out[0].health.leased).toBe(2);
  });

  it('skips a repo with no lane-pool-health-watch log', () => {
    expect(probeLanePools(join(dir, 'empty'))).toEqual([]);
  });
});

// ── probeAuthExpiredSessions — live incident, night of 2026-09-25/26 ET ─────────────────────────────────────
describe('probeAuthExpiredSessions', () => {
  const bgAgent = (over = {}) => ({ name: 'ci-heal-2711', kind: 'background', cwd: '/x/dispatch/abc', sessionId: 's-1', startedAt: '2026-09-26T10:53:00.000Z', ...over });

  it('flags a background session the injected reader confirms auth-expired, carrying its own startedAt', () => {
    const readInfo = () => ({ authExpired: true, reason: 'claude-auth' });
    const out = probeAuthExpiredSessions([bgAgent()], { readInfo });
    expect(out).toEqual([{ name: 'ci-heal-2711', startedAt: Date.parse('2026-09-26T10:53:00.000Z') }]);
  });

  it('never flags a session the reader clears, or one that throws', () => {
    expect(probeAuthExpiredSessions([bgAgent()], { readInfo: () => ({ authExpired: false, reason: 'no-signal' }) })).toEqual([]);
    expect(probeAuthExpiredSessions([bgAgent()], { readInfo: () => { throw new Error('unreadable'); } })).toEqual([]);
    expect(probeAuthExpiredSessions([bgAgent()], { readInfo: () => null })).toEqual([]);
  });

  it('skips a non-background row (interactive terminal session), or one missing cwd/sessionId, without calling the reader', () => {
    let called = false;
    const readInfo = () => { called = true; return { authExpired: true }; };
    probeAuthExpiredSessions([{ ...bgAgent(), kind: 'interactive' }], { readInfo });
    probeAuthExpiredSessions([{ ...bgAgent(), cwd: undefined }], { readInfo });
    probeAuthExpiredSessions([{ ...bgAgent(), sessionId: undefined }], { readInfo });
    expect(called).toBe(false);
  });

  it('empty/non-array input is never a guess', () => {
    expect(probeAuthExpiredSessions(undefined)).toEqual([]);
    expect(probeAuthExpiredSessions([])).toEqual([]);
  });

  it('probeAgents itself carries cwd/sessionId through — what this probe needs to resolve a transcript', () => {
    const exec = () => JSON.stringify([{ name: 'ci-heal-2711', state: 'blocked', kind: 'background', startedAt: '2026-09-26T10:53:00.000Z', cwd: '/x', sessionId: 's-1' }]);
    expect(probeAgents({ exec })).toEqual([{ name: 'ci-heal-2711', state: 'blocked', kind: 'background', startedAt: '2026-09-26T10:53:00.000Z', cwd: '/x', sessionId: 's-1', status: null, waitingFor: null, pid: null }]);
  });

  it('probeAgents carries an integer pid through (#4068 live-process-stale-transcript), never a non-integer', () => {
    const exec = () => JSON.stringify([{ name: 'a', kind: 'background', pid: 4242 }, { name: 'b', kind: 'background', pid: '17' }]);
    expect(probeAgents({ exec }).map((a) => a.pid)).toEqual([4242, null]);
  });
});

// ── probeBgIsolationStalls — #x9fbg1x, live incident fix-2748/fix-2770, 2026-09-26 ────────────────────────────
describe('probeBgIsolationStalls', () => {
  const stuckAgent = (over = {}) => ({
    name: 'fix-2748', kind: 'background', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt',
    startedAt: '2026-09-26T18:00:00.000Z', cwd: '/x/dispatch/f6b254c8', sessionId: '03bd61b3-…', ...over,
  });

  it('confirms a stuck-on-permission-prompt session the injected reader confirms is the EnterWorktree guard', () => {
    const readInfo = () => ({ stall: true, evidence: 'Call EnterWorktree first…' });
    const out = probeBgIsolationStalls([stuckAgent()], { readInfo });
    expect(out).toEqual([{
      name: 'fix-2748', sessionId: '03bd61b3-…', cwd: '/x/dispatch/f6b254c8',
      startedAt: Date.parse('2026-09-26T18:00:00.000Z'), evidence: 'Call EnterWorktree first…',
    }]);
  });

  it('never flags a session the reader clears, or one that throws', () => {
    expect(probeBgIsolationStalls([stuckAgent()], { readInfo: () => ({ stall: false, reason: 'no-signal' }) })).toEqual([]);
    expect(probeBgIsolationStalls([stuckAgent()], { readInfo: () => { throw new Error('unreadable'); } })).toEqual([]);
    expect(probeBgIsolationStalls([stuckAgent()], { readInfo: () => null })).toEqual([]);
  });

  it('never even calls the reader for a session not already stuck on a permission prompt — cheap by construction', () => {
    let called = false;
    const readInfo = () => { called = true; return { stall: true }; };
    probeBgIsolationStalls([stuckAgent({ state: 'working', status: 'busy', waitingFor: null })], { readInfo });
    probeBgIsolationStalls([stuckAgent({ kind: 'interactive' })], { readInfo });
    expect(called).toBe(false);
  });

  it('empty/non-array input is never a guess', () => {
    expect(probeBgIsolationStalls(undefined)).toEqual([]);
    expect(probeBgIsolationStalls([])).toEqual([]);
  });

  // #xrv69j6 — `status`/`waitingFor` carried through too: the real shape `claude agents --json` reports for a
  // session blocked on Claude Code's own unanswerable permission prompt (live case: `fix-2735`), and the
  // `dispatch-permission-stall` health smell's only input.
  it('probeAgents carries status/waitingFor through — the dispatch-permission-stall smell\'s own input', () => {
    const exec = () => JSON.stringify([{ name: 'fix-2735', state: 'blocked', status: 'waiting', waitingFor: 'permission prompt', kind: 'background', startedAt: '2026-09-26T17:28:00.000Z', cwd: '/x', sessionId: 's-2' }]);
    const [row] = probeAgents({ exec });
    expect(row.status).toBe('waiting');
    expect(row.waitingFor).toBe('permission prompt');
  });
});

// ── probeProcesses / probeMachineLoad — machine-overload's own inputs (#4075 continuation, card xzdgabp) ─────

describe('probeProcesses', () => {
  it('shells `ps -Ao pid,ppid,pcpu,etime,command` and parses it via parsePsOutput', () => {
    const exec = (cmd, args) => {
      expect(cmd).toBe('ps');
      expect(args).toEqual(['-Ao', 'pid,ppid,pcpu,etime,command']);
      return '  PID  PPID %CPU     ELAPSED COMMAND\n    1     0   0.0  01:00:00 /sbin/launchd\n';
    };
    expect(probeProcesses({ exec })).toEqual([{ pid: 1, ppid: 0, pcpu: 0, etime: '01:00:00', command: '/sbin/launchd' }]);
  });
});

describe('probeMachineLoad', () => {
  it('normalizes os.loadavg() + core count into {load1,load5,load15,cpuCount}', () => {
    const out = probeMachineLoad({ getLoadAvg: () => [293, 210, 90], getCpuCount: () => 8 });
    expect(out).toEqual({ load1: 293, load5: 210, load15: 90, cpuCount: 8 });
  });

  it('never reports a zero/negative core count (would divide-by-zero downstream)', () => {
    expect(probeMachineLoad({ getLoadAvg: () => [1, 1, 1], getCpuCount: () => 0 }).cpuCount).toBe(1);
  });
});

// ── tick() end-to-end: the machine-overload incident fixture (#4075 continuation, card xzdgabp) ─────────────
//    Reproduces the LIVE incident (2026-09-26 ~10:34-10:55 ET) via `--ps-fixture`/`--machine-load-fixture` — no
//    load generator is ever run to test this smell.

describe('tick() — machine-overload: normal snapshot never opens, the incident fixture does', () => {
  const psFixture = (dir2, copies) => {
    const path = join(dir2, 'xzdgabp-ps-fixture.txt');
    const lines = ['  PID  PPID %CPU     ELAPSED COMMAND', '    1     0   0.0  05-01:00:00 /sbin/launchd'];
    let pid = 25000;
    for (let i = 0; i < copies; i += 1) {
      const scriptPid = pid++;
      const nodePid = pid++;
      lines.push(`${scriptPid}     1  92.0       00:19:40 /bin/sh /Users/nicolasgilbert/workspace/webeverything/scratchpad/spawn-hog2.sh`);
      lines.push(`${nodePid} ${scriptPid}  98.0       00:00:02 node -e 1`);
    }
    writeFileSync(path, lines.join('\n'));
    return path;
  };
  const loadFixture = (dir2, load1, cpuCount) => {
    const path = join(dir2, 'xzdgabp-load-fixture.json');
    writeFileSync(path, JSON.stringify({ load1, load5: load1, load15: load1, cpuCount }));
    return path;
  };

  it('a normal-load snapshot never opens an episode (2 ticks)', async () => {
    const stateRoot = join(dir, 'state-normal');
    const flags = {
      'state-root': stateRoot, 'logs-dir': join(dir, 'logs-normal'), 'lock-root': join(dir, 'locks-normal'),
      'self-sync-dir': join(dir, 'sync-normal'), 'no-gh': true, 'no-diagnose': true,
      'ps-fixture': psFixture(dir, 0), 'machine-load-fixture': loadFixture(dir, 1.2, 8),
    };
    mkdirSync(flags['logs-dir'], { recursive: true });
    mkdirSync(flags['lock-root'], { recursive: true });
    mkdirSync(flags['self-sync-dir'], { recursive: true });

    const first = await tick(flags);
    const second = await tick(flags);
    expect(first.transitions.find((t) => t.key.startsWith('machine-overload'))).toBeUndefined();
    expect(second.transitions.find((t) => t.key.startsWith('machine-overload'))).toBeUndefined();
    expect(second.section.join('\n')).not.toContain('machine-overload');
  });

  it('opens exactly one machine-overload episode after 2 ticks of the incident fixture, naming the culprit', async () => {
    const stateRoot = join(dir, 'state-incident');
    const flags = {
      'state-root': stateRoot, 'logs-dir': join(dir, 'logs-incident'), 'lock-root': join(dir, 'locks-incident'),
      'self-sync-dir': join(dir, 'sync-incident'), 'no-gh': true, 'no-diagnose': true,
      'ps-fixture': psFixture(dir, 50), 'machine-load-fixture': loadFixture(dir, 293, 8),
    };
    mkdirSync(flags['logs-dir'], { recursive: true });
    mkdirSync(flags['lock-root'], { recursive: true });
    mkdirSync(flags['self-sync-dir'], { recursive: true });

    const first = await tick(flags);
    expect(first.transitions.find((t) => t.type === 'opened' && t.key.startsWith('machine-overload'))).toBeUndefined();

    const second = await tick(flags);
    const opens = second.transitions.filter((t) => t.type === 'opened' && t.key.startsWith('machine-overload'));
    expect(opens.length).toBe(1);
    // Notified even in shadow mode — approved by an earlier operator decision; the Sun 2026-09-27
    // notify-list.mjs addition is additive and never demotes a sign already approved.
    expect(second.plan.find((p) => p.kind === 'notify' && p.key === opens[0].key)?.suppressed).toBeFalsy();

    const episodesDir = join(healthDir(stateRoot), 'episodes');
    const report = readdirSync(episodesDir).find((f) => f.includes('machine-overload') && f.endsWith('.md'));
    expect(report).toBeTruthy();
    const text = readFileSync(join(episodesDir, report), 'utf8');
    expect(text).toContain('50 ×');
    expect(text).toContain('spawn-hog2.sh');
    expect(text).toContain('orphaned, parent launchd');
    expect(text).toContain('stop tree 25000');
  });
});

// ── tick() end-to-end: a forced lane-starvation fixture ─────────────────────────────────────────────────────

describe('tick() — forced lane-starvation fixture', () => {
  it('opens exactly one lane-starvation episode after 2 ticks (openAfter=2) and writes exactly one report', async () => {
    const stateRoot = join(dir, 'state');
    const logsDir = join(dir, 'logs');
    const lockRoot = join(dir, 'locks'); // empty on purpose: no leases → daemon-silent stays inert
    const syncDir = join(dir, 'self-sync'); // empty on purpose: no alerts → clone-stale stays inert
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(lockRoot, { recursive: true });
    mkdirSync(syncDir, { recursive: true });

    writeFileSync(join(logsDir, 'lane-pool-health-watch-we.log'),
      `${JSON.stringify({ checked: true, health: { total: 2, leased: 2, acquirable: 0, dirtyUnleased: 0 } })}\n`);
    const fixLog = join(logsDir, 'fix-dispatch-daemon.log');
    writeFileSync(fixLog, [
      'fix-dispatch-daemon: tick (1) — dispatched 0, refused 3',
      'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2661 — no free lane in the pool',
      'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2662 — no free lane in the pool',
      'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2663 — no free lane in the pool',
      '',
    ].join('\n'));

    const flags = {
      'state-root': stateRoot, 'logs-dir': logsDir, 'lock-root': lockRoot, 'self-sync-dir': syncDir,
      'no-gh': true, 'no-diagnose': true,
    };

    const first = await tick(flags);
    expect(first.transitions.find((t) => t.type === 'opened' && t.key.startsWith('lane-starvation'))).toBeUndefined();

    // A second no-lane tick block, appended — the incremental read of just the new lines.
    appendFileSync(fixLog, [
      'fix-dispatch-daemon: tick (2) — dispatched 0, refused 3',
      'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2664 — no free lane in the pool',
      'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2665 — no free lane in the pool',
      'fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #2666 — no free lane in the pool',
      '',
    ].join('\n'));

    const second = await tick(flags);
    const laneStarvationOpens = second.transitions.filter((t) => t.type === 'opened' && t.key.startsWith('lane-starvation'));
    expect(laneStarvationOpens.length).toBe(1);

    const episodesDir = join(healthDir(stateRoot), 'episodes');
    const reportFiles = readdirSync(episodesDir).filter((f) => f.startsWith('') && f.includes('lane-starvation') && f.endsWith('.md'));
    expect(reportFiles.length).toBe(1);

    const lines = healthSectionLines({ stateRoot });
    expect(lines[0]).toContain('last health tick completed');
  });
});

describe('tick() — an episode that closes in the same tick its investigation findings landed (#4437)', () => {
  it('keeps the findings in the rewritten closed report, exactly once, and does not append them again', async () => {
    const stateRoot = join(dir, 'state');
    const logsDir = join(dir, 'logs');
    const lockRoot = join(dir, 'locks');
    const syncDir = join(dir, 'self-sync');
    for (const d of [logsDir, lockRoot, syncDir]) mkdirSync(d, { recursive: true });
    const poolLog = join(logsDir, 'lane-pool-health-watch-we.log');
    const fixLog = join(logsDir, 'fix-dispatch-daemon.log');
    const noLaneBlock = (n) => [
      `fix-dispatch-daemon: tick (${n}) — dispatched 0, refused 3`,
      ...[1, 2, 3].map((i) => `fix-dispatch-daemon: refused no-lane web-everything/web-everything PR #${2600 + n * 10 + i} — no free lane in the pool`),
      '',
    ].join('\n');
    writeFileSync(poolLog, `${JSON.stringify({ checked: true, health: { total: 2, leased: 2, acquirable: 0, dirtyUnleased: 0 } })}\n`);
    writeFileSync(fixLog, noLaneBlock(1));
    const flags = { 'state-root': stateRoot, 'logs-dir': logsDir, 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true };
    await tick(flags);
    appendFileSync(fixLog, noLaneBlock(2));
    await tick(flags);

    const hdir = healthDir(stateRoot);
    const mdName = readdirSync(join(hdir, 'episodes')).find((f) => f.includes('lane-starvation') && f.endsWith('.md'));
    const episodeId = mdName.replace(/\.md$/, '');
    // A running entry with no handle/session (so no real `claude` is ever invoked) whose findings are already recorded.
    mkdirSync(join(hdir, 'investigations'), { recursive: true });
    writeFileSync(join(hdir, 'investigations', 'ledger.json'), JSON.stringify([{
      episodeId, key: 'lane-starvation::lane-pool:we', smell: 'lane-starvation', subject: 'lane-pool:we',
      session: null, handle: null, startedAt: Date.now(), deadlineAt: Date.now() + 20 * 60_000, status: 'running',
    }]));
    writeFileSync(join(hdir, 'investigations', `${episodeId}.json`), JSON.stringify({
      recordedAt: '2026-09-28T12:00:00.000Z',
      evidence: [{ command: 'stale-state', output: 'ZZ-EVIDENCE-LINE' }],
      recommendation: { whatIsWrong: 'ZZ-WHAT-IS-WRONG', productChange: 'p', nextStep: 'n' },
    }));

    // Healthy again: three clean ticks (closeAfter) — the last one closes the episode and rewrites its report.
    writeFileSync(poolLog, `${JSON.stringify({ checked: true, health: { total: 10, leased: 1, acquirable: 9, dirtyUnleased: 0 } })}\n`);
    appendFileSync(fixLog, 'fix-dispatch-daemon: tick (3) — dispatched 3, refused 0\n');
    let closed = null;
    for (let i = 1; i <= 6 && !closed; i += 1) {
      const t = await tick({ ...flags, now: new Date(Date.now() + i * 2 * 3_600_000).toISOString() });
      closed = t.transitions.find((x) => x.type === 'closed' && x.key.startsWith('lane-starvation')) ?? null;
    }
    expect(closed).not.toBeNull();
    const report = () => readFileSync(join(hdir, 'episodes', mdName), 'utf8');
    expect(report().match(/## Agent investigation/g)).toHaveLength(1);
    expect(report().match(/ZZ-WHAT-IS-WRONG/g)).toHaveLength(1);
    expect(report().match(/ZZ-EVIDENCE-LINE/g)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(hdir, 'investigations', 'ledger.json'), 'utf8'))[0].reportedAt).toBeTruthy();

    await tick({ ...flags, now: new Date(Date.now() + 20 * 3_600_000).toISOString() });
    expect(report().match(/## Agent investigation/g)).toHaveLength(1);
  });
});

// ── probeDaemonStatus (the declared #4067 daemon-status read as the daemon inventory) ───────────────────────

describe('probeDaemonStatus', () => {
  it('maps launchd labels to the log names the smells key on', () => {
    expect(daemonNameForLabel('com.we.fix-dispatch-daemon')).toBe('fix-dispatch-daemon');
    expect(daemonNameForLabel('com.we.conveyor-pass-daemon.merge-orphan-sweep')).toBe('merge-orphan-sweep');
    expect(daemonNameForLabel('com.plateau.drain-daemon')).toBe('plateau-drain-daemon');
  });

  it('turns assessed daemon-status rows into lease rows, with the drain judged on its newest activity', () => {
    const collect = () => ({ observedAt: 'x', daemons: [] });
    const assess = () => ({ daemons: [
      { name: 'com.we.review-daemon', readable: true, running: true, kind: 'review-daemon', state: 'alive',
        lease: { entry: { pid: 42, heartbeatAt: '2026-09-25T15:00:00.000Z' } }, tick: { found: true, logMtimeMs: Date.parse('2026-09-25T15:01:00.000Z') } },
      { name: 'com.plateau.drain-daemon', readable: true, running: true, kind: 'drain-daemon', state: 'alive', lease: { entry: null },
        tick: { found: true, at: '2026-09-25T15:17:31.332Z', lastActivityAt: '2026-09-25T15:37:21.553Z' } },
      { name: 'com.we.broken', readable: false, running: false },
    ] });
    const rows = probeDaemonStatus({ collect, assess });
    expect(rows.map((r) => r.log)).toEqual(['review-daemon', 'plateau-drain-daemon']);
    expect(rows[0]).toMatchObject({ pid: 42, pidAlive: true, heartbeatAt: Date.parse('2026-09-25T15:00:00.000Z') });
    expect(rows[1].lastActivityAt).toBe(Date.parse('2026-09-25T15:37:21.553Z'));
    expect(rows[1].heartbeatAt).toBeNull();
  });

  // 2026-09-27 — root cause of the live `daemon-silent` false-positive FLAPPING on `merge-orphan-sweep` (open
  // 36h+): that pass's log lives in its own dedicated clone (`wev-merge-daemon`, #3383's daemon split), never
  // under this watch's single `defaultLogsDir()`, so `daemon-silent.mjs` always fell back to a synthetic memory
  // that hardcoded a 2-minute interval regardless of the daemon's real (15-minute) cadence. Carrying
  // `DAEMON_MANIFEST`'s own interval on the lease lets that fallback scale its threshold correctly — see
  // `daemon-silent.mjs`'s own use of `lease.intervalMs`.
  it('carries DAEMON_MANIFEST\'s own intervalMs for a pass-daemon watcher (merge-orphan-sweep\'s real 15-minute cadence, not a hardcoded default)', () => {
    const collect = () => ({ observedAt: 'x', daemons: [] });
    const assess = () => ({ daemons: [
      { name: 'com.we.conveyor-pass-daemon.merge-orphan-sweep', readable: true, running: true, kind: 'pass-daemon', state: 'alive',
        lease: { entry: { pid: 967, heartbeatAt: '2026-09-27T07:26:00.000Z' } }, tick: { found: false, logMtimeMs: Date.parse('2026-09-27T07:26:00.000Z') } },
    ] });
    const rows = probeDaemonStatus({ collect, assess });
    expect(rows[0].log).toBe('merge-orphan-sweep');
    expect(rows[0].intervalMs).toBe(15 * 60 * 1000);
  });

  it('is null for a daemon DAEMON_MANIFEST does not cover (every resident, non-pass-daemon daemon)', () => {
    const collect = () => ({ observedAt: 'x', daemons: [] });
    const assess = () => ({ daemons: [
      { name: 'com.we.review-daemon', readable: true, running: true, kind: 'review-daemon', state: 'alive',
        lease: { entry: { pid: 1, heartbeatAt: '2026-09-27T07:26:00.000Z' } }, tick: { found: true, logMtimeMs: Date.parse('2026-09-27T07:26:00.000Z') } },
    ] });
    const rows = probeDaemonStatus({ collect, assess });
    expect(rows[0].intervalMs).toBeNull();
  });
});

// ── stale-claim's probes (x4axhga) ───────────────────────────────────────────────────────────────────────────

describe('probePrs — carries headRefName (stale-claim\'s open-PR exclusion needs it)', () => {
  it('threads headRefName through from the gh read', () => {
    const exec = () => JSON.stringify([{ number: 7, title: 'x', headRefName: 'lane/4169-soak-harness', labels: [], statusCheckRollup: [], updatedAt: 't' }]);
    const out = probePrs({ exec });
    expect(out[0]).toMatchObject({ number: 7, headRefName: 'lane/4169-soak-harness' });
  });
});

describe('probeStaleState', () => {
  it('shells the declared stale-state read and returns its verdict (records/gaps), not the whole run envelope', () => {
    const exec = () => JSON.stringify({ runId: 'x', verdict: { observedAt: 'now', records: [{ kind: 'claim', id: '4169' }], gaps: ['g'] } });
    const out = probeStaleState({ exec });
    expect(out).toEqual({ observedAt: 'now', records: [{ kind: 'claim', id: '4169' }], gaps: ['g'] });
  });
});

describe('probeMergedPrs', () => {
  it('pairs the merged-PR list (one gh call) with the real backlog/ cards read (reused from backlog-stranded-sweep.mjs, never a second scan)', () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push(args); return JSON.stringify([{ number: 2689, title: 'x0zg44l: soak', headRefName: 'lane/x0zg44l-soak', body: '' }]); };
    const out = probeMergedPrs({ exec });
    // The backlog cards are WE's, so the merged-PR list must be WE's too — never whatever repo the cwd resolves to.
    expect(calls[0]).toEqual(expect.arrayContaining(['--repo', 'web-everything/web-everything']));
    expect(out.prs).toEqual([{ number: 2689, title: 'x0zg44l: soak', headRefName: 'lane/x0zg44l-soak', body: '' }]);
    // The real repo's backlog/ dir has hundreds of cards — proves this reads the real reader, not a stub.
    expect(out.cards.length).toBeGreaterThan(50);
    expect(out.cards[0]).toHaveProperty('stem');
    expect(out.cards[0]).toHaveProperty('body');
  });
});

// ── review round 1 (PR #2672) regressions ─────────────────────────────────────────────────────────────────────

describe('persisted state is scrubbed', () => {
  it('a credential in a refusal line never reaches state.json', async () => {
    const tok = `ghp_${'Q'.repeat(36)}`;
    const logsDir = join(dir, 'logs'); mkdirSync(logsDir);
    const lockRoot = join(dir, 'locks'); mkdirSync(lockRoot);
    const syncDir = join(dir, 'sync'); mkdirSync(syncDir);
    const stateRoot = join(dir, 'state');
    writeFileSync(join(logsDir, 'fix-dispatch-daemon.log'), [
      'reconcile-fix-dispatch-daemon: tick (a) — dispatched 0, refused 1',
      `reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #9 — auth header token ${tok} rejected`,
      '',
    ].join('\n'));
    const flags = { 'state-root': stateRoot, 'logs-dir': logsDir, 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true };
    await tick(flags);
    const { readFileSync } = await import('node:fs');
    const stateText = readFileSync(join(healthDir(stateRoot), 'state.json'), 'utf8');
    expect(stateText).toContain('web-everything/web-everything#9');
    expect(stateText).not.toContain(tok);
  });
});

// #4079 review round 1, finding 10 — the tick's own filing-request wiring (`--no-file`, `--dry-run` never
// writing the ledger, a filing-pass failure landing in `probeErrors.file` rather than failing the tick) had
// no direct test; only the pure `planFileRequests`/`landPending` pieces did.
describe('tick() — #4079 filing-request dispatch plumbing', () => {
  const seedEpisode = (hd) => {
    mkdirSync(hd, { recursive: true });
    writeFileSync(join(hd, 'state.json'), JSON.stringify({
      episodes: {
        'my-smell::we': {
          key: 'my-smell::we', smell: 'my-smell', subject: 'we', status: 'open', id: '2026-09-01-x-we-0000',
          investigation: { recommendation: { productChange: 'add a retry' } },
        },
      },
    }));
  };
  const flagsFor = (stateRoot, n) => ({
    'state-root': stateRoot,
    'logs-dir': join(dir, `logs-file-${n}`),
    'lock-root': join(dir, `locks-file-${n}`),
    'self-sync-dir': join(dir, `sync-file-${n}`),
    'no-gh': true, 'no-diagnose': true, 'no-investigate': true,
  });
  const mkFlagDirs = (flags) => {
    mkdirSync(flags['logs-dir'], { recursive: true });
    mkdirSync(flags['lock-root'], { recursive: true });
    mkdirSync(flags['self-sync-dir'], { recursive: true });
  };

  it('plans and ledgers a filing request when config `fileDispatch` is on', async () => {
    const stateRoot = join(dir, 'state-file-1');
    const hd = healthDir(stateRoot);
    seedEpisode(hd);
    writeFileSync(join(hd, 'config.json'), JSON.stringify({ fileDispatch: true }));
    const flags = flagsFor(stateRoot, 1);
    mkFlagDirs(flags);
    await tick(flags);
    const ledger = JSON.parse(readFileSync(join(hd, 'filing', 'ledger.json'), 'utf8'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].key).toBe('my-smell::we');
    expect(ledger[0].status).toBe('pending');
  });

  it('--no-file skips the filing pass entirely — no ledger file is ever created', async () => {
    const stateRoot = join(dir, 'state-file-2');
    const hd = healthDir(stateRoot);
    seedEpisode(hd);
    writeFileSync(join(hd, 'config.json'), JSON.stringify({ fileDispatch: true }));
    const flags = { ...flagsFor(stateRoot, 2), 'no-file': true };
    mkFlagDirs(flags);
    await tick(flags);
    expect(existsSync(join(hd, 'filing', 'ledger.json'))).toBe(false);
  });

  it('--dry-run computes the plan but never writes the ledger', async () => {
    const stateRoot = join(dir, 'state-file-3');
    const hd = healthDir(stateRoot);
    seedEpisode(hd);
    writeFileSync(join(hd, 'config.json'), JSON.stringify({ fileDispatch: true }));
    const flags = { ...flagsFor(stateRoot, 3), 'dry-run': true };
    mkFlagDirs(flags);
    await tick(flags);
    expect(existsSync(join(hd, 'filing', 'ledger.json'))).toBe(false);
  });

  it('a broken filing pass (corrupt ledger) lands in probeErrors.file — never a failed tick', async () => {
    const stateRoot = join(dir, 'state-file-4');
    const hd = healthDir(stateRoot);
    seedEpisode(hd);
    writeFileSync(join(hd, 'config.json'), JSON.stringify({ fileDispatch: true }));
    mkdirSync(join(hd, 'filing'), { recursive: true });
    writeFileSync(join(hd, 'filing', 'ledger.json'), '{ not json');
    const flags = flagsFor(stateRoot, 4);
    mkFlagDirs(flags);
    const summary = await tick(flags);
    expect(summary.probeErrors.file).toMatch(/corrupt/);
  });
});

describe('runTickWithWatchdog', () => {
  it('kills a tick that outlives its budget from OUTSIDE the tick process and records overrun.json', async () => {
    const stateRoot = join(dir, 'state');
    const hd = healthDir(stateRoot);
    mkdirSync(hd, { recursive: true });
    const hang = join(dir, 'hang.mjs');
    writeFileSync(hang, 'const end = Date.now() + 10_000; while (Date.now() < end) { /* a synchronous hang */ }\n');
    const code = await runTickWithWatchdog([], { dir: hd, killAfterMs: 300, script: hang });
    expect(code).toBe(3);
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(join(hd, 'overrun.json'), 'utf8')).killedAfterMs).toBe(300);
  }, 15_000);
});

// ── review round 2 (PR #2672) regressions ─────────────────────────────────────────────────────────────────────

describe('round 2: tick output, silences, partial lines', () => {
  const setup = () => {
    const logsDir = join(dir, 'logs'); mkdirSync(logsDir, { recursive: true });
    const lockRoot = join(dir, 'locks'); mkdirSync(lockRoot, { recursive: true });
    const syncDir = join(dir, 'sync'); mkdirSync(syncDir, { recursive: true });
    const stateRoot = join(dir, 'state');
    return { logsDir, stateRoot, flags: { 'state-root': stateRoot, 'logs-dir': logsDir, 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true } };
  };

  it("tick()'s own return value (printed section, --json summary) never carries a raw credential", async () => {
    const { logsDir, flags } = setup();
    const tok = `ghp_${'Z'.repeat(36)}`;
    // Bootstrap-read ticks are spread back at the interval, so 16 unproductive ticks span 30 min: the episode
    // opens on the first tick and its summary/recommendation carry the refusal text.
    const block = `reconcile-fix-dispatch-daemon: tick (a) — dispatched 0, refused 1\nreconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #9 — auth header token ${tok} rejected\n`;
    writeFileSync(join(logsDir, 'fix-dispatch-daemon.log'), `reconcile-fix-dispatch-daemon: started on Mac:1, tick every 120000ms.\n${block.repeat(16)}`);
    const summary = await tick(flags);
    expect(summary.transitions.some((t) => t.key === 'daemon-owed-no-dispatch::fix-dispatch-daemon')).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(tok);
  });

  it('a silence set while a tick runs survives the tick (silences.json is never written by the tick)', async () => {
    const { flags, stateRoot } = setup();
    const hd = healthDir(stateRoot);
    mkdirSync(hd, { recursive: true });
    const silence = [{ smell: 'clone-stale', subject: null, card: '4078', expiresAt: Date.now() + 3_600_000 }];
    writeFileSync(join(hd, 'silences.json'), JSON.stringify(silence));
    await tick(flags);
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(join(hd, 'silences.json'), 'utf8'))).toEqual(silence);
    expect(JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')).silences).toBeUndefined();
  });

  it('a refusal line split across two reads (no trailing newline yet) is parsed whole on the next read', () => {
    const logsDir = join(dir, 'logs'); mkdirSync(logsDir);
    const f = join(logsDir, 'fix-dispatch-daemon.log');
    writeFileSync(f, 'reconcile-fix-dispatch-daemon: started on Mac:1, tick every 120000ms.\n');
    const a = probeDaemonLogs(logsDir, {});
    appendFileSync(f, 'reconcile-fix-dispatch-daemon: tick (a) — dispatched 0, refused 1\nreconcile-fix-dispatch-daemon: refused no-lane frontier-ui/fronti');
    const b = probeDaemonLogs(logsDir, a.cursors);
    expect(b.samples[0].text).not.toContain('frontier-ui/fronti');
    appendFileSync(f, 'erui PR #7 — no free lane\n');
    const c = probeDaemonLogs(logsDir, b.cursors);
    expect(c.samples[0].text).toBe('reconcile-fix-dispatch-daemon: refused no-lane frontier-ui/frontierui PR #7 — no free lane\n');
  });
});

// ── review round 3 (PR #2672) regressions ─────────────────────────────────────────────────────────────────────

describe('round 3: probe-error scrub and active-card silences', () => {
  const base = () => {
    const lockRoot = join(dir, 'locks'); mkdirSync(lockRoot, { recursive: true });
    const syncDir = join(dir, 'sync'); mkdirSync(syncDir, { recursive: true });
    return { 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true };
  };

  it('a credential in a probe error never reaches state.json, last-tick.json or the returned summary', async () => {
    const tok = `ghp_${'P'.repeat(36)}`;
    const badLogs = join(dir, `logs-${tok}`);
    writeFileSync(badLogs, 'not a directory'); // readdirSync throws ENOTDIR, its message naming this path
    const stateRoot = join(dir, 'state');
    const summary = await tick({ ...base(), 'state-root': stateRoot, 'logs-dir': badLogs });
    expect(Object.keys(summary.probeErrors)).toContain('daemonLogs');
    const { readFileSync } = await import('node:fs');
    const hd = healthDir(stateRoot);
    for (const text of [JSON.stringify(summary), readFileSync(join(hd, 'state.json'), 'utf8'), readFileSync(join(hd, 'last-tick.json'), 'utf8')]) {
      expect(text).not.toContain(tok);
    }
  });

  const runWithSilence = async (status) => {
    const stateRoot = join(dir, `state-${status}`);
    const hd = healthDir(stateRoot);
    mkdirSync(hd, { recursive: true });
    const logsDir = join(dir, `logs-${status}`); mkdirSync(logsDir, { recursive: true });
    const backlogDir = join(dir, `backlog-${status}`); mkdirSync(backlogDir, { recursive: true });
    writeFileSync(join(backlogDir, '9001-some-card.md'), `---\nkind: story\nstatus: ${status}\n---\n# card\n`);
    writeFileSync(join(hd, 'overrun.json'), JSON.stringify({ at: new Date().toISOString(), killedAfterMs: 180000 }));
    writeFileSync(join(hd, 'silences.json'), JSON.stringify([{ smell: 'health-tick-overrun', subject: null, card: '9001', expiresAt: Date.now() - 1000 }]));
    const summary = await tick({ ...base(), 'state-root': stateRoot, 'logs-dir': logsDir, 'backlog-dir': backlogDir });
    const { readFileSync } = await import('node:fs');
    return { summary, state: JSON.parse(readFileSync(join(hd, 'state.json'), 'utf8')) };
  };

  it('an expired silence whose tracking card is still active keeps the episode tracked', async () => {
    const { summary, state } = await runWithSilence('active');
    expect(summary.transitions.map((t) => t.type)).toContain('opened');
    expect(summary.transitions.map((t) => t.type)).not.toContain('silence-expired');
    expect(state.episodes['health-tick-overrun::health-watch'].tracked).toMatchObject({ card: '9001' });
  });

  it('once the tracking card is no longer active, the expired silence re-raises the episode', async () => {
    const { summary, state } = await runWithSilence('resolved');
    expect(summary.transitions.map((t) => t.type)).toContain('silence-expired');
    expect(state.episodes['health-tick-overrun::health-watch'].tracked).toBeNull();
  });
});

// ── review-seat-cap-near-limit (card xn2wf9t) — the per-provider daily-cap warning, record-only by design ──────

describe('tick() — review-seat-cap-near-limit: reads the scorecard store, opens record-only (never notifies)', () => {
  const base = () => {
    const lockRoot = join(dir, 'locks-seatcap'); mkdirSync(lockRoot, { recursive: true });
    const syncDir = join(dir, 'sync-seatcap'); mkdirSync(syncDir, { recursive: true });
    return { 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true };
  };
  const scorecardFixture = (rows) => {
    const path = join(dir, `xn2wf9t-store-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
    return path;
  };
  const seatRow = (provider, callId, scoredAt = new Date().toISOString()) => ({ dispatchKind: 'review-seat', provider, callId, scoredAt });

  it('a quiet day (well under every cap) never opens the episode', async () => {
    const stateRoot = join(dir, 'state-seatcap-quiet');
    const flags = { ...base(), 'state-root': stateRoot, 'logs-dir': join(dir, 'logs-seatcap-quiet'), 'scorecard-store-fixture': scorecardFixture([seatRow('codex', 'c1')]) };
    mkdirSync(flags['logs-dir'], { recursive: true });
    const summary = await tick(flags);
    expect(summary.transitions.find((t) => t.key.startsWith('review-seat-cap-near-limit'))).toBeUndefined();
  });

  it('a provider near its own cap opens ONE episode, names it, and stays suppressed (shadow, never notify)', async () => {
    const stateRoot = join(dir, 'state-seatcap-hot');
    // 65/80 (the default codex cap) = 81.25% — over the 80% warn line.
    const codexRows = Array.from({ length: 65 }, (_, i) => seatRow('codex', `c${i}`));
    const flags = {
      ...base(), 'state-root': stateRoot, 'logs-dir': join(dir, 'logs-seatcap-hot'),
      'scorecard-store-fixture': scorecardFixture(codexRows),
    };
    mkdirSync(flags['logs-dir'], { recursive: true });
    const summary = await tick(flags);
    const opens = summary.transitions.filter((t) => t.type === 'opened' && t.key.startsWith('review-seat-cap-near-limit::review-seat-cap:codex'));
    expect(opens).toHaveLength(1);
    // `severity: 'low'` structurally never produces a `notify` plan entry at all (`planActions` only ever
    // pushes one for `severity === 'high'`) — only the (itself-suppressed) `investigate` entry.
    expect(summary.plan.some((p) => p.kind === 'notify' && p.key === opens[0].key)).toBe(false);
    const investigate = summary.plan.find((p) => p.kind === 'investigate' && p.key === opens[0].key);
    expect(investigate.suppressed).toMatch(/shadow mode/);
    expect(summary.section.join('\n')).toMatch(/codex.*8[1-9]%|codex.*65\/80/);
  });
});

// ── #4309 — hourly GitHub-spend persistence, wired into the tick alongside the unchanged probeGhCalls ──────────
describe('tick() — gh spend persistence (#4309)', () => {
  const H = (iso) => Date.parse(iso);
  const W1 = H('2026-09-28T12:20:00Z') / 1000; // one GitHub window spanning 11:20 → 12:20
  const W2 = H('2026-09-28T13:15:00Z') / 1000; // the next one, first seen 12:15
  const shim = (iso, used, reset) => ({ ts: iso, op: 'pr view', outcome: 'call', ok: true, caller: 'session:abcd1234', resource: 'graphql', id: 'app', inv: `${iso}-${used}`, rl: [{ used, rem: 5000 - used, limit: 5000, reset, res: 'graphql' }] });
  const flagsFor = (logPath, now) => {
    const lockRoot = join(dir, 'locks-spend'); mkdirSync(lockRoot, { recursive: true });
    const syncDir = join(dir, 'sync-spend'); mkdirSync(syncDir, { recursive: true });
    return {
      'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true, 'state-root': join(dir, 'state-spend'),
      'logs-dir': join(dir, 'logs-spend'), 'gh-calls-log': logPath, now,
    };
  };

  it('persists closed hours: zero-observation hours as UNKNOWN, the baseline carried across the persistence boundary and a fresh window', async () => {
    const ghDir = join(dir, 'gh'); mkdirSync(ghDir, { recursive: true });
    const logPath = join(ghDir, 'calls.jsonl');
    const lines = [
      { ts: '2026-09-28T10:05:00.000Z', op: 'pr list', outcome: 'call', ok: true, caller: 'review-daemon.mjs' }, // pre-#4309: no rl
      { ts: '2026-09-28T10:06:00.000Z', op: 'pr list', outcome: 'call', ok: true, caller: 'review-daemon.mjs', resource: 'graphql', id: 'app', inv: 'd1' },
      shim('2026-09-28T11:50:00.000Z', 100, W1), // the window's first observation: a baseline, not "100 points"
    ];
    writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const first = await tick(flagsFor(logPath, '2026-09-28T12:30:00.000Z'));
    expect(first.probeErrors.ghCalls).toBeUndefined(); // probeGhCalls still ran, unchanged
    expect(first.probeErrors.ghSpend).toBeUndefined();
    expect(first.ghSpend.rowsWritten).toBe(3); // 10:00 (two identities) + 11:00

    // 12:10 closes a 4-point gap against the 11:50 baseline persisted in the cursor; 12:15 opens a NEW window.
    appendFileSync(logPath, [shim('2026-09-28T12:10:00.000Z', 104, W1), shim('2026-09-28T12:15:00.000Z', 7, W2)].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const second = await tick(flagsFor(logPath, '2026-09-28T13:05:00.000Z'));
    expect(second.ghSpend.rowsWritten).toBe(1);
    const again = await tick(flagsFor(logPath, '2026-09-28T13:06:00.000Z'));
    expect(again.ghSpend.rowsWritten).toBe(0); // idempotent

    const rows = readFileSync(join(ghDir, 'spend-hourly.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const byHour = (h) => rows.filter((r) => r.hour === h);
    for (const r of byHour('2026-09-28T10:00:00.000Z')) {
      expect(r.unknown).toBe(true);
      expect([r.bucketUsed, r.attributed, r.estimated, r.unattributed]).toEqual([null, null, null, null]);
      expect(r.unknownRequests).toBe(1);
    }
    expect(byHour('2026-09-28T11:00:00.000Z')[0]).toMatchObject({ unknown: true, attributed: null, requests: 1 });
    const noon = byHour('2026-09-28T12:00:00.000Z')[0];
    expect(noon).toMatchObject({ unknown: false, bucketUsed: 4, attributed: 0, estimated: 0, unattributed: 4, requests: 2, responses: 2, unknownRequests: 2 });
    expect(noon.byCaller['session:abcd1234'].attributed).toBe(0); // legacy counters never assert a caller cost
  }, 30_000); // three real ticks, each spawning probe subprocesses — explicit budget for a loaded full-suite run

  it('persistGhSpend defaults to the throttle\'s own call log and delegates to gh-spend.mjs', () => {
    const seen = [];
    persistGhSpend({ now: 1, persist: (o) => { seen.push(o); return { rowsWritten: 0 }; } });
    expect(seen[0].logPath).toMatch(/calls\.jsonl$/);
    expect(seen[0].now).toBe(1);
  });

  it('a fixture tick (--lock-root, no --gh-calls-log) never writes spend files into the real throttle dir (PR #2851 review)', async () => {
    // Stand-in for the operator's real ~/workspace/.lanes/gh-throttle: the default path tick() would resolve.
    const realThrottle = join(dir, 'real-gh-throttle'); mkdirSync(realThrottle, { recursive: true });
    writeFileSync(join(realThrottle, 'calls.jsonl'), JSON.stringify({ ts: '2020-01-01T10:05:00.000Z', op: 'pr list', outcome: 'call', ok: true, caller: 'x' }) + '\n');
    const prev = process.env.WE_GH_THROTTLE_LOCK_ROOT;
    process.env.WE_GH_THROTTLE_LOCK_ROOT = realThrottle;
    try {
      const lockRoot = join(dir, 'locks-fixture'); mkdirSync(lockRoot, { recursive: true });
      const syncDir = join(dir, 'sync-fixture'); mkdirSync(syncDir, { recursive: true });
      const summary = await tick({ 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'no-gh': true, 'no-diagnose': true, 'state-root': join(dir, 'state-fixture'), 'logs-dir': join(dir, 'logs-fixture') });
      expect(readdirSync(realThrottle).sort()).toEqual(['calls.jsonl']);
      expect(summary.ghSpend).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.WE_GH_THROTTLE_LOCK_ROOT; else process.env.WE_GH_THROTTLE_LOCK_ROOT = prev;
    }
  });
});


// #4378 — actual state/report boundary, no live credential access.
describe('credential inventory tick integration', () => {
  it('opens both findings, preserves unknowns, closes after two clean samples, and stores metadata only', async () => {
    const fixture = join(dir, 'inventory.json');
    const stateRoot = join(dir, 'inventory-state');
    const lockRoot = join(dir, 'inventory-locks'); mkdirSync(lockRoot);
    const syncDir = join(dir, 'inventory-sync'); mkdirSync(syncDir);
    const flags = { 'state-root': stateRoot, 'lock-root': lockRoot, 'self-sync-dir': syncDir, 'logs-dir': join(dir, 'inventory-logs'), 'no-gh': true, 'no-diagnose': true, 'credential-inventory-fixture': fixture, now: '2026-10-01T12:00:00Z' };
    const sample = { checkedAt: flags.now, repositories: [{ repo: 'a/b', secrets: { complete: true }, ci: { complete: true } }], secrets: [{ repo: 'a/b', name: 'FUI_READ_TOKEN', updated_at: '2026-01-01T00:00:00Z', value: 'SECRET_CANARY' }], ciFindings: [{ repo: 'a/b', runId: 42, attempt: 1, workflow: 'CI', observedAt: flags.now, badCredentials: true, logs: 'SECRET_CANARY' }] };
    const collectInventory = () => { throw Error('live collection forbidden'); };
    const run = async () => { writeFileSync(fixture, JSON.stringify(sample)); return tick(flags, { collectInventory }); };
    const first = await run();
    expect(first.transitions.filter((t) => t.key.startsWith('credential-inventory-stale::') && t.type === 'opened')).toHaveLength(2);
    expect(first.section.join('\n')).toContain('FUI_READ_TOKEN');
    let stored = readFileSync(join(healthDir(stateRoot), 'state.json'), 'utf8');
    expect(stored).not.toContain('SECRET_CANARY'); expect(JSON.parse(stored).credentialInventoryCache).toHaveLength(1);
    sample.repositories[0].secrets = { complete: false, errors: ['denied'] }; sample.repositories[0].ci = { complete: false, errors: ['unavailable'] }; sample.secrets = []; sample.ciFindings = [];
    const partial = await run(); expect(partial.probeErrors.credentialInventory).toContain('denied');
    expect(partial.transitions.filter((t) => t.type === 'closed' && t.key.startsWith('credential-inventory-stale::'))).toHaveLength(0);
    sample.repositories[0].secrets.complete = true; sample.repositories[0].ci.complete = true;
    expect((await run()).transitions.filter((t) => t.type === 'closed' && t.key.startsWith('credential-inventory-stale::'))).toHaveLength(0);
    expect((await run()).transitions.filter((t) => t.type === 'closed' && t.key.startsWith('credential-inventory-stale::'))).toHaveLength(2);
    delete flags['credential-inventory-fixture'];
    expect((await tick(flags, { collectInventory })).probeErrors.credentialInventory).toBeUndefined();
  }, 30000);
});

describe('credential inventory cadence', () => {
  it('samples when independently due despite another probe error, skips non-due/no-gh and fixture collection', async () => {
    const stateRoot = join(dir, 'cadence-state'); const hd = healthDir(stateRoot); mkdirSync(hd, { recursive: true });
    const lockRoot = join(dir, 'cadence-locks'); mkdirSync(lockRoot);
    const empty = join(dir, 'empty.json'); writeFileSync(empty, '{}');
    const flags = { 'state-root': stateRoot, 'lock-root': lockRoot, 'logs-dir': join(dir, 'logs'), 'self-sync-dir': join(dir, 'sync'), 'no-diagnose': true, 'graphql-budget-fixture': join(dir, 'absent.json'), 'rest-budget-fixture': empty, now: '2026-10-01T12:00:00Z' };
    // Other GitHub probes have already sampled; inventory is independently due.
    writeFileSync(join(hd, 'state.json'), JSON.stringify({ ghCache: { at: Date.parse(flags.now) } }));
    let calls = 0;
    const collectInventory = () => { calls++; return { repositories: [{ repo: 'a/b', secrets: { complete: true }, ci: { complete: true } }] }; };
    const first = await tick(flags, { collectInventory }); expect(calls).toBe(1); expect(first.probeErrors.graphqlBudget).toBeTruthy();
    await tick(flags, { collectInventory }); expect(calls).toBe(1);
    await tick({ ...flags, 'force-gh': true, 'no-gh': true }, { collectInventory }); expect(calls).toBe(1);
    await tick({ ...flags, 'credential-inventory-fixture': empty }, { collectInventory }); expect(calls).toBe(1);
  }, 30000);
});


describe('xyx5mea isolated shell replay', () => {
  const hour = 3_600_000;
  const cases = [
    ['draft-not-promoted', 3336, 1790882705935],
    ['red-pr-unattended', 3373, 1790894455629],
    ['repeated-pr-attempts', 3336, 1790882705935],
  ];
  afterEach(() => { episodeReplay.probes = null; episodeReplay.send.mockClear(); });

  it.each(cases)('%s replays captured timing, delivery and restart dedupe', async (smell, number, start) => {
    const flags = { 'state-root': join(dir, 'state'), 'logs-dir': join(dir, 'logs'),
      'lock-root': join(dir, 'locks'), 'self-sync-dir': join(dir, 'sync'),
      'no-gh': true, 'no-diagnose': true };
    for (const name of ['logs-dir', 'lock-root', 'self-sync-dir']) mkdirSync(flags[name], { recursive: true });
    const statePath = join(healthDir(flags['state-root']), 'state.json');
    const key = `${smell}::web-everything/web-everything#${number}`;
    function input(now) {
      return {
        prs: smell === 'repeated-pr-attempts' ? [] : [{
          repo: 'web-everything/web-everything', number, isDraft: smell === 'draft-not-promoted',
          statusCheckRollup: [{ name: 'test', status: 'COMPLETED',
            conclusion: smell === 'draft-not-promoted' ? 'SUCCESS' : 'FAILURE',
            completedAt: new Date(start - hour).toISOString() }],
        }],
        agents: [], daemonLogs: [],
        operationRuns: smell !== 'repeated-pr-attempts' ? [] : Array.from({ length: 5 }, (_, i) => ({
          id: `run-${i}`, op: 'open-pr', input: { repo: 'web-everything/web-everything', pr: number },
          effects: [{ key: 'submit', status: 'failed', lastAttemptAt: new Date(now).toISOString(), error: 'submit failed' }],
        })),
      };
    }
    async function at(now, extra = {}) {
      episodeReplay.probes = input(now);
      return tick({ ...flags, now: new Date(now).toISOString(), ...extra });
    }
    episodeReplay.send.mockClear();
    for (const now of [start, start + hour - 1]) {
      const r = await at(now);
      expect(r.plan.filter(p => p.kind === 'notify')).toEqual([]);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).episodes[key].severity).toBe('medium');
    }
    expect(episodeReplay.send).not.toHaveBeenCalled();
    const before = readFileSync(statePath, 'utf8');
    const dry = await at(start + hour, { 'dry-run': true });
    expect(dry.plan.filter(p => p.kind === 'notify')).toEqual([
      { kind: 'notify', key, reason: 'escalated', suppressed: null },
    ]);
    expect(dry.notifications).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    const quiet = await at(start + hour, { 'no-notify': true });
    expect(quiet.notifications).toEqual([]);
    expect(episodeReplay.send).not.toHaveBeenCalled();
    // Restore the below-threshold snapshot to exercise a normal send of this same transition.
    writeFileSync(statePath, before);
    const high = await at(start + hour);
    expect(high.transitions).toContainEqual({ type: 'escalated', key });
    expect(high.notifications).toEqual([{ key, ok: true, error: null }]);
    expect(episodeReplay.send).toHaveBeenCalledTimes(1);
    const episode = JSON.parse(readFileSync(statePath, 'utf8')).episodes[key];
    expect(episode).toMatchObject({ severity: 'high', escalatedAt: start + hour, firstBreachAt: start });
    const report = readFileSync(join(healthDir(flags['state-root']), 'episodes', `${episode.id}.md`), 'utf8');
    expect(report).toContain('high');
    expect(report).toContain('escalated');
    const restart = await at(start + hour + 1);
    expect(restart.notifications).toEqual([]);
    expect(restart.transitions.filter(t => t.type === 'escalated')).toEqual([]);
    expect(episodeReplay.send).toHaveBeenCalledTimes(1);
  });
});

it('xe8y12n probe preserves fresh raw evidence independently of cached/normalised labels', () => {
  const commits = [{ authors: [{ name: 'Claude' }] }];
  const exec = (_bin, args) => JSON.stringify(args[1] === 'list'
    ? [{ number: 3239, labels: null }]
    : { state: 'OPEN', labels: [], headRefOid: 'a'.repeat(40) });
  const rows = probePrs({ exec, readCommits: () => commits, now: 123 });
  expect(rows[0]).toMatchObject({ labelsValid: false, reviewObservation: { state: 'OPEN', labels: [], commits, observedAt: 123 } });
  const failed = probePrs({ exec: (_bin, args) => { if (args[1] === 'view') throw new Error('unavailable'); return JSON.stringify([{ number: 3239, labels: [] }]); }, readCommits: () => commits });
  expect(failed[0].reviewObservation).toBeNull();
});

it('xe8y12n probe re-observes only PRs whose cached labels could hide a missing review label', async () => {
  const views = [];
  const commitReads = [];
  const listed = [
    { number: 1, labels: [{ name: 'review:pending' }] },
    { number: 2, labels: [{ name: 'review:human' }, { name: 'bug' }] },
    { number: 3, labels: [{ name: 'checking' }] },
    { number: 4, labels: [] },
    { number: 5, labels: null },
    { number: 6, labels: [{ name: 'review:accepted' }], isDraft: true },
  ];
  const exec = (_bin, args) => {
    if (args[1] === 'list') return JSON.stringify(listed);
    views.push(Number(args[2]));
    return JSON.stringify({ state: 'OPEN', labels: [], headRefOid: 'a'.repeat(40) });
  };
  const rows = probePrs({ exec, now: 5, readCommits: (_slug, number) => { commitReads.push(number); return []; } });
  const byNumber = new Map(rows.map(row => [row.number, row]));
  // Each constellation repo lists the same fixture, so only count what happens for one repo's rows.
  const perRepo = new Set(views);
  expect([...perRepo].sort()).toEqual([3, 4, 5]);
  expect(views.length).toBe(perRepo.size * (rows.length / listed.length));
  expect(new Set(commitReads)).toEqual(perRepo);
  // A labelled PR costs no call but still reports a clean cached observation, so an open episode can close.
  for (const number of [1, 2, 6]) expect(byNumber.get(number).reviewObservation).toMatchObject({ state: 'OPEN', cached: true, commits: [] });
  const { default: smell } = await import('../health-smells/review-label-missing.mjs');
  const closeResults = smell.evaluate({ prs: [...byNumber.values()].filter(row => [1, 2, 6].includes(row.number)) }, { now: 10, lastTick: { completedAt: 0 } });
  expect(closeResults).toHaveLength(3);
  for (const result of closeResults) expect(result.breach).toBe(false);
  for (const number of [3, 4, 5]) expect(byNumber.get(number).reviewObservation).toMatchObject({ state: 'OPEN' });
});
