import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import b from './host-handoff-cache-write-race.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

/** Run the scenario against a scratch tree whose guard/preflight modules hold `files`. */
async function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), 'host-handoff-tree-'));
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), source);
  }
  const previous = process.env.SOAK_TREE_ROOT;
  process.env.SOAK_TREE_ROOT = root;
  try { return { root, report: await b.run({}) }; }
  finally {
    if (previous === undefined) delete process.env.SOAK_TREE_ROOT; else process.env.SOAK_TREE_ROOT = previous;
  }
}

describe('host-handoff break cannot be satisfied by a removed or renamed guard', () => {
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('keeps the fix required (never it.fails) even when the guard module is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'host-handoff-empty-'));
    roots.push(empty);
    expect(b.fixPresent(empty)).toBe(true);
  });

  it('reports an import failure as a violation when the guard module is missing', async () => {
    const { root, report } = await runAgainst({});
    roots.push(root);
    expect(b.judge(report)).toEqual([expect.stringContaining('host guard module import failed')]);
  });

  it('reports every guard export that was removed or renamed', async () => {
    const { root, report } = await runAgainst({
      'scripts/lib/daemon-host-guard.mjs': 'export const renamedGetThisHost = () => 1;\n',
      'scripts/operations/daemon-preflight.mjs': 'export const cliIO = () => ({});\nexport const main = async () => 0;\n',
    });
    roots.push(root);
    const [message] = b.judge(report);
    expect(message).toContain('missing callable exports');
    for (const name of ['getThisHost', 'resolveHostRole', 'createGitHubOwnershipSource']) expect(message).toContain(name);
    expect(message).not.toContain('cliIO');
  });

  it('rejects a guard whose exports exist but are not callable', async () => {
    const { root, report } = await runAgainst({
      'scripts/lib/daemon-host-guard.mjs': 'export const getThisHost = 1;\nexport const resolveHostRole = 1;\nexport const createGitHubOwnershipSource = 1;\n',
      'scripts/operations/daemon-preflight.mjs': 'export const cliIO = 1;\nexport const main = 1;\n',
    });
    roots.push(root);
    expect(b.judge(report)[0]).toContain('missing callable exports');
  });

  it('fails the required break when only createGitHubOwnershipSource is renamed in a real-module tree', async () => {
    const guardURL = new URL('../../../lib/daemon-host-guard.mjs', import.meta.url);
    const guardSource = readFileSync(guardURL, 'utf8')
      .replace('export function createGitHubOwnershipSource(', 'export function renamedOwnershipSource(')
      .replace("'./constellation-repos.mjs'", JSON.stringify(new URL('../../../lib/constellation-repos.mjs', import.meta.url).href));
    const { root, report } = await runAgainst({
      'scripts/lib/daemon-host-guard.mjs': guardSource,
      // Re-export the real preflight so its static import does not mask the missing callable check.
      'scripts/operations/daemon-preflight.mjs': 'export { cliIO, main } from '
        + JSON.stringify(new URL('../../../operations/daemon-preflight.mjs', import.meta.url).href) + ';\n',
    });
    roots.push(root);
    // defineBreakTest registers a required pass when this is true, and requires an empty judge result.
    expect(b.fixPresent(root)).toBe(true);
    expect(b.judge(report)).toEqual(['missing callable exports: createGitHubOwnershipSource']);
  });
});
