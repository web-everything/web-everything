/**
 * @file scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs
 * @description we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — pins the durable, HEAD-SCOPED
 *   ci-heal escalation marker: build/parse round-trip, the trusted-author gate (mirrors every sibling marker),
 *   and the head-scoping that makes a new push re-arm auto-heal with no human intervention. Real incident:
 *   web-everything/web-everything#2783 (three ci-heal sessions in one evening, each escalating identically on the
 *   same head with nothing durable recorded).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCiHealEscalationComment, parseCiHealEscalations, latestCiHealEscalationForHead,
  composeCiHealEscalation, CI_HEAL_ESCALATION_MARKER, CI_HEAL_ESCALATION_OUTCOMES, postOrOweCiHealEscalation,
} from '../ci-heal-escalation-mark.mjs';
import { collectCiAuthDiagnosis } from '../ci-auth-diagnosis.mjs';
import { owedWriteAlreadyLive } from '../ci-heal-owed.mjs';
import { budgetBlockedMessage } from '../../lib/gh-throttle.mjs';

const AUTOMATION = { login: 'web-everything' };
const HEAD = '70326866f0f299ddd005f9da54f0b87a3c169ac4'; // PR #2783's real head, 2026-09-27

describe('CI_HEAL_ESCALATION_OUTCOMES', () => {
  it('is exactly the three-valued enum the file header describes', () => {
    expect(CI_HEAL_ESCALATION_OUTCOMES).toEqual(['needs-human', 'waiting-on-system-fix', 'not-a-ci-break']);
  });
});

describe('buildCiHealEscalationComment', () => {
  it('leads with the stable marker line', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'not a CI break' });
    expect(body.startsWith(CI_HEAL_ESCALATION_MARKER)).toBe(true);
  });
  it('lowercases and trims the head sha (case/whitespace must never fork the comparison)', () => {
    const body = buildCiHealEscalationComment({ headSha: `  ${HEAD.toUpperCase()}  `, outcome: 'needs-human' });
    expect(body).toContain(`head: ${HEAD}`);
  });
  it('needs-human requires no systemFixRef and omits the system-fix line', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'genuine defect' });
    expect(body).not.toContain('system-fix:');
    expect(body).toContain('outcome: needs-human');
  });
  it('waiting-on-system-fix carries the system-fix line', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'waiting-on-system-fix', systemFixRef: 2784 });
    expect(body).toContain('outcome: waiting-on-system-fix');
    expect(body).toContain('system-fix: #2784');
  });
  it('waiting-on-system-fix WITHOUT a systemFixRef throws — never a half-formed marker', () => {
    expect(() => buildCiHealEscalationComment({ headSha: HEAD, outcome: 'waiting-on-system-fix' })).toThrow();
  });
  it('an unknown outcome throws rather than posting a marker parseCiHealEscalations could not read back', () => {
    expect(() => buildCiHealEscalationComment({ headSha: HEAD, outcome: 'bogus' })).toThrow();
  });
  it('a missing headSha throws', () => {
    expect(() => buildCiHealEscalationComment({ outcome: 'needs-human' })).toThrow();
  });
  // we:backlog/fix-review-ciheal-deadlock (LIVE DEADLOCK 2026-09-28/29, PR #2878) — the third outcome: every
  // required check is green, the only red is the review gate itself. Requires no systemFixRef (there is no
  // fix to wait on) and its own distinct message, never the generic needs-human "a person must judge this" text.
  it('not-a-ci-break requires no systemFixRef and carries its own message (never conflated with needs-human)', () => {
    const body = buildCiHealEscalationComment({
      headSha: HEAD, outcome: 'not-a-ci-break',
      reason: 'not a CI break — the only red check is review-gate, held by the review:pending label',
    });
    expect(body).not.toContain('system-fix:');
    expect(body).toContain('outcome: not-a-ci-break');
    expect(body).toMatch(/owed its ordinary review/);
    expect(body).not.toMatch(/needs a human judgment call/);
  });
});

describe('parseCiHealEscalations — the round trip and the trusted-author gate', () => {
  it('round-trips a built comment back to its fields', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'not a CI break' });
    const [parsed] = parseCiHealEscalations([{ body, author: AUTOMATION, createdAt: '2026-09-27T01:23:00Z' }]);
    expect(parsed).toMatchObject({ headSha: HEAD, outcome: 'needs-human', reason: 'not a CI break', systemFixRef: null });
  });
  it('round-trips the waiting-on-system-fix shape including the ref', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'waiting-on-system-fix', systemFixRef: 2784, reason: 'soak-replay-gate false red' });
    const [parsed] = parseCiHealEscalations([{ body, author: AUTOMATION }]);
    expect(parsed).toMatchObject({ headSha: HEAD, outcome: 'waiting-on-system-fix', systemFixRef: '2784' });
  });
  it('round-trips the not-a-ci-break shape (we:backlog/fix-review-ciheal-deadlock, PR #2878)', () => {
    const body = buildCiHealEscalationComment({
      headSha: HEAD, outcome: 'not-a-ci-break',
      reason: 'not a CI break — the only red check is review-gate, held by the review:pending label',
    });
    const [parsed] = parseCiHealEscalations([{ body, author: AUTOMATION }]);
    expect(parsed).toMatchObject({
      headSha: HEAD, outcome: 'not-a-ci-break', systemFixRef: null,
      reason: 'not a CI break — the only red check is review-gate, held by the review:pending label',
    });
  });
  it('#3383 — an UNTRUSTED author\'s identical-looking comment never counts (forgeable "already escalated" would suppress a real ci-heal)', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human' });
    expect(parseCiHealEscalations([{ body, author: { login: 'some-random-account' } }])).toEqual([]);
  });
  it('a human quoting the marker in a REPLY (not the leading line) never counts', () => {
    const marker = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human' });
    const quoted = `> ${marker.split('\n')[0]}\n\nI disagree, please retry.`;
    expect(parseCiHealEscalations([{ body: quoted, author: AUTOMATION }])).toEqual([]);
  });
  it('a non-array / empty input is zero escalations, never a throw', () => {
    expect(parseCiHealEscalations(null)).toEqual([]);
    expect(parseCiHealEscalations([])).toEqual([]);
  });
  it('a bare-string comment array is tolerated (author unknown → untrusted → excluded), matching every sibling marker\'s contract', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human' });
    expect(parseCiHealEscalations([body])).toEqual([]);
  });
});

describe('latestCiHealEscalationForHead — the head-scoping that makes a new push re-arm auto-heal', () => {
  const OLD_HEAD = 'c2bd9d5b8bc2bd9d5b8bc2bd9d5b8bc2bd9d5b8b';

  it('finds an escalation matching the CURRENT head', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'genuine defect' });
    const result = latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD);
    expect(result).toMatchObject({ headSha: HEAD, outcome: 'needs-human' });
  });

  it('LIVE INCIDENT #2783 shape: an escalation on the OLD head does not match once a new push moves the head — auto-heal re-arms with no human clear', () => {
    const body = buildCiHealEscalationComment({ headSha: OLD_HEAD, outcome: 'needs-human', reason: 'not a CI break' });
    // The PR has since been rebased/re-pushed onto a NEW head — the stale escalation comment is still in
    // `comments` (comments are never deleted), but it names a head this PR no longer has.
    expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD)).toBeNull();
  });

  it('no headSha given → null, never a false match', () => {
    const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human' });
    expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], null)).toBeNull();
    expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], undefined)).toBeNull();
  });

  it('multiple escalations on the SAME head: the LAST one in comments order wins', () => {
    const first = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'first look' });
    const second = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'waiting-on-system-fix', systemFixRef: 2784, reason: 'second look' });
    const result = latestCiHealEscalationForHead(
      [{ body: first, author: AUTOMATION }, { body: second, author: AUTOMATION }], HEAD,
    );
    expect(result).toMatchObject({ outcome: 'waiting-on-system-fix', systemFixRef: '2784' });
  });
});

// PR #2787 review finding — the PRODUCER side of the head-scoping. The ci-heal brief rebases BEFORE it may
// escalate, so after a clean-but-unpushed rebase `git rev-parse HEAD` names a local commit GitHub never saw: a
// marker stamped with it never matches `pr.headRefOid`, reconcile ignores it, and the same heal is dispatched
// again. Every escalation command in the brief must stamp the PR's PUBLISHED head, read off GitHub.
//
// #4269 (PR #2787 review, same finding's SECOND half, 2026-09-27) — reading that published head FRESH, live, at
// EACH escalation exit (as this describe block itself used to assert was correct) is its own bug: a push landing
// mid-session, AFTER diagnosis began but BEFORE an escalation exit runs, would hand a live `gh pr view` read a
// head this session never actually examined, and the marker would be stamped against it — silently suppressing
// healing on a revision nobody diagnosed. The fix: the brief now captures the head ONCE, at step 0 (before
// diagnosis begins), into `$EXAMINED_HEAD`, and every escalation exit stamps ONLY that captured value.
describe('fix-agent-ci-brief.md — every escalation marker targets the head this session actually examined, never the local HEAD nor a fresh live re-read', () => {
  const BRIEF = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills-src', 'conveyor', 'fix-agent-ci-brief.md'), 'utf8');
  const markerCalls = BRIEF.match(/ci-heal-escalation-mark\.mjs" \{\{PR_NUM\}\}[^\n]*\n[^\n]*/g) || [];
  it('finds every escalation call in the brief (sanity — one per escalation exit)', () => {
    expect(markerCalls.length).toBeGreaterThanOrEqual(4);
  });
  it('escalation after an unpushed rebase targets the published PR head — no call stamps --head from the local HEAD', () => {
    expect(BRIEF).not.toMatch(/--head="\$\(git rev-parse HEAD\)"/);
  });
  it('every escalation call stamps the CAPTURED $EXAMINED_HEAD — never a fresh, live gh pr view re-read at escalation time (#4269)', () => {
    for (const call of markerCalls) {
      expect(call).toMatch(/--head="\$EXAMINED_HEAD"/);
      expect(call).not.toMatch(/--head="\$\(gh pr view/);
    }
  });
  it('$EXAMINED_HEAD is itself captured off the PR\'s own headRefOid, exactly once, before any escalation call', () => {
    const captureIndex = BRIEF.indexOf('EXAMINED_HEAD="$(gh pr view {{PR_NUM}} --repo {{REPO}} --json headRefOid --jq .headRefOid)"');
    expect(captureIndex).toBeGreaterThan(-1);
    const firstMarkerCallIndex = BRIEF.indexOf(markerCalls[0]);
    expect(captureIndex).toBeLessThan(firstMarkerCallIndex);
  });
});

