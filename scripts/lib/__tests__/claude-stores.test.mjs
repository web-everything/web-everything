import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeKey, planStores, readStore, aggregate as aggregateModel, resolveOwner, stopPlan,
  afterStopMiss, resolveLaunchAccount, applyWorkerEnv, trustTargets, transcriptRoots } from '../claude-stores.mjs';
import { isAccountMap, AccountRefusal, isNotApplied } from '../claude-account.mjs';

// The model requires plan problems; tests without a plan state that explicitly.
const aggregate = (reads, o = {}) => aggregateModel(reads, { planProblems: [], ...o });
// Fixture IO belongs to the harness. The model receives only values and injected probes.
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = Array.from({ length: 12 }, (_, index) => JSON.parse(readFileSync(
  join(here, '..', '__fixtures__', 'claude-stores', `break-${String(index + 1).padStart(2, '0')}.json`), 'utf8')));
const HOME = '/home/test';
const A = `${HOME}/.claude`;
const B = `${HOME}/claude-b`;
const UUID = 'abcdef01-1234-4567-89ab-123456789abc';
const identity = path => path;
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const store = (key, status = 'ok') => ({ key, account: null, env: { CLAUDE_CONFIG_DIR: key }, status, routed: false, inherited: true });
const options = input => ({ ...input, realpath: identity, exists: path => input.existing.includes(path) });
const readsFor = (stores, input) => stores.map(item => readStore(item, { output: input.listings[item.key] ?? [] }));
function refusal(call) {
  let error;
  try { call(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AccountRefusal);
  expect(error.notApplied).toBe(true);
  expect(isNotApplied(error)).toBe(true);
  expect(typeof error.reason).toBe('string');
  expect(error.reason.trim()).not.toBe('');
  return error;
}

function checkBreak(fixture) {
  const { input, expect: wanted } = fixture;
  const opts = options(input);
  const planned = planStores(opts);
  const agg = aggregate(readsFor(planned.stores, input), { planProblems: planned.problems });
  switch (fixture.break) {
    case 1: {
      const launch = resolveLaunchAccount(opts);
      expect(launch).toMatchObject({ kind: 'account', account: 'b', store: wanted.grant });
      const targets = trustTargets(planned.stores, launch.store);
      expect(targets.grant).toBe(wanted.grant);
      expect(targets.revoke.sort()).toEqual([...wanted.revoke].sort());
      break;
    }
    case 2:
      expect(planned.problems).toEqual([]);
      expect(planned.stores.map(s => s.key).sort()).toEqual([...wanted.keys].sort());
      expect(planned.stores.find(s => s.key === B)).toMatchObject({ account: 'b', routed: wanted.routed, status: 'ok' });
      break;
    case 3:
      expect(resolveOwner(input.handle, agg)).toMatchObject({ kind: 'found', store: wanted.storeKey });
      expect(stopPlan(input.handle, agg)).toEqual({ action: 'stop', ...wanted });
      break;
    case 4:
      expect(transcriptRoots(planned.stores).sort()).toEqual([...wanted.roots].sort());
      break;
    case 5:
      expect(agg.status).toBe('unknown');
      expect(resolveOwner(input.handle, agg)).toMatchObject({ kind: wanted.kind, problems: agg.problems });
      expect(stopPlan(input.handle, agg)).toEqual({ action: wanted.action, reason: wanted.reason });
      break;
    case 6:
      for (const map of input.badMaps) {
        expect(isAccountMap(map)).toBe(wanted.valid);
        refusal(() => resolveLaunchAccount({ ...opts, map }));
        const partial = planStores({ ...opts, map });
        expect(partial.stores.map(s => s.key)).toEqual([A]);
        expect(partial.problems.length).toBeGreaterThan(0);
        const unknown = aggregate(readsFor(partial.stores, input), { mapAvailable: false });
        expect(unknown.status).toBe(wanted.aggregate);
        expect(unknown.problems.length).toBeGreaterThan(0);
      }
      break;
    case 7: {
      const bad = { ...input.map, accounts: { b: { configDir: input.relative } } };
      expect(isAccountMap(bad)).toBe(wanted.validRelative);
      refusal(() => resolveLaunchAccount({ ...opts, map: bad }));
      const launch = resolveLaunchAccount(opts);
      const original = { ...input.env, KEEP: 'yes' };
      const once = applyWorkerEnv(original, launch);
      const twice = applyWorkerEnv(once, launch);
      expect(once).not.toBe(original);
      expect(original).toEqual({ ...input.env, KEEP: 'yes' });
      expect(twice).toEqual(once);
      expect(twice.KEEP).toBe('yes');
      expect(storeKey(once.CLAUDE_CONFIG_DIR, opts)).toBe(wanted.store);
      expect(storeKey(twice.CLAUDE_CONFIG_DIR, opts)).toBe(wanted.store);
      break;
    }
    case 8:
      expect(agg.status).toBe(wanted.status);
      expect(agg.rows).toHaveLength(wanted.rowCount);
      expect(agg.problems.some(p => p.includes(wanted.problemStore) && p.includes(wanted.problemStatus))).toBe(true);
      expect(resolveOwner(input.handle, agg).kind).toBe(wanted.owner);
      expect(stopPlan(input.handle, agg)).toEqual({ action: 'refuse', reason: 'unknown' });
      break;
    case 9: {
      expect(planned.stores.map(s => s.key)).toEqual(wanted.keys);
      const read = readsFor(planned.stores, input)[0];
      expect(aggregate([read, read]).rows).toHaveLength(wanted.rowCount);
      break;
    }
    case 10:
      expect(resolveOwner(input.handle, agg)).toMatchObject({ kind: wanted.kind, matches: expect.any(Array) });
      expect(resolveOwner(input.handle, agg).matches).toHaveLength(2);
      expect(stopPlan(input.handle, agg)).toEqual({ action: 'refuse', reason: wanted.reason });
      expect(resolveOwner(input.unique, agg)).toMatchObject({ kind: 'found', store: wanted.uniqueStore });
      expect(stopPlan(input.unique, agg).env).toEqual({ CLAUDE_CONFIG_DIR: wanted.uniqueStore });
      break;
    case 11:
      for (const map of input.badMaps) {
        const error = refusal(() => resolveLaunchAccount({ ...opts, map }));
        expect(error.notApplied).toBe(wanted.notApplied);
        expect(`${error.message} ${error.reason} ${error.stack}`).not.toContain('secret-relative-input');
      }
      expect(isNotApplied(new Error('ordinary failure'))).toBe(false);
      break;
    case 12: {
      expect(resolveOwner(input.handle, agg).kind).toBe('found');
      const owner = planned.stores.find(s => s.key === A);
      expect(afterStopMiss(input.handle, A, readStore(owner, { output: input.listings[A] }))).toEqual(wanted.listed);
      expect(afterStopMiss(input.handle, A, readStore(owner, { output: [] }))).toEqual(wanted.gone);
      expect(afterStopMiss(input.handle, A, readStore(owner, { error: new Error('unreadable') }))).toEqual(wanted.unreadable);
      break;
    }
    default: throw new Error('unhandled break fixture');
  }
}

describe('multi-store acceptance fixtures', () => {
  // Each table entry registers a separately named `it('break N: ...')`.
  for (const fixture of fixtures) it(`break ${fixture.break}: ${fixture.title}`, () => checkBreak(fixture));
});

describe('store identity and planning guarantees', () => {
  it('resolves symlinks before parent segments in discovery and launch selectors', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-store-path-')));
    try {
      mkdirSync(`${root}/target/child`, { recursive: true });
      mkdirSync(`${root}/target/.claude`);
      symlinkSync(`${root}/target/child`, `${root}/link`, 'dir');
      const parent = `${root}/link/..`;
      const opts = {
        home: root, realpath: realpathSync.native, exists: existsSync,
        env: { CLAUDE_CONFIG_DIR: parent, XPC_SERVICE_NAME: 'com.we.worker' },
        map: { accounts: { a: { configDir: parent }, b: { configDir: root } },
          daemons: { 'com.we.worker': 'a' } },
      };
      expect(realpathSync.native(parent)).toBe(`${root}/target`);
      for (const selector of [parent, `${parent}/`, `${parent}/./`, '~/link/..']) {
        expect(storeKey(selector, opts)).toBe(`${root}/target`);
      }
      expect(storeKey(undefined, { ...opts, home: parent })).toBe(`${root}/target/.claude`);
      expect(planStores({ ...opts, home: parent, env: {}, map: { accounts: {}, daemons: {} } }).stores[0].key)
        .toBe(`${root}/target/.claude`);
      const plan = planStores(opts);
      expect(plan.problems).toEqual([]);
      expect(plan.stores.map(store => store.key)).toEqual([`${root}/target`, root]);
      expect(plan.stores[0]).toMatchObject({ inherited: true, routed: true });
      expect(resolveLaunchAccount(opts)).toMatchObject({ account: 'a', store: `${root}/target`,
        env: { CLAUDE_CONFIG_DIR: `${root}/target` } });
      expect(resolveLaunchAccount({ ...opts, env: { CLAUDE_CONFIG_DIR: parent } }))
        .toEqual({ kind: 'inherit', store: `${root}/target` });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('keeps unresolved parent segments distinct on missing and unreadable probes', () => {
    const selector = `${HOME}/link/../missing`;
    expect(storeKey(selector, { home: HOME, realpath: missing })).toBe(selector);
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    for (const realpath of [missing, denied]) {
      const plan = planStores({ home: HOME, realpath, exists: () => false,
        env: { CLAUDE_CONFIG_DIR: selector },
        map: { accounts: { a: { configDir: `${HOME}/missing` } }, daemons: { 'com.we.worker': 'a' } } });
      expect(plan.stores).toHaveLength(2);
      expect(plan.stores[0]).toMatchObject({ key: selector, status: realpath === missing ? 'invalid' : 'unreadable' });
      expect(plan.stores[1].key).toBe(`${HOME}/missing`);
      expect(plan.stores[0].env.CLAUDE_CONFIG_DIR).toBe(selector);
      expect(transcriptRoots(plan.stores)[0]).toBe(`${selector}/projects`);
    }
  });
  it('storeKey never returns empty; unset, empty and explicit default are identical', () => {
    for (const dir of [undefined, '', A]) expect(storeKey(dir, { home: HOME, realpath: identity })).toBe(A);
  });
  it('preserves unresolved selectors, canonicalizes aliases and only tolerates ENOENT', () => {
    expect(storeKey(`${HOME}/x/../.claude/`, { home: HOME, realpath: missing })).toBe(`${HOME}/x/../.claude/`);
    expect(storeKey('/alias', { home: HOME, realpath: () => A })).toBe(A);
    expect(() => storeKey('relative', { home: HOME, realpath: identity })).toThrow();
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    expect(() => storeKey(A, { home: HOME, realpath: () => { throw denied; } })).toThrow(denied);
  });
  it('merges routed/inherited flags for symlink aliases', () => {
    const input = structuredClone(fixtures[0].input);
    input.map.accounts.b.configDir = '/alias';
    const result = planStores({ ...options(input), realpath: path => path === '/alias' ? A : path, exists: () => true });
    expect(result.stores).toHaveLength(1);
    expect(result.stores[0]).toMatchObject({ key: A, inherited: true, routed: true });
  });
  it('missing inherited and routed stores are invalid, not absent', () => {
    const result = planStores({ ...options(fixtures[0].input), exists: () => false, realpath: missing });
    expect(result.stores).toHaveLength(2);
    expect(result.stores.every(s => s.status === 'invalid')).toBe(true);
  });
  it('routing B off omits unprovisioned B, but retains provisioned rollback B', () => {
    const input = structuredClone(fixtures[0].input);
    input.map.routing.accountB = false;
    expect(planStores({ ...options(input), exists: path => path === A }).stores.map(s => s.key)).toEqual([A]);
    expect(planStores(options(input)).stores.find(s => s.key === B)).toMatchObject({ status: 'ok', routed: false });
  });
  it('non-B daemon mappings route missing stores without the B switch', () => {
    const input = structuredClone(fixtures[0].input);
    input.map.daemons = { 'com.we.worker': 'a' };
    input.map.routing.accountB = false;
    input.env.CLAUDE_CONFIG_DIR = B;
    expect(planStores({ ...options(input), exists: () => false }).stores.find(s => s.key === A))
      .toMatchObject({ routed: true, inherited: false, status: 'invalid' });
  });
});

describe('read, aggregate and ownership guarantees', () => {
  it('accepts JSON or parsed rows, lowercases UUIDs and preserves CLI job ids and row fields', () => {
    const row = { sessionId: UUID.toUpperCase(), id: 'job-17', title: 'inspect' };
    for (const output of [[row], JSON.stringify([row])]) {
      expect(readStore(store(A), { output })).toEqual({ store: store(A), status: 'ok',
        sessions: [{ ...row, sessionId: UUID, storeKey: A }] });
    }
  });
  it.each(['{', '{}', 'null', '42', {}, null, [null], [{}], [{ sessionId: 12 }], [{ sessionId: 'not-a-uuid' }]].map(value => [value]))
    ('rejects the whole malformed store: %j', output => {
      const read = readStore(store(B), { output });
      expect(read).toMatchObject({ status: 'invalid', sessions: [] });
    });
  it('one bad row invalidates otherwise positive rows', () => {
    expect(readStore(store(A), { output: [{ sessionId: UUID }, {}] })).toMatchObject({ status: 'invalid', sessions: [] });
  });
  it('undefined output or any read error is unreadable even alongside valid output', () => {
    for (const io of [{}, { output: [], error: new Error('failed') }]) {
      expect(readStore(store(A), io)).toMatchObject({ status: 'unreadable', sessions: [] });
    }
  });
  it('absent holds nothing, remains absent and contributes no aggregate problem or paths', () => {
    const absent = store(B, 'absent');
    const read = readStore(absent, { error: new Error('missing') });
    expect(read).toEqual({ store: absent, status: 'absent', sessions: [] });
    expect(aggregate([read])).toEqual({ status: 'ok', rows: [], problems: [] });
    expect(transcriptRoots([absent])).toEqual([]);
    expect(trustTargets([store(A), absent], A)).toEqual({ grant: A, revoke: [A] });
  });
  it('unknown never becomes absent and each failed store and map contributes a problem', () => {
    const reads = [readStore(store(A), {}), readStore(store(B), { output: '{}' })];
    const agg = aggregate(reads, { mapAvailable: false });
    expect(agg.status).toBe('unknown');
    expect(agg.problems).toHaveLength(3);
    for (const [key, status] of [[A, 'unreadable'], [B, 'invalid']]) {
      expect(agg.problems.some(p => p.includes(key) && p.includes(status))).toBe(true);
    }
    expect(resolveOwner('missing', agg)).toEqual({ kind: 'unknown', problems: agg.problems });
  });
  it('an unavailable map alone prevents absence even with all stores ok', () => {
    const agg = aggregate([readStore(store(A), { output: [] })], { mapAvailable: false });
    expect(agg.status).toBe('unknown');
    expect(agg.problems).toHaveLength(1);
    expect(resolveOwner(UUID, agg).kind).toBe('unknown');
  });
  it('the same full UUID in two stores is ambiguous; duplicates within one are counted once', () => {
    const a = readStore(store(A), { output: [{ sessionId: UUID, id: 'a' }, { sessionId: UUID.toUpperCase(), id: 'a' }] });
    const b = readStore(store(B), { output: [{ sessionId: UUID, id: 'b' }] });
    const agg = aggregate([a, b]);
    expect(agg.rows).toHaveLength(2);
    expect(resolveOwner(UUID, agg)).toMatchObject({ kind: 'ambiguous', matches: expect.any(Array) });
    expect(stopPlan(UUID, agg)).toEqual({ action: 'refuse', reason: 'ambiguous' });
    expect(resolveOwner(UUID, aggregate([a])).kind).toBe('found');
  });
  it('normalizes handles, matches CLI id, and falls back to UUID only when id is absent', () => {
    const agg = aggregate([readStore(store(B), { output: [{ sessionId: UUID, id: 'job-b' }] })]);
    expect(resolveOwner(`  ${UUID.toUpperCase()}  `, agg)).toMatchObject({ kind: 'found', store: B });
    expect(stopPlan(' JOB-B ', agg)).toEqual({ action: 'stop', storeKey: B, argId: 'job-b', env: { CLAUDE_CONFIG_DIR: B } });
    const noId = aggregate([readStore(store(B), { output: [{ sessionId: UUID }] })]);
    expect(stopPlan(UUID, noId).argId).toBe(UUID);
  });
  it.each([
    ['shared UUID prefix', 'abcdef01', 'abcdef01'],
    ['shared job id', 'job-shared', 'job-shared'],
    ['job id case and whitespace', ' JOB-SHARED ', 'job-shared'],
    ['job id matching another UUID prefix', 'abcdef01-9999', 'job-other'],
  ])('refuses a unique handle whose CLI argument is ambiguous in its store: %s', (_name, firstId, secondId) => {
    const rows = [{ sessionId: UUID, id: firstId },
      { sessionId: 'abcdef01-9999-4567-89ab-123456789abc', id: secondId }];
    for (const output of [rows, [...rows].reverse()]) {
      const agg = aggregate([readStore(store(A), { output })]);
      expect(resolveOwner(firstId, agg).kind).toBe('ambiguous');
      for (const handle of [UUID, 'abcdef01-1234']) {
        expect(resolveOwner(handle, agg).kind).toBe('found');
        expect(stopPlan(handle, agg)).toEqual({ action: 'refuse', reason: 'ambiguous' });
      }
    }
  });
  it('refuses a stop while discovery is incomplete, and checks the emitted argument only in the selected store when complete', () => {
    const a = readStore(store(A), { output: [{ sessionId: UUID, id: 'abcdef01' }] });
    const bad = readStore(store(B), { error: new Error('unreadable') });
    expect(stopPlan(UUID, aggregate([a, bad]))).toEqual({ action: 'refuse', reason: 'unknown' });
    // The selected-store check still works when discovery is complete.
    const clean = readStore(store(B), { output: [{ sessionId: 'abcdef01-9999-4567-89ab-123456789abc', id: 'abcdef01' }] });
    expect(stopPlan(UUID, aggregate([a, clean]))).toEqual({ action: 'stop', storeKey: A,
      argId: 'abcdef01', env: { CLAUDE_CONFIG_DIR: A } });
  });
  it.each([
    ['different job ids', 'job-first', 'job-second'],
    ['missing job id', 'job-first', undefined],
    ['job id case difference', 'job-first', 'JOB-FIRST'],
    ['job id whitespace difference', 'job-first', ' job-first '],
  ])('conflicting duplicate sessions preserve every job identity: %s', (_name, firstId, secondId) => {
    const rows = [{ sessionId: UUID, id: firstId }, { sessionId: UUID.toUpperCase(), id: secondId }];
    for (const ordered of [rows, [...rows].reverse()]) {
      const reads = ordered.map(row => readStore(store(A), { output: [row] }));
      for (const input of [reads, [readStore(store(A), { output: ordered })]]) {
        const agg = aggregate([...input, ...input]);
        expect(agg.status).toBe('ok');
        expect(agg.rows).toHaveLength(2);
        expect(agg.problems).toEqual([]);
        for (const handle of [UUID, 'abcdef01']) {
          expect(resolveOwner(handle, agg).kind).toBe('ambiguous');
          expect(stopPlan(handle, agg)).toEqual({ action: 'refuse', reason: 'ambiguous' });
        }
        for (const handle of [firstId, secondId].filter(id => id !== undefined)) {
          const sameHandle = secondId !== undefined && firstId.trim().toLowerCase() === secondId.trim().toLowerCase();
          expect(resolveOwner(handle, agg).kind).toBe(sameHandle ? 'ambiguous' : 'found');
          expect(stopPlan(handle, agg)).toEqual(sameHandle ? { action: 'refuse', reason: 'ambiguous' }
            : { action: 'stop', storeKey: A, argId: handle, env: { CLAUDE_CONFIG_DIR: A } });
          expect(afterStopMiss(handle, A, readStore(store(A), { output: ordered })))
            .toEqual({ action: 'refuse', reason: 'still-listed' });
        }
      }
    }
  });
  it('identical duplicates keep their job identity, including when no CLI id is supplied', () => {
    for (const id of ['job-first', undefined]) {
      const read = readStore(store(A), { output: [{ sessionId: UUID, id }, { sessionId: UUID.toUpperCase(), id }] });
      const agg = aggregate([read, read]);
      expect(agg.status).toBe('ok');
      expect(agg.rows).toHaveLength(1);
      expect(stopPlan(id ?? UUID, agg)).toEqual({ action: 'stop', storeKey: A,
        argId: id ?? UUID, env: { CLAUDE_CONFIG_DIR: A } });
    }
  });
  it('a conflicting session does not discard other sessions or merge identities across stores', () => {
    const otherUUID = 'ffffffff-1234-4567-89ab-123456789abc';
    const conflict = readStore(store(A), { output: [{ sessionId: UUID, id: 'job-first' },
      { sessionId: UUID, id: 'job-second' }, { sessionId: otherUUID, id: 'job-other' }] });
    const otherStore = readStore(store(B), { output: [{ sessionId: UUID, id: 'job-b' }] });
    const agg = aggregate([conflict, otherStore]);
    expect(agg.status).toBe('ok');
    expect(agg.rows).toHaveLength(4);
    expect(stopPlan(otherUUID, agg)).toEqual({ action: 'stop', storeKey: A,
      argId: 'job-other', env: { CLAUDE_CONFIG_DIR: A } });
    for (const handle of ['job-first', 'job-second']) {
      expect(resolveOwner(handle, agg).kind).toBe('found');
      expect(stopPlan(handle, agg)).toEqual({ action: 'stop', storeKey: A,
        argId: handle, env: { CLAUDE_CONFIG_DIR: A } });
    }
    expect(stopPlan(UUID, agg)).toEqual({ action: 'refuse', reason: 'ambiguous' });
  });
  it.each([undefined, null, 12, '', '   '])('rejects empty/non-string owner handles: %j', handle => {
    expect(() => resolveOwner(handle, { status: 'ok', rows: [], problems: [] })).toThrow();
  });
  it('only complete evidence yields absent and gone', () => {
    const agg = aggregate([readStore(store(A), { output: [] })]);
    expect(resolveOwner(UUID, agg)).toEqual({ kind: 'absent' });
    expect(stopPlan(UUID, agg)).toEqual({ action: 'gone' });
  });
  it('afterStopMiss matches CLI ids and prefixes and refuses malformed or absent relists', () => {
    const read = readStore(store(A), { output: [{ sessionId: UUID, id: 'job-a' }] });
    for (const handle of ['job-a', 'abcdef01']) expect(afterStopMiss(handle, A, read)).toEqual({ action: 'refuse', reason: 'still-listed' });
    for (const read of [readStore(store(A), { output: '{}' }), readStore(store(A, 'absent'), {})]) {
      expect(afterStopMiss(UUID, A, read)).toEqual({ action: 'refuse', reason: 'unknown' });
    }
  });
});

describe('launch-only account contracts', () => {
  it('inherits the canonical store for an unmapped interactive launch', () => {
    expect(resolveLaunchAccount({ env: {}, map: { accounts: {}, daemons: {} }, home: HOME, realpath: identity }))
      .toEqual({ kind: 'inherit', store: A });
  });
  it('launches configDir accounts with an absolute selector', () => {
    expect(resolveLaunchAccount(options(fixtures[0].input))).toEqual({ kind: 'account', account: 'b', store: B,
      env: { CLAUDE_CONFIG_DIR: B } });
  });
  it('B routing off inherits without changing existing resolveAccount behavior', () => {
    const input = structuredClone(fixtures[0].input);
    input.map.routing.accountB = false;
    expect(resolveLaunchAccount(options(input))).toEqual({ kind: 'inherit', store: A });
  });
  it('keychain launches declare credential work without performing IO', () => {
    const input = structuredClone(fixtures[0].input);
    input.map.accounts.b = { service: 'svc', account: 'acct-b', type: 'oauth' };
    expect(resolveLaunchAccount(options(input))).toEqual({ kind: 'account', account: 'b', store: null, env: {}, needsCredential: true });
  });
  it.each(['a', 'b'])('refuses unresolved keychain credentials for account %s before applying worker env', account => {
    const input = structuredClone(fixtures[0].input);
    input.map.daemons[input.env.XPC_SERVICE_NAME] = account;
    input.map.accounts[account] = { service: 'svc', account: `acct-${account}`, type: 'oauth' };
    const launch = resolveLaunchAccount(options(input));
    expect(launch).toMatchObject({ kind: 'account', account, needsCredential: true });
    for (const inherited of [{}, { CLAUDE_CONFIG_DIR: A, ANTHROPIC_API_KEY: 'inherited-secret', KEEP: 'value' }]) {
      for (const extraEnv of [{}, { CLAUDE_CODE_OAUTH_TOKEN: 'unresolved-secret' }]) {
        const env = Object.freeze({ ...inherited });
        const pending = Object.freeze({ ...launch, env: Object.freeze(extraEnv) });
        const error = refusal(() => applyWorkerEnv(env, pending));
        expect(error.reason).toBe('credential-unresolved');
        expect(`${error.message} ${error.reason} ${error.stack}`).not.toContain('secret');
        expect(env).toEqual(inherited);
        expect(pending.needsCredential).toBe(true);
      }
    }
  });
  it('applies resolved keychain credentials while scrubbing inherited credentials', () => {
    const env = { ANTHROPIC_API_KEY: 'old-key', CLAUDE_CODE_OAUTH_TOKEN: 'old-token', KEEP: 'value' };
    const launch = { kind: 'account', account: 'b', store: null, needsCredential: false,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'resolved-token' } };
    expect(applyWorkerEnv(env, launch)).toEqual({ KEEP: 'value', CLAUDE_CODE_OAUTH_TOKEN: 'resolved-token' });
    expect(env.ANTHROPIC_API_KEY).toBe('old-key');
  });
  it('refuses unavailable maps even for an interactive launch and never echoes input or probe secrets', () => {
    refusal(() => resolveLaunchAccount({ env: {}, map: null, home: HOME, realpath: identity }));
    const secret = 'SECRET-PROBE-DO-NOT-ECHO';
    const error = refusal(() => resolveLaunchAccount({ ...options(fixtures[0].input),
      realpath: () => { throw new Error(secret); } }));
    expect(`${error.message} ${error.reason} ${error.stack}`).not.toContain(secret);
  });
  it('inherit worker env is copied without changing the selected store', () => {
    const env = { CLAUDE_CONFIG_DIR: B, KEEP: 'value' };
    const result = applyWorkerEnv(env, { kind: 'inherit', store: B });
    expect(result).toEqual(env);
    expect(result).not.toBe(env);
    expect(storeKey(result.CLAUDE_CONFIG_DIR, { home: HOME, realpath: identity })).toBe(B);
  });
});

describe('short handle with incomplete discovery', () => {
  const sessionId = 'abcdef01-1234-4567-89ab-123456789abc';
  const okRead = readStore(store(A), { output: [{ sessionId, id: 'abcdef01' }] });
  const badRead = readStore(store(B), { output: 'not-json' });
  const agg = aggregate([okRead, badRead]);
  it('a prefix match refuses as unknown (a hidden store could hold a colliding job)', () => {
    expect(resolveOwner('abcdef0', agg).kind).toBe('unknown');
    expect(stopPlan('abcdef0', agg)).toEqual({ action: 'refuse', reason: 'unknown' });
  });
  it('a full UUID matched in a readable store is unknown while another store is unreadable, naming that store', () => {
    const owner = resolveOwner(sessionId, agg);
    expect(owner.kind).toBe('unknown');
    expect(owner.problems.some(p => p.includes(B) && p.includes('invalid'))).toBe(true);
    expect(stopPlan(sessionId, agg)).toEqual({ action: 'refuse', reason: 'unknown' });
  });
  it('a store-local CLI job id is not trusted while discovery is incomplete', () => {
    expect(resolveOwner('abcdef01', agg).kind).toBe('unknown');
    expect(resolveOwner('abcdef01', aggregate([okRead])).kind).toBe('found');
  });
  it('all stores readable: a full UUID is still found (unchanged)', () => {
    const fine = aggregate([okRead, readStore(store(B), { output: [] })]);
    expect(resolveOwner(sessionId, fine)).toMatchObject({ kind: 'found', store: A });
  });
  it('zero stores read: the full UUID is absent only when discovery is complete, unknown with a plan problem', () => {
    expect(resolveOwner(sessionId, aggregate([]))).toEqual({ kind: 'absent' });
    expect(resolveOwner(sessionId, aggregate([], { planProblems: ['account map unavailable'] })).kind).toBe('unknown');
  });
  it('prefix ambiguity is unchanged by an unreadable store', () => {
    const two = readStore(store(B), { output: [{ sessionId: 'abcdef01-0000-4000-8000-000000000000' }] });
    expect(resolveOwner('abcdef01', aggregate([okRead, two])).kind).toBe('ambiguous');
    const bad = readStore(store('/x/c'), { output: 'nope' });
    expect(resolveOwner('abcdef01', aggregate([okRead, two, bad])).kind).toBe('ambiguous');
  });
  it('planning problems (unavailable map) keep the aggregate unknown, never absent', () => {
    const planned = aggregate([okRead], { planProblems: ['account map unavailable'] });
    expect(planned.status).toBe('unknown');
    expect(resolveOwner('ffffffff', planned).kind).toBe('unknown');
  });
  it('applyWorkerEnv scrubs inherited credentials when switching accounts', () => {
    const env = applyWorkerEnv({ ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y', PATH: '/bin' },
      { kind: 'account', env: { CLAUDE_CONFIG_DIR: B } });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: B });
  });
  it('a complete discovery lets the same prefix be found', () => {
    expect(resolveOwner('abcdef0', aggregate([okRead])).kind).toBe('found');
  });
});

describe('audit round 2 guarantees', () => {
  it('aggregate refuses to run without plan problems', () => {
    expect(() => aggregateModel([])).toThrow(TypeError);
  });
  it('a listing row with an empty or non-string id makes the whole store invalid', () => {
    const sessionId = 'abcdef01-1234-4567-89ab-123456789abc';
    for (const id of ['', '  ', 5]) expect(readStore(store(A), { output: [{ sessionId, id }] }).status).toBe('invalid');
  });
});
