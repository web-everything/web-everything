import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { timeoutFixture, timeoutLog } from './fixtures/mq-timeout.mjs';
import { firstStderrErrorLine } from '../enqueue-on-event.mjs';
import { enqueuePr, ENQUEUE_MUTATION } from '../merge-queue-enqueue.mjs';

const roots = [];
const root = () => { const dir = mkdtempSync(join(process.env.TMPDIR, 'mq-timeout-')); roots.push(dir); return dir; };
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
it('pure timeout without pass proof refuses across guard instances', () => {
  const dir = root();
  const first = timeoutFixture(dir, { qualifying: false }).guard();
  expect(first.hold).toBe(true);
  expect(first.line).toContain('failed_checks');
  expect(timeoutFixture(dir, { qualifying: false }).guard().hold).toBe(true);
});
it('a second flake failure on the same head stays refused', () => {
  expect(timeoutFixture(root(), { repeats: true }).guard().hold).toBe(true);
});
it.each([
  ['unreadable logs', { unreadable: true }],
  ['mixed timeout and assertion', { text: timeoutLog.replace('Tests 1 failed', 'AssertionError: expected 2 to be 3\nTests 2 failed') }],
  ['incomplete log', { text: timeoutLog.split('Test Files')[0] }],
  ['mismatched failing count', { text: timeoutLog.replace('Tests 1 failed', 'Tests 2 failed') }],
  ['other FAIL cause', { text: timeoutLog.replace('Test Files', 'Error: worker crashed\nTest Files') }],
  ['oversized log', { text: timeoutLog + 'x'.repeat(4 * 1024 * 1024) }],
])('%s stays refused', (_, options) => {
  expect(timeoutFixture(root(), options).guard().hold).toBe(true);
});
it('stderr picker skips real Node warnings and trace hint, preserving fallback and redaction', () => {
  const noise = '(node:98430) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)';
  expect(firstStderrErrorLine(noise + '\nError: queue unavailable')).toBe('Error: queue unavailable');
  expect(firstStderrErrorLine('(node:12) ExperimentalWarning: feature\nError: failed')).toBe('Error: failed');
  expect(firstStderrErrorLine(noise)).toBe(noise.split('\n')[0]);
  expect(firstStderrErrorLine(noise + '\nAuthorization: Bearer abc')).toBe('[redacted]');
});

it('preflight, dry-run and mutation all refuse timeout-only evidence', () => {
  const dir = root();
  expect(timeoutFixture(dir, { preflight: true, qualifying: false }).guard().hold).toBe(true);
  expect(timeoutFixture(dir, { dryRun: true, qualifying: false }).guard().hold).toBe(true);
  expect(timeoutFixture(dir, { qualifying: false }).guard().hold).toBe(true);
  expect(timeoutFixture(dir, { preflight: true, qualifying: false }).guard().hold).toBe(true);
});
it('timeout-only evidence refuses before consulting the ledger', () => {
  let reads = 0;
  const result = timeoutFixture(root(), { qualifying: false, ledger: { atomicUpdate() { reads++; throw Error('corrupt'); } } }).guard();
  expect(result.hold).toBe(true);
  expect(reads).toBe(0);
});

