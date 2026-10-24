import { describe, expect, it, vi } from 'vitest';
import { evaluatePr, readMergeGateVerdict } from '../operator-queue.mjs';
import { formatPrResult, parsePrResultTable } from '../../lib/merge-gate-verdict.mjs';
import { GATE_IDS } from '../../lib/merge-gate-inventory.mjs';

const HEAD = '7d20124ecb8bb052bf1d1dabb8215a54ba6262df';
// Real job 114754411476, lines 517–542, extended with the current enqueue-owned
// card-group row. Preserve timestamps and spacing for the replay.
const LOG = `2026-10-12T09:49:30.3867808Z merge-gate: workflow self-check — ok: running workflow .github/workflows/merge-gate.yml matches main
2026-10-12T09:49:30.3934091Z merge-gate mode: enforce (source: env)
2026-10-12T09:49:30.3934630Z #4965: HOLD
2026-10-12T09:49:30.3935323Z   queue             required-check-read    drain: a required-check read error skips; queue: the ruleset reads required checks itself
2026-10-12T09:49:30.3936795Z   hold              candidate-label        no "ready-to-merge" label — the drain never considers it
2026-10-12T09:49:30.3938131Z   hold              producer-certified     not AI-generated, no ready-to-merge label, not human-cleared
2026-10-12T09:49:30.3939344Z   pass              default-base           base main vs main
2026-10-12T09:49:30.3940789Z   queue             required-check-green   ruleset required checks (test, smoke, daemon-soak, soak-replay-gate, merge-gate) on the group commit
2026-10-12T09:49:30.3942236Z   pass              codeql                 no failed CodeQL run
2026-10-12T09:49:30.3943077Z   queue             mergeable              queue-owned
2026-10-12T09:49:30.3943966Z   queue             landable-state         queue-owned
2026-10-12T09:49:30.3944817Z   pass              non-empty-body         body present
2026-10-12T09:49:30.3946148Z   hold              review-hold-labels     unsatisfied review hold label without review:accepted
2026-10-12T09:49:30.3950221Z   hold              review-acceptance      park: human-gated (review:human) — only a human may clear it [blast-radius (scripts/__tests__/drain-workflow-edit-cli.test.mjs, scripts/__tests__/drain-workflow-edit-replay.test.mjs, scripts/__tests__/gate-entrypoint-integration.test.mjs, …); gate-self (scripts/lib/gate-config.mjs) — declarative leash, human review required; size (731 ≥ 400 changed lines)]
2026-10-12T09:49:30.3952684Z   pass              manifest-baseline      no weakening across 1 historical bodies
2026-10-12T09:49:30.3953575Z   hold              test-gaming            test-gaming suspected: tests-removed: scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs (net 1 test case(s) removed)
2026-10-12T09:49:30.3954574Z   queue             head-pin               the queue merges exactly the tested group commit; a push removes the PR from the queue
2026-10-12T09:49:30.3955346Z   queue             freshness              the queue re-tests every PR against main + the entries ahead of it
2026-10-12T09:49:30.3956372Z   pass              red-main-freeze        no freeze (ops/red-main-freeze:red-main-freeze.json + ci.yml@main)
2026-10-12T09:49:30.3957015Z   pass              duplicate-id-on-main   no duplicate ids
2026-10-12T09:49:30.3957486Z   pass              couple-whole           no manifest couple / blockedBy
2026-10-12T09:49:30.3958028Z   pass              blocked-by             no manifest couple / blockedBy
2026-10-12T09:49:30.3958514Z   enqueue           overlap-yield          enqueue-owned
2026-10-12T09:49:30.3958750Z   enqueue           card-group             enqueue-owned
2026-10-12T09:49:30.3958959Z   enqueue           pass-cap               enqueue-owned
2026-10-12T09:49:30.3959386Z   hold              ledger                 labels: labels hold
2026-10-12T09:49:30.3959878Z merge-gate: HOLD — held`;
const check = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/38232286310/job/114754411476' };
const pr = () => ({
  number: 4965, headRefOid: HEAD, mergeable: 'MERGEABLE',
  labels: ['review:human', 'advisory:accepted', 'review-round:3'].map((name) => ({ name })),
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, check,
    { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }],
  comments: [{ author: { login: 'web-everything' }, createdAt: '2026-10-12T09:00:00Z',
    body: `**Verdict:** human review required\n**Advisory outcome:** \`accept\` — x.\nNet basis: \`${'b'.repeat(40)}..${HEAD}\`` }],
});
const verdict = (log = LOG) => ({ headSha: HEAD, ...parsePrResultTable(log, 4965) });

