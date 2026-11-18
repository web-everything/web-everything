import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readQuarantine, writeQuarantineChange, runSafetyNet, resolveQuarantineSettings, rerunRedMainFailedJobs, runAddCommand, mainQuarantineCovered } from '../red-main-quarantine-io.mjs';
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

describe('runAddCommand — the `add` CLI wiring triggers the rerun', () => {
  it('operator --job reaches the published entry', () => {
    runAddCommand({ tests: 'a.test.mjs::case', 'broken-sha': SHA, actor: 'operator', owner: 'o', reason: 'r', job: 'soak-shard (1)' },
      { rerun: () => null, write: ({ change }) => { expect(change(null).list.entries[0].job).toBe('soak-shard (1)'); return { ok: true }; } });
  });
  const flags = { tests: 'a.test.mjs', 'broken-sha': SHA, owner: 'o', reason: 'r', actor: 'a' };
  it('a successful add calls the rerun with the broken sha and --dir, and attaches `rerun` to the output', () => {
    const rerun = vi.fn(() => ({ rerun: true, runId: 42 }));
    const write = vi.fn(() => ({ ok: true, events: [] }));
    const out = runAddCommand({ ...flags, dir: '/claims' }, { write, rerun });
    expect(write).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledWith({ brokenSha: SHA, dir: '/claims' });
    expect(out).toMatchObject({ ok: true, rerun: { rerun: true, runId: 42 } });
  });
  it('an uppercase --broken-sha reaches the list write and the rerun lowercased (one spelling end to end)', () => {
    const rerun = vi.fn(() => ({ rerun: false }));
    let message = '';
    runAddCommand({ ...flags, 'broken-sha': SHA.toUpperCase() }, { write: (w) => { message = w.message; return { ok: true }; }, rerun });
    expect(rerun).toHaveBeenCalledWith({ brokenSha: SHA });
    expect(message).toContain(`broken ${SHA.slice(0, 9)},`);
  });
  it('without --dir the rerun gets no dir (its default applies)', () => {
    const rerun = vi.fn(() => ({ rerun: false, reason: 'already-rerun' }));
    runAddCommand(flags, { write: () => ({ ok: true }), rerun });
    expect(rerun).toHaveBeenCalledWith({ brokenSha: SHA });
  });
  it('a write that reports ok:false triggers no rerun and carries no `rerun` field', () => {
    const rerun = vi.fn(() => ({ rerun: true }));
    const out = runAddCommand(flags, { write: () => ({ ok: false, error: 'nope' }), rerun });
    expect(rerun).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: false, error: 'nope' });
  });
  it('a write that throws propagates and triggers no rerun', () => {
    const rerun = vi.fn();
    expect(() => runAddCommand(flags, { write: () => { throw new Error('refused'); }, rerun })).toThrow('refused');
    expect(rerun).not.toHaveBeenCalled();
  });
});

