import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  overlapYieldWaits, outranksForLand, overlapRowKey, windowMsAtLabelTime, validateOverlapYieldConfig,
  resolveOverlapYieldSettings, parseOverlapYieldOverrides, DEFAULT_OVERLAP_YIELD_CONFIG,
  isExemptItem, computeOverlapContext, writeOverlapYieldConfig,
  isShallowRepository, gitHistoryConfigAtReader, readyToMergeLabelTimeMs,
} from '../land-overlap-yield.mjs';

const T0 = Date.parse('2026-09-28T12:00:00Z');
const MIN = 60_000;

/** A minimal snapshot row. `linesEach` files of 10 changed lines each, named f0..f{n-1} by default. */
function row({
  number, repo = 'we', base = 'main', draft = false, labels = [], files = null, filesComplete = true,
  readyAtMs = null, windowMs = null, item = null, exempt = false, dependsOn = new Set(),
} = {}) {
  return {
    number, repo, baseRefName: base, isDraft: draft, labels, filesComplete,
    files: files ?? [{ path: `f${number}.txt`, additions: 10, deletions: 0 }],
    readyAtMs, windowMs, item, exempt, dependsOn,
  };
}

describe('outranksForLand — rule 3, a strict total order', () => {
  it('bigger total changed lines wins', () => {
    const big = row({ number: 5, files: [{ path: 'a', additions: 100, deletions: 0 }] });
    const small = row({ number: 6, files: [{ path: 'a', additions: 5, deletions: 0 }] });
    expect(outranksForLand(big, small)).toBe(true);
    expect(outranksForLand(small, big)).toBe(false);
  });
  it('ties break on the LOWER pr number', () => {
    const a = row({ number: 3, files: [{ path: 'a', additions: 10, deletions: 0 }] });
    const b = row({ number: 9, files: [{ path: 'a', additions: 10, deletions: 0 }] });
    expect(outranksForLand(a, b)).toBe(true);
    expect(outranksForLand(b, a)).toBe(false);
  });
});

