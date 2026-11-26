import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghCallerPriority, deriveGhCaller, recordGhHeadroom, ghPriorityAdmission, runGhSync, runGhCliPassthrough, isGhDeferred } from './gh-throttle.window-fixture.mjs';
import { writeBudgetBlock } from './gh-throttle.window-fixture.mjs';
import { rollupSpend, summarizeSpendRows, renderSpendReport } from '../gh-spend.mjs';

const now = Date.now();
function fixture(rem, fn) {
  const lockRoot = mkdtempSync(join(tmpdir(), 'gh-priority-'));
  recordGhHeadroom(lockRoot, 'default', [{ res: 'graphql', limit: 1000, rem, reset: (now + 60000) / 1000 }]);
  const throttle = { lockRoot, now: () => now, env: {}, warn: vi.fn(), exec: vi.fn(() => '[]'), caller: 'dispatch-plan.mjs' };
  try { fn(throttle); } finally { rmSync(lockRoot, { recursive: true, force: true }); }
}

describe('priority admission', () => {
  it.each(['review-daemon', 'review-set-label', 'review-pr', 'merge-ai-prs'])('serves %s first', caller => {
    expect(ghCallerPriority(deriveGhCaller({}, { GH_CALLER: `we:scripts/${caller}.mjs` }))).toBe('critical');
  });
  it.each(['dispatch-plan', 'parked-pr-conflict-watch', 'parked-pr-progress-watch', 'active-progress-watch', 'lane-whois', 'reconcile-pass', 'reconcile-fix-dispatch'])('defers %s first', caller => {
    expect(ghCallerPriority(deriveGhCaller({ caller }, {}))).toBe('background');
  });
  it('limits landing and ci-heal exceptions to landing/push attribution or mutations', () => {
    expect(ghCallerPriority('pr-land.mjs', ['pr', 'list'])).toBe('normal');
    expect(ghCallerPriority('pr-land:landing', ['pr', 'view'])).toBe('critical');
    expect(ghCallerPriority('pr-land.mjs', ['pr', 'merge'])).toBe('critical');
    expect(ghCallerPriority('ci-heal:push')).toBe('critical');
    expect(ghCallerPriority('someone-else')).toBe('normal');
  });
  it.each([[249, 'dispatch-plan.mjs', true], [250, 'dispatch-plan.mjs', false], [99, 'other', true], [100, 'other', false], [1, 'review-daemon', false]])('remaining=%s caller=%s deferred=%s', (rem, caller, deferred) => fixture(rem, throttle => {
    const result = runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: { ...throttle, caller, deferrable: true } });
    expect(isGhDeferred(result)).toBe(deferred);
    expect(throttle.exec).toHaveBeenCalledTimes(deferred ? 0 : 1);
    if (deferred) expect(throttle.warn).toHaveBeenCalledWith(expect.stringContaining('skip this pass'));
  }));
  it('an unaudited CLI passthrough `pr list` is never deferred (deferral is opt-in)', () => fixture(20, throttle => {
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.from('') }));
    const result = runGhCliPassthrough(['pr', 'list'], { throttle, spawn });
    expect(result.deferred).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  }));
  it('an unaudited runGhSync `pr list` (no throttle.deferrable) still executes below the threshold', () => fixture(5, throttle => {
    const result = runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: { ...throttle, caller: 'someone-else' } });
    expect(isGhDeferred(result)).toBe(false);
    expect(throttle.exec).toHaveBeenCalledTimes(1);
  }));
  it('a deferred call with encoding:buffer returns a Buffer', () => fixture(5, throttle => {
    const result = runGhSync(['pr', 'list'], { encoding: 'buffer', throttle: { ...throttle, caller: 'someone-else', deferrable: true } });
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(isGhDeferred(result)).toBe(true);
  }));
  it('deferral reports skipped work in the spend log without executing', () => fixture(20, throttle => {
    const result = runGhSync(['pr', 'list'], { encoding: 'utf8', throttle: { ...throttle, deferrable: true } });
    expect(isGhDeferred(result)).toBe(true);
    expect(throttle.exec).not.toHaveBeenCalled();
    const entries = readFileSync(join(throttle.lockRoot, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const sections = summarizeSpendRows(rollupSpend(entries));
    expect(sections[0].requests).toBe(0);
    expect(sections[0].deferred).toBe(1);
    expect(renderSpendReport(sections, { hours: 1, by: 'caller' })).toContain('deferred-low-budget: 1');
  }));
  it('does not apply stale evidence, other identities, or GraphQL reservations to REST', () => fixture(20, throttle => {
    const context = { ...throttle, identity: 'default', resource: 'graphql', nowMs: now };
    expect(ghPriorityAdmission(context)).not.toBeNull();
    expect(ghPriorityAdmission({ ...context, nowMs: now + 60001 })).toBeNull();
    expect(ghPriorityAdmission({ ...context, identity: 'other' })).toBeNull();
    expect(ghPriorityAdmission({ ...context, resource: 'core' })).toBeNull();
  }));
});

