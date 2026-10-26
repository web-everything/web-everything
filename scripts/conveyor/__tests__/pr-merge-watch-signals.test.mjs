// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runMergeWatch, resolveMergeWatchSettings } from '../pass-daemons/pr-merge-watch-pass.mjs';
import { readSignalLogs, normalizeReason, overdueSignals } from '../pass-daemons/pr-merge-watch-signals.mjs';

vi.mock('node:fs', async original => {
  const actual = await original();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
vi.mock('../../lib/gh-throttle.mjs', async original => ({ ...await original(),
  execFileSyncThrottled: () => { throw Error('no live gh'); },
  execFileThrottled: () => { throw Error('no live gh'); },
}));
const repo = 'example/widgets', head = 'a'.repeat(40);
const at = n => new Date(Date.UTC(2026, 9, 25, 12, n)).toISOString();
const job = (id, duration = 10) => ({ id, name: 'unit', status: 'completed', started_at: at(-60), completed_at: at(-60 + duration) });
let root, pr, pushed, timeline, checks, runs, history, gh, emitEvent, log, options;
beforeEach(() => {
  if (!process.env.TMPDIR) throw Error('task TMPDIR required');
  root = mkdtempSync(join(process.env.TMPDIR, 'merge-signals-'));
  mkdirSync(join(root, 'logs'));
  writeFileSync(join(root, 'logs/review-daemon.log'), '');
  pr = { number: 17, state: 'OPEN', isDraft: false, headRefOid: head, labels: [], mergeStateStatus: 'CLEAN', createdAt: at(-720) };
  pushed = at(-300);
  timeline = [{ event: 'reviewed', state: 'approved', submitted_at: at(0) }];
  checks = [];
  runs = [1, 2, 3].map(id => ({ id }));
  history = new Map(runs.map(({ id }) => [id, [job(id)]]));
  emitEvent = vi.fn().mockResolvedValue(true); log = vi.fn();
  gh = vi.fn(args => {
    if (args[0] === 'pr') return structuredClone(pr);
    const path = args[1];
    if (path.includes('/pulls?state=open')) return [{ number: 17, state: 'open', head: { sha: pr.headRefOid } }];
    if (path.includes('/comments?')) return [];
    if (path.includes('/timeline?')) return structuredClone(timeline);
    if (path.includes('/check-runs?')) return { check_runs: structuredClone(checks) };
    if (path.includes('/commits/')) return { sha: pr.headRefOid, commit: { committer: { date: pushed } } };
    if (path.includes('/actions/runs?')) return { workflow_runs: runs };
    const match = /actions\/runs\/(\d+)\/jobs/.exec(path);
    if (match) return { jobs: history.get(Number(match[1])) };
    throw Error('unexpected read');
  });
  options = { repos: [repo], gh, stateDir: join(root, 'state'), now: at(0),
    settings: { readyNotMergingMinutes: 60 }, emitEvent, log,
    signalLogs: () => readSignalLogs([join(root, 'logs')]) };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const tick = () => runMergeWatch(options);
const events = () => emitEvent.mock.calls.map(([event]) => event);
const disk = () => JSON.parse(readFileSync(join(root, 'state', `${encodeURIComponent(repo)}.json`), 'utf8'));
function looping(count = 10, style = 'review') {
  const lines = Array.from({ length: count }, (_, i) => {
    const prefix = style === 'fix' ? `reconcile-fix-dispatch-daemon: reconcile-refused live-process ${repo} PR #17`
      : style === 'drain' ? `drain: skipped ${repo}#17` : `review-daemon: ${repo}#17 review:pending, no review dispatched`;
    return `${at(-20 + i / 60)} ${prefix} — held for ${i + 1}ms at ${at(-20 + i / 60)} head ${String(i).padStart(40, 'a')}\n`;
  }).join('');
  writeFileSync(join(root, 'logs/review-daemon.log'), lines);
}
function progress(draft = false) { pr.isDraft = draft; timeline = []; }
function overdue(minutes = 21) { checks = [{ id: 77, name: 'unit', status: 'in_progress', started_at: at(-minutes) }]; }

describe('pr-looping', () => {
  it.each(['review', 'fix', 'drain'])('fires once per head and normalised reason for %s logs', async style => {
    looping(10, style);
    expect(await tick()).toEqual({ delivered: 1, incomplete: false });
    await tick();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ kind: 'pr-looping', repo, pr: 17, detail: { count: 10 } });
    expect(events()[0].detail.reason).toContain('<time>');
    pr.headRefOid = 'b'.repeat(40);
    await tick();
    expect(events()).toHaveLength(2);
  });
  it('timestamp-normalisation also removes durations, shas and control characters', () => {
    expect(normalizeReason('wait 10ms 2026-10-25T12:00:00.000Z abcdef123\u001b'))
      .toBe(normalizeReason('wait 99ms 2026-10-25T12:29:59.000Z 123456abc'));
  });
  it('does not fire below ten, outside thirty minutes, before this head or for another repo', async () => {
    looping(9); await tick();
    looping(); options.now = at(60); await tick();
    options.now = at(0); pushed = at(-1); await tick();
    pushed = at(-300);
    const file = join(root, 'logs/review-daemon.log');
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll(repo, 'other/widgets'));
    await tick(); expect(events()).toEqual([]);
  });
  it('reads only the bounded tail and discards partial first/last lines', () => {
    const file = join(root, 'logs/review-daemon.log');
    const contents = 'old sentinel'.repeat(10000) + '\nnew complete\npartial';
    writeFileSync(file, contents);
    vi.mocked(readSync).mockClear();
    expect(readSignalLogs([join(root, 'logs')], 64)).toEqual(['new complete\n']);
    expect(readSync).toHaveBeenCalledTimes(1);
    expect(readSync).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer),
      0, 64, Buffer.byteLength(contents) - 64);
    expect(vi.mocked(readSync).mock.calls[0][1].byteLength).toBe(64);
  });
});

