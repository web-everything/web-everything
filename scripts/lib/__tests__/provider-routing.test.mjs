/**
 * @file provider-routing.test.mjs — unit tests for scripts/lib/provider-routing.mjs (#3690).
 *
 * Verifies:
 *   - Pure, deterministic execution (identical inputs -> deep-equal results).
 *   - Provider recommendation cascade: Gemini fit, Codex fit, Both (high-stakes & thin history),
 *     and Claude fallback at Haiku, Sonnet, and Opus tiers.
 *   - Default agy Claude alternates: native identity/reliability vetoes, audit entries and determinism.
 *   - Statute-tier paths strictly force Claude Opus regardless of external model track record.
 *   - Supervision level backdown plan (#3690): clean streak counting, informative trial gating,
 *     calibration-miss hard veto on most recent record, and 'other'-verified skipping.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  selectProvider,
  selectProbationWorker,
  selectSupervisionLevel,
  isStatuteTierPath,
  isHighStakesTask,
  isWithinProvenEnvelope,
  RECOMMENDATIONS,
  CLAUDE_TIERS,
  AGY_CLAUDE_MODEL_BY_TIER,
  SUPERVISION_LEVELS,
  DEFAULT_BACKDOWN_THRESHOLDS,
  PROVEN_TASK_ENVELOPES,
  THIN_TRIAL_THRESHOLD,
  workerTierFor,
  DISPATCH_MACHINERY_PATHS,
  EXTERNAL_WORKER_CANDIDATES,
  externalTierEquivalent,
  CRITICAL_WORK_GATE,
  PROBATION_ROSTER,
} from '../provider-routing.mjs';
import { CODEX_MODEL } from '../codex-model-routing.mjs';

describe('probation availability audit', () => {
  it.each(['antigravity-argon', 'antigravity', 'codex'])('keeps the worker held without coercing malformed %s hold values', (key) => {
    for (const held of [{ toString: null }, [{ toString: null }]]) {
      const context = {
        kind: 'build', filesTouched: ['a.mjs'], estimatedSize: 40,
        criticalWork: { critical: false, reasons: [] }, criticalMisses: [],
        availability: { [key]: held },
        argonSettings: { value: { enabled: true, model: 'gemini-4-argon-high' }, sources: {} },
      };
      const direct = selectProbationWorker({ taskType: 'build-new-feature', ...context });
      const routed = selectProvider({ taskType: 'build-new-feature' }, context);
      for (const result of [direct, routed]) {
        const worker = 'worker' in result ? result.worker : result.probationWorker;
        expect(worker?.id).not.toBe('antigravity-argon');
        expect(worker?.id ?? null).toBe(key === 'codex' ? null : 'codex');
        expect(result.auditTrail).toContainEqual(expect.objectContaining({
          criterion: 'probation-candidate:antigravity-argon', result: 'quota-held',
          dataConsulted: '<object>',
        }));
      }
    }
  });
});

// ── Fixture Scorecard Helpers ──────────────────────────────────────────────────

function makeRecord({
  provider = 'codex',
  model = 'gpt-6-astra',
  taskType = 'bugfix',
  scoredAt = '2026-09-15T01:00:00.000Z',
  outcome = 'landed',
  verifiedBy = 'claude-subagent',
  findings = null,
  taskDescription = 'Test delegation task',
  pr = null,
  handle = null,
  subjectClass = 'work-agent',
  informative = false,
  rootCause = null,
} = {}) {
  return {
    v: 1,
    provider,
    model,
    taskType,
    scoredAt,
    outcome,
    verifiedBy,
    findings,
    taskDescription,
    pr,
    handle,
    subjectClass,
    informative,
    rootCause,
    dispatchKind: 'session-delegation',
  };
}

describe('provider-routing — header states the router\'s reach (#3798)', () => {
  // The ratified "Reach" rule (platform-decisions.md#delegation-trial-record-graduation): mechanical
  // provider routing binds the mechanical dispatch path only; an interactive loop keeps its own verdict.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../provider-routing.mjs'), 'utf8');
  const header = source.slice(0, source.indexOf('*/'));
  // Comment prose wraps across lines: collapse the ` * ` gutters and whitespace before matching.
  const prose = header.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

  it('#3798 — the header comment says the reach is "the mechanical dispatch path only" and no longer claims to serve interactive sessions', () => {
    expect(source.trimStart().startsWith('/**')).toBe(true);
    expect(prose).toContain('the mechanical dispatch path only');
    expect(prose).not.toContain('both interactive Claude Code sessions');
    expect(prose).not.toMatch(/pre-dispatch check before picking a subagent/);
    // An interactive loop keeps its own verdict; the router may inform it, never replace it.
    expect(prose).toContain('the router may inform that verdict, never replace it');
  });
});

