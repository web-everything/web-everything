import { describe, expect, it } from 'vitest';

import {
  ADVISOR_BRIEF_LINE, advisorArgv, advisorForLaunch, advisorLedgerPath, advisorLedgerRow, decideAdvisor,
  loadAdvisorSettings, recordAdvisorRun, resolveAdvisorSettings, sampleBucket, withAdvisorBrief,
} from '../advisor-trial.mjs';
import { buildAgentArgv } from '../../operations/dispatch-lane-io.mjs';
import { parseReviewVerdicts, summarizeAdvisorTrial, transcriptAdvisorFacts } from '../../operations/advisor-trial-report.mjs';

const settings = (over = {}) => ({ mode: 'sample', model: 'opus', sampleRate: 0.5, kinds: ['fix'], ...over });

describe('advisor trial — sampling', () => {
  it('buckets are deterministic per run id and spread across [0,1)', () => {
    expect(sampleBucket('run-a')).toBe(sampleBucket('run-a'));
    expect(sampleBucket('run-a')).not.toBe(sampleBucket('run-b'));
    const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const on = ids.filter((id) => decideAdvisor({ runId: id, kind: 'fix', settings: settings() }).on).length;
    expect(on / ids.length).toBeGreaterThan(0.45);
    expect(on / ids.length).toBeLessThan(0.55);
    for (const id of ids.slice(0, 50)) { const b = sampleBucket(id); expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(1); }
  });

  it('the same run id always lands in the same arm', () => {
    const a = decideAdvisor({ runId: 'abc', kind: 'fix', settings: settings() });
    const b = decideAdvisor({ runId: 'abc', kind: 'fix', settings: settings() });
    expect(a).toEqual(b);
    expect(a.reason).toMatch(/^sampled-(in|out)$/);
    expect(a.on).toBe(a.bucket < 0.5);
  });

  it('mode on/off, rate 0/1, kinds and a missing run id', () => {
    expect(decideAdvisor({ runId: 'x', kind: 'fix', settings: settings({ mode: 'on' }) }).on).toBe(true);
    expect(decideAdvisor({ runId: 'x', kind: 'fix', settings: settings({ mode: 'off' }) }).on).toBe(false);
    expect(decideAdvisor({ runId: 'x', kind: 'fix', settings: settings({ sampleRate: 1 }) }).on).toBe(true);
    expect(decideAdvisor({ runId: 'x', kind: 'fix', settings: settings({ sampleRate: 0 }) }).on).toBe(false);
    expect(decideAdvisor({ runId: 'x', kind: 'build', settings: settings({ mode: 'on' }) })).toMatchObject({ on: false, reason: 'kind-not-in-trial' });
    expect(decideAdvisor({ runId: '', kind: 'fix', settings: settings() })).toMatchObject({ on: false, reason: 'no-run-id' });
  });
});

describe('advisor trial — settings fail off', () => {
  const load = (text) => loadAdvisorSettings({ path: '/x.json', read: () => { if (text instanceof Error) throw text; return text; } });
  it('reads the shipped shape', () => {
    expect(load(JSON.stringify({ advisor: settings() }))).toMatchObject({ settings: settings(), error: null });
  });
  it('missing, bad JSON, bad mode, bad keys or a Fable model all mean off', () => {
    for (const text of [Object.assign(new Error('nope'), { code: 'ENOENT' }), '{', '[]',
      JSON.stringify({ advisor: { mode: 'always' } }),
      JSON.stringify({ advisor: { mode: 'on', sampleRate: 2 } }),
      JSON.stringify({ advisor: { mode: 'on', model: 'fable' } }),
      JSON.stringify({ advisor: { mode: 'on', model: '--dangerously-skip-permissions' } })]) {
      const r = load(text);
      expect(r.settings.mode).toBe('off');
      expect(r.error).toMatch(/advisor off/);
    }
  });
  it('the checked-in settings file is valid and samples fix at 0.5 with opus', () => {
    const r = loadAdvisorSettings({ env: {} });
    expect(r.error).toBeNull();
    expect(r.settings).toEqual({ mode: 'sample', model: 'opus', sampleRate: 0.5, kinds: ['fix'] });
  });
  it('a __proto__ key never throws; a throwing loader means off', () => {
    const r = load('{"advisor":{"mode":"on","__proto__":{}}}');
    expect(r.settings.mode).toBe('off');
    expect(advisorForLaunch({ runId: 'r', kind: 'fix', load: () => { throw new Error('io'); } })).toMatchObject({ on: false, reason: 'mode-off' });
  });
  it('advisorForLaunch carries a settings error and stays off', () => {
    const d = advisorForLaunch({ runId: 'r', kind: 'fix', load: () => ({ ...resolveAdvisorSettings({}), settings: { ...resolveAdvisorSettings({}).settings, mode: 'off' }, error: 'boom' }) });
    expect(d).toMatchObject({ on: false, reason: 'mode-off', settingsError: 'boom' });
  });
});

