/** @file Real entry probes staged with fake IO: never run gh or osascript. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { isCliEntry } from '../operator-notify-cli.mjs';
let dir;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'notify-entry-')));
  for (const file of ['operator-notify.mjs', 'operator-notify-cli.mjs']) copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', file), join(dir, file));
  writeFileSync(join(dir, 'operator-notify-io.mjs'), `
    export const DEFAULT_STATE_PATH = 'unused';
    export const readQueue = () => ({ ready: process.env.EMPTY ? [] : [{ repo: 'web-everything/web-everything', number: 2108, title: 'PR title' }], errors: [] });
    export const readState = () => { if (process.env.CORRUPT) throw Error('corrupt state'); return { notified: {} }; };
    export const writeState = () => {};
    export const notifyDesktopChecked = () => ({ ok: !process.env.FAIL, error: 'fake delivery failure' });
  `);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (path, env = {}) => {
  const childEnv = { ...process.env, ...env };
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [path, '--once', '--repo=ignored'], { encoding: 'utf8', timeout: 10000, env: childEnv });
};
it.each(['operator-notify.mjs', 'operator-notify-cli.mjs'])('runs %s through a symlinked directory and doubled slash', (file) => {
  symlinkSync(dir, join(dir, 'link'));
  const result = run(`${dir}/link//${file}`);
  expect(result.status).toBe(0); expect(result.stdout).toBe('notified web-everything/web-everything#2108  PR title\n'); expect(result.stderr).toBe('');
});
it('runs the CLI via an aliased file symlink', () => {
  symlinkSync(join(dir, 'operator-notify-cli.mjs'), join(dir, 'alias.mjs'));
  expect(run(`${dir}//alias.mjs`).stdout).toContain('notified web-everything/web-everything#2108');
});
it.each(['operator-notify.mjs', 'operator-notify-cli.mjs'])('%s surfaces failed delivery and process exit status', (file) => {
  const result = run(join(dir, file), { FAIL: '1' });
  expect(result.status).toBe(1); expect(result.stdout).toBe('NOT NOTIFIED web-everything/web-everything#2108  PR title\n'); expect(result.stderr).toContain('fake delivery failure');
});
it('empty queue is silent', () => {
  const result = run(join(dir, 'operator-notify.mjs'), { EMPTY: '1' });
  expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
});
it('guard rejects missing and unrelated entry paths', () => {
  expect(isCliEntry(undefined)).toBe(false);
  expect(isCliEntry(join(dir, 'missing'), 'file:///unrelated')).toBe(false);
  expect(isCliEntry(fileURLToPath(import.meta.url))).toBe(false);
});

it('corrupt state exits nonzero without a notification', () => {
  const result = run(join(dir, 'operator-notify.mjs'), { CORRUPT: '1' });
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('corrupt state');
});
