import { it, expect } from 'vitest';
import * as gates from '../verify-lane-gate.mjs';
import { selectRelatedTests } from '../related-test-selection.mjs';

const hub = 'scripts/lib/hub.mjs';
const own = 'scripts/lib/__tests__/own.test.mjs';
const guard = 'scripts/lib/__tests__/guard.test.mjs';
function fixture({ changed = [hub], files = { [hub]: '', [own]: "import '../hub.mjs'" }, graphThrows = false, max = 4 } = {}) {
  const runGit = args => {
    if (args[0] === 'merge-base') return 'base';
    if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : changed.join('\n');
    if (args[0] === 'grep') throw new Error('no references');
    if (args[0] === 'ls-files') {
      if (!args.includes('--cached')) return '';
      if (graphThrows) throw new Error('graph unavailable');
      return Object.keys(files).join('\n');
    }
    throw new Error(args.join(' '));
  };
  return { runGit, readRepoFile: p => files[p] ?? '', env: {}, allowCardOnlySkip: false,
    fileConfig: { selection: 'pr', relatedMode: 'import-only', relatedMaxTests: max, relatedDepth: 2,
      shardMinTests: 0, alwaysRunTests: [guard] } };
}
it('a hub change with ≤ relatedMaxTests graph tests runs `vitest run <list>`, never `vitest related`', () => {
  const plan = gates.resolveDefaultGate(fixture());
  expect(plan.command).toContain(`npx vitest run '${own}'`);
  expect(plan.command).not.toContain('vitest related');
  expect(plan.decision.selection.tests).toEqual([own]);
});
it.each([0, -3, 'abc', NaN, null])('relatedMaxTests=%s never means "run no tests"', max => {
  const plan = gates.resolveDefaultGate(fixture({ max }));
  expect(plan.command).toContain(`npx vitest run`);
  expect(plan.command).toContain(own);
  expect(plan.command).not.toMatch(/^echo|vitest related/);
});
it('complete selection returns a sorted tests list', () => {
  expect(selectRelatedTests({ changedFiles: [hub], reverse: new Map([[hub, new Set(['z.test.mjs', 'a.test.mjs'])]]), maxTests: 4, maxDepth: 2 }).tests).toEqual(['a.test.mjs', 'z.test.mjs']);
});
it('graph throws -> capped-fallback with changed tests included', () => {
  const p = gates.resolveDefaultGate(fixture({ changed: [hub, own], graphThrows: true }));
  expect(p.decision.selection.status).toBe('capped-fallback');
  expect(p.decision.selection.tests).toEqual([guard, own].sort());
  expect(p.command).not.toContain('vitest related');
});
it('a >32KB list -> capped-fallback with bounded command', () => {
  const files = { [hub]: '' };
  for (let i = 0; i < 4; i++) files[`scripts/lib/__tests__/${i}${'x'.repeat(9000)}.test.mjs`] = "import '../hub.mjs'";
  const p = gates.resolveDefaultGate(fixture({ files }));
  expect(p.decision.selection.status).toBe('capped-fallback');
  expect(Buffer.byteLength(p.command)).toBeLessThan(32000);
  expect(p.command).not.toContain('vitest related');
});
it('empty graph runs named suites only, never unfiltered vitest run', () => {
  const p = gates.resolveDefaultGate(fixture({ files: {} }));
  expect(p.decision.selection.tests).toEqual([guard]);
  expect(p.command).toContain(`vitest run '${guard}'`);
});
it('changed tests and direct importers of each source survive the clip', () => {
  const second = 'scripts/lib/second.mjs';
  const direct = 'scripts/lib/__tests__/second.test.mjs';
  const files = { [hub]: '', [second]: '', [own]: "import '../hub.mjs'", [direct]: "import '../second.mjs'" };
  for (let i = 0; i < 10; i++) files[`scripts/lib/__tests__/extra${i}.test.mjs`] = "import '../hub.mjs'";
  const p = gates.resolveDefaultGate(fixture({ changed: [hub, second, 'scripts/lib/__tests__/changed.test.mjs'], files, max: 3 }));
  expect(p.decision.selection.tests).toContain(direct);
  expect(p.decision.selection.tests).toContain('scripts/lib/__tests__/changed.test.mjs');
  expect(p.decision.selection.tests.length).toBeLessThanOrEqual(3);
});
it('explicit related gate rewrites and preserves composed standards', () => {
  const p = gates.capExplicitRelatedGate({ gate: `npx vitest related '${hub}' --run && npm run check:standards`, ...fixture() });
  expect(p.command).toContain(`vitest run '${own}'`);
  expect(p.command).toMatch(/ && npm run check:standards$/);
});
it('explicit vitest run x stays untouched', () => {
  expect(gates.capExplicitRelatedGate({ gate: 'npx vitest run x', ...fixture() }).command).toBe('npx vitest run x');
});
it.each([
  '--config=vitest.custom.ts --project=browser',
  "--config 'vitest custom.ts' --project 'browser suite'",
])('explicit related gate preserves --config and --project: %s', options => {
  const p = gates.capExplicitRelatedGate({ gate: `vitest related '${hub}' --run ${options} && npm run check:standards`, ...fixture(), env: { WE_VERIFY_TEST_TIMEOUT_FACTOR: '1' } });
  const spaced = options.includes("'");
  expect(p.command).toBe(`npx vitest run '${own}' --passWithNoTests '--config' '${spaced ? 'vitest custom.ts' : 'vitest.custom.ts'}' '--project' '${spaced ? 'browser suite' : 'browser'}' && npm run check:standards`);
  expect(p.selection.tests).toEqual([own]);
});
it('explicit related gate preserves filtering and bail options as literal arguments', () => {
  const p = gates.capExplicitRelatedGate({ gate: `vitest related '${hub}' --run -t 'a && b' --exclude=slow.test.mjs --bail=2`, ...fixture(), env: { WE_VERIFY_TEST_TIMEOUT_FACTOR: '1' } });
  expect(p.command).toBe(`npx vitest run '${own}' --passWithNoTests '-t' 'a && b' '--exclude' 'slow.test.mjs' '--bail=2'`);
});
it.each(['--root=other', '--unknown', '--run=false'])('explicit related gate refuses unsupported option %s', option => {
  expect(() => gates.capExplicitRelatedGate({ gate: `vitest related '${hub}' ${option}`, ...fixture() }))
    .toThrow(/unsupported related gate option/);
});
it.each(['--config', '--project --run', '--config='])('explicit related gate refuses missing option value: %s', option => {
  expect(() => gates.capExplicitRelatedGate({ gate: `vitest related '${hub}' ${option}`, ...fixture() }))
    .toThrow(/requires a literal value/);
});
it('explicit related gate refuses options when no selected or named suites can execute them', () => {
  const o = fixture({ files: {} });
  o.fileConfig.alwaysRunTests = [];
  expect(() => gates.capExplicitRelatedGate({ gate: `vitest related '${hub}' --config=vitest.custom.ts`, ...o }))
    .toThrow(/options require selected or named test suites/);
});
it('explicit related gate refuses an option value standing in for a missing target', () => {
  expect(() => gates.capExplicitRelatedGate({ gate: 'vitest related --config vitest.custom.ts', ...fixture() }))
    .toThrow(/names no target file/);
});
it('--gate-uncapped preserves related and records the exemption', () => {
  const p = gates.capExplicitRelatedGate({ gate: `vitest related ${hub} --run`, uncapped: true, ...fixture() });
  expect(p.command).toBe(`vitest related ${hub} --run`);
  expect(p.gateUncapped).toBe(true);
});
it('matchRequestedDefaultGate still matches an explicit-list default across standards variants', () => {
  const o = fixture();
  const requested = gates.resolveDefaultGate({ ...o, env: { WE_VERIFY_STANDARDS: 'always' } });
  const resolved = gates.resolveDefaultGate(o);
  expect(gates.matchRequestedDefaultGate({ gate: requested.command, env: {}, resolved,
    resolveUnder: env => gates.resolveDefaultGate({ ...o, env }) })?.command).toBe(resolved.command);
});

