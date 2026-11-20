// @vitest-environment node
/** PR #6014: quarantine must reach integration and soak test execution. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { quarantineSkip } from '../quarantine-skip.mjs';
import { addEntries } from '../../lib/red-main-quarantine.mjs';

const jobs = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs;
const now = Date.parse('2026-10-27T23:00:00Z');
const integrationFile = 'scripts/__tests__/lane-pool-acquire-base.test.mjs';
const soakFile = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs';
const otherFile = 'scripts/conveyor/soak/breaks/other.soak.test.mjs';
const soakName = '50 real daemon ticks: every invariant holds after every tick';

function skip(job, file, overrides = {}) {
  const list = addEntries(null, { tests: [file], job, brokenSha: 'a'.repeat(40), owner: 'red-main-safety-net',
    reason: 'repeat failures', actor: 'red-main-safety-net', now: now - 1000 }).list;
  return quarantineSkip({ env: {}, now, changed: [],
    read: { ok: true, list: { ...list, mode: 'quarantine', fixPrs: [6010] } },
    flags: { job, event: 'pull_request', ref: 'refs/pull/6014/merge' }, ...overrides });
}

describe('CI consumes quarantine for every automatically quarantined suite', () => {
  it.each([
    ['integration-part', 'Real-git integration suite', 'test:integration:vitest', 'integration', integrationFile],
    ['soak-shard', 'Soak shard', 'test:soak:shard', 'soak-shard (${{ matrix.shard }})', soakFile],
  ])('%s passes job-specific exclusions to its runner', (id, name, script, job, file) => {
    const step = jobs[id].steps.find((s) => s.name?.startsWith(name));
    expect(step.run).toContain(`$(node scripts/ci/quarantine-skip.mjs --job="${job}")`);
    expect(step.run).toMatch(new RegExp(`npm run ${script} -- `));
    const resolved = job.replace('${{ matrix.shard }}', '1');
    expect(skip(resolved, file).line).toBe(id === 'soak-shard' ? `--exclude=${file} --quarantined=${file}` : `--exclude=${file}`);
  });

  it('soak checkout is depth 50 plus blobless main so quarantine can prove changed files (else it fails closed)', () => {
    const steps = jobs['soak-shard'].steps;
    const i = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'));
    expect(steps[i].with?.['fetch-depth']).toBe(50);
    const fetch = steps[i + 1];
    expect(fetch.run).toBe('sh scripts/ci/fetch-main-history.sh');
    expect(fetch['timeout-minutes']).toBe(4);
    expect(fetch['continue-on-error']).toBeUndefined();
    const helper = readFileSync(new URL('../fetch-main-history.sh', import.meta.url), 'utf8');
    expect(helper).toMatch(/--filter=blob:none --depth=1000000 origin '\+refs\/heads\/main:refs\/remotes\/origin\/main'/);
  });

  it.each([['integration', integrationFile], ['soak-shard (1)', soakFile]])('%s retains fail-closed guards', (job, file) => {
    expect(skip(job, file, { changed: [file] }).skip).toEqual([]);
    expect(skip(job, file, { changed: null }).skip).toEqual([]);
    expect(skip(job, file, { read: { ok: false } }).line).toBe('');
    expect(skip(job, file, { now: now + 25 * 60 * 60 * 1000 }).skip).toEqual([]);
    for (const flags of [
      { job, event: 'push', ref: 'refs/heads/main' },
      { job, event: 'workflow_dispatch', ref: 'refs/heads/main' },
      { job, event: 'pull_request', ref: 'refs/pull/6010/merge' },
    ]) expect(skip(job, file, { flags }).skip).toEqual([]);
    expect(skip(job, `${file}::named failure`).skip).toEqual([]);
  });

  it.each(['integration', 'test-shard (1)', 'soak-shard (1)'])('%s never excludes a named entry even for a matching single test', (job) => {
    expect(skip(job, `${soakFile}::${soakName}`).skip).toEqual([]);
  });
});

// Exercise the actual soak CLI module, replacing only process execution and assignment.
const io = vi.hoisted(() => ({ spawn: vi.fn(), files: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: io.spawn, execFileSync: vi.fn() }));
vi.mock('../../conveyor/soak/shard-files.mjs', async (original) => ({ ...(await original()), shardFiles: io.files }));
vi.mock('../../readiness/heavy-admission.mjs', () => ({ admittedArgv: (file, args) => ({ file, args }) }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

async function runSoak(args, files = [soakFile, otherFile], status = 0) {
  vi.resetModules();
  io.files.mockReturnValue(files);
  io.spawn.mockReset().mockReturnValue({ status });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.argv = [process.execPath, 'scripts/conveyor/soak/run-shard.mjs', '--shard=1/8', ...args];
  await import('../../conveyor/soak/run-shard.mjs');
}

describe('soak CLI quarantine consumption', () => {
  it('removes the quarantined file after shard assignment and still runs the other file', async () => {
    await runSoak(skip('soak-shard (1)', soakFile).line.split(' '));
    expect(io.files).toHaveBeenCalledWith({ shard: 1, total: 8 });
    expect(io.spawn.mock.calls[0][1]).toEqual(['vitest', 'run', '--config', 'vitest.soak.config.ts', otherFile]);
  });
  it('a named soak quarantine keeps every assigned file running, including unrelated assertions', async () => {
    const { line } = skip('soak-shard (1)', `${soakFile}::${soakName}`);
    expect(line).toBe('');
    await runSoak(line ? [line] : []);
    expect(io.spawn.mock.calls[0][1]).toEqual(['vitest', 'run', '--config', 'vitest.soak.config.ts', soakFile, otherFile]);
  });
  it('a shard emptied by a generic --exclude FAILS (no green shard without assertions) and never invokes Vitest', async () => {
    await runSoak([`--exclude=${soakFile}`], [soakFile]);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('quarantined'));
  });
  it('a shard emptied ONLY by active job-tagged quarantine entries PASSES and names each file', async () => {
    const tagged = skip('soak-shard (1)', soakFile).line;
    expect(tagged).toBe(`--exclude=${soakFile} --quarantined=${soakFile}`);
    await runSoak(tagged.split(' '), [soakFile]);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(soakFile));
  });
  it('an untagged or expired entry yields no quarantined flag, so the emptied shard FAILS', async () => {
    const untagged = addEntries(null, { tests: [soakFile], brokenSha: 'a'.repeat(40), owner: 'red-main-safety-net',
      reason: 'repeat failures', actor: 'red-main-safety-net', now: now - 1000 }).list;
    const read = { ok: true, list: { ...untagged, mode: 'quarantine', fixPrs: [6010] } };
    const flags = { job: 'soak-shard (1)', event: 'pull_request', ref: 'refs/pull/6014/merge' };
    expect(quarantineSkip({ env: {}, now, changed: [], read, flags }).line).not.toContain('--quarantined=');
    expect(skip('soak-shard (1)', soakFile, { now: now + 10 * 24 * 3600 * 1000 }).line).not.toContain('--quarantined=');
    await runSoak([`--exclude=${soakFile}`], [soakFile]);
    expect(process.exitCode).toBe(1);
  });
  it('with no skips it runs the original assignment and preserves failures', async () => {
    await runSoak([], [soakFile, otherFile], 1);
    expect(io.spawn.mock.calls[0][1]).toEqual(['vitest', 'run', '--config', 'vitest.soak.config.ts', soakFile, otherFile]);
    expect(process.exitCode).toBe(1);
  });
  it('only exact assigned files are excluded, never globs or files in another shard', async () => {
    await runSoak(['--exclude=scripts/**', '--exclude=other-shard.soak.test.mjs']);
    expect(io.spawn.mock.calls[0][1]).toContain(soakFile);
    expect(io.spawn.mock.calls[0][1]).toContain(otherFile);
  });
});
