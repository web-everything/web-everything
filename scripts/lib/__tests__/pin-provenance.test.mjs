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

describe('pinnedFrom exemption requires an audited exact 40-hex sha', () => {
  for (const held of [false, true]) {
    it.each(invalid)(`refuses pin %j (held=${held}) and runs the normal audit`, pinnedFrom => {
      const gate = vi.fn(makeAuditedTipGate(env()));
      expect(revokedAppliedTips({ applied: [{ ref, sha, pinnedFrom }], auditedTip: gate, auditAdopted: [ref],
        held: held ? [{ detail: { ref, newTip: sha } }] : [] })).toEqual([ref]);
    });
  }
  it('honours a lowercase 40-hex pin that is audited for the ref (no regression)', () => {
    expect(revoked(pin, env(), [{ detail: { ref, newTip: sha } }])).toEqual([]);
    expect(revoked(pin, env())).toEqual([]);
  });
  it('does not honour a 40-hex pin audited only for another ref, or revoked', () => {
    expect(revoked(pin, env({ rows: [{ ref: 'lane/other', sha: pin, tests: 'green', audit: 'NOT WEAKENED' }] }))).toEqual([ref]);
    const row = { ref, sha: pin, tests: 'green', audit: 'NOT WEAKENED' };
    expect(revoked(pin, env({ rows: [row, { ...row, tests: 'red' }] }))).toEqual([ref]);
  });
  it('fails closed when the audited set is missing', () => {
    expect(revoked(pin, env({ ledger: false }))).toEqual([ref]);
  });
  it('fails closed when the audited set is unreadable', () => {
    const e = env(); e.WE_FIX_READY_PATH = join(e.WE_FIX_READY_PATH, 'not-a-file');
    expect(revoked(pin, e)).toEqual([ref]);
  });
});
