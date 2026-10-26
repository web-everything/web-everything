import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allocateCardNumber, loadNumberAtBirthSettings, reserveCardNumber, reserveCollisionNumbers, readNumberingEvidence } from '../card-number-allocator.mjs';
import { tryAcquireNumberingLock } from '../../readiness/drain-lock.mjs';
import { numberPendingHashes } from '../../lane-drain.mjs';
import { planBaseCollisionHeal, applyCollisionHealToIndex, healNnnCollision } from '../nnn-collision-heal.mjs';
import { planRenumber } from '../../backlog/renumber-collisions.mjs';
import { gitBlobOid, gitRun } from '../git-run.mjs';
import { rebaseDropManifest } from '../rebase-drop-manifest.mjs';
import { acquireFixClaim } from '../../conveyor/fix-procedure.mjs';
import { fixDispatchClaimRoot } from '../../conveyor/fix-claim-store.mjs';

const io = vi.hoisted(() => ({ git: null }));
// Inject the subprocess boundary explicitly: builtin ESM mocks can leave the
// drain's captured execFileSync pointing at the real process runner.
const execFile = (cmd, args, opts) => {
  if (cmd !== 'git' || !io.git) throw Error(`unexpected subprocess ${cmd}`);
  return io.git(args, opts);
};
vi.mock('../proc-read.mjs', async (original) => {
  const actual = await original();
  return { ...actual, readGit: (args, opts) => io.git ? io.git(args, opts) : actual.readGit(args, opts) };
});

