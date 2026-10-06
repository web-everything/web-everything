/**
 * @file scripts/lib/__tests__/rust-scan-bridge.test.mjs
 * @description Fast, cargo-free unit tests for the fallback contract runWeScan/createWeScanRunner promise
 *   check-standards.mjs's call sites: `null` on ANY failure (missing binary, STALE relative to a declared
 *   reference file, non-zero exit, unparseable output, non-array output), a parsed array on success — never
 *   a thrown error. Uses `createWeScanRunner`'s injection seam with tiny fixture scripts standing in for the
 *   real `we-scan` binary, so this needs no Rust toolchain and stays in the default fast suite (the real
 *   binary's own behavior is proven by scripts/__tests__/rust-scan-*-parity.test.mjs, which does need cargo).
 *
 * The shape-validation and staleness tests are the direct regression coverage for PR #1741's two review
 * findings — see rust-scan-bridge.mjs's own header for the full incident writeup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeScanRunner, SHARED_SUBCOMMANDS } from '../rust-scan-bridge.mjs';

let dir;
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

function fixtureScript(body) {
  dir = mkdtempSync(join(tmpdir(), 'we-scan-bridge-test-'));
  const p = join(dir, 'fake-we-scan');
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Write `path` and set its mtime to `whenMs` (epoch ms) — deterministic staleness fixtures, no real
 *  clock/build timing to race against. */
function touchAt(path, whenMs) {
  writeFileSync(path, '// reference file fixture\n');
  const s = whenMs / 1000;
  utimesSync(path, s, s);
}

describe('createWeScanRunner — the fallback contract (#3417)', () => {
  it('returns null when the binary path does not exist', () => {
    const run = createWeScanRunner('/nonexistent/path/to/we-scan');
    expect(run('stdout-flush', ['--root=.'])).toBeNull();
  });

  it('returns the parsed JSON when the binary succeeds', () => {
    const bin = fixtureScript('echo \'[{"file":"a.mjs","line":1,"kind":"emit-then-exit","text":"x"}]\'');
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'])).toEqual([{ file: 'a.mjs', line: 1, kind: 'emit-then-exit', text: 'x' }]);
  });

  it('returns null when the binary exits non-zero', () => {
    const bin = fixtureScript('echo "boom" >&2; exit 1');
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'])).toBeNull();
  });

  it('returns null when the binary produces unparseable output (a stale/corrupt build)', () => {
    const bin = fixtureScript('echo "not json"');
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'])).toBeNull();
  });

  it('never throws, across missing/failing/malformed cases', () => {
    const cases = [
      createWeScanRunner('/nonexistent/path'),
      createWeScanRunner(fixtureScript('exit 1')),
      createWeScanRunner(fixtureScript('echo "{"')),
    ];
    for (const run of cases) expect(() => run('secret-scrub', ['--root=.'])).not.toThrow();
  });

  // ── PR #1741 review finding 1 (correctness) — reject wrongly-shaped output, don't return it ──────────
  it('returns null when the binary emits valid JSON that is NOT an array (a build predating an output-contract change)', () => {
    const bin = fixtureScript('echo \'{"file":"a.mjs","line":1}\''); // an object, not the array contract
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'])).toBeNull();
  });

  it('an array of any shape passes the array-only check (deep shape is the caller\'s own concern)', () => {
    const bin = fixtureScript('echo \'[]\'');
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'])).toEqual([]);
  });

  it('the malformed-shape case never leaks the wrong-shaped value as a return', () => {
    const bin = fixtureScript('echo \'false\''); // valid JSON, not an array
    const run = createWeScanRunner(bin);
    const result = run('secret-scrub', ['--root=.']);
    expect(result).toBeNull();
    expect(result).not.toBe(false);
  });

  // ── PR #1741 review finding 2 (security) — refuse a binary staler than its JS reference ───────────────
  it('returns null when a referenceFile is NEWER than the binary (built once, JS edited afterward, no rebuild)', () => {
    const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
    utimesSync(bin, 1000, 1000); // binary "built" at t=1000s
    const ref = join(dir, 'reference.mjs');
    touchAt(ref, 2000_000); // reference file edited LATER, at t=2000s
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'], { referenceFiles: [ref] })).toBeNull();
  });

  it('returns the parsed result when the binary is NEWER than every referenceFile (genuinely fresh)', () => {
    const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
    const ref = join(dir, 'reference.mjs');
    touchAt(ref, 1000_000); // reference file written FIRST, at t=1000s
    utimesSync(bin, 2000, 2000); // binary "built" AFTER, at t=2000s
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'], { referenceFiles: [ref] })).toEqual([{ file: 'a.mjs' }]);
  });

  it('a missing referenceFile is not treated as staleness (nothing to compare against)', () => {
    const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'], { referenceFiles: ['/nonexistent/reference.mjs'] })).toEqual([{ file: 'a.mjs' }]);
  });

  it('with MULTIPLE referenceFiles, staleness against ANY one of them is enough to fall back', () => {
    const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
    utimesSync(bin, 1000, 1000);
    const freshRef = join(dir, 'fresh.mjs');
    const staleRef = join(dir, 'stale-trigger.mjs');
    touchAt(freshRef, 500_000); // older than the binary — fine on its own
    touchAt(staleRef, 2000_000); // newer than the binary — this one alone must trigger the fallback
    const run = createWeScanRunner(bin);
    expect(run('stdout-flush', ['--root=.'], { referenceFiles: [freshRef, staleRef] })).toBeNull();
  });

  it('never throws on a staleness-triggering call', () => {
    const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
    utimesSync(bin, 1000, 1000);
    const ref = join(dir, 'reference.mjs');
    touchAt(ref, 2000_000);
    const run = createWeScanRunner(bin);
    expect(() => run('stdout-flush', ['--root=.'], { referenceFiles: [ref] })).not.toThrow();
  });

  // ── #4168 — `opts.scoped` bypasses the binary even when it exists/is fresh/would succeed ────────────────
  // The binary has no file-scoped mode; a caller running `--local --files=…` says so via `scoped: true` and
  // gets `null` straight away, so its OWN file-scoped JS fallback runs instead of the (always whole-corpus)
  // binary silently re-doing the full walk the caller specifically scoped down to avoid.
  describe('opts.scoped (#4168)', () => {
    it('returns null immediately when scoped, even though the binary exists and would succeed', () => {
      const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
      const run = createWeScanRunner(bin);
      expect(run('citation-check', ['--root=.'], { scoped: true })).toBeNull();
    });

    it('scoped:false (or omitted) behaves exactly as before — the binary still runs', () => {
      const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
      const run = createWeScanRunner(bin);
      expect(run('citation-check', ['--root=.'], { scoped: false })).toEqual([{ file: 'a.mjs' }]);
      expect(run('citation-check', ['--root=.'])).toEqual([{ file: 'a.mjs' }]);
    });

    it('never throws when scoped', () => {
      const bin = fixtureScript('echo \'[{"file":"a.mjs"}]\'');
      const run = createWeScanRunner(bin);
      expect(() => run('secret-scrub', ['--root=.'], { scoped: true })).not.toThrow();
    });
  });
});