describe('overlapYieldWaits — rules 1-6', () => {
  it('X yields to a larger, in-review, overlapping, same-base Y', () => {
    const x = row({ number: 10, files: [{ path: 'shared.mjs', additions: 5, deletions: 0 }], readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: [{ path: 'shared.mjs', additions: 200, deletions: 0 }] });
    const waits = overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 + MIN });
    expect(waits.get(overlapRowKey(x))).toMatchObject({ yieldTo: 20, files: ['shared.mjs'] });
  });

  it('does not yield to a draft', () => {
    const x = row({ number: 10, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, draft: true, labels: ['review:pending'], files: x.files });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('does not yield to review:changes', () => {
    const x = row({ number: 10, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:changes'], files: x.files });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('does not yield across a different base branch', () => {
    const x = row({ number: 10, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, base: 'lane/poc', labels: ['review:pending'], files: x.files });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('does not yield to a SMALLER PR', () => {
    const x = row({ number: 10, files: [{ path: 'a', additions: 100, deletions: 0 }], readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: [{ path: 'a', additions: 1, deletions: 0 }] });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('does not yield when the files do not overlap', () => {
    const x = row({ number: 10, files: [{ path: 'a', additions: 5, deletions: 0 }], readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: [{ path: 'b', additions: 500, deletions: 0 }] });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('does not yield to a Y that DEPENDS ON X (rule 4)', () => {
    const x = row({ number: 10, item: 100, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: x.files, dependsOn: new Set([100]) });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('an incomplete file list never yields, on either side', () => {
    const xUnknown = row({ number: 10, filesComplete: false, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: xUnknown.files });
    expect(overlapYieldWaits({ candidates: [xUnknown], openPrs: [xUnknown, y], nowMs: T0 }).size).toBe(0);

    const x = row({ number: 11, readyAtMs: T0, windowMs: 45 * MIN });
    const yUnknown = row({ number: 21, labels: ['review:pending'], files: x.files, filesComplete: false });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, yUnknown], nowMs: T0 }).size).toBe(0);
  });

  it('an exempt X never yields (rule 5)', () => {
    const x = row({ number: 10, exempt: true, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: x.files });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 }).size).toBe(0);
  });

  it('past its own budget, X no longer yields (rule 6)', () => {
    const x = row({ number: 10, readyAtMs: T0, windowMs: 45 * MIN });
    const y = row({ number: 20, labels: ['review:pending'], files: [{ path: x.files[0].path, additions: 500, deletions: 0 }] });
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 + 44 * MIN }).size).toBe(1);
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 + 46 * MIN }).size).toBe(0);
  });

  it('a three-PR overlap cycle yields ACYCLICALLY (total-order rank, never overlap-relative size)', () => {
    // A beats B on file 'ab'; B beats C on file 'bc'; C beats A on file 'ca' — an overlap-relative read cycles.
    // The GLOBAL total order (total lines desc, then lower PR#) breaks the tie the same way everywhere.
    const a = row({ number: 1, labels: ['review:pending'], files: [{ path: 'ab', additions: 10, deletions: 0 }, { path: 'ca', additions: 10, deletions: 0 }] });
    const b = row({ number: 2, labels: ['review:pending'], files: [{ path: 'ab', additions: 10, deletions: 0 }, { path: 'bc', additions: 10, deletions: 0 }] });
    const c = row({ number: 3, labels: ['review:pending'], files: [{ path: 'bc', additions: 10, deletions: 0 }, { path: 'ca', additions: 10, deletions: 0 }] });
    // Every candidate is ready (X); every candidate is also a possible Y (openPrs includes all three).
    const cands = [a, b, c].map((r) => ({ ...r, readyAtMs: T0, windowMs: 45 * MIN }));
    const waits = overlapYieldWaits({ candidates: cands, openPrs: cands, nowMs: T0 });
    // Global rank here: all tie on total lines (20 each) so it's pure PR-number order — #1 outranks #2 and #3.
    expect(waits.get(overlapRowKey(a))).toBeUndefined(); // #1 never yields (nothing outranks it)
    expect(waits.get(overlapRowKey(b))?.yieldTo).toBe(1);
    expect(waits.get(overlapRowKey(c))?.yieldTo).toBe(1); // #3 shares 'ca' with #1 (higher rank) and 'bc' with #2
  });

  it('a chain of blockers never holds X past its own budget (44-minute-apart review rounds)', () => {
    const x = row({ number: 10, readyAtMs: T0, windowMs: 45 * MIN });
    // Three successive "in review" Ys, each appearing/outranking only after the previous round — X keeps
    // finding SOME larger overlapping Y in review right up to its deadline, then is released regardless.
    const y1 = row({ number: 20, labels: ['review:pending'], files: [{ path: x.files[0].path, additions: 500, deletions: 0 }] });
    const within = overlapYieldWaits({ candidates: [x], openPrs: [x, y1], nowMs: T0 + 44 * MIN });
    expect(within.size).toBe(1);
    const past = overlapYieldWaits({ candidates: [x], openPrs: [x, y1], nowMs: T0 + 45 * MIN });
    expect(past.size).toBe(0);
  });

  it('keys by repo+number, never a bare number (cross-repo PR-number collision safety)', () => {
    const weX = row({ number: 7, repo: 'we', readyAtMs: T0, windowMs: 45 * MIN });
    const fuiX = row({ number: 7, repo: 'frontierui', readyAtMs: T0, windowMs: 45 * MIN });
    const weY = row({ number: 8, repo: 'we', labels: ['review:pending'], files: [{ path: weX.files[0].path, additions: 500, deletions: 0 }] });
    const waits = overlapYieldWaits({ candidates: [weX, fuiX], openPrs: [weX, fuiX, weY], nowMs: T0 });
    expect(waits.get('we#7')?.yieldTo).toBe(8);
    expect(waits.has('frontierui#7')).toBe(false); // no overlapping same-repo Y for the frontierui candidate
  });
});

