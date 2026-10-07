/**
 * @file duplicate-pr-watch.test.mjs — `#xs19sz9`. PURE logic tests for `groupPrsByDeliveredItem` /
 * `planDuplicateFindings` / `buildDuplicateFindingBody` + IO-shell tests over injected fakes (no real `gh`, no
 * real subprocess, no real filesystem), mirroring `we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs`'s
 * own shape.
 */

import { describe, it, test, expect, mock } from 'bun:test';
import {
  hasLabelNamed,
  groupPrsByDeliveredItem,
  planDuplicateFindings,
  buildDuplicateFindingBody,
  watchDuplicatePrs,
  defaultListOpenPrs,
  defaultPostFinding,
} from '../../../../scripts/conveyor/duplicate-pr-watch.mjs';

describe('the real incident that motivated this pass — the 2026-09-05 quadruple/double-PR storm', () => {
  // The real shape (headRefName/title only — the fields deliveredItemNumsFromPr actually reads) of the four
  // PRs the in-flight build-guard bug spawned for item #3478, before any of them were closed.
  const QUADRUPLE_3478 = [
    { number: 1933, headRefName: 'lane/3478-runner-target-queue', title: 'WE #3478: resolve the live conveyor runner\'s actual checkout before queuing work', body: '', labels: [] },
    { number: 1935, headRefName: 'lane/3478-runner-aware-queue', title: 'WE #3478: add queue-work.mjs — resolve the LIVE conveyor runner\'s checkout before clearing an item', body: '', labels: [] },
    { number: 1937, headRefName: 'lane/3478-queue-checkout-resolve', title: 'WE #3478: add queue-work.mjs, a checkout-aware conveyor queue entry point', body: '', labels: [] },
    { number: 1939, headRefName: 'lane/3478-queue-work-target-resolution', title: 'WE #3478: Resolve the queue sidecar from the live runner\'s lock, not the caller\'s cwd', body: '', labels: [] },
  ];

  // The two double-PR pairs from the same incident, retry-lettered (#3110's convention) — #3230/#1928+#1931,
  // #2819/#1936+#1940, #3481/#1929+#1930.
  const PAIR_3230 = [
    { number: 1928, headRefName: 'lane/3230-verify-staged-write', title: 'WE #3230: verify the STAGED write before reporting a review recorded', body: '', labels: [] },
    { number: 1931, headRefName: 'lane/3230f-verify-recordPrepVerdict-write', title: 'WE #3230: verify recordPrepVerdict\'s write against the staged index, not a bare write', body: '', labels: [] },
  ];

  it('groups all four #3478 PRs under item 3478', () => {
    const byItem = groupPrsByDeliveredItem(QUADRUPLE_3478);
    expect(byItem.get('3478')).toEqual([1933, 1935, 1937, 1939]);
  });

  it('would have caught the real incident — plans a finding for every one of the four PRs, no keeper chosen', () => {
    const plans = planDuplicateFindings(QUADRUPLE_3478);
    expect(plans.map((p) => p.pr)).toEqual([1933, 1935, 1937, 1939]);
    for (const plan of plans) {
      expect(plan.duplicates).toEqual([{ itemNum: '3478', siblings: QUADRUPLE_3478.map((p) => p.number).filter((n) => n !== plan.pr) }]);
    }
  });

  it('would have caught the retry-lettered double-PR pair on #3230 too', () => {
    const plans = planDuplicateFindings(PAIR_3230);
    expect(plans.map((p) => p.pr)).toEqual([1928, 1931]);
    expect(plans[0].duplicates).toEqual([{ itemNum: '3230', siblings: [1931] }]);
    expect(plans[1].duplicates).toEqual([{ itemNum: '3230', siblings: [1928] }]);
  });

  it('a full sweep over the real #3478 quadruple posts exactly four findings, each citing its own siblings', () => {
    const posted = [];
    const postFinding = ({ repo, pr, body }) => posted.push({ repo, pr, body });
    const results = watchDuplicatePrs({ repo: 'web-everything/web-everything', listPrs: () => QUADRUPLE_3478, postFinding });
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.posted)).toBe(true);
    expect(posted).toHaveLength(4);
    const bodyFor1933 = posted.find((p) => p.pr === 1933).body;
    expect(bodyFor1933).toContain('#3478');
    expect(bodyFor1933).toContain('#1935');
    expect(bodyFor1933).toContain('#1937');
    expect(bodyFor1933).toContain('#1939');
    expect(bodyFor1933).not.toContain('#1933,'); // never cites itself as a sibling
  });
});

