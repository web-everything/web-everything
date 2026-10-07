/**
 * agy-launcher-probation (#4291) — the doc-fix BUILD arc of `probation-build-run.mjs` over a fake `io` (no git,
 * no gh, no model). Mirrors `probation-heal-run.test.mjs`'s own fake-io shape and coverage, adapted to a build's
 * two extra facts a heal never has: it CLAIMS/RESOLVES a backlog item, and it OPENS a brand-new PR rather than
 * pushing to one that already exists.
 *
 * A plan review (Codex, read-only, #4291 fast-lane prepare) flagged that releasing the claim via
 * `backlog.mjs release` AFTER a `git reset --hard` (which already reverts the item's own status) trips the
 * `release`-only-from-`active`/`preparing` guard. The fix — relied on throughout below — is that NOTHING is
 * ever pushed on a failure path, so a plain `git reset --hard` back to the pre-claim HEAD undoes the claim
 * along with everything after it in one step; there is no separate "release the claim" call at all.
 */
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { symlinkSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearScopeAndAppendFinding, sanitizeHoldReason } from '../build-dispatch-hold-route-land.mjs';
import { scanRepoLocusPrefixes } from '../../check-standards-rules.mjs';
import { withInfraLock } from '../../conveyor/infra-blocked.mjs';
import { gateFailureDetail, captureWorkerMessage, openPrArgv, parseArgs, realIo, runProbationBuild } from '../probation-build-run.mjs';

