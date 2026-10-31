/**
 * @file scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs
 * @description we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — pins the durable, HEAD-SCOPED
 *   ci-heal escalation marker: build/parse round-trip, the trusted-author gate (mirrors every sibling marker),
 *   and the head-scoping that makes a new push re-arm auto-heal with no human intervention. Real incident:
 *   web-everything/web-everything#2783 (three ci-heal sessions in one evening, each escalating identically on the
 *   same head with nothing durable recorded).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCiHealEscalationComment, parseCiHealEscalations, latestCiHealEscalationForHead,
  escalationStaleAgainstBase, enrichPrsWithEscalationBaseFacts, defaultReadBaseHead,
  buildInheritedRedBaseNote, CI_HEAL_INHERITED_BASE_NOTE_MARKER,
  composeCiHealEscalation, CI_HEAL_ESCALATION_MARKER, CI_HEAL_ESCALATION_OUTCOMES, postOrOweCiHealEscalation,
  checkNeedsHumanEscalable, checkNotCiBreakRecordable,
} from '../ci-heal-escalation-mark.mjs';
import { collectCiAuthDiagnosis } from '../ci-auth-diagnosis.mjs';
import { owedWriteAlreadyLive } from '../ci-heal-owed.mjs';
import { budgetBlockedMessage } from '../../lib/gh-throttle.mjs';

const AUTOMATION = { login: 'web-everything' };
const HEAD = '70326866f0f299ddd005f9da54f0b87a3c169ac4'; // PR #2783's real head, 2026-09-27

describe('CI_HEAL_ESCALATION_OUTCOMES', () => {
  it('is exactly the four-valued enum the file header describes', () => {
    expect(CI_HEAL_ESCALATION_OUTCOMES).toEqual(['needs-human', 'waiting-on-system-fix', 'not-a-ci-break', 'inherited-from-base']);
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
  const { CI_HEAL_VERDICT_VOID_MARKER, buildCiHealVerdictVoidComment, parseCiHealVerdictVoids,
    notCiBreakRecordRefusal, checkNotCiBreakRecordable, needsHumanGateOnlyRefusal,
    checkNeedsHumanEscalable } = await import('../ci-heal-escalation-mark.mjs');
  const { MAX_VERDICT_VOIDS_PER_HEAD, planVerdictVoid, runReconcileNotesAllRepos } = await import('../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
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
    expect(parseCiHealVerdictVoids([c])).toEqual([{ voids: 'not-a-ci-break', headSha: head, red: ['test', 'daemon-soak'], createdAt: null, index: 0 }]);
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
  it('#5925: cancelled smoke and red review-gate allow a not-a-ci-break record', () => {
    const statusCheckRollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'smoke', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    expect(refusal({ pr: { ...fixture, statusCheckRollup }, requiredChecks: ['test', 'smoke', 'review-gate'] })).toBeNull();
  });
  it.each(['IN_PROGRESS', 'MISSING', 'FAILURE'])('cancelled smoke does not excuse %s real work', state => {
    const statusCheckRollup = [
      { name: 'smoke', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
      ...(state === 'MISSING' ? [] : [{ name: 'test', status: state === 'IN_PROGRESS' ? state : 'COMPLETED', conclusion: state === 'FAILURE' ? state : null }]),
    ];
    expect(refusal({ pr: { ...fixture, statusCheckRollup }, requiredChecks: ['test', 'smoke', 'review-gate'] })).toContain('test');
  });
  it('a newer real failure still refuses after an older cancellation', () => {
    const statusCheckRollup = [
      { name: 'smoke', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-26T10:00:00Z' },
      { name: 'smoke', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-26T11:00:00Z' },
    ];
    expect(refusal({ pr: { ...fixture, statusCheckRollup }, requiredChecks: ['smoke'] })).toContain('red: smoke');
  });
  it('does not judge a different head or unknown required set', () => {
    expect(refusal({ headSha: 'abcdef0123456789' })).toBeNull();
    expect(refusal({ requiredChecks: [] })).toBeNull();
  });

  const recordOptions = () => ({ pr: 4535, repo: fixture.repo, headSha: head, outcome: 'not-a-ci-break', settings,
    readPr: vi.fn(() => fixture), readRequired: vi.fn(async () => ({ checks: fixture.requiredChecks })) });

  it.each([
    ['not-a-ci-break', checkNotCiBreakRecordable],
    ['needs-human', checkNeedsHumanEscalable],
  ])('%s classification errors abort recording instead of becoming read warnings', async (outcome, preflight) => {
    for (const malformed of [{}, { name: '' }, { context: '' }, { name: 123 }, null]) {
      for (const reverse of [false, true]) {
        const rows = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, malformed];
        await expect(preflight({ ...recordOptions(), outcome,
          readPr: () => ({ ...fixture, statusCheckRollup: reverse ? rows.toReversed() : rows }),
          readRequired: async () => ({ checks: ['test'] }),
        })).rejects.toThrow(TypeError);
      }
    }
  });

  describe('gate-only red and cancelled-check recording regressions', () => {
    const check = (name, conclusion, extra = {}) => ({ name, status: 'COMPLETED', conclusion, ...extra });
    const gatePr = (statusCheckRollup = [check('test', 'SUCCESS'), check('review-gate', 'FAILURE')]) => ({
      ...fixture, statusCheckRollup,
    });
    const humanRefusal = (overrides = {}) => needsHumanGateOnlyRefusal({
      headSha: head, pr: gatePr(), requiredChecks: ['test'], ...overrides,
    });
    it.each([1, 2, 3])('does not match a --head prefix of %i characters', length => {
      expect(humanRefusal({ headSha: head.slice(0, length) })).toBeNull();
    });

    const humanOptions = () => ({ ...recordOptions(), outcome: 'needs-human',
      readPr: vi.fn(() => gatePr()), readRequired: vi.fn(async () => ({ checks: ['test'] })) });

    const requiredStates = ['SUCCESS', 'FAILURE', 'CANCELLED', 'STALE', 'IN_PROGRESS', 'MISSING'];
    const gateStates = ['SUCCESS', 'FAILURE', 'IN_PROGRESS', 'MISSING'];
    it.each(['review-gate', 'merge-gate'].flatMap(gate => requiredStates.flatMap(required =>
      gateStates.map(state => ({ gate, required, state })))))(
      'both preflights: required=$required, $gate=$state', async ({ gate, required, state }) => {
        const row = (name, value) => value === 'MISSING' ? []
          : [check(name, value === 'IN_PROGRESS' ? null : value,
            { status: value === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'COMPLETED',
              ...(name === 'merge-gate' && value === 'FAILURE'
                ? { mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 } } : {}) })];
        const readers = { readPr: () => gatePr([...row('test', required), ...row(gate, state)]),
          readRequired: async () => ({ checks: ['test', gate] }) };
        const human = await checkNeedsHumanEscalable({ ...humanOptions(), ...readers });
        const notCi = await checkNotCiBreakRecordable({ ...recordOptions(), ...readers });
        expect(human.refusal !== null).toBe(required === 'SUCCESS' && state === 'FAILURE');
        expect(notCi.refusal !== null).toBe(required !== 'SUCCESS'
          || (gate === 'merge-gate' && ['IN_PROGRESS', 'MISSING'].includes(state)));
      },
    );

    it.each([
      ['needs-human', checkNeedsHumanEscalable], ['not-a-ci-break', checkNotCiBreakRecordable],
    ])('%s honors explicit off and default settings resolution', async (outcome, preflight) => {
      const opts = { ...humanOptions(), outcome,
        readPr: vi.fn(() => gatePr(outcome === 'needs-human'
          ? [check('test', 'SUCCESS'), check('review-gate', 'FAILURE')]
          : [check('test', 'CANCELLED'), check('review-gate', 'FAILURE')])) };
      expect(await preflight({ ...opts, settings: { recheckNotCiBreak: false } })).toEqual({ refusal: null });
      expect(opts.readPr).not.toHaveBeenCalled();
      expect(opts.readRequired).not.toHaveBeenCalled();
      const previous = process.env.WE_CI_HEAL_RECHECK_NOT_CI_BREAK;
      try {
        for (const value of ['off', 'on', undefined]) {
          if (value === undefined) delete process.env.WE_CI_HEAL_RECHECK_NOT_CI_BREAK;
          else process.env.WE_CI_HEAL_RECHECK_NOT_CI_BREAK = value;
          opts.readPr.mockClear();
          opts.readRequired.mockClear();
          const result = await preflight({ ...opts, settings: undefined });
          expect(result.refusal !== null).toBe(value !== 'off');
          expect(opts.readPr).toHaveBeenCalledTimes(value === 'off' ? 0 : 1);
          expect(opts.readRequired).toHaveBeenCalledTimes(value === 'off' ? 0 : 1);
        }
      } finally {
        if (previous === undefined) delete process.env.WE_CI_HEAL_RECHECK_NOT_CI_BREAK;
        else process.env.WE_CI_HEAL_RECHECK_NOT_CI_BREAK = previous;
      }
    });

    it('#6004/#5979: green required test plus red review-gate permits not-a-ci-break and refuses needs-human', () => {
      expect(refusal({ pr: gatePr(), requiredChecks: ['test'] })).toBeNull();
      const message = humanRefusal();
      expect(message).toEqual(expect.any(String));
      expect(message).toContain('review-gate');
      expect(message).toMatch(/not (?:a )?CI break|review.{0,30}owed/i);
      expect(message).toMatch(/(?:do not|cannot|refus\w*|must not)[\s\S]*needs-human/i);
    });

    it('a proven merge-gate review hold refuses needs-human and names the gate', () => {
      expect(humanRefusal({ pr: gatePr([check('test', 'SUCCESS'), check('merge-gate', 'FAILURE',
        { mergeGateReviewHold: { holds: ['review-acceptance'], jobId: 123 } })]) }))
        .toEqual(expect.stringContaining('merge-gate'));
    });

    it('does not refuse needs-human for a different head', () => {
      expect(humanRefusal({ headSha: 'abcdef0123456789' })).toBeNull();
    });

    it('does not refuse needs-human for an empty required roster', () => {
      expect(humanRefusal({ requiredChecks: [] })).toBeNull();
    });

    it('a real required test failure plus red review-gate may escalate needs-human', () => {
      expect(humanRefusal({ pr: gatePr([check('test', 'FAILURE'), check('review-gate', 'FAILURE')]) })).toBeNull();
    });

    it.each([false, true])('mixed attempt metadata keeps a real CI break escalatable through injected readers (reverse=%s)', async reverse => {
      const rows = [
        check('test', 'SUCCESS', { __typename: 'CheckRun', run_attempt: 1, id: 100, completedAt: '2026-10-28T01:00:00Z' }),
        check('test', 'FAILURE', { __typename: 'CheckRun', completedAt: '2026-10-28T02:00:00Z' }),
      ];
      const pr = gatePr([...(reverse ? rows.toReversed() : rows), check('review-gate', 'FAILURE')]);
      const readers = { readPr: vi.fn(() => pr), readRequired: vi.fn(async () => ({ checks: ['test'] })) };
      await expect(checkNeedsHumanEscalable({ ...humanOptions(), ...readers })).resolves.toEqual({ refusal: null });
      await expect(checkNotCiBreakRecordable({ ...recordOptions(), ...readers })).resolves.toEqual({ refusal: expect.stringContaining('red: test') });
      expect(readers.readPr).toHaveBeenCalledTimes(2);
      expect(readers.readRequired).toHaveBeenCalledTimes(2);
    });

    it('does not refuse needs-human when there are no red checks', () => {
      expect(humanRefusal({ pr: gatePr([check('test', 'SUCCESS'), check('review-gate', 'SUCCESS')]) })).toBeNull();
    });

    it('optional CANCELLED smoke does not block recording not-a-ci-break', () => {
      expect(refusal({ requiredChecks: ['test'], pr: gatePr([
        check('test', 'SUCCESS'), check('smoke', 'CANCELLED'),
      ]) })).toBeNull();
    });

    it('required CANCELLED test blocks recording as still running or pending, not as red', () => {
      const message = refusal({ requiredChecks: ['test'], pr: gatePr([check('test', 'CANCELLED')]) });
      expect(message).toEqual(expect.any(String));
      expect(message).toMatch(/(?:still running|pending):[^.]*test/i);
      expect(message).not.toMatch(/red:|IS a CI break/);
    });

    it('optional cancelled smoke cannot hide an IN_PROGRESS required test', () => {
      const message = refusal({ requiredChecks: ['test'], pr: gatePr([
        check('smoke', 'CANCELLED'), check('test', null, { status: 'IN_PROGRESS' }),
      ]) });
      expect(message).toEqual(expect.any(String));
      expect(message).toMatch(/(?:still running|pending):[^.]*test/i);
      expect(message).not.toContain('smoke');
    });

    it('checkNeedsHumanEscalable refuses gate-only red using injected PR and required-check readers', async () => {
      const opts = humanOptions();
      expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: humanRefusal() });
      expect(opts.readPr).toHaveBeenCalledWith({ pr: 4535, repo: fixture.repo });
      expect(opts.readRequired).toHaveBeenCalledWith({ repo: fixture.repo });
    });

    it('checkNeedsHumanEscalable permits a real CI failure with injected readers', async () => {
      const opts = humanOptions();
      opts.readPr.mockReturnValue(gatePr([check('test', 'FAILURE'), check('review-gate', 'FAILURE')]));
      expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null });
    });

    it.each(['not-a-ci-break', 'waiting-on-system-fix', 'inherited-from-base'])(
      'checkNeedsHumanEscalable skips both readers for outcome %s', async outcome => {
        const opts = { ...humanOptions(), outcome };
        expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null });
        expect(opts.readPr).not.toHaveBeenCalled();
        expect(opts.readRequired).not.toHaveBeenCalled();
      },
    );

    it.each(['readPr', 'readRequired'])(
      'checkNeedsHumanEscalable reports a warning and no refusal when %s fails', async reader => {
        const opts = humanOptions();
        opts[reader].mockImplementation(() => { throw new Error('offline'); });
        expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null, warning: expect.stringContaining('offline') });
        if (reader === 'readPr') expect(opts.readRequired).not.toHaveBeenCalled();
      },
    );

    it('checkNeedsHumanEscalable reports an asynchronous required-roster read failure', async () => {
      const opts = humanOptions();
      opts.readRequired.mockRejectedValue(new Error('required roster unavailable'));
      expect(await checkNeedsHumanEscalable(opts)).toEqual({
        refusal: null, warning: expect.stringContaining('required roster unavailable'),
      });
    });
  });

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
  // Finding on PR #4560: a void is keyed by head only, so one earlier void hid every later contradicted verdict on the
  // same head. A void owes nothing only when it comes AFTER the latest not-a-ci-break verdict.
  describe('a second contradicted verdict on a head that already has a void', () => {
    const verdict = (n) => ({ author: AUTOMATION, createdAt: `2026-10-09T0${n}:00:00Z`,
      body: buildCiHealEscalationComment({ headSha: head, outcome: 'not-a-ci-break', reason: `verdict ${n}` }) });
    const prWith = (comments) => ({ ...fixture, comments });
    it('owes a fresh void for a later verdict', () => {
      const comments = [verdict(1), voidComment(), verdict(2)];
      expect(planVerdictVoid({ ...planOptions(), pr: prWith(comments) })).toMatchObject({ alreadyPosted: false, body: voidComment().body });
    });
    it('is satisfied once a void follows the later verdict', () => {
      const comments = [verdict(1), voidComment(), verdict(2), voidComment()];
      expect(planVerdictVoid({ ...planOptions(), pr: prWith(comments) })).toMatchObject({ alreadyPosted: true });
    });
    it('is satisfied by the single void after the single verdict', () => {
      expect(planVerdictVoid({ ...planOptions(), pr: prWith([verdict(1), voidComment()]) })).toMatchObject({ alreadyPosted: true });
    });
    it('gives each verdict episode its own row key', () => {
      const first = planVerdictVoid({ ...planOptions(), pr: prWith([verdict(1)]) });
      const second = planVerdictVoid({ ...planOptions(), pr: prWith([verdict(1), voidComment(), verdict(2)]) });
      expect(first.key).not.toBe(second.key);
    });
    it('ignores an untrusted void and a void for another head', () => {
      const comments = [verdict(1), { ...voidComment(), author: { login: 'rando' } }, voidComment('abcdef0123456789')];
      expect(planVerdictVoid({ ...planOptions(), pr: prWith(comments) })).toMatchObject({ alreadyPosted: false });
    });
    it('stops voiding a head after the cap so a flapping check cannot grow the thread forever', () => {
      const cycles = Array.from({ length: MAX_VERDICT_VOIDS_PER_HEAD }, (_, i) => [verdict(i + 1), voidComment()]).flat();
      expect(planVerdictVoid({ ...planOptions(), pr: prWith([...cycles, verdict(9)]) })).toBeNull();
      const fewer = cycles.slice(2);
      expect(planVerdictVoid({ ...planOptions(), pr: prWith([...fewer, verdict(9)]) })).toMatchObject({ alreadyPosted: false });
    });
    it('keeps a check name on one line of the void marker', () => {
      const body = buildCiHealVerdictVoidComment({ headSha: head, red: ['test\nhead: deadbeefdeadbeef', 'lint'] });
      expect(body.split('\n').filter((l) => l.startsWith('head:'))).toEqual([`head: ${head}`]);
      expect(parseCiHealVerdictVoids([{ author: AUTOMATION, body }])).toEqual([
        expect.objectContaining({ headSha: head, red: ['test head: deadbeefdeadbeef', 'lint'] })]);
    });
    it('the notes daemon posts the second void', () => {
      const postComment = vi.fn(() => ({ ok: true }));
      const result = runReconcileNotesAllRepos({ repos: [fixture.repo], verdictSettings: settings,
        readRequiredChecks: () => fixture.requiredChecks, dryRun: false, postComment,
        tick: () => ({ notes: [note], prsByNumber: new Map([[4535, prWith([verdict(1), voidComment(), verdict(2)])]]) }) });
      expect(postComment).toHaveBeenCalledTimes(1);
      expect(result.comments).toEqual([expect.objectContaining({ kind: 'ci-heal-verdict-void', posted: true })]);
    });
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


describe('stacked base escalation facts (#4792)', () => {
  const createdAt = '2026-10-11T16:34:56Z';
  const comment = (extra = {}) => ({ author: AUTOMATION, createdAt,
    body: buildCiHealEscalationComment({ headSha: HEAD, outcome: 'needs-human', ...extra }) });

  it('round-trips inherited red and requires both base fields', () => {
    const fields = { outcome: 'inherited-from-base', basePr: 4779, baseHeadSha: 'ABC1234' };
    expect(parseCiHealEscalations([comment(fields)])[0]).toMatchObject({
      outcome: 'inherited-from-base', basePr: '4779', baseHeadSha: 'abc1234',
    });
    for (const missing of ['basePr', 'baseHeadSha']) {
      expect(() => comment({ ...fields, [missing]: null })).toThrow(TypeError);
    }
    expect(composeCiHealEscalation({ head: HEAD, outcome: fields.outcome,
      'base-pr': '4779', 'base-head': 'ABC1234' })).toContain('base-head: abc1234');
  });

  it('allows needs-human to record a base head, and preserves legacy nulls', () => {
    expect(parseCiHealEscalations([comment({ baseHeadSha: 'ABC1234' })])[0])
      .toMatchObject({ baseHeadSha: 'abc1234', basePr: null });
    expect(parseCiHealEscalations([comment()])[0]).toMatchObject({ baseHeadSha: null, basePr: null });
  });

  it.each([
    [{ baseHeadSha: 'abc' }, { sha: 'def' }, true],
    [{ baseHeadSha: 'ABC' }, { sha: 'abc', committedAt: '2026-10-12' }, false],
    [{ createdAt }, { committedAt: '2026-10-11T16:44:54Z' }, true],
    [{ createdAt }, { committedAt: '2026-10-11T16:24:54Z' }, false],
    [{ createdAt }, { committedAt: createdAt }, false],
    [{ createdAt }, { committedAt: 'invalid' }, false],
    [{ createdAt: 'invalid' }, { committedAt: createdAt }, false],
    [{ baseHeadSha: 'abc', createdAt }, { committedAt: '2026-10-12' }, false],
    [null, { sha: 'abc' }, false], [{ createdAt }, null, false], [{}, {}, false],
  ])('staleness: %j against %j → %s', (escalation, baseHead, stale) => {
    expect(escalationStaleAgainstBase(escalation, baseHead)).toBe(stale);
  });

  it('only invalidates the latest matching verdict when base facts are supplied', () => {
    const comments = [comment(), comment({ baseHeadSha: 'abc' })];
    expect(latestCiHealEscalationForHead(comments, HEAD)?.baseHeadSha).toBe('abc');
    expect(latestCiHealEscalationForHead(comments, HEAD, { baseHead: { sha: 'def' } })).toBeNull();
    expect(latestCiHealEscalationForHead(comments, HEAD, { baseHead: { sha: 'ABC' } })).not.toBeNull();
  });

  it('reads each eligible base once, preserving untouched objects including failed reads', () => {
    const pr = { headRefOid: HEAD, baseRefName: 'lane/base', comments: [comment()] };
    const prs = [pr, { ...pr }, { ...pr, baseRefName: 'trunk' }, { ...pr, comments: [] },
      { ...pr, baseRefName: 'lane/missing' }, { ...pr, baseRefName: 'lane/missing' },
      { ...pr, baseRefName: null }, { ...pr, headRefOid: 'new' }];
    const calls = [];
    const facts = { sha: 'abc', committedAt: createdAt };
    const result = enrichPrsWithEscalationBaseFacts(prs, { repo: 'owner/repo', defaultBranch: 'trunk',
      readBaseHead: (ref, options) => { calls.push([ref, options]); return ref === 'lane/base' ? facts : null; } });
    expect(calls).toEqual([['lane/base', { repo: 'owner/repo' }], ['lane/missing', { repo: 'owner/repo' }]]);
    expect(result[0]).toEqual({ ...pr, escalationBaseHead: facts });
    expect(result[1].escalationBaseHead).toEqual(facts);
    for (let i = 2; i < prs.length; i++) expect(result[i]).toBe(prs[i]);
    expect(enrichPrsWithEscalationBaseFacts(null)).toEqual([]);
  });

  it.each([undefined, null, '', false])('skips GitHub without an explicit repo (%s)', repo => {
    const exec = vi.fn();
    expect(defaultReadBaseHead('lane/base', { repo, exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads encoded GitHub branch facts and tolerates command/JSON failures', () => {
    const calls = [];
    const exec = (...args) => { calls.push(args); return JSON.stringify({ sha: 'abc', committedAt: createdAt }); };
    expect(defaultReadBaseHead('lane/base', { repo: 'owner/repo', exec })).toEqual({ sha: 'abc', committedAt: createdAt });
    expect(calls[0][0]).toBe('gh');
    expect(calls[0][1]).toEqual(['api', 'repos/owner/repo/branches/lane%2Fbase', '--jq',
      '{sha: .commit.sha, committedAt: .commit.commit.committer.date}']);
    expect(calls[0][2]).toMatchObject({ timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(defaultReadBaseHead('base', { repo: 'owner/repo', exec: () => { throw Error('offline'); } })).toBeNull();
    expect(defaultReadBaseHead('base', { repo: 'owner/repo', exec: () => 'bad json' })).toBeNull();
    expect(defaultReadBaseHead('base', { repo: 'owner/repo', exec: () => '{}' })).toBeNull();
  });

  it('addresses the base fixer with a distinct leading marker', () => {
    const body = buildInheritedRedBaseNote({ stackedPr: 4792, stackedHead: HEAD, baseHeadSha: 'abc', reason: 'base test' });
    expect(body.split('\n')[0]).toBe(CI_HEAL_INHERITED_BASE_NOTE_MARKER);
    expect(body).toContain('stacked-pr: #4792');
    expect(body).toContain('base-head: abc');
    expect(body).toContain('reason: base test');
    expect(body).toContain("this PR's fixer");
  });
});


describe('needs-human CLI preflight wiring — #6004/#5979', () => {
  it.each([
    ['review-gate', [], 'review'],
    ['merge-gate', [{ name: 'ready-to-merge' }], 'review'], ['merge-gate', [], 'review'],
    ['merge-gate', [], 'job-failure'], ['merge-gate', [], 'other-head'],
    ['merge-gate', [], 'truncated'], ['merge-gate', [], 'unreadable'],
    ['review-gate', [], 'malformed', 'not-a-ci-break'],
    ['review-gate', [], 'malformed', 'needs-human'],
    ['merge-gate', [], 'conflicting-flags', 'not-a-ci-break'],
    ['merge-gate', [], 'conflicting-flags', 'needs-human'],
  ])('classifies raw %s with labels %j and %s evidence before posting (outcome=%s)', (gate, labels, evidence, outcome = 'needs-human') => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-gate-cli-'));
    try {
      const log = join(dir, 'calls.jsonl');
      const preload = join(dir, 'preload.mjs');
      // Exercise the real CLI and default readers without launching gh or touching shared caches.
      writeFileSync(join(dir, 'required-status-checks-cache.json'), JSON.stringify({ entries: {
        'web-everything/web-everything@main': { checks: ['test', ...(gate === 'merge-gate' ? ['merge-gate'] : [])], fetchedAtMs: Date.now(), source: 'live' },
      } }));
      writeFileSync(preload, `
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const facts = ${JSON.stringify({ number: 6042, labels, headRefOid: HEAD, statusCheckRollup: [
  { name: 'test', status: 'COMPLETED', conclusion: evidence === 'malformed' ? 'FAILURE' : 'SUCCESS' },
  ...(evidence === 'malformed' ? [{}] : []),
  ...(evidence === 'conflicting-flags' ? [
    { name: gate, status: 'COMPLETED', conclusion: 'FAILURE', required: false },
  ] : []),
  { name: gate, status: 'COMPLETED', conclusion: 'FAILURE',
    ...(gate === 'merge-gate' ? { detailsUrl: 'https://github.com/web-everything/web-everything/actions/runs/100/job/123' } : {}) },
] })};
for (const method of ['execFileSync', 'spawnSync', 'execSync', 'exec', 'execFile', 'spawn']) {
  cp[method] = (...args) => {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, args: args.slice(0, 2) }) + '\\n');
    if (method === 'execFileSync' && args[0] === 'gh') {
      if (args[1][0] === 'pr' && args[1][1] === 'view') return JSON.stringify(facts);
      if (args[1][0] === 'api' && args[1][1] === 'repos/web-everything/web-everything/actions/jobs/123') {
        if (${JSON.stringify(evidence)} === 'unreadable') return 'invalid JSON';
        return JSON.stringify({ head_sha: ${JSON.stringify(evidence === 'other-head' ? 'a'.repeat(40) : HEAD)}, completed_at: '2026-10-29T03:00:00Z' });
      }
      if (args[1][0] === 'api' && args[1][1] === 'repos/web-everything/web-everything/actions/jobs/123/logs')
        return ${JSON.stringify('#6042: HOLD\n  hold review-acceptance review pending\n'
          + (evidence === 'job-failure' ? '  fail-closed codeql security check failed\n' : '')
          + (evidence === 'truncated' ? '' : 'merge-gate: HOLD — held\n'))};
    }
    throw new Error('unexpected child process in CLI preflight test');
  };
}
syncBuiltinESMExports();
`);
      const result = spawnSync(process.execPath, ['--import', preload,
        join(dirname(fileURLToPath(import.meta.url)), '..', 'ci-heal-escalation-mark.mjs'), '6042',
        `--head=${HEAD}`, `--base-head=${HEAD}`, `--outcome=${outcome}`, '--repo=web-everything/web-everything'], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '', WE_COORDINATION_ROOT: dir,
          WE_CI_HEAL_RECHECK_NOT_CI_BREAK: 'on', MERGE_GATE_CANDIDACY_HOLD_IS_NOT_CI_FAILURE: 'on',
          WE_GH_THROTTLE_COST_HEADERS: '0',
          WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle') },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      if (['malformed', 'conflicting-flags'].includes(evidence)) {
        expect(result.stderr).toContain(evidence === 'malformed'
          ? 'Check rows must have a non-empty string name or context'
          : 'Check rows have conflicting required flags');
        expect(result.stderr).not.toContain('could not re-check');
        expect(result.stderr).not.toContain('could not post');
      } else if (evidence === 'review') {
        expect(result.stderr).toContain('refusing to record needs-human on PR #6042');
        expect(result.stderr).toContain(gate);
      } else {
        expect(result.stderr).not.toContain('refusing to record needs-human');
        // The posting seam is deliberately closed: real/unknown failures may
        // escalate, but this fixture never writes a comment or changes labels.
        expect(result.stderr).toContain('could not post CI-heal escalation comment');
      }
      expect(result.stdout).toBe('');
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const reads = calls.filter(call => call.args[0] === 'gh' && ['pr', 'api'].includes(call.args[1]?.[0])
        && call.args[1][1] !== 'comment');
      expect(reads[0].args).toEqual(['gh', ['pr', 'view', '6042', '--json',
        'number,labels,headRefOid,statusCheckRollup,url', '--repo=web-everything/web-everything']]);
      expect(reads.map(call => call.args[1].slice(0, 2))).toEqual([
        ['pr', 'view'], ...(gate === 'merge-gate' && evidence !== 'conflicting-flags' ? [
          ['api', 'repos/web-everything/web-everything/actions/jobs/123'],
          ...(evidence === 'unreadable' ? [] : [['api', 'repos/web-everything/web-everything/actions/jobs/123/logs']]),
        ] : []),
      ]);
      if (['review', 'malformed', 'conflicting-flags'].includes(evidence)) expect(calls).toEqual(reads);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('inherited-red CLI routing', () => {
  it.each([false, true])('resolves the base on GitHub and tolerates a failed base note (%s)', failNote => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-base-'));
    try {
      const log = join(dir, 'calls.jsonl');
      const stub = join(dir, 'gh');
      writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'repo') console.log('main');
else if (args[0] === 'api') console.log(JSON.stringify({ sha: 'abc1234', committedAt: '2026-10-11T16:44:54Z' }));
else if (args[1] === 'list') console.log('4779');
else if (args[1] === 'view') console.log(JSON.stringify({ baseRefName: 'lane/takeover-budget', headRefOid: '${HEAD}', labels: [{ name: 'review-status:fixing' }] }));
else if (args[1] === 'comment' && args[2] === '4779' && ${failNote}) { console.error('base note unavailable'); process.exit(1); }
`);
      chmodSync(stub, 0o755);
      const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'ci-heal-escalation-mark.mjs'),
        '4792', '--repo=web-everything/web-everything', `--head=${HEAD}`, '--outcome=inherited-from-base', '--reason=base test'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: '', PATH: `${dir}:${process.env.PATH}`, WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle') },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: 'inherited-from-base', baseNotePosted: !failNote });
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls).toContainEqual(['api', 'repos/web-everything/web-everything/branches/lane%2Ftakeover-budget',
        '--jq', '{sha: .commit.sha, committedAt: .commit.commit.committer.date}']);
      const posts = calls.filter(args => args[1] === 'comment');
      expect(posts.map(args => args[2])).toEqual(['4792', '4779']);
      expect(posts[0][4]).toContain('base-pr: #4779');
      expect(posts[0][4]).toContain('base-head: abc1234');
      expect(posts[1][4].split('\n')[0]).toBe(CI_HEAL_INHERITED_BASE_NOTE_MARKER);
      expect(calls.flat()).not.toContain('review-status:needs-human');
      if (failNote) expect(result.stderr).toContain('⚠ could not post inherited-red note');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('needs-human verdict void', async () => {
  const { buildCiHealVerdictVoidComment: buildVoid, parseCiHealVerdictVoids, needsHumanVoidState, notCiBreakVerdictVoidState } = await import('../ci-heal-escalation-mark.mjs');
  const { planNeedsHumanVoid, MAX_VERDICT_VOIDS_PER_HEAD, runReconcileNotesAllRepos } = await import('../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs');
  const escalation = (outcome = 'needs-human') => ({ author: AUTOMATION, body: buildCiHealEscalationComment({ headSha: HEAD, outcome }) });
  const voidComment = (voids = 'needs-human', headSha = HEAD) => ({ author: AUTOMATION, body: buildVoid({ headSha, voids, cause: 'ci-green\nnow' }) });
  const options = (comments = [escalation()]) => ({
    note: { kind: 'ci-heal-escalation-moot', prNumber: 5012, headSha: HEAD, outcome: 'needs-human' },
    repo: 'we', verdictSettings: { voidNeedsHumanWhenCiGreen: true },
    pr: { headRefOid: HEAD, state: 'OPEN', comments, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    readRequiredChecks: () => ['test'],
  });
  it('preserves the original not-a-ci-break comment byte for byte', () => {
    expect(buildVoid({ headSha: HEAD, red: ['test'] })).toBe([
      '🚦 conveyor CI-heal — verdict void', '', 'voids: not-a-ci-break', 'head: ' + HEAD, 'red: test', '',
      'The earlier `not-a-ci-break` verdict on this exact head is no longer true: the required check(s) above completed '
        + 'FAILED after it was recorded. The verdict is void, so the ordinary CI-heal path (with its usual attempt cap) '
        + 'owns this head again. No person is needed for this step.',
    ].join('\n'));
  });
  it('builds and parses the new typed void with a single-line cause', () => {
    expect(voidComment().body).toContain('voids: needs-human\nhead: ' + HEAD + '\ncause: ci-green now');
    expect(parseCiHealVerdictVoids([voidComment()])[0]).toMatchObject({ voids: 'needs-human', headSha: HEAD });
  });
  it('honors the setting, head, trust and thread order', () => {
    const comments = [escalation(), voidComment()];
    expect(latestCiHealEscalationForHead(comments, HEAD, { voidNeedsHuman: true })).toBeNull();
    expect(latestCiHealEscalationForHead(comments, HEAD, { voidNeedsHuman: false })?.outcome).toBe('needs-human');
    for (const c of [voidComment('not-a-ci-break'), voidComment('needs-human', 'abcdef0123456789'), { ...voidComment(), author: { login: 'rando' } }]) {
      expect(latestCiHealEscalationForHead([escalation(), c], HEAD, { voidNeedsHuman: true })?.outcome).toBe('needs-human');
    }
    expect(latestCiHealEscalationForHead([voidComment(), escalation()], HEAD, { voidNeedsHuman: true })?.outcome).toBe('needs-human');
    expect(latestCiHealEscalationForHead([escalation('not-a-ci-break'), voidComment()], HEAD, { recheck: true })?.outcome).toBe('not-a-ci-break');
    expect(notCiBreakVerdictVoidState([escalation('not-a-ci-break'), voidComment()], HEAD).voidCount).toBe(0);
    expect(needsHumanVoidState(comments, HEAD)).toEqual({ escalationIndex: 0, voided: true, voidCount: 1 });
  });
  it('plans once per escalation, dedupes and caps', () => {
    expect(planNeedsHumanVoid(options())).toMatchObject({ key: 'ci-heal-needs-human-void:5012:' + HEAD + ':0', alreadyPosted: false });
    expect(planNeedsHumanVoid(options([escalation(), voidComment()]))).toMatchObject({ alreadyPosted: true });
    const cycles = Array.from({ length: MAX_VERDICT_VOIDS_PER_HEAD }, () => [escalation(), voidComment()]).flat();
    expect(planNeedsHumanVoid(options([...cycles, escalation()]))).toBeNull();
    expect(planNeedsHumanVoid(options([escalation(), voidComment(), escalation()]))).toMatchObject({ alreadyPosted: false });
  });
  it('re-verifies facts and never falls through to an operator note', () => {
    const o = options();
    for (const override of [
      { verdictSettings: { voidNeedsHumanWhenCiGreen: false } },
      { pr: { ...o.pr, headRefOid: 'abcdef0123456789' } },
      { pr: { ...o.pr, mergeStateStatus: 'DIRTY' } },
      { pr: { ...o.pr, codeqlFailure: { reason: 'security alert' } } },
      { pr: { ...o.pr, comments: [] } },
      { pr: { ...o.pr, statusCheckRollup: [] } },
    ]) {
      expect(planNeedsHumanVoid({ ...o, ...override })).toBeNull();
      const postComment = vi.fn(() => ({ ok: true }));
      runReconcileNotesAllRepos({ ...o, ...override, repos: ['we'], dryRun: false, postComment,
        tick: () => ({ notes: [o.note], prsByNumber: new Map([[5012, override.pr ?? o.pr]]) }) });
      expect(postComment).not.toHaveBeenCalled();
    }
    const postComment = vi.fn(() => ({ ok: true }));
    runReconcileNotesAllRepos({ ...o, repos: ['we'], dryRun: false, postComment,
      tick: () => ({ notes: [o.note], prsByNumber: new Map([[5012, o.pr]]) }) });
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('voids: needs-human') }));
  });
});


describe('R4: default CLI check reader classifies merge-gate review holds', () => {
  const jobId = 123;
  const options = (overrides = {}) => {
    const facts = { number: 6042, url: 'https://github.com/example/repo/pull/6042',
      headRefOid: HEAD, labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'merge-gate', id: jobId, status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T13:00:00-04:00' },
      ] };
    return { pr: 6042, repo: 'example/repo', headSha: HEAD, outcome: 'needs-human',
      settings: { recheckNotCiBreak: true }, readRequired: () => ({ checks: ['test', 'merge-gate'] }),
      prChecksOptions: {
        runGh: vi.fn(() => JSON.stringify(facts)),
        readMergeGateVerdict: vi.fn(() => ({ num: 6042, head_sha: HEAD, ok: false,
          results: [{ id: 'review-acceptance', status: 'hold', reason: 'review pending' }] })),
        readFreeze: vi.fn(() => { throw new Error('freeze should be lazy'); }),
        mergeGateSetting: 'on', ...overrides,
      },
    };
  };

  it('refuses needs-human through the real default reader with injected classifier I/O', async () => {
    const opts = options();
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: expect.stringContaining('merge-gate') });
    expect(opts.prChecksOptions.readMergeGateVerdict).toHaveBeenCalledWith({ repo: 'example/repo', prNumber: 6042, jobId });
    expect(opts.prChecksOptions.runGh).toHaveBeenCalledWith(expect.arrayContaining([
      'pr', 'view', '6042', '--json', 'number,labels,headRefOid,statusCheckRollup,url',
    ]), expect.objectContaining({ maxBuffer: expect.any(Number), timeout: expect.any(Number) }));
    expect(opts.prChecksOptions.readFreeze).not.toHaveBeenCalled();
  });

  it('also refuses a review:pending candidate whose merge-gate was excused for review work', async () => {
    const opts = options();
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.labels = [{ name: 'review:pending' }];
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: expect.stringContaining('merge-gate') });
  });

  it('R3: real npm ci job failure refuses not-a-ci-break through the default reader with a warning', async () => {
    const opts = options({ readMergeGateVerdict: () => ({ error: 'npm ci failed before a verdict was printed' }) });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('red: merge-gate'), warning: expect.stringContaining('npm ci failed') });
  });

  it('R3: real npm ci job failure permits needs-human through the default reader with a warning', async () => {
    const opts = options({ readMergeGateVerdict: () => ({ error: 'npm ci failed before a verdict was printed' }) });
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null, warning: expect.stringContaining('npm ci failed') });
  });

  it.each(['throw', 'error'])('required merge-gate FAILURE with an unreadable verdict (%s) refuses not-a-ci-break', async mode => {
    const opts = options({ readMergeGateVerdict: () => {
      if (mode === 'throw') throw new Error('verdict unreadable');
      return { error: 'verdict unreadable' };
    } });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('red: merge-gate'), warning: expect.stringContaining('verdict unreadable') });
  });

  it.each(['throw', 'error'])('classifier read failure (%s) keeps no-block plus warning policy', async mode => {
    const opts = options({ readMergeGateVerdict: () => {
      if (mode === 'throw') throw new Error('classifier unavailable');
      return { error: 'classifier unavailable' };
    } });
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null, warning: expect.stringContaining('classifier unavailable') });
  });

  it.each(['throw', 'error'])('freeze read failure (%s) on an unlabelled candidate surfaces a warning', async mode => {
    const opts = options({
      readMergeGateVerdict: vi.fn(() => ({ num: 6042, head_sha: HEAD, ok: false, mainCiGreen: true,
        completed_at: '2026-10-28T13:00:00-04:00',
        results: [{ id: 'red-main-freeze', status: 'hold', reason: 'main is RED (freeze: manual freeze: operator hold)' }] })),
      readFreeze: vi.fn(() => {
        if (mode === 'throw') throw new Error('freeze unavailable');
        return { error: 'freeze unavailable' };
      }),
    });
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.labels = [];
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    expect(await checkNeedsHumanEscalable(opts))
      .toEqual({ refusal: null, warning: expect.stringContaining('freeze unavailable') });
    expect(opts.prChecksOptions.readFreeze).toHaveBeenCalledTimes(1);
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('red: merge-gate'), warning: expect.stringContaining('freeze unavailable') });
  });

  it('a verdict for another head cannot prove a review hold', async () => {
    const opts = options({ readMergeGateVerdict: () => ({ num: 6042, head_sha: 'another-head', ok: false,
      results: [{ id: 'review-acceptance', status: 'hold', reason: 'old review pending' }] }) });
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('merge-gate') });
  });

  it('classifies every failed merge-gate attempt independently', async () => {
    const opts = options();
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.statusCheckRollup.push({ name: 'merge-gate', id: 99, run_id: 1, run_attempt: 2,
      status: 'COMPLETED', conclusion: 'FAILURE', completed_at: '2026-10-28T14:00:00-04:00' });
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: expect.stringContaining('merge-gate') });
    expect(opts.prChecksOptions.readMergeGateVerdict).toHaveBeenCalledTimes(2);
    expect(opts.prChecksOptions.readMergeGateVerdict).toHaveBeenCalledWith({ repo: 'example/repo', prNumber: 6042, jobId });
    expect(opts.prChecksOptions.readMergeGateVerdict).toHaveBeenCalledWith({ repo: 'example/repo', prNumber: 6042, jobId: 99 });
  });

  it.each([false, true])('a review hold cannot excuse another merge-gate job failure (reverse=%s)', async reverse => {
    const opts = options({ readMergeGateVerdict: vi.fn(({ jobId: id }) => ({
      num: 6042, head_sha: HEAD, ok: false,
      results: [{ id: id === jobId ? 'review-acceptance' : 'main-ci',
        status: id === jobId ? 'hold' : 'fail-closed', reason: 'job-specific evidence' }],
    })) });
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.statusCheckRollup.push({ name: 'merge-gate', id: 99,
      status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T12:00:00-04:00' });
    if (reverse) facts.statusCheckRollup.reverse();
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('red: merge-gate') });
  });

  it.each([false, true])('CodeQL failure is never excused as gate-only through the default reader (reverse=%s)', async reverse => {
    const opts = options();
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.statusCheckRollup.push(
      { name: 'CodeQL', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1 },
      { name: 'CodeQL', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 2 },
    );
    if (reverse) facts.statusCheckRollup.reverse();
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('red: CodeQL') });
  });

  it('keeps a distinct required MERGE-GATE failure through the default reader', async () => {
    const opts = options();
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.statusCheckRollup.push({ name: 'MERGE-GATE', id: 999,
      status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T14:00:00-04:00' });
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    opts.readRequired = () => ({ checks: ['test', 'merge-gate', 'MERGE-GATE'] });
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: null });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: expect.stringContaining('red: MERGE-GATE') });
    expect(opts.prChecksOptions.readMergeGateVerdict).toHaveBeenCalledWith({ repo: 'example/repo', prNumber: 6042, jobId });
  });

  it.each(['SUCCESS', null])('newer success/pending evidence (%s) retains the older failed merge-gate and reads its verdict', async conclusion => {
    const opts = options();
    const facts = JSON.parse(opts.prChecksOptions.runGh());
    facts.statusCheckRollup.push({ name: 'merge-gate', id: 99,
      status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion,
      started_at: '2026-10-28T14:00:00-04:00',
      ...(conclusion ? { completed_at: '2026-10-28T14:01:00-04:00' } : {}) });
    opts.prChecksOptions.runGh.mockReturnValue(JSON.stringify(facts));
    expect(await checkNeedsHumanEscalable(opts)).toEqual({ refusal: conclusion ? expect.stringContaining('merge-gate') : null });
    expect(await checkNotCiBreakRecordable({ ...opts, outcome: 'not-a-ci-break' }))
      .toEqual({ refusal: conclusion ? null : expect.stringContaining('merge-gate') });
    expect(opts.prChecksOptions.readMergeGateVerdict).toHaveBeenCalledWith({ repo: 'example/repo', prNumber: 6042, jobId });
  });
});
