/** Card x4z1vez (Plateau /sessions S2) — the `sessions` operation: ended Claude jobs, review completions, window,
 *  subagent folding, live/ended dedupe, degraded[]. Fixture `jobs/` and `completions/` dirs, no real host reads. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseWindow, normalizeJob, endedJobToRow, reviewCompletionToRow, assembleSessions, sessionsOperation,
  REVIEW_HISTORY_GAP,
} from '../sessions.mjs';
import { createSessionHistoryReader } from '../sessions-io.mjs';

const NOW = Date.now();
const H = 3_600_000;
const ago = (h) => new Date(NOW - h * H).toISOString();
const job = (o) => ({
  sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', daemonShort: 'aaaaaaaa', name: 'fix-4271', state: 'done',
  detail: 'PR #4271 pushed', respawnFlags: ['--model', 'sonnet'], createdAt: ago(3), firstTerminalAt: ago(2),
  lastTerminalAt: ago(1.9), updatedAt: ago(1.9), children: [], ...o,
});
const live = (running = []) => ({ observedAt: new Date(NOW).toISOString(), running });
const liveRow = (o) => ({
  runId: 'x', kind: 'fix', workItem: null, pr: null, startedAt: ago(4), lastActivityAt: ago(0.1), state: 'working',
  reason: 'active', joinVia: 'name', weak: false, executor: 'claude', model: 'sonnet', name: 'fix-4271', lane: null, ...o,
});

describe('parseWindow', () => {
  it.each([['', 0], [undefined, 0], ['24h', 86_400_000], ['90m', 5_400_000], ['2d', 172_800_000]])('%s', (i, ms) => {
    expect(parseWindow(i)).toBe(ms);
  });
  it('rejects a typo instead of meaning "no history"', () => { expect(() => parseWindow('24 hours')).toThrow(/duration/); });
});

describe('endedJobToRow', () => {
  it('a done job with a PR child is pr-opened, with kind, PR, model, end time from firstTerminalAt', () => {
    const row = endedJobToRow(normalizeJob(job({ children: [{ id: '4271', kind: 'pr', href: 'https://github.com/web-everything/web-everything/pull/4271' }] })));
    expect(row).toMatchObject({ state: 'done', kind: 'fix', outcome: 'pr-opened', model: 'sonnet', executor: 'claude', endedAt: ago(2), pr: { repo: 'we', number: 4271 } });
  });
  it('a stopped job is stopped; a failed one is failed; a done one without a PR is no-pr', () => {
    expect(endedJobToRow(normalizeJob(job({ state: 'stopped' }))).outcome).toBe('stopped');
    expect(endedJobToRow(normalizeJob(job({ state: 'failed' }))).outcome).toBe('failed');
    expect(endedJobToRow(normalizeJob(job())).outcome).toBe('no-pr');
  });
  it('maps names to kinds, and a running job is not a row', () => {
    expect(endedJobToRow(normalizeJob(job({ name: 'prepare-item-4708' }))).kind).toBe('prepare');
    expect(endedJobToRow(normalizeJob(job({ name: 'conveyor-4412' }))).kind).toBe('build');
    expect(endedJobToRow(normalizeJob(job({ name: 'harness verify r' }))).kind).toBe('other');
    expect(endedJobToRow(normalizeJob(job({ state: 'running' })))).toBeNull();
  });
  it('tolerates junk records', () => { expect(normalizeJob(null)).toBeNull(); expect(normalizeJob({ state: 'done' })).toBeNull(); });
});

describe('assembleSessions', () => {
  const jobs = [
    normalizeJob(job()),
    normalizeJob(job({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', daemonShort: 'bbbbbbbb', name: 'ci-heal-9', firstTerminalAt: ago(25), updatedAt: ago(25) })),
  ];
  it('excludes a job that ended 25 h ago at a 24 h window, and returns no done rows with no window', () => {
    const r = assembleSessions({ live: live(), jobs, windowMs: 24 * H });
    expect(r.rows.map((x) => x.name)).toEqual(['fix-4271']);
    expect(assembleSessions({ live: live(), jobs, windowMs: 0 }).rows).toEqual([]);
  });
  it('shows a live row with an ended twin once, as done', () => {
    const r = assembleSessions({ live: live([liveRow({ runId: 'aaaaaaaa-0000-4000-8000-000000000001' })]), jobs, windowMs: 24 * H });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ state: 'done', joinVia: 'job' });
  });
  it('an ended twin never shows as live even outside the window', () => {
    const r = assembleSessions({ live: live([liveRow({ runId: 'aaaaaaaa-0000-4000-8000-000000000001' })]), jobs, windowMs: 0 });
    expect(r.rows).toEqual([]);
  });
  it('folds subagents into the parent count, not rows; sorts working before done', () => {
    const r = assembleSessions({
      live: live([liveRow({ runId: 'cccccccc', name: 'conveyor-5', kind: 'build' }), liveRow({ runId: 'cccccccc:agent-1', kind: 'subagent' }), liveRow({ runId: 'cccccccc:agent-2', kind: 'subagent' })]),
      jobs, windowMs: 24 * H,
    });
    expect(r.rows.map((x) => [x.name, x.state, x.subagents])).toEqual([['conveyor-5', 'working', 2], ['fix-4271', 'done', 0]]);
  });
  it('turns review completions into done review rows and drops the superseded live row', () => {
    const c = { kind: 'review', status: 'done', session: 'review-4368', pr: '4368', verdict: 'converged', runId: 'review-pr-1', startedAt: ago(1), updatedAt: ago(0.5) };
    expect(reviewCompletionToRow(c)).toMatchObject({ kind: 'review', outcome: 'verdict', pr: { repo: 'we', number: 4368 } });
    const r = assembleSessions({ live: live([liveRow({ runId: 'rj', kind: 'review', name: 'review-4368', lastActivityAt: ago(1) })]), reviews: [c], windowMs: 24 * H });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].state).toBe('done');
  });
});

describe('createSessionHistoryReader + operation (fixture dirs)', () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), 'sessions-'));
    const jobsDir = join(root, 'jobs'); const completionsDir = join(root, 'completions');
    mkdirSync(jobsDir); mkdirSync(completionsDir);
    const put = (id, s) => { mkdirSync(join(jobsDir, id)); writeFileSync(join(jobsDir, id, 'state.json'), JSON.stringify(s)); };
    put('j1', job());
    put('j2', job({ sessionId: 'dddddddd-0000-4000-8000-000000000004', daemonShort: 'dddddddd', name: 'ci-heal-5', state: 'stopped' }));
    mkdirSync(join(jobsDir, 'j3')); writeFileSync(join(jobsDir, 'j3', 'state.json'), '{not json');
    writeFileSync(join(completionsDir, 'review-7.json'), JSON.stringify({ kind: 'review', status: 'done', session: 'review-7', pr: '7', verdict: 'ok', updatedAt: ago(1) }));
    return { jobsDir, completionsDir };
  };
  it('reads jobs and review completions, skips a bad record, always logs the review-store gap until D6', () => {
    const { jobsDir, completionsDir } = dirs();
    const h = createSessionHistoryReader({ jobsDir, completionsDir })({ windowMs: 24 * H, now: Date.now() });
    expect(h.jobs).toHaveLength(2);
    expect(h.reviews).toHaveLength(1);
    expect(h.degraded).toEqual([REVIEW_HISTORY_GAP]);
  });
  it('marks degraded jobs when the folder is missing', () => {
    const h = createSessionHistoryReader({ jobsDir: '/nonexistent/jobs', completionsDir: '/nonexistent/c' })({ windowMs: 1, now: Date.now() });
    expect(h.degraded).toEqual(expect.arrayContaining(['jobs', 'review-completions']));
  });
  it('the declared operation needs both readers', () => {
    expect(sessionsOperation({ collectLive: () => live(), readHistory: () => ({ jobs: [], reviews: [], degraded: [] }) })).toBeTruthy();
    expect(() => sessionsOperation({})).toThrow(/needs/);
  });
});
