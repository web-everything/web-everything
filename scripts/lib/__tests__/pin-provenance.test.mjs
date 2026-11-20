import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAuditedTipGate, revokedAppliedTips } from '../daemon-rebuild/audited-tip.mjs';

// A pinnedFrom only exempts an applied tip from audit revocation when it is an exact lowercase 40-hex sha
// that the canonical audit evidence accepts for that ref. Anything else is judged by the normal audit.
const ref = 'lane/pin', sha = 'a'.repeat(40), pin = 'b'.repeat(40);
const invalid = ['arbitrary', 'e'.repeat(40), pin.toUpperCase(), 'b'.repeat(39), 'b'.repeat(41), true, 7, {}, [pin]];
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function env({ rows = [{ ref, sha: pin, tests: 'green', audit: 'NOT WEAKENED' }], ledger = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pin-prov-')); roots.push(root);
  const e = { WE_FIX_READY_PATH: join(root, 'audited.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json'),
    WE_DAEMON_OVERLAY_FOLLOW_TIP: 'audited-only' };
  writeFileSync(e.WE_PLATFORM_PREFERENCES_FILE, '{}');
  if (ledger) writeFileSync(e.WE_FIX_READY_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return e;
}
const revoked = (pinnedFrom, e, held = []) => revokedAppliedTips({
  applied: [{ ref, pr: 42, sha, pinnedFrom }], auditedTip: makeAuditedTipGate(e), auditAdopted: [ref], held });

describe('pinnedFrom never exempts; the applied sha is judged on its own audit evidence', () => {
  for (const held of [false, true]) {
    it.each(invalid)(`refuses pin %j (held=${held}) and runs the normal audit`, pinnedFrom => {
      const gate = vi.fn(makeAuditedTipGate(env()));
      expect(revokedAppliedTips({ applied: [{ ref, sha, pinnedFrom }], auditedTip: gate, auditAdopted: [ref],
        held: held ? [{ detail: { ref, newTip: sha } }] : [] })).toEqual([ref]);
    });
  }
  const good = (s) => ({ ref, sha: s, tests: 'green', audit: 'NOT WEAKENED' });
  it('an audited pin never exempts an applied sha that has no evidence of its own', () => {
    expect(revoked(pin, env())).toEqual([ref]);
  });
  it('an applied sha that is itself audited is not revoked, whatever the pin says (normal audit)', () => {
    expect(revoked('arbitrary', env({ rows: [good(sha)] }))).toEqual([]);
    expect(revoked(pin, env({ rows: [good(sha), good(pin)] }))).toEqual([]);
  });
  it('an applied sha with red evidence is revoked even when the pin is audited', () => {
    expect(revoked(pin, env({ rows: [good(pin), good(sha), { ...good(sha), tests: 'red' }] }))).toEqual([ref]);
  });
  it('a live hold on the applied sha wins over everything', () => {
    expect(revoked(pin, env({ rows: [good(sha), good(pin)] }), [{ detail: { ref, newTip: sha } }])).toEqual([ref]);
  });
  it('evidence for another ref does not count', () => {
    expect(revoked(pin, env({ rows: [{ ...good(sha), ref: 'lane/other' }] }))).toEqual([ref]);
  });
  it('fails closed when the audited set is missing', () => {
    expect(revoked(pin, env({ ledger: false, rows: [] }))).toEqual([ref]);
  });
  it('fails closed when the audited set is unreadable', () => {
    const e = env(); e.WE_FIX_READY_PATH = join(e.WE_FIX_READY_PATH, 'not-a-file');
    expect(revoked(pin, e)).toEqual([ref]);
  });
});
