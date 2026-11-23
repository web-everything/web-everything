// @vitest-environment node
// P8-b: audited-tip must not statically import the hotpatch guards. That closed an import cycle
// (daemon-overlays -> audited-tip -> hotpatch-guards -> prototype-load -> prototype-load-io -> daemon-overlays)
// that deadlocked vite-node module loading and hung CI test-shard 9 until the job timeout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('../audited-tip.mjs', import.meta.url)), 'utf8');

describe('audited-tip import graph', () => {
  it('has no static import of the hotpatch guards or readers', () => {
    expect(source).not.toMatch(/^\s*import\s[^;]*from\s+['"][^'"]*hotpatch-(guards|readers)\.mjs['"]/m);
  });

  it('loads the hotpatch modules lazily inside revokedHotpatchTips', () => {
    expect(source).toMatch(/await import\('\.\.\/hotpatch-guards\.mjs'\)/);
  });

  it('imports together with daemon-overlays without deadlocking', async () => {
    const overlays = await import('../../daemon-overlays.mjs');
    const tip = await import('../audited-tip.mjs');
    expect(typeof overlays.cloneKey).toBe('function');
    expect(typeof tip.revokedHotpatchTips).toBe('function');
  });
});