describe('provider-routing — constants and helpers', () => {
  it('freezes enum objects', () => {
    expect(Object.isFrozen(RECOMMENDATIONS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_TIERS)).toBe(true);
    expect(Object.isFrozen(SUPERVISION_LEVELS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BACKDOWN_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(PROVEN_TASK_ENVELOPES)).toBe(true);
  });

  describe('isStatuteTierPath', () => {
    it('identifies platform-decisions.md as statute-tier', () => {
      expect(isStatuteTierPath('docs/agent/platform-decisions.md')).toBe(true);
      expect(isStatuteTierPath('./docs/agent/platform-decisions.md')).toBe(true);
      expect(isStatuteTierPath('/docs/agent/platform-decisions.md')).toBe(true);
    });

    it('identifies any path under docs/agent/ as statute-tier', () => {
      expect(isStatuteTierPath('docs/agent/conventions.md')).toBe(true);
      expect(isStatuteTierPath('docs/agent/statute-additions.md')).toBe(true);
      expect(isStatuteTierPath('docs/agent/testing.md')).toBe(true);
    });

    it('returns false for non-statute paths', () => {
      expect(isStatuteTierPath('scripts/lib/provider-routing.mjs')).toBe(false);
      expect(isStatuteTierPath('src/index.njk')).toBe(false);
      expect(isStatuteTierPath('README.md')).toBe(false);
      expect(isStatuteTierPath('')).toBe(false);
      expect(isStatuteTierPath(null)).toBe(false);
    });
  });

  describe('isWithinProvenEnvelope', () => {
    it('accepts doc-fix within 100 LOC and 2 files', () => {
      expect(isWithinProvenEnvelope('doc-fix', 50, 1)).toBe(true);
      expect(isWithinProvenEnvelope('doc-fix', 100, 2)).toBe(true);
      expect(isWithinProvenEnvelope('doc-fix', 150, 1)).toBe(false);
      expect(isWithinProvenEnvelope('doc-fix', 50, 3)).toBe(false);
    });

    it('accepts bugfix within 250 LOC and 4 files', () => {
      expect(isWithinProvenEnvelope('bugfix', 200, 3)).toBe(true);
      expect(isWithinProvenEnvelope('bugfix', 250, 4)).toBe(true);
      expect(isWithinProvenEnvelope('bugfix', 260, 2)).toBe(false);
      expect(isWithinProvenEnvelope('bugfix', 100, 5)).toBe(false);
    });
  });

  describe('isHighStakesTask', () => {
    it('returns false if not bugfix or conflict-resolution', () => {
      expect(isHighStakesTask({ taskType: 'doc-fix' }, { filesTouched: ['scripts/lib/foo.test.mjs', 'scripts/conveyor/run.mjs'] })).toBe(false);
    });

    it('returns false if no test file is touched', () => {
      expect(isHighStakesTask({ taskType: 'bugfix' }, { filesTouched: ['scripts/conveyor/run.mjs'] })).toBe(false);
    });

    it('returns false if only test files are touched without critical subsystem or 3+ impl files', () => {
      expect(isHighStakesTask({ taskType: 'bugfix' }, { filesTouched: ['tests/foo.test.js'] })).toBe(false);
      expect(isHighStakesTask({ taskType: 'bugfix' }, { filesTouched: ['tests/foo.test.js', 'demos/foo.js'] })).toBe(false);
    });

    it('returns true if test file AND critical subsystem (e.g. scripts/conveyor/) are touched', () => {
      expect(isHighStakesTask(
        { taskType: 'bugfix' },
        { filesTouched: ['scripts/lib/__tests__/foo.test.mjs', 'scripts/conveyor/runner.mjs'] }
      )).toBe(true);
    });

    it('returns true if test file AND core blocks/plugs standards paths are touched', () => {
      expect(isHighStakesTask(
        { taskType: 'conflict-resolution' },
        { filesTouched: ['blocks/nav/nav.test.ts', 'blocks/nav/nav.ts'] }
      )).toBe(true);
    });

    it('returns true if test file AND 3+ implementation files are touched', () => {
      expect(isHighStakesTask(
        { taskType: 'bugfix' },
        { filesTouched: ['tests/app.spec.ts', 'demos/a.js', 'demos/b.js', 'demos/c.js'] }
      )).toBe(true);
    });
  });
});

describe('selectProvider — cascade branches', () => {
  it('determinism: produces byte-identical return values on identical inputs', () => {
    const task = { description: 'Fix parser bug', taskType: 'bugfix' };
    const context = {
      filesTouched: ['scripts/lib/parser.mjs'],
      estimatedSize: 80,
      scorecards: [
        makeRecord({ provider: 'gemini', model: 'gemini-3.1-pro', taskType: 'bugfix', findings: null }),
      ],
    };

    const res1 = selectProvider(task, context);
    const res2 = selectProvider(task, context);

    expect(res1).toEqual(res2);
    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
  });

  // Branch 1: Gemini Fit
  it('branch 1: recommends gemini when gemini is fit with a clean verified track record', () => {
    const task = { description: 'Fix tokenizer regex', taskType: 'bugfix' };
    const scorecards = [
      makeRecord({
        provider: 'gemini',
        model: 'gemini-3.1-pro',
        taskType: 'bugfix',
        scoredAt: '2026-09-15T01:00:00.000Z',
        verifiedBy: 'claude-subagent',
        findings: null,
      }),
    ];
    const context = {
      filesTouched: ['scripts/lib/tokenizer.mjs'],
      estimatedSize: 45,
      scorecards,
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.GEMINI);
    expect(res.claudeTier).toBeNull();
    expect(res.auditTrail[0].result).toBe('fit');
    expect(res.reasoning).toContain('Gemini is fit');
  });

  // Branch 2: Codex Fit
  it('branch 2: recommends codex when gemini is unfit but codex has a clean track record', () => {
    const task = { description: 'Fix buffer allocation', taskType: 'bugfix' };
    const scorecards = [
      // Gemini has an unverified trial (only 'other')
      makeRecord({
        provider: 'antigravity',
        model: 'gemini-3.1-pro',
        taskType: 'bugfix',
        scoredAt: '2026-09-15T01:00:00.000Z',
        verifiedBy: 'other',
        findings: null,
      }),
      // Codex has a clean claude-verified trial
      makeRecord({
        provider: 'codex',
        model: 'gpt-6-astra',
        taskType: 'bugfix',
        scoredAt: '2026-09-15T02:00:00.000Z',
        verifiedBy: 'claude-subagent',
        findings: null,
      }),
    ];
    const context = {
      filesTouched: ['scripts/lib/buffer.mjs'],
      estimatedSize: 60,
      scorecards,
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CODEX);
    expect(res.claudeTier).toBeNull();
    expect(res.auditTrail[0].result).toBe('unfit'); // Gemini unfit
    expect(res.auditTrail[1].result).toBe('fit'); // Codex fit
    expect(res.reasoning).toContain('Codex is fit');
  });

  // Branch 3: Both Together (High-Stakes)
  it('branch 3 (high-stakes): recommends both when task is high-stakes and single providers do not fit', () => {
    const task = { description: 'Resolve conveyor deadlock during drain pass', taskType: 'bugfix' };
    const scorecards = [
      // Codex has an unresolved finding on its most recent trial for bugfix
      makeRecord({
        provider: 'codex',
        model: 'gpt-6-astra',
        taskType: 'bugfix',
        scoredAt: '2026-09-15T04:00:00.000Z',
        verifiedBy: 'independent-claude',
        outcome: 'reworked',
        findings: 'Deadlock detection race condition in worker loop',
      }),
    ];
    const context = {
      filesTouched: [
        'scripts/conveyor/drain.mjs',
        'scripts/conveyor/__tests__/drain.test.mjs',
      ],
      estimatedSize: 120,
      scorecards,
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.BOTH);
    expect(res.claudeTier).toBeNull();
    expect(res.auditTrail.find((a) => a.criterion === 'both-together')?.result).toBe('fit');
    expect(res.reasoning).toContain('Both Gemini and Codex are recommended');
  });

  // Branch 3: Both Together (Thin History)
  it('branch 3 (thin history): recommends both when trials exist on record but neither has an informative trial', () => {
    const task = { description: 'Build simple JSON formatter script', taskType: 'build-new-feature' };
    const scorecards = [
      // Clean trial exists for codex, but size exceeds codex envelope for single dispatch
      makeRecord({
        provider: 'codex',
        model: 'gpt-6-astra',
        taskType: 'build-new-feature',
        scoredAt: '2026-09-15T01:00:00.000Z',
        verifiedBy: 'claude-subagent',
        findings: null, // clean, never informative
      }),
    ];
    // Scope is 320 LOC (exceeds proven envelope of 300 LOC so neither codex nor gemini fits alone)
    const context = {
      filesTouched: ['scripts/lib/json-format.mjs'],
      estimatedSize: 320,
      scorecards,
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.BOTH);
    expect(res.claudeTier).toBeNull();
    expect(res.reasoning).toContain('too thin');
  });

  // Branch 4: #3857 — the model-tier table never outputs Haiku; a trivial single-file doc-fix is Sonnet,
  // the table's default, not a special Haiku carve-out.
  it('branch 4 (sonnet): a trivial single-file doc-fix defaults to sonnet, never haiku (#3857)', () => {
    const task = { description: 'Fix typo in documentation comment', taskType: 'doc-fix' };
    const context = {
      filesTouched: ['docs/reference.md'],
      estimatedSize: 5,
      scorecards: [], // No external model history
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
    expect(res.reasoning).toContain("standard's default");
  });

  // Branch 4: Claude Sonnet
  it('branch 4 (sonnet): recommends claude sonnet as default for bounded multi-file work', () => {
    const task = { description: 'Refactor CLI option parsing across modules', taskType: 'bugfix' };
    const context = {
      filesTouched: ['scripts/cli-opts.mjs', 'scripts/run-opts.mjs'],
      estimatedSize: 180,
      scorecards: [], // No external model history
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
    expect(res.reasoning).toContain('sonnet');
  });

  // Branch 4: Claude Opus (Architectural Decision)
  it('branch 4 (opus): recommends claude opus for architectural-decision tasks', () => {
    const task = {
      description: 'Design polyglot server runtime forward adapters',
      taskType: 'architectural-decision',
    };
    const context = {
      filesTouched: ['plans/polyglot-adapters.md'],
      estimatedSize: 250,
      scorecards: [
        makeRecord({ provider: 'codex', model: 'gpt-6-astra', taskType: 'architectural-decision', findings: null }),
      ],
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.OPUS);
    expect(res.reasoning).toContain('opus');
  });

  // Branch 4: #3857 — triage-research no longer forces Opus by taskType alone (the table has no such
  // row); it defaults to Sonnet like everything else not on the table's four raise-only rows.
  it('branch 4 (sonnet): triage-research no longer forces opus by taskType alone (#3857)', () => {
    const task = {
      description: 'Investigate flaky WebWorker state synchronization under load',
      taskType: 'triage-research',
    };
    const context = {
      filesTouched: ['research/worker-sync.md'],
      estimatedSize: 100,
      scorecards: [],
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
    expect(res.reasoning).toContain("standard's default");
  });

  // Statute-tier path override
  it('statute-tier path forces Claude Opus regardless of clean external model track record', () => {
    const task = { description: 'Update platform decision on auto-land seam', taskType: 'doc-fix' };
    const scorecards = [
      makeRecord({ provider: 'gemini', model: 'gemini-3.1-pro', taskType: 'doc-fix', findings: null }),
      makeRecord({ provider: 'codex', model: 'gpt-6-astra', taskType: 'doc-fix', findings: null }),
    ];
    const context = {
      filesTouched: ['docs/agent/platform-decisions.md'],
      estimatedSize: 20,
      scorecards,
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.OPUS);
    expect(res.reasoning).toContain('rewording statute or rule text');
  });

  // Thin history on judgment-requiring task forces Claude, not Both
  it('thin history on architectural task forces Claude Opus (not Both)', () => {
    const task = { description: 'Architectural evaluation of session store', taskType: 'architectural-decision' };
    const context = {
      filesTouched: ['plans/session-store.md'],
      estimatedSize: 150,
      scorecards: [
        makeRecord({ provider: 'codex', model: 'gpt-6-astra', taskType: 'architectural-decision', findings: null }),
      ],
    };

    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.OPUS);
  });
});

describe('selectProvider — default Antigravity alternate backend (agy Claude route)', () => {
  it('freezes exactly the two real agy Claude tier mappings', () => {
    expect(Object.isFrozen(AGY_CLAUDE_MODEL_BY_TIER)).toBe(true);
    expect(Object.keys(AGY_CLAUDE_MODEL_BY_TIER).sort()).toEqual(['opus', 'sonnet']);
    expect(AGY_CLAUDE_MODEL_BY_TIER).toEqual({
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-6-thinking',
    });
    expect('haiku' in AGY_CLAUDE_MODEL_BY_TIER).toBe(false);
  });

  it('offers Sonnet by default with identical, deterministic output for omitted, true and false quota flags', () => {
    const task = { description: 'Refactor CLI option parsing across modules', taskType: 'bugfix' };
    const context = {
      filesTouched: ['scripts/cli-opts.mjs', 'scripts/run-opts.mjs'],
      estimatedSize: 180,
      scorecards: [],
    };
    const res = selectProvider(task, context);
    const explicitTrue = selectProvider(task, { ...context, quotaStrained: true });
    const explicitFalse = selectProvider(task, { ...context, quotaStrained: false });

    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
    expect(res.alternateBackend).toEqual({
      tool: 'scripts/gemini-direct-task.mjs',
      cliModel: 'claude-sonnet-4-6',
      reason: expect.any(String),
    });
    expect(res.alternateBackend.reason).toContain('gemini-direct-task.mjs');
    expect(res.alternateBackend.reason).toContain('claude-sonnet-4-6');
    expect(res.alternateBackend.reason).toContain('Default capacity-relief');
    expect(explicitTrue).toEqual(res);
    expect(explicitFalse).toEqual(res);
    expect(res.auditTrail.map((a) => a.criterion)).toEqual([
      'gemini-fitness', 'codex-fitness', 'both-together', 'claude-tier', 'agy-alternate-backend',
    ]);
    expect(res.auditTrail.at(-1)).toEqual({
      criterion: 'agy-alternate-backend',
      result: 'offered',
      dataConsulted: "claudeTier='sonnet', taskType='bugfix', statute=false, latestAntigravityTrial=none",
      reasoning: expect.stringContaining('claude-sonnet-4-6'),
    });
    expect(selectProvider(task, context)).toEqual(res);
    expect(JSON.stringify(selectProvider(task, context))).toBe(JSON.stringify(res));
  });

  // #3857 — file-count, LOC and acceptanceTestable:false no longer force Opus on their own; none of
  // these three cases matches a table row (no statute path, no prepare-decision/architectural-decision,
  // no security tag, no dispatch-machinery path), so each stays at the Sonnet default.
  it.each([
    { filesTouched: Array.from({ length: 9 }, (_, i) => `scripts/module-${i}.mjs`), estimatedSize: 180 },
    { filesTouched: ['scripts/module.mjs'], estimatedSize: 501 },
    { filesTouched: ['scripts/module.mjs'], estimatedSize: 180, acceptanceTestable: false },
  ])('stays Sonnet for effort sizing/caution that is no longer a table row (#3857): %j', (context) => {
    const res = selectProvider({ taskType: 'bugfix' }, context);

    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
    expect(res.alternateBackend).toEqual({
      tool: 'scripts/gemini-direct-task.mjs',
      cliModel: 'claude-sonnet-4-6',
      reason: expect.stringContaining('claude-sonnet-4-6'),
    });
    expect(res.auditTrail).toHaveLength(5);
    expect(res.auditTrail.at(-1)).toMatchObject({ criterion: 'agy-alternate-backend', result: 'offered' });
  });

  it.each([
    { outcome: 'rejected', findings: null },
    { outcome: 'reworked', findings: 'Unresolved write_to_file failure' },
  ])('vetoes only the taskType with the latest unclean Antigravity trial: %j', (failure) => {
    // An older informative trial bypasses Step 3's thin-history branch; scope exceeds
    // the external fitness envelope so these calls exercise the Claude branch.
    const context = {
      filesTouched: ['scripts/cli-opts.mjs', 'scripts/run-opts.mjs'],
      estimatedSize: 280,
      scorecards: [
        makeRecord({ provider: 'antigravity', outcome: 'reworked', findings: 'Earlier review finding', informative: true }),
        makeRecord({ provider: 'antigravity', model: 'claude-sonnet-4-6', scoredAt: '2026-09-15T03:00:00.000Z', verifiedBy: 'other', ...failure }),
        makeRecord({ provider: 'antigravity', scoredAt: '2026-09-15T02:00:00.000Z' }),
        makeRecord({ provider: 'gemini', scoredAt: '2026-09-15T04:00:00.000Z' }),
      ],
    };
    const snapshot = JSON.stringify(context);
    const res = selectProvider({ taskType: 'bugfix' }, context);

    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
    expect(res.alternateBackend).toBeNull();
    expect(res.auditTrail).toHaveLength(5);
    expect(res.auditTrail.at(-1)).toMatchObject({ criterion: 'agy-alternate-backend', result: 'recent-failure' });
    const otherTask = selectProvider({ taskType: 'build-new-feature' }, context);
    expect(otherTask.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(otherTask.alternateBackend.cliModel).toBe('claude-sonnet-4-6');
    expect(otherTask.auditTrail.at(-1).result).toBe('offered');
    expect(JSON.stringify(selectProvider({ taskType: 'bugfix' }, context))).toBe(JSON.stringify(res));
    expect(JSON.stringify(context)).toBe(snapshot);
  });

  it('restores the default when a later clean Antigravity trial supersedes failure across models', () => {
    const context = {
      filesTouched: ['scripts/cli-opts.mjs', 'scripts/run-opts.mjs'],
      estimatedSize: 280,
      model: 'claude-sonnet-4-6',
      scorecards: { records: [
        makeRecord({ provider: 'antigravity', model: 'claude-opus-4-6-thinking', scoredAt: '2026-09-15T02:00:00.000Z', verifiedBy: 'other' }),
        makeRecord({ provider: 'antigravity', model: 'claude-sonnet-4-6', outcome: 'rejected', findings: 'Unresolved build crash', informative: true }),
        makeRecord({ provider: 'gemini', scoredAt: '2026-09-15T03:00:00.000Z', outcome: 'rejected' }),
      ] },
    };
    const res = selectProvider({ taskType: 'bugfix' }, context);

    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.alternateBackend.cliModel).toBe('claude-sonnet-4-6');
    expect(res.auditTrail.at(-1)).toMatchObject({ criterion: 'agy-alternate-backend', result: 'offered' });
  });

  it('requires native Opus for statute-tier work even with quota strain and clean Antigravity history', () => {
    const task = { description: 'Update platform decision on auto-land seam', taskType: 'doc-fix' };
    const context = {
      filesTouched: ['docs/agent/platform-decisions.md'],
      estimatedSize: 20,
      scorecards: [
        makeRecord({ provider: 'gemini', model: 'gemini-3.1-pro', taskType: 'doc-fix' }),
        makeRecord({ provider: 'codex', model: 'gpt-6-astra', taskType: 'doc-fix' }),
        makeRecord({ provider: 'antigravity', model: 'claude-opus-4-6-thinking', taskType: 'doc-fix' }),
      ],
      quotaStrained: true,
    };
    const res = selectProvider(task, context);

    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe(CLAUDE_TIERS.OPUS);
    expect(res.alternateBackend).toBeNull();
    expect(res.auditTrail).toHaveLength(5);
    expect(res.auditTrail.at(-1)).toMatchObject({ criterion: 'agy-alternate-backend', result: 'forced-native' });
    expect(res).toEqual(selectProvider(task, { ...context, quotaStrained: false }));
  });

  it('requires native Opus for architectural-decision regardless of Antigravity history', () => {
    for (const trial of [
      { outcome: 'landed', findings: null },
      { outcome: 'reworked', findings: 'Unresolved build failure' },
    ]) {
      const res = selectProvider({ taskType: 'architectural-decision' }, {
        filesTouched: ['scripts/module.mjs'],
        estimatedSize: 20,
        quotaStrained: true,
        scorecards: [makeRecord({ provider: 'antigravity', model: 'claude-opus-4-6-thinking', taskType: 'architectural-decision', ...trial })],
      });
      expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
      expect(res.claudeTier).toBe(CLAUDE_TIERS.OPUS);
      expect(res.alternateBackend).toBeNull();
      expect(res.auditTrail).toHaveLength(5);
      expect(res.auditTrail.at(-1)).toMatchObject({ criterion: 'agy-alternate-backend', result: 'forced-native' });
    }
  });

  // #3857 — triage-research no longer earns Opus from the model-tier table (no row names it), but
  // `forcedNativeIdentity` is a SEPARATE axis (this Step 3.5 gate, unchanged by #3857) that still forces
  // native Claude identity/tools for triage-research regardless of tier or Antigravity history.
  it('requires native identity for triage-research regardless of Antigravity history, though the tier is now Sonnet (#3857)', () => {
    for (const trial of [
      { outcome: 'landed', findings: null },
      { outcome: 'reworked', findings: 'Unresolved build failure' },
    ]) {
      const res = selectProvider({ taskType: 'triage-research' }, {
        filesTouched: ['scripts/module.mjs'],
        estimatedSize: 20,
        quotaStrained: true,
        scorecards: [makeRecord({ provider: 'antigravity', model: 'claude-opus-4-6-thinking', taskType: 'triage-research', ...trial })],
      });
      expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
      expect(res.claudeTier).toBe(CLAUDE_TIERS.SONNET);
      expect(res.alternateBackend).toBeNull();
      expect(res.auditTrail).toHaveLength(5);
      expect(res.auditTrail.at(-1)).toMatchObject({ criterion: 'agy-alternate-backend', result: 'forced-native' });
    }
  });

  it('leaves Gemini, Codex and Both return objects untouched by quota strain', () => {
    const task = { description: 'Fix parser bug', taskType: 'bugfix' };
    const cases = [
      {
        recommendation: RECOMMENDATIONS.GEMINI,
        filesTouched: ['scripts/lib/parser.mjs'],
        scorecards: [makeRecord({ provider: 'gemini', model: 'gemini-3.1-pro' })],
      },
      {
        recommendation: RECOMMENDATIONS.CODEX,
        filesTouched: ['scripts/lib/parser.mjs'],
        scorecards: [makeRecord()],
      },
      {
        recommendation: RECOMMENDATIONS.BOTH,
        filesTouched: ['scripts/conveyor/drain.mjs', 'scripts/conveyor/__tests__/drain.test.mjs'],
        scorecards: [makeRecord({ outcome: 'reworked', findings: 'Deadlock detection race condition in worker loop' })],
      },
    ];
    for (const { recommendation, filesTouched, scorecards } of cases) {
      const context = { filesTouched, scorecards, estimatedSize: 120 };
      const res = selectProvider(task, { ...context, quotaStrained: true });
      expect(res.recommendation).toBe(recommendation);
      expect('alternateBackend' in res).toBe(false);
      expect(res).toEqual(selectProvider(task, context));
    }
  });
});

describe('selectSupervisionLevel — progressive backdown plan (#3690)', () => {
  it('counts explanatory landed accepts toward the clean streak without a hard veto (#3889, rule 5: post-miss bar + rootCause on record)', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };
    const records = [
      makeRecord({
        ...triple, scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'reworked',
        findings: 'Independent review caught a dropped merge-parent change', informative: true,
        rootCause: 'Merge-base cache in the adapter went stale after a rebase; diagnosis recorded before any post-miss trial counted.',
      }),
      ...[1, 2, 3, 4, 5, 6].map((hour) => makeRecord({ ...triple, scoredAt: `2026-09-15T0${hour}:00:00.000Z` })),
      ...[2291, 2292].map((pr, index) => makeRecord({
        ...triple,
        pr,
        scoredAt: `2026-09-15T0${index + 7}:00:00.000Z`,
        outcome: 'landed',
        verifiedBy: 'independent-claude',
        findings: 'Independent claude -p process verified via 3-way diff against both merge parents plus two real vitest runs (34/34 targeted, 1822/1822 broader operations suite) before any push. Verdict ACCEPT; pushed to origin/lane/op-runner-activity.',
      })),
    ];

    const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records);

    // 8 clean trials = minCleanStreak(5) + default k(3) — the post-miss bar, not the cold-start bar.
    expect(res.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
    expect(res.auditTrail.find((a) => a.criterion === 'most-recent-trial-veto')?.result).toBe('clean');
    expect(res.auditTrail.find((a) => a.criterion === 'post-miss-bar-selection')?.result).toBe('post-miss');
    expect(res.auditTrail.find((a) => a.criterion === 'post-miss-root-cause-requirement')?.result).toBe('pass');
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({
      result: 'pass',
      dataConsulted: expect.stringContaining('streak=8, threshold=8'),
    });
  });

  it('does not count a missing/undefined outcome with real-problem findings as clean (fail-closed)', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };
    const records = [
      ...[1, 2, 3, 4].map((hour) => makeRecord({ ...triple, scoredAt: `2026-09-15T0${hour}:00:00.000Z` })),
      { ...makeRecord({ ...triple, scoredAt: '2026-09-15T05:00:00.000Z', findings: 'Build failure' }), outcome: undefined },
    ];

    const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records);

    // The undefined-outcome record is itself an unclean verified record, so it is also a confirmed miss
    // (#3889, rule 5): the post-miss bar (minCleanStreak 5 + default k 3 = 8) applies to the displayed
    // threshold, on top of the pre-existing hard veto that already forces 'full' here.
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({
      result: 'fail',
      dataConsulted: expect.stringContaining('streak=0, threshold=8'),
    });
  });

  it('does not let narrative findings on a landed record alone satisfy the informative-trial requirement', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };
    const records = [1, 2, 3, 4, 5].map((hour) =>
      makeRecord({
        ...triple,
        scoredAt: `2026-09-15T0${hour}:00:00.000Z`,
        outcome: 'landed',
        verifiedBy: 'independent-claude',
        findings: 'Independent claude -p process verified via 3-way diff; Verdict ACCEPT.',
      })
    );

    const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records, {
      minCleanStreak: 5,
      requireInformativeTrial: true,
    });

    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'informative-trial-requirement')).toMatchObject({
      result: 'fail',
      dataConsulted: 'hasInformativeTrial=false, required=true',
    });
  });

  it('a verified rejected record with real findings but informative:false does NOT satisfy the requirement (#3888, rule 4)', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };
    const records = [
      makeRecord({
        ...triple, scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'rejected',
        findings: 'Unresolved build crash', informative: false, verifiedBy: 'independent-claude',
      }),
      ...[1, 2, 3, 4, 5].map((hour) => makeRecord({ ...triple, scoredAt: `2026-09-15T0${hour}:00:00.000Z` })),
    ];

    const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records, {
      minCleanStreak: 5,
      requireInformativeTrial: true,
    });

    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'informative-trial-requirement')).toMatchObject({
      result: 'fail',
      dataConsulted: 'hasInformativeTrial=false, required=true',
    });
  });

  it('a verified landed record with informative:true DOES satisfy the requirement (#3888, rule 4)', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };
    const records = [
      makeRecord({
        ...triple, scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'landed',
        informative: true, verifiedBy: 'independent-claude',
      }),
      ...[1, 2, 3, 4, 5].map((hour) => makeRecord({ ...triple, scoredAt: `2026-09-15T0${hour}:00:00.000Z` })),
    ];

    const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records, {
      minCleanStreak: 5,
      requireInformativeTrial: true,
    });

    expect(res.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
    expect(res.auditTrail.find((a) => a.criterion === 'informative-trial-requirement')).toMatchObject({
      result: 'pass',
      dataConsulted: 'hasInformativeTrial=true, required=true',
    });
  });

  it('returns full supervision with the "no informative trial" reason when every row is explicitly informative:false, even with rejected/reworked findings (#3888, rule 4; rootCause added #3889, rule 5)', () => {
    const records = [
      // Precede the trailing clean streak so they don't reset it, but would have counted as the
      // positive control under the old outcome+findings inference this rule replaces. A rootCause note is
      // recorded on the miss so the post-miss bar (rule 5) is clearable, isolating the assertion to the
      // informative-trial requirement this test targets.
      makeRecord({ scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'reworked', findings: 'caught bug', informative: false, rootCause: 'Diagnosed: a race in the worker pool caused the dropped update.' }),
      makeRecord({ scoredAt: '2026-09-15T00:30:00.000Z', outcome: 'rejected', findings: 'caught another bug', informative: false }),
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T03:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T04:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T05:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T06:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T07:00:00.000Z', findings: null, informative: false }),
      makeRecord({ scoredAt: '2026-09-15T08:00:00.000Z', findings: null, informative: false }),
    ];

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, {
      minCleanStreak: 5,
      requireInformativeTrial: true,
    });
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.reasoning).toContain('no informative trial');
    expect(res.auditTrail.find((a) => a.criterion === 'informative-trial-requirement')?.result).toBe('fail');
  });

  it.each([
    { outcome: 'reworked', findings: 'Independent review caught a dropped merge-parent change' },
    { outcome: 'rejected', findings: 'Independent review caught a dropped merge-parent change' },
    { outcome: 'reworked', findings: null },
    { outcome: 'rejected', findings: null },
  ])('vetoes a real-problem outcome and resets the clean streak: %j', (failure) => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };
    const records = [
      ...[1, 2, 3, 4, 5].map((hour) => makeRecord({ ...triple, scoredAt: `2026-09-15T0${hour}:00:00.000Z` })),
      makeRecord({ ...triple, scoredAt: '2026-09-15T06:00:00.000Z', verifiedBy: 'independent-claude', ...failure }),
    ];

    const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records);

    // The veto-firing record is itself the (only) confirmed miss on record, so the displayed threshold is
    // also the post-miss bar (minCleanStreak 5 + default k 3 = 8; #3889, rule 5).
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'most-recent-trial-veto')?.result).toBe('veto-fired');
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({
      result: 'fail',
      dataConsulted: expect.stringContaining('streak=0, threshold=8'),
    });
  });

  it('determinism: produces identical output on identical inputs', () => {
    const records = [
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', outcome: 'reworked', findings: 'caught bug' }),
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null }),
    ];
    const r1 = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records);
    const r2 = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records);
    expect(r1).toEqual(r2);
  });

  it('streak-not-yet-met case -> returns full supervision', () => {
    // Cold-start triple (no miss ever recorded): the bar stays minCleanStreak, unaffected by the
    // post-miss elevation (#3889, rule 5) — see Done-when #3's dedicated cold-start regression test below.
    const records = [
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null }), // clean 1
      makeRecord({ scoredAt: '2026-09-15T03:00:00.000Z', findings: null }), // clean 2
      makeRecord({ scoredAt: '2026-09-15T04:00:00.000Z', findings: null }), // clean 3
    ];

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, { minCleanStreak: 5 });
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.reasoning).toContain('below required threshold 5');
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')?.result).toBe('fail');
  });

  it('streak-met-but-never-informative case -> returns full supervision', () => {
    const records = [
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', findings: null }), // clean 1
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null }), // clean 2
      makeRecord({ scoredAt: '2026-09-15T03:00:00.000Z', findings: null }), // clean 3
      makeRecord({ scoredAt: '2026-09-15T04:00:00.000Z', findings: null }), // clean 4
      makeRecord({ scoredAt: '2026-09-15T05:00:00.000Z', findings: null }), // clean 5
    ];

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, {
      minCleanStreak: 5,
      requireInformativeTrial: true,
    });
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.reasoning).toContain('no informative trial');
    expect(res.auditTrail.find((a) => a.criterion === 'informative-trial-requirement')?.result).toBe('fail');
  });

  it('streak-met-and-informative case -> returns spot-check supervision (#3889, rule 5: post-miss bar + rootCause on record)', () => {
    const records = [
      makeRecord({
        scoredAt: '2026-09-15T00:30:00.000Z', outcome: 'reworked',
        findings: 'Independent review caught quoting bug', informative: true,
        rootCause: 'Shell-quoting for embedded newlines was never escaped for this adapter; fixed and diagnosed.',
      }), // informative + confirmed miss, root-caused
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', findings: null }), // clean 1
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null }), // clean 2
      makeRecord({ scoredAt: '2026-09-15T03:00:00.000Z', findings: null }), // clean 3
      makeRecord({ scoredAt: '2026-09-15T04:00:00.000Z', findings: null }), // clean 4
      makeRecord({ scoredAt: '2026-09-15T05:00:00.000Z', findings: null }), // clean 5
      makeRecord({ scoredAt: '2026-09-15T06:00:00.000Z', findings: null }), // clean 6
      makeRecord({ scoredAt: '2026-09-15T07:00:00.000Z', findings: null }), // clean 7
      makeRecord({ scoredAt: '2026-09-15T08:00:00.000Z', findings: null }), // clean 8 (minCleanStreak 5 + default k 3)
    ];

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, {
      minCleanStreak: 5,
      requireInformativeTrial: true,
    });
    expect(res.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
    expect(res.reasoning).toContain('Spot-check supervision approved');
    expect(res.auditTrail.every((a) => a.result === 'clean' || a.result === 'pass' || a.result === 'post-miss')).toBe(true);
  });

  it('most-recent-record-is-reworked case -> returns full supervision (hard veto) even with long prior streak', () => {
    const records = [
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', outcome: 'reworked', findings: 'prior finding' }),
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null }),
      makeRecord({ scoredAt: '2026-09-15T03:00:00.000Z', findings: null }),
      makeRecord({ scoredAt: '2026-09-15T04:00:00.000Z', findings: null }),
      makeRecord({ scoredAt: '2026-09-15T05:00:00.000Z', findings: null }),
      makeRecord({ scoredAt: '2026-09-15T06:00:00.000Z', findings: null }),
      makeRecord({ scoredAt: '2026-09-15T07:00:00.000Z', findings: null }),
      // Most recent trial (08:00) caught a regression
      makeRecord({ scoredAt: '2026-09-15T08:00:00.000Z', outcome: 'reworked', findings: 'New defect found by independent review' }),
    ];

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, { minCleanStreak: 5 });
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.reasoning).toContain('Calibration-miss hard veto');
    expect(res.auditTrail.find((a) => a.criterion === 'most-recent-trial-veto')?.result).toBe('veto-fired');
  });

  it('an other-verified record in the middle of a streak neither breaks nor extends it (#3889, rule 5: post-miss bar + rootCause on record)', () => {
    const records = [
      makeRecord({
        scoredAt: '2026-09-15T00:30:00.000Z', outcome: 'reworked', findings: 'prior finding', informative: true,
        rootCause: 'Prior finding root-caused: a stale cache key collided across two unrelated task runs.',
      }), // informative + confirmed miss, root-caused
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }), // clean 1
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }), // clean 2
      // 'other'-verified trial in the middle (e.g. smoke test)
      makeRecord({ scoredAt: '2026-09-15T03:00:00.000Z', verifiedBy: 'other', findings: null }), // skipped!
      makeRecord({ scoredAt: '2026-09-15T04:00:00.000Z', verifiedBy: 'independent-claude', findings: null }), // clean 3
      makeRecord({ scoredAt: '2026-09-15T05:00:00.000Z', verifiedBy: 'independent-claude', findings: null }), // clean 4
      makeRecord({ scoredAt: '2026-09-15T06:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }), // clean 5
      makeRecord({ scoredAt: '2026-09-15T07:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }), // clean 6
      makeRecord({ scoredAt: '2026-09-15T08:00:00.000Z', verifiedBy: 'independent-claude', findings: null }), // clean 7
      makeRecord({ scoredAt: '2026-09-15T09:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }), // clean 8 (minCleanStreak 5 + default k 3)
    ];

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, { minCleanStreak: 5 });
    expect(res.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
    const streakEntry = res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak');
    expect(streakEntry?.dataConsulted).toContain('streak=8');
  });

  describe('post-miss re-graduation (platform-decisions.md#delegation-trial-record-graduation, rule 5; #3889)', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'conflict-resolution' };

    it('(2a) after a confirmed miss with NO rootCause on record, no number of later clean trials reaches spot-check — the reason names the missing note', () => {
      // 20 trailing clean trials — far more than any plausible minCleanStreak + k — still never clears
      // without a rootCause note in its own field.
      const records = [
        makeRecord({ ...triple, scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'reworked', findings: 'Independent review caught a dropped merge-parent change', informative: true }),
        ...Array.from({ length: 20 }, (_, i) => makeRecord({ ...triple, scoredAt: `2026-09-16T${String(i).padStart(2, '0')}:00:00.000Z` })),
      ];

      const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records);

      expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
      expect(res.reasoning).toContain('no root-cause note');
      expect(res.auditTrail.find((a) => a.criterion === 'post-miss-root-cause-requirement')).toMatchObject({
        result: 'fail',
        dataConsulted: 'hasConfirmedMiss=true, hasRootCause=false',
      });
      expect(res.auditTrail.find((a) => a.criterion === 'post-miss-bar-selection')?.result).toBe('post-miss');
    });

    it('(2b) with a rootCause on record, minCleanStreak clean trials still return full and minCleanStreak + k return spot-check', () => {
      const missRow = { ...triple, scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'reworked', findings: 'Independent review caught a dropped merge-parent change', informative: true, rootCause: 'Root cause: merge-base cache used a stale ref after a force-push.' };
      const thresholds = { minCleanStreak: 5, k: 3 };

      const atMinCleanStreak = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, [
        makeRecord(missRow),
        ...Array.from({ length: 5 }, (_, i) => makeRecord({ ...triple, scoredAt: `2026-09-16T0${i}:00:00.000Z` })),
      ], thresholds);
      expect(atMinCleanStreak.level).toBe(SUPERVISION_LEVELS.FULL);
      expect(atMinCleanStreak.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({
        result: 'fail',
        dataConsulted: expect.stringContaining('streak=5, threshold=8'),
      });

      const atPostMissBar = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, [
        makeRecord(missRow),
        ...Array.from({ length: 8 }, (_, i) => makeRecord({ ...triple, scoredAt: `2026-09-16T0${i}:00:00.000Z` })),
      ], thresholds);
      expect(atPostMissBar.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
      expect(atPostMissBar.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({
        result: 'pass',
        dataConsulted: expect.stringContaining('streak=8, threshold=8'),
      });
    });

    it('(2c) a rootCause written into a later row\'s findings instead of the field does not clear the miss', () => {
      const records = [
        makeRecord({ ...triple, scoredAt: '2026-09-15T00:00:00.000Z', outcome: 'reworked', findings: 'Independent review caught a dropped merge-parent change', informative: true }),
        // The diagnosis text lands in `findings`, never in `rootCause` — this must NOT count.
        makeRecord({ ...triple, scoredAt: '2026-09-15T01:00:00.000Z', findings: 'Root cause: merge-base cache used a stale ref after a force-push.' }),
        ...Array.from({ length: 8 }, (_, i) => makeRecord({ ...triple, scoredAt: `2026-09-16T0${i}:00:00.000Z` })),
      ];

      const res = selectSupervisionLevel(triple.provider, triple.model, triple.taskType, records);

      expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
      expect(res.reasoning).toContain('no root-cause note');
      expect(res.auditTrail.find((a) => a.criterion === 'post-miss-root-cause-requirement')).toMatchObject({
        result: 'fail',
        dataConsulted: 'hasConfirmedMiss=true, hasRootCause=false',
      });
    });
  });

  it('(3) cold-start triple with no miss ever recorded is completely unaffected — still graduates at exactly minCleanStreak, no rootCause required (#3889, rule 5)', () => {
    const triple = { provider: 'antigravity', model: 'gemini-3.8-flash-low', taskType: 'doc-fix' };
    const records = Array.from({ length: 5 }, (_, i) => makeRecord({ ...triple, scoredAt: `2026-09-15T0${i}:00:00.000Z`, taskType: 'doc-fix', informative: true }));

    const res = selectSupervisionLevel(triple.provider, triple.model, 'doc-fix', records, { minCleanStreak: 5 });

    expect(res.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
    expect(res.auditTrail.find((a) => a.criterion === 'post-miss-bar-selection')).toMatchObject({
      result: 'cold-start',
      dataConsulted: expect.stringContaining('requiredCleanStreak=5 (minCleanStreak=5)'),
    });
    expect(res.auditTrail.find((a) => a.criterion === 'post-miss-root-cause-requirement')).toMatchObject({
      result: 'pass',
      dataConsulted: 'hasConfirmedMiss=false, hasRootCause=false',
    });
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({
      result: 'pass',
      dataConsulted: expect.stringContaining('streak=5, threshold=5'),
    });
  });

  it('handles empty scorecards gracefully, defaulting to full supervision', () => {
    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', []);
    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')?.result).toBe('fail');
  });

  it('respects caller-supplied threshold overrides', () => {
    const records = [
      makeRecord({ scoredAt: '2026-09-15T01:00:00.000Z', findings: null }),
      makeRecord({ scoredAt: '2026-09-15T02:00:00.000Z', findings: null }),
    ];

    // minCleanStreak: 2, requireInformativeTrial: false -> should pass
    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, {
      minCleanStreak: 2,
      requireInformativeTrial: false,
    });
    expect(res.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
  });

  it('#3801 Fork 3: a reviewer-subject row never counts toward a work triple with the same provider/model/subject', () => {
    // Same provider, model AND subject string ('bugfix') as a work triple, but a review-lens subjectClass.
    const records = [1, 2, 3, 4, 5].map((hour) =>
      makeRecord({ scoredAt: `2026-09-15T0${hour}:00:00.000Z`, findings: null, subjectClass: 'review-lens' })
    );

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', records, { minCleanStreak: 5, requireInformativeTrial: false });

    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({ result: 'fail', dataConsulted: expect.stringContaining('streak=0') });
  });

  it('#3801 Fork 3: a work row never counts toward a review-lens subject with the same provider/model/subject', () => {
    // Same provider, model AND subject string as the review-lens query, but subjectClass defaults to work-agent.
    const records = [1, 2, 3, 4, 5].map((hour) =>
      makeRecord({ scoredAt: `2026-09-15T0${hour}:00:00.000Z`, taskType: 'design-review', findings: null })
    );

    const res = selectSupervisionLevel('codex', 'gpt-6-astra', 'design-review', records, { minCleanStreak: 5, requireInformativeTrial: false }, 'review-lens');

    expect(res.level).toBe(SUPERVISION_LEVELS.FULL);
    expect(res.auditTrail.find((a) => a.criterion === 'trailing-clean-streak')).toMatchObject({ result: 'fail', dataConsulted: expect.stringContaining('streak=0') });
  });

  it('#3801 Fork 3: a review-lens subject with no graduated candidate resolves to Claude at full', () => {
    // The router already accepts any subject string generically; a lens subject with no scorecard history
    // resolves exactly like an unseen work task type — Claude, fully supervised.
    const res = selectProvider({ taskType: 'design-review' }, { filesTouched: ['scripts/lib/example.mjs'], estimatedSize: 30, scorecards: [] });

    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);

    const supervision = selectSupervisionLevel('claude', res.model, 'design-review', [], {}, 'review-lens');
    expect(supervision.level).toBe(SUPERVISION_LEVELS.FULL);
  });
});

