/**
 * @file guard-bash-wait-poll.test.mjs — #x36vidg: the agent WAIT-POLL arm of the PreToolUse(Bash) guard.
 *   Positive cases are real commands lifted from 2026-09-24/25 session transcripts (paths shortened); the
 *   negatives are the shapes that MUST keep passing (one-shot reads, non-PR/CI loops, the interactive session).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { waitPollKind, agentWaitPollReason, interactiveWaitPollNudge, decide } from '../guard-bash.mjs';

const T = '/private/tmp/claude-501/-Users-x-workspace-webeverything/b2b9df0b/tasks';

// Real PR/CI polls (lane-worker subagents).
const PR_POLLS = [
  `for i in $(seq 1 40); do\n  state=$(gh pr view 2583 --json state,mergedAt,mergeCommit -q '.state + "|" + (.mergedAt // "null")' 2>&1)\n  echo "[$i] $state"\n  if echo "$state" | grep -q '^MERGED'; then echo "MERGED"; break; fi\n  sleep 15\ndone`,
  `for i in $(seq 1 90); do\n  info=$(gh pr view 2593 --repo web-everything/web-everything --json state,labels,mergedAt 2>/dev/null)\n  state=$(echo "$info" | python3 -c "import json,sys; print(json.load(sys.stdin)['state'])")\n  [ "$state" = MERGED ] && break\n  sleep 10\ndone`,
  `until gh pr checks 2610 --repo web-everything/web-everything | grep -qv pending; do sleep 30; done`,
  `while true; do s=$(gh pr view 2641 --json statusCheckRollup -q '.statusCheckRollup[].conclusion'); echo "$s" | grep -q SUCCESS && break; sleep 20; done`,
  `for i in 1 2 3 4 5; do gh api repos/web-everything/web-everything/commits/b798c7490/check-runs --jq '.check_runs[].status'; sleep 60; done`,
  `while gh run list --branch lane/x --json status -q '.[0].status' | grep -q in_progress; do sleep 20; done`,
  `gh pr checks 2610 --repo web-everything/web-everything --watch 2>&1 | tail -40`,
  `gh run watch 123456`,
];

// Real background-output polls (review agents + lane workers).
const TASK_POLLS = [
  `F=${T}/bnu77l1c4.output; until grep -q "exit=" $F 2>/dev/null; do sleep 5; done; cat $F`,
  `out=${T}/bswrog0fe.output\nuntil grep -qE "pull/[0-9]+|error:|landed|merged" "$out" 2>/dev/null; do\n  sleep 8\ndone\ntail -80 "$out"`,
  `for i in $(seq 1 55); do if ! kill -0 62315 2>/dev/null; then break; fi; /bin/sleep 10; done; cat ${T}/b4w0p5xh4.output`,
  `timeout 580 bash -c 'f="${T}/bbowkjm51.output"; until [ -s "$f" ] && tail -c 200 "$f" | grep -qiE "verdict|pass"; do sleep 5; done; echo done'`,
  `for i in $(seq 1 30); do wc -l ~/.claude/projects/x/abc/subagents/agent-a1.jsonl; sleep 20; done`,
];

// Must keep passing in EVERY session kind.
const ALLOWED = [
  'gh pr view 2583 --json state,labels,mergedAt',
  'gh pr checks 2610 --repo web-everything/web-everything',
  'gh pr view 12 --json statusCheckRollup',
  `cat ${T}/bnu77l1c4.output`,
  'until curl -sf http://localhost:4000/ >/dev/null; do sleep 1; done',
  'for i in $(seq 1 20); do node scripts/verify-lane.mjs check --json && break; sleep 30; done',
  'while [ ! -f /tmp/lock ]; do sleep 2; done',
  'for f in backlog/*.md; do gh pr list --search "$f"; done',
  'git commit -m "until gh pr view 1 merged; do sleep 5; done"',
  'sleep 20 && gh pr view 2597 --json state',
];

describe('waitPollKind (#x36vidg)', () => {
  it.each(PR_POLLS)('classifies a PR/CI poll: %s', (c) => expect(waitPollKind(c)).toBe('pr-ci'));
  it.each(TASK_POLLS)('classifies a background-output poll: %s', (c) => expect(waitPollKind(c)).toBe('task-output'));
  it.each(ALLOWED)('leaves a non-poll alone: %s', (c) => expect(waitPollKind(c)).toBeNull());
  it('ignores a poll quoted inside a heredoc body (data, not a command)', () => {
    expect(waitPollKind("cat > notes.md <<'EOF'\nuntil gh pr view 1; do sleep 5; done\nEOF")).toBeNull();
  });
});

describe('session scoping', () => {
  it('denies in an agent session, with the actionable reason', () => {
    expect(agentWaitPollReason(PR_POLLS[0], { agentSession: true })).toMatch(/drain\/pr-watch owns merge\+CI; report and exit/);
    expect(agentWaitPollReason(TASK_POLLS[0], { agentSession: true })).toMatch(/you will be notified on completion.*timeout: 600000/s);
  });
  it('never denies the interactive session — it gets a WARN instead', () => {
    expect(agentWaitPollReason(PR_POLLS[0], { agentSession: false })).toBeNull();
    expect(interactiveWaitPollNudge(PR_POLLS[0], { agentSession: false })).toMatch(/PR\/CI/);
    expect(interactiveWaitPollNudge(TASK_POLLS[0], { agentSession: false })).toMatch(/background task/);
    expect(interactiveWaitPollNudge(PR_POLLS[0], { agentSession: true })).toBeNull();
  });
  it('decide() only fires the arm with ctx.agentSession', () => {
    expect(decide(PR_POLLS[1], { agentSession: true })).toMatch(/WAIT-POLL/);
    expect(decide(PR_POLLS[1], {})).toMatch(/POLLING LOOP/); // the generic no-polling arm now covers every session
    for (const c of ALLOWED) expect(decide(c, { agentSession: true }) || '').not.toMatch(/WAIT-POLL|SLEEP-POLL/);
  });
});

// The real hook boundary: PreToolUse JSON on stdin, exactly as Claude Code sends it.
describe('CLI — live PreToolUse payloads', () => {
  const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard-bash.mjs');
  const run = (command, extra = {}, env = {}) => {
    const e = { ...process.env, ...env };
    delete e.WE_DISPATCH_KIND;
    delete e.WE_CONVEYOR_WORKER;
    Object.assign(e, env);
    const out = execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp', tool_input: { command }, ...extra }),
      encoding: 'utf8', env: e,
    });
    return out.trim() ? JSON.parse(out.trim().split('\n')[0]) : null;
  };
  it('denies a subagent (agent_id on the payload)', () => {
    const r = run(PR_POLLS[0], { agent_id: 'a87d6abcef9cf44cb', agent_type: 'general-purpose' });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('denies a dispatched worker (WE_DISPATCH_KIND)', () => {
    const r = run(TASK_POLLS[0], {}, { WE_DISPATCH_KIND: 'fix' });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });
  // xgqz204 — a `claude --bg` dispatch (review/fix/ci-heal/stuck-inspect/build) carries no WE_DISPATCH_KIND:
  // `--bg` drops ambient env, and stamping the kind would arm the #3105 verification deny. It carries the
  // worker marker in `--settings` env instead (dispatch-lane-io.mjs#buildAgentArgv), which is what the hook sees.
  it('denies a --bg dispatched worker (WE_CONVEYOR_WORKER=1, no WE_DISPATCH_KIND)', () => {
    for (const c of [TASK_POLLS[0], PR_POLLS[0]]) {
      const r = run(c, {}, { WE_CONVEYOR_WORKER: '1' });
      expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
  it('the worker marker alone does NOT arm the #3105 verification deny (fix/ci-heal briefs run verify-lane run)', () => {
    expect(run('node /x/scripts/verify-lane.mjs run --repo=.', {}, { WE_CONVEYOR_WORKER: '1' })).toBeNull();
  });
  it('an unrecognised worker-marker value is not an agent session (warn only)', () => {
    const r = run(PR_POLLS[0], {}, { WE_CONVEYOR_WORKER: '0' });
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/POLLING LOOP/); // not the agent-scoped arm
  });
  it('the interactive session is denied too, by the generic no-polling arm', () => {
    const r = run(PR_POLLS[0]);
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toMatch(/POLLING LOOP/);
  });
  it('passes a one-shot read and a non-PR poll from a subagent', () => {
    expect(run('gh pr view 2583 --json state,labels', { agent_id: 'a1' })).toBeNull();
    expect(run('sleep 5 && curl -sf http://localhost:4000/', { agent_id: 'a1' })).toBeNull();
  });
});
