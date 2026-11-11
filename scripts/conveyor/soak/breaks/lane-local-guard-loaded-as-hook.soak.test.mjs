import b from './lane-local-guard-loaded-as-hook.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

defineBreakTest(b);

const root = new URL('../../../../', import.meta.url).pathname;

describe('lane-local guard break inspects every security hook event', () => {
  it.each(['Stop', 'SubagentStop'])('flags a %s hook reverted to a lane-local guard', async event => {
    const tree = mkdtempSync(join(tmpdir(), 'soak-stop-revert-'));
    const previous = process.env.SOAK_TREE_ROOT;
    try {
      const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
      settings.hooks[event][0].hooks[0].command = 'node scripts/guard-stop-passive-wait.mjs';
      mkdirSync(join(tree, '.claude'));
      writeFileSync(join(tree, '.claude/settings.json'), JSON.stringify(settings));
      mkdirSync(join(tree, 'scripts/hooks'), { recursive: true });
      copyFileSync(join(root, 'scripts/hooks/run-pinned-guard.mjs'), join(tree, 'scripts/hooks/run-pinned-guard.mjs'));
      process.env.SOAK_TREE_ROOT = tree;
      const { violations } = await b.run();
      expect(violations).toContain('hook runs the lane-local script: node scripts/guard-stop-passive-wait.mjs');
    } finally {
      if (previous === undefined) delete process.env.SOAK_TREE_ROOT; else process.env.SOAK_TREE_ROOT = previous;
      rmSync(tree, { recursive: true, force: true });
    }
  });
});
