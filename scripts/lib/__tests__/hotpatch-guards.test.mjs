import { createHotpatchReaders } from '../hotpatch-readers.mjs';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { receiptGuard, auditGuard, ciDefinitionGuard, resolveHotpatchKnobs, admitHotpatch } from '../hotpatch-guards.mjs';
import { hotpatchFixture, HP_SHA as SHA } from './fixtures/hotpatch.mjs';
describe('hotpatch admission', () => {
  it('admits complete bound green CI and an own-sha canonical audit', async () => {
    expect(await admitHotpatch(SHA, hotpatchFixture().readers)).toMatchObject({ outcome: 'pass' });
  });
  it('a success test check from another app or an unbound workflow is not a receipt', async () => {
    for (const mutate of [d => { d.checks.check_runs[0].app.id = 1; }, d => { d.workflows.workflow_runs[0].path = '.github/workflows/other.yml'; }, d => { d.workflows.workflow_runs[0].head_sha = 'b'.repeat(40); }]) {
      const { data, readers } = hotpatchFixture(); mutate(data);
      expect((await receiptGuard(SHA, readers)).outcome).not.toBe('pass');
    }
  });
  it('no audit record and queued CI classify wait, never pass', async () => {
    const { data, readers } = hotpatchFixture(); data.audits = [];
    data.checks.check_runs[0].status = 'queued'; data.checks.check_runs[0].conclusion = null;
    expect(await admitHotpatch(SHA, readers)).toMatchObject({ outcome: 'wait' });
  });
  it('a failed rerun with a higher id beats an earlier success even with an older completed_at', async () => {
    const { data, readers } = hotpatchFixture();
    data.checks.check_runs.push({ ...data.checks.check_runs[0], id: 20, conclusion: 'failure', completed_at: '2000-01-01' }); data.checks.total_count++;
    expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'fail' });
  });
  it('a carried audit from an earlier head with the same fingerprint does not pass', async () => {
    const { data, readers } = hotpatchFixture(); data.audits[0].head = 'b'.repeat(40);
    data.audits[0].fingerprint = { hash: 'same' };
    expect(await auditGuard(SHA, readers)).toMatchObject({ outcome: 'wait' });
  });
  it('WEAKENED refuses and a ruling remains unverifiable', async () => {
    const { data, readers } = hotpatchFixture(); data.audits[0].verdict = 'WEAKENED'; data.audits[0].findings = ['security'];
    expect(await auditGuard(SHA, readers)).toMatchObject({ outcome: 'fail' });
    data.ruledWeakened = [{ sha: SHA, ref: `hotpatch/${SHA}`, ruling: 'R1', findings: ['security'] }];
    expect(await auditGuard(SHA, readers)).toMatchObject({ outcome: 'unknown', detail: 'hotpatch-audit-unverifiable' });
  });
  it.each(Object.keys(hotpatchFixture().readers))('each reader throwing yields unknown: %s', async key => {
    const { readers } = hotpatchFixture(); readers[key] = () => { throw new Error('unreadable'); };
    expect(await admitHotpatch(SHA, readers)).toMatchObject({ outcome: 'unknown' });
  });
  it.each(['.github/workflows/ci.yml', '.github/workflows/other.yml', 'scripts/ci/shards.mjs', 'vitest.unit.config.ts', 'package.json', 'package-lock.json'])('a PR editing %s is refused even with a green test check', async path => {
    const { data, readers } = hotpatchFixture(); data.paths = [path];
    expect(await ciDefinitionGuard(SHA, readers)).toMatchObject({ outcome: 'fail' });
    expect(await admitHotpatch(SHA, readers)).toMatchObject({ outcome: 'fail' });
  });
  it('skipped test-shard checks are not a receipt', async () => {
    const { data, readers } = hotpatchFixture(); data.checks.check_runs[1].conclusion = 'skipped';
    expect((await receiptGuard(SHA, readers)).outcome).not.toBe('pass');
  });
  it('permits the disabled visual job in an otherwise complete CI receipt', async () => {
    const { data, readers } = hotpatchFixture();
    data.checks.check_runs.push({ ...data.checks.check_runs[0], id: 50, name: 'visual', conclusion: 'skipped' });
    data.checks.total_count++;
    expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'pass' });
  });
  it.each(['test', 'test-shard (1)', 'test-shard (2)', 'smoke', 'daemon-soak'])(
    'still refuses skipped required job %s alongside disabled visual', async name => {
      const { data, readers } = hotpatchFixture();
      data.checks.check_runs.push({ ...data.checks.check_runs[0], id: 50, name: 'visual', conclusion: 'skipped' });
      data.checks.total_count++;
      data.checks.check_runs.find(check => check.name === name).conclusion = 'skipped';
      expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'fail' });
    },
  );
  it.each(['other job', 'other app', 'other suite', 'other head', 'queued', 'failed', 'neutral'])(
    'does not extend the disabled visual exception to %s', async kind => {
      const { data, readers } = hotpatchFixture();
      const check = { ...data.checks.check_runs[0], id: 50, name: 'visual', conclusion: 'skipped' };
      if (kind === 'other job') check.name = 'optional';
      if (kind === 'other app') check.app = { id: 1 };
      if (kind === 'other suite') check.check_suite = { id: 99 };
      if (kind === 'other head') check.head_sha = 'b'.repeat(40);
      if (kind === 'queued') { check.status = 'queued'; check.conclusion = null; }
      if (kind === 'failed') check.conclusion = 'failure';
      if (kind === 'neutral') check.conclusion = 'neutral';
      data.checks.check_runs.push(check); data.checks.total_count++;
      expect((await receiptGuard(SHA, readers)).outcome).not.toBe('pass');
    },
  );
  it('missing or queued shards wait and shards from another suite cannot fill gaps', async () => {
    const { data, readers } = hotpatchFixture(); data.checks.check_runs[1].check_suite = { id: 99 };
    expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'wait' });
  });
  it('oversized evidence is unknown with an operator fallback', async () => {
    const { data, readers } = hotpatchFixture(); data.checks.total_count = 101;
    expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'unknown', fallback: expect.any(String) });
  });
  it('resolves policy provenance and keeps unsafe values from admitting', async () => {
    const policy = resolveHotpatchKnobs({ platform: { parallel: false }, tool: { auditBar: 'anything' }, envValues: { liveWhen: 'during-ci' } });
    expect(policy.value).toMatchObject({ liveWhen: 'after-receipt-and-audit', auditBar: 'no-pr-introduced-security', receiptSource: 'ci-full-suite', parallel: false });
    expect(policy.sources.parallel).toBe('platform');
    const { data, readers } = hotpatchFixture(); data.settings = { tool: { receiptSource: 'anything' } };
    expect((await admitHotpatch(SHA, readers)).outcome).not.toBe('pass');
  });
});