describe('hasLabelNamed', () => {
  it('true for an object-shaped label list', () => {
    expect(hasLabelNamed([{ name: 'review:changes' }, { name: 'ready-to-merge' }], 'review:changes')).toBe(true);
  });
  it('true for a bare-string label list', () => {
    expect(hasLabelNamed(['review:changes'], 'review:changes')).toBe(true);
  });
  it('false when absent, and tolerant of missing/malformed input', () => {
    expect(hasLabelNamed([{ name: 'review:pending' }], 'review:changes')).toBe(false);
    expect(hasLabelNamed(undefined, 'review:changes')).toBe(false);
    expect(hasLabelNamed([null, {}], 'review:changes')).toBe(false);
  });
});

describe('groupPrsByDeliveredItem', () => {
  it('does not false-positive on legitimately different slices of the same epic', () => {
    // Two real slices of one epic (#3383), each with its OWN item number via `parent:` — never the same id.
    const prs = [
      { number: 100, headRefName: 'lane/3402-fixture-harness-fork1', title: 'WE #3402: fixture harness fork 1', body: '', files: [] },
      { number: 101, headRefName: 'lane/3446-fixture-harness-fork2', title: 'WE #3446: fixture harness fork 2', body: '', files: [] },
    ];
    const byItem = groupPrsByDeliveredItem(prs);
    expect(byItem.get('3402')).toEqual([100]);
    expect(byItem.get('3446')).toEqual([101]);
  });

  it('does not false-positive on a bare "#NNN" citation in the title (not a delivery claim)', () => {
    const prs = [
      { number: 200, headRefName: 'lane/9001-unrelated-fix', title: 'WE #9001: unrelated fix (see #3478 for background)', body: '', files: [] },
    ];
    const byItem = groupPrsByDeliveredItem(prs);
    expect(byItem.get('3478')).toBeUndefined();
    expect(byItem.get('9001')).toEqual([200]);
  });

  it('an all-markdown PR is never credited as a delivery (guard 7, reused)', () => {
    const prs = [
      { number: 300, headRefName: 'lane/3478-housekeeping', title: 'WE #3478: reopen + note', body: '', files: [{ path: 'backlog/3478-x.md' }] },
      { number: 301, headRefName: 'lane/3478-real-fix', title: 'WE #3478: the real fix', body: '', files: [{ path: 'scripts/conveyor/foo.mjs' }] },
    ];
    const byItem = groupPrsByDeliveredItem(prs);
    // Only the real (non-markdown) PR is credited — no duplicate group forms with just one member.
    expect(byItem.get('3478')).toEqual([301]);
  });

  it('a single open PR for an item is never a group of its own', () => {
    const byItem = groupPrsByDeliveredItem([{ number: 1, headRefName: 'lane/42-solo', title: 'WE #42: solo fix', body: '', files: [] }]);
    expect(byItem.get('042')).toEqual([1]);
  });
});

