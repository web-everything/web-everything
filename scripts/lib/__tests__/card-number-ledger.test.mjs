import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readCardLedger, appendCardLedgerRows, assignCardNumbers, parseCardLedger, sizedCardLedgerRun, numericCardFloor } from '../card-number-ledger.mjs';
import { buildSeedRows, seedCardNumberLedger, LEGACY_IDENTITIES_PATH } from '../../backlog/seed-card-number-ledger.mjs';
import { resolveCardNumbering } from '../policy-cascade.mjs';
import { cardLedgerCheckpoint } from '../../backlog/card-ledger-checkpoint.mjs';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicSigningIdentity, readBoundedTransportFile, stageOnTransportBranch } from '../git-transport-branch.mjs';
import { provisionCardLedgerSigningKey } from '../../backlog/card-ledger-signing-key.mjs';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const a = 'a'.repeat(40), b = 'b'.repeat(40);
const row = (id = 'xabc123', num = 11, kind = 'assign') => ({ id, num, pr: 1, at: '2026-10-19T00:00:00.000Z', by: 'drain', kind });
const lines = (...rows) => rows.map(r => JSON.stringify(r) + '\n').join('');
const hash = s => createHash('sha256').update(s).digest('hex');
const lock = fn => ({ ran: true, result: fn() });
// Real Git evidence: the checked tree and reviewed base can contain different roots.
function signedRepository(test) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'card-ledger-history-')));
  try {
    const board = join(root, 'repo'); mkdirSync(board);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'drain', GIT_AUTHOR_EMAIL: 'drain@example.test',
      GIT_COMMITTER_NAME: 'drain', GIT_COMMITTER_EMAIL: 'drain@example.test' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE']) delete env[name];
    const git = (args, extraEnv = {}) => String(execFileSync('git', args,
      { cwd: board, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: 'pipe', maxBuffer: 65536 }));
    git(['init', '-q', '-b', 'main']);
    const keys = ['trusted', 'forger'].map(name => {
      const path = join(root, name);
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path]);
      return { path, ...publicSigningIdentity(path) };
    });
    const trust = { allowedSigners: [{ key: keys[0].key, fingerprint: keys[0].fingerprint }], quarantine: [] };
    mkdirSync(join(board, 'scripts/settings'), { recursive: true }); mkdirSync(join(board, 'card-numbers'));
    const writeTrust = value => {
      mkdirSync(join(board, 'scripts/settings'), { recursive: true });
      writeFileSync(join(board, 'scripts/settings/card-ledger-trust.json'), JSON.stringify(value));
    };
    const commit = (key = keys[0], date = '2026-10-19T00:00:00Z') => {
      git(['add', '.']);
      git(['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${key.path}`,
        'commit', '-S', '-q', '-m', 'drain evidence'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      return git(['rev-parse', 'HEAD']).trim();
    };
    writeTrust(trust); const base = commit();
    const pinBase = sha => git(['update-ref', 'refs/remotes/origin/main', sha]); pinBase(base);
    let text = '';
    const append = (value, key, date) => { text += lines(value); writeFileSync(join(board, 'card-numbers/we.jsonl'), text); return commit(key, date); };
    const options = () => ({ repo: 'we', board, ledgerAuth: 'signed', existing: text, tip: 'HEAD', env: {} });
    test({ root, board, git, keys, trust, base, writeTrust, commit, pinBase, append, options });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function refusesAssignment(options, error = /unreadable/) {
  const stage = vi.fn(); let returned;
  expect(() => { returned = assignCardNumbers({ ...options, ids: ['xmno345'], numericFiles: [], lock, stage,
    sign: { keyPath: 'never-used' } }); }).toThrow(error);
  // Allocation happens inside stage's content callback, so no stage means no allocation or push.
  expect(stage).not.toHaveBeenCalled(); expect(returned).toBeUndefined();
}

it.each(['origin/main', 'merge_group'].flatMap(source => ['key', 'quarantine', 'both'].map(attack => ({ source, attack }))))(
  'trustRootReadFromBaseNotTreeUnderCheck ($source, malicious $attack)', ({ source, attack }) => {
  signedRepository(f => {
    f.append(row(), f.keys[1]); const legitimate = f.append(row('xdef456', 12));
    f.writeTrust({ allowedSigners: attack === 'quarantine' ? f.trust.allowedSigners : f.keys.map(({ key, fingerprint }) => ({ key, fingerprint })),
      quarantine: attack === 'key' ? [] : [{ commit: legitimate, reason: 'attacker hides legitimate row', approval: 'unreviewed' }] });
    f.commit();
    const eventPath = join(f.root, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ merge_group: { base_sha: f.base } }));
    const options = { ...f.options(), env: source === 'merge_group'
      ? { GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: eventPath } : {} };
    const state = readCardLedger(options);
    expect(state).toMatchObject({ readable: false, byId: new Map([['xdef456', 12]]), byNum: new Map([[12, 'xdef456']]) });
    expect(state.trust).toEqual(f.trust);
    refusesAssignment(options);
    // The identical checked tree is acceptable only once its root is reviewed at base.
    const checked = f.git(['rev-parse', 'HEAD']).trim();
    const reviewed = readCardLedger({ ...options, base: checked });
    expect(reviewed.readable).toBe(attack !== 'quarantine');
    expect(reviewed.byId).toEqual(new Map(attack === 'key' ? [['xabc123', 11], ['xdef456', 12]] : attack === 'both' ? [['xabc123', 11]] : []));
    f.git(['rm', 'scripts/settings/card-ledger-trust.json']); const missing = f.commit(); f.pinBase(missing);
    f.writeTrust(f.trust); f.commit();
    const missingOptions = { ...options, base: missing };
    expect(readCardLedger(missingOptions).readable).toBe(false); refusesAssignment(missingOptions);
  });
});

it('revokedKeyOnlyBeforeCheckpoint rejects a genuinely signed backdated descendant', () => {
  signedRepository(f => {
    f.append(row()); const checkpointCommit = f.append(row('xdef456', 12));
    const initial = f.options().existing;
    const revoked = { ...f.trust, allowedSigners: [{ ...f.trust.allowedSigners[0], revoked: true }],
      checkpoint: { commit: checkpointCommit, fileSha256: hash(initial) } };
    f.writeTrust(revoked); f.pinBase(f.commit());
    expect(readCardLedger(f.options())).toMatchObject({ readable: true, byId: new Map([['xabc123', 11], ['xdef456', 12]]) });
    const after = f.append(row('xghi789', 13), f.keys[0], '2001-01-01T00:00:00Z');
    expect(Number(f.git(['show', '-s', '--format=%ct', after]).trim())).toBeLessThan(Number(f.git(['show', '-s', '--format=%ct', checkpointCommit]).trim()));
    expect(readCardLedger(f.options())).toMatchObject({ readable: false, byId: new Map([['xabc123', 11], ['xdef456', 12]]),
      byNum: new Map([[11, 'xabc123'], [12, 'xdef456']]) });
    refusesAssignment(f.options());
    f.writeTrust(f.trust); f.pinBase(f.commit());
    expect(readCardLedger(f.options()).readable).toBe(true);
  });
});