const roots = [];
const fixture = (id = 'xaaaaaa') => {
  const cwd = mkdtempSync(join(tmpdir(), 'card-number-')); roots.push(cwd);
  mkdirSync(join(cwd, 'backlog'));
  return { id, cwd, statePath: join(cwd, 'state', 'reservations.json'), lockRoot: join(cwd, 'locks'),
    settings: { value: { enabled: 'on', remote: 'best-effort' }, source: 'test tool' }, log: () => {} };
};
const offline = () => { throw new Error('offline'); };
// Shared remote, separate host state: mutations honor atomic create-only leases.
function remote() {
  const refs = new Map(); const blobs = new Map(); const calls = [];
  const git = (args, options = {}) => {
    calls.push(args);
    switch (args[0]) {
      case 'fetch': return '';
      case 'update-ref': return '';
      case 'ls-tree': return '';
      case 'ls-remote': return [...refs].map(([r, oid]) => `${oid}\t${r}\n`).join('');
      case 'hash-object': {
        const oid = createHash('sha1').update(options.input).digest('hex');
        blobs.set(oid, options.input); return oid + '\n';
      }
      case 'cat-file': if (!blobs.has(args[2])) throw Error('missing blob'); return blobs.get(args[2]);
      case 'push': {
        const claims = args.slice(args.indexOf('origin') + 1).map((s) => s.split(':'));
        if (claims.some(([, ref]) => refs.has(ref))) throw Error('already exists');
        claims.forEach(([oid, ref]) => refs.set(ref, oid)); return '';
      }
      default: throw Error(`unexpected git command ${args[0]}`);
    }
  };
  return { git, refs, blobs, calls };
}
afterEach(() => {
  io.git = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

it.each([true, false])('legacy numbering with births disabled skips an outstanding birth reservation (dryRun=%s)', (dryRun) => {
  const opts = fixture(); const r = remote();
  writeFileSync(join(opts.cwd, 'backlog/074-existing.md'), '---\n---\nExisting\n');
  expect(allocateCardNumber({ ...opts, git: r.git }).num).toBe('075');
  writeFileSync(join(opts.cwd, 'backlog/xbbbbbb-other.md'), '---\n---\nOther\n');
  mkdirSync(join(opts.cwd, '.claude/skills/batch-backlog-items'), { recursive: true });
  vi.stubEnv('WE_NUMBER_AT_BIRTH', 'off');
  vi.stubEnv('WE_JIT_READ_SOURCE', 'worktree');
  io.git = (args, extra) => {
    if (args[0] === 'remote') return 'origin\n';
    if (args[0] === 'ls-files') return args[1] === 'backlog/*.md'
      ? 'backlog/074-existing.md\nbacklog/xbbbbbb-other.md\n' : '';
    if (args[0] === 'grep') return '';
    if (args[0] === 'rm') { rmSync(join(opts.cwd, args.at(-1))); return ''; }
    if (['add', 'commit'].includes(args[0])) return '';
    return r.git(args, extra);
  };
  const result = numberPendingHashes(opts.cwd, { dryRun, execFile });
  expect(result.assigned).toEqual([{ hash: 'xbbbbbb', nnn: '076' }]);
  if (!dryRun) {
    expect(result.committed).toBe(true);
    expect(readFileSync(join(opts.cwd, 'backlog/076-other.md'), 'utf8')).toContain('bornAs: xbbbbbb');
    expect(r.refs.get('refs/card-ids/xbbbbbb')).toBe(r.refs.get('refs/number-reservations/076'));
  } else expect(r.refs.has('refs/card-ids/xbbbbbb')).toBe(false);
  expect(allocateCardNumber({ ...fixture(), git: r.git }).num).toBe('075');
});

it('legacy numbering holds cards when configured remote evidence is unavailable', () => {
  const opts = fixture();
  writeFileSync(join(opts.cwd, 'backlog/xbbbbbb-other.md'), '---\n---\nOther\n');
  vi.stubEnv('WE_JIT_READ_SOURCE', 'worktree');
  const calls = [];
  io.git = (args) => {
    calls.push(args);
    if (args[0] === 'remote') return 'origin\n';
    if (args[0] === 'ls-files') return args[1] === 'backlog/*.md' ? 'backlog/xbbbbbb-other.md\n' : '';
    if (args[0] === 'grep') return '';
    throw Error('offline');
  };
  expect(numberPendingHashes(opts.cwd, { execFile })).toMatchObject({ assigned: [], committed: false, error: expect.stringContaining('offline') });
  expect(calls.some((args) => ['push', 'hash-object', 'rm', 'add', 'commit'].includes(args[0]))).toBe(false);
  expect(readFileSync(join(opts.cwd, 'backlog/xbbbbbb-other.md'), 'utf8')).toBe('---\n---\nOther\n');
});

it.each([true, false])('refreshes canonical bornAs before deferred numbering (identical body=%s)', (identical) => {
  const opts = fixture(); const r = remote(); const calls = [];
  writeFileSync(join(opts.cwd, 'backlog/074-existing.md'), '---\n---\nExisting\n');
  writeFileSync(join(opts.cwd, 'backlog/xaaaaaa-same.md'), `---\nkind: task\n---\n${identical ? 'Same' : 'Edited'}\n`);
  vi.stubEnv('WE_NUMBER_AT_BIRTH', 'off');
  vi.stubEnv('WE_JIT_READ_SOURCE', 'worktree');
  let refreshed = false;
  io.git = (args, extra) => {
    calls.push(args);
    if (args[0] === 'remote') return 'origin\n';
    if (args[0] === 'ls-files') return args[1] === 'backlog/*.md'
      ? 'backlog/074-existing.md\nbacklog/xaaaaaa-same.md\n' : '';
    if (args[0] === 'fetch') {
      refreshed = args.includes('main:refs/remotes/origin/main');
      return '';
    }
    if (args[0] === 'ls-tree') return 'backlog/074-existing.md\0backlog/075-same.md\0';
    if (args[0] === 'grep') return refreshed && args.includes('^bornAs: x[0-9a-z]{6}$')
      ? 'origin/main:backlog/075-same.md:bornAs: xaaaaaa\n' : '';
    if (args[0] === 'show') return '---\nbornAs: xaaaaaa\n---\nSame\n';
    return r.git(args, extra);
  };
  const result = numberPendingHashes(opts.cwd, { dryRun: true, execFile });
  expect(result.assigned).toEqual([]);
  if (identical) expect(result.droppedDuplicates).toEqual([
    { hash: 'xaaaaaa', stem: 'xaaaaaa-same', existing: 'backlog/075-same.md' },
  ]);
  else expect(result.held).toContainEqual(expect.objectContaining({ hash: 'xaaaaaa', reason: expect.stringContaining('body differs') }));
  expect(calls.findIndex((args) => args[0] === 'fetch')).toBeLessThan(
    calls.findIndex((args) => args[0] === 'grep' && args.includes('^bornAs: x[0-9a-z]{6}$')));
  expect(calls.some((args) => ['push', 'hash-object', 'rm', 'add', 'commit'].includes(args[0]))).toBe(false);
});

it.each(['base', 'merged'])('%s collision planner refuses to move a bornAs identity', (kind) => {
  const birth = { name: '075-birth.md', text: '---\nbornAs: xaaaaaa\n---\nBirth\n', ordinal: 2 };
  const existing = { name: '075-other.md', text: '---\n---\nOther\n', ordinal: 1 };
  expect(() => kind === 'base'
    ? planBaseCollisionHeal([birth], { baseNums: ['075'], baseNames: [existing.name] })
    : planRenumber([existing, birth], { ontoNames: [existing.name] }))
    .toThrow(/birth|bornAs|immutable/i);
});

it.each(['base', 'merged'])('%s collision planner refuses a reserved source without bornAs', (kind) => {
  const incoming = { name: '075-incoming.md', text: '---\nkind: task\n---\nLegacy incoming\n', ordinal: 2 };
  const existing = { name: '075-existing.md', text: '---\n---\nExisting\n', ordinal: 1 };
  const before = structuredClone([existing, incoming]);
  // Leave a valid destination gap: the refusal must come from the source guard.
  const constraints = { reservedNums: ['075', '078'], ceiling: 78 };
  expect(() => kind === 'base'
    ? planBaseCollisionHeal([incoming], { baseNums: ['075'], baseNames: [existing.name], ...constraints })
    : planRenumber([existing, incoming], { ontoNames: [existing.name], ...constraints }))
    .toThrow(/immutable birth number/);
  expect([existing, incoming]).toEqual(before);
});

it.each(['base', 'merged'])('%s collision planner takes a number above the frontier and refuses an exhausted range', (kind) => {
  const files = [{ name: '074-incoming.md', text: '---\n---\nIncoming\n', ordinal: 2 }];
  const constraints = { reservedNums: ['075', '077'], ceiling: 77 };
  const plan = kind === 'base'
    ? planBaseCollisionHeal(files, { baseNums: ['074'], baseNames: ['074-existing.md'], ...constraints })
    : planRenumber([...files, { name: '074-existing.md', text: 'Existing\n', ordinal: 1 }],
      { ontoNames: ['074-existing.md'], ...constraints });
  expect(plan.collisions[0].newNum).toBe('078');
  for (const [refused, error] of [[{ reservedNums: ['99999'], ceiling: 99999 }, /exhausted/],
    [{ reservedNums: ['nan'], ceiling: 75 }, /invalid card number/]]) {
    expect(() => kind === 'base'
      ? planBaseCollisionHeal(files, { baseNums: ['074'], baseNames: ['074-existing.md'], ...refused })
      : planRenumber([...files, { name: '074-existing.md', text: 'Existing\n' }],
        { ontoNames: ['074-existing.md'], ...refused }))
      .toThrow(error);
  }
});

it.each(['base', 'merged'])('%s collision planner skips but never trusts a high unreserved lane number', (kind) => {
  // A stray lane file must not push the permanent shared claim to the top of the range.
  const files = [{ name: '074-incoming.md', text: '---\n---\nIncoming\n', ordinal: 2 },
    { name: '076-local.md', text: 'Local\n', ordinal: 1 }, { name: '99998-stray.md', text: 'Stray\n', ordinal: 1 }];
  const constraints = { reservedNums: ['075'], ceiling: 75 };
  const plan = kind === 'base'
    ? planBaseCollisionHeal(files, { baseNums: ['074'], baseNames: ['074-existing.md'], ...constraints })
    : planRenumber([...files, { name: '074-existing.md', text: 'Existing\n', ordinal: 1 }],
      { ontoNames: ['074-existing.md'], ...constraints });
  expect(plan.collisions.map((move) => move.newNum)).toEqual(['077']);
});

it.each(['base', 'merged'])('%s collision planner never reuses a deleted legacy number below the frontier', (kind) => {
  // 075 and 076 belonged to legacy cards deleted before reservation refs existed: no tree or ref
  // records them, so the remote-backed planner must take a fresh number above the frontier.
  const files = [{ name: '074-incoming.md', text: '---\n---\nIncoming\n', ordinal: 2 }];
  const constraints = { reservedNums: ['078'], canonicalNums: ['074', '077'], ceiling: 78 };
  const plan = kind === 'base'
    ? planBaseCollisionHeal(files, { baseNums: ['074'], baseNames: ['074-existing.md'], ...constraints })
    : planRenumber([...files, { name: '074-existing.md', text: 'Existing\n', ordinal: 1 }],
      { ontoNames: ['074-existing.md'], ...constraints });
  expect(plan.collisions.map((move) => move.newNum)).toEqual(['079']);
});

describe('atomic birth numbering', () => {
  it.each(['café', 'cafe\u0301', 'quote"', 'back\\slash', 'line\nbreak', 'carriage\rreturn',
    'line\u2028separator', 'invisible\u200b', '`backtick`', '--leading'])('counts canonical paths containing %s without Git quoting loss', (slug) => {
    const opts = fixture(); const r = remote();
    writeFileSync(join(opts.cwd, 'backlog/074-existing.md'), '');
    opts.settings.value.remote = 'required';
    const git = (args, extra) => args[0] === 'ls-tree'
      ? (args.includes('-z') ? `backlog/075-${slug}.md\0` : '"backlog/075-caf\\303\\251.md"\n')
      : r.git(args, extra);
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: true, num: '076' });
  });

  it.each(['best-effort', 'required'])('%s refuses numbers beyond the five-digit ID grammar', (mode) => {
    const opts = fixture(); const r = remote();
    opts.settings.value.remote = mode;
    writeFileSync(join(opts.cwd, 'backlog/99999-existing.md'), '');
    expect(allocateCardNumber({ ...opts, git: r.git })).toMatchObject({
      ok: false, required: mode === 'required', reason: expect.stringContaining('exhausted'),
    });
    expect(r.calls.filter((args) => args[0] === 'push')).toHaveLength(0);
  });

  it('replaying the same id on another host returns the same number through card-ids', () => {
    const r = remote(); const a = fixture(); const b = fixture();
    expect(allocateCardNumber({ ...a, git: r.git })).toMatchObject({ ok: true, num: '001' });
    expect(allocateCardNumber({ ...b, git: r.git })).toMatchObject({ ok: true, num: '001' });
    expect(r.refs.get('refs/card-ids/xaaaaaa')).toBe(r.refs.get('refs/number-reservations/001'));
    expect(r.calls.filter((a) => a[0] === 'push')).toHaveLength(1);
  });

  it('two ids get two numbers and each has a create-only card-ids mapping', () => {
    const r = remote();
    const a = allocateCardNumber({ ...fixture('xaaaaaa'), git: r.git });
    const b = allocateCardNumber({ ...fixture('xbbbbbb'), git: r.git });
    expect(a).toMatchObject({ ok: true, num: '001' });
    expect(b).toMatchObject({ ok: true, num: '002' });
    expect(r.refs.get('refs/card-ids/xaaaaaa')).toBe(r.refs.get('refs/number-reservations/001'));
    expect(r.refs.get('refs/card-ids/xbbbbbb')).toBe(r.refs.get('refs/number-reservations/002'));
    expect(r.refs.has('refs/card-ids/xbbbbbb')).toBe(true);
    for (const push of r.calls.filter((a) => a[0] === 'push')) {
      expect(push).toContain('--atomic');
      expect(push.filter((a) => a.startsWith('--force-with-lease=') && a.endsWith(':'))).toHaveLength(2);
    }
  });

  it('a losing same-id claim replays the winner instead of reserving another number', () => {
    const r = remote(); let raced = false;
    const git = (args, options) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        expect(allocateCardNumber({ ...fixture(), git: r.git }).ok).toBe(true);
      }
      return r.git(args, options);
    };
    expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({ ok: true, num: '001' });
    expect([...r.refs.keys()].filter((s) => s.startsWith('refs/number-reservations/'))).toHaveLength(1);
  });

  it('retries a confirmed number clash for a different id', () => {
    const r = remote(); let raced = false;
    const git = (args, options) => {
      if (args[0] === 'push' && !raced) {
        raced = true;
        expect(allocateCardNumber({ ...fixture('xbbbbbb'), git: r.git }).ok).toBe(true);
      }
      return r.git(args, options);
    };
    expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({ ok: true, num: '002' });
  });

  it.each(['local', 'main', 'host', 'remote'])('never reissues the highest number from %s', (plane) => {
    const opts = fixture(); const r = remote();
    if (plane === 'local') writeFileSync(join(opts.cwd, 'backlog/075-local.md'), '');
    if (plane === 'host') {
      mkdirSync(join(opts.cwd, 'state'));
      writeFileSync(opts.statePath, JSON.stringify({ highest: 75, reservations: [] }));
    }
    if (plane === 'remote') r.refs.set('refs/number-reservations/075', 'a'.repeat(40));
    const git = (args, extra) => args[0] === 'ls-tree' && plane === 'main' ? 'backlog/075-main.md\0' : r.git(args, extra);
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: true, num: '076' });
    expect(JSON.parse(readFileSync(opts.statePath, 'utf8')).highest).toBe(76);
  });

  it.each(['best-effort', 'required'])('%s fails closed on a held lock, unusable state directory or corrupt persisted state', (mode) => {
    const opts = fixture(); opts.settings.value.remote = mode;
    expect(tryAcquireNumberingLock(opts.lockRoot, 'test-holder').ok).toBe(true);
    const failure = { ok: false, required: mode === 'required' };
    expect(allocateCardNumber({ ...opts, git: remote().git, waitMs: 0 })).toMatchObject(failure);
    const other = fixture(); writeFileSync(join(other.cwd, 'state'), 'file');
    expect(allocateCardNumber({ ...other, settings: opts.settings, git: remote().git })).toMatchObject(failure);
    const corrupt = fixture(); mkdirSync(join(corrupt.cwd, 'state')); writeFileSync(corrupt.statePath, 'null');
    expect(allocateCardNumber({ ...corrupt, settings: opts.settings, git: remote().git })).toMatchObject(failure);
  });

  it.each(['best-effort', 'required'])('%s makes no reservation push when canonical main retrieval fails despite healthy transport', (mode) => {
    for (const failure of ['fetch', 'ls-tree', 'truncated-tree']) {
      const opts = fixture(); opts.settings.value.remote = mode;
      const r = remote();
      const git = (args, extra) => {
        if (args[0] === failure) throw Error('canonical main unavailable');
        if (args[0] === 'ls-tree') return failure === 'truncated-tree' ? 'backlog/075-existing.md' : 'backlog/075-existing.md\0';
        return r.git(args, extra);
      };
      // No local cards or remote refs cover the historical cards on canonical main.
      expect(allocateCardNumber({ ...opts, git })).toMatchObject({
        ok: false, required: mode === 'required', reason: expect.stringContaining('origin/main'),
      });
      expect(r.calls.filter((args) => args[0] === 'push')).toHaveLength(0);
      expect(r.refs.size).toBe(0);
    }
  });

  it.each(['best-effort', 'required'])('%s fails closed on offline or unconfirmed push outage', (mode) => {
    const opts = fixture(); opts.settings.value.remote = mode;
    expect(allocateCardNumber({ ...opts, git: offline })).toMatchObject({ ok: false, required: mode === 'required' });
    const r = remote();
    const git = (args, extra) => { if (args[0] === 'push') throw Error('permission denied'); return r.git(args, extra); };
    expect(allocateCardNumber({ ...opts, git })).toMatchObject({ ok: false, required: mode === 'required' });
    expect(r.refs.size).toBe(0);
  });

  it.each(['', '001', 'xabc', 'Xaaaaaa', 'xaaaaaa/evil', 'xaaaaaa\n', null])('rejects invalid HASH_RE id %j before Git', (id) => {
    expect(allocateCardNumber({ ...fixture(), id, git: () => { throw Error('must not call Git'); } }))
      .toMatchObject({ ok: false, reason: 'invalid card id: expected HASH_RE' });
  });

  it.each(['abc\trefs/number-reservations/001\n', `${'a'.repeat(40)}\trefs/number-reservations/001`, 'garbage\n'])
    ('rejects short, truncated or malformed remote listing %j', (listing) => {
      const r = remote();
      const git = (args, extra) => args[0] === 'ls-remote' ? listing : r.git(args, extra);
      expect(allocateCardNumber({ ...fixture(), git }).ok).toBe(false);
      expect(r.refs.size).toBe(0);
    });

  it.each(['truncated', 'oversized', 'wrong-id', 'wrong-number-ref', 'extra-key', 'bad-time', 'unreadable'])
    ('rejects %s mapping evidence', (kind) => {
      const r = remote(); expect(allocateCardNumber({ ...fixture(), git: r.git }).ok).toBe(true);
      const oid = r.refs.get('refs/card-ids/xaaaaaa'); const raw = r.blobs.get(oid); const claim = JSON.parse(raw);
      if (kind === 'truncated') r.blobs.set(oid, raw.slice(0, -1));
      if (kind === 'oversized') r.blobs.set(oid, ' '.repeat(4097) + raw);
      if (kind === 'wrong-id') r.blobs.set(oid, JSON.stringify({ ...claim, id: 'xbbbbbb' }) + '\n');
      if (kind === 'wrong-number-ref') r.refs.set('refs/number-reservations/001', 'b'.repeat(40));
      if (kind === 'extra-key') r.blobs.set(oid, JSON.stringify({ ...claim, extra: true }) + '\n');
      if (kind === 'bad-time') r.blobs.set(oid, JSON.stringify({ ...claim, timestamp: 'bad' }) + '\n');
      if (kind === 'unreadable') r.blobs.delete(oid);
      expect(allocateCardNumber({ ...fixture(), git: r.git }).ok).toBe(false);
    });

  it('bounds contention and preserves existing immutable refs', () => {
    const r = remote(); let pushes = 0;
    const git = (args, extra) => {
      if (args[0] === 'push') {
        const ref = args.at(-2).split(':')[1]; r.refs.set(ref, 'a'.repeat(40)); pushes++; throw Error('clash');
      }
      return r.git(args, extra);
    };
    expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({ ok: false, reason: 'remote reservation contention exhausted' });
    expect(pushes).toBe(100);
  });

  it('off avoids all IO', () => {
    const settings = loadNumberAtBirthSettings({ file: {}, env: { WE_NUMBER_AT_BIRTH: 'off' }, platform: {} });
    expect(allocateCardNumber({ ...fixture(), settings, git: offline })).toMatchObject({ ok: false, reason: 'number-at-birth disabled' });
  });
});

