// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RESOURCE_POLICY_STANDARD } from '../../lib/resource-admission.mjs';
import { assessResourceStatus, renderResourceStatus, resourceStatusOperation } from '../resource-status.mjs';

const raw = {
  snapshot: { sampledAt: '2026-10-09T22:31:02Z', freshUntil: '2026-10-09T22:31:32Z',
    cpu: { idlePct: 37, cores: 12, loadAvg: [63, 51.7, 48.7] }, memory: { pressureLevel: 1 },
    disk: { busyPct: 100, ioDepth: 3.2, readMBps: 56.9, writeMBps: 3.1 },
    fsevents: { fseventsdCpuPct: 178, backlog: null }, heavySlots: { held: 1, cap: 2 },
    agentSessions: { total: 5, claude: 4, codex: 1 }, laneCount: 127 },
  policy: RESOURCE_POLICY_STANDARD, sources: { platform: '/platform.json', tool: '/tool.json' },
  nowMs: Date.parse('2026-10-09T22:31:06Z'),
};
describe('resource status', () => {
  it('admits build using CPU idle despite high load, and assesses every policy kind', () => {
    const assessed = assessResourceStatus(raw);
    expect(assessed.verdicts.build).toMatchObject({ verdict: 'admit', unknown: false });
    expect(Object.keys(assessed.verdicts)).toHaveLength(8);
    const text = renderResourceStatus(assessed);
    for (const term of ['cpu idle 37%', 'disk busy 100%', 'fseventsd cpu 178%', 'comparison only',
      '2026-10-09 18:31:02 ET', 'age 4s', 'fresh until 18:31:32 ET', 'platform /platform.json', 'tool /tool.json']) expect(text).toContain(term);
  });
  it('holds heavy kinds and admits light kinds on a stale snapshot', () => {
    const assessed = assessResourceStatus({ ...raw, nowMs: raw.nowMs + 60000 });
    for (const [kind, rule] of Object.entries(raw.policy)) {
      if (kind === 'staleGraceMs') continue;
      expect(assessed.verdicts[kind]).toMatchObject({ verdict: rule.class === 'heavy' ? 'hold' : 'admit', unknown: true });
    }
    expect(renderResourceStatus(assessed)).toContain('stale');
  });
  it('reports missing snapshots and still shows unknown verdicts', () => {
    const text = renderResourceStatus(assessResourceStatus({ ...raw, snapshot: null }));
    expect(text).toContain('snapshot missing'); expect(text).toContain('unknown'); expect(text).toContain('verdicts');
  });
  it('uses policy stale grace consistently with admission', () => {
    const assessed = assessResourceStatus({ ...raw, nowMs: raw.nowMs + 60000, policy: { ...raw.policy, staleGraceMs: 60000 } });
    expect(assessed.freshness).toBe('fresh'); expect(assessed.verdicts.build.unknown).toBe(false);
  });
  it('requires an injected reader', () => { expect(() => resourceStatusOperation()).toThrow(/collect/); });
});
