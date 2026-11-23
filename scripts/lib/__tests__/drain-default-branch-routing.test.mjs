// @vitest-environment node
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLiveDefaultBranchReader } from '../default-branch-cache.mjs';
import { ownerFromGhArgv, ownerOfSlug } from '../github-app-installations.mjs';

// Execute the CLI's actual reader/warning closures without starting its mutation loop.
const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
const errorText = new Function(`${source.slice(source.indexOf('export function ghListErrText('),
  source.indexOf('\n/**', source.indexOf('export function ghListErrText('))).replace('export ', '')}; return ghListErrText;`)();
const readerSource = source.slice(source.indexOf('  const newDefaultBranchReader ='),
  source.indexOf('  const verifyDefaultBranch ='));
const localRepo = 'web-everything/web-everything';
const repos = [localRepo, 'frontier-ui/frontierui', 'plateauapp/plateau-app'];

function fixture(unreadable = null) {
  const warnings = [], calls = [], map = new Map();
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    // Same owner selection as the App shim: argv, GH_REPO, then checkout origin.
    const owner = ownerFromGhArgv(args) || ownerOfSlug(options.env?.GH_REPO || localRepo);
    if (owner !== ownerOfSlug(args[2]) || args[2] === unreadable) {
      throw Object.assign(new Error('Command failed: gh repo view'), {
        stderr: `GraphQL: Could not resolve to a Repository\n for ${args[2]}`,
      });
    }
    return { stdout: 'trunk\n' };
  };
  const create = new Function('createLiveDefaultBranchReader', 'defaultBranchByRepo', 'execFileP', 'process', 'ghListErrText',
    `${readerSource}; return newDefaultBranchReader;`)(
    options => createLiveDefaultBranchReader({ ...options, writeCache: () => {} }), map, exec,
    { env: { GH_REPO: localRepo }, stderr: { write: line => warnings.push(line) } }, errorText);
  return { create, warnings, calls, map };
}

it('resolves every constellation default branch with the target owner despite ambient GH_REPO', async () => {
  const f = fixture();
  for (const repo of repos) expect(await f.create()(repo)).toBe('trunk');
  expect(f.calls.map(c => c.options.env.GH_REPO)).toEqual(repos);
  expect(f.warnings).toEqual([]);
});

it('refuses an unreadable sibling branch and logs its stderr cause for the next-pass retry', async () => {
  const f = fixture(repos[1]);
  expect(await f.create()(repos[1])).toBeNull();
  expect(f.map.get(repos[1])).toBeNull();
  expect(f.warnings.join('')).toContain('frontier-ui/frontierui: default branch unresolved live');
  expect(f.warnings.join('')).not.toContain('Could not resolve');
  expect(f.warnings.join('')).toContain('retry on the next pass');
});
