import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorizedPush, readPushAuthority } from '../authorized-push.mjs';
import { createAuthorizedPushForTesting, nonTestFactoryImports, snapshotOptionsForTesting } from './helpers/authorized-push-factory.mjs';
import { acquireFixClaim, fixBegin, fixEnd, pushRefusal, readLiveFixClaim } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot, listFixDispatchClaimsStrict } from '../../conveyor/fix-claim-store.mjs';
import { resolveCoordinationRoot } from '../../operations/coordination-root.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';

vi.mock('node:child_process', async original => ({ ...await original(), spawnSync: vi.fn(() => { throw new Error('No git permitted'); }) }));
vi.mock('../../operations/coordination-root.mjs', async original => {
  const coordination = await original();
  return { ...coordination, resolveCoordinationRoot: vi.fn(coordination.resolveCoordinationRoot) };
});
vi.mock('../../conveyor/fix-procedure.mjs', async original => {
  const procedure = await original();
  return { ...procedure, readLiveFixClaim: vi.fn(procedure.readLiveFixClaim), pushRefusal: vi.fn(procedure.pushRefusal) };
});
const roots = [], nowMs = Date.now(), head = 'a'.repeat(40);
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const lockRoot = mkdtempSync(join(process.env.TMPDIR, 'push-s1c-')); roots.push(lockRoot);
  const options = { repo: 'we', pr: 42, who: 'worker', sessionId: 'mine', token: null, lockRoot, nowMs };
  const view = { headRefName: 'lane/fix', headRefOid: head, isDraft: false, state: 'OPEN', labels: [], isCrossRepository: false };
  const gh = vi.fn(async args => args[1] === 'view' ? JSON.stringify(view) : '');
  const labels = { ensureLabel() {}, setLabels() {}, postComment() {} };
  const read = () => readLiveFixClaim(options);
  const authority = () => createAuthorizedPushForTesting({ gh: 'fixture-gh', readClaim: read,
    branchClaimRefusal: () => pushRefusal({ ...options, branch: 'lane/fix', strict: true }),
    ghPrView: () => view, isAncestor: () => true }).readPushAuthority({ repo: 'we', pr: 42, branch: 'lane/fix',
    expectedHead: head, sha: head, gitDir: '.', purpose: 'repair', holder: { sessionId: options.sessionId } });
  return { options, view, gh, labels, read, authority,
    begin: extra => fixBegin({ ...options, gh, labels, ...extra }),
    dir: () => lockDirFor(lockRoot, 'fix-dispatch:we:fixing:42') };
}

function pushFixture() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'push-s1c-order-')); roots.push(root);
  const sha = 'b'.repeat(40), events = [];
  let probed = false, pushed = false;
  const entry = { meta: { repo: 'we', pr: 42, kind: 'fixing', ttlMinutes: 20, branch: 'lane/fix', sessionId: 'mine' } };
  const io = { gh: 'fixture-gh', isAncestor: () => true,
    readClaim: vi.fn(() => { events.push('claim'); return entry; }),
    branchClaimRefusal: vi.fn(() => { events.push('branch'); return null; }),
    ghPrView: vi.fn(() => {
      events.push('view');
      return { headRefName: 'lane/fix', headRefOid: pushed ? sha : head, labels: [],
        state: 'OPEN', isDraft: false, isCrossRepository: false };
    }),
    spawn: vi.fn((_bin, args) => {
      events.push(args.includes('--git-path') ? 'lease' : 'git');
      if (args.includes('init')) mkdirSync(join(args.at(-1), 'objects/info'), { recursive: true });
      if (args.includes('--git-path')) probed = true;
      return { status: 0, stdout: args.includes('--git-common-dir') ? `${root}\n` : `${join(root, 'missing-lease')}\n` };
    }),
    gitPush: vi.fn(() => {
      pushed = true; events.push('push');
      return { status: 0, stdout: `To https://github.com/web-everything/web-everything.git\n \t${sha}:refs/heads/lane/fix\taaaa..bbbb\nDone\n` };
    }),
  };
  const options = { repo: 'we', pr: 42, branch: 'lane/fix', expectedHead: head, sha, gitDir: root,
    purpose: 'repair', holder: { sessionId: 'mine' } };
  return { io, options, events, probed: () => probed, entry,
    push: () => createAuthorizedPushForTesting(io).authorizedPush(options) };
}

