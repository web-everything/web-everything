import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('scripts/settings/prototype-load.json', 'utf8'));

describe('prototype-load daemon registry', () => {
  it('declares pass-readers: the clone that owns the pass daemons, with the launchd label of ci-red-recovery-watch-we', () => {
    expect(config.daemons['pass-readers']).toEqual(expect.objectContaining({
      label: 'com.we.conveyor-pass-daemon.ci-red-recovery-watch-we',
      clone: 'wev-pass-readers',
    }));
  });

  it('gives every daemon a launchd label', () => {
    for (const [key, d] of Object.entries(config.daemons)) expect(typeof d.label, key).toBe('string');
  });
});