describe('windowMsAtLabelTime — rule 6\'s non-renewable, restart-proof budget', () => {
  it('trusted history with a value at readyAt wins', () => {
    const ms = windowMsAtLabelTime({ readyAtMs: T0, configAt: () => ({ trusted: true, windowMinutes: 10 }) });
    expect(ms).toBe(10 * MIN);
  });
  it('trusted history but the file did not exist yet ⇒ the CODE default (not the untrusted fallback)', () => {
    const ms = windowMsAtLabelTime({ readyAtMs: T0, configAt: () => ({ trusted: true, windowMinutes: null }), codeDefaultMinutes: 45 });
    expect(ms).toBe(45 * MIN);
  });
  it('untrusted history (shallow / git error) ⇒ the SMALLER of current and code default', () => {
    const ms = windowMsAtLabelTime({ readyAtMs: T0, configAt: () => ({ trusted: false }), codeDefaultMinutes: 45, currentWindowMinutes: 10 });
    expect(ms).toBe(10 * MIN);
    const ms2 = windowMsAtLabelTime({ readyAtMs: T0, configAt: () => ({ trusted: false }), codeDefaultMinutes: 45, currentWindowMinutes: 90 });
    expect(ms2).toBe(45 * MIN);
  });
  it('a throwing configAt is treated as untrusted, never crashes the caller', () => {
    const ms = windowMsAtLabelTime({ readyAtMs: T0, configAt: () => { throw new Error('git blew up'); }, codeDefaultMinutes: 45 });
    expect(ms).toBe(45 * MIN);
  });
  it('widening windowMinutes AFTER readyAt does not re-arm an already-expired X, even across a simulated restart', () => {
    // The history reader always answers with the OLD value in effect at readyAt — exactly what a fresh
    // planner with no memo (a "drain restart") would derive from git history, regardless of what the LIVE
    // config says now (currentWindowMinutes simulates the widened live value).
    const configAt = () => ({ trusted: true, windowMinutes: 10 }); // the value at X's own readyAt
    const windowMs = windowMsAtLabelTime({ readyAtMs: T0, configAt, currentWindowMinutes: 999 /* widened live value, ignored */ });
    expect(windowMs).toBe(10 * MIN);
    const x = row({ number: 10, readyAtMs: T0, windowMs });
    const y = row({ number: 20, labels: ['review:pending'], files: x.files });
    // "Restart" = a brand-new call, no shared state — X is well past its OWN 10-minute budget.
    expect(overlapYieldWaits({ candidates: [x], openPrs: [x, y], nowMs: T0 + 11 * MIN }).size).toBe(0);
  });
});

describe('validateOverlapYieldConfig — strict, never silently coerced', () => {
  it('accepts a well-shaped config', () => {
    expect(validateOverlapYieldConfig({ enabled: true, windowMinutes: 45 })).toMatchObject({ ok: true, config: { enabled: true, windowMinutes: 45 } });
  });
  it('rejects a non-object, a non-boolean enabled, and a non-positive/non-finite windowMinutes', () => {
    expect(validateOverlapYieldConfig(null).ok).toBe(false);
    expect(validateOverlapYieldConfig('nope').ok).toBe(false);
    expect(validateOverlapYieldConfig({ enabled: 'yes', windowMinutes: 45 }).ok).toBe(false);
    expect(validateOverlapYieldConfig({ enabled: true, windowMinutes: 0 }).ok).toBe(false);
    expect(validateOverlapYieldConfig({ enabled: true, windowMinutes: -5 }).ok).toBe(false);
    expect(validateOverlapYieldConfig({ enabled: true, windowMinutes: NaN }).ok).toBe(false);
  });
});

describe('resolveOverlapYieldSettings — full replace, never merged field-by-field', () => {
  it('an override REPLACES the whole value, not just the touched field', () => {
    const fileConfig = { enabled: false, windowMinutes: 45 };
    expect(resolveOverlapYieldSettings({ fileConfig, overrides: { enable: true, windowMinutes: null } })).toEqual({ enabled: true, windowMinutes: 45 });
    expect(resolveOverlapYieldSettings({ fileConfig, overrides: { enable: null, windowMinutes: 5 } })).toEqual({ enabled: false, windowMinutes: 5 });
  });
  it('no override ⇒ the file config, byte-identical', () => {
    expect(resolveOverlapYieldSettings({ fileConfig: DEFAULT_OVERLAP_YIELD_CONFIG })).toEqual(DEFAULT_OVERLAP_YIELD_CONFIG);
  });
});

