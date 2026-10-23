/** Bounded observations must expose grants that need evidence beyond list + comments. */
import { expect, it } from 'vitest';
import { createJudgeSweepFactsReader } from '../judge-sweep-facts-io.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';

const repo = 'o/r', head = 'a'.repeat(40), at = '2026-10-22T13:00:00Z';
const baseCap = 12;

it.each([
  ['automatic standing grant', 'web-everything[bot]', true, baseCap, true],
  ['operator grant', OPERATOR_LOGINS[0], false, baseCap + 1, false],
  ['untrusted grant', 'untrusted-contributor', true, baseCap, false],
])('keeps %s scope explicit within the list-and-comments budget', (_name, login, standing, cap, incomplete) => {
  const comments = [{ id: 'IC_grant', author: { login }, createdAt: at,
    body: buildRoundExtensionComment({ repo, pr: 1, by: 1, actor: OPERATOR_LOGINS[0],
      channel: 'test', reason: 'one more round', at,
      ...(standing ? { standingRuling: `${repo}#6000`, head, episode: `${repo}#1@${head}:review:12/12` } : {}),
    }) }];
  const calls = [];
  const reader = createJudgeSweepFactsReader({
    gh: args => {
      calls.push(args);
      if (args[0] !== 'pr' || args[1] !== 'list') throw new Error('unexpected extra GitHub read');
      return JSON.stringify([{ number: 1, title: 'scope fixture', headRefOid: head,
        labels: [], assignees: [], updatedAt: at }]);
    },
    now: () => Date.parse(at), baseCap,
    readLedgerRows: () => [], readFixRows: () => [], readJobs: () => [],
    readComments: () => comments,
  });
  const facts = reader({ repo }).prs[0];
  expect(calls).toHaveLength(1);
  expect(facts.cap).toBe(cap);
  expect(facts.evidenceErrors).toEqual(incomplete
    ? ['standing ruling unverified; inspect ruling and grant scope before judging'] : []);
});
