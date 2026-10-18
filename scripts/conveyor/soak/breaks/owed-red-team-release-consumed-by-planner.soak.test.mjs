import b from './owed-red-team-release-consumed-by-planner.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

// Includes repeated runner ticks in both CLI modes before the daemon's one saved-result completion.
defineBreakTest(b);
