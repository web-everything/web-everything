/**
 * @file scripts/operations/__tests__/sessions-io-real.test.mjs
 * @description Card x4z1vez — the fidelity qualifier (#2949) for `sessions-io.mjs`: its history reads proved
 * against a REAL directory tree (real `jobs/<id>/state.json` files with real mtimes, real `completions/`), through
 * the real `assembleSessions`, not injected stubs.
 */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createSessionHistoryReader } from '../sessions-io.mjs';
import { assembleSessions, REVIEW_HISTORY_GAP } from '../sessions.mjs';

const H = 3_600_000;

it('reads a real jobs tree: skips files older than window+slack by mtime, tolerates junk, and the 24 h window excludes a 25 h job', async () => {
  await withRealRepo(async ({ root }) => {
    const now = Date.now();
    const iso = (h) => new Date(now - h * H).toISOString();
    const jobsDir = join(root, 'jobs');
    const completionsDir = join(root, 'completions');
    mkdirSync(completionsDir, { recursive: true });
    const put = (id, state, ageH) => {
      mkdirSync(join(jobsDir, id), { recursive: true });
      const p = join(jobsDir, id, 'state.json');
      writeFileSync(p, typeof state === 'string' ? state : JSON.stringify(state));
      const t = new Date(now - ageH * H);
      utimesSync(p, t, t);
    };
    const base = { state: 'done', detail: 'ok', createdAt: iso(5), respawnFlags: ['--model', 'opus[1m]'], children: [] };
    put('fresh', { ...base, sessionId: 's-fresh', name: 'fix-100', firstTerminalAt: iso(2), updatedAt: iso(2) }, 2);
    put('edge', { ...base, sessionId: 's-edge', name: 'ci-heal-101', firstTerminalAt: iso(25), updatedAt: iso(25) }, 25);
    put('ancient', { ...base, sessionId: 's-old', name: 'fix-102', firstTerminalAt: iso(900), updatedAt: iso(900) }, 900);
    put('junk', '{not json', 1);
    writeFileSync(join(completionsDir, 'review-9.json'), JSON.stringify({ kind: 'review', status: 'done', session: 'review-9', pr: '9', verdict: 'converged', updatedAt: iso(1) }));

    const h = createSessionHistoryReader({ jobsDir, completionsDir })({ windowMs: 24 * H, now });
    expect(h.jobs.map((j) => j.sessionId).sort()).toEqual(['s-edge', 's-fresh']); // the 900 h file is never opened
    const out = assembleSessions({ live: { observedAt: new Date(now).toISOString(), running: [] }, ...h, windowMs: 24 * H });
    expect(out.rows.map((r) => r.name).sort()).toEqual(['fix-100', 'review-9']);
    expect(out.rows.find((r) => r.name === 'fix-100')).toMatchObject({ model: 'opus[1m]', state: 'done', kind: 'fix' });
    expect(out.degraded).toEqual([REVIEW_HISTORY_GAP]);
  });
});
