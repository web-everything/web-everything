import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveDaemonKey } from '../prototype-load.mjs';

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

  it('gives every daemon a launchd label unless it declares both repo and clone', () => {
    for (const [key, d] of Object.entries(config.daemons)) {
      if (d.repo !== undefined || d.clone !== undefined && d.label === undefined) {
        // A label-free entry must name a real, safe workspace-relative repo and clone (non-empty, no absolute or parent segments).
        for (const field of ['repo', 'clone']) expect(d[field], `${key}.${field}`).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
        continue;
      }
      expect(typeof d.label, key).toBe('string');
    }
  });

  it('declares drain-plateau with its primary repo and actual launchd clone, without a label', () => {
    expect(config.daemons['drain-plateau']).toMatchObject({
      repo: 'plateau-app', clone: 'plateau-drain-daemon',
      runs: 'plateau drain daemon (tools/drain-daemon, runs the clone the launchd plist com.plateau.drain-daemon actually uses)',
      note: expect.any(String),
    });
    expect(config.daemons['drain-plateau']).not.toHaveProperty('label');
  });

  it('preserves the WE drain entry unchanged', () => {
    expect(config.daemons.drain).toEqual({
      label: 'com.plateau.drain-daemon',
      clone: '.lanes/we-drain-daemon/code',
      note: "The plist's DRAIN_DAEMON_WE_CLONE is the DATA clone lane-1, which carries no overlays. Register overlays on the CODE clone code; see scripts/settings/operator-task.json edgeClones.drain and scripts/lib/daemon-clone-registry.mjs.",
      runs: 'merge-queue drain (drain-queue-safety, enqueue)',
    });
  });

  it('resolves plateau-drain-daemon to drain-plateau through the shipped alias', () => {
    expect(config.daemonAliases['plateau-drain-daemon']).toBe('drain-plateau');
    expect(resolveDaemonKey(config.daemons, config.daemonAliases, 'plateau-drain-daemon'))
      .toEqual({ key: 'drain-plateau' });
  });

  it('declares merge-watch on the wev-merge-daemon clone with the merge-orphan-sweep label', () => {
    expect(config.daemons['merge-watch']).toMatchObject({ label: 'com.we.conveyor-pass-daemon.merge-orphan-sweep', clone: 'wev-merge-daemon' });
    expect(config.daemons).not.toHaveProperty('merge');
  });

  it('marks merge-watch unsupported with a reason naming main-only self-sync, so the loader refuses it', () => {
    expect(typeof config.daemons['merge-watch'].unsupported).toBe('string');
    expect(config.daemons['merge-watch'].unsupported).toMatch(/main-only|mainOnly/);
    expect(Object.keys(config.daemons).filter(key => config.daemons[key].unsupported !== undefined).sort())
      .toEqual(['drain-plateau', 'merge-watch']);
  });

  it('marks drain-plateau unsupported until its main-only self-sync consumes overlays, with a normal PR fallback', () => {
    expect(config.daemons['drain-plateau'].unsupported).toEqual(expect.any(String));
    expect(config.daemons['drain-plateau'].unsupported).toMatch(/main-only/);
    expect(config.daemons['drain-plateau'].unsupported).toMatch(/overlay/);
    expect(config.daemons['drain-plateau'].unsupported).toMatch(/normal PR/);
  });

  it('gives every daemon a runs description', () => {
    for (const [key, d] of Object.entries(config.daemons)) expect(typeof d.runs, key).toBe('string');
  });

  it('describes drain as the merge-queue drain, not merge-watch', () => {
    expect(config.daemons.drain.runs).toMatch(/merge-queue drain/);
    expect(config.daemons['merge-watch'].runs).toMatch(/pr-merge-watch/);
  });
});