describe('selectProvider — explorationHint (model-capability-ratings)', () => {
  // Synthetic test ratings only; these do not claim any real benchmark performance.
  function makeRating(overrides = {}) {
    return {
      provider: 'codex',
      model: 'test-coding-model',
      verified: true,
      source: 'https://example.test/synthetic-benchmark',
      asOf: '2026-09-01',
      lastUpdated: '2026-09-15',
      categories: {
        contextIngestion: { value: null, unit: 'points', note: '' },
        autonomousAgenticWork: { value: 80, unit: 'points', note: '' },
        algorithmicSpeedIdeSync: { value: null, unit: 'points', note: '' },
        cliToolUse: { value: 60, unit: 'points', note: '' },
        overallCodingIndex: { value: 70, unit: 'points', note: '' },
      },
      ...overrides,
    };
  }
  const task = { taskType: 'bugfix' };

  it('surfaces a verified rating with provenance when both groups have zero trials', () => {
    const entry = makeRating();
    const { explorationHint } = selectProvider(task, {
      scorecards: [], capabilityRatings: { version: 1, entries: [entry], dropped: [] },
    });
    expect(THIN_TRIAL_THRESHOLD).toBe(3);
    expect(explorationHint).toEqual({
      suggestedProvider: 'codex', suggestedModel: 'test-coding-model',
      category: 'autonomousAgenticWork', value: 80, unit: 'points',
      asOf: entry.asOf, source: entry.source,
      reason: "Real trial history for taskType 'bugfix' is thin (gemini/antigravity: 0, codex: 0 trials, threshold 3); verified external rating suggests trying codex/test-coding-model (autonomousAgenticWork=80) next.",
    });
  });

  it.each([false, undefined])('never surfaces verification=%s', (verified) => {
    expect(selectProvider(task, { capabilityRatings: [makeRating({ verified })] }).explorationHint).toBeNull();
  });

  it('returns null when ratings or context are omitted, or the registry is empty', () => {
    expect(selectProvider(task, { scorecards: [] }).explorationHint).toBeNull();
    expect(selectProvider(task).explorationHint).toBeNull();
    expect(selectProvider(task, { capabilityRatings: { version: 1, entries: [], dropped: [] } }).explorationHint).toBeNull();
  });

  it.each([3, 4])('does not consult ratings with %i trials in each group, including antigravity', (count) => {
    const scorecards = Array.from({ length: count }, (_, i) => [
      makeRecord({ provider: i % 2 ? 'gemini' : 'antigravity' }), makeRecord(),
    ]).flat();
    const registry = { version: 1, entries: [makeRating()], dropped: [] };
    expect(selectProvider(task, { scorecards, capabilityRatings: registry }).explorationHint).toBeNull();
    // Prove the gate prevents consultation, rather than merely discarding a ranked hint.
    expect(selectProvider(task, {
      scorecards,
      get capabilityRatings() { throw new Error('Registry must not be consulted'); },
    }).explorationHint).toBeNull();
  });

  it.each(['gemini', 'codex'])('consults when only %s has thin task-specific history', (thinProvider) => {
    const scorecards = ['gemini', 'codex'].flatMap((provider) =>
      Array.from({ length: provider === thinProvider ? 2 : 3 }, () => makeRecord({ provider }))
    );
    scorecards.push(makeRecord({ provider: thinProvider, taskType: 'doc-fix' }), makeRecord({ provider: 'claude' }), null);
    const result = selectProvider(task, { scorecards: { records: scorecards }, capabilityRatings: [makeRating()] });
    expect(result.explorationHint.suggestedProvider).toBe('codex');
    expect(result.explorationHint.reason).toContain(
      `gemini/antigravity: ${thinProvider === 'gemini' ? 2 : 3}, codex: ${thinProvider === 'codex' ? 2 : 3} trials`
    );
  });

  it.each([
    ['bugfix', 'autonomousAgenticWork'], ['build-new-feature', 'autonomousAgenticWork'],
    ['self-fix', 'autonomousAgenticWork'], ['conflict-resolution', 'cliToolUse'],
    ['doc-fix', 'cliToolUse'], ['triage-research', 'overallCodingIndex'],
  ])('uses %s default category %s', (taskType, category) => {
    expect(selectProvider({ taskType }, { capabilityRatings: [makeRating()] }).explorationHint.category).toBe(category);
  });

  it('category override changes the ranking and winning provider/model', () => {
    const codex = makeRating();
    const gemini = makeRating({ provider: 'gemini', model: 'test-cli-model', categories: {
      ...codex.categories,
      autonomousAgenticWork: { value: 40, unit: 'points', note: '' },
      cliToolUse: { value: 90, unit: 'points', note: '' },
    } });
    const context = { capabilityRatings: [codex, gemini] };
    expect(selectProvider(task, context).explorationHint.suggestedProvider).toBe('codex');
    expect(selectProvider(task, { ...context, capabilityCategory: 'cliToolUse' }).explorationHint).toMatchObject({
      suggestedProvider: 'gemini', suggestedModel: 'test-cli-model', category: 'cliToolUse', value: 90,
    });
  });

  it('skips unknown values and unsupported providers, keeps measured zero and stable ties', () => {
    const unknown = makeRating({ categories: {
      ...makeRating().categories, autonomousAgenticWork: { value: null, unit: 'points', note: '' },
    } });
    const zero = makeRating({ provider: 'antigravity', model: 'test-zero-model', categories: {
      ...makeRating().categories, autonomousAgenticWork: { value: 0, unit: 'points', note: '' },
    } });
    const context = { capabilityRatings: [unknown, makeRating({ provider: 'claude' }), zero, { ...zero, provider: 'gemini' }] };
    expect(selectProvider(task, context).explorationHint).toMatchObject({ suggestedProvider: 'antigravity', value: 0 });
    expect(selectProvider(task, { capabilityRatings: [unknown] }).explorationHint).toBeNull();
    expect(selectProvider(task, { ...context, capabilityCategory: 'unknown-category' }).explorationHint).toBeNull();
  });

  it.each([
    ['gemini', { scorecards: [makeRecord({ provider: 'gemini' })] }],
    ['codex', { scorecards: [makeRecord()] }],
    ['both', { filesTouched: ['scripts/lib/parser.mjs', 'scripts/lib/__tests__/parser.test.mjs'] }],
    ['claude', { scorecards: [], quotaStrained: true }],
  ])('adds only explorationHint on the %s branch, preserving all existing output bytes', (recommendation, context) => {
    const { explorationHint: absent, ...baseline } = selectProvider(task, context);
    const withRatings = { ...context, capabilityRatings: [makeRating()] };
    const snapshot = JSON.stringify(withRatings);
    const { explorationHint, ...result } = selectProvider(task, withRatings);
    expect(result.recommendation).toBe(recommendation);
    expect(absent).toBeNull();
    expect(explorationHint.suggestedModel).toBe('test-coding-model');
    expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(withRatings)).toBe(snapshot);
    expect(selectProvider(task, withRatings)).toEqual({ ...result, explorationHint });
  });
});

