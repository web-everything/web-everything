import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { createBuildPrioritySet, readPriorityCards, readPriorityPrs } from '../build-priority-set-io.mjs';
import { resolveOperation } from '../run.mjs';
import { hasJsonFlag, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry } from '../registry.mjs';
import { decideRuntimeAdmission, readBuildPrioritySettings } from '../../lib/build-queue.mjs';

const dirs = [];
const at = '2026-11-20T12:00:00.000Z';
const flags = ['--ids=42,43', '--mode=only', '--ttl-hours=2', '--actor=operator', '--reason=priority call'];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(join(process.env.TMPDIR, 'build-priority-set-')); dirs.push(dir);
  const path = join(dir, 'build-priority.runtime.json');
  const readCard = vi.fn(() => ({ scope: ['we:scripts/a.mjs scripts/a.test.mjs'] }));
  const readPrs = vi.fn(() => []);
  const options = { env: { WE_BUILD_PRIORITY_RUNTIME_FILE: path }, readCard, readPrs, now: () => new Date(at), ...overrides };
  const command = async (argv = flags) => {
    const operation = createBuildPrioritySet(options);
    const registry = createRegistry(); registry.register(operation.declaration);
    const outcome = await runOperationCli({ ...operation, registry, argv,
      store: createMemoryRunStore(), newRunId: () => 'priority-test' });
    return { ...outcome, ...operation.finish({ ...outcome, json: hasJsonFlag(argv) }) };
  };
  return { dir, path, options, command, readCard, readPrs };
}
const changed = (flag, value) => [...flags.filter(s => !s.startsWith(`--${flag}=`)), ...(value === undefined ? [] : [`--${flag}=${value}`])];
function untouched(f, names = []) { expect(fs.readdirSync(f.dir).sort()).toEqual(names.sort()); }

