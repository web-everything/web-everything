// @vitest-environment node
import { expect, it } from 'vitest';
import { mainRedState } from '../../conveyor/main-ci-red-core.mjs';
import { readMainCiFact } from '../../merge-gate-check.mjs';
import { decideMainPushSkip } from '../main-push-skip.mjs';
import { readFileSync } from 'node:fs';
const head = 'a'.repeat(40), old = 'b'.repeat(40);
const run = (id, sha, conclusion, event = 'push') => ({ databaseId: id, headSha: sha, conclusion,
  event, status: 'completed', createdAt: `2026-11-20T${id}:00:00Z`, updatedAt: `2026-11-20T${id}:30:00Z` });
const check = (name, conclusion) => ({ id: 1, name, status: 'completed', conclusion });
it.each(['failure', undefined])('required checks cannot hide red main with marker %s', marker => {
  const tip = { sha: head, runStatus: 'completed', requiredChecks: ['test', 'smoke', 'daemon-soak'],
    checkRuns: ['test', 'smoke', 'daemon-soak'].map(name => check(name, 'success')) };
  if (marker) tip.checkRuns.push(check('main-execution', marker));
  expect(mainRedState([run(10, old, 'failure'), run(11, head, 'failure')], { tip }))
    .toMatchObject({ status: 'red', latestRed: { sha: old } });
});
function fact(rows, current = head) {
  return readMainCiFact({ repo: 'fixture/repo', exec: (_, args) => {
    if (args[0] === 'run') {
      const event = args.indexOf('--event');
      return JSON.stringify(event < 0 ? rows : rows.filter(r => r.event === args[event + 1]));
    }
    if (args[1] === 'repos/fixture/repo/git/ref/heads/main') return JSON.stringify({ object: { sha: current } });
    throw Error('unavailable evidence');
  } });
}
it('hourly failure newer than real push success keeps merge admission red', () => {
  expect(fact([run(10, head, 'success'), run(11, head, 'failure', 'schedule')])).toMatchObject({ red: true });
});
it('hourly success proves green for its own current head', () => {
  expect(fact([run(10, head, 'failure'), run(11, head, 'success', 'schedule')])).toMatchObject({ red: false });
});
it('newer-created schedule on an older SHA cannot clear current-head failure', () => {
  expect(fact([run(10, head, 'failure'), run(11, old, 'success', 'schedule')])).toMatchObject({ red: true });
});
it('unknown schedule head evidence fails closed', () => {
  expect(fact([run(11, head, 'success', 'schedule')], null).error).toBeTruthy();
});
it.each([undefined, 'invalid', '2026-11-20T09:00:00Z'])('later job completion cannot renew queue start %s', start => {
  const runs = JSON.parse(readFileSync(new URL('./fixtures/main-push-runs.json', import.meta.url)));
  Object.assign(runs.workflow_runs[0], { run_started_at: start, updated_at: '2026-11-20T11:59:00Z', run_attempt: 2 });
  expect(decideMainPushSkip({ sha: head, before: old, event: 'push', ref: 'refs/heads/main', currentRunId: 101,
    now: Date.parse('2026-11-20T12:00:00Z'), runs, queueFuiSha: old, fuiTip: old, beforeIsAncestor: true,
    env: {}, platform: {}, log: () => {} }).skip).toBe(false);
});

it('unknown run event cannot become green now that the list includes all events', () => {
  expect(fact([{ ...run(11, head, 'success'), event: undefined }]).error).toBeTruthy();
});
it('skipped tip falls through to an older real green push', () => {
  const tip = { sha: head, runStatus: 'completed', requiredChecks: ['test'],
    checkRuns: [check('test', 'success'), check('main-execution', 'failure')] };
  expect(mainRedState([run(10, old, 'success'), run(11, head, 'failure')], { tip }))
    .toMatchObject({ status: 'green', latestGreen: { sha: old } });
});
it('skipped tip preserves real scheduled evidence on the same SHA', () => {
  const tip = { sha: head, runStatus: 'completed', requiredChecks: ['test'],
    checkRuns: [check('test', 'success'), check('main-execution', 'failure')] };
  expect(mainRedState([run(10, head, 'success', 'schedule'), run(11, head, 'failure')], { tip }))
    .toMatchObject({ status: 'green', latestGreen: { runId: 10 } });
});
it('skipped tip without any real execution leaves evidence unknown', () => {
  const tip = { sha: head, runStatus: 'completed', requiredChecks: ['test'], checkRuns: [check('test', 'success')] };
  expect(mainRedState([run(11, head, 'success')], { tip }).status).toBe('unknown');
});