it('ignoresAmbientSignerTrust even when local Git verifies the forger signature', () => {
  signedRepository(f => {
    const forged = f.append(row(), f.keys[1]); f.append(row('xdef456', 12));
    const ambient = join(f.root, 'ambient-signers');
    writeFileSync(ambient, `drain ${f.keys[1].key}\n`);
    f.git(['config', 'gpg.format', 'ssh']); f.git(['config', 'gpg.ssh.allowedSignersFile', ambient]);
    f.git(['verify-commit', forged]);
    expect(readCardLedger(f.options())).toMatchObject({ readable: false, byId: new Map([['xdef456', 12]]), byNum: new Map([[12, 'xdef456']]) });
    refusesAssignment(f.options());
  });
});

it('writerRefusesUnsignedPush: a transport signing verification failure returns no number and never pushes', async () => {
  const { stageOnTransportBranch } = await import('../git-transport-branch.mjs');
  const calls = [], verify = vi.fn(() => { throw new Error('signature verification failed'); });
  const run = args => {
    calls.push(args);
    return args[0] === 'diff' ? 'card-numbers/we.jsonl' : args[0] === 'rev-parse' ? a : args[0] === 'ls-remote' ? 'tip' : '';
  };
  const f = fixture({ auth: 'signed' }); let returned;
  expect(() => {
    returned = appendCardLedgerRows({ repo: 'we', rows: [row()], ledgerAuth: 'signed', lock,
      sign: { keyPath: 'injected-key' }, run: f.run, readLedger: () => parseCardLedger(''),
      stage: options => stageOnTransportBranch({ ...options, board: 'fixture', run,
        sign: { ...options.sign, verify }, read: () => '', write: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), exists: () => false, log: () => {} }),
    });
  }).toThrow(/signature verification failed/);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(calls.some(args => args.includes('commit') && args.includes('-S'))).toBe(true);
  expect(calls.filter(args => args[0] === 'push')).toEqual([]);
  expect(returned).toBeUndefined();
});

it('damaged introducing history refuses assignment without writes', () => {
  signedRepository(f => {
    const introducing = f.append(row()); f.append(row('xdef456', 12));
    expect(readCardLedger(f.options()).readable).toBe(true);
    rmSync(join(f.board, '.git/objects', introducing.slice(0, 2), introducing.slice(2)));
    expect(readCardLedger(f.options()).readable).toBe(false); refusesAssignment(f.options());
  });
});

it.each(['missing history', 'shallow history', 'unreadable history', 'missing introducing blob', 'invalid signature', 'removal', 'replacement'])(
  '%s refuses assignment without allocation or writes', damage => {
    const initial = lines(row());
    const text = damage === 'removal' ? '' : damage === 'replacement' ? lines(row('xabc123', 12)) : initial;
    const f = fixture({ auth: 'signed', text, history: [[a, initial], [b, text]], bad: damage === 'invalid signature' ? [a] : [] });
    const original = f.run.getMockImplementation();
    f.run.mockImplementation((args, opts) => {
      if (args[0] === 'rev-list' && damage === 'missing history') return '';
      if (args.includes('--is-shallow-repository') && damage === 'shallow history') return 'true';
      if ((args[0] === 'rev-list' && damage === 'unreadable history') || (args[0] === 'show' && args[1] === `${a}:card-numbers/we.jsonl` && damage === 'missing introducing blob')) throw new Error('missing Git object');
      return original(args, opts);
    });
    expect(f.read().readable).toBe(false); refusesAssignment(f.options);
  });
