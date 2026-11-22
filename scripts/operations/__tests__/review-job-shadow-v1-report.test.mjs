import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    expect(() => readFileSync(join(dir, 'shadow.jsonl'))).toThrow();
  });

  it.each([Error('unreadable settings'), '{', '{}', '{"reviewLoop":{"flowShadow":{"enabled":"yes"}}}'])('unreadable or malformed settings fail closed: %s', async value => {
    setting.value = value;
    expect(resolveFlowShadow(process.env, { readSetting }).enabled).toBe(false);
    report(flags); await Promise.all(observations);
    expect(() => readFileSync(join(dir, 'shadow.jsonl'))).toThrow();
  });

  it('valid enabled setting and v1 done evidence append exactly one row at the env override', async () => {
    const result = report(flags);
    expect(result.record).toMatchObject({ kind: 'review', status: 'done' });
    expect(result.record.role).toBeUndefined();
    await Promise.all(observations);
    const rows = readFileSync(join(dir, 'shadow.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0].predicate).toMatchObject({ round: 0, runId: 'run-1' });
  });
});