describe('realIo().blockedByGraph', () => {
  it('includes hash-named cards and validates their parsed proposals against the loaded graph', async () => {
    const { parseProposedBlockedBy, validateProposedBlockedBy } = await import('../../lib/probation-launcher.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'probation-build-graph-'));
    try {
      mkdirSync(join(dir, 'backlog'));
      writeFileSync(join(dir, 'backlog', '4705-self.md'), '---\nstatus: open\nblockedBy: []\n---\n');
      writeFileSync(join(dir, 'backlog', 'x2c7uas-target.md'), '---\nstatus: open\nblockedBy: [4705]\n---\n');
      writeFileSync(join(dir, 'backlog', 'x2c7uasq-invalid.md'), '---\nstatus: open\n---\n');
      writeFileSync(join(dir, 'backlog', '123456-invalid.md'), '---\nstatus: open\n---\n');
      const graph = realIo().blockedByGraph(dir);
      expect(graph.get('x2c7uas')).toEqual({ status: 'open', blockedBy: ['4705'] });
      expect([...graph.keys()].sort()).toEqual(['4705', 'x2c7uas']);
      const edges = parseProposedBlockedBy('## Proposed blockedBy changes\n- add x2c7uas — prerequisite (we:a:1)\n');
      expect(validateProposedBlockedBy('4705', edges, graph)).toEqual(['blockedBy cycle: #4705 → #x2c7uas → #4705']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('realIo().findItem — the card\'s own scope is what the arc allowlists (#4291 advisory finding)', () => {
  const withCard = (text, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'probation-build-find-'));
    try { mkdirSync(join(dir, 'backlog')); writeFileSync(join(dir, 'backlog', '4291-x.md'), text); return fn(realIo({ session: 's' }).findItem('4291', dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('reads an inline-array scope', () => withCard('---\nstatus: open\nscope: ["we:docs/a.md"]\n---\n\n# X\n', (item) => expect(item.scope).toEqual(['we:docs/a.md'])));
  it('reads a block-list scope', () => withCard('---\nstatus: open\nscope:\n  - we:docs/a.md\n  - we:docs/b/\n---\n\n# X\n', (item) => expect(item.scope).toEqual(['we:docs/a.md', 'we:docs/b/'])));
  it('no scope, or a non-list scope, reads as none', () => {
    withCard('---\nstatus: open\n---\n\n# X\n', (item) => expect(item.scope).toEqual([]));
    withCard('---\nstatus: open\nscope: we:docs/a.md\n---\n\n# X\n', (item) => expect(item.scope).toEqual([]));
    withCard('---\nstatus: open\nscope: ["", "  ", null]\n---\n\n# X\n', (item) => expect(item.scope).toEqual([]));
  });
  // #4291 advisory finding (security) — gray-matter's default engines EVAL a `---js` block, and the post-worker
  // re-read parses text the worker controls. It must never run, and reads as no scope.
  it.each(['js', 'javascript', 'coffee'])('a `---%s` card is never evaluated — no scope, no side effect', (lang) => {
    delete globalThis.__probationCardEvalRan;
    withCard(`---${lang}\n{ scope: (globalThis.__probationCardEvalRan = true, ["we:docs/a.md"]) }\n---\n\n# X\n`, (item) => {
      expect(globalThis.__probationCardEvalRan).toBeUndefined();
      expect(item.scope).toEqual([]);
    });
  });
});

describe('openPrArgv — every probation build PR is parked review:pending, never label-on-green (#4291 plan review round 3)', () => {
  it('carries --mode=park --parkLabel=review:pending --requireVerified=true, never label-on-green', () => {
    const argv = openPrArgv({ num: '4291', attemptTag: '', slug: 'probation-launcher', bodyFile: '/lane/.pr-body.md' });
    expect(argv).toEqual(expect.arrayContaining(['--mode=park', '--parkLabel=review:pending', '--requireVerified=true']));
    expect(argv).not.toContain('--mode=label-on-green');
    expect(argv[1]).toBe('--ref=lane/4291-probation-launcher');
  });
  it('folds a retry\'s attempt tag into the ref between the number and the slug, never elsewhere', () => {
    const argv = openPrArgv({ num: '4291', attemptTag: 'b', slug: 'probation-launcher', bodyFile: '/lane/.pr-body.md' });
    expect(argv[1]).toBe('--ref=lane/4291b-probation-launcher');
  });
});

const codex = { id: 'codex', provider: 'codex', model: 'gpt-6-astra', executor: 'codex', launcher: 'scripts/codex-direct-task.mjs', checker: null, taskType: 'doc-fix' };

/** A fake io: a claimed item whose worker diff, gate and PR-open result the test chooses. */
// The card's own `scope:` (in `raw` AND the parsed `scope`) is what bounds the worker — kept consistent with
// the happy-path numstat below, never only the dispatch's `--scope` argument (#4291 advisory finding).
const ITEM_RAW = '---\nstatus: open\nscope: ["we:docs/probation/probation.md"]\n---\n\n## Done when\n\n1. it works.';

function fakeIo({
  itemScope = ['we:docs/probation/probation.md'],
  lane = '/lanes/22', item = { path: 'backlog/4291-probation-launcher.md', slug: 'probation-launcher', title: 'Probation launcher', spec: '## Done when\n\n1. it works.', raw: ITEM_RAW, scope: itemScope },
  claimOk = true, numstat = '1\t20\tdocs/probation/probation.md', gate = true, resolveOk = true, openPr: openPrResult = { ok: true, pr: 9001, url: 'https://x/9001' },
  throwOn = null, postWorkerSpec = null, postWorkerRaw = null, claimTamperedRaw = null, runWorkerOk = true, lastMessage = undefined,
  headShaSequence = null, throwOnHeadShaCall = null, hookResetClean = true, hookTampered = false, tamperRestoreClean = true,
} = {}) {
  const calls = [];
  const boom = (name) => { if (throwOn === name) throw new Error(`${name} exploded`); };
  let findItemCalls = 0;
  let headShaCalls = 0;
  const cleanSnapshot = { configHash: 'clean', files: {} };
  const tamperedSnapshot = { configHash: 'clean', files: { 'pre-commit': 'planted' } };
  const io = {
    log: () => {},
    openBlockers: () => [],
    acquireLane: (o) => { calls.push(['acquireLane', o.lane, o.scope]); return lane; },
    resetHookSurface: (d, baseline) => { boom('resetHookSurface'); calls.push(baseline ? ['reset-hooks', d, baseline] : ['reset-hooks', d]); return { clean: baseline ? tamperRestoreClean : hookResetClean, leftover: hookResetClean ? [] : ['pre-commit'], snapshot: cleanSnapshot }; },
    snapshotHookSurface: (d) => { boom('snapshotHookSurface'); calls.push(['snapshot-hooks', d]); return hookTampered ? tamperedSnapshot : cleanSnapshot; },
    findItem: () => {
      findItemCalls += 1;
      // Call 1 is the very first read, before claim. Call 2 is the post-claim consistency check — normally a
      // no-op re-read (`claimTamperedRaw` simulates `claim` itself misbehaving). Call 3+ is the post-worker
      // check — `postWorkerSpec`/`postWorkerRaw` simulate a worker that rewrote the item's own body/frontmatter.
      if (findItemCalls === 1) return item;
      if (findItemCalls === 2) return claimTamperedRaw != null ? { ...item, raw: claimTamperedRaw } : item;
      return { ...item, spec: postWorkerSpec ?? item.spec, raw: postWorkerRaw ?? item.raw };
    },
    claim: () => { calls.push(['claim']); return claimOk; },
    // Call 1 is pre-claim, call 2 is post-claim — `headShaSequence` (e.g. `['a', 'b']`) simulates `claim`
    // itself moving HEAD (a commit), which every `abandon` path's undo assumes never happens.
    // `throwOnHeadShaCall` (e.g. `2`) throws on that ONE call only — the post-claim read after a successful claim.
    headSha: () => { boom('headSha'); headShaCalls += 1; if (headShaCalls === throwOnHeadShaCall) throw new Error('headSha exploded'); return headShaSequence ? headShaSequence[headShaCalls - 1] ?? headShaSequence.at(-1) : 'base-sha'; },
    writeTaskFile: (_d, name, text) => { calls.push(['task', name, text.length > 0]); return `/lanes/22/.git/${name}`; },
    runWorker: (argv) => { boom('runWorker'); calls.push(['worker', argv[0], argv.find((a) => a.startsWith('--model='))]); return { ok: runWorkerOk, out: runWorkerOk ? '' : 'timed out', lastMessage }; },
    holdWorkerDecline: (entry) => { boom('holdWorkerDecline'); calls.push(['hold', entry]); },
    landAlreadyDone: (entry, dir) => { calls.push(['land', entry, dir]); return { status: 'landed', pr: 9002 }; },
    writeCard: (_dir, path, text) => { boom('writeCard'); calls.push(['card', path, text]); },
    untracked: () => ['node_modules'],
    diffNumstat: (_d, _base, exclude) => { calls.push(['numstat', exclude]); return numstat; },
    discardChanges: (_d, base) => { calls.push(['discard', base]); numstat = ''; },
    resolveItem: () => { boom('resolveItem'); calls.push(['resolve']); return resolveOk ? { ok: true } : { ok: false, reason: 'open-children' }; },
    commit: (_d, paths, msg) => { boom('commit'); calls.push(['commit', paths, msg.split('\n')[0]]); },
    runGate: () => { calls.push(['gate']); return { pass: gate, output: 'gate out' }; },
    writePrBody: () => { boom('writePrBody'); calls.push(['prBody']); return '/lanes/22/.pr-body.md'; },
    openPr: (o) => { boom('openPr'); calls.push(['openPr', o.slug, o.attemptTag]); return openPrResult; },
    appendScorecard: (r) => calls.push(['scorecard', r.launchOutcome, r.executor, r.outcome, r.verifiedBy, r.item, r.pr]),
  };
  return { io, calls };
}
// #4291 plan review round 7 — a declared scope is now REQUIRED before any worker runs (see the run script's
// own "no declared scope" refusal), so every test defaults one matching the happy-path numstat below; a test
// that needs a DIFFERENT scope (or none) overrides it via `extra.scope` (including `''`, which parses to `[]`).
const args = (worker = codex, extra = {}) => parseArgs(['--num=4291', '--session=probation-4291', `--worker=${JSON.stringify(worker)}`, '--lane=22', '--scope=we:docs/probation/probation.md', ...Object.entries(extra).map(([k, v]) => `--${k}=${v}`)]);

describe('parseArgs', () => {
  it('parses the build-specific flags (num, attempt) and the shared ones', () => {
    const a = parseArgs(['--num=4291', '--session=s', '--attempt=b', '--worker={"id":"codex"}', '--lane=22', '--scope=we:a.mjs,we:b.mjs']);
    expect(a).toMatchObject({ num: '4291', session: 's', attemptTag: 'b', lane: 22, scope: ['we:a.mjs', 'we:b.mjs'], worker: { id: 'codex' } });
  });
  it('a first attempt has an empty attempt tag', () => expect(parseArgs(['--num=1', '--session=s']).attemptTag).toBe(''));
});

describe('runProbationBuild — the arc', () => {
  it('claim → worker builds within envelope → resolve → commit → gate green → PR opened parked, one launch row', async () => {
    const { io, calls } = fakeIo();
    const r = await runProbationBuild(args(), io);
    expect(r).toMatchObject({ outcome: 'opened-pr', executor: 'codex' });
    expect(calls.find((c) => c[0] === 'worker')).toEqual(['worker', expect.stringMatching(/scripts\/codex-direct-task\.mjs$/), '--model=gpt-6-astra']);
    expect(calls.find((c) => c[0] === 'commit')).toEqual(['commit', ['docs/probation/probation.md', 'backlog/4291-probation-launcher.md'], expect.stringContaining('WE #4291: doc-fix-build — ')]);
    expect(calls.find((c) => c[0] === 'openPr')).toEqual(['openPr', 'probation-launcher', '']);
    expect(calls.filter((c) => c[0] === 'scorecard')).toEqual([['scorecard', 'opened-pr', 'codex', null, null, '4291', 9001]]);
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
    // the untracked files that were there BEFORE the worker ran, AND the item's own file (its claim/resolve
    // bookkeeping, not the worker's change), are excluded from the diff the worker's own change is measured by.
    expect(calls.find((c) => c[0] === 'numstat')).toEqual(['numstat', ['node_modules', 'backlog/4291-probation-launcher.md']]);
  });

  it('a claim-stamp line in the raw numstat never inflates the worker\'s own diff or duplicates the commit path', async () => {
    // If the item's own file were not excluded, this numstat (as the claim/resolve bookkeeping diff would look)
    // would count as a SECOND changed file, wrongly consuming half the doc-fix envelope's file cap.
    const { io, calls } = fakeIo({ numstat: '1\t20\tdocs/probation/probation.md\n2\t1\tbacklog/4291-probation-launcher.md' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('opened-pr');
    expect(calls.find((c) => c[0] === 'commit')[1]).toEqual(['docs/probation/probation.md', 'backlog/4291-probation-launcher.md']);
  });

  it('no lane available → not-applicable, before any claim', async () => {
    const { io, calls } = fakeIo();
    io.acquireLane = () => null;
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('not-applicable');
    expect(calls.some((c) => c[0] === 'claim')).toBe(false);
  });

  it('no backlog file for the item → not-applicable, before any claim', async () => {
    const { io, calls } = fakeIo();
    io.findItem = () => null;
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('not-applicable');
    expect(calls.some((c) => c[0] === 'claim')).toBe(false);
  });

  it('the item could not be claimed → not-applicable, no worker run, no discard, no scorecard row', async () => {
    const { io, calls } = fakeIo({ claimOk: false });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('not-applicable');
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
    expect(calls.some((c) => c[0] === 'scorecard')).toBe(false);
  });

  it.each([
    'Target files exist only on lane/mechanical-dispatcher; porting them exceeds the bugfix envelope.',
    undefined,
    '   ',
  ])('no change records the reason (%s), routes the hold and opens a card-only PR', async (lastMessage) => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage });
    const r = await runProbationBuild(args(), io);
    const reason = lastMessage?.trim() || 'The worker changed nothing and provided no final message.';
    expect(r).toMatchObject({ outcome: 'opened-pr', pr: 9001 });
    expect(r.detail).toContain(reason);
    expect(calls.find((c) => c[0] === 'hold')?.[1]).toEqual({ num: '4291', route: 'out-of-scope', commit: null, reason: `worker-declined: ${reason}` });
    const card = calls.find((c) => c[0] === 'card')?.[2];
    expect(card).toContain('## Findings (standalone worker, ');
    expect(card).toContain(`> worker-declined: ${reason}`);
    expect(card).toContain('status: open');
    expect(card).not.toMatch(/^scope:/m);
    expect(calls.find((c) => c[0] === 'commit')?.[1]).toEqual(['backlog/4291-probation-launcher.md']);
    expect(calls.some((c) => ['discard', 'resolve'].includes(c[0]))).toBe(false);
    expect(calls.filter((c) => c[0] === 'scorecard')).toHaveLength(1);
    // Once the routed card lands, a fresh standalone attempt skips it until it is re-scoped.
    const retry = fakeIo({ itemScope: [] });
    expect((await runProbationBuild(args(), retry.io)).outcome).toBe('not-applicable');
    expect(retry.calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  it('bounds and quotes a decline, without treating a cited commit as proof of delivery', async () => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage: 'worker-declined: spec already done on main: commit abc1234\n<script>`' + 'x'.repeat(900) });
    const r = await runProbationBuild(args(), io);
    const reason = calls.find((c) => c[0] === 'hold')[1].reason;
    expect(reason.length).toBe(617); // prefix + 600-character excerpt
    expect(reason).not.toMatch(/[\n<`]/);
    expect(reason).toContain('…');
    expect(r.detail).toContain(reason);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('replays #3353 already-exists evidence through the shared already-done landing', async () => {
    const lastMessage = 'The fixture already exists; all Done-when checks pass. spec already done on main: commit 0ee967238';
    const { io, calls } = fakeIo({ numstat: '', lastMessage });
    const result = await runProbationBuild(args(codex, { num: '3353' }), io);
    expect(result).toMatchObject({ outcome: 'opened-pr', pr: 9002, detail: expect.stringContaining('already-done: 0ee967238') });
    const entry = { num: '3353', route: 'already-done', commit: '0ee967238', reason: lastMessage };
    expect(calls.find((c) => c[0] === 'hold')).toEqual(['hold', entry]);
    expect(calls.find((c) => c[0] === 'land')).toEqual(['land', entry, '/lanes/22']);
    expect(calls.filter((c) => ['card', 'resolve', 'commit', 'openPr'].includes(c[0]))).toEqual([]);
    expect(calls.findIndex((c) => c[0] === 'discard')).toBeLessThan(calls.findIndex((c) => c[0] === 'land'));
  });

  it('does not resolve an uncited already-exists assertion', async () => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage: 'already exists; all Done-when checks pass' });
    await runProbationBuild(args(), io);
    expect(calls.find((c) => c[0] === 'hold')[1].route).toBe('out-of-scope');
    expect(calls.some((c) => c[0] === 'land')).toBe(false);
  });

  it('reports a refused citation without falling through to a decline or a plain resolve', async () => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage: 'spec already done on main: commit abc1234' });
    io.landAlreadyDone = () => ({ status: 'failed', error: 'unverified citation' });
    expect(await runProbationBuild(args(), io)).toMatchObject({ outcome: 'escalated-needs-human', pr: null,
      detail: 'already-done landing failed: unverified citation' });
    expect(calls.filter((c) => ['card', 'resolve', 'commit', 'openPr'].includes(c[0]))).toEqual([]);
  });

  it.each(['holdWorkerDecline', 'writeCard', 'commit'])('reports failed decline persistence at %s with its reason', async (throwOn) => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage: 'Wrong target branch.', throwOn });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toContain('Wrong target branch.');
    expect(calls.some((c) => c[0] === 'openPr')).toBe(false);
  });

  it('a failed decline PR preserves the gated card commit and reports the reason', async () => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage: 'Wrong target.', openPr: { ok: false, reason: 'PR refused' } });
    const r = await runProbationBuild(args(), io);
    expect(r).toMatchObject({ outcome: 'escalated-needs-human', detail: expect.stringContaining('Wrong target.') });
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
  });

  it('rejects card tampering even when there is no implementation diff', async () => {
    const { io, calls } = fakeIo({ numstat: '', postWorkerRaw: ITEM_RAW.replace('open', 'resolved') });
    expect((await runProbationBuild(args(), io)).outcome).toBe('escalated-needs-human');
    expect(calls.some((c) => c[0] === 'hold')).toBe(false);
  });

  it('a build bigger than the doc-fix envelope lands Findings and holds for the builder', async () => {
    const { io, calls } = fakeIo({ numstat: '60\t50\tdocs/probation/probation.md' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('opened-pr');
    expect(r.detail).toMatch(/changed 110 lines/);
    expect(calls.find(c => c[0] === 'hold')[1]).toMatchObject({ route: 'other' });
    expect(calls.find(c => c[0] === 'card')[2]).toContain('route to the builder');
    expect(calls.find(c => c[0] === 'card')[2]).toMatch(/^scope:/m);
    expect(calls.find(c => c[0] === 'commit')[1]).toEqual(['backlog/4291-probation-launcher.md']);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('a non-documentation path touched by the worker is discarded, never resolved (#4291 plan review)', async () => {
    const { io, calls } = fakeIo({ numstat: '2\t1\tscripts/lib/probation-launcher.mjs' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('gate-red');
    expect(r.detail).toMatch(/non-documentation path.*scripts\/lib\/probation-launcher\.mjs/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  describe('a declared scope is an ALLOWLIST, not a growing denylist (#4291 plan review rounds 4-7)', () => {
    // Rounds 4-6 tried a DENYLIST of specific dangerous paths against an unscoped item, and it kept being
    // provably incomplete (round 5 named `CLAUDE.md`, round 6 named `GEMINI.md`). Round 7 replaced the whole
    // fallback with a hard refusal on no declared scope (below) plus this allowlist — so EVERY one of these
    // paths remains refused. #3996 now rejects non-reader-facing Markdown at the documentation gate first;
    // reader-facing docs still exercise the item's scope allowlist independently.
    it('a path matching the item\'s own declared scope is built', async () => {
      const { io } = fakeIo({ numstat: '1\t20\tdocs/probation/probation.md' });
      const r = await runProbationBuild(args(), io);
      expect(r.outcome).toBe('opened-pr');
    });
    it('a scope entry ending in `/` is a DIRECTORY prefix — every file under it is in scope (#4291 plan review round 9)', async () => {
      const { io } = fakeIo({ numstat: '1\t20\tdocs/probation/guides/anything.md', itemScope: ['we:docs/probation/guides/'] });
      const r = await runProbationBuild(args(codex, { scope: 'we:docs/probation/guides/' }), io);
      expect(r.outcome).toBe('opened-pr');
    });
    it('a cross-repo scope entry (e.g. `frontierui:docs/a.md`) never allowlists a same-named WE path — this launcher only ever builds in the WE lane (#4291 plan review round 10)', async () => {
      const { io, calls } = fakeIo({ numstat: '1\t2\tdocs/a.md', itemScope: ['frontierui:docs/a.md'] });
      const r = await runProbationBuild(args(codex, { scope: 'frontierui:docs/a.md' }), io);
      expect(r.outcome).toBe('not-applicable'); // stripped to nothing → no declared (WE) scope → refused
      expect(r.detail).toMatch(/declares no scope/);
      expect(calls.some((c) => c[0] === 'worker')).toBe(false);
    });
    it.each([
      ['a different backlog card', 'backlog/9999-some-other-item.md', /non-documentation path/],
      ['the statute layer', 'docs/agent/platform-decisions.md', /outside the item's own declared scope/],
      ['an unlisted reader-facing document', 'docs/GEMINI.md', /outside the item's own declared scope/],
      ['CLAUDE.md', 'CLAUDE.md', /non-documentation path/],
      ['AGENTS.md', 'AGENTS.md', /non-documentation path/],
      ['a .claude/ command file', '.claude/commands/x.md', /non-documentation path/],
      ['an arbitrary unlisted .md file (GEMINI.md — round 6\'s own example; no denylist entry names it)', 'GEMINI.md', /non-documentation path/],
    ])('%s is discarded by the documentation or scope allowlist', async (_label, path, refusal) => {
      const { io, calls } = fakeIo({ numstat: `2\t1\t${path}` });
      const r = await runProbationBuild(args(), io);
      expect(r.outcome).toBe('gate-red');
      expect(r.detail).toMatch(refusal);
      expect(r.detail).toContain(path);
      expect(calls.some((c) => c[0] === 'discard')).toBe(true);
      expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
    });
  });

  it('a dispatch --scope broader than the card\'s own declared scope never widens the allowlist — the card governs (#4291 advisory finding)', async () => {
    // The dispatch argument allows `docs/probation/probation.md`; the card (read in the lane) declares only `a.md`.
    const { io, calls } = fakeIo({ itemScope: ['we:docs/probation/a.md'] });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('gate-red');
    expect(r.detail).toMatch(/outside the item's own declared scope.*: docs\/probation\/probation\.md$/);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
  });

  it('a card scope WIDER than the leased dispatch --scope never lets the worker edit an unleased path (#4291 advisory repair review)', async () => {
    const { io, calls } = fakeIo({ itemScope: ['we:docs/probation/'], numstat: '1\t2\tdocs/probation/other.md' });
    const r = await runProbationBuild(args(), io); // leased only docs/probation/probation.md
    expect(r.outcome).toBe('gate-red');
    expect(r.detail).toMatch(/outside the item's own declared scope.*: docs\/probation\/other\.md$/);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('an empty dispatch --scope is a whole-clone lease, not deny-all — the card\'s scope alone bounds the build (#4291 advisory finding)', async () => {
    const { io, calls } = fakeIo();
    const r = await runProbationBuild(args(codex, { scope: '' }), io);
    expect(r.outcome).toBe('opened-pr');
    expect(calls.some((c) => c[0] === 'commit')).toBe(true);
    const { io: io2 } = fakeIo({ numstat: '1\t2\tdocs/probation/other.md' });
    expect((await runProbationBuild(args(codex, { scope: '' }), io2)).outcome).toBe('gate-red'); // the card still governs
    const { io: io3 } = fakeIo(); // a lease naming only another repo's paths is still a lease — nothing here is leased
    expect((await runProbationBuild(args(codex, { scope: 'frontierui:docs/x.md' }), io3)).outcome).toBe('gate-red');
  });

  it('a card with no declared scope is refused even when the dispatch passed a --scope (#4291 advisory finding)', async () => {
    const { io, calls } = fakeIo({ itemScope: [] });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('not-applicable');
    expect(r.detail).toMatch(/declares no scope/);
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  it('a HEAD read that throws AFTER a successful claim still undoes the claim, resetting to the known pre-claim sha (#4291 advisory finding)', async () => {
    const { io, calls } = fakeIo({ throwOnHeadShaCall: 2 });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/unexpected error: headSha exploded/);
    expect(calls.some((c) => c[0] === 'claim')).toBe(true);
    expect(calls.find((c) => c[0] === 'discard')).toEqual(['discard', 'base-sha']);
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  it('an item with no declared scope is refused before any worker runs (#4291 plan review round 7)', async () => {
    const { io, calls } = fakeIo({ itemScope: [] });
    const r = await runProbationBuild(args(codex, { scope: '' }), io);
    expect(r.outcome).toBe('not-applicable');
    expect(r.detail).toMatch(/declares no scope/);
    expect(r.executor).toBe('none');
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
    expect(calls.some((c) => c[0] === 'scorecard')).toBe(false);
  });

  it('a worker that rewrites the item\'s own backlog card body is discarded and escalated, never resolved (#4291 plan review)', async () => {
    const { io, calls } = fakeIo({ postWorkerSpec: '## Done when\n\n1. something else entirely.' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/edited the item's own backlog card/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('a worker that tampers with the item\'s frontmatter (e.g. `scope:`) beyond the claim\'s own stamp is discarded and escalated (#4291 plan review round 2)', async () => {
    const { io, calls } = fakeIo({ postWorkerRaw: '---\nstatus: open\nscope: ["we:evil.mjs"]\n---\n\n## Done when\n\n1. it works.' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/edited the item's own backlog card/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });

  it('a worker forging `graduatedTo:`/`codifiedIn:` directly is caught as tamper too — this launcher never sets those itself, so they are NOT in its own allowlist even though the shared default permits them (#4291 plan review round 8)', async () => {
    const { io, calls } = fakeIo({ postWorkerRaw: '---\nstatus: open\nscope: ["we:docs/probation/probation.md"]\ngraduatedTo: "some-standard"\n---\n\n## Done when\n\n1. it works.' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/edited the item's own backlog card/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });
  // #4291 advisory finding (codex-correctness) — the post-worker card is compared against the POST-CLAIM read,
  // byte for byte: `status`/`dateStarted` are claim-owned, but the worker may not forge them either.
  it.each([
    ['status', '---\nstatus: resolved\nscope: ["we:docs/probation/probation.md"]\n---\n\n## Done when\n\n1. it works.'],
    ['dateStarted', '---\nstatus: open\nscope: ["we:docs/probation/probation.md"]\ndateStarted: "2020-01-01"\n---\n\n## Done when\n\n1. it works.'],
  ])('a worker forging the claim-owned `%s` directly is caught as tamper', async (_key, forged) => {
    const { io, calls } = fakeIo({ postWorkerRaw: forged });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/edited the item's own backlog card/);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
  });
  it('a worker that did not finish cleanly (ok:false) is escalated, never resolved or committed, even with a partial diff (#4291 plan review round 2)', async () => {
    const { io, calls } = fakeIo({ runWorkerOk: false });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/did not finish cleanly/);
    expect(calls.some((c) => c[0] === 'resolve')).toBe(false);
    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(calls.find((c) => c[0] === 'scorecard')).toBeTruthy();
  });

  it('an unexpected thrown error opening the PR (not just ok:false) still preserves the gate-green commit — never discarded (#4291 plan review round 2)', async () => {
    const { io, calls } = fakeIo({ throwOn: 'openPr' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/unexpected error opening the PR.*gate-green/);
    expect(calls.some((c) => c[0] === 'commit')).toBe(true);
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
  });

  it('claim moving HEAD (as if it committed) is caught BEFORE the worker ever runs, and nothing is reset to an unexplained HEAD (#4291 plan review round 4)', async () => {
    const { io, calls } = fakeIo({ headShaSequence: ['pre-claim-sha', 'post-claim-sha'] });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/claim moved HEAD \(pre-claim-sha → post-claim-sha\)/);
    expect(r.executor).toBe('none');
    expect(calls.some((c) => c[0] === 'scorecard')).toBe(false);
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  it('claim writing frontmatter this launcher does not expect is caught BEFORE the worker ever runs, with no scorecard row (#4291 plan review round 4)', async () => {
    // Simulates `backlog.mjs claim` itself changing to write something outside CLAIM_OWNED_FRONTMATTER_KEYS —
    // the live, self-checking counterpart to trusting that fact as a one-time review-time read. `postWorkerRaw`
    // is read by the check's OWN `findItem` call (the 2nd overall), which runs before the worker is ever spawned.
    const { io, calls } = fakeIo({ claimTamperedRaw: '---\nstatus: active\nscope: ["we:evil.mjs"]\n---\n\n## Done when\n\n1. it works.' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/claim wrote frontmatter this launcher does not expect/);
    expect(r.executor).toBe('none');
    expect(calls.some((c) => c[0] === 'scorecard')).toBe(false);
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  it('a broken lane (git itself throwing right after the claim) escalates rather than crashing uncaught, and never fabricates a discard with no base to reset to — and writes no scorecard row, since the worker never ran (#4291 plan review round 6)', async () => {
    const { io, calls } = fakeIo({ throwOn: 'headSha' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/unexpected error: headSha exploded/);
    expect(r.executor).toBe('none');
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
    expect(calls.some((c) => c[0] === 'scorecard')).toBe(false);
  });

  it('an unexpected thrown error AFTER the worker ran attributes the scorecard row to the worker, not `none` (#4291 plan review round 6 — the counterpart of the broken-lane case above)', async () => {
    const { io, calls } = fakeIo({ throwOn: 'resolveItem' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/unexpected error: resolveItem exploded/);
    expect(r.executor).toBe('codex');
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.find((c) => c[0] === 'scorecard')).toEqual(['scorecard', 'escalated-needs-human', 'codex', null, null, '4291', null]);
  });

  it('a refused resolve is discarded and escalated', async () => {
    const { io, calls } = fakeIo({ resolveOk: false });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/resolve refused: open-children/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
  });

  it('a red final gate (after the resolve+commit) resets the lane all the way back — the commit is undone too', async () => {
    const { io, calls } = fakeIo({ gate: false });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('gate-red');
    expect(calls.some((c) => c[0] === 'commit')).toBe(true);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'openPr')).toBe(false);
  });

  it('open-pr blocked on an outside dependency is its own outcome — the built work is never discarded', async () => {
    const { io, calls } = fakeIo({ openPr: { ok: false, blockedOnInfra: true, reason: 'a GitHub outage' } });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('blocked-on-infra');
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
  });

  it('any other open-pr failure escalates — the built, gate-green work stays in the lane', async () => {
    const { io, calls } = fakeIo({ openPr: { ok: false, blockedOnInfra: false, reason: 'the required check failed' } });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(calls.some((c) => c[0] === 'discard')).toBe(false);
  });

  it('an unexpected thrown error (not an explicit ok:false) still resets the lane rather than stranding the claim', async () => {
    const { io, calls } = fakeIo({ throwOn: 'commit' });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/unexpected error: commit exploded/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
  });

  // x55dojc — hardening against a worker planting a git hook.
  it('refuses before any claim/worker when the lane\'s git-hook baseline cannot be cleaned', async () => {
    const { io, calls } = fakeIo({ hookResetClean: false });
    const r = await runProbationBuild(args(), io);
    expect(r).toMatchObject({ outcome: 'escalated-needs-human', executor: 'none' });
    expect(r.detail).toMatch(/clean git-hook baseline/);
    expect(calls.some((c) => c[0] === 'claim' || c[0] === 'worker')).toBe(false);
  });

  it('a worker that changes the lane\'s git-hook surface is refused, discarded, and never committed/PR-opened', async () => {
    const { io, calls } = fakeIo({ hookTampered: true });
    const r = await runProbationBuild(args(), io);
    expect(r).toMatchObject({ outcome: 'escalated-needs-human', executor: 'codex' });
    expect(r.detail).toMatch(/refused:/);
    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(calls.some((c) => c[0] === 'openPr')).toBe(false);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.filter((c) => c[0] === 'reset-hooks').length).toBeGreaterThanOrEqual(2); // baseline + post-tamper cleanup
    // #4291 advisory finding (security) — the cleanup restores the PRE-worker config (the whole file, not just
    // hooksPath), and does so BEFORE `discard` runs git in the lane.
    const cleanupAt = calls.findIndex((c) => c[0] === 'reset-hooks' && c[2]);
    expect(calls[cleanupAt][2]).toEqual({ configHash: 'clean', files: {} });
    expect(cleanupAt).toBeLessThan(calls.findIndex((c) => c[0] === 'discard'));
  });

  it('a tamper whose config restore fails runs NO further git in the lane — no discard — and says to quarantine it', async () => {
    const { io, calls } = fakeIo({ hookTampered: true, tamperRestoreClean: false });
    const r = await runProbationBuild(args(), io);
    expect(r.outcome).toBe('escalated-needs-human');
    expect(r.detail).toMatch(/NOT discarded; quarantine it/);
    expect(calls.some((c) => c[0] === 'discard' || c[0] === 'commit')).toBe(false);
  });

  it('refuses missing identity and resolves an omitted worker from policy', async () => {
    await expect(runProbationBuild(parseArgs(['--session=s', '--worker={"id":"codex"}']), fakeIo().io)).rejects.toThrow();
    await expect(runProbationBuild(parseArgs(['--num=1', '--session=', '--worker={"id":"codex"}']), fakeIo().io)).rejects.toThrow();
    await expect(runProbationBuild(parseArgs(['--num=1', '--session=s']), fakeIo().io)).resolves.toMatchObject({ executor: 'codex' });
  });
});

describe('standalone task types and workers', () => {
  it.each(['codex', 'antigravity-claude', 'antigravity-gemini'])('resolves %s by name and generates a unique session', (id) => {
    const argv = ['--num=4519', `--worker=${id}`];
    const a = parseArgs(argv);
    expect(a.worker.id).toBe(id);
    expect(a.worker.model).toBeTruthy();
    expect(a.taskType).toBe('doc-fix');
    expect(a.session).toMatch(new RegExp(`^probation-4519-${id}-[a-f0-9]+$`));
    expect(parseArgs(argv).session).not.toBe(a.session);
  });

  it.each(['antigravity-claude', 'antigravity-gemini'])('allows the agy overrides for %s and retains Flash checking', (id) => {
    for (const model of ['claude-sonnet-4-6', 'gemini-3.8-flash-high']) {
      const a = parseArgs([`--worker=${id}`, `--model=${model}`]);
      expect(a.worker.model).toBe(model);
      if (model.startsWith('gemini')) expect(a.worker).toMatchObject({ simpleOnly: true, checker: 'codex' });
    }
  });

  it.each(['codex', 'antigravity-claude', 'antigravity-gemini'])('rejects disallowed models for %s', (id) => {
    expect(() => parseArgs([`--worker=${id}`, '--model=unapproved'])).toThrow('disallowed model');
    expect(() => parseArgs([`--worker=${JSON.stringify({ id, model: 'unapproved' })}`])).toThrow('disallowed model');
  });

  it('refuses an agy model on Codex and an unsupported task type', () => {
    expect(() => parseArgs(['--worker=codex', '--model=claude-sonnet-4-6'])).toThrow('disallowed model');
    expect(() => parseArgs(['--taskType=ci-heal'])).toThrow('taskType');
  });

  it.each([[200, 'opened-pr'], [300, 'opened-pr']])('bugfix bounds a %i LOC source diff', async (loc, outcome) => {
    const { io, calls } = fakeIo({ itemScope: ['we:scripts/example.mjs'], numstat: `${loc}\t0\tscripts/example.mjs` });
    const rows = [];
    io.appendScorecard = (row) => rows.push(row);
    const acquire = io.acquireLane;
    io.acquireLane = (o) => { expect(o.taskType).toBe('bugfix'); return acquire(o); };
    const result = await runProbationBuild(args(codex, { taskType: 'bugfix', scope: 'we:scripts/example.mjs' }), io);
    expect(result).toMatchObject({ outcome, pr: outcome === 'opened-pr' ? 9001 : null });
    expect(rows[0].taskType).toBe('bugfix');
    if (loc === 200) expect(calls.find((c) => c[0] === 'commit')[2]).toContain('bugfix-build — Probation launcher');
    else expect(calls.some((c) => c[0] === 'discard')).toBe(true);
  });

  it('the default still refuses 200 documentation LOC', async () => {
    const { io } = fakeIo({ numstat: '200\t0\tdocs/probation/probation.md' });
    expect((await runProbationBuild(args(), io)).detail).toContain('route to the builder');
  });

  it('bugfix refuses statute paths even when explicitly scoped', async () => {
    const path = 'docs/agent/platform-decisions.md';
    const { io } = fakeIo({ itemScope: [path], numstat: `1\t0\t${path}` });
    const r = await runProbationBuild(args(codex, { taskType: 'bugfix', scope: path }), io);
    expect(r.detail).toContain('statute-tier');
    expect(r.outcome).toBe('gate-red');
  });

  it.each(['APPROVE', 'REJECT'])('Flash requires its read-only Codex checker: %s', async (verdict) => {
    const { io, calls } = fakeIo();
    io.diffText = () => 'diff';
    io.runChecker = (argv) => { expect(argv).toContain('--review'); return verdict; };
    const a = parseArgs(['--num=4291', '--worker=antigravity-gemini', '--taskType=bugfix']);
    expect((await runProbationBuild(a, io)).outcome).toBe(verdict === 'APPROVE' ? 'opened-pr' : 'gate-red');
    if (verdict === 'REJECT') expect(calls.some((c) => c[0] === 'commit')).toBe(false);
  });

  it('uses bugfix in the PR title and body and retains the verification park', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probation-body-'));
    try {
      const bodyFile = realIo().writePrBody(dir, { num: '1', worker: codex, diff: { loc: 200, files: 1 }, taskType: 'bugfix' });
      expect(readFileSync(bodyFile, 'utf8')).toContain('within the proven `bugfix` envelope');
      expect(openPrArgv({ num: '1', slug: 'fix', bodyFile, taskType: 'bugfix' })).toEqual(expect.arrayContaining([
        '--title=WE #1: bugfix-build — fix', '--requireVerified=true', '--parkLabel=review:pending',
      ]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('invalid CLI input exits with a single JSON result before acquiring a lane', () => {
    try {
      execFileSync(process.execPath, ['scripts/operations/probation-build-run.mjs', '--num=1', '--worker=codex', '--model=unapproved'], { encoding: 'utf8' });
      throw new Error('expected refusal');
    } catch (e) {
      expect(JSON.parse(e.stdout)).toMatchObject({ executor: 'none', pr: null, outcome: 'escalated-needs-human', detail: expect.stringContaining('disallowed model') });
    }
  });

  it('separate processes append all scorecards under the existing store lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probation-scorecard-race-'));
    const path = join(dir, 'scorecards.json');
    const storeUrl = pathToFileURL(resolve('scripts/conveyor/run-scorecard-store.mjs')).href;
    const launcherUrl = pathToFileURL(resolve('scripts/lib/probation-launcher.mjs')).href;
    try {
      await Promise.all([1, 2, 3, 4].map((item) => new Promise((done, fail) => {
        const code = `import { appendScorecard } from ${JSON.stringify(storeUrl)};
          import { launchScorecardRow } from ${JSON.stringify(launcherUrl)};
          appendScorecard(launchScorecardRow({ worker: ${JSON.stringify({ ...codex, taskType: 'bugfix' })},
            pr: null, repo: 'web-everything/web-everything', handle: 'parallel-${item}', item: '${item}', launchOutcome: 'gate-red' }),
            { path: ${JSON.stringify(path)}, requireLock: true });`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, LANE_POOL_ROOT: dir } });
        let stderr = '';
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', fail);
        child.on('close', (status) => status === 0 ? done() : fail(new Error(stderr)));
      })));
      const rows = JSON.parse(readFileSync(path, 'utf8')).records;
      expect(rows.map((r) => r.item).sort()).toEqual(['1', '2', '3', '4']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it('required store locks refuse writes under contention instead of falling back unlocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probation-lock-'));
  const path = join(dir, 'store.json');
  let wrote = false;
  try {
    writeFileSync(`${path}.lock`, String(process.pid));
    expect(() => withInfraLock(path, () => { wrote = true; }, { timeoutMs: 0, requireLock: true })).toThrow('could not acquire store lock');
    expect(wrote).toBe(false);
    expect(readFileSync(`${path}.lock`, 'utf8')).toBe(String(process.pid));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('undoes a worker-created commit instead of publishing a multi-commit arc', async () => {
  const { io, calls } = fakeIo({ headShaSequence: ['base-sha', 'base-sha', 'worker-commit'] });
  const result = await runProbationBuild(args(codex, { taskType: 'bugfix' }), io);
  expect(result.outcome).toBe('escalated-needs-human');
  expect(calls).toContainEqual(['discard', 'base-sha']);
  expect(calls.some((c) => c[0] === 'commit' || c[0] === 'openPr')).toBe(false);
});

it('restores checker hook tampering before undoing a rejected Flash build', async () => {
  const { io, calls } = fakeIo();
  let checked = false;
  io.diffText = () => 'diff';
  io.runChecker = () => { checked = true; return 'REJECT'; };
  io.snapshotHookSurface = () => ({ configHash: checked ? 'tampered' : 'clean', files: {} });
  const result = await runProbationBuild(parseArgs(['--num=4291', '--worker=antigravity-gemini', '--taskType=bugfix']), io);
  expect(result.detail).toContain('checker changed the git-hook surface');
  const restore = calls.findIndex((c) => c[0] === 'reset-hooks' && c.length === 3);
  const discard = calls.findIndex((c) => c[0] === 'discard');
  expect(restore).toBeGreaterThan(-1);
  expect(discard).toBeGreaterThan(restore);
});


describe('test-fix build (#4551)', () => {
  it('runs Flash with the Codex checker and rejects production paths', async () => {
    const input = parseArgs(['--num=4551', '--taskType=test-fix', '--worker=antigravity-gemini']);
    expect(input.worker).toMatchObject({ taskType: 'test-fix', model: 'gemini-3.8-flash-high', checker: 'codex' });
    const run = fakeIo({ itemScope: ['scripts/a.test.mjs'], numstat: '1\t1\tscripts/a.test.mjs' });
    let checked = false;
    run.io.diffText = () => 'test diff';
    run.io.runChecker = () => { checked = true; return 'APPROVE'; };
    expect((await runProbationBuild(input, run.io)).outcome).toBe('opened-pr');
    expect(checked).toBe(true);
    const mixed = fakeIo({ itemScope: ['scripts/a.test.mjs', 'src/a.mjs'], numstat: '1\t1\tscripts/a.test.mjs\n1\t0\tsrc/a.mjs' });
    expect((await runProbationBuild(input, mixed.io)).outcome).toBe('gate-red');
    expect(mixed.calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(mixed.calls.some((c) => c[0] === 'commit')).toBe(false);
  });
});


describe('standalone final report capture', () => {
  it.each([
    { lastMessage: 'Codex declined: wrong target branch.' },
    { events: { finalResponse: 'Gemini declined: wrong target branch.' } },
  ])('parses the whole launcher report before truncating diagnostic output', (report) => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-report-'));
    try {
      const script = join(dir, 'report.mjs');
      writeFileSync(script, `console.log(${JSON.stringify(declineStream)}); console.log(${JSON.stringify(JSON.stringify({ ...report, padding: 'x'.repeat(5000) }, null, 2))});`);
      const result = realIo({ session: 'test' }).runWorker([script], dir);
      expect(result.ok).toBe(true);
      expect(result.lastMessage).toBe(report.lastMessage ?? report.events.finalResponse);
      expect(result.out).toHaveLength(4000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Verbatim final two events from lane-16's #2351 run (2026-09-30 00:58Z).
const declineStream = readFileSync(resolve('scripts/operations/__tests__/fixtures/codex-worker-declined.jsonl'), 'utf8');
const declineMessage = JSON.parse(declineStream.split('\n')[0]).item.text;
describe('streamed worker decline regression', () => {
  it('captures the last completed agent message before turn.completed', () => {
    const prefix = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Earlier update' } });
    expect(captureWorkerMessage(`${prefix}\n${declineStream}`)).toBe(declineMessage);
    expect(captureWorkerMessage(`noise\n${declineStream}malformed`)).toBe(declineMessage);
  });
  it.each([{ lastMessage: 'preferred report' }, { events: { finalResponse: 'preferred report' } }])(
    'prefers the trailing launcher report over stream text', (report) => {
      expect(captureWorkerMessage(declineStream + JSON.stringify(report, null, 2))).toBe('preferred report');
    });
  it.each(['codex', 'gemini'])('reads a fresh %s log before returning from the worker', (provider) => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-log-'));
    try {
      mkdirSync(join(dir, '.git'));
      const script = join(dir, `${provider}-direct-task.mjs`);
      const stream = provider === 'codex' ? declineStream : JSON.stringify({ event: 'result', result: { response: declineMessage } });
      writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync('.git/${provider}-direct-task.jsonl', ${JSON.stringify(stream)}); console.log('{}');`);
      expect(realIo().runWorker([script], dir).lastMessage).toBe(declineMessage);
      writeFileSync(script, "console.log('{}');");
      expect(realIo().runWorker([script], dir).lastMessage).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('falls back to a reported log and tolerates missing logs', () => {
    expect(captureWorkerMessage('{"lastMessage":null,"logFile":"run.jsonl"}', (path) => {
      expect(path).toBe('run.jsonl'); return declineStream;
    })).toBe(declineMessage);
    expect(captureWorkerMessage('bad output')).toBe('');
  });
  it('reassembles Gemini agent-response deltas when its terminal response is absent', () => {
    const stream = ['No files ', 'changed.'].map((text_delta) => JSON.stringify({ event: 'step_update',
      step_update: { step_type: 'agent_response', step_index: 1, text_delta } })).join('\n');
    expect(captureWorkerMessage(stream)).toBe('No files changed.');
  });
  it.each(['Blocked by #2350.', 'Requires #2350.', '#2350 remains incomplete.'])('annotates blocker wording: %s', async (lastMessage) => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage });
    await runProbationBuild(args(), io);
    expect(calls.find((c) => c[0] === 'card')?.at(-1)).toContain('possible blocker: #2350');
  });
  it('carries the observed refusal into Findings with its possible blocker', async () => {
    const { io, calls } = fakeIo({ numstat: '', lastMessage: captureWorkerMessage(declineStream) });
    await runProbationBuild(args(), io);
    const card = calls.find((c) => c[0] === 'card')?.at(-1);
    expect(card).toContain('possible blocker: #2350');
    expect(card).not.toContain('possible blocker: #2351');
    expect(card).toContain('supervised cutover remains incomplete');
  });
});


describe('standalone prepare', () => {
  const path = 'backlog/4291-probation-launcher.md';
  const prepared = ITEM_RAW + '\n## Design\nConcrete preparation.\n## MVP\nBounded change.\n## Test plan\nReplay the failure.\n## Proof plan\nProbe the CLI.\n';
  function prepareIo(options = {}) {
    const fake = fakeIo({ numstat: `12\t0\t${path}`, postWorkerRaw: prepared, ...options });
    fake.io.readCommittedCard = () => fake.io.findItem().raw;
    fake.io.readPrepareBrief = () => '# Prepare {{ITEM_NUM}}: {{ITEM_SPEC_PATH}}';
    fake.io.stampPrepare = () => {
      fake.calls.push(['stamp']);
      const read = fake.io.findItem;
      fake.io.findItem = (...a) => {
        const item = read(...a);
        return { ...item, raw: item.raw.replace('---\n', '---\npreparedDate: "2026-09-30"\npreparedAgainstSha: "base-sha"\n') };
      };
      return { ok: true };
    };
    return fake;
  }
  const prepareArgs = () => args(codex, { taskType: 'prepare', scope: `we:${path}` });
  it.each([
    ['cyclic', '12', 'open', ['4291'], 'blockedBy cycle'],
    ['unknown', '99', null, [], 'does not resolve'],
    ['resolved', '12', 'resolved', [], 'is resolved'],
    ['self', '4291', 'open', [], 'cannot block itself'],
    ['cyclic hash', 'x2c7uas', 'open', ['4291'], 'blockedBy cycle'],
    ['unknown hash', 'x2c7uas', null, [], 'does not resolve'],
    ['resolved hash', 'x2c7uas', 'resolved', [], 'is resolved'],
    ['self hash', 'x2c7uas', 'open', [], 'cannot block itself', 'x2c7uas'],
  ])('abandons gate-red on a %s proposal with no PR creation', async (_kind, target, status, blockedBy, detail, self = '4291') => {
    const { io, calls } = prepareIo({ postWorkerRaw: `${prepared}\n## Proposed blockedBy changes\n- add ${target} — dependency (we:a:1)\n` });
    io.blockedByGraph = () => new Map([
      [self, { status: 'open', blockedBy: [] }],
      ...(status ? [[target, { status, blockedBy }]] : []),
    ]);
    expect(await runProbationBuild({ ...prepareArgs(), num: self }, io)).toMatchObject({ outcome: 'gate-red', detail: expect.stringContaining(detail) });
    expect(calls).toContainEqual(['discard', 'base-sha']);
    expect(calls.some(c => ['commit', 'prBody', 'openPr'].includes(c[0]))).toBe(false);
  });
  it.each(['12', 'x2c7uas'])('passes a valid proposal to writePrBody: %s', async (target) => {
    const line = `- add ${target} — prerequisite (we:a:1)`;
    const { io, calls } = prepareIo({ postWorkerRaw: `${prepared}\n## Proposed blockedBy changes\n${line}\n` });
    io.blockedByGraph = () => new Map([
      ['4291', { status: 'open', blockedBy: [] }],
      [target, { status: 'open', blockedBy: [] }],
    ]);
    io.writePrBody = (_dir, options) => { calls.push(['prBody', options]); return '/lanes/22/.pr-body.md'; };
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({ outcome: 'opened-pr', pr: 9001 });
    expect(calls.find(c => c[0] === 'prBody')?.[1].proposedEdges).toEqual([{ op: 'add', target, line }]);
    expect(calls.some(c => c[0] === 'openPr')).toBe(true);
  });
  it('replays #4397: records could-not-prepare without stamping or resolving', async () => {
    const lastMessage = 'could-not-prepare: premise is stale; we:scripts/lib/lane-salvage.mjs uses copyLitterTreeSync/copyFileSync; FIFO timed out.';
    const { io, calls } = prepareIo({ numstat: '', postWorkerRaw: ITEM_RAW, lastMessage });
    const settled = [];
    io.settlePrepare = entry => settled.push(entry);
    const result = await runProbationBuild({ ...prepareArgs(), runId: 'builder', effectKey: 'prepare#1' }, io);
    expect(result).toMatchObject({ outcome: 'could-not-prepare', pr: 9001 });
    expect(result).not.toHaveProperty('cause');
    expect(settled).toEqual([{ runId: 'builder', key: 'prepare#1', status: 'failed', result }]);
    expect(calls.find(c => c[0] === 'card')?.at(-1)).toContain(lastMessage);
    expect(calls.some(c => ['stamp', 'resolve', 'discard'].includes(c[0]))).toBe(false);
    expect(calls.find(c => c[0] === 'commit')[1]).toEqual([path]);
    expect(calls.some(c => c[0] === 'gate')).toBe(true);
  });
  it('requires declared test scope before stamping source preparation', async () => {
    const raw = prepared.replace('we:docs/probation/probation.md', 'we:scripts/merge-ai-prs.mjs');
    const { io, calls } = prepareIo({ item: { path, raw, spec: raw, scope: ['we:scripts/merge-ai-prs.mjs'] }, postWorkerRaw: raw });
    const tasks = [];
    io.writeTaskFile = (_dir, _name, text) => { tasks.push(text); return '/tmp/task.md'; };
    const result = await runProbationBuild(prepareArgs(), io);
    expect(result.detail).toContain('test scope');
    expect(calls.some(c => c[0] === 'stamp')).toBe(false);
    expect(tasks[0]).toContain('we:scripts/__tests__/merge-ai-prs*.test.mjs');
  });
  it.each([
    ['we:scripts/__tests__/merge-ai-prs*.test.mjs', true],
    ['we:scripts/__tests__/merge-ai-prs-regression.test.mjs', true],
    ['we:scripts/__tests__/unrelated.test.mjs', false],
    ['frontierui:scripts/__tests__/merge-ai-prs.test.mjs', false],
  ])('stamps only when the (possibly corrected) scope lists a matching test: %s', async (testScope, accepted) => {
    const raw = prepared.replace('we:docs/probation/probation.md', 'we:scripts/merge-ai-prs.mjs');
    const revised = raw.replace('"we:scripts/merge-ai-prs.mjs"]', `"we:scripts/merge-ai-prs.mjs", "${testScope}"]`);
    const { io, calls } = prepareIo({ item: { path, raw, spec: raw, scope: ['we:scripts/merge-ai-prs.mjs'] }, postWorkerRaw: revised });
    expect((await runProbationBuild(prepareArgs(), io)).outcome).toBe(accepted ? 'opened-pr' : 'escalated-needs-human');
    expect(calls.some(c => c[0] === 'stamp')).toBe(accepted);
  });
  it.each([
    { lastMessage: 'No final answer', numstat: '', postWorkerRaw: ITEM_RAW },
    { lastMessage: 'could-not-prepare: stale', numstat: '1\t0\tscripts/other.mjs', postWorkerRaw: ITEM_RAW },
    { lastMessage: 'could-not-prepare: stale', numstat: '', postWorkerRaw: ITEM_RAW, runWorkerOk: false },
  ])('does not misclassify an invalid prepare as a recorded finding', async options => {
    const { io, calls } = prepareIo(options);
    expect((await runProbationBuild(prepareArgs(), io)).outcome).not.toBe('could-not-prepare');
    expect(calls.some(c => ['card', 'commit', 'openPr'].includes(c[0]))).toBe(false);
  });
  it('replays #4325: feeds the rejected stamp diagnostic back before committing the repaired card', async () => {
    const { io, calls } = prepareIo();
    const stamp = io.stampPrepare;
    let attempts = 0;
    const tasks = [];
    io.writeTaskFile = (_dir, _name, text) => { tasks.push(text); return '/lanes/22/.git/task.md'; };
    io.stampPrepare = () => ++attempts === 1
      ? { ok: false, out: 'locus-prefix: 6 bare code-path refs lack a <repo>: prefix' } : stamp();
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({ outcome: 'opened-pr', pr: 9001 });
    expect(tasks[1]).toContain('locus-prefix: 6 bare code-path refs');
    expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
    expect(calls.filter(c => c[0] === 'commit')).toHaveLength(1);
    expect(calls.some(c => c[0] === 'discard')).toBe(false);
  });
  it('bounds failed validation repairs and preserves a no-diff worker explanation', async () => {
    const { io, calls } = prepareIo();
    io.stampPrepare = () => ({ ok: false, out: 'locus-prefix' });
    const scorecards = [];
    io.appendScorecard = row => scorecards.push(row);
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({
      outcome: 'escalated-needs-human', cause: 'result-lost',
      evidence: { resultAuthored: true, resultDiscarded: true, sessionAbsent: false },
    });
    expect(scorecards[0]).toMatchObject({ cause: 'result-lost', evidence: { error: expect.stringContaining('locus-prefix') } });
    expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
    expect(calls.some(c => c[0] === 'commit')).toBe(false);
    const empty = prepareIo({ numstat: '', lastMessage: 'could-not-prepare: scope is wrong' });
    expect((await runProbationBuild(prepareArgs(), empty.io)).detail).toContain('scope is wrong');
  });
  // Live 2026-10-07 19:35Z: both reports below were recorded as FAILURES ("prepare requires a card-only diff").
  it('replays #4560: an already-done report is verified through the landing pass and settles as handled, not failed', async () => {
    const lastMessage = "already-done - delivered by commit 10fedba67afc, which references this card's birth ID xak56ki";
    const { io, calls } = prepareIo({ numstat: '', postWorkerRaw: ITEM_RAW, lastMessage });
    const settled = [];
    io.settlePrepare = entry => settled.push(entry);
    const result = await runProbationBuild({ ...prepareArgs(), runId: 'builder', effectKey: 'prepare#1' }, io);
    expect(result).toMatchObject({ outcome: 'prepare-already-done', pr: 9002 });
    expect(result).not.toHaveProperty('cause');
    expect(settled[0]).toMatchObject({ status: 'applied' });
    expect(calls.find(c => c[0] === 'land')[1]).toEqual({ num: '4291', route: 'already-done', commit: '10fedba67afc', reason: 'spec already done on main: commit 10fedba67afc' });
    expect(calls.some(c => ['stamp', 'resolve', 'openPr'].includes(c[0]))).toBe(false);
  });
  it('an already-done the landing pass cannot verify is a needs-you hold, never a resolve and never a failure record', async () => {
    const { io, calls } = prepareIo({ numstat: '', postWorkerRaw: ITEM_RAW, lastMessage: 'already-done - commit 10fedba67afc' });
    io.landAlreadyDone = () => ({ status: 'failed', error: 'cited commit does not credit the card' });
    const result = await runProbationBuild(prepareArgs(), io);
    expect(result).toMatchObject({ outcome: 'prepare-needs-you', detail: expect.stringContaining('was not verified') });
    expect(result).not.toHaveProperty('cause');
    expect(calls.some(c => c[0] === 'resolve')).toBe(false);
  });
  it('an already-done with no cited commit is never resolved: needs-you hold', async () => {
    const { io, calls } = prepareIo({ numstat: '', postWorkerRaw: ITEM_RAW, lastMessage: 'already-done - shipped last week' });
    const result = await runProbationBuild(prepareArgs(), io);
    expect(result).toMatchObject({ outcome: 'prepare-needs-you' });
    expect(calls.some(c => c[0] === 'land')).toBe(false);
    expect(calls.find(c => c[0] === 'hold')[1].reason).toMatch(/^needs-you: prepare blocked \(already-done\)/);
  });
  describe('replays #4328: a bad-scope report routes to a re-scope step', () => {
    const lastMessage = 'could-not-prepare — scope is wrong: `scope:` points at the 4309 backlog card itself, so a build would have nothing to build';
    const cardWithRefs = ITEM_RAW.replace('we:docs/probation/probation.md', 'we:backlog/4309-queue.md') + '\n1. `we:backlog/4309-queue.md:67` - a unit test.\n';
    const badItem = { path: 'backlog/4291-probation-launcher.md', slug: 'probation-launcher', title: 'x', spec: '', raw: cardWithRefs, scope: ['we:backlog/4309-queue.md'] };
    it('re-derives the scope from the cited card, rewrites it, and re-runs the worker once', async () => {
      const { io, calls } = prepareIo({ item: badItem, numstat: '', postWorkerRaw: badItem.raw, lastMessage });
      io.pathExists = (_d, rel) => rel === 'scripts/queue.mjs';
      io.readCardScope = (_d, rel) => (rel === 'backlog/4309-queue.md' ? ['we:scripts/queue.mjs', 'we:backlog/x.md'] : []);
      await runProbationBuild(prepareArgs(), io);
      expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
      expect(calls.find(c => c[0] === 'card')[2]).toContain('scope: ["we:scripts/queue.mjs"]');
    });
    it('holds with a needs-you reason when no scope can be derived: not a failure, not a silent unstamped hold', async () => {
      const { io, calls } = prepareIo({ item: badItem, numstat: '', postWorkerRaw: badItem.raw, lastMessage });
      const result = await runProbationBuild(prepareArgs(), io);
      expect(result).toMatchObject({ outcome: 'prepare-needs-you', detail: expect.stringContaining('needs-you: prepare blocked (spec-defect)') });
      expect(result).not.toHaveProperty('cause');
      expect(calls.filter(c => c[0] === 'worker')).toHaveLength(1);
      expect(calls.find(c => c[0] === 'hold')[1].route).toBe('other');
      expect(calls.some(c => ['stamp', 'resolve', 'openPr'].includes(c[0]))).toBe(false);
    });
    it('a second spec-defect report after a re-scope is a needs-you hold, not a loop', async () => {
      const { io, calls } = prepareIo({ item: badItem, numstat: '', postWorkerRaw: badItem.raw, lastMessage });
      io.pathExists = (_d, rel) => rel === 'scripts/queue.mjs';
      io.readCardScope = () => ['we:scripts/queue.mjs'];
      io.findItem = (() => { let n = 0; return () => { n += 1; return n <= 2 ? badItem : { ...badItem, raw: calls.find(c => c[0] === 'card')?.[2] ?? badItem.raw }; }; })();
      const result = await runProbationBuild(prepareArgs(), io);
      expect(result.outcome).toBe('prepare-needs-you');
      expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
    });
    it('a second spec-defect report is still a needs-you hold when the runner\'s own scope edit is in the diff (PR #4323 review)', async () => {
      // The diff comes from the runner's writeCard, not a fixed empty numstat: the worker declined again and left
      // the runner-authored scope edit in place, so the lane diff is exactly that one card.
      const { io, calls } = prepareIo({ item: badItem, numstat: '', postWorkerRaw: badItem.raw, lastMessage });
      io.pathExists = (_d, rel) => rel === 'scripts/queue.mjs';
      io.readCardScope = () => ['we:scripts/queue.mjs'];
      let written = null;
      const writeCard = io.writeCard;
      io.writeCard = (d, p, text) => { written = text; writeCard(d, p, text); };
      io.diffNumstat = (_d, _base, exclude) => { calls.push(['numstat', exclude]); return written ? `1\t1\t${badItem.path}` : ''; };
      io.findItem = (() => { let n = 0; return () => { n += 1; return n <= 2 || !written ? badItem : { ...badItem, raw: written }; }; })();
      const result = await runProbationBuild(prepareArgs(), io);
      expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
      expect(result).toMatchObject({ outcome: 'prepare-needs-you' });
      expect(calls.some(c => ['stamp', 'resolve', 'openPr', 'commit'].includes(c[0]))).toBe(false);
    });
    it('a second run that changes nothing and declines nothing is not read as a prepared card', async () => {
      const { io, calls } = prepareIo({ item: badItem, numstat: '', postWorkerRaw: badItem.raw, lastMessage });
      io.pathExists = (_d, rel) => rel === 'scripts/queue.mjs';
      io.readCardScope = () => ['we:scripts/queue.mjs'];
      let written = null;
      const writeCard = io.writeCard;
      io.writeCard = (d, p, text) => { written = text; writeCard(d, p, text); };
      io.diffNumstat = () => (written ? `1\t1\t${badItem.path}` : '');
      io.findItem = (() => { let n = 0; return () => { n += 1; return n <= 2 || !written ? badItem : { ...badItem, raw: written }; }; })();
      let run = 0;
      const runWorker = io.runWorker;
      io.runWorker = (...a) => { run += 1; const r = runWorker(...a); return run === 1 ? r : { ...r, lastMessage: 'Done.' }; };
      const result = await runProbationBuild(prepareArgs(), io);
      expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
      expect(result.outcome).toBe('gate-red');
      expect(calls.some(c => ['stamp', 'resolve', 'openPr', 'commit'].includes(c[0]))).toBe(false);
    });
  });
  it('persists both terminal outcomes against the original dispatch identity', async () => {
    for (const succeeds of [true, false]) {
      const { io } = prepareIo();
      const terminal = [];
      io.settlePrepare = entry => terminal.push(entry);
      if (!succeeds) io.stampPrepare = () => ({ ok: false, out: 'stamp refused' });
      const parsed = parseArgs(['--num=4291', '--worker=codex', '--taskType=prepare',
        '--run-id=original', '--effect-key=original#2#0']);
      const result = await runProbationBuild({ ...prepareArgs(), runId: parsed.runId, effectKey: parsed.effectKey }, io);
      expect(terminal).toEqual([{ runId: 'original', key: 'original#2#0',
        status: succeeds ? 'applied' : 'failed', result }]);
    }
  });
  it('accepts a card-only prepare, stamps it, and never claims or resolves', async () => {
    const { io, calls } = prepareIo();
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({ outcome: 'opened-pr' });
    expect(calls.some(c => ['claim', 'resolve'].includes(c[0]))).toBe(false);
    expect(calls.some(c => c[0] === 'stamp')).toBe(true);
  });
  it('accepts a worker that corrects the card\'s own scope: (#4658) and reaches opened-pr', async () => {
    const { io, calls } = prepareIo({ postWorkerRaw: prepared.replace('scope: ["we:docs/probation/probation.md"]', 'scope: ["we:scripts/real-touch-set.mjs", "we:scripts/__tests__/real-touch-set.test.mjs"]') });
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({ outcome: 'opened-pr' });
    expect(calls.some(c => c[0] === 'openPr')).toBe(true);
  });
  it('still refuses a worker that edits a frontmatter key outside the prepare allow-list', async () => {
    const { io, calls } = prepareIo({ postWorkerRaw: prepared.replace('---\nstatus: open', '---\nblockedBy: [1]\nstatus: open') });
    expect((await runProbationBuild(prepareArgs(), io)).outcome).not.toBe('opened-pr');
    expect(calls.some(c => c[0] === 'openPr')).toBe(false);
  });
  it.each([
    { numstat: `12\t0\t${path}\n1\t0\tscripts/code.mjs` },
    { postWorkerRaw: prepared.replace('status: open', 'status: resolved') },
  ])('refuses edits outside the card envelope: %j', async (options) => {
    const { io, calls } = prepareIo(options);
    expect((await runProbationBuild(prepareArgs(), io)).outcome).not.toBe('opened-pr');
    expect(calls.some(c => c[0] === 'openPr')).toBe(false);
  });
  it('never stamps a card with missing substantive sections', async () => {
    const { io, calls } = prepareIo({ postWorkerRaw: ITEM_RAW + '\n## Design\nOnly a design.\n' });
    expect((await runProbationBuild(prepareArgs(), io)).detail).toContain('Missing nonempty');
    expect(calls.filter(c => c[0] === 'worker')).toHaveLength(2);
    expect(calls.some(c => ['stamp', 'commit', 'openPr'].includes(c[0]))).toBe(false);
  });
  it('refuses a committed card without stamps', async () => {
    const { io, calls } = prepareIo();
    io.readCommittedCard = () => prepared;
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({ detail: 'prepare-unstamped at HEAD' });
    expect(calls.some(c => c[0] === 'openPr')).toBe(false);
  });
  it('refuses an unstamped result even when the stamp command reports success', async () => {
    const { io, calls } = prepareIo();
    io.stampPrepare = () => ({ ok: true });
    expect(await runProbationBuild(prepareArgs(), io)).toMatchObject({ detail: 'prepare-unstamped' });
    expect(calls.some(c => c[0] === 'commit')).toBe(false);
  });
});


describe('Findings publication regressions', () => {
  it('sanitises absolute paths and bare file:line with the real lane standards gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'findings-standards-'));
    try {
      execFileSync('git', ['clone', '--shared', '--quiet', resolve('.'), dir]);
      // A CI checkout has no local `main` for the shared clone to track, so `origin/main` is missing and the
      // backlog scope guards refuse to run; pin it to HEAD so the changed set is just this test's edit.
      try { execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'origin/main'], { stdio: 'ignore' }); }
      catch { execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']); }
      symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
      const file = 'backlog/' + readdirSync(join(dir, 'backlog')).find(f => f.startsWith('4331-'));
      const original = readFileSync(join(dir, file), 'utf8');
      const reason = 'worker-declined: guard too broad at session-reaper.mjs:453 in /Users/example/workspace/.lanes/lane-22/scripts/session-reaper.mjs:453';
      const written = clearScopeAndAppendFinding(original, { num: '4331', reason });
      expect(written).toContain('we:session-reaper.mjs:453');
      expect(written).not.toContain('/Users/example');
      expect(scanRepoLocusPrefixes([{ file, content: written }])).toEqual([]);
      writeFileSync(join(dir, file), written);
      const result = JSON.parse(execFileSync(process.execPath, ['scripts/check-standards.mjs', '--local', `--files=${file}`, '--json'], { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
      expect(result.errors).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);

  it('preserves qualified paths and URLs, strips local paths, and caps after prefixing', () => {
    const clean = sanitizeHoldReason('we:a.mjs fui:a.mjs a.mjs https://example.com/a.mjs /tmp/lane/a.mjs C:\\Users\\test\\a.mjs');
    expect(clean).toBe('we:a.mjs fui:a.mjs we:a.mjs https://example.com/a.mjs [local path] [local path]');
    expect(sanitizeHoldReason('a.mjs '.repeat(200), { max: 100 }).length).toBe(100);
  });

  it('lands only the card after a nine-file bugfix exceeds its envelope', async () => {
    const paths = Array.from({ length: 9 }, (_, i) => `scripts/fixture-${i}.mjs`);
    const { io, calls } = fakeIo({ itemScope: paths.map(p => `we:${p}`), numstat: paths.map(p => `1\t0\t${p}`).join('\n') });
    const result = await runProbationBuild(args(codex, { taskType: 'bugfix', scope: paths.map(p => `we:${p}`).join(',') }), io);
    expect(result.outcome).toBe('opened-pr');
    expect(result.detail).toContain('scope exceeds the bugfix envelope — route to the builder');
    expect(result.detail).toContain('touched 9 files (limit 4)');
    expect(calls.find(c => c[0] === 'hold')[1]).toMatchObject({ route: 'other' });
    expect(calls.find(c => c[0] === 'commit')[1]).toEqual(['backlog/4291-probation-launcher.md']);
    expect(calls.findIndex(c => c[0] === 'discard')).toBeLessThan(calls.findIndex(c => c[0] === 'card'));
    expect(calls.some(c => c[0] === 'resolve')).toBe(false);
  });

  it('refuses to publish Findings if discarding the implementation failed', async () => {
    const { io, calls } = fakeIo({ numstat: '200\t0\tdocs/probation/probation.md' });
    io.discardChanges = () => {};
    const result = await runProbationBuild(args(), io);
    expect(result.outcome).toBe('gate-red');
    expect(result.detail).toContain('could not discard');
    expect(calls.some(c => ['card', 'commit', 'openPr'].includes(c[0]))).toBe(false);
  });

  it('extracts the first failure from a real gate subprocess before truncation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'findings-gate-output-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(join(dir, 'scripts/verify-lane.mjs'), `
        console.log('check-standards — Web Everything');
        console.log(' error missing locus prefix');
        console.log('tail'.repeat(5000));
        process.exitCode = 2;
      `);
      const gate = realIo().runGate(dir);
      expect(gate.pass).toBe(false);
      expect(gate.failureDetail).toBe('check:standards: error missing locus prefix');
      expect(gate.output).not.toContain('missing locus prefix');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains the failing check and first error even before a long output tail', async () => {
    const output = 'check-standards — Web Everything\n\x1b[31m error\x1b[0m 2 code-path references lack a locus prefix\n' + 'tail\n'.repeat(4000);
    const failureDetail = gateFailureDetail(output);
    expect(failureDetail).toBe('check:standards: error 2 code-path references lack a locus prefix');
    const { io } = fakeIo({ numstat: '', lastMessage: 'declined' });
    io.runGate = () => ({ pass: false, output: output.slice(-12000), failureDetail });
    const result = await runProbationBuild(args(), io);
    expect(result.detail).toContain(failureDetail);
    expect(gateFailureDetail(' FAIL scripts/example.test.mjs > case\nAssertionError: nope')).toContain('vitest: FAIL');
  });
});

describe('parseArgs — operator pins keep the narrow worker allowlist (PR 3209 review)', () => {
  it('rejects prepare on antigravity-claude and widened models for a pinned worker', () => {
    expect(() => parseArgs(['--num=1', '--session=s', '--taskType=prepare', '--worker=antigravity-claude'])).toThrow(/prepare requires/);
    expect(() => parseArgs(['--num=1', '--session=s', '--worker=antigravity-claude', '--model=claude-opus-4-6-thinking'])).toThrow(/disallowed model/);
    expect(() => parseArgs(['--num=1', '--session=s', '--worker=codex', '--model=gpt-5.6-terra'])).toThrow(/disallowed model/);
  });
  it('resolves a default route for a non-critical doc-fix with no --worker (no gate crash)', () => {
    expect(() => parseArgs(['--num=1', '--session=s', '--taskType=doc-fix'])).not.toThrow();
  });
});

describe('owned new test scope (#4650)', () => {
  const source = 'scripts/merge-ai-prs.mjs';
  const test = 'scripts/__tests__/merge-ai-prs-merge-failure-isolation.test.mjs';
  it.each([
    [test, true, true],
    ['scripts/__tests__/merge-ai-prs-regression.test.ts', true, true],
    [test, false, false],
    ['scripts/__tests__/unrelated.test.mjs', true, false],
    ['other/__tests__/merge-ai-prs.test.mjs', true, false],
    ['scripts/__tests__/merge-ai-prs-helper.mjs', true, false],
    ['scripts/unrelated.mjs', true, false],
  ])('replays #4389: %s new=%s accepted=%s', async (path, added, accepted) => {
    const { io, calls } = fakeIo({ itemScope: [`we:${source}`], numstat: `1\t1\t${source}\n10\t0\t${path}` });
    io.addedPaths = () => added ? [path] : [];
    const result = await runProbationBuild(args(codex, { taskType: 'bugfix', scope: `we:${source}` }), io);
    expect(result.outcome).toBe(accepted ? 'opened-pr' : 'gate-red');
    expect(calls.some(c => c[0] === 'resolve')).toBe(accepted);
  });
  it('admits an owned new test in test-fix mode without admitting production edits', async () => {
    const { io } = fakeIo({ itemScope: [`we:${source}`], numstat: `10\t0\t${test}` });
    io.addedPaths = () => [test];
    expect((await runProbationBuild(args(codex, { taskType: 'test-fix', scope: `we:${source}` }), io)).outcome).toBe('opened-pr');
  });
  it('does not widen a lease that excludes the owning source', async () => {
    const { io } = fakeIo({ itemScope: [`we:${source}`], numstat: `10\t0\t${test}` });
    io.addedPaths = () => [test];
    expect((await runProbationBuild(args(codex, { taskType: 'bugfix', scope: 'we:scripts/other.mjs' }), io)).outcome).toBe('gate-red');
  });
});


it('observes NEW tests through real Git numstat including staged and untracked additions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owned-test-git-'));
  try {
    execFileSync('git', ['clone', '--shared', '--quiet', resolve('.'), dir]);
    const io = realIo();
    const existing = 'scripts/operations/probation-build-run.mjs';
    const fresh = 'scripts/operations/__tests__/probation-build-run-new-regression.test.mjs';
    writeFileSync(join(dir, existing), readFileSync(join(dir, existing), 'utf8') + '\n// changed\n');
    writeFileSync(join(dir, fresh), '// regression\n');
    expect(io.diffNumstat(dir, 'HEAD')).toContain(fresh);
    expect(io.addedPaths(dir, 'HEAD')).toEqual([fresh]);
    execFileSync('git', ['add', '--', fresh], { cwd: dir });
    expect(io.addedPaths(dir, 'HEAD')).toEqual([fresh]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(['4397', '4389'])('replays incident #%s using its checkout card and real Git/file IO', async num => {
  const dir = mkdtempSync(join(tmpdir(), `probation-${num}-replay-`));
  try {
    execFileSync('git', ['clone', '--shared', '--quiet', resolve('.'), dir]);
    const real = realIo();
    const item = real.findItem(num, dir);
    const { io, calls } = fakeIo({ lane: dir, item });
    for (const key of ['findItem', 'headSha', 'untracked', 'diffNumstat', 'addedPaths', 'writeCard']) io[key] = real[key];
    const source = 'scripts/merge-ai-prs.mjs';
    // Must be a path ABSENT from the clone: #4389's real regression test now lives on main, so reusing its name
    // would make the worker's write a modification, not the added file this replay exercises.
    const test = 'scripts/__tests__/merge-ai-prs-replay-regression.test.mjs';
    io.runWorker = () => {
      if (num === '4389') {
        writeFileSync(join(dir, source), readFileSync(join(dir, source), 'utf8') + '\n// replay worker diff\n');
        writeFileSync(join(dir, test), '// replay regression addition\n');
      }
      return { ok: true, lastMessage: num === '4397'
        ? 'could-not-prepare: premise stale; we:scripts/lib/lane-salvage.mjs uses copyLitterTreeSync/copyFileSync; real FIFO probe timed out.' : 'Built with regression test.' };
    };
    io.readPrepareBrief = real.readPrepareBrief;
    const result = await runProbationBuild(parseArgs([`--num=${num}`, '--worker=codex',
      `--taskType=${num === '4397' ? 'prepare' : 'bugfix'}`, `--scope=${num === '4397' ? `we:${item.path}` : `we:${source}`}`]), io);
    expect(result.outcome).toBe(num === '4397' ? 'could-not-prepare' : 'opened-pr');
    if (num === '4397') {
      const recorded = readFileSync(join(dir, item.path), 'utf8');
      expect(recorded).toContain('## Findings');
      expect(recorded).toContain('copyLitterTreeSync/copyFileSync; real FIFO probe timed out.');
      expect(recorded).toContain('status: open');
      expect(calls.some(c => c[0] === 'resolve')).toBe(false);
    } else {
      expect(calls.find(c => c[0] === 'commit')[1]).toEqual(expect.arrayContaining([source, test]));
    }
    // Publication and gate callbacks are spies: no live model, commit, push, or PR occurs.
    expect(calls.some(c => c[0] === 'gate')).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
