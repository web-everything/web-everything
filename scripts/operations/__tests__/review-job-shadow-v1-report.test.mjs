import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewJobIo } from '../review-job.mjs';
import { runReport } from '../completion-cli.mjs';
import { shadowReviewStep, resolveFlowShadow } from '../../lib/flow-engine/shadow.mjs';

const setting = vi.hoisted(() => ({ value: '{"reviewLoop":{"flowShadow":{"enabled":true,"file":null}}}' }));
vi.mock('../../lib/flow-engine/shadow.mjs', async importOriginal => {
  const real = await importOriginal();
  return { ...real, shadowReviewStep: vi.fn(real.shadowReviewStep) };
});

const readSetting = () => {
  if (setting.value instanceof Error) throw setting.value;
  return setting.value;
};
let dir, report, observations;
const flags = { session: 'review-7', kind: 'review', pr: '7', repo: 'o/r', status: 'done',
  outcome: 'bounced', verdict: 'complete', runId: 'run-1', label: 'review label',
  head: 'a'.repeat(40), netDiff: 'b'.repeat(64), round: 0 };
const logFile = () => join(dir, 'shadow-6f2f72-7.jsonl');
const rows = file => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const bytes = () => readFileSync(join(dir, 'review-7.json'), 'utf8');
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'review-shadow-v1-'));
  vi.stubEnv('OPERATION_COMPLETIONS_DIR', dir);
  vi.stubEnv('WE_FLOW_V0_SHADOW_FILE', join(dir, 'shadow.jsonl'));
  vi.stubEnv('WE_FLOW_V0_EXECUTOR_COMMIT', 'c'.repeat(40));
  vi.stubEnv('WE_PLATFORM_PREFERENCES_FILE', join(dir, 'absent'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));
  setting.value = '{"reviewLoop":{"flowShadow":{"enabled":true,"file":null}}}';
  observations = [];
  const real = await vi.importActual('../../lib/flow-engine/shadow.mjs');
  shadowReviewStep.mockReset().mockImplementation(input => {
    const pending = real.shadowReviewStep(input, { readSetting, log: () => {} });
    observations.push(pending);
    return pending;
  });
  report = createReviewJobIo({ env: { WE_WORKER_WRAPPER: 'off' } }).report;
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('v1 report shadow observer', () => {
  it.each(['throw', 'reject', 'mutate'])('%s cannot change durable completion or runReport return value', async mode => {
    const baseline = runReport(flags), originalBytes = bytes();
    let observed;
    shadowReviewStep.mockImplementation(input => {
      observed = structuredClone(input);
      expect(bytes()).toBe(originalBytes);
      if (mode === 'throw') throw Error('sync failure');
      if (mode === 'reject') return Promise.reject(Error('async failure'));
      input.classified.outcome = 'auto-cleared'; input.classified.label = 'changed';
    });
    expect(report(flags)).toEqual(baseline);
    await Promise.resolve();
    expect(bytes()).toBe(originalBytes);
    expect(shadowReviewStep).toHaveBeenCalledOnce();
    expect(observed).toEqual({ repo: 'o/r', pr: '7', session: 'review-7',
      classified: { outcome: 'bounced', loopOutcome: 'complete', runId: 'run-1', label: 'review label',
        head: flags.head, netDiff: flags.netDiff, round: 0 } });
  });

  it('started never calls the shadow', () => {
    expect(report({ ...flags, status: 'started' }).record.status).toBe('started');
    expect(shadowReviewStep).not.toHaveBeenCalled();
  });

  it('setting off appends no row on the v1 done path', async () => {
    setting.value = '{"reviewLoop":{"flowShadow":{"enabled":false}}}';
    report(flags); await Promise.all(observations);
    expect(shadowReviewStep).toHaveBeenCalledOnce();
    expect(() => readFileSync(logFile())).toThrow();
  });

  it.each([Error('unreadable settings'), '{', '{}', '{"reviewLoop":{"flowShadow":{"enabled":"yes"}}}'])('unreadable or malformed settings fail closed: %s', async value => {
    setting.value = value;
    expect(resolveFlowShadow(process.env, { readSetting }).enabled).toBe(false);
    report(flags); await Promise.all(observations);
    expect(() => readFileSync(logFile())).toThrow();
  });

  it('valid enabled setting and v1 done evidence append exactly one row at the env override', async () => {
    const result = report(flags);
    expect(result.record).toMatchObject({ kind: 'review', status: 'done' });
    expect(result.record.role).toBeUndefined();
    await Promise.all(observations);
    const rows = readFileSync(logFile(), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0].predicate).toMatchObject({ round: 0, runId: 'run-1' });
  });
});

