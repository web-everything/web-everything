/**
 * @file fleet.mjs — #4075 daemon soak harness (card x0zg44l). The fake-GitHub PR fleet a soak starts with: one
 * PR in each state the live daemons meet every day. Each entry says what work it OWES (and so which daemon must
 * dispatch it — `invariants.mjs#OWED_KIND_DAEMON`), or `null` when the daemons must leave it alone.
 *
 * Real branches on the world's bare origin (`w.git.createBranch`), so every `gh pr diff`/mergeability read the
 * daemons make resolves against real git.
 */

import { FALLBACK_REQUIRED_STATUS_CHECKS } from '../../lib/required-status-checks.mjs';

/** @typedef {{key:string, owes:(null|'review'|'fix'|'ci-heal'), pr:number, note:string}} FleetPr */

// The branch-protection required set the fake GitHub serves (the live set, `required-status-checks.mjs`'s
// fallback). A PR owes a review only once EVERY required check succeeded on its head, so GREEN covers them all.
// Derived from the fallback, never retyped: `pr-state-io.mjs` reads the declared fallback when the fake `gh` serves no
// `protection/required_status_checks`, so a hand-copied set goes stale the moment the fallback changes.
const REQUIRED = [...FALLBACK_REQUIRED_STATUS_CHECKS];
const GREEN = REQUIRED.map((name) => ({ name, conclusion: 'SUCCESS' }));
const RED = [{ name: 'test', conclusion: 'FAILURE' }];

/**
 * Seed the default fleet into world `w`.
 * @returns {FleetPr[]}
 */
export function seedDefaultFleet(w) {
  const out = [];
  w.gh.setRequiredChecks('we', REQUIRED);
  const add = (key, owes, note, { files, labels = [], checks = GREEN, body, isDraft = false, comments = [] }) => {
    const head = `lane/soak-${key}`;
    w.git.createBranch('we', head, { from: 'main', files });
    const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: `soak: ${note}`, labels, body, isDraft });
    w.gh.setChecks('we', pr, checks);
    for (const c of comments) w.gh.comment('we', pr, c.body, { author: c.author });
    out.push({ key, owes, pr, note });
  };

  add('pending', 'review', 'review:pending, green CI — owes a review', {
    files: { 'soak/pending.txt': 'a change waiting for review\n' },
    labels: ['review:pending'],
  });
  add('red-no-item', 'ci-heal', 'red CI, no backlog item — owes a ci-heal', {
    files: { 'soak/red-no-item.txt': 'a change whose CI is red\n' },
    checks: RED,
    body: 'No backlog item for this one.',
  });
  add('changes', 'fix', 'review:changes with a finding — owes a fix', {
    files: { 'soak/changes.txt': 'a change that was bounced\n' },
    labels: ['review:changes'],
    comments: [{ author: 'review-bot', body: '1. soak finding: the change needs a test' }],
  });
  add('human', null, 'review:human — parked for a person (the review daemon may still advise on it)', {
    files: { 'soak/human.txt': 'a change parked for a person\n' },
    labels: ['review:human'],
  });
  add('draft', null, 'a draft — nothing owed', {
    files: { 'soak/draft.txt': 'work in progress\n' },
    isDraft: true,
  });
  return out;
}

/**
 * Fleet churn: open ONE new PR mid-soak in a seeded-random state, the way new work keeps arriving live. A
 * `conflicting` PR is made real: its branch and a fresh main commit (tracked via `api.moveMain`, so the
 * behind/lag invariants count it) both rewrite the same file.
 * @param {object} w - the world
 * @param {{n:number, rand:() => number, api:{owe:Function, moveMain:Function}}} o
 * @returns {{pr:number, key:string, owes:(string|null)}}
 */
export function openChurnPr(w, { n, rand, api }) {
  const pick = rand();
  const key = pick < 0.35 ? 'pending' : pick < 0.6 ? 'red' : pick < 0.8 ? 'changes' : 'conflicting';
  const head = `lane/soak-churn-${n}-${key}`;
  const file = key === 'conflicting' ? 'soak/shared-conflict.txt' : `soak/churn-${n}.txt`;
  w.git.createBranch('we', head, { from: 'main', files: { [file]: `branch side of churn PR ${n}\n` } });
  if (key === 'conflicting') api.moveMain(w, { [file]: `main side, churn ${n}\n` }, `soak: main edits ${file} (conflicts churn PR ${n})`);
  const labels = key === 'pending' ? ['review:pending'] : key === 'changes' ? ['review:changes'] : key === 'conflicting' ? ['review:accepted'] : [];
  const pr = w.gh.openPr({ repo: 'we', head, base: 'main', title: `soak churn ${n}: ${key}`, labels, body: 'No backlog item.' });
  w.gh.setChecks('we', pr, key === 'red' ? RED : GREEN);
  if (key === 'changes') w.gh.comment('we', pr, `1. soak finding on churn PR ${n}: add a test`, { author: 'review-bot' });
  const owes = key === 'pending' ? 'review' : key === 'red' ? 'ci-heal' : key === 'changes' ? 'fix' : null;
  if (owes) api.owe(pr, owes, `churn ${n} ${key}`);
  return { pr, key, owes };
}
