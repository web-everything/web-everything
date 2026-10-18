import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { routeTestGaming, planTestGamingRoute, sweepTestGamingRoutes } from '../test-gaming-route.mjs';
import { planReconcile } from '../reconcile-core.mjs';
import { defaultReadPrs } from '../reconcile-pass.mjs';
import { sweepAdvisoryLabels } from '../advisory-label-sweep.mjs';
import { buildAdvisoryFixComment } from '../advisory-fix-mark.mjs';
import { buildFixEndComment } from '../fix-procedure.mjs';
import { ADVISORY_NOTE_MARKER } from '../advisory-round-count.mjs';
import { CONVERTED_ADVISORY_NOTE_MARKER } from '../../lib/review-escalation.mjs';
import { runReviewTick, buildCliDaemonEffects } from '../../../skills-src/conveyor/review-daemon.mjs';
import { resolveReviewSettings, resolveReviewSettingSource } from '../../lib/review-settings.mjs';

vi.mock('../../lib/review-facts.mjs', async original => ({
  ...await original(), warmReviewFacts: async () => ({ skipped: 'test' }),
}));
afterEach(() => vi.restoreAllMocks());

const HEAD = 'a'.repeat(40);
const FILE = 'scripts/conveyor/__tests__/health-responder-core.test.mjs';
const BINDING = `The merge gate flags a net removal of 1 test case(s) in \`${FILE}\`. Restore the removed test(s), or replace each with an equivalent test that still covers the same guarantee. If the removal is genuinely correct (the behaviour itself was removed), keep it, and state why in a \`test-removal-justified:\` line in the fix-end note.`;
const bot = body => ({ body, author: { login: 'web-everything' } });
function world() {
  const fx = JSON.parse(readFileSync('scripts/conveyor/__tests__/fixtures/pr-ownership/pr-5157-before-ci-heal.json', 'utf8'));
  const pr = fx.pr;
  pr.headRefOid = HEAD;
  pr.labels = [{ name: 'review:pending' }];
  pr.comments = [];
  const row = pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1);
  row.mergeGateReviewHold = { holds: ['test-gaming'], jobId: 1 };
  const verdict = { num: pr.number, head_sha: HEAD, ok: false, results: [
    { id: 'test-gaming', status: 'hold', reason: `test-gaming suspected: tests-removed: ${FILE} (net 1 test case(s) removed)` },
  ] };
  const provider = {
    readPrState: vi.fn(() => structuredClone(pr)),
    postComment: vi.fn((repo, n, body) => pr.comments.push(bot(body))),
    setLabels: vi.fn((repo, n, { add, remove = [] }) => {
      pr.labels = pr.labels.filter(l => !remove.includes(l.name));
      if (add && !pr.labels.some(l => l.name === add)) pr.labels.push({ name: add });
    }),
  };
  const notify = vi.fn();
  const options = { repo: 'web-everything/web-everything', provider, readVerdict: () => verdict,
    readComments: () => structuredClone(pr.comments), notify, enabled: true };
  const plan = overrides => planReconcile({ repo: 'we', prs: [pr], now: Date.parse(fx.observedAt),
    requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'],
    advisoryReviewOnHumanHandoff: 'on', ...overrides });
  return { pr, row, verdict, provider, notify, options, plan };
}

