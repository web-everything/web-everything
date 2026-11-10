/** #5062 phase 1: pure inputs only; no runner, switch store, or GitHub IO.
 * The input contract below keeps raw dispatch records separate from PR-controlled evidence.
 * dispatchRecords is the lookup result for (repo, pr.number), not a lookup by headRef.
 */
import { describe, it, expect } from 'vitest';
import { decideJudgeClearance, deriveRecordBinding, protectedPathsTouched, JUDGE_REFUSALS } from '../judge-clearance.mjs';
import { buildAuthorActorMarker, buildClearerActorMarker } from '../review-independence.mjs';
import { buildDelegationMarker } from '../delegation-marker.mjs';

const repo = 'example/web-everything';
const head = 'b'.repeat(40);
const baseSha = 'a'.repeat(40);
const author = 'author-session';
const marker = buildDelegationMarker({ provider: 'codex', model: 'gpt-5', taskType: 'other' });
const binding = { headIsSameRepo: true, repoMatches: true, prNumberMatches: true, baseShaIsAncestor: true };
const record = { repo, prNumber: 250, headRef: 'lane/x', baseSha,
  startedAt: '2026-11-10T10:00:00Z', finishedAt: '2026-11-10T11:00:00Z',
  executedProvider: 'codex', sessionId: author };
