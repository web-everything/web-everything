import { DELEGATED_CLEARANCE_INELIGIBLE_LABELS } from '../../lib/review-labels.mjs';
import { redTeamResultId, parseRedTeamComment, redTeamGateMarker } from '../../lib/red-team-gate.mjs';
import { defaultReadPr } from '../advisory-label-sweep.mjs';
import { sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';
import * as ghThrottle from '../../lib/gh-throttle.mjs';
import { runReviewLabelCli } from '../../review-set-label.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDelegatedClearance, sweepDelegatedClearance, resolveDelegatedClearance } from '../delegated-clearance-sweep.mjs';

const head = 'a'.repeat(40), prior = 'b'.repeat(40);
const bot = body => ({ author: { login: 'web-everything' }, body });
const pr = () => ({ number: 5925, headRefOid: head, mergeable: 'MERGEABLE',
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'],
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  comments: [bot(`**Verdict:** human review required
**Advisory outcome:** ` + '`accept`' + `
Net basis: \`${prior}..${head}\``), bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\nNo confirmed breaks.`)] });
const approvals = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/delegated-pre-approvals.json'), 'utf8'));
function harness(extra = {}) {
  let state = { observed: {}, memo: {} };
  const h = { prs: [pr()], repo: 'o/r', setting: { shadowUntil: '2026-10-25T00:00:00Z' },
    now: () => Date.parse('2026-10-26T00:00:00Z'), readState: () => state, writeState: vi.fn(next => { state = structuredClone(next); }),
    readNetFiles: vi.fn(() => ['scripts/example.mjs']), shape: vi.fn(() => ({ humanRequired: false })),
    readPreApprovals: () => [], readMovedFiles: vi.fn(() => ['backlog/123-card.md']),
    emit: vi.fn(), runLabel: vi.fn(() => ({ ok: true, detail: 'cleared' })), ...extra };
  h.readComments ??= vi.fn(number => h.prs.find(p => p.number === number).comments);
  h.readPr ??= vi.fn(({ number, readComments }) => ({ ...h.prs.find(p => p.number === number), comments: readComments(number, { repo: h.repo }) }));
  return h;
}
describe('R130 delegated clearance', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts the emitted advisory outcome and net basis without a reviewed-sha marker', () => {
    expect(pr().comments[0].body).not.toContain('reviewed-sha');
    expect(planDelegatedClearance([pr()])).toHaveLength(1);
  });
  it.each(['same-head', 'older-head', 'shadow-memo'])('a later clean result cannot hide a confirmed break: %s', mode => {
    const p = pr(), h = harness({ prs: [p], readPreApprovals: () => approvals, setting: {} });
    if (mode === 'shadow-memo') sweepDelegatedClearance(h);
    p.comments.splice(1, 0, bot(`<!-- we:red-team-advisory pr=5925 rev=${mode === 'same-head' ? head : prior} -->
1. [**confirmed**] (security, broken) ` + '`src/a.js:1`' + ` — historical break`));
    sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pre-approval-void' }));
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each(['not-real', 'dismissed', 'card', 'forged', 'wrong-result', 'partial'])('only a recorded finding-specific dismissal supersedes historical breaks: %s', ruling => {
    const p = pr();
    const broken = `<!-- we:red-team-advisory pr=5925 rev=${prior} -->
1. [**confirmed**] (correctness, broken) ` + '`src/a.js:1`' + ` — historical break`;
    const id = redTeamResultId(parseRedTeamComment(broken));
    p.comments.splice(1, 0, bot(broken), { author: { login: ruling === 'forged' ? 'web-everything' : 'chalbert' },
      body: redTeamGateMarker(5925, prior, `operator-${ruling === 'forged' || ruling === 'wrong-result' || ruling === 'partial' ? 'not-real' : ruling}`, ruling === 'wrong-result' ? '0'.repeat(16) : id)
        + `\n- 1 finding(s) left advisory (#${ruling === 'partial' ? 2 : 1}).` });
    const h = harness({ prs: [p], readPreApprovals: () => approvals });
    const results = sweepDelegatedClearance(h);
    expect(results[0].delegated).toBe(['not-real', 'dismissed'].includes(ruling) ? 'auto-approved' : 'pre-approval-void');
  });
  it.each(DELEGATED_CLEARANCE_INELIGIBLE_LABELS)('the sweep refuses an existing %s hold', label => {
    const p = pr(); p.labels.push(label);
    const h = harness({ prs: [p] });
    expect(sweepDelegatedClearance(h)).toEqual([]);
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each(['cosmetic', 'unconfirmed', 'other-pr'])('historical %s evidence does not void the approval', kind => {
    const p = pr();
    p.comments.splice(1, 0, bot(`<!-- we:red-team-advisory pr=${kind === 'other-pr' ? 123 : 5925} rev=${prior} -->
1. [${kind === 'unconfirmed' ? 'not confirmed' : '**confirmed**'}] (security, ${kind === 'cosmetic' ? 'cosmetic' : 'broken'}) ` + '`src/a.js:1`' + ` — historical finding`));
    const h = harness({ prs: [p], readPreApprovals: () => approvals });
    expect(sweepDelegatedClearance(h)[0].delegated).toBe('auto-approved');
  });
  it.each([...DELEGATED_CLEARANCE_INELIGIBLE_LABELS, 'unreadable', 'malformed'])('the CLI refuses live delegated hold %s without writes', label => {
    const output = [], setLabels = vi.fn(), postComment = vi.fn();
    const provider = { readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
      readPrState: () => ({ ...pr(), labels: label === 'unreadable' ? null : [...pr().labels, { name: label === 'malformed' ? null : label }] }), setLabels, postComment };
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
    try {
      expect(() => runReviewLabelCli({ argv: ['5925', '--repo=o/r', '--to=clear-human', '--actor=daemon-delegate-R130',
        '--channel=daemon', `--expect-head=${head}`, '--reason=operator R130',
        '--delegation-json=' + JSON.stringify({ by: 'operator R130', scope: 'test', expires: '2099-01-01T00:00:00Z' })],
        allowClearHuman: true, provider, emit: s => output.push(s) })).toThrow('exit 1');
      expect(output.join('')).toContain('delegated clearance refused');
      expect(setLabels).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });

  it.each(['eligible', 'missing-gates', 'failed-check'])('reconciler default reader composes live delegated gates: %s', evidence => {
    const h = harness();
    // Exercise the production reader composition, injecting only forge transport and the write sink.
    delete h.readPr;
    const fresh = { ...pr(), state: 'OPEN', isDraft: false };
    if (evidence === 'missing-gates') delete fresh.mergeable;
    if (evidence === 'failed-check') fresh.statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
    const forge = vi.spyOn(ghThrottle, 'execFileSyncThrottled').mockImplementation((file, args) => {
      expect(file).toBe('gh');
      expect(args.slice(0, 3)).toEqual(['pr', 'view', '5925']);
      // Model gh's field projection so omitting a requested gate really loses that evidence.
      const fields = args[args.indexOf('--json') + 1].split(',');
      return JSON.stringify(Object.fromEntries(fields.filter(key => key in fresh).map(key => [key, fresh[key]])));
    });
    try {
      const results = sweepReviewHoldLabels({ repo: h.repo, listPrs: () => h.prs,
        provider: {}, readComments: h.readComments, settings: { referralDefault: 'operator' },
        now: h.now, delegatedClearance: h });
      expect(forge).toHaveBeenCalledOnce();
      expect(forge.mock.calls[0][1].at(-1).split(',')).toEqual(expect.arrayContaining(['mergeable', 'statusCheckRollup', 'isDraft']));
      if (evidence === 'eligible') {
        expect(h.runLabel).toHaveBeenCalledOnce();
        expect(results).toContainEqual(expect.objectContaining({ num: 5925, delegated: 'auto-approved' }));
      } else {
        expect(h.runLabel).not.toHaveBeenCalled();
        expect(results).toContainEqual(expect.objectContaining({ num: 5925, delegated: 'aborted' }));
      }
    } finally { forge.mockRestore(); }
  });
  it('keeps a void across later clean heads and restart until a new ruling is supplied', () => {
    const h = harness({ readPreApprovals: () => approvals });
    h.prs[0].comments.push(bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\n1. [**confirmed**] (security, broken) \`src/a.js:1\` — break`));
    sweepDelegatedClearance(h);
    expect(h.readState().memo['o/r#5925:R122:pre-approval-void']).toBe(true);
    const moved = { ...pr(), headRefOid: prior, comments: pr().comments.map(c => ({ ...c, body: c.body.replaceAll(head, prior) })) };
    const resumed = harness({ prs: [moved], readPreApprovals: () => approvals,
      readState: () => structuredClone(h.readState()) });
    sweepDelegatedClearance(resumed);
    expect(resumed.runLabel).not.toHaveBeenCalled();
    resumed.readPreApprovals = () => [{ ...approvals[0], rulingId: 'R131' }];
    sweepDelegatedClearance(resumed);
    expect(resumed.runLabel).toHaveBeenCalledTimes(1);
  });
  it('carries legacy head-keyed voids forward conservatively', () => {
    const h = harness({ readPreApprovals: () => approvals,
      readState: () => ({ observed: {}, memo: { [`o/r#5925@${prior}:pre-approval-void`]: true } }) });
    sweepDelegatedClearance(h);
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('the real clearance argv passes CLI validation without network', () => {
    const h = harness(); sweepDelegatedClearance(h);
    const call = h.runLabel.mock.calls[0][0], output = [];
    const provider = { readPostingIdentity: vi.fn(() => { throw new Error('validation complete; no network'); }) };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      expect(() => runReviewLabelCli({ argv: [String(call.num), `--repo=${call.repo}`, ...call.args],
        allowClearHuman: true, provider, emit: s => output.push(s) })).toThrow('exit');
      expect(provider.readPostingIdentity).toHaveBeenCalledTimes(1);
      expect(output.join('')).toContain('validation complete; no network');
    } finally { exit.mockRestore(); }
  });
  it('the real CLI refuses a moved head before any write', () => {
    const h = harness(); sweepDelegatedClearance(h);
    const call = h.runLabel.mock.calls[0][0], output = [];
    const provider = { readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
      readPrState: vi.fn(() => ({ ...pr(), headRefOid: prior })), setLabels: vi.fn(), postComment: vi.fn() };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      expect(() => runReviewLabelCli({ argv: [String(call.num), `--repo=${call.repo}`, ...call.args],
        allowClearHuman: true, provider, emit: s => output.push(s) })).toThrow('exit');
      expect(output.join('')).toContain('live head differs from --expect-head');
      expect(provider.setLabels).not.toHaveBeenCalled();
      expect(provider.postComment).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });
  it.each(['missing-delegation', 'null-delegation', 'invalid-head', 'new-head'])('the real CLI rejects invalid pinned clearance: %s', invalid => {
    const h = harness(); sweepDelegatedClearance(h);
    const call = h.runLabel.mock.calls[0][0], output = [];
    let args = [...call.args];
    if (invalid === 'missing-delegation') args = args.filter(a => !a.startsWith('--delegation-json='));
    if (invalid === 'null-delegation') args = args.map(a => a.startsWith('--delegation-json=') ? '--delegation-json=null' : a);
    if (invalid === 'invalid-head') args = args.map(a => a.startsWith('--expect-head=') ? '--expect-head=bad' : a);
    if (invalid === 'new-head') args.push(`--new-head=${head}`);
    const provider = { readPostingIdentity: vi.fn() };
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      expect(() => runReviewLabelCli({ argv: [String(call.num), `--repo=${call.repo}`, ...args],
        allowClearHuman: true, provider, emit: s => output.push(s) })).toThrow('exit');
      expect(output.join('')).toMatch(/requires|must be an object/);
      expect(provider.readPostingIdentity).not.toHaveBeenCalled();
    } finally { exit.mockRestore(); }
  });
  it('the shared fresh reader requests all gates and the complete comment thread', () => {
    const exec = vi.fn(() => JSON.stringify(pr())), readComments = vi.fn(() => pr().comments);
    expect(defaultReadPr({ repo: 'o/r', number: 5925, exec, readComments, fields: 'number,state,labels,headRefOid,mergeable,statusCheckRollup,isDraft' })).toEqual(pr());
    expect(exec.mock.calls[0][1].at(-1).split(',')).toEqual(expect.arrayContaining(['labels', 'headRefOid', 'mergeable', 'statusCheckRollup', 'isDraft']));
    expect(readComments).toHaveBeenCalledWith(5925, { repo: 'o/r' });
  });
  it.each(['head', 'labels', 'checks', 'mergeable', 'break', 'unreadable', 'incomplete'])('revalidates fresh %s immediately before live clearance', change => {
    const fresh = pr();
    if (change === 'head') fresh.headRefOid = prior;
    if (change === 'labels') fresh.labels.push('operator:hold');
    if (change === 'checks') fresh.statusCheckRollup.push({ state: 'SUCCESS', context: 'new gate' });
    if (change === 'mergeable') fresh.mergeable = 'UNKNOWN';
    if (change === 'break') fresh.comments.push(bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\n1. [**confirmed**] (security, broken) \`src/a.js:1\` — break`));
    if (change === 'incomplete') delete fresh.statusCheckRollup;
    const readComments = vi.fn(() => fresh.comments);
    const readPr = vi.fn(({ number, repo, readComments }) => {
      if (change === 'unreadable') throw new Error('fresh read failed');
      return { ...fresh, comments: readComments(number, { repo }) };
    });
    const h = harness({ readPr, readComments, readPreApprovals: () => approvals });
    const results = sweepDelegatedClearance(h);
    expect(readPr).toHaveBeenCalledWith({ repo: 'o/r', number: 5925, readComments });
    expect(h.runLabel).not.toHaveBeenCalled();
    expect(results.length).toBeGreaterThan(0);
    if (change === 'break') expect(h.readState().memo['o/r#5925:R122:pre-approval-void']).toBe(true);
  });
  it('shadow and dry runs never re-read live state', () => {
    for (const extra of [{ setting: {} }, { dryRun: true }]) {
      const h = harness(extra); sweepDelegatedClearance(h);
      expect(h.readPr).not.toHaveBeenCalled();
    }
  });
  it('clears an eligible PR behind eight ineligible held PRs', () => {
    const ineligible = Array.from({ length: 8 }, (_, i) => ({ ...pr(), number: i + 1,
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }));
    const h = harness({ prs: [...ineligible, pr()] });
    sweepDelegatedClearance(h);
    expect(h.runLabel).toHaveBeenCalledTimes(1);
    expect(h.runLabel).toHaveBeenCalledWith(expect.objectContaining({ num: 5925, head }));
  });
  it('observes a pending pre-approval behind eight eligible PRs', () => {
    const eligible = Array.from({ length: 8 }, (_, i) => {
      const number = i + 1;
      return { ...pr(), number, comments: pr().comments.map(c => ({ ...c, body: c.body.replace('pr=5925', `pr=${number}`) })) };
    });
    const h = harness({ prs: [...eligible, { ...pr(), mergeable: 'UNKNOWN' }], readPreApprovals: () => approvals });
    sweepDelegatedClearance(h);
    expect(h.readState().observed['o/r#5925:R122']).toBe(head);
    expect(h.runLabel).toHaveBeenCalledTimes(8);
  });
  it('voids a pre-approval behind eight ineligible held PRs', () => {
    const p = pr();
    p.comments.push(bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\n1. [**confirmed**] (security, broken) \`src/a.js:1\` — break`));
    const h = harness({ prs: [...Array.from({ length: 8 }, (_, i) => ({ ...pr(), number: i + 1, mergeable: 'UNKNOWN' })), p],
      readPreApprovals: () => approvals });
    sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pre-approval-void', pr: 5925 }));
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('bounds complete comment reads separately and reports deferred evidence', () => {
    const rows = Array.from({ length: 9 }, (_, i) => {
      const number = i + 1;
      return { ...pr(), number, comments: pr().comments.map(c => ({ ...c, body: c.body.replace('pr=5925', `pr=${number}`) })) };
    });
    const readComments = vi.fn(number => rows.find(p => p.number === number).comments);
    const h = harness({ prs: rows.map(p => ({ ...p, comments: Array(100).fill(p.comments[0]) })), readComments });
    const results = sweepDelegatedClearance(h);
    expect(readComments).toHaveBeenCalledTimes(16);
    expect(h.runLabel).toHaveBeenCalledTimes(8);
    expect(results).toContainEqual(expect.objectContaining({ num: 9, delegated: 'deferred', detail: expect.stringContaining('complete comment') }));
  });
  it('clears an eligible ninth PR across repeated ticks with eight persistently ineligible predecessors', () => {
    const rows = Array.from({ length: 9 }, (_, i) => {
      const number = i + 1;
      return { ...pr(), number, mergeable: i < 8 ? 'UNKNOWN' : 'MERGEABLE',
        comments: pr().comments.map(c => ({ ...c, body: c.body.replace('pr=5925', `pr=${number}`) })) };
    });
    const readComments = vi.fn(number => rows.find(p => p.number === number).comments);
    const h = harness({ prs: rows.map(p => ({ ...p, comments: Array(100).fill(p.comments[0]) })), readComments });
    sweepDelegatedClearance(h);
    expect(readComments).toHaveBeenCalledTimes(8);
    expect(h.runLabel).not.toHaveBeenCalled();
    // Reconstruct the IO shell from persisted state, as after a daemon restart.
    const resumed = harness({ ...h, readState: () => JSON.parse(JSON.stringify(h.readState())) });
    sweepDelegatedClearance(resumed);
    expect(readComments).toHaveBeenCalledTimes(17);
    expect(resumed.runLabel).toHaveBeenCalledTimes(1);
    expect(resumed.runLabel).toHaveBeenCalledWith(expect.objectContaining({ num: 9, head }));
  });
  it('progresses the ninth eligible PR behind eight shape-ineligible predecessors after restart', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ ...pr(), number: i + 1,
      comments: pr().comments.map(c => ({ ...c, body: c.body.replace('pr=5925', `pr=${i + 1}`) })) }));
    const h = harness({ prs: rows, readNetFiles: vi.fn(({ num }) => [`scripts/pr-${num}.mjs`]),
      shape: vi.fn(files => ({ humanRequired: files[0] !== 'scripts/pr-9.mjs' })) });
    sweepDelegatedClearance(h);
    expect(h.shape).toHaveBeenCalledTimes(8);
    expect(h.runLabel).not.toHaveBeenCalled();
    const resumed = harness({ ...h, readState: () => JSON.parse(JSON.stringify(h.readState())) });
    sweepDelegatedClearance(resumed);
    expect(h.shape).toHaveBeenCalledTimes(16);
    expect(resumed.runLabel).toHaveBeenCalledTimes(1);
    expect(resumed.runLabel).toHaveBeenCalledWith(expect.objectContaining({ num: 9, head }));
  });
  it.each([null, [], { 'repo:o/r': -1 }, { 'repo:o/r': 'unknown' }])('invalid persisted candidate cursors fail closed (%s)', candidateCursors => {
    const h = harness({ readState: () => ({ observed: {}, memo: {}, candidateCursors }) });
    expect(sweepDelegatedClearance(h)[0]).toMatchObject({ delegated: 'sweep-failed', detail: expect.stringContaining('operator review required') });
    expect(h.shape).not.toHaveBeenCalled();
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each([null, [], { 'repo:o/r': -1 }, { 'repo:o/r': 'unknown' }])('invalid persisted comment cursors fail closed (%s)', commentCursors => {
    const h = harness({ readState: () => ({ observed: {}, memo: {}, commentCursors }) });
    expect(sweepDelegatedClearance(h)[0]).toMatchObject({ delegated: 'sweep-failed', detail: expect.stringContaining('operator review required') });
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('plans only a held PR with complete green evidence', () => {
    expect(planDelegatedClearance([pr()])).toHaveLength(1);
    expect(planDelegatedClearance([{ ...pr(), comments: undefined }])).toEqual([]);
  });
  it('shadow emits would-approve once and never writes a label', () => {
    const h = harness({ setting: {} });
    sweepDelegatedClearance(h); sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'would-approve', pr: 5925, head }));
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('live writes a pinned clearance quoting R130/R11, operator words, net files and shape', () => {
    const h = harness(); sweepDelegatedClearance(h);
    expect(h.runLabel).toHaveBeenCalledWith(expect.objectContaining({ repo: 'o/r', num: 5925, head,
      body: expect.stringMatching(/R130.*R11[\s\S]*Ok[\s\S]*scripts\/example.mjs[\s\S]*humanRequired[\s\S]*false[\s\S]*aaaa/),
      args: expect.arrayContaining(['--to=clear-human', '--actor=daemon-delegate-R130', '--channel=daemon', `--expect-head=${head}`]) }));
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'auto-approved', head }));
  });
  it('leaves humanRequired without a named pre-approval alone', () => {
    const h = harness({ shape: () => ({ humanRequired: true }) });
    expect(sweepDelegatedClearance(h)).toEqual([]); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('an approval for repository A never clears the same-numbered human-required PR in repository B', () => {
    const h = harness({ repo: 'other/repository', shape: () => ({ humanRequired: true }), readPreApprovals: () => approvals });
    expect(sweepDelegatedClearance(h)).toEqual([]);
    expect(h.runLabel).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.readState().observed).toEqual({});
  });
  it('foreign approvals cannot waive review conditions in the pure planner', () => {
    const p = pr(); p.labels = ['review:human']; p.comments = [];
    const preApprovals = [{ ...approvals[0], conditions: { ...approvals[0].conditions, accepted: false, redTeamClear: false } }];
    expect(planDelegatedClearance([p], { repo: 'other/repository', preApprovals })).toEqual([]);
    expect(planDelegatedClearance([p], { preApprovals })).toEqual([]);
    expect(planDelegatedClearance([p], { repo: 'o/r', preApprovals })[0].approval).toEqual(preApprovals[0]);
  });
  it.each([undefined, null, '', 'repository', 'o/r/extra'])('rejects unqualified or malformed approval repository (%s)', repo => {
    const h = harness({ readPreApprovals: () => [{ ...approvals[0], repo }] });
    expect(sweepDelegatedClearance(h)[0]).toMatchObject({ delegated: 'sweep-failed', detail: expect.stringContaining('operator review required') });
    expect(h.runLabel).not.toHaveBeenCalled();
    expect(h.writeState).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
  it('selects the matching repository from shared approvals with overlapping PR numbers', () => {
    const matching = { ...approvals[0], repo: 'other/repository', rulingId: 'R131' };
    const h = harness({ repo: 'other/repository', shape: () => ({ humanRequired: true }), readPreApprovals: () => [...approvals, matching] });
    sweepDelegatedClearance(h);
    expect(h.runLabel).toHaveBeenCalledWith(expect.objectContaining({ approval: matching }));
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'auto-approved', rulingId: 'R131' }));
    expect(h.readState().observed).toEqual({ 'other/repository#5925:R131': head });
  });
  it('rejects duplicate repository-qualified approvals even when repository case differs', () => {
    const h = harness({ readPreApprovals: () => [...approvals, { ...approvals[0], repo: 'O/R' }] });
    expect(sweepDelegatedClearance(h)[0]).toMatchObject({ delegated: 'sweep-failed' });
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each([true, false])('honours a named pre-approval (shadow=%s)', shadow => {
    const h = harness({ setting: shadow ? {} : harness().setting, shape: () => ({ humanRequired: true }), readPreApprovals: () => approvals });
    sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: shadow ? 'would-approve' : 'auto-approved', basis: expect.stringContaining('R122') }));
  });
  it('blocks non-card movement and never falls through to R11', () => {
    const h = harness({ readPreApprovals: () => [{ ...approvals[0], approvedHead: prior }], readMovedFiles: () => ['src/bug.js'] });
    expect(sweepDelegatedClearance(h)).toEqual([]); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('remembers the first observed approved head across ticks', () => {
    const h = harness({ readPreApprovals: () => approvals, setting: {} });
    sweepDelegatedClearance(h); h.prs = [{ ...pr(), headRefOid: prior, comments: pr().comments.map(c => ({ ...c, body: c.body.replaceAll(head, prior) })) }];
    sweepDelegatedClearance(h);
    expect(h.readMovedFiles).toHaveBeenCalledWith(expect.objectContaining({ approvedHead: head, head: prior }));
  });
  it('voids a confirmed break once per approval identity even when red-team clear is absent', () => {
    const p = pr(); p.labels = ['review:human', 'advisory:accepted'];
    p.comments.push(bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\n1. [**confirmed**] (security, broken) \`src/a.js:1\` — break`));
    const h = harness({ prs: [p], readPreApprovals: () => approvals });
    sweepDelegatedClearance(h); sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pre-approval-void', rulingId: 'R122', head }));
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each(['red-team', 'accepted', 'gates', 'mergeable', 'stale-accept', 'stale-red-team', 'missing-checks'])('fails closed on %s', missing => {
    const p = pr();
    if (missing === 'red-team') p.labels = p.labels.filter(x => x !== 'red-team:clear');
    if (missing === 'accepted') p.labels = p.labels.filter(x => x !== 'advisory:accepted');
    if (missing === 'gates') p.statusCheckRollup[0].conclusion = 'FAILURE';
    if (missing === 'mergeable') p.mergeable = 'UNKNOWN';
    if (missing === 'stale-accept') p.comments[0].body = p.comments[0].body.replace(head, prior);
    if (missing === 'stale-red-team') p.comments[1].body = p.comments[1].body.replace(head, prior);
    if (missing === 'missing-checks') delete p.statusCheckRollup;
    const h = harness({ prs: [p] }); expect(sweepDelegatedClearance(h)).toEqual([]);
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each([null, [], Array(1001).fill('x')])('unreadable or oversized net files require human review (%s)', files => {
    const h = harness({ readNetFiles: () => files });
    expect(sweepDelegatedClearance(h)[0]).toMatchObject({ delegated: 'sweep-failed', detail: expect.stringContaining('human review') });
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('dry run writes neither events, state nor labels', () => {
    const h = harness({ dryRun: true }); sweepDelegatedClearance(h);
    expect(h.emit).not.toHaveBeenCalled(); expect(h.writeState).not.toHaveBeenCalled(); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('memoises a CLI refusal without retrying it', () => {
    const h = harness({ runLabel: vi.fn(() => ({ ok: false, detail: 'identity refused' })) });
    expect(sweepDelegatedClearance(h)[0].delegated).toBe('refused'); sweepDelegatedClearance(h);
    expect(h.runLabel).toHaveBeenCalledTimes(1);
  });
  it('a new confirmed break voids an earlier shadow decision at the same head', () => {
    const h = harness({ setting: {}, readPreApprovals: () => approvals }); sweepDelegatedClearance(h);
    h.prs[0].comments.push(bot(`<!-- we:red-team-advisory pr=5925 rev=${head} -->\n1. [**confirmed**] (correctness, broken) \`src/a.js:1\` — new break`));
    sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'pre-approval-void', head }));
  });
  it('allows only the identical approved head when allowedHeadMove is none', () => {
    const h = harness({ readPreApprovals: () => [{ ...approvals[0], approvedHead: prior,
      conditions: { ...approvals[0].conditions, allowedHeadMove: 'none' } }] });
    expect(sweepDelegatedClearance(h)).toEqual([]); expect(h.readMovedFiles).not.toHaveBeenCalled();
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it.each([null, { humanRequired: undefined }])('unknown shape fails closed (%s)', scored => {
    const h = harness({ shape: () => scored });
    expect(sweepDelegatedClearance(h)[0].delegated).toBe('sweep-failed'); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('a pre-approval read failure never falls through to R11', () => {
    const h = harness({ readPreApprovals: () => { throw new Error('unreadable'); } });
    expect(sweepDelegatedClearance(h)[0].delegated).toBe('sweep-failed'); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('uses the environment shadow deadline over the platform preference', () => {
    vi.stubEnv('WE_DELEGATED_CLEARANCE_SHADOW_UNTIL', '2099-01-01T00:00:00Z');
    const h = harness(); delete h.setting; sweepDelegatedClearance(h);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'would-approve' }));
    expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('resolves standard/platform/tool/environment and logs the setting provenance', () => {
    const log = vi.fn();
    const value = resolveDelegatedClearance({ platform: { shadowUntil: '2030-01-01T00:00:00Z', stateFile: 'platform-state' },
      tool: { stateFile: 'tool-state' }, env: { WE_POLICY_CASCADE_LOG: '1', WE_DELEGATED_CLEARANCE_SHADOW_UNTIL: '2020-01-01T00:00:00Z' }, log });
    expect(value).toMatchObject({ shadowUntil: '2020-01-01T00:00:00Z', stateFile: 'tool-state' });
    expect(log.mock.calls[0][0]).toMatch(/shadowUntil=.*\(env\)/);
    expect(log.mock.calls[0][0]).toMatch(/stateFile=.*\(tool\)/);
  });
  it('oversized external approval files require operator human review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegated-approval-test-'));
    try {
      const file = join(dir, 'oversized.json'); writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
      const h = harness({ setting: { preApprovalsFile: file } }); delete h.readPreApprovals;
      expect(sweepDelegatedClearance(h)[0]).toMatchObject({ delegated: 'sweep-failed', detail: expect.stringContaining('operator human review') });
      expect(h.runLabel).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a future deadline remains in shadow', () => {
    const h = harness({ setting: { shadowUntil: '2026-10-27T00:00:00Z' } }); sweepDelegatedClearance(h);
    expect(h.runLabel).not.toHaveBeenCalled(); expect(h.emit.mock.calls[0][0].kind).toBe('would-approve');
  });
  it('corrupt persisted state fails closed', () => {
    const h = harness({ readState: () => ({ memo: {}, observed: null }) });
    expect(sweepDelegatedClearance(h)[0].delegated).toBe('sweep-failed'); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('a complete comment read failure blocks clearance', () => {
    const p = pr(); p.comments = Array(100).fill(p.comments[0]);
    const h = harness({ prs: [p], readComments: () => { throw new Error('comment read failed'); } });
    expect(sweepDelegatedClearance(h)[0].delegated).toBe('sweep-failed'); expect(h.runLabel).not.toHaveBeenCalled();
  });
  it('the sanctioned CLI is attempted only once even if it throws', () => {
    const h = harness({ runLabel: vi.fn(() => { throw new Error('timeout'); }) });
    sweepDelegatedClearance(h); sweepDelegatedClearance(h);
    expect(h.runLabel).toHaveBeenCalledTimes(1); expect(h.emit.mock.calls[0][0].kind).toBe('approval-refused');
  });
});