describe('latest main quarantine coverage releases the drain only with complete evidence', () => {
  const file = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs', job = 'soak-shard (1)';
  it.each(['all-covered', 'unit-covered', 'named-case', 'one-uncovered', 'unreadable-list', 'unreadable-run', 'expired', 'non-shard', 'integration', 'oversized', 'incomplete-jobs', 'missing-full-jobs', 'unreadable-log', 'newer-run', 'legacy', 'wrong-job'])('%s proceeds only when all failures are covered; otherwise holds', (scenario) => {
    const now = Date.now(), readLog = vi.fn(() => ({ complete: true, files: [file, ...(scenario === 'one-uncovered' ? ['other.test.mjs'] : [])] }));
    const list = addEntries(null, { tests: [scenario === 'named-case' ? `${file}::50 real daemon ticks` : file], brokenSha: SHA, actor: 'operator', owner: 'o', reason: 'r', now,
      ...(scenario === 'legacy' ? {} : { job: scenario === 'wrong-job' ? 'soak-shard (2)' : job }) }).list;
    list.mode = 'quarantine';
    if (scenario === 'expired') { list.entries[0].addedAt = now - 1; list.entries[0].expiresAt = now; }
    const failed = [{ id: 1, name: job }, { id: 2, name: 'daemon-soak' }];
    if (scenario === 'unit-covered') { list.entries[0].test = file; list.entries[0].job = 'test-shard (1)'; failed[0].name = 'test-shard (1)'; failed[1].name = 'test'; }
    if (scenario === 'non-shard') failed.push({ id: 3, name: 'lint' });
    if (scenario === 'integration') failed.push({ id: 3, name: 'integration' });
    if (scenario === 'oversized') failed.push(...[2, 3, 4, 5, 6].map((n) => ({ id: n + 2, name: `soak-shard (${n})` })));
    const result = mainQuarantineCovered({ list: scenario === 'unreadable-list' ? null : list, signal: { latestRedSha: SHA }, now,
      exec: () => { if (scenario === 'unreadable-run') throw new Error('unreadable'); return JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', headSha: scenario === 'newer-run' ? 'other' : SHA }]); },
      readJobs: () => ({ complete: scenario !== 'incomplete-jobs', failed,
        ...(scenario === 'missing-full-jobs' ? {} : { jobs: failed.map((j) => ({ ...j, conclusion: 'failure' })) }) }),
      readLog: scenario === 'unreadable-log' ? () => { throw new Error('unreadable'); } : readLog,
      readAggregateLog: () => `${scenario === 'unit-covered' ? '##[error]Unit shards did not succeed.' : 'One or more soak shards did not succeed (soak-shard result: failure).'}\n##[error]Process completed with exit code 1.` });
    expect(result).toBe(['all-covered', 'unit-covered'].includes(scenario));
    if (scenario === 'oversized') expect(readLog).not.toHaveBeenCalled();
  });

  describe.each([
    ['test', 'test-shard (1)', '##[error]Unit shards did not succeed.'],
    ['coverage-merge', 'test-shard (1)', '##[error]Unit shards did not succeed; refusing incomplete coverage.'],
    ['daemon-soak', job, 'One or more soak shards did not succeed (soak-shard result: failure).'],
  ])('%s aggregate evidence', (aggregate, shard, message) => {
    const exit = '##[error]Process completed with exit code 1.';
    function probe(log, extra = []) {
      const now = Date.now(), reads = [];
      const list = { ...addEntries(null, { tests: [file], job: shard, brokenSha: SHA, actor: 'operator', owner: 'o', reason: 'r', now }).list, mode: 'quarantine' };
      const failed = [{ id: 1, name: `hetzner / ${shard}` }, { id: 2, name: `hetzner / ${aggregate}` }, ...extra];
      const covered = mainQuarantineCovered({ list, signal: { latestRedSha: SHA }, now,
        readJobs: () => ({ complete: true, failed, jobs: failed.map((j) => ({ ...j, conclusion: 'failure' })) }),
        exec: (_bin, args, options) => {
          if (args[0] === 'run') return JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', headSha: SHA }]);
          reads.push(args[1]);
          expect(options).toMatchObject({ timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
          if (args[1].endsWith('/2/logs')) { if (log instanceof Error) throw log; return log; }
          if (args[1].endsWith('/1/logs')) return ` FAIL ${file} > covered case\nAssertionError: expected true\n Test Files 1 failed\n Tests 1 failed\n`;
          throw new Error('unexpected log read');
        },
      });
      return { covered, reads };
    }

    it('reads its own bounded log before accepting the known dependency failure and final exit', () => {
      // Real Actions logs quote all shell branches inside the Run group before emitting the executed error.
      const log = `##[group]Run if [ condition ]; then\necho "::error::Standards did not succeed."\n##[endgroup]\n${message}\n${exit}`;
      const { covered, reads } = probe(log.split('\n').map((line) => `2026-11-18T12:00:00.000Z ${line}`).join('\n'));
      expect(covered).toBe(true);
      expect(reads).toHaveLength(2);
      expect(reads.some((path) => path.endsWith('/2/logs'))).toBe(true);
      expect(reads.some((path) => path.endsWith('/1/logs'))).toBe(true);
    });

    it.each(['Error: independent aggregate failure', '##[error]upload failed', '::error::permission denied',
      'Integration did not succeed unexpectedly', 'Timeout: runner stopped', 'daemon-soak-scope did not succeed (result: failure).'])
    ('retains the hold for independent error text: %s', (error) => {
      expect(probe(`${error}\n${message}\n${exit}`).covered).toBe(false);
      expect(probe(`${message}\n${error}\n${exit}`).covered).toBe(false);
      expect(probe(`${message}\n${exit}\n${error}`).covered).toBe(false);
    });

    it.each([null, '', new Error('unreadable aggregate log')])('retains the hold for unreadable or empty aggregate evidence: %s', (log) => {
      expect(probe(log).covered).toBe(false);
    });
    it('retains the hold for incomplete, unknown or quoted-only failure evidence', () => {
      for (const log of [message, exit, `${message}\n${exit}\ntruncated`,
        `##[error]Unknown dependency did not succeed.\n${exit}`,
        `##[group]Run echo failure\n${message}\n##[endgroup]\n${exit}`,
        `##[group]Run echo failure\n##[error]independent failure\n##[endgroup]\n${message}\n${exit}`,
        `##[group]Run echo failure\n${message}\n${exit}`]) expect(probe(log).covered, log).toBe(false);
    });
    it('retains the operator hold for unknown aggregates and more than three aggregate logs without reading them', () => {
      for (const extra of [[{ id: 3, name: 'unknown-aggregate' }],
        [3, 4, 5].map((id) => ({ id, name: aggregate }))]) {
        expect(probe(`${message}\n${exit}`, extra)).toEqual({ covered: false, reads: [] });
      }
    });
  });

  it.each(['success', 'cancelled', 'timed_out', 'startup_failure', 'action_required', null])('full job read retains the hold for an uncovered %s job', (conclusion) => {
    const now = Date.now();
    const list = { ...addEntries(null, { tests: [file], job, brokenSha: SHA, actor: 'operator', owner: 'o', reason: 'r', now }).list, mode: 'quarantine' };
    const exec = vi.fn((_bin, args) => {
      if (args[0] === 'run') return JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', headSha: SHA }]);
      if (args[1].endsWith('/2/logs')) return 'One or more soak shards did not succeed (soak-shard result: failure).\n##[error]Process completed with exit code 1.';
      if (args[1].endsWith('/logs')) return ` FAIL ${file} > covered case\nAssertionError: expected true\n Test Files 1 failed\n Tests 1 failed\n`;
      return JSON.stringify({ total_count: 3, jobs: [{ id: 1, name: job, conclusion: 'failure' },
        { id: 2, name: 'daemon-soak', conclusion: 'failure' }, { id: 3, name: 'soak-shard (2)', conclusion }] });
    });
    expect(mainQuarantineCovered({ list, signal: { latestRedSha: SHA }, now, exec })).toBe(conclusion === 'success');
  });

  it.each(['', 'Error: uncovered teardown failure', 'Unhandled rejection: late', '##[error]uncovered runner failure',
    ` FAIL ${file} > unlisted failure`, ' Tests 2 failed'])('coverage refuses trailing non-test or unlisted failure evidence: %j', (tail) => {
    const now = Date.now();
    const list = { ...addEntries(null, { tests: [file], job, brokenSha: SHA, actor: 'operator', owner: 'o', reason: 'r', now }).list, mode: 'quarantine' };
    expect(mainQuarantineCovered({ list, signal: { latestRedSha: SHA }, now,
      exec: (_bin, args) => args[0] === 'run'
        ? JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', headSha: SHA }])
        : ` FAIL ${file} > covered case\nAssertionError: expected true\n Test Files 1 failed\n Tests 1 failed\n${tail}`,
      readJobs: () => ({ complete: true, failed: [{ id: 1, name: job }], jobs: [{ id: 1, name: job, conclusion: 'failure' }] }),
    })).toBe(tail === '');
  });

  it.each([
    'Unhandled Rejection: worker died', 'Unhandled Error: worker died', 'Error: worker crashed',
    '##[error]uncovered runner failure', 'ELIFECYCLE Command failed', 'Timeout: runner exceeded its deadline',
    'Error: independent failure',
  ])('coverage fails closed for independent errors anywhere in the log: %s', (error) => {
    const now = Date.now();
    const list = { ...addEntries(null, { tests: [file], job, brokenSha: SHA, actor: 'operator', owner: 'o', reason: 'r', now }).list, mode: 'quarantine' };
    const block = ` FAIL ${file} > covered case\nAssertionError: expected true\n⎯⎯⎯⎯⎯ [1/1] ⎯⎯⎯\n`;
    const summary = ' Test Files 1 failed\n Tests 1 failed\n';
    const covered = (log) => mainQuarantineCovered({ list, signal: { latestRedSha: SHA }, now,
      exec: (_bin, args) => args[0] === 'run'
        ? JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', headSha: SHA }]) : log,
      readJobs: () => ({ complete: true, failed: [{ id: 1, name: job }], jobs: [{ id: 1, name: job, conclusion: 'failure' }] }),
    });
    expect(covered(`${block}${summary}`)).toBe(true);
    expect(covered(`${block}${summary}##[error]Process completed with exit code 1.`)).toBe(true);
    for (const log of [`${error}\n${block}${summary}`, `${block}${error}\n${summary}`, `${block}${summary}${error}`,
      ` FAIL ${file} > covered case\nAssertionError: expected true\n${error}\n${summary}`]) {
      expect(covered(log), log).toBe(false);
    }
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
  it('an uppercase sha (short or full) matches the lowercase run sha and shares its claim', () => {
    const dir = dirOf();
    const { exec, calls } = fake(red);
    expect(rerunRedMainFailedJobs({ brokenSha: SHA.slice(0, 9).toUpperCase(), exec, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: true, runId: 42 });
    expect(rerunRedMainFailedJobs({ brokenSha: SHA.toUpperCase(), exec, dir, repoSlug: 'o/r' })).toMatchObject({ rerun: false, reason: 'already-rerun' });
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