// S1 negative cases exercise the real observer and durable report boundary.
describe('S1 full-step evidence', () => {
  it('key-only disagreement opens a finding with both canonical seven-field steps', async () => {
    runReport(flags);
    const real = await vi.importActual('../../lib/flow-engine/shadow.mjs');
    const engine = await import('../../lib/flow-engine/index.mjs');
    await real.shadowReviewStep({ repo: flags.repo, pr: flags.pr, session: flags.session,
      classified: { ...flags, loopOutcome: flags.verdict } }, {
      readSetting, log: () => {}, engine: { ...engine, plan: (flow, p) => engine.plan(flow, p).map(s => ({ ...s, key: s.key + '-wrong' })) },
    });
    const finding = rows(logFile() + '.findings.jsonl')[0];
    const planned = JSON.parse(finding.planned), actual = JSON.parse(finding.actual);
    expect(finding).toMatchObject({ repo: 'o/r', pr: '7', seq: 1 });
    expect(Object.keys(actual).sort()).toEqual(['event', 'from', 'guard', 'key', 'outcome', 'route', 'to']);
    expect(planned).toEqual({ ...actual, key: actual.key + '-wrong' });
    expect(actual.key).toBe('review:o%2Fr%237:1.1');
    expect(finding.actual).toBe(engine.canonicalJSON(actual));
    expect(finding.planned).toBe(engine.canonicalJSON(planned));
    expect(rows(logFile())[0].predicate.agreement).toBe(false);
  });

  it('event-only difference reads as disagree and opens a finding', async () => {
    runReport(flags);
    const real = await vi.importActual('../../lib/flow-engine/shadow.mjs');
    const engine = await import('../../lib/flow-engine/index.mjs');
    await real.shadowReviewStep({ repo: flags.repo, pr: flags.pr, session: flags.session,
      classified: { ...flags, loopOutcome: flags.verdict } }, {
      readSetting, log: () => {}, engine: { ...engine, plan: (flow, p) => engine.plan(flow, p).map(s => ({ ...s, event: 'other' })) },
    });
    expect(rows(logFile() + '.findings.jsonl')).toHaveLength(1);
    expect(rows(logFile())[0].predicate.agreement).toBe(false);
  });

  it.each([{ extra: 1 }, { attempt: 2 }])('a Step with an extra field %j is refused as a disagreement', async extra => {
    runReport(flags);
    const real = await vi.importActual('../../lib/flow-engine/shadow.mjs');
    const engine = await import('../../lib/flow-engine/index.mjs');
    await real.shadowReviewStep({ repo: flags.repo, pr: flags.pr, session: flags.session,
      classified: { ...flags, loopOutcome: flags.verdict } }, {
      readSetting, log: () => {}, engine: { ...engine, plan: (flow, p) => engine.plan(flow, p).map(s => ({ ...s, ...extra })) },
    });
    expect(rows(logFile() + '.findings.jsonl')).toHaveLength(1);
    expect(rows(logFile())[0].predicate.agreement).toBe(false);
  });

  it('never releases a lock another observer now holds', async () => {
    runReport(flags);
    const real = await vi.importActual('../../lib/flow-engine/shadow.mjs');
    const engine = await import('../../lib/flow-engine/index.mjs');
    const { reserve, readLockEntry, releaseLockDir } = await import('../../readiness/file-locks.mjs');
    const locks = join(realpathSync(dir), '.flow-v0-shadow-locks');
    let lockRoot;
    await real.shadowReviewStep({ repo: flags.repo, pr: flags.pr, session: flags.session,
      classified: { ...flags, loopOutcome: flags.verdict } }, {
      readSetting, log: () => {}, engine: { ...engine, appendTransition: async (...a) => {
        lockRoot = join(locks, readdirSync(locks)[0]);
        releaseLockDir(lockRoot, 'append');
        reserve(lockRoot, 'append', 'successor', Date.now(), new Date().toISOString());
        return engine.appendTransition(...a);
      } },
    });
    expect(readLockEntry(lockRoot, 'append')?.owner).toBe('successor');
  });

  it.each(['bounced', 'auto-cleared'])('shadow on/off preserves %s runReport result, completion and exit behavior', async outcome => {
    const input = { ...flags, outcome, verdict: outcome === 'auto-cleared' ? 'converged' : 'complete' };
    setting.value = '{"reviewLoop":{"flowShadow":{"enabled":false}}}';
    const exit = process.exitCode, off = report(input), before = bytes();
    await Promise.all(observations);
    setting.value = '{"reviewLoop":{"flowShadow":{"enabled":true}}}';
    expect(report(input)).toEqual(off);
    await Promise.all(observations);
    expect(bytes()).toBe(before);
    expect(process.exitCode).toBe(exit);
    expect(rows(logFile())).toHaveLength(1);
  });

  it('rotates a log at the bound and continues replay/sequence in the active file', async () => {
    report(flags); await Promise.all(observations);
    const first = readFileSync(logFile(), 'utf8');
    writeFileSync(logFile(), first + ' '.repeat(262144 - Buffer.byteLength(first)));
    report({ ...flags, runId: 'run-2' }); await Promise.all(observations);
    expect(readFileSync(logFile() + '.1', 'utf8')).toHaveLength(262144);
    expect(rows(logFile())[0].predicate.seq).toBe(2);
    report({ ...flags, runId: 'run-3' }); await Promise.all(observations);
    expect(rows(logFile()).map(r => r.predicate.seq)).toEqual([2, 3]);
  });

  it('two PRs write distinct safe filenames', async () => {
    report(flags); await Promise.all(observations);
    report({ ...flags, pr: '8', session: 'review-8' }); await Promise.all(observations);
    expect(rows(logFile())[0].subject[0].name).toBe('o/r#7');
    expect(rows(join(dir, 'shadow-6f2f72-8.jsonl'))[0].subject[0].name).toBe('o/r#8');
  });

  it('ownership refusal leaves no shadow row even when the existing completion is done', async () => {
    runReport({ ...flags, 'session-id': 'owner' });
    const before = bytes(), baseline = runReport(flags);
    expect(baseline.refused).toBe(true);
    expect(report(flags)).toEqual(baseline);
    await Promise.all(observations);
    expect(shadowReviewStep).not.toHaveBeenCalled();
    expect(bytes()).toBe(before);
    expect(readdirSync(dir).filter(n => n.endsWith('.jsonl'))).toEqual([]);
  });
});
