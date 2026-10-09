/** @file hermetic-test-scan.test.mjs — the live-read ratchet over test + soak sources (card xcu4cqf). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBaseline, checkHermeticBaseline, findLiveReads, isHermeticScanSource, scanHermeticTests } from '../hermetic-test-scan.mjs';
import { loadHermeticSettings } from '../hermetic-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const settings = loadHermeticSettings(ROOT);
const kinds = (src) => findLiveReads(src, settings).map((f) => f.kind);

describe('live-read detector', () => {
  it('flags the 2026-10-08 incident shape: the orphan-adopt pass driven without its delivery reader injected', () => {
    const src = `const results = await adoptOrphanedBuildClaims({
      listClaims: () => [], findRow: () => null, spawnResume: () => 1,
    });`;
    expect(findLiveReads(src, settings)).toMatchObject([{ line: 1, kind: 'live-reader-uninjected' }]);
    expect(findLiveReads(src, settings)[0].text).toMatch(/readDelivery/);
  });
  it('accepts the same call once every live seam is injected (the PR #4522 shape)', () => {
    const src = `adoptOrphanedBuildClaims({ listClaims, spawnResume: () => 1, readDelivery: (n) => null,
      sessionLivenessFor: () => null, recordFailure: () => {}, releaseLaneLease: () => {} });`;
    expect(kinds(src)).toEqual([]);
  });
  it.each([
    ["execFileSync('gh', ['pr', 'list'])", 'real-gh-spawn'],
    ["const out = spawnSync('gh', args, opts)", 'real-gh-spawn'],
    ["readFileSync(join(homedir(), '.claude', 'daemon-self-sync-state', 'q.json'))", 'real-home-state'],
    ["execFileSync('git', ['show', 'origin/main:backlog/x.md'], { cwd: ROOT })", 'remote-ref-read'],
    ["process.env.WE_TEST_HERMETIC = '0';", 'hermetic-opt-out'],
    ["readBuildDelivery(4382)", 'live-reader-uninjected'],
  ])('flags %s', (src, kind) => {
    expect(kinds(src)).toEqual([kind]);
  });
  it.each([
    "// execFileSync('gh', ['pr', 'list'])",
    "const fixture = \"execFileSync('gh', ['pr', 'list'])\";",
    "writeFileSync(join(binDir, 'gh'), fakeGh); execFileSync('gh', ['pr', 'list'], { env })",
    "expect(statePath({})).toBe(join(homedir(), '.claude', 'conveyor', 'x'));",
    "execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: lane })",
    "readGh(['api'], { exec: fakeExec })",
    "readBuildDelivery(4382, { listPrs: () => [], readCardStatus: () => 'open', readCardOpened: () => null })",
    "import { adoptOrphanedBuildClaims } from '../build-dispatch-orphan-adopt.mjs';",
  ])('ignores %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });
  it('scans tests and soak scenarios, not production code or its own fixtures', () => {
    expect(isHermeticScanSource('scripts/x/__tests__/a.test.mjs')).toBe(true);
    expect(isHermeticScanSource('scripts/conveyor/soak/breaks/build-dispatch-orphan-adopt.mjs')).toBe(true);
    expect(isHermeticScanSource('blocks/x/__tests__/a.test.ts')).toBe(true);
    expect(isHermeticScanSource('scripts/conveyor/build-dispatch-orphan-adopt.mjs')).toBe(false);
    expect(isHermeticScanSource('scripts/lib/__tests__/hermetic-test-scan.test.mjs')).toBe(false);
  });
  it('a live-suite file is allowed to be live (it never runs in a blocking suite)', () => {
    const file = settings.liveSuite.tests[0].file;
    const { counts } = scanHermeticTests(ROOT, { files: [file], read: () => "execFileSync('gh', ['pr', 'list'])" });
    expect(counts).toEqual({});
  });
  it('is red on a fixture adding a live read to a clean file', () => {
    expect(checkBaseline({ 'scripts/__tests__/new.test.mjs': 1 }, {}).regressions).toEqual([{ file: 'scripts/__tests__/new.test.mjs', count: 1, allowed: 0 }]);
  });
});

describe('tracked test-source live-read ratchet', () => {
  it('has no per-file regressions, and the baseline equals a fresh scan (it can only shrink)', () => {
    const { counts, baseline, regressions, findings } = checkHermeticBaseline(ROOT);
    expect(regressions, JSON.stringify(regressions.map((r) => ({ ...r, findings: findings[r.file] })), null, 2)).toEqual([]);
    expect(counts, 'Regenerate with node scripts/lib/hermetic-test-scan.mjs --write-baseline after an improvement').toEqual(baseline);
  });
  it('the committed baseline is valid JSON of positive integers', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'scripts/hermetic-test-baseline.json'), 'utf8'));
    for (const [f, n] of Object.entries(raw)) expect(Number.isInteger(n) && n > 0, f).toBe(true);
  });
});
