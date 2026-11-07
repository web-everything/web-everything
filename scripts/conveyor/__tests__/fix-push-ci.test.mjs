import { it, expect } from 'vitest';
import { markFixPushAwaitingCi } from '../fix-push-ci.mjs';
import { resolveHandoffSettings } from '../../lib/handoff-settings.mjs';
it('creates missing CI labels before applying them and supports a same-head retry', () => {
  const labels = new Set();
  let edits = 0;
  const run = (cmd, args) => {
    expect(cmd).toBe('gh');
    expect(args).toContain('--repo=o/r');
    if (args[0] === 'label' && args[1] === 'create') {
      expect(args).toContain('--force');
      labels.add(args[2]);
      return '';
    }
    if (args[1] === 'view') return JSON.stringify({ headRefOid: 'abc', labels: [] });
    if (args[1] === 'edit') {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--add-label' && !labels.has(args[i + 1])) {
          throw new Error(`could not add label: '${args[i + 1]}' not found`);
        }
      }
      edits += 1;
      return '';
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  const push = { repo: 'o/r', pr: 7, head: 'abc' };
  const deps = { run, readNumstat: () => '', recordPush: () => {} };
  expect(markFixPushAwaitingCi(push, deps)).toBe(true);
  expect(markFixPushAwaitingCi(push, deps)).toBe(true);
  expect(labels).toEqual(new Set(['checking', 'status:awaiting-ci']));
  expect(edits).toBe(2);
});
it('labels the pushed head awaiting CI and removes stale red labels', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, readNumstat: () => '', recordPush: () => {} })).toBe(true);
  expect(calls[3]).toEqual(expect.arrayContaining(['--add-label', 'checking', '--add-label', 'status:awaiting-ci', '--remove-label', 'ci:failed', '--remove-label', 'status:ci-red']));
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'moved' }, { run, readNumstat: () => '', recordPush: () => {} })).toBe(false);
  expect(calls).toHaveLength(5);
});
it('retains the push record and stops before editing when label creation fails', () => {
  const push = { repo: 'o/r', pr: 7, head: 'abc' };
  const recorded = [];
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: 'abc', labels: [] });
    throw new Error('label creation unavailable');
  };
  expect(() => markFixPushAwaitingCi(push, { run, readNumstat: () => '', recordPush: value => recorded.push(value) })).toThrow('label creation unavailable');
  expect(recorded).toEqual([push]);
  expect(calls.map(args => args.slice(0, 2))).toEqual([['pr', 'view'], ['label', 'create']]);
});
it('a same-head retry after a required check failed keeps the red verdict and drops only fixer state', () => {
  const calls = [];
  const rollup = [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', context: 'smoke', state: 'PENDING' },
  ];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', statusCheckRollup: rollup, labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }, { name: 'status:fixing' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, readNumstat: () => '', recordPush: () => {}, readRequired: () => ['test', 'smoke'] })).toBe(false);
  expect(calls.map(a => a.slice(0, 2))).toEqual([['pr', 'view'], ['pr', 'edit']]);
  expect(calls[1]).toEqual(['pr', 'edit', '7', '--repo=o/r', '--remove-label', 'status:fixing']);
});
it('a same-head retry after CI went green drops the previous head\'s red labels without re-handing to CI', () => {
  const calls = [];
  const rollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'smoke', state: 'SUCCESS' }];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', statusCheckRollup: rollup, labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, readNumstat: () => '', recordPush: () => {}, readRequired: () => ['test', 'smoke'] })).toBe(false);
  expect(calls[1]).toEqual(['pr', 'edit', '7', '--repo=o/r', '--remove-label', 'ci:failed', '--remove-label', 'status:ci-red']);
});
it('headCiVerdict judges required checks only: partial, unknown and missing-status rows are pending', async () => {
  const { headCiVerdict, readRequiredChecksSafe } = await import('../fix-push-ci.mjs');
  const run = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, ...(conclusion ? { conclusion } : {}) });
  const req = ['test', 'smoke'];
  expect(headCiVerdict(undefined, req)).toBe('pending');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS')], req)).toBe('pending'); // smoke never reported
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), run('smoke', 'COMPLETED', 'SUCCESS')], [])).toBe('pending');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), { name: 'smoke' }], req)).toBe('pending');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), run('smoke', 'COMPLETED', 'NEUTRAL'), run('merge-gate', 'COMPLETED', 'FAILURE')], req)).toBe('green');
  expect(headCiVerdict([run('test', 'COMPLETED', 'TIMED_OUT'), run('smoke', 'QUEUED')], req)).toBe('red');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), { __typename: 'StatusContext', context: 'smoke', state: 'ERROR' }], req)).toBe('red');
  expect(readRequiredChecksSafe('o/r', () => { throw new Error('403'); })).toEqual([]);
});
it('a held merge-gate (a review or freeze hold, not CI) is never a red verdict under the live required set', async () => {
  const { headCiVerdict } = await import('../fix-push-ci.mjs');
  const live = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
  const row = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, ...(conclusion ? { conclusion } : {}) });
  const queued = [row('test', 'QUEUED'), row('smoke', 'QUEUED'), row('daemon-soak', 'QUEUED')];
  expect(headCiVerdict([...queued, row('merge-gate', 'COMPLETED', 'FAILURE'), row('soak-replay-gate', 'IN_PROGRESS')], live)).toBe('pending');
  const green = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(n => row(n, 'COMPLETED', 'SUCCESS'));
  // A failing merge-gate never decides red, but blocks green: the head stays pending (an ordinary hand-off).
  expect(headCiVerdict([...green, row('merge-gate', 'COMPLETED', 'FAILURE')], live)).toBe('pending');
  expect(headCiVerdict([...green, row('merge-gate', 'COMPLETED', 'SUCCESS')], live)).toBe('green');
  expect(headCiVerdict([...green.slice(1), row('test', 'COMPLETED', 'FAILURE'), row('merge-gate', 'IN_PROGRESS')], live)).toBe('red');
  // A required set replaces the shared exclusion list: a required soak-replay-gate failure is CI red.
  expect(headCiVerdict([...green.slice(0, 3), row('soak-replay-gate', 'COMPLETED', 'FAILURE'), row('merge-gate', 'COMPLETED', 'SUCCESS')], live)).toBe('red');
});
it('a finished verdict also clears an earlier hand-off\'s waiting labels', async () => {
  const { fixPushLabelPlan } = await import('../fix-push-ci.mjs');
  const present = ['checking', 'status:awaiting-ci', 'ci:failed', 'status:ci-red', 'status:awaiting-review'];
  expect(fixPushLabelPlan(present, 'green')).toEqual({ handOff: false, remove: ['checking', 'status:awaiting-ci', 'ci:failed', 'status:ci-red'] });
  expect(fixPushLabelPlan(present, 'red')).toEqual({ handOff: false, remove: ['checking', 'status:awaiting-ci', 'status:awaiting-review'] });
  expect(fixPushLabelPlan(present, 'pending').handOff).toBe(true);
});
it('resolves missing-CI timing per leaf through the cascade', () => {
  const out = resolveHandoffSettings('fix', { tool: { ciMissingAfterPushMin: 12 }, platform: { ciMissingAfterPushMin: 15, sendBackReservedSlots: 2 }, env: {} });
  expect(out.value).toEqual({ ciMissingAfterPushMin: 12, sendBackReservedSlots: 2 });
  expect(out.sources).toMatchObject({ ciMissingAfterPushMin: 'tool', sendBackReservedSlots: 'platform' });
});