it.each([
  ['pr comment', ['pr', 'comment', '1', '--body', 'x']],
  ['pr edit', ['pr', 'edit', '1', '--add-label', 'x']],
  ['pr merge', ['pr', 'merge', '1']],
  ['pr view (non-list read)', ['pr', 'view', '1', '--json', 'mergeable']],
])('never defers %s below the normal threshold — it still executes', (_n, args) => fixture(5, throttle => {
  const result = runGhSync(args, { encoding: 'utf8', throttle: { ...throttle, caller: 'someone-else' } });
  expect(isGhDeferred(result)).toBe(false);
  expect(throttle.exec).toHaveBeenCalledTimes(1);
  const cli = runGhCliPassthrough(args, { throttle: { ...throttle, caller: 'someone-else' }, spawn: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })) });
  expect(cli.deferred).toBeUndefined();
}));
it('defers a discovery list without an options object instead of crashing', () => fixture(5, throttle => {
  const result = runGhSync(['pr', 'list'], { throttle: { ...throttle, caller: 'someone-else', deferrable: true } });
  expect(isGhDeferred(result)).toBe(true);
}));
it('isGhDeferred ignores large non-deferral payloads without parsing them', () => {
  expect(isGhDeferred(JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ number: i }))))).toBe(false);
  expect(isGhDeferred('not json deferred-low-budget')).toBe(false);
});

it('does not let an out-of-order response replenish the same budget window', () => fixture(20, throttle => {
  recordGhHeadroom(throttle.lockRoot, 'default', [{ res: 'graphql', rem: 900, limit: 1000, reset: (now + 60000) / 1000 }]);
  expect(ghPriorityAdmission({ ...throttle, identity: 'default', resource: 'graphql', nowMs: now }).remaining).toBe(20);
}));
it('critical calls still honor the actual shared exhaustion block', () => fixture(0, throttle => {
  writeBudgetBlock(throttle.lockRoot, 'default', 'graphql', { untilMs: now + 60000, nowMs: now });
  expect(() => runGhSync(['pr', 'list'], { throttle: { ...throttle, caller: 'review-daemon' } })).toThrow('shared backoff');
  expect(throttle.exec).not.toHaveBeenCalled();
}));
it('learns headroom from captured response headers without a quota probe', () => fixture(900, throttle => {
  const trace = '* Request at now\n> GET /graphql HTTP/1.1\n< HTTP/2.0 200 OK\n< X-Ratelimit-Resource: graphql\n< X-Ratelimit-Used: 980\n< X-Ratelimit-Remaining: 20\n< X-Ratelimit-Limit: 1000\n< X-Ratelimit-Reset: ' + (now + 60000) / 1000 + '\n\n';
  const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.from(trace) }));
  runGhCliPassthrough(['pr', 'list'], { throttle: { ...throttle, caller: 'review-daemon' }, spawn });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(ghPriorityAdmission({ ...throttle, identity: 'default', resource: 'graphql', nowMs: now })?.remaining).toBe(20);
}));
