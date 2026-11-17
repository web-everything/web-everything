import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { classifySubmit } from '../open-pr.mjs';
import { admitCanonicalAudit } from '../../pr-land.mjs';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';

const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const message = `no canonical codex-audit record for ${sha}. Run node scripts/operations/run.mjs codex-audit --base=origin/main --head=${sha}`;
function runner(canonicalAudit) {
  const spawn = vi.fn(() => ({ status: 0, stdout: '{"pr":7}' }));
  const review = vi.fn(() => ({ action: 'pass' }));
  const run = createPrLandRunner({ canonicalAudit, prePrReview: review, spawn, env: {}, prepGate: () => ({ ok: true }), readPrepBody: () => '' });
  return { run, spawn, review };
}
describe('open-pr canonical gate', () => {
  it.each([false, true])('refuses without spawning including dry run=%s', dry => {
    const check = vi.fn(() => ({ ok: false, reason: 'canonical-audit-missing', message }));
    const { run, spawn, review } = runner(check);
    expect(run({ argv: ['--ref=lane/audit', ...(dry ? ['--dry-run'] : [])] })).toEqual({ outcome: 'refused', reason: 'canonical-audit-missing', detail: message });
    expect(spawn).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledOnce();
    if (!dry) expect(review.mock.invocationCallOrder[0]).toBeLessThan(check.mock.invocationCallOrder[0]);
  });
  it('reports WEAKENED without spawning', () => {
    const { run, spawn } = runner(() => ({ ok: false, reason: 'canonical-audit-weakened', message }));
    expect(run({ argv: ['--ref=lane/audit', '--dry-run'] }).reason).toBe('canonical-audit-weakened');
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])('allows a real green record and pins the published sha, dry run=%s', dry => {
    const record = { head: sha, base, questionHash: QUESTION_HASH, at: '2026-11-17T00:00:00Z', verdict: 'NOT WEAKENED', findings: [] };
    const { run, spawn } = runner(request => checkCanonicalAuditForOpen({ ...request,
      env: { WE_PLATFORM_PREFERENCES_FILE: '/prefs' }, exec: () => sha, fetchMain: () => {}, ancestor: () => true, liveFingerprint: () => null,
      readFile: path => path === '/prefs' ? '{}' : path.endsWith('prototype-load.json') ? '{"auditRecordPath":"audit.jsonl"}' : JSON.stringify(record),
    }));
    expect(run({ argv: ['--ref=lane/audit', ...(dry ? ['--dry-run'] : [])] }).outcome).toBe('opened');
    expect(spawn.mock.calls[0][1]).toContain(`--sha=${sha}`);
  });
  it('check failures and incomplete decisions refuse without spawning', () => {
    for (const check of [() => { throw new Error('unreadable'); }, () => undefined]) {
      const { run, spawn } = runner(check);
      expect(run({ argv: ['--ref=lane/audit'] }).reason).toBe('canonical-audit-missing');
      expect(spawn).not.toHaveBeenCalled();
    }
  });
  it.each(['canonical-audit-missing', 'canonical-audit-weakened'])('classifies direct pr-land %s refusals', reason => {
    expect(classifySubmit({ status: 3, stdout: JSON.stringify({ reason, detail: message }) })).toMatchObject({ outcome: 'refused', reason });
  });
});
describe('direct pr-land canonical gate seam', () => {
  it.each(['canonical-audit-missing', 'canonical-audit-weakened'])('emits %s at exit 3 with the same message', reason => {
    const refuse = vi.fn();
    admitCanonicalAudit({ repo: '/repo', ref: 'lane/audit', sha }, { check: () => ({ ok: false, reason, message }), refuse });
    expect(refuse).toHaveBeenCalledWith({ repo: '/repo', merged: false, reason, detail: message }, 3);
  });
  it('green evidence does not emit a refusal', () => {
    const refuse = vi.fn();
    expect(admitCanonicalAudit({ sha }, { check: () => ({ ok: true }), refuse }).ok).toBe(true);
    expect(refuse).not.toHaveBeenCalled();
  });
  it('the direct CLI gates before its dry-run return and before publishing', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pr-land.mjs'), 'utf8');
    const gate = source.indexOf('  admitCanonicalAudit({ repo: REPO');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(source.indexOf('  if (DRY_RUN) {', gate));
    expect(gate).toBeLessThan(source.indexOf('  // 2. Publish', gate));
  });
});
