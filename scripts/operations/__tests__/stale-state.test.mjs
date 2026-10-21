import { describe, it, expect, vi } from 'vitest';
import { staleStateOperation } from '../stale-state.mjs';
import { createStaleStateReader } from '../stale-state-io.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';

const at = '2026-09-15T12:00:00.000Z';
function fixture({ leases = [], claims = {}, runs = {}, probe = () => false, ahead = '0' } = {}) {
  const run = vi.fn((bin, argv, opts) => {
    expect(opts.env.GIT_OPTIONAL_LOCKS).toBe('0');
    if (bin === 'git') {
      expect(argv).toEqual(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
      if (ahead instanceof Error) throw ahead;
      return ahead;
    }
    expect(argv).toEqual(['/fixture/scripts/lane-pool.mjs', 'status', '--json']);
    return JSON.stringify({ lanes: leases });
  });
  const read = createStaleStateReader({
    root: '/fixture', run, now: () => Date.parse(at), host: 'here', probe,
    listFiles: () => Object.keys(claims),
    readText: (path) => claims[path.split('/').at(-1)],
    readClaim: ({ ref }) => {
      const file = Object.keys(claims).find((f) => f.startsWith(`${ref}-`));
      return { found: true, content: claims[file], status: 'active', rel: `backlog/${file}` };
    },
    runStore: { list: () => Object.keys(runs), read: (id) => {
      if (runs[id] instanceof Error) throw runs[id];
      return runs[id];
    } },
  });
  const declaration = staleStateOperation({ readState: read });
  return { run, read, declaration };
}
const lease = (extra = {}, clean = true) => ({
  path: '/pool/lane-1', clean, behind: 0, leased: false,
  lease: { session: 'worker', pid: 11, agentPid: 22, host: 'here', acquiredAt: '2026-09-15T11:00:00.000Z', ...extra },
});
async function invoke(declaration) {
  const registry = createRegistry();
  registry.register(declaration);
  const result = await runOperationCli({ declaration, registry, argv: ['--json'],
    store: createMemoryRunStore(), sinks: {}, newRunId: () => 'test-stale-state' });
  expect(result.code).toBe(0);
  return JSON.parse(result.lines.join('\n')).verdict;
}

describe('stale-state — observed liveness, no cleanup', () => {
  it('reports a live owner with observation and age', async () => {
    const { declaration } = fixture({ leases: [lease()], probe: () => true });
    expect(isReadOnlyOperation(declaration)).toBe(true);
    expect(declaration.steps.map(({ step }) => step.kind)).toEqual(['compute', 'compute']);
    expect((await invoke(declaration)).records[0]).toMatchObject({ kind: 'lane-lease',
      owner: 'worker', pid: 11, pidChecked: true, pidAlive: true, verdict: 'live', ageMs: 3600000 });
  });
  it('reports a dead lease owner with no observed unsafe work', async () => {
    const { declaration } = fixture({ leases: [lease()] });
    expect((await invoke(declaration)).records[0]).toMatchObject({ verdict: 'dead', hasUnsafeWork: false });
  });
  it.each([['dirty', false, '0'], ['unpushed', true, '2']])('separates dead owners with %s work', async (_, clean, ahead) => {
    const { declaration } = fixture({ leases: [lease({}, clean)], ahead });
    expect((await invoke(declaration)).records[0]).toMatchObject({ verdict: 'dead', hasUnsafeWork: true });
  });
  it('never treats a null pid as dead, even if a probe would return false', async () => {
    const probe = vi.fn(() => false);
    const { declaration } = fixture({ leases: [lease({ pid: null, agentPid: null })], probe });
    expect((await invoke(declaration)).records[0]).toMatchObject({ verdict: 'unknown', pid: null, pidChecked: false, pidAlive: null });
    expect(probe).not.toHaveBeenCalled();
  });
  it('does not confuse the dead acquire process with the owner', async () => {
    const { declaration } = fixture({ leases: [lease({ agentPid: undefined })] });
    expect((await invoke(declaration)).records[0]).toMatchObject({ verdict: 'unknown', pidAlive: false, ownerPidAlive: null });
  });
  it('keeps foreign-host and failed probes unknown', async () => {
    for (const extra of [{ host: 'elsewhere' }, {}]) {
      const { declaration } = fixture({ leases: [lease(extra)], probe: () => { throw new Error('unreadable'); } });
      expect((await invoke(declaration)).records[0].verdict).toBe('unknown');
    }
  });
  it('keeps work safety unknown when the ahead probe fails', async () => {
    const { declaration } = fixture({ leases: [lease()], ahead: new Error('git failed') });
    expect((await invoke(declaration)).records[0].hasUnsafeWork).toBeNull();
  });
  it('runs the ahead probe in a lane under lane Git hardening, never a bare process env', async () => {
    const { run, read } = fixture({ leases: [lease()] });
    vi.stubEnv('GIT_EXTERNAL_DIFF', 'echo inherited');
    try { read(); } finally { vi.unstubAllEnvs(); }
    const [, , opts] = run.mock.calls.find(([bin]) => bin === 'git');
    const pins = Object.entries(opts.env).filter(([k]) => k.startsWith('GIT_CONFIG_KEY_')).map(([, v]) => v);
    expect(pins).toEqual(expect.arrayContaining(['core.fsmonitor', 'core.hooksPath']));
    expect(opts.env.GIT_EXTERNAL_DIFF).toBeUndefined();
    expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(opts.env.GIT_OPTIONAL_LOCKS).toBe('0');
  });
  it('enumerates claims and all runs, retaining missing and corrupt evidence', async () => {
    const { declaration } = fixture({
      claims: { '123-active.md': '---\nstatus: active\nclaimedBy: person\ndateStarted: 2026-09-14\n---\n',
        '124-open.md': '---\nstatus: open\n---\n' },
      runs: { 'run-a': { op: 'claim', pid: null, effects: [], stepTimings: [] }, 'run-b': new Error('corrupt') },
    });
    const result = await invoke(declaration);
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({ kind: 'claim', owner: 'person', verdict: 'unknown', hasUnsafeWork: null });
    expect(result.records.slice(1).map((r) => r.verdict)).toEqual(['unknown', 'unknown']);
    expect(result.gaps.join('\n')).toContain('corrupt');
  });
  it('reports source failures instead of claiming the inventory is complete', () => {
    const read = createStaleStateReader({ run: () => { throw new Error('status failed'); },
      listFiles: () => { throw new Error('backlog failed'); }, runStore: { list: () => { throw new Error('runs failed'); } } });
    expect(read().gaps.join('\n')).toMatch(/status failed[\s\S]*backlog failed[\s\S]*runs failed/);
  });
  it('refuses a malformed injected reader', () => {
    expect(() => staleStateOperation()).toThrow(/reader/);
    const declaration = staleStateOperation({ readState: () => null });
    expect(() => declaration.steps[0].step.fn({})).toThrow(/records/);
  });
});