it('settings resolve standard -> platform -> tool -> env with independent provenance', () => {
  const platform = { cardNumbering: { numberAtBirth: { enabled: 'off' }, remote: 'required' } };
  const file = { backlog: { cardNumbering: { numberAtBirth: { enabled: 'on' } } } };
  expect(loadNumberAtBirthSettings({ file: {}, env: {}, platform: {} }).sources).toEqual({ enabled: 'standard', remote: 'standard' });
  const settings = loadNumberAtBirthSettings({ file, env: {}, platform });
  expect(settings.value).toEqual({ enabled: 'on', remote: 'required' });
  expect(settings.sources).toEqual({ enabled: 'tool', remote: 'platform' });
  expect(settings.source).toContain('remote="required" (platform)');
  expect(loadNumberAtBirthSettings({ file, platform, env: { WE_NUMBER_AT_BIRTH: 'off', WE_CARD_NUMBERING_REMOTE: 'best-effort' } }).sources)
    .toEqual({ enabled: 'env', remote: 'env' });
});

it.each(['on', 'off'])('logs each effective setting and its independent provenance when enabled=%s', (enabled) => {
  const settings = loadNumberAtBirthSettings({
    platform: { cardNumbering: { remote: 'required' } },
    file: { backlog: { cardNumbering: { numberAtBirth: { enabled } } } }, env: {},
  });
  const log = vi.fn();
  allocateCardNumber({ ...fixture(), settings, log, git: remote().git });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toContain('backlog.cardNumbering:');
  expect(log.mock.calls[0][0]).toContain(`enabled="${enabled}" (tool)`);
  expect(log.mock.calls[0][0]).toContain('remote="required" (platform)');
});

