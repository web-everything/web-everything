import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareCarryFingerprints, ensureCommitReadable, liveCarryFingerprints, resolveCarryEquivalenceSetting, proveReplayEquivalent } from '../carry-equivalence.mjs';
import { latestAcceptRecord, decideAcceptCarryForward } from '../accept-carry-forward.mjs';

const oldDiff = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n';
const movedDiff = oldDiff.replace(' context', ' changed context').replace('@@ -1,2 +1,2 @@', '@@ -3,2 +3,2 @@');

describe('carry fingerprint equivalence', () => {
  const cleared = liveCarryFingerprints(oldDiff);
  const live = liveCarryFingerprints(movedDiff);
  it('prefers strict, comparing case-insensitively', () => {
    expect(compareCarryFingerprints({ cleared: { diff: cleared.diff.toUpperCase() }, live: cleared })).toMatchObject({ same: true, tier: 'strict' });
  });
  it('accepts context and offset movement only in contribution mode', () => {
    expect(compareCarryFingerprints({ cleared, live })).toMatchObject({ same: true, tier: 'contribution' });
    expect(compareCarryFingerprints({ mode: 'strict', cleared, live })).toMatchObject({ same: false });
    expect(compareCarryFingerprints({ mode: 'strict', cleared, live }).reason).toContain(`net diff changed (${cleared.diff.slice(0, 12)} → ${live.diff.slice(0, 12)}`);
  });
  it('refuses changed added lines and missing fingerprints', () => {
    expect(compareCarryFingerprints({ cleared, live: liveCarryFingerprints(movedDiff.replace('+new', '+different')) }).same).toBe(false);
    expect(compareCarryFingerprints()).toEqual({ same: false, reason: 'live net diff unreadable' });
    expect(compareCarryFingerprints({ live })).toEqual({ same: false, reason: 'the clearance recorded no reviewed-diff fingerprint' });
  });
  it('reads the same accept comment and preserves strict-only callers', () => {
    const sha = 'a'.repeat(40);
    const record = latestAcceptRecord([{ viewerDidAuthor: true, body: `<!-- reviewed-sha: ${sha} -->\n<!-- reviewed-diff: ${cleared.diff} -->\n<!-- reviewed-contribution: ${cleared.contribution} -->` }]);
    expect(record.contribution).toBe(cleared.contribution);
    const facts = { setting: 'on', record, headSha: 'b'.repeat(40), headDiff: live.diff };
    expect(decideAcceptCarryForward(facts).action).toBe('review-owed');
    expect(decideAcceptCarryForward({ ...facts, headContribution: live.contribution, equivalence: 'contribution' })).toMatchObject({ action: 'carry', reason: expect.stringContaining('contribution') });
    expect(decideAcceptCarryForward({ ...facts, headContribution: live.contribution, equivalence: 'strict' }).action).toBe('review-owed');
  });
});

describe('carry equivalence policy', () => {
  it('resolves default, settings, env and shipped policy', () => {
    expect(resolveCarryEquivalenceSetting({ env: {}, readFile: () => '{}' })).toEqual({ value: 'contribution', source: 'default' });
    expect(resolveCarryEquivalenceSetting({ env: {}, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }).value).toBe('contribution');
    expect(resolveCarryEquivalenceSetting({ env: {}, readFile: () => '{"review":{"carryEquivalence":"strict"}}' })).toEqual({ value: 'strict', source: 'settings' });
    expect(resolveCarryEquivalenceSetting({ env: { WE_REVIEW_CARRY_EQUIVALENCE: 'contribution' }, readFile: () => '{"review":{"carryEquivalence":"strict"}}' })).toEqual({ value: 'contribution', source: 'env' });
    expect(resolveCarryEquivalenceSetting({ env: {} })).toEqual({ value: 'contribution', source: 'settings' });
  });
  it.each([null, '', false, 'typo'])('fails closed on present invalid values: %s', (value) => {
    expect(resolveCarryEquivalenceSetting({ env: { WE_REVIEW_CARRY_EQUIVALENCE: value } })).toEqual({ value: 'strict', source: `fail-closed (env=${JSON.stringify(value)})` });
    expect(resolveCarryEquivalenceSetting({ env: {}, readFile: () => JSON.stringify({ review: { carryEquivalence: value } }) })).toEqual({ value: 'strict', source: `fail-closed (settings=${JSON.stringify(value)})` });
  });
});