function clean() {
  return {
    repo, now: Date.parse('2026-11-10T12:00:00Z'),
    switches: { judgeEnabled: true, waitHours: 0 }, parkedAt: '2026-11-10T11:59:59Z',
    pr: { number: 250, headRefName: 'lane/x', headRefOid: head, isCrossRepository: false,
      headRepository: { nameWithOwner: repo }, baseRepository: { nameWithOwner: repo },
      body: `${marker}\n${buildAuthorActorMarker(author)}`, title: 'Explain a feature',
      labels: ['review:human', 'advisory:accepted'], commits: [],
      comments: [{ author: { login: 'github-actions[bot]' }, createdAt: '2026-11-10T11:30:00Z',
        body: `**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${baseSha}..${head}\`\n${buildClearerActorMarker('reviewer-session')}` }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    ciGreen: true, changedPaths: ['docs/guide.md'], addedLines: [], decisionCardResolves: [],
    dispatchRecords: [{ ...record }], recordBinding: { ...binding },
    judge: { provider: 'anthropic', actorId: 'judge-session' },
  };
}
function refuses(input, refusal, detail) {
  const result = decideJudgeClearance(input);
  expect(result).toMatchObject({ allowed: false, refusal });
  if (detail !== undefined) expect(result.detail).toEqual(detail);
  return result;
}
const protectedPaths = [
  'scripts/review-set-label.mjs', 'scripts/merge-ai-prs.mjs', 'scripts/pr-land.mjs',
  'scripts/operations/record-verdict.mjs', 'scripts/operations/review-dispatch.mjs',
  'scripts/lib/advisory-labels.mjs', 'scripts/lib/verdict-ledger.mjs',
  '.github/workflows/review-gate.yml', '.github/workflows/apply-review-request.yml',
  '.github/workflows/ci.yml', '.github/workflows/deploy.yml', '.github/workflows/new-gate.yml',
  'scripts/apply-review-request.mjs', 'scripts/check-review-gate.mjs', 'scripts/collect-review-requests.mjs',
  'scripts/lib/github-app-token.mjs', '.env.local', 'config/.development-env',
  'config/credentials.json', 'config/password.txt', 'config/secret.json', 'config/token.json',
  'config/private.pem', 'config/service.key',
  'scripts/guard-bash.mjs', 'scripts/guard-lane.mjs', 'scripts/guard-future.mjs',
  '.claude/settings.json', '.githooks/pre-commit', 'scripts/lib/secret-scrub.mjs',
  'scripts/rust-scan/src/secret_scrub.rs',
  'docs/agent/platform-decisions.md', 'docs/agent/future-statute.md',
  'docs/agent/platform-decisions/future-ruling.md',
  'scripts/lib/judge-clearance.mjs', 'scripts/operations/judge-clear.mjs',
  'scripts/operations/judge-arbitrate.mjs', 'scripts/conveyor/judge-pass.mjs',
  'scripts/conveyor/judge-digest.mjs', 'scripts/lib/judge-spawn.mjs',
  'scripts/lib/codex-judge-spawn.mjs', 'scripts/lib/judge-switches.mjs',
  'scripts/conveyor/judge-switch.mjs', 'scripts/lib/judge-verdict-record.mjs',
  'scripts/lib/judge-facts.mjs', 'scripts/lib/judge-trusted-paths.mjs',
  'scripts/lib/finding-bounce.mjs', 'scripts/conveyor/stand-down-answer-core.mjs',
  'scripts/conveyor/stand-down.mjs', 'scripts/lib/review-independence.mjs',
  'scripts/lib/delegation-marker.mjs', 'scripts/lib/ai-pr-authorship.mjs',
  'scripts/lib/dispatch-provider-availability.mjs', 'scripts/operations/dispatch-lane.mjs',
  'scripts/operations/dispatch-lane-io.mjs', 'scripts/operations/dispatch-provider-registry.mjs',
  'scripts/operations/deliver-item-wrapper.mjs', 'scripts/operations/coordination-root.mjs',
  'scripts/lib/judge-future-thing.mjs', 'scripts/lib/__tests__/judge-clearance.test.mjs',
  'scripts/future/nested/__tests__/judge-new.test.mjs',
];

describe('#5062 judge clearance decision', () => {
  it('allows a fully evidenced independent judge when only the human gate remains', () => {
    expect(decideJudgeClearance(clean())).toMatchObject({ allowed: true, refusal: null });
  });
  it('exports a frozen closed refusal vocabulary including fail-closed error', () => {
    expect(Object.isFrozen(JUDGE_REFUSALS)).toBe(true);
    const values = Array.isArray(JUDGE_REFUSALS) ? JUDGE_REFUSALS : Object.values(JUDGE_REFUSALS);
    expect([...values].sort()).toEqual(['kill-switch', 'wait-not-elapsed', 'not-human-gated',
      'reviewers-not-accepted', 'protected-list', 'secret-in-diff', 'independence-unknown',
      'same-provider', 'same-actor', 'error'].sort());
  });
  it.each(protectedPaths)('never clears protected path %s; shared check agrees and names it', (path) => {
    const input = { ...clean(), changedPaths: [path] };
    const result = refuses(input, 'protected-list');
    const shared = protectedPathsTouched(input);
    expect(shared).toMatchObject({ touched: true, paths: [path] });
    expect(result.detail).toEqual(shared.detail);
    expect(JSON.stringify(result.detail)).toContain(path);
  });
  it.each(['backlog/9000-story.md', 'src/_data/blocks.json', 'reports/token-notes.md', 'docs/guide.md'])(
    'does not protect ordinary content solely by its tree/name: %s', (path) => {
      const input = { ...clean(), changedPaths: [path] };
      expect(protectedPathsTouched(input).touched).toBe(false);
      expect(decideJudgeClearance(input).allowed).toBe(true);
    });
  it.each([undefined, null, {}, 'docs/guide.md', Object.assign(['docs/guide.md'], { truncated: true })])(
    'incomplete path evidence fails closed: %j', (changedPaths) => {
      const input = { ...clean(), changedPaths };
      refuses(input, 'protected-list', 'changed-paths-incomplete');
      expect(protectedPathsTouched(input)).toMatchObject({ touched: true, detail: 'changed-paths-incomplete' });
    });
  it.each(['docs/guide.md', 'backlog/9000-story.md', 'src/_data/example.json', 'config/settings.json'])(
    'secret scan includes added content in %s', (path) => {
      refuses({ ...clean(), changedPaths: [path], addedLines: [{ path, line: 'fake key: sk-' + 'Ab12'.repeat(6) }] }, 'secret-in-diff');
    });
  it('refuses an opaque high-entropy added token without a known prefix', () => {
    refuses({ ...clean(), addedLines: [{ path: 'docs/guide.md', line: 'q7Jz9Bv2Kx4Mp8Nw6R' }] }, 'secret-in-diff');
  });
  it('a resolved/codified decision from head frontmatter stays human', () => {
    const input = { ...clean(), changedPaths: ['backlog/9001-decision.md'], decisionCardResolves: ['backlog/9001-decision.md'] };
    refuses(input, 'protected-list', 'decision-card-resolved');
    expect(protectedPathsTouched(input)).toMatchObject({ touched: true, paths: input.changedPaths, detail: 'decision-card-resolved' });
  });
  it.each(['**Ratified 2026-11-10 by operator**', '**Operator ruling: yes**', 'Operator, verbatim: yes'])(
    'an added ruling stamp stays human: %s', (line) => {
      const input = { ...clean(), changedPaths: ['backlog/9000-story.md'], addedLines: [{ path: 'backlog/9000-story.md', line }] };
      refuses(input, 'protected-list', 'ruling-recorded');
      expect(protectedPathsTouched(input)).toMatchObject({ touched: true, paths: input.changedPaths, detail: 'ruling-recorded' });
    });
  it.each(['codifiedIn: docs/agent/platform-decisions.md#example', 'See **Ratified 2026-11-10**', 'ordinary prose'])(
    'ordinary story references and removed ruling stamps do not record a ruling: %s', (line) => {
      expect(decideJudgeClearance({ ...clean(), addedLines: [{ path: 'docs/guide.md', line }] }).allowed).toBe(true);
    });
  it('removing a ruling line does not count as adding it', () => {
    expect(decideJudgeClearance({ ...clean(), addedLines: [] }).allowed).toBe(true);
  });
  it.each([false, undefined, null])('judgeEnabled=%j refuses before all other checks', (judgeEnabled) => {
    refuses({ ...clean(), switches: { judgeEnabled }, pr: null, changedPaths: undefined }, 'kill-switch');
  });
  it.each([0, undefined])('waitHours=%j allows an immediate park or unknown park time', (waitHours) => {
    for (const parkedAt of ['2026-11-10T11:59:59Z', null]) {
      expect(decideJudgeClearance({ ...clean(), switches: { judgeEnabled: true, waitHours }, parkedAt }).allowed).toBe(true);
    }
  });
  it('positive wait refuses a one-hour park before checking labels', () => {
    const input = clean(); input.switches.waitHours = 4; input.parkedAt = '2026-11-10T11:00:00Z'; input.pr.labels = [];
    refuses(input, 'wait-not-elapsed');
  });
  it.each([null, 'invalid'])('positive wait refuses unknown parked time %j', (parkedAt) => {
    refuses({ ...clean(), switches: { judgeEnabled: true, waitHours: 4 }, parkedAt }, 'wait-not-elapsed', 'parked-time-unknown');
  });
  it('allows the exact elapsed wait boundary', () => {
    expect(decideJudgeClearance({ ...clean(), switches: { judgeEnabled: true, waitHours: 4 }, parkedAt: '2026-11-10T08:00:00Z' }).allowed).toBe(true);
  });
  it('requires review:human before review acceptance', () => {
    const input = clean(); input.pr.labels = []; refuses(input, 'not-human-gated');
  });
  it.each(['old-head', 'changes', 'red-ci', 'missing-advisory', 'missing-accepted-label'])(
    'review acceptance must be current and complete: %s', (problem) => {
      const input = clean();
      if (problem === 'old-head') input.pr.headRefOid = 'c'.repeat(40);
      if (problem === 'changes') input.pr.labels.push('review:changes');
      if (problem === 'red-ci') { input.ciGreen = false; input.pr.statusCheckRollup[0].conclusion = 'FAILURE'; }
      if (problem === 'missing-advisory') input.pr.comments = [];
      if (problem === 'missing-accepted-label') input.pr.labels = ['review:human'];
      input.changedPaths = ['scripts/merge-ai-prs.mjs'];
      refuses(input, 'reviewers-not-accepted');
    });
  it('a resolved ordinary story with no ruling stamp is still eligible', () => {
    expect(decideJudgeClearance({ ...clean(), changedPaths: ['backlog/9000-story.md'],
      decisionCardResolves: [], addedLines: [{ path: 'backlog/9000-story.md', line: 'status: resolved' }] }).allowed).toBe(true);
  });
  it('protection precedes secret and independence refusals', () => {
    refuses({ ...clean(), changedPaths: ['scripts/merge-ai-prs.mjs'], dispatchRecords: [],
      addedLines: [{ path: 'docs/guide.md', line: 'sk-' + 'Ab12'.repeat(6) }] }, 'protected-list');
  });
  it('secret evidence precedes unknown independence', () => {
    refuses({ ...clean(), dispatchRecords: [],
      addedLines: [{ path: 'docs/guide.md', line: 'sk-' + 'Ab12'.repeat(6) }] }, 'secret-in-diff');
  });
  it('same trusted author provider is refused', () => {
    const input = clean(); input.dispatchRecords[0].executedProvider = 'anthropic';
    // An agreeing marker is still merely PR-side evidence, never the provider authority.
    input.pr.body = input.pr.body.replace('provider=codex', 'provider=anthropic');
    refuses(input, 'same-provider');
  });
  it.each(['body', 'title', 'comments', 'labels', 'commits'])(
    'provider text in PR %s cannot replace an absent binding record', (surface) => {
      const input = clean(); input.dispatchRecords = [];
      if (surface === 'title') input.pr.title = marker;
      if (surface === 'comments') input.pr.comments.push({ body: marker });
      if (surface === 'labels') input.pr.labels.push('provider:codex');
      if (surface === 'commits') input.pr.commits = [{ messageBody: 'Provider: codex' }];
      refuses(input, 'independence-unknown');
    });
  it('a forged Codex delegation cannot hide a trusted Anthropic author from the Anthropic judge', () => {
    const input = clean(); input.dispatchRecords[0].executedProvider = 'anthropic';
    refuses(input, 'same-provider');
  });
  it.each([[], null, [{ ...record, executedProvider: null }], [{ ...record }, { ...record }]])(
    'absent, unreadable, incomplete or duplicate binding records remain unknown: %j', (dispatchRecords) => {
      refuses({ ...clean(), dispatchRecords }, 'independence-unknown');
    });
  it.each(['headIsSameRepo', 'repoMatches', 'prNumberMatches', 'baseShaIsAncestor'])(
    'false or missing binding flag %s fails closed', (flag) => {
      for (const value of [false, undefined]) refuses({ ...clean(), recordBinding: { ...binding, [flag]: value } }, 'independence-unknown', 'record-mismatch');
    });
  it('missing binding facts cannot attest independence', () => {
    refuses({ ...clean(), recordBinding: undefined }, 'independence-unknown', 'record-mismatch');
  });
  it('reused lane ref with a genuinely shared ancestor never inherits PR 100 provider for PR 250', () => {
    const input = clean();
    const oldRecord = { ...record, prNumber: 100 };
    const derived = deriveRecordBinding({ record: oldRecord, pr: input.pr, baseShaIsAncestor: true });
    expect(derived).toMatchObject({ ...binding, prNumberMatches: false });
    refuses({ ...input, dispatchRecords: [oldRecord], recordBinding: derived }, 'independence-unknown', 'record-mismatch');
    // A lookup by (repo, 250) yields no record; copying the body/ref cannot repair that.
    refuses({ ...input, dispatchRecords: [] }, 'independence-unknown');
  });
  it('derives all four binding facts for the matching live PR', () => {
    expect(deriveRecordBinding({ record, pr: clean().pr, baseShaIsAncestor: true })).toEqual(binding);
  });
  it.each(['fork', 'wrong-repo', 'wrong-history', 'missing-repository'])(
    'derives a refusal from live identity evidence: %s', (problem) => {
      const input = clean(); const candidate = { ...record };
      if (problem === 'fork') { input.pr.isCrossRepository = true; input.pr.headRepository.nameWithOwner = 'attacker/web-everything'; }
      if (problem === 'wrong-repo') candidate.repo = 'other/web-everything';
      if (problem === 'missing-repository') delete input.pr.headRepository;
      input.recordBinding = deriveRecordBinding({ record: candidate, pr: input.pr, baseShaIsAncestor: problem !== 'wrong-history' });
      input.dispatchRecords = [candidate];
      refuses(input, 'independence-unknown', 'record-mismatch');
    });
  it('a later Claude fix commit adds doubt to the trusted Codex binding', () => {
    const input = clean(); input.pr.commits = [{ messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }];
    refuses(input, 'independence-unknown');
  });
  it.each(['delegation', 'author', 'actor-disagreement'])(
    'missing identity signals or a run-session disagreement fail closed: %s', (problem) => {
      const input = clean();
      if (problem === 'delegation') input.pr.body = buildAuthorActorMarker(author);
      if (problem === 'author') input.pr.body = marker;
      if (problem === 'actor-disagreement') input.dispatchRecords[0].sessionId = 'other-author';
      refuses(input, 'independence-unknown');
    });
  it.each([author, 'reviewer-session'])('judge must differ from author and recorded reviewer actor %s', (actorId) => {
    refuses({ ...clean(), judge: { provider: 'anthropic', actorId } }, 'same-actor');
  });
  it('catches an internal input-access error and refuses', () => {
    const input = clean(); Object.defineProperty(input, 'changedPaths', { get() { throw new Error('unreadable evidence'); } });
    refuses(input, 'error');
  });
});
