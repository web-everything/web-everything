import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFixDispatchClaimsStrict } from '../fix-claim-store.mjs';
import { pushRefusal } from '../fix-procedure.mjs';

const roots = [], restore = [];
afterEach(() => {
  for (const path of restore.splice(0)) chmodSync(path, 0o700);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  if (!process.env.TMPDIR) throw new Error('This fixture requires the task TMPDIR');
  const root = mkdtempSync(join(process.env.TMPDIR, 'strict-claims-')); roots.push(root);
  const lockRoot = join(root, 'claims'), dir = join(lockRoot, 'claim.lock'), file = join(dir, 'lock.json');
  mkdirSync(dir, { recursive: true });
  const entry = { owner: 'fixture', heartbeatAt: new Date().toISOString(),
    meta: { repo: 'we', kind: 'fix', pr: 42, branch: 'lane/isolated', sessionId: 'mine' } };
  writeFileSync(file, JSON.stringify(entry));
  return { root, lockRoot, dir, file, entry };
}
describe('Design A test 7: strict claim-store evidence', () => {
  it('returns valid entries and distinguishes a readable empty root', () => {
    const f = fixture();
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ entries: [f.entry], unreadable: false });
    rmSync(f.dir, { recursive: true });
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toEqual({ entries: [], unreadable: false });
  });
  it.each(['unreadable lock.json', 'EACCES subdir', 'corrupt JSON', 'missing root', 'missing lock.json', 'missing meta', 'unreadable root'])(
    '%s is unreadable and strict pushRefusal reports claim-store-unreadable', kind => {
      const f = fixture();
      if (kind === 'unreadable lock.json') {
        chmodSync(f.file, 0); restore.push(f.file);
        expect(() => readFileSync(f.file)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      }
      if (kind === 'EACCES subdir' || kind === 'unreadable root') {
        const path = kind === 'EACCES subdir' ? f.dir : f.lockRoot;
        chmodSync(path, 0); restore.push(path);
        expect(() => readdirSync(path)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      }
      if (kind === 'corrupt JSON') writeFileSync(f.file, '{broken');
      if (kind === 'missing root') rmSync(f.lockRoot, { recursive: true });
      if (kind === 'missing lock.json') rmSync(f.file);
      if (kind === 'missing meta') { delete f.entry.meta; writeFileSync(f.file, JSON.stringify(f.entry)); }
      const scan = listFixDispatchClaimsStrict(f.lockRoot);
      expect.soft(scan.entries).toEqual([]);
      expect.soft(scan.unreadable).toBeTruthy();
      expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', sessionId: 'mine',
        lockRoot: f.lockRoot, strict: true })).toMatchObject({ refused: true, code: 'claim-store-unreadable' });
    },
  );
  it('preserves readable entries while flagging an incomplete neighboring claim', () => {
    const f = fixture(); mkdirSync(join(f.lockRoot, 'incomplete.lock'));
    const scan = listFixDispatchClaimsStrict(f.lockRoot);
    expect(scan.entries).toMatchObject([f.entry]); expect(scan.unreadable).toBeTruthy();
  });
});

describe('strict claim shape refusals', () => {
  it.each(['garbage', '', null, 'not-a-date'])('refuses invalid heartbeat %j rather than expiring it', heartbeatAt => {
    const f = fixture(); f.entry.heartbeatAt = heartbeatAt;
    writeFileSync(f.file, JSON.stringify(f.entry));
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ entries: [], unreadable: true });
    expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', strict: true, lockRoot: f.lockRoot }))
      .toMatchObject({ code: 'claim-store-unreadable' });
  });
  it.each([
    ['repo', 1], ['repo', ' '], ['repo', null], ['pr', '42'], ['pr', 0], ['pr', -1],
    ['pr', 1.5], ['pr', Number.MAX_SAFE_INTEGER + 1], ['kind', 1], ['kind', ' '],
    ['branch', null], ['branch', ' '], ['branch', 7], ['branch', undefined],
  ])('refuses malformed held-claim %s=%j', (key, value) => {
    const f = fixture(); f.entry.meta.kind = 'fixing'; f.entry.meta[key] = value;
    writeFileSync(f.file, JSON.stringify(f.entry));
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ entries: [], unreadable: true });
    expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', strict: true, lockRoot: f.lockRoot }))
      .toMatchObject({ code: 'claim-store-unreadable' });
  });
  it.each(['fix', 'ci-heal'])('accepts branchless dispatcher kind %s', kind => {
    const f = fixture(); f.entry.meta.kind = kind; delete f.entry.meta.branch;
    writeFileSync(f.file, JSON.stringify(f.entry));
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ unreadable: false });
  });
});