it('declares namespaced settings without duplicate ownership', async () => {
  const { readDeclaredSettings } = await import('../settings-files.mjs');
  const settings = readDeclaredSettings();
  expect(settings.errors).toEqual([]); expect(settings.duplicates).toEqual([]);
  expect(settings.owners['backlog.cardNumbering.numberAtBirth.enabled']).toBe('settings/number-at-birth.json');
  expect(settings.owners['backlog.cardNumbering.remote']).toBe('settings/number-at-birth.json');
});

it('prunes old and landed entries without lowering the high-water mark', () => {
  const opts = fixture(); mkdirSync(join(opts.cwd, 'state'));
  writeFileSync(opts.statePath, JSON.stringify({ highest: 90, reservations: [
    { num: 90, timestamp: '2000-01-01T00:00:00Z' },
    { num: 20, timestamp: new Date().toISOString() },
  ] }));
  const r = remote();
  const git = (args, extra) => args[0] === 'ls-tree' ? 'backlog/020-landed.md\0' : r.git(args, extra);
  expect(allocateCardNumber({ ...opts, git }).num).toBe('091');
  expect(JSON.parse(readFileSync(opts.statePath, 'utf8')).reservations.map((e) => e.num)).toEqual([91]);
  expect(allocateCardNumber({ ...opts, id: 'xbbbbbb', git }).num).toBe('092');
});

