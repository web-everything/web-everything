/**
 * @file Prevention: every pass the legacy runner ticks must still run SOMEWHERE after the daemon split.
 * Live 2026-10-05: `advisory-label-sweep` (and earlier `ci-red-recovery-watch`) lived only in the retired
 * runner tick, or in a manifest with no launchd template, so nothing ran them. A pass in
 * `MECHANICAL_PASS_NAMES` must have a daemon-manifest entry that a launchd template actually installs, or
 * be named in EXCLUDED below with a reason.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MECHANICAL_PASS_NAMES } from '../runner.mjs';
import { DAEMON_MANIFEST } from '../daemon-manifest.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templateText = [root, join(root, 'launchd')].flatMap((dir) =>
  readdirSync(dir).filter((n) => /^com\.we\..*\.plist\.example$/.test(n)).map((n) => readFileSync(join(dir, n), 'utf8'))).join('\n');

/** Passes with no pass-daemon entry on purpose. Each needs a reason; an entry here is a claim a reviewer can check. */
const EXCLUDED = {
  'reconcile-fix-dispatch': 'owned by the fix-dispatch daemon (com.we.fix-dispatch-daemon), not a pass-daemon',
  'ci-heal-pr-dispatch': 'owned by the review/fix dispatch daemons, not a pass-daemon',
  'promote-draft-pr-dispatch': 'owned by the review/fix dispatch daemons, not a pass-daemon',
  'reconcile-pass': 'runs standalone inside skills-src/conveyor/review-daemon.mjs (com.we.review-daemon)',
  'hiccup-sink': 'dynamic import inside the runner, no standalone invocation',
};

/**
 * KNOWN ORPHANS, found by this test on 2026-10-05 and NOT fixed in the same PR as it (scope). These have no
 * launchd template in the repo. A hand-made plist on one machine does not count: it vanishes with the machine.
 * This list may only SHRINK: the second test fails when an entry gains a template, so remove it then.
 * Fix = add a template (and a manifest entry where there is none), then delete the line.
 */
const KNOWN_ORPHANS = {
  'infra-blocked': 'manifest entry, no template, not loaded on the dev machine',
  'branch-drift': 'manifest entry, no template, not loaded on the dev machine',
  'ci-queue-watch': 'manifest entries, no template, not loaded on the dev machine',
  'duplicate-pr-watch': 'manifest entry, no template, not loaded on the dev machine',
  'parked-pr-progress-watch': 'manifest entries, no template, not loaded on the dev machine',
  'lease-reaper': 'manifest entry, no template; loaded on the dev machine only via a hand-made plist',
  'lane-pool-health-watch': 'manifest entries, no template; loaded on the dev machine only via hand-made plists',
  'parked-pr-conflict-watch': 'manifest entries, no template; loaded on the dev machine only via hand-made plists',
  'session-reaper': 'no manifest entry and no template: nothing runs it since the runner split',
  'operator-notify': 'no manifest entry and no template: nothing runs it since the runner split',
  'review-hold-reconcile': 'no manifest entry and no template: nothing runs it since the runner split',
};

const entriesFor = (pass) => Object.keys(DAEMON_MANIFEST).filter((k) => k === pass || k.startsWith(`${pass}-`));
const hasTemplate = (key) => templateText.includes(`--pass=${key}<`);

describe('legacy runner passes still run somewhere', () => {
  it('every runner pass has an installed daemon entry or a reasoned exclusion', () => {
    const orphans = MECHANICAL_PASS_NAMES.filter((pass) => !(pass in EXCLUDED) && !(pass in KNOWN_ORPHANS))
      .filter((pass) => !entriesFor(pass).some(hasTemplate));
    expect(orphans, 'runner passes with no manifest entry + launchd template, no exclusion, not a known orphan').toEqual([]);
  });

  it('every exclusion is real and carries a reason', () => {
    for (const [pass, why] of Object.entries(EXCLUDED)) {
      expect(MECHANICAL_PASS_NAMES, pass).toContain(pass);
      expect(why.length, pass).toBeGreaterThan(10);
      expect(entriesFor(pass).some(hasTemplate), `${pass} is excluded but IS installed; drop the exclusion`).toBe(false);
    }
  });

  it('the known-orphan list only shrinks: each entry is real and still orphaned', () => {
    for (const [pass, why] of Object.entries(KNOWN_ORPHANS)) {
      expect(MECHANICAL_PASS_NAMES, pass).toContain(pass);
      expect(why.length, pass).toBeGreaterThan(10);
      expect(entriesFor(pass).some(hasTemplate), `${pass} now has a template; remove it from KNOWN_ORPHANS`).toBe(false);
    }
  });

  it('advisory-label-sweep is installed from a repo template (the live 2026-10-05 gap)', () => {
    expect(entriesFor('advisory-label-sweep').some(hasTemplate)).toBe(true);
  });
});
