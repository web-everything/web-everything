import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readQuarantine, writeQuarantineChange, runSafetyNet, resolveQuarantineSettings, rerunRedMainFailedJobs } from '../red-main-quarantine-io.mjs';
import { addEntries, pruneOnGreen, testsToSkip } from '../red-main-quarantine.mjs';

const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const d = mkdtempSync(join(tmpdir(), 'rmq-'));
  const origin = join(d, 'origin.git');
  g(['init', '--quiet', '--bare', origin], d);
  const board = join(d, 'board');
  g(['clone', '--quiet', origin, board], d);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'init'], board);
  g(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], board);
  g(['config', 'user.email', 't@t'], board); g(['config', 'user.name', 't'], board);
  return { origin, board };
}
const SHA = '7e51376635bbb571dfc596f1986960bf35a03fd6';
const TEST = 'skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs';

describe('quarantine IO — ops/quarantine branch (real git)', () => {
  it('an unreachable branch is unreadable, never empty', () => {
    const { board } = repo();
    expect(readQuarantine({ board }).ok).toBe(false);
  });
  it('add creates ops/quarantine with the list + an audit event; prune on green empties it; nothing else is pushed', () => {
    const { board, origin } = repo();
    const now = Date.now();
    writeQuarantineChange({ board, actor: 'red-main-safety-net', message: 'add', change: (cur) => addEntries(cur, { tests: [TEST], brokenSha: SHA, owner: 'o', reason: 'r', actor: 'red-main-safety-net', now }) });
    const r = readQuarantine({ board });
    expect(r.ok).toBe(true);
    expect(testsToSkip({ list: r.list, now, prNumber: 1, fixPrs: [2] })).toEqual([TEST]);
    const events = g(['show', 'refs/heads/ops/quarantine:events.jsonl'], origin);
    expect(events).toContain('"type":"quarantine-added"');
    writeQuarantineChange({ board, actor: 'red-main-safety-net', message: 'prune', change: (cur) => pruneOnGreen(cur, { mainGreen: true, now }) });
    expect(readQuarantine({ board }).list.entries).toEqual([]);
    expect(g(['show', 'refs/heads/ops/quarantine:events.jsonl'], origin)).toContain('"type":"quarantine-removed"');
    expect(g(['for-each-ref', '--format=%(refname)'], origin).trim().split('\n').sort()).toEqual(['refs/heads/main', 'refs/heads/ops/quarantine']);
  });
  it('a writer outside the allow-list writes nothing', () => {
    const { board, origin } = repo();
    expect(() => writeQuarantineChange({ board, actor: 'pr-4613', message: 'x', change: (cur) => ({ ok: true, list: cur, events: [] }) })).toThrow(/refused/);
    expect(g(['for-each-ref', '--format=%(refname)'], origin).trim()).toBe('refs/heads/main');
  });

  it('the live safety net publishes the proof, job and owed card on the ops ref', () => {
    const { board, origin } = repo();
    const fixture = JSON.parse(readFileSync(join('scripts', 'lib', '__tests__', 'fixtures', 'red-main-quarantine-62da75ed3.json'), 'utf8'));
    // Supply a hypothetical earlier run of the failing sha whose re-run passed; the recorded episode had none.
    fixture.mainCiRuns.runs.push({ ...fixture.mainCiRuns.runs[0], databaseId: 7, createdAt: '2026-10-14T06:08:00Z', updatedAt: '2026-10-14T06:15:00Z', attempt: 2 });
    const rerunJobs = [{ name: 'integration', conclusion: 'failure', run_attempt: 1 }, { name: 'integration', conclusion: 'success', run_attempt: 2 }];
    const file = 'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs';
    const result = runSafetyNet({
      mainCiRuns: fixture.mainCiRuns, now: Date.parse(fixture.now), dir: join(board, 'health'), board,
      mode: { value: 'quarantine', source: 'env' },
      settings: resolveQuarantineSettings({ env: {}, platform: null, file: join(board, 'absent.json') }),
      readJobs: (id, opts) => (opts?.filter === 'all' ? { jobs: id === 7 ? rerunJobs : [] } : { failed: fixture.failedJobs }),
      readLog: () => ({ complete: true, files: [file], tests: [{ file, name: 'A3' }] }), log: () => {},
    });
    expect(result.applied).toBe(true);
    const list = readQuarantine({ board }).list;
    expect(list).toMatchObject({ mode: 'quarantine', entries: [{ test: file, job: 'integration', proof: { kind: 'rerun-passed', runId: 7, attempt: 2 } }] });
    const events = g(['show', 'refs/heads/ops/quarantine:events.jsonl'], origin).trim().split('\n').map(JSON.parse);
    expect(events.filter((e) => e.type === 'card-owed')).toEqual([expect.objectContaining(result.plan.cards[0])]);
    expect(g(['for-each-ref', '--format=%(refname)'], origin).trim().split('\n').sort()).toEqual(['refs/heads/main', 'refs/heads/ops/quarantine']);
  });
});

