import b from './same-content-head-move-voids-carry.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
// This shipped fix must stay green even when its independent presence probe refuses.
defineBreakTest(b);
