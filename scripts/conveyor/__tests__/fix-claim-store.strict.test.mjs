import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { draftSidecarFor, readClaimEvidence } from '../../readiness/file-locks.mjs';
import { listFixDispatchClaimsStrict, validateFixClaimMeta } from '../fix-claim-store.mjs';
import { pushRefusal } from '../fix-procedure.mjs';

const roots = [], restore = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of restore.splice(0)) chmodSync(path, 0o700);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  if (!process.env.TMPDIR) throw new Error('This fixture requires the task TMPDIR');
  const root = mkdtempSync(join(process.env.TMPDIR, 'strict-claims-')); roots.push(root);
  const lockRoot = join(root, 'claims'), dir = join(lockRoot, 'claim.lock'), file = join(dir, 'lock.json');
  mkdirSync(dir, { recursive: true });
  const entry = { owner: 'fixture', heartbeatAt: new Date().toISOString(),
    meta: { repo: 'we', kind: 'fix', pr: 42, ttlMinutes: 20, branch: 'lane/isolated', sessionId: 'mine' } };
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
  it.each(['lane/repair+tests', 'feature/repair', 'main', 'lane/topic@work', 'lane/équipe',
    'lane/repair=tests', 'lane/repair;tests', 'lane/repair"tests', "lane/repair'tests", 'lane/repair`tests',
    '@', 'lane/a]b', 'lane/a./b', 'lane/a\u2028b', 'lane/a\u200bb', 'lane/-topic',
  ])('accepts Git-valid branch %s in live and expired neighboring claims', branch => {
    expect(spawnSync('git', ['check-ref-format', '--branch', branch],
      { timeout: 5000, maxBuffer: 4096, stdio: 'pipe' }).status).toBe(0);
    const f = fixture();
    const neighbor = join(f.lockRoot, 'neighbor.lock'); mkdirSync(neighbor);
    const entry = { ...f.entry, meta: { ...f.entry.meta, kind: 'fixing', pr: 99, branch, sessionId: 'other' } };
    expect.soft(validateFixClaimMeta(entry.meta)).toBe(true);
    for (const heartbeatAt of [f.entry.heartbeatAt, '2020-01-01T00:00:00.000Z']) {
      writeFileSync(join(neighbor, 'lock.json'), JSON.stringify({ ...entry, heartbeatAt }));
      expect.soft(listFixDispatchClaimsStrict(f.lockRoot).unreadable).toBe(false);
      expect.soft(pushRefusal({ repo: 'we', branch: 'lane/isolated', sessionId: 'mine',
        lockRoot: f.lockRoot, strict: true })).toBeNull();
    }
  });
  it.each(['lane/fix ', 'lane/a..b', 'lane/.hidden', 'lane/a.lock/topic', 'lane/a//b',
    'lane/a@{b', 'lane/a\\b', 'lane/a?b', 'lane/a*b', 'lane/a[b', 'lane/a:b', 'lane/a~b', 'lane/a^b',
    'lane/a\nb', 'lane/a\rb', 'lane/a\tb', 'lane/a\u0000b', 'lane/a\u007fb', '-topic', 'HEAD', 'refs/heads/lane/fix',
    'lane/fix.', 'lane/fix/',
  ])('rejects invalid or noncanonical branch %j', branch => {
    const f = fixture(); f.entry.meta.branch = branch;
    writeFileSync(f.file, JSON.stringify(f.entry));
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ unreadable: true });
  });
  it.each([1, 'garbage', '', null, 'not-a-date'])('refuses invalid heartbeat %j rather than expiring it', heartbeatAt => {
    const f = fixture(); f.entry.heartbeatAt = heartbeatAt;
    writeFileSync(f.file, JSON.stringify(f.entry));
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ entries: [], unreadable: true });
    expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', strict: true, lockRoot: f.lockRoot }))
      .toMatchObject({ code: 'claim-store-unreadable' });
  });
  it.each([
    ['repo', 'unknown'], ['kind', 'unknown'], ['branch', 'lane/?'], ['branch', 'lane/'], ['repo', 1], ['repo', ' '], ['repo', null], ['pr', '42'], ['pr', 0], ['pr', -1],
    ['pr', 1.5], ['pr', Number.MAX_SAFE_INTEGER + 1], ['kind', 1], ['kind', ' '],
    ['branch', null], ['branch', ' '], ['branch', 7], ['branch', undefined],
  ])('refuses malformed held-claim %s=%j', (key, value) => {
    const f = fixture(); f.entry.meta.kind = 'fixing'; f.entry.meta[key] = value;
    writeFileSync(f.file, JSON.stringify(f.entry));
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ entries: [], unreadable: true });
    expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', strict: true, lockRoot: f.lockRoot }))
      .toMatchObject({ code: 'claim-store-unreadable' });
  });
  it.each(['Infinity', Infinity, 0, -1, 1.5, 241, undefined])('refuses invalid TTL %j before expiry filtering', ttlMinutes => {
    const f = fixture(); f.entry.meta.kind = 'fixing'; f.entry.meta.ttlMinutes = ttlMinutes;
    // JSON's exponent syntax can parse to Infinity; exercise that raw input too.
    writeFileSync(f.file, ttlMinutes === Infinity
      ? JSON.stringify(f.entry).replace('\"ttlMinutes\":null', '\"ttlMinutes\":1e400') : JSON.stringify(f.entry));
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


describe('strict sidecar audit regressions', () => {
  const hbName = entry => `hb.${createHash('sha256').update(entry.owner).digest('hex').slice(0, 16)}`;
  const refused = f => {
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toEqual({ entries: [], unreadable: true });
    expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', strict: true, lockRoot: f.lockRoot }))
      .toMatchObject({ refused: true, code: 'claim-store-unreadable' });
  };
  it.each(['hb', 'draft'])('fails closed on an unreadable %s sidecar', kind => {
    const f = fixture();
    mkdirSync(join(f.dir, kind === 'hb' ? hbName(f.entry) : draftSidecarFor(f.entry)));
    expect(() => readClaimEvidence(f.dir)).toThrow();
    refused(f);
  });
  it.each(['', 'garbage', '2020-01-01', '2026-02-30T00:00:00Z'])(
    'fails closed on malformed heartbeat sidecar %j, including older timestamps', value => {
      const f = fixture(); writeFileSync(join(f.dir, hbName(f.entry)), value);
      expect(() => readClaimEvidence(f.dir)).toThrow();
      refused(f);
    },
  );
  it.each(['entry', 'hb', 'draft'].flatMap(kind => ['Z', '.1Z', '.12Z', '.123Z', '.000Z'].map(suffix => [kind, suffix])))(
    'accepts strict UTC %s evidence with precision %s, including lease-extending heartbeats', (kind, suffix) => {
      const f = fixture(), now = Date.parse('2026-11-24T16:00:00Z');
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const at = '2026-11-24T16:00:00' + suffix;
      f.entry.meta.kind = 'fixing';
      f.entry.heartbeatAt = kind === 'hb' ? new Date(now - 21 * 60_000).toISOString() : at;
      writeFileSync(f.file, JSON.stringify(f.entry));
      if (kind !== 'entry') writeFileSync(join(f.dir, kind === 'hb' ? hbName(f.entry) : draftSidecarFor(f.entry)),
        kind === 'hb' ? at : JSON.stringify({ preDraft: false, at }));
      expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ unreadable: false,
        entries: [{ heartbeatAt: at, ...(kind === 'draft' ? { sidecarAt: at } : {}) }] });
      expect(pushRefusal({ repo: 'we', branch: 'lane/isolated', sessionId: 'foreign', strict: true, lockRoot: f.lockRoot }))
        .toMatchObject({ refused: true, code: 'foreign-claim' });
    },
  );
  it('accepts an older no-millisecond heartbeat without replacing newer entry evidence', () => {
    const f = fixture(); writeFileSync(join(f.dir, hbName(f.entry)), '2026-01-01T00:00:00Z');
    expect(readClaimEvidence(f.dir).entry.heartbeatAt).toBe(f.entry.heartbeatAt);
    expect(listFixDispatchClaimsStrict(f.lockRoot)).toMatchObject({ unreadable: false, entries: [f.entry] });
  });
  it.each(['entry', 'hb', 'draft'].flatMap(kind => [
    'garbage', '2026-02-30T16:00:00Z', '2026-02-29T16:00:00.1Z', '2026-11-24T24:00:00Z',
    '2026-11-24T16:00:00.1234Z', '2026-11-24T16:00:00+00:00', '2026-11-24T16:00:00',
  ].map(at => [kind, at])))(
    'fails closed on invalid strict UTC %s evidence %s', (kind, at) => {
      const f = fixture();
      if (kind === 'entry') { f.entry.heartbeatAt = at; writeFileSync(f.file, JSON.stringify(f.entry)); }
      else writeFileSync(join(f.dir, kind === 'hb' ? hbName(f.entry) : draftSidecarFor(f.entry)),
        kind === 'hb' ? at : JSON.stringify({ preDraft: false, at }));
      refused(f);
    },
  );
  it.each(['{broken', '{}', JSON.stringify({ preDraft: false, at: 'garbage' })])(
    'fails closed on malformed draft sidecar %s', value => {
      const f = fixture(); writeFileSync(join(f.dir, draftSidecarFor(f.entry)), value);
      expect(() => readClaimEvidence(f.dir)).toThrow();
      refused(f);
    },
  );
  it.each(['entry', 'hb', 'draft'])('bounds future %s timestamps to 60 seconds of skew', kind => {
    const f = fixture(), now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const stamp = offset => {
      const at = new Date(now + offset).toISOString();
      if (kind === 'entry') {
        f.entry.heartbeatAt = at; writeFileSync(f.file, JSON.stringify(f.entry));
      } else writeFileSync(join(f.dir, kind === 'hb' ? hbName(f.entry) : draftSidecarFor(f.entry)),
        kind === 'hb' ? at : JSON.stringify({ preDraft: false, at }));
    };
    stamp(60_000);
    expect(listFixDispatchClaimsStrict(f.lockRoot).unreadable).toBe(false);
    stamp(60_001);
    refused(f);
  });
});