describe('rerunRedMainFailedJobs — a quarantine add re-runs the failed jobs of the broken main run, once per sha', () => {
  const runs = (list) => JSON.stringify(list);
  const fake = (list, { failRerun = false } = {}) => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      if (args[0] === 'run' && args[1] === 'list') return runs(list);
      if (args[0] === 'run' && args[1] === 'rerun') { if (failRerun) throw new Error('boom'); return ''; }
      throw new Error('unexpected ' + args.join(' '));
    };
    return { exec, calls };
  };
  const dirOf = () => mkdtempSync(join(tmpdir(), 'rmq-rr-'));
  const red = [{ databaseId: 42, headSha: SHA, status: 'completed', conclusion: 'failure', createdAt: '2026-11-08T03:47:00Z' }];
  const reruns = (calls) => calls.filter((a) => a[1] === 'rerun');

  it('a completed+failed latest run for the broken sha gets exactly one --failed rerun', () => {
    const { exec, calls } = fake(red);
    const r = rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir: dirOf(), repoSlug: 'o/r' });
    expect(r).toMatchObject({ rerun: true, runId: 42 });
    expect(reruns(calls)).toHaveLength(1);
    expect(reruns(calls)[0]).toEqual(expect.arrayContaining(['run', 'rerun', '42', '--failed']));
  });
  it('a second add for the same sha does not rerun again', () => {
    const { exec, calls } = fake(red);
    const dir = dirOf();
    rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' });
    const r = rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' });
    expect(r).toMatchObject({ rerun: false, reason: 'already-rerun' });
    expect(reruns(calls)).toHaveLength(1);
  });
  it('a latest run still in progress, green, or for another sha is never rerun', () => {
    for (const list of [
      [{ ...red[0], status: 'in_progress', conclusion: null }],
      [{ ...red[0], conclusion: 'success' }],
      [{ ...red[0], headSha: 'f'.repeat(40) }],
      [red[0], { ...red[0], databaseId: 43, status: 'in_progress', conclusion: null, createdAt: '2026-11-08T05:00:00Z' }],
      [],
    ]) {
      const { exec, calls } = fake(list);
      expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir: dirOf(), repoSlug: 'o/r' }).rerun).toBe(false);
      expect(reruns(calls)).toHaveLength(0);
    }
  });
  it('a failed rerun request is reported with the manual fallback and is NOT retried (at most one request per sha)', () => {
    const dir = dirOf();
    const bad = fake(red, { failRerun: true });
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec: bad.exec, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: false, error: expect.stringContaining('gh run rerun 42 --failed') });
    const again = fake(red);
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec: again.exec, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: false, reason: 'already-rerun' });
    expect(reruns(again.calls)).toHaveLength(0);
  });
  it('an unreadable run list is reported, never thrown, and leaves no claim (a later add may still rerun)', () => {
    const dir = dirOf();
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec: () => { throw new Error('gh down'); }, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: false, error: expect.stringContaining('gh down') });
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec: fake(red).exec, dir, repoSlug: 'o/r' }).rerun).toBe(true);
  });
  it('a short and a full spelling of the same sha share one claim (keyed by the resolved run sha)', () => {
    const dir = dirOf();
    const { exec, calls } = fake(red);
    expect(rerunRedMainFailedJobs({ brokenSha: SHA.slice(0, 7), exec, dir, repoSlug: 'o/r' }).rerun).toBe(true);
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: false, reason: 'already-rerun' });
    expect(reruns(calls)).toHaveLength(1);
  });
  it('an exclusive-create failure that is not "already claimed" fails closed (claim path is a directory)', () => {
    const dir = dirOf();
    mkdirSync(join(dir, `red-main-quarantine-rerun-${SHA}.json`));
    const { exec, calls } = fake(red);
    const r = rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' });
    expect(r.rerun).toBe(false);
    expect(reruns(calls)).toHaveLength(0);
  });
  it('a missing broken sha reruns nothing', () => {
    const { exec, calls } = fake(red);
    expect(rerunRedMainFailedJobs({ brokenSha: undefined, exec, dir: dirOf(), repoSlug: 'o/r' }).rerun).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('the list call is scoped to the repo, the ci.yml workflow and branch main', () => {
    const { exec, calls } = fake(red);
    rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir: dirOf(), repoSlug: 'o/r' });
    expect(calls[0]).toEqual(expect.arrayContaining(['--repo', 'o/r', '--workflow', 'ci.yml', '--branch', 'main']));
  });
  it('an unwritable claim (fail closed) or malformed run-list JSON never reruns and never throws', () => {
    const { exec, calls } = fake(red);
    const file = join(dirOf(), 'a-file'); writeFileSync(file, 'x');
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir: join(file, 'sub'), repoSlug: 'o/r' })).toMatchObject({ rerun: false, error: expect.stringContaining('claim') });
    expect(reruns(calls)).toHaveLength(0);
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec: () => 'not json', dir: dirOf(), repoSlug: 'o/r' })).toMatchObject({ rerun: false, error: expect.any(String) });
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec: () => '[null, 7, {"headSha": 5}]', dir: dirOf(), repoSlug: 'o/r' }).rerun).toBe(false);
  });
  it('a pre-existing malformed marker for the sha is treated as already claimed, no throw, no rerun', () => {
    const dir = dirOf();
    writeFileSync(join(dir, `red-main-quarantine-rerun-${SHA}.json`), '42');
    const { exec, calls } = fake(red);
    expect(rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: false, reason: 'already-rerun' });
    expect(reruns(calls)).toHaveLength(0);
  });
  it('two concurrent adds for one sha issue exactly one rerun (exclusive claim before the request)', () => {
    const dir = dirOf();
    let inner = null;
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      if (args[1] === 'list') return runs(red);
      if (!inner) inner = rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' }); // second caller arrives mid-request
      return '';
    };
    const first = rerunRedMainFailedJobs({ brokenSha: SHA, exec, dir, repoSlug: 'o/r' });
    expect(first.rerun).toBe(true);
    expect(inner).toMatchObject({ rerun: false, reason: 'already-rerun' });
    expect(reruns(calls)).toHaveLength(1);
  });
});
