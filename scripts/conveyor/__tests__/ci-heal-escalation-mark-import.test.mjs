// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
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