describe('pr-no-progress', () => {
  it.each([false, true])('fires once per head after the strict ready/draft threshold (draft=%s)', async draft => {
    progress(draft); pushed = at(draft ? -241 : -181);
    expect((await tick()).incomplete).toBe(false); await tick();
    expect(events()).toEqual([{ kind: 'pr-no-progress', repo, pr: 17,
      detail: { minutes: draft ? 241 : 181, state: draft ? 'draft' : 'ready' } }]);
  });
  it.each([false, true])('is silent below and exactly at threshold (draft=%s)', async draft => {
    progress(draft); pushed = at(draft ? -240 : -180); await tick();
    pushed = at(-45); await tick(); expect(events()).toEqual([]);
  });
  it('#5912: PR opened twelve hours ago with head pushed 45 minutes ago does NOT alarm', async () => {
    progress(true); pushed = at(-45); pr.createdAt = at(-720);
    expect(await tick()).toEqual({ delivered: 0, incomplete: false });
  });
  it('a recent force-push restarts the clock even when the commit date is old', async () => {
    progress(); pushed = at(-500); timeline = [{ event: 'head_ref_force_pushed', created_at: at(-10) }];
    await tick(); expect(events()).toEqual([]);
  });
  it('label-churn-not-progress: recent labels never reset the head timer', async () => {
    progress(); timeline = [{ event: 'labeled', created_at: at(-1) }, { event: 'unlabeled', created_at: at(0) }];
    await tick(); expect(events()[0].kind).toBe('pr-no-progress');
  });
  it.each(['reviewed', 'ready_for_review', 'added_to_merge_queue', 'merged'])('a real %s transition resets the timer', async event => {
    timeline = [{ event, state: 'approved', created_at: at(-1) }];
    await tick(); expect(events()).toEqual([]);
  });
  it('a new head gets its own receipt and baseline', async () => {
    progress(); await tick(); pr.headRefOid = 'b'.repeat(40); pushed = at(-45);
    await tick(); expect(events()).toHaveLength(1);
    pushed = at(-181); await tick(); expect(events()).toHaveLength(2);
  });
});

describe('ci-job-overdue', () => {
  it('derives a same-name median from bounded recent completed runs and emits once per job run', async () => {
    overdue(31);
    history.set(1, [job(1, 4), { ...job(10, 50), name: 'other' }]);
    history.set(2, [job(2, 15)]); history.set(3, [job(3, 20)]);
    expect(await tick()).toEqual({ delivered: 1, incomplete: false }); await tick();
    expect(events()).toEqual([{ kind: 'ci-job-overdue', repo, pr: 17, detail: { job: 'unit', minutes: 31, median: 15 } }]);
    checks[0].id++; await tick(); expect(events()).toHaveLength(2);
    expect(gh.mock.calls.filter(([a]) => a[1].includes('/jobs?')).length).toBe(9);
  });
  it('does not fire below or at 2x median, or with fewer than three samples', async () => {
    overdue(19); await tick(); overdue(20); await tick();
    overdue(21); runs.pop(); await tick(); expect(events()).toEqual([]);
  });
  it('honours the factor and averages middle samples for an even median', () => {
    const current = [{ id: 1, name: 'unit', status: 'in_progress', started_at: at(-25) }];
    const recent = [job(1, 4), job(2, 10), job(3, 20), { ...job(4, 100), started_at: at(-200), completed_at: at(-100) }];
    expect(overdueSignals(current, recent, Date.parse(at(0)), 2)).toEqual([]);
    expect(overdueSignals(current, recent, Date.parse(at(0)), 1)[0].median).toBe(15);
  });
});

