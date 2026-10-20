// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveRaisedByConflict, applyRaisedByConflictsToIndex, loadCardConflictSettings } from '../card-conflict-resolve.mjs';
import { gitBlobOid } from '../git-run.mjs';

const path = 'backlog/1-card.md';
const entry = n => `- Also raised by o/r#${n}`;
const section = text => `# Card\n\n## Also raised by\n\n${text}\n`;
const main = section(entry(1)), pr = section(entry(2));
const conflict = `<<<<<<< main\n${entry(1)}\n=======\n${entry(2)}\n>>>>>>> pr`;
const merged = section(conflict);

describe('resolveRaisedByConflict refusal matrix', () => {
  it('unions only the mention entries and preserves surrounding prose', () => {
    const result = resolveRaisedByConflict({ path, main, pr, merged: `${merged}\n## Next\nUnchanged.\n` });
    expect(result).toEqual({ ok: true, text: `${section(`${entry(1)}\n${entry(2)}`)}\n## Next\nUnchanged.\n` });
  });

  it.each([
    ['orphan separator', `=======\n${conflict}`],
    ['orphan closing marker', `${conflict}\n>>>>>>> stray`],
    ['orphan opening marker', `<<<<<<< stray\n${entry(1)}`],
    ['nested conflict', `<<<<<<< outer\n${conflict}\n=======\n${entry(2)}\n>>>>>>> outer`],
    ['diff3 ancestor', conflict.replace('=======', `||||||| ancestor\n${entry(3)}\n=======`)],
    ['missing separator', conflict.replace('=======\n', '')],
    ['missing close', conflict.replace('\n>>>>>>> pr', '')],
    ['unlabelled opening', conflict.replace('<<<<<<< main', '<<<<<<<')],
    ['unlabelled close', conflict.replace('>>>>>>> pr', '>>>>>>>')],
  ])('rejects malformed conflict grammar: %s', (_, body) => {
    expect(resolveRaisedByConflict({ path, main, pr, merged: section(body) }).ok).toBe(false);
  });

  it.each([
    ['duplicate headings', `${merged}\n## Also raised by\n${entry(3)}\n`],
    ['backtick fenced section', `\`\`\`md\n${merged}\`\`\`\n`],
    ['tilde fenced section', `~~~md\n${merged}~~~\n`],
    ['missing heading', conflict],
  ])('rejects ambiguous or fenced mention sections: %s', (_, text) => {
    expect(resolveRaisedByConflict({ path, main, pr, merged: text }))
      .toEqual({ ok: false, reason: 'missing or ambiguous Also raised by section' });
  });

  it.each([
    ['main has ambiguous headings', { main: `${main}\n## Also raised by\n${entry(3)}\n` }],
    ['PR contains conflict markers', { pr: merged }],
    ['conflict outside the list', { merged: `${conflict}\n${merged}` }],
    ['prose inside the list', { pr: section('unstructured prose') }],
    ['non-card path', { path: 'scripts/code.mjs' }],
    ['disabled resolver', { enabled: false }],
    ['NUL input', { main: `${main}\0` }],
  ])('refuses %s', (_, overrides) => {
    expect(resolveRaisedByConflict({ path, main, pr, merged, ...overrides }).ok).toBe(false);
  });

  it('honours the explicit resolver setting through the policy cascade', () => {
    expect(loadCardConflictSettings({ env: { WE_CARD_CONFLICTS_AUTO_RESOLVE_RAISED_BY: 'false' },
      platform: {}, repo: {} }).value.autoResolveRaisedBy).toBe(false);
  });
});

describe('applyRaisedByConflictsToIndex', () => {
  function fixture({ brokenPath, nonCard = false, mode = '100644', failHash = false } = {}) {
    const calls = [];
    const run = (cmd, args, options = {}) => {
      calls.push(args);
      const ok = stdout => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'diff') return ok(`${nonCard ? 'scripts/code.mjs' : path}\0`);
      if (args[0] === 'grep') return { status: 1, stdout: '' };
      if (args[0] === 'ls-tree') return ok(`${mode} blob ${'a'.repeat(40)}\t${args.at(-1)}\n`);
      if (args[0] === 'show') {
        if (args[1].endsWith(`:${brokenPath}`)) return { status: 128, stdout: '', stderr: 'missing' };
        return ok(args[1].startsWith('tree:') ? merged : args[1].startsWith('base:') ? main : pr);
      }
      if (args[0] === 'hash-object') return ok(failHash ? 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' : gitBlobOid(options.input));
      if (args[0] === 'update-index') return ok('');
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    const apply = options => applyRaisedByConflictsToIndex({ run, cwd: '/fixture', tree: 'tree', base: 'base', mergeRef: 'pr', conflictPaths: [path], ...options });
    return { calls, apply };
  }

  it('stages a verified regular-file union', () => {
    const { calls, apply } = fixture();
    expect(apply()).toEqual({ ok: true, resolved: [path] });
    expect(calls.filter(a => a[0] === 'update-index')).toEqual([
      ['update-index', '--add', '--cacheinfo', '100644', gitBlobOid(section(`${entry(1)}\n${entry(2)}`)), path],
    ]);
  });

  it('plans every conflicting path before staging any', () => {
    const second = 'backlog/2-card.md';
    const { calls, apply } = fixture({ brokenPath: second });
    expect(apply({ conflictPaths: [path, second] }).ok).toBe(false);
    expect(calls.filter(a => ['hash-object', 'update-index'].includes(a[0]))).toEqual([]);
  });

  it.each([
    ['non-card diff', { nonCard: true }],
    ['symlink mode', { mode: '120000' }],
    ['executable mode', { mode: '100755' }],
    ['mangled hash input', { failHash: true }],
  ])('refuses %s without staging', (_, options) => {
    const { calls, apply } = fixture(options);
    expect(apply().ok).toBe(false);
    expect(calls.filter(a => a[0] === 'update-index')).toEqual([]);
  });
});
