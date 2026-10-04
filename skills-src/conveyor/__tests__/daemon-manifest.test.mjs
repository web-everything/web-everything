/**
 * @file skills-src/conveyor/__tests__/daemon-manifest.test.mjs
 * @description Unit proof of #3871's closed allowlist — the one gate standing between a `--pass=<name>` flag
 *   and a real spawn. #3873 populated {@link DAEMON_MANIFEST} with the 7 real watcher passes (the manifest
 *   started empty by design at #3871 — see that file's own header history); most tests below still supply
 *   their OWN fixture manifest rather than the shared one, except the `DAEMON_MANIFEST` describe block, which
 *   pins the real, populated shape.
 */
import { describe, it, expect } from 'vitest';
import {
  DAEMON_MANIFEST, isSafeManifestScriptPath, assertValidManifestEntry, resolveManifestEntry,
} from '../daemon-manifest.mjs';
import { defaultLaunchNames } from '../supervisor-launcher.mjs';
import { CONSTELLATION_REPOS } from '../../../scripts/lib/constellation-repos.mjs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('DAEMON_MANIFEST — #3873, the 7 real watcher passes', () => {
  const REPO_KEYS = Object.keys(CONSTELLATION_REPOS);

  it('has the host passes plus 6 passes per repo', () => {
    expect(Object.keys(DAEMON_MANIFEST).sort()).toEqual([
      'branch-drift', 'infra-blocked', 'duplicate-pr-watch', 'orphan-claim-release', 'merge-orphan-sweep', 'lease-reaper', 'health-watch', 'health-responder',
      ...['ci-queue-watch', 'parked-pr-conflict-watch', 'parked-pr-progress-watch', 'lane-pool-health-watch', 'stuck-pr-watch', 'ci-red-recovery-watch']
        .flatMap((p) => REPO_KEYS.map((k) => `${p}-${k}`)),
    ].sort());
  });

  // #4077 — the health watch: ONE host-wide entry (never per-repo), its `tick` subcommand, a 5-minute cadence,
  // against a script that exists.
  it('health-watch is one host-wide 5-minute `tick` entry against a script that exists', () => {
    const e = DAEMON_MANIFEST['health-watch'];
    expect(e.script).toBe('scripts/conveyor/health-watch.mjs');
    expect(e.args).toEqual(['tick']);
    expect(e.intervalMs).toBe(5 * 60 * 1000);
    expect(existsSync(join(REPO_ROOT, e.script))).toBe(true);
    for (const key of REPO_KEYS) expect(DAEMON_MANIFEST[`health-watch-${key}`]).toBeUndefined();
  });

  // we:backlog/x5uqim1-*.md (#4075/#3383) — the CI-red-recovery watcher runs `--apply` (a real `gh run rerun`
  // when its own idempotent cap allows it), unlike a read-only watcher such as `ci-queue-watch` — see
  // `we:scripts/conveyor/ci-red-recovery-watch.mjs`'s own header for why running it unconditionally is safe.
  it('ci-red-recovery-watch runs --apply against the real script, per-repo, against a script that exists', () => {
    for (const key of REPO_KEYS) {
      const e = DAEMON_MANIFEST[`ci-red-recovery-watch-${key}`];
      expect(e.script).toBe('scripts/conveyor/ci-red-recovery-watch.mjs');
      expect(e.args).toContain('sweep');
      expect(e.args).toContain('--apply');
      expect(existsSync(join(REPO_ROOT, e.script))).toBe(true);
    }
  });

  // #3383 — live-caught 2026-09-24: `lease-reaper.mjs` had gone the same way `session-reaper.mjs` had before
  // #3982's fix (its only caller, `runner.mjs`'s mechanical passes, was retired by this epic's daemon split),
  // and #3873's own "wire the 8 watcher passes" slice never named it. No lease-reaper*.log ever appeared under
  // a running daemon's own log directory, confirming it never ran live. Registered here, repo-agnostic (no
  // --repo — it walks the whole shared LANE_POOL_ROOT across every constellation repo in one process).
  it('epic #3383 lease-reaper runs against the real script, WE-only cadence, no --repo (it is repo-agnostic)', () => {
    const e = DAEMON_MANIFEST['lease-reaper'];
    expect(e.script).toBe('scripts/conveyor/lease-reaper.mjs');
    expect(e.args).toEqual([]);
    expect(e.intervalMs).toBe(120_000);
    expect(existsSync(join(REPO_ROOT, e.script))).toBe(true);
  });

  it('epic #3383 merge-orphan-sweep runs the BARE (no --label) orphan sweep every 15 min, against a script that exists', () => {
    const e = DAEMON_MANIFEST['merge-orphan-sweep'];
    expect(e.script).toBe('scripts/merge-ai-prs.mjs');
    expect(e.args).toEqual([]); // bare — never --label=ready-to-merge (a different, already-covered role)
    expect(e.intervalMs).toBe(15 * 60 * 1000);
    expect(existsSync(join(REPO_ROOT, e.script))).toBe(true);
  });

  it('every entry is independently valid (no manifest entry ships broken)', () => {
    for (const name of Object.keys(DAEMON_MANIFEST)) {
      expect(() => assertValidManifestEntry(name, DAEMON_MANIFEST[name]), name).not.toThrow();
    }
  });

  it('#3913 orphan-claim-release runs the writing mode, every 6 h, against a script that exists', () => {
    const e = DAEMON_MANIFEST['orphan-claim-release'];
    expect(e.script).toBe('scripts/conveyor/orphan-claim-release.mjs');
    expect(e.args).toEqual(['--apply']);
    expect(e.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(existsSync(join(REPO_ROOT, e.script))).toBe(true);
  });

  it('the WE-only passes carry no --repo flag at all — genuinely single-repo, not merely unbuilt cross-repo', () => {
    for (const name of ['branch-drift', 'infra-blocked', 'duplicate-pr-watch', 'orphan-claim-release', 'lease-reaper']) {
      expect(DAEMON_MANIFEST[name].args.some((a) => a.startsWith('--repo='))).toBe(false);
    }
  });

  it('merge-orphan-sweep carries no --repo/--repos/--this-repo flag — bare already defaults to the full constellation', () => {
    expect(DAEMON_MANIFEST['merge-orphan-sweep'].args.some((a) => a.startsWith('--repo'))).toBe(false);
  });

  it('merge-orphan-sweep never carries --label=ready-to-merge — that is the separate, already-covered /drain role', () => {
    expect(DAEMON_MANIFEST['merge-orphan-sweep'].args.some((a) => a.startsWith('--label'))).toBe(false);
  });

  it('the 6 repo-generic passes each get one entry per constellation repo, with the matching --repo=<slug>', () => {
    for (const passName of ['ci-queue-watch', 'parked-pr-conflict-watch', 'parked-pr-progress-watch', 'lane-pool-health-watch', 'stuck-pr-watch', 'ci-red-recovery-watch']) {
      for (const [key, { slug }] of Object.entries(CONSTELLATION_REPOS)) {
        const entry = DAEMON_MANIFEST[`${passName}-${key}`];
        expect(entry, `${passName}-${key}`).toBeDefined();
        expect(entry.args).toContain(`--repo=${slug}`);
      }
    }
  });

  it('lane-pool-health-watch is wired for plateau-app specifically (live-caught 2026-09-22: PR #167 had no lane-pool coverage)', () => {
    expect(DAEMON_MANIFEST['lane-pool-health-watch-plateau-app'].args).toContain('--repo=plateauapp/plateau-app');
  });

  it('epic #3383 stuck-pr-watch runs `sweep` against the real script, per repo, at the shared cadence', () => {
    for (const key of REPO_KEYS) {
      const e = DAEMON_MANIFEST[`stuck-pr-watch-${key}`];
      expect(e.script).toBe('scripts/conveyor/stuck-pr-watch.mjs');
      expect(e.args[0]).toBe('sweep');
      expect(existsSync(join(REPO_ROOT, e.script))).toBe(true);
    }
  });

  it('poc-branch-sync is deliberately absent — it does not exist as a script on main (a false premise in #3873\'s own scope, corrected here rather than invented)', () => {
    expect(Object.keys(DAEMON_MANIFEST).some((n) => n.includes('poc-branch-sync'))).toBe(false);
  });
});

