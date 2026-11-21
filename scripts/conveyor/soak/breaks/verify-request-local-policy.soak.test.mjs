import { defineBreakTest } from '../define-break-test.mjs';
import localPolicy from './verify-request-local-policy.mjs';

defineBreakTest(localPolicy);