describe('test-gaming hold routing', () => {
  it.each(['review:pending', 'review:human'])('routes production discovery output carrying %s', label => {
    const w = world();
    w.pr.labels = [{ name: label }];
    const prs = defaultReadPrs({ repo: w.options.repo, exec: (_file, args) => {
      const fields = args[args.indexOf('--json') + 1].split(',');
      return JSON.stringify([Object.fromEntries(fields.map(field => [field, w.pr[field]]))]);
    }, readCommits: () => [], readComments: () => [] });
    expect(sweepTestGamingRoutes({ ...w.options, prs })).toEqual([
      expect.objectContaining({ action: 'admit', pr: w.pr.number }),
    ]);
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
  });

  it.each(['CLOSED', 'MERGED', undefined, 'moved'])('rejects a state-less snapshot whose live state is %s', state => {
    const w = world();
    const listed = { ...w.pr };
    delete listed.state;
    w.provider.readPrState.mockReturnValue({ ...w.pr, state: state === 'moved' ? 'OPEN' : state,
      headRefOid: state === 'moved' ? 'b'.repeat(40) : HEAD });
    expect(routeTestGaming(listed, w.options).action).toBe('skip');
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it.each(['same head', 'pushed head', 'legacy notice'])('keeps a justified removal parked after advisory sweeps: %s', kind => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    if (kind === 'pushed head') w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
    w.pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: w.pr.headRefOid })
      + '\n\ntest-removal-justified: obsolete behaviour removed'));
    if (kind === 'legacy notice') w.pr.comments.push(bot(`Test removal needs your ruling.\n\n<!-- test-gaming-needs-you: ${HEAD} -->`));
    for (let tick = 0; tick < 2; tick++) {
      expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
      sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
        readPr: () => structuredClone(w.pr), provider: w.provider });
      expect(w.pr.labels.map(l => l.name)).toEqual(['review:human']);
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    }
    expect(w.notify).toHaveBeenCalledTimes(kind === 'legacy notice' ? 0 : 1);
    expect(w.provider.postComment).toHaveBeenCalledTimes(2);
    expect(w.row.conclusion).toBe('FAILURE');
  });

  it.each([ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER])(
    'preserves a newer panel outcome when forwarding a justification: %s', marker => {
      const w = world();
      routeTestGaming(w.pr, w.options);
      w.pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })
        + '\n\ntest-removal-justified: obsolete behaviour removed'));
      w.pr.comments.push(bot(`${marker}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: separate defect\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\``));
      expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
      // Simulate a missed label write, forcing the sweep to re-derive the outcome.
      w.pr.labels = [{ name: 'review:human' }];
      sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
        readPr: () => structuredClone(w.pr), provider: w.provider });
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    });

  it('recovers an interrupted label removal from the durable ruling outcome', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })
      + '\n\ntest-removal-justified: obsolete behaviour removed'));
    w.provider.setLabels.mockImplementationOnce(() => { throw Error('label write interrupted'); });
    expect(() => routeTestGaming(w.pr, w.options)).toThrow('label write interrupted');
    expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
    sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
      readPr: () => structuredClone(w.pr), provider: w.provider });
    expect(w.pr.labels.map(l => l.name)).toEqual(['review:human']);
    expect(w.notify).toHaveBeenCalledOnce();
    expect(w.provider.postComment).toHaveBeenCalledTimes(2);
  });

  it('binds the real test-gaming sweep in the production CLI daemon effects', async () => {
    const reviewTickAllRepos = vi.fn(() => ({ liveProcessPrs: [] }));
    await buildCliDaemonEffects({ owner: 'test', reviewTickAllRepos,
      log: { error: () => {} }, reapSessions: () => null,
      convertAdvisoryEnabled: false, runPrepReview: () => null,
    }).tickOnce();
    expect(reviewTickAllRepos).toHaveBeenCalledOnce();
    expect(reviewTickAllRepos.mock.calls[0][0].routeTestGaming).toBe(sweepTestGamingRoutes);
  });

  it('admits one binding finding through the real planner and fixer input, preserving the hold', () => {
    const w = world();
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    routeTestGaming(w.pr, w.options);
    const fixes = w.plan().dispatch.filter(d => d.kind === 'fix');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].mode).toBe('advisory-fix');
    expect(w.pr.comments.at(-1).body).toContain(`Admitted finding: ${BINDING}`);
    // Advisory-fix reads the latest advisory note as its authoritative input.
    expect(w.pr.comments.at(-1).body).toContain('**Advisory outcome:** `changes`');
    expect(w.plan().refusals).toContainEqual(expect.objectContaining({ kind: 'review-hold-red' }));
    expect(w.row.conclusion).toBe('FAILURE');
  });

  it('routes a draft held on test-gaming to repair without promoting it (#5487)', () => {
    const w = world();
    w.pr.isDraft = true;
    routeTestGaming(w.pr, w.options);
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    expect(w.pr.isDraft).toBe(true);
    expect(w.pr.comments.at(-1).body).toContain(BINDING);
  });

  it('keeps other failing merge rules on the existing path', () => {
    const w = world();
    w.verdict.results.push({ id: 'review-acceptance', status: 'hold', reason: 'missing acceptance' });
    routeTestGaming(w.pr, w.options);
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it('keeps an unfinished reclaimed fixer eligible after a production claim release', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })));
    for (let tick = 0; tick < 2; tick++) {
      expect(routeTestGaming(w.pr, w.options).action).toBe('admitted');
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    }
    expect(w.provider.postComment).toHaveBeenCalledOnce();
  });

  it.each([ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER, 'Legacy advisory'])(
    'red-team: a later accepting advisory cannot strand an unfinished route (%s)', marker => {
      const w = world();
      routeTestGaming(w.pr, w.options);
      const acceptance = `${marker}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\``;
      w.pr.comments.push(bot(acceptance));
      sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
        readPr: () => structuredClone(w.pr), provider: w.provider });
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:accepted');
      for (let tick = 0; tick < 3; tick++) {
        // Recovery survives later sweeps and an ordinary reclaimed-worker release.
        if (tick === 1) w.pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })));
        const routed = routeTestGaming(w.pr, w.options);
        expect(routed.action).toBe('admitted');
        expect(routed.snapshot?.labels.map(l => l.name)).toContain('advisory:changes');
        sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
          readPr: () => structuredClone(w.pr), provider: w.provider });
        expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
        expect(w.pr.labels.map(l => l.name)).not.toContain('advisory:accepted');
        expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
      }
      expect(w.provider.postComment).toHaveBeenCalledTimes(2);
      expect(w.pr.comments.some(c => c.body === acceptance)).toBe(true);
      expect(w.row.conclusion).toBe('FAILURE');
    });

  it('recovers an interrupted repair-label restoration after a later accepting advisory', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\``));
    w.pr.labels = [{ name: 'review:human' }, { name: 'advisory:accepted' }];
    w.provider.setLabels.mockImplementationOnce(() => { throw Error('label write interrupted'); });
    expect(() => routeTestGaming(w.pr, w.options)).toThrow('label write interrupted');
    expect(routeTestGaming(w.pr, w.options).snapshot.labels.map(l => l.name)).toContain('advisory:changes');
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    expect(w.provider.postComment).toHaveBeenCalledTimes(2);
  });

  it('does not reopen a completed route when an accepting advisory arrives after the repair', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(buildAdvisoryFixComment({})), bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })),
      bot(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\``));
    sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
      readPr: () => structuredClone(w.pr), provider: w.provider });
    expect(routeTestGaming(w.pr, w.options).action).toBe('completed');
    expect(w.pr.labels.map(l => l.name)).toContain('advisory:accepted');
    expect(w.provider.postComment).toHaveBeenCalledOnce();
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
  });

  it('keeps the current repair dispatchable after a stale-head accepting advisory', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${'b'.repeat(40)}\``));
    for (let tick = 0; tick < 2; tick++) {
      expect(routeTestGaming(w.pr, w.options).action).toBe('admitted');
      sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
        readPr: () => structuredClone(w.pr), provider: w.provider });
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    }
    expect(w.provider.postComment).toHaveBeenCalledTimes(2);
  });

  it.each(['before route', 'outsider', 'infra stall'])(
    'does not complete a route using a repair marker from %s', kind => {
      const w = world();
      const mark = bot(buildAdvisoryFixComment({}));
      if (kind === 'before route') w.pr.comments.push(mark);
      routeTestGaming(w.pr, w.options);
      if (kind !== 'before route') w.pr.comments.push(kind === 'outsider'
        ? { ...mark, author: { login: 'outsider' } } : mark);
      w.pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD, infraStall: kind === 'infra stall' })));
      expect(routeTestGaming(w.pr, w.options).action).toBe('admitted');
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
    });

  it.each([ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER])(
    'preserves an unresolved existing advisory before routing test removal (%s)', marker => {
      const w = world();
      w.pr.labels = [{ name: 'review:human' }, { name: 'advisory:changes' }];
      const existing = `${marker}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: reject unauthenticated DELETE requests\n\n---\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\``;
      w.pr.comments.push(bot(existing));
      routeTestGaming(w.pr, w.options);
      expect(w.pr.comments.at(-1).body).toBe(existing);
      expect(w.provider.postComment).not.toHaveBeenCalled();
      expect(w.provider.setLabels).not.toHaveBeenCalled();
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
      // Once that finding is addressed, the hold still gets its own binding repair.
      w.pr.comments.push(bot(buildAdvisoryFixComment({})));
      expect(routeTestGaming(w.pr, w.options).action).toBe('admit');
      expect(w.pr.comments.at(-1).body).toContain(BINDING);
    });

  it.each(['unresolved beyond page', 'addressed beyond page'])(
    'decides advisory deferral from the complete thread: %s', kind => {
      const w = world();
      w.pr.labels = [{ name: 'review:human' }, { name: 'advisory:changes' }];
      const note = bot(`${ADVISORY_NOTE_MARKER}\n\nAdmitted finding: reject unauthenticated DELETE requests`);
      const listed = { ...structuredClone(w.pr), comments: kind === 'unresolved beyond page' ? [] : [note] };
      w.pr.comments.push(note);
      if (kind === 'addressed beyond page') w.pr.comments.push(bot(buildAdvisoryFixComment({})));
      expect(routeTestGaming(listed, w.options).action).toBe(kind === 'unresolved beyond page' ? 'skip' : 'admit');
      expect(w.provider.postComment).toHaveBeenCalledTimes(kind === 'unresolved beyond page' ? 0 : 1);
    });

  it.each(['changes', 'accept'])('uses the advisory outcome when its label is absent: %s', outcome => {
    const w = world();
    w.pr.labels = [{ name: 'review:human' }];
    w.pr.comments.push(bot(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** ${outcome === 'changes' ? 'Changes requested' : 'Accepted'}\n\n**Advisory outcome:** \`${outcome}\`\n\n${outcome === 'changes' ? 'Admitted finding: reject unauthenticated DELETE requests' : 'No findings'}\n\n---\n\nNet basis: \`${'0'.repeat(40)}..${'b'.repeat(40)}\``));
    expect(routeTestGaming(w.pr, w.options).action).toBe(outcome === 'changes' ? 'skip' : 'admit');
    expect(w.provider.postComment).toHaveBeenCalledTimes(outcome === 'changes' ? 0 : 1);
  });

  it('admits the same head only once and does not dispatch another fix after completion', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    routeTestGaming(w.pr, w.options);
    expect(w.provider.postComment).toHaveBeenCalledTimes(1);
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    w.pr.comments.push(bot(buildAdvisoryFixComment({})), bot(`🔓 conveyor fix-end — fix claim released\n\nat \`${HEAD.slice(0, 9)}\``));
    routeTestGaming(w.pr, w.options);
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    expect(w.provider.postComment).toHaveBeenCalledTimes(1);
  });

  it('sends a justified removal to needs-you once without clearing the gate, including after a push', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
    w.pr.comments.push(bot(`🔓 conveyor fix-end — fix claim released\n\nat \`${w.pr.headRefOid.slice(0, 9)}\`\n\ntest-removal-justified: obsolete behaviour was removed`));
    routeTestGaming(w.pr, w.options);
    routeTestGaming(w.pr, w.options);
    expect(w.notify).toHaveBeenCalledTimes(1);
    expect(w.notify.mock.calls[0][0].reason).toContain('obsolete behaviour was removed');
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    expect(w.row.conclusion).toBe('FAILURE');
    expect(w.row.mergeGateReviewHold.holds).toEqual(['test-gaming']);
    expect(w.pr.labels.map(l => l.name)).toContain('review:human');
  });

  it('replans a daemon tick from the routed labels so no competing review launches', () => {
    const w = world();
    const dispatch = vi.fn();
    runReviewTick({ repo: w.options.repo, readPrs: () => [structuredClone(w.pr)], readAgents: () => [],
      holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, dispatch,
      routeTestGaming: args => {
        expect(args).toEqual({ repo: w.options.repo, prs: [w.pr] });
        return sweepTestGamingRoutes({ ...w.options, ...args });
      },
      reconcile: ({ readPrs }) => {
        const snapshot = readPrs();
        return { ...w.plan(), dispatch: snapshot[0].labels.some(l => l.name === 'review:pending')
          ? [{ kind: 'review', prNumber: w.pr.number }] : [] };
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(w.provider.postComment).toHaveBeenCalledOnce();
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
  });

  it.each([' ', '\n\n', '\r\n\r\n', '\t', '\u2028'])(
    'ignores a justified fix-end for a different head with separator %j', separator => {
      const w = world();
      routeTestGaming(w.pr, w.options);
      w.pr.comments.push(bot(`🔓 conveyor fix-end — fix claim released${separator}at \`${HEAD.slice(0, 9)}\`\n\ntest-removal-justified: old head only`));
      w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
      expect(routeTestGaming(w.pr, w.options).action).toBe('admit');
      expect(w.provider.postComment).toHaveBeenCalledTimes(2);
      expect(w.notify).not.toHaveBeenCalled();
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    });

  it.each([7, 9, 40])('recognizes a matching newline-delimited fix-end head of length %i', length => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(`🔓 conveyor fix-end — fix claim released\n\nat \`${HEAD.slice(0, length)}\`\n\ntest-removal-justified: removed behaviour`));
    expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
    expect(w.notify).toHaveBeenCalledOnce();
  });

  it.each(['completion', 'justification', 'different head'])(
    'recognizes the production fix-end sentence for %s', kind => {
      const w = world();
      routeTestGaming(w.pr, w.options);
      const completion = buildFixEndComment({ who: 'fix-5537', headSha: HEAD });
      if (kind === 'completion') w.pr.comments.push(bot(buildAdvisoryFixComment({})));
      w.pr.comments.push(bot(completion + (kind === 'completion' ? '' : '\n\ntest-removal-justified: removed behaviour')));
      if (kind === 'different head') w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
      expect(routeTestGaming(w.pr, w.options).action).toBe(
        kind === 'completion' ? 'completed' : kind === 'justification' ? 'needs-you' : 'admit');
      expect(w.notify).toHaveBeenCalledTimes(kind === 'justification' ? 1 : 0);
    });

  it.each(['aaaaaa', 'a'.repeat(41), 'NOT-A-SHA'])('refuses a malformed explicit fix-end head %s', head => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(`🔓 conveyor fix-end\n\nat \`${head}\`\n\ntest-removal-justified: malformed head`));
    expect(routeTestGaming(w.pr, w.options).action).toBe('admitted');
    expect(w.notify).not.toHaveBeenCalled();
  });

  it('keeps legacy unscoped completions within their original routed head', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot('🔓 conveyor fix-end\n\ntest-removal-justified: legacy removal'));
    expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
    w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
    expect(routeTestGaming(w.pr, w.options).action).toBe('admit');
    expect(w.notify).toHaveBeenCalledOnce();
  });

  it('admits one new repair after a head change within the round cap', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(buildAdvisoryFixComment({})), bot(`🔓 conveyor fix-end\n\nat \`${HEAD}\``));
    expect(routeTestGaming(w.pr, w.options).action).toBe('completed');
    w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
    expect(routeTestGaming(w.pr, w.options).action).toBe('admit');
    expect(routeTestGaming(w.pr, w.options).action).toBe('admitted');
    expect(w.provider.postComment).toHaveBeenCalledTimes(2);
    expect(w.pr.comments.at(-1).body).toContain(BINDING);
    expect(w.pr.comments.at(-1).body).toContain(`test-gaming-route: ${w.pr.headRefOid}`);
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
  });

  it('deduplicates a route found only in the complete comment read', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    const listed = { ...w.pr, comments: Array.from({ length: 100 }, () => bot('old discussion')) };
    expect(routeTestGaming(listed, w.options).action).toBe('admitted');
    expect(w.provider.postComment).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, {}, { nodes: [], hasNextPage: true }])('incomplete comment read %j admits nothing', comments => {
    const w = world();
    const log = vi.fn();
    expect(sweepTestGamingRoutes({ ...w.options, prs: [w.pr], readComments: () => comments, log })).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('incomplete comment read'));
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'])('continues routing subsequent PRs after one PR throws on %s', stage => {
    const bad = world(), good = world(), log = vi.fn();
    bad.pr.number = 5487;
    bad.verdict.num = bad.pr.number;
    const provider = {
      readPrState: (repo, n) => (n === bad.pr.number ? bad : good).provider.readPrState(repo, n),
      postComment: (repo, n, body) => {
        if (n === bad.pr.number && stage === 'write') throw Error('write failed');
        return (n === bad.pr.number ? bad : good).provider.postComment(repo, n, body);
      },
      setLabels: (repo, n, labels) => (n === bad.pr.number ? bad : good).provider.setLabels(repo, n, labels),
    };
    const out = sweepTestGamingRoutes({ ...good.options, provider, prs: [bad.pr, good.pr], log,
      readVerdict: ({ prNumber }) => {
        if (prNumber === bad.pr.number && stage === 'read') throw Error('read failed');
        return (prNumber === bad.pr.number ? bad : good).verdict;
      },
      readComments: n => (n === bad.pr.number ? bad : good).pr.comments,
    });
    expect(out).toEqual([expect.objectContaining({ pr: good.pr.number, action: 'admit' })]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`${stage} failed`));
    expect(good.provider.postComment).toHaveBeenCalledOnce();
    expect(good.pr.labels.map(l => l.name)).toContain('advisory:changes');
  });

  it.each(['completion', 'justification', 'notice'])('rejects an outsider %s after the legitimate route', kind => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    const end = `🔓 conveyor fix-end\n\nat \`${HEAD}\``;
    const justified = `${end}\n\ntest-removal-justified: removed behaviour`;
    if (kind === 'completion') w.pr.comments.push(bot(buildAdvisoryFixComment({})));
    if (kind === 'notice') w.pr.comments.push(bot(justified));
    w.pr.comments.push({ author: { login: 'outsider' }, body: kind === 'completion' ? end
      : kind === 'justification' ? justified : `<!-- test-gaming-needs-you: ${HEAD} -->` });
    const out = routeTestGaming(w.pr, w.options);
    expect(out.action).toBe(kind === 'notice' ? 'needs-you' : 'admitted');
    expect(w.notify).toHaveBeenCalledTimes(kind === 'notice' ? 1 : 0);
    expect(w.pr.labels.map(l => l.name).includes('advisory:changes')).toBe(kind !== 'notice');
  });

  it.each([
    { id: 'unknown', status: 'hold' },
    { id: 'test-gaming', status: 'unknown' },
    { id: 'other-rule', status: 'unknown' },
  ])('refuses unknown gate evidence %j', row => {
    const w = world();
    w.verdict.results = [{ ...w.verdict.results[0], ...row }];
    expect(routeTestGaming(w.pr, w.options).action).toBe('skip');
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it.each([
    'skip-only: x.test.mjs',
    'tests-removed: /absolute.test.mjs (net 1 test case(s) removed)',
    'tests-removed: x/../up.test.mjs (net 1 test case(s) removed)',
    ...['0', '-1', '1.5', 'NaN', '9007199254740992'].map(n => `tests-removed: x.test.mjs (net ${n} test case(s) removed)`),
    'tests-removed: x.test.mjs (net 9007199254740991 test case(s) removed); tests-removed: y.test.mjs (net 1 test case(s) removed)',
  ])('refuses unusable removal evidence %s', reason => {
    const w = world();
    w.verdict.results[0].reason = reason;
    expect(routeTestGaming(w.pr, w.options).action).toBe('skip');
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it.each([
    '[click](https://evil).test.mjs', 'x`quoted`.test.mjs', 'x"quoted".test.mjs',
    'x\'quoted\'.test.mjs', '--instruction.test.mjs', 'x/--instruction.test.mjs', './x.test.mjs',
    'x\\windows.test.mjs', 'x\ninstruction.test.mjs', 'x\rinstruction.test.mjs',
    'x\u2028instruction.test.mjs', 'x\u200binstruction.test.mjs', 'ｘ.test.mjs',
    `${'x'.repeat(241)}.test.mjs`,
  ])('refuses unsafe gate-derived path %j without write effects', path => {
    const w = world();
    w.verdict.results[0].reason = `tests-removed: ${path} (net 1 test case(s) removed)`;
    expect(routeTestGaming(w.pr, w.options).action).toBe('skip');
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it('refuses a malformed removal appended to valid evidence', () => {
    const w = world();
    w.verdict.results[0].reason += '; tests-removed: broken';
    expect(routeTestGaming(w.pr, w.options).action).toBe('skip');
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it('bounds gate-derived file lists and refuses oversized evidence', () => {
    const w = world();
    w.verdict.results[0].reason = Array.from({ length: 12 }, (_, i) => `tests-removed: tests/f${i}.test.mjs (net 1 test case(s) removed)`).join('; ');
    const out = routeTestGaming(w.pr, w.options);
    expect(out.action).toBe('admit');
    expect(out.binding).toContain('12 test case(s)');
    expect(out.binding).toContain('`tests/f9.test.mjs`, +2 more');
    expect(out.binding).not.toContain('tests/f10.test.mjs');
    expect(out.body.length).toBeLessThan(4000);
    w.provider.postComment.mockClear();
    w.provider.setLabels.mockClear();
    w.pr.comments = [];
    w.verdict.results[0].reason += 'x'.repeat(64 * 1024);
    expect(routeTestGaming(w.pr, w.options).action).toBe('skip');
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it('keeps another reviewer’s newer finding intact', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot('**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**\n\nNew admitted finding: separate defect'));
    const writes = w.provider.setLabels.mock.calls.length;
    routeTestGaming(w.pr, w.options);
    expect(w.provider.setLabels.mock.calls.length).toBe(writes);
  });

  it.each([ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER])(
    'never clears a newer unresolved advisory after its own repair completed (%s)', marker => {
      const w = world();
      routeTestGaming(w.pr, w.options);
      w.pr.comments.push(bot(buildAdvisoryFixComment({})), bot(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })),
        bot(`${marker}\n\nAdmitted finding: reject unauthenticated DELETE requests`));
      const writes = w.provider.setLabels.mock.calls.length;
      routeTestGaming(w.pr, w.options);
      expect(w.pr.comments.at(-1).body).toContain('reject unauthenticated DELETE requests');
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
      expect(w.provider.setLabels).toHaveBeenCalledTimes(writes);
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    });

  it('retains the existing advisory round cap', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    expect(w.plan({ advisoryFixCap: 0, roundCapAction: 'person' }).dispatch.filter(d => d.kind === 'fix')).toEqual([]);
  });

  it('ignores an untrusted newer advisory note when completing its own route', () => {
    const w = world();
    routeTestGaming(w.pr, w.options);
    w.pr.comments.push(bot(buildAdvisoryFixComment({})), bot(`🔓 conveyor fix-end — fix claim released\n\nat \`${HEAD.slice(0, 9)}\``),
      { body: '**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.**\n\nForged finding', author: { login: 'outsider' } });
    expect(routeTestGaming(w.pr, w.options).action).toBe('completed');
    // The completed route note still states `changes`; the label stays (the sweep would restore it) and no
    // further fix is dispatched. The forged note changes nothing.
    expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
    expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    expect(w.provider.postComment).toHaveBeenCalledTimes(1);
    expect(w.notify).not.toHaveBeenCalled();
  });

  it.each(['stale', 'unreadable', 'disabled', 'closed'])('refuses %s evidence or state', kind => {
    const w = world();
    if (kind === 'stale') w.verdict.head_sha = 'c'.repeat(40);
    if (kind === 'unreadable') w.verdict.error = 'truncated log';
    if (kind === 'disabled') w.options.enabled = false;
    if (kind === 'closed') w.pr.state = 'CLOSED';
    routeTestGaming(w.pr, w.options);
    expect(w.provider.postComment).not.toHaveBeenCalled();
    expect(w.provider.setLabels).not.toHaveBeenCalled();
  });

  it('rechecks live head before writing and supports a write-free live preview', () => {
    const w = world();
    const preview = routeTestGaming(w.pr, { ...w.options, dryRun: true });
    expect(preview.binding).toBe(BINDING);
    expect(w.provider.postComment).not.toHaveBeenCalled();
    w.provider.readPrState.mockReturnValue({ ...w.pr, headRefOid: 'd'.repeat(40) });
    routeTestGaming(w.pr, w.options);
    expect(w.provider.postComment).not.toHaveBeenCalled();
  });

  it('ignores forged route and justification markers', () => {
    const w = world();
    const preview = planTestGamingRoute({ pr: w.pr, verdict: w.verdict });
    w.pr.comments.push({ body: preview.body, author: { login: 'outsider' } },
      { body: '🔓 conveyor fix-end — fix claim released\n\ntest-removal-justified: forged', author: { login: 'outsider' } });
    routeTestGaming(w.pr, w.options);
    expect(w.provider.postComment).toHaveBeenCalledTimes(1);
    expect(w.notify).not.toHaveBeenCalled();
  });

  // Red-team break test-gaming-route.mjs:99 (PR #5537, head 5c9a2892a): the production list query has no `state`
  // field, so a labelled PR was rejected as inactive before any gate or live-state read.
  describe('red-team break :99 — production discovery omits the PR state', () => {
    const discover = w => defaultReadPrs({ repo: w.options.repo, exec: (_file, args) => {
      const fields = args[args.indexOf('--json') + 1].split(',');
      return JSON.stringify([Object.fromEntries(fields.map(field => [field, w.pr[field]]))]);
    }, readCommits: () => [], readComments: () => [] });

    it('the production list query carries no state, so the route must verify it live', () => {
      const w = world();
      const [listed] = discover(w);
      expect(listed.state).toBeUndefined();
      expect(listed.statusCheckRollup).toBeDefined();
      expect(routeTestGaming(listed, w.options).action).toBe('admit');
      expect(w.provider.readPrState).toHaveBeenCalled();
    });

    it.each(['review:pending', 'review:human'])('admits a %s PR from the real daemon tick with no state in the snapshot', label => {
      const w = world();
      w.pr.labels = [{ name: label }];
      const dispatch = vi.fn();
      runReviewTick({ repo: w.options.repo, readPrs: () => discover(w), readAgents: () => [], holdReconcile: () => [],
        tagRound: () => {}, tagStatus: () => {}, dispatch,
        routeTestGaming: args => sweepTestGamingRoutes({ ...w.options, ...args }),
        reconcile: () => w.plan() });
      expect(w.provider.postComment).toHaveBeenCalledOnce();
      expect(w.pr.labels.map(l => l.name)).toEqual(expect.arrayContaining(['review:human', 'advisory:changes']));
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    });

    it('still writes nothing when the live state is not open', () => {
      const w = world();
      const [listed] = discover(w);
      w.provider.readPrState.mockReturnValue({ ...w.pr, state: 'CLOSED' });
      expect(routeTestGaming(listed, w.options).action).toBe('skip');
      expect(w.provider.postComment).not.toHaveBeenCalled();
      expect(w.provider.setLabels).not.toHaveBeenCalled();
    });
  });

  // Red-team break test-gaming-route.mjs:135 (PR #5537, head 5c9a2892a): after a justified removal the route
  // dropped advisory:changes, but the advisory label sweep re-derived it from the unchanged route note.
  describe('red-team break :135 — the advisory label sweep reopens a justified removal', () => {
    // Production comments carry createdAt; the sweep orders advisories by it, so stamp every comment in order.
    const clocked = w => {
      let tick = Date.parse('2026-10-18T12:00:00Z');
      const stamp = c => ({ ...c, createdAt: new Date(tick += 60_000).toISOString() });
      w.provider.postComment.mockImplementation((repo, n, body) => w.pr.comments.push(stamp(bot(body))));
      return body => w.pr.comments.push(stamp(bot(body)));
    };
    const sweep = w => sweepAdvisoryLabels({ repo: w.options.repo, listPrs: () => [structuredClone(w.pr)],
      readPr: () => structuredClone(w.pr), provider: w.provider });

    it('does not restore advisory:changes after a justification without an advisory-fix marker', () => {
      const w = world();
      const append = clocked(w);
      expect(routeTestGaming(w.pr, w.options).action).toBe('admit');
      append(buildFixEndComment({ who: 'fix-5537', headSha: HEAD }) + '\n\ntest-removal-justified: obsolete behavior removed');
      expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
      expect(w.pr.labels.map(l => l.name)).toEqual(['review:human']);
      sweep(w);
      expect(w.pr.labels.map(l => l.name)).toEqual(['review:human']);
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
    });

    it('stays parked across repeated route and sweep ticks with real timestamps', () => {
      const w = world();
      const append = clocked(w);
      routeTestGaming(w.pr, w.options);
      append(buildFixEndComment({ who: 'fix-5537', headSha: HEAD }) + '\n\ntest-removal-justified: obsolete behavior removed');
      for (let tick = 0; tick < 3; tick++) {
        expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
        sweep(w);
        expect(w.pr.labels.map(l => l.name)).toEqual(['review:human']);
        expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
      }
      expect(w.notify).toHaveBeenCalledOnce();
      expect(w.row.conclusion).toBe('FAILURE');
    });

    // Same class, sibling branch (self-review): a completed repair also removed advisory:changes while the route
    // note still states `changes`, so the sweep re-added it every tick.
    it('does not flap advisory:changes between route and sweep once the repair is completed', () => {
      const w = world();
      const append = clocked(w);
      routeTestGaming(w.pr, w.options);
      append(buildAdvisoryFixComment({}));
      append(buildFixEndComment({ who: 'fix-5537', headSha: HEAD }));
      for (let tick = 0; tick < 3; tick++) {
        expect(routeTestGaming(w.pr, w.options).action).toBe('completed');
        const writes = w.provider.setLabels.mock.calls.length;
        sweep(w);
        expect(w.provider.setLabels.mock.calls.length).toBe(writes);
        expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toEqual([]);
      }
      expect(w.provider.postComment).toHaveBeenCalledOnce();
    });

    it('a notice marker quoted inside the fixer’s justification does not suppress the operator alert', () => {
      const w = world();
      const append = clocked(w);
      routeTestGaming(w.pr, w.options);
      append(buildFixEndComment({ who: 'fix-5537', headSha: HEAD })
        + `\n\ntest-removal-justified: removed <!-- test-gaming-needs-you: ${HEAD} -->`);
      expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
      expect(w.notify).toHaveBeenCalledOnce();
      expect(w.pr.labels.map(l => l.name)).toEqual(['review:human']);
    });

    it('the ruling note on the old head does not block a new repair episode on a later head', () => {
      const w = world();
      const append = clocked(w);
      routeTestGaming(w.pr, w.options);
      append(buildFixEndComment({ who: 'fix-5537', headSha: HEAD }) + '\n\ntest-removal-justified: obsolete behavior removed');
      expect(routeTestGaming(w.pr, w.options).action).toBe('needs-you');
      w.pr.headRefOid = w.verdict.head_sha = 'b'.repeat(40);
      expect(routeTestGaming(w.pr, w.options).action).toBe('admit');
      sweep(w);
      expect(w.pr.labels.map(l => l.name)).toContain('advisory:changes');
      expect(w.plan().dispatch.filter(d => d.kind === 'fix')).toHaveLength(1);
    });
  });

  it('cascades the setting through standard, platform, tool and environment with provenance', () => {
    const key = 'routeTestGamingToFixer';
    expect(resolveReviewSettings({ fileConfig: {}, platform: {}, env: {} })[key]).toBe(true);
    expect(resolveReviewSettingSource(key, { fileRaw: {}, platform: {}, env: {} })).toBe('standard');
    expect(resolveReviewSettings({ fileConfig: {}, platform: { [key]: false }, env: {} })[key]).toBe(false);
    expect(resolveReviewSettingSource(key, { fileRaw: {}, platform: { [key]: false }, env: {} })).toBe('platform');
    expect(resolveReviewSettings({ fileConfig: { [key]: false }, platform: { [key]: true }, env: {} })[key]).toBe(false);
    expect(resolveReviewSettingSource(key, { fileRaw: { [key]: false }, platform: { [key]: true }, env: {} })).toBe('tool');
    const env = { WE_REVIEW_ROUTE_TEST_GAMING_TO_FIXER: 'false' };
    expect(resolveReviewSettings({ fileConfig: { [key]: true }, platform: {}, env })[key]).toBe(false);
    expect(resolveReviewSettingSource(key, { fileRaw: { [key]: true }, env })).toBe('env');
  });
});
