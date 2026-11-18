import { it, expect } from 'vitest';
import { failedCodeQLCheck } from '../codeql-gate.mjs';

it.each([null, 'SKIPPED', 'NEUTRAL', 'CANCELLED', 'STALE'])('CodeQL remains failed during a non-successful rerun (%s)', conclusion => {
  const failed = { name: 'CodeQL', workflow_id: 1, status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-28T01:00:00Z' };
  const rerun = { ...failed, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, startedAt: '2026-10-28T02:00:00Z' };
  const success = { ...failed, conclusion: 'SUCCESS', startedAt: '2026-10-28T03:00:00Z' };
  for (const rows of [[failed, rerun], [rerun, failed]]) expect(failedCodeQLCheck({ statusCheckRollup: rows })).toBe(failed);
  for (const rows of [[failed, rerun, success], [success, rerun, failed]]) expect(failedCodeQLCheck({ statusCheckRollup: rows })).toBeNull();
});
it.each([undefined, 'same display', 'different display'])('CodeQL cannot accept display-only identity (%s)', workflowName => {
  const failed = { name: 'CodeQL', workflowName: 'same display', conclusion: 'FAILURE', startedAt: '2026-10-28T01:00:00Z' };
  const passed = { ...failed, workflowName, conclusion: 'SUCCESS', startedAt: '2026-10-28T02:00:00Z' };
  for (const rows of [[failed, passed], [passed, failed]]) expect(failedCodeQLCheck({ statusCheckRollup: rows })).toBe(failed);
});