describe('selectSupervisionLevel — architectural separation from model-capability-ratings', () => {
  it('retains its six declared parameters and identical behavior on identical evidence', () => {
    // JavaScript .length stops before the first default: backdownThresholds = {}. subjectClass follows it
    // (also defaulted, #3801 Fork 3) and so is likewise excluded from .length.
    expect(selectSupervisionLevel.length).toBe(4);
    expect(selectSupervisionLevel.toString().split('\n')[0]).toBe(
      "function selectSupervisionLevel(provider, model, taskType, scorecards, backdownThresholds = {}, subjectClass = 'work-agent') {"
    );
    const scorecards = [makeRecord()];
    const thresholds = { minCleanStreak: 1, requireInformativeTrial: false };
    const first = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', scorecards, thresholds);
    const second = selectSupervisionLevel('codex', 'gpt-6-astra', 'bugfix', scorecards, thresholds);
    expect(first.level).toBe(SUPERVISION_LEVELS.SPOT_CHECK);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('contains no capability registry, imported helper, or exploration references in its source span', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../provider-routing.mjs'), 'utf8');
    const start = source.indexOf('export function selectSupervisionLevel');
    expect(start).toBeGreaterThanOrEqual(0);
    // route-import-graph.mjs extracts imports, but has no function-span helper.
    // Start AFTER the parameter list so the default {} is not mistaken for the body.
    const openingBrace = source.indexOf('{', source.indexOf(')', start) + 1);
    expect(openingBrace).toBeGreaterThan(start);
    let depth = 0;
    let end = -1;
    for (let i = openingBrace; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    expect(end).toBeGreaterThan(openingBrace);
    const span = source.slice(start, end);
    // Check the counter captured the entire function, including its final return.
    expect(span).toBe(`export ${selectSupervisionLevel.toString()}`);
    expect(span).not.toContain('model-capability-ratings');
    expect(span).not.toMatch(/isUsableForExploration|getExplorationHint|capabilityRatings|capabilityCategory|explorationHint|THIN_TRIAL_THRESHOLD|forcedNativeIdentity|latestAntigravityTrial|agyAlternateResult/);
  });
});

// ── #3857 — the model-tier table (workerTierFor) ────────────────────────────────────────────────────────────

describe('workerTierFor — the checked-in model-tier table (#3857)', () => {
  it('defaults to sonnet when nothing matches a row', () => {
    expect(workerTierFor({ kind: 'build', taskType: 'build-new-feature', scopePaths: ['scripts/foo.mjs'], tags: [] }))
      .toEqual({ tier: CLAUDE_TIERS.SONNET, reason: "the standard's default" });
    expect(workerTierFor({})).toEqual({ tier: CLAUDE_TIERS.SONNET, reason: "the standard's default" });
  });

  it('kind prepare-decision, or taskType architectural-decision, is opus: preparing a decision\'s forks is judgment', () => {
    expect(workerTierFor({ kind: 'prepare-decision' }).tier).toBe(CLAUDE_TIERS.OPUS);
    expect(workerTierFor({ kind: 'prepare-decision' }).reason).toBe("preparing a decision's forks is judgment");
    expect(workerTierFor({ kind: 'build', taskType: 'architectural-decision' }).tier).toBe(CLAUDE_TIERS.OPUS);
  });

  it('a scope path under docs/agent/, or kind statute-wording, is opus: rewording statute or rule text', () => {
    expect(workerTierFor({ kind: 'build', scopePaths: ['docs/agent/platform-decisions.md'] }).tier).toBe(CLAUDE_TIERS.OPUS);
    expect(workerTierFor({ kind: 'build', scopePaths: ['docs/agent/platform-decisions.md'] }).reason).toBe('rewording statute or rule text');
    expect(workerTierFor({ kind: 'statute-wording' }).tier).toBe(CLAUDE_TIERS.OPUS);
  });

  it('kind security-fix, or a security tag, is opus: a security-critical fix', () => {
    expect(workerTierFor({ kind: 'security-fix' }).tier).toBe(CLAUDE_TIERS.OPUS);
    expect(workerTierFor({ kind: 'security-fix' }).reason).toBe('a security-critical fix');
    expect(workerTierFor({ kind: 'fix', tags: ['security'] }).tier).toBe(CLAUDE_TIERS.OPUS);
    expect(workerTierFor({ kind: 'fix', tags: ['other-tag'] }).tier).toBe(CLAUDE_TIERS.SONNET);
  });

  it('dispatch machinery defaults to sonnet and only high risk raises it to opus', () => {
    for (const p of DISPATCH_MACHINERY_PATHS) {
      for (const risk of [undefined, 'low', 'medium']) {
        expect(workerTierFor({ kind: 'build', scopePaths: [p], risk }).tier).toBe(CLAUDE_TIERS.SONNET);
      }
      expect(workerTierFor({ kind: 'build', scopePaths: [p], risk: 'high' }))
        .toEqual({ tier: CLAUDE_TIERS.OPUS, reason: 'high-risk work' });
    }
    expect(workerTierFor({ kind: 'dispatch-machinery' }).tier).toBe(CLAUDE_TIERS.SONNET);
    expect(DISPATCH_MACHINERY_PATHS).toEqual([
      'scripts/operations/dispatch-lane-io.mjs',
      'scripts/operations/dispatch-task.mjs',
      'scripts/lib/dispatch-contracts.mjs',
      'scripts/lib/provider-routing.mjs',
      'scripts/conveyor/tick-core.mjs',
    ]);
  });

  it('never outputs haiku, and the output set is exactly sonnet and opus', () => {
    const cases = [
      {}, { kind: 'build' }, { kind: 'prepare' }, { kind: 'fix' }, { kind: 'ci-heal' }, { kind: 'investigate' },
      { kind: 'prepare-decision' }, { kind: 'security-fix' }, { kind: 'statute-wording' }, { kind: 'dispatch-machinery' },
      { taskType: 'architectural-decision' }, { taskType: 'doc-fix' }, { scopePaths: ['docs/agent/x.md'] },
      { tags: ['security'] },
    ];
    const tiers = new Set(cases.map((c) => workerTierFor(c).tier));
    for (const t of tiers) expect([CLAUDE_TIERS.SONNET, CLAUDE_TIERS.OPUS]).toContain(t);
    expect(tiers.has(CLAUDE_TIERS.HAIKU)).toBe(false);
  });

  it('is raise-only: a matching row can only move sonnet up to opus, and PURE (identical input -> identical output)', () => {
    const base = { kind: 'build', taskType: 'build-new-feature', scopePaths: ['scripts/foo.mjs'], tags: [] };
    expect(workerTierFor(base).tier).toBe(CLAUDE_TIERS.SONNET);
    expect(workerTierFor({ ...base, scopePaths: ['docs/agent/x.md'] }).tier).toBe(CLAUDE_TIERS.OPUS);
    // Never sonnet again once a row matches opus for the same underlying facts plus more.
    expect(workerTierFor({ ...base, scopePaths: ['docs/agent/x.md', 'scripts/foo.mjs'] }).tier).toBe(CLAUDE_TIERS.OPUS);
    expect(workerTierFor(base)).toEqual(workerTierFor({ ...base }));
  });
});

// #3906 — EXTERNAL_WORKER_CANDIDATES / externalTierEquivalent, and the critical-work gate that holds
// Gemini, Codex and dual-dispatch out of `build`/`fix`/`ci-heal` until #4034.
describe('EXTERNAL_WORKER_CANDIDATES, externalTierEquivalent and the critical-work gate (#3906)', () => {
  // A clean, verified Codex trial for both taskTypes the gated-kind tests below exercise, built the same
  // way the cascade-branch tests above build their fixtures (single small file, one clean claude-subagent
  // trial, well within the proven envelope).
  const cleanCodexContext = (taskType) => ({
    filesTouched: ['scripts/lib/example.mjs'],
    estimatedSize: 40,
    scorecards: [
      makeRecord({ provider: 'codex', model: CODEX_MODEL, taskType, scoredAt: '2026-09-20T01:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }),
    ],
  });

  it('astra is listed exactly once, at tierEquivalent opus, and its model equals CODEX_MODEL', () => {
    const rows = EXTERNAL_WORKER_CANDIDATES.filter((r) => r.provider === 'codex' && r.model === CODEX_MODEL);
    expect(rows).toHaveLength(1);
    expect(rows[0].tierEquivalent).toBe(CLAUDE_TIERS.OPUS);
    expect(rows.filter((r) => r.model === CODEX_MODEL)).toHaveLength(1);
  });

  it('externalTierEquivalent returns opus for the astra pair and null for an unlisted pair', () => {
    expect(externalTierEquivalent('codex', CODEX_MODEL)).toBe(CLAUDE_TIERS.OPUS);
    expect(externalTierEquivalent('codex', 'some-other-model')).toBeNull();
    expect(externalTierEquivalent('gemini', 'gemini-3.1-pro')).toBeNull();
  });

  it('CRITICAL_WORK_GATE holds build, fix and ci-heal; doc-fix, ci-heal, bugfix and features are open (probation, 2026-09-30)', () => {
    expect(CRITICAL_WORK_GATE.kinds).toEqual(['build', 'fix', 'ci-heal', 'prepare', 'prepare-decision', 'investigate', 'prepare-item', 'prevention-card', 'prepare-card', 'doc-fix']);
    expect(CRITICAL_WORK_GATE.basis).toBe('operator 2026-09-30');
    const rows = CRITICAL_WORK_GATE.openForNonCritical;
    expect(Object.keys(rows).sort()).toEqual(['bugfix', 'build-new-feature', 'ci-heal', 'conflict-resolution', 'doc-fix', 'prepare', 'test-fix', 'prepare-decision', 'investigate', 'design', 'diagnosis', 'prevention-card', 'prepare-card'].sort());
    expect(Object.entries(rows).filter(([, v]) => v === true).map(([k]) => k).sort()).toEqual(['bugfix', 'build-new-feature', 'ci-heal', 'doc-fix', 'prepare', 'test-fix', 'prepare-decision', 'investigate', 'design', 'diagnosis', 'prevention-card', 'prepare-card'].sort());
    expect(PROBATION_ROSTER.prepare).toEqual(['codex', 'antigravity-gemini']);
    expect(PROBATION_ROSTER.bugfix).toEqual(['codex', 'antigravity-claude', 'antigravity-gemini']);
    expect(rows['build-new-feature']).toBe(true);
    expect(PROBATION_ROSTER['build-new-feature']).toEqual(['codex', 'antigravity-argon']);
    expect(rows['conflict-resolution']).toBe(false);
  });

  it('a gated kind (build/fix/ci-heal) recommends claude despite a clean Codex track record, auditing a critical-work-gate entry', () => {
    for (const kind of ['build', 'fix', 'ci-heal']) {
      const task = { taskType: 'build-new-feature' };
      const context = { ...cleanCodexContext('build-new-feature'), kind };
      const res = selectProvider(task, context);
      expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
      const gateEntry = res.auditTrail.find((a) => a.criterion === 'critical-work-gate');
      expect(gateEntry).toBeTruthy();
      expect(gateEntry.result).toBe('claude-only');
    }
  });

  it('the same context with no kind at all (an interactive advisory call) recommends codex with tierEquivalent opus — proving the gate is the only thing holding it', () => {
    const task = { taskType: 'build-new-feature' };
    const context = cleanCodexContext('build-new-feature'); // no `kind` field
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CODEX);
    expect(res.tierEquivalent).toBe(CLAUDE_TIERS.OPUS);
    expect(res.auditTrail.some((a) => a.criterion === 'critical-work-gate')).toBe(false);
  });

  it('the same context with kind: fix plus an explicit criticalWorkGate: { kinds: [] } also recommends codex with tierEquivalent opus', () => {
    const task = { taskType: 'build-new-feature' };
    const context = { ...cleanCodexContext('build-new-feature'), kind: 'fix', criticalWorkGate: { kinds: [] } };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CODEX);
    expect(res.tierEquivalent).toBe(CLAUDE_TIERS.OPUS);
    expect(res.auditTrail.some((a) => a.criterion === 'critical-work-gate')).toBe(false);
  });

  it('a bugfix-typed clean Codex trial is also held for gated kinds', () => {
    const task = { taskType: 'bugfix' };
    const context = { ...cleanCodexContext('bugfix'), kind: 'ci-heal' };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.auditTrail.find((a) => a.criterion === 'codex-fitness').result).toBe('unfit');
  });

  it('Gemini trials are also held for gated kinds', () => {
    const task = { taskType: 'bugfix' };
    const context = {
      filesTouched: ['scripts/lib/example.mjs'],
      estimatedSize: 40,
      kind: 'build',
      scorecards: [
        makeRecord({ provider: 'gemini', model: 'gemini-3.1-pro', taskType: 'bugfix', scoredAt: '2026-09-20T01:00:00.000Z', verifiedBy: 'claude-subagent', findings: null }),
      ],
    };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    const geminiAudit = res.auditTrail.find((a) => a.criterion === 'gemini-fitness');
    expect(geminiAudit.result).toBe('unfit');
  });
});

describe('the critical-work gate opens per taskType for non-critical work only (#4034)', () => {
  // Explicitly opens bugfix, which now also has a Codex-only probation roster.
  const openBugfix = { ...CRITICAL_WORK_GATE, openForNonCritical: { ...CRITICAL_WORK_GATE.openForNonCritical, bugfix: true } };
  // One clean claude-subagent codex bugfix trial, well within the proven envelope (same shape as cleanCodexContext above).
  const baseContext = (extra = {}) => ({
    filesTouched: ['scripts/operations/operator-queue.mjs'],
    estimatedSize: 40,
    scorecards: [
      makeRecord({ provider: 'codex', model: CODEX_MODEL, taskType: 'bugfix', scoredAt: '2026-09-20T01:00:00.000Z', verifiedBy: 'claude-subagent', outcome: 'landed', findings: null }),
    ],
    ...extra,
  });

  it('opened + not critical + no vetoes recommends claude with untried agy Claude on probation, audited open-non-critical', () => {
    const task = { taskType: 'bugfix' };
    const context = { ...baseContext(), kind: 'fix', criticalWorkGate: openBugfix, criticalWork: { critical: false, reasons: [] }, criticalMisses: [] };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.probationWorker?.id).toBe('antigravity-claude');
    const gateEntry = res.auditTrail.find((a) => a.criterion === 'critical-work-gate');
    expect(gateEntry.result).toBe('open-non-critical');
  });

  it('the DEFAULT gate offers agy Claude probation for bugfix while conflict-resolution stays closed', () => {
    const task = { taskType: 'bugfix' };
    const context = { ...baseContext(), kind: 'fix', criticalWork: { critical: false, reasons: [] }, criticalMisses: [] };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    const gateEntry = res.auditTrail.find((a) => a.criterion === 'critical-work-gate');
    expect(gateEntry.result).toBe('open-non-critical');
    expect(res.probationWorker?.id).toBe('antigravity-claude');
    const closed = selectProvider({ taskType: 'conflict-resolution' }, context);
    expect(closed.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(closed.probationWorker).toBeNull();
    expect(closed.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('claude-only');
  });

  it('opened but critical work stays on claude, and the gate reasoning names the proxy', () => {
    const task = { taskType: 'bugfix' };
    const context = {
      ...baseContext(),
      kind: 'fix',
      criticalWorkGate: openBugfix,
      criticalWork: { critical: true, reasons: [{ proxy: 'daemon-drain', detail: 'scripts/conveyor/health-watch.mjs' }] },
      criticalMisses: [],
    };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    const gateEntry = res.auditTrail.find((a) => a.criterion === 'critical-work-gate');
    expect(gateEntry.reasoning).toContain('daemon-drain');
  });

  it('opened but criticalWork missing, or criticalMisses missing, fails closed to claude', () => {
    const task = { taskType: 'bugfix' };
    const noCriticalWork = { ...baseContext(), kind: 'fix', criticalWorkGate: openBugfix, criticalMisses: [] };
    expect(selectProvider(task, noCriticalWork).recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    const noCriticalMisses = { ...baseContext(), kind: 'fix', criticalWorkGate: openBugfix, criticalWork: { critical: false, reasons: [] } };
    expect(selectProvider(task, noCriticalMisses).recommendation).toBe(RECOMMENDATIONS.CLAUDE);
  });

  it('opened, not critical, but a critical miss on the exact {provider, model, taskType} triple hard-vetoes codex', () => {
    const task = { taskType: 'bugfix' };
    const context = {
      ...baseContext(),
      kind: 'fix',
      criticalWorkGate: openBugfix,
      criticalWork: { critical: false, reasons: [] },
      criticalMisses: [{ provider: 'codex', model: CODEX_MODEL, taskType: 'bugfix' }],
    };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    const codexAudit = res.auditTrail.find((a) => a.criterion === 'codex-fitness');
    expect(codexAudit.reasoning.startsWith('Hard veto')).toBe(true);
  });

  it('a veto on a different taskType or a different model does not block agy probation', () => {
    const task = { taskType: 'bugfix' };
    const diffTaskType = { ...baseContext(), kind: 'fix', criticalWorkGate: openBugfix, criticalWork: { critical: false, reasons: [] }, criticalMisses: [{ provider: 'codex', model: CODEX_MODEL, taskType: 'doc-fix' }] };
    expect(selectProvider(task, diffTaskType)).toMatchObject({ recommendation: RECOMMENDATIONS.CLAUDE, probationWorker: { id: 'antigravity-claude' } });
    const diffModel = { ...baseContext(), kind: 'fix', criticalWorkGate: openBugfix, criticalWork: { critical: false, reasons: [] }, criticalMisses: [{ provider: 'codex', model: 'some-other-model', taskType: 'bugfix' }] };
    expect(selectProvider(task, diffModel)).toMatchObject({ recommendation: RECOMMENDATIONS.CLAUDE, probationWorker: { id: 'antigravity-claude' } });
  });

  it('a gate opened only for doc-fix leaves a bugfix fix dispatch on claude', () => {
    const openDocFix = { ...CRITICAL_WORK_GATE, openForNonCritical: { 'doc-fix': true } };
    const task = { taskType: 'bugfix' };
    const context = { ...baseContext(), kind: 'fix', criticalWorkGate: openDocFix, criticalWork: { critical: false, reasons: [] }, criticalMisses: [] };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.probationWorker).toBeNull();
    expect(res.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('claude-only');
  });

  it('opened, not critical, thin history (codex trial is reworked as most recent) never falls to both — recommends claude', () => {
    const task = { taskType: 'bugfix' };
    const context = {
      filesTouched: ['scripts/operations/operator-queue.mjs'],
      estimatedSize: 40,
      kind: 'fix',
      criticalWorkGate: openBugfix,
      criticalWork: { critical: false, reasons: [] },
      criticalMisses: [],
      scorecards: [
        makeRecord({ provider: 'codex', model: CODEX_MODEL, taskType: 'bugfix', scoredAt: '2026-09-20T01:00:00.000Z', verifiedBy: 'claude-subagent', outcome: 'reworked', findings: 'unresolved' }),
      ],
    };
    const res = selectProvider(task, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.recommendation).not.toBe(RECOMMENDATIONS.BOTH);
  });

  it('kind build and ci-heal behave like fix for the opened bugfix row', () => {
    for (const kind of ['build', 'ci-heal']) {
      const task = { taskType: 'bugfix' };
      const context = { ...baseContext(), kind, criticalWorkGate: openBugfix, criticalWork: { critical: false, reasons: [] }, criticalMisses: [] };
      const res = selectProvider(task, context);
      expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
      expect(res.probationWorker?.id).toBe('antigravity-claude');
      const gateEntry = res.auditTrail.find((a) => a.criterion === 'critical-work-gate');
      expect(gateEntry.result).toBe('open-non-critical');
    }
  });
});
