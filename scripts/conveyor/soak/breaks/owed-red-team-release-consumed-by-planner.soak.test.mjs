import b from './owed-red-team-release-consumed-by-planner.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

// Includes repeated automated runner ticks and manual overrides in both CLI modes before saved-result completion.
defineBreakTest(b);