function fixture({ text = '', history = [], trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }], quarantine: [] }, bad = [], auth = 'none', maxBytes = 4096, historyBudget = 10 } = {}) {
  const snapshots = Object.fromEntries(history);
  const run = vi.fn((args, opts) => {
    if (args[0] === 'fetch') return '';
    if (args[0] === 'ls-tree') return 'card-numbers/we.jsonl';
    if (args[0] === 'rev-parse') return args.includes('--is-shallow-repository') ? 'false' : b;
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-list') return history.map(([sha]) => sha).reverse().join('\n');
    if (args[0] === 'show') {
      if (args[1].endsWith('card-ledger-trust.json')) return JSON.stringify(trust);
      const sha = args[1].split(':')[0];
      return sha === 'origin/ops/card-numbers' ? text : snapshots[sha];
    }
    throw new Error('unexpected git ' + args.join(' '));
  });
  const verify = vi.fn(({ commit, allowedSigners }) => {
    if (bad.includes(commit) || !allowedSigners.length) throw new Error('untrusted signature');
    return 'SHA256:trusted';
  });
  const options = { repo: 'we', board: 'fixture', run, verify, ledgerAuth: auth, maxBytes, historyBudget, env: { WE_OPS_FETCH_TTL_MS: '0' } };
  return { run, verify, options, read: () => readCardLedger(options) };
}
describe('strict per-repo ledger', () => {
  it('none is default; missing ledger is unreadable; none never reads signing trust/history', () => {
    const f = fixture({ text: lines(row()) });
    expect(f.read()).toMatchObject({ readable: true, byId: new Map([['xabc123', 11]]) });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([a]) => a[0] === 'rev-list')).toBe(false);
    expect(fixture({ text: null }).read().readable).toBe(false);
    expect(() => readCardLedger({ repo: '../evil' })).toThrow(/repo/);
  });
  it('strict shape, conflicting identities/numbers, and partial last lines fail closed', () => {
    for (const text of [lines(row(), row('xabc123', 12)), lines(row(), row('xdef456', 11)), lines({ ...row(), extra: true }), lines({ ...row(), num: 100000 }), JSON.stringify(row()), 'bad\n']) {
      expect(parseCardLedger(text).readable).toBe(false);
    }
    expect(parseCardLedger(lines(row(), row())).readable).toBe(true);
    expect(parseCardLedger(JSON.stringify(row())).byId.size).toBe(0);
  });
  it('numeric floor includes only top-level numeric files', () => {
    expect(numericCardFloor(['backlog/009-a.md', 'backlog/042-b.md', 'backlog/raised-by/90/999-x.md'])).toBe(42);
  });
  it('rejectsOversizedLedgerBeforeAllocation: sized boundary refuses blob before full read', () => {
    const exec = vi.fn(args => args[0] === 'rev-parse' ? a : args[1] === '-s' ? '101' : 'x'.repeat(101));
    expect(() => sizedCardLedgerRun({ maxBytes: 100, exec })(['show', 'tip:file'])).toThrow(/cap/);
    expect(exec.mock.calls.some(([args]) => args[0] === 'cat-file' && args[1] === 'blob')).toBe(false);
    exec.mockImplementation(args => args[0] === 'rev-parse' ? a : args[1] === '-s' ? '5' : '12345');
    expect(sizedCardLedgerRun({ maxBytes: 100, exec })(['show', 'tip:file'])).toBe('12345');
    expect(exec.mock.calls.at(-1)[1].maxBuffer).toBeLessThanOrEqual(101);
  });
});
describe('signed introducing history', () => {
  it.each(['seed', 'shadow', 'assign'])('rejectsUntrustedIntroducerBehindTrustedTip including spoofed authors: %s', kind => {
    const forged = row('xabc123', 11, kind), good = row('xdef456', 12, kind);
    const f = fixture({ auth: 'signed', text: lines(forged, good), history: [[a, lines(forged)], [b, lines(forged, good)]], bad: [a] });
    const state = f.read();
    expect(state).toMatchObject({ readable: false, byId: new Map([['xdef456', 12]]) });
    expect(state.byNum).toEqual(new Map([[12, 'xdef456']]));
    // Consumer contract: diagnostic mappings cannot authorize display or queue writes.
    // This shadow slice has no production display/enqueue reader yet.
    const assignment = vi.fn(() => row().at), enqueue = vi.fn();
    const displayed = [forged.id, good.id].map(id => state.readable ? state.byId.get(id) ?? id : id);
    expect(displayed).toEqual(['xabc123', 'xdef456']);
    const stage = vi.fn();
    // Even the trusted row must not take the idempotent assignment shortcut.
    for (const id of [good.id, 'xghi789']) {
      let returned;
      expect(() => {
        returned = assignCardNumbers({ ...f.options, ids: [id], stage, now: assignment, lock });
        enqueue(returned);
      }).toThrow(/unreadable/);
      expect(returned).toBeUndefined();
    }
    expect(stage).not.toHaveBeenCalled();
    expect(assignment).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it('trustRootReadFromBaseNotTreeUnderCheck; missing root refuses', () => {
    const f = fixture({ auth: 'signed', text: lines(row()), history: [[a, lines(row())]], bad: [a] });
    expect(f.read().readable).toBe(false);
    expect(f.run).toHaveBeenCalledWith(['show', 'origin/main:scripts/settings/card-ledger-trust.json'], expect.any(Object));
    const g = fixture({ auth: 'signed', trust: null }); expect(g.read().readable).toBe(false);
  });
  it('missing history, invalid signatures, removal/replacement refuse', () => {
    for (const history of [[], [[a, lines(row())], [b, '']], [[a, lines(row())], [b, lines(row('xabc123', 12))]]]) {
      const text = history.length ? history.at(-1)[1] : lines(row());
      expect(fixture({ auth: 'signed', text, history }).read().readable).toBe(false);
    }
  });
  it('quarantineRestoresReadabilityAndBurnsNumbers without inflating floor', () => {
    const forged = lines(row('xabc123', 99999), row('xghi789', 13));
    const good = lines(row('xdef456', 12));
    const f = fixture({ auth: 'signed', text: forged + good, history: [[a, forged], [b, forged + good]], bad: [a] });
    const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }], quarantine: [{ commit: a, reason: 'forged', approval: 'reviewed PR' }] };
    expect(f.read().readable).toBe(false);
    const clean = fixture({ auth: 'signed', text: forged + good, history: [[a, forged], [b, forged + good]], bad: [a], trust }).read();
    expect(clean.readable).toBe(true); expect(clean.burned.has(99999)).toBe(true);
    expect(clean.byNum.has(99999)).toBe(false);
    for (const commit of ['abc', a.toUpperCase()]) expect(fixture({ auth: 'signed', trust: { ...trust, quarantine: [{ ...trust.quarantine[0], commit }] } }).read().readable).toBe(false);
  });
  it('checkpointBoundsHistoryWalk and revokedKeyOnlyBeforeCheckpoint', () => {
    const initial = lines(row()); const text = initial + lines(row('xdef456', 12));
    const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted', revoked: true }], checkpoint: { commit: a, fileSha256: hash(initial) }, quarantine: [] };
    const f = fixture({ auth: 'signed', text, history: [[a, initial], [b, text]], trust });
    // Fixture rev-list models the range after checkpoint.
    const original = f.run.getMockImplementation();
    f.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? b : original(args, opts));
    expect(f.read()).toMatchObject({ readable: false, byId: new Map([['xabc123', 11]]) });
    expect(f.verify.mock.calls.every(([o]) => o.commit !== a)).toBe(true);
    expect(fixture({ auth: 'signed', text, history: [[a, initial], [b, text]], historyBudget: 1 }).read().readable).toBe(false);
    expect(fixture({ auth: 'signed', text, trust: { ...trust, checkpoint: { commit: a, fileSha256: '0'.repeat(64) } }, history: [[a, initial]] }).read().readable).toBe(false);
  });
});
describe('CAS allocation and seed', () => {
  function writer({ fail = false, overflow = false } = {}) {
    let text = ''; let pushes = 0; const proposals = [];
    const read = () => parseCardLedger(text);
    const stage = vi.fn(o => {
      const next = o.files[0].content({ existing: text }); proposals.push(next); pushes++;
      if (pushes === 1) { text = overflow ? 'x'.repeat(500) : lines(row('xdef456', 11)); throw new Error('non-fast-forward'); }
      if (fail) throw new Error('signing failed');
      text = next; return { pushed: true };
    });
    return { read, stage, proposals, get pushes() { return pushes; } };
  }
  it('recomputes after a concurrent winner and returns only read-back numbers; replay idempotent', () => {
    const w = writer(); const opts = { repo: 'we', ids: ['xabc123'], pr: 1, floor: 10, numericFiles: [], lock, readLedger: w.read, stage: w.stage };
    expect(assignCardNumbers(opts)).toEqual(new Map([['xabc123', 12]]));
    expect(w.proposals[0]).toContain('"num":11'); expect(w.proposals[1]).toContain('"num":12');
    const count = w.pushes; expect(assignCardNumbers(opts).get('xabc123')).toBe(12); expect(w.pushes).toBe(count);
  });
  it('overflowing retry stops allocation, append and push; no number returned', () => {
    const w = writer({ overflow: true });
    expect(() => assignCardNumbers({ repo: 'we', ids: ['xabc123'], floor: 10, numericFiles: [], lock, readLedger: w.read, stage: w.stage, maxBytes: 200 })).toThrow();
    expect(w.pushes).toBe(1);
  });
  it('writerRefusesUnsignedPush in signed mode and refuses non-ledger refs before IO', () => {
    const stage = vi.fn();
    expect(() => appendCardLedgerRows({ repo: 'we', rows: [row()], ledgerAuth: 'signed', stage, lock })).toThrow(/sign/);
    expect(stage).not.toHaveBeenCalled();
    expect(() => appendCardLedgerRows({ repo: 'we', rows: [row()], branch: 'main', stage, lock })).toThrow(/ONLY|ref/);
    expect(stage).not.toHaveBeenCalled();
  });
  it('seedHandlesLegacyDuplicateBornAs: allowlist is upper bound and body identities ignored', () => {
    const cards = [{ path: 'backlog/010-a.md', text: '---\nbornAs: xabc123\n---\n' }, { path: 'backlog/011-b.md', text: '---\nbornAs: xabc123\n---\n' }, { path: 'backlog/012-c.md', text: '---\nstatus: open\n---\nbornAs: xabc123\n' }];
    const legacy = [{ id: 'xabc123', nums: [10, 11], canonical: 10, reason: 'legacy' }];
    expect(buildSeedRows({ cards, legacy }).rows.map(r => [r.id, r.num])).toEqual([['xabc123', 10]]);
    expect(buildSeedRows({ cards, legacy: [] }).errors.length).toBeGreaterThan(0);
    expect(buildSeedRows({ cards: [cards[1]], legacy })).toMatchObject({ rows: [expect.objectContaining({ num: 11 })], warnings: [expect.any(String)] });
    expect(buildSeedRows({ cards: [...cards, { ...cards[0], path: 'backlog/013-third.md' }], legacy }).errors.length).toBeGreaterThan(0);
    const append = vi.fn(); const run = vi.fn(() => JSON.stringify({ we: [] }));
    expect(() => seedCardNumberLedger({ repo: 'we', cards, run, append, apply: true })).toThrow(/duplicate/);
    expect(append).not.toHaveBeenCalled(); expect(run.mock.calls[0][0]).toEqual(['show', `origin/main:${LEGACY_IDENTITIES_PATH}`]);
  });
});
it('card policies use the cascade, default auth none, repo pins rename-before-enqueue', () => {
  expect(resolveCardNumbering({ env: {}, platform: {} })).toMatchObject({ value: { mode: 'rename-before-enqueue', ledgerAuth: 'none' }, sources: { mode: 'tool', ledgerAuth: 'standard' } });
  expect(resolveCardNumbering({ tool: {}, platform: {}, env: {} }).value.mode).toBe('rename-after-land');
  const s = resolveCardNumbering({ tool: {}, platform: { ledgerAuth: 'signed' }, env: { WE_CARD_NUMBERING_MODE: 'bad', WE_CARD_LEDGER_AUTH: 'bad' } });
  expect(s.value.ledgerAuth).toBe('signed'); expect(s.invalid).toHaveLength(2);
});

