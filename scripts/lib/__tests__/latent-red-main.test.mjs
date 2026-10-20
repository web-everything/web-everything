// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLatentRedMain, listMergeGroupCiRuns, runLatentRedMainCheck, workflowMatcher, validLedger } from '../latent-red-main.mjs';

const T = 'scripts/lib/__tests__/ledger-readiness-drain-facts.test.mjs > replay reports before, after';
const TIP = 'f'.repeat(40);
const run = (id, conclusion, extra = {}) => ({ databaseId: id, status: 'completed', conclusion, createdAt: new Date(1e12 + id * 1000).toISOString(), headBranch: `gh-readonly-queue/main/pr-${id}-abc`, ...extra });
const rest = (r, path = '.github/workflows/ci.yml') => ({ id: r.databaseId, status: r.status, conclusion: r.conclusion, created_at: r.createdAt, head_branch: r.headBranch, head_sha: r.headSha ?? 'a'.repeat(40), event: 'merge_group', run_attempt: 1, path });

describe('detectLatentRedMain (live 2026-10-20: every merge group failed on one expired-fixture test)', () => {
  const fails = { 3: [T, 'x'], 2: [T], 1: [T, 'y'] };
  const failuresOf = (r) => fails[r.databaseId] ?? null;
  const runs = [run(3, 'failure'), run(2, 'failure'), run(1, 'failure')];
  it('fires when the newest N completed runs fail on a shared test', () => {
    expect(detectLatentRedMain({ runs, threshold: 3, failuresOf })).toMatchObject({ fire: true, tests: [T], runIds: [3, 2, 1], prs: [3, 2, 1] });
  });
  it('passes over only in-progress and cancelled runs; any other non-failure conclusion ends the streak', () => {
    const mixed = [run(9, null, { status: 'in_progress' }), run(8, 'cancelled'), ...runs];
    expect(detectLatentRedMain({ runs: mixed, threshold: 3, failuresOf }).fire).toBe(true);
    for (const c of ['success', 'skipped', 'neutral', 'stale', null, 'action_required', 'startup_failure']) {
      expect(detectLatentRedMain({ runs: [run(4, c), ...runs], threshold: 3, failuresOf }).fire).toBe(false);
    }
  });
  it('fails closed: no shared test, an unreadable run, too short a streak, or off', () => {
    expect(detectLatentRedMain({ runs, threshold: 3, failuresOf: (r) => [`t${r.databaseId}`] }).fire).toBe(false);
    expect(detectLatentRedMain({ runs, threshold: 3, failuresOf: (r) => (r.databaseId === 2 ? null : [T]) }).fire).toBe(false);
    expect(detectLatentRedMain({ runs: runs.slice(0, 2), threshold: 3, failuresOf }).fire).toBe(false);
    expect(detectLatentRedMain({ runs, threshold: 0, failuresOf }).reason).toBe('off');
  });
});

describe('listMergeGroupCiRuns', () => {
  it('reads the REST runs endpoint and keeps only the CI workflow path, newest first', () => {
    const exec = vi.fn(() => JSON.stringify({ workflow_runs: [rest(run(1, 'failure')), rest(run(2, 'failure'), '.github/workflows/merge-gate.yml'), rest(run(3, 'success'))] }));
    expect(listMergeGroupCiRuns({ repo: 'o/r', exec }).map((r) => r.databaseId)).toEqual([3, 1]);
    expect(exec.mock.calls[0][1]).toEqual(['api', 'repos/o/r/actions/runs?event=merge_group&per_page=100']);
  });
});

