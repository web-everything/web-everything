import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createItemActivityReader } from '../item-activity-io.mjs';
import { createAgentActivityReader, projectSlugFor } from '../agent-activity-io.mjs';
import { writeJobRecord, listReviewJobAgents, jobLogPath, jobRecordPath } from '../review-job-store.mjs';
import { newCompletionRecord, applyCompletionUpdate, writeCompletion } from '../completion-store.mjs';
import { newRunRecord } from '../run-record.mjs';
import { writeRun } from '../run-store.mjs';

let root, jobsDir, completionsDir, runsDir, projectsDir;
const start = '2026-10-02T10:00:00Z';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'item-activity-'));
  [jobsDir, completionsDir, runsDir, projectsDir] = ['jobs', 'completions', 'runs', 'projects'].map((p) => join(root, p));
  for (const dir of [jobsDir, completionsDir, runsDir, projectsDir]) mkdirSync(dir);
  vi.stubEnv('OPERATION_REVIEW_JOBS_DIR', jobsDir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const completion = () => applyCompletionUpdate(newCompletionRecord({ session: 'review-42', kind: 'review', pr: 42, now: () => start }),
  { status: 'done', outcome: 'approved', runId: 'panel-42' }, () => '2026-10-02T11:00:00Z');
function reader(options = {}) {
  const readSources = createAgentActivityReader({ root, projectsDir, listAgents: () => [],
    listJobs: () => listReviewJobAgents({ dir: jobsDir }), run: () => '{"lanes":[]}' });
  return createItemActivityReader({ readSources, jobsDir, completionsDir, runsDir, projectsDir,
    metadata: [{ repo: 'we', prs: [{ number: 42, title: '#4198 activity', headRefName: 'lane/4198-activity' }] }], ...options });
}

describe('real stores, shared ingestion, and filesystem evidence', () => {
  it('soaks repeated live reads, prunes a dead pid, then retains natural terminal evidence with native juror pointers', () => {
    writeJobRecord({ slug: 'review-42', pr: 42, pid: process.pid, startedAt: start, cwd: root }, jobsDir);
    writeJobRecord({ slug: 'review-43', pr: 43, pid: 2147483647, startedAt: start, cwd: root }, jobsDir);
    writeFileSync(jobLogPath('review-42', jobsDir), 'actual job log\n');
    const logTime = new Date('2026-10-02T10:30:00Z');
    utimesSync(jobLogPath('review-42', jobsDir), logTime, logTime);
    const native = join(root, 'codex.jsonl');
    writeFileSync(native, '{"provider":"codex"}\n');
    const panel = newRunRecord({ id: 'panel-42', op: 'review-pr', input: { cwd: root } });
    panel.telemetry = [{ sessionId: 'codex-thread', lens: 'correctness', servedBackend: 'codex', transcriptFile: native },
      { sessionId: 'missing-native-thread', lens: 'security', servedBackend: 'codex' }];
    writeRun(panel, runsDir);
    const read = reader({ now: () => Date.parse('2026-10-02T10:31:00Z') });
    for (let i = 0; i < 25; i++) {
      const result = read({ pr: 42 });
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({ role: 'review', live: true, card: '4198', transcriptPath: jobLogPath('review-42', jobsDir), outcome: null });
      expect(result.runs[0].transcriptAgeMs).toBe(60_000);
      expect(result.runs[0].lastEventAt).toBe(logTime.toISOString());
    }
    expect(existsSync(jobRecordPath('review-43', jobsDir))).toBe(false);
    writeCompletion(completion(), completionsDir);
    expect(read({ pr: 42 }).runs).toHaveLength(1);
    rmSync(jobRecordPath('review-42', jobsDir));
    const after = read({ card: '4198' });
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({ live: false, outcome: 'approved', jurors: [
      { sessionId: 'codex-thread', transcriptPath: native }, { sessionId: 'missing-native-thread', transcriptPath: null },
    ] });
    expect(after.gaps.join(' ')).toMatch(/security: transcript unavailable/);
  });
  it('reads real Claude session transcripts and reports deleted/non-file evidence truthfully', () => {
    // Keep the session recent after deletion, when age falls back to startedAt.
    const now = () => Date.parse(start) + 60_000;
    const project = join(projectsDir, projectSlugFor(root)); mkdirSync(project);
    const transcript = join(project, 'session.jsonl'); writeFileSync(transcript, '{}\n');
    utimesSync(transcript, new Date(start), new Date(start));
    const readSources = createAgentActivityReader({ root, projectsDir, now, listAgents: () => [
      { sessionId: 'session', name: 'fix-42', cwd: root, state: 'working', startedAt: start }],
    listJobs: () => [], run: () => '{"lanes":[]}' });
    const read = reader({ readSources, now });
    expect(read({ pr: 42 }).runs[0].transcriptPath).toBe(transcript);
    rmSync(transcript);
    expect(read({ pr: 42 }).runs[0]).toMatchObject({ transcriptPath: null, lastEventAt: null, transcriptAgeMs: null });
    writeFileSync(join(completionsDir, 'review-42.json'), '{broken');
    expect(read({ pr: 42 }).gaps.join(' ')).toMatch(/completion unreadable/);
  });
  it('distinguishes metadata failure from empty and reads additional repo-qualified identities for cards', () => {
    const viewPr = vi.fn((repo, number) => ({ number, title: '#4198', headRefName: 'lane/4198-test' }));
    const listPrs = vi.fn(() => []);
    const readSources = () => ({ rows: [{ id: 'f', name: 'review-fui-42' }] });
    const read = reader({ metadata: undefined, readSources, viewPr, listPrs });
    expect(read({ card: '4198' }).runs[0].pr).toEqual({ repo: 'frontierui', number: 42 });
    expect(listPrs.mock.calls.map((c) => c[0])).toEqual(['we', 'frontierui', 'plateau-app']);
    expect(viewPr).toHaveBeenCalledWith('frontierui', 42);
    const fail = reader({ metadata: undefined, viewPr: () => { throw new Error('offline'); } });
    expect(fail({ pr: 42 })).toMatchObject({ runs: [], gaps: [expect.stringContaining('metadata unavailable')] });
    expect(reader()({ pr: 999 })).toEqual({ runs: [], gaps: [] });
  });
  it('supplied maps/metadata never use network, including completion-only card selection', () => {
    const exec = vi.fn(() => { throw new Error('network forbidden'); });
    writeCompletion(completion(), completionsDir);
    expect(reader({ exec })({ pr: 42 }).runs[0].card).toBe('4198');
    expect(reader({ exec, metadata: undefined, prToCard: { 'we:42': '1234' } })({ card: '1234' }).runs).toHaveLength(1);
    expect(exec).not.toHaveBeenCalled();
  });
  it('keeps real concurrent fixer/job rows and only advertises readable nested Claude evidence', () => {
    writeJobRecord({ slug: 'review-42', pr: 42, pid: process.pid, startedAt: start, cwd: root }, jobsDir);
    writeFileSync(jobLogPath('review-42', jobsDir), 'review log');
    const project = join(projectsDir, projectSlugFor(root)); mkdirSync(project);
    const jurorPath = join(project, 'judge-session.jsonl'); writeFileSync(jurorPath, '{}\n');
    writeFileSync(join(project, 'fix-session.jsonl'), '{}\n');
    const run = newRunRecord({ id: 'panel-42', op: 'review-pr', input: { cwd: root } });
    run.telemetry = [{ servedBackend: 'claude', sessionId: 'judge-session', lens: 'design' }];
    writeRun(run, runsDir); writeCompletion(completion(), completionsDir);
    const readSources = createAgentActivityReader({ root, projectsDir,
      listAgents: () => [{ sessionId: 'fix-session', name: 'fix-42', cwd: root, state: 'working', startedAt: start }],
      listJobs: () => listReviewJobAgents({ dir: jobsDir }), run: () => '{"lanes":[]}' });
    const read = reader({ readSources });
    const result = read({ card: '4198' });
    expect(result.runs.map((r) => r.role)).toEqual(['fix', 'review']);
    expect(result.runs[1].jurors[0].transcriptPath).toBe(jurorPath);
    rmSync(jurorPath);
    expect(read({ pr: 42 }).runs[1].jurors[0].transcriptPath).toBeNull();
    rmSync(join(runsDir, 'panel-42.json'));
    expect(read({ pr: 42 }).gaps.join(' ')).toMatch(/run record missing/);
  });

  it('bulk-reads branch-only card candidates and avoids one view per historical completion', () => {
    writeCompletion(completion(), completionsDir);
    const exec = vi.fn((_cmd, args) => {
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      expect(args).not.toContain('--search');
      return JSON.stringify([{ number: 42, title: 'Unnumbered title', headRefName: 'lane/4198-work' }]);
    });
    const result = reader({ metadata: undefined, exec })({ card: '4198' });
    expect(result.runs).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls.map(([, args]) => args[3])).toEqual([
      'web-everything/web-everything', 'frontier-ui/frontierui', 'plateauapp/plateau-app',
    ]);
  });

});
