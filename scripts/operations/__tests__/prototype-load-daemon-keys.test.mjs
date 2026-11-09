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

  it('declares merge-watch on the wev-merge-daemon clone with the merge-orphan-sweep label', () => {
    expect(config.daemons['merge-watch']).toMatchObject({ label: 'com.we.conveyor-pass-daemon.merge-orphan-sweep', clone: 'wev-merge-daemon' });
    expect(config.daemons).not.toHaveProperty('merge');
  });

  it('marks merge-watch unsupported with a reason naming main-only self-sync, so the loader refuses it', () => {
    expect(typeof config.daemons['merge-watch'].unsupported).toBe('string');
    expect(config.daemons['merge-watch'].unsupported).toMatch(/main-only|mainOnly/);
    for (const [key, d] of Object.entries(config.daemons)) if (key !== 'merge-watch') expect(d.unsupported, key).toBeUndefined();
  });

  it('gives every daemon a runs description', () => {
    for (const [key, d] of Object.entries(config.daemons)) expect(typeof d.runs, key).toBe('string');
  });

  it('describes drain as the merge-queue drain, not merge-watch', () => {
    expect(config.daemons.drain.runs).toMatch(/merge-queue drain/);
    expect(config.daemons['merge-watch'].runs).toMatch(/pr-merge-watch/);
  });
});