describe('runLatentRedMainCheck', () => {
  const host = ({ mainConclusion = 'success', rerunThrows = false } = {}) => vi.fn((bin, args) => {
    const a = args.join(' ');
    if (a.includes('event=merge_group')) return JSON.stringify({ workflow_runs: [3, 2, 1].map((n) => rest(run(n, 'failure'))) });
    if (a.includes('event=push')) return JSON.stringify({ workflow_runs: [{ ...rest(run(7, mainConclusion)), event: 'push', head_sha: TIP }] });
    if (/runs\/\d+\/jobs/.test(a)) return JSON.stringify({ jobs: [{ id: 50, name: 'test-shard (1)', conclusion: 'failure' }, { id: 51, name: 'test', conclusion: 'failure' }] });
    if (a.endsWith('/logs')) return `2026-10-20T07:00:00Z FAIL  ${T.split(' > ')[0]} > ${T.split(' > ')[1]}\n`;
    if (a.includes('commits/main')) return TIP;
    if (args[0] === 'run' && args[1] === 'rerun') { if (rerunThrows) throw new Error('HTTP 403'); return ''; }
    throw new Error(`unexpected ${a}`);
  });
  const withDir = (fn) => { const d = mkdtempSync(join(tmpdir(), 'lrm-')); try { return fn(join(d, 'l.json')); } finally { rmSync(d, { recursive: true, force: true }); } };
  it('re-runs main tip\'s green CI once and publishes one needs-you event', () => withDir((ledgerPath) => {
    const exec = host(); const publish = vi.fn(); const lines = [];
    const first = runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish, log: (l) => lines.push(l) });
    expect(first).toMatchObject({ fired: true, action: 'rerun-main', detail: { rerun: 'requested' } });
    expect(exec.mock.calls.filter(([, a]) => a[0] === 'run' && a[1] === 'rerun').map(([, a]) => a)).toEqual([['run', 'rerun', '7', '--repo', 'o/r']]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'latent-red-main', head: `latent-red-main:${TIP}` }));
    expect(lines.join('\n')).toContain('drain.latentRedMainRuns=3 (standard)');
    expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).acted[TIP]).toMatchObject({ mainRun: 7, rerun: 'requested' });
    expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish, log: () => {} }).action).toBe('already-acted');
    expect(exec.mock.calls.filter(([, a]) => a[1] === 'rerun')).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  }));
  it('leaves an already-red main to the red-main machinery, and dry run writes nothing', () => withDir((ledgerPath) => {
    const exec = host({ mainConclusion: 'failure' });
    expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('main-already-red');
    expect(exec.mock.calls.some(([, a]) => a[1] === 'rerun')).toBe(false);
    const dry = host();
    expect(runLatentRedMainCheck({ repo: 'o/r', exec: dry, threshold: 3, ledgerPath: `${ledgerPath}.dry`, dryRun: true, log: () => {} })).toMatchObject({ fired: true, action: 'rerun-main' });
    expect(dry.mock.calls.some(([, a]) => a[1] === 'rerun')).toBe(false);
  }));
  it('never re-issues a re-run whose outcome is unknown; retries a deferred one at most 3 times', () => withDir((ledgerPath) => {
    const exec = host({ rerunThrows: true });
    const go = (x = exec, path = ledgerPath) => runLatentRedMainCheck({ repo: 'o/r', exec: x, threshold: 3, ledgerPath: path, publish: () => {}, log: () => {} });
    expect(go().detail.rerun).toMatch(/^outcome unknown/);
    expect(go().action).toBe('already-acted');
    expect(exec.mock.calls.filter(([, a]) => a[1] === 'rerun')).toHaveLength(1);
    const base = host();
    const deferred = vi.fn((bin, args) => (args[1] === 'rerun' ? JSON.stringify({ outcome: 'deferred-low-budget' }) : base(bin, args)));
    const p2 = `${ledgerPath}.2`;
    expect(go(deferred, p2).detail.rerun).toMatch(/^failed: deferred/);
    go(deferred, p2); go(deferred, p2);
    expect(go(deferred, p2).action).toBe('already-acted');
    expect(deferred.mock.calls.filter(([, a]) => a[1] === 'rerun')).toHaveLength(3);
    expect(runLatentRedMainCheck({ repo: 'o/r', exec: () => { throw new Error('rate'); }, threshold: 3, ledgerPath, log: () => {} }).action).toBe('error');
    expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 0, ledgerPath, log: () => {} }).action).toBe('off');
  }));
  it('an unreadable ledger never re-runs: needs-you only', () => withDir((ledgerPath) => {
    writeFileSync(ledgerPath, '{not json');
    const exec = host(); const publish = vi.fn();
    for (let i = 0; i < 3; i++) expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish, log: () => {} }).action).toBe('ledger-unreadable');
    expect(exec.mock.calls.some(([, a]) => a[1] === 'rerun')).toBe(false);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'latent-red-main' }));
  }));
  it('never caches a no-signal from unreadable evidence', () => withDir((ledgerPath) => {
    let logsReadable = false;
    const base = host();
    const exec = vi.fn((bin, args) => { if (args.join(' ').endsWith('/logs') && !logsReadable) throw new Error('HTTP 502'); return base(bin, args); });
    expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('no-signal');
    logsReadable = true;
    expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('rerun-main');
  }));
  it('records nothing while main CI is still running; a throwing logger never escapes', () => withDir((ledgerPath) => {
    const base = host();
    const running = vi.fn((bin, args) => (args.join(' ').includes('event=push')
      ? JSON.stringify({ workflow_runs: [{ ...rest(run(7, null, { status: 'in_progress' })), event: 'push', head_sha: TIP }] }) : base(bin, args)));
    expect(runLatentRedMainCheck({ repo: 'o/r', exec: running, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('main-run-in-progress');
    expect(runLatentRedMainCheck({ repo: 'o/r', exec: base, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('rerun-main');
    expect(() => runLatentRedMainCheck({ repo: 'o/r', exec: () => { throw new Error('x'); }, threshold: 3, ledgerPath, log: () => { throw new Error('log'); } })).not.toThrow();
  }));
  it('pages the REST list until enough CI rows, and fails closed when the page budget runs out', () => {
    const other = (n) => ({ ...rest(run(n, 'success'), '.github/workflows/merge-gate.yml') });
    const pages = (p) => (p <= 5 ? Array.from({ length: 100 }, (_, i) => other(p * 1000 + i)) : []);
    const exec = vi.fn((bin, args) => { const p = Number(/[&]page=(\d+)/.exec(args[1])?.[1] ?? 1); return JSON.stringify({ total_count: 10_000, workflow_runs: p === 2 ? [rest(run(5, 'failure')), ...pages(2).slice(1)] : pages(p) }); });
    expect(() => listMergeGroupCiRuns({ repo: 'o/r', exec, limit: 2 })).toThrow(/within 5 pages/);
    const found = vi.fn((bin, args) => { const p = Number(/[&]page=(\d+)/.exec(args[1])?.[1] ?? 1); return JSON.stringify({ total_count: 10_000, workflow_runs: p === 2 ? [rest(run(5, 'failure')), ...pages(2).slice(1)] : pages(p) }); });
    expect(listMergeGroupCiRuns({ repo: 'o/r', exec: found, limit: 1 }).map((r) => r.databaseId)).toEqual([5]);
    expect(found.mock.calls).toHaveLength(2);
  });
  it('fails closed on a structurally malformed ledger (Codex round 3)', () => withDir((ledgerPath) => {
    const good = { at: 1, published: false, mainRun: 7, runIds: [3, 2, 1], tests: [T] };
    for (const bad of [{ acted: { [TIP]: false } }, { acted: { [TIP]: { status: 'failed', attempts: -5 } } }, { acted: [] }, { lastNoFire: 'x' },
      { acted: { [TIP]: { status: 'failed', published: 'invalid', mainRun: null } } },
      { acted: { [TIP]: { ...good, status: 'failed', attempts: 1, rerun: 'failed: deferred before sending (x)' } } },
      { acted: { [TIP]: { ...good, status: 'failed', attempts: 1, unsent: true, rerun: 'outcome unknown: timeout' } } },
      { acted: { [TIP]: { ...good, status: 'requested', attempts: 1 } } },
      { acted: { notasha: { ...good, status: 'main-already-red' } } }]) {
      writeFileSync(ledgerPath, JSON.stringify(bad));
      const exec = host();
      expect(runLatentRedMainCheck({ repo: 'o/r', exec, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('ledger-unreadable');
      expect(exec.mock.calls.some(([, a]) => a[1] === 'rerun')).toBe(false);
    }
    expect(validLedger({})).toBe(true);
    expect(validLedger({ acted: { [TIP]: { ...good, status: 'requested', attempts: 1, rerun: 'requested' } } })).toBe(true);
    expect(validLedger({ acted: { [TIP]: { ...good, status: 'failed', attempts: 2, unsent: true, rerun: 'failed: deferred before sending (low gh budget)' } } })).toBe(true);
  }));
  it('a threshold change never reuses a cached no-signal', () => withDir((ledgerPath) => {
    const base = host();
    const two = vi.fn((bin, args) => (args.join(' ').includes('event=merge_group')
      ? JSON.stringify({ workflow_runs: [2, 1].map((n) => rest(run(n, 'failure'))).concat([rest(run(0, 'success'))]) }) : base(bin, args)));
    expect(runLatentRedMainCheck({ repo: 'o/r', exec: two, threshold: 3, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('no-signal');
    expect(runLatentRedMainCheck({ repo: 'o/r', exec: two, threshold: 2, ledgerPath, publish: () => {}, log: () => {} }).action).toBe('rerun-main');
  }));
  it('matches a workflow only by file or full path, never by name or id', () => {
    const r = { path: '.github/workflows/ci.yml', name: 'CI' };
    for (const w of ['ci.yml', '.github/workflows/ci.yml']) expect(workflowMatcher(w)(r)).toBe(true);
    for (const w of ['CI', '305968843', 'merge-gate.yml', '.github/workflows/.github/workflows/ci.yml']) expect(workflowMatcher(w)(r)).toBe(false);
  });
});
