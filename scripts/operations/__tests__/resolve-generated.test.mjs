import { afterEach, expect, it } from 'vitest';
import { fixture, snapshot, DOC } from '../../lib/__tests__/fixtures/generated-merge.mjs';
import { resolveGenerated, resolveGeneratedOperation, finishResolveGenerated } from '../resolve-generated.mjs';
import { resolveOperation } from '../run.mjs';
import { buildCliSpec, parseOperationArgv, runOperationCli } from '../cli-adapter.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
const fixtures = [];
const setup = opts => { const f = fixture(opts); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
it('refuses with a source conflict present and preserves index and worktree', () => {
  const f = setup({ conflict: 'source.txt' });
  expect(f.git(['merge', '--no-edit', 'theirs']).status).toBe(1);
  const before = snapshot(f);
  expect(resolveGenerated({ git: f.git, cwd: f.root })).toBe(false);
  expect(snapshot(f)).toEqual(before);
});
it('resolves a doc-only rebase stop without committing, using stage-0 inputs', () => {
  const f = setup();
  expect(f.git(['rebase', 'theirs']).status).toBe(1);
  expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe(DOC);
  const head = f.ok(['rev-parse', 'HEAD']);
  // Unstaged inputs must not enter the generated document.
  f.json('scripts/settings/b.json', { sample: { unstaged: true } });
  const operation = resolveOperation('resolve-generated', { cli: true });
  expect(operation.sinks['generated.resolve']({ checkout: f.root })).toBe(true);
  expect(f.ok(['rev-parse', 'HEAD'])).toBe(head);
  expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe('');
  expect(f.ok(['show', `:${DOC}`])).toContain('"b":1');
  expect(f.ok(['show', `:${DOC}`])).not.toContain('unstaged');
  f.ok(['restore', '--worktree', 'scripts/settings/b.json']);
  f.generate('--check');
  f.ok(['rebase', '--continue']);
});
it('drives the real CLI adapter: --help, a bare call and --checkout reach the resolver (no control-flag collision)', async () => {
  const { declaration, registry, sinks, finish } = resolveOperation('resolve-generated', { cli: true });
  expect(() => buildCliSpec(declaration)).not.toThrow();
  const help = await runOperationCli({ declaration, registry, sinks, argv: ['--help'], store: createMemoryRunStore() });
  expect(help.code).toBe(0);
  expect(help.lines.join('\n')).toContain('--checkout');
  // The adapter's own --cwd flag belongs to judged operations; this op must not accept it as its input.
  expect(parseOperationArgv(declaration, ['--cwd=/x']).ok).toBe(false);
  const f = setup();
  expect(f.git(['rebase', 'theirs']).status).toBe(1);
  const outcome = await runOperationCli({ declaration, registry, sinks, argv: [`--checkout=${f.root}`],
    store: createMemoryRunStore(), newRunId: () => 'resolve-generated-test' });
  expect(finish(outcome).code).toBe(0);
  expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe('');
  expect(f.ok(['show', `:${DOC}`])).toContain('"b":1');
});
it('registers the declared CLI operation and reports refusal as a nonzero exit', () => {
  const { declaration } = resolveOperation('resolve-generated', { cli: true });
  expect(declaration.name).toBe(resolveGeneratedOperation().name);
  expect(finishResolveGenerated({ code: 0, lines: [], run: { effects: [{ type: 'generated.resolve', status: 'applied', result: false }] } }).code).toBe(1);
});