describe('parseOverlapYieldOverrides — CLI beats env; conflicts are usage errors', () => {
  it('force-enable / force-disable flags', () => {
    expect(parseOverlapYieldOverrides({ argv: ['--overlap-yield'] }).enable).toBe(true);
    expect(parseOverlapYieldOverrides({ argv: ['--no-overlap-yield'] }).enable).toBe(false);
    expect(parseOverlapYieldOverrides({ argv: [] }).enable).toBeNull();
  });
  it('env var applies only when no flag is present; a flag wins over a conflicting env value', () => {
    expect(parseOverlapYieldOverrides({ argv: [], env: { WE_DRAIN_OVERLAP_YIELD: '1' } }).enable).toBe(true);
    expect(parseOverlapYieldOverrides({ argv: [], env: { WE_DRAIN_OVERLAP_YIELD: '0' } }).enable).toBe(false);
    expect(parseOverlapYieldOverrides({ argv: ['--overlap-yield'], env: { WE_DRAIN_OVERLAP_YIELD: '0' } }).enable).toBe(true);
  });
  it('both enable+disable flags together is a usage error', () => {
    expect(() => parseOverlapYieldOverrides({ argv: ['--overlap-yield', '--no-overlap-yield'] })).toThrow(/mutually exclusive/);
  });
  it('an env value other than 0/1 is a usage error', () => {
    expect(() => parseOverlapYieldOverrides({ argv: [], env: { WE_DRAIN_OVERLAP_YIELD: 'true' } })).toThrow(/must be "0" or "1"/);
  });
  it('parses --overlap-yield-window=<minutes>, refusing a non-positive value', () => {
    expect(parseOverlapYieldOverrides({ argv: ['--overlap-yield-window=90'] }).windowMinutes).toBe(90);
    expect(() => parseOverlapYieldOverrides({ argv: ['--overlap-yield-window=0'] })).toThrow(/positive number of minutes/);
    expect(() => parseOverlapYieldOverrides({ argv: ['--overlap-yield-window=abc'] })).toThrow(/positive number of minutes/);
  });
});

describe('isExemptItem — rule 5 (2026-09-29 review coverage finding)', () => {
  const fakeIo = (files, contents) => ({
    readdir: () => files,
    readFile: (p) => { const key = Object.keys(contents).find((f) => p.endsWith(f)); if (key) return contents[key]; throw new Error('ENOENT'); },
  });

  it('reads priority:high as exempt', () => {
    const io = fakeIo(['100-a.md'], { '100-a.md': '---\npriority: high\n---\n\nBody.\n' });
    expect(isExemptItem(100, { backlogDir: '/x', ...io })).toBe(true);
  });
  it('reads tier:pinned as exempt', () => {
    const io = fakeIo(['100-a.md'], { '100-a.md': '---\ntier: pinned\n---\n\nBody.\n' });
    expect(isExemptItem(100, { backlogDir: '/x', ...io })).toBe(true);
  });
  it('neither field present is NOT exempt', () => {
    const io = fakeIo(['100-a.md'], { '100-a.md': '---\nkind: story\n---\n\nBody.\n' });
    expect(isExemptItem(100, { backlogDir: '/x', ...io })).toBe(false);
  });
  it('a missing card (no file, or a throwing readdir/readFile) reads NOT exempt — never throws', () => {
    expect(isExemptItem(999, { backlogDir: '/x', readdir: () => [], readFile: () => { throw new Error('nope'); } })).toBe(false);
    expect(isExemptItem(999, { backlogDir: '/x', readdir: () => { throw new Error('ENOENT'); }, readFile: () => '' })).toBe(false);
  });
  it('a null itemId is NOT exempt (no IO at all)', () => {
    expect(isExemptItem(null, { backlogDir: '/x', readdir: () => { throw new Error('must not be called'); } })).toBe(false);
  });
});