describe('isSafeManifestScriptPath', () => {
  it('accepts a plain repo-relative path', () => {
    expect(isSafeManifestScriptPath('scripts/conveyor/branch-drift.mjs')).toBe(true);
  });
  it('refuses an absolute path, a .. traversal, a NUL byte, or a non-string', () => {
    expect(isSafeManifestScriptPath('/etc/passwd')).toBe(false);
    expect(isSafeManifestScriptPath('../../etc/passwd')).toBe(false);
    expect(isSafeManifestScriptPath('scripts/../../../etc/passwd')).toBe(false);
    expect(isSafeManifestScriptPath('scripts/x\0.mjs')).toBe(false);
    expect(isSafeManifestScriptPath('')).toBe(false);
    expect(isSafeManifestScriptPath(undefined)).toBe(false);
    expect(isSafeManifestScriptPath(42)).toBe(false);
  });
});

describe('assertValidManifestEntry', () => {
  it('accepts a well-formed entry and returns it unchanged', () => {
    const entry = { script: 'scripts/conveyor/branch-drift.mjs', args: ['sweep'], intervalMs: 120_000 };
    expect(assertValidManifestEntry('branch-drift', entry)).toBe(entry);
  });
  it('accepts an entry with no args (optional)', () => {
    const entry = { script: 'scripts/conveyor/x.mjs', intervalMs: 1000 };
    expect(assertValidManifestEntry('x', entry)).toBe(entry);
  });
  it('rejects a missing/unsafe script path', () => {
    expect(() => assertValidManifestEntry('bad', { script: '/etc/passwd', intervalMs: 1000 })).toThrow(/script must be a repo-relative path/);
    expect(() => assertValidManifestEntry('bad', { intervalMs: 1000 })).toThrow(/script must be a repo-relative path/);
  });
  it('rejects non-array or non-string args', () => {
    expect(() => assertValidManifestEntry('bad', { script: 'x.mjs', args: 'sweep', intervalMs: 1000 })).toThrow(/args must be an array of strings/);
    expect(() => assertValidManifestEntry('bad', { script: 'x.mjs', args: [1, 2], intervalMs: 1000 })).toThrow(/args must be an array of strings/);
  });
  it('rejects a non-positive or non-numeric intervalMs', () => {
    expect(() => assertValidManifestEntry('bad', { script: 'x.mjs', intervalMs: 0 })).toThrow(/intervalMs must be a positive number/);
    expect(() => assertValidManifestEntry('bad', { script: 'x.mjs', intervalMs: -5 })).toThrow(/intervalMs must be a positive number/);
    expect(() => assertValidManifestEntry('bad', { script: 'x.mjs', intervalMs: 'soon' })).toThrow(/intervalMs must be a positive number/);
  });
  it('rejects a non-object entry entirely', () => {
    expect(() => assertValidManifestEntry('bad', null)).toThrow(/is not an object/);
    expect(() => assertValidManifestEntry('bad', 'x.mjs')).toThrow(/is not an object/);
  });
});

