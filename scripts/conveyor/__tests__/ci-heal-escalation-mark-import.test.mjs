// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../ci-heal-escalation-mark.mjs', import.meta.url);
const options = { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000 };

describe('ci-heal-escalation-mark fresh-process entry points — coroner #36', () => {
  it('reaches the no-argument usage error without an import-cycle crash', () => {
    const result = spawnSync(process.execPath, ['--no-deprecation', fileURLToPath(moduleUrl)], options);
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toMatch(/ReferenceError|before initialization/);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage:');
  });

  it('imports successfully in a fresh ESM process', () => {
    const result = spawnSync(process.execPath, [
      '--no-deprecation', '--input-type=module', '-e',
      `await import(${JSON.stringify(moduleUrl.href)}); console.log('ok')`,
    ], options);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('ok\n');
  });
});

// The review-status step runs through `await import('./review-status-tag.mjs')`, and that module statically
// imports the entry module back. If the CLI shell awaits it at top level the cycle deadlocks (Node exit 13, no
// JSON line). Neither test above reaches it, so this one drives the whole CLI past the post step with `gh` stubbed.
describe('ci-heal-escalation-mark CLI success path — PR #4002 review finding', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('posts the comment, applies the review-status clear, exits 0 and prints the ok JSON line', () => {
    dir = mkdtempSync(join(tmpdir(), 'ci-heal-escalation-cli-'));
    const log = join(dir, 'gh-calls.log');
    const stub = join(dir, 'gh');
    writeFileSync(stub, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'case "$1 $2" in',
      '  "pr view") echo \'{"labels":[{"name":"review-status:fixing"}]}\' ;;',
      '  "repo view") echo "web-everything/web-everything" ;;',
      'esac',
      'exit 0',
    ].join('\n'));
    chmodSync(stub, 0o755);

    const result = spawnSync(process.execPath, [
      '--no-deprecation', fileURLToPath(moduleUrl), '4002', `--head=${'a'.repeat(40)}`,
      '--outcome=needs-human', '--reason=test', '--repo=web-everything/web-everything',
    ], {
      ...options,
      env: { ...process.env, NODE_OPTIONS: '', PATH: `${dir}:${process.env.PATH}`, WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle') },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/unsettled top-level await/i);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, pr: 4002, escalated: true, outcome: 'needs-human' });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/pr comment 4002/);
    // proves the dynamic import actually ran and applied the status change (not swallowed by the cosmetic catch)
    expect(calls).toMatch(/pr view 4002 .*--json labels/);
    expect(calls).toMatch(/review-status:needs-human/);
  });
});
