import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { allocateCardNumber, loadNumberAtBirthSettings } from '../card-number-allocator.mjs';
import { tryAcquireNumberingLock } from '../../readiness/drain-lock.mjs';

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
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

describe('atomic birth numbering', () => {
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
    const git = (args, extra) => args[0] === 'ls-tree' && plane === 'main' ? 'backlog/075-main.md\n' : r.git(args, extra);
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
        if (args[0] === 'ls-tree') return failure === 'truncated-tree' ? 'backlog/075-existing.md' : 'backlog/075-existing.md\n';
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
  const git = (args, extra) => args[0] === 'ls-tree' ? 'backlog/020-landed.md\n' : r.git(args, extra);
  expect(allocateCardNumber({ ...opts, git }).num).toBe('091');
  expect(JSON.parse(readFileSync(opts.statePath, 'utf8')).reservations.map((e) => e.num)).toEqual([91]);
  expect(allocateCardNumber({ ...opts, id: 'xbbbbbb', git }).num).toBe('092');
});

it('oversized ref evidence fails closed with an explicit hash-fallback result', () => {
  const r = remote();
  const git = (args, extra) => args[0] === 'ls-remote' ? ' '.repeat(1024 * 1024 + 1) : r.git(args, extra);
  expect(allocateCardNumber({ ...fixture(), git })).toMatchObject({ ok: false, required: false, reason: 'oversized remote ref listing' });
  expect(r.refs.size).toBe(0);
});
