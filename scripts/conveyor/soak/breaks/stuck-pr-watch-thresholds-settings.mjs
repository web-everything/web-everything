/** S5: moving stage thresholds into settings preserves every shipped default and stall boundary. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STUCK_THRESHOLD_MINUTES, stuckThresholdMinutes, evaluateStuckPr } from '../../stuck-pr-watch-core.mjs';
import { readDeclaredSettings } from '../../../lib/settings-files.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SETTINGS = 'scripts/settings/stuck-pr-watch.json';
const CORE = 'scripts/conveyor/stuck-pr-watch-core.mjs';

export default {
  id: 'stuck-pr-watch-thresholds-settings',
  title: 'settings preserve the four stuck PR defaults and stage stall boundaries',
  card: 'S5 (settings-ization, defaults unchanged)',
  fixedBy: { sha: 'working-tree', where: 'S5', paths: [SETTINGS, 'scripts/conveyor/stuck-pr-watch-core.mjs'] },
  // A deleted settings file is a regression of the installed reader, not an absent fix.
  fixPresent(root) {
    try { return readFileSync(join(root, CORE), 'utf8').includes('readDeclaredSettings'); }
    catch { return false; }
  },
  async run({ root = ROOT, log } = {}) {
    const violations = [], observations = [];
    try {
      const literal = { review: 45, fix: 45, approved: 30, conflict: 45 };
      assert.deepEqual(DEFAULT_STUCK_THRESHOLD_MINUTES, literal);
      assert.ok(Object.isFrozen(DEFAULT_STUCK_THRESHOLD_MINUTES));
      const fileThresholds = JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')).stuckPrWatch.thresholdMinutes;
      assert.deepEqual(fileThresholds, literal);
      // The default reader has module-relative paths and no directory override. Equal
      // shipped/default values alone cannot prove wiring, so pin its import and default.
      const coreSource = readFileSync(join(root, CORE), 'utf8');
      assert.match(coreSource, /^import\s*\{\s*readDeclaredSettings\s*\}\s*from\s*['"]\.\.\/lib\/settings-files\.mjs['"];$/m,
        'production reader imports the shared readDeclaredSettings');
      assert.equal(stuckThresholdMinutes.length, 0, 'production resolver retains default parameters');
      assert.match(coreSource, /^export function stuckThresholdMinutes\(env = process\.env, \{ readSettings: read = readDeclaredSettings,/m,
        'production resolver defaults to readDeclaredSettings without an injected reader');
      // Exercise the production defaults with no WE_STUCK_PR_* environment overrides.
      const production = stuckThresholdMinutes({});
      assert.deepEqual(production, literal, 'production reader preserves all four literal defaults');
      assert.deepEqual(production, fileThresholds, 'production reader matches the declared file thresholds');
      const shipped = stuckThresholdMinutes({}, {
        readSettings: () => readDeclaredSettings({ dir: join(root, 'scripts/settings'), legacyPath: null }),
      });
      assert.equal(stuckThresholdMinutes({}, {
        readSettings: () => ({ stuckPrWatch: { thresholdMinutes: { review: 99 } } }),
      }).review, 99, 'core consumes configured thresholds');
      const missing = stuckThresholdMinutes({}, { readSettings: () => ({}) });
      assert.deepEqual(shipped, literal);
      assert.deepEqual(missing, literal);
      const prs = {
        review: { labels: ['review:pending'] },
        fix: { labels: ['review:changes'] },
        approved: { labels: ['review:accepted'], mergeable: 'MERGEABLE' },
        conflict: { labels: [], mergeable: 'CONFLICTING' },
      };
      const now = Date.parse('2026-11-17T12:00:00Z');
      for (const [stage, minutes] of Object.entries(literal)) {
        for (const thresholds of [undefined, shipped, missing]) {
          for (const delta of [-1, 1]) {
            const result = evaluateStuckPr({ pr: prs[stage], now, thresholds,
              activityAt: new Date(now - (minutes + delta) * 60_000).toISOString() });
            assert.equal(result.stage, stage);
            assert.equal(result.thresholdMinutes, minutes);
            assert.equal(result.stuck, delta > 0, `${stage}: ${minutes + delta} minutes`);
          }
        }
        observations.push(`${stage}: unchanged ${minutes}-minute boundary with shipped or missing settings`);
      }
      log?.(observations.join('\n'));
    } catch (error) { violations.push(error.message); }
    return { violations, observations };
  },
  judge: report => report.violations,
};