describe('resolveManifestEntry — the closed-allowlist lookup itself', () => {
  const fixture = { 'ci-queue-watch': { script: 'scripts/conveyor/ci-queue-watch.mjs', args: ['sweep'], intervalMs: 60_000 } };

  it('resolves a known name from a supplied manifest', () => {
    expect(resolveManifestEntry('ci-queue-watch', fixture)).toEqual(fixture['ci-queue-watch']);
  });
  it('refuses an unknown name and names every currently-known entry', () => {
    expect(() => resolveManifestEntry('totally-made-up', fixture)).toThrow(/"totally-made-up" is not in the daemon manifest/);
    expect(() => resolveManifestEntry('totally-made-up', fixture)).toThrow(/Known entries: ci-queue-watch/);
  });
  it('never takes a raw path as the name — a path-shaped name is just another unknown name', () => {
    expect(() => resolveManifestEntry('/etc/passwd', fixture)).toThrow(/is not in the daemon manifest/);
    expect(() => resolveManifestEntry('../../etc/passwd', fixture)).toThrow(/is not in the daemon manifest/);
  });
  it('says so plainly when nothing is registered at all', () => {
    expect(() => resolveManifestEntry('anything', {})).toThrow(/No entries are registered yet/);
  });
  it('re-validates on every lookup — a corrupted on-disk entry still fails closed', () => {
    expect(() => resolveManifestEntry('bad', { bad: { script: '/etc/passwd', intervalMs: 1000 } })).toThrow(/script must be a repo-relative path/);
  });
  it('defaults to the real DAEMON_MANIFEST when none is supplied', () => {
    expect(resolveManifestEntry('branch-drift')).toEqual(DAEMON_MANIFEST['branch-drift']);
    expect(() => resolveManifestEntry('totally-made-up')).toThrow(/"totally-made-up" is not in the daemon manifest/);
  });
});

it('health-responder is a host singleton shadow tick at 60 seconds', () => {
  expect(resolveManifestEntry('health-responder')).toMatchObject({ script: 'scripts/conveyor/health-responder.mjs', args: ['tick'], intervalMs: 60_000 });
});

it('health-responder is resident-only: it never joins the supervisor launcher default launch set', () => {
  expect(DAEMON_MANIFEST['health-responder'].defaultLaunch).toBe(false);
  expect(defaultLaunchNames()).not.toContain('health-responder');
  expect(defaultLaunchNames()).toContain('health-watch');
  // Still resolvable by name: the resident `pass-daemon`/launchd path is the one sanctioned start.
  expect(resolveManifestEntry('health-responder').script).toBe('scripts/conveyor/health-responder.mjs');
});

it('defaultLaunch must be a boolean when present, and false excludes only from the default set', () => {
  const ok = { script: 'scripts/x.mjs', intervalMs: 1000 };
  expect(() => assertValidManifestEntry('x', { ...ok, defaultLaunch: 'no' })).toThrow(/defaultLaunch must be a boolean/);
  expect(assertValidManifestEntry('x', { ...ok, defaultLaunch: false }).defaultLaunch).toBe(false);
  const manifest = { a: ok, b: { ...ok, defaultLaunch: false }, c: { ...ok, defaultLaunch: true } };
  expect(defaultLaunchNames(manifest)).toEqual(['a', 'c']);
  expect(resolveManifestEntry('b', manifest)).toBe(manifest.b);
});

it('does not register the dedicated heavy-run sampler as a pass', () => {
  expect(DAEMON_MANIFEST).not.toHaveProperty('heavy-run-sample');
});