it('real legacy list seeds all seven pairs once, never migrates aliases', async () => {
  const { readFileSync } = await import('node:fs');
  const legacy = JSON.parse(readFileSync('scripts/settings/card-ledger-legacy-identities.json', 'utf8')).we;
  expect(legacy).toHaveLength(7);
  const cards = legacy.flatMap(e => e.nums.map(num => ({ path: `backlog/${num}-legacy.md`, text: `---\nbornAs: ${e.id}\n---\n` })));
  const result = buildSeedRows({ cards, legacy });
  expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(7);
  expect(parseCardLedger(lines(...result.rows)).conflicts).toEqual([]);
});

it('initial oversized evidence refuses before allocation or staging', () => {
  // now runs in the real allocator for each proposed row; allocate is overwritten
  // by assignCardNumbers and therefore cannot serve as an allocation spy here.
  const now = vi.fn(() => row().at);
  const stage = vi.fn(options => {
    options.files[0].content({ existing: '' });
    return { pushed: true };
  });
  const readLedger = () => parseCardLedger('x'.repeat(101), { maxBytes: 100 });
  let returned;
  expect(() => { returned = assignCardNumbers({ repo: 'we', ids: ['xabc123'], numericFiles: [], stage, now,
    readLedger, maxBytes: 100, lock }); }).toThrow(/unreadable/);
  expect(stage).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled();
  expect(returned).toBeUndefined();
});
it('read-back failure never returns an unconfirmed assignment', () => {
  const stage = vi.fn(o => { o.files[0].content({ existing: '' }); return { pushed: true }; });
  expect(() => assignCardNumbers({ repo: 'we', ids: ['xabc123'], stage, readLedger: () => parseCardLedger(''), floor: 10, numericFiles: [], lock })).toThrow(/read-back/);
});
it('quarantined numbers are skipped but never raise floor, and trusted rows retain their numbers', () => {
  let text = lines(row('xdef456', 12));
  const readLedger = () => ({ ...parseCardLedger(text), burned: new Set([13, 99999]) });
  // Exercise the allocator's quarantine exclusions through its fresh-state seam.
  const realStage = o => {
    const content = o.files[0].content;
    // Signed reader provides burned state, including on every retry.
    text = content({ existing: text, wt: 'fixture' });
    return { pushed: true };
  };
  const f = fixture({ auth: 'signed' });
  const opts = { repo: 'we', ids: ['xghi789'], ledgerAuth: 'signed', sign: { keyPath: 'unused-in-injected-stage' },
    run: f.run, stage: realStage, readLedger, floor: 12, numericFiles: [], lock };
  expect(assignCardNumbers(opts).get('xghi789')).toBe(14);
  const forged = lines(row('xabc123', 11)); const good = lines(row('xdef456', 11));
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }], quarantine: [{ commit: a, reason: 'forged', approval: 'reviewed' }] };
  const result = fixture({ auth: 'signed', text: forged + good, history: [[a, forged], [b, forged + good]], bad: [a], trust }).read();
  expect(result.readable).toBe(true); expect(result.byNum.get(11)).toBe('xdef456'); expect(result.burned.has(11)).toBe(false);
});
it('checkpoint advances past exhausted history and does not revisit reviewed commits', () => {
  const text = lines(row()); const checkpoint = { commit: a, fileSha256: hash(text) };
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted', revoked: true }], quarantine: [], checkpoint };
  const f = fixture({ auth: 'signed', text, trust, history: [[a, text]], historyBudget: 1 });
  const original = f.run.getMockImplementation();
  f.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? '' : original(args, opts));
  expect(f.read().readable).toBe(true); expect(f.verify).not.toHaveBeenCalled();
  expect(f.run.mock.calls.some(([args]) => args[0] === 'rev-list' && args.includes(`${a}..origin/ops/card-numbers`))).toBe(true);
});

it('checkpointPreservesQuarantinedRowsAndBurnedNumbers', () => {
  const good = row('xdef456', 12);
  const forged = lines(row('xabc123', 13), row('xghi789', 99999), row('xjkl012', 12), good) + 'invalid quarantined line\n';
  const text = forged + lines(good);
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }],
    quarantine: [{ commit: a, reason: 'forged', approval: 'reviewed' }] };
  const original = fixture({ auth: 'signed', text, trust, history: [[a, forged], [b, text]], bad: [a] });
  const checkpoint = cardLedgerCheckpoint({ ...original.options, commit: b,
    env: { ...original.options.env, WE_CARD_LEDGER_AUTH: 'signed' } });
  expect(checkpoint).toEqual({ commit: b, fileSha256: hash(text), quarantinedLines: [1, 2, 3, 4, 5], quarantinedCommits: [a] });

  const adopted = fixture({ auth: 'signed', text, trust: { ...trust, checkpoint }, history: [[a, forged], [b, text]] });
  const native = adopted.run.getMockImplementation();
  adopted.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? '' : native(args, opts));
  const assertPreserved = state => {
    expect(state.readable).toBe(true);
    expect(state.byId).toEqual(new Map([['xdef456', 12]]));
    expect(state.byNum).toEqual(new Map([[12, 'xdef456']]));
    expect(state.burned).toEqual(new Set([13, 99999]));
  };
  assertPreserved(adopted.read());
  expect(adopted.verify).not.toHaveBeenCalled();
  expect(adopted.run.mock.calls.some(([args]) => args[0] === 'show' && args[1] === `${a}:card-numbers/we.jsonl`)).toBe(false);

  // Allocation uses the checkpoint-restored reader, not synthetic burned-number state.
  let appended;
  const stage = vi.fn(options => {
    appended = options.files[0].content({ existing: text, wt: 'fixture' });
    throw new Error('probe stops before push');
  });
  expect(() => assignCardNumbers({ ...adopted.options, ids: ['xmno345'], numericFiles: [], lock,
    sign: { keyPath: 'injected-stage' }, readLedger: adopted.read, stage })).toThrow(/probe stops/);
  expect(JSON.parse(appended.trim().split('\n').at(-1))).toMatchObject({ id: 'xmno345', num: 14 });

  const c = 'c'.repeat(40);
  const advancing = fixture({ auth: 'signed', text, trust: { ...trust, checkpoint }, history: [[a, forged], [b, text], [c, text]] });
  const advanceRun = advancing.run.getMockImplementation();
  advancing.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? c : advanceRun(args, opts));
  const advanced = cardLedgerCheckpoint({ ...advancing.options, commit: c,
    env: { ...advancing.options.env, WE_CARD_LEDGER_AUTH: 'signed' } });
  expect(advanced).toEqual({ ...checkpoint, commit: c });
  const final = fixture({ auth: 'signed', text, trust: { ...trust, checkpoint: advanced }, history: [[c, text]] });
  const finalRun = final.run.getMockImplementation();
  final.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? '' : finalRun(args, opts));
  assertPreserved(final.read());
});