it('oversized ref evidence fails closed with an explicit hash-fallback result', () => {
  const r = remote();
  const git = (args, extra) => args[0] === 'ls-remote' ? ' '.repeat(32 * 1024 * 1024 + 1) : r.git(args, extra);
  expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({ ok: false, required: false, reason: 'oversized remote ref listing' });
  expect(r.refs.size).toBe(0);
});

it.each([8500, 99998])('allocates and replays after %s permanent birth reservations, including retry scans', (count) => {
  const r = remote();
  const paths = Array.from({ length: count }, (_, i) => `backlog/${String(i + 1).padStart(3, '0')}-card.md\0`).join('');
  for (let n = 1; n <= count; n++) {
    const num = String(n).padStart(3, '0');
    const id = `x${n.toString(36).padStart(6, '0')}`;
    const claim = JSON.stringify({ id, num, owner: 'fixture', timestamp: '2026-10-01T00:00:00Z' }) + '\n';
    const oid = createHash('sha256').update(claim).digest('hex');
    r.blobs.set(oid, claim);
    r.refs.set(`refs/number-reservations/${num}`, oid);
    r.refs.set(`refs/card-ids/${id}`, oid);
  }
  let lostResponse = false;
  const git = (args, options) => {
    const output = args[0] === 'ls-tree' ? paths : r.git(args, options);
    if (args[0] === 'ls-tree' && Buffer.byteLength(output) > (options?.maxBuffer ?? 1024 * 1024)) throw Error('ENOBUFS');
    if (args[0] === 'ls-remote') {
      expect(Buffer.byteLength(output)).toBeGreaterThan(1024 * 1024);
      // Exercise the same output cap as the production subprocess, including retry scans.
      if (Buffer.byteLength(output) > (options?.maxBuffer ?? 1024 * 1024)) throw Error('ENOBUFS');
    }
    if (args[0] === 'push' && !lostResponse) { lostResponse = true; throw Error('lost push response'); }
    return output;
  };
  const expected = String(count + 1);
  expect(reserveCardNumber({ id: 'xaaaaaa', git })).toBe(expected);
  expect(reserveCardNumber({ id: 'xaaaaaa', git })).toBe(expected);
  expect(r.calls.filter((args) => args[0] === 'push')).toHaveLength(1);
});