describe('ensureCommitReadable', () => {
  const sha = 'a'.repeat(40);
  it.each(['readable', 'fetch succeeds', 'fetch fails', 'still missing'])('%s', (variant) => {
    const calls = [];
    let reads = 0;
    const exec = (cmd, args) => {
      expect(cmd).toBe('git');
      calls.push(args);
      if (args[0] === 'cat-file') {
        reads++;
        if (variant !== 'readable' && (reads === 1 || variant !== 'fetch succeeds')) throw new Error('missing');
      }
      if (args[0] === 'fetch' && variant === 'fetch fails') throw new Error('fetch failed');
      return '';
    };
    expect(ensureCommitReadable({ exec, sha })).toMatchObject({
      ok: variant === 'readable' || variant === 'fetch succeeds', reason: expect.any(String),
    });
    expect(calls).toEqual(variant === 'readable'
      ? [['cat-file', '-e', `${sha}^{commit}`]]
      : [['cat-file', '-e', `${sha}^{commit}`], ['fetch', '--no-tags', '-q', 'origin', sha], ['cat-file', '-e', `${sha}^{commit}`]]);
  });
  it('fails closed without a reader or sha', () => {
    expect(ensureCommitReadable().ok).toBe(false);
    expect(ensureCommitReadable({ exec: () => '', sha: null }).ok).toBe(false);
  });
});

describe('replay proof with real git', () => {
  it.each(['same', 'changed', 'conflict', 'nested manifest'])('%s replay', (variant) => {
    const dir = mkdtempSync(join(tmpdir(), 'we-replay-'));
    const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const content = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n';
    const commit = (text) => { writeFileSync(join(dir, 'f.txt'), text); g('add', '.'); g('commit', '--allow-empty', '-qm', 'change'); };
    try {
      g('init', '-q', '-b', 'main'); commit(content);
      g('checkout', '-qb', 'lane'); writeFileSync(join(dir, '.lane-manifest.json'), '{}'); commit(content.replace('five', 'lane'));
      const fromSha = g('rev-parse', 'HEAD');
      g('checkout', '-q', 'main');
      const base = content.replace(variant === 'conflict' ? 'five' : 'three', 'main'); commit(base);
      g('checkout', '-qb', 'replayed');
      if (variant === 'nested manifest') { mkdirSync(join(dir, 'nested')); writeFileSync(join(dir, 'nested/.lane-manifest.json'), '{}'); }
      commit(base.replace('five', variant === 'changed' ? 'different' : 'lane'));
      const toSha = g('rev-parse', 'HEAD');
      const proof = proveReplayEquivalent({ exec: (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir }), fromSha, toSha, mainRef: 'main' });
      expect(proof.ok).toBe(variant === 'same');
      if (variant === 'changed') expect(proof.reason).toContain('f.txt');
      if (variant === 'conflict') expect(proof.reason).toContain('conflicts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fetches an unreadable cleared head once, then verifies it again', () => {
    const calls = []; let reads = 0;
    const exec = (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'cat-file' && reads++ === 0) throw new Error('missing');
      if (args[0] === 'merge-base') return 'c'.repeat(40);
      if (args[0] === 'merge-tree') return 'd'.repeat(40) + '\n';
      if (args[0] === 'diff') return '.lane-manifest.json\n';
      return '';
    };
    expect(proveReplayEquivalent({ exec, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) }).ok).toBe(true);
    expect(calls.filter((a) => a[0] === 'fetch')).toEqual([['fetch', '--no-tags', '-q', 'origin', 'a'.repeat(40)]]);
    expect(reads).toBe(2);
  });
  it('refuses invalid tree output and later git failures', () => {
    for (const failure of ['merge-base', 'merge-tree', 'diff', 'invalid-tree']) {
      const exec = (_cmd, args) => {
        if (args[0] === failure) throw new Error('failure');
        if (args[0] === 'merge-base') return 'c'.repeat(40);
        if (args[0] === 'merge-tree') return failure === 'invalid-tree' ? 'invalid' : 'd'.repeat(40);
        return '';
      };
      expect(proveReplayEquivalent({ exec, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) }).ok).toBe(false);
    }
  });
  it('never throws when git or inputs are unavailable', () => {
    expect(proveReplayEquivalent().ok).toBe(false);
    expect(proveReplayEquivalent({ exec: () => { throw new Error('missing'); }, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) })).toMatchObject({ ok: false, reason: expect.stringContaining('not readable locally') });
  });
});

// R503 part 4 — the drain-mechanical set also covers the regenerated CI timing file, so a merge of main that only
// moves it keeps an operator approval; any other change still invalidates.
import { MECHANICAL_DIFF_PATHS, NOT_A_REFRESH_PREFIXES, isMechanicalDiffSection } from '../transient-paths.mjs';
import { TRANSIENT_CARRY_PATHS } from '../carry-equivalence.mjs';
import { normalizeDiffFingerprint, normalizeContributionFingerprint } from '../review-escalation.mjs';
import { decideHumanClearanceCarry } from '../human-clearance-carry.mjs';