// we:backlog/4352 — the escalation-marker sibling of ci-heal-mark's owed-on-budget-refusal case.
describe('#4352 — postOrOweCiHealEscalation', () => {
  const REPO = { key: 'we', slug: 'web-everything/web-everything' };
  const budgetError = () => {
    const stderr = budgetBlockedMessage({ resource: 'graphql', until: 'soon' });
    return Object.assign(new Error(`Command failed\n${stderr}`), { status: 1, stderr });
  };
  const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'r' });

  it('a budget-refused escalation is recorded owed under its own kind, keyed by the head it already carries', () => {
    const owed = [];
    const out = postOrOweCiHealEscalation({
      pr: 2783, body, headSha: HEAD, repo: REPO, post: () => { throw budgetError(); }, owe: (r) => { owed.push(r); return r; },
    });
    expect(out.commented).toBe(false);
    expect(owed).toEqual([{ repo: 'we', slug: 'web-everything/web-everything', pr: 2783, kind: 'ci-heal-escalation', headSha: HEAD, body }]);
  });

  it('a successful post owes nothing; a non-budget failure still throws', () => {
    const owe = () => { throw new Error('must not owe'); };
    expect(postOrOweCiHealEscalation({ pr: 1, body, headSha: HEAD, repo: REPO, post: () => '', owe })).toEqual({ commented: true });
    expect(() => postOrOweCiHealEscalation({ pr: 1, body, headSha: HEAD, repo: REPO, post: () => { throw new Error('HTTP 422'); }, owe })).toThrow(/422/);
  });

  it('the owed dedupe check agrees with latestCiHealEscalationForHead — same head matches, another head does not', () => {
    const rec = { kind: 'ci-heal-escalation', headSha: HEAD, body };
    const live = [{ body, author: AUTOMATION }];
    expect(latestCiHealEscalationForHead(live, HEAD)).not.toBeNull();
    expect(owedWriteAlreadyLive(live, rec)).toBe(true);
    const other = buildCiHealEscalationComment({ headSha: 'f'.repeat(40), outcome: 'needs-human' });
    expect(owedWriteAlreadyLive([{ body: other, author: AUTOMATION }], rec)).toBe(false);
  });
});