it('the shared collision subprocess runner honors the numbering listing buffer', () => {
  const size = 2 * 1024 * 1024;
  const result = gitRun(process.execPath, ['-e', `process.stdout.write('a'.repeat(${size}))`], {
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.length).toBe(size);
});

it('collision evidence fetched during a rebuild cannot pair an old tree with a newer main parent', () => {
  vi.stubEnv('WE_COORDINATION_ROOT', join(fixture().cwd, 'coordination'));
  let trackingMain = 'A'; let fetchedMain = 'A'; let mergedNotes; let committed;
  const run = (cmd, args, options = {}) => {
    let stdout = '';
    if (args[0] === 'fetch') {
      fetchedMain = 'B';
      // Git updates tracking refs for explicit destinations AND its configured refmap.
      if (args.some((arg) => arg.includes(':refs/remotes/')) || !args.includes('--refmap=')) trackingMain = 'B';
    } else if (args[0] === 'merge-tree') { mergedNotes = trackingMain; stdout = 'merged-tree\n'; }
    else if (args[0] === 'remote') stdout = 'origin\n';
    else if (args[0] === 'ls-tree' && args.includes('backlog/')) {
      stdout = args.includes('merged-tree')
        ? 'backlog/074-existing.md\0backlog/077-latest.md\0backlog/074-incoming.md\0'
        : 'backlog/074-existing.md\0backlog/077-latest.md\0';
    } else if (args[0] === 'cat-file') stdout = '---\nkind: task\n---\nLegacy card\n';
    else if (args[0] === 'hash-object') stdout = gitBlobOid(options.input) + '\n';
    else if (args[0] === 'write-tree') stdout = 'healed-tree\n';
    else if (args[0] === 'commit-tree') {
      committed = { parentNotes: trackingMain, treeNotes: mergedNotes };
      stdout = 'new-commit\n';
    }
    return { status: 0, stdout, stderr: '' };
  };
  const result = rebaseDropManifest({ laneRef: 'lane/test', fetch: false, healCollision: true, run });
  expect(result.action).toBe('rebased');
  expect(result.healed).toMatchObject([{ oldNum: '074', newNum: '078' }]);
  expect(fetchedMain).toBe('B');
  expect(committed).toEqual({ parentNotes: 'A', treeNotes: 'A' });
});

it.each(['origin', 'upstream'])('reads fresh %s numbering evidence without advancing its tracking main', (remoteName) => {
  let fetchedRef;
  const git = (args) => {
    if (args[0] === 'fetch') {
      expect(args).toEqual(['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', remoteName,
        expect.stringMatching(/^refs\/heads\/main:refs\/tmp\/numbering-/)]);
      fetchedRef = args.at(-1).split(':')[1];
      return '';
    }
    if (args[0] === 'ls-tree') {
      expect(fetchedRef).toBeTruthy();
      return args.includes(fetchedRef) ? 'backlog/078-newest.md\0' : 'backlog/074-stale.md\0';
    }
    if (args[0] === 'update-ref') { expect(args).toEqual(['update-ref', '-d', fetchedRef]); return ''; }
    if (args[0] === 'ls-remote') { expect(args[1]).toBe(remoteName); return ''; }
    throw Error(`unexpected command ${args[0]}`);
  };
  expect(readNumberingEvidence(git, remoteName).main).toEqual([78]);
});

it.each([false, true])('two interleaved evidence reads retain their own canonical tree (refreshTracking=%s)', (refreshTracking) => {
  const trees = new Map(); const deleted = []; const destinations = [];
  let nested; let fetchCount = 0;
  const git = (args) => {
    if (args[0] === 'fetch') {
      const num = ++fetchCount === 1 ? 78 : 91;
      // Model Git's shared FETCH_HEAD and explicit destinations. The second call
      // completes after the first fetch, before the first caller reads its tree.
      trees.set('FETCH_HEAD', num);
      for (const spec of args.filter((arg) => arg.includes(':refs/'))) {
        const ref = spec.split(':')[1]; trees.set(ref, num); destinations.push(ref);
      }
      if (fetchCount === 1) nested = readNumberingEvidence(git, 'origin', { refreshTracking });
      return '';
    }
    if (args[0] === 'ls-tree') {
      const ref = args[args.indexOf('--') - 1].replace(/^origin\//, 'refs/remotes/origin/');
      if (!trees.has(ref)) throw Error(`missing tree ${ref}`);
      return `backlog/${trees.get(ref)}-canonical.md\0`;
    }
    if (args[0] === 'update-ref') { deleted.push(args[2]); trees.delete(args[2]); return ''; }
    if (args[0] === 'ls-remote') return '';
    throw Error(`unexpected command ${args[0]}`);
  };
  expect(readNumberingEvidence(git, 'origin', { refreshTracking }).main).toEqual([78]);
  expect(nested.main).toEqual([91]);
  const privateRefs = destinations.filter((ref) => ref.startsWith('refs/tmp/numbering-'));
  expect(new Set(privateRefs).size).toBe(2);
  expect(deleted.sort()).toEqual(privateRefs.sort());
  expect([...trees.keys()].some((ref) => ref.startsWith('refs/tmp/numbering-'))).toBe(false);
});

it.each(['fetch', 'ls-tree', 'truncated-tree', 'ls-remote'])('cleans up private evidence refs after %s failure', (failure) => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === failure) throw Error('injected evidence failure');
    if (args[0] === 'ls-tree') return failure === 'truncated-tree' ? 'backlog/078-truncated.md' : 'backlog/078-existing.md\0';
    return '';
  };
  expect(() => readNumberingEvidence(git)).toThrow();
  const ref = calls.find(([cmd]) => cmd === 'fetch').find((arg) => arg.startsWith('refs/heads/main:'))?.split(':')[1];
  expect(ref).toMatch(/^refs\/tmp\/numbering-/);
  expect(calls).toContainEqual(['update-ref', '-d', ref]);
});

