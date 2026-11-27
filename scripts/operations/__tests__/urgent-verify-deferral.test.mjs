import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUrgentDeps, urgentVerify } from '../urgent-verify.mjs';
import { urgentMarker, urgentSignature, urgentFuiRepo } from '../urgent-verify-marker.mjs';

describe('urgent verification deferral invalidates earlier evidence', () => {
  it.each(['green', 'unreadable'])('deferral fails closed against a prior %s ledger for the same SHA', async state => {
    const parent = mkdtempSync(join(tmpdir(), 'uv-deferred-receipt-'));
    try {
      const cwd = join(parent, 'fixture-lane'), home = join(parent, 'home');
      mkdirSync(cwd); mkdirSync(home);
      const sha = 'a'.repeat(40), now = Date.parse('2026-11-18T12:00:00Z'), key = Buffer.alloc(32, 7);
      const repo = 'https://example.com/org/repo';
      const steps = ['fetch-main-history', 'install-fui', 'install', ...Array.from({ length: 10 }, (_, i) => `unit:unit:${i + 1}/10`), 'coverage', 'hostPaths', 'integration', 'standards'];
      const marker = { sha, fuiSha: sha, fuiRepo: urgentFuiRepo, suite: 'full', shards: 10, result: 'green',
        startedAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now - 1000).toISOString(), host: 'fixture-host', repo, steps };
      marker.sig = urgentSignature(marker, key);
      let ledger = JSON.stringify(marker);
      const check = () => urgentMarker({ urgent: true, reason: 'Urgent daemon repair', sha, shards: 10, expectedSteps: steps, now, repo, readKey: () => key, ledger });
      const fs = { readFileSync: vi.fn(path => {
        if (path.endsWith('.key')) return key;
        if (state === 'unreadable') throw Object.assign(new Error('ledger unreadable'), { code: 'EACCES' });
        return ledger;
      }), mkdirSync: vi.fn(), writeFileSync: vi.fn(),
      appendFileSync: vi.fn((_path, line) => { ledger += `\n${line}`; }) };
      const spawnSync = vi.fn(() => ({ status: 75, stderr: 'heavy-command admission-deferred: no slot', admissionDeferred: true }));
      const deps = createUrgentDeps({ cwd, home, fs, spawnSync, nowMs: () => now, host: 'fixture-host',
        env: { PATH: '/fixture/bin', LANE_POOL_ROOT: join(parent, 'pool') } });
      const release = vi.fn(), cleanup = vi.fn();
      Object.assign(deps, { clean: () => true, head: () => sha, repo: () => repo, plan: () => [],
        now: () => new Date(now).toISOString(), guardSigning: () => ({ release, check: vi.fn() }),
        'fetch-main-history': deps.standards });
      expect(check().ok).toBe(true);
      expect(await urgentVerify({ sha }, { isolate: () => ({ deps, cleanup }) })).toMatchObject({ ok: false, deferred: true, detail: 'admission-deferred' });
      expect(check()).toMatchObject({ ok: false, detail: 'no-urgent-marker' });
      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      const invalidation = JSON.parse(fs.appendFileSync.mock.calls[0][1]);
      expect(invalidation).toMatchObject({ sha, result: 'deferred', failure: { step: 'fetch-main-history' } });
      expect(invalidation.sig).toBe(urgentSignature(invalidation, key));
      expect(release.mock.invocationCallOrder[0]).toBeLessThan(fs.appendFileSync.mock.invocationCallOrder[0]);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
