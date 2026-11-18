// Shared admission/apply decision table; fixture data, never filesystem targets.
export const admissibleTargets = [
  'docs/guide.md', 'README.md', 'docs/x/y.md', 'notes.mdx', 'docs/example.mjs',
  'scripts/lib/__tests__/foo.test.mjs', 'src/__tests__/a.test.ts', 'src/a.spec.ts',
];
export const refusedTargets = [
  'scripts/operations/fix-run.mjs', 'vitest.config.ts', 'playwright.config.ts',
  '.github/workflows/ci.yml', '.github/x.md', 'scripts/settings/agy-build.json',
  'package.json', 'docs/package.json', 'backlog/123.md', 'agent-memory-src/x.md',
  'docs/agent/testing.md', 'foo.real.test.mjs', 'scripts/conveyor/soak/breaks/x.test.mjs',
  'scripts/lib/agy-confined-build.mjs', 'scripts/lib/policy-cascade.mjs', 'src/main.ts',
  'src/__tests__/soak/x.test.ts', 'docs/breaks/x.md', 'docs/soak/x.md',
  'docs/a.json', 'docs/a.yml', 'docs/a.yaml', 'docs/a.toml',
  'src/__tests__/vitest.config.ts', 'src/__tests__/playwright.config.ts',
  'src/__tests__/foo.config.ts', 'src/__tests__/tsconfig.build',
  'src/__tests__/yarn.lock', 'docs/bun.lockb', 'src/__tests__/foo.real.test.mjs',
  'scripts/lib/__tests__/agy-confined-build.test.mjs', 'AGENTS.md',
  '../escape.md', '/abs.md', '.git/x.md', 'docs/.git/x', 'docs/.GIT/x.md',
  'docs//x.md', 'docs/./x.md', 'docs/../x.md', 'docs/x.md/', 'docs/x\\y.md',
  'docs/x\x00.md', 'docs/x\x1f.md', 'docs/x\x85.md',
  'docs/*.md', 'docs/?.md', 'docs/[x].md', 'docs/{x}.md',
];