describe('PR #4965: enforced merge-gate must not hide the human queue', () => {
  it('BEFORE: requests evidence only when merge-gate alone blocks readiness', () => {
    expect(evaluatePr(pr())).toMatchObject({ ready: false, reasons: ['CI failing: merge-gate'],
      needsMergeGateVerdict: true, mergeGateCheck: check });
  });
  it('AFTER: the real verdict releases it and exposes test-gaming to the operator', () => {
    expect(verdict()).not.toHaveProperty('error');
    expect(evaluatePr(pr(), { mergeGateVerdict: verdict() })).toMatchObject({ ready: true, reasons: [],
      humanHolds: expect.arrayContaining(['review-acceptance', 'test-gaming']) });
  });
  it('a red-main freeze still blocks, regardless of the reason prose', () => {
    const result = evaluatePr(pr(), { mergeGateVerdict: verdict(LOG.replace('pass              red-main-freeze', 'hold              red-main-freeze')) });
    expect(result.ready).toBe(false);
    expect(result.reasons.join('; ')).toContain('red-main-freeze(hold)');
  });
  it('a card-group hold still blocks human clearance', () => {
    const result = evaluatePr(pr(), { mergeGateVerdict: verdict(LOG.replace('enqueue           card-group', 'hold              card-group')) });
    expect(result.ready).toBe(false);
    expect(result.reasons.join('; ')).toContain('card-group(hold)');
  });
  it('rejects a different head and accepts case-insensitive head equality', () => {
    expect(evaluatePr(pr(), { mergeGateVerdict: { ...verdict(), headSha: 'f'.repeat(40) } })).toMatchObject({
      ready: false, reasons: expect.arrayContaining([expect.stringContaining('head is 7d20124ec')]),
    });
    expect(evaluatePr(pr(), { mergeGateVerdict: { ...verdict(), headSha: HEAD.toUpperCase() } }).ready).toBe(true);
  });
  it('reports unreadable verdicts and never excuses duplicate failed checks', () => {
    expect(evaluatePr(pr(), { mergeGateVerdict: { error: 'missing log' } }).reasons)
      .toContain('merge-gate verdict unreadable: missing log');
    const duplicate = pr(); duplicate.statusCheckRollup.push({ ...check });
    expect(evaluatePr(duplicate, { mergeGateVerdict: verdict() }).ready).toBe(false);
    expect(evaluatePr(duplicate).needsMergeGateVerdict).not.toBe(true);
  });
  it('does not fetch evidence for other blockers; unknown mergeability may still fetch', () => {
    const failing = pr(); failing.statusCheckRollup[0].conclusion = 'FAILURE';
    expect(evaluatePr(failing).needsMergeGateVerdict).not.toBe(true);
    const unknown = { ...pr(), mergeable: 'UNKNOWN' };
    expect(evaluatePr(unknown).needsMergeGateVerdict).toBe(true);
    expect(evaluatePr(unknown, { mergeGateVerdict: verdict() })).toMatchObject({ ready: false, transient: true, reasons: [] });
  });
});