it('refuses allocation when private evidence ref cleanup fails', () => {
  const r = remote();
  const git = (args, options) => {
    if (args[0] === 'update-ref') throw Error('cleanup failed');
    return r.git(args, options);
  };
  expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({
    ok: false, reason: expect.stringContaining('cleanup failed'),
  });
  expect(r.calls.some(([command]) => command === 'push')).toBe(false);
});

it('a held fix claim stops collision constraints and reservations before any reservation push', () => {
  vi.stubEnv('WE_COORDINATION_ROOT', join(fixture().cwd, 'coordination'));
  vi.stubEnv('WE_FIX_WHO', 'healer');
  vi.stubEnv('WE_FIX_TOKEN', '');
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'healer-session');
  expect(acquireFixClaim({ repo: 'we', pr: 5958, who: 'other-fixer', branch: 'lane/test',
    lockRoot: fixDispatchClaimRoot() }).ok).toBe(true);
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    if (args[0] === 'ls-tree') return { status: 0, stdout: args.includes('origin/main')
      ? 'backlog/074-existing.md\0' : 'backlog/074-incoming.md\0' };
    if (args.join(' ') === 'remote get-url origin') return { status: 0, stdout: 'git@github.com:web-everything/web-everything.git\n' };
    throw Error(`unexpected command after held claim: ${args.join(' ')}`);
  };
  expect(healNnnCollision({ laneRef: 'lane/test', fetch: false, run })).toMatchObject({
    action: 'error', reason: expect.stringContaining('other-fixer holds the fix claim'),
  });
  expect(calls.map(([command]) => command)).toEqual(['ls-tree', 'ls-tree', 'remote']);
  expect(calls).not.toContainEqual(['remote']); // collisionNumberingConstraints entry
  expect(calls.some(([command]) => ['fetch', 'ls-remote', 'hash-object', 'push'].includes(command))).toBe(false);
});

it.each(['rewrite', 'publish'])('collision reservations survive a failed %s and cannot be reused', (failure) => {
  vi.stubEnv('WE_COORDINATION_ROOT', join(fixture().cwd, 'coordination'));
  const r = remote(); const calls = [];
  const run = (cmd, args, options) => {
    calls.push(args);
    let stdout = '';
    if (args[0] === 'remote') stdout = args.length === 1 ? 'origin\n' : 'git@github.com:web-everything/web-everything.git\n';
    else if (args[0] === 'ls-tree') stdout = args.includes('origin/lane/test')
      ? 'backlog/074-incoming.md\0' : 'backlog/074-existing.md\0backlog/077-latest.md\0';
    else if (args[0] === 'cat-file') stdout = '---\n---\nIncoming\n';
    else if (args[0] === 'hash-object') stdout = gitBlobOid(options.input) + '\n';
    else if (args[0] === 'update-index' && failure === 'rewrite') return { status: 1, stderr: 'injected rewrite failure' };
    else if (args[0] === 'push' && args.some((arg) => arg.includes(':refs/heads/'))) return { status: 1, stderr: 'injected publish failure' };
    else if (args[0] === 'write-tree') stdout = 'healed-tree\n';
    else if (args[0] === 'commit-tree') stdout = 'healed-commit\n';
    else if (!['read-tree', 'update-index', 'rm'].includes(args[0])) stdout = r.git(args, options);
    return { status: 0, stdout, stderr: '' };
  };
  expect(healNnnCollision({ laneRef: 'lane/test', fetch: false, run })).toMatchObject({
    action: 'error', reason: expect.stringContaining(`injected ${failure} failure`),
  });
  const claims = new Map(r.refs);
  expect(claims.get('refs/number-reservations/078')).toMatch(/^[a-f0-9]{40}$/);
  expect(calls.filter(([command]) => command === 'push')).toHaveLength(failure === 'publish' ? 2 : 1);
  expect(() => reserveCollisionNumbers({ collisions: [{ newNum: '078' }] }, r.git, 'origin')).toThrow('already exists');
  expect(r.refs).toEqual(claims);
  expect(reserveCardNumber({ id: 'xbbbbbb', minimum: 76, git: r.git })).toBe('079');
  expect(r.refs.get('refs/number-reservations/078')).toBe(claims.get('refs/number-reservations/078'));
});

it('deferred numbering atomically reserves and replays even when birth numbering is disabled', () => {
  const r = remote();
  vi.stubEnv('WE_NUMBER_AT_BIRTH', 'off');
  expect(reserveCardNumber({ id: 'xaaaaaa', git: r.git, minimum: 75 })).toBe('075');
  expect(reserveCardNumber({ id: 'xbbbbbb', git: r.git, minimum: 75 })).toBe('076');
  expect(reserveCardNumber({ id: 'xaaaaaa', git: r.git, minimum: 77 })).toBe('075');
  expect(r.refs.get('refs/card-ids/xbbbbbb')).toBe(r.refs.get('refs/number-reservations/076'));
});

