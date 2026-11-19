// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decideMqSameHead, mqSameHeadGuard } from '../drain-queue-safety.mjs';
import { readMqInfraJobs } from '../drain-mq-infra-evidence.mjs';
import { added, head, infraFixture, repo, commit } from './fixtures/drain-mq-infra.mjs';

describe('merge-group infrastructure same-head requeue', () => {
  const classify = f => readMqInfraJobs({ checks: f.checks, repo, commit,
    removedAt: Date.parse(f.events[1].createdAt), aggregateJobs: ['test', 'coverage-merge'],
    readJson: path => JSON.parse(f.exec('gh', ['api', `repos/${repo}/${path}`])),
    readLog: path => f.exec('gh', ['api', `repos/${repo}/${path}`]),
  });

  it('classifies the real #7103 cancelled integration and test needs integration as infra-jobs directly', () => {
    const f = infraFixture(mqSameHeadGuard, { checkConclusion: 'cancelled' });
    expect(classify(f)).toEqual({ infra: 'infra-jobs', infraNames: ['integration'], derivedNames: ['test'] });
    expect(f.calls.filter(([, args]) => args[1]?.endsWith('/135261064381/logs'))).toHaveLength(1);
    expect(f.calls.some(([, args]) => args[1] === `repos/${repo}/contents/.github/workflows/ci.yml?ref=${commit}`)).toBe(true);
  });

  it.each(['assertion failure', 'unreadable', 'unrelated needs'])(
    'direct cancelled-check classification retains its strict %s veto', kind => {
      const f = infraFixture(mqSameHeadGuard, { checkConclusion: 'cancelled' });
      if (kind === 'assertion failure') f.logs[135261064381] = 'assertion failure\nProcess completed with exit code 1';
      if (kind === 'unreadable') delete f.logs[135261064381];
      if (kind === 'unrelated needs') f.workflow = 'jobs:\n  integration:\n    timeout-minutes: 20\n  test:\n    needs: other\n';
      expect(classify(f)).toEqual({ logReason: expect.stringContaining('operator must inspect failed jobs and enqueue manually') });
    });

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
      f.mainRuns[0].conclusion = 'failure';
      f.logs[135261064381] = 'Real-git integration suite\n';
      expect(f.guard().hold).toBe(true);
      expect(f.lines[1]).toBe(`mq-same-head-retry-declined: #7103 head ${head} — main CI is not green (newest completed run 9 concluded failure); failed check(s): integration, test; derived aggregates skipped: test; main run 9`);
      // The supplied job facts alone cannot identify the live gate: cancelled checks took a different path.
      const cancelled = infraFixture(legacy.mqSameHeadGuard, { checkConclusion: 'cancelled' });
      expect(cancelled.guard().hold).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['cancelled', 'timed_out'])('re-enqueues once for a 20-minute %s job, timed_out check and derived test, with green main', conclusion => {
    const f = infraFixture(mqSameHeadGuard);
    f.jobs[135261064381].conclusion = conclusion;
    expect(f.guard().hold).toBe(false);
    expect(f.lines).toEqual([expect.stringMatching(/^mq-same-head-retry:.*infrastructure retry 1\/1.*INFRA: integration.*derived aggregates skipped: test/)]);
    expect(f.calls.filter(([, args]) => args.some(arg => /\/logs$/.test(arg)))).toHaveLength(1);
    expect(f.calls.some(([, args]) => args.includes('POST'))).toBe(false);
    expect(f.calls.filter(([, args]) => args[1]?.includes('/actions/workflows/'))).toHaveLength(2);
    expect(f.calls.length).toBeLessThanOrEqual(12);
    f.events.push(added());
    expect(f.guard().hold).toBe(true); // A manual withdrawal cannot restore the allowance.
  });

  it.each([undefined, false])('holds infrastructure evidence without affirmative main green (%s), including old mainNotFailing state', mainGreen => {
    const f = infraFixture(mqSameHeadGuard);
    expect(decideMqSameHead({ pr: 7103, head, timeline: { nodes: f.events, hasPreviousPage: false },
      retryEvidence: { infra: 'infra-jobs', infraNames: ['integration'], mergeState: 'CLEAN', mainGreen, mainNotFailing: true } }).hold).toBe(true);
  });

  it('retries once when the deciding main run is fresh and successful', () => {
    const f = infraFixture(mqSameHeadGuard);
    expect(f.guard().hold).toBe(false);
    expect(f.calls.filter(([, args]) => args[1]?.includes('/actions/workflows/'))).toHaveLength(2);
    f.secondFailure();
    expect(f.guard().hold).toBe(true);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'in_progress'])('holds real failing main even with a newer %s run', state => {
    const f = infraFixture(mqSameHeadGuard);
    f.mainRuns[0].conclusion = 'failure';
    if (state !== 'failure') f.mainRuns.unshift({ ...f.mainRuns[0], id: 10,
      status: state === 'in_progress' ? state : 'completed', conclusion: state === 'in_progress' ? null : state,
      created_at: '2026-11-18T01:40:00Z', updated_at: '2026-11-18T01:50:00Z' });
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('main CI is not green');
    expect(f.lines.some(line => line.startsWith('mq-same-head-retry:'))).toBe(false);
  });

  it.each(['cancelled', 'timed_out', 'in_progress', 'pending', 'queued'])('holds when main has only a %s run', state => {
    const f = infraFixture(mqSameHeadGuard);
    const completed = ['cancelled', 'timed_out'].includes(state);
    Object.assign(f.mainRuns[0], { status: completed ? 'completed' : state, conclusion: completed ? state : null });
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('main CI is not green');
    expect(f.lines.join('\n')).toContain('operator must inspect main CI');
  });

  it('uses the shared main ordering: a pending push can coexist with a fresh deciding success', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.mainRuns.unshift({ ...f.mainRuns[0], id: 10, status: 'in_progress', conclusion: null,
      created_at: '2026-11-18T01:40:00Z' });
    expect(f.guard().hold).toBe(false);
    expect(f.lines[0]).toContain('main run 9');
  });

  it.each(['created', 'updated', 'both', 'future'])('holds %s main age evidence, including month-old success on current main HEAD', kind => {
    const f = infraFixture(mqSameHeadGuard);
    f.mainHead = f.mainRuns[0].head_sha = 'd'.repeat(40);
    if (kind === 'created' || kind === 'both') f.mainRuns[0].created_at = '2026-10-18T00:00:00Z';
    if (kind === 'updated' || kind === 'both') f.mainRuns[0].updated_at = '2026-10-18T00:30:00Z';
    if (kind === 'future') f.mainRuns[0].updated_at = '2026-11-19T00:30:00Z';
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('main CI is not green');
    expect(f.lines.join('\n')).toContain('within 24h');
  });

  it('retains the shared 2h freshness rule when main HEAD cannot be read', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.mainRuns[0].updated_at = '2026-11-17T23:00:00Z';
    f.mainRuns[0].created_at = '2026-11-17T22:00:00Z';
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('stale (older than 2h)');
  });

  it.each([0, 1])('bounds current-main HEAD age at exactly 24h (+%sms)', extra => {
    const f = infraFixture(mqSameHeadGuard);
    f.mainHead = f.mainRuns[0].head_sha = 'd'.repeat(40);
    f.mainRuns[0].created_at = f.mainRuns[0].updated_at = new Date(Date.parse('2026-11-17T02:00:00Z') - extra).toISOString();
    expect(f.guard().hold).toBe(extra > 0);
  });

  it.each([
    ['unreadable', f => { f.mainError = true; }],
    ['incomplete', f => { f.mainTotal = 2; }],
    ['malformed', f => { f.mainRuns[0].path = 'other.yml'; }],
    ['missing', f => { f.mainRuns = []; }],
  ])('holds %s main CI evidence and names the manual fallback', (_kind, change) => {
    const f = infraFixture(mqSameHeadGuard);
    change(f);
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('main CI evidence unreadable or incomplete');
    expect(f.lines.join('\n')).toContain('operator must inspect main CI and enqueue manually');
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

  it('preserves the legacy main-green cancellation retry without reading Actions evidence', () => {
    const f = infraFixture(mqSameHeadGuard, { checkConclusion: 'cancelled' });
    f.checks.pop();
    expect(f.guard().hold).toBe(false);
    expect(f.calls.filter(([, args]) => args[1]?.includes('/actions/workflows/'))).toHaveLength(2);
    expect(f.calls.some(([, args]) => /\/actions\/(?:jobs|runs)\//.test(args[1] ?? ''))).toBe(false);
    expect(f.lines[0]).not.toContain('derived aggregates skipped');
    // Legacy cancellation permits two retries; the third removal exhausts that allowance.
    f.secondFailure();
    f.secondFailure();
    expect(f.guard().hold).toBe(true);
  });

  it('accepts a complete run finalized after ejection while all failed jobs and checks finished before it', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.runs[44434828048].updated_at = '2026-11-18T01:31:00Z';
    expect(f.guard().hold).toBe(false);
  });

  it('directly classifies a timed-out aggregate job as intrinsic infrastructure rather than a derived failure', () => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[1].conclusion = f.jobs[135269693446].conclusion = 'timed_out';
    f.jobs[135269693446].steps[1].conclusion = 'timed_out';
    expect(classify(f)).toEqual({ infra: 'infra-jobs', infraNames: ['integration', 'test'], derivedNames: [] });
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

  it.each(['annotation', 'log'])('recognizes positive timeout %s evidence while rejecting unreadable evidence', kind => {
    const f = infraFixture(mqSameHeadGuard);
    f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
    f.jobs[135261064381].steps[1].conclusion = 'failure';
    f.checks[0].output.annotations_count = 1;
    f.annotations = [{ message: kind === 'annotation' ? 'The job has exceeded the time limit' : 'Execution interrupted' }];
    f.logs[135261064381] = kind === 'log' ? 'The job has exceeded the time limit' : 'Execution interrupted.';
    expect(f.guard().hold).toBe(false);
    f.annotations = [];
    expect(f.guard().hold).toBe(true);
  });

  it.each(['cancelled', 'timed_out'])('recognizes duration-only %s without failed steps using the tested workflow timeout', conclusion => {
    const f = infraFixture(mqSameHeadGuard);
    f.jobs[135261064381].conclusion = conclusion;
    expect(f.guard().hold).toBe(false);
    expect(f.calls.some(([, args]) => args[1]?.includes('contents/.github/workflows/ci.yml?ref='))).toBe(true);
    f.workflow = 'jobs:\n  integration:\n    timeout-minutes: 25\n';
    expect(f.guard().hold).toBe(true);
  });

  describe.each(['cancelled', 'timed_out'])('%s job logs without failed step metadata', conclusion => {
    it.each(['assertion failure\nProcess completed with exit code 1', 'expected', 'expect(', 'test', 'tests',
      '✓', '✔', '✗', '×', 'FAIL', 'exit code 2', 'exit-code: 42', 'exit code -1'])('vetoes %s anywhere in the whole log', failure => {
      const f = infraFixture(mqSameHeadGuard);
      f.jobs[135261064381].conclusion = conclusion;
      f.logs[135261064381] = `${failure}\n${'x'.repeat(70 * 1024)}\nThe job has exceeded the time limit`;
      expect(f.guard().hold).toBe(true);
      expect(f.lines.join('\n')).toContain('non-infrastructure failed job');
      expect(f.calls.filter(([, args]) => args[1]?.endsWith('/135261064381/logs'))).toHaveLength(1);
    });

    it.each(['unreadable', 'empty', 'oversized'])('holds %s whole-log evidence with the manual fallback', kind => {
      const f = infraFixture(mqSameHeadGuard);
      f.jobs[135261064381].conclusion = conclusion;
      if (kind === 'unreadable') delete f.logs[135261064381];
      if (kind === 'empty') f.logs[135261064381] = '';
      if (kind === 'oversized') f.logs[135261064381] = 'x'.repeat(4 * 1024 * 1024);
      expect(f.guard().hold).toBe(true);
      expect(f.lines.join('\n')).toContain('operator must inspect failed jobs and enqueue manually');
    });
  });

  describe.each(['test', 'coverage-merge'])('%s aggregate dependency causality', aggregate => {
    const configure = f => {
      f.checks[1].name = f.jobs[135269693446].name = aggregate;
      f.jobs[135269693446].steps[1].name = aggregate === 'test' ? 'Gate on shard results' : 'Require successful shards';
    };
    it.each(['integration', '[integration]'])('accepts only an infra job in its resolved needs (%s)', needs => {
      const f = infraFixture(mqSameHeadGuard);
      configure(f);
      f.workflow = `jobs:\n  integration:\n    timeout-minutes: 20\n  ${aggregate}:\n    needs: ${needs}\n`;
      expect(f.guard().hold).toBe(false);
      expect(f.calls.filter(([, args]) => args[1]?.includes('contents/.github/workflows/ci.yml?ref='))).toHaveLength(1);
    });

    it('declines skipped unit shards when an unrelated integration job timed out', () => {
      const f = infraFixture(mqSameHeadGuard);
      configure(f);
      f.workflow = `jobs:\n  integration:\n    timeout-minutes: 20\n  test-shard: {}\n  ${aggregate}:\n    needs: [test-shard]\n`;
      f.checks.push({ ...f.checks[0], id: 3, name: 'test-shard', conclusion: 'skipped',
        details_url: f.checks[0].details_url.replace('135261064381', '3') });
      expect(f.guard().hold).toBe(true);
      expect(f.lines.join('\n')).toContain('derived aggregate needs do not trace to infrastructure failure');
    });

    it.each(['missing', 'expression', 'unknown', 'absent check', 'other run', 'ambiguous', 'unreadable', 'oversized'])('fails closed for %s workflow needs', kind => {
      const f = infraFixture(mqSameHeadGuard);
      configure(f);
      f.jobs[135261064381].steps[1].conclusion = 'cancelled'; // Isolate graph validation from timeout lookup.
      const needs = { missing: '', expression: '    needs: "${{ inputs.jobs }}"\n', unknown: '    needs: unknown\n',
        'absent check': '    needs: missing\n', 'other run': '    needs: integration\n', ambiguous: '    needs: integration\n' };
      f.workflow = `jobs:\n  integration: {}\n  missing: {}\n  ${aggregate}:\n${needs[kind] ?? ''}`;
      if (kind === 'other run') f.checks[0].details_url = f.checks[0].details_url.replace('44434828048', '555');
      if (kind === 'other run') {
        f.jobs[135261064381].run_id = 555;
        f.runs[555] = { ...f.runs[44434828048], id: 555 };
      }
      if (kind === 'ambiguous') f.workflow += `  duplicate:\n    name: ${aggregate}\n    needs: integration\n`;
      if (kind === 'unreadable') f.workflow = 'jobs: [';
      if (kind === 'oversized') f.workflow = '#'.repeat(128 * 1024 + 1);
      expect(f.guard().hold).toBe(true);
      expect(f.lines.join('\n')).toContain('operator must inspect failed jobs and enqueue manually');
    });

    it('declines a needed job that failed for a non-infrastructure reason despite another needed timeout', () => {
      const f = infraFixture(mqSameHeadGuard);
      configure(f);
      f.workflow = `jobs:\n  integration:\n    timeout-minutes: 20\n  unit: {}\n  ${aggregate}:\n    needs: [integration, unit]\n`;
      f.checks.push({ ...f.checks[0], id: 3, name: 'unit', conclusion: 'failure',
        details_url: f.checks[0].details_url.replace('135261064381', '3') });
      f.jobs[3] = { ...f.jobs[135261064381], id: 3, name: 'unit', conclusion: 'failure' };
      f.logs[3] = 'assertion failure\nProcess completed with exit code 1';
      expect(f.guard().hold).toBe(true);
      expect(f.lines.join('\n')).toContain('non-infrastructure failed job');
    });
  });

  it.each([
    ['failure', false], ['failure', true], ['cancelled', true], ['timed_out', true],
  ])('holds elapsed-time-only %s with failed step=%s and invalid configuration', (conclusion, failedStep) => {
    const f = infraFixture(mqSameHeadGuard, { checkConclusion: conclusion === 'failure' ? conclusion : 'timed_out' });
    f.jobs[135261064381].conclusion = conclusion;
    if (failedStep) f.jobs[135261064381].steps[1].conclusion = 'failure';
    f.checks[0].output.annotations_count = 1;
    f.annotations = [{ message: 'Error: invalid configuration' }];
    f.logs[135261064381] = 'Error: invalid configuration';
    expect(f.guard().hold).toBe(true);
    expect(f.lines.join('\n')).toContain('non-infrastructure failed job');
    expect(f.calls.some(([, args]) => args[1]?.includes('contents/.github/workflows/ci.yml?ref='))).toBe(false);
  });

  it.each(['failure', 'cancelled', 'timed_out'])('accepts positive timeout text for %s with a failed step and no test failure', conclusion => {
    const f = infraFixture(mqSameHeadGuard, { checkConclusion: conclusion === 'failure' ? conclusion : 'timed_out' });
    f.jobs[135261064381].conclusion = conclusion;
    f.jobs[135261064381].steps[1].conclusion = 'failure';
    f.checks[0].output.summary = 'The job has exceeded the time limit';
    f.logs[135261064381] = 'Execution interrupted.';
    expect(f.guard().hold).toBe(false);
    f.secondFailure();
    expect(f.guard().hold).toBe(true);
  });

  describe.each(['output', 'annotations', 'logs'])('intrinsic failure veto in %s', source => {
    it.each(['assert', 'unexpected', 'expect(', 'test: 1 failed', 'tests: 1 failed', '✗ integration suite: 1 failed',
      '× integration suite: 1 failed', 'FAIL', 'Process completed with exit code 1'])('holds runner loss accompanied by %s', failure => {
      const f = infraFixture(mqSameHeadGuard);
      f.checks[0].conclusion = f.jobs[135261064381].conclusion = 'failure';
      f.jobs[135261064381].steps[1].conclusion = 'failure';
      f.checks[0].output.summary = 'Runner lost connection';
      f.logs[135261064381] = 'Execution interrupted.';
      if (source === 'output') f.checks[0].output.summary += ` ${failure}`;
      if (source === 'annotations') {
        f.checks[0].output.annotations_count = 1;
        f.annotations = [{ message: failure }];
      }
      if (source === 'logs') f.logs[135261064381] += `\n${failure}`;
      expect(f.guard().hold).toBe(true);
      expect(f.lines.join('\n')).toContain('non-infrastructure failed job');
      expect(f.lines.some(line => line.startsWith('mq-same-head-retry:'))).toBe(false);
    });
  });

  it('holds an oversized workflow timeout definition and names the manual fallback', () => {
    const f = infraFixture(mqSameHeadGuard);
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

  it('holds when nine runner-loss jobs plus their aggregate exhaust the shared 30-call API budget and names manual inspection', () => {
    const f = infraFixture(mqSameHeadGuard);
    const check = f.checks[0], aggregate = f.checks[1], job = f.jobs[135261064381], run = f.runs[44434828048];
    f.checks = Array.from({ length: 9 }, (_, i) => {
      const id = 100 + i, runId = 200 + i;
      f.jobs[id] = { ...job, id, run_id: runId, name: `runner-${i}`, conclusion: 'failure' };
      f.runs[runId] = { ...run, id: runId };
      f.logs[id] = 'Execution interrupted.';
      return { ...check, id, name: `runner-${i}`, conclusion: 'failure',
        details_url: `https://github.com/chalbert/web-everything/actions/runs/${runId}/job/${id}`,
        output: { summary: 'Runner lost connection' } };
    });
    f.checks.push(aggregate);
    expect(f.guard().hold).toBe(true);
    expect(f.calls.filter(([, args]) => args[0] === 'api' && args[1] !== 'graphql').length).toBeLessThanOrEqual(30);
    expect(f.lines.join('\n')).toContain('shared API budget may be exhausted');
    expect(f.lines.join('\n')).toContain('operator must inspect failed jobs and enqueue manually');
  });
});
