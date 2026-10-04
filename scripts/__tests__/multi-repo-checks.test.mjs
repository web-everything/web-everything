import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isScannedFile, SCAN_ROOTS, scanMultiRepo, validateAllowlist } from '../lib/multi-repo-scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const sources = new Map(SCAN_ROOTS.flatMap((dir) => readdirSync(resolve(root, dir), { recursive: true })
  .map((name) => `${dir}/${name}`).filter(isScannedFile).map((file) => [file, read(file)])));
const allowlist = JSON.parse(read('scripts/lib/we-only-checks.json'));

it('keeps every scanned source repo-explicit or specifically allowlisted', () => {
  expect(validateAllowlist(allowlist, sources)).toEqual([]);
  const exempt = new Set(allowlist.map(({ file }) => file));
  const violations = [...sources].filter(([file]) => !exempt.has(file))
    .flatMap(([file, source]) => scanMultiRepo(source).map((finding) => ({ file, ...finding })));
  expect(violations).toEqual([]);
});

it('is included in test:unit without adding a standards gate', () => {
  // xaipsbs — test:unit runs through the heavy-admission wrapper; the command it wraps is still plain `vitest run`.
  expect(JSON.parse(read('package.json')).scripts['test:unit']).toBe('node scripts/readiness/heavy-admission.mjs run -- vitest run');
  expect(read('vitest.config.ts')).toContain("'scripts/**/__tests__/**/*.test.mjs'");
  expect(fileURLToPath(import.meta.url)).toMatch(/scripts\/__tests__\/multi-repo-checks\.test\.mjs$/);
});

describe('negative controls', () => {
  it.each([
    "exec('gh', ['pr','view',String(pr),'--json','state,mergedAt'], opts)",
    ...['execFileSync', 'execFileSyncThrottled', 'exec', 'spawn', 'spawnSync'].map((run) => `${run}('gh', ['pr', 'view', '1'])`),
    "runGhSync(['pr', 'view', '1'])",
    "const args = ['pr', 'view', '1']; execFileSync('gh', args)",
    "let args; args = ['pr', 'view', '1']; spawn('gh', args)",
    "runGhSync(['api', 'repos/{owner}/{repo}/pulls'])",
    'execSync(`gh api repos/{owner}/{repo}/pulls`)',
    "execSync('gh pr view 1')",
    'execSync(`gh pr view ${pr}`)',
    "const slug = 'frontier-ui/frontierui'",
    "execSync('gh pr view 1; gh pr view 2 --repo owner/repo')",
    "// args.push('--repo', repo)\nconst args = ['pr', 'view']; exec('gh', args)",
    "const args = ['pr', 'view']; function run(args) { exec('gh', args); } exec('gh', args)",
  ])('flags %s', (source) => expect(scanMultiRepo(source).length).toBeGreaterThan(0));
});

describe('explicit repository and non-executable controls', () => {
  it.each([
    "exec('gh', ['pr', 'view', '1', '--repo', repo])",
    "spawnSync('gh', ['pr', 'view', '1', '--repo=owner/repo'])",
    "runGhSync(['pr', 'view', '1', '-R', repo])",
    "const args = ['pr', 'view']; args.push('--repo', repo); exec('gh', args)",
    "const args = ['pr', 'view']; args.push(`--repo=${repo}`); exec('gh', args)",
    "const args = ['pr', 'view']; args.splice(1, 0, '--repo', repo); exec('gh', args)",
    "let args = ['pr', 'view']; args = [...args, '--repo', repo]; exec('gh', args)",
    "exec('gh', ['pr', 'view', ...repoArgs])",
    'runGhSync(["api", `repos/${repo}/pulls`])',
    'execSync(`gh api repos/${repo}/pulls`)',
    "execSync('gh pr view 1 --repo=owner/repo')",
    "execSync('gh pr view 1 -R owner/repo')",
    '// frontier-ui/frontierui\n/* plateauapp/plateau-app gh pr view 1 */',
    "const url = 'https://example.test'; // frontier-ui/frontierui",
    "throw new Error('gh pr view failed')",
    "const args = ['pr', 'view']; args.push('--repo', slug); function run(args) { exec('gh', args); }",
    "const build = (repo) => ['pr', 'merge', '1', ...(repo ? ['--repo', repo] : [])];",
  ])('accepts %s', (source) => expect(scanMultiRepo(source)).toEqual([]));
});

it('skips tests, fixtures and dependencies at any depth', () => {
  for (const file of ['scripts/lib/__tests__/x.mjs', 'scripts/conveyor/nested/__fixtures__/x.js',
    'scripts/operations/x.test.ts', 'skills-src/conveyor/node_modules/x.ts', 'scripts/review-runner.mjs']) {
    expect(isScannedFile(file)).toBe(false);
  }
  expect(isScannedFile('scripts/operations/nested/check.ts')).toBe(true);
});

it('rejects invalid, duplicate, placeholder and stale allowlist entries', () => {
  const file = 'scripts/lib/example.mjs';
  const reason = 'The systemd documentation link names the source host for the installed daemon.';
  const corpus = new Map([[file, "const repo = 'frontier-ui/frontierui'"]]);
  expect(validateAllowlist([{ file, reason }], corpus)).toEqual([]);
  for (const entry of [{ file: '', reason }, { file: 'scripts/outside.mjs', reason }, { file: 'scripts/lib/missing.mjs', reason },
    ...['TODO', 'n/a', 'legacy', 'because', 'scripts lib example mjs '.repeat(4)].map((text) => ({ file, reason: text.repeat(4) }))]) {
    expect(validateAllowlist([entry], corpus).length).toBeGreaterThan(0);
  }
  expect(validateAllowlist([{ file, reason }, { file, reason }], corpus).join()).toContain('duplicate');
  expect(validateAllowlist([{ file, reason }], new Map([[file, '// only a comment']])).join()).toContain('remove this entry');
});

it('does not let comments, unrelated scopes or later shell commands hide a violation', () => {
  expect(scanMultiRepo("execSync('gh pr view 1 --repo x/y && gh pr view 2')")).toHaveLength(1);
  expect(scanMultiRepo("execFileSync('sh', ['-c', 'gh pr view 1'])")).toHaveLength(1);
  expect(scanMultiRepo('const url = `repos/${repo /* frontier-ui/frontierui */}/pulls`;')).toEqual([]);
  expect(scanMultiRepo("runGhSync(['api', `repos/${'{owner}/{repo}'}/pulls`])")).toHaveLength(1);
  // gh-argv-shaped arrays are checked wherever they flow, so an unrecognised helper cannot hide a repo-less call.
  expect(scanMultiRepo("function f() { const args = ['pr', 'view']; } function g(args) { exec('gh', args); }")).toHaveLength(1);
  expect(scanMultiRepo("const r = run(['pr', 'list', '--state', 'open']);")).toHaveLength(1);
  expect(scanMultiRepo("const args = ['pr', 'view']; run(args);")).toHaveLength(1);
});


it('the timeout reservation soak uses a repository-neutral fixture and still exercises recovery', async () => {
  const file = 'scripts/conveyor/soak/breaks/timeout-retry-reservation-wedged-on-failed-observation.mjs';
  expect(scanMultiRepo(read(file))).toEqual([]);
  const { default: scenario } = await import('../conveyor/soak/breaks/timeout-retry-reservation-wedged-on-failed-observation.mjs');
  expect(scenario.judge(await scenario.run())).toEqual([]);
});