describe('PUSH-GATE-S1C Tier-1 negatives', () => {
  it('default ports ignore WE_COORDINATION_ROOT and see foreign claims under the fixed home layout at call time', () => {
    const f = fixture(), home = join(f.options.lockRoot, 'home');
    const originalResolve = vi.mocked(resolveCoordinationRoot).getMockImplementation();
    const decoy = join(f.options.lockRoot, 'decoy');
    const gate = createAuthorizedPushForTesting({ gh: 'fixture-gh', ghPrView: () => f.view, isAncestor: () => true });
    try {
      vi.mocked(resolveCoordinationRoot).mockImplementation(options => originalResolve({ ...options, home }));
      vi.stubEnv('WE_COORDINATION_ROOT', decoy);
      const fixed = join(home, 'workspace', '.operations', 'coordination', 'fix-dispatch-claims');
      expect(fixDispatchClaimRoot(resolveCoordinationRoot({ env: {} }))).toBe(fixed);
      for (const lockRoot of [fixed, fixDispatchClaimRoot(decoy)])
        expect(acquireFixClaim({ ...f.options, lockRoot, branch: 'lane/fix' }).ok).toBe(true);
      expect(acquireFixClaim({ ...f.options, lockRoot: fixed, pr: 99, sessionId: 'foreign', branch: 'lane/fix' }).ok).toBe(true);
      vi.mocked(readLiveFixClaim).mockClear(); vi.mocked(pushRefusal).mockClear();
      const result = gate.readPushAuthority({ repo: 'we', pr: 42, branch: 'lane/fix', expectedHead: head, sha: head,
        gitDir: '.', purpose: 'repair', holder: { sessionId: 'mine' } });
      expect.soft(readLiveFixClaim).toHaveBeenCalledWith({ repo: 'we', pr: 42, lockRoot: fixed });
      expect.soft(pushRefusal).toHaveBeenCalledWith(expect.objectContaining({ lockRoot: fixed, strict: true }));
      expect(result).toMatchObject({ ok: false, code: 'foreign-claim' });
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      vi.mocked(resolveCoordinationRoot).mockImplementation(originalResolve);
      vi.unstubAllEnvs();
    }
  });
  it('refuses a hold that appears only after the lease probe, with zero pushes', () => {
    const f = pushFixture(), view = f.io.ghPrView;
    f.io.ghPrView = () => ({ ...view(), labels: f.probed() ? [{ name: 'review:human' }] : [] });
    expect.soft(f.push()).toMatchObject({ ok: false, code: 'hold-label' });
    expect(f.probed()).toBe(true);
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it('refuses a claim released or expired only after the lease probe, with zero pushes', () => {
    const f = pushFixture();
    f.io.readClaim.mockImplementation(() => f.probed() ? null : f.entry);
    expect.soft(f.push()).toMatchObject({ ok: false, code: 'not-claim-holder' });
    expect(f.probed()).toBe(true);
    expect(f.io.gitPush).not.toHaveBeenCalled();
  });
  it('reads final claim, strict branch scan and live PR immediately before the push port', () => {
    const f = pushFixture();
    expect(f.push()).toMatchObject({ ok: true });
    const at = f.events.indexOf('push');
    expect(f.events.slice(at - 4, at + 1)).toEqual(['lease', 'claim', 'branch', 'view', 'push']);
  });
  it('freezes one data snapshot including holder, unaffected by later caller mutation', () => {
    const options = { branch: 'lane/fix', holder: { sessionId: 'mine', who: 'worker', token: 'secret' } };
    const snapshot = snapshotOptionsForTesting(options);
    options.branch = 'lane/other'; options.holder.token = 'other'; options.holder.sessionId = 'other';
    expect(snapshot).toEqual({ branch: 'lane/fix', holder: { sessionId: 'mine', who: 'worker', token: 'secret' } });
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.holder)).toBe(true);
  });
  it.each(['branch', 'holder.token'])('%s getter is bad-input without invoking it or git', key => {
    const getter = vi.fn(() => key === 'branch' ? 'lane/fix' : 'secret');
    const options = { repo: 'we', pr: 42, branch: 'lane/fix', expectedHead: head, sha: head,
      gitDir: '.', purpose: 'repair', holder: { sessionId: 'mine' } };
    Object.defineProperty(key === 'branch' ? options : options.holder, key === 'branch' ? 'branch' : 'token', { enumerable: true, get: getter });
    for (const call of [authorizedPush, readPushAuthority]) expect(call(options)).toMatchObject({ ok: false, code: 'bad-input' });
    expect(getter).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled();
  });
  it('old lock.json with a fresh foreign heartbeat sidecar is foreign-claim', () => {
    const f = fixture(), acquired = acquireFixClaim({ ...f.options, sessionId: 'foreign', branch: 'lane/fix', nowMs: nowMs - 30 * 60_000 });
    const hb = createHash('sha256').update(acquired.entry.owner).digest('hex').slice(0, 16);
    writeFileSync(join(f.dir(), `hb.${hb}`), new Date(nowMs).toISOString());
    expect(pushRefusal({ ...f.options, branch: 'lane/fix', strict: true }))
      .toMatchObject({ refused: true, code: 'foreign-claim' });
  });
  it.each(['lane/fix ', 'lane/a..b', 'lane/a/', 'lane/a.lock'])('malformed branch %s is claim-store-unreadable', branch => {
    const f = fixture(); acquireFixClaim({ ...f.options, branch: 'lane/fix' });
    const file = join(f.dir(), 'lock.json'), entry = JSON.parse(readFileSync(file, 'utf8'));
    entry.meta.branch = branch; writeFileSync(file, JSON.stringify(entry));
    expect(pushRefusal({ ...f.options, branch: 'lane/fix', strict: true })).toMatchObject({ code: 'claim-store-unreadable' });
  });
  it.each([null, '', 0])('an unbound neighbour with tokenHash=%j and the same who is foreign in strict mode', tokenHash => {
    const f = fixture(); acquireFixClaim({ ...f.options, branch: 'lane/fix' });
    const file = join(f.dir(), 'lock.json'), entry = JSON.parse(readFileSync(file, 'utf8'));
    entry.meta.sessionId = null; entry.meta.tokenHash = tokenHash; writeFileSync(file, JSON.stringify(entry));
    expect(pushRefusal({ ...f.options, branch: 'lane/fix', strict: true })).toMatchObject({ refused: true, code: 'foreign-claim' });
    expect(pushRefusal({ ...f.options, branch: 'lane/fix' })).toBeNull();
  });
  it.each(['owner', 'sessionId', 'tokenHash', 'claimedAt'])('a draft sidecar is ignored after %s reassignment and the new lock.json stays byte-identical', async key => {
    const f = fixture(); expect(await f.begin({ draft: true, reason: 'scope-change' })).toMatchObject({ ok: true });
    expect(readdirSync(f.dir()).filter(name => name.startsWith('draft.'))).toHaveLength(1);
    const file = join(f.dir(), 'lock.json'), entry = JSON.parse(readFileSync(file, 'utf8'));
    if (key === 'owner') entry.owner = 'fixer:new';
    else entry.meta[key] = key === 'claimedAt' ? new Date(nowMs + 1).toISOString() : 'new';
    const bytes = JSON.stringify(entry); writeFileSync(file, bytes);
    if (key === 'sessionId') f.options.sessionId = 'new';
    f.view.isDraft = true;
    expect(f.authority()).toMatchObject({ code: 'draft' });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
  it('draft conversion writes only its sidecar, leaving lock.json byte-identical', async () => {
    const f = fixture(); let before;
    f.gh.mockImplementation(async args => {
      if (args[1] === 'view') return JSON.stringify(f.view);
      before = readFileSync(join(f.dir(), 'lock.json'), 'utf8'); return '';
    });
    expect(await f.begin({ draft: true, reason: 'scope-change' })).toMatchObject({ ok: true });
    expect(readFileSync(join(f.dir(), 'lock.json'), 'utf8')).toBe(before);
    const sidecar = readdirSync(f.dir()).find(name => name.startsWith('draft.'));
    expect(JSON.parse(readFileSync(join(f.dir(), sidecar), 'utf8'))).toEqual({ preDraft: false, at: new Date(nowMs).toISOString() });
  });
  it.each(['sessionId', 'claimedAt'])('reassignment of %s during the draft call fails without stamping the new holder', async key => {
    const f = fixture(); let bytes;
    f.gh.mockImplementation(async args => {
      if (args[1] === 'view') return JSON.stringify(f.view);
      const file = join(f.dir(), 'lock.json'), entry = JSON.parse(readFileSync(file, 'utf8'));
      entry.meta[key] = key === 'sessionId' ? 'new' : new Date(nowMs + 1).toISOString();
      bytes = JSON.stringify(entry); writeFileSync(file, bytes); return '';
    });
    expect(await f.begin({ draft: true, reason: 'scope-change' })).toMatchObject({ ok: false, reason: 'draft-failed' });
    expect(readFileSync(join(f.dir(), 'lock.json'), 'utf8')).toBe(bytes);
    expect(readdirSync(f.dir()).filter(name => name.startsWith('draft.'))).toEqual([]);
  });
  it('reentry without drafting an already-draft PR clears ownership and refuses the draft', async () => {
    const f = fixture(); expect(await f.begin({ draft: true, reason: 'scope-change' })).toMatchObject({ ok: true });
    f.view.isDraft = true; expect(f.authority()).toMatchObject({ ok: true });
    expect(await f.begin({ draft: false })).toMatchObject({ ok: true, reentrant: true });
    expect(f.authority()).toMatchObject({ ok: false, code: 'draft' });
    expect(readdirSync(f.dir()).filter(name => name.startsWith('draft.'))).toEqual([]);
  });
  it.each([undefined, null])('requested draft with isDraft=%j fails and releases the claim', async isDraft => {
    const f = fixture(); f.view.isDraft = isDraft;
    expect(await f.begin({ draft: true, reason: 'scope-change' })).toMatchObject({ ok: false, reason: 'draft-failed' });
    expect(f.read()).toBeNull(); expect(f.gh.mock.calls.some(([args]) => args[1] === 'ready')).toBe(false);
  });
  it('strict and direct readers both reject invalid metadata', async () => {
    const f = fixture(); await f.begin();
    const file = join(f.dir(), 'lock.json'), entry = JSON.parse(readFileSync(file, 'utf8'));
    entry.meta.branch = 'lane/a..b'; writeFileSync(file, JSON.stringify(entry));
    expect(listFixDispatchClaimsStrict(f.options.lockRoot).unreadable).toBe(true);
    expect(f.authority()).toMatchObject({ ok: false, code: 'unreadable' });
  });
  it('fixEnd removes the draft sidecar with the released claim', async () => {
    const f = fixture(); await f.begin({ draft: true, reason: 'scope-change' });
    expect(readdirSync(f.dir()).filter(name => name.startsWith('draft.'))).toHaveLength(1);
    expect(await fixEnd({ ...f.options, gh: f.gh, labels: f.labels, readSelfReview: () => null })).toMatchObject({ ok: true });
    expect(existsSync(f.dir())).toBe(false);
  });
  it.each(['{broken', '{}', '{"preDraft":true,"at":"2026-11-24T15:00:00.000Z"}', '{"preDraft":false,"at":"invalid"}'])(
    'incomplete or corrupt draft evidence %s fails closed', async contents => {
      const f = fixture(); await f.begin({ draft: true, reason: 'scope-change' });
      const sidecar = readdirSync(f.dir()).find(name => name.startsWith('draft.'));
      writeFileSync(join(f.dir(), sidecar), contents); f.view.isDraft = true;
      expect(listFixDispatchClaimsStrict(f.options.lockRoot).unreadable).toBe(true);
      expect(f.authority().ok).toBe(false); expect(spawnSync).not.toHaveBeenCalled();
    });
  it('factory lives under __tests__ and a non-test import fails the static guard', () => {
    const f = fixture(), bad = join(f.options.lockRoot, 'production.mjs');
    writeFileSync(bad, "import { createAuthorizedPushForTesting } from './__tests__/helpers/authorized-push-factory.mjs';\n");
    expect(nonTestFactoryImports([bad])).toEqual([bad]);
    expect(nonTestFactoryImports(['scripts/lib/__tests__/authorized-push-s1c.test.mjs'])).toEqual([]);
    expect(existsSync('scripts/lib/__tests__/helpers/authorized-push-factory.mjs')).toBe(true);
    expect(existsSync('scripts/lib/authorized-push-testing.mjs')).toBe(false);
  });
});
