import { describe, it, expect, vi } from 'vitest';
import { check, readIntakeSettings, readIntake, main } from '../intake.mjs';
import { roundEndRefusal, applyIntakeEffects } from '../round-end-gates.mjs';
import { parseNumstat } from '../../pr-size-accounting.mjs';
const head = 'a'.repeat(40), baseSha = 'b'.repeat(40);
const entries = parseNumstat('300\t0\tscripts/conveyor/reconcile-core.mjs\n285\t0\tscripts/lib/review-loop/intake.mjs\n900\t0\tscripts/__tests__/fixture.test.mjs');
const subject = (extra = {}) => ({ pr: 7181, head, baseSha, round: 1, entries, markers: [], ...extra });
const marker = (body, login = 'chalbert') => ({ body, author: { login } });
describe('intake', () => {
  it('over-cap from merge-base splits after one round unless exempt', () => {
    expect(check(subject())).toMatchObject({ verdict: 'fail', reason: 'split-required', lines: 585, round: 1, head, baseSha });
    expect(check(subject({ entries: parseNumstat('300\t0\tdocs/guide.html\n285\t0\tREADME.md') }))).toMatchObject({ verdict: 'pass', lines: 0 });
    expect(check(subject({ markers: [marker(`<!-- intake-urgent pr=7181 head=${head} reason=outage -->`, 'stranger')] })).verdict).toBe('fail');
    expect(check(subject({ labels: ['docs/', 'size:over-cap'] })).verdict).toBe('fail');
  });
  it('missing, binary, malformed and throwing evidence stays unknown for human review', () => {
    for (const entries of [undefined, null, [{ paths: ['a.js'], changed: NaN }], [{ paths: ['a.js'], changed: -1 }]]) expect(check(subject({ entries })).verdict).toBe('unknown');
    expect(check({ get entries() { throw Error('unreadable'); } })).toMatchObject({ verdict: 'unknown', reason: 'unverifiable' });
    expect(readIntake(subject(), { diffStat: () => { throw Error('binary'); } }).verdict).toBe('unknown');
  });
  it('first round observes; configured round threshold and cap apply', () => {
    expect(check(subject({ round: 0 }))).toMatchObject({ verdict: 'pass', observation: 'over-cap' });
    expect(check(subject(), { roundsBeforeSplit: 2 }).verdict).toBe('pass');
    expect(check(subject(), { maxLines: 600 }).verdict).toBe('pass');
  });
  it('rename-only and declared generated paths are atomic; mixed docs count code only', () => {
    expect(check(subject({ entries: parseNumstat('0\t0\t\0old.js\0new.js\0') })).verdict).toBe('pass');
    expect(check(subject({ entries: parseNumstat('900\t0\tgenerated/code.js') }), { generatedPaths: ['generated/**'] }).verdict).toBe('pass');
    expect(check(subject({ entries: [...entries, ...parseNumstat('900\t0\tREADME.md')] })).lines).toBe(585);
    expect(check(subject({ entries: parseNumstat('585\t0\t\0docs/a.md\0code.js\0') })).verdict).toBe('fail');
  });
  it('urgent requires exact head and PR and trusted author', () => {
    for (const [pr, sha] of [[7182, head], [7181, baseSha]]) expect(check(subject({ markers: [marker(`<!-- intake-urgent pr=${pr} head=${sha} reason=outage -->`)] })).verdict).toBe('fail');
    expect(check(subject({ markers: [marker(`<!-- intake-urgent pr=7181 head=${head} reason=outage -->`)] })).exemptReason).toBe('urgent');
  });
  it('override trust, PR binding and thread order ignore timestamps', () => {
    const body = '<!-- intake-override pr=7181 ruling=R1099 -->';
    expect(check(subject({ markers: [marker(body, 'stranger')] })).verdict).toBe('fail');
    expect(check(subject({ markers: [marker(body.replace('7181', '7182'))] })).verdict).toBe('fail');
    expect(check(subject({ markers: [{ ...marker(body), createdAt: '2099' }, { ...marker(body.replace('R1099', 'R1100')), createdAt: '2000' }] })).overrideUsed).toBe('R1100');
  });
  it('reader rejects moved head and pins merge-base', () => {
    const git = args => args[0] === 'merge-base' ? baseSha : '585\t0\tcode.js\0';
    expect(readIntake(subject(), { git }).baseSha).toBe(baseSha);
    expect(readIntake(subject(), { git, diffStat: () => ({ sha: baseSha }) }).verdict).toBe('unknown');
  });
  it('settings ship shadow and resolve environment with provenance', () => {
    const logs = [];
    expect(readIntakeSettings({ env: {}, platform: {}, operatorOverride: {}, log: s => logs.push(s) }).enforce).toBe('shadow');
    expect(readIntakeSettings({ env: { WE_POLICY_CASCADE_LOG: '1', WE_REVIEW_INTAKE_MAX_LINES: '600', WE_REVIEW_INTAKE_ENFORCE: 'on' }, platform: {}, operatorOverride: {}, log: s => logs.push(s) })).toMatchObject({ maxLines: 600, enforce: 'on' });
    expect(logs.join(' ')).toContain('env');
  });
});

