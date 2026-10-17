// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAEMON_ENTRY_MODULES } from '../daemon-boot-smoke.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('daemon entry cold imports (rebuild boot smoke entry list)', () => {
  // A fresh process per entry preserves import ordering and exposes ESM cycles.
  it.each(DAEMON_ENTRY_MODULES)('%s imports without starting its daemon', (entry) => {
    const child = spawnSync(process.execPath, [
      '--input-type=module', '-e', `await import(${JSON.stringify(`./${entry}`)})`,
    ], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000 });

    expect(child.error, `${entry}: ${child.error?.message}`).toBeUndefined();
    expect(child.signal, `${entry}: ${child.stderr}`).toBeNull();
    expect(child.status, `${entry}: ${child.stderr}\n${child.stdout}`).toBe(0);
  }, 35_000);
});
