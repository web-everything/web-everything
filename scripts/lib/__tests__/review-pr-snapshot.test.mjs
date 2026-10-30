import { it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSnapshotPrView, resolvePrSnapshotSettings } from '../review-pr-snapshot.mjs';

it('shares only pinned immutable fields; metadata, head/base changes, expiry, corruption and disable stay live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-pr-snapshot-'));
  const lines = [];
  const settings = resolvePrSnapshotSettings({ fileConfig: { prSnapshot: { ttlMs: 3000 } },
    platform: { ttlMs: 5000 }, env: { WE_POLICY_CASCADE_LOG: '1', WE_REVIEW_PR_SNAPSHOT_TTL_MS: '2000' }, log: l => lines.push(l) });
  expect(settings.value.ttlMs).toBe(2000);
  expect(settings.sources.ttlMs).toBe('env');
  expect(lines.join('\n')).toContain('ttlMs=2000 (env)');
  expect(resolvePrSnapshotSettings({ fileConfig: {}, platform: {}, env: {} }).value.ttlMs).toBe(120000);
  expect(resolvePrSnapshotSettings({ fileConfig: { prSnapshot: { ttlMs: -1 } }, platform: { ttlMs: 10 }, env: {} }).value.ttlMs).toBe(10);
  let at = 0, heavy = 0, calls = 0;
  let current = { number: 7, headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    labels: ['hold'], comments: ['old'], reviews: ['changes'], mergeable: 'CONFLICTING',
    files: [{ path: 'one' }], commits: [{ oid: 'a'.repeat(40) }] };
  const fields = Object.keys(current).filter(f => !['headRefOid', 'baseRefOid'].includes(f));
  const exec = argv => {
    calls++;
    const requested = argv.at(-1).split(',');
    if (requested.includes('files')) heavy++;
    return JSON.stringify(Object.fromEntries(requested.map(f => [f, current[f]])));
  };
  const read = (extra = {}) => readSnapshotPrView({ repo: 'owner/repo', pr: 7, fields, exec,
    dir, now: () => at, settings, ...extra });
  try {
    const first = read();
    current = { ...current, labels: ['new hold'], comments: ['new'], reviews: ['accepted'], mergeable: 'MERGEABLE' };
    expect(read()).toEqual({ ...first, labels: current.labels, comments: current.comments, reviews: current.reviews, mergeable: current.mergeable });
    expect(heavy).toBe(1);
    expect(calls).toBe(3); // Miss: proof + payload; second process: live metadata only.
    const stored = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
    expect(Object.keys(stored.data).sort()).toEqual(['commits', 'files']);
    at = 2000; read(); expect(heavy).toBe(2);
    current.headRefOid = 'c'.repeat(40); read(); expect(heavy).toBe(3);
    current.baseRefOid = 'd'.repeat(40); read(); expect(heavy).toBe(4);
    read({ repo: 'other/repo' }); expect(heavy).toBe(5);
    read({ pr: 8 }); expect(heavy).toBe(6);
    for (const file of readdirSync(dir)) writeFileSync(join(dir, file), '{');
    read(); expect(heavy).toBe(7);
    const before = calls;
    expect(read({ settings: { value: { ttlMs: 0 } } })).toEqual(Object.fromEntries(fields.map(f => [f, current[f]])));
    expect(calls).toBe(before + 1);
    // A push between proof and payload must not poison the old head's snapshot.
    current.headRefOid = 'e'.repeat(40);
    read({ exec: argv => {
      if (argv.at(-1).split(',').includes('files')) current.headRefOid = 'f'.repeat(40);
      return exec(argv);
    } });
    expect(readdirSync(dir).some(file => {
      try { return JSON.parse(readFileSync(join(dir, file), 'utf8')).identity[3] === 'e'.repeat(40); } catch { return false; }
    })).toBe(false);
    let diffs = 0;
    const withDiff = { fields: [...fields, 'diff'], exec: argv => {
      if (argv[1] === 'diff') { diffs++; return 'diff --git a/one b/one\n'; }
      return exec(argv);
    } };
    expect(read(withDiff).diff).toBe('diff --git a/one b/one\n');
    expect(read(withDiff).diff).toBe('diff --git a/one b/one\n');
    expect(diffs).toBe(1);
    current.headRefOid = '1'.repeat(40);
    read({ ...withDiff, exec: argv => {
      if (argv[1] === 'diff') { current.headRefOid = '2'.repeat(40); return 'new diff'; }
      return exec(argv);
    } });
    expect(readdirSync(dir).some(file => {
      try { return JSON.parse(readFileSync(join(dir, file), 'utf8')).identity[3] === '1'.repeat(40); } catch { return false; }
    })).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
