// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOversizedAssets, main } from '../check-site-asset-size.mjs';

const script = fileURLToPath(new URL('../check-site-asset-size.mjs', import.meta.url));
const MIB = 1024 * 1024;
let root;

beforeEach(() => { root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'site-asset-size-')); });
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function asset(path, bytes) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  const fd = openSync(target, 'w');
  try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
}

function cli(args = [root], cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('site asset size guard', () => {
  it('fails just over the default limit and names the file, size, cap and remediation', () => {
    asset('large.bin', 24 * MIB + 1);
    const result = cli();
    expect(result.status).toBe(1);
    expect(result.output).toContain('large.bin');
    expect(result.output).toMatch(/24\.\d+ MiB/);
    expect(result.output).toContain('Cloudflare Workers assets cap is 25 MiB');
    expect(result.output).toContain('Reduce or remove');
  });

  it('passes just under the default limit', () => {
    asset('small.bin', 24 * MIB - 1);
    expect(cli().status).toBe(0);
    expect(findOversizedAssets(root)).toEqual([]);
  });

  it('allows a file exactly at the limit', () => {
    asset('boundary.bin', 24 * MIB);
    expect(cli().status).toBe(0);
  });

  it('names nested relative paths and reports every offender largest first', () => {
    asset('nested/smaller.bin', 24 * MIB + 1);
    asset('larger.bin', 25 * MIB);
    expect(findOversizedAssets(root)).toEqual([
      { path: 'larger.bin', bytes: 25 * MIB },
      { path: join('nested', 'smaller.bin'), bytes: 24 * MIB + 1 },
    ]);
    const result = cli();
    expect(result.status).toBe(1);
    expect(result.output).toContain(join('nested', 'smaller.bin'));
    expect(result.output.indexOf('larger.bin')).toBeLessThan(result.output.indexOf('smaller.bin'));
  });

  it('fails closed with exit 2 when the directory is missing', () => {
    const result = cli([join(root, 'missing')]);
    expect(result.status).toBe(2);
    expect(result.output).toContain('missing');
  });

  it('fails closed with exit 2 when the directory argument is a file', () => {
    asset('file.bin', 0);
    expect(cli([join(root, 'file.bin')]).status).toBe(2);
  });

  it('fails closed on a symbolic link instead of silently skipping unverified assets', () => {
    symlinkSync('missing-target', join(root, 'linked.bin'));
    const result = cli();
    expect(result.status).toBe(2);
    expect(result.output).toContain('linked.bin');
  });

  it('honors a custom limit in the function and CLI', () => {
    asset('custom.bin', MIB + 1);
    expect(findOversizedAssets(root, MIB)).toEqual([{ path: 'custom.bin', bytes: MIB + 1 }]);
    expect(cli([root, '--limit-mib=1']).status).toBe(1);
    expect(cli([root, '--limit-mib=2']).status).toBe(0);
  });

  it('uses _site by default', () => {
    mkdirSync(join(root, '_site'));
    asset('_site/default.bin', 24 * MIB + 1);
    expect(cli([]).status).toBe(1);
  });

  it.each(['NaN', 'Infinity', '0', '-1', ''])('rejects invalid limit %j with exit 2', (limit) => {
    expect(cli([root, `--limit-mib=${limit}`]).status).toBe(2);
  });

  it('exports main with a returned exit code', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([join(root, 'missing')])).toBe(2);
    expect(main([root])).toBe(0);
  });
});
