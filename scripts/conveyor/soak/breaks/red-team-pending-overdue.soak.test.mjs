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


it.each(['missing', 'syntax', 'throws', 'capability', 'unreadable-result'])('fixPresent refuses to expected-fail an import/capability failure: %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'pending-import-'));
  try {
    const dir = join(root, 'scripts/conveyor/health-smells');
    mkdirSync(dir, { recursive: true });
    const sources = { syntax: 'export default {', throws: "throw new Error('import failed');",
      capability: "export default { id: 'red-team-pending-overdue' };",
      'unreadable-result': "export default { id: 'red-team-pending-overdue', evaluate() { return null; } };" };
    if (mode !== 'missing') writeFileSync(join(dir, 'red-team-pending-overdue.mjs'), sources[mode]);
    expect(scenario.fixPresent(root)).toBe(true);
    expect(scenario.judge(await scenario.run({ sourceRoot: root })).length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.each(['never-alert', 'always-alert'])('wrong id cannot mask a behavioral regression: %s', async regression => {
  const root = mkdtempSync(join(tmpdir(), 'pending-wrong-id-'));
  try {
    const dir = join(root, 'scripts/conveyor/health-smells');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'red-team-pending-overdue.mjs'), `export default { id: 'old-smell',
      evaluate({prs}) { return prs.map(() => ({subject: 'example/project#1@abcdef1', breach: ${regression === 'always-alert'}})); } };`);
    expect(scenario.fixPresent(root)).toBe(true);
    expect(scenario.judge(await scenario.run({ sourceRoot: root })).length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