import { recordFixPush, readFixPush } from '../fix-push-state.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
it('ages missing CI from the push, preserving that time on a same-head retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-push-'));
  try {
    const key = { repo: 'o/r', pr: 7, head: 'abc' };
    const first = recordFixPush(key, { dir, now: () => 1000 });
    expect(recordFixPush(key, { dir, now: () => 60_000 })).toEqual(first);
    expect(readFixPush({ ...key, head: 'other' }, { dir })).toBeNull();
    expect(recordFixPush({ ...key, head: 'other' }, { dir, now: () => 60_000 }).pushedAt).toBe(new Date(60_000).toISOString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


const sizePush = { repo: 'o/r', pr: 7, head: 'abc' };
function sizeHarness({ labels = [], readNumstat, filesOutput, repo = 'o/r', fail } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    expect(cmd).toBe('gh');
    calls.push(args);
    if (fail?.(args)) throw new Error('size write failed');
    if (args[0] === 'api' || (args[1] === 'view' && args.at(-1) === 'files')) return filesOutput;
    if (args[1] === 'view') return JSON.stringify({ headRefOid: 'abc', labels });
    return '';
  };
  const invoke = () => markFixPushAwaitingCi({ ...sizePush, repo }, {
    run, recordPush: () => {}, ...(readNumstat ? { readNumstat } : {}),
  });
  return { calls, invoke };
}
const sizeComments = calls => calls.filter(a => a[1] === 'comment');
const sizeAdds = calls => calls.filter(a => a[1] === 'edit' && a.includes('--add-label') && a.includes('size:over-cap'));
const expectCiHandoff = calls => expect(calls.at(-1)).toEqual([
  'pr', 'edit', '7', '--repo=o/r', '--add-label', 'checking', '--add-label', 'status:awaiting-ci',
]);

it('crossing 300 lines labels and posts one visible split plan without closing the PR', () => {
  const { calls, invoke } = sizeHarness({ readNumstat: () => '200\t0\tsrc/a.mjs\n101\t0\tdocs/b.md\n' });
  expect(invoke()).toBe(true);
  expect(calls[1]).toEqual(['label', 'create', 'size:over-cap', '--repo=o/r', '--color', 'd93f0b', '--description',
    'PR grew over the 300 non-test line cap: split plan proposed — auto-managed', '--force']);
  expect(sizeAdds(calls)).toHaveLength(1);
  expect(sizeComments(calls)).toHaveLength(1);
  const comment = sizeComments(calls)[0];
  expect(comment.slice(0, -1)).toEqual(['pr', 'comment', '7', '--repo=o/r', '--body']);
  expect(comment.at(-1)).toContain('pr-size-over-cap');
  expect(comment.at(-1)).toContain('301 non-test lines');
  expect(comment.at(-1)).toContain('File groups:');
  expect(comment.at(-1)).toContain('we:src/a.mjs: 200');
  expect(comment.at(-1)).toContain('we:docs/b.md: 101');
  expect(comment.at(-1)).toContain('Proposed: split into the file groups above; the PR is not closed and review continues.');
  expect(calls.some(a => a.includes('close'))).toBe(false);
  expectCiHandoff(calls);
});
it('already flagged growth does not post a second event or re-add the label', () => {
  const { calls, invoke } = sizeHarness({ labels: ['size:over-cap'], readNumstat: () => '301\t0\tsrc/a.mjs\n' });
  expect(invoke()).toBe(true);
  expect(sizeComments(calls)).toEqual([]);
  expect(sizeAdds(calls)).toEqual([]);
  expectCiHandoff(calls);
});
it.each([299, 300])('at %s lines does not flag or comment', lines => {
  const { calls, invoke } = sizeHarness({ readNumstat: () => `${lines}\t0\tsrc/a.mjs\n` });
  expect(invoke()).toBe(true);
  expect(calls).toHaveLength(4);
  expect(sizeAdds(calls)).toEqual([]);
  expect(sizeComments(calls)).toEqual([]);
});
it.each([
  ['reader throws', () => { throw new Error('read failed'); }],
  ['binary row', () => '-\t-\timage.png\n'],
  ['truncated row', () => '1\t0\tsrc/a.mjs'],
  ['failed read object', () => ({ status: 1, stdout: '' })],
])('fails closed for %s with an unknown event and CI hand-off', (name, readNumstat) => {
  const { calls, invoke } = sizeHarness({ readNumstat });
  expect(invoke()).toBe(true);
  expect(sizeAdds(calls)).toHaveLength(1);
  expect(sizeComments(calls)).toHaveLength(1);
  expect(sizeComments(calls)[0].at(-1)).toContain('pr-size-unmeasurable');
  expect(sizeComments(calls)[0].at(-1)).toContain('unknown');
  expect(sizeComments(calls)[0].at(-1)).toContain('human review of the full diff is required');
  expectCiHandoff(calls);
});
it('removes the size label when back under cap', () => {
  const { calls, invoke } = sizeHarness({ labels: ['size:over-cap'], readNumstat: () => '' });
  expect(invoke()).toBe(true);
  expect(calls[1]).toEqual(['pr', 'edit', '7', '--repo=o/r', '--remove-label', 'size:over-cap']);
  expect(sizeComments(calls)).toEqual([]);
  expectCiHandoff(calls);
});
it.each(['create', 'edit', 'comment'])('size %s failure still completes the CI hand-off before rethrowing', operation => {
  const { calls, invoke } = sizeHarness({ readNumstat: () => '301\t0\tsrc/a.mjs\n',
    fail: a => a[1] === operation && (a.includes('size:over-cap') || operation === 'comment'),
  });
  expect(invoke).toThrow('size write failed');
  expectCiHandoff(calls);
});
it('size removal failure still completes CI hand-off', () => {
  const { calls, invoke } = sizeHarness({ labels: ['size:over-cap'], readNumstat: () => '',
    fail: a => a.includes('--remove-label') && a.includes('size:over-cap'),
  });
  expect(invoke).toThrow('size write failed');
  expectCiHandoff(calls);
});
it.each([
  ['over-cap', '301\t0\tsrc/a.mjs\n', 'pr-size-over-cap'],
  ['unknown', '-\t-\timage.png\n', 'pr-size-unmeasurable'],
])('retries a failed %s event comment before applying the size label', (name, numstatText, event) => {
  const labels = new Set();
  const delivered = [];
  const calls = [];
  let commentAttempts = 0;
  const run = (cmd, args) => {
    expect(cmd).toBe('gh');
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: 'abc', labels: [...labels] });
    if (args[1] === 'comment') {
      if (++commentAttempts === 1) throw new Error('comment unavailable');
      delivered.push(args.at(-1));
    }
    if (args[1] === 'edit') {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--add-label') labels.add(args[i + 1]);
        if (args[i] === '--remove-label') labels.delete(args[i + 1]);
      }
    }
    return '';
  };
  const deps = { run, recordPush: () => {}, readNumstat: () => numstatText };
  expect(() => markFixPushAwaitingCi(sizePush, deps)).toThrow('comment unavailable');
  expectCiHandoff(calls);
  expect(labels).toEqual(new Set(['checking', 'status:awaiting-ci']));
  expect(delivered).toEqual([]);
  expect(sizeAdds(calls)).toEqual([]);

  // Retry against the actual labels persisted by the failed invocation.
  expect(markFixPushAwaitingCi(sizePush, deps)).toBe(true);
  expectCiHandoff(calls);
  expect(labels).toEqual(new Set(['checking', 'status:awaiting-ci', 'size:over-cap']));
  expect(commentAttempts).toBe(2);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain(event);
  expect(delivered[0]).toContain('Proposed: split into the file groups above; the PR is not closed and review continues.');
  expect(calls.indexOf(sizeComments(calls)[1])).toBeLessThan(calls.indexOf(sizeAdds(calls)[0]));

  expect(markFixPushAwaitingCi(sizePush, deps)).toBe(true);
  expectCiHandoff(calls);
  expect(commentAttempts).toBe(2);
  expect(delivered).toHaveLength(1);
  expect(sizeAdds(calls)).toHaveLength(1);
});
it('default reader uses paginated API numstat with the repo and PR', () => {
  const { calls, invoke } = sizeHarness({ filesOutput: '301\t0\tsrc/a.mjs\n' });
  expect(invoke()).toBe(true);
  expect(calls[1]).toEqual(['api', '--paginate', 'repos/o/r/pulls/7/files', '--jq', '.[]|"\\(.additions)\\t\\(.deletions)\\t\\(.filename)"']);
  expect(sizeAdds(calls)).toHaveLength(1);
});
it('default reader without a repo uses gh pr view files', () => {
  const { calls, invoke } = sizeHarness({ repo: '', filesOutput: JSON.stringify({ files: [{ additions: 301, deletions: 0, path: 'src/a.mjs' }], changedFiles: 1 }) });
  expect(invoke()).toBe(true);
  expect(calls[1]).toEqual(['pr', 'view', '7', '--json', 'files,changedFiles']);
  expect(sizeAdds(calls)).toHaveLength(1);
});
it('default reader fails closed at the 3000-file API cap with human review fallback', () => {
  const { calls, invoke } = sizeHarness({ filesOutput: '0\t0\tsrc/a.mjs\n'.repeat(3000) });
  expect(invoke()).toBe(true);
  expect(sizeAdds(calls)).toHaveLength(1);
  expect(sizeComments(calls)[0].at(-1)).toContain('pr-size-unmeasurable');
  expect(sizeComments(calls)[0].at(-1)).toContain('human review of the full diff is required');
  expectCiHandoff(calls);
});
it('fails closed when the no-repo file list is partial (default reader) and keeps the size label', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    if (args[1] === 'view' && args.includes('headRefOid,labels,statusCheckRollup')) {
      return JSON.stringify({ headRefOid: 'abc', labels: ['size:over-cap'] });
    }
    if (args[1] === 'view' && args.includes('files,changedFiles')) {
      return JSON.stringify({ files: [{ path: 'a.mjs', additions: 1, deletions: 0 }], changedFiles: 250 });
    }
    return '';
  };
  markFixPushAwaitingCi({ pr: 7, head: 'abc' }, { run, recordPush: () => {} });
  expect(calls.some(args => args.includes('--remove-label') && args.includes('size:over-cap'))).toBe(false);
});