describe('hotpatch production readers', () => {
  const workflow = 'jobs:\n  test-shard:\n    strategy:\n      matrix:\n        shard: [1, 2]\n    steps:\n      - run: vitest run --shard=${{ matrix.shard }}/${{ strategy.job-total }}';
  function production() {
    const fixture = hotpatchFixture(), calls = [];
    Object.assign(fixture.data.workflows.workflow_runs[0], { id: 70, status: 'completed', conclusion: 'success' });
    const job = (name, id, steps) => ({ name, id, head_sha: SHA, status: 'completed', conclusion: 'success',
      steps: steps.map(name => ({ name, status: 'completed', conclusion: 'success' })) });
    const jobs = [
      job('test-shard (1)', 8, ['Unit suite shard 1/2']),
      job('test-shard (2)', 9, ['Unit suite shard 2/2']),
      job('integration-part (daemon-core)', 20, ['Real-git integration suite (lane-pool, operations transport)']),
      job('soak-shard (1)', 21, ['Soak shard 1/1']),
      job('smoke', 11, ['Build WE docs (deploy smoke)', 'Interaction lane']),
    ];
    for (const j of jobs.filter(j => !fixture.data.checks.check_runs.some(c => c.name === j.name))) {
      fixture.data.checks.check_runs.push({ ...fixture.data.checks.check_runs[0], name: j.name, id: j.id });
      fixture.data.checks.total_count++;
    }
    const logs = Object.fromEntries(jobs.filter(j => j.name !== 'smoke')
      .map(j => [j.id, 'red-main-quarantine skip: redMainMode is stop (ops/quarantine) — running everything\n']));
    const files = { readFileSync(path) {
      path = String(path); // The policy resolver supplies a file URL.
      if (path.endsWith('/scripts/settings/codex-audit.json')) return JSON.stringify({ audit: { priorQuestionHashes: [] } });
      if (path.endsWith('/scripts/settings/hotpatch.json')) return JSON.stringify({ liveWhen: 'after-receipt-and-audit', auditBar: 'no-pr-introduced-security', receiptSource: 'ci-full-suite', parallel: true });
      if (path.endsWith('/scripts/settings/prototype-load.json')) return JSON.stringify({ auditRecordPath: '~/audits' });
      if (path === '/home/test/audits') return fixture.data.audits.map(r => JSON.stringify(r)).join('\n');
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } };
    const exec = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'git') {
        expect(options.env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' });
        expect(options.env.GIT_DIR).toBeUndefined();
        if (args[0] === 'fetch') return '';
        if (args[0] === 'rev-parse') return SHA;
        if (args[0] === 'remote') return 'https://github.com/org/repo.git';
        if (args[0] === 'show') { expect(args).toEqual(['show', 'origin/main:.github/workflows/ci.yml']); return workflow; }
        if (args[0] === 'diff' || args[0] === 'merge-base') return '';
      }
      if (command === 'gh') {
        if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'org/repo', url: 'https://github.com/org/repo' });
        const endpoint = args[1] === '--allow-escape-sequences' ? args[2] : args[1];
        if (endpoint.includes('/check-runs?')) return JSON.stringify(fixture.data.checks);
        if (endpoint.includes('/actions/runs?')) return JSON.stringify(fixture.data.workflows);
        if (endpoint === 'repos/org/repo/actions/runs/70/jobs?filter=all&per_page=100')
          return JSON.stringify({ total_count: jobs.length, jobs });
        const logId = /^repos\/org\/repo\/actions\/jobs\/(\d+)\/logs$/.exec(endpoint)?.[1];
        if (logId && Object.hasOwn(logs, logId)) return logs[logId];
      }
      throw new Error('unexpected IO');
    });
    const readers = createHotpatchReaders({ cwd: '/repo', env: { HOME: '/home/test', GIT_DIR: '/evil' }, files, exec });
    return { ...fixture, readers, files, exec, calls, jobs, logs };
  }
  it('reads origin/main shard definitions and re-reads API evidence on each admission without loading or rebuilding', async () => {
    const f = production();
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'pass' });
    expect(f.calls.filter(c => c.command === 'gh')).toHaveLength(8);
    const logs = f.calls.filter(c => c.command === 'gh' && c.args.some(arg => arg.endsWith('/logs')));
    expect(logs.map(c => c.args)).toEqual([8, 9, 20, 21].map(id =>
      ['api', '--allow-escape-sequences', `repos/org/repo/actions/jobs/${id}/logs`, '--hostname', 'github.com']));
    expect(logs.every(c => c.options.timeout === 30000 && c.options.maxBuffer === 2 * 1024 * 1024)).toBe(true);
    expect(f.calls.filter(c => c.command === 'git' && c.args[0] === 'fetch').map(c => c.args)).toEqual([['fetch', '--no-tags', 'origin', 'main', SHA]]);
    expect(f.calls.findIndex(c => c.args[0] === 'fetch')).toBeLessThan(f.calls.findIndex(c => c.args[0] === 'diff'));
    const next = production(); next.data.checks.check_runs[0].conclusion = 'failure';
    expect(await admitHotpatch(SHA, next.readers)).toMatchObject({ outcome: 'fail' });
    expect(f.calls.every(c => ['git', 'gh'].includes(c.command))).toBe(true);
  });
  it('production receipts refuse successful jobs whose suite step was skipped', async () => {
    const f = production(); f.jobs[0].steps[0].conclusion = 'skipped';
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown' });
  });
  it('production admission accepts disabled visual while proving required suite execution', async () => {
    const f = production();
    f.data.checks.check_runs.push({ ...f.data.checks.check_runs[0], id: 50, name: 'visual', conclusion: 'skipped' });
    f.data.checks.total_count++;
    f.jobs.push({ id: 50, name: 'visual', head_sha: SHA, status: 'completed', conclusion: 'skipped', steps: [] });
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'pass' });
    f.jobs[0].steps[0].conclusion = 'skipped';
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown', detail: 'hotpatch-full-suite-unproven' });
  });
  it('production receipts read escape-coded execution logs through the shared transport', async () => {
    const f = production(); f.logs[8] = `\x1b[32m${f.logs[8]}\x1b[0m`;
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'pass' });
    expect(f.calls.find(c => c.command === 'gh' && c.args.includes('repos/org/repo/actions/jobs/8/logs')).args)
      .toContain('--allow-escape-sequences');
  });
  it.each(['', '\x1b[31m'])('production receipts refuse quarantine exclusions in successful job logs (prefix=%j)', async prefix => {
    const f = production(); f.logs[8] = `${prefix}red-main-quarantine skip: quarantined → --exclude=guard.test.mjs\n`;
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown' });
  });
  it('unreadable production execution logs stay unknown', async () => {
    const f = production(); delete f.logs[8];
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown' });
    expect(f.calls.some(c => c.command === 'gh' && c.args.includes('repos/org/repo/actions/jobs/8/logs'))).toBe(true);
  });
  it('unreadable main workflow and audit evidence stay unknown', async () => {
    for (const kind of ['workflow', 'audit']) {
      const f = production();
      if (kind === 'workflow') f.exec.mockImplementation(() => { throw new Error('read failed'); });
      else { const read = f.files.readFileSync; f.files.readFileSync = p => { if (p === '/home/test/audits') throw new Error('read failed'); return read(p); }; }
      expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown' });
    }
  });
  it('R11: truncated newer negative ledger record is unknown', async () => {
    const f = production(), read = f.files.readFileSync;
    f.files.readFileSync = p => p === '/home/test/audits' ? read(p) + '\n{"verdict":"WEAKENED"' : read(p);
    expect(await auditGuard(SHA, f.readers)).toMatchObject({outcome: 'unknown'});
  });
  it('R12: unreadable prior-question policy is unknown', async () => {
    const f = production(), read = f.files.readFileSync;
    f.files.readFileSync = (p, e) => String(p).includes('codex-audit.json') ? (() => {throw new Error('unreadable policy');})() : read(p, e);
    expect(await auditGuard(SHA, f.readers)).toMatchObject({outcome: 'unknown'});
  });
  it('oversized audit ledger refuses with an archive fallback', async () => {
    const f = production(), read = f.files.readFileSync;
    f.files.readFileSync = p => p === '/home/test/audits' ? ' '.repeat(2 * 1024 * 1024 + 1) : read(p);
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown', fallback: expect.stringContaining('archive') });
  });
  it('keeps forbidden bypass vocabulary and lifecycle calls out of the guard', () => {
    const source = readFileSync('scripts/lib/hotpatch-guards.mjs', 'utf8');
    expect(source).not.toMatch(/hotPatchProvenance|hotPatchMode|vetoIgnore|urgent-verify/);
    expect(source).not.toMatch(/\b(?:plan|adopt|rebuild)\s*\(/);
  });
});