it('runtime list install validates and writes atomically with mode 0600 and exact reader fields', async () => {
  const f = fixture();
  fs.writeFileSync(f.path, 'old');
  const inode = fs.statSync(f.path).ino;
  const fsync = vi.fn(fd => fs.fsyncSync(fd));
  f.options.fsync = fsync;
  const rename = vi.fn((src, dest) => {
    expect(fsync).toHaveBeenCalledOnce();
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
    expect(fs.statSync(src).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8')).phase).toBe('install-attempt');
    fs.renameSync(src, dest);
  });
  f.options.rename = rename;
  expect((await f.command()).code).toBe(0);
  expect(rename).toHaveBeenCalledOnce();
  expect(fs.statSync(f.path).ino).not.toBe(inode);
  expect(fs.statSync(f.path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toEqual({ ids: ['42', '43'], mode: 'only', setBy: 'operator', at, ttlHours: 2 });
  expect(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8')).toBe(`${JSON.stringify({ actor: 'operator', reason: 'priority call', ids: ['42', '43'], mode: 'only', ttlHours: 2, at, phase: 'install-attempt' })}\n`);
  untouched(f, ['build-priority.runtime.json', 'build-priority.audit.jsonl']);
});

it('round-trips the installed list through readBuildPrioritySettings', async () => {
  const f = fixture();
  expect((await f.command()).code).toBe(0);
  expect(readBuildPrioritySettings({ runtimePath: f.path, env: {}, now: Date.parse(at) })).toMatchObject({
    ids: ['42', '43'], source: 'runtime', mode: 'only', only: true, runtime: { expired: false, setBy: 'operator' },
  });
});

it.each(['only', 'lift'])('refuses padded IDs before installation or preview in %s mode', async mode => {
  for (const ids of ['042', '00042', '00', '42,043', '42,042', ' 042 ']) {
    for (const preview of [false, true]) {
      const f = fixture();
      const previous = JSON.stringify({ ids: ['42'], mode: 'only', setBy: 'operator', at, ttlHours: 2 });
      fs.writeFileSync(f.path, previous);
      const result = await f.command([
        ...flags.filter(s => !s.startsWith('--ids=') && !s.startsWith('--mode=')),
        `--ids=${ids}`, `--mode=${mode}`, ...(preview ? ['--preview'] : []),
      ]);
      expect(result.code).not.toBe(0);
      expect(result.lines.join('\n')).toContain('without leading zeroes');
      expect(f.readCard).not.toHaveBeenCalled();
      expect(f.readPrs).not.toHaveBeenCalled();
      expect(fs.readFileSync(f.path, 'utf8')).toBe(previous);
      untouched(f, ['build-priority.runtime.json']);
    }
  }
});

it('keeps a canonical installed card admitted when intersecting the environment priority', async () => {
  const f = fixture();
  expect((await f.command(changed('ids', ' 42 '))).code).toBe(0);
  const settings = readBuildPrioritySettings({ runtimePath: f.path,
    env: { WE_BUILD_PRIORITY: '42' }, now: Date.parse(at) });
  expect(settings.ids).toEqual(['42']);
  expect(decideRuntimeAdmission({ num: 42 }, 'build', settings).admitted).toBe(true);
});

it('registers the operation in run.mjs', () => { expect(resolveOperation('build-priority-set').declaration.name).toBe('build-priority-set'); });

it.each([
  ['we', 'web-everything/web-everything'],
  ['webeverything', 'web-everything/web-everything'],
  ['fui', 'frontier-ui/frontierui'],
  ['frontierui', 'frontier-ui/frontierui'],
  ['FUI', 'frontier-ui/frontierui'],
  ['plateau-app', 'plateauapp/plateau-app'],
  ['plateau', 'plateauapp/plateau-app'],
  ['pa', 'plateauapp/plateau-app'],
])('refuses exact and directory overlaps for %s scopes in preview and install', async (prefix, repo) => {
  for (const scope of ['scripts/a.mjs', 'scripts/']) {
    for (const preview of [false, true]) {
      const f = fixture({ readCard: () => ({ scope: [`${prefix}:${scope}`] }),
        readPrs: () => [{ repo, number: 1, files: ['scripts/a.mjs'] }] });
      fs.writeFileSync(f.path, 'old');
      const result = await f.command([...flags, ...(preview ? ['--preview'] : [])]);
      expect(result.code).not.toBe(0);
      expect(result.lines.join('\n')).toContain(`scope overlaps open PR ${repo}#1`);
      expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
      untouched(f, ['build-priority.runtime.json']);
    }
  }
});

it.each(['web-everything/web-everything', 'plateauapp/plateau-app'])(
  'keeps Frontier UI scopes separate from identical paths in %s', async repo => {
    const f = fixture({ readCard: () => ({ scope: ['fui:scripts/a.mjs'] }),
      readPrs: () => [{ repo, number: 1, files: ['scripts/a.mjs'] }] });
    expect((await f.command([...flags, '--preview'])).code).toBe(0);
    untouched(f);
  });

it.each([false, true])('emits one JSON envelope with the priority record (preview: %s)', async preview => {
  const f = fixture();
  const result = await f.command([...flags, ...(preview ? ['--preview'] : []), '--json']);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.lines.join('\n'));
  expect(payload.verdict.record).toEqual({ ids: ['42', '43'], mode: 'only', setBy: 'operator', at, ttlHours: 2 });
  if (preview) untouched(f);
  else expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toEqual(payload.verdict.record);
});

it('keeps JSON refusals parseable without writing anything', async () => {
  const f = fixture({ readCard: () => null });
  const result = await f.command([...flags, '--preview', '--json']);
  expect(result.code).not.toBe(0);
  expect(JSON.parse(result.lines.join('\n')).error).toContain('card 42');
  untouched(f);
});

it.each([
  ['unknown mode', 'mode', 'other'], ['ttl zero', 'ttl-hours', '0'], ['ttl negative', 'ttl-hours', '-1'],
  ['ttl oversized', 'ttl-hours', '169'], ['ttl NaN', 'ttl-hours', 'NaN'], ['ttl infinite', 'ttl-hours', 'Infinity'],
  ['missing actor', 'actor', undefined], ['blank actor', 'actor', '  '], ['missing reason', 'reason', undefined],
  ['blank reason', 'reason', '  '], ['empty ids', 'ids', ''], ['duplicate ids', 'ids', '42,42'],
  ['duplicate trimmed ids', 'ids', '42, 42'], ['non-numeric ids', 'ids', '42,xabc123'],
  ['invalid ids', 'ids', '42,1e2'], ['empty id member', 'ids', '42,'],
])('refuses %s without writing anything', async (_name, flag, value) => {
  const f = fixture();
  expect((await f.command(changed(flag, value))).code).not.toBe(0);
  untouched(f);
});

it.each([
  ['unknown card', { readCard: () => null }],
  ['unreadable card source', { readCard: () => { throw new Error('unreadable origin/main'); } }],
  ['unreadable PR source', { readPrs: () => { throw new Error('unreadable PRs'); } }],
  ['incomplete PR source', { readPrs: () => null }],
  ['malformed PR files', { readPrs: () => [{ repo: 'web-everything/web-everything', number: 1 }] }],
  ['unrepresentable PR filenames', { readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/a b.mjs'] }] }],
  ['missing card scope', { readCard: () => ({}) }],
  ['open PR overlap', { readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/a.test.mjs'] }] }],
  ['directory scope overlap', { readCard: () => ({ scope: ['we:scripts/'] }), readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: ['scripts/a.mjs'] }] }],
])('refuses %s and preserves the old runtime file', async (_name, overrides) => {
  const f = fixture(overrides);
  fs.writeFileSync(f.path, 'old');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  untouched(f, ['build-priority.runtime.json']);
});

it('refuses an existing exclusive lock without removing it or writing anything', async () => {
  const f = fixture();
  fs.writeFileSync(`${f.path}.lock`, 'another writer');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(`${f.path}.lock`, 'utf8')).toBe('another writer');
  untouched(f, ['build-priority.runtime.json.lock']);
});

it('preview validates and prints the proposed record but writes nothing', async () => {
  const f = fixture();
  const result = await f.command([...flags, '--preview']);
  expect(result.code).toBe(0);
  expect(result.lines.join('\n')).toContain('"setBy": "operator"');
  expect(f.readCard).toHaveBeenCalledWith('42');
  expect(f.readPrs).toHaveBeenCalled();
  untouched(f);
  f.options.readPrs = () => { throw new Error('unreadable PRs'); };
  expect((await f.command([...flags, '--preview'])).code).not.toBe(0);
  untouched(f);
});

it('rename failure leaves the old file intact with an install-attempt audit and no temporary file', async () => {
  const f = fixture({ rename: () => { throw new Error('rename refused'); } });
  fs.writeFileSync(f.path, 'old');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  expect(JSON.parse(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8')).phase).toBe('install-attempt');
  untouched(f, ['build-priority.runtime.json', 'build-priority.audit.jsonl']);
});

it('fsync failure leaves the old file intact and cleans up the temporary file and lock', async () => {
  const f = fixture({ fsync: () => { throw new Error('fsync refused'); } });
  fs.writeFileSync(f.path, 'old');
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  untouched(f, ['build-priority.runtime.json']);
});

it('O_EXCL refuses a writer that acquires the lock after initial validation', async () => {
  const f = fixture();
  f.options.readPrs = () => { fs.writeFileSync(`${f.path}.lock`, 'other writer'); return []; };
  expect((await f.command()).code).not.toBe(0);
  expect(fs.readFileSync(`${f.path}.lock`, 'utf8')).toBe('other writer');
  untouched(f, ['build-priority.runtime.json.lock']);
});

it('accepts lift and the maximum TTL and appends rather than replaces audit history', async () => {
  const f = fixture();
  expect((await f.command()).code).toBe(0);
  expect((await f.command([...changed('mode', 'lift').filter(s => !s.startsWith('--ttl-hours=')), '--ttl-hours=168'])).code).toBe(0);
  expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toMatchObject({ mode: 'lift', ttlHours: 168 });
  expect(fs.readFileSync(join(f.dir, 'build-priority.audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
});

it('uses the coordination-root default when no runtime override is supplied', async () => {
  const f = fixture();
  f.options.env = { WE_COORDINATION_ROOT: f.dir };
  expect((await f.command()).code).toBe(0);
  expect(fs.existsSync(f.path)).toBe(true);
});

it('reads cards from a pinned origin/main using bounded git reads, refusing unknown or ambiguous cards', () => {
  const git = vi.fn(args => args[0] === 'rev-parse' ? 'a'.repeat(40) : args[0] === 'ls-tree'
    ? 'backlog/042-card.md\0backlog/43-card.md\0' : '---\nscope: ["we:scripts/a.mjs"]\n---\n');
  const read = readPriorityCards({ git });
  expect(read('42')).toEqual({ scope: ['we:scripts/a.mjs'] });
  expect(git.mock.calls[0][0]).toEqual(['rev-parse', '--verify', 'refs/remotes/origin/main']);
  expect(git.mock.calls.some(([args]) => args.includes(`${'a'.repeat(40)}:backlog/042-card.md`))).toBe(true);
  expect(() => read('99')).toThrow(/card/);
  expect(() => readPriorityCards({ git: args => args[0] === 'rev-parse' ? 'a'.repeat(40)
    : 'backlog/042-card.md\0backlog/42-other.md\0' })('42')).toThrow(/ambiguous/);
  expect(() => readPriorityCards({ git: () => { throw new Error('unreadable'); } })('42')).toThrow();
});

it('PR reader uses bounded gh list and refuses truncated or malformed evidence with an operator fallback', () => {
  const gh = vi.fn(() => '[]');
  expect(readPriorityPrs({ gh })).toEqual([]);
  expect(gh.mock.calls[0][0]).toEqual(expect.arrayContaining(['pr', 'list', '--state', 'open', '--limit']));
  for (const value of [null, [{}], Array.from({ length: 200 }, () => ({})), [{ number: 1, files: Array.from({ length: 100 }, () => ({ path: 'a' })) }]]) {
    expect(() => readPriorityPrs({ gh: () => JSON.stringify(value) })).toThrow(/repair|drain|retry/i);
  }
  expect(() => readPriorityPrs({ gh: () => { throw new Error('unreadable'); } })).toThrow();
});


it.each([false, true])('audit append failure refuses activation (existing runtime: %s)', async existing => {
  const f = fixture();
  if (existing) fs.writeFileSync(f.path, 'old');
  fs.mkdirSync(join(f.dir, 'build-priority.audit.jsonl'));
  const rename = vi.fn(fs.renameSync);
  f.options.rename = rename;
  expect((await f.command()).code).not.toBe(0);
  expect(rename).not.toHaveBeenCalled();
  if (existing) expect(fs.readFileSync(f.path, 'utf8')).toBe('old');
  else expect(fs.existsSync(f.path)).toBe(false);
  untouched(f, ['build-priority.audit.jsonl', ...(existing ? ['build-priority.runtime.json'] : [])]);
});

it.each(['scripts/a.mjs', 'scripts/renamed.mjs'])('PR rename evidence blocks overlap with %s', async path => {
  const gh = () => JSON.stringify([{ number: 1, files: [{ path: 'scripts/renamed.mjs', previousFilename: 'scripts/a.mjs' }] }]);
  const prs = readPriorityPrs({ gh });
  expect(prs[0].files).toEqual(['scripts/renamed.mjs', 'scripts/a.mjs']);
  const f = fixture({ readCard: () => ({ scope: [`we:${path}`] }), readPrs: () => prs });
  expect((await f.command()).code).not.toBe(0);
  untouched(f);
});

it.each(['we:scripts/a.mjs', 'fui:scripts/a.mjs'])('treats PR filename %s as a literal path in its repo', async path => {
  const f = fixture({ readCard: () => ({ scope: [`we:${path}`] }),
    readPrs: () => [{ repo: 'web-everything/web-everything', number: 1, files: [path] }] });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toContain('scope overlaps open PR');
  untouched(f);
});

it('refuses a delimiter-only scope member alongside a valid member', async () => {
  const f = fixture({ readCard: () => ({ scope: ['we:scripts/a.mjs', ',,,'] }) });
  const result = await f.command();
  expect(result.code).not.toBe(0);
  expect(result.lines.join('\n')).toMatch(/repair evidence.*retry/);
  untouched(f);
});

it.each([false, true])('fsyncs and closes the parent directory after rename (sync failure: %s)', async fail => {
  const f = fixture();
  const events = [];
  let directoryFd;
  const closeSync = fs.closeSync;
  const close = vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
    closeSync(fd);
    if (fd === directoryFd) {
      // A successful real close proves cleanup; fstat could observe a reused fd number.
      events.push('directory-close');
      directoryFd = undefined;
    }
  });
  f.options.rename = (src, dest) => { events.push('rename'); fs.renameSync(src, dest); };
  f.options.fsync = fd => {
    if (fs.fstatSync(fd).isDirectory()) {
      directoryFd = fd;
      events.push('directory-fsync');
      if (fail) throw new Error('directory fsync refused');
    } else events.push('file-fsync');
    fs.fsyncSync(fd);
  };
  let result;
  try { result = await f.command(); }
  finally { close.mockRestore(); }
  expect(events).toEqual(['file-fsync', 'rename', 'directory-fsync', 'directory-close']);
  if (fail) {
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('directory fsync refused');
  } else expect(result.code).toBe(0);
  untouched(f, ['build-priority.runtime.json', 'build-priority.audit.jsonl']);
});
