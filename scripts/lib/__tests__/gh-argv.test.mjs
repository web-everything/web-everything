import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { classifyGhResource, renderGhResourceClassifier } from '../gh-argv.mjs';

describe('generated resource classifier with no module or bundler context', () => {
  it.each([
    { argv: ['pr', 'view', '1'], resource: 'graphql' },
    { argv: ['--repo', 'o/r', 'pr', 'list'], resource: 'graphql' },
    { argv: ['api', 'graphql'], resource: 'graphql' },
    { argv: ['-R', 'o/r', 'api', 'graphql'], resource: 'graphql' },
    { argv: ['--repo', 'o/r', 'api', 'graphql'], resource: 'graphql' },
    { argv: ['--repo=o/r', 'api', 'graphql'], resource: 'graphql' },
    { argv: ['-Ro/r', 'api', 'graphql'], resource: 'graphql' },
    { argv: ['--hostname', 'ghe.example.com', '-R', 'o/r', 'api', '-iq', '.data', 'graphql'], resource: 'graphql' },
    { argv: ['-R', 'graphql', 'api', 'user'], resource: 'core' },
    { argv: ['--repo', 'graphql', 'api', 'user'], resource: 'core' },
    { argv: ['-R', 'o/r', 'api', '-iH', 'graphql', 'user'], resource: 'core' },
    { argv: ['api', '-iq', '.data', 'graphql'], resource: 'graphql' },
    { argv: ['api', '--header', 'graphql', 'user'], resource: 'core' },
    { argv: ['api', '-iH', 'graphql', 'user'], resource: 'core' },
    { argv: ['api', '--jq', '-XPOST', 'graphql'], resource: 'graphql' },
    { argv: ['api', 'repos/o/r/pulls'], resource: 'core' },
    { argv: ['run', 'watch', '1'], resource: 'core' },
    { argv: [], resource: 'core' },
  ])('classifies $argv as $resource from standalone source', ({ argv, resource }) => {
    // A fresh context deliberately supplies no imports, require, or Vite SSR bindings.
    const standalone = runInNewContext(`${renderGhResourceClassifier()}\nclassifyGhResource;`);
    expect(standalone(argv)).toBe(resource);
    expect(classifyGhResource(argv)).toBe(resource);
  });
});
