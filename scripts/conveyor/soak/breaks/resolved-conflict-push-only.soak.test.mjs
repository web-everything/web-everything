// @vitest-environment node
import b from './resolved-conflict-push-only.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);
