/**
 * @file guard-bash-no-polling.test.mjs — the NO-POLLING arm of the PreToolUse(Bash) guard.
 *   Incident: a build agent sat ~20 min in a `for … perl select(undef…) … done` loop and had to be killed.
 */
import { describe, it, expect } from 'vitest';
import { decide, pollingLoopReason } from '../guard-bash.mjs';

const INCIDENT = `for i in $(seq 1 38); do if grep -q "fix-dispatch done" ~/.claude/conveyor/fix-dispatch-daemon.log; then break; fi; perl -e 'select(undef,undef,undef,30)'; done`;

const DENIED = [
  INCIDENT,
  "perl -e 'sleep 330'",
  "until grep -q ok x.log; do perl -e 'sleep 120'; done",
  'while true; do sleep 1; done',
  'sleep 31',
  'sleep 1m',
  'sleep infinity',
  "node -e 'setTimeout(()=>{},60000)'",
  "for i in 1 2; do node -e 'setTimeout(r=>r,1000)'; done",
  "python3 -c 'import time; time.sleep(90)'",
  'while read -t 5 l; do echo $l; done',
  "bash -c 'until [ -f /tmp/x ]; do sleep 2; done'",
  "timeout 580 bash -c 'until [ -f /tmp/x ]; do sleep 5; done'",
];
const ALLOWED = [
  'sleep 5',
  'sleep 30',
  'for f in scripts/*.mjs; do node --check $f; done',
  'for f in a b; do git commit -m "sleep 100"; done',
  'while read l; do echo "$l"; done < file.txt',
  'node scripts/verify-lane.mjs check --wait=540000 --json --repo=.',
  'node scripts/verify-lane.mjs request',
  "perl -e 'print 1'",
  'git commit -m "until x; do sleep 5; done"',
];

describe('pollingLoopReason / decide — no polling', () => {
  it.each(DENIED)('denies: %s', (c) => {
    expect(pollingLoopReason(c)).toMatch(/POLLING LOOP|exceeds/);
    expect(decide(c, {})).toBeTruthy();
  });
  it.each(ALLOWED)('allows: %s', (c) => {
    expect(pollingLoopReason(c)).toBeNull();
  });
  it('the deny message names the sanctioned alternatives', () => {
    const r = pollingLoopReason(INCIDENT);
    expect(r).toMatch(/END YOUR TURN/);
    expect(r).toMatch(/#5137/);
    expect(r).toMatch(/check --wait=540000/);
    expect(r).toMatch(/report what is still pending/);
  });
  it('applies to every session kind (no agent scoping)', () => {
    expect(decide(INCIDENT, { agentSession: false })).toBeTruthy();
    expect(decide(INCIDENT, { agentSession: true })).toBeTruthy();
  });
  it('allowlist: bare background heartbeat sleep <= 120 only', () => {
    expect(pollingLoopReason('sleep 120', { runInBackground: true })).toBeNull();
    expect(pollingLoopReason('sleep 121', { runInBackground: true })).toBeTruthy();
    expect(pollingLoopReason('sleep 120', { runInBackground: false })).toBeTruthy();
    expect(pollingLoopReason('while true; do sleep 60; done', { runInBackground: true })).toBeTruthy();
  });
  it('the limit is a setting', () => {
    expect(pollingLoopReason('sleep 45', { settings: { maxSleepSeconds: 60, heartbeatMaxSeconds: 0 } })).toBeNull();
  });
});
