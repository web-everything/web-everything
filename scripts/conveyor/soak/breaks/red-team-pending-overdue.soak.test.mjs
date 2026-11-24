import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import scenario from './red-team-pending-overdue.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(scenario);

it.each(['never-alert', 'always-alert', 'updated-at-age'])('fixPresent does not mask deterministic %s regression', async regression => {
  const root = mkdtempSync(join(tmpdir(), 'pending-soak-'));
  try {
    const dir = join(root, 'scripts/conveyor/health-smells');
    mkdirSync(dir, { recursive: true });
    const breach = regression === 'never-alert' ? 'false' : regression === 'always-alert' ? 'true'
      : 'now - Date.parse(pr.updatedAt) >= 40 * 60000';
    writeFileSync(join(dir, 'red-team-pending-overdue.mjs'), `export default {
      id: 'red-team-pending-overdue', openAfter: 1, closeAfter: 1,
      evaluate({prs}, {now}) { return prs.map(pr => ({subject: 'example/project#1@abcdef1', breach: ${breach}})); }
    };`);
    expect(scenario.fixPresent(root)).toBe(true);
    expect(scenario.judge(await scenario.run({ sourceRoot: root })).length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
