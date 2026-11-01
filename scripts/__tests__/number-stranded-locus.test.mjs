import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WE_SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * #1961 — `number-stranded`'s lane refusal, tested at the level that actually runs.
 *
 * Round 2 asked for the WIRING, not the predicate: a tested `isLaneLocus` that `numberStranded()` failed to
 * call would still ship a guard that never fires. Round 3's juror then found the guard was asking the WRONG
 * QUESTION — it tested `process.cwd()` while the repair writes to `ROOT`, this script's own checkout. Invoked
 * by absolute path from an unrelated directory the guard passed and the verb went on to renumber the LANE's
 * cards, which is precisely the half-applied rename it exists to prevent. Confirmed against the running code
 * before the fix: it offered to number 2 real cards.
 *
 * So both cases below decouple cwd from ROOT deliberately, by planting a COPY of the scripts tree at a
 * chosen locus (the #2274 throwaway-clone substrate `we:scripts/backlog/__tests__/resolve-parent-cli.test.mjs`
 * uses) and running it from somewhere else entirely. A test that only ever runs `cd <checkout> && node
 * scripts/backlog.mjs` cannot tell the two apart — which is why the hole survived two rounds.
 */
let laneRoot;   // a LANE-shaped ROOT: <tmp>/.lanes/<pool>/lane-1
let plainRoot;  // a NON-lane ROOT
let elsewhere;  // a cwd unrelated to both

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'ns-locus-'));
  laneRoot = join(base, '.lanes', 'web-everything', 'lane-1');
  plainRoot = join(base, 'primary');
  elsewhere = join(base, 'elsewhere');
  for (const d of [laneRoot, plainRoot, elsewhere]) mkdirSync(d, { recursive: true });
  for (const root of [laneRoot, plainRoot]) {
    cpSync(WE_SCRIPTS_DIR, join(root, 'scripts'), { recursive: true });
    cpSync(join(dirname(WE_SCRIPTS_DIR), 'skills-src/conveyor/daemon-manifest.mjs'),
      join(root, 'skills-src/conveyor/daemon-manifest.mjs'));
    // The transcript check imports this skill module during CLI startup.
    cpSync(join(dirname(WE_SCRIPTS_DIR), 'skills-src', 'inspect-codex-transcript'),
      join(root, 'skills-src', 'inspect-codex-transcript'), { recursive: true });
    symlinkSync(join(dirname(WE_SCRIPTS_DIR), 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'backlog'), { recursive: true });
  }
});
afterAll(() => {
  try { rmSync(join(laneRoot, '..', '..', '..'), { recursive: true, force: true }); } catch { /* best-effort */ }
});

const run = (root, cwd) => {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'backlog.mjs'), 'number-stranded', '--dry-run'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

describe('number-stranded refuses on the locus it PROTECTS, not the one it is called from (#1961)', () => {
  it('REFUSES when the script lives in a lane, even invoked from a non-lane cwd', () => {
    // The hole round 3 closed. Before the fix this returned 0 and offered to renumber the lane's cards.
    const { code, out } = run(laneRoot, elsewhere);
    expect(code).not.toBe(0);
    expect(out).toMatch(/refusing to run in a LANE clone/);
    // A refusal that does not say where to go is a dead end — both remedies must be named.
    expect(out).toMatch(/PRIMARY checkout/);
    expect(out).toMatch(/drain/);
  });

  it('REFUSES from inside the lane too — the ordinary invocation still holds', () => {
    const { code, out } = run(laneRoot, laneRoot);
    expect(code).not.toBe(0);
    expect(out).toMatch(/refusing to run in a LANE clone/);
  });

  it('does NOT refuse on locus grounds when the script lives OUTSIDE a lane', () => {
    // The guard must not fire everywhere. Asserted from a lane-free cwd AND from `elsewhere`, so neither a
    // cwd-based nor a ROOT-based reading can pass this by accident.
    for (const cwd of [plainRoot, elsewhere]) {
      const { code, out } = run(plainRoot, cwd);
      expect(code, out).toBe(0);
      expect(out, `cwd=${cwd}`).not.toMatch(/refusing to run in a LANE clone/);
    }
  });
});