it('re-arms legacy acquire-null escalations without deleting comments or moving the head', () => {
  const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'lane ref gone — lane/4409-prepare-item-guard-relaxation-lint no longer resolves' });
  expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD)).toBeNull();
  const verified = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'origin ref verified absent — lane/4409' });
  expect(latestCiHealEscalationForHead([{ body: verified, author: AUTOMATION }], HEAD)?.outcome).toBe('needs-human');
});

it('#4545 renders credential evidence after the existing marker fields', () => {
  const body = buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', reason: 'Bad credentials',
    authDiagnosis: { status: 'resolved', repo: 'web-everything/web-everything', runId: 36632379377, attempt: 1,
      revision: 'b'.repeat(40), job: 'build', step: 'Checkout FUI (sibling)', secret: 'FUI_READ_TOKEN',
      updatedAt: '2026-09-30T00:00:00Z', observedAt: '2026-10-01T00:00:00Z', repositorySecret: true } });
  expect(body).toContain('gh secret set FUI_READ_TOKEN --repo web-everything/web-everything');
  expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD)).toMatchObject({ outcome: 'needs-human', reason: 'Bad credentials' });
});

describe('#4545 real CLI composition and owed-body preservation', () => {
  const flags = { head: HEAD, outcome: 'needs-human', reason: 'Bad credentials', repo: 'web-everything/web-everything', run: '36632379377', attempt: '1' };
  function collect(input) {
    return collectCiAuthDiagnosis(input, { now: () => '2026-10-01T00:00:00Z', read: (args) => {
      if (args[0] === 'secret') return JSON.stringify([{ name: 'FUI_READ_TOKEN', updatedAt: '2026-09-30T00:00:00Z' }]);
      if (args[0] === 'run') return 'build\tCheckout FUI (sibling)\t##[error]Bad credentials';
      if (args[1].includes('/contents/')) return JSON.stringify({ encoding: 'base64', content: Buffer.from('jobs:\n  build:\n    steps:\n      - name: Checkout FUI (sibling)\n        uses: actions/checkout@v4\n        with:\n          repository: frontier-ui/frontierui\n          token: ${{ secrets.FUI_READ_TOKEN }}').toString('base64') });
      if (args[1].includes('/jobs?')) return JSON.stringify({ total_count: 1, jobs: [{ id: 42, run_id: Number(flags.run), run_attempt: 1, head_sha: HEAD, name: 'build', conclusion: 'failure', steps: [{ number: 2, name: 'Checkout FUI (sibling)', conclusion: 'failure' }] }] });
      return JSON.stringify({ id: Number(flags.run), run_attempt: 1, head_sha: HEAD, repository: { full_name: flags.repo }, path: '.github/workflows/ci.yml', event: 'push' });
    } });
  }
  it('renders the incident through the collector used by the CLI and preserves it on a budget refusal', () => {
    const body = composeCiHealEscalation(flags, { collect });
    expect(body).toContain('Checkout FUI (sibling)');
    expect(body).toContain('2026-09-30T00:00:00Z');
    expect(body).toContain('gh secret set FUI_READ_TOKEN --repo web-everything/web-everything');
    let record;
    const out = postOrOweCiHealEscalation({ pr: 2999, body, headSha: HEAD, repo: { key: 'we', slug: flags.repo },
      post: () => { throw new Error(budgetBlockedMessage({ resource: 'graphql', until: 'soon' })); },
      owe: (r) => { record = r; return r; } });
    expect(out.commented).toBe(false);
    expect(record.body).toBe(body);
    expect(owedWriteAlreadyLive([{ body, author: AUTOMATION }], record)).toBe(true);
    expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD)).toMatchObject({ headSha: HEAD, outcome: 'needs-human', reason: flags.reason });
  });
  it('failed enrichment retains original escalation and never emits command errors', () => {
    const body = composeCiHealEscalation(flags, { collect: () => { throw new Error('CANARY_SECRET_VALUE'); } });
    expect(body).toContain('enrichment unavailable');
    expect(body).not.toContain('CANARY_SECRET_VALUE');
    expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD)?.reason).toBe(flags.reason);
  });
  it('legacy invocations do no reads and produce the identical body', () => {
    const { run, attempt, ...legacy } = flags;
    expect(composeCiHealEscalation(legacy, { collect: () => { throw new Error('must not read'); } })).toBe(buildCiHealEscalationComment({ headSha: HEAD, outcome: legacy.outcome, reason: legacy.reason }));
  });
  it('brief passes diagnosed run and attempt alongside captured head on the needs-human auth exit', () => {
    const brief = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../skills-src/conveyor/fix-agent-ci-brief.md'), 'utf8');
    expect(brief).toContain('CI_AUTH_ARGS=(--run="$AUTH_RUN" --attempt="$AUTH_ATTEMPT")');
    expect(brief).toContain('--head="$EXAMINED_HEAD" --outcome=needs-human "${CI_AUTH_ARGS[@]}"');
    expect(brief.indexOf('CI_AUTH_ARGS=()')).toBeLessThan(brief.indexOf('CI_AUTH_ARGS=(--run='));
    expect(brief).toContain('the healer never executes it');
  });
});

