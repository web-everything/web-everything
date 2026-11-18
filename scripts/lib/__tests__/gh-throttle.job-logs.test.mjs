// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowJobLogEscapeSequences, runGhSync } from '../gh-throttle.mjs';
import { excuseMergeGateRows, readMergeGateVerdict } from '../merge-gate-hold-class.mjs';
import { GATE_IDS } from '../merge-gate-inventory.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('job-log escape-sequence permission', () => {
  it.each([
    ['string', 'utf8'], ['string', 'latin1'], ['string', 'utf16le'],
    ['Buffer', undefined], ['Buffer', 'buffer'], ['Buffer', 'latin1'], ['Buffer', 'utf16le'],
  ])('sanitizes CSI, OSC and C0 controls while preserving %s output (encoding %s)', (type, encoding) => {
    const root = mkdtempSync(join(tmpdir(), 'gh-job-logs-')); roots.push(root);
    const raw = '\u001b[31mhéllo\u001b[0m\u001b]0;hidden title\u0007\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\'
      + String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i).filter(i => ![9, 10, 13].includes(i)))
      + '\tline\r\n';
    const clean = 'héllolink\tline\r\n';
    const codec = encoding && encoding !== 'buffer' ? encoding : 'utf8';
    const output = type === 'Buffer' ? Buffer.from(raw, codec) : raw;
    const exec = vi.fn(() => output);
    const opts = { encoding, throttle: { env: {}, lockRoot: root, logPath: join(root, 'calls.jsonl'), personalRoute: false, exec } };
    const args = ['api', 'repos/o/r/actions/jobs/123/logs'];
    const expected = type === 'Buffer' ? Buffer.from(clean, codec) : clean;
    expect(runGhSync(args, opts)).toEqual(expected);
    expect(runGhSync([...args, '--allow-escape-sequences'], opts)).toEqual(expected);
    expect(runGhSync(['api', 'repos/o/r/actions/jobs/123'], opts)).toBe(output);
  });

  it('stores sanitized job logs in the read memo and sanitizes historical raw entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'gh-job-logs-')); roots.push(root);
    const raw = '\u001b[32mhéllo\u001b[0m\u0000\n';
    const exec = vi.fn(() => raw);
    const opts = { encoding: 'utf8', throttle: {
      env: { WE_GH_READ_MEMO_DIR: root, WE_GH_THROTTLE_COST_HEADERS: '0' },
      lockRoot: join(root, 'locks'), logPath: join(root, 'calls.jsonl'), personalRoute: false, execFileSync: exec,
    } };
    const args = ['api', 'repos/o/r/actions/jobs/123/logs'];
    expect(runGhSync(args, opts)).toBe('héllo\n');
    const path = join(root, readdirSync(root).find(name => name.endsWith('.json')));
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    expect(entry.stdout).toBe('héllo\n');
    writeFileSync(path, JSON.stringify({ ...entry, stdout: raw }));
    expect(runGhSync(args, opts)).toBe('héllo\n');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('adds permission to job-log reads without mutating caller arguments', () => {
    for (const args of [
      ['api', 'repos/o/r/actions/jobs/123/logs'],
      ['api', '--hostname', 'github.com', 'repos/o/r/actions/jobs/123/logs'],
    ]) {
      const original = [...args];
      Object.freeze(args);
      expect(allowJobLogEscapeSequences(args)).toEqual([...original, '--allow-escape-sequences']);
      expect(args).toEqual(original);
    }
  });

  it.each([
    ['api', 'repos/o/r/actions/jobs/123'],
    ['api', 'repos/o/r/actions/runs/123/logs'],
    ['api', 'repos/o/r/actions/jobs/no-id/logs'],
    ['api', 'repos/o/r/actions/jobs/123/logs', '--allow-escape-sequences'],
    ['pr', 'view', 'repos/o/r/actions/jobs/123/logs'],
  ])('leaves unrelated or already-permitted calls untouched: %j', (...args) => {
    expect(allowJobLogEscapeSequences(args)).toBe(args);
  });

  it('parses #7037 review-hold logs through runGhSync and annotates the failing merge-gate row', () => {
    const root = mkdtempSync(join(tmpdir(), 'gh-job-logs-')); roots.push(root);
    const sha = 'a'.repeat(40);
    const holds = ['review-acceptance', 'test-gaming'];
    const log = ['#7037: HOLD', ...GATE_IDS.map(id =>
      `  ${(holds.includes(id) ? 'hold' : 'pass').padEnd(17)} ${id.padEnd(22)} fixture`),
    'merge-gate: HOLD — held'].join('\n');
    const exec = vi.fn(args => {
      if (!args[1].endsWith('/logs')) return JSON.stringify({ head_sha: sha, completed_at: '2026-11-18T12:00:00Z' });
      if (!args.includes('--allow-escape-sequences')) throw Error('the response contains terminal escape sequences; pass --allow-escape-sequences');
      return `\u001b[32mworkflow diagnostic\u001b[0m\n${log}`;
    });
    const runGh = (args, opts) => runGhSync(args, { ...opts, throttle: {
      ...opts.throttle, env: {}, lockRoot: root, logPath: join(root, 'calls.jsonl'), personalRoute: false, exec,
    } });
    const options = { repo: 'o/r', jobId: 123, prNumber: 7037, cache: new Map(), runGh };
    // The gh 2.104 refusal leaves unreadable evidence red and unannotated.
    const unreadable = readMergeGateVerdict({ ...options, cache: new Map(), runGh: exec });
    expect(unreadable.error).toContain('terminal escape sequences');
    const row = { name: 'merge-gate', id: 123, status: 'COMPLETED', conclusion: 'FAILURE' };
    const excuse = readVerdict => excuseMergeGateRows([row], {
      prNumber: 7037, headSha: sha, labels: ['review:human'], setting: 'on', readVerdict,
    });
    expect(excuse(() => unreadable)).toEqual({ rows: [row], excused: false });
    const verdict = readMergeGateVerdict(options);
    expect(verdict).toMatchObject({ num: 7037, head_sha: sha, ok: false });
    expect(excuse(() => verdict)).toEqual({ excused: false, reviewHold: true, rows: [{
      ...row, mergeGateReviewHold: { holds: expect.arrayContaining(holds), jobId: 123 },
    }] });
    expect(exec.mock.calls.at(-1)[0]).toContain('--allow-escape-sequences');
  });
});
