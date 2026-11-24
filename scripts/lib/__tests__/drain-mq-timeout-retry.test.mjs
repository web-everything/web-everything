import { afterEach, expect, it } from 'vitest';
import { firstStderrErrorLine } from '../enqueue-on-event.mjs';
it('stderr picker skips real Node warnings and trace hint, preserving fallback and redaction', () => {
  const noise = '(node:98430) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)';
  expect(firstStderrErrorLine(noise + '\nError: queue unavailable')).toBe('Error: queue unavailable');
  expect(firstStderrErrorLine('(node:12) ExperimentalWarning: feature\nError: failed')).toBe('Error: failed');
  expect(firstStderrErrorLine(noise)).toBe(noise.split('\n')[0]);
  expect(firstStderrErrorLine(noise + '\nAuthorization: Bearer abc')).toBe('[redacted]');
});
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { classifyMqTimeoutLog } from '../mq-failure-evidence.mjs';
import { timeoutFixture, timeoutLog } from './fixtures/mq-timeout.mjs';
const roots = [];
const fixture = options => { const root = mkdtempSync(join(process.env.TMPDIR, 'mq-timeout-')); roots.push(root); return timeoutFixture(root, options); };
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it.each([
  ['assertion', { text: timeoutLog.replace('Error: Test timed out in 5000ms.', 'AssertionError: mismatch') }],
  ['mixed failure', { text: timeoutLog + 'AssertionError: mismatch' }],
  ['unreadable logs', { unreadable: true }], ['missing escape handling', { stripEscape: true }],
  ['second removal', { repeats: true }], ['queue reentry', { reentry: true }], ['dry run', { dryRun: true }],
  ['job status', { job: { status: 'in_progress' } }], ['run status', { run: { status: 'in_progress' } }],
  ['run event', { run: { event: 'pull_request' } }], ['run attempt', { job: { run_attempt: 2 } }],
  ['run conclusion', { run: { conclusion: 'success' } }], ['unknown attempt', { run: { run_attempt: undefined } }],
  ['oversized log', { text: timeoutLog + 'x'.repeat(4 * 1024 * 1024) }], ['call budget', { maxCalls: 2 }], ['incomplete check page', { incomplete: true }],
])('%s refuses recovery', async (_, options) =>
  expect(await fixture(options).retry()).toMatchObject({ retry: false }));
it('timeout plus derived test job retries once across fresh adapters sharing the ledger', async () => {
  const f = fixture();
  expect(await f.retry()).toMatchObject({ retry: true, reason: 'mq-flake-timeout' });
  expect(await f.retry()).toMatchObject({ retry: false, reason: 'Already retried this head' });
});
it.each(['original', 'second', 'unreadable'])('mutation-boundary %s timeline refuses after timeout authorization', async phase => {
  const f = fixture(), authorized = await f.retry();
  expect(authorized.retry).toBe(true);
  f.setTimeline(phase);
  expect(f.enqueue(authorized.sameHeadAdmission).ok).toBe(phase === 'original');
  expect(f.mutations()).toBe(phase === 'original' ? 1 : 0);
});
it.each(['stdout | tests/a.test.mjs > a\nAssertionError: hidden\n', 'Errors 1 error', 'src/a.ts(1,2): error TS2322', 'unrecognized output', 'x'.repeat(2049)])('unknown or oversized failure refuses: %s', extra =>
  expect(classifyMqTimeoutLog(extra + '\n' + timeoutLog, 'unit')).toBe('unknown'));
it('ANSI timeout headlines remain eligible', () => expect(classifyMqTimeoutLog(timeoutLog.replace('Error:', '\x1b[31mError:\x1b[0m'), 'unit')).toBe('mq-flake-timeout'));
it('ledger storage failure retains hold without unhandled rejection', async () => {
  const errors = [], onRejection = error => errors.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    expect(fixture({ ledgerIo: { atomicUpdate() { throw Error('corrupt ledger'); } } }).retry()).toMatchObject({ retry: false, reason: expect.stringContaining('operator inspection required') });
    await new Promise(setImmediate); expect(errors).toEqual([]);
  } finally { process.removeListener('unhandledRejection', onRejection); }
});