it('collision targets use atomic create-only claims and a stale plan loses to a birth', () => {
  const r = remote();
  const plan = { collisions: [{ newNum: '075' }, { newNum: '076' }] };
  expect(reserveCardNumber({ id: 'xaaaaaa', git: r.git, minimum: 75 })).toBe('075');
  expect(() => reserveCollisionNumbers(plan, r.git, 'origin')).toThrow('already exists');
  expect(r.refs.has('refs/number-reservations/076')).toBe(false);
  reserveCollisionNumbers({ collisions: [{ newNum: '076' }] }, r.git, 'origin');
  expect(reserveCardNumber({ id: 'xbbbbbb', git: r.git, minimum: 75 })).toBe('077');
  expect(reserveCardNumber({ id: 'xaaaaaa', git: r.git })).toBe('075');
});

it.each(['index', 'standalone'])('%s collision wiring refuses unreadable reservations before any index write', (mode) => {
  vi.stubEnv('WE_COORDINATION_ROOT', join(fixture().cwd, 'coordination'));
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    let stdout = '';
    if (args[0] === 'remote') stdout = 'origin\n';
    if (args[0] === 'ls-tree') stdout = args.includes('origin/main') || args.some((arg) => arg.startsWith('refs/tmp/numbering-'))
      ? 'backlog/074-existing.md\0backlog/077-latest.md\0' : 'backlog/074-incoming.md\0';
    if (args[0] === 'cat-file') stdout = '---\n---\nIncoming\n';
    if (args[0] === 'ls-remote') return { status: 1, stdout: '', stderr: 'offline' };
    return { status: 0, stdout, stderr: '' };
  };
  const result = mode === 'index' ? applyCollisionHealToIndex({ run, env: {}, tree: 'lane/test', cwd: '/fixture' })
    : healNnnCollision({ run, laneRef: 'lane/test', fetch: false });
  expect(result.reason).toMatch(/reservation/);
  expect(calls.some((args) => ['hash-object', 'update-index', 'read-tree', 'push'].includes(args[0]))).toBe(false);
});

it.each(['index', 'standalone'])('%s collision wiring claims a fresh target above the frontier before rewriting', (mode) => {
  vi.stubEnv('WE_COORDINATION_ROOT', join(fixture().cwd, 'coordination'));
  const r = remote(); const calls = [];
  r.refs.set('refs/number-reservations/076', 'a'.repeat(40));
  const run = (cmd, args, options) => {
    calls.push(args);
    let stdout;
    if (args[0] === 'remote') stdout = 'origin\n';
    else if (args[0] === 'ls-tree') stdout = args.includes('origin/main') || args.some((arg) => arg.startsWith('refs/tmp/numbering-'))
      ? 'backlog/074-existing.md\0backlog/077-latest.md\0' : 'backlog/074-incoming.md\0';
    else if (args[0] === 'cat-file') stdout = '---\n---\nIncoming\n';
    else if (args[0] === 'hash-object') stdout = gitBlobOid(options.input) + '\n';
    // Stop at the first index mutation; the claim must already be durable.
    else if (['read-tree', 'update-index'].includes(args[0])) {
      expect(r.refs.has('refs/number-reservations/078')).toBe(true);
      return { status: 1, stdout: '', stderr: 'stop after claim' };
    } else stdout = r.git(args, options);
    return { status: 0, stdout, stderr: '' };
  };
  const result = mode === 'index' ? applyCollisionHealToIndex({ run, env: {}, tree: 'lane/test' })
    : healNnnCollision({ run, laneRef: 'lane/test', fetch: false });
  expect(result.reason).toMatch(/stop after claim/);
  // 075 is an untraced gap below the frontier: it may be a deleted legacy card, so it is never claimed.
  expect(calls.find((args) => args[0] === 'push')).toContain('--force-with-lease=refs/number-reservations/078:');
  expect(r.refs.has('refs/number-reservations/075')).toBe(false);
});

it('bounds overflow after a last-number contention and refuses out-of-grammar reservation refs', () => {
  const r = remote();
  const git = (args, options) => {
    if (args[0] === 'push') {
      r.refs.set('refs/number-reservations/99999', 'a'.repeat(40));
      throw Error('clash');
    }
    return r.git(args, options);
  };
  expect(() => reserveCardNumber({ id: 'xaaaaaa', git, minimum: 99999 })).toThrow('exhausted');
  r.refs.set('refs/number-reservations/100000', 'b'.repeat(40));
  expect(() => reserveCardNumber({ id: 'xbbbbbb', git: r.git })).toThrow('invalid reservation number');
});

it('local filenames containing a newline retain their complete numeric prefix', () => {
  const opts = fixture(); const r = remote();
  writeFileSync(join(opts.cwd, 'backlog/075-line\nbreak.md'), '');
  expect(allocateCardNumber({ ...opts, git: r.git })).toMatchObject({ ok: true, num: '076' });
});

it('allows the last supported number and rejects oversized canonical tree evidence', () => {
  const opts = fixture(); const r = remote();
  writeFileSync(join(opts.cwd, 'backlog/99998-existing.md'), '');
  expect(allocateCardNumber({ ...opts, git: r.git })).toMatchObject({ ok: true, num: '99999' });
  const other = remote();
  const git = (args, options) => args[0] === 'ls-tree' ? 'a'.repeat(32 * 1024 * 1024 + 1) + '\0' : other.git(args, options);
  expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({ ok: false,
    reason: expect.stringContaining('oversized backlog tree') });
  expect(other.refs.size).toBe(0);
});
