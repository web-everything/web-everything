// Shared admission/apply decision table; fixture data, never filesystem targets.
export const admissibleTargets = [
  'tests/helper.cjs', 'src/__tests__/helper.js', 'src/foo-unit.test.ts',
  'docs/guide.md', 'README.md', 'docs/x/y.md', 'notes.mdx', 'docs/notes.txt',
  'scripts/lib/__tests__/foo.test.mjs', 'src/__tests__/a.test.ts', 'src/a.spec.ts',
];
export const refusedTargets = [
  'src/__tests__/__fixtures__/payload.js', 'tests/__fixtures__/payload.cjs',
  'src/__tests__/__fixture__/payload.ts', 'src/__tests__/fixtures/payload.js',
  'docs/a.test.mjs', 'docs/__tests__/a.test.ts',
  'tests/a11y/rendered-site-a11y.spec.ts', 'tests/e2e/flow.spec.ts',
  'docs/Makefile', 'docs/Dockerfile', 'docs/install', 'docs/CODEOWNERS',
  'tests/run.sh', '__tests__/setup.mjs', 'src/__tests__/setup.js', 'tests/helper.py', 'src/a.test.sh',
  'scripts/__tests__/pr-merge-gate.test.js', 'scripts/__tests__/gate-entrypoint-integration.test.ts',
  'scripts/__tests__/pr-merge-gate.test.mjs', 'scripts/__tests__/gate-entrypoint-integration.test.mjs',
  'scripts/lib/__tests__/pr-merge-gate-unit.test.mjs', 'scripts/__tests__/gate-entrypoint-e2e.test.mjs',
  // Docs are prose: dotfiles (git behaviour files) and non-prose extensions are refused (audit: docs/.gitignore hides untracked files).
  'docs/.gitignore', 'docs/.gitattributes', 'docs/a/.hidden.md', 'docs/example.mjs', 'docs/run.sh', 'docs/img.png',
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