it('checkpointAccountsForQuarantinesOutsideRepositoryHistory', () => {
  const text = lines(row());
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }],
    quarantine: [{ commit: a, reason: 'other repository file', approval: 'reviewed' }] };
  const f = fixture({ auth: 'signed', text, trust, history: [[b, text]] });
  const checkpoint = cardLedgerCheckpoint({ ...f.options, commit: b,
    env: { ...f.options.env, WE_CARD_LEDGER_AUTH: 'signed' } });
  expect(checkpoint.quarantinedLines).toEqual([]);
  expect(checkpoint.quarantinedCommits).toEqual([a]);
  const adopted = fixture({ auth: 'signed', text, trust: { ...trust, checkpoint }, history: [[b, text]] });
  const native = adopted.run.getMockImplementation();
  adopted.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? '' : native(args, opts));
  expect(adopted.read()).toMatchObject({ readable: true, byId: new Map([['xabc123', 11]]), burned: new Set() });
});

it.each([
  {},
  { quarantinedLines: [0], quarantinedCommits: [a] },
  { quarantinedLines: [1, 1], quarantinedCommits: [a] },
  { quarantinedLines: [2], quarantinedCommits: [a] },
  { quarantinedLines: [1], quarantinedCommits: [] },
  { quarantinedLines: [], quarantinedCommits: ['short'] },
  { quarantinedLines: [], quarantinedCommits: [] },
])('incompleteCheckpointQuarantineMetadataRefusesAssignmentAndCandidate: %j', metadata => {
  const text = lines(row());
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }],
    quarantine: [{ commit: a, reason: 'forged', approval: 'reviewed' }],
    checkpoint: { commit: b, fileSha256: hash(text), ...metadata } };
  const f = fixture({ auth: 'signed', text, trust, history: [[b, text]] });
  const native = f.run.getMockImplementation();
  f.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? '' : native(args, opts));
  expect(f.read().readable).toBe(false);
  const stage = vi.fn();
  expect(() => assignCardNumbers({ ...f.options, ids: ['xdef456'], stage, lock })).toThrow(/unreadable/);
  expect(stage).not.toHaveBeenCalled();
  expect(() => cardLedgerCheckpoint({ ...f.options, commit: b,
    env: { ...f.options.env, WE_CARD_LEDGER_AUTH: 'signed' } })).toThrow(/checkpoint/);
});

it('assigner takes its floor from numeric filenames and skips legacy alias numbers', () => {
  let text = '';
  const stage = o => { text = o.files[0].content({ existing: text }); return { pushed: true }; };
  const assigned = assignCardNumbers({ repo: 'we', ids: ['xabc123'], numericFiles: ['backlog/010-canonical.md', 'backlog/042-alias.md'],
    stage, readLedger: () => parseCardLedger(text), lock });
  expect(assigned.get('xabc123')).toBe(43);
});
it('none-mode seed apply needs no signing bootstrap and pushes once; dry run never writes', () => {
  const cards = [{ path: 'backlog/011-a.md', text: '---\nbornAs: xabc123\n---\n' }];
  const run = vi.fn(() => '{"we":[]}'), append = vi.fn();
  expect(seedCardNumberLedger({ repo: 'we', cards, run, append, env: {} }).applied).toBe(false);
  expect(append).not.toHaveBeenCalled();
  expect(seedCardNumberLedger({ repo: 'we', cards, run, append, env: {}, apply: true }).applied).toBe(true);
  expect(append).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, rows: [expect.objectContaining({ id: 'xabc123', num: 11, kind: 'seed' })] }));
});
it('refuses on mutex contention and bounded CAS exhaustion with an operator-visible fallback', () => {
  const stage = vi.fn();
  expect(() => appendCardLedgerRows({ repo: 'we', rows: [row()], lock: () => ({ ran: false }), stage })).toThrow(/mutex/);
  expect(stage).not.toHaveBeenCalled();
  stage.mockImplementation(o => { o.files[0].content({ existing: '' }); throw new Error('non-fast-forward'); });
  expect(() => appendCardLedgerRows({ repo: 'we', rows: [row()], stage, attempts: 2, lock })).toThrow(/exhausted 2.*retry/);
  expect(stage).toHaveBeenCalledTimes(2);
});
it('merged introducing history refuses rather than trusting a signed merge tip', () => {
  const f = fixture({ auth: 'signed', text: lines(row()) });
  const original = f.run.getMockImplementation();
  f.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? `${b} ${a} ${'c'.repeat(40)}` : original(args, opts));
  expect(f.read()).toMatchObject({ readable: false, errors: [expect.stringContaining('checkpoint')] });
});
it('quarantine never makes a partial final row readable', () => {
  const text = JSON.stringify(row());
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }], quarantine: [{ commit: a, reason: 'forged', approval: 'reviewed' }] };
  expect(fixture({ auth: 'signed', text, history: [[a, text]], trust }).read().readable).toBe(false);
});