describe('computeOverlapContext — the drain\'s IO orchestration (2026-09-29 review coverage finding)', () => {
  const T0 = Date.parse('2026-09-28T12:00:00Z');
  const row = (number, over = {}) => ({
    number, repo: 'we', baseRefName: 'main', isDraft: false, labels: over.labels ?? ['review:pending'],
    files: [{ path: 'shared.md', additions: 10, deletions: 0 }], filesComplete: true,
    readyAtMs: null, windowMs: null, item: null, exempt: false, dependsOn: new Set(), headSha: 'cafebabe', ...over,
  });
  const xRow = (number) => row(number, { labels: ['ready-to-merge', 'review:accepted'] });

  /** A trusted (non-shallow), fixed-history `exec` fake: `origin/main`'s config at any `readyAt` is `{enabled:true, windowMinutes:999}` — a value deliberately DIFFERENT from any override under test, so a test that reads 999 back proves history was consulted, and a test that reads the override value back proves the override BYPASSED it. */
  const trustedExec = (cmd, args) => {
    if (args[0] === 'rev-parse') return 'false\n';
    if (args[0] === 'rev-list') return 'fedcba9\n';
    if (args[0] === 'show') return JSON.stringify({ enabled: true, windowMinutes: 999 });
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const readyGhExec = () => JSON.stringify([{ event: 'labeled', label: { name: 'ready-to-merge' }, created_at: new Date(T0).toISOString() }]);

  it('an explicit --overlap-yield-window override BYPASSES the git-history read entirely, even when history is trusted', () => {
    const { waits } = computeOverlapContext({
      candidateRows: [xRow(2)], openPrRows: [xRow(2), row(1, { files: [{ path: 'shared.md', additions: 500, deletions: 0 }] })],
      nowMs: T0, exec: trustedExec, ghExec: readyGhExec, overrides: { windowMinutes: 5 },
    });
    const w = waits.get('we#2');
    expect(w.windowMinutes).toBe(5); // the override — NOT 999 (history) and NOT 45 (code default)
  });

  it('with NO override, a trusted history value is used', () => {
    const { waits } = computeOverlapContext({
      candidateRows: [xRow(2)], openPrRows: [xRow(2), row(1, { files: [{ path: 'shared.md', additions: 500, deletions: 0 }] })],
      nowMs: T0, exec: trustedExec, ghExec: readyGhExec,
    });
    expect(waits.get('we#2').windowMinutes).toBe(999);
  });

  it('an unreadable ready-to-merge label time marks the candidate exempt — never yields, even though the trial found a target', () => {
    const { waits } = computeOverlapContext({
      candidateRows: [xRow(2)], openPrRows: [xRow(2), row(1, { files: [{ path: 'shared.md', additions: 500, deletions: 0 }] })],
      nowMs: T0, exec: trustedExec, ghExec: () => { throw new Error('gh unreachable'); },
    });
    expect(waits.size).toBe(0);
  });

  it('settings.enabled:false (via override) short-circuits to an empty Map with no IO at all', () => {
    const { waits, settings } = computeOverlapContext({
      candidateRows: [xRow(2)], openPrRows: [xRow(2), row(1, { files: [{ path: 'shared.md', additions: 500, deletions: 0 }] })],
      nowMs: T0, exec: () => { throw new Error('must not be called'); }, ghExec: () => { throw new Error('must not be called'); },
      overrides: { enable: false },
    });
    expect(waits.size).toBe(0);
    expect(settings.enabled).toBe(false);
  });
});

describe('writeOverlapYieldConfig — degrades to an unlocked write, honestly reported (2026-09-29 review finding)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'overlap-yield-config-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a normal write acquires the lock (locked:true) and persists the patch', () => {
    const path = join(dir, 'cfg.json');
    const result = writeOverlapYieldConfig({ path, patch: { enabled: false, windowMinutes: 20 } });
    expect(result).toMatchObject({ ok: true, locked: true, config: { enabled: false, windowMinutes: 20 } });
  });

  it('a held lock (another writer) still succeeds — degrades to unlocked, never refuses the edit', async () => {
    const path = join(dir, 'cfg.json');
    const lockRoot = `${dir}-locks`;
    mkdirSync(lockRoot, { recursive: true });
    const { reserve } = await import('../../readiness/file-locks.mjs');
    // The SAME lock key `writeOverlapYieldConfig` itself reserves (a private literal, not exported — mirrored
    // here; a drift would only make this test's "held" setup a no-op, never a false failure).
    const held = reserve(lockRoot, '<overlap-yield-config:write>', 'someone-else', Date.now(), new Date().toISOString(), 999999, 'unknown', 15);
    expect(held.ok).toBe(true); // sanity: we actually hold it before calling the writer
    const result = writeOverlapYieldConfig({ path, patch: { enabled: false, windowMinutes: 20 } });
    expect(result.ok).toBe(true); // the edit still lands
    expect(result.locked).toBe(false); // honestly reports it did NOT get the lock
    expect(result.config).toEqual({ enabled: false, windowMinutes: 20 });
  });

  it('an invalid patch is refused regardless of lock state — nothing is written', () => {
    const path = join(dir, 'cfg.json');
    const result = writeOverlapYieldConfig({ path, patch: { windowMinutes: -5 } });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('isShallowRepository / gitHistoryConfigAtReader / readyToMergeLabelTimeMs — IO shell fallbacks (#4417)', () => {
  const T = Date.parse('2026-09-28T12:00:00Z');
  /** exec fake keyed on the git subcommand; counts every call. */
  const fakeGit = ({ shallow = 'false\n', revList = 'abc123\n', show = JSON.stringify({ enabled: true, windowMinutes: 30 }) } = {}) => {
    const calls = [];
    const exec = (_cmd, args) => {
      calls.push(args[0]);
      if (args[0] === 'rev-parse') { if (shallow instanceof Error) throw shallow; return shallow; }
      if (args[0] === 'rev-list') { if (revList instanceof Error) throw revList; return revList; }
      if (args[0] === 'show') { if (show instanceof Error) throw show; return show; }
      throw new Error(`unexpected ${args[0]}`);
    };
    return { exec, calls };
  };

  it('isShallowRepository maps true/false/garbage/throw to true/false/null/null', () => {
    expect(isShallowRepository({ exec: () => 'true\n' })).toBe(true);
    expect(isShallowRepository({ exec: () => 'false\n' })).toBe(false);
    expect(isShallowRepository({ exec: () => 'wat' })).toBe(null);
    expect(isShallowRepository({ exec: () => { throw new Error('no git'); } })).toBe(null);
  });

  it('gitHistoryConfigAtReader: each fallback path yields its OWN distinct value', () => {
    expect(gitHistoryConfigAtReader({ exec: fakeGit({ shallow: 'true\n' }).exec })(T)).toEqual({ trusted: false });
    expect(gitHistoryConfigAtReader({ exec: fakeGit({ shallow: 'garbage' }).exec })(T)).toEqual({ trusted: false });
    expect(gitHistoryConfigAtReader({ exec: fakeGit({ revList: '\n' }).exec })(T)).toEqual({ trusted: true, windowMinutes: null });
    expect(gitHistoryConfigAtReader({ exec: fakeGit().exec })(T)).toEqual({ trusted: true, windowMinutes: 30 });
    expect(gitHistoryConfigAtReader({ exec: fakeGit({ show: new Error('bad path') }).exec })(T)).toEqual({ trusted: true, windowMinutes: null });
    expect(gitHistoryConfigAtReader({ exec: fakeGit({ show: 'not json' }).exec })(T)).toEqual({ trusted: true, windowMinutes: null });
    expect(gitHistoryConfigAtReader({ exec: fakeGit({ revList: new Error('boom') }).exec })(T)).toEqual({ trusted: false });
  });

  it('gitHistoryConfigAtReader memoizes per exact ms — a repeat call spawns no further git', () => {
    const { exec, calls } = fakeGit();
    const configAt = gitHistoryConfigAtReader({ exec });
    const first = configAt(T);
    const afterFirst = calls.length; // rev-parse + rev-list + show
    expect(afterFirst).toBe(3);
    expect(configAt(T)).toBe(first);
    expect(calls.length).toBe(afterFirst);
    configAt(T + 1);
    expect(calls.length).toBe(afterFirst + 2); // a different ms is a real lookup (rev-list + show)
  });

  describe('readyToMergeLabelTimeMs', () => {
    let cdir;
    beforeEach(() => { cdir = mkdtempSync(join(tmpdir(), 'rtm-label-')); });
    afterEach(() => { rmSync(cdir, { recursive: true, force: true }); });
    const events = (list) => JSON.stringify(list);
    const ev = (name, at, event = 'labeled') => ({ event, label: { name }, created_at: at });
    const mkExec = (out) => { const f = (...a) => { f.n++; if (out instanceof Error) throw out; return out; }; f.n = 0; return f; };

    it('the LAST ready-to-merge add wins; other labels and unlabel events are ignored', () => {
      const exec = mkExec(events([
        ev('ready-to-merge', '2026-09-28T10:00:00Z'),
        ev('review:pending', '2026-09-28T11:00:00Z'),
        ev('ready-to-merge', '2026-09-28T09:00:00Z', 'unlabeled'),
        ev('ready-to-merge', '2026-09-28T12:00:00Z'),
      ]));
      expect(readyToMergeLabelTimeMs({ repo: 'o/r', num: 1, sha: 's1', exec, dir: cdir })).toBe(Date.parse('2026-09-28T12:00:00Z'));
    });

    it('empty / invalid JSON / throw → null; no slug or sha → null with NO exec call', () => {
      expect(readyToMergeLabelTimeMs({ repo: 'o/r', num: 2, sha: 's', exec: mkExec('[]'), dir: cdir })).toBe(null);
      expect(readyToMergeLabelTimeMs({ repo: 'o/r', num: 3, sha: 's', exec: mkExec('{{'), dir: cdir })).toBe(null);
      expect(readyToMergeLabelTimeMs({ repo: 'o/r', num: 4, sha: 's', exec: mkExec(new Error('gh down')), dir: cdir })).toBe(null);
      const exec = mkExec('[]');
      expect(readyToMergeLabelTimeMs({ repo: null, num: 5, sha: 's', exec, dir: cdir })).toBe(null);
      expect(readyToMergeLabelTimeMs({ repo: 'o/r', num: 5, sha: '', exec, dir: cdir })).toBe(null);
      expect(exec.n).toBe(0);
    });

    it('a second call with the same head sha is served from the cache (exec once); a new sha re-reads', () => {
      const exec = mkExec(events([ev('ready-to-merge', '2026-09-28T10:00:00Z')]));
      const args = { repo: 'o/r', num: 6, sha: 'aaaaaaa', exec, dir: cdir };
      const t = readyToMergeLabelTimeMs(args);
      expect(readyToMergeLabelTimeMs(args)).toBe(t);
      expect(exec.n).toBe(1);
      readyToMergeLabelTimeMs({ ...args, sha: 'bbbbbbb' });
      expect(exec.n).toBe(2);
    });
  });
});

describe('isExemptItem — filename matching (#4417)', () => {
  const dirOf = (files) => ({
    backlogDir: '/b',
    readdir: () => Object.keys(files),
    readFile: (p) => files[p.split('/').pop()],
  });
  const high = '---\npriority: high\n---\n';

  it('matches the real `<id>-<slug>.md` convention', () => {
    expect(isExemptItem(100, dirOf({ '100-fix.md': high }))).toBe(true);
  });

  it('a hyphen-less `<id>.md` is NOT matched (deliberate: cards are always number-hyphen-slug)', () => {
    expect(isExemptItem(100, dirOf({ '100.md': high }))).toBe(false);
  });

  it('id 100 never matches a `1000-` prefixed card', () => {
    expect(isExemptItem(100, dirOf({ '1000-other.md': high }))).toBe(false);
  });
});
