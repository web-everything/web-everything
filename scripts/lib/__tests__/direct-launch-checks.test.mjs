/** Pin the direct-worker rejection ladder without spawning tests or models. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUDIT_QUESTION, auditArgv, parseAuditVerdict, runPostRunChecks, scopeVerdict } from '../direct-launch-checks.mjs';

const options = { dir: '/lane', base: 'base', weRoot: '/we', brief: 'Repair the bug', scope: ['we:src/a.js'], envelope: { maxFiles: 2, maxLoc: 20 } };
function fixture(overrides = {}) {
  const calls = [];
  const io = {
    diffPaths: () => { calls.push('paths'); return ['src/a.js']; },
    diffText: () => { calls.push('diff'); return 'the diff'; },
    numstat: () => { calls.push('numstat'); return '1\t1\tsrc/a.js'; },
    runTests: (_dir, paths) => { calls.push('test'); expect(paths).toEqual(['src/a.js']); return { ok: true }; },
    runAudit: argv => {
      calls.push('audit');
      const task = readFileSync(argv.find(a => a.startsWith('--task-file=')).slice(12), 'utf8');
      expect(task).toContain(AUDIT_QUESTION);
      expect(task).toContain('<task>\nRepair the bug\n</task>');
      expect(task).toContain('<material>\nthe diff\n</material>');
      return 'NOT WEAKENED\nChecks preserved';
    },
    ...overrides,
  };
  return { calls, io };
}

describe('parseAuditVerdict', () => {
  it.each(['NOT WEAKENED', '**NOT WEAKENED**', '\n # not weakened\nreason'])('accepts an explicit first-line clearance: %s', message => {
    expect(parseAuditVerdict(message).approved).toBe(true);
  });
  it('rejects WEAKENED with its reasons', () => expect(parseAuditVerdict('WEAKENED\nDeleted guard')).toMatchObject({ approved: false, verdict: 'weakened', reason: 'Deleted guard' }));
  it.each(['', undefined, 'Looks good', 'Explanation\nNOT WEAKENED', 'NOT WEAKENED extra'])('fails closed for unreadable verdict %s', message => {
    expect(parseAuditVerdict(message)).toMatchObject({ approved: false, verdict: 'unreadable' });
  });
});

describe('auditArgv', () => {
  it('uses the read-only direct seat shape without optional settings', () => {
    expect(auditArgv({ weRoot: '/we', dir: '/lane', taskFile: '/task', timeoutMs: 123 })).toEqual([
      '/we/scripts/codex-direct-task.mjs', '--task-file=/task', '--dir=/lane', '--review', '--json', '--no-stream', '--gate=none', '--timeout-ms=123', '--clear-rollout-after-run',
    ]);
  });
  it('adds model and effort only when given', () => {
    expect(auditArgv({ weRoot: '/we', dir: '/lane', taskFile: '/task', model: 'model', effort: 'high' }).slice(-2)).toEqual(['--model=model', '--effort=high']);
  });
});

describe('scopeVerdict', () => {
  const check = patch => scopeVerdict({ paths: ['src/a.js'], scope: ['we:src/a.js', 'src/b.js'], ...patch });
  it('accepts a qualified subset', () => expect(check({}).ok).toBe(true));
  it('rejects outside paths and foreign repo grants', () => {
    expect(check({ paths: ['src/c.js'] }).ok).toBe(false);
    expect(check({ scope: ['frontierui:src/a.js'] }).ok).toBe(false);
  });
  it('accepts directory prefixes with a slash boundary', () => {
    expect(check({ scope: ['src/'] }).ok).toBe(true);
    expect(check({ paths: ['src-other/a.js'], scope: ['src/'] }).ok).toBe(false);
  });
  it('fails closed on empty or malformed scope', () => {
    expect(check({ scope: [] }).ok).toBe(false);
    expect(check({ scope: [null] }).ok).toBe(false);
  });
  it('rejects envelope overflow and missing summary', () => {
    expect(check({ summary: { files: 1, loc: 21 }, envelope: options.envelope }).ok).toBe(false);
    expect(check({ summary: { files: 3, loc: 1 }, envelope: options.envelope }).ok).toBe(false);
    expect(check({ envelope: options.envelope }).ok).toBe(false);
  });
});

describe('runPostRunChecks', () => {
  it('runs test → audit → fresh scope and accepts', () => {
    const { io, calls } = fixture();
    expect(runPostRunChecks(options, io)).toMatchObject({ accepted: true, outcome: 'accepted', steps: [{ gate: 'test', ok: true }, { gate: 'audit', ok: true }, { gate: 'scope', ok: true }] });
    expect(calls).toEqual(['paths', 'test', 'diff', 'audit', 'paths', 'numstat']);
  });
  it('test failure stops before audit', () => {
    const { io, calls } = fixture({ runTests: () => ({ ok: false, reason: 'red test' }) });
    expect(runPostRunChecks(options, io)).toMatchObject({ outcome: 'rejected:test', reason: 'red test' });
    expect(calls).toEqual(['paths']);
  });
  it('audit silence fails closed before scope', () => {
    const { io, calls } = fixture({ runAudit: () => '' });
    expect(runPostRunChecks(options, io)).toMatchObject({ outcome: 'rejected:audit', reason: expect.stringContaining('unreadable') });
    expect(calls).not.toContain('numstat');
  });
  it('rejects an outside path discovered after audit', () => {
    let reads = 0;
    const { io } = fixture({ diffPaths: () => ++reads === 1 ? ['src/a.js'] : ['outside.js'] });
    expect(runPostRunChecks({ ...options, envelope: null }, io).outcome).toBe('rejected:scope');
  });
  it('diffPaths throwing is rejected:scope', () => {
    const { io } = fixture({ diffPaths: () => { throw new Error('git failed'); } });
    expect(runPostRunChecks(options, io).outcome).toBe('rejected:scope');
  });
  it.each(['runTests', 'runAudit', 'numstat'])('fails closed if %s throws', method => {
    const { io } = fixture({ [method]: () => { throw new Error('spawn failed'); } });
    expect(runPostRunChecks(options, io).outcome).toBe(`rejected:${({ runTests: 'test', runAudit: 'audit', numstat: 'scope' })[method]}`);
  });
  it('diffText throwing is rejected:scope', () => {
    const { io } = fixture({ diffText: () => { throw new Error('git failed'); } });
    expect(runPostRunChecks(options, io).outcome).toBe('rejected:scope');
  });
  it('rejects a failed scope re-read after a successful audit', () => {
    let reads = 0;
    const { io } = fixture({ diffPaths: () => { if (++reads === 2) throw new Error('git failed'); return ['src/a.js']; } });
    expect(runPostRunChecks(options, io).outcome).toBe('rejected:scope');
  });
  it('rejects malformed numstat rather than treating it as zero lines', () => {
    const { io } = fixture({ numstat: () => 'unreadable' });
    expect(runPostRunChecks(options, io).outcome).toBe('rejected:scope');
  });
  it('rejects envelope overflow for fallback to the existing route', () => {
    const { io } = fixture({ numstat: () => '100\t0\tsrc/a.js' });
    expect(runPostRunChecks(options, io)).toMatchObject({ outcome: 'rejected:scope', reason: expect.stringContaining('limit 20') });
  });
  it('documentation-only diff passes tests without spawning them', () => {
    const { io } = fixture({ diffPaths: () => ['docs/a.md'], numstat: () => '1\t0\tdocs/a.md', runTests: () => { throw new Error('must not run'); } });
    const result = runPostRunChecks({ ...options, scope: ['docs/'] }, io);
    expect(result.accepted).toBe(true);
    expect(result.steps[0].reason).toBe('no code paths changed');
  });
  it('refuses missing untracked line evidence under an envelope', () => {
    const { io } = fixture({ numstat: () => '' });
    expect(runPostRunChecks(options, io).outcome).toBe('rejected:scope');
  });
});