it('#4545 malformed enrichment cannot prevent the original escalation', () => {
  const body = composeCiHealEscalation({ head: HEAD, outcome: 'needs-human', run: '123', attempt: '1' },
    { collect: () => ({ failures: { bad: 'CANARY_SECRET_VALUE' } }) });
  expect(body).toContain('enrichment unavailable');
  expect(body).not.toContain('CANARY_SECRET_VALUE');
  expect(latestCiHealEscalationForHead([{ body, author: AUTOMATION }], HEAD)?.outcome).toBe('needs-human');
});

describe('not-a-ci-break verdict invalidation — live #4535', async () => {
  const { vi } = await import('vitest');
  const { CI_HEAL_VERDICT_VOID_MARKER, buildCiHealVerdictVoidComment, parseCiHealVerdictVoids,
    notCiBreakRecordRefusal, checkNotCiBreakRecordable } = await import('../ci-heal-escalation-mark.mjs');
  const { planVerdictVoid, runReconcileNotesAllRepos } = await import('../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
  const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ci-heal-verdict/pr4535-2026-10-09.json'), 'utf8'));
  const head = fixture.headRefOid;
  const settings = { recheckNotCiBreak: true };
  const voidComment = (headSha = head) => ({ author: AUTOMATION, createdAt: '2026-10-09T05:00:00Z',
    body: buildCiHealVerdictVoidComment({ headSha, red: ['test'] }) });
  const latest = (comments, recheck = true) => latestCiHealEscalationForHead(comments, head, { recheck });
  const escalation = latest(fixture.comments);
  const asOf = fixture.statusCheckRollup.filter((r) => r.startedAt <= fixture.escalationAt)
    .map((r) => r.completedAt > fixture.escalationAt ? { ...r, status: 'IN_PROGRESS', conclusion: null } : r);
  const refusal = (overrides = {}) => notCiBreakRecordRefusal({ headSha: head, pr: fixture, requiredChecks: fixture.requiredChecks, ...overrides });

  it('finds the real escalation and voids it only with rechecking enabled', () => {
    expect(escalation).toMatchObject({ outcome: 'not-a-ci-break', headSha: head, createdAt: fixture.escalationAt });
    const comments = [...fixture.comments, voidComment()];
    expect(latest(comments)).toBeNull();
    expect(latest(comments, false)).toEqual(escalation);
  });
  it('ignores untrusted voids', () => expect(latest([...fixture.comments, { ...voidComment(), author: { login: 'rando' } }])).toEqual(escalation));
  it('ignores voids for another head', () => expect(latest([...fixture.comments, voidComment('abcdef0123456789')])).toEqual(escalation));
  it('thread order prevents an earlier void from hiding a later escalation', () => expect(latest([voidComment(), ...fixture.comments])).toEqual(escalation));
  it('a voided verdict does not hide a later needs-human escalation', () => {
    const human = { author: AUTOMATION, body: buildCiHealEscalationComment({ headSha: head, outcome: 'needs-human', reason: 'Needs judgment' }) };
    expect(latest([...fixture.comments, voidComment(), human])).toMatchObject({ outcome: 'needs-human' });
  });
  it('a void never hides needs-human even when posted after it', () => {
    const human = { author: AUTOMATION, body: buildCiHealEscalationComment({ headSha: head, outcome: 'needs-human' }) };
    expect(latest([human, voidComment()])).toMatchObject({ outcome: 'needs-human' });
  });
  it('round-trips lowercase heads and check names without confusing marker types', () => {
    const c = { author: AUTOMATION, body: buildCiHealVerdictVoidComment({ headSha: head.toUpperCase(), red: ['test', 'daemon-soak'] }) };
    expect(c.body.startsWith(CI_HEAL_VERDICT_VOID_MARKER)).toBe(true);
    expect(parseCiHealVerdictVoids([c])).toEqual([{ headSha: head, red: ['test', 'daemon-soak'], createdAt: null, index: 0 }]);
    expect(parseCiHealVerdictVoids(fixture.comments)).toEqual([]);
    expect(parseCiHealEscalations([c])).toEqual([]);
  });
  it('refuses the unfinished snapshot', () => expect(refusal({ pr: { ...fixture, statusCheckRollup: asOf } })).toContain('test'));
  it('refuses the final red snapshot as a CI break', () => {
    expect(refusal()).toContain('red: test');
    expect(refusal()).toContain('IS a CI break');
  });
  it('accepts all required checks green', () => {
    const statusCheckRollup = fixture.requiredChecks.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
    expect(refusal({ pr: { ...fixture, statusCheckRollup } })).toBeNull();
  });
  it('does not judge a different head or unknown required set', () => {
    expect(refusal({ headSha: 'abcdef0123456789' })).toBeNull();
    expect(refusal({ requiredChecks: [] })).toBeNull();
  });

  const recordOptions = () => ({ pr: 4535, repo: fixture.repo, headSha: head, outcome: 'not-a-ci-break', settings,
    readPr: vi.fn(() => fixture), readRequired: vi.fn(async () => ({ checks: fixture.requiredChecks })) });
  it.each([{ outcome: 'needs-human' }, { settings: { recheckNotCiBreak: false } }])('skips reads for %j', async (overrides) => {
    const opts = { ...recordOptions(), ...overrides };
    expect(await checkNotCiBreakRecordable(opts)).toEqual({ refusal: null });
    expect(opts.readPr).not.toHaveBeenCalled();
    expect(opts.readRequired).not.toHaveBeenCalled();
  });
  it('reports a read warning without refusing on missing evidence', async () => {
    const opts = recordOptions();
    opts.readPr.mockImplementation(() => { throw new Error('offline'); });
    expect(await checkNotCiBreakRecordable(opts)).toEqual({ refusal: null, warning: expect.stringContaining('offline') });
    expect(opts.readRequired).not.toHaveBeenCalled();
  });
  it('refuses with injected PR and asynchronous required-check readers', async () => {
    const opts = recordOptions();
    expect(await checkNotCiBreakRecordable(opts)).toEqual({ refusal: expect.stringContaining('red: test') });
    expect(opts.readPr).toHaveBeenCalledWith({ pr: 4535, repo: fixture.repo });
    expect(opts.readRequired).toHaveBeenCalledWith({ repo: fixture.repo });
  });

  const note = { kind: 'ci-heal-escalated', outcome: 'not-a-ci-break', headSha: head, prNumber: 4535 };
  const planOptions = () => ({ note, pr: fixture, repo: fixture.repo, verdictSettings: settings,
    readRequiredChecks: vi.fn(() => fixture.requiredChecks) });
  it('plans a verdict void from the daemon note and deduplicates a trusted void', () => {
    expect(planVerdictVoid(planOptions())).toMatchObject({ kind: 'ci-heal-verdict-void', alreadyPosted: false, body: voidComment().body });
    expect(planVerdictVoid({ ...planOptions(), pr: { ...fixture, comments: [...fixture.comments, voidComment()] } })).toMatchObject({ alreadyPosted: true });
  });
  it('off avoids required-check reads', () => {
    const opts = { ...planOptions(), verdictSettings: { recheckNotCiBreak: false } };
    expect(planVerdictVoid(opts)).toBeNull();
    expect(opts.readRequiredChecks).not.toHaveBeenCalled();
  });
  it.each([true, false])('notes daemon plans/posts the void with dryRun=%s', (dryRun) => {
    const postComment = vi.fn(() => ({ ok: true }));
    const result = runReconcileNotesAllRepos({ repos: [fixture.repo], verdictSettings: settings,
      readRequiredChecks: () => fixture.requiredChecks, dryRun, postComment,
      tick: () => ({ notes: [note], prsByNumber: new Map([[4535, fixture]]) }) });
    expect(result.comments).toEqual([expect.objectContaining({ kind: 'ci-heal-verdict-void', body: voidComment().body, posted: !dryRun, dryRun })]);
    expect(postComment).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    if (!dryRun) expect(postComment).toHaveBeenCalledWith({ repo: fixture.repo, pr: 4535, body: voidComment().body });
  });
});