it.each([
  { name: 'quarantined partial then trusted append', bad: [] },
  { name: 'trusted partial then trusted append', quarantine: [] },
  { name: 'quarantined partial then quarantined append', both: true },
])('commitBoundarySplittingAPhysicalLineRefusesReadAndCheckpoint: $name', ({ quarantine, both }) => {
  const partial = 'invalid quarantined row';
  const text = partial + lines(row('xabc123', 11, 'shadow'));
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }],
    quarantine: quarantine ?? [{ commit: a, reason: 'forged', approval: 'reviewed' },
      ...(both ? [{ commit: b, reason: 'forged', approval: 'reviewed' }] : [])] };
  const f = fixture({ auth: 'signed', text, trust, history: [[a, partial], [b, text]] });
  const state = f.read();
  expect(state.readable).toBe(false);
  expect(state.errors.join(';')).toMatch(/boundary/);
  expect(() => cardLedgerCheckpoint({ ...f.options, commit: b,
    env: { ...f.options.env, WE_CARD_LEDGER_AUTH: 'signed' } })).toThrow(/checkpoint refused/);
  // The physical-line reader (used once a checkpoint is adopted) agrees: the same bytes are unreadable.
  expect(parseCardLedger(text).readable).toBe(false);
});
it('splitRowRecoveryNamedInTheBoundaryErrorReadsOnceTheJoinedLineIsQuarantined', () => {
  // The boundary refusal names its recovery: a reviewed checkpoint at the completing commit that
  // quarantines the joined physical line. Pin that this recovery really yields a readable ledger.
  const text = 'invalid quarantined row' + lines(row('xabc123', 11, 'shadow'));
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:trusted' }],
    quarantine: [{ commit: a, reason: 'forged', approval: 'reviewed' }],
    checkpoint: { commit: b, fileSha256: hash(text), quarantinedLines: [1], quarantinedCommits: [a] } };
  const f = fixture({ auth: 'signed', text, trust, history: [[b, text]] });
  const native = f.run.getMockImplementation();
  f.run.mockImplementation((args, opts) => args[0] === 'rev-list' ? '' : native(args, opts));
  const state = f.read();
  expect(state).toMatchObject({ readable: true, errors: [], quarantinedLines: [1], quarantinedCommits: [a] });
  expect(state.byId.size).toBe(0);
});