it('CLI pins numstat and lists would-splits read-only for one PR and all open PRs', async () => {
  const comments = await import('../../../conveyor/pr-comments-complete.mjs');
  const { REARM_COMMENT_MARKER } = await import('../../../conveyor/rearm-review.mjs');
  const reader = vi.spyOn(comments, 'readCompletePrComments').mockReturnValue([marker(REARM_COMMENT_MARKER)]);
  const pr = { number: 7181, headRefOid: head, baseRefName: 'main' };
  const gh = vi.fn(args => args[0] === 'repo' ? { nameWithOwner: 'frontier-ui/frontierui' } : args[1] === 'view' ? pr : [pr]);
  const exitCode = process.exitCode;
  const git = args => args[0] === 'merge-base' ? baseSha : '585\t0\tcode.js\0';
  const output = [];
  try {
    await main(['--pr=7181', '--shadow'], { gh, git, log: s => output.push(s) });
    await main(['--open'], { gh, git, log: s => output.push(s) });
    expect(output).toEqual(['fail split-required lines=585 round=1', '#7181 fail split-required lines=585 round=1']);
    expect(reader).toHaveBeenCalledWith(7181, expect.objectContaining({ repo: 'frontier-ui/frontierui' }));
    expect(gh.mock.calls.every(([args]) => ['pr', 'repo'].includes(args[0]) && ['view', 'list'].includes(args[1]))).toBe(true);
    const prCalls = gh.mock.calls.filter(([args]) => args[0] === 'pr');
    expect(prCalls.length).toBe(2);
    expect(prCalls.every(([args]) => args[args.indexOf('--repo') + 1] === 'frontier-ui/frontierui')).toBe(true);
    const full = args => args[0] === 'repo' ? { nameWithOwner: 'frontier-ui/frontierui' } : Array(1000).fill(pr);
    await expect(main(['--open'], { gh: full, git })).rejects.toThrow('operator');
  } finally { reader.mockRestore(); process.exitCode = exitCode; }
});

it('diff argv disables relative configuration and relative paths explicitly', () => {
  const git = vi.fn(args => args[0] === 'merge-base' ? baseSha : '585\t0\tcode.js\0');
  expect(readIntake(subject(), { git }).verdict).toBe('fail');
  expect(git.mock.calls[1][0]).toEqual(['-c', 'core.attributesFile=', '-c', 'diff.relative=false', 'diff', '--no-relative', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--find-renames', baseSha, head, '--']);
});

it('trackOverrides=false preserves the used ruling and emits the override audit event', async () => {
  const verdict = check(subject({ markers: [marker('<!-- intake-override pr=7181 ruling=R1099 -->')] }), { trackOverrides: false });
  expect(verdict).toMatchObject({ verdict: 'pass', overrideUsed: 'R1099' });
  const intake = roundEndRefusal({ pr: {}, attempts: 1, readIntake: () => verdict });
  const appendEvent = vi.fn();
  await applyIntakeEffects({ notes: [{ kind: 'intake-effect', intake, pr: { number: 7181 } }] }, { appendEvent, runSize: vi.fn() });
  expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intake-override', detail: expect.objectContaining({ ruling: 'R1099' }) }));
});

it.each(['pass', 'fail', 'unknown'])('CLI exit status reflects %s evidence only without --shadow', async verdict => {
  const comments = await import('../../../conveyor/pr-comments-complete.mjs');
  const { REARM_COMMENT_MARKER } = await import('../../../conveyor/rearm-review.mjs');
  const reader = vi.spyOn(comments, 'readCompletePrComments').mockReturnValue([marker(REARM_COMMENT_MARKER)]);
  const pr = { number: 7181, headRefOid: head, baseRefName: 'main' };
  const gh = args => args[0] === 'repo' ? { nameWithOwner: 'frontier-ui/frontierui' } : [pr];
  const git = args => {
    if (verdict === 'unknown') throw Error('unreadable evidence');
    return args[0] === 'merge-base' ? baseSha : `${verdict === 'fail' ? 585 : 1}\t0\tcode.js\0`;
  };
  const exitCode = process.exitCode;
  try {
    process.exitCode = 0;
    await main(['--open', '--shadow'], { gh, git, log: () => {} });
    expect(process.exitCode).toBe(0);
    await main(['--open'], { gh, git, log: () => {} });
    expect(process.exitCode).toBe(verdict === 'pass' ? 0 : 1);
  } finally { reader.mockRestore(); process.exitCode = exitCode; }
});