describe('createWeScanRunner — resolveSharedBin', () => {
  it('runs the shared binary when the local binary is missing and forwards references and subcommand', () => {
    const shared = fixtureScript('echo \'["shared"]\'');
    const referenceFiles = [join(dir, 'reference.mjs')];
    touchAt(referenceFiles[0], 2000_000);
    const resolveSharedBin = vi.fn(() => shared);
    const run = createWeScanRunner(join(dir, 'missing'), { resolveSharedBin });
    expect(run('secret-scrub', ['--root=.'], { referenceFiles })).toEqual(['shared']);
    expect(resolveSharedBin).toHaveBeenCalledTimes(1);
    expect(resolveSharedBin).toHaveBeenCalledWith(referenceFiles, 'secret-scrub');
  });

  it('runs the shared binary even when an existing local binary is stale', () => {
    const shared = fixtureScript('echo \'["shared"]\'');
    // fixtureScript owns the outer cleanup dir; keep the second script independent.
    const localDir = mkdtempSync(join(tmpdir(), 'we-scan-bridge-local-'));
    try {
      const local = join(localDir, 'we-scan');
      writeFileSync(local, '#!/bin/sh\necho \'["local"]\'\n');
      chmodSync(local, 0o755);
      utimesSync(local, 1000, 1000);
      utimesSync(shared, 1000, 1000);
      const ref = join(localDir, 'reference.mjs');
      touchAt(ref, 2000_000);
      const resolveSharedBin = vi.fn(() => shared);
      const run = createWeScanRunner(local, { resolveSharedBin });
      expect(run('stdout-flush', [], { referenceFiles: [ref] })).toEqual(['shared']);
      expect(resolveSharedBin).toHaveBeenCalledTimes(1);
      expect(resolveSharedBin).toHaveBeenCalledWith([ref], 'stdout-flush');
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });

  describe.each(['null', 'throws'])('when the resolver %s', (outcome) => {
    it.each(['missing', 'fresh', 'stale'])('preserves the %s local binary behavior without throwing', (state) => {
      const local = fixtureScript('echo \'["local"]\'');
      const ref = join(dir, 'reference.mjs');
      touchAt(ref, 2000_000);
      utimesSync(local, state === 'stale' ? 1000 : 3000, state === 'stale' ? 1000 : 3000);
      const resolveSharedBin = vi.fn(() => {
        if (outcome === 'throws') throw new Error('cache unavailable');
        return null;
      });
      const run = createWeScanRunner(state === 'missing' ? join(dir, 'missing') : local, { resolveSharedBin });
      let result;
      expect(() => { result = run('stdout-flush', [], { referenceFiles: [ref] }); }).not.toThrow();
      expect(result).toEqual(state === 'fresh' ? ['local'] : null);
      expect(resolveSharedBin).toHaveBeenCalledTimes(1);
      expect(resolveSharedBin).toHaveBeenCalledWith([ref], 'stdout-flush');
    });
  });

  it('never consults the shared resolver for scoped calls', () => {
    const bin = fixtureScript('echo \'["shared"]\'');
    const resolveSharedBin = vi.fn(() => bin);
    const run = createWeScanRunner(bin, { resolveSharedBin });
    expect(run('secret-scrub', [], { scoped: true })).toBeNull();
    expect(resolveSharedBin).not.toHaveBeenCalled();
  });

  it('shares secret-scrub and stdout-flush but not citation-check', () => {
    expect(SHARED_SUBCOMMANDS.has('secret-scrub')).toBe(true);
    expect(SHARED_SUBCOMMANDS.has('stdout-flush')).toBe(true);
    expect(SHARED_SUBCOMMANDS.has('citation-check')).toBe(false);
  });
});
