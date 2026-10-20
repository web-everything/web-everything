import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../main-ci-red-core.mjs';
import * as io from '../main-ci-red-io.mjs';
import smell from '../health-smells/main-ci-red.mjs';

// card 303: replay the recorded episode without touching live GitHub or ledgers.
const episode = JSON.parse(readFileSync('scripts/conveyor/__tests__/fixtures/main-ci-red-2026-10-14-group-evidence.json'));
const group = episode.mergeGroupRuns[0];
const tipSha = episode.mainRuns[0].headSha;
const isolated = { mainCiRedRerunCancelledTip: false, mainCiRedFlakeSignaturePattern: '' };
const settings = core.mainCiRedSettings(isolated);
const find = (extra = {}) => core.findMergeGroupFlakeEvidence({ groupRuns: [group], tipSha,
  failedJobs: ['integration', 'test'], jobsOf: (id) => episode.jobs[id] ?? null, settings, ...extra });

const isGroupList = (args) => args[0] === 'api' && /actions\/runs\?event=merge_group/.test(String(args[1]));
function host(t = '2026-10-14T06:26:00Z', overrides = {}) {
  return vi.fn((bin, args) => {
    if (args[0] === 'run' && args.includes('--branch')) return JSON.stringify(overrides.mainRuns ?? episode.mainRuns);
    if (isGroupList(args)) {
      if (overrides.groupError) throw new Error('unreadable groups');
      // The REST runs endpoint shape (merge-group runs are not listed under `--workflow ci.yml`, live 2026-10-20).
      return JSON.stringify({ workflow_runs: (overrides.groupRuns ?? episode.mergeGroupRuns).filter((r) => Date.parse(r.createdAt) <= Date.parse(t))
        .map((r) => Date.parse(r.updatedAt) > Date.parse(t) ? { ...r, status: 'in_progress', conclusion: null } : r)
        .map((r) => ({ id: r.databaseId, status: r.status, conclusion: r.conclusion, created_at: r.createdAt, updated_at: r.updatedAt,
          head_branch: r.headBranch, head_sha: r.headSha, event: 'merge_group', run_attempt: r.attempt, path: '.github/workflows/ci.yml' })) });
    }
    const path = args[1];
    const jobs = /\/runs\/(\d+)\/jobs/.exec(path);
    if (jobs) {
      if (overrides.jobsError && Number(jobs[1]) !== 38517676708) throw new Error('unreadable jobs');
      const rows = (overrides.jobs ?? episode.jobs)[jobs[1]] ?? [];
      return JSON.stringify({ total_count: rows.length + (overrides.incomplete && Number(jobs[1]) !== 38517676708 ? 1 : 0), jobs: rows });
    }
    if (path.endsWith('/commits/main')) return overrides.tipSha ?? tipSha;
    if (path.includes('/check-runs?')) return JSON.stringify({ check_runs: [] });
    if (path.includes('/annotations')) return '[]';
    if (path.endsWith('/logs')) return '';
    if (path.includes('/compare/')) return '["scripts/code.mjs"]';
    throw new Error(`Unexpected read: ${args.join(' ')}`);
  });
}
const probe = (exec, config = isolated) => io.probeMainCiRuns({ exec, config, settings: core.mainCiRedSettings(config), readRequired: () => ({ checks: ['test'] }) });
async function replay(t, config = isolated, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'c303-'));
  try {
    return await io.probeAndOwnMainCi({ dir, now: Date.parse(t), config, dryRun: true,
      readRuns: (opts) => io.probeMainCiRuns({ ...opts, exec: host(t, overrides), readRequired: () => ({ checks: ['test'] }) }),
      readPrs: () => [], listAgents: async () => [], gates: async () => ({ killed: true }) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('card 303 merge-group evidence', () => {
  it('parses only the requested queue branch and a full base SHA', () => {
    expect(core.parseMergeGroupBase(group.headBranch)).toBe(tipSha);
    for (const branch of [null, 'junk', group.headBranch.replace('/main/', '/other/'), group.headBranch.slice(0, -1), `${group.headBranch}/junk`]) {
      expect(core.parseMergeGroupBase(branch)).toBeNull();
    }
    expect(core.parseMergeGroupBase(group.headBranch.replace('/main/', '/release/v1/'), 'release/v1')).toBe(tipSha);
  });
  it('replays no rerun at 06:20 and flake rerun at 06:26, preserving cancelled-tip priority', async () => {
    expect((await replay('2026-10-14T06:20:00Z')).rerun).toBeUndefined();
    const after = await replay('2026-10-14T06:26:00Z');
    expect(after.rerun).toMatchObject({ runId: 38517676708, kind: 'flake', reason: 'merge-group-green-on-tip' });
    expect(after.failing.flake.groupEvidence.runId).toBe(38520623968);
    expect(after.failing.groupEvidence).toEqual(after.failing.flake.groupEvidence);
    expect(core.mainRedState(after.runs, { tip: after.tip }).status).toBe('red');
    expect((await replay('2026-10-14T06:26:00Z', {})).rerun.kind).toBe('cancelled-tip');
  });
  it('requires matching base, completed success, and all non-summary jobs', () => {
    expect(find()).toMatchObject({ runId: group.databaseId, baseSha: tipSha, completedAt: group.updatedAt, coveredJobs: ['integration'] });
    expect(find({ tipSha: tipSha.toUpperCase() })).not.toBeNull();
    expect(find({ tipSha: tipSha.slice(0, 7) })).not.toBeNull();
    for (const sha of [tipSha.slice(0, 6), 'a'.repeat(40), `${tipSha}0`]) expect(find({ tipSha: sha })).toBeNull();
    for (const jobs of [null, [], [{ name: 'integration', conclusion: 'skipped' }]]) expect(find({ jobsOf: () => jobs })).toBeNull();
    expect(find({ failedJobs: ['test', 'daemon-soak'] })).toBeNull();
    expect(find({ groupRuns: [{ ...group, status: 'in_progress' }] })).toBeNull();
    expect(find({ groupRuns: [{ ...group, conclusion: 'failure' }] })).toBeNull();
    expect(find({ groupRuns: [{ ...group, attempt: 2 }] })).not.toBeNull();
    expect(find({ settings: { ...settings, mainCiRedMergeGroupFlakeEvidence: false } })).toBeNull();
    const newer = { ...group, databaseId: 42, updatedAt: '2026-10-14T06:27:00Z' };
    expect(find({ groupRuns: [group, newer], jobsOf: () => episode.jobs[group.databaseId] }).runId).toBe(42);
    expect(find({ groupRuns: [newer, group], jobsOf: (id) => id === 42 ? null : episode.jobs[id] }).runId).toBe(group.databaseId);
  });
  it('keeps rerun guards ahead of evidence', async () => {
    const evidence = { runId: group.databaseId };
    expect(core.classifyFlakeRun({ run: { attempt: 2 }, groupEvidence: evidence, settings }).reason).toBe('already-rerun');
    expect(core.classifyFlakeRun({ groupEvidence: evidence, settings: { ...settings, mainCiRedFlakeRerun: false } }).reason).toBe('rerun-off');
    const mainRuns = episode.mainRuns.map((r) => r.databaseId === 38517676708 ? { ...r, attempt: 2 } : r);
    const result = await replay('2026-10-14T06:26:00Z', isolated, { mainRuns });
    expect(result.rerun).toBeUndefined();
    expect(result.failing.flake.reason).toBe('already-rerun');
  });
  it('bounds reads, reads the tip once, logs the setting source, and tolerates failures', () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exec = host();
      probe(exec, { ...isolated, mainCiRedMergeGroupFlakeEvidence: true });
      expect(exec.mock.calls.filter(([, args]) => isGroupList(args))).toHaveLength(1);
      expect(exec.mock.calls.filter(([, args]) => args[1]?.endsWith('/commits/main'))).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('source health)'));
      const candidates = [0, 1, 2].map((i) => ({ ...group, databaseId: 42 + i, updatedAt: `2026-10-14T06:2${5 - i}:00Z` }));
      const bounded = host(undefined, { groupRuns: candidates });
      probe(bounded);
      expect(bounded.mock.calls.filter(([, args]) => /\/runs\/4[234]\/jobs/.test(args[1]))).toHaveLength(2);
      for (const config of [{ ...isolated, mainCiRedMergeGroupFlakeEvidence: false }, { ...isolated, mainCiRedFlakeRerun: false }]) {
        const off = host();
        probe(off, config);
        expect(off.mock.calls.some(([, args]) => isGroupList(args))).toBe(false);
      }
      for (const overrides of [{ groupError: true }, { jobsError: true }, { incomplete: true }, { tipSha: 'a'.repeat(40) }]) {
        expect(probe(host(undefined, overrides)).failing.flake.eligible).toBe(false);
      }
    } finally { log.mockRestore(); }
  });
  it('reports evidence without removing any existing smell prose', () => {
    const result = probe(host());
    const evaluate = (mainCiRuns) => smell.evaluate({ mainCiRuns }, { now: Date.parse('2026-10-14T06:26:00Z'), config: {}, quarantineSafetyNet: null })[0];
    const withEvidence = evaluate(result);
    const without = evaluate({ ...result, failing: { ...result.failing, groupEvidence: null } });
    expect(withEvidence.measure.flakeEvidence).toEqual({ runId: group.databaseId, baseSha: tipSha, completedAt: group.updatedAt });
    expect(without.measure.flakeEvidence).toBeNull();
    expect(withEvidence.summary).toBe(`${without.summary.slice(0, -1)}; merge-group run ${group.databaseId} passed the failing jobs on the main tip — flake, re-run requested.`);
  });
  it('uses the same setting validity for source attribution', () => {
    const key = 'mainCiRedMergeGroupFlakeEvidence';
    for (const value of [true, false]) expect(core.mainCiRedSettingSource({ [key]: value }, key)).toBe('health');
    for (const value of [null, undefined, 'true', 1]) expect(core.mainCiRedSettingSource({ [key]: value }, key)).toBe('standard');
    expect(core.mainCiRedSettingSource({ mainCiRedMergeGroupRunLimit: 2 }, 'mainCiRedMergeGroupRunLimit')).toBe('health');
    expect(core.mainCiRedSettingSource({}, 'unknown')).toBe('standard');
  });
});