describe('planDuplicateFindings', () => {
  const dupPair = () => ([
    { number: 10, headRefName: 'lane/500-fix', title: 'WE #500: fix A', body: '', labels: [] },
    { number: 11, headRefName: 'lane/500b-fix', title: 'WE #500: fix B', body: '', labels: [] },
  ]);

  it('flags both PRs in a fresh duplicate pair — no keeper picked', () => {
    const plans = planDuplicateFindings(dupPair());
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.pr)).toEqual([10, 11]);
  });

  it('a single non-duplicated PR produces no plan at all', () => {
    const plans = planDuplicateFindings([{ number: 1, headRefName: 'lane/1-solo', title: 'WE #1: solo', body: '', labels: [] }]);
    expect(plans).toEqual([]);
  });

  it('DEDUP — a PR that already carries review:changes is skipped even though it is still a live duplicate', () => {
    const prs = dupPair();
    prs[0].labels = [{ name: 'review:changes' }];
    const plans = planDuplicateFindings(prs);
    expect(plans.map((p) => p.pr)).toEqual([11]); // only the not-yet-flagged sibling
  });

  it('re-arms once review:changes is cleared and the duplicate condition still holds', () => {
    const prs = dupPair();
    prs[0].labels = [{ name: 'review:accepted' }]; // cleared by a human, but the sibling is still open
    const plans = planDuplicateFindings(prs);
    expect(plans.map((p) => p.pr)).toEqual([10, 11]); // both re-flagged — accepted is not our dedup marker
  });

  it('one PR duplicating on two different item ids gets exactly one combined finding', () => {
    // A batch PR (`lane/batch-...-700-701`) whose TRAILING id (701) collides with a solo PR, while a second
    // batch PR shares the batch's leading id... kept simple: two separate single-item collisions on one PR
    // is exercised via two distinct groups both containing PR 20.
    const prs = [
      { number: 20, headRefName: 'lane/700-multi', title: 'WE #700: multi A / resolve #701', body: '', labels: [] },
      { number: 21, headRefName: 'lane/700b-multi', title: 'WE #700: multi B', body: '', labels: [] },
      { number: 22, headRefName: 'lane/701-solo', title: 'WE #701: solo', body: '', labels: [] },
    ];
    const plans = planDuplicateFindings(prs);
    const plan20 = plans.find((p) => p.pr === 20);
    expect(plan20.duplicates.map((d) => d.itemNum).sort()).toEqual(['700', '701']);
  });

  it('deterministic ascending-PR-number order regardless of input order', () => {
    const prs = dupPair().reverse();
    const plans = planDuplicateFindings(prs);
    expect(plans.map((p) => p.pr)).toEqual([10, 11]);
  });
});

describe('buildDuplicateFindingBody', () => {
  it('names the item id, the siblings, and states no keeper is being chosen', () => {
    const body = buildDuplicateFindingBody({ pr: 1933, duplicates: [{ itemNum: '3478', siblings: [1935, 1937, 1939] }] });
    expect(body).toContain('#3478');
    expect(body).toContain('#1935');
    expect(body).toContain('#1937');
    expect(body).toContain('#1939');
    expect(body).toMatch(/does \*\*not\*\* say which PR should be kept/i);
    expect(body).not.toContain('undefined');
  });

  it('renders multiple colliding items as a bulleted list', () => {
    const body = buildDuplicateFindingBody({ pr: 20, duplicates: [{ itemNum: '700', siblings: [21] }, { itemNum: '701', siblings: [22] }] });
    expect(body).toContain('#700');
    expect(body).toContain('#701');
    expect(body.split('\n').filter((l) => l.startsWith('- Item'))).toHaveLength(2);
  });
});

describe('defaultListOpenPrs — argv shape (exec injected, no real gh call)', () => {
  it('queries open PRs with the fields this pass needs, no --repo when omitted', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '[]'; };
    defaultListOpenPrs({ exec });
    expect(capturedArgv).toEqual(['pr', 'list', '--state', 'open', '--limit', '200',
      '--json', 'number,headRefName,title,body,labels,files']);
  });

  it('appends --repo when given', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '[]'; };
    defaultListOpenPrs({ exec, repo: 'o/n' });
    expect(capturedArgv).toEqual(['pr', 'list', '--state', 'open', '--limit', '200',
      '--json', 'number,headRefName,title,body,labels,files', '--repo', 'o/n']);
  });
});

describe('defaultPostFinding — subprocess argv shape + temp-file lifecycle (exec/fs injected, no real gh/node)', () => {
  it('writes the body to a temp file, shells reconcile-finding.mjs with it, and always removes the file', () => {
    let capturedCmd; let capturedArgv; let written; let removedPath;
    const exec = (cmd, argv) => { capturedCmd = cmd; capturedArgv = argv; return ''; };
    const writeFile = (path, body) => { written = { path, body }; };
    const removeFile = (path) => { removedPath = path; };
    defaultPostFinding({
      repo: 'o/n', pr: 1933, body: 'the finding text', root: '/repo', exec, writeFile, removeFile, tmpDir: '/tmp',
    });
    expect(capturedCmd).toBe('node');
    expect(capturedArgv[0]).toBe('/repo/scripts/conveyor/reconcile-finding.mjs');
    expect(capturedArgv[1]).toBe('1933');
    expect(capturedArgv[2]).toMatch(/^--body-file=\/tmp\/duplicate-pr-finding-1933-/);
    expect(capturedArgv).toContain('--agent=duplicate-pr-watch');
    expect(capturedArgv).toContain('--repo=o/n');
    expect(written.body).toBe('the finding text');
    expect(removedPath).toBe(written.path);
  });

  it('omits --repo when none given', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return ''; };
    defaultPostFinding({ pr: 1, body: 'x', root: '/repo', exec, writeFile: () => {}, removeFile: () => {}, tmpDir: '/tmp' });
    expect(capturedArgv.some((a) => /^--repo=/.test(a))).toBe(false);
  });

  it('removes the temp file even when the subprocess call throws', () => {
    let removedPath;
    const exec = () => { throw new Error('reconcile-finding refused'); };
    const removeFile = (path) => { removedPath = path; };
    expect(() => defaultPostFinding({
      pr: 1, body: 'x', root: '/repo', exec, writeFile: () => {}, removeFile, tmpDir: '/tmp',
    })).toThrow('reconcile-finding refused');
    expect(removedPath).toMatch(/^\/tmp\/duplicate-pr-finding-1-/);
  });
});

