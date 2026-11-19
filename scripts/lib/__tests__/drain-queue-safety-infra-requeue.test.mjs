// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mqSameHeadGuard } from '../drain-queue-safety.mjs';
import { added, head, infraFixture } from './fixtures/drain-mq-infra.mjs';

describe('merge-group infrastructure same-head requeue', () => {
  it('reproduces the legacy timed_out plus derived-test decline against red main offline', async () => {
    const sourceUrl = new URL('../drain-queue-safety.mjs', import.meta.url);
    // Disable only the new evidence path to replay the pre-fix reader/decision/decline functions.
    const source = readFileSync(sourceUrl, 'utf8')
      .replace(/const infraJobs = readMqInfraJobs\(\{ checks: rawChecks,[\s\S]*?\}\);/, 'const infraJobs = undefined;')
      .replace(/from '(\.[^']+)'/g, (_match, specifier) => `from '${new URL(specifier, sourceUrl).href}'`);
    const dir = mkdtempSync(join(tmpdir(), 'mq-infra-baseline-'));
    try {
      const file = join(dir, 'guard.mjs');
      writeFileSync(file, source);
      const legacy = await import(/* @vite-ignore */ pathToFileURL(file).href);
      const f = infraFixture(legacy.mqSameHeadGuard);
      f.logs[135261064381] = 'Real-git integration suite\n';
      expect(f.guard().hold).toBe(true);
      expect(f.lines[1]).toBe(`mq-same-head-retry-declined: #7103 head ${head} — main CI is not green (newest completed run 9 concluded failure); failed check(s): integration, test; derived aggregates skipped: test; main run 9`);
      // The supplied job facts alone cannot identify the live gate: cancelled checks took a different path.
      const cancelled = infraFixture(legacy.mqSameHeadGuard, { checkConclusion: 'cancelled' });
      expect(cancelled.guard().hold).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['cancelled', 'timed_out'])('re-enqueues once for a 20-minute cancelled job, %s check and derived test, despite red main', conclusion => {
    const f = infraFixture(mqSameHeadGuard, { checkConclusion: conclusion });
    expect(f.guard().hold).toBe(false);
    expect(f.lines).toEqual([expect.stringMatching(/^mq-same-head-retry:.*infrastructure retry 1\/1.*INFRA: integration.*derived aggregates skipped: test/)]);
    expect(f.calls.some(([, args]) => args.some(arg => /workflows\/ci.yml|\/logs|POST/.test(arg)))).toBe(false);
    expect(f.calls.length).toBeLessThanOrEqual(8);
    f.events.push(added());
    expect(f.guard().hold).toBe(true); // A manual withdrawal cannot restore the allowance.
  });

  it('holds the second infrastructure failure on the same head and alerts on the existing log channel', () => {
    const f = infraFixture(mqSameHeadGuard);
    expect(f.guard().hold).toBe(false);
    f.secondFailure();
    const held = f.guard();
    expect(held.hold).toBe(true);
    expect(held.reason).toContain('infrastructure requeue exhausted (1/1)');
    expect(f.lines.filter(line => line.startsWith('mq-infra-requeue-exhausted:'))).toEqual([
      expect.stringContaining(`head ${head} — automatic infrastructure retry 1/1 spent; operator must inspect`),
    ]);
    expect(f.lines.filter(line => line.startsWith('mq-same-head-retry:'))).toHaveLength(1);
  });

  it('retries a pure cancellation without aggregates once without consulting main', () => {
    const f = infraFixture(mqSameHeadGuard, { checkConclusion: 'cancelled' });
    f.checks.pop();
    expect(f.guard().hold).toBe(false);
    f.secondFailure();
    expect(f.guard().hold).toBe(true);
    expect(f.calls.some(([, args]) => args[1]?.includes('/workflows/'))).toBe(false);
  });

  it('accepts a complete run finalized after ejection while all failed jobs and checks finished before it', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.runs[44434828048].updated_at = '2026-11-18T01:31:00Z';
    expect(f.guard().hold).toBe(false);
  });

  it('treats a timed-out aggregate job as intrinsic infrastructure rather than a derived failure', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[1].conclusion = f.jobs[135269693446].conclusion = 'timed_out';
    f.jobs[135269693446].steps[1].conclusion = 'timed_out';
    expect(f.guard().hold).toBe(false);
    expect(f.lines[0]).toContain('INFRA: integration, test');
    expect(f.lines[0]).not.toContain('derived aggregates skipped');
  });

  it('holds a real failure with a test FAIL and exit code 1 even alongside cancellation and a derived aggregate', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks.push({ ...f.checks[0], id: 3, name: 'test-shard (1)', conclusion: 'failure',
      details_url: f.checks[0].details_url.replace('135261064381', '3'), output: { summary: 'FAIL assertion; Process completed with exit code 1.' } });
    f.jobs[3] = { ...f.jobs[135261064381], id: 3, name: 'test-shard (1)', conclusion: 'failure',
      steps: [{ name: 'Unit tests', status: 'completed', conclusion: 'failure' }] };
    f.logs[3] = 'FAIL assertion\nProcess completed with exit code 1.';
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('non-infrastructure failed job');
    expect(f.calls.some(([, args]) => args.includes('POST'))).toBe(false);
  });

  it.each(['timeout', 'runner-lost'])('accepts positive %s failure evidence with complete metadata and a log without intrinsic failures', kind => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
    f.checks[0].output.summary = kind === 'timeout' ? 'The job has exceeded the time limit' : 'Runner lost connection';
    f.logs[135261064381] = 'Execution interrupted by infrastructure.';
    expect(f.guard().hold).toBe(false);
    f.logs[135261064381] += '\nFAIL a test\nProcess completed with exit code 1.';
    expect(f.guard().hold).toBe(true);
  });

  it.each(['annotation', 'duration'])('recognizes timeout %s evidence while rejecting unreadable evidence', kind => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
    f.checks[0].output.annotations_count = 1;
    f.annotations = [{ message: kind === 'annotation' ? 'The job has exceeded the time limit' : 'Execution interrupted' }];
    f.logs[135261064381] = 'Execution interrupted.';
    expect(f.guard().hold).toBe(false);
    f.annotations = [];
    expect(f.guard().hold).toBe(true);
  });

  it('recognizes a duration-only timeout using timeout-minutes from the tested workflow', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
    f.logs[135261064381] = 'Execution interrupted.';
    expect(f.guard().hold).toBe(false);
    f.workflow = 'jobs:\n  integration:\n    timeout-minutes: 25\n';
    expect(f.guard().hold).toBe(true);
  });

  it('holds an oversized workflow timeout definition and names the manual fallback', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
    f.checks[0].output.annotations_count = 1;
    f.annotations = [{ message: 'Execution interrupted' }];
    f.workflow = '#'.repeat(128 * 1024 + 1);
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('128-KiB limit or is incomplete; operator must inspect');
  });

  it.each(['annotations', 'log'])('holds oversized %s evidence with an operator-visible fallback', kind => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
    f.checks[0].output.summary = 'Runner lost connection';
    f.checks[0].output.annotations_count = kind === 'annotations' ? 101 : 0;
    f.logs[135261064381] = 'x'.repeat(4 * 1024 * 1024);
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('operator must inspect failed jobs and enqueue manually');
  });

  it.each([
    ['unreadable check-runs', f => { f.checkError = true; }],
    ['incomplete check-runs', f => { f.checkTotal = 3; }],
    ['pending check', f => { f.checks[0].status = 'in_progress'; }],
    ['unreadable job', f => { delete f.jobs[135261064381]; }],
    ['incomplete job', f => { delete f.jobs[135261064381].completed_at; }],
    ['missing steps', f => { delete f.jobs[135261064381].steps; }],
    ['pending step', f => { f.jobs[135261064381].steps[1].status = 'in_progress'; }],
    ['intrinsic aggregate step', f => { f.jobs[135269693446].steps[0].conclusion = 'failure'; }],
    ['missing gate step', f => { f.jobs[135269693446].steps[1].name = 'Other failure'; }],
    ['unreadable run', f => { delete f.runs[44434828048]; }],
    ['incomplete run', f => { f.runs[44434828048].status = 'in_progress'; }],
    ['wrong head', f => { f.jobs[135261064381].head_sha = head; }],
    ['wrong run', f => { f.jobs[135261064381].run_id++; }],
    ['wrong attempt', f => { f.jobs[135261064381].run_attempt++; }],
    ['wrong workflow', f => { f.runs[44434828048].event = 'push'; }],
    ['not CLEAN', f => { f.live.mergeStateStatus = 'BEHIND'; }],
    ['unreadable PR state', f => { f.live = null; }],
    ['truncated timeline', f => { f.truncatedTimeline = true; }],
    ['completion at removal', f => { f.checks[0].completed_at = f.events[1].createdAt; }],
    ['failed rerun', f => { f.checks.push({ ...f.checks[0], id: 3, details_url: f.checks[0].details_url.replace('135261064381', '3') }); }],
  ])('fails closed for %s', (_kind, change) => {
    const f = infraFixture(mqSameHeadGuard);
    change(f);
    expect(f.guard().hold).toBe(true);
    expect(f.lines.some(line => line.startsWith('mq-same-head-retry:'))).toBe(false);
  });

  it('holds an oversized failed-job set with an operator-visible fallback', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks = Array.from({ length: 11 }, (_, i) => ({ ...f.checks[0], id: i + 1,
      name: `cancelled-${i}`, details_url: f.checks[0].details_url.replace('135261064381', String(100 + i)) }));
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('10-job limit; operator must inspect failed jobs and enqueue manually');
    expect(f.calls.some(([, args]) => args[1]?.includes('/actions/jobs/'))).toBe(false);
  });

  it('holds when ten runner-loss jobs exhaust the shared 30-call API budget and names manual inspection', () => {
    const f = infraFixture(mqSameHeadGuard);
    const check = f.checks[0], job = f.jobs[135261064381], run = f.runs[44434828048];
    f.checks = Array.from({ length: 10 }, (_, i) => {
      const id = 100 + i, runId = 200 + i;
      f.jobs[id] = { ...job, id, run_id: runId, name: `runner-${i}`, conclusion: 'failure' };
      f.runs[runId] = { ...run, id: runId };
      f.logs[id] = 'Execution interrupted.';
      return { ...check, id, name: `runner-${i}`, conclusion: 'failure',
        details_url: `https://github.com/chalbert/web-everything/actions/runs/${runId}/job/${id}`,
        output: { summary: 'Runner lost connection' } };
    });
    expect(f.guard().hold).toBe(true);
    expect(f.calls.filter(([, args]) => args[0] === 'api' && args[1] !== 'graphql').length).toBeLessThanOrEqual(30);
    expect(f.lines.join('\n')).toContain('shared API budget may be exhausted');
    expect(f.lines.join('\n')).toContain('operator must inspect failed jobs and enqueue manually');
  });
});