describe('advisor trial — flag building', () => {
  const on = decideAdvisor({ runId: 'r', kind: 'fix', settings: settings({ mode: 'on' }) });
  const off = decideAdvisor({ runId: 'r', kind: 'fix', settings: settings({ mode: 'off' }) });

  it('advisorArgv / withAdvisorBrief', () => {
    expect(advisorArgv(on)).toEqual(['--advisor', 'opus']);
    expect(advisorArgv(off)).toEqual([]);
    expect(advisorArgv(null)).toEqual([]);
    expect(withAdvisorBrief('do it\n', on)).toBe(`do it\n\n${ADVISOR_BRIEF_LINE}\n`);
    expect(withAdvisorBrief('do it', off)).toBe('do it');
  });

  it('buildAgentArgv adds the flag and brief line only when on, and never touches --model', () => {
    const base = { sessionId: 's', payload: { prompt: 'fix PR #1', sessionSlug: 'fix-1', launchKind: 'fix' } };
    const plain = buildAgentArgv(base);
    const withOff = buildAgentArgv({ ...base, advisor: off });
    const withOn = buildAgentArgv({ ...base, advisor: on });
    expect(withOff).toEqual(plain);
    const model = (argv) => argv[argv.indexOf('--model') + 1];
    expect(model(withOn)).toBe(model(plain));
    expect(withOn.slice(-3)).toEqual(['--advisor', 'opus', `fix PR #1\n\n${ADVISOR_BRIEF_LINE}\n`]);
    expect(withOn.slice(0, -3)).toEqual(plain.slice(0, -1));
  });

  it('a resume stays a bare --bg --resume even when on', () => {
    expect(buildAgentArgv({ sessionId: 's', payload: { prompt: 'go' }, resumeSessionId: 'old', advisor: on }))
      .toEqual(['--bg', '--resume', 'old', 'go']);
  });
});

describe('advisor trial — ledger', () => {
  it('row shape and append', () => {
    const d = decideAdvisor({ runId: 'r1', kind: 'fix', settings: settings({ mode: 'on' }) });
    const row = advisorLedgerRow({ decision: d, runId: 'r1', agentId: 'a1', sessionSlug: 'fix-7', repo: 'we', pr: '7', item: '12', at: 't' });
    expect(row).toMatchObject({ schema: 1, runId: 'r1', agentId: 'a1', pr: 7, item: '12', advisor: true, advisorModel: 'opus', kind: 'fix' });
    const writes = [];
    expect(recordAdvisorRun(row, { path: '/p/l.jsonl', mkdir: () => {}, append: (p, t) => writes.push([p, t]) })).toBe(true);
    expect(JSON.parse(writes[0][1])).toEqual(row);
    expect(recordAdvisorRun(row, { path: '/p', mkdir: () => { throw new Error('ro'); } })).toBe(false);
  });
  it('under test with no override: settings off, no ledger', () => {
    expect(loadAdvisorSettings({ env: { VITEST: 'true' } }).settings.mode).toBe('off');
    expect(advisorLedgerPath({ VITEST: 'true' }, '/h')).toBeNull();
    expect(recordAdvisorRun({}, { path: null })).toBe(false);
  });
  it('ledger path sits next to the perf store', () => {
    expect(advisorLedgerPath({}, '/h')).toBe('/h/workspace/.operations/metrics/perf/advisor-trial.jsonl');
    expect(advisorLedgerPath({ WE_ADVISOR_TRIAL_LEDGER: '/x.jsonl' }, '/h')).toBe('/x.jsonl');
  });
});