it('timeout-only evidence blocks enqueue before any mutation', () => {
  const dir = root(), repo = 'fixture/timeout', num = 42;
  const headSha = 'a'.repeat(40), baseSha = 'c'.repeat(40);
  let mutations = 0;
  const admissions = [];
  const exec = (command, args) => {
    if (command === 'git' && args[0] === 'ls-remote') return `${baseSha}\trefs/heads/main\n`;
    if (command !== 'gh') throw Error('unexpected process');
    if (args[0] === 'pr' && args.includes('id,headRefOid,baseRefName'))
      return JSON.stringify({ id: 'PR_timeout', headRefOid: headSha, baseRefName: 'main' });
    if (args.includes(`query=${ENQUEUE_MUTATION}`)) {
      mutations++;
      // The server may have accepted the mutation before the connection timed out.
      throw Object.assign(Error('enqueue response timed out'), { code: 'ETIMEDOUT' });
    }
    if (args.some(arg => arg.includes('isInMergeQueue')))
      return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false, headRefOid: headSha } } } });
    throw Error('unexpected enqueue IO');
  };
  const enqueue = () => enqueuePr({ repo, num, headSha, cwd: dir, exec,
    preparedSurface: { headSha, base: 'main', baseSha, files: ['scripts/example.mjs'] },
    sameHeadAdmission: () => {
      // Recreate the guard and file-backed ledger for each mutation attempt.
      const decision = timeoutFixture(dir, { qualifying: false }).guard();
      admissions.push(decision);
      return decision;
    },
  });

  expect(timeoutFixture(dir, { preflight: true, qualifying: false }).guard().hold).toBe(true);
  expect(enqueue()).toMatchObject({ ok: false, held: true, reason: 'mq-same-head-failed' });
  expect(admissions).toHaveLength(1);
  expect(admissions[0].hold).toBe(true);
  expect(mutations).toBe(0);
  const fresh = timeoutFixture(dir, { preflight: true, qualifying: false }).guard();
  expect(fresh.hold).toBe(true);
  expect(fresh.line).toContain('failed_checks');
  expect(enqueue()).toMatchObject({ ok: false, held: true, reason: 'mq-same-head-failed' });
  expect(admissions).toHaveLength(2);
  expect(admissions[1].hold).toBe(true);
  expect(mutations).toBe(0);
});

it('timeout log missing only the final exit annotation stays refused', () => {
  const text = timeoutLog.replace('##[error]Process completed with exit code 1.\n', '');
  expect(text).toContain('Test Files 1 failed | 196 passed (197)');
  expect(text).toContain('Tests 1 failed | 8410 passed');
  expect(text).not.toContain('##[error]');
  expect(timeoutFixture(root(), { text }).guard().hold).toBe(true);
});

it('complete timeout proof admits once and then holds on the persisted allowance', () => {
  const dir = root();
  expect(timeoutFixture(dir).guard()).toMatchObject({ hold: false, line: expect.stringContaining('mq-flake-timeout') });
  expect(timeoutFixture(dir).guard().hold).toBe(true);
});
it.each([
  ['rejected run metadata', { runEvent: 'pull_request' }],
  ['unreadable ledger', { ledger: { atomicUpdate() { throw Error('unreadable'); } } }],
  ['spent ledger', { ledger: { atomicUpdate() { return false; } } }],
  ['unfinished same-named head check', { extraHeadCheck: { status: 'in_progress', conclusion: null } }],
  ['undated same-named success', { undatedPass: true }],
  ['undated same-named failure', { extraHeadCheck: { conclusion: 'failure', completed_at: undefined } }],
  ['tied same-named failure', { extraHeadCheck: { conclusion: 'failure' } }],
])('%s holds with otherwise complete timeout pass proof', (_, options) => {
  expect(timeoutFixture(root(), options).guard().hold).toBe(true);
});
it('a 64 MiB quarantine read cannot satisfy the subsequent 4 MiB reader', () => {
  const text = timeoutLog.replace('Error: Test timed out in 5000ms.', 'AssertionError: expected true to be false') + 'padding\n'.repeat(600_000);
  const f = timeoutFixture(root(), { text, runEvent: 'pull_request', boundedLogs: true, quarantine: {
    readList: () => ({ ok: true, list: { mode: 'quarantine', entries: [{ test: 'unrelated.test.mjs', expiresAt: Date.now() + 3_600_000 }] } }),
  } });
  expect(f.guard().hold).toBe(true);
  expect(f.logReads).toContain(64 * 1024 * 1024);
  expect(f.logReads).toContain(4 * 1024 * 1024);
});

it('an ordinary assertion with complete pass proof retains the ordinary flake retry', () => {
  const text = timeoutLog.replace('Error: Test timed out in 5000ms.', 'AssertionError: expected true to be false');
  expect(timeoutFixture(root(), { text }).guard().hold).toBe(false);
});