describe('watchDuplicatePrs — IO shell over injected fakes (no gh/subprocess)', () => {
  it('is idempotent — a second sweep where both PRs already carry review:changes posts nothing', () => {
    const posted = [];
    const listPrs = () => ([
      { number: 10, headRefName: 'lane/500-fix', title: 'WE #500: fix A', body: '', labels: [{ name: 'review:changes' }] },
      { number: 11, headRefName: 'lane/500b-fix', title: 'WE #500: fix B', body: '', labels: [{ name: 'review:changes' }] },
    ]);
    const postFinding = (o) => posted.push(o);
    const results = watchDuplicatePrs({ repo: 'o/n', listPrs, postFinding });
    expect(results).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('ignores a single, non-duplicated open PR — not this pass\'s scope', () => {
    const posted = [];
    const listPrs = () => ([{ number: 1, headRefName: 'lane/1-solo', title: 'WE #1: solo', body: '', labels: [] }]);
    const results = watchDuplicatePrs({ repo: 'o/n', listPrs, postFinding: (o) => posted.push(o) });
    expect(results).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('dry-run: reports the plan, posts nothing', () => {
    const posted = [];
    const listPrs = () => ([
      { number: 10, headRefName: 'lane/500-fix', title: 'WE #500: fix A', body: '', labels: [] },
      { number: 11, headRefName: 'lane/500b-fix', title: 'WE #500: fix B', body: '', labels: [] },
    ]);
    const results = watchDuplicatePrs({ repo: 'o/n', listPrs, postFinding: (o) => posted.push(o), dryRun: true });
    expect(results).toEqual([
      { pr: 10, itemNums: ['500'], posted: false },
      { pr: 11, itemNums: ['500'], posted: false },
    ]);
    expect(posted).toEqual([]);
  });

  it('one PR\'s post failure does not stop the sweep from posting the rest', () => {
    const posted = [];
    let calls = 0;
    const postFinding = (o) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      posted.push(o);
    };
    const listPrs = () => ([
      { number: 10, headRefName: 'lane/500-fix', title: 'WE #500: fix A', body: '', labels: [] },
      { number: 11, headRefName: 'lane/500b-fix', title: 'WE #500: fix B', body: '', labels: [] },
    ]);
    const results = watchDuplicatePrs({ repo: 'o/n', listPrs, postFinding });
    expect(results).toHaveLength(2);
    expect(results[0].error).toBe('boom');
    expect(results[1].posted).toBe(true);
    expect(posted).toHaveLength(1);
  });
});


const __actual0 = { ...(await import('node:child_process')) };
// bun: an async factory that awaits import() of another mocked module spins forever (vitest is fine),
// so share the mock fn through the closure instead.
const execFileSync = mock();
mock.module('node:child_process', () => ({
  ...__actual0, execFileSync,
}));
mock.module('../../../../scripts/lib/gh-throttle.mjs', () => {
    return {
    execFileSyncThrottled: mock((file, args, opts) => execFileSync(file, args, opts)),
    runGhSync: mock((args, opts) => execFileSync('gh', args, opts)),
  };
});
mock.module('../../../../scripts/lib/write-all-sync.mjs', () => ({ writeAllSync: mock(), writeLineSync: mock() }));

import { prFileContract } from './pr-file-test-helpers.mjs';
prFileContract({
  name: 'duplicate-pr-watch', load: (q = '') => import('../../../../scripts/conveyor/duplicate-pr-watch.mjs' + q),
  reader: 'defaultListOpenPrs', run: 'watchDuplicatePrs',
  fields: 'number,headRefName,title,body,labels,files',
});