describe('advisor trial — report', () => {
  const usage = (iterations) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations });
  const lines = [
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'server_tool_use', id: 'adv1', name: 'advisor', input: {} }],
      usage: usage([{ type: 'message', input_tokens: 5 }, { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100 }]) } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'ok' }],
      usage: usage([{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100 }]) } },
  ];
  it('counts advisor calls/tokens once per message, outside the worker totals', () => {
    const f = transcriptAdvisorFacts(lines);
    expect(f).toMatchObject({ found: true, advisorCalls: 1, advisorTokens: 1100, workerTokens: 15, advisorModel: 'claude-opus-5-5' });
    expect(f.advisorCostUsd).toBeGreaterThan(0);
  });
  it('parses review-pr verdicts and skips mechanical bounces', () => {
    const v = parseReviewVerdicts([
      { createdAt: '2026-10-08T02:00:00Z', body: '✅ review — accepted\n\n**Verdict:** ✅ pass\n### Panel verdicts\n### Findings (3)\n' },
      { createdAt: '2026-10-08T01:00:00Z', body: '🔁 review — changes requested\n\nRecorded by parked-pr-conflict-watch' },
      { createdAt: '2026-10-08T01:30:00Z', body: '🔁 review — changes requested\n**Verdict:** changes\n### Panel verdicts\n' },
    ]);
    expect(v).toEqual([{ at: '2026-10-08T01:30:00Z', verdict: 'changes', findings: null }, { at: '2026-10-08T02:00:00Z', verdict: 'accepted', findings: 3 }]);
  });
  it('compares arms: later fix runs, next verdict and cost', () => {
    const rows = [
      { schema: 1, runId: 'a', at: '2026-10-08T00:00:00Z', kind: 'fix', repo: 'we', pr: 1, advisor: true },
      { schema: 1, runId: 'b', at: '2026-10-08T00:00:00Z', kind: 'fix', repo: 'we', pr: 2, advisor: false },
      { schema: 1, runId: 'c', at: '2026-10-08T03:00:00Z', kind: 'fix', repo: 'we', pr: 2, advisor: false },
    ];
    const s = summarizeAdvisorTrial({
      rows,
      transcripts: { a: { found: true, workerCostUsd: 1, advisorCostUsd: 0.5, workerTokens: 100, advisorTokens: 10, advisorCalls: 2 } },
      reviews: { 'we#1': [{ at: '2026-10-08T01:00:00Z', verdict: 'accepted', findings: 1 }], 'we#2': [{ at: '2026-10-08T01:00:00Z', verdict: 'changes', findings: 4 }] },
    });
    expect(s.on).toMatchObject({ runs: 1, prs: 1, fixRoundsPerPr: 1, laterFixRunsPerRun: 0, acceptedNextReviewPct: 100, findingsAfterFix: 1, totalCostUsd: 1.5, advisorCallsPerRun: 2 });
    const partial = summarizeAdvisorTrial({ rows: rows.slice(0, 1), transcripts: { a: { found: true, workerCostUsd: null, advisorCostUsd: 0.5, workerTokens: 9 } } });
    expect(partial.on).toMatchObject({ totalCostUsd: null, withTranscript: 1 });
    expect(s.off).toMatchObject({ runs: 2, prs: 1, fixRoundsPerPr: 2, laterFixRunsPerRun: 0.5, acceptedNextReviewPct: 0, findingsAfterFix: 4, totalCostUsd: null });
  });
});