describe('mechanical net-diff paths (R503)', () => {
  const code = 'diff --git a/src/a.mjs b/src/a.mjs\n--- a/src/a.mjs\n+++ b/src/a.mjs\n@@ -1,1 +1,1 @@\n-a\n+b\n';
  const timings = (n) => `diff --git a/scripts/ci/test-timings.json b/scripts/ci/test-timings.json\n--- a/scripts/ci/test-timings.json\n+++ b/scripts/ci/test-timings.json\n@@ -1,1 +1,1 @@\n-{"t":1}\n+{"t":${n}}\n`;
  it('names the root manifest and the CI timing file only', () => {
    expect([...MECHANICAL_DIFF_PATHS].sort()).toEqual(['.lane-manifest.json', 'scripts/ci/test-timings.json']);
  });
  it.each([['strict', normalizeDiffFingerprint], ['contribution', normalizeContributionFingerprint]])('%s fingerprint ignores a timings-only change', (_, fp) => {
    expect(fp(code + timings(2))).toBe(fp(code + timings(3)));
    expect(fp(code + timings(2))).toBe(fp(code));
  });
  it.each([['strict', normalizeDiffFingerprint], ['contribution', normalizeContributionFingerprint]])('%s fingerprint still moves for a one-character code change and a nested timings file', (_, fp) => {
    expect(fp(code + timings(2))).not.toBe(fp(code.replace('+b', '+c') + timings(2)));
    const nested = timings(2).replaceAll('scripts/ci/test-timings.json', 'x/scripts/ci/test-timings.json');
    expect(fp(code + nested)).not.toBe(fp(code));
  });
  // One diff section per NOT_A_REFRESH_PREFIXES entry, each opened by exactly that header line (so dropping any one
  // prefix from the list reddens its own row), plus the completeness check that a new prefix brings its own row.
  const T = 'scripts/ci/test-timings.json';
  const H = `diff --git a/${T} b/${T}\n`;
  const NOT_A_REFRESH_VARIANTS = {
    'deleted file mode': `${H}deleted file mode 100644\n`,
    'new file mode': `${H}new file mode 100644\n`,
    'old mode': `${H}old mode 100644\n`,
    'new mode': `${H}new mode 100755\n`,
    'rename ': `${H}rename from ${T}\n`,
    'copy ': `${H}copy from ${T}\n`,
    'similarity index': `${H}similarity index 90%\n`,
    'dissimilarity index': `${H}dissimilarity index 100%\n`,
    'Binary files': `${H}index 1..2\nBinary files a/${T} and b/${T} differ\n`,
    'GIT binary patch': `${H}index 1..2\nGIT binary patch\nliteral 3\nKcmZ?l00000\n\n`,
  };
  it('has one timing-file variant per NOT_A_REFRESH prefix', () => {
    expect(Object.keys(NOT_A_REFRESH_VARIANTS).sort()).toEqual([...NOT_A_REFRESH_PREFIXES].sort());
  });
  it.each(Object.entries(NOT_A_REFRESH_VARIANTS))('a timing-file section opened by "%s" is a real change, not a refresh', (_, v) => {
    const lines = (code + v).split('\n');
    expect(isMechanicalDiffSection(lines, lines.indexOf(H.trimEnd()))).toBe(false);
    expect(normalizeDiffFingerprint(code + v)).not.toBe(normalizeDiffFingerprint(code));
    expect(normalizeContributionFingerprint(code + v)).not.toBe(normalizeContributionFingerprint(code));
  });
  it.each([['strict', normalizeDiffFingerprint], ['contribution', normalizeContributionFingerprint]])('%s fingerprint treats a timing-file delete, add, rename, mode change or binary replacement as a real change', (_, fp) => {
    const variants = [
      `${H}deleted file mode 100644\nindex 1..0\n--- a/${T}\n+++ /dev/null\n@@ -1 +0,0 @@\n-{"t":1}\n`,
      `${H}new file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/${T}\n@@ -0,0 +1 @@\n+{"t":1}\n`,
      `${H}old mode 100644\nnew mode 100755\n`,
      `${H}similarity index 90%\nrename from ${T}\nrename to ${T}\n`,
      `${H}index 1..2\nBinary files a/${T} and b/${T} differ\n`,
      `${H}index 1..2\nGIT binary patch\nliteral 3\nKcmZ?l00000\n\nliteral 0\nHcmV?d00001\n\n`,
    ];
    for (const v of variants) expect(fp(code + v)).not.toBe(fp(code));
  });
  it('keeps replay equivalence manifest-only: the modify-only timing file is not a transient carry path', () => {
    expect(TRANSIENT_CARRY_PATHS).toEqual(['.lane-manifest.json']);
    expect(Object.isFrozen(TRANSIENT_CARRY_PATHS)).toBe(true);
  });
  it('an operator clearance carries across a merge of main that only moved the timing file', () => {
    const cleared = liveCarryFingerprints(code + timings(2));
    const base = { enabled: true, headSha: 'b'.repeat(40), mechanical: { ok: true, kind: 'merge', reason: '1 merge(s) of origin/main' } };
    const clearance = { sha: 'a'.repeat(40), diff: cleared.diff, contribution: cleared.contribution, actor: 'operator' };
    expect(decideHumanClearanceCarry({ ...base, clearance, headDiff: code + timings(9) })).toMatchObject({ carry: true });
    expect(decideHumanClearanceCarry({ ...base, clearance, headDiff: code.replace('+b', '+c') + timings(9) })).toMatchObject({ carry: false });
    expect(decideHumanClearanceCarry({ ...base, clearance, headDiff: null })).toMatchObject({ carry: false });
  });
});
