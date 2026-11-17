import { expect, it } from 'vitest';
import b, { liveHolderContention } from './host-handoff-cache-write-race.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

it('live holder paused over 1s completes after fencing; preflight reports the retained lock', async () => {
  expect((await liveHolderContention()).violations).toEqual([]);
}, 15000);
