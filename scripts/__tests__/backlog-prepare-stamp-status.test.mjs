import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKLOG = join(dirname(dirname(fileURLToPath(import.meta.url))), 'backlog.mjs');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prep-stamp-'));
  mkdirSync(join(dir, 'backlog'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stamp(statusLine) {
  const name = '9001-x.md';
  const fm = ['---', 'kind: story', 'size: 1', ...(statusLine ? [statusLine] : []), 'dateOpened: "2026-01-01"', '---', '', '# x', ''];
  writeFileSync(join(dir, 'backlog', name), fm.join('\n'));
  const run = () => execFileSync('node', [BACKLOG, 'prepare-stamp', '9001', `--backlog-dir=${join(dir, 'backlog')}`, '--session=nonexistent-session'], { cwd: dir, encoding: 'utf8' });
  run();
  const first = readFileSync(join(dir, 'backlog', name), 'utf8');
  run();
  return { first, second: readFileSync(join(dir, 'backlog', name), 'utf8') };
}
const status = (t) => t.match(/^status: (.*)$/m)?.[1];

describe('prepare-stamp status handling (#4480)', () => {
  it('keeps an active claim and stamps; idempotent', () => {
    const { first, second } = stamp('status: active');
    expect(status(first)).toBe('active');
    expect(first).toMatch(/^preparedDate:/m);
    expect(first).toMatch(/^preparedAgainstSha:/m);
    expect(second).toBe(first);
  });
  it('keeps preparing', () => expect(status(stamp('status: preparing').first)).toBe('preparing'));
  it('keeps parked', () => expect(status(stamp('status: parked').first)).toBe('parked'));
  it('open and status-less cards end up open, stamped', () => {
    for (const line of ['status: open', 'status: open  # note', null]) {
      const { first } = stamp(line);
      expect(status(first)).toMatch(/^open/);
      expect(first).toMatch(/^preparedAgainstSha:/m);
    }
  });
});