it('a queued rerun with a higher id supersedes an earlier success', async () => {
  const { data, readers } = hotpatchFixture();
  data.checks.check_runs.push({ ...data.checks.check_runs[0], id: 30, status: 'queued', conclusion: null }); data.checks.total_count++;
  expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'wait' });
});
it.each(['missing', 'queued'])('%s shards wait for a full receipt', async kind => {
  const { data, readers } = hotpatchFixture();
  if (kind === 'missing') { data.checks.check_runs.pop(); data.checks.total_count--; }
  else { data.checks.check_runs[1].status = 'queued'; data.checks.check_runs[1].conclusion = null; }
  expect(await receiptGuard(SHA, readers)).toMatchObject({ outcome: 'wait' });
});
it('malformed workflow evidence and duplicate check ids remain unknown', async () => {
  const a = hotpatchFixture(); a.data.workflows.workflow_runs.push({}); a.data.workflows.total_count++;
  expect(await receiptGuard(SHA, a.readers)).toMatchObject({ outcome: 'unknown' });
  const b = hotpatchFixture(); b.data.checks.check_runs[1].id = b.data.checks.check_runs[0].id;
  expect(await receiptGuard(SHA, b.readers)).toMatchObject({ outcome: 'unknown' });
});

// Canonical round-1 negatives: each case preserves an older green receipt.
describe('round-1 receipt and audit negatives', () => {
  it.each(['smoke', 'daemon-soak'])('R7: waits for independent %s', async name => {
    const {data, readers} = hotpatchFixture();
    data.checks.check_runs.push({...data.checks.check_runs[0], id: 50, name, status: 'in_progress', conclusion: null}); data.checks.total_count++;
    expect((await receiptGuard(SHA, readers)).outcome).not.toBe('pass');
  });
  it.each(['pending', 'unbound'])('R8: refuses another lower-ID %s test suite', async kind => {
    const {data, readers} = hotpatchFixture();
    data.checks.check_runs.push({...data.checks.check_runs[0], id: 1, check_suite: {id: 99}, ...(kind === 'pending' ? {status: 'queued', conclusion: null} : {})}); data.checks.total_count++;
    expect((await receiptGuard(SHA, readers)).outcome).not.toBe('pass');
  });
  it.each(['card-only', 'quarantine'])('R9: successful jobs without full execution (%s) are not receipts', async () => {
    const {readers} = hotpatchFixture(); readers.fullSuite = () => false;
    expect((await receiptGuard(SHA, readers)).outcome).not.toBe('pass');
  });
  it.each(['scripts/ci-card-only.mjs', 'vitest.shared.ts', 'scripts/hermetic-tests.settings.json'])('R10: refuses executable CI input %s', async path => {
    const {data, readers} = hotpatchFixture(); data.paths = [path];
    expect((await ciDefinitionGuard(SHA, readers)).outcome).toBe('fail');
  });
  it('R13: malformed contradictory findings cannot authorize an audit', async () => {
    const {data, readers} = hotpatchFixture(); data.audits[0].findings = 'WEAKENED';
    expect((await auditGuard(SHA, readers)).outcome).not.toBe('pass');
  });
});


it.each(['contradictory findings', 'invalid timestamp'])(
  'round-2: newer unusable WEAKENED on a passing SHA/base yields unknown: %s', async kind => {
    const { data, readers } = hotpatchFixture();
    const newer = { ...data.audits[0], verdict: 'WEAKENED', findings: ['guard weakened'] };
    if (kind === 'contradictory findings') newer.findings = ['NOT WEAKENED'];
    else newer.at = 'unreadable timestamp';
    data.audits.push(newer);
    expect(await auditGuard(SHA, readers)).toMatchObject({ outcome: 'unknown' });
    expect(await admitHotpatch(SHA, readers)).toMatchObject({ outcome: 'unknown' });
  },
);
