/**
 * @file guard-bash-no-polling.test.mjs — the NO-POLLING arm of the PreToolUse(Bash) guard.
 *   Incident: a build agent sat ~20 min in a `for … perl select(undef…) … done` loop and had to be killed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decide, pollingLoopReason, heredocScan } from '../guard-bash.mjs';

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
  // Bypass shapes (review of #4170): every wait primitive must be denied however it is spelled.
  // — prefix wrappers in front of sleep
  'nohup sleep 100',
  'env sleep 100',
  'time sleep 100',
  'echo 100 | xargs sleep',
  'xargs -n1 sleep',
  'timeout 200 sleep 100',
  // — a duration that is not a plain in-limit literal is unbounded, never allowed
  'sleep $N',
  'sleep $((60*10))',
  'sleep 1e3',
  'sleep 5 $N',
  'sleep 0x10',
  "perl -e 'sleep $n'",
  "python3 -c 'import time; time.sleep(x)'",
  // — cumulative waits in one command
  'sleep 30 ; sleep 30 ; sleep 30',
  'sleep 20 && echo a && sleep 20',
  // — a loop INSIDE an interpreter one-liner
  "perl -e 'while(1){sleep 1}'",
  "python3 -c 'import time\nwhile 1: time.sleep(1)'",
  "ruby -e 'loop { sleep 1 }'",
  "node -e 'setInterval(()=>{},1000)'",
  "php -r 'while(1){sleep(1);}'",
  // — other interpreters / nested carriers
  "ruby -e 'sleep 100'",
  "awk 'BEGIN{system(\"sleep 100\")}'",
  "while true; do bash -c 'sleep 1'; done",
  "for i in 1 2; do echo $(sleep 5); done",
  // — a heredoc FED to an interpreter is a script, not data
  "bash <<'EOF'\nwhile ! grep -q done x.log; do sleep 60; done\nEOF",
  "python3 - <<'EOF'\nimport time\ntime.sleep(600)\nEOF",
  "sh <<EOF\nsleep 100\nEOF",
  "node - <<'EOF'\nsetTimeout(()=>{},120000)\nEOF",
  // — a standalone timed read blocks as long as a sleep
  'read -t 120 value',
  'read -t $N value',
  'read -r -t 31 value',
  // — the wait is the loop CONDITION, or the loop spins with no sleep word at all
  'while sleep 1; do date; done',
  'until sleep 1; do date; done',
  '! while true; do sleep 1; done',
  'while ! curl -sf localhost:1; do :; done',
  'until [ -f /tmp/x ]; do true; done',
  // — backticks, an eval, a backslash-escaped program, a conditional, a pipe-fed heredoc, a perl/ruby bare statement
  'x=`sleep 100`',
  'eval sleep 100',
  '\\sleep 100',
  'if sleep 100; then echo ok; fi',
  "cat <<'EOM' | bash\nwhile true; do sleep 5; done\nEOM",
  "perl -e 'sleep 100'",
  "python3 -c 'import os; os.system(\"sleep 100\")'",
];
const ALLOWED = [
  // The wait is OUTSIDE the loop (or the loop never waits): no polling loop.
  'for pid in $(pgrep x); do kill $pid; done; sleep 2',
  'sleep 5; while true; do echo x; done',
  'docker compose up -d && sleep 3 && for i in 1 2; do echo $i; done',
  'sleep 1; for f in a b; do echo "$f"; done',
  'for f in a b; do echo "$f"; done; sleep 1',
  'sleep 10 && sleep 10 && sleep 5',
  'sleep 5 2>/dev/null',
  'sleep 5 &',
  'read -t 5 value',
  'read -r -p "go? " -t 10 value',
  // Prose / data that merely MENTIONS a poll loop is not a command.
  "git commit -m \"$(cat <<'EOF'\nuntil x; do sleep 5; done\nEOF\n)\"",
  "cat > notes.md <<'EOF'\nwhile true; do sleep 5; done\nEOF",
  "git commit -m \"perl -e 'sleep 100'\"",
  'echo "nohup sleep 100"',
  // A heredoc fed to an interpreter that does not wait is fine.
  "bash <<'EOF'\necho hi\nEOF",
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "node -e 'console.log(1)'",
  "python3 -c 'import json,sys; print(json.load(sys.stdin))'",
  // A script that merely MENTIONS sleep (data, a text edit, a search) is not a wait.
  "python3 -c \"print('sleep deprivation')\"",
  "echo foo | perl -ne 'print if /sleep/'",
  "awk '/sleep/ {print $1}' f",
  "node -e \"console.log(require('./x').sleep)\"",
  "python3 -c \"import sys\nfor l in sys.stdin:\n if 'sleep' in l: print(l)\"",
  "python3 - <<'EOM'\ns = open('g.mjs').read()\ns = s.replace(\"sleep 100\", \"sleep 10\")\nfor line in s.splitlines():\n    assert 'sleep' in s\nEOM",
  "perl -pi -e 's/sleep 100/sleep 10/' notes.txt",
  // A heredoc given to a script FILE is that script's stdin DATA, not a program.
  "node scripts/foo.mjs <<'EOM'\n{\"title\":\"remove sleep 100 from while loops\"}\nEOM",
  "python3 build.py <<'EOM'\nfor sleep 100\nEOM",
  // Lookups, substitutions counted once, redirections and quoting on a literal.
  'command -v sleep >/dev/null && echo yes',
  'echo $(sleep 20)',
  'x=$(sleep 16)',
  'x=`sleep 16`',
  'sleep 5 2>&1',
  'sleep "5"',
  "sleep '5'",
  'for i in 1 2; do :; done',
  'sleep 100 --help',
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
    expect(pollingLoopReason(c)).toMatch(/POLLING LOOP|exceed/);
    expect(decide(c, {})).toBeTruthy();
  });
  it.each(ALLOWED)('allows: %s', (c) => {
    expect(pollingLoopReason(c)).toBeNull();
  });
  it('the deny message names the sanctioned alternatives', () => {
    const r = pollingLoopReason(INCIDENT);
    expect(r).toMatch(/#5137/);
    expect(r).toMatch(/check --wait=540000/);
    expect(r).toMatch(/report what is still pending/);
  });
  // Incident: two background subagents obeyed "END YOUR TURN and let the harness resume you" and sat idle for
  // hours — nothing resumes a subagent. An agent session must be told: ONE bounded check, then CONTINUE or finish.
  it('an AGENT session is never told to end its turn and wait; it is told to check once, continue, or finish', () => {
    const r = pollingLoopReason(INCIDENT, { agentSession: true });
    expect(r).toMatch(/POLLING LOOP/);
    expect(r).not.toMatch(/END YOUR TURN and let the harness/);
    expect(r).toMatch(/do NOT end your turn to wait/);
    expect(r).toMatch(/ONE bounded check/);
    expect(r).toMatch(/CONTINUE with the next step/);
    expect(r).toMatch(/report what is still pending/);
    expect(r).toMatch(/--wait=/);
  });
  it('the long-sleep and chained-sleep refusals carry the same agent advice', () => {
    for (const c of ['sleep 600', 'sleep 20; sleep 20']) {
      const r = pollingLoopReason(c, { agentSession: true });
      expect(r).toMatch(/exceed/);
      expect(r).toMatch(/CONTINUE with the next step/);
      expect(r).not.toMatch(/END YOUR TURN and let the harness/);
    }
  });
  it('decide() hands agentSession to the arm', () => {
    expect(decide(INCIDENT, { agentSession: true })).toMatch(/CONTINUE with the next step/);
  });
  it('the interactive session never gets "end your turn and let the harness resume you" either', () => {
    expect(pollingLoopReason(INCIDENT)).not.toMatch(/END YOUR TURN and let the harness/);
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
  it('a non-literal duration is reported as unbounded, not allowed', () => {
    expect(pollingLoopReason('sleep $N')).toMatch(/unbounded|non-literal/);
    expect(pollingLoopReason('sleep 1e3')).toMatch(/1000s/);
  });
  it('pathological input is scanned in bounded time (no quadratic blow-up)', () => {
    for (const c of [`sleep${' '.repeat(200000)}`, `sleep ${'9'.repeat(100000)}`, `perl -e '${'select(undef,undef,undef,'.repeat(20000)}'`]) {
      const t0 = Date.now();
      pollingLoopReason(c);
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });
  it('heredocScan keeps the bodies it strips so interpreter-fed ones can be scanned', () => {
    const r = heredocScan("python3 - <<'EOF'\nprint(1)\nEOF\necho done");
    expect(r.text).toBe('python3 - <<\'EOF\'\necho done');
    expect(r.heredocs).toEqual([{ head: "python3 - <<'EOF'", body: 'print(1)' }]);
  });
});

// The heartbeat allowlist is only real if the decide()/CLI path hands run_in_background to the arm (review of
// #4170: replacing ctx.runInBackground with {} in decide() reddened NO test, and would stall every
// /workflow + /conveyor tick loop in production).
describe('heartbeat allowlist — end to end through decide() and the hook CLI', () => {
  const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard-bash.mjs');
  const run = (command, toolInput = {}, extraEnv = {}) => {
    const e = { ...process.env };
    delete e.WE_DISPATCH_KIND;
    delete e.WE_CONVEYOR_WORKER;
    Object.assign(e, extraEnv);
    const out = execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp', tool_input: { command, ...toolInput } }),
      encoding: 'utf8', env: e,
    });
    return out.trim() ? JSON.parse(out.trim().split('\n')[0]) : null;
  };
  it('decide(): a bare background sleep <= 120 passes, the same sleep in the foreground is denied', () => {
    expect(decide('sleep 120', { runInBackground: true })).toBeNull();
    expect(decide('sleep 120', { runInBackground: false })).toMatch(/exceed/);
    expect(decide('sleep 120', {})).toMatch(/exceed/);
  });
  it('decide(): backgrounding does not launder a loop or an over-limit sleep', () => {
    expect(decide('sleep 121', { runInBackground: true })).toMatch(/exceed/);
    expect(decide('while true; do sleep 60; done', { runInBackground: true })).toMatch(/POLLING LOOP/);
  });
  it('CLI: tool_input.run_in_background:true lets the heartbeat through', () => {
    expect(run('sleep 120', { run_in_background: true })).toBeNull();
  });
  it('CLI: the same payload without the flag is denied', () => {
    const r = run('sleep 120');
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/exceed/);
  });
  it('CLI: a dispatched worker (WE_CONVEYOR_WORKER=1) gets the continue-or-finish advice', () => {
    const r = run(INCIDENT, {}, { WE_CONVEYOR_WORKER: '1' });
    expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/CONTINUE with the next step/);
    expect(r.hookSpecificOutput.permissionDecisionReason).not.toMatch(/END YOUR TURN and let the harness/);
  });
  it('CLI: a polling loop is denied even with run_in_background:true', () => {
    const r = run('while true; do sleep 60; done', { run_in_background: true });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
