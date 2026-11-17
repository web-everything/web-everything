/** S5: moving stage thresholds into settings preserves every shipped default and stall boundary. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STUCK_THRESHOLD_MINUTES, stuckThresholdMinutes, evaluateStuckPr } from '../../stuck-pr-watch-core.mjs';
import { readSettings } from '../../../lib/settings-files.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SETTINGS = 'scripts/settings/stuck-pr-watch.json';

export default {
  id: 'stuck-pr-watch-thresholds-settings',
  title: 'settings preserve the four stuck PR defaults and stage stall boundaries',
  card: 'S5 (settings-ization, defaults unchanged)',
  fixedBy: { sha: 'working-tree', where: 'S5', paths: [SETTINGS, 'scripts/conveyor/stuck-pr-watch-core.mjs'] },
  fixPresent: root => existsSync(join(root, SETTINGS)),
  async run({ root = ROOT, log } = {}) {
    const violations = [], observations = [];
    try {
      const literal = { review: 45, fix: 45, approved: 30, conflict: 45 };
      assert.deepEqual(DEFAULT_STUCK_THRESHOLD_MINUTES, literal);
      assert.ok(Object.isFrozen(DEFAULT_STUCK_THRESHOLD_MINUTES));
      assert.deepEqual(JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')).stuckPrWatch.thresholdMinutes, literal);
      const shipped = stuckThresholdMinutes({}, {
        readSettings: () => readSettings({ dir: join(root, 'scripts/settings'), legacyPath: null }),
      });
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
