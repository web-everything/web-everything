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
    const files = { readFileSync(path) {
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
        if (args[1].includes('/check-runs?')) return JSON.stringify(fixture.data.checks);
        if (args[1].includes('/actions/runs?')) return JSON.stringify(fixture.data.workflows);
      }
      throw new Error('unexpected IO');
    });
    const readers = createHotpatchReaders({ cwd: '/repo', env: { HOME: '/home/test', GIT_DIR: '/evil' }, files, exec });
    return { ...fixture, readers, files, exec, calls };
  }
  it('reads origin/main shard definitions and re-reads API evidence on each admission without loading or rebuilding', async () => {
    const f = production();
    expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'pass' });
    expect(f.calls.filter(c => c.command === 'gh')).toHaveLength(3);
    expect(f.calls.filter(c => c.command === 'git' && c.args[0] === 'fetch').map(c => c.args)).toEqual([['fetch', '--no-tags', 'origin', 'main', SHA]]);
    expect(f.calls.findIndex(c => c.args[0] === 'fetch')).toBeLessThan(f.calls.findIndex(c => c.args[0] === 'diff'));
    const next = production(); next.data.checks.check_runs[0].conclusion = 'failure';
    expect(await admitHotpatch(SHA, next.readers)).toMatchObject({ outcome: 'fail' });
    expect(f.calls.every(c => ['git', 'gh'].includes(c.command))).toBe(true);
  });
  it('unreadable main workflow and audit evidence stay unknown', async () => {
    for (const kind of ['workflow', 'audit']) {
      const f = production();
      if (kind === 'workflow') f.exec.mockImplementation(() => { throw new Error('read failed'); });
      else { const read = f.files.readFileSync; f.files.readFileSync = p => { if (p === '/home/test/audits') throw new Error('read failed'); return read(p); }; }
      expect(await admitHotpatch(SHA, f.readers)).toMatchObject({ outcome: 'unknown' });
    }
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