describe('durability and closed evidence paths', () => {
  it.each(['loop', 'progress', 'ci'])('failed %s delivery keeps its saved receipt retryable', async kind => {
    if (kind === 'loop') looping(); else if (kind === 'progress') progress(); else overdue();
    emitEvent.mockResolvedValueOnce(false);
    expect((await tick()).incomplete).toBe(true);
    expect(disk().prs[17].heads[head].signals).toBeUndefined();
    emitEvent.mockImplementationOnce(() => {
      expect(disk().prs[17].heads[head].signals).toBeUndefined(); return true;
    });
    await tick(); await tick(); expect(events()).toHaveLength(2);
    expect(Object.values(disk().prs[17].heads[head].signals)).toEqual([true]);
  });
  it.each(['commit', 'timeline', 'checks', 'history', 'logs'])('unreadable %s fails closed with a fixed operator fallback', async source => {
    if (source === 'history') overdue();
    const real = gh.getMockImplementation();
    gh.mockImplementation(args => {
      if ((source === 'commit' && args[1].includes('/commits/') && !args[1].includes('/check-runs'))
        || (source === 'timeline' && args[1].includes('/timeline'))
        || (source === 'checks' && args[1].includes('/check-runs'))
        || (source === 'history' && args[1].includes('/jobs?'))) throw Error('UNTRUSTED sentinel');
      return real(args);
    });
    if (source === 'logs') options.signalLogs = () => { throw Error('UNTRUSTED sentinel'); };
    expect((await tick()).incomplete).toBe(true); expect(events()).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator must inspect/);
    expect(log.mock.calls.flat().join(' ')).not.toContain('UNTRUSTED');
  });
  it('oversized timeline refuses at three pages with an operator fallback', async () => {
    progress(); timeline = Array.from({ length: 100 }, () => ({ event: 'labeled' }));
    expect((await tick()).incomplete).toBe(true); expect(events()).toEqual([]);
    expect(gh.mock.calls.filter(([a]) => a[1].includes('/timeline')).length).toBe(3);
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator must inspect/);
  });
  it('oversized job evidence refuses and names the operator fallback', async () => {
    checks = Array.from({ length: 100 }, (_, id) => job(id));
    expect((await tick()).incomplete).toBe(true); expect(events()).toEqual([]);
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator must inspect/);
  });
  it('resolves and logs the three environment settings with scalar validators', () => {
    const env = { WE_PR_MERGE_WATCH_NO_PROGRESS_DRAFT_MINUTES: '300',
      WE_PR_MERGE_WATCH_NO_PROGRESS_MINUTES: '200', WE_PR_MERGE_WATCH_CI_JOB_OVERDUE_FACTOR: '3' };
    expect(resolveMergeWatchSettings({ env, log })).toMatchObject({ noProgressDraftMinutes: 300, noProgressMinutes: 200, ciJobOverdueFactor: 3 });
    for (const [key, value] of Object.entries({ noProgressDraftMinutes: 300, noProgressMinutes: 200, ciJobOverdueFactor: 3 })) {
      expect(log.mock.calls.flat().join(' ')).toContain(`${key}=${value} (env)`);
    }
    expect(resolveMergeWatchSettings({ env: { ...env, WE_PR_MERGE_WATCH_CI_JOB_OVERDUE_FACTOR: '0' }, log }).ciJobOverdueFactor).toBe(2);
  });
});


it('counts timestamped repeat markers without expanding unbounded log output', async () => {
  writeFileSync(join(root, 'logs/review-daemon.log'),
    `${at(-1)} (repeated 10 times since ${at(-20)}) review-daemon: ${repo}#17 skipped — draft\n`);
  expect(await tick()).toEqual({ delivered: 1, incomplete: false });
  expect(events()[0]).toMatchObject({ kind: 'pr-looping', detail: { count: 10 } });
});
