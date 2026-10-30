import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLabelCached, resolveLabelCachePolicy } from '../label-cache.mjs';

it('shares label existence on disk, refreshes misses/expiry, and honors the source-logged TTL cascade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'label-cache-'));
  try {
    const logs = [];
    const policy = resolveLabelCachePolicy({ tool: { cache: { ttlMs: 100 } }, platform: { cache: { ttlMs: 200 } },
      env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => logs.push(line) });
    expect(policy.sources.ttlMs).toBe('tool');
    expect(logs.join()).toContain('ttlMs=100 (tool)');
    expect(resolveLabelCachePolicy({ tool: null, platform: {}, env: {} }).value.ttlMs).toBe(3600000);
    expect(resolveLabelCachePolicy({ tool: null, platform: { cache: { ttlMs: 200 } }, env: {} }).sources.ttlMs).toBe('platform');
    const disabled = resolveLabelCachePolicy({ tool: null, platform: {}, env: { WE_LABELS_CACHE_TTL_MS: '0' } });
    expect(disabled.sources.ttlMs).toBe('env');
    expect(disabled.value.ttlMs).toBe(0);
    expect(resolveLabelCachePolicy({ tool: { cache: { ttlMs: -1 } }, platform: {}, env: { WE_LABELS_CACHE_TTL_MS: '' } }).value.ttlMs).toBe(3600000);
    let time = 1, lists = 0, creates = 0;
    const remote = new Set(['present']);
    const exec = args => {
      expect(args).not.toContain('--force');
      if (args[1] === 'list') { lists++; expect(args.slice(-4)).toEqual(['--limit', '1000', '--json', 'name']); return JSON.stringify([...remote].map(name => ({ name }))); }
      creates++;
      if (args[2] === 'broken') throw new Error('permission denied');
      if (args[2] === 'raced') { remote.add('raced'); throw new Error('already exists'); }
      remote.add(args[2]);
      return 'created';
    };
    const ensure = (name, repo = 'o/n', runner = exec, picked = policy) => ensureLabelCached(['label', 'create', name, '--repo', repo], { exec: runner, dir, policy: picked, now: () => time });
    expect(ensure('present')).toBe('');
    expect(ensure('present', 'o/n', args => exec(args))).toBe(''); // independent runner reads the shared file
    expect([lists, creates]).toEqual([1, 0]);
    remote.add('external');
    expect(ensure('external')).toBe(''); // cached miss refreshes once
    expect([lists, creates]).toEqual([2, 0]);
    expect(ensure('new')).toBe('created');
    expect(ensure('new')).toBe('');
    expect([lists, creates]).toEqual([3, 1]);
    time = 101;
    ensure('present');
    expect(lists).toBe(4); // label additions did not extend list age
    ensure('present', 'other/repo');
    expect(lists).toBe(5);
    expect(ensure('raced')).toBe('');
    expect(() => ensure('broken')).toThrow('permission denied');
    const before = lists;
    ensure('present', 'o/n', exec, disabled);
    expect(lists).toBe(before);
    expect(ensure('present', 'o/n', args => {
      if (args[1] === 'create') throw new Error('already exists');
      return exec(args);
    }, disabled)).toBe(''); // disabling the cache retains idempotence
    expect(ensure('fallback', 'o/n', args => args[1] === 'list' ? (() => { throw new Error('offline'); })() : exec(args),
      { value: { ttlMs: 1 } })).toBe('created');
    for (const file of readdirSync(dir)) {
      expect(file.endsWith('.tmp')).toBe(false);
      const row = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      expect(Object.keys(row).sort()).toEqual(['names', 'refreshedAt', 'repo']);
      writeFileSync(join(dir, file), 'corrupt');
    }
    ensure('present'); // corrupt cache re-lists, never prevents provisioning
    expect(lists).toBeGreaterThan(before);
  } finally { rmSync(dir, { recursive: true }); }
});
