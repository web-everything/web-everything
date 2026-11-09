/** @file merge-ai-prs-mq-failure-route-hook.test.mjs — R772: the same-head hold routes real MQ failures to the fixer. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../merge-ai-prs.mjs', import.meta.url)), 'utf8');

describe('merge-ai-prs mq-failure route hook', () => {
  it('calls routeMqFailureOnHold inside the mq-same-head-failed hold, before returning the decline', () => {
    const hold = src.indexOf('if (guard.hold) {');
    const route = src.indexOf('routeMqFailureOnHold', hold);
    const decline = src.indexOf("kind: 'mq-same-head-failed'", hold);
    expect(hold).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(hold);
    expect(decline).toBeGreaterThan(route);
  });
  it('is best-effort, dry-run aware and never blocks the decline', () => {
    const block = src.slice(src.indexOf('if (guard.hold) {'), src.indexOf("kind: 'mq-same-head-failed'"));
    expect(block).toContain('dryRun: DRY_RUN');
    expect(block).toContain('.catch(() => {})');
    expect(block).not.toContain('await ');
  });
});