it('real SSH introducing commits reject an unsigned row beneath a signed tip', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { publicSigningIdentity } = await import('../git-transport-branch.mjs');
  const root = mkdtempSync(join(tmpdir(), 'card-ledger-real-'));
  try {
    const board = join(root, 'repo'), keyPath = join(root, 'key'); mkdirSync(board);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', keyPath]);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'drain', GIT_AUTHOR_EMAIL: 'drain@example.test', GIT_COMMITTER_NAME: 'drain', GIT_COMMITTER_EMAIL: 'drain@example.test' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
    const git = args => String(execFileSync('git', args, { cwd: board, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 65536 }));
    git(['init', '-q', '-b', 'main']);
    mkdirSync(join(board, 'scripts/settings'), { recursive: true }); mkdirSync(join(board, 'card-numbers'));
    writeFileSync(join(board, 'scripts/settings/card-ledger-trust.json'), JSON.stringify({ allowedSigners: [publicSigningIdentity(keyPath)], quarantine: [] }));
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'reviewed trust root']);
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).trim()]);
    const commit = (text, signed) => {
      writeFileSync(join(board, 'card-numbers/we.jsonl'), text); git(['add', '.']);
      git(['-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `user.signingkey=${keyPath}`, '-c', `commit.gpgsign=${signed}`, 'commit', '-q', '-m', 'drain row']);
    };
    const original = lines(row()); const forged = lines(row('xdef456', 12, 'shadow')); const good = lines(row('xghi789', 13, 'seed'));
    commit(original, true); commit(original + forged, false); commit(original + forged + good, true);
    const result = readCardLedger({ repo: 'we', board, ledgerAuth: 'signed', existing: original + forged + good, tip: 'HEAD', env: {} });
    expect(result.readable).toBe(false);
    expect(result.byId, JSON.stringify(result.errors)).toEqual(new Map([['xabc123', 11], ['xghi789', 13]]));
    expect(result.errors).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('accepts ordinary SSH public-key comments but rejects multiline signer material', () => {
  const trust = { allowedSigners: [{ key: 'ssh-ed25519 AAAA drain host', fingerprint: 'SHA256:trusted' }], quarantine: [] };
  expect(fixture({ auth: 'signed', text: lines(row()), history: [[a, lines(row())]], trust }).read().readable).toBe(true);
  trust.allowedSigners[0].key += '\nother AAAA';
  expect(fixture({ auth: 'signed', text: lines(row()), history: [[a, lines(row())]], trust }).read().readable).toBe(false);
});

it('rejectsAppendCrossingReadCapBeforePush', async () => {
  const { stageOnTransportBranch } = await import('../git-transport-branch.mjs');
  const existing = lines(row());
  const added = row('xdef456', 12);
  const maxBytes = Buffer.byteLength(existing + lines(added)) - 1;
  expect(Buffer.byteLength(existing)).toBeLessThan(maxBytes);
  const calls = [];
  const run = args => { calls.push(args); return args[0] === 'diff' ? 'card-numbers/we.jsonl' : args[0] === 'ls-remote' ? 'tip' : ''; };
  const write = vi.fn(), readLedger = vi.fn(() => parseCardLedger(existing));
  let result, error;
  try {
    result = appendCardLedgerRows({ repo: 'we', rows: [added], ledgerAuth: 'none', maxBytes, lock, readLedger,
      stage: options => stageOnTransportBranch({ ...options, board: 'fixture', run,
        read: () => existing, write, mkdir: vi.fn(), rm: vi.fn(), exists: () => false, log: () => {} }),
    });
  } catch (e) { error = e; }
  expect(calls.filter(args => args[0] === 'push')).toEqual([]);
  expect(calls.filter(args => args.includes('commit'))).toEqual([]);
  expect(write.mock.calls.some(([path]) => path.endsWith('card-numbers/we.jsonl'))).toBe(false);
  expect(error?.message).toMatch(/cap.*raise readMaxBytes/);
  expect(readLedger).not.toHaveBeenCalled();
  expect(result).toBeUndefined();
});
it('allowsCompleteLedgerExactlyAtReadCap', () => {
  let text = lines(row());
  const added = row('xdef456', 12);
  const maxBytes = Buffer.byteLength(text + lines(added));
  const push = vi.fn();
  const stage = options => { text = options.files[0].content({ existing: text }); push(); return { pushed: true }; };
  expect(appendCardLedgerRows({ repo: 'we', rows: [added], ledgerAuth: 'none', maxBytes, lock, stage,
    readLedger: () => parseCardLedger(text, { maxBytes }) })).toEqual(new Map([['xdef456', 12]]));
  expect(push).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(text)).toBe(maxBytes);
});

it.each([{ floor: 10, expected: 43 }, { floor: 80, expected: 81 }])(
  'explicitReservationFloorNeverReplacesNumericFilenameEvidence ($floor)', ({ floor, expected }) => {
    let text = '';
    const run = vi.fn(() => 'backlog/010-canonical.md\nbacklog/042-legacy-alias.md\n');
    const stage = vi.fn(options => { text = options.files[0].content({ existing: text }); return { pushed: true }; });
    const assigned = assignCardNumbers({ repo: 'we', board: 'fixture', ids: ['xabc123'], floor, run, stage,
      readLedger: () => parseCardLedger(text), lock });
    expect(assigned.get('xabc123')).toBe(expected);
    expect(assigned.get('xabc123')).toBeGreaterThan(42);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'], expect.objectContaining({ cwd: 'fixture' }));
    expect(stage).toHaveBeenCalledTimes(1);
  });
it('explicitReservationFloorDoesNotPermitAllocationWhenNumericFilenamesAreUnreadable', () => {
  const run = vi.fn(() => { throw new Error('numeric filenames unavailable'); });
  const stage = vi.fn(options => { options.files[0].content({ existing: '' }); return { pushed: true }; });
  expect(() => assignCardNumbers({ repo: 'we', board: 'fixture', ids: ['xabc123'], floor: 10, run, stage,
    readLedger: () => parseCardLedger(''), lock })).toThrow(/numeric filenames unavailable/);
  expect(run).toHaveBeenCalledTimes(1);
  expect(stage).not.toHaveBeenCalled();
});

// Retained boundary regressions from the former out-of-scope suite.
describe('card ledger filesystem boundaries', () => {
  // Each observation hook delegates to the real filesystem operation.
  let root, read, close, chmod;
  beforeEach(() => {
    read = vi.fn(readSync);
    close = vi.fn(closeSync);
    chmod = vi.fn(chmodSync);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'card-ledger-boundaries-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('ledger writer bounded-read wiring', () => {
    let descriptorRead, realStage;
    beforeEach(async () => {
      descriptorRead = vi.spyOn(fs, 'readSync');
      syncBuiltinESMExports();
      // Import after installing the observer: Vite can snapshot builtin named
      // exports, so synchronizing a module imported earlier is insufficient.
      vi.resetModules();
      ({ stageOnTransportBranch: realStage } = await import('../git-transport-branch.mjs'));
      descriptorRead.mockClear();
    });
    afterEach(() => {
      descriptorRead.mockRestore();
      syncBuiltinESMExports();
    });
    function writerTransport({ initial, retry, cap }) {
      const board = join(root, 'writer'), calls = [], stagedBytes = [], reads = [];
      const allocate = vi.fn(() => row().at), append = vi.fn();
      let text = initial, attempt = 0;
      mkdirSync(board);
      const run = (args, options) => {
        calls.push(args);
        if (args[0] === 'worktree' && args[1] === 'add') {
          const wt = args.at(-2);
          mkdirSync(join(wt, 'card-numbers'), { recursive: true });
          writeFileSync(join(wt, 'card-numbers/we.jsonl'), text);
        }
        if (args[0] === 'add') stagedBytes.push(readFileSync(join(options.cwd, args.at(-1)), 'utf8'));
        if (args[0] === 'push' && retry !== undefined) {
          text = retry;
          throw new Error('non-fast-forward');
        }
        return args[0] === 'ls-remote' ? 'tip' : args[0] === 'diff' ? 'card-numbers/we.jsonl' : '';
      };
      // Only Git is simulated. Keep the transport's default filesystem reader,
      // writer and cleanup, and forward the ledger writer's options unchanged.
      const stage = options => {
        const start = descriptorRead.mock.calls.length;
        try {
          return realStage({ ...options, run, now: () => ++attempt, log: () => {},
            files: options.files.map(file => ({ ...file, content: input => {
              append(input);
              return file.content(input);
            } })) });
        } finally {
          reads.push(descriptorRead.mock.calls.slice(start).map((args, i) => ({
            args, result: descriptorRead.mock.results[start + i],
          })));
        }
      };
      return { calls, stagedBytes, reads, allocate, append,
        assign: () => assignCardNumbers({ repo: 'we', board, ids: ['xabc123'], floor: 10, numericFiles: [],
          ledgerAuth: 'none', maxBytes: cap, lock, stage, now: allocate,
          readLedger: () => parseCardLedger('') }) };
    }
    function expectCapPlusOne(observations, cap) {
      expect(observations.length).toBeGreaterThan(0);
      let requested = 0, received = 0;
      for (const { args: [, buffer, offset, length, position], result } of observations) {
        expect(buffer.length).toBeLessThanOrEqual(cap + 1);
        expect(offset + length).toBeLessThanOrEqual(cap + 1);
        expect(position).toBeNull();
        expect(result.type).toBe('return');
        requested += length; received += result.value;
      }
      expect(requested).toBe(cap + 1); expect(received).toBe(cap + 1);
    }

    it('writerInitialReadUsesConfiguredCapPlusOneBeforeAllocationAppendOrPush', () => {
      const cap = 256, w = writerTransport({ initial: 'x'.repeat(4096), cap });
      let returned;
      expect(() => { returned = w.assign(); }).toThrow(/exceeds read cap.*raise readMaxBytes/);
      expect(w.reads).toHaveLength(1); expectCapPlusOne(w.reads[0], cap);
      expect(w.allocate).not.toHaveBeenCalled(); expect(w.append).not.toHaveBeenCalled();
      expect(w.stagedBytes).toEqual([]);
      expect(w.calls.filter(args => ['add', 'commit', 'push'].includes(args[0]))).toEqual([]);
      expect(returned).toBeUndefined();
    });

    it('writerOverflowingRetryReadsOnlyCapPlusOneAndNeverAllocatesAppendsOrPushesAgain', () => {
      const cap = 256, w = writerTransport({ initial: '', retry: 'x'.repeat(4096), cap });
      let returned;
      expect(() => { returned = w.assign(); }).toThrow(/exceeds read cap.*raise readMaxBytes/);
      expect(w.reads).toHaveLength(2); expectCapPlusOne(w.reads[1], cap);
      expect(w.allocate).toHaveBeenCalledTimes(1); expect(w.append).toHaveBeenCalledTimes(1);
      expect(w.stagedBytes).toHaveLength(1);
      expect(JSON.parse(w.stagedBytes[0])).toMatchObject({ id: 'xabc123', num: 11 });
      for (const command of ['add', 'commit', 'push']) {
        expect(w.calls.filter(args => args[0] === command)).toHaveLength(1);
      }
      expect(returned).toBeUndefined();
    });
  });

  describe('transport ledger symlink boundary', () => {
    function transport(prepare, content) {
      const board = join(root, 'board'), calls = [], stagedBytes = [];
      mkdirSync(board);
      const run = (args, options) => {
        calls.push(args);
        if (args[0] === 'add') stagedBytes.push(readFileSync(join(options.cwd, args.at(-1)), 'utf8'));
        if (args[0] === 'worktree' && args[1] === 'add') {
          const wt = args.at(-2);
          mkdirSync(wt, { recursive: true });
          prepare(wt);
        }
        return args[0] === 'ls-remote' ? 'tip' : args[0] === 'diff' ? 'card-numbers/we.jsonl' : '';
      };
      return { calls, stagedBytes, stage: () => stageOnTransportBranch({ board, branch: 'ops/card-numbers',
        allowRef: 'refs/heads/ops/card-numbers', readMaxBytes: 4096, run, now: () => 1, log: () => {},
        files: [{ path: 'card-numbers/we.jsonl', content }], message: 'fixture' }) };
    }

    it.each(['', lines(row())])('rejectsFetchedLedgerSymlinkBeforeReadingOrWritingExternalTarget (%j)', text => {
      const target = join(root, 'external'); writeFileSync(target, text);
      const content = vi.fn(({ existing }) => existing + lines(row('xdef456', 12)));
      const t = transport(wt => {
        mkdirSync(join(wt, 'card-numbers'));
        const path = join(wt, 'card-numbers/we.jsonl'); symlinkSync(target, path);
        expect(() => readBoundedTransportFile(path, 4096, { read })).toThrow();
        expect(read).not.toHaveBeenCalled();
      }, content);
      expect(t.stage).toThrow();
      expect(content).not.toHaveBeenCalled();
      expect(readFileSync(target, 'utf8')).toBe(text);
      expect(t.calls.filter(args => ['add', 'commit', 'push'].includes(args[0]))).toEqual([]);
    });

    it('rejectsFetchedLedgerDirectorySymlinkBeforeCreatingOrWritingExternalFiles', () => {
      const outside = join(root, 'external-directory'); mkdirSync(outside);
      const target = join(outside, 'we.jsonl'); writeFileSync(target, '');
      const content = vi.fn();
      const t = transport(wt => symlinkSync(outside, join(wt, 'card-numbers'), 'dir'), content);
      expect(t.stage).toThrow(/regular directory/);
      expect(content).not.toHaveBeenCalled(); expect(readFileSync(target, 'utf8')).toBe('');
      expect(t.calls.filter(args => ['add', 'commit', 'push'].includes(args[0]))).toEqual([]);
    });

    it('rejectsLedgerSymlinkSwappedAfterReadBeforeDescriptorWrite', () => {
      const target = join(root, 'external'); writeFileSync(target, 'outside bytes');
      let path;
      const t = transport(wt => {
        mkdirSync(join(wt, 'card-numbers')); path = join(wt, 'card-numbers/we.jsonl'); writeFileSync(path, '');
      }, ({ existing }) => {
        expect(existing).toBe(''); rmSync(path); symlinkSync(target, path); return lines(row());
      });
      expect(t.stage).toThrow(); expect(readFileSync(target, 'utf8')).toBe('outside bytes');
      expect(t.calls.filter(args => ['add', 'commit', 'push'].includes(args[0]))).toEqual([]);
    });

    it.each([null, lines(row())])('writesRegularAndNewLedgerFilesThroughDescriptors (%j)', initial => {
      const expected = (initial ?? '') + lines(row('xdef456', 12));
      const t = transport(wt => {
        mkdirSync(join(wt, 'card-numbers'));
        if (initial !== null) writeFileSync(join(wt, 'card-numbers/we.jsonl'), initial);
      }, ({ existing }) => {
        expect(existing).toBe(initial); return expected;
      });
      expect(t.stage()).toMatchObject({ pushed: true });
      expect(t.stagedBytes).toEqual([expected]);
      expect(t.calls.filter(args => args[0] === 'push')).toHaveLength(1);
    });
  });

  describe('transport filesystem byte boundary', () => {
    it('rejectsOversizedFilesystemLedgerAfterRequestingAndReadingOnlyCapPlusOneBytes', () => {
      const cap = 32, path = join(root, 'ledger.jsonl');
      let descriptorClosed = false;
      close.mockImplementation(fd => {
        closeSync(fd);
        // Observe immediately: assertion/reporting code may reopen this descriptor number.
        try { fstatSync(fd); } catch (e) {
          if (e.code !== 'EBADF') throw e;
          descriptorClosed = true;
        }
      });
      writeFileSync(path, 'x'.repeat(4096));
      expect(() => readBoundedTransportFile(path, cap, { read, close })).toThrow(/exceeds read cap/);
      expect(read).toHaveBeenCalled();
      let requested = 0, received = 0;
      for (const [index, args] of read.mock.calls.entries()) {
        const [, buffer, offset, length, position] = args;
        expect(buffer.length).toBeLessThanOrEqual(cap + 1);
        expect(offset + length).toBeLessThanOrEqual(cap + 1);
        expect(position).toBeNull();
        requested += length;
        expect(read.mock.results[index].type).toBe('return');
        received += read.mock.results[index].value;
      }
      expect(requested).toBe(cap + 1);
      expect(received).toBe(cap + 1);
      const fd = read.mock.calls[0][0];
      expect(close).toHaveBeenCalledWith(fd);
      expect(descriptorClosed).toBe(true);
    });

    it('acceptsFilesystemLedgerExactlyAtCapAndClosesItsDescriptor', () => {
      const path = join(root, 'ledger.jsonl'), text = 'x'.repeat(32);
      writeFileSync(path, text);
      expect(readBoundedTransportFile(path, 32, { read, close })).toBe(text);
      expect(read.mock.results.reduce((sum, result) => sum + result.value, 0)).toBe(32);
      expect(close).toHaveBeenCalledWith(read.mock.calls[0][0]);
    });
  });

  describe('signing private keys stay outside checkouts', () => {
    const env = { WE_CARD_LEDGER_AUTH: 'signed' };

    it('rejectsCheckoutKeyPathBeforeSshKeygenOrChmod', () => {
      const checkout = join(root, 'checkout');
      mkdirSync(checkout);
      // A linked worktree has a .git file rather than a directory.
      writeFileSync(join(checkout, '.git'), 'gitdir: elsewhere\n');
      const keyPath = join(checkout, 'missing', 'signing_key'), exec = vi.fn();
      expect(() => provisionCardLedgerSigningKey({ keyPath, env, exec, chmod })).toThrow(/outside every checkout/);
      expect(exec).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
      expect(existsSync(join(checkout, 'missing'))).toBe(false);
    });

    it('rejectsSymlinkedAncestorIntoCheckoutBeforeSshKeygenOrChmod', () => {
      const checkout = join(root, 'checkout'), link = join(root, 'outside-link');
      mkdirSync(join(checkout, '.git'), { recursive: true });
      symlinkSync(checkout, link, 'dir');
      const keyPath = join(link, 'missing', 'signing_key'), exec = vi.fn();
      expect(() => provisionCardLedgerSigningKey({ keyPath, env, exec, chmod })).toThrow(/outside every checkout/);
      expect(exec).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
      expect(existsSync(join(checkout, 'missing'))).toBe(false);
    });

    it('rejectsExistingKeySymlinkBeforeSshKeygenOrChmod', () => {
      const target = join(root, 'existing-key'), keyPath = join(root, 'signing_key');
      writeFileSync(target, 'private fixture material', { mode: 0o640 });
      symlinkSync(target, keyPath);
      const before = statSync(target).mode, exec = vi.fn();
      expect(() => provisionCardLedgerSigningKey({ keyPath, env, exec, chmod })).toThrow(/key symlink/);
      expect(exec).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
      expect(statSync(target).mode).toBe(before);
    });

    it('acceptsExistingRegularKeyOutsideCheckoutAndSetsPrivatePermissions', () => {
      const keyPath = join(root, 'signing_key');
      writeFileSync(keyPath, 'private fixture material', { mode: 0o640 });
      const exec = vi.fn((command, args) => args[0] === '-y' ? 'ssh-ed25519 AAAA fixture\n' : '256 SHA256:fixture fixture (ED25519)\n');
      expect(provisionCardLedgerSigningKey({ keyPath, env, exec, chmod })).toEqual({ key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:fixture' });
      expect(exec.mock.calls.every(([, args]) => !args.includes('-t'))).toBe(true);
      expect(chmod).toHaveBeenCalledTimes(1);
      expect(chmod).toHaveBeenCalledWith(keyPath, 0o600);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    });
  });

});
