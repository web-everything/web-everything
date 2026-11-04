import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('scripts/settings/prototype-load.json', 'utf8'));
const TEMPLATE = 'skills-src/conveyor/launchd/com.we.conveyor-pass-daemon.ci-red-recovery-watch-we.plist.example';

describe('prototype-load daemon registry', () => {
  it('declares pass-readers with the launchd label of ci-red-recovery-watch-we, the label the shipped template installs', () => {
    expect(config.daemons['pass-readers'].label).toBe('com.we.conveyor-pass-daemon.ci-red-recovery-watch-we');
    const template = readFileSync(TEMPLATE, 'utf8');
    expect(template).toContain(`<key>Label</key>\n\t<string>${config.daemons['pass-readers'].label}</string>`);
  });

  it('pass-readers sets no explicit clone: the clone comes from the installed plist WorkingDirectory, so a watcher installed from the template (wev-review-daemon) or moved to wev-pass-readers is targeted where it actually runs', () => {
    expect(config.daemons['pass-readers']).not.toHaveProperty('clone');
  });

  it('gives every daemon a launchd label', () => {
    for (const [key, d] of Object.entries(config.daemons)) expect(typeof d.label, key).toBe('string');
  });
});
