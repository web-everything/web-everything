// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnoseEndedJob, summarizeDiagnosis, writeEndedJobDiagnosis } from '../review-job-end-diagnosis.mjs';
let dir;
const slug = 'review-we-42';
const pid = 123;
const diagnose = () => diagnoseEndedJob({ slug, pid, dir });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'job-diagnosis-')); mkdirSync(join(dir, 'diagnostics')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
it('keeps the last 40 lines, redacts tokens, and chooses the last error over later progress', () => {
  const token = 'ghp_abcdefgh12345678';
  writeFileSync(join(dir, `${slug}.log`), Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    + `\nfatal: ${token}\nprogress\n`);
  const d = diagnose();
  expect(d.tail.split('\n')).toHaveLength(40);
  expect(d.tail).toContain('line 22');
  expect(d.tail).not.toContain(token);
  expect(d.lastErrorLine).toBe('fatal: <redacted-token>');
  expect(d.exitCode).toBe('unknown (no exit marker: killed hard or crashed)');
  expect(d.signal).toBe(d.exitCode);
  expect(d.marker).toBe(false);
});
it('bounds oversized input in bytes and truncates the chosen line to 200 characters', () => {
  writeFileSync(join(dir, `${slug}.log`), 'error: ' + 'é'.repeat(10000));
  const d = diagnose();
  expect(Buffer.byteLength(d.tail)).toBeLessThanOrEqual(8192);
  expect(d.lastErrorLine).toHaveLength(200);
});
it('names the log-inspection fallback for an oversized partial line', () => {
  writeFileSync(join(dir, `${slug}.log`), 'x'.repeat(5000000));
  expect(diagnose().tail).toContain('inspect job log');
});
it.each([123, 456])('accepts only a matching exit-marker pid (%s)', markerPid => {
  writeFileSync(join(dir, 'diagnostics', `${slug}.exit.json`), JSON.stringify({ pid: markerPid, exitCode: null, signal: 'SIGTERM' }));
  const d = diagnose();
  expect(d.marker).toBe(markerPid === pid);
  expect(d.signal).toBe(markerPid === pid ? 'SIGTERM' : 'unknown (no exit marker: killed hard or crashed)');
});
it('handles missing log and malformed marker, then atomically persists the full diagnosis', () => {
  writeFileSync(join(dir, 'diagnostics', `${slug}.exit.json`), '{');
  const d = diagnose();
  expect(d.tail).toBe('');
  expect(d.lastErrorLine).toBe('');
  expect(d.marker).toBe(false);
  writeEndedJobDiagnosis({ slug, pid, dir }, d);
  expect(JSON.parse(readFileSync(join(dir, 'diagnostics', `${slug}.ended.json`), 'utf8'))).toEqual({ pid, ...d });
});
it('falls back to the last nonempty line and makes summaries one terminal-safe line', () => {
  writeFileSync(join(dir, `${slug}.log`), 'starting\nfinished\n\n');
  expect(diagnose().lastErrorLine).toBe('finished');
  expect(summarizeDiagnosis({ exitCode: 1, signal: null, lastErrorLine: 'bad\n"line"\x1b' }))
    .toBe(String.raw`exit=1 signal=? last="bad \"line\" "`);
});