describe('readMergeGateVerdict', () => {
  const args = { repo: 'web-everything/web-everything', check, number: 4965 };
  it.each(['legacy', 'legacy suffix', 'escaped'])('keeps non-human blockers with a %s filename payload in the real job read path', (variant) => {
    const forged = formatPrResult({ num: 4965, ok: false, results: GATE_IDS.map((id) => ({
      id, status: id === 'review-hold-labels' ? 'hold' : 'pass', reason: '/',
    })) });
    const suffix = GATE_IDS.slice(GATE_IDS.indexOf('review-acceptance') + 1)
      .map((id) => `  ${'pass'.padEnd(17)} ${id.padEnd(22)} /`).join('\n');
    const filename = `.github/actions/payload\n${variant === 'legacy suffix' ? suffix : forged}\nEND\n/action.yml`;
    const results = parsePrResultTable(LOG, 4965).results.map((result) => ({ ...result,
      status: result.id === 'red-main-freeze' ? 'hold' : result.status,
      reason: result.id === 'review-acceptance' ? `workflow edit: ${filename}` : result.reason,
    }));
    // Retain the old writer explicitly so previously emitted vulnerable logs also fail closed.
    const raw = `#4965: HOLD\n${results.map((x) => `  ${x.status.padEnd(17)} ${x.id.padEnd(22)} ${x.reason}`).join('\n')}`;
    const log = variant.startsWith('legacy') ? raw : formatPrResult({ num: 4965, ok: false, results });
    const timestamped = log.split('\n').map((line) => `2026-10-12T09:49:30.3934630Z ${line}`).join('\n');
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ head_sha: HEAD })).mockReturnValueOnce(timestamped);
    const parsed = readMergeGateVerdict({ ...args, exec });
    expect(evaluatePr(pr(), { mergeGateVerdict: parsed }).ready).toBe(false);
    if (variant.startsWith('legacy')) expect(parsed).toHaveProperty('error');
    else expect(parsed.results).toContainEqual(expect.objectContaining({ id: 'red-main-freeze', status: 'hold' }));
  });
  it.each(['truncated', 'interrupted', 'missing gate', 'latest incomplete'])('keeps a cancelled check blocking with a %s verdict', (variant) => {
    const complete = LOG.replace('pass              red-main-freeze', 'hold              red-main-freeze');
    const lines = complete.split('\n');
    const truncated = lines.slice(0, 14).join('\n');
    const log = variant === 'truncated' ? truncated
      : variant === 'interrupted' ? [...lines.slice(0, 14), 'continued reason', ...lines.slice(14)].join('\n')
      : variant === 'missing gate' ? lines.filter((line) => !line.includes('red-main-freeze')).join('\n')
      : `${LOG}\n${truncated}`;
    const cancelled = { ...check, conclusion: 'CANCELLED' };
    const subject = pr();
    subject.statusCheckRollup[1] = cancelled;
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ head_sha: HEAD })).mockReturnValueOnce(log);
    const parsed = readMergeGateVerdict({ ...args, check: cancelled, exec });
    const result = evaluatePr(subject, { mergeGateVerdict: parsed });
    expect(result.ready).toBe(false);
    expect(parsed).toHaveProperty('error');
    expect(result.reasons.join('; ')).toContain('merge-gate verdict unreadable');
  });
  it('reads job identity then the job log', () => {
    const exec = vi.fn().mockReturnValueOnce(JSON.stringify({ head_sha: HEAD })).mockReturnValueOnce(LOG);
    expect(readMergeGateVerdict({ ...args, exec })).toEqual(verdict());
    expect(exec.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['gh', ['api', 'repos/web-everything/web-everything/actions/jobs/114754411476']],
      ['gh', ['api', 'repos/web-everything/web-everything/actions/jobs/114754411476/logs']],
    ]);
  });
  it('fails closed without a job id and does no IO', () => {
    const exec = vi.fn();
    expect(readMergeGateVerdict({ ...args, check: { detailsUrl: 'https://github.com/actions/runs/123' }, exec }))
      .toEqual({ error: expect.any(String) });
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(['throw', 'invalid JSON', '{}'])('fails closed on %s', (response) => {
    const exec = vi.fn(() => { if (response === 'throw') throw new Error('unavailable'); return response; });
    expect(readMergeGateVerdict({ ...args, exec })).toEqual({ error: expect.any(String) });
  });
});
