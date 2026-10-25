import b from './ready-red-team-blocked-pr-enqueued.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
// Sweep-to-enqueue regression: scripts/lib/__tests__/drain-merge-strategy.test.mjs
// "the runner label sweep never removes a label-only red-team:pending hold, so the next enqueue still refuses".
defineBreakTest(b);