it.each([false, true])('default selection drops option-shaped changed tests (graph unavailable: %s)', graphThrows => {
  const unsafe = '--exclude=**/*.test.mjs';
  const p = gates.resolveDefaultGate(fixture({ changed: [unsafe, own], files: { [unsafe]: '', [own]: '' }, graphThrows }));
  expect(p.decision.selection.tests).not.toContain(unsafe);
  expect(p.testCommand).not.toContain(unsafe);
  expect(p.testCommand).toContain(`'${own}'`);
});
it('fallback drops option-shaped direct importers and named suites before clipping', () => {
  const unsafe = '--exclude=**/*.test.mjs';
  const selection = gates.cappedFallbackSelection({ targets: [hub], reverse: new Map([[hub, new Set([unsafe, own])]]),
    settings: { relatedMaxTests: 1, alwaysRunTests: [unsafe, guard] } });
  expect(selection.tests).toEqual([guard, own].sort());
});
it('explicit related rewrite drops option-shaped graph results', () => {
  const unsafe = '--exclude=**/*.test.mjs';
  const p = gates.capExplicitRelatedGate({ gate: `npx vitest related '${hub}' --run`,
    ...fixture({ files: { [hub]: '', [unsafe]: "import './scripts/lib/hub.mjs'", [own]: "import '../hub.mjs'" } }) });
  expect(p.selection.tests).toEqual([own]);
  expect(p.command).not.toContain(unsafe);
});
it('an all-option-shaped selection never becomes an unfiltered vitest run', () => {
  const unsafe = '--exclude=**/*.test.mjs';
  const o = fixture({ changed: [unsafe], files: { [unsafe]: '' } });
  o.fileConfig.alwaysRunTests = [];
  const p = gates.resolveDefaultGate(o);
  expect(p.decision.selection.tests).toEqual([]);
  expect(p.command).not.toContain('vitest run');
});
