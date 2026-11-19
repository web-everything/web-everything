import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSecuritySeat } from '../review-loop-cli.mjs';

test('shadow classification logs without changing any seating result', () => {
  const log = mock.method(console, 'error', () => {});
  try {
    for (const files of [['src/main.ts'], ['backlog/a.md']]) {
      const opts = { cardOnly: { lightLane: true, claudeSeat: false }, readChangedFiles: () => files };
      const argv = ['--pr=1', '--repo=example/repo'];
      const without = chooseSecuritySeat(argv, { ...opts, uiFastLane: () => ({ verdict: 'full-panel', reason: 'no-local-checkout' }) });
      const withShadow = chooseSecuritySeat(argv, { ...opts, uiFastLane: () => ({ verdict: 'ui-fast-lane', reason: 'ui-only' }) });
      assert.deepEqual(withShadow, without);
    }
    assert.ok(log.mock.calls.some(c => c.arguments[0] === 'ui-fast-lane would-apply: ui-only'));
    assert.ok(log.mock.calls.some(c => c.arguments[0] === 'ui-fast-lane full-panel: no-local-checkout'));
  } finally { log.mock.restore(); }
});

test('throwing reader never escapes or changes roster, even if touch-set read fails', () => {
  const log = mock.method(console, 'error', () => {});
  try {
    const opts = { cardOnly: { lightLane: false }, readChangedFiles: () => { throw new Error('unreadable'); } };
    const argv = ['--pr=1'];
    const baseline = chooseSecuritySeat(argv, { ...opts, uiFastLane: () => ({ verdict: 'full-panel', reason: 'no-local-checkout' }) });
    assert.deepEqual(chooseSecuritySeat(argv, { ...opts, uiFastLane: () => { throw new Error('secret\nterminal'); } }), baseline);
    assert.equal(log.mock.calls.at(-1).arguments[0], 'ui-fast-lane full-panel: reader-failed');
  } finally { log.mock.restore(); }
});

test('resume and no PR never invoke shadow reader or log it', () => {
  const log = mock.method(console, 'error', () => {});
  try {
    const uiFastLane = () => assert.fail('must not read');
    chooseSecuritySeat([], { uiFastLane, cardOnly: {} });
    chooseSecuritySeat(['--resume=saved', '--pr=1'], { uiFastLane, cardOnly: {}, store: { read: () => ({}) } });
    assert.equal(log.mock.calls.length, 0);
  } finally { log.mock.restore(); }
});
